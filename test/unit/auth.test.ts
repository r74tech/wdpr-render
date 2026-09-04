import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import {
	AuthError,
	IntrospectionCache,
	authenticateRenderKey,
	createIntrospectionFetcher,
	requireRenderKey,
	type Introspection,
} from "../../src/api/middleware/auth";
import type { AppEnv, Bindings } from "../../src/types/env";

const validKey = `wpv4_${"A".repeat(43)}`;
const now = Date.parse("2026-09-04T12:00:00.000Z");

function me(overrides: Partial<Introspection["key"]> = {}): Introspection {
	return {
		user: { wikidot_id: 42, name: "Alice", unix_name: "alice" },
		key: { name: "Renderer", scopes: ["render:use"], expires_at: null, ...overrides },
	};
}

function response(body: unknown, status = 200): Response {
	return Response.json(body, { status });
}

async function expectAuthError(
	promise: Promise<unknown>,
	status: AuthError["status"],
	code: AuthError["code"],
) {
	try {
		await promise;
		expect.unreachable();
	} catch (error) {
		expect(error).toBeInstanceOf(AuthError);
		if (!(error instanceof AuthError)) return;
		expect(error.status).toBe(status);
		expect(error.code).toBe(code);
	}
}

describe("authenticateRenderKey", () => {
	test("rejects missing and malformed bearer credentials without introspection", async () => {
		let calls = 0;
		const fetchIntrospection = async () => {
			calls += 1;
			return response(me());
		};

		await expectAuthError(
			authenticateRenderKey({ authorization: undefined, fetchIntrospection, now }),
			401,
			"unauthorized",
		);
		await expectAuthError(
			authenticateRenderKey({ authorization: "Bearer invalid", fetchIntrospection, now }),
			401,
			"unauthorized",
		);
		expect(calls).toBe(0);
	});

	test("returns a principal and reuses a successful introspection", async () => {
		let calls = 0;
		const cache = new IntrospectionCache();
		const fetchIntrospection = async () => {
			calls += 1;
			return response(me());
		};

		const first = await authenticateRenderKey({
			authorization: `Bearer ${validKey}`,
			fetchIntrospection,
			cache,
			now,
		});
		const second = await authenticateRenderKey({
			authorization: `Bearer ${validKey}`,
			fetchIntrospection,
			cache,
			now: now + 59_000,
		});

		expect(first.me).toEqual(me());
		expect(first.keyHash).toMatch(/^[a-f0-9]{64}$/);
		expect(second).toEqual(first);
		expect(calls).toBe(1);
	});

	test("caches upstream 401 for ten seconds", async () => {
		let calls = 0;
		const cache = new IntrospectionCache();
		const fetchIntrospection = async () => {
			calls += 1;
			return response({ code: "unauthorized" }, 401);
		};

		for (const time of [now, now + 9_999]) {
			await expectAuthError(
				authenticateRenderKey({
					authorization: `Bearer ${validKey}`,
					fetchIntrospection,
					cache,
					now: time,
				}),
				401,
				"unauthorized",
			);
		}
		expect(calls).toBe(1);
	});

	test("rejects pages:render and caches the response before checking scope", async () => {
		let calls = 0;
		const cache = new IntrospectionCache();
		const fetchIntrospection = async () => {
			calls += 1;
			return response(me({ scopes: ["pages:render"] }));
		};

		for (const time of [now, now + 1_000]) {
			await expectAuthError(
				authenticateRenderKey({
					authorization: `Bearer ${validKey}`,
					fetchIntrospection,
					cache,
					now: time,
				}),
				403,
				"insufficient_scope",
			);
		}
		expect(calls).toBe(1);
	});

	test.each([
		[500, { code: "internal" }],
		[200, { nope: true }],
		[200, me({ expires_at: "not-a-date" })],
	] as const)("maps upstream status/body failures to 503: %s", async (status, body) => {
		await expectAuthError(
			authenticateRenderKey({
				authorization: `Bearer ${validKey}`,
				fetchIntrospection: async () => response(body, status),
				now,
			}),
			503,
			"upstream_auth_unavailable",
		);
	});

	test("rejects an expired response without caching it", async () => {
		let calls = 0;
		const cache = new IntrospectionCache();
		const fetchIntrospection = async () => {
			calls += 1;
			return response(me({ expires_at: new Date(now).toISOString() }));
		};

		for (let index = 0; index < 2; index += 1) {
			await expectAuthError(
				authenticateRenderKey({
					authorization: `Bearer ${validKey}`,
					fetchIntrospection,
					cache,
					now,
				}),
				401,
				"unauthorized",
			);
		}
		expect(calls).toBe(2);
	});

	test("cuts the successful cache TTL at key expiry", async () => {
		let calls = 0;
		const cache = new IntrospectionCache();
		const fetchIntrospection = async () => {
			calls += 1;
			return response(me({ expires_at: new Date(now + 30_000).toISOString() }));
		};

		await authenticateRenderKey({
			authorization: `Bearer ${validKey}`,
			fetchIntrospection,
			cache,
			now,
		});
		await authenticateRenderKey({
			authorization: `Bearer ${validKey}`,
			fetchIntrospection,
			cache,
			now: now + 29_999,
		});
		await expectAuthError(
			authenticateRenderKey({
				authorization: `Bearer ${validKey}`,
				fetchIntrospection,
				cache,
				now: now + 30_000,
			}),
			401,
			"unauthorized",
		);
		expect(calls).toBe(2);
	});

	test("times out introspection", async () => {
		await expectAuthError(
			authenticateRenderKey({
				authorization: `Bearer ${validKey}`,
				fetchIntrospection: async (_key, signal) =>
					new Promise((_resolve, reject) => {
						signal.addEventListener("abort", () => reject(signal.reason));
					}),
				now,
				timeoutMs: 5,
			}),
			503,
			"upstream_auth_unavailable",
		);
	});

	test("enforces the timeout when the fetcher ignores AbortSignal", async () => {
		await expectAuthError(
			authenticateRenderKey({
				authorization: `Bearer ${validKey}`,
				fetchIntrospection: async () => new Promise(() => undefined),
				now,
				timeoutMs: 5,
			}),
			503,
			"upstream_auth_unavailable",
		);
	});

	test("enforces rate limits by API-key hash and fails open on limiter errors", async () => {
		const keys: string[] = [];
		await expectAuthError(
			authenticateRenderKey({
				authorization: `Bearer ${validKey}`,
				fetchIntrospection: async () => response(me()),
				rateLimiter: {
					async limit({ key }) {
						keys.push(key);
						return { success: false };
					},
				},
				now,
			}),
			429,
			"rate_limited",
		);
		expect(keys[0]).toMatch(/^apikey:[a-f0-9]{16}$/);

		const principal = await authenticateRenderKey({
			authorization: `Bearer ${validKey}`,
			fetchIntrospection: async () => response(me()),
			rateLimiter: { limit: async () => Promise.reject(new Error("limiter unavailable")) },
			now,
		});
		expect(principal.me.user.name).toBe("Alice");
	});
});

