import type { PageRef, WikitextPageContext } from "@wdprlib/ast";
import {
	definePageData,
	matchesListPagesSelectors,
	type AsyncIncludeFetcher,
	type IncludeDependency,
	type ListPagesDataRequirement,
	type ListPagesExternalData,
	type ListUsersDataRequirement,
	type ListUsersExternalData,
	type NormalizedListPagesQuery,
	type PageData,
	type ProcessWikitextCallbackContext,
	type TagCloudDataRequirement,
	type TagCloudExternalData,
} from "@wdprlib/parser";
import type { ResolvedUser } from "@wdprlib/render";
import { normalizeFullname, resolvePageRef, type Bulk, type BulkPage } from "./bulk";

export interface Dependency {
	site: string | null;
	page: string;
	iteration: number;
}

export interface MissingInclude {
	site: string | null;
	page: string;
	requested_by: string[];
}

export interface ProviderDiagnostic {
	severity: "warning";
	code: string;
	message: string;
}

export interface RenderUserInput {
	unix_name: string;
	name: string;
	id?: number;
	avatar_url?: string;
}

export interface RenderViewerInput {
	number: number;
	title: string;
	name: string;
}

export class MissingIncludeCollector {
	readonly #requestedBy: string;
	readonly #siteName: string;
	readonly #missing = new Map<
		string,
		{ site: string | null; page: string; requestedBy: Set<string> }
	>();

	constructor(requestedBy: string, siteName: string) {
		this.#requestedBy = normalizeFullname(requestedBy);
		this.#siteName = siteName.toLowerCase();
	}

	record(reference: PageRef): void {
		const site =
			reference.site === null || reference.site.toLowerCase() === this.#siteName
				? null
				: reference.site.toLowerCase();
		const page = normalizeFullname(reference.page);
		const key = site === null ? `local\0${page}` : `remote\0${site}\0${page}`;
		const existing = this.#missing.get(key);
		if (existing) {
			existing.requestedBy.add(this.#requestedBy);
			return;
		}
		this.#missing.set(key, {
			site,
			page,
			requestedBy: new Set([this.#requestedBy]),
		});
	}

	values(): MissingInclude[] {
		return [...this.#missing.values()].map((missing) => ({
			site: missing.site,
			page: missing.page,
			requested_by: [...missing.requestedBy],
		}));
	}
}

export function createIncludeFetcher(
	bulk: Bulk,
	missing: MissingIncludeCollector,
): AsyncIncludeFetcher {
	return async (reference) => {
		const page = resolvePageRef(bulk, reference);
		if (page) return page.source;
		missing.record(reference);
		return null;
	};
}

export function toDependency(dependency: IncludeDependency, siteName: string): Dependency {
	const referenceSite = dependency.location.site;
	const site =
		referenceSite === null || referenceSite.toLowerCase() === siteName.toLowerCase()
			? null
			: referenceSite.toLowerCase();
	return {
		site,
		page: normalizeFullname(dependency.location.page),
		iteration: dependency.iteration,
	};
}

export function toPageData(page: BulkPage): PageData {
	const tags = page.tags ?? [];
	return definePageData({
		name: page.name,
		category: page.category,
		fullname: page.fullname,
		title: page.title ?? "",
		createdAt: page.created_at ? new Date(page.created_at) : new Date(0),
		updatedAt: page.updated_at ? new Date(page.updated_at) : new Date(0),
		createdBy: page.created_by
			? {
					id: page.created_by.id,
					name: page.created_by.name,
					unixName: page.created_by.unix_name,
				}
			: undefined,
		content: page.source,
		tags: tags.filter((tag) => !tag.startsWith("_")),
		hiddenTags: tags.filter((tag) => tag.startsWith("_")),
		rating: page.rating ?? 0,
		ratingVotes: page.rating_votes ?? 0,
		revisions: 0,
		size: page.source.length,
	});
}

type ListPagesProvider = (
	query: NormalizedListPagesQuery,
	requirement: ListPagesDataRequirement,
	context: ProcessWikitextCallbackContext<WikitextPageContext>,
) => Promise<ListPagesExternalData>;

export function createListPagesProvider(
	bulk: Bulk,
	diagnostics: ProviderDiagnostic[],
): ListPagesProvider {
	return async (query, _requirement, context) => {
		const unsupported = unsupportedListPagesFields(query);
		if (unsupported.length > 0) {
			diagnostics.push({
				severity: "warning",
				code: "listpages-unsupported-selector",
				message: `Unsupported ListPages selector: ${unsupported.join(", ")}`,
			});
			return { pages: [], totalCount: 0, site: bulk.site };
		}

		if (query.limit === 0) return { pages: [], totalCount: 0, site: bulk.site };
		const current = resolvePageRef(bulk, { site: null, page: context.page.fullName });
		const currentPage = current
			? toPageData(current)
			: definePageData({
					fullname: normalizeFullname(context.page.fullName),
					title: "",
					createdAt: new Date(0),
					updatedAt: new Date(0),
					tags: context.page.tags ?? [],
				});
		const candidates = query.range === "." ? (current ? [current] : []) : bulk.localPages;
		const pages = candidates
			.map(toPageData)
			.filter((page) => matchesListPagesSelectors(page, query, currentPage))
			.filter((page) => query.name === undefined || page.name === normalizeFullname(query.name))
			.filter(
				(page) =>
					query.fullname === undefined || page.fullname === normalizeFullname(query.fullname),
			)
			.toSorted(listPagesComparator(query));
		const totalCount = pages.length;
		const offset = Math.max(query.offset ?? 0, 0);
		const limit = query.limit ?? 20;
		return {
			pages: pages.slice(offset, limit < 0 ? undefined : offset + limit),
			totalCount,
			site: bulk.site,
		};
	};
}

