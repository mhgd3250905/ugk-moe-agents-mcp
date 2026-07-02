import { startCliAuth } from "../../../_lib/marketplace.js";

export async function onRequestPost({ request, env }) {
	return startCliAuth(request, env);
}
