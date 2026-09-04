import { describe, expect, test } from "bun:test";
import { buildBulk, parseTargets } from "../../src/core/bulk";
import { resolveTarget } from "../../src/core/resolve";

const site = { name: "render", title: "Render", domain: "render.example" };

describe("resolveTarget", () => {
	test("expands a local and cross-site include chain and projects its trace", async () => {
		const bulk = buildBulk({
			site,
			pages: [
				{ fullname: "start", source: "before\n[[include middle]]\nafter" },
				{ fullname: "middle", source: "middle\n[[include :other:end]]" },
				{ site: "other", fullname: "end", source: "終端" },
			],
		});
		const target = parseTargets(bulk, ["start"])[0];
		if (!target) throw new Error("fixture target missing");

		const result = await resolveTarget(bulk, target);

		expect(result).toMatchObject({
			requested: "start",
			fullname: "start",
			status: "ok",
			missing: [],
			reached_max_iterations: false,
		});
		expect(result.dependencies).toEqual([
			{ site: null, page: "middle", iteration: 0 },
			{ site: "other", page: "end", iteration: 1 },
		]);
		expect(result.input_bytes).toBe(
			new TextEncoder().encode("before\n[[include middle]]\nafter").length,
		);
		expect(result.expanded_bytes).toBe(
			new TextEncoder().encode("before\nmiddle\n終端\nafter").length,
		);
	});

	test("reports missing includes and the iteration limit", async () => {
		const chain = Array.from({ length: 12 }, (_, index) => ({
			fullname: `chain-${index}`,
			source: index === 11 ? "end" : `[[include chain-${index + 1}]]`,
		}));
		const bulk = buildBulk({
			site,
			pages: [{ fullname: "start", source: "[[include missing]]\n[[include chain-0]]" }, ...chain],
		});
		const target = parseTargets(bulk, ["start"])[0];
		if (!target) throw new Error("fixture target missing");

		const result = await resolveTarget(bulk, target);

		expect(result.status).toBe("missing_includes");
		expect(result.missing).toEqual([{ site: null, page: "missing", requested_by: ["start"] }]);
		expect(result.reached_max_iterations).toBe(true);
	});
});
