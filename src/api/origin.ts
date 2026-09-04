import type { Bindings } from "../types/env";
import { ApiError } from "./errors";

export function validateFilesOrigin(value: string, environment: Bindings["ENVIRONMENT"]): string {
	try {
		if (!/^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/?#]+\/?$/.test(value)) {
			throw new Error("origin must not contain a path, query, or fragment");
		}
		const url = new URL(value);
		const cleanOrigin =
			url.username === "" &&
			url.password === "" &&
			url.pathname === "/" &&
			url.search === "" &&
			url.hash === "";
		const secure = url.protocol === "https:";
		const developmentHttp =
			environment === "development" &&
			url.protocol === "http:" &&
			(url.hostname === "localhost" || url.hostname === "127.0.0.1");
		if (!cleanOrigin || (!secure && !developmentHttp)) throw new Error("unsafe origin");
		return url.origin;
	} catch (error) {
		console.error("Invalid FILES_ORIGIN", error);
		throw new ApiError(500, "internal", "Internal server error");
	}
}
