import { env, SELF } from "cloudflare:test";
import { describe, expect, test } from "vitest";
import { sha256Hex } from "../../src/core/signed-url";

const keys = {
	valid: `wpv4_${"A".repeat(43)}`,
	expired: `wpv4_${"B".repeat(43)}`,
	insufficientScope: `wpv4_${"C".repeat(43)}`,
	invalidResponse: `wpv4_${"D".repeat(43)}`,
};

interface TestBindings {
	HTML_BLOCKS: R2Bucket;
	FILES: Fetcher;
	FAILING_API: Fetcher;
}

interface RenderResult {
	status: string;
	html?: string;
	html_blocks?: Array<{ hash: string; url: string; expires_at: number }>;
	error_code?: string;
}

function apiRequest(path: string, key = keys.valid, body?: unknown): Request {
	return new Request(`https://api.example${path}`, {
		method: body === undefined ? "GET" : "POST",
		headers: {
			Authorization: `Bearer ${key}`,
			...(body === undefined ? {} : { "Content-Type": "application/json" }),
		},
		body: body === undefined ? undefined : JSON.stringify(body),
	});
}

async function render(fetcher: Fetcher, source: string): Promise<Response> {
	return fetcher.fetch(
		apiRequest("/v1/render", keys.valid, {
			pages: [{ fullname: "start", source }],
			targets: ["start"],
		}),
	);
}

describe("API Worker runtime", () => {
	test.each(["/", "/v1/health"])("serves the public health endpoint at %s", async (path) => {
		const response = await SELF.fetch(`https://example.com${path}`);

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			ok: true,
			versions: { parser: "5.1.6", render: "4.0.7" },
		});
	});

	test.each([
		["expired key", keys.expired, 401, "unauthorized"],
		["missing scope", keys.insufficientScope, 403, "insufficient_scope"],
		["invalid introspection response", keys.invalidResponse, 503, "upstream_auth_unavailable"],
	] as const)(
		"enforces the wpv4 service-binding boundary for %s",
		async (_name, key, status, code) => {
			const response = await SELF.fetch(apiRequest("/v1/me", key));

			expect(response.status).toBe(status);
			expect(await response.json()).toMatchObject({ code });
		},
	);

	test("renders through the API, overwrites R2, and serves the signed block from files", async () => {
		const bindings = env as unknown as TestBindings;
		const content = "<p>runtime html block</p>";
		const hash = await sha256Hex(content);
		await bindings.HTML_BLOCKS.put(`html/${hash}`, "stale content");

		const response = await render(SELF, `[[html]]\n${content}\n[[/html]]`);
		const body = (await response.json()) as { results: RenderResult[] };
		const result = body.results[0];

		expect(response.status).toBe(200);
		expect(result?.status).toBe("ok");
		expect(result?.html).toContain('sandbox="allow-scripts"');
		expect(result?.html_blocks).toHaveLength(1);
		expect(result?.html_blocks?.[0]?.hash).toBe(hash);
		expect(await (await bindings.HTML_BLOCKS.get(`html/${hash}`))?.text()).toBe(content);

		const blockUrl = result?.html_blocks?.[0]?.url;
		if (!blockUrl) throw new Error("render response did not contain an html-block URL");
		const blockResponse = await bindings.FILES.fetch(blockUrl);
		const blockHtml = await blockResponse.text();
		expect(blockResponse.status).toBe(200);
		expect(blockHtml).toContain(content);
		expect(blockHtml).toContain(
			'<script type="text/javascript" src="/common--javascript/html-block-iframe.js"></script>',
		);
	});

	test("returns a page error when R2 persistence rejects the write", async () => {
		const bindings = env as unknown as TestBindings;
		const response = await render(bindings.FAILING_API, "[[html]]\nfail at runtime\n[[/html]]");
		const body = (await response.json()) as { results: RenderResult[] };

		expect(response.status).toBe(200);
		expect(body.results[0]).toMatchObject({
			status: "error",
			error_code: "html_block_store_failed",
		});
		expect(body.results[0]?.html).toBeUndefined();
		expect(body.results[0]?.html_blocks).toBeUndefined();
	});
});
