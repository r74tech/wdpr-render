import { HTML_BLOCK_RESIZE_SCRIPT } from "@wdprlib/runtime/html-block-script";
import { verifyHtmlBlockSignature } from "../core/signed-url";

export type FilesBindings = Pick<FilesEnv, "ASSETS" | "HTML_BLOCKS" | "FILES_URL_SECRET">;

const HTML_PATH = /^\/html\/([a-f0-9]{64})$/;
const RESIZE_SCRIPT_PATH = "/common--javascript/html-block-iframe.js";

export async function handleFilesRequest(
	request: Request,
	env: FilesBindings,
	now = Math.floor(Date.now() / 1_000),
): Promise<Response> {
	const url = new URL(request.url);
	if (request.method === "GET" && url.pathname === "/html-block.css") {
		return env.ASSETS.fetch(request);
	}
	if (request.method === "GET" && url.pathname === RESIZE_SCRIPT_PATH) {
		return new Response(HTML_BLOCK_RESIZE_SCRIPT, {
			headers: {
				"Content-Type": "text/javascript; charset=utf-8",
				"Cache-Control": "public, max-age=3600",
				"X-Content-Type-Options": "nosniff",
			},
		});
	}

	const match = HTML_PATH.exec(url.pathname);
	if ((request.method !== "GET" && request.method !== "HEAD") || !match) return notFound();
	const hash = match[1]!;
	const expiresAt = Number(url.searchParams.get("exp"));
	const signature = url.searchParams.get("sig") ?? "";
	const valid = await verifyHtmlBlockSignature({
		hash,
		expiresAt,
		signature,
		secret: env.FILES_URL_SECRET,
		now,
	});
	if (!valid) return forbidden();

	const object = await env.HTML_BLOCKS.get(`html/${hash}`);
	if (object === null) return notFound();
	if (request.method === "HEAD") return htmlResponse(null);

	const source = await object.text();
	const html = /<body[\s>]/i.test(source) ? source : wrapHtmlFragment(source);
	const transformed = new HTMLRewriter()
		.on("body", {
			element(element) {
				element.append(
					'<script type="text/javascript" src="/common--javascript/html-block-iframe.js"></script>',
					{ html: true },
				);
			},
		})
		.transform(new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } }));
	return htmlResponse(transformed.body);
}

export function wrapHtmlFragment(source: string): string {
	return `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd"><html id="html-block-html" xmlns="http://www.w3.org/1999/xhtml" xml:lang="ja" lang="ja"><head><meta http-equiv="Content-type" content="text/html; charset=utf-8"/><link rel="stylesheet" href="/html-block.css"/></head><body>${source}</body></html>`;
}

function htmlResponse(body: BodyInit | null): Response {
	return new Response(body, {
		headers: {
			"Content-Type": "text/html; charset=utf-8",
			"Cache-Control": "private, no-store",
			"X-Content-Type-Options": "nosniff",
			"Referrer-Policy": "no-referrer",
			"Permissions-Policy": "camera=(), microphone=(), geolocation=()",
		},
	});
}

function forbidden(): Response {
	return new Response("Forbidden", { status: 403, headers: { "Cache-Control": "no-store" } });
}

function notFound(): Response {
	return new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });
}
