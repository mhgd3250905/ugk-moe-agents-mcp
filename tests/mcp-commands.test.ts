import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { registerMcpCommand, type McpCommandState } from "../extensions/mcp/commands.ts";
import { formatMcpStatus } from "../extensions/mcp/formatter.ts";
import { createMcpPermissionState } from "../extensions/mcp/permissions.ts";
import { createMcpToolDefinition } from "../extensions/mcp/tools.ts";

function makePi(initialTools: string[] = []) {
	const commands = new Map<string, { handler: Function }>();
	const registeredTools = new Map<string, any>();
	let activeTools = [...initialTools];
	const setActiveToolsCalls: string[][] = [];

	const pi = {
		commands,
		registeredTools,
		setActiveToolsCalls,
		registerCommand(name: string, options: { handler: Function }) {
			commands.set(name, options);
		},
		registerTool(tool: any) {
			registeredTools.set(tool.name, tool);
		},
		getActiveTools() {
			return [...activeTools];
		},
		setActiveTools(names: string[]) {
			activeTools = [...names];
			setActiveToolsCalls.push([...names]);
		},
	};

	return pi;
}

function makeState(overrides: Partial<McpCommandState> = {}): McpCommandState {
	return {
		registry: {
			connections: new Map(),
			async disconnectAll() {},
		},
		permissionState: createMcpPermissionState("ask"),
		serverTools: new Map(),
		failedServers: new Map(),
		warnings: [],
		staleServerTools: new Map(),
		...overrides,
	};
}

async function runMcp(
	pi: ReturnType<typeof makePi>,
	args: string,
	context: any = {},
): Promise<{ notifications: string[] }> {
	const notifications: string[] = [];
	await pi.commands.get("mcp")!.handler(args, {
		...context,
		ui: {
			...context.ui,
			notify(message: string) {
				notifications.push(message);
				context.ui?.notify?.(message);
			},
		},
	});
	return { notifications };
}

test("/mcp status renders connected servers, tool count, mode, and failed servers", async () => {
	const state = makeState({
		registry: {
			connections: new Map([
				["alpha", { name: "alpha", status: "connected", tools: [{ name: "echo" }] }],
			]) as any,
			async disconnectAll() {},
		},
		serverTools: new Map([["alpha", ["alpha__echo"]]]),
		failedServers: new Map([["beta", "spawn failed"]]),
	});
	const pi = makePi();
	registerMcpCommand(pi as any, state);

	const directText = formatMcpStatus(state);
	assert.match(directText, /已连接 server/);
	assert.match(directText, /工具/);
	assert.match(directText, /权限模式/);
	assert.match(directText, /失败 server/);
	assert.match(directText, /alpha/);
	assert.match(directText, /beta/);

	const { notifications } = await runMcp(pi, "status");
	assert.equal(notifications.length, 1);
	assert.match(notifications[0], /已连接 server/);
	assert.match(notifications[0], /工具/);
	assert.match(notifications[0], /权限模式/);
	assert.match(notifications[0], /失败 server/);
});

test("/mcp on off ask switches permission mode", async () => {
	const state = makeState();
	const pi = makePi();
	registerMcpCommand(pi as any, state);

	await runMcp(pi, "on");
	assert.equal(state.permissionState.mode, "on");

	await runMcp(pi, "off");
	assert.equal(state.permissionState.mode, "off");

	await runMcp(pi, "ask");
	assert.equal(state.permissionState.mode, "ask");
});

test("/mcp with no args opens the main menu and reuses existing dispatch", async () => {
	const state = makeState({
		registry: {
			connections: new Map([
				["alpha", { name: "alpha", status: "connected", tools: [] }],
				["beta", { name: "beta", status: "connected", tools: [] }],
				["down", { name: "down", status: "disconnected", tools: [] }],
			]) as any,
			async disconnectAll() {},
		},
	});
	const pi = makePi();
	registerMcpCommand(pi as any, state);
	const selectCalls: Array<{ title: string; options: string[] }> = [];

	await runMcp(pi, "", {
		ui: {
			async select(title: string, options: string[]) {
				selectCalls.push({ title, options });
				return selectCalls.length === 1 ? "⚙️ 切换权限模式" : "on";
			},
		},
	});

	assert.equal(selectCalls[0].title, "MCP(已连接 2 个 server,模式: ask)");
	assert.deepEqual(selectCalls[0].options, [
		"📊 查看状态",
		"🔄 重载所有 server",
		"⚙️ 切换权限模式",
		"✅ 启用 server",
		"⛔ 禁用 server",
		"退出",
	]);
	assert.equal(selectCalls[1].title, "切换 MCP 权限模式");
	assert.equal(state.permissionState.mode, "on");
});

