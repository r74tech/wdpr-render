import { describe, expect, spyOn, test } from "bun:test";
import app from "../../src/api";
import { normalizeUrlPaths } from "../../src/api/routes/render";
import { parseRequest, renderRequestSchema } from "../../src/api/schema";
import type { Bindings } from "../../src/types/env";

const validKey = `wpv4_${"Z".repeat(43)}`;

function env(options: { failContent?: string } = {}): Bindings & { puts: string[] } {
	const puts: string[] = [];
	return {
		ENVIRONMENT: "staging",
		FILES_ORIGIN: "https://files.example",
		FILES_URL_SECRET: "test-secret",
		WPV4: {
			fetch: async () =>
				Response.json({
					user: { wikidot_id: 42, name: "Alice", unix_name: "alice", ignored: true },
					key: { name: "Renderer", scopes: ["render:use"], expires_at: null, ignored: true },
					ignored: true,
				}),
		} as unknown as Fetcher,
		HTML_BLOCKS: {
			async put(_key: string, value: string) {
				if (value === options.failContent) throw new Error("R2 unavailable");
				puts.push(value);
				return null;
			},
		} as unknown as R2Bucket,
		puts,
	};
}

function request(path: string, body?: unknown, headers: Record<string, string> = {}): Request {
	return new Request(`https://api.example${path}`, {
		method: body === undefined ? "GET" : "POST",
		headers: {
			...(body === undefined ? {} : { "Content-Type": "application/json" }),
			...(path === "/v1/health" ? {} : { Authorization: `Bearer ${validKey}` }),
			...headers,
		},
		body: body === undefined ? undefined : JSON.stringify(body),
	});
}

async function json(response: Response): Promise<Record<string, unknown>> {
	return (await response.json()) as Record<string, unknown>;
}

