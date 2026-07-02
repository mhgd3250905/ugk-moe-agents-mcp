import { reportTask } from "../../../_lib/marketplace.js";

export async function onRequestPost({ request, env, params }) {
	return reportTask(request, env, params.name);
}
