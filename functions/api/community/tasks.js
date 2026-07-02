import { communityTasks } from "../../_lib/marketplace.js";

export async function onRequestGet({ env }) {
	return communityTasks(env);
}
