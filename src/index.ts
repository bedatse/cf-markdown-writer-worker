import * as cheerio from "cheerio";

export interface Env {
	API_TOKEN: string;
	AI: Ai;
	AI_MODEL: string;
	PAGE_METADATA: D1Database;
	HTML_PREPROCESS: KVNamespace;
	RAW_HTML_BUCKET: R2Bucket;
	KNOWLEDGE_BUCKET: R2Bucket;
	RETURN_MARKDOWN: string;
}

interface RequestBody {
	url: string;
	maxChunkSize: number;
	maxTokens: number;
	additionalPrompt: string;
}

interface PreprocessHTMLRules {
	type: string;
	selector?: string;
	exclude?: string;
}

const DEFAULT_MAX_CHUNK_SIZE = 114688;
const DEFAULT_MAX_TOKENS = 1024;

/**
 * Get the page metadata from the D1 database
 * @param url - The URL to get the metadata for
 * @param env - The environment variables
 * @returns The document ID and the R2 key
 */
export async function getPageMetadata(url:string, env: Env) {
	// Get HTML location from D1 PageMetadata
	try {
		const pageMetadata = await env.PAGE_METADATA.prepare("SELECT * FROM PageMetadata WHERE url = ?")
			.bind(url)
			.first();

		if (!pageMetadata) {
			console.log({ "message": "URL is not in the database", "URL": url });
			return {docId: null, r2Key: null};
		}

		const docId = String(pageMetadata.id);
		const r2Key = String(pageMetadata.r2_path);
		console.log({ "message": "Fetched URL metadata from PageMetadata", "URL": url, "R2Path": r2Key });

		return {docId, r2Key}
	} catch (e: any) {
		console.log({ "message": "Failed to query from D1 PageMetadata", "URL": url, "Error": e.message });
		console.error(e);
		throw new Error("Failed to query from D1 PageMetadata");
	}
}

/**
 * Get the HTML from the R2 bucket
 * @param r2Key - The R2 key to get the HTML from
 * @param env - The environment variables
 * @returns The HTML
 */
export async function getHtml(r2Key: string, env: Env) {
	// Get HTML from R2
	try {
		const r2Obj = await env.RAW_HTML_BUCKET.get(r2Key);
		if (!r2Obj) {
			console.log({ "message": "HTML not found from R2", "R2Path": r2Key });
			return null;
		}

		const html = await r2Obj.text();
		console.log({ "message": "Fetched HTML from R2", "R2Path": r2Key });

		return html;
	} catch (e: any) {
		console.log({ "message": "Failed to get HTML from R2", "R2Path": r2Key, "Error": e.message });
		console.error(e);
		throw new Error("Failed to get HTML from R2")
	}
}

/**
 * Get the HTML preprocessing rules from the KV store
 * @param domain - The domain to get the rules for
 * @param env - The environment variables
 * @returns The HTML preprocessing rules
 */
export async function getHtmlPreprocessRules(domain: string, env: Env): Promise<PreprocessHTMLRules[]> {
	try {
		const kvKey = `domain:${domain.replace(/^www\./g, "")}`;
		const htmlPreprocessRules = await env.HTML_PREPROCESS.get(kvKey);
		if (!htmlPreprocessRules) {
			console.log({ "message": "No HTML preprocessing rules found", "Domain": domain, "Key": kvKey });
			return [];
		}

		const rules: PreprocessHTMLRules[] = JSON.parse(htmlPreprocessRules)?.rules || [];

		console.log({ "message": "Fetched HTML preprocessing rules from KV", "Domain": domain, "Key": kvKey, "Rules": rules });
		return rules;
	} catch (e: any) {
		console.log({ "message": "Failed to get HTML preprocessing rules from KV", "Domain": domain, "Error": e.message });
		console.error(e);
		throw new Error("Failed to get HTML preprocessing rules from KV")
	}
}

/**
 * Preprocess the HTML
 * @param html - The HTML to preprocess
 * @param rules - The HTML preprocessing rules
 * @returns The title and the processed HTML
 */
