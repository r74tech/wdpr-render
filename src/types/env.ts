import type { AuthPrincipal } from "../api/middleware/auth";

export type Bindings = Pick<
	ApiEnv,
	| "HTML_BLOCKS"
	| "WPV4"
	| "ENVIRONMENT"
	| "WPV4_ORIGIN"
	| "FILES_ORIGIN"
	| "FILES_URL_SECRET"
	| "RENDER_RATE_LIMITER"
>;

export interface Variables {
	principal: AuthPrincipal;
}

export interface AppEnv {
	Bindings: Bindings;
	Variables: Variables;
}
