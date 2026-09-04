import { env, SELF } from "cloudflare:test";
import { describe, expect, test } from "vitest";
import { sha256Hex, signHtmlBlockUrl } from "../../src/core/signed-url";

async function storeAndSign(content: string): Promise<string> {
	const hash = await sha256Hex(content);
	await (env as unknown as { HTML_BLOCKS: R2Bucket }).HTML_BLOCKS.put(`html/${hash}`, content);
	return signHtmlBlockUrl({
		origin: "https://files.example",
		hash,
		secret: "test-secret",
		expiresAt: Math.floor(Date.now() / 1_000) + 60,
	});
}

describe("files Worker runtime", () => {
	test.each([
		["fragment", "<p>fragment</p>", true],
		["document", "<!doctype html><html><body><p>document</p></body></html>", false],
	] as const)("serves a signed %s through R2 and HTMLRewriter", async (_name, source, wrapped) => {
		const response = await SELF.fetch(await storeAndSign(source));
		const html = await response.text();

		expect(response.status).toBe(200);
		expect(response.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
		expect(response.headers.get("Cache-Control")).toBe("private, no-store");
		expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
		expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
		expect(response.headers.get("Permissions-Policy")).toBe(
			"camera=(), microphone=(), geolocation=()",
		);
		expect(html).toContain(source.includes("fragment") ? "fragment" : "document");
		expect(html).toContain(
			'<script type="text/javascript" src="/common--javascript/html-block-iframe.js"></script>',
		);
		expect(html.includes('href="/html-block.css"')).toBe(wrapped);
	});

	test("serves the iframe stylesheet as a static asset", async () => {
		const response = await SELF.fetch("https://files.example/html-block.css");
		expect(response.status).toBe(200);
		expect(await response.text()).toContain("html#html-block-html");
	});
});
