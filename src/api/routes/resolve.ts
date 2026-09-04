import { Hono } from "hono";
import { buildBulk, parseTargets, BulkInputError } from "../../core/bulk";
import { resolveTarget } from "../../core/resolve";
import { readJsonBody } from "../../lib/json-body";
import type { AppEnv } from "../../types/env";
import { ApiError } from "../errors";
import { aggregateMissing } from "../results";
import { parseRequest, resolveRequestSchema } from "../schema";

export const resolveRoutes = new Hono<AppEnv>().post("/", async (context) => {
	const startedAt = Date.now();
	const body = parseRequest(resolveRequestSchema, await readJsonBody(context.req.raw));
	try {
		const bulk = buildBulk(body);
		const targets = parseTargets(bulk, body.targets);
		const results = [];
		for (const target of targets) results.push(await resolveTarget(bulk, target));
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
