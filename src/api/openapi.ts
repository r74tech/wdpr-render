import { z } from "zod";
import { introspectionSchema } from "./middleware/auth";
import { renderRequestSchema, resolveRequestSchema, urlPathsSchema } from "./schema";

const missing = z.object({
	site: z.string().nullable(),
	page: z.string(),
	requested_by: z.array(z.string()),
});
const dependency = z.object({
	site: z.string().nullable(),
	page: z.string(),
	iteration: z.number().int(),
});
const result = z.object({
	requested: z.string(),
	fullname: z.string(),
	dependencies: z.array(dependency),
	missing: z.array(missing),
	input_bytes: z.number().int(),
});
const resolveResult = result.extend({
	status: z.enum(["ok", "missing_includes"]),
	reached_max_iterations: z.boolean(),
	expanded_bytes: z.number().int(),
});
const renderResult = result.extend({
	status: z.enum(["ok", "missing_includes", "error"]),
	html: z.string().optional(),
	styles: z.array(z.string()).optional(),
	html_blocks: z
		.array(
			z.object({
				index: z.number().int(),
				hash: z.string(),
				url: z.string(),
				expires_at: z.number().int(),
			}),
		)
		.optional(),
	diagnostics: z.array(z.object({ severity: z.string(), code: z.string(), message: z.string() })),
	error_code: z.enum(["render_failed", "html_block_store_failed"]).optional(),
	error_message: z.string().optional(),
});
const health = z.object({
	ok: z.literal(true),
	versions: z.object({ parser: z.string(), render: z.string() }),
});

function jsonSchema(schema: z.ZodType, io: "input" | "output" = "output") {
	return z.toJSONSchema(schema, {
		io,
		target: "draft-2020-12",
		override: ({ zodSchema, jsonSchema }) => {
			if (zodSchema === urlPathsSchema) {
				Object.assign(jsonSchema, {
					type: "object",
					additionalProperties: { type: "string" },
					description: "Page fullname to request path. Keys are normalized; collisions return 400.",
				});
			}
		},
	});
}

function response(description: string, schema: string) {
	return {
		description,
		content: { "application/json": { schema: { $ref: `#/components/schemas/${schema}` } } },
	};
}

const authErrors = {
	401: {
		...response("Invalid or expired API key", "Error"),
		headers: {
			"WWW-Authenticate": {
				schema: { type: "string" },
				description: "Bearer authentication challenge",
			},
		},
	},
	403: response("Missing render:use scope", "Error"),
	429: {
		...response("Rate limit exceeded", "Error"),
		headers: {
			"Retry-After": {
				schema: { type: "string", example: "60" },
				description: "Seconds before retry",
			},
		},
	},
	500: response("Internal server error", "Error"),
	503: response("Authentication service unavailable", "Error"),
};
const bearerSecurity = [{ bearerAuth: [] }];
const bulkExample = {
	pages: [{ fullname: "start", source: "+ Hello\nThis is **Wikidot** syntax." }],
	targets: ["start"],
};
const requestDescription =
	"JSON body: at most 5,000,000 UTF-8 bytes. Each source: at most 1,000,000 UTF-8 bytes. Pages and targets: at most 20 each; targets cannot outnumber pages. Targets must be supplied local pages. Fullnames are normalized; collisions return 400.";

function bulkOperation(kind: "resolve" | "render") {
	const name = kind === "resolve" ? "Resolve" : "Render";
	return {
		operationId: kind === "resolve" ? "resolveIncludes" : "renderPages",
		tags: ["Pages"],
		summary: kind === "resolve" ? "Resolve include dependencies" : "Render Wikidot pages",
		description:
			kind === "resolve"
				? "Expands raw includes. Omitted targets selects all local pages. Add reported missing pages to the bulk and repeat before rendering."
				: "Returns results in target order. missing_includes omits HTML unless force is true. A per-target error also omits HTML and does not roll back other results. These statuses are returned with HTTP 200. HTML block URLs expire after 24 hours. Dependencies reflect the full render pipeline and can differ from resolve.",
		security: bearerSecurity,
		requestBody: {
			required: true,
			description: requestDescription,
			content: {
				"application/json": {
					schema: { $ref: `#/components/schemas/${name}Request` },
					example: bulkExample,
				},
			},
		},
		responses: {
			200: response("Per-target results and aggregate missing includes", `${name}Response`),
			400: response("Invalid JSON, UTF-8, or bulk input", "Error"),
			413: response("JSON body exceeds 5,000,000 bytes", "Error"),
			415: response("Content-Type must be application/json", "Error"),
			...authErrors,
		},
	};
}

export const openApiDocument = {
	openapi: "3.1.0",
	info: {
		title: "WDPR Render API",
		version: "1.0.0",
		description:
			"Resolve and render Wikidot pages from a supplied bulk. No wpv4 page data is read or written. Protected operations require an active API key with render:use. Staging and production allow 60 authenticated requests per key per 60 seconds. JSON responses use UTF-8 and Cache-Control: no-store.",
	},
	servers: [{ url: "/", description: "Current API origin" }],
	paths: {
		"/": {
			get: {
				operationId: "rootHealth",
				tags: ["Health"],
				summary: "Health check",
				security: [],
				responses: { 200: response("Service versions", "Health") },
			},
		},
		"/v1/health": {
			get: {
				operationId: "getHealth",
				tags: ["Health"],
				summary: "Health check",
				security: [],
				responses: { 200: response("Service versions", "Health") },
			},
		},
		"/v1/me": {
			get: {
				operationId: "getMe",
				tags: ["Authentication"],
				summary: "Inspect the current API key",
				security: bearerSecurity,
				responses: {
					200: response("Validated user and key metadata; never the raw key", "Me"),
					...authErrors,
				},
			},
		},
		"/v1/resolve": { post: bulkOperation("resolve") },
		"/v1/render": { post: bulkOperation("render") },
	},
	components: {
		securitySchemes: {
			bearerAuth: {
				type: "http",
				scheme: "bearer",
				description: "Enter the wpv4_ API key without the Bearer prefix. Requires render:use.",
			},
		},
		schemas: {
			Health: jsonSchema(health),
			Me: jsonSchema(introspectionSchema),
			ResolveRequest: jsonSchema(resolveRequestSchema, "input"),
			RenderRequest: jsonSchema(renderRequestSchema, "input"),
			ResolveResponse: jsonSchema(
				z.object({
					results: z.array(resolveResult),
					missing: z.array(missing),
					elapsed_ms: z.number(),
				}),
			),
			RenderResponse: jsonSchema(
				z.object({
					results: z.array(renderResult),
					missing: z.array(missing),
					elapsed_ms: z.number(),
				}),
			),
			Error: jsonSchema(
				z.object({ error: z.string(), code: z.string(), detail: z.unknown().optional() }),
			),
		},
	},
};
