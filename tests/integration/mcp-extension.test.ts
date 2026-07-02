import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import registerUgkExtension from "../../extensions/index.ts";
import { registerMcp } from "../../extensions/mcp/index.ts";
import { loadMcpConfig } from "../../extensions/mcp/config.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const stubServerPath = path.join(__dirname, "..", "fixtures", "mcp-stub-server.mjs");
const isolatedUserConfigRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ugk-mcp-test-user-"));
const isolatedHome = path.join(isolatedUserConfigRoot, "home");

function makePi(initialTools: string[] = []) {
	const handlers = new Map<string, Function[]>();
	const commands = new Map<string, { handler: Function }>();
	const registeredTools = new Map<string, any>();
	let activeTools = [...initialTools];

	const pi = {
		handlers,
		commands,
		registeredTools,
		registerCommand(name: string, options: { handler: Function }) {
			commands.set(name, options);
		},
		registerTool(tool: any) {
			registeredTools.set(tool.name, tool);
			if (!activeTools.includes(tool.name)) {
				activeTools.push(tool.name);
			}
		},
		getActiveTools() {
			return [...activeTools];
		},
		setActiveTools(names: string[]) {
			activeTools = [...names];
		},
		on(eventName: string, handler: Function) {
			const existing = handlers.get(eventName) ?? [];
			existing.push(handler);
			handlers.set(eventName, existing);
		},
	};

	return pi;
}

async function emit(pi: ReturnType<typeof makePi>, eventName: string, event: any = {}, ctx: any = {}) {
	const results = [];
	for (const handler of pi.handlers.get(eventName) ?? []) {
		results.push(await handler(event, ctx));
	}
	return results;
}

function makeCtx(cwd: string, overrides: Record<string, unknown> = {}) {
	const notifications: string[] = [];
	const confirmations: string[] = [];
	return {
		cwd,
		hasUI: true,
		notifications,
		confirmations,
		ui: {
			notify(message: string) {
				notifications.push(message);
			},
			async confirm(title: string, body?: string) {
				confirmations.push([title, body].filter(Boolean).join("\n"));
				return true;
			},
		},
		...overrides,
	};
}

function writeProjectConfig(cwd: string, servers: Record<string, unknown>) {
	fs.writeFileSync(path.join(cwd, ".mcp.json"), JSON.stringify({ mcpServers: servers }, null, 2));
}

function registerMcpForTest(pi: ReturnType<typeof makePi>, deps: Parameters<typeof registerMcp>[1] = {}) {
	return registerMcp(pi as any, {
		...deps,
		loadConfig:
			deps.loadConfig ??
			((cwd) =>
				loadMcpConfig(cwd, {
					packageRoot: deps.packageRoot,
					platform: "win32",
					env: { APPDATA: isolatedUserConfigRoot },
					homedir: () => isolatedHome,
				})),
	});
}

function listNodeCommandLines() {
	if (process.platform !== "win32") {
		return execFileSync("ps", ["-eo", "pid,args"], { encoding: "utf8" });
	}

	return execFileSync(
		"powershell.exe",
		[
			"-NoProfile",
			"-Command",
			"Get-CimInstance Win32_Process -Filter \"Name = 'node.exe'\" | Select-Object -ExpandProperty CommandLine",
		],
		{ encoding: "utf8" },
	);
}

async function waitForNoProcess(commandLinePattern: RegExp) {
	for (let attempt = 0; attempt < 20; attempt += 1) {
		if (!commandLinePattern.test(listNodeCommandLines())) {
			return;
		}
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	assert.doesNotMatch(listNodeCommandLines(), commandLinePattern);
}

test("session_start connects configured MCP servers and registers tools", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "ugk-mcp-start-"));
	writeProjectConfig(cwd, {
		alpha: { command: process.execPath, args: [stubServerPath] },
	});
	const pi = makePi(["local_tool"]);
	const ctx = makeCtx(cwd);

	const state = registerMcpForTest(pi);
	await emit(pi, "session_start", { reason: "startup" }, ctx);

	assert.equal(pi.registeredTools.has("alpha__echo"), true);
	assert.equal(pi.registeredTools.has("alpha__sum"), true);
	assert.deepEqual(state.serverTools.get("alpha"), ["alpha__echo", "alpha__sum"]);
	assert.equal(state.failedServers?.size, 0);

	await emit(pi, "session_shutdown", { reason: "quit" }, ctx);
	await waitForNoProcess(/mcp-stub-server\.mjs/);
});