test("/mcp menu and status follow UI language", async () => {
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "ugk-mcp-language-"));
	fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ uiLanguage: "en-US" }));
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		const state = makeState({
			registry: {
				connections: new Map([
					["alpha", { name: "alpha", status: "connected", tools: [] }],
				]) as any,
				async disconnectAll() {},
			},
		});
		const pi = makePi();
		registerMcpCommand(pi as any, state);
		const selectCalls: Array<{ title: string; options: string[] }> = [];

		await runMcp(pi, "", {
			ui: {
				async select(title: string, options: string[]) {
					selectCalls.push({ title, options });
					return "Status";
				},
			},
		});

		assert.equal(selectCalls[0].title, "MCP(connected servers: 1, mode: ask)");
		assert.deepEqual(selectCalls[0].options, [
			"📊 Status",
			"🔄 Reload all servers",
			"⚙️ Switch permission mode",
			"✅ Enable server",
			"⛔ Disable server",
			"Exit",
		]);
		assert.match(formatMcpStatus(state), /MCP Status/);
		assert.match(formatMcpStatus(state), /Connected servers/);
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		fs.rmSync(agentDir, { recursive: true, force: true });
	}
});

test("/mcp with no args falls back to status when select UI is unavailable", async () => {
	const state = makeState({
		registry: {
			connections: new Map([
				["alpha", { name: "alpha", status: "connected", tools: [{ name: "echo" }] }],
			]) as any,
			async disconnectAll() {},
		},
		serverTools: new Map([["alpha", ["alpha__echo"]]]),
	});
	const pi = makePi();
	registerMcpCommand(pi as any, state);

	const { notifications } = await runMcp(pi, "");

	assert.equal(notifications.length, 1);
	assert.match(notifications[0], /alpha/);
});

test("/mcp enable menu lists inactive and stale servers", async () => {
	const state = makeState({
		serverTools: new Map([
			["alpha", ["alpha__echo"]],
			["beta", ["beta__read"]],
		]),
		staleServerTools: new Map([["gone", ["gone__old"]]]),
	});
	const pi = makePi(["alpha__echo"]);
	registerMcpCommand(pi as any, state);
	const selectCalls: Array<{ title: string; options: string[] }> = [];

	const { notifications } = await runMcp(pi, "", {
		ui: {
			async select(title: string, options: string[]) {
				selectCalls.push({ title, options });
				return selectCalls.length === 1 ? "✅ 启用 server" : "gone (stale)";
			},
		},
	});

	assert.deepEqual(selectCalls[1].options, ["beta", "gone (stale)", "返回"]);
	assert.match(notifications.join("\n"), /过期/);
});

test("/mcp disable menu lists active MCP servers only", async () => {
	const state = makeState({
		serverTools: new Map([
			["alpha", ["alpha__echo"]],
			["beta", ["beta__read"]],
		]),
	});
	const pi = makePi(["local_tool", "alpha__echo"]);
	registerMcpCommand(pi as any, state);
	const selectCalls: Array<{ title: string; options: string[] }> = [];

	await runMcp(pi, "", {
		ui: {
			async select(title: string, options: string[]) {
				selectCalls.push({ title, options });
				return selectCalls.length === 1 ? "⛔ 禁用 server" : "alpha";
			},
		},
	});

	assert.deepEqual(selectCalls[1].options, ["alpha", "返回"]);
	assert.deepEqual(pi.setActiveToolsCalls.at(-1), ["local_tool"]);
});

