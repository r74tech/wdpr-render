import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
	plugins: [
		cloudflareTest({
			wrangler: { configPath: "./wrangler.files.jsonc" },
			miniflare: { bindings: { FILES_URL_SECRET: "test-secret" } },
		}),
	],
	test: {
		include: ["test/workers/files.test.ts"],
	},
});