export function preprocessHTML(html: string, rules: PreprocessHTMLRules[]): { title: string, processedHtml: string[] } {
	try {
		const processedHtml: string[] = [];
		const $ = cheerio.load(html);
		const title = $('title').text();
	
		// Remove all scripts, styles, and inline data
		$('script').remove();
		$('style').remove();
		$('img[src^="data:"]').removeAttr('src')
		$('*').removeAttr('style')

		if (!rules || rules.length === 0) {
			return { title, processedHtml: [$('body').text()] };
		}
		
		for (const rule of rules) {
			try {
				const ruleType = rule.type;
				if (ruleType === "css") {
					console.log({ "message": "Processing CSS rule", "Selector": rule });
					const selector = rule.selector;
					const excSelector = rule.exclude || "";
					let selectedDOM = $(selector);
		
					if (selectedDOM.length > 0) {
						if (excSelector !== "") {
							selectedDOM.find(excSelector).remove();
						}
		
						const selectedHtml = selectedDOM.html();
	
						console.log({ "message": "Selected HTML", "length": selectedHtml?.length || 0 });
						processedHtml.push(selectedHtml || "");
					} else {
						console.log({ "message": "No DOM Element found for selector", "Selector": selector });
					}
				}
			} catch (e: any) {
				console.log({ "message": "Failed to process rule", "Rule": rule, "Error": e.message });
				console.error(e);
				continue;
			}
		}
	
		console.log({ "message": "Processed HTML", "segments": processedHtml.length, "totalLength": processedHtml.reduce((acc, curr) => acc + curr.length, 0) });
		return { title, processedHtml };
	} catch (e: any) {
		console.log({ "message": "Failed to preprocess HTML", "Error": e.message });
		console.error(e);
		throw new Error("Failed to preprocess HTML");
	}
}

/**
 * Split the HTML into chunks
 * @param htmlInput - The HTML to split
 * @param maxChunkSize - The maximum chunk size
 * @returns The chunks
 */