test("/mcp enable and disable menus notify when no server is available", async () => {
	const state = makeState({
		serverTools: new Map([["alpha", ["alpha__echo"]]]),
	});
	const pi = makePi(["alpha__echo"]);
	registerMcpCommand(pi as any, state);

	const enable = await runMcp(pi, "", {
		ui: {
			async select() {
				return "✅ 启用 server";
			},
		},
	});
	const piWithoutActiveServers = makePi();
	registerMcpCommand(piWithoutActiveServers as any, state);
	const disable = await runMcp(piWithoutActiveServers, "", {
		ui: {
			async select() {
				return "⛔ 禁用 server";
			},
		},
	});

	assert.match(enable.notifications.join("\n"), /没有可启用的 server/);
	assert.match(disable.notifications.join("\n"), /没有可禁用的 server/);
});

test("/mcp disable removes only that server's tools and preserves non-MCP tools", async () => {
	const state = makeState({
		serverTools: new Map([
			["alpha", ["alpha__echo", "alpha__sum"]],
			["beta", ["beta__read"]],
		]),
	});
	const pi = makePi(["local_tool", "alpha__echo", "beta__read", "alpha__sum"]);
	registerMcpCommand(pi as any, state);

	await runMcp(pi, "disable alpha");

	assert.deepEqual(pi.setActiveToolsCalls.at(-1), ["local_tool", "beta__read"]);
});

test("/mcp enable adds that server's tools without duplicates", async () => {
	const state = makeState({
		serverTools: new Map([["alpha", ["alpha__echo", "alpha__sum"]]]),
	});
	const pi = makePi(["local_tool", "alpha__echo"]);
	registerMcpCommand(pi as any, state);

	await runMcp(pi, "enable alpha");

	assert.deepEqual(pi.setActiveToolsCalls.at(-1), ["local_tool", "alpha__echo", "alpha__sum"]);
});

test("/mcp enable reports stale servers separately from missing servers", async () => {
	const state = makeState({
		staleServerTools: new Map([["beta", ["beta__read"]]]),
	});
	const pi = makePi();
	registerMcpCommand(pi as any, state);

	const stale = await runMcp(pi, "enable beta");
	const missing = await runMcp(pi, "enable missing");

	assert.match(stale.notifications.join("\n"), /过期/);
	assert.doesNotMatch(stale.notifications.join("\n"), /not found/i);
	assert.match(missing.notifications.join("\n"), /未找到/);
});

test("/mcp reload disconnects, invokes reload, registers new tools, and updates state", async () => {
	let disconnected = false;
	let reloadCalled = 0;
	const state = makeState({
		registry: {
			connections: new Map([["alpha", { name: "alpha", status: "connected", tools: [] }]]) as any,
			async disconnectAll() {
				disconnected = true;
			},
		},
		serverTools: new Map([["alpha", ["alpha__old"]]]),
	});
	const pi = makePi(["alpha__old"]);
	registerMcpCommand(pi as any, state, {
		async reload() {
			reloadCalled += 1;
			return {
				connections: [
					{ name: "alpha", status: "connected", tools: [{ name: "echo", inputSchema: { type: "object" } }] },
				] as any[],
			};
		},
	});

	await runMcp(pi, "reload");

	assert.equal(disconnected, true);
	assert.equal(reloadCalled, 1);
	assert.deepEqual(state.serverTools.get("alpha"), ["alpha__echo"]);
	assert.equal(pi.registeredTools.has("alpha__echo"), true);
});

test("/mcp reload uses pre-registered startup tools without duplicate registration warnings", async () => {
	let registerCalls = 0;
	const state = makeState({
		serverTools: new Map([["alpha", ["alpha__echo"]]]),
		warnings: [],
	});
	const pi = makePi(["alpha__echo"]);
	registerMcpCommand(pi as any, state, {
		async reload() {
			return {
				connections: [
					{ name: "alpha", status: "connected", tools: [{ name: "echo", inputSchema: { type: "object" } }] },
				] as any[],
				registered: new Map([["alpha", ["alpha__echo"]]]),
				warnings: [],
			};
		},
		registerMcpTools() {
			registerCalls += 1;
			return { registered: [], registeredByServer: new Map(), skipped: [], warnings: ["duplicate"] };
		},
	});

	await runMcp(pi, "reload");

	assert.equal(registerCalls, 0);
	assert.deepEqual(state.serverTools.get("alpha"), ["alpha__echo"]);
	assert.deepEqual(state.warnings, []);
});

