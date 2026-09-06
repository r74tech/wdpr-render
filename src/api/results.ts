import type { MissingInclude } from "../core/providers";
import { z } from "zod";
import {
	missingIncludeSchema,
	renderTargetResultSchema,
	resolveTargetResultSchema,
} from "../core/schema";

export const healthResponseSchema = z
	.object({
		ok: z.literal(true),
		versions: z.object({ parser: z.string(), render: z.string() }),
	})
	.meta({ id: "Health" });

export const resolveResponseSchema = z
	.object({
		results: z.array(resolveTargetResultSchema),
		missing: z.array(missingIncludeSchema),
		elapsed_ms: z.number(),
	})
	.meta({
		id: "ResolveResponse",
		examples: [
			{
				results: [
					{
						requested: "start",
						fullname: "start",
						status: "ok",
						dependencies: [],
						missing: [],
						input_bytes: 35,
						expanded_bytes: 35,
						reached_max_iterations: false,
					},
				],
				missing: [],
				elapsed_ms: 1,
			},
		],
	});
export type ResolveResponse = z.infer<typeof resolveResponseSchema>;

export const renderResponseSchema = z
	.object({
		results: z.array(renderTargetResultSchema),
		missing: z.array(missingIncludeSchema),
		elapsed_ms: z.number(),
	})
	.meta({
		id: "RenderResponse",
		examples: [
			{
				results: [
					{
						requested: "start",
						fullname: "start",
						status: "ok",
						dependencies: [],
						missing: [],
						input_bytes: 35,
						diagnostics: [],
						html: '<h1 id="toc0"><span>Hello</span></h1><p>This is <strong>Wikidot</strong> syntax.</p>',
						styles: [],
						html_blocks: [],
					},
				],
				missing: [],
				elapsed_ms: 1,
			},
		],
	});
export type RenderResponse = z.infer<typeof renderResponseSchema>;

export function aggregateMissing(
	results: readonly { missing: readonly MissingInclude[] }[],
): MissingInclude[] {
	const aggregate = new Map<
		string,
		{ site: string | null; page: string; requestedBy: Set<string> }
	>();
	for (const result of results) {
		for (const missing of result.missing) {
			const key =
				missing.site === null
					? `local\0${missing.page}`
					: `remote\0${missing.site}\0${missing.page}`;
			const current = aggregate.get(key);
			if (current) {
				for (const target of missing.requested_by) current.requestedBy.add(target);
			} else {
				aggregate.set(key, {
					site: missing.site,
					page: missing.page,
					requestedBy: new Set(missing.requested_by),
				});
			}
		}
	}
	return [...aggregate.values()].map(({ site, page, requestedBy }) => ({
		site,
		page,
		requested_by: [...requestedBy],
	}));
}
