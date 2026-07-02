import { toggleFavorite } from "../../../_lib/marketplace.js";

export async function onRequestPost({ request, env, params }) {
	return await toggleFavorite(request, env, params.name);
}
