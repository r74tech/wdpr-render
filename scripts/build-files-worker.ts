const result = await Bun.build({
	entrypoints: ["src/files/index.ts"],
	outdir: "dist",
	naming: "files.js",
	target: "browser",
	format: "esm",
});

if (!result.success) {
	for (const log of result.logs) console.error(log);
	process.exit(1);
}

export {};
