import { Hono } from "hono";
import { cors } from "hono/cors";
import { ApiError } from "./errors";
import { requireRenderKey } from "./middleware/auth";
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

app.get("/v1/health", (context) =>
	context.json({ ok: true, versions: { parser: "5.1.6", render: "4.0.7" } }),
);
app.use("/v1/me", requireRenderKey);
app.use("/v1/resolve", requireRenderKey);
app.use("/v1/render", requireRenderKey);
app.get("/v1/me", (context) => context.json(context.get("principal").me));
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
