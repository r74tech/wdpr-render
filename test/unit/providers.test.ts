import { describe, expect, test } from "bun:test";
import {
	createSettings,
	type IncludeDependency,
	type ListPagesDataRequirement,
	type NormalizedListPagesQuery,
} from "@wdprlib/parser";
import { buildBulk } from "../../src/core/bulk";
import {
	MissingIncludeCollector,
	createIncludeFetcher,
	createListPagesProvider,
	createPageExistenceResolver,
	createTagCloudProvider,
	createUserResolver,
	toDependency,
	toPageData,
	type ProviderDiagnostic,
} from "../../src/core/providers";

const site = { name: "render", title: "Render", domain: "render.example" };
const requirement: ListPagesDataRequirement = {
	id: 0,
	query: {},
	neededVariables: [],
	rawAttributes: {},
};
const callbackContext = {
	page: { fullName: "guide", tags: [] },
	settings: createSettings("page"),
};

function fixtureBulk() {
	return buildBulk({
		site,
		pages: [
			{
				fullname: "guide",
				source: "Guide body",
				title: "Guide",
				tags: ["docs", "_hidden"],
				created_at: "2026-01-02T00:00:00.000Z",
				updated_at: "2026-01-03T00:00:00.000Z",
				created_by: { id: 1, name: "Alice", unix_name: "alice" },
				rating: 5,
				rating_votes: 2,
			},
			{
				fullname: "news:second",
				source: "二番目",
				title: "Second",
				tags: ["docs", "release"],
				created_at: "2026-01-03T00:00:00.000Z",
			},
			{
				fullname: "news:first",
				source: "一番目",
				title: "First",
				tags: ["release"],
				created_at: "2026-01-01T00:00:00.000Z",
			},
			{ site: "other", fullname: "remote", source: "Remote" },
		],
	});
}

describe("include provider", () => {
	test("resolves local and cross-site pages and deduplicates missing references", async () => {
		const bulk = fixtureBulk();
		const missing = new MissingIncludeCollector("guide", bulk.site.name);
		const fetchInclude = createIncludeFetcher(bulk, missing);

		expect(await fetchInclude({ site: null, page: "NEWS:SECOND" })).toBe("二番目");
		expect(await fetchInclude({ site: "other", page: "REMOTE" })).toBe("Remote");
		expect(await fetchInclude({ site: "OTHER", page: "Missing" })).toBeNull();
		expect(await fetchInclude({ site: "other", page: "missing" })).toBeNull();
		expect(missing.values()).toEqual([{ site: "other", page: "missing", requested_by: ["guide"] }]);
	});

	test("projects only the public dependency fields", () => {
		const dependency: IncludeDependency = {
			location: { site: "Other", page: "Guide" },
			assignments: [{ key: "name", value: "Alice" }],
			start: 0,
			end: 20,
			inner: ":Other:Guide",
			iteration: 2,
		};

		expect(toDependency(dependency, "render")).toEqual({
			site: "other",
			page: "guide",
			iteration: 2,
		});
	});
});

