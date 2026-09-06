import { resolver, type DescribeRouteOptions, type GenerateSpecOptions } from "hono-openapi";
import { z } from "zod";
import { urlPathsSchema } from "./schema";

export function documentSchema(
	schema: z.ZodType,
	io: "input" | "output" = "output",
): ReturnType<typeof resolver> {
	const options: z.core.ToJSONSchemaParams = {
		io,
		override: ({ zodSchema, jsonSchema }) => {
			if (jsonSchema.examples === undefined) {
				if (jsonSchema.format === "date-time") jsonSchema.examples = ["2030-01-01T00:00:00Z"];
				else if (jsonSchema.type === "integer" || jsonSchema.type === "number")
					jsonSchema.examples = [0];
			}
			if (zodSchema === urlPathsSchema)
				Object.assign(jsonSchema, {
					type: "object",
					additionalProperties: { type: "string" },
					description: "Page fullname to request path. Keys are normalized; collisions return 400.",
				});
		},
	};
	return resolver(schema, { options });
}

export function jsonResponse(description: string, schema: z.ZodType) {
	return { description, content: { "application/json": { schema: documentSchema(schema) } } };
}

const errorSchema = z
	.object({ error: z.string(), code: z.string(), detail: z.unknown().optional() })
	.meta({ id: "Error" });

export const authErrors = {
	401: {
		...jsonResponse("Invalid or expired API key", errorSchema),
		headers: {
			"WWW-Authenticate": {
				schema: { type: "string" },
				description: "Bearer authentication challenge",
			},
		},
	},
	403: jsonResponse("Missing render:use scope", errorSchema),
	429: {
		...jsonResponse("Rate limit exceeded", errorSchema),
		headers: {
			"Retry-After": {
				schema: { type: "string", example: "60" },
				description: "Seconds before retry",
			},
		},
	},
	500: jsonResponse("Internal server error", errorSchema),
	503: jsonResponse("Authentication service unavailable", errorSchema),
} satisfies DescribeRouteOptions["responses"];

export const bulkErrors = {
	400: jsonResponse("Invalid JSON, UTF-8, or bulk input", errorSchema),
	413: jsonResponse("JSON body exceeds 5,000,000 bytes", errorSchema),
	415: jsonResponse("Content-Type must be application/json", errorSchema),
	...authErrors,
};
export const bearerSecurity = [{ bearerAuth: [] }];

export function bulkRequestBody(schema: z.ZodType) {
	return {
		required: true,
		description:
			"JSON body: at most 5,000,000 UTF-8 bytes. Each source: at most 1,000,000 UTF-8 bytes. Pages and targets: at most 20 each; targets cannot outnumber pages. Targets must be supplied local pages. Fullnames are normalized; collisions return 400.",
		content: {
			"application/json": {
				schema: documentSchema(schema, "input"),
				example: {
					pages: [{ fullname: "start", source: "+ Hello\nThis is **Wikidot** syntax." }],
					targets: ["start"],
				},
			},
		},
	};
}

export const openApiOptions = {
	exclude: ["/docs", "/swagger", "/openapi.json"],
	documentation: {
		openapi: "3.1.0",
		info: {
			title: "WDPR Render API",
			version: "1.0.0",
			description:
				"Resolve and render Wikidot pages from a supplied bulk. No wpv4 page data is read or written. Protected operations require an active API key with render:use. Staging and production allow 60 authenticated requests per key per 60 seconds. JSON responses use UTF-8 and Cache-Control: no-store.",
		},
		servers: [{ url: "/", description: "Current API origin" }],
		components: {
			securitySchemes: {
				bearerAuth: {
					type: "http",
					scheme: "bearer",
					description: "Enter the wpv4_ API key without the Bearer prefix. Requires render:use.",
				},
			},
		},
	},
} satisfies Partial<GenerateSpecOptions>;

export const redocHtml = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>WDPR Render API</title>
<style>body { margin: 0; } nav { padding: 12px 20px; font: 14px system-ui; border-bottom: 1px solid #ddd; } nav a { margin-right: 20px; }</style>
</head>
<body>
<nav aria-label="API documentation"><a href="/openapi.json">OpenAPI JSON</a><a href="/swagger">Try API in Swagger UI</a></nav>
<redoc spec-url="/openapi.json"></redoc>
<script src="https://cdn.jsdelivr.net/npm/redoc@2.5.3/bundles/redoc.standalone.js"></script>
</body>
</html>`;