test("/mcp reload removes vanished server tools from active set and never calls unregisterTool", async () => {
	const state = makeState({
		registry: {
			connections: new Map([["alpha", { name: "alpha", status: "connected", tools: [] }]]) as any,
			async disconnectAll() {},
		},
		serverTools: new Map([
			["alpha", ["alpha__echo"]],
			["beta", ["beta__read"]],
		]),
	});
	const pi = {
		...makePi(["local_tool", "alpha__echo", "beta__read"]),
		unregisterTool() {
			throw new Error("unregisterTool must not be called");
		},
	};
	registerMcpCommand(pi as any, state, {
		async reload() {
			return {
				connections: [
					{ name: "alpha", status: "connected", tools: [{ name: "new", inputSchema: { type: "object" } }] },
				] as any[],
			};
		},
	});

	await runMcp(pi as any, "reload");

	assert.deepEqual(pi.setActiveToolsCalls.at(-1), ["local_tool"]);
	assert.deepEqual(state.serverTools.get("alpha"), ["alpha__new"]);
	assert.equal(state.serverTools.has("beta"), false);
	assert.deepEqual(state.staleServerTools.get("beta"), ["beta__read"]);
});

test("/mcp reload clears stale marker when a vanished server returns", async () => {
	const state = makeState({
		registry: {
			connections: new Map([["alpha", { name: "alpha", status: "connected", tools: [] }]]) as any,
			async disconnectAll() {},
		},
		serverTools: new Map([["alpha", ["alpha__echo"]]]),
		staleServerTools: new Map([["beta", ["beta__read"]]]),
	});
	const pi = makePi(["local_tool", "alpha__echo"]);
	registerMcpCommand(pi as any, state, {
		async reload() {
			return {
				connections: [
					{ name: "alpha", status: "connected", tools: [{ name: "echo", inputSchema: { type: "object" } }] },
					{ name: "beta", status: "connected", tools: [{ name: "read", inputSchema: { type: "object" } }] },
				] as any[],
			};
		},
	});

	await runMcp(pi, "reload");

	assert.equal(state.staleServerTools.has("beta"), false);
	assert.doesNotMatch(formatMcpStatus(state), /过期 server:.*beta/i);
});

test("stale tool execution returns disconnected without reconnecting", async () => {
	let callAttempts = 0;
	let reconnectAttempts = 0;
	const connection = {
		name: "beta",
		status: "connected",
		tools: [{ name: "read", inputSchema: { type: "object" } }],
		async callTool() {
			callAttempts += 1;
			if (this.status !== "connected") {
				throw new Error('MCP server "beta" is disconnected; cannot call tool "read"');
			}
			return { content: [{ type: "text", text: "ok" }] };
		},
		async disconnect() {
			this.status = "disconnected";
		},
		async connect() {
			reconnectAttempts += 1;
		},
	};
	const definition = createMcpToolDefinition(connection as any, connection.tools[0] as any);
	const state = makeState({
		registry: {
			connections: new Map([["beta", connection]]) as any,
			async disconnectAll() {
				await connection.disconnect();
			},
		},
		serverTools: new Map([["beta", ["beta__read"]]]),
	});
	const pi = makePi(["beta__read"]);
	registerMcpCommand(pi as any, state, {
		async reload() {
			return { connections: [] };
		},
	});

	await runMcp(pi, "reload");
	await assert.rejects(
		() => definition.execute("call-1", {}, undefined, undefined, {}),
		/disconnected/i,
	);

	assert.equal(callAttempts, 1);
	assert.equal(reconnectAttempts, 0);
});

test("unknown command and missing server notify clearly without throwing", async () => {
	const state = makeState();
	const pi = makePi();
	registerMcpCommand(pi as any, state);

	const unknown = await runMcp(pi, "wat");
	assert.match(unknown.notifications.join("\n"), /unknown|未知/i);

	const missingDisable = await runMcp(pi, "disable missing");
	assert.match(missingDisable.notifications.join("\n"), /missing|not found|未找到|不存在/i);

	const missingEnable = await runMcp(pi, "enable");
	assert.match(missingEnable.notifications.join("\n"), /server|usage|用法|缺少/i);
});
