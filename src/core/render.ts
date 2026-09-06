import { createSettings, processWikitext } from "@wdprlib/parser";
import { renderWikitext } from "@wdprlib/render";
import type { Bulk, TargetPage } from "./bulk";
import { normalizeFullname } from "./bulk";
import { HtmlBlockCollector, persistHtmlBlocks, type HtmlBlockBucket } from "./html-blocks";
import {
	MissingIncludeCollector,
	createIncludeFetcher,
	createListPagesProvider,
	createListUsersProvider,
	createPageExistenceResolver,
	createTagCloudProvider,
	createUserResolver,
	toDependency,
	type Dependency,
	type MissingInclude,
	type ProviderDiagnostic,
	type RenderUserInput,
	type RenderViewerInput,
} from "./providers";

import type { RenderDiagnostic, RenderTargetResult } from "./schema";
export type { RenderDiagnostic, RenderTargetResult } from "./schema";

const encoder = new TextEncoder();

export interface RenderTargetInput {
	bulk: Bulk;
	target: TargetPage;
	force: boolean;
	viewer?: RenderViewerInput;
	users?: readonly RenderUserInput[];
	existingPages?: readonly string[];
	urlPaths?: Readonly<Record<string, string>>;
	bucket: HtmlBlockBucket;
	filesOrigin: string;
	filesUrlSecret: string;
	htmlBlockExpiresAt: number;
}

export async function renderTarget(input: RenderTargetInput): Promise<RenderTargetResult> {
	const { bulk, target } = input;
	const missingCollector = new MissingIncludeCollector(target.page.fullname, bulk.site.name);
	const providerDiagnostics: ProviderDiagnostic[] = [];
	const inputBytes = encoder.encode(target.page.source).length;
	let diagnostics: RenderDiagnostic[] = [];
	let dependencies: Dependency[] = [];

	try {
		const settings = { ...createSettings("page"), allowStyleElements: true };
		const page = {
			fullName: target.page.fullname,
			unixName: target.page.name,
			tags: target.page.tags ?? [],
			urlPath: urlPathFor(input.urlPaths, target.page.fullname),
			site: bulk.site.name,
			domain: bulk.site.domain,
			category: target.page.category,
		};
		const document = await processWikitext(target.page.source, {
			page,
			settings,
			includeMaxIterations: 10,
			dataProvider: {
				fetchInclude: createIncludeFetcher(bulk, missingCollector),
				fetchListPages: createListPagesProvider(bulk, providerDiagnostics),
				fetchListUsers: createListUsersProvider(input.viewer),
				fetchTagCloud: createTagCloudProvider(bulk),
			},
		});
		dependencies = document.dependencies.map((dependency) =>
			toDependency(dependency, bulk.site.name),
		);
		diagnostics = [
			...document.diagnostics.map(({ severity, code, message }) => ({
				severity,
				code,
				message,
			})),
			...providerDiagnostics,
		];
		const missing = missingCollector.values();
		if (!input.force && missing.length > 0) {
			return baseResult(input, "missing_includes", diagnostics, dependencies, missing, inputBytes);
		}

		const htmlBlocks = new HtmlBlockCollector({
			origin: input.filesOrigin,
			secret: input.filesUrlSecret,
			expiresAt: input.htmlBlockExpiresAt,
		});
		const rendered = await renderWikitext(document, {
			styleMode: "separate",
			htmlBlockSandbox: "allow-scripts",
			baseUrl: bulk.site.domain ? `https://${bulk.site.domain}` : undefined,
			resolvers: {
				resolveHtmlBlockUrl: (block) => htmlBlocks.resolve(block),
				resolvePageExistence: createPageExistenceResolver(bulk, input.existingPages ?? []),
				resolveUsers: createUserResolver(input.users ?? []),
			},
		});

		try {
			await persistHtmlBlocks(input.bucket, htmlBlocks.blocks());
		} catch (error) {
			return errorResult(
				input,
				"html_block_store_failed",
				error,
				diagnostics,
				dependencies,
				missing,
				inputBytes,
			);
		}

		return {
			...baseResult(input, "ok", diagnostics, dependencies, missing, inputBytes),
			html: rendered.html,
			styles: rendered.styles,
			html_blocks: htmlBlocks.metadata(),
		};
	} catch (error) {
		return errorResult(
			input,
			"render_failed",
			error,
			diagnostics,
			dependencies,
			missingCollector.values(),
			inputBytes,
		);
	}
}

function urlPathFor(paths: Readonly<Record<string, string>> | undefined, fullname: string): string {
	const key = normalizeFullname(fullname);
	return paths && Object.hasOwn(paths, key) ? paths[key]! : `/${fullname}`;
}

function baseResult(
	input: RenderTargetInput,
	status: RenderTargetResult["status"],
	diagnostics: RenderDiagnostic[],
	dependencies: Dependency[],
	missing: MissingInclude[],
	inputBytes: number,
): RenderTargetResult {
	return {
		requested: input.target.requested,
		fullname: input.target.page.fullname,
		status,
		diagnostics,
		dependencies,
		missing,
		input_bytes: inputBytes,
	};
}

function errorResult(
	input: RenderTargetInput,
	code: NonNullable<RenderTargetResult["error_code"]>,
	error: unknown,
	diagnostics: RenderDiagnostic[],
	dependencies: Dependency[],
	missing: MissingInclude[],
	inputBytes: number,
): RenderTargetResult {
	return {
		...baseResult(input, "error", diagnostics, dependencies, missing, inputBytes),
		error_code: code,
		error_message: error instanceof Error ? error.message : "Unknown rendering error",
	};
}
