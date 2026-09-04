import { ApiError } from "../api/errors";

export const MAX_JSON_BODY_BYTES = 5_000_000;

export async function readJsonBody(
	request: Request,
	maxBytes = MAX_JSON_BODY_BYTES,
): Promise<unknown> {
	const contentType = request.headers.get("Content-Type")?.split(";", 1)[0]?.trim().toLowerCase();
	if (contentType !== "application/json") {
		throw new ApiError(415, "unsupported_media_type", "Content-Type must be application/json");
	}

	const declaredLength = request.headers.get("Content-Length");
	if (declaredLength !== null) {
		const parsed = Number(declaredLength);
		if (Number.isFinite(parsed) && parsed > maxBytes) {
			throw new ApiError(413, "payload_too_large", "Request body exceeds 5000000 bytes");
		}
	}

	const reader = request.body?.getReader();
	if (!reader) throw new ApiError(400, "validation", "Request body is required");
	const chunks: Uint8Array[] = [];
	let length = 0;
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		length += value.byteLength;
		if (length > maxBytes) {
			await reader.cancel();
			throw new ApiError(413, "payload_too_large", "Request body exceeds 5000000 bytes");
		}
		chunks.push(value);
	}

	const bytes = new Uint8Array(length);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}

	let text: string;
	try {
		text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		throw new ApiError(400, "validation", "Request body is not valid UTF-8");
	}
	try {
		return JSON.parse(text) as unknown;
	} catch {
		throw new ApiError(400, "validation", "Request body is not valid JSON");
	}
}
