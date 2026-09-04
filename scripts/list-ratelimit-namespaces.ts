interface ApiEnvelope<T> {
	success: boolean;
	result: T;
}

export {};

interface WorkerScript {
	id?: string;
}

interface WorkerBinding {
	name?: string;
	type?: string;
	namespace_id?: string;
}

interface WorkerSettings {
	bindings?: WorkerBinding[];
}

interface ExpectedNamespace {
	namespaceId: string;
	script: string;
	binding: string;
}

function parseExpectedNamespace(value: string): ExpectedNamespace {
	const match = /^([1-9][0-9]*)=([^:=]+):([^:=]+)$/.exec(value);
	if (!match) {
		throw new Error("Expected namespace must use <id>=<script>:<binding>");
	}
	return { namespaceId: match[1]!, script: match[2]!, binding: match[3]! };
}

const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
const apiToken = process.env.CLOUDFLARE_API_TOKEN;
if (!accountId || !apiToken) {
	throw new Error("CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN are required");
}

const apiBase = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}`;
const headers = { Authorization: `Bearer ${apiToken}` };

async function get<T>(path: string): Promise<T> {
	const response = await fetch(`${apiBase}${path}`, { headers });
	if (!response.ok) throw new Error(`Cloudflare API ${path} failed with HTTP ${response.status}`);
	const envelope = (await response.json()) as ApiEnvelope<T>;
	if (!envelope.success) throw new Error(`Cloudflare API ${path} returned success=false`);
	return envelope.result;
}

const scripts = await get<WorkerScript[]>("/workers/scripts");
const usages: Array<{ namespaceId: string; script: string; binding: string }> = [];
for (const script of scripts) {
	if (!script.id) throw new Error("Cloudflare API returned a Worker without an id");
	const settings = await get<WorkerSettings>(
		`/workers/scripts/${encodeURIComponent(script.id)}/settings`,
	);
	for (const binding of settings.bindings ?? []) {
		if (binding.type !== "ratelimit" || !binding.namespace_id) continue;
		usages.push({
			namespaceId: binding.namespace_id,
			script: script.id,
			binding: binding.name ?? "(unnamed)",
		});
	}
}

usages.sort(
	(left, right) =>
		Number(left.namespaceId) - Number(right.namespaceId) ||
		left.script.localeCompare(right.script) ||
		left.binding.localeCompare(right.binding),
);
if (usages.length === 0) console.log("No Rate Limiting namespaces are currently in use.");
else {
	console.log("namespace_id\tscript\tbinding");
	for (const usage of usages) {
		console.log(`${usage.namespaceId}\t${usage.script}\t${usage.binding}`);
	}
}

const expected = process.argv.slice(2).map(parseExpectedNamespace);
if (expected.length > 0) {
	if (new Set(expected.map(({ namespaceId }) => namespaceId)).size !== expected.length) {
		throw new Error("Namespace IDs must be distinct");
	}
	for (const planned of expected) {
		const actual = usages.filter(({ namespaceId }) => namespaceId === planned.namespaceId);
		const expectedOwner =
			actual.length === 1 &&
			actual[0]!.script === planned.script &&
			actual[0]!.binding === planned.binding;
		if (actual.length > 0 && !expectedOwner) {
			throw new Error(
				`Namespace ${planned.namespaceId} has an unexpected owner: ${actual.map(({ script, binding }) => `${script}:${binding}`).join(", ")}`,
			);
		}
		console.log(
			actual.length === 0
				? `Available namespace: ${planned.namespaceId}`
				: `Expected owner: ${planned.namespaceId}=${planned.script}:${planned.binding}`,
		);
	}
}
