const keys = {
	valid: `wpv4_${"A".repeat(43)}`,
	expired: `wpv4_${"B".repeat(43)}`,
	insufficientScope: `wpv4_${"C".repeat(43)}`,
	invalidResponse: `wpv4_${"D".repeat(43)}`,
};

function introspection(scopes, expiresAt = null) {
	return {
		user: { wikidot_id: 42, name: "Alice", unix_name: "alice" },
		key: { name: "Runtime fixture", scopes, expires_at: expiresAt },
	};
}

export default {
	fetch(request) {
		const url = new URL(request.url);
		if (request.method !== "GET" || url.pathname !== "/api/v1/me") {
			return Response.json({ error: "Not found", code: "not_found" }, { status: 404 });
		}

		const key = request.headers.get("Authorization")?.replace(/^Bearer /, "");
		switch (key) {
			case keys.valid:
				return Response.json(introspection(["render:use"]));
			case keys.expired:
				return Response.json(introspection(["render:use"], "2000-01-01T00:00:00.000Z"));
			case keys.insufficientScope:
				return Response.json(introspection(["pages:read"]));
			case keys.invalidResponse:
				return Response.json({ invalid: true });
			default:
				return Response.json({ error: "Unauthorized", code: "unauthorized" }, { status: 401 });
		}
	},
};
