import app from "../../src/api";
import type { Bindings } from "../../src/types/env";

const failingBucket = {
	async put(): Promise<never> {
		throw new Error("R2 unavailable in runtime fixture");
	},
} as unknown as R2Bucket;

export default {
	fetch(request, env, context) {
		return app.fetch(request, { ...env, HTML_BLOCKS: failingBucket }, context);
	},
} satisfies ExportedHandler<Bindings>;
