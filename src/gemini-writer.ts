import * as cheerio from "cheerio";
import { GoogleGenerativeAI } from "@google/generative-ai";

import { Env } from "./common";
import { BaseWriter } from "./basewriter";

const DEFAULT_MAX_TOKENS = 1024;

export class GeminiWriter extends BaseWriter {
    protected maxTokens: number;

    constructor(env: Env, url: string, maxTokens: number = DEFAULT_MAX_TOKENS) {
        super(env, url);
        this.maxTokens = maxTokens;
    }
    
    preprocessHTML(html: string): { title: string, processedHtml: string } {
        try {
            const $ = cheerio.load(html);
            const title = $('title').text();

            $('script').remove();
            $('style').remove();
            $('img[src^="data:"]').removeAttr('src')

            return { title, processedHtml: $.text() };
        } catch (e: any) {
            console.error({ "message": "Failed to preprocess HTML", "url": this.url, "error": e.message, "traceId": this.traceId }, e, e.stack);
            throw e;
        }
    }

    /**
     * Generate markdown from the HTML
     * @param title - The title of the page
     * @param html - The HTML to generate markdown from
     * @returns The markdown generated
     */
    async generateMarkdown(title: string, html: string, additionalPrompt: string) {
        const systemPrompts = [
            `You will be given an HTML page and you will need to generate a markdown output. Generating simple and clear markdown in using original text only found in the HTML. Remove all links, images, and URLs. Do not repeat information.`,
            `Always start the markdown with the page title as level 1 heading. The page title is ${title}.`
        ]
    
        try {
            console.log({ "message": "Creating Google Generative AI instance", "url": this.url, "model": this.env.GOOGLE_AI_MODEL, "traceId": this.traceId });
            const genAI = new GoogleGenerativeAI(this.env.GOOGLE_AISTUDIO_API_KEY);
            const systemInstruction = {
                "role": "system",
                "parts": [...systemPrompts.map((prompt) => ({ "text": prompt }))],
            }
    
            console.log({ "message": "Creating Model", "url": this.url, "model": this.env.GOOGLE_AI_MODEL, "traceId": this.traceId });
            const model = genAI.getGenerativeModel({
                model: this.env.GOOGLE_AI_MODEL,
                systemInstruction: systemInstruction,
                generationConfig: {
                    temperature: 0.2,
                    topP: 0.1,
                    maxOutputTokens: this.maxTokens,
                }
            });

            console.log({ "message": "Starting Chat", "url": this.url, "model": this.env.GOOGLE_AI_MODEL, "traceId": this.traceId });
            const session = model.startChat();
    
            console.log({ "message": "Sending Prompt", "url": this.url, "model": this.env.GOOGLE_AI_MODEL, "prompt": additionalPrompt, "traceId": this.traceId });
            const response = await session.sendMessage([{ "text": html }, { "text": additionalPrompt }]);

            // TODO: Handle non-retryable errors from generative AI models - throw exception on retryable errors, return null on non-retryable errors
            console.log({ "message": "Received Response", "url": this.url, "model": this.env.GOOGLE_AI_MODEL, "prompt": additionalPrompt, "traceId": this.traceId });
            return response.response.text();
            
        } catch (e: any) {
            console.error({ "message": "Failed to compose response", "url": this.url, "model": this.env.GOOGLE_AI_MODEL, "error": e.message, "traceId": this.traceId }, e, e.stack);
            throw e;
        }
    }

    async writeMarkdown(html: string, additionalPrompt: string): Promise<string> {
        const preprocessResult = this.preprocessHTML(html);

        const processedHtml = preprocessResult.processedHtml;
        const title = preprocessResult.title;

        return await this.generateMarkdown(title, processedHtml, additionalPrompt);
    }
}