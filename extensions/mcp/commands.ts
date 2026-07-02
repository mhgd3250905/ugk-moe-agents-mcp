import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { McpPermissionState } from "./permissions.ts";
import { setMcpPermissionMode, type McpPermissionMode } from "./permissions.ts";
import type { McpConnection, McpRegistry } from "./registry.ts";
import {
	buildToolName,
	normalizeToolName,
	registerMcpTools,
	resolveNormalizedServerNames,
	type McpToolRegistrationOptions,
	type McpToolRegistrationResult,
} from "./tools.ts";
import { formatMcpStatus } from "./formatter.ts";
import { uiText } from "../shared/ui-language.ts";

function mcpMenuOptions(): string[] {
	return uiText(
		["📊 查看状态", "🔄 重载所有 server", "⚙️ 切换权限模式", "✅ 启用 server", "⛔ 禁用 server", "退出"],
		["📊 Status", "🔄 Reload all servers", "⚙️ Switch permission mode", "✅ Enable server", "⛔ Disable server", "Exit"],
	);
}

function mcpModeOptions(): string[] {
	return uiText(["ask", "on", "off", "返回"], ["ask", "on", "off", "Back"]);
}

export type McpCommandState = {
	registry: Pick<McpRegistry, "connections" | "disconnectAll">;
	permissionState: McpPermissionState;
	serverTools: Map<string, string[]>;
	failedServers?: Map<string, string>;
	warnings?: string[];
	staleServerTools?: Map<string, string[]>;
};

export type McpReloadResult = {
	connections?: McpConnection[];
	registered?: Map<string, string[]>;
	failed?: Map<string, string>;
	warnings?: string[];
};

export type McpCommandDeps = {
	reload?: (context?: CommandContext) => Promise<McpReloadResult>;
	registerMcpTools?: (
		pi: ExtensionAPI,
		connections: McpConnection[],
		opts?: McpToolRegistrationOptions,
	) => McpToolRegistrationResult;
};

type CommandContext = {
	cwd?: string;
	hasUI?: boolean;
	ui?: {
		notify?: (message: string) => void;
		confirm?: (title: string, body?: string) => boolean | Promise<boolean>;
		select?: (title: string, options: string[]) => string | Promise<string>;
	};
};

export function registerMcpCommand(pi: ExtensionAPI, state: McpCommandState, deps: McpCommandDeps = {}): void {
	pi.registerCommand("mcp", {
		description: "Manage MCP servers and tools",
		async handler(input: string = "", context: CommandContext = {}) {
			const resolvedInput = await resolveMcpArgs(input, context, state, getActiveTools(pi));
			if (!resolvedInput) {
				return;
			}

			const [command = "status", serverName] = resolvedInput.trim().split(/\s+/).filter(Boolean);
			const action = command.toLowerCase();

			if (action === "status") {
				notify(context, formatMcpStatus(state));
				return;
			}

			if (isPermissionMode(action)) {
				setMcpPermissionMode(state.permissionState, action);
				notify(context, uiText(`MCP 模式: ${state.permissionState.mode}`, `MCP mode: ${state.permissionState.mode}`));
				return;
			}

			if (action === "disable") {
				notify(context, disableServer(pi, state, serverName));
				return;
			}

			if (action === "enable") {
				notify(context, enableServer(pi, state, serverName));
				return;
			}

			if (action === "reload") {
				notify(context, await reloadMcp(pi, state, deps, context));
				return;
			}

			notify(context, uiText(`未知 /mcp 命令 "${command}"。用法: /mcp status|on|off|ask|reload|enable <server>|disable <server>`, `Unknown /mcp command "${command}". Usage: /mcp status|on|off|ask|reload|enable <server>|disable <server>`));
		},
	});
}

async function resolveMcpArgs(
	args: string,
	ctx: CommandContext,
	state: McpCommandState,
	activeTools: string[],
): Promise<string | undefined> {
	if (args.trim()) {
		return args;
	}
	if (!ctx.ui?.select) {
		return "status";
	}

	const options = mcpMenuOptions();
	const selection = await ctx.ui.select(formatMcpMenuTitle(state), options);
	if (!selection || selection === options[5]) {
		return undefined;
	}
	if (selection === options[0]) {
		return "status";
	}
	if (selection === options[1]) {
		return "reload";
	}
	if (selection === options[2]) {
		return selectMcpMode(ctx);
	}
	if (selection === options[3]) {
		return selectMcpServerToEnable(ctx, state, activeTools);
	}
	if (selection === options[4]) {
		return selectMcpServerToDisable(ctx, state, activeTools);
	}
	return undefined;
}

