import { SELF } from "cloudflare:test";
import { describe, expect, test } from "vitest";

describe("API Worker runtime", () => {
	test("serves the health endpoint", async () => {
		const response = await SELF.fetch("https://example.com/v1/health");

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ ok: true });
	});
});
