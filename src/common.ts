export enum MarkdownModel {
	LLAMA = "llama-3.3",
	GEMINI_2_FLASH = "gemini-2.0-flash-exp",
}

export interface Env {
	API_TOKEN: string;
	AI: Ai;
	AI_MODEL: string;
	PAGE_METADATA: D1Database;
	HTML_PREPROCESS: KVNamespace;
	RAW_HTML_BUCKET: R2Bucket;
	SCREENSHOT_BUCKET: R2Bucket;
	KNOWLEDGE_BUCKET: R2Bucket;
	CREATE_MARKDOWN_QUEUE: Queue;
	RETURN_MARKDOWN: string;
	GOOGLE_AISTUDIO_API_KEY: string;
	GOOGLE_AI_MODEL: string;
}

export interface RequestBody {
	url: string;
	additionalPrompt?: string;
	model?: MarkdownModel;
	maxChunkSize?: number;
	maxTokens?: number;
}
