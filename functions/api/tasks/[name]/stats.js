import { getTaskStats } from "../../../_lib/marketplace.js";

export async function onRequestGet({ request, env, params }) {
	return getTaskStats(request, env, params.name);
}
