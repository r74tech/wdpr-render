import { Hono } from "hono";

const app = new Hono<{ Bindings: ApiEnv }>();

app.get("/v1/health", (context) => context.json({ ok: true }));

export default app;
