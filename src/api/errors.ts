export type ApiErrorCode =
	| "validation"
	| "payload_too_large"
	| "unsupported_media_type"
	| "not_found"
	| "internal";

export class ApiError extends Error {
	readonly status: 400 | 404 | 413 | 415 | 500;
	readonly code: ApiErrorCode;
	readonly detail?: unknown;

	constructor(status: ApiError["status"], code: ApiErrorCode, message: string, detail?: unknown) {
		super(message);
		this.name = "ApiError";
		this.status = status;
		this.code = code;
		this.detail = detail;
	}
}
