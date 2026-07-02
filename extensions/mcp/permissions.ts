import type { McpConfigScope } from "./config.ts";
import { suppressConfirmation } from "../shared/autopilot.ts";

export type McpPermissionMode = "off" | "ask" | "on";

export interface McpPermissionState {
	mode: McpPermissionMode;
	sessionAllowedServers: Set<string>;
}

export type PolicyResult =
	| { allowed: true; requiresConfirmation: boolean; reason?: undefined }
	| { allowed: false; requiresConfirmation: false; reason: string };

export type McpSpawnPolicyRequest = {
	serverName: string;
	scope: McpConfigScope;
	command: string;
};

export type McpToolPolicyRequest = {
	serverName: string;
	toolName: string;
	reason: string;
};

export function createMcpPermissionState(initialMode: McpPermissionMode = "ask"): McpPermissionState {
	return {
		mode: initialMode,
		sessionAllowedServers: new Set(),
	};
}

export function isTaskMcpToolPreauthorized(
	registeredName: string,
	env: Record<string, string | undefined> = process.env,
): boolean {
	return (env.UGK_TASK_ALLOW_MCP_TOOLS ?? "")
		.split(",")
		.map((item) => item.trim())
		.filter(Boolean)
		.includes(registeredName);
}

export function setMcpPermissionMode(state: McpPermissionState, mode: McpPermissionMode): void {
	state.mode = mode;
	clearMcpSessionAllow(state);
}

export function grantMcpSessionAllow(state: McpPermissionState, serverName: string): void {
	state.sessionAllowedServers.add(serverName);
}

export function clearMcpSessionAllow(state: McpPermissionState, serverName?: string): void {
	if (serverName === undefined) {
		state.sessionAllowedServers.clear();
		return;
	}

	state.sessionAllowedServers.delete(serverName);
}

export function checkMcpSpawnPolicy(
	_state: McpPermissionState,
	request: McpSpawnPolicyRequest,
	hasUI: boolean,
): PolicyResult {
	if (request.scope === "install" || request.scope === "user") {
		return { allowed: true, requiresConfirmation: false };
	}

	if (!hasUI) {
		return {
			allowed: false,
			requiresConfirmation: false,
			reason: `MCP server "${request.serverName}" blocked by spawn policy: scope "${request.scope}" requires UI confirmation before spawning command "${request.command}".`,
		};
	}

	return { allowed: true, requiresConfirmation: true };
}

export function checkMcpToolPolicy(
	state: McpPermissionState,
	request: McpToolPolicyRequest,
	_hasUI: boolean,
): PolicyResult {
	if (state.mode === "off") {
		return {
			allowed: false,
			requiresConfirmation: false,
			reason: "MCP is off. Ask the user to run /mcp ask or /mcp on.",
		};
	}

	if (state.mode === "on" || state.sessionAllowedServers.has(request.serverName)) {
		return { allowed: true, requiresConfirmation: false };
	}

	// autopilot on 时,ask 模式的确认被短路为直接放行(见 shared/autopilot.ts)。
	return { allowed: true, requiresConfirmation: suppressConfirmation(true) };
}
