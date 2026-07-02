import { adminSubmissions } from "../../_lib/marketplace.js";

export async function onRequestGet({ request, env }) {
	return adminSubmissions(request, env);
}
