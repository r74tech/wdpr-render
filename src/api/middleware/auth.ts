import { z } from "zod";
import { createMiddleware } from "hono/factory";
import { sha256Hex } from "../../core/signed-url";
import type { AppEnv, Bindings } from "../../types/env";
import { tryRenderRateLimit, type RenderRateLimiter } from "./rate-limit";

const API_KEY_PATTERN = /^wpv4_[A-Za-z0-9_-]{43}$/;
const SUCCESS_CACHE_TTL_MS = 60_000;
const UNAUTHORIZED_CACHE_TTL_MS = 10_000;
const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_CACHE_CAPACITY = 1_000;

export const introspectionSchema = z.object({
	user: z.object({
		wikidot_id: z.number().int(),
		name: z.string(),
		unix_name: z.string(),
	}),
	key: z.object({
		name: z.string(),
		scopes: z.array(z.string()),
		expires_at: z.union([z.iso.datetime({ offset: true }), z.null()]),
	}),
});

export type Introspection = z.infer<typeof introspectionSchema>;

export interface AuthPrincipal {
	keyHash: string;
	me: Introspection;
}

export class AuthError extends Error {
	readonly status: 401 | 403 | 429 | 503;
	readonly code:
		| "unauthorized"
		| "insufficient_scope"
		| "rate_limited"
		| "upstream_auth_unavailable";

	constructor(status: AuthError["status"], code: AuthError["code"], message: string) {
		super(message);
		this.name = "AuthError";
		this.status = status;
		this.code = code;
	}
}

export type IntrospectionCacheEntry =
	| { kind: "success"; value: Introspection; expiresAt: number }
	| { kind: "unauthorized"; expiresAt: number };

export class IntrospectionCache {
	readonly #capacity: number;
	readonly #entries = new Map<string, IntrospectionCacheEntry>();

	constructor(capacity = DEFAULT_CACHE_CAPACITY) {
		this.#capacity = capacity;
	}

	get(key: string, now: number): IntrospectionCacheEntry | undefined {
		const entry = this.#entries.get(key);
		if (entry && entry.expiresAt <= now) {
			this.#entries.delete(key);
			return undefined;
		}
		return entry;
	}

	setSuccess(key: string, value: Introspection, now: number, expiresAt: number): void {
		this.#set(key, { kind: "success", value, expiresAt }, now);
	}

	setUnauthorized(key: string, now: number): void {
		this.#set(key, { kind: "unauthorized", expiresAt: now + UNAUTHORIZED_CACHE_TTL_MS }, now);
	}

	#set(key: string, entry: IntrospectionCacheEntry, now: number): void {
		for (const [cachedKey, cached] of this.#entries) {
			if (cached.expiresAt <= now) this.#entries.delete(cachedKey);
		}
		this.#entries.delete(key);
		while (this.#entries.size >= this.#capacity) {
			const oldest = this.#entries.keys().next().value;
			if (oldest === undefined) break;
			this.#entries.delete(oldest);
		}
		this.#entries.set(key, entry);
	}
}

export type FetchIntrospection = (apiKey: string, signal: AbortSignal) => Promise<Response>;

type GlobalFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export function createIntrospectionFetcher(
	env: Pick<Bindings, "ENVIRONMENT" | "WPV4" | "WPV4_ORIGIN">,
	globalFetch: GlobalFetch = fetch,
): FetchIntrospection {
	if (env.ENVIRONMENT === "development") {
		if (!env.WPV4_ORIGIN) throw unavailable();
		return (apiKey, signal) =>
			globalFetch(new URL("/api/v1/me", env.WPV4_ORIGIN), {
				headers: { Authorization: `Bearer ${apiKey}` },
				signal,
			});
	}
	if (!env.WPV4) throw unavailable();
	return (apiKey, signal) =>
		env.WPV4!.fetch(
			new Request("https://wpv4.internal/api/v1/me", {
				headers: { Authorization: `Bearer ${apiKey}` },
				signal,
			}),
		);
}

export interface AuthenticateRenderKeyInput {
	authorization: string | undefined;
	fetchIntrospection: FetchIntrospection;
	cache?: IntrospectionCache;
	rateLimiter?: RenderRateLimiter;
	now?: number;
	timeoutMs?: number;
	onLimiterError?: (error: unknown) => void;
}

