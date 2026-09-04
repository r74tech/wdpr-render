const builds = [
	{ entrypoint: "src/api/index.ts", output: "api.js" },
	{ entrypoint: "test/fixtures/api-r2-failure.ts", output: "api-r2-failure.js" },
] as const;

for (const { entrypoint, output } of builds) {
	const result = await Bun.build({
		entrypoints: [entrypoint],
		outdir: "dist",
		naming: output,
		target: "browser",
		format: "esm",
	});

	if (!result.success) {
		for (const log of result.logs) console.error(log);
		process.exit(1);
	}
}

export {};