// ponytail: 锁死修复 —— resume/new/fork 也必须连 MCP(原白名单只含 startup/reload,
// 导致恢复会话/新建会话时 MCP 不加载,必须手动 /mcp reload)。
for (const reason of ["resume", "new", "fork"] as const) {
	test(`session_start with reason "${reason}" connects MCP servers (not just startup/reload)`, async () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), `ugk-mcp-${reason}-`));
		writeProjectConfig(cwd, {
			alpha: { command: process.execPath, args: [stubServerPath] },
		});
		const pi = makePi(["local_tool"]);
		const ctx = makeCtx(cwd);
		const state = registerMcpForTest(pi);

		await emit(pi, "session_start", { reason }, ctx);

		assert.equal(pi.registeredTools.has("alpha__echo"), true, `${reason} 应触发 MCP 连接`);
		assert.equal(state.failedServers?.size ?? 0, 0);

		await emit(pi, "session_shutdown", { reason: "quit" }, ctx);
		await waitForNoProcess(/mcp-stub-server\.mjs/);
	});
}

test("session_start loads install-scope MCP servers from the UGK package root", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "ugk-mcp-install-cwd-"));
	const packageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ugk-mcp-install-package-"));
	fs.writeFileSync(
		path.join(packageRoot, "mcp.json"),
		JSON.stringify({
			mcpServers: {
				packaged: { command: process.execPath, args: [stubServerPath] },
			},
		}),
	);
	const pi = makePi(["local_tool"]);
	const ctx = makeCtx(cwd, { hasUI: false, ui: undefined });

	const state = registerMcpForTest(pi, { packageRoot });
	await emit(pi, "session_start", { reason: "startup" }, ctx);

	assert.equal(pi.registeredTools.has("packaged__echo"), true);
	assert.deepEqual(state.serverTools.get("packaged"), ["packaged__echo", "packaged__sum"]);
	assert.equal(state.failedServers?.size, 0);

	await emit(pi, "session_shutdown", { reason: "quit" }, ctx);
	await waitForNoProcess(/mcp-stub-server\.mjs/);
});

test("no MCP config has zero side effects", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "ugk-mcp-empty-"));
	const pi = makePi(["local_tool"]);
	const ctx = makeCtx(cwd);

	registerMcpForTest(pi);
	await emit(pi, "session_start", { reason: "startup" }, ctx);

	assert.equal(pi.registeredTools.size, 0);
	assert.deepEqual(pi.getActiveTools(), ["local_tool"]);
});

test("session_shutdown disconnects all registry connections", async () => {
	let disconnects = 0;
	const registry = {
		connections: new Map(),
		async connect() {
			return { name: "alpha", status: "connected", tools: [] };
		},
		async disconnectAll() {
			disconnects += 1;
		},
	};
	const pi = makePi();
	const ctx = makeCtx(process.cwd());
	registerMcpForTest(pi, {
		registry: registry as any,
		loadConfig: () => ({
			servers: new Map([["alpha", { name: "alpha", scope: "user", config: { command: "node" } }]]),
			errors: [],
		}),
	});

	await emit(pi, "session_start", { reason: "startup" }, ctx);
	await emit(pi, "session_shutdown", { reason: "quit" }, ctx);
	await emit(pi, "session_shutdown", { reason: "quit" }, ctx);

	assert.equal(disconnects, 2);
});

test("reload re-registers prior MCP tool names without duplicate warnings", async () => {
	let generation = 0;
	const registry = {
		connections: new Map(),
		async connect(name: string) {
			generation += 1;
			const connection = {
				name,
				status: "connected",
				tools: [{ name: "echo", inputSchema: { type: "object" } }],
				async callTool() {
					return { content: [{ type: "text", text: `generation:${generation}` }] };
				},
			};
			this.connections.set(name, connection);
			return connection;
		},
		async disconnectAll() {
			this.connections.clear();
		},
	};
	const pi = makePi(["local_tool"]);
	const ctx = makeCtx(process.cwd());
	const state = registerMcpForTest(pi, {
		registry: registry as any,
		loadConfig: () => ({
			servers: new Map([["alpha", { name: "alpha", scope: "user", config: { command: "node" } }]]),
			errors: [],
		}),
	});

	await emit(pi, "session_start", { reason: "startup" }, ctx);
	await pi.commands.get("mcp")!.handler("reload", ctx);
	const result = await pi.registeredTools.get("alpha__echo").execute("call-1", {}, undefined, undefined, ctx);

	assert.equal(state.warnings?.length, 0);
	assert.deepEqual(state.serverTools.get("alpha"), ["alpha__echo"]);
	assert.deepEqual(result.content, [{ type: "text", text: "generation:2" }]);
});