describe("IntrospectionCache", () => {
	test("removes expired entries before evicting the oldest live entry", () => {
		const cache = new IntrospectionCache(2);
		cache.setSuccess("expired", me(), now, now + 1);
		cache.setSuccess("oldest-live", me(), now, now + 60_000);
		cache.setSuccess("new", me(), now + 2, now + 60_000);

		expect(cache.get("expired", now + 2)).toBeUndefined();
		expect(cache.get("oldest-live", now + 2)?.kind).toBe("success");
		expect(cache.get("new", now + 2)?.kind).toBe("success");

		cache.setSuccess("newest", me(), now + 3, now + 60_000);
		expect(cache.get("oldest-live", now + 3)).toBeUndefined();
		expect(cache.get("new", now + 3)?.kind).toBe("success");
		expect(cache.get("newest", now + 3)?.kind).toBe("success");
	});
});

describe("createIntrospectionFetcher", () => {
	test("requires a service binding outside development", () => {
		expect(() => createIntrospectionFetcher({ ENVIRONMENT: "staging", WPV4: undefined })).toThrow(
			AuthError,
		);
	});

	test("uses the configured HTTP origin only in development", async () => {
		let request: Request | undefined;
		const fetchIntrospection = createIntrospectionFetcher(
			{ ENVIRONMENT: "development", WPV4_ORIGIN: "http://localhost:5173" },
			async (input, init) => {
				request = new Request(input, init);
				return response(me());
			},
		);

		await fetchIntrospection(validKey, new AbortController().signal);

		expect(request?.url).toBe("http://localhost:5173/api/v1/me");
		expect(request?.headers.get("Authorization")).toBe(`Bearer ${validKey}`);
	});

	test("uses the service binding in staging", async () => {
		let request: Request | undefined;
		const fetchIntrospection = createIntrospectionFetcher({
			ENVIRONMENT: "staging",
			WPV4: {
				async fetch(input: RequestInfo | URL, init?: RequestInit) {
					request = new Request(input, init);
					return response(me());
				},
			} as Fetcher,
		});

		await fetchIntrospection(validKey, new AbortController().signal);

		expect(request?.url).toBe("https://wpv4.internal/api/v1/me");
		expect(request?.headers.get("Authorization")).toBe(`Bearer ${validKey}`);
	});
});

describe("requireRenderKey", () => {
	function app() {
		const app = new Hono<AppEnv>();
		app.use("/*", requireRenderKey);
		app.get("/", (context) => context.json({ ok: true }));
		return app;
	}

	test("returns 401 before checking the staging service binding", async () => {
		const result = await app().fetch(new Request("https://example.test/"), {
			ENVIRONMENT: "staging",
		} as unknown as Bindings);

		expect(result.status).toBe(401);
		expect(result.headers.get("WWW-Authenticate")).toBe('Bearer realm="wdpr-render"');
		const body: unknown = await result.json();
		expect(body).toEqual({
			error: "Invalid or expired API key",
			code: "unauthorized",
		});
	});

	test("returns Retry-After when the rate limiter rejects a key", async () => {
		const key = `wpv4_${"B".repeat(43)}`;
		const result = await app().fetch(
			new Request("https://example.test/", {
				headers: { Authorization: `Bearer ${key}` },
			}),
			{
				ENVIRONMENT: "staging",
				WPV4: { fetch: async () => response(me()) } as unknown as Fetcher,
				RENDER_RATE_LIMITER: { limit: async () => ({ success: false }) },
			} as unknown as Bindings,
		);

		expect(result.status).toBe(429);
		expect(result.headers.get("Retry-After")).toBe("60");
		const body: unknown = await result.json();
		expect(body).toEqual({
			error: "Rate limit exceeded",
			code: "rate_limited",
		});
	});
});
