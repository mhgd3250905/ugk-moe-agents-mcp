import { downloadSubmissionArtifact } from "../../../_lib/marketplace.js";

export async function onRequestGet({ env, params }) {
	return downloadSubmissionArtifact(env, params.id);
}
