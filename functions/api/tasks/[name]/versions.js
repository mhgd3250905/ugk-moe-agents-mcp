import { getTaskVersions } from "../../../_lib/marketplace.js";

export async function onRequestGet({ env, params }) {
	return getTaskVersions(env, params.name);
}
