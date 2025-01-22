
import { Env, RequestBody, MarkdownModel } from "./common";
import { BaseWriter } from "./basewriter";
import { LlamaWriter } from "./llama-writer";
import { GeminiWriter } from "./gemini-writer";

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		// Check if the request is authorized
		const apiKey = request.headers.get("Authorization")?.replace("Bearer ", "");
		if (apiKey !== env.API_TOKEN) {
			console.log({ "message": "Unauthorized request", "APIKey": apiKey, "ExpectedAPIKey": env.API_TOKEN });
			return Response.json({"message": "Unauthorized", "status": "failed"}, { status: 401 });
		}

		// Check if the request is POST
		if (request.method !== "POST" && request.method !== "PUT") {
			console.log({ "message": "Invalid request method", "Method": request.method });
			return Response.json({"message": "Invalid request method", "status": "failed"}, { status: 405 });
		}

		// Get the parameters from the request
		const body: RequestBody = await request.json();
		// Check if the URL is provided
		if (!body.url) {
			console.log({ "message": "URL parameter is missing", "URL": body.url });
			return Response.json({"message": "URL parameter is missing", "status": "failed"}, { status: 400 });
		} 

		switch (request.method) {
			case "POST":
				let writer: BaseWriter;

				switch (body.model) {
					case MarkdownModel.GEMINI_2_FLASH:
						writer = new GeminiWriter(env, body.url, body.maxTokens);
						break;
					default:
						writer = new LlamaWriter(env, body.url, body.maxTokens, body.maxChunkSize);
				}

				const result = await writer.run(body.additionalPrompt || "");

				if (env.RETURN_MARKDOWN === "true") {
					return Response.json({"message": result.message, "status": result.status, "markdown": result.markdown}, { status: result.code });
				}
				return Response.json({"message": result.message, "status": result.status}, { status: result.code });
			case "PUT":
				try {
					await env.CREATE_MARKDOWN_QUEUE.send(body);
					console.log({ "message": "Message sent to queue", "status": "success", "request": body });
					return Response.json({"message": "Request Accepted", "status": "success", "request": body}, { status: 202 });
				} catch (e: any) {
					console.error({ "message": "Failed to send message to queue", "Error": e.message }, e, e.stack);
					return Response.json({"message": "Failed to send message to queue", "status": "failed"}, { status: 500 });
				}
		}
	},

	async queue(batch: MessageBatch, env: Env): Promise<void> {
		console.log({ "message": "Consuming queue", "BatchSize": batch.messages.length });

		for (const message of batch.messages) {
			console.log({ "message": "Processing message", "Message": message });

			const body: RequestBody = message.body as RequestBody;
			
			let writer: BaseWriter;

			switch (body.model) {
				case MarkdownModel.GEMINI_2_FLASH:
					writer = new GeminiWriter(env, body.url, body.maxTokens);
					break;
				default:
					writer = new LlamaWriter(env, body.url, body.maxTokens, body.maxChunkSize);
			}

			const result = await writer.run(body.additionalPrompt || "");

			switch (result.status) {
				case "hardfail":
					console.warn({ "message": "Failed to process request, will not retry", "Result": result });
					message.ack(); // Do not retry on hardfail
					break;
				case "softfail":
					console.warn({ "message": "Failed to process request, will retry", "Result": result });
					message.retry();
					break;
				case "success":
					console.log({ "message": "Successfully processed request", "Result": result });
					message.ack();
					break;
			}
		}
	},
} satisfies ExportedHandler<Env>;
