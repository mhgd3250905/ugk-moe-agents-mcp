/**
 * S1 fix regression test: entering and exiting plan mode must preserve
 * dynamically registered tools (e.g. MCP tools), not clobber them with
 * a hardcoded NORMAL_MODE_TOOLS list.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import planModeExtension from "../extensions/plan-mode.ts";

type MockPi = {
	commands: Map<string, { handler: (args: string, ctx: any) => Promise<void> }>;
	activeTools: string[];
} & ExtensionAPI;

function createMockPi(initialTools: string[]): MockPi {
	let activeTools = [...initialTools];
	const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
	return {
		commands,
		activeTools,
		on(event: string, handler: any) {
			// Capture agent_end so tests can drive the execute->complete flow.
			if (event === "agent_end") {
				(this as any)._agentEndHandler = handler;
			}
		},
		registerFlag() {},
		getFlag: () => false,
		registerShortcut() {},
		registerCommand(name, options) {
			commands.set(name, { handler: options.handler as any });
		},
		registerTool() {},
		getActiveTools: () => [...activeTools],
		setActiveTools(names) {
			activeTools = [...names];
		},
	} as any;
}

test("plan mode toggle preserves MCP/dynamic tools on exit", async () => {
	// Simulate a session where MCP tools are already active.
	const initialTools = ["read", "bash", "edit", "write", "mcp__github__search", "mcp__fs__read_file"];
	const pi = createMockPi(initialTools);
	planModeExtension(pi);

	const planCommand = (pi as any).commands.get("plan");
	assert.ok(planCommand, "/plan command should be registered");

	// Minimal ctx stub: ui.notify + setStatus + setWidget + theme + sessionManager + appendEntry
	const noop = () => {};
	const ctx: any = {
		hasUI: true,
		cwd: process.cwd(),
		ui: {
			notify: noop,
			setStatus: noop,
			setWidget: noop,
			theme: { fg: (s: string) => s, strikethrough: (s: string) => s },
		},
		sessionManager: { getEntries: () => [] },
	};

	// Enter plan mode: tools become PLAN_MODE_TOOLS.
	await planCommand.handler("", ctx);
	assert.deepEqual(
		pi.getActiveTools().sort(),
		["read", "bash", "grep", "find", "ls", "questionnaire"].sort(),
		"entering plan mode should restrict tools",
	);

	// Exit plan mode: MCP tools must be restored, not just NORMAL_MODE_TOOLS.
	await planCommand.handler("", ctx);
	assert.deepEqual(
		pi.getActiveTools().sort(),
		initialTools.sort(),
		"exiting plan mode must restore the original tool set incl. MCP/dynamic tools",
	);
});

test("plan mode toggle notification follows UI language", async () => {
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "ugk-plan-language-"));
	fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ uiLanguage: "en-US" }));
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		const pi = createMockPi(["read", "bash", "edit", "write"]);
		planModeExtension(pi);
		const notifications: string[] = [];
		const ctx: any = {
			hasUI: true,
			cwd: process.cwd(),
			ui: {
				notify: (message: string) => notifications.push(message),
				setStatus: () => {},
				setWidget: () => {},
				theme: { fg: (_color: string, text: string) => text, strikethrough: (s: string) => s },
			},
			sessionManager: { getEntries: () => [] },
		};

		await (pi as any).commands.get("plan").handler("", ctx);

		assert.match(notifications.join("\n"), /Plan mode enabled/);
		assert.doesNotMatch(notifications.join("\n"), /已开启/);
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		fs.rmSync(agentDir, { recursive: true, force: true });
	}
});

test("plan mode toggle without getActiveTools falls back to normal tools", async () => {
	// Edge case: if getActiveTools is unavailable, exit should use NORMAL_MODE_TOOLS fallback.
	const pi = createMockPi(["read", "bash"]);
	// Simulate missing getActiveTools on the live pi (togglePlanMode captures snapshot first).
	const liveActiveTools: string[] = [...(pi as any).activeTools];
	(pi as any).getActiveTools = undefined;
	// Redirect setActiveTools into a readable sink for assertion (no getActiveTools available).
	(pi as any).setActiveTools = (names: string[]) => {
		liveActiveTools.length = 0;
		liveActiveTools.push(...names);
	};

	planModeExtension(pi);
	const planCommand = (pi as any).commands.get("plan");
	const noop = () => {};
	const ctx: any = {
		hasUI: true,
		cwd: process.cwd(),
		ui: { notify: noop, setStatus: noop, setWidget: noop, theme: { fg: (s: string) => s } },
		sessionManager: { getEntries: () => [] },
	};

	// Enter then exit.
	await planCommand.handler("", ctx);
	await planCommand.handler("", ctx);
	// With no snapshot captured, fallback should be the normal 4 tools.
	assert.deepEqual(
		liveActiveTools.sort(),
		["read", "bash", "edit", "write"].sort(),
		"without snapshot, exit should fall back to NORMAL_MODE_TOOLS",
	);
});

test("plan execute -> complete restores MCP tools (S1 completeExecution path)", async () => {
	const initialTools = ["read", "bash", "edit", "write", "mcp__github__search"];
	const pi = createMockPi(initialTools);
	planModeExtension(pi);

	const planCommand = (pi as any).commands.get("plan");
	const noop = () => {};
	const ctx: any = {
		hasUI: true,
		cwd: process.cwd(),
		ui: {
			notify: noop,
			setStatus: noop,
			setWidget: noop,
			select: async () => "执行计划",
			theme: { fg: (s: string) => s, strikethrough: (s: string) => s },
		},
		sessionManager: { getEntries: () => [] },
	};
	(pi as any).sendMessage = noop;
	(pi as any).appendEntry = noop;

	// 1. Enter plan mode.
	await planCommand.handler("", ctx);
	assert.deepEqual(pi.getActiveTools().sort(), ["read", "bash", "grep", "find", "ls", "questionnaire"].sort());

	// 2. Trigger agent_end with a plan-shaped assistant message so todos get extracted,
	//    then the handler offers "执行计划" (ctx.ui.select returns Execute) -> startExecution.
	const agentEndHandler = (pi as any)._agentEndHandler;
	assert.ok(agentEndHandler, "agent_end handler should be registered");
	const planMessage = { role: "assistant", content: [{ type: "text", text: "Plan:\n1. Do thing one\n2. Do thing two" }] };
	await agentEndHandler({ messages: [planMessage] }, ctx);
	// After startExecution, tools should be restored (MCP back) but snapshot retained for complete.
	assert.deepEqual(
		pi.getActiveTools().sort(),
		initialTools.sort(),
		"startExecution should restore MCP tools",
	);

	// 3. Trigger agent_end again with [DONE:1] [DONE:2] marking all todos complete -> completeExecution.
	const doneMessage = { role: "assistant", content: [{ type: "text", text: "Done both. [DONE:1] [DONE:2]" }] };
	await agentEndHandler({ messages: [doneMessage] }, ctx);
	assert.deepEqual(
		pi.getActiveTools().sort(),
		initialTools.sort(),
		"MCP tools must survive the execute->complete flow (S1 completeExecution path)",
	);
});
