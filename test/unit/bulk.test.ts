import { describe, expect, test } from "bun:test";
import {
	BulkInputError,
	buildBulk,
	normalizeFullname,
	parseTargets,
	resolvePageRef,
} from "../../src/core/bulk";

const site = { name: "render", title: "Render", domain: "render.example" };

describe("normalizeFullname", () => {
	test.each([
		["Guide", "guide"],
		["/_default:Guide/revision/2", "guide"],
		["News:日本語/anything", "news:日本語"],
		["_DEFAULT:Home", "home"],
	])("normalizes %s", (input, expected) => {
		expect(normalizeFullname(input)).toBe(expected);
	});
});

describe("buildBulk", () => {
	test("indexes local aliases and cross-site pages", () => {
		const bulk = buildBulk({
			site,
			pages: [
				{ fullname: "Guide", source: "local" },
				{ site: "RENDER", fullname: "Local-2", source: "alias" },
				{ site: "other", fullname: "Guide", source: "remote" },
			],
		});

		expect(resolvePageRef(bulk, { site: null, page: "GUIDE" })?.source).toBe("local");
		expect(resolvePageRef(bulk, { site: "render", page: "local-2" })?.source).toBe("alias");
		expect(resolvePageRef(bulk, { site: "OTHER", page: "Guide" })?.source).toBe("remote");
	});

	test("rejects keys that collide after normalization", () => {
		expect(() =>
			buildBulk({
				site,
				pages: [
					{ fullname: "Guide", source: "one" },
					{ site: "render", fullname: "/_default:GUIDE/revision/2", source: "two" },
				],
			}),
		).toThrow(BulkInputError);
	});

	test("keeps a local category fullname separate from a same-named cross-site page", () => {
		const bulk = buildBulk({
			site,
			pages: [
				{ fullname: "other:guide", source: "local" },
				{ site: "other", fullname: "guide", source: "remote" },
			],
		});

		expect(resolvePageRef(bulk, { site: null, page: "other:guide" })?.source).toBe("local");
		expect(resolvePageRef(bulk, { site: "other", page: "guide" })?.source).toBe("remote");
	});
});

describe("parseTargets", () => {
	test("preserves requested names and returns normalized local pages", () => {
		const bulk = buildBulk({ site, pages: [{ fullname: "Guide", source: "body" }] });
		const targets = parseTargets(bulk, ["/_default:GUIDE/revision/1"]);

		expect(targets).toHaveLength(1);
		expect(targets[0]?.requested).toBe("/_default:GUIDE/revision/1");
		expect(targets[0]?.page.fullname).toBe("guide");
	});

	test("rejects cross-site and unknown targets separately", () => {
		const bulk = buildBulk({ site, pages: [{ fullname: "Guide", source: "body" }] });

		try {
			parseTargets(bulk, [":other:guide", "missing"]);
			expect.unreachable();
		} catch (error) {
			expect(error).toBeInstanceOf(BulkInputError);
			if (!(error instanceof BulkInputError)) return;
			expect(error.detail).toEqual({
				cross_site_targets: [":other:guide"],
				unknown_targets: ["missing"],
			});
		}
	});
});
