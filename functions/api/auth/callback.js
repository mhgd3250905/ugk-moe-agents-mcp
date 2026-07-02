import { githubCallback } from "../../_lib/marketplace.js";

export async function onRequestGet({ request, env }) {
	return await githubCallback(request, env);
}