test("session_start does not track MCP tools skipped by non-MCP collisions", async () => {
	const registry = {
		connections: new Map(),
		async connect(name: string) {
			const connection = {
				name,
				status: "connected",
				tools: [{ name: "echo", inputSchema: { type: "object" } }],
				async callTool() {
					return { content: [{ type: "text", text: "mcp" }] };
				},
			};
			this.connections.set(name, connection);
			return connection;
		},
		async disconnectAll() {
			this.connections.clear();
		},
	};
	const pi = makePi(["alpha__echo"]);
	const ctx = makeCtx(process.cwd());
	const state = registerMcpForTest(pi, {
		registry: registry as any,
		loadConfig: () => ({
			servers: new Map([["alpha", { name: "alpha", scope: "user", config: { command: "node" } }]]),
			errors: [],
		}),
	});

	await emit(pi, "session_start", { reason: "startup" }, ctx);
	await pi.commands.get("mcp")!.handler("disable alpha", ctx);

	assert.equal(pi.registeredTools.has("alpha__echo"), false);
	assert.deepEqual(state.serverTools.get("alpha"), []);
	assert.deepEqual(pi.getActiveTools(), ["alpha__echo"]);
	assert.match(state.warnings.join("\n"), /already registered/);
});

test("before_agent_start omits instructions from disconnected stale servers after reload", async () => {
	let phase = "initial";
	const registry = {
		connections: new Map(),
		async connect(name: string) {
			const connection = {
				name,
				status: "connected",
				tools: [{ name: "echo", inputSchema: { type: "object" } }],
				client: {
					getInstructions() {
						return `${name} instructions`;
					},
				},
				async callTool() {
					return { content: [{ type: "text", text: "ok" }] };
				},
				async disconnect() {
					this.status = "disconnected";
				},
			};
			this.connections.set(name, connection);
			return connection;
		},
		async disconnectAll() {
			await Promise.all(Array.from(this.connections.values(), (connection: any) => connection.disconnect()));
		},
	};
	const pi = makePi(["local_tool"]);
	const ctx = makeCtx(process.cwd());
	registerMcpForTest(pi, {
		registry: registry as any,
		loadConfig: () => ({
			servers:
				phase === "initial"
					? new Map([["beta", { name: "beta", scope: "user", config: { command: "node" } }]])
					: new Map(),
			errors: [],
		}),
	});

	await emit(pi, "session_start", { reason: "startup" }, ctx);
	phase = "empty";
	await pi.commands.get("mcp")!.handler("reload", ctx);
	const injected = (await emit(pi, "before_agent_start", { systemPrompt: "Base prompt" }, ctx)).at(-1);

	assert.equal(injected, undefined);
});

test("process cleanup waits for async registry disconnect", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "ugk-mcp-signal-cleanup-"));
	const marker = path.join(cwd, "disconnect-marker.txt");
	const registry = {
		connections: new Map(),
		async disconnectAll() {
			await new Promise((resolve) => setTimeout(resolve, 100));
			fs.writeFileSync(marker, "disconnected");
		},
	};
	const pi = makePi();
	const beforeExitListeners = process.listenerCount("beforeExit");
	registerMcpForTest(pi, {
		registry: registry as any,
		loadConfig: () => ({ servers: new Map(), errors: [] }),
	});
	const mcpModule = await import("../../extensions/mcp/index.ts");

	assert.equal(typeof mcpModule.disconnectMcpCleanupRegistries, "function");
	assert.ok(process.listenerCount("beforeExit") >= beforeExitListeners);
	await mcpModule.disconnectMcpCleanupRegistries();

	assert.equal(fs.readFileSync(marker, "utf8"), "disconnected");
});

test("before_agent_start appends MCP server instructions", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "ugk-mcp-instructions-"));
	writeProjectConfig(cwd, {
		alpha: { command: process.execPath, args: [stubServerPath] },
	});
	const pi = makePi();
	const ctx = makeCtx(cwd);

	registerMcpForTest(pi);
	await emit(pi, "session_start", { reason: "startup" }, ctx);
	const injected = (await emit(pi, "before_agent_start", { systemPrompt: "Base prompt" }, ctx)).at(-1);

	assert.match(injected.systemPrompt, /Base prompt/);
	assert.match(injected.systemPrompt, /MCP server instructions/);
	assert.match(injected.systemPrompt, /alpha/);
	assert.match(injected.systemPrompt, /Use echo for test messages/);

	await emit(pi, "session_shutdown", { reason: "quit" }, ctx);
});

test("end-to-end registered MCP tool calls the stub server", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "ugk-mcp-e2e-"));
	writeProjectConfig(cwd, {
		alpha: { command: process.execPath, args: [stubServerPath] },
	});
	const pi = makePi();
	const ctx = makeCtx(cwd);

	registerMcpForTest(pi);
	await emit(pi, "session_start", { reason: "startup" }, ctx);

	const echo = pi.registeredTools.get("alpha__echo");
	const result = await echo.execute("call-1", { message: "hello" }, undefined, undefined, ctx);

	assert.deepEqual(result.content, [{ type: "text", text: "echo:hello" }]);

	await emit(pi, "session_shutdown", { reason: "quit" }, ctx);
	await waitForNoProcess(/mcp-stub-server\.mjs/);
});

