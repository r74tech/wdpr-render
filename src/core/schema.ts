import { z } from "zod";

export const missingIncludeSchema = z.object({
	site: z.string().nullable(),
	page: z.string(),
	requested_by: z.array(z.string()),
});
export type MissingInclude = z.infer<typeof missingIncludeSchema>;

export const dependencySchema = z.object({
	site: z.string().nullable(),
	page: z.string(),
	iteration: z.number().int(),
});
export type Dependency = z.infer<typeof dependencySchema>;

export const htmlBlockMetadataSchema = z.object({
	index: z.number().int(),
	hash: z.string(),
	url: z.string(),
	expires_at: z
		.number()
		.int()
		.meta({
			description: "URL expiration as Unix seconds (UTC), 24 hours after rendering.",
			examples: [1893542400],
		}),
});
export type HtmlBlockMetadata = z.infer<typeof htmlBlockMetadataSchema>;

export const renderDiagnosticSchema = z.object({
	severity: z.string(),
	code: z.string(),
	message: z.string(),
});
export type RenderDiagnostic = z.infer<typeof renderDiagnosticSchema>;

const targetResultSchema = z.object({
	requested: z.string(),
	fullname: z.string(),
	dependencies: z.array(dependencySchema),
	missing: z.array(missingIncludeSchema),
	input_bytes: z.number().int(),
});

export const resolveTargetResultSchema = targetResultSchema.extend({
	status: z.enum(["ok", "missing_includes"]),
	reached_max_iterations: z.boolean(),
	expanded_bytes: z.number().int(),
});
export type ResolveTargetResult = z.infer<typeof resolveTargetResultSchema>;

export const renderTargetResultSchema = targetResultSchema.extend({
	status: z.enum(["ok", "missing_includes", "error"]),
	html: z.string().optional(),
	styles: z.array(z.string()).optional(),
	html_blocks: z.array(htmlBlockMetadataSchema).optional(),
	diagnostics: z.array(renderDiagnosticSchema),
	error_code: z.enum(["render_failed", "html_block_store_failed"]).optional(),
	error_message: z.string().optional(),
});
export type RenderTargetResult = z.infer<typeof renderTargetResultSchema>;
