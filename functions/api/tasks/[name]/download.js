import { recordDownload } from "../../../_lib/marketplace.js";

export async function onRequestPost({ request, env, params }) {
	return await recordDownload(request, env, params.name);
}
