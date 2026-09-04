import { describe, expect, test } from "bun:test";
import { HtmlBlockCollector, persistHtmlBlocks } from "../../src/core/html-blocks";

describe("HtmlBlockCollector", () => {
	test("returns signed URLs and keeps duplicate occurrences with one expiry", async () => {
		const collector = new HtmlBlockCollector({
			origin: "https://files.example",
			secret: "secret",
			expiresAt: 90_000,
		});

		const firstUrl = await collector.resolve({ index: 0, content: "<b>same</b>" });
		const secondUrl = await collector.resolve({ index: 1, content: "<b>same</b>" });

		expect(firstUrl).toBe(secondUrl);
		expect(collector.metadata()).toEqual([
			{
				index: 0,
				hash: expect.any(String),
				url: firstUrl,
				expires_at: 90_000,
			},
			{
				index: 1,
				hash: expect.any(String),
				url: secondUrl,
				expires_at: 90_000,
			},
		]);
	});
});

describe("persistHtmlBlocks", () => {
	test("deduplicates by hash and performs puts sequentially", async () => {
		const collector = new HtmlBlockCollector({
			origin: "https://files.example",
			secret: "secret",
			expiresAt: 90_000,
		});
		await collector.resolve({ index: 0, content: "first" });
		await collector.resolve({ index: 1, content: "first" });
		await collector.resolve({ index: 2, content: "second" });
		let active = 0;
		let maximumActive = 0;
		const puts: Array<{ key: string; content: string; options: unknown }> = [];
		const bucket = {
			async put(key: string, content: string, options: unknown) {
				active += 1;
				maximumActive = Math.max(maximumActive, active);
				await Promise.resolve();
				puts.push({ key, content, options });
				active -= 1;
				return null;
			},
		};

		await persistHtmlBlocks(bucket, collector.blocks());

		expect(maximumActive).toBe(1);
		expect(puts).toHaveLength(2);
		expect(puts.map(({ content }) => content)).toEqual(["first", "second"]);
		expect(puts[0]?.key).toMatch(/^html\/[a-f0-9]{64}$/);
		expect(puts[0]?.options).toEqual({
			httpMetadata: { contentType: "text/html; charset=utf-8" },
		});
	});

	test("stops after a failed put and leaves earlier puts intact", async () => {
		const collector = new HtmlBlockCollector({
			origin: "https://files.example",
			secret: "secret",
			expiresAt: 90_000,
		});
		await collector.resolve({ index: 0, content: "first" });
		await collector.resolve({ index: 1, content: "second" });
		await collector.resolve({ index: 2, content: "third" });
		const stored: string[] = [];
		const bucket = {
			async put(_key: string, content: string) {
				if (content === "second") throw new Error("R2 unavailable");
				stored.push(content);
				return null;
			},
		};

		await expect(persistHtmlBlocks(bucket, collector.blocks())).rejects.toThrow("R2 unavailable");
		expect(stored).toEqual(["first"]);
	});
});
