import type { AuthPrincipal } from "../api/middleware/auth";

export interface Bindings {
	HTML_BLOCKS: R2Bucket;
	WPV4?: Fetcher;
	ENVIRONMENT: "development" | "staging" | "production";
	WPV4_ORIGIN?: string;
	FILES_ORIGIN: string;
	FILES_URL_SECRET: string;
	RENDER_RATE_LIMITER?: RateLimit;
}

export interface Variables {
	principal: AuthPrincipal;
}

export interface AppEnv {
	Bindings: Bindings;
	Variables: Variables;
}