async function selectMcpMode(ctx: CommandContext): Promise<string | undefined> {
	const options = mcpModeOptions();
	const selection = await ctx.ui!.select!(uiText("切换 MCP 权限模式", "Switch MCP Permission Mode"), options);
	return selection && selection !== options[3] ? selection : undefined;
}

async function selectMcpServerToEnable(
	ctx: CommandContext,
	state: McpCommandState,
	activeTools: string[],
): Promise<string | undefined> {
	const active = new Set(activeTools);
	const options = Array.from(state.serverTools)
		.filter(([, tools]) => !tools.some((tool) => active.has(tool)))
		.map(([serverName]) => serverName);

	for (const [serverName, tools] of state.staleServerTools ?? []) {
		if (!tools.some((tool) => active.has(tool)) && !options.includes(serverName)) {
			options.push(`${serverName} (stale)`);
		}
	}

	if (options.length === 0) {
		notify(ctx, uiText("没有可启用的 server", "No servers available to enable"));
		return undefined;
	}

	const back = uiText("返回", "Back");
	const selection = await ctx.ui!.select!(uiText("启用 MCP server", "Enable MCP Server"), [...options, back]);
	if (!selection || selection === back) {
		return undefined;
	}
	return `enable ${selection.replace(/ \(stale\)$/, "")}`;
}

async function selectMcpServerToDisable(
	ctx: CommandContext,
	state: McpCommandState,
	activeTools: string[],
): Promise<string | undefined> {
	const active = new Set(activeTools);
	const options = Array.from(state.serverTools)
		.filter(([, tools]) => tools.some((tool) => active.has(tool)))
		.map(([serverName]) => serverName);

	if (options.length === 0) {
		notify(ctx, uiText("没有可禁用的 server", "No servers available to disable"));
		return undefined;
	}

	const back = uiText("返回", "Back");
	const selection = await ctx.ui!.select!(uiText("禁用 MCP server", "Disable MCP Server"), [...options, back]);
	return selection && selection !== back ? `disable ${selection}` : undefined;
}

function formatMcpMenuTitle(state: McpCommandState): string {
	return uiText(
		`MCP(已连接 ${countConnectedServers(state)} 个 server,模式: ${state.permissionState.mode})`,
		`MCP(connected servers: ${countConnectedServers(state)}, mode: ${state.permissionState.mode})`,
	);
}

function disableServer(pi: ExtensionAPI, state: McpCommandState, serverName?: string): string {
	if (!serverName) {
		return uiText("缺少 server。用法: /mcp disable <server>", "Missing server. Usage: /mcp disable <server>");
	}

	const tools = state.serverTools.get(serverName);
	if (!tools) {
		return uiText(`MCP server "${serverName}" 未找到。`, `MCP server "${serverName}" not found.`);
	}

	removeActiveTools(pi, tools);
	return uiText(`MCP server "${serverName}" 已禁用(已从 active tools 移除 ${tools.length} 个工具)。`, `MCP server "${serverName}" disabled (${tools.length} tools removed from active tools).`);
}

function enableServer(pi: ExtensionAPI, state: McpCommandState, serverName?: string): string {
	if (!serverName) {
		return uiText("缺少 server。用法: /mcp enable <server>", "Missing server. Usage: /mcp enable <server>");
	}

	if (state.staleServerTools?.has(serverName)) {
		return uiText(`MCP server "${serverName}" 已过期(重载时断开)。请运行 /mcp reload 重新连接,或先修复配置。`, `MCP server "${serverName}" is stale (disconnected during reload). Run /mcp reload to reconnect, or fix the config first.`);
	}

	const tools = state.serverTools.get(serverName);
	if (!tools) {
		return uiText(`MCP server "${serverName}" 未找到。`, `MCP server "${serverName}" not found.`);
	}

	const active = new Set(getActiveTools(pi));
	for (const tool of tools) {
		active.add(tool);
	}
	pi.setActiveTools(Array.from(active));
	return uiText(`MCP server "${serverName}" 已启用(${tools.length} 个工具已激活)。`, `MCP server "${serverName}" enabled (${tools.length} tools activated).`);
}

