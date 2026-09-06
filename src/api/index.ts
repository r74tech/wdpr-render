import { Hono } from "hono";
import { cors } from "hono/cors";
import { swaggerUI } from "@hono/swagger-ui";
import { describeRoute, openAPIRouteHandler } from "hono-openapi";
import type { z } from "zod";
import {
	authErrors,
	bearerSecurity,
	jsonResponse,
	openApiOptions,
	redocHtml,
} from "./documentation";
import { healthResponseSchema } from "./results";
import { ApiError } from "./errors";
import { introspectionSchema, requireRenderKey } from "./middleware/auth";
import { renderRoutes } from "./routes/render";
import { resolveRoutes } from "./routes/resolve";
import type { AppEnv } from "../types/env";

const app = new Hono<AppEnv>();

app.use("*", async (context, next) => {
	context.header("Cache-Control", "no-store");
	await next();
	if (context.res.headers.get("Content-Type")?.startsWith("application/json")) {
		context.res.headers.set("Content-Type", "application/json; charset=UTF-8");
	}
});
app.use("/v1/*", cors({ origin: "*", allowHeaders: ["Authorization", "Content-Type"] }));

app.get("/openapi.json", openAPIRouteHandler(app, openApiOptions));
app.get("/docs", (context) => context.html(redocHtml));
app.get(
	"/swagger",
	swaggerUI({
		url: "/openapi.json",
		title: "WDPR Render API",
		validatorUrl: "",
		persistAuthorization: false,
	}),
);

app.on(
	"GET",
	["/", "/v1/health"],
	describeRoute({
		tags: ["Health"],
		summary: "Health check",
		security: [],
		responses: { 200: jsonResponse("Service versions", healthResponseSchema) },
	}),
	(context) =>
		context.json({ ok: true, versions: { parser: "5.1.6", render: "4.0.7" } } satisfies z.infer<
			typeof healthResponseSchema
		>),
);
app.use("/v1/me", requireRenderKey);
app.use("/v1/resolve", requireRenderKey);
app.use("/v1/render", requireRenderKey);
app.get(
	"/v1/me",
	describeRoute({
		operationId: "getMe",
		tags: ["Authentication"],
		summary: "Inspect the current API key",
		security: bearerSecurity,
		responses: {
			200: jsonResponse("Validated user and key metadata; never the raw key", introspectionSchema),
			...authErrors,
		},
	}),
	(context) => context.json(context.get("principal").me),
);
app.route("/v1/resolve", resolveRoutes);
app.route("/v1/render", renderRoutes);

app.notFound((context) => context.json({ error: "Route not found", code: "not_found" }, 404));
app.onError((error, context) => {
	if (error instanceof ApiError) {
		return context.json(
			{
				error: error.message,
				code: error.code,
				...(error.detail === undefined ? {} : { detail: error.detail }),
			},
			error.status,
		);
	}
	console.error("Unhandled API error", error);
	return context.json({ error: "Internal server error", code: "internal" }, 500);
});

export default app;
