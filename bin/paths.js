/**
 * Shared path helpers for bin/ scripts.
 *
 * Centralizes the agent-dir resolution that was duplicated across
 * update-core.js, workspace-trust.js, and ugk-startup-settings.js.
 */
import os from "node:os";
import path from "node:path";

/** Default agent directory if PI_CODING_AGENT_DIR is unset. */
export function defaultAgentDir() {
	return process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
}

/**
 * Resolve the agent dir from a given env, expanding leading ~/ to the home dir.
 * Used by startup settings where users may write "~/custom/path" in env.
 */
export function resolveAgentDir(env = process.env) {
	const raw = env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
	if (raw === "~") return os.homedir();
	if (raw.startsWith("~/")) return path.join(os.homedir(), raw.slice(2));
	return raw;
}
