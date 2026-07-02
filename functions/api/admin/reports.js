import { adminReports } from "../../_lib/marketplace.js";

export async function onRequestGet({ request, env }) {
	return adminReports(request, env);
}
