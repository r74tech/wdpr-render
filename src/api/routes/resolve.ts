import { Hono } from "hono";
import { describeRoute } from "hono-openapi";
import { buildBulk, parseTargets, BulkInputError } from "../../core/bulk";
import { resolveTarget } from "../../core/resolve";
import { readJsonBody } from "../../lib/json-body";
import type { AppEnv } from "../../types/env";
import { ApiError } from "../errors";
import { aggregateMissing, resolveResponseSchema, type ResolveResponse } from "../results";
import { bearerSecurity, bulkErrors, bulkRequestBody, jsonResponse } from "../documentation";
import { parseRequest, resolveRequestSchema } from "../schema";

export const resolveRoutes = new Hono<AppEnv>().post(
	"/",
	describeRoute({
		operationId: "resolveIncludes",
		tags: ["Pages"],
		summary: "Resolve include dependencies",
		description:
			"Expands raw includes. Omitted targets selects all local pages. Add reported missing pages to the bulk and repeat before rendering.",
		security: bearerSecurity,
		requestBody: bulkRequestBody(resolveRequestSchema),
		responses: {
			200: jsonResponse("Per-target results and aggregate missing includes", resolveResponseSchema),
			...bulkErrors,
		},
	}),
	async (context) => {
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
			} satisfies ResolveResponse);
		} catch (error) {
			if (error instanceof BulkInputError) {
				throw new ApiError(400, "validation", error.message, error.detail);
			}
			throw error;
		}
	},
);
