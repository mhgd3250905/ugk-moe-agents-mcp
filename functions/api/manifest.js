import { buildManifest } from "../_lib/marketplace.js";

export async function onRequestGet({ request, env }) {
	return buildManifest(request, env);
}
