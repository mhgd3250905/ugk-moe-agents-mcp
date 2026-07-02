import { logout } from "../_lib/marketplace.js";

export function onRequestPost() {
	return logout();
}
