import { submitTask } from "../../_lib/marketplace.js";

export async function onRequestPost({ request, env }) {
	return submitTask(request, env);
}