export function splitHtml(htmlInput: string, maxChunkSize: number = DEFAULT_MAX_CHUNK_SIZE): string[] {
	// Split long htmlInput into chunks, do not split chunk in between words and in between HTML tags
	const chunks = [];

	let currentChunk = '';
	let tagStack = [];
	let inTag = false;
	let tagContent = '';

	// Process character by character
	for (let i = 0; i < htmlInput.length; i++) {
		const char = htmlInput[i];
		
		if (char === '<') {
			inTag = true;
			tagContent = char;
			continue;
		}
		
		if (inTag) {
			tagContent += char;
			if (char === '>') {
				inTag = false;
				// Check if opening or closing tag
				if (tagContent.match(/^<\//)) {
					tagStack.pop();
				} else if (!tagContent.match(/^<.*\/>/)) {
					const tagName = tagContent.match(/^<([^ >]+)/)?.[1];
					if (tagName) tagStack.push(tagName);
				}
				currentChunk += tagContent;
				tagContent = '';
				continue;
			}
			continue;
		}

		currentChunk += char;

		// Check if chunk is getting too large and we're not in the middle of a tag
		if (currentChunk.length >= maxChunkSize && !inTag) {
			// Find last space to split on
			let splitIndex = currentChunk.lastIndexOf(' ');
			if (splitIndex === -1) splitIndex = currentChunk.length;

			// Add closing tags for any open tags
			let chunkToAdd = currentChunk.slice(0, splitIndex);
			for (let j = tagStack.length - 1; j >= 0; j--) {
				chunkToAdd += `</${tagStack[j]}>`;
			}
			chunks.push(chunkToAdd);

			// Start new chunk with opening tags
			currentChunk = '';
			for (let j = 0; j < tagStack.length; j++) {
				currentChunk += `<${tagStack[j]}>`;
			}
			currentChunk += currentChunk.slice(splitIndex);
		}
	}

	// Add any remaining content as the final chunk
	if (currentChunk) {
		chunks.push(currentChunk);
	}

	return chunks;
}

/**
 * Generate markdown from the chunks
 * @param chunks - The chunks to generate markdown from
 * @param title - The title of the page
 * @param additionalPrompt - The additional prompt to add to the markdown
 * @param maxTokens - The maximum number of tokens to generate
 * @param env - The environment variables
 * @returns The markdown and the messages
 */
export async function generateMarkdown(chunks: string[], title: string, additionalPrompt: string, maxTokens: number, env: Env) {
	try {
		const model: any = env.AI_MODEL;

		const messages = [
			{ role: "system", content: `You are a helpful assistant that can read HTML. You will be given a few HTML snippets and you will need to generate a markdown output. 
	Generating simple and clear markdown in using original text only found in the HTML. Remove all links, images, and URLs. Do not repeat information.
	Always start the markdown with the page title as level 1 heading. The page title is "${title}".`},
			...chunks.map((chunk, index) => ({ role: "user", content: `HTML Chunk ${index + 1}: ${chunk}` })),
			{ role: "user", content: `Generate a markdown output, in the HTML content original language language, using all available HTML chunks. ${additionalPrompt}`},
		]

		console.log({ "message": "Running AI to generate markdown", "Model": model });

		const response = await env.AI.run(model, {"messages": messages, max_tokens: maxTokens})
		const markdown = String(response.response);

		console.log({ "message": "Generated markdown", "responseLength": markdown.length });
		
		return { markdown, messages };
	} catch (e: any) {
		console.log({ "message": "Failed to generate markdown", "Error": e.message });
		console.error(e);
		throw new Error("Failed to generate markdown");
	}
}

/**
 * Store the markdown in the Knowledge Bucket and update the PageMetadata
 * @param docId - The document ID
 * @param r2Key - The R2 key
 * @param markdown - The markdown to store
 * @param env - The environment variables
 */
export async function storeMarkdownAndUpdatePageMetadata(docId: string, r2Key: string, markdown: string, env: Env) {
	try {
		const r2Response = await env.KNOWLEDGE_BUCKET.put(r2Key, markdown);
		console.log({ 
			"message": "Saved Markdown in Knowledge Bucket", 
			"Size": markdown.length,
			"R2Key": r2Key, 
			"R2SaveSize": r2Response?.size, 
			"R2SaveResult": r2Response?.uploaded 
		});
	} catch (e: any) {
		console.log({ "message": "Failed to store markdown in Knowledge Bucket", "R2Key": r2Key, "Error": e.message });
		console.error(e);
		throw new Error("Failed to store markdown in Knowledge Bucket");
	}

	// Update the PageMetadata with the markdown creation time
	try {
		await env.PAGE_METADATA.prepare("UPDATE PageMetadata SET markdown_created_at = CURRENT_TIMESTAMP WHERE id = ?")
			.bind(docId)
			.run();
	} catch (e: any) {
		console.log({ "message": "Failed to update PageMetadata", "docId": docId, "Error": e.message });
		console.error(e);
		throw new Error("Failed to update PageMetadata");
	}
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

		// Get the parameters from the request
		const body: RequestBody = await request.json();
		const reqUrl = body?.url;
		const maxChunkSize = body?.maxChunkSize || DEFAULT_MAX_CHUNK_SIZE;
		const maxTokens = body?.maxTokens || DEFAULT_MAX_TOKENS;
		const additionalPrompt = body?.additionalPrompt || "";

		// Check if the URL is provided
		if (!reqUrl) {
			console.log({ "message": "URL parameter is missing", "URL": reqUrl });
			return Response.json({"message": "URL is required", "status": "failed"}, { status: 400 });
		} 

		const targetUrl = new URL(reqUrl);
		const domain = targetUrl.hostname;

		try {
			console.log({ "message": "Request URL", "URL": reqUrl, "MaxChunkSize": maxChunkSize, "MaxTokens": maxTokens, "AdditionalPrompt": additionalPrompt });
			// Get HTML location from D1 PageMetadata
			const {docId, r2Key} = await getPageMetadata(reqUrl, env);

			if (!docId || !r2Key) {
				return Response.json({"message": "URL is not in the database", "status": "failed"}, { status: 404 });
			}

			// Get HTML from R2
			const html = await getHtml(r2Key, env);
			if (!html) {
				return Response.json({"message": "HTML not found from R2", "status": "failed"}, { status: 404 });
			}

			// Get HTML Preprocessing rules from KV
			const htmlPreprocessRules = await getHtmlPreprocessRules(domain, env) || [];

			const {title, processedHtml} = preprocessHTML(html, htmlPreprocessRules);
			let chunks: string[] = [];

			// If any of the processed HTML chunks are larger than the max chunk size, redistribute split them
			if (processedHtml.reduce((acc, curr) => acc || curr.length > maxChunkSize, false)) {
				chunks = splitHtml(processedHtml.join("\n\n"), maxChunkSize);
			} else {
				chunks = processedHtml;
			}

			// Generate markdown
			const { markdown, messages } = await generateMarkdown(chunks, title, additionalPrompt, maxTokens, env);

			// Store markdown in Knowledge Bucket
			await storeMarkdownAndUpdatePageMetadata(docId, r2Key, markdown, env);

			if (env.RETURN_MARKDOWN === "true") {
				return Response.json({"message": "Markdown saved to Knowledge Bucket", "status": "success", "markdown": markdown, "messages": messages}, { status: 200 });
			}

			return Response.json({"message": "Markdown saved to Knowledge Bucket", "status": "success"}, { status: 200 });
		} catch (e: any) {
			return Response.json({"message": e.message, "status": "failed"}, { status: 500 });
		}
	},
} satisfies ExportedHandler<Env>;

