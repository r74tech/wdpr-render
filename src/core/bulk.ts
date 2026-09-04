import type { PageRef } from "@wdprlib/ast";

export interface BulkSite {
	name: string;
	title: string;
	domain: string;
}

export interface BulkUser {
	id: number;
	name: string;
	unix_name: string;
}

export interface BulkPageInput {
	site?: string | null;
	fullname: string;
	source: string;
	title?: string;
	tags?: string[];
	created_at?: string;
	updated_at?: string;
	created_by?: BulkUser;
	rating?: number;
	rating_votes?: number;
}

export interface BulkPage extends Omit<BulkPageInput, "site" | "fullname"> {
	site: string | null;
	fullname: string;
	name: string;
	category: string;
	key: string;
}

export interface Bulk {
	site: BulkSite;
	pages: ReadonlyMap<string, BulkPage>;
	localPages: readonly BulkPage[];
}

export interface TargetPage {
	requested: string;
	page: BulkPage;
}

export class BulkInputError extends Error {
	readonly detail: Record<string, string[]>;

	constructor(message: string, detail: Record<string, string[]>) {
		super(message);
		this.name = "BulkInputError";
		this.detail = detail;
	}
}

export function normalizeFullname(value: string): string {
	let normalized = value.toLowerCase().replace(/^\/+/, "");
	const pathSeparator = normalized.indexOf("/");
	if (pathSeparator >= 0) normalized = normalized.slice(0, pathSeparator);
	return normalized.replace(/^_default:/, "");
}

export function buildBulk(input: { site: BulkSite; pages: readonly BulkPageInput[] }): Bulk {
	const pages = new Map<string, BulkPage>();
	const localPages: BulkPage[] = [];
	const duplicateKeys = new Set<string>();

	for (const inputPage of input.pages) {
		const local =
			inputPage.site == null || inputPage.site.toLowerCase() === input.site.name.toLowerCase();
		const pageSite = local ? null : inputPage.site!.toLowerCase();
		const fullname = normalizeFullname(inputPage.fullname);
		const storageKey = pageKey(pageSite, fullname);
		const key = pageSite === null ? fullname : `${pageSite}:${fullname}`;
		const separator = fullname.indexOf(":");
		const category = separator < 0 ? "_default" : fullname.slice(0, separator);
		const name = separator < 0 ? fullname : fullname.slice(separator + 1);
		const page: BulkPage = {
			...inputPage,
			site: pageSite,
			fullname,
			category,
			name,
			key,
		};

		if (pages.has(storageKey)) duplicateKeys.add(key);
		else pages.set(storageKey, page);
		if (local) localPages.push(page);
	}

	if (duplicateKeys.size > 0) {
		throw new BulkInputError("Duplicate pages after normalization", {
			duplicate_keys: [...duplicateKeys],
		});
	}

	return { site: input.site, pages, localPages };
}

export function resolvePageRef(bulk: Bulk, reference: PageRef): BulkPage | null {
	const referenceSite = reference.site;
	const local =
		referenceSite === null || referenceSite.toLowerCase() === bulk.site.name.toLowerCase();
	const site = local || referenceSite === null ? null : referenceSite.toLowerCase();
	return bulk.pages.get(pageKey(site, normalizeFullname(reference.page))) ?? null;
}

export function parseTargets(bulk: Bulk, requestedTargets?: readonly string[]): TargetPage[] {
	const targets = requestedTargets ?? bulk.localPages.map((page) => page.fullname);
	const crossSiteTargets: string[] = [];
	const unknownTargets: string[] = [];
	const parsed: TargetPage[] = [];

	for (const requested of targets) {
		if (/^:[^:]+:/.test(requested)) {
			crossSiteTargets.push(requested);
			continue;
		}
		const page = bulk.pages.get(pageKey(null, normalizeFullname(requested)));
		if (!page || page.site !== null) {
			unknownTargets.push(requested);
			continue;
		}
		parsed.push({ requested, page });
	}

	if (crossSiteTargets.length > 0 || unknownTargets.length > 0) {
		const detail: Record<string, string[]> = {};
		if (crossSiteTargets.length > 0) detail.cross_site_targets = crossSiteTargets;
		if (unknownTargets.length > 0) detail.unknown_targets = unknownTargets;
		throw new BulkInputError("Invalid render targets", detail);
	}

	return parsed;
}

function pageKey(site: string | null, fullname: string): string {
	return site === null ? `local\0${fullname}` : `remote\0${site}\0${fullname}`;
}
