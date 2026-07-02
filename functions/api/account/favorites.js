import { accountFavorites } from "../../_lib/marketplace.js";

export async function onRequestGet({ request, env }) {
	return accountFavorites(request, env);
}