async function reloadMcp(
	pi: ExtensionAPI,
	state: McpCommandState,
	deps: McpCommandDeps,
	context: CommandContext,
): Promise<string> {
	const previousTools = new Map(state.serverTools);
	await state.registry.disconnectAll();

	const result = deps.reload ? await deps.reload(context) : {};
	const connections = result.connections ?? [];
	let registration: McpToolRegistrationResult | undefined;
	if (connections.length > 0 && !result.registered) {
		registration = (deps.registerMcpTools ?? registerMcpTools)(pi, connections);
	}

	const nextServerTools = result.registered
		? normalizeServerTools(result.registered)
		: registration
			? new Map(registration.registeredByServer)
		: serverToolsFromConnections(connections);

	state.serverTools.clear();
	for (const [serverName, tools] of nextServerTools) {
		state.serverTools.set(serverName, tools);
	}

	state.failedServers = result.failed ?? new Map();
	state.warnings = result.warnings ?? [];
	state.staleServerTools ??= new Map();
	for (const serverName of nextServerTools.keys()) {
		state.staleServerTools.delete(serverName);
	}

	const nextTools = new Set(Array.from(nextServerTools.values()).flat());
	const staleTools: string[] = [];
	for (const [serverName, tools] of previousTools) {
		const removedTools = tools.filter((tool) => !nextTools.has(tool));
		if (nextServerTools.has(serverName) && removedTools.length === 0) {
			state.staleServerTools.delete(serverName);
			continue;
		}

		state.staleServerTools.set(serverName, removedTools.length > 0 ? removedTools : tools);
		staleTools.push(...removedTools.length > 0 ? removedTools : tools);
	}

	removeActiveTools(pi, staleTools);
	return uiText(
		`MCP 重载完成。已连接: ${connections.length},工具: ${countTools(nextServerTools)},失败: ${countFailed(state.failedServers)},过期: ${state.staleServerTools.size}`,
		`MCP reload complete. Connected: ${connections.length}, tools: ${countTools(nextServerTools)}, failed: ${countFailed(state.failedServers)}, stale: ${state.staleServerTools.size}`,
	);
}

function serverToolsFromConnections(connections: McpConnection[]): Map<string, string[]> {
	const normalizedServers = resolveNormalizedServerNames(connections.map((connection) => connection.name));
	const serverTools = new Map<string, string[]>();

	for (const connection of connections) {
		const serverName = normalizedServers.names.get(connection.name) ?? connection.name;
		serverTools.set(
			connection.name,
			connection.tools.map((tool) => buildToolName(serverName, normalizeToolName(tool.name))),
		);
	}

	return serverTools;
}

function normalizeServerTools(registered: NonNullable<McpReloadResult["registered"]>): Map<string, string[]> {
	return new Map(registered);
}

function removeActiveTools(pi: ExtensionAPI, tools: string[]): void {
	if (tools.length === 0) {
		return;
	}

	const disabled = new Set(tools);
	pi.setActiveTools(getActiveTools(pi).filter((tool) => !disabled.has(tool)));
}

export function getActiveTools(pi: ExtensionAPI): string[] {
	return typeof pi.getActiveTools === "function" ? pi.getActiveTools() : [];
}

function isPermissionMode(value: string): value is McpPermissionMode {
	return value === "on" || value === "off" || value === "ask";
}

function countTools(serverTools: Map<string, string[]>): number {
	return Array.from(serverTools.values()).reduce((sum, tools) => sum + tools.length, 0);
}

function countConnectedServers(state: McpCommandState): number {
	return Array.from(state.registry.connections.values()).filter((connection) => connection.status === "connected").length;
}

function countFailed(failedServers: McpCommandState["failedServers"]): number {
	if (!failedServers) {
		return 0;
	}
	return failedServers.size;
}

function notify(context: CommandContext, message: string): void {
	context.ui?.notify?.(message);
}
