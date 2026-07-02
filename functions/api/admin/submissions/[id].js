import { reviewSubmission } from "../../../_lib/marketplace.js";

export async function onRequestPost({ request, env, params }) {
	return reviewSubmission(request, env, params.id);
}
