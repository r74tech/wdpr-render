import { expect, test } from "bun:test";
import { Hono } from "hono";
import { generateSpecs } from "hono-openapi";
import app from "../../src/api";
import { resolveRoutes } from "../../src/api/routes/resolve";

test("serves generated OpenAPI, Redoc and Swagger UI without credentials", async () => {
	const response = await app.request("/openapi.json");
	expect(response.status).toBe(200);
	const spec = (await response.json()) as Awaited<ReturnType<typeof generateSpecs>>;
	expect(spec.openapi).toBe("3.1.0");
	expect(Object.keys(spec.paths).sort()).toEqual([
		"/",
		"/v1/health",
		"/v1/me",
		"/v1/render",
		"/v1/resolve",
	]);
	expect(spec.paths["/v1/render"].post?.security).toEqual([{ bearerAuth: [] }]);
	expect(spec.paths["/v1/health"].get?.security).toEqual([]);
	const input = spec.components.schemas?.RenderRequest;
	expect(input).toMatchObject({
		required: ["pages", "targets"],
		properties: {
			pages: {
				maxItems: 20,
				items: {
					properties: {
						created_at: { format: "date-time", examples: ["2030-01-01T00:00:00Z"] },
					},
				},
			},
			targets: { maxItems: 20 },
			url_paths: { type: "object", additionalProperties: { type: "string" } },
		},
	});
	expect(spec.components.schemas?.ResolveRequest).toMatchObject({ required: ["pages"] });
	expect(spec.components.schemas?.Me).toMatchObject({
		examples: [
			{
				user: { wikidot_id: 123456 },
				key: { scopes: ["render:use"], expires_at: "2030-01-02T00:00:00Z" },
			},
		],
	});
	const ui = await app.request("/docs");
	expect(ui.status).toBe(200);
	expect(ui.headers.get("Content-Type")).toContain("text/html");
	expect(await ui.text()).toContain('<redoc spec-url="/openapi.json"');
	const swagger = await app.request("/swagger");
	expect(swagger.status).toBe(200);
	expect(await swagger.text()).toContain("SwaggerUIBundle");
});

test("generates paths from the mounted Hono routes", async () => {
	const mounted = new Hono().route("/preview/includes", resolveRoutes);
	const spec = await generateSpecs(mounted);
	expect(Object.keys(spec.paths)).toEqual(["/preview/includes"]);
	expect(spec.paths["/preview/includes"].post).toMatchObject({
		operationId: "resolveIncludes",
		requestBody: {
			content: { "application/json": { schema: { $ref: "#/components/schemas/ResolveRequest" } } },
		},
	});
});
