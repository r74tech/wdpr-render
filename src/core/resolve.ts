import { resolveIncludesAsyncWithTrace } from "@wdprlib/parser";
import type { Bulk, TargetPage } from "./bulk";
import { MissingIncludeCollector, createIncludeFetcher, toDependency } from "./providers";
import type { ResolveTargetResult } from "./schema";
export type { ResolveTargetResult } from "./schema";

const encoder = new TextEncoder();

export async function resolveTarget(bulk: Bulk, target: TargetPage): Promise<ResolveTargetResult> {
	const missing = new MissingIncludeCollector(target.page.fullname, bulk.site.name);
	const resolution = await resolveIncludesAsyncWithTrace(
		target.page.source,
		createIncludeFetcher(bulk, missing),
		{ maxIterations: 10 },
	);
	const missingValues = missing.values();

	return {
		requested: target.requested,
		fullname: target.page.fullname,
		status: missingValues.length === 0 ? "ok" : "missing_includes",
		dependencies: resolution.dependencies.map((dependency) =>
			toDependency(dependency, bulk.site.name),
		),
		missing: missingValues,
		reached_max_iterations: resolution.reachedMaxIterations,
		input_bytes: encoder.encode(target.page.source).length,
		expanded_bytes: encoder.encode(resolution.source).length,
	};
}
