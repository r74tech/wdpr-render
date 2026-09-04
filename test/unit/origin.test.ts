import { describe, expect, spyOn, test } from "bun:test";
import { ApiError } from "../../src/api/errors";
import { validateFilesOrigin } from "../../src/api/origin";

describe("validateFilesOrigin", () => {
	test.each([
		["https://files.example", "staging", "https://files.example"],
		["https://files.example/", "production", "https://files.example"],
		["http://localhost:8788", "development", "http://localhost:8788"],
		["http://127.0.0.1:8788", "development", "http://127.0.0.1:8788"],
	] as const)("accepts a safe origin: %s", (value, environment, expected) => {
		expect(validateFilesOrigin(value, environment)).toBe(expected);
	});

	test.each([
		["https://user@files.example", "staging"],
		["https://files.example/path", "staging"],
		["https://files.example?query=1", "staging"],
		["https://files.example#fragment", "staging"],
		["https://files.example/%2e", "staging"],
		["javascript:alert(1)", "development"],
		["data:text/plain,test", "development"],
		["http://files.example", "development"],
		["http://localhost:8788", "staging"],
	] as const)("rejects an unsafe origin: %s", (value, environment) => {
		const consoleError = spyOn(console, "error").mockImplementation(() => undefined);
		try {
			validateFilesOrigin(value, environment);
			expect.unreachable();
		} catch (error) {
			expect(error).toBeInstanceOf(ApiError);
			if (!(error instanceof ApiError)) return;
			expect(error.status).toBe(500);
			expect(error.code).toBe("internal");
		} finally {
			consoleError.mockRestore();
		}
	});
});
