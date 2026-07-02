import { confirmCliAuth } from "../../../_lib/marketplace.js";

export async function onRequestPost({ request, env }) {
	return confirmCliAuth(request, env);
}
