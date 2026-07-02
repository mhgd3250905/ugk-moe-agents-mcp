import { serveTaskFile } from "../../../_lib/marketplace.js";

// Serves individual loose files from R2 for CLI install.
// File path passed as query param ?f=<path> to avoid wildcard route syntax
// that older wrangler versions reject ([...path]).
export async function onRequestGet({ env, params, request }) {
	const file = new URL(request.url).searchParams.get("f") ?? "";
	return serveTaskFile(env, params.name, file);
}
