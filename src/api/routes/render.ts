import { Hono } from "hono";
import { describeRoute } from "hono-openapi";
import { buildBulk, parseTargets, normalizeFullname, BulkInputError } from "../../core/bulk";
import { renderTarget } from "../../core/render";
import { readJsonBody } from "../../lib/json-body";
import type { AppEnv } from "../../types/env";
import { ApiError } from "../errors";
import { validateFilesOrigin } from "../origin";
import { aggregateMissing, renderResponseSchema, type RenderResponse } from "../results";
import { bearerSecurity, bulkErrors, bulkRequestBody, jsonResponse } from "../documentation";
import { parseRequest, renderRequestSchema } from "../schema";

export const renderRoutes = new Hono<AppEnv>().post(
	"/",
	describeRoute({
		operationId: "renderPages",
		tags: ["Pages"],
		summary: "Render Wikidot pages",
		description:
			"Returns results in target order. missing_includes omits HTML unless force is true. A per-target error also omits HTML and does not roll back other results. These statuses are returned with HTTP 200. HTML block URLs expire after 24 hours. Dependencies reflect the full render pipeline and can differ from resolve.",
		security: bearerSecurity,
		requestBody: bulkRequestBody(renderRequestSchema),
		responses: {
			200: jsonResponse("Per-target results and aggregate missing includes", renderResponseSchema),
			...bulkErrors,
		},
	}),
	async (context) => {
		const startedAt = Date.now();
		const body = parseRequest(renderRequestSchema, await readJsonBody(context.req.raw));
		try {
			const bulk = buildBulk(body);
			const targets = parseTargets(bulk, body.targets);
			const urlPaths = normalizeUrlPaths(body.url_paths);
			const filesOrigin = validateFilesOrigin(context.env.FILES_ORIGIN, context.env.ENVIRONMENT);
			const expiresAt = Math.floor(startedAt / 1_000) + 86_400;
			const results = [];
			for (const target of targets) {
				results.push(
					await renderTarget({
						bulk,
						target,
						force: body.force,
						viewer: body.viewer,
						users: body.users,
						existingPages: body.existing_pages,
						urlPaths,
						bucket: context.env.HTML_BLOCKS,
						filesOrigin,
						filesUrlSecret: context.env.FILES_URL_SECRET,
						htmlBlockExpiresAt: expiresAt,
					}),
				);
			}
			return context.json({
				results,
				missing: aggregateMissing(results),
				elapsed_ms: Date.now() - startedAt,
			} satisfies RenderResponse);
		} catch (error) {
			if (error instanceof BulkInputError) {
				throw new ApiError(400, "validation", error.message, error.detail);
			}
			throw error;
		}
	},
);

export function normalizeUrlPaths(
	input: Readonly<Record<string, string>> | undefined,
): Record<string, string> {
	const normalized = Object.create(null) as Record<string, string>;
	const duplicates = new Set<string>();
	for (const [key, path] of Object.entries(input ?? {})) {
		const normalizedKey = normalizeFullname(key);
		if (Object.hasOwn(normalized, normalizedKey)) duplicates.add(normalizedKey);
		else normalized[normalizedKey] = path;
	}
	if (duplicates.size > 0) {
		throw new ApiError(400, "validation", "Duplicate URL paths after normalization", {
			duplicate_url_paths: [...duplicates],
		});
	}
	return normalized;
}
