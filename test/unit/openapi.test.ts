import { expect, test } from "bun:test";
import app from "../../src/api";
import type { openApiDocument } from "../../src/api/openapi";

test("serves OpenAPI and Swagger UI without credentials", async () => {
	const response = await app.request("/openapi.json");
	expect(response.status).toBe(200);
	const spec = (await response.json()) as typeof openApiDocument;
	expect(spec.openapi).toBe("3.1.0");
	expect(Object.keys(spec.paths).sort()).toEqual([
		"/",
		"/v1/health",
		"/v1/me",
		"/v1/render",
		"/v1/resolve",
	]);
	expect(spec.paths["/v1/render"].post.security).toEqual([{ bearerAuth: [] }]);
	expect(spec.paths["/v1/health"].get.security).toEqual([]);
	const input = spec.components.schemas.RenderRequest;
	expect(input).toMatchObject({
		required: ["pages", "targets"],
		properties: {
			pages: { maxItems: 20 },
			targets: { maxItems: 20 },
			url_paths: { type: "object", additionalProperties: { type: "string" } },
		},
	});
	expect(spec.components.schemas.ResolveRequest.required).toEqual(["pages"]);
	const ui = await app.request("/docs");
	expect(ui.status).toBe(200);
	expect(ui.headers.get("Content-Type")).toContain("text/html");
	expect(await ui.text()).toContain("/openapi.json");
});
