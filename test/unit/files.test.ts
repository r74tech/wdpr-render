import { describe, expect, test } from "bun:test";
import { sha256Hex, signHtmlBlockUrl } from "../../src/core/signed-url";
import { handleFilesRequest, wrapHtmlFragment, type FilesBindings } from "../../src/files/worker";

const now = 1_000;

function env(content: string | null): FilesBindings {
	return {
		ASSETS: { fetch: async () => new Response("css") } as unknown as Fetcher,
		FILES_URL_SECRET: "current-secret",
		HTML_BLOCKS: {
			get: async () => (content === null ? null : { text: async () => content }),
		} as unknown as R2Bucket,
	};
}

async function signedUrl(secret = "current-secret", expiresAt = 2_000): Promise<string> {
	return signHtmlBlockUrl({
		origin: "https://files.example",
		hash: await sha256Hex("block"),
		secret,
		expiresAt,
	});
}

describe("files Worker", () => {
	test("returns 404 for unsupported methods and malformed paths", async () => {
		for (const request of [
			new Request("https://files.example/nope"),
			new Request(`https://files.example/html/${"A".repeat(64)}`),
			new Request(await signedUrl(), { method: "POST" }),
		]) {
			const response = await handleFilesRequest(request, env("block"), now);
			expect(response.status).toBe(404);
			expect(response.headers.get("Cache-Control")).toBe("no-store");
		}
	});

	test("rejects missing, tampered, and expired signatures before R2", async () => {
		let reads = 0;
		const bindings = env("block");
		bindings.HTML_BLOCKS = {
			get: async () => {
				reads += 1;
				return null;
			},
		} as unknown as R2Bucket;
		const valid = new URL(await signedUrl());
		for (const request of [
			new Request(valid.origin + valid.pathname),
			new Request(`${valid.toString()}x`),
			new Request(await signedUrl("current-secret", now)),
		]) {
			const response = await handleFilesRequest(request, bindings, now);
			expect(response.status).toBe(403);
			expect(response.headers.get("Cache-Control")).toBe("no-store");
		}
		expect(reads).toBe(0);
	});

	test("returns 404 when R2 is missing", async () => {
		const response = await handleFilesRequest(new Request(await signedUrl()), env(null), now);
		expect(response.status).toBe(404);
	});

	test("serves HEAD metadata without reading the object body", async () => {
		let textReads = 0;
		const bindings = env("block");
		bindings.HTML_BLOCKS = {
			get: async () => ({
				text: async () => {
					textReads += 1;
					return "block";
				},
			}),
		} as unknown as R2Bucket;
		const response = await handleFilesRequest(
			new Request(await signedUrl(), { method: "HEAD" }),
			bindings,
			now,
		);
		expect(response.status).toBe(200);
		expect(await response.text()).toBe("");
		expect(response.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
		expect(response.headers.get("Cache-Control")).toBe("private, no-store");
		expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
		expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
		expect(response.headers.get("Permissions-Policy")).toBe(
			"camera=(), microphone=(), geolocation=()",
		);
		expect(textReads).toBe(0);
	});

	test("wraps fragments with the local stylesheet", () => {
		const html = wrapHtmlFragment("<p>block</p>");
		expect(html).toContain('<html id="html-block-html"');
		expect(html).toContain('<link rel="stylesheet" href="/html-block.css"/>');
		expect(html).toContain("<body><p>block</p></body>");
	});

	test("serves the resize script", async () => {
		const response = await handleFilesRequest(
			new Request("https://files.example/common--javascript/html-block-iframe.js"),
			env(null),
			now,
		);
		expect(response.status).toBe(200);
		expect(response.headers.get("Content-Type")).toBe("text/javascript; charset=utf-8");
		expect(await response.text()).toContain("postMessage");
	});

	test("serves the stylesheet through the Assets binding", async () => {
		let requestedUrl = "";
		const bindings = env(null);
		bindings.ASSETS = {
			fetch: async (input: URL | RequestInfo) => {
				requestedUrl = new Request(input).url;
				return new Response("body { margin: 0; }", {
					headers: { "Content-Type": "text/css; charset=utf-8" },
				});
			},
		} as unknown as Fetcher;
		const response = await handleFilesRequest(
			new Request("https://files.example/html-block.css"),
			bindings,
			now,
		);
		expect(response.status).toBe(200);
		expect(requestedUrl).toBe("https://files.example/html-block.css");
		expect(response.headers.get("Content-Type")).toContain("text/css");
	});
});