type ListUsersProvider = (
	requirement: ListUsersDataRequirement,
) => Promise<ListUsersExternalData | null>;

export function createListUsersProvider(viewer: RenderViewerInput | undefined): ListUsersProvider {
	return async () => (viewer ? { user: viewer } : null);
}

type TagCloudProvider = (requirement: TagCloudDataRequirement) => Promise<TagCloudExternalData>;

export function createTagCloudProvider(bulk: Bulk): TagCloudProvider {
	return async (requirement) => {
		const category =
			requirement.category === null ? null : normalizeWikidotCategoryName(requirement.category);
		const pages =
			category === null
				? bulk.localPages
				: bulk.localPages.filter((page) => page.category === category);
		if (category !== null && pages.length === 0) {
			return { status: "category-not-found", category };
		}

		const weights = new Map<string, number>();
		for (const page of pages) {
			for (const tag of page.tags ?? []) {
				if (tag.startsWith("_")) continue;
				weights.set(tag, (weights.get(tag) ?? 0) + 1);
			}
		}
		const tags = [...weights]
			.map(([tag, weight]) => ({ tag, weight }))
			.toSorted((left, right) => right.weight - left.weight || compareText(left.tag, right.tag))
			.slice(0, Math.max(requirement.limit, 0));
		return { status: "ok", category, tags };
	};
}

export function createPageExistenceResolver(
	bulk: Bulk,
	existingPages: readonly string[],
): (requestedPages: string[]) => Promise<ReadonlySet<string>> {
	const existing = new Set([
		...bulk.localPages.map((page) => normalizeRenderedPageReference(page.fullname)),
		...existingPages.map(normalizeRenderedPageReference),
	]);
	return async (requestedPages) =>
		new Set(requestedPages.filter((page) => existing.has(normalizeRenderedPageReference(page))));
}

export function createUserResolver(
	users: readonly RenderUserInput[],
): (usernames: string[]) => Promise<ReadonlyMap<string, ResolvedUser | null>> {
	const byUnixName = new Map(users.map((user) => [user.unix_name.toLowerCase(), user]));
	return async (usernames) => {
		const resolved = new Map<string, ResolvedUser>();
		for (const username of usernames) {
			const unixName = username.toLowerCase();
			const user = byUnixName.get(unixName);
			resolved.set(username, {
				...(user ? { name: user.name, avatarUrl: user.avatar_url } : {}),
				url: `https://www.wikidot.com/user:info/${encodeURIComponent(unixName)}`,
			});
		}
		return resolved;
	};
}

const LIST_PAGES_FIELDS = new Set([
	"category",
	"tags",
	"name",
	"fullname",
	"range",
	"order",
	"reverse",
	"offset",
	"limit",
]);
const LIST_PAGES_ORDER_FIELDS = new Set(["created_at", "updated_at", "title", "fullname"]);

function unsupportedListPagesFields(query: NormalizedListPagesQuery): string[] {
	const fields = Object.keys(query).filter((field) => !LIST_PAGES_FIELDS.has(field));
	if (query.range !== undefined && query.range !== ".") fields.push("range");
	if (query.order && !LIST_PAGES_ORDER_FIELDS.has(query.order.field)) fields.push("order");
	return [...new Set(fields)];
}

function listPagesComparator(
	query: NormalizedListPagesQuery,
): (left: PageData, right: PageData) => number {
	const field = query.order?.field ?? "created_at";
	const ascending = (query.order?.direction === "asc") !== Boolean(query.reverse);
	const direction = ascending ? 1 : -1;
	return (left, right) => direction * comparePageData(left, right, field);
}

function comparePageData(left: PageData, right: PageData, field: string): number {
	switch (field) {
		case "updated_at":
			return left.updatedAt.getTime() - right.updatedAt.getTime();
		case "title":
			return compareText(left.title, right.title);
		case "fullname":
			return compareText(left.fullname, right.fullname);
		default:
			return left.createdAt.getTime() - right.createdAt.getTime();
	}
}

function compareText(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function normalizeWikidotCategoryName(value: string): string {
	const lower = value.trim().toLowerCase();
	const leadingUnderscore = lower.startsWith("_");
	const body = lower
		.replace(/^_+/, "")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return leadingUnderscore ? `_${body}` : body;
}

function normalizeRenderedPageReference(value: string): string {
	let normalized = value.toLowerCase();
	if (normalized.includes(":")) normalized = normalized.replace(/:\s+/g, ":");
	if (/\s/.test(normalized)) normalized = normalized.replace(/\s+/g, "-").trim();
	if (!normalized.startsWith("/") && normalized.includes("/")) {
		normalized = normalized.replaceAll("/", "-");
	}
	return normalized.startsWith("/") ? normalized.slice(1) : normalized;
}
