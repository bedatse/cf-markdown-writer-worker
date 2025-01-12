import * as cheerio from "cheerio";

export interface Env {
	API_TOKEN: string;
	AI: Ai;
	AI_MODEL: string;
	PAGE_METADATA: D1Database;
	HTML_PREPROCESS: KVNamespace;
	RAW_HTML_BUCKET: R2Bucket;
	KNOWLEDGE_BUCKET: R2Bucket;
}

interface RequestBody {
	url: string;
}

export function preprocessHTML($: cheerio.CheerioAPI, rulesStr: string): string[] {
	// TODO: Change rules to JSON object
	const rules = rulesStr.split("\n");
	let processedHtml: string[] = [];

	for (const ruleArr of rules) {
		try {
			const rule =  ruleArr.split("::");
			const ruleType = rule[0];
			const paramStr = rule[1];
			if (ruleType === "css") {
				const selectors = paramStr.split("||");
				for (const selector of selectors) {
					const selectedHtml = $(selector).html();
					if (selectedHtml) {
						processedHtml.push(selectedHtml);
					} else {
						console.log({ "message": "No HTML found for selector", "Selector": selector });
					}
				}
			}
		} catch (e: any) {
			console.log({ "message": "Failed to parse rule", "Rule": ruleArr, "Error": e.message });
			console.error(e);
		}
	}

	return processedHtml;
}

export default {
	async fetch(request, env, ctx): Promise<Response> {
		// Check if the request is authorized
		const apiKey = request.headers.get("Authorization")?.replace("Bearer ", "");
		if (apiKey !== env.API_TOKEN) {
			console.log({ "message": "Unauthorized request", "APIKey": apiKey, "ExpectedAPIKey": env.API_TOKEN });
			return Response.json({"message": "Unauthorized", "status": "failed"}, { status: 401 });
		}

		// Check if the request is POST
		if (request.method !== "POST") {
			console.log({ "message": "Invalid request method", "Method": request.method });
			return Response.json({"message": "Invalid request method", "status": "failed"}, { status: 405 });
		}

		// Get the URL and await network idle time from the request
		// TODO: Change the request to POST with JSON body
		const url = new URL(request.url);
		const body: RequestBody = await request.json();
		const reqUrl = body?.url;

		console.log({ "message": "Request URL", "URL": reqUrl });

		// Check if the URL is provided
		if (!reqUrl) {
			console.log({ "message": "URL parameter is missing", "URL": reqUrl });
			return Response.json({"message": "URL is required", "status": "failed"}, { status: 400 });
		} 

		const targetUrl = new URL(reqUrl);
		const domain = targetUrl.hostname;
		const targetUrlString = targetUrl.toString();
		
		let r2Key: string;
		// Get HTML location from D1 PageMetadata
		try {
			const pageMetadata = await env.PAGE_METADATA.prepare("SELECT * FROM PageMetadata WHERE url = ?")
				.bind(targetUrlString)
				.first();

			if (!pageMetadata) {
				console.log({ "message": "URL is not in the database", "URL": targetUrlString });
				return Response.json({"message": "URL is not in the database", "status": "failed"}, { status: 404 });
			}

			r2Key = String(pageMetadata.r2_path);
			console.log({ "message": "Fetched URL metadata from PageMetadata", "URL": targetUrlString, "R2Path": r2Key });
		} catch (e: any) {
			console.log({ "message": "Failed to query from D1 PageMetadata", "URL": targetUrlString, "Error": e.message });
			console.error(e);
			return Response.json({"message": "Failed to get URL metadata", "status": "failed"}, { status: 500 });
		}

		let html: string;
		// Get HTML from R2
		try {
			const r2Obj = await env.RAW_HTML_BUCKET.get(r2Key);
			if (!r2Obj) {
				// TODO: potential error handling for removing the page metadata from D1
				console.log({ "message": "HTML not found from R2", "R2Path": r2Key });
				return Response.json({"message": "HTML not found from R2", "status": "failed"}, { status: 404 });
			}

			html = await r2Obj.text();
			console.log({ "message": "Fetched HTML from R2", "URL": targetUrlString, "R2Path": r2Key });
		} catch (e: any) {
			console.log({ "message": "Failed to get HTML from R2", "URL": targetUrlString, "R2Path": r2Key, "Error": e.message });
			console.error(e);
			return Response.json({"message": "Failed to get HTML", "status": "failed"}, { status: 500 });
		}

		// Get HTML preprocessing rules from KV
		const kvKey = `domain:${domain.replace(/^www\./g, "")}`;
		const htmlPreprocessRules = await env.HTML_PREPROCESS.get(kvKey);
		if (!htmlPreprocessRules) {
			console.log({ "message": "No HTML preprocessing rules found", "URL": targetUrlString, "Key": kvKey });
		} else {
			console.log({ "message": "Fetched HTML preprocessing rules from KV", "URL": targetUrlString, "Key": kvKey, "Rules": htmlPreprocessRules });
		}

		const $ = cheerio.load(html);
		const title = $('title').text();
		const htmlbody = $('body').html();

		let htmlInput: string;

		if (htmlPreprocessRules) {
			const processedHtml = preprocessHTML($, htmlPreprocessRules);
			htmlInput = processedHtml.join("\n\n");
		} else {
			htmlInput = htmlbody || "";
		}

		const model: any = env.AI_MODEL;

		const messages = [
			{ role: "system", content: `You are a helpful assistant that can read HTML. You will be given a few HTML snippets and you will need to generate a markdown output. 
Generating simple and clear markdown in using original text only found in the HTML. Remove all links, images, and URLs. 
Always start the markdown with the page title as level 1 heading.`},
			{ role: "user", content: `The page title is "${title}".`},
			{ role: "user", content: `Generate a markdown output, in the HTML content original language language, from the following HTML input: \n${htmlInput}`}
		]

		console.log({ "message": "Running AI to generate markdown", "Model": model, "Messages": messages });

		const response: any = await env.AI.run(model, {messages})

		// Store the markdown in Knowledge Bucket
		const markdown = String(response.response);
		try {
			const r2Response = await env.KNOWLEDGE_BUCKET.put(r2Key, markdown);
			console.log({ 
				"message": "Saved Markdown in Knowledge Bucket", 
				"URL": targetUrlString, 
				"Size": markdown.length,
				"R2Key": r2Key, 
				"R2SaveSize": r2Response?.size, 
				"R2SaveResult": r2Response?.uploaded 
			});
		} catch (e: any) {
			console.log({ "message": "Failed to store markdown in Knowledge Bucket", "URL": targetUrlString, "R2Key": r2Key, "Error": e.message });
			console.error(e);
			return Response.json({"message": "Failed to store markdown", "status": "failed"}, { status: 500 });
		}

		// Update the PageMetadata with the markdown creation time
		try {
			await env.PAGE_METADATA.prepare("UPDATE PageMetadata SET markdown_created_at = CURRENT_TIMESTAMP WHERE url = ?")
				.bind(targetUrlString)
				.run();
		} catch (e: any) {
			console.log({ "message": "Failed to update PageMetadata", "URL": targetUrlString, "Error": e.message });
			console.error(e);
		}

		return Response.json({"message": "Markdown saved to Knowledge Bucket", "status": "success"}, { status: 200 });
	},
} satisfies ExportedHandler<Env>;