export async function authenticateRenderKey({
	authorization,
	fetchIntrospection,
	cache = new IntrospectionCache(),
	rateLimiter,
	now = Date.now(),
	timeoutMs = DEFAULT_TIMEOUT_MS,
	onLimiterError,
}: AuthenticateRenderKeyInput): Promise<AuthPrincipal> {
	const apiKey = parseBearerKey(authorization);
	const keyHash = await sha256Hex(apiKey);
	const cached = cache.get(keyHash, now);
	let introspection: Introspection;

	if (cached?.kind === "unauthorized") throw unauthorized();
	if (cached?.kind === "success") {
		introspection = cached.value;
	} else {
		const response = await fetchWithTimeout(fetchIntrospection, apiKey, timeoutMs);
		if (response.status === 401) {
			cache.setUnauthorized(keyHash, now);
			throw unauthorized();
		}
		if (!response.ok) throw unavailable();

		let body: unknown;
		try {
			body = await response.json();
		} catch {
			throw unavailable();
		}
		const parsed = introspectionSchema.safeParse(body);
		if (!parsed.success) throw unavailable();
		introspection = parsed.data;
		const keyExpiresAt = introspection.key.expires_at
			? Date.parse(introspection.key.expires_at)
			: null;
		if (keyExpiresAt !== null && keyExpiresAt <= now) throw unauthorized();
		cache.setSuccess(
			keyHash,
			introspection,
			now,
			Math.min(now + SUCCESS_CACHE_TTL_MS, keyExpiresAt ?? Number.POSITIVE_INFINITY),
		);
	}

	if (!introspection.key.scopes.includes("render:use")) {
		throw new AuthError(403, "insufficient_scope", "Missing scope: render:use");
	}
	if (!(await tryRenderRateLimit(rateLimiter, keyHash, onLimiterError))) {
		throw new AuthError(429, "rate_limited", "Rate limit exceeded");
	}
	return { keyHash, me: introspection };
}

function parseBearerKey(authorization: string | undefined): string {
	if (!authorization?.startsWith("Bearer ")) throw unauthorized();
	const apiKey = authorization.slice("Bearer ".length);
	if (!API_KEY_PATTERN.test(apiKey)) throw unauthorized();
	return apiKey;
}

async function fetchWithTimeout(
	fetchIntrospection: FetchIntrospection,
	apiKey: string,
	timeoutMs: number,
): Promise<Response> {
	const controller = new AbortController();
	let timeout: ReturnType<typeof setTimeout>;
	const timedOut = new Promise<never>((_resolve, reject) => {
		timeout = setTimeout(() => {
			controller.abort(new Error("Introspection timed out"));
			reject(unavailable());
		}, timeoutMs);
	});
	try {
		return await Promise.race([fetchIntrospection(apiKey, controller.signal), timedOut]);
	} catch {
		throw unavailable();
	} finally {
		clearTimeout(timeout!);
	}
}

function unauthorized(): AuthError {
	return new AuthError(401, "unauthorized", "Invalid or expired API key");
}

function unavailable(): AuthError {
	return new AuthError(503, "upstream_auth_unavailable", "Authentication service unavailable");
}

const introspectionCache = new IntrospectionCache();

export const requireRenderKey = createMiddleware<AppEnv>(async (context, next) => {
	context.header("Cache-Control", "no-store");
	try {
		const principal = await authenticateRenderKey({
			authorization: context.req.header("Authorization"),
			fetchIntrospection: (apiKey, signal) =>
				createIntrospectionFetcher(context.env)(apiKey, signal),
			cache: introspectionCache,
			rateLimiter: context.env.RENDER_RATE_LIMITER,
			onLimiterError: (error) => console.error("Render rate limiter unavailable", error),
		});
		context.set("principal", principal);
		await next();
	} catch (error) {
		if (!(error instanceof AuthError)) throw error;
		if (error.status === 401) context.header("WWW-Authenticate", 'Bearer realm="wdpr-render"');
		if (error.status === 429) context.header("Retry-After", "60");
		return context.json({ error: error.message, code: error.code }, error.status);
	}
});
