import { Hono } from "hono";
import { buildBulk, parseTargets, normalizeFullname, BulkInputError } from "../../core/bulk";
import { renderTarget } from "../../core/render";
import { readJsonBody } from "../../lib/json-body";
import type { AppEnv } from "../../types/env";
import { ApiError } from "../errors";
import { validateFilesOrigin } from "../origin";
import { aggregateMissing } from "../results";
import { parseRequest, renderRequestSchema } from "../schema";

export const renderRoutes = new Hono<AppEnv>().post("/", async (context) => {
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
		});
	} catch (error) {
		if (error instanceof BulkInputError) {
			throw new ApiError(400, "validation", error.message, error.detail);
		}
		throw error;
	}
});

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
