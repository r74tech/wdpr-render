export interface RenderRateLimiter {
	limit(input: { key: string }): Promise<{ success: boolean }>;
}

export async function tryRenderRateLimit(
	limiter: RenderRateLimiter | undefined,
	keyHash: string,
	onError?: (error: unknown) => void,
): Promise<boolean> {
	if (!limiter) return true;
	try {
		const result = await limiter.limit({ key: `apikey:${keyHash.slice(0, 16)}` });
		return result.success;
	} catch (error) {
		onError?.(error);
		return true;
	}
}
