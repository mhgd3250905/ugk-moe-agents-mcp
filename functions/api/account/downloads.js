import { accountDownloads } from "../../_lib/marketplace.js";

export async function onRequestGet({ request, env }) {
	return accountDownloads(request, env);
}
