import { sha256Hex, signHtmlBlockUrl } from "./signed-url";

export interface HtmlBlockMetadata {
	index: number;
	hash: string;
	url: string;
	expires_at: number;
}

export interface CollectedHtmlBlock {
	index: number;
	hash: string;
	content: string;
}

export interface HtmlBlockCollectorOptions {
	origin: string;
	secret: string;
	expiresAt: number;
}

export class HtmlBlockCollector {
	readonly #options: HtmlBlockCollectorOptions;
	readonly #metadata: HtmlBlockMetadata[] = [];
	readonly #blocks = new Map<string, CollectedHtmlBlock>();

	constructor(options: HtmlBlockCollectorOptions) {
		this.#options = options;
	}

	async resolve(input: { index: number; content: string }): Promise<string> {
		const hash = await sha256Hex(input.content);
		const url = await signHtmlBlockUrl({
			origin: this.#options.origin,
			hash,
			secret: this.#options.secret,
			expiresAt: this.#options.expiresAt,
		});
		this.#metadata.push({
			index: input.index,
			hash,
			url,
			expires_at: this.#options.expiresAt,
		});

		const existing = this.#blocks.get(hash);
		if (!existing || input.index < existing.index) {
			this.#blocks.set(hash, { index: input.index, hash, content: input.content });
		}
		return url;
	}

	metadata(): HtmlBlockMetadata[] {
		return this.#metadata.toSorted((left, right) => left.index - right.index);
	}

	blocks(): CollectedHtmlBlock[] {
		return [...this.#blocks.values()].toSorted((left, right) => left.index - right.index);
	}
}

export interface HtmlBlockBucket {
	put(key: string, value: string, options: R2PutOptions): Promise<unknown>;
}

export async function persistHtmlBlocks(
	bucket: HtmlBlockBucket,
	blocks: readonly CollectedHtmlBlock[],
): Promise<void> {
	for (const block of blocks) {
		await bucket.put(`html/${block.hash}`, block.content, {
			httpMetadata: { contentType: "text/html; charset=utf-8" },
		});
	}
}
