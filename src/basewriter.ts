import { Env } from "./common";
import { randomUUID } from "node:crypto";

export abstract class BaseWriter {
	protected env: Env;
	protected url: string;
	protected traceId: string;
	protected docId?: string;
	protected r2Key?: string;

	constructor(env: Env, url: string) {
		this.env = env;
		this.url = url;
		this.traceId = randomUUID();
	}

	/**
	 * Get the page metadata from the D1 database
	 */
	async loadPageMetadata(): Promise<boolean> {
		// Get HTML location from D1 PageMetadata
		try {
			const pageMetadata = await this.env.PAGE_METADATA.prepare("SELECT id, r2_path FROM PageMetadata WHERE url = ?")
				.bind(this.url)
				.first();

			if (!pageMetadata) {
				console.warn({ "message": "URL not found", "url": this.url, "traceId": this.traceId });
				return false;
			}

			this.docId = String(pageMetadata.id);
			this.r2Key = String(pageMetadata.r2_path);

			console.log({ "message": "Fetched URL metadata from D1 PageMetadata", "url": this.url, "docId": this.docId, "r2key": this.r2Key, "traceId": this.traceId });
            return true;
		} catch (e: any) {
			console.error({ "message": "Failed to query from D1 PageMetadata", "url": this.url, "error": e.message, "traceId": this.traceId }, e, e.stack);
			throw e;
		}
	}

	/**
	 * Get the HTML from the R2 bucket
	 * @returns The HTML
	 */
	async getHtml(): Promise<string | null> {
		if (!this.r2Key) {
			console.error({ "message": "r2Key is not set", "url": this.url, "traceId": this.traceId });
			throw new Error("r2Key is not set before calling getHtml()");
		}
		// Get HTML from R2
		try {
			const r2Obj = await this.env.RAW_HTML_BUCKET.get(`${this.r2Key}.html`);
			if (!r2Obj) {
				console.warn({ "message": "HTML not found from R2", "url": this.url, "r2key": this.r2Key, "traceId": this.traceId });
				return null;
			}

			const html = await r2Obj.text();
			console.log({ "message": "Fetched HTML from R2", "url": this.url, "r2key": this.r2Key, "traceId": this.traceId });

			return html;
		} catch (e: any) {
			console.error({ "message": "Failed to get HTML from R2", "url": this.url, "r2key": this.r2Key, "error": e.message, "traceId": this.traceId }, e, e.stack);
			throw e;
		}
	}

    /**
     * Store the markdown in the Knowledge Bucket
     * @param markdown - The markdown to store
     */
    async storeMarkdown(markdown: string): Promise<void> {
		if (!this.r2Key) {
			console.error({ "message": "r2Key is not set", "url": this.url, "traceId": this.traceId });
			throw new Error("r2Key is not set before calling storeMarkdown()");
		}

		// Store the markdown in the Knowledge Bucket
		try {
			const r2Response = await this.env.KNOWLEDGE_BUCKET.put(`${this.r2Key}.md`, markdown);
			console.log({
                "message": "Saved Markdown in Knowledge Bucket", 
                "size": markdown.length, "r2savesize": r2Response?.size, 
                "url": this.url, "r2key": this.r2Key, "traceId": this.traceId 
            });
        } catch (e: any) {
            console.error({ "message": "Failed to store markdown in Knowledge Bucket", "url": this.url, "r2key": this.r2Key, "error": e.message, "traceId": this.traceId }, e, e.stack);
            throw e;
        }
    }

    /**
     * Update the PageMetadata with the markdown creation time
     */
    async updatePageMetadata(): Promise<void> {
		if (!this.docId) {
			console.error({ "message": "docId is not set", "url": this.url, "traceId": this.traceId });
			throw new Error("docId is not set before calling updatePageMetadata()");
		}

        // Update the PageMetadata with the markdown creation time
        try {
            await this.env.PAGE_METADATA.prepare("UPDATE PageMetadata SET markdown_created_at = CURRENT_TIMESTAMP WHERE id = ?")
                .bind(this.docId)
                .run();
            console.log({ "message": "Updated PageMetadata with markdown creation time", "url": this.url, "docId": this.docId, "traceId": this.traceId });
        } catch (e: any) {
            console.error({ "message": "Failed to update PageMetadata", "url": this.url, "docId": this.docId, "error": e.message, "traceId": this.traceId }, e, e.stack);
            throw e;
        }
    }

    async run(additionalPrompt: string) {
        try {
            // Get HTML location from D1 PageMetadata
            const success = await this.loadPageMetadata();
            if (!success) {
                return {"message": "URL not found in D1 PageMetadata", "status": "hardfail", "code": 404};
            }
    
            // Get HTML from R2
            const html = await this.getHtml();
            if (!html) {
                return {"message": "HTML not found from R2", "status": "hardfail", "code": 404};
            }
    
            // Write the markdown
            const markdown = await this.writeMarkdown(html, additionalPrompt);
            if (!markdown) {
                return {"message": "Failed to generate markdown", "status": "hardfail", "code": 500};
            }
    
            // Store markdown in Knowledge Bucket
            await this.storeMarkdown(markdown);

            await this.updatePageMetadata();
    
            return {"message": "Markdown saved to Knowledge Bucket", "status": "success", "code": 200, "markdown": markdown};
        } catch (e: any) {
            return {"message": e.message, "status": "softfail", "code": 500};
        }
    }

    abstract writeMarkdown(html: string, additionalPrompt: string): Promise<string>;
}