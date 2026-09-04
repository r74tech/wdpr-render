import { describe, expect, test } from "bun:test";
import app from "../../src/api";

describe("API Worker", () => {
	test("returns its health status", async () => {
		const response = await app.request("http://localhost/v1/health");

		expect(response.status).toBe(200);
		expect(await response.text()).toBe('{"ok":true}');
	});
});
