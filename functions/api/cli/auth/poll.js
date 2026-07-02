import { pollCliAuth } from "../../../_lib/marketplace.js";

export async function onRequestPost({ request, env }) {
	return pollCliAuth(request, env);
}
