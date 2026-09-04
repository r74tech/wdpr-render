import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
	plugins: [
		cloudflareTest({
			main: "./dist/api.js",
			wrangler: { configPath: "./wrangler.jsonc" },
			miniflare: {
				compatibilityDate: "2026-09-04",
				bindings: {
					ENVIRONMENT: "staging",
					FILES_ORIGIN: "https://files.example",
					FILES_URL_SECRET: "test-secret",
				},
				serviceBindings: {
					WPV4: "wpv4",
					FILES: "files",
					FAILING_API: "api-r2-failure",
				},
				workers: [
					{
						name: "files",
						scriptPath: "./dist/files.js",
						modules: true,
						bindings: { FILES_URL_SECRET: "test-secret" },
						r2Buckets: { HTML_BLOCKS: "wdpr-render-html-dev" },
						serviceBindings: {
							ASSETS: () => new Response("Not found", { status: 404 }),
						},
					},
					{
						name: "wpv4",
						scriptPath: "./test/fixtures/wpv4-mock.js",
						modules: true,
					},
					{
						name: "api-r2-failure",
						scriptPath: "./dist/api-r2-failure.js",
						modules: true,
						bindings: {
							ENVIRONMENT: "staging",
							FILES_ORIGIN: "https://files.example",
							FILES_URL_SECRET: "test-secret",
						},
						serviceBindings: { WPV4: "wpv4" },
					},
				],
			},
		}),
	],
	test: {
		include: ["test/workers/api.test.ts"],
	},
});
