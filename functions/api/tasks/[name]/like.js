import { toggleLike } from "../../../_lib/marketplace.js";

export async function onRequestPost({ request, env, params }) {
	return await toggleLike(request, env, params.name);
}
