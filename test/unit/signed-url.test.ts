import { describe, expect, test } from "bun:test";
import { sha256Hex, signHtmlBlockUrl, verifyHtmlBlockSignature } from "../../src/core/signed-url";

describe("sha256Hex", () => {
	test.each([
		["", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
		["abc", "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"],
		["本文", "2617ab4ad6fe995785421872bde4648311a8de11848c1f487fb7eb458572e87b"],
	])("hashes UTF-8 input", async (input, expected) => {
		expect(await sha256Hex(input)).toBe(expected);
	});
});

describe("signed html-block URLs", () => {
	test("signs and verifies the hash and Unix expiry", async () => {
		const hash = await sha256Hex("block");
		const url = new URL(
			await signHtmlBlockUrl({
				origin: "https://files.example",
				hash,
				secret: "current-secret",
				expiresAt: 2_000,
			}),
		);

		expect(url.pathname).toBe(`/html/${hash}`);
		expect(url.searchParams.get("exp")).toBe("2000");
		expect(
			await verifyHtmlBlockSignature({
				hash,
				expiresAt: 2_000,
				signature: url.searchParams.get("sig") ?? "",
				secret: "current-secret",
				now: 1_999,
			}),
		).toBe(true);
	});

	test("rejects tampering and expiry", async () => {
		const hash = await sha256Hex("block");
		const url = new URL(
			await signHtmlBlockUrl({
				origin: "https://files.example",
				hash,
				secret: "current-secret",
				expiresAt: 2_000,
			}),
		);
		const signature = url.searchParams.get("sig") ?? "";
		expect(
			await verifyHtmlBlockSignature({
				hash: `${hash.slice(0, -1)}0`,
				expiresAt: 2_000,
				signature,
				secret: "current-secret",
				now: 1_000,
			}),
		).toBe(false);
		expect(
			await verifyHtmlBlockSignature({
				hash,
				expiresAt: 2_000,
				signature,
				secret: "current-secret",
				now: 2_000,
			}),
		).toBe(false);
	});
});
