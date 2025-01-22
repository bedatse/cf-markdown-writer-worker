import * as cheerio from "cheerio";

import { Env } from "./common";
import { BaseWriter } from "./basewriter";

export interface PreprocessHTMLRules {
	type: string;
	selector?: string;
	exclude?: string;
}

const DEFAULT_MAX_CHUNK_SIZE = 114688;
const DEFAULT_MAX_TOKENS = 1024;

export class LlamaWriter extends BaseWriter {
    protected domain: string;
    protected maxChunkSize: number;
    protected maxTokens: number;

    constructor(env: Env, url: string, maxTokens: number = DEFAULT_MAX_TOKENS, maxChunkSize: number = DEFAULT_MAX_CHUNK_SIZE) {
        super(env, url);
        this.domain = new URL(url).hostname;
        this.maxChunkSize = maxChunkSize;
        this.maxTokens = maxTokens;
    }

    /**
     * Since Llama 3.3 only have 128K context window, we need to preprocess the HTML to reduce the context window size
     * 
     * Get the HTML preprocessing rules from the KV store
     * @returns The HTML preprocessing rules
     */
    async getHtmlPreprocessRules(): Promise<PreprocessHTMLRules[]> {
        try {
            const kvKey = `domain:${this.domain.replace(/^www\./g, "")}`;

            // Obtain the HTML preprocessing rules from the KV store
            const htmlPreprocessRules = await this.env.HTML_PREPROCESS.get(kvKey);
            if (!htmlPreprocessRules) {
                console.warn({ "message": "No HTML preprocessing rules found", "url": this.url, "domain": this.domain, "key": kvKey, "traceId": this.traceId });
                return [];
            }

            const rules: PreprocessHTMLRules[] = JSON.parse(htmlPreprocessRules)?.rules || [];

            console.log({ "message": "Fetched HTML preprocessing rules from KV", "url": this.url, "domain": this.domain, "key": kvKey, "rules": rules, "traceId": this.traceId });
            return rules;
        } catch (e: any) {
            console.error({ "message": "Failed to get HTML preprocessing rules from KV", "url": this.url, "domain": this.domain, "error": e.message, "traceId": this.traceId });
            throw e;
        }
    }

    /**
     * Preprocess the HTML
     * 
     * @param html - The HTML to preprocess
     * @param rules - The HTML preprocessing rules
     * @returns The title and the processed HTML
     */
    preprocessHTML(html: string, rules: PreprocessHTMLRules[]): { title: string, processedHtml: string[] } {
        try {
            const processedHtml: string[] = [];
            const $ = cheerio.load(html);
            const title = $('title').text();
        
            // Remove all scripts, stylesheets, and inline images data
            $('script').remove();
            $('style').remove();
            $('img[src^="data:"]').removeAttr('src')

            if (!rules || rules.length === 0) {
                return { title, processedHtml: [$('body').text()] };
            }
            
            for (const rule of rules) {
                try {
                    const ruleType = rule.type;
                    if (ruleType === "css") {
                        console.log({ "message": "Processing CSS rule", "url": this.url, "rule": rule, "traceId": this.traceId });
                        const selector = rule.selector;
                        const excSelector = rule.exclude || "";
                        let selectedDOM = $(selector);
            
                        if (selectedDOM.length > 0) {
                            if (excSelector !== "") {
                                selectedDOM.find(excSelector).remove();
                            }
            
                            const selectedHtml = selectedDOM.html();
        
                            console.log({ "message": "Selected HTML", "length": selectedHtml?.length || 0, "url": this.url, "rule": rule, "traceId": this.traceId });
                            processedHtml.push(selectedHtml || "");
                        } else {
                            console.log({ "message": "No DOM Element found for selector", "url": this.url, "rule": rule, "traceId": this.traceId });
                        }
                    }
                } catch (e: any) {
                    console.error({ "message": "Failed to process rule", "url": this.url, "rule": rule, "error": e.message, "traceId": this.traceId }, e, e.stack);
                    continue;
                }
            }
        
            console.log({ "message": "Processed HTML", "url": this.url, "segments": processedHtml.length, "totalLength": processedHtml.reduce((acc, curr) => acc + curr.length, 0), "traceId": this.traceId });
            return { title, processedHtml };
        } catch (e: any) {
            console.error({ "message": "Failed to preprocess HTML", "url": this.url, "error": e.message, "traceId": this.traceId }, e, e.stack);
            throw e;
        }
    }

    /**
     * Split the HTML into chunks
     * @param htmlInput - The HTML to split
     * @returns The chunks
     */
    splitHtml(html: string): string[] {
        // Split long htmlInput into chunks, do not split chunk in between words and in between HTML tags
        const chunks = [];

        let currentChunk = '';
        let tagStack = [];
        let inTag = false;
        let tagContent = '';

        // Process character by character
        for (let i = 0; i < html.length; i++) {
            const char = html[i];
            
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
            if (currentChunk.length >= this.maxChunkSize && !inTag) {
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
     * @param title - The title of the page
     * @param chunks - The chunks to generate markdown from
     * @returns The markdown generated
     */
    async generateMarkdown(title: string, chunks: string[], additionalPrompt: string) {
        try {
            console.log({ "message": "Connecting to AI Model", "url": this.url, "model": this.env.AI_MODEL, "traceId": this.traceId });
            const model: any = this.env.AI_MODEL;

            const messages = [
                { role: "system", content: `You are a helpful assistant that can read HTML. You will be given a few HTML snippets and you will need to generate a markdown output. 
        Generating simple and clear markdown in using original text only found in the HTML. Remove all links, images, and URLs. Do not repeat information.
        Always start the markdown with the page title as level 1 heading. The page title is "${title}".`},
                ...chunks.map((chunk, index) => ({ role: "user", content: `HTML Chunk ${index + 1}: ${chunk}` })),
                { role: "user", content: `Generate a markdown output, in the HTML content original language language, using all available HTML chunks. ${additionalPrompt}`},
            ]

            console.log({ "message": "Running AI to generate markdown", "url": this.url, "model": model, "traceId": this.traceId });

            const response = await this.env.AI.run(model, {"messages": messages, max_tokens: this.maxTokens})

            // TODO: Handle non-retryable errors from generative AI models - throw exception on retryable errors, return null on non-retryable errors
            const markdown = String(response.response);

            console.log({ "message": "Generated markdown", "url": this.url, "responseLength": markdown.length, "markdown": markdown, "traceId": this.traceId });
            
            return markdown;
        } catch (e: any) {
            console.error({ "message": "Failed to generate markdown", "url": this.url, "error": e.message, "traceId": this.traceId }, e, e.stack);
            throw e;
        }
    }

    async writeMarkdown(html: string, additionalPrompt: string): Promise<string> {
        const htmlPreprocessRules = await this.getHtmlPreprocessRules() || [];
        const preprocessResult = this.preprocessHTML(html, htmlPreprocessRules);
        const processedHtml = preprocessResult.processedHtml;

        const title = preprocessResult.title;

        let chunks: string[] = [];

        // If any of the processed HTML chunks are larger than the max chunk size, redistribute split them
        if (processedHtml.reduce((acc, curr) => acc || curr.length > this.maxChunkSize, false)) {
            chunks = this.splitHtml(processedHtml.join("\n\n"));
        } else {
            chunks = processedHtml;
        }

        // Generate markdown
        return await this.generateMarkdown(title, chunks, additionalPrompt);
    }
}