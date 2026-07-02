import { githubLogin } from "../../_lib/marketplace.js";

export async function onRequestGet({ request, env }) {
	return await githubLogin(request, env);
}
