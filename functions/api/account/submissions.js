import { accountSubmissions } from "../../_lib/marketplace.js";

export async function onRequestGet({ request, env }) {
	return accountSubmissions(request, env);
}
