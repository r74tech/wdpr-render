const encoder = new TextEncoder();

function bytesToHex(bytes: ArrayBuffer): string {
	return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function signaturesEqual(left: string, right: string): boolean {
	if (left.length !== right.length) {
		return false;
	}

	let difference = 0;
	for (let index = 0; index < left.length; index += 1) {
		difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
	}
	return difference === 0;
}

async function hmacSha256Hex(secret: string, message: string): Promise<string> {
	const key = await crypto.subtle.importKey(
		"raw",
		encoder.encode(secret),
		{ hash: "SHA-256", name: "HMAC" },
		false,
		["sign"],
	);
	return bytesToHex(await crypto.subtle.sign("HMAC", key, encoder.encode(message)));
}

export async function sha256Hex(input: string): Promise<string> {
	return bytesToHex(await crypto.subtle.digest("SHA-256", encoder.encode(input)));
}

export interface SignHtmlBlockUrlInput {
	origin: string;
	hash: string;
	secret: string;
	expiresAt: number;
}

export async function signHtmlBlockUrl({
	origin,
	hash,
	secret,
	expiresAt,
}: SignHtmlBlockUrlInput): Promise<string> {
	const signature = await hmacSha256Hex(secret, `${hash}:${expiresAt}`);
	const url = new URL(`/html/${hash}`, origin);
	url.searchParams.set("exp", expiresAt.toString());
	url.searchParams.set("sig", signature);
	return url.toString();
}

export interface VerifyHtmlBlockSignatureInput {
	hash: string;
	expiresAt: number;
	signature: string;
	secret: string;
	now: number;
}

export async function verifyHtmlBlockSignature({
	hash,
	expiresAt,
	signature,
	secret,
	now,
}: VerifyHtmlBlockSignatureInput): Promise<boolean> {
	if (
		!/^[a-f0-9]{64}$/.test(hash) ||
		!/^[a-f0-9]{64}$/.test(signature) ||
		!Number.isSafeInteger(expiresAt) ||
		expiresAt <= now
	) {
		return false;
	}

	const expectedSignature = await hmacSha256Hex(secret, `${hash}:${expiresAt}`);
	return signaturesEqual(signature, expectedSignature);
}
