import { marketplaceStats } from "../_lib/marketplace.js";

export async function onRequestGet({ env }) {
	return marketplaceStats(env);
}
