# WDPR Render API v1

The API accepts all page source needed for one render as JSON. It does not read or write wpv4 page data. A client first resolves includes, adds any reported pages to the bulk, and then renders selected local pages.

## Interactive documentation

Open `/docs` on the API origin for Redoc, `/swagger` to try requests in Swagger UI, or download `/openapi.json` for the generated OpenAPI 3.1 specification. Locally, these are `http://localhost:8789/docs`, `http://localhost:8789/swagger`, and `http://localhost:8789/openapi.json` when using the README's development ports.

Redoc and Swagger UI load their assets from jsDelivr. Redoc displays the API reference; use the link to Swagger UI to send requests. Enter the raw `wpv4_` key in **Authorize**; Swagger UI adds the Bearer prefix. **Try it out** sends real requests to the same API origin, including normal rate limiting and HTML-block persistence. Credentials are not persisted across reloads, and the external Swagger validator is disabled.

`hono-openapi` generates paths and methods from the registered Hono routes, with descriptions and schema references declared alongside their handlers. Request validators and response types share the Zod schemas used to generate the specification; there is no separate hand-written OpenAPI document. UTF-8 byte limits and cross-field constraints are described in the operations because JSON Schema cannot express them directly. The specification can also be consumed by client generators such as `@hey-api/openapi-ts`.

## Authentication

`GET /`, `GET /v1/health`, `GET /docs`, `GET /swagger`, `GET /openapi.json`, and CORS preflight are public. `GET /v1/me`, `POST /v1/resolve`, and `POST /v1/render` require:

```http
Authorization: Bearer wpv4_<43 URL-safe characters>
```

The key is introspected through wpv4 and must be active, unexpired, and include `render:use`. The API caches successful introspection for at most 60 seconds and wpv4 401 responses for 10 seconds. Staging and production allow 60 authenticated requests per key per 60 seconds; a rejected request returns 429 with `Retry-After: 60`.

`GET /v1/me` returns the validated user and key fields associated with the credential. It does not return the raw key.

## Request limits

- `Content-Type` must be `application/json`.
- The JSON body is at most 5,000,000 UTF-8 bytes.
- `pages` contains at most 20 entries. An individual `source` is at most 1,000,000 UTF-8 bytes.
- `targets` contains at most 20 entries and cannot contain more entries than `pages`.
- `site` defaults to `{ "name": "render", "title": "Render", "domain": "" }`. Its `name` matches `[a-z0-9-]{1,64}`, `title` is at most 128 characters, and `domain` is at most 253 characters.
- Each page requires `fullname` and `source`. `fullname` contains 1–256 characters; optional `site` is null or a valid site name, and optional `title` is at most 256 characters.
- Optional `created_at` and `updated_at` are RFC 3339 timestamps with an offset. Optional `created_by` is `{ "id": <integer>, "name": <string>, "unix_name": <string> }`; `rating` and `rating_votes` are numbers.
- `tags` contains at most 100 values per page, `users` at most 1,000, and `existing_pages` at most 10,000.
- Local targets must exist in `pages`. Cross-site pages may satisfy includes but cannot be render targets.
- Fullnames are normalized case-insensitively, without a leading slash, path suffix, or `_default:` prefix. Collisions after normalization return 400.

All API JSON responses use UTF-8 and `Cache-Control: no-store`.

## Resolve → fetch missing → render

Set the API URL and key in the caller's environment rather than writing credentials into prompts, source files, or shell history.

```sh
curl "$WDPR_RENDER_ORIGIN/v1/resolve" \
  -H "Authorization: Bearer $WPV4_API_KEY" \
  -H "Content-Type: application/json" \
  --data-binary @bulk.json
```

Example `bulk.json`:

```json
{
	"site": {
		"name": "example",
		"title": "Example Wiki",
		"domain": "example.wikidot.com"
	},
	"pages": [
		{
			"fullname": "guide:start",
			"title": "Start",
			"source": "[[include component:notice]]\nHello"
		}
	],
	"targets": ["guide:start"]
}
```

When an include is absent, `/v1/resolve` returns HTTP 200 with `missing_includes` results and an aggregate `missing` list:

```json
{
	"results": [
		{
			"requested": "guide:start",
			"fullname": "guide:start",
			"status": "missing_includes",
			"dependencies": [{ "site": null, "page": "component:notice", "iteration": 0 }],
			"missing": [
				{
					"site": null,
					"page": "component:notice",
					"requested_by": ["guide:start"]
				}
			],
			"reached_max_iterations": false,
			"input_bytes": 34,
			"expanded_bytes": 98
		}
	],
	"missing": [
		{
			"site": null,
			"page": "component:notice",
			"requested_by": ["guide:start"]
		}
	],
	"elapsed_ms": 1
}
```

Fetch each missing page from the appropriate site, append it to `pages`, and repeat `/v1/resolve` until `missing` is empty or the client decides not to continue. A cross-site include is represented by a non-null `site` and must be added with the same `page.site` value.

Then call render with the completed bulk:

```sh
curl "$WDPR_RENDER_ORIGIN/v1/render" \
  -H "Authorization: Bearer $WPV4_API_KEY" \
  -H "Content-Type: application/json" \
  --data-binary @bulk.json
```

Each result has one of these states:

- `ok`: includes `html`, separately collected `styles`, diagnostics, dependencies, and optional `html_blocks`.
- `missing_includes`: no HTML is returned when `force` is false.
- `error`: rendering or R2 persistence failed; `error_code` and `error_message` are present and HTML is omitted.

Results preserve the input order of `targets`. One target failing does not roll back another target's HTML or previously completed R2 writes.

### Force rendering

Set `"force": true` on `/v1/render` to render even when includes are missing. WDPR emits an error block for unresolved content, and the result can still be `ok` while its `missing` field remains non-empty. Use this for previews where an incomplete result is preferable to no HTML.

### Optional render data

- `viewer`: `{ "number": 7, "title": "Display name", "name": "unix-name" }` for `[[module ListUsers users="."]]`.
- `users`: user records used by WDPR's batch user resolver. Each entry requires `unix_name` and `name`; `id` and `avatar_url` are optional.
- `existing_pages`: additional local page names considered to exist when rendering links.
- `url_paths`: page fullname to request-path mapping used by URL-sensitive modules. Keys are normalized like page fullnames and collisions return 400.

## Dependency differences

`/v1/resolve` expands raw include syntax before parsing. `/v1/render` reports dependencies observed by the complete WDPR processing pipeline. Ordinary include chains have the same `{ site, page, iteration }` shape, but two cases intentionally differ:

- A self-include is traced by `/v1/resolve`; the render pipeline leaves it unexpanded and does not report it as a render dependency.
- An include generated by a module such as ListPages can be observed only by `/v1/render`, because it does not exist in the raw source scanned by `/v1/resolve`.

Clients must use the aggregate `missing` field from the endpoint they are currently processing rather than assuming both graphs are identical.

## ListPages and TagCloud

ListPages evaluates only pages supplied in the local bulk. Supported selectors are `category`, `tags`, `name`, `fullname`, `range="."`, `order`, `reverse`, `offset`, and `limit`. Supported order fields are `created_at`, `updated_at`, `title`, and `fullname`; the default is `created_at` descending. Unsupported selectors produce a `listpages-unsupported-selector` warning and an empty module result.

TagCloud also evaluates only local bulk pages. Hidden tags beginning with `_` are excluded. A category is normalized to its Wikidot unix-name form; a category absent from the bulk is treated as not found.

## HTML blocks

`[[html]]` content is SHA-256 content-addressed and stored under `html/<hash>` in R2. The returned iframe uses `sandbox="allow-scripts"` without `allow-same-origin`. Its URL contains `exp` and an HMAC-SHA256 `sig`, expires after 24 hours, and is also returned in `html_blocks[].url` with the same Unix-second value in `expires_at`.

The files Worker validates the signature before reading R2, injects the WDPR resize script, and sends private/no-store and browser-hardening headers. R2 lifecycle rules retain objects for seven days so repeated rendering can refresh an object's lifecycle without breaking an already-issued URL.

## Errors and retry behavior

Errors use this shape:

```json
{
	"error": "Request validation failed",
	"code": "validation",
	"detail": { "issues": [] }
}
```

Relevant status codes are 400 validation, 401 invalid/expired key, 403 missing scope, 413 oversized body, 415 wrong media type, 429 rate limited, 503 wpv4 introspection unavailable, and 500 internal failure. Cloudflare may terminate CPU-heavy rendering with Error 1102 and an HTTP 5xx before the application can return JSON. On 1102 or another transient 5xx, split `targets` and the associated page bulk into smaller requests instead of retrying the same oversized request unchanged.
