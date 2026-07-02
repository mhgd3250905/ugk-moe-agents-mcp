import { getTaskStatsDetail } from "../../../_lib/marketplace.js";

export async function onRequestGet({ env, params }) {
	return getTaskStatsDetail(env, params.name);
}