describe("API Worker", () => {
	test("serves public health and JSON errors with no-store headers", async () => {
		const health = await app.fetch(request("/v1/health"), {} as Bindings);
		expect(health.status).toBe(200);
		expect(await json(health)).toEqual({
			ok: true,
			versions: { parser: "5.1.6", render: "4.0.7" },
		});
		expect(health.headers.get("Content-Type")).toBe("application/json; charset=UTF-8");
		expect(health.headers.get("Cache-Control")).toBe("no-store");

		const missing = await app.fetch(request("/unknown"), {} as Bindings);
		expect(missing.status).toBe(404);
		expect(await json(missing)).toEqual({ error: "Route not found", code: "not_found" });
		expect(missing.headers.get("Cache-Control")).toBe("no-store");
	});

	test("handles CORS preflight before authentication", async () => {
		const response = await app.fetch(
			new Request("https://api.example/v1/render", {
				method: "OPTIONS",
				headers: {
					Origin: "https://client.example",
					"Access-Control-Request-Method": "POST",
					"Access-Control-Request-Headers": "Authorization, Content-Type",
				},
			}),
			{} as Bindings,
		);
		expect(response.status).toBe(204);
		expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
		expect(response.headers.get("Access-Control-Allow-Headers")).toContain("Authorization");
	});

	test("protects private routes and returns only validated introspection fields", async () => {
		const unauthorized = await app.fetch(new Request("https://api.example/v1/me"), {} as Bindings);
		expect(unauthorized.status).toBe(401);

		const response = await app.fetch(request("/v1/me"), env());
		expect(response.status).toBe(200);
		expect(await json(response)).toEqual({
			user: { wikidot_id: 42, name: "Alice", unix_name: "alice" },
			key: { name: "Renderer", scopes: ["render:use"], expires_at: null },
		});
	});

	test("resolves targets in order and aggregates missing includes", async () => {
		const response = await app.fetch(
			request("/v1/resolve", {
				pages: [
					{ fullname: "A", source: "[[include missing]]" },
					{ fullname: "B", source: "[[include missing]]" },
				],
				targets: ["B", "A"],
			}),
			env(),
		);
		const body = await json(response);
		expect(response.status).toBe(200);
		expect(
			(body.results as Array<{ requested: string }>).map(({ requested }) => requested),
		).toEqual(["B", "A"]);
		expect(body.missing).toEqual([{ site: null, page: "missing", requested_by: ["b", "a"] }]);
	});

	test("keeps dependency contracts aligned while preserving documented pipeline differences", async () => {
		const common = {
			pages: [
				{ fullname: "start", source: "[[include middle]]" },
				{ fullname: "middle", source: "[[include leaf]]" },
				{ fullname: "leaf", source: "Leaf" },
			],
			targets: ["start"],
		};
		const resolved = await app.fetch(request("/v1/resolve", common), env());
		const rendered = await app.fetch(request("/v1/render", common), env());
		const resolveResult = ((await json(resolved)).results as Array<Record<string, unknown>>)[0];
		const renderResult = ((await json(rendered)).results as Array<Record<string, unknown>>)[0];
		expect(renderResult?.dependencies).toEqual(resolveResult?.dependencies);

		const self = { pages: [{ fullname: "self", source: "[[include self]]" }], targets: ["self"] };
		const selfResolved = await app.fetch(request("/v1/resolve", self), env());
		const selfRendered = await app.fetch(request("/v1/render", self), env());
		const selfDependencies = ((
			(await json(selfResolved)).results as Array<Record<string, unknown>>
		)[0]?.dependencies ?? []) as unknown[];
		expect(selfDependencies).toHaveLength(1);
		expect(
			((await json(selfRendered)).results as Array<Record<string, unknown>>)[0]?.dependencies,
		).toEqual([]);

		const generated = {
			pages: [
				{
					fullname: "start",
					source: '[[module ListPages category="items" limit="1"]]\n%%content%%\n[[/module]]',
				},
				{ fullname: "items:one", source: "[[include generated]]" },
				{ fullname: "generated", source: "Generated" },
			],
			targets: ["start"],
		};
		const generatedResolved = await app.fetch(request("/v1/resolve", generated), env());
		const generatedRendered = await app.fetch(request("/v1/render", generated), env());
		expect(
			((await json(generatedResolved)).results as Array<Record<string, unknown>>)[0]?.dependencies,
		).toEqual([]);
		expect(
			((await json(generatedRendered)).results as Array<Record<string, unknown>>)[0]?.dependencies,
		).toEqual([{ site: null, page: "generated", iteration: 0 }]);
	});

	test("returns ordered partial render results without rolling back successful work", async () => {
		const bindings = env({ failContent: "fail" });
		const response = await app.fetch(
			request("/v1/render", {
				pages: [
					{ fullname: "ok", source: "Rendered\n[[html]]\nsuccess\n[[/html]]" },
					{ fullname: "missing", source: "[[include absent]]" },
					{ fullname: "block", source: "[[html]]\nfail\n[[/html]]" },
				],
				targets: ["ok", "missing", "block"],
			}),
			bindings,
		);
		const body = await json(response);
		const results = body.results as Array<Record<string, unknown>>;
		expect(response.status).toBe(200);
		expect(results.map(({ status }) => status)).toEqual(["ok", "missing_includes", "error"]);
		expect(results[0]?.html).toContain("Rendered");
		expect(results[1]?.html).toBeUndefined();
		expect(results[2]?.error_code).toBe("html_block_store_failed");
		expect(body.missing).toEqual([{ site: null, page: "absent", requested_by: ["missing"] }]);
		expect(bindings.puts).toEqual(["success"]);
	});

	test("renders missing includes when force is true", async () => {
		const response = await app.fetch(
			request("/v1/render", {
				pages: [{ fullname: "start", source: "[[include absent]]" }],
				targets: ["start"],
				force: true,
			}),
			env(),
		);
		const result = (await json(response)).results as Array<Record<string, unknown>>;
		expect(result[0]?.status).toBe("ok");
		expect(result[0]?.html).toContain("error-block");
	});

	test.each([
		[{ pages: [{ fullname: "a", source: "" }], targets: ["unknown"] }, "unknown_targets"],
		[{ pages: [{ fullname: "a", source: "" }], targets: [":other:a"] }, "cross_site_targets"],
		[
			{
				pages: [
					{ fullname: "A", source: "" },
					{ fullname: "/a/path", source: "" },
				],
				targets: ["a"],
			},
			"duplicate_keys",
		],
	] as const)("rejects invalid bulk references: %s", async (body, detailKey) => {
		const response = await app.fetch(request("/v1/render", body), env());
		const result = await json(response);
		expect(response.status).toBe(400);
		expect(result.code).toBe("validation");
		expect(result.detail).toHaveProperty(detailKey);
	});

	test("normalizes url_paths and rejects normalized collisions", async () => {
		const good = await app.fetch(
			request("/v1/render", {
				pages: [{ fullname: "Start", source: "[[[start]]]" }],
				targets: ["start"],
				url_paths: { "/START/path": "/custom" },
			}),
			env(),
		);
		expect(good.status).toBe(200);
		expect(normalizeUrlPaths({ "/START/path": "/custom" })).toEqual({ start: "/custom" });

		const bad = await app.fetch(
			request("/v1/render", {
				pages: [{ fullname: "start", source: "" }],
				targets: ["start"],
				url_paths: { Start: "/one", "/start/path": "/two" },
			}),
			env(),
		);
		expect(bad.status).toBe(400);
		expect((await json(bad)).detail).toEqual({ duplicate_url_paths: ["start"] });
	});

	test("does not read Object prototype properties as url_paths", async () => {
		for (const fullname of ["constructor", "__proto__"]) {
			const response = await app.fetch(
				request("/v1/render", {
					pages: [{ fullname, source: "Rendered" }],
					targets: [fullname],
				}),
				env(),
			);
			const result = ((await json(response)).results as Array<Record<string, unknown>>)[0];
			expect(result?.status).toBe("ok");
			expect(result?.html).toContain("Rendered");
		}

		const explicitPath = JSON.parse(
			'{"pages":[{"fullname":"__proto__","source":"[[module ListPages order=\\"fullname\\" offset=\\"@URL|0\\" limit=\\"1\\"]]\\n%%fullname%%\\n[[/module]]"},{"fullname":"a","source":""},{"fullname":"b","source":""}],"targets":["__proto__"],"url_paths":{"__proto__":"/__proto__/offset/1"}}',
		) as unknown;
		const response = await app.fetch(request("/v1/render", explicitPath), env());
		expect(response.status).toBe(200);
		const responseResult = ((await json(response)).results as Array<Record<string, unknown>>)[0];
		expect(responseResult?.html).toContain("<p>a</p>");
		const parsed = parseRequest(renderRequestSchema, explicitPath);
		const paths = normalizeUrlPaths(parsed.url_paths);
		expect(Object.hasOwn(paths, "__proto__")).toBe(true);
		expect(paths.__proto__).toBe("/__proto__/offset/1");
	});

	test("rejects invalid media, JSON, UTF-8, declared size, and measured size", async () => {
		const bindings = env();
		const headers = { Authorization: `Bearer ${validKey}`, "Content-Type": "application/json" };
		const invalidMedia = await app.fetch(
			new Request("https://api.example/v1/resolve", {
				method: "POST",
				headers: { ...headers, "Content-Type": "text/plain" },
				body: "{}",
			}),
			bindings,
		);
		expect(invalidMedia.status).toBe(415);

		const broken = await app.fetch(
			new Request("https://api.example/v1/resolve", { method: "POST", headers, body: "{" }),
			bindings,
		);
		expect(broken.status).toBe(400);

		const invalidUtf8 = await app.fetch(
			new Request("https://api.example/v1/resolve", {
				method: "POST",
				headers,
				body: new Uint8Array([0xff]),
			}),
			bindings,
		);
		expect(invalidUtf8.status).toBe(400);

		const declared = await app.fetch(
			new Request("https://api.example/v1/resolve", {
				method: "POST",
				headers: { ...headers, "Content-Length": "5000001" },
				body: "{}",
			}),
			bindings,
		);
		expect(declared.status).toBe(413);

		const measured = await app.fetch(
			new Request("https://api.example/v1/resolve", {
				method: "POST",
				headers,
				body: new Uint8Array(5_000_001),
			}),
			bindings,
		);
		expect(measured.status).toBe(413);
	});

	test("rejects more than 500 pages", async () => {
		const response = await app.fetch(
			request("/v1/resolve", {
				pages: Array.from({ length: 501 }, (_, index) => ({ fullname: `p-${index}`, source: "" })),
			}),
			env(),
		);
		expect(response.status).toBe(400);
		expect((await json(response)).code).toBe("validation");
	});

	test("allows empty pages and limits targets to the page count", async () => {
		const empty = await app.fetch(request("/v1/resolve", { pages: [] }), env());
		expect(empty.status).toBe(200);
		expect((await json(empty)).results).toEqual([]);

		for (const path of ["/v1/resolve", "/v1/render"]) {
			const response = await app.fetch(
				request(path, {
					pages: [{ fullname: "a", source: "" }],
					targets: ["a", "a"],
				}),
				env(),
			);
			expect(response.status).toBe(400);
			expect((await json(response)).code).toBe("validation");
		}
	});

	test("maps unhandled errors to JSON 500 and keeps JSON headers on errors", async () => {
		const consoleError = spyOn(console, "error").mockImplementation(() => undefined);
		const bindings = env();
		Object.defineProperty(bindings, "FILES_ORIGIN", {
			get() {
				throw new Error("configuration getter failed");
			},
		});
		const internal = await app.fetch(
			request("/v1/render", {
				pages: [{ fullname: "a", source: "" }],
				targets: ["a"],
			}),
			bindings,
		);
		expect(internal.status).toBe(500);
		expect(await json(internal)).toEqual({ error: "Internal server error", code: "internal" });

		for (const response of [
			internal,
			await app.fetch(new Request("https://api.example/v1/me"), {} as Bindings),
			await app.fetch(request("/v1/resolve", {}), env()),
			await app.fetch(request("/unknown"), {} as Bindings),
		]) {
			expect(response.headers.get("Content-Type")).toBe("application/json; charset=UTF-8");
			expect(response.headers.get("Cache-Control")).toBe("no-store");
		}
		consoleError.mockRestore();
	});
});