test("root extension wires MCP command, hooks, and guided doctor entrypoint", async () => {
	const pi = {
		...makePi(),
		registerFlag() {},
		registerShortcut() {},
		getFlag() {
			return undefined;
		},
		getSessionName() {
			return "demo";
		},
	};

	registerUgkExtension(pi as any);

	assert.equal(pi.commands.has("mcp"), true);
	assert.ok((pi.handlers.get("session_start") ?? []).length >= 1);
	assert.ok((pi.handlers.get("session_shutdown") ?? []).length >= 1);
	assert.ok((pi.handlers.get("before_agent_start") ?? []).length >= 1);

	const notifications: string[] = [];
	await pi.commands.get("doctor")!.handler("", {
		ui: {
			notify(message: string) {
				notifications.push(message);
			},
		},
	});
	assert.match(notifications.join("\n"), /UGK Environment Doctor/);
	assert.match(notifications.join("\n"), /MCP/);
	assert.doesNotMatch(notifications.join("\n"), /configured: \d+/);
});

test("/mcp reload treats command contexts with confirm UI as interactive even without hasUI", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "ugk-mcp-reload-ui-"));
	fs.writeFileSync(
		path.join(cwd, ".mcp.local.json"),
		JSON.stringify({
			mcpServers: {
				alpha: { command: process.execPath, args: [stubServerPath] },
			},
		}),
	);
	const pi = makePi(["local_tool"]);
	const notifications: string[] = [];
	let confirmations = 0;

	registerMcpForTest(pi);
	await pi.commands.get("mcp")!.handler("reload", {
		cwd,
		hasUI: false,
		ui: {
			notify(message: string) {
				notifications.push(message);
			},
			async confirm() {
				confirmations += 1;
				return true;
			},
		},
	});

	assert.equal(confirmations, 1);
	assert.equal(pi.registeredTools.has("alpha__echo"), true);
	assert.match(notifications.join("\n"), /已连接: 1/);

	await emit(pi, "session_shutdown", { reason: "quit" }, { cwd });
	await waitForNoProcess(/mcp-stub-server\.mjs/);
});

test("MCP confirmation prompts follow UI language", async () => {
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "ugk-mcp-language-confirm-"));
	fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ uiLanguage: "en-US" }));
	process.env.PI_CODING_AGENT_DIR = agentDir;
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "ugk-mcp-confirm-language-"));
	writeProjectConfig(cwd, {
		alpha: { command: process.execPath, args: [stubServerPath] },
	});
	const pi = makePi();
	const selections: Array<{ title: string; options: string[] }> = [];
	const ctx = {
		cwd,
		hasUI: true,
		ui: {
			async select(title: string, options: string[]) {
				selections.push({ title, options });
				return options[0];
			},
			notify() {},
		},
	};

	try {
		registerMcpForTest(pi);
		await emit(pi, "session_start", { reason: "startup" }, ctx);
		assert.match(selections[0].title, /Allow MCP server/);
		assert.deepEqual(selections[0].options, ["Allow", "Deny"]);

		const echo = pi.registeredTools.get("alpha__echo");
		await echo.execute("call-1", { message: "hello" }, undefined, undefined, ctx);
		assert.match(selections[1].title, /Allow MCP tool/);
		assert.deepEqual(selections[1].options, ["Allow once", "Allow for session", "Deny"]);

		await emit(pi, "session_shutdown", { reason: "quit" }, ctx);
		await waitForNoProcess(/mcp-stub-server\.mjs/);
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		fs.rmSync(agentDir, { recursive: true, force: true });
	}
});

test("/mcp reload without confirm or select still fail-closes project scope servers", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "ugk-mcp-reload-no-ui-"));
	writeProjectConfig(cwd, {
		alpha: { command: process.execPath, args: [stubServerPath] },
	});
	const pi = makePi(["local_tool"]);
	const notifications: string[] = [];
	const state = registerMcpForTest(pi);

	await pi.commands.get("mcp")!.handler("reload", {
		cwd,
		ui: {
			notify(message: string) {
				notifications.push(message);
			},
		},
	});

	assert.equal(pi.registeredTools.has("alpha__echo"), false);
	assert.match(state.failedServers?.get("alpha") ?? "", /blocked by spawn policy/i);
	assert.match(notifications.join("\n"), /失败: 1/);
	await waitForNoProcess(/mcp-stub-server\.mjs/);
});
