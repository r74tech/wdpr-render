import { z } from "zod";
import { ApiError } from "./errors";

const encoder = new TextEncoder();
const MAX_BULK_ENTRIES = 20;
const siteName = z.string().regex(/^[a-z0-9-]{1,64}$/);
const isoDate = z.iso.datetime({ offset: true });
const source = z.string().superRefine((value, context) => {
	if (encoder.encode(value).byteLength > 1_000_000) {
		context.addIssue({ code: "custom", message: "Source exceeds 1000000 bytes" });
	}
});

const siteSchema = z
	.object({
		name: siteName,
		title: z.string().max(128).optional(),
		domain: z.string().max(253).optional(),
	})
	.transform((site) => ({
		name: site.name,
		title: site.title ?? "Render",
		domain: site.domain ?? "",
	}));

const pageSchema = z.object({
	site: siteName.nullish(),
	fullname: z.string().min(1).max(256),
	source,
	title: z.string().max(256).optional(),
	tags: z.array(z.string()).max(100).optional(),
	created_at: isoDate.optional(),
	updated_at: isoDate.optional(),
	created_by: z
		.object({ id: z.number().int(), name: z.string(), unix_name: z.string() })
		.optional(),
	rating: z.number().optional(),
	rating_votes: z.number().optional(),
});

export const urlPathsSchema = z.unknown().transform((value, context): Record<string, string> => {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		context.addIssue({ code: "custom", message: "URL paths must be an object" });
		return z.NEVER;
	}
	const paths = Object.create(null) as Record<string, string>;
	for (const [key, path] of Object.entries(value)) {
		if (typeof path !== "string") {
			context.addIssue({ code: "custom", path: [key], message: "URL path must be a string" });
			continue;
		}
		paths[key] = path;
	}
	return paths;
});

const baseSchema = z.object({
	site: siteSchema.default({ name: "render", title: "Render", domain: "" }),
	pages: z.array(pageSchema).max(MAX_BULK_ENTRIES),
});

export const resolveRequestSchema = baseSchema
	.extend({
		targets: z.array(z.string().min(1).max(256)).max(MAX_BULK_ENTRIES).optional(),
	})
	.superRefine(targetsWithinPages)
	.meta({ id: "ResolveRequest" });

export const renderRequestSchema = baseSchema
	.extend({
		targets: z.array(z.string().min(1).max(256)).max(MAX_BULK_ENTRIES),
		force: z.boolean().default(false),
		viewer: z.object({ number: z.number(), title: z.string(), name: z.string() }).optional(),
		users: z
			.array(
				z.object({
					unix_name: z.string(),
					name: z.string(),
					id: z.number().optional(),
					avatar_url: z.string().optional(),
				}),
			)
			.max(1_000)
			.optional(),
		existing_pages: z.array(z.string()).max(10_000).optional(),
		url_paths: urlPathsSchema.optional(),
	})
	.superRefine(targetsWithinPages)
	.meta({ id: "RenderRequest" });

export type ResolveRequest = z.infer<typeof resolveRequestSchema>;
export type RenderRequest = z.infer<typeof renderRequestSchema>;

export function parseRequest<T>(schema: z.ZodType<T>, input: unknown): T {
	const result = schema.safeParse(input);
	if (!result.success) {
		throw new ApiError(400, "validation", "Request validation failed", {
			issues: result.error.issues,
		});
	}
	return result.data;
}

function targetsWithinPages(
	input: { pages: unknown[]; targets?: unknown[] },
	context: z.RefinementCtx,
): void {
	if (input.targets && input.targets.length > input.pages.length) {
		context.addIssue({
			code: "custom",
			path: ["targets"],
			message: "Targets cannot exceed the number of pages",
		});
	}
}
