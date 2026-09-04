import { describe, expect, test } from "bun:test";
import { buildBulk, parseTargets } from "../../src/core/bulk";
import { renderTarget } from "../../src/core/render";

const site = { name: "render", title: "Render", domain: "render.example" };

function targetFor(pages: Parameters<typeof buildBulk>[0]["pages"], target = "start") {
	const bulk = buildBulk({ site, pages });
	const parsed = parseTargets(bulk, [target])[0];
	if (!parsed) throw new Error("fixture target missing");
	return { bulk, target: parsed };
}

function recordingBucket(failOn?: string) {
	const puts: Array<{ key: string; content: string }> = [];
	return {
		puts,
		bucket: {
			async put(key: string, content: string) {
				if (content === failOn) throw new Error("R2 unavailable");
				puts.push({ key, content });
				return null;
			},
		},
	};
}

describe("renderTarget", () => {
	test("renders includes, styles, modules, users, and signed html blocks", async () => {
		const source = [
			"[[include intro]]",
			"[[module CSS]]",
			".from-module { color: red; }",
			"[[/module]]",
			'[[module ListPages category="news" order="fullname" limit="10"]]',
			"%%fullname%%",
			"[[/module]]",
			'[[module ListUsers users="."]]',
			"%%number%% %%title%% %%name%%",
			"[[/module]]",
			"[[user alice]]",
			"[[html]]",
			"<script>one()</script>",
			"[[/html]]",
			"[[html]]",
			"<script>one()</script>",
			"[[/html]]",
		].join("\n");
		const { bulk, target } = targetFor([
			{ fullname: "start", source },
			{ fullname: "intro", source: "導入" },
			{ fullname: "news:a", source: "A", title: "Alpha" },
			{ fullname: "news:b", source: "B", title: "Beta" },
		]);
		const { bucket, puts } = recordingBucket();

		const result = await renderTarget({
			bulk,
			target,
			force: false,
			viewer: { number: 7, title: "閲覧者", name: "viewer" },
			users: [{ unix_name: "alice", name: "Alice" }],
			existingPages: [],
			urlPaths: { start: "/custom/start" },
			bucket,
			filesOrigin: "https://files.example",
			filesUrlSecret: "secret",
			htmlBlockExpiresAt: 90_000,
		});

		expect(result.status).toBe("ok");
		expect(result.html).toContain("導入");
		expect(result.html).toContain("news:a");
		expect(result.html).toContain("news:b");
		expect(result.html).toContain("7 閲覧者 viewer");
		expect(result.html).toContain("Alice");
		expect(result.styles).toEqual([expect.stringContaining(".from-module")]);
		expect(result.dependencies).toEqual([{ site: null, page: "intro", iteration: 0 }]);
		expect(result.html_blocks).toHaveLength(2);
		expect(result.html_blocks?.[0]?.expires_at).toBe(90_000);
		expect(result.html_blocks?.[1]?.expires_at).toBe(90_000);
		expect(result.html_blocks?.[0]?.url).toBe(result.html_blocks?.[1]?.url);
		expect(result.html).toContain((result.html_blocks?.[0]?.url ?? "").replaceAll("&", "&amp;"));
		expect(puts).toHaveLength(1);
		expect(puts[0]?.content).toBe("<script>one()</script>");
	});

	test("does not render or write html blocks when includes are missing without force", async () => {
		const { bulk, target } = targetFor([
			{
				fullname: "start",
				source: "[[include missing]]\n[[html]]\n<p>hidden</p>\n[[/html]]",
			},
		]);
		const { bucket, puts } = recordingBucket();

		const result = await renderTarget({
			bulk,
			target,
			force: false,
			bucket,
			filesOrigin: "https://files.example",
			filesUrlSecret: "secret",
			htmlBlockExpiresAt: 90_000,
		});

		expect(result.status).toBe("missing_includes");
		expect(result.html).toBeUndefined();
		expect(result.html_blocks).toBeUndefined();
		expect(result.missing).toEqual([{ site: null, page: "missing", requested_by: ["start"] }]);
		expect(puts).toEqual([]);
	});

	test("renders missing includes as an error block when force is enabled", async () => {
		const { bulk, target } = targetFor([{ fullname: "start", source: "[[include missing]]" }]);
		const { bucket } = recordingBucket();

		const result = await renderTarget({
			bulk,
			target,
			force: true,
			bucket,
			filesOrigin: "https://files.example",
			filesUrlSecret: "secret",
			htmlBlockExpiresAt: 90_000,
		});

		expect(result.status).toBe("ok");
		expect(result.html).toContain("error-block");
		expect(result.html).toContain("missing");
		expect(result.missing).toHaveLength(1);
	});

	test("returns an error without html after an html-block put failure", async () => {
		const { bulk, target } = targetFor([
			{
				fullname: "start",
				source: ["[[html]]", "first", "[[/html]]", "[[html]]", "second", "[[/html]]"].join("\n"),
			},
		]);
		const { bucket, puts } = recordingBucket("second");

		const result = await renderTarget({
			bulk,
			target,
			force: false,
			bucket,
			filesOrigin: "https://files.example",
			filesUrlSecret: "secret",
			htmlBlockExpiresAt: 90_000,
		});

		expect(result.status).toBe("error");
		expect(result.error_code).toBe("html_block_store_failed");
		expect(result.error_message).toBe("R2 unavailable");
		expect(result.html).toBeUndefined();
		expect(result.html_blocks).toBeUndefined();
		expect(puts.map(({ content }) => content)).toEqual(["first"]);
	});

	test("returns a provider diagnostic for unsupported ListPages selectors", async () => {
		const { bulk, target } = targetFor([
			{
				fullname: "start",
				source: '[[module ListPages rating="> 0"]]\n%%fullname%%\n[[/module]]',
			},
		]);
		const { bucket } = recordingBucket();

		const result = await renderTarget({
			bulk,
			target,
			force: false,
			bucket,
			filesOrigin: "https://files.example",
			filesUrlSecret: "secret",
			htmlBlockExpiresAt: 90_000,
		});

		expect(result.diagnostics).toContainEqual({
			severity: "warning",
			code: "listpages-unsupported-selector",
			message: "Unsupported ListPages selector: rating",
		});
	});
});
