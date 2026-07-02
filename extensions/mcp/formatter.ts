import type { McpConnection } from "./registry.ts";
import type { McpPermissionState } from "./permissions.ts";
import { uiText } from "../shared/ui-language.ts";

// ponytail: formatter 自描述所需 state 形状(structural typing 鸭子兼容 McpCommandState),
// 不再 import commands.ts —— 斩断 commands→formatter→commands 的 import cycle。
// 字段是 formatMcpStatus 实际读到的子集,增删时同步此处。
interface McpStatusStateShape {
	registry: { connections: Iterable<McpConnection> };
	permissionState: Pick<McpPermissionState, "mode">;
	serverTools: Map<string, string[]>;
	failedServers?: Map<string, string>;
	warnings?: string[];
	staleServerTools?: Map<string, string[]>;
}

export function formatMcpStatus(state: McpStatusStateShape): string {
	const connections = Array.from(state.registry.connections.values());
	const connected = connections.filter((connection) => connection.status === "connected");
	const failed = normalizeFailedServers(state.failedServers);
	const toolCount = Array.from(state.serverTools.values()).reduce((sum, tools) => sum + tools.length, 0);
	const stale = state.staleServerTools ? Array.from(state.staleServerTools.entries()) : [];
	const warnings = state.warnings ?? [];

	const lines = [
		uiText("MCP 状态", "MCP Status"),
		uiText(
			`已连接 server: ${connected.length}${connected.length ? ` (${connected.map((c) => c.name).join(", ")})` : ""}`,
			`Connected servers: ${connected.length}${connected.length ? ` (${connected.map((c) => c.name).join(", ")})` : ""}`,
		),
		uiText(`工具: ${toolCount}`, `Tools: ${toolCount}`),
		uiText(`权限模式: ${state.permissionState.mode}`, `Permission mode: ${state.permissionState.mode}`),
	];

	if (failed.length > 0) {
		lines.push(uiText(`失败 server: ${failed.map(([name, message]) => `${name} (${message})`).join(", ")}`, `Failed servers: ${failed.map(([name, message]) => `${name} (${message})`).join(", ")}`));
	} else {
		lines.push(uiText("失败 server: 无", "Failed servers: none"));
	}

	if (stale.length > 0) {
		lines.push(uiText(`过期 server: ${stale.map(([name, tools]) => `${name} (${tools.length} 个工具)`).join(", ")}`, `Stale servers: ${stale.map(([name, tools]) => `${name} (${tools.length} tools)`).join(", ")}`));
	}

	if (warnings.length > 0) {
		lines.push(uiText(`警告: ${warnings.join("; ")}`, `Warnings: ${warnings.join("; ")}`));
	}

	return lines.join("\n");
}

function normalizeFailedServers(failedServers: McpStatusStateShape["failedServers"]): Array<[string, string]> {
	if (!failedServers) {
		return [];
	}
	return Array.from(failedServers.entries(), ([name, error]) => [name, String(error)]);
}
