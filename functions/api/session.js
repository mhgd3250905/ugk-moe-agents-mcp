import { currentSession } from "../_lib/marketplace.js";

export async function onRequestGet({ request, env }) {
	return await currentSession(request, env);
}
