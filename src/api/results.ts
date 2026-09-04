import type { MissingInclude } from "../core/providers";

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