describe("PageData and ListPages", () => {
	test("fills required PageData and separates hidden tags", () => {
		const bulk = buildBulk({
			site,
			pages: [{ fullname: "日本語", source: "本文", tags: ["見える", "_隠す"] }],
		});
		const page = bulk.localPages[0];
		if (!page) throw new Error("fixture page missing");

		const data = toPageData(page);

		expect(data).toMatchObject({
			name: "日本語",
			category: "_default",
			fullname: "日本語",
			title: "",
			tags: ["見える"],
			hiddenTags: ["_隠す"],
			rating: 0,
			ratingVotes: 0,
			revisions: 0,
			content: "本文",
			size: 2,
		});
		expect(data.createdAt.toISOString()).toBe("1970-01-01T00:00:00.000Z");
		expect(data.updatedAt.toISOString()).toBe("1970-01-01T00:00:00.000Z");
		expect(data.createdBy).toBeUndefined();
	});

	test("filters, orders, reverses, and reports total count before slicing", async () => {
		const bulk = fixtureBulk();
		const diagnostics: ProviderDiagnostic[] = [];
		const listPages = createListPagesProvider(bulk, diagnostics);
		const query: NormalizedListPagesQuery = {
			category: { include: ["news"], exclude: [], all: false, current: false },
			tags: { all: [], any: ["release"], none: [], special: null },
			order: { field: "created_at", direction: "asc" },
			reverse: true,
			offset: 0,
			limit: 1,
		};

		const result = await listPages(query, requirement, callbackContext);

		expect(result?.pages.map((page) => page.fullname)).toEqual(["news:second"]);
		expect(result?.totalCount).toBe(2);
		expect(diagnostics).toEqual([]);
	});

	test.each([
		[{ pagetype: "normal" }, "pagetype"],
		[{ parent: { type: "none" } }, "parent"],
		[{ linkTo: "guide" }, "linkTo"],
		[{ createdAt: { type: "year", year: 2026 } }, "createdAt"],
		[{ updatedAt: { type: "year", year: 2026 } }, "updatedAt"],
		[{ createdBy: "alice" }, "createdBy"],
		[{ rating: { op: ">", value: 0 } }, "rating"],
		[{ votes: { op: ">", value: 0 } }, "votes"],
		[{ dataFormFields: { status: "open" } }, "dataFormFields"],
		[{ perPage: 10 }, "perPage"],
		[{ range: "before" }, "range"],
		[{ order: { field: "rating", direction: "asc" } }, "order"],
		[{ order: { field: "votes", direction: "asc" } }, "order"],
		[{ order: { field: "revisions", direction: "asc" } }, "order"],
		[{ order: { field: "comments", direction: "asc" } }, "order"],
		[{ order: { field: "size", direction: "asc" } }, "order"],
		[{ order: { field: "random", direction: "asc" } }, "order"],
		[{ rating: { op: ">", value: 0 }, limit: 0 }, "rating"],
		[{ parent: { type: "none" }, range: "." }, "parent"],
	] satisfies Array<[NormalizedListPagesQuery, string]>)(
		"rejects unsupported selector before early-return paths: %o",
		async (query, field) => {
			const bulk = fixtureBulk();
			const diagnostics: ProviderDiagnostic[] = [];
			const listPages = createListPagesProvider(bulk, diagnostics);

			const result = await listPages(query, requirement, callbackContext);

			expect(result?.pages).toEqual([]);
			expect(diagnostics[0]?.code).toBe("listpages-unsupported-selector");
			expect(diagnostics[0]?.message).toContain(field);
		},
	);
});

describe("TagCloud and render resolvers", () => {
	test("normalizes category and aggregates visible tags", async () => {
		const bulk = buildBulk({
			site,
			pages: [
				{ fullname: "news-foo:a", source: "", tags: ["beta", "alpha", "_hidden"] },
				{ fullname: "news-foo:b", source: "", tags: ["alpha"] },
			],
		});
		const tagCloud = createTagCloudProvider(bulk);

		expect(await tagCloud({ id: 0, category: "News Foo", limit: 2 })).toEqual({
			status: "ok",
			category: "news-foo",
			tags: [
				{ tag: "alpha", weight: 2 },
				{ tag: "beta", weight: 1 },
			],
		});
		expect(await tagCloud({ id: 1, category: "Missing", limit: 10 })).toEqual({
			status: "category-not-found",
			category: "missing",
		});
	});

	test("preserves requested page spellings and raw user map keys", async () => {
		const bulk = fixtureBulk();
		const pageExists = createPageExistenceResolver(bulk, ["Existing"]);
		const users = createUserResolver([
			{ unix_name: "alice", name: "Alice", avatar_url: "https://example.com/alice.png" },
		]);

		expect(await pageExists(["GUIDE", "existing", "Missing"])).toEqual(
			new Set(["GUIDE", "existing"]),
		);
		expect(await users(["ALICE", "unknown"])).toEqual(
			new Map([
				[
					"ALICE",
					{
						name: "Alice",
						url: "https://www.wikidot.com/user:info/alice",
						avatarUrl: "https://example.com/alice.png",
					},
				],
				["unknown", { url: "https://www.wikidot.com/user:info/unknown" }],
			]),
		);
	});
});
