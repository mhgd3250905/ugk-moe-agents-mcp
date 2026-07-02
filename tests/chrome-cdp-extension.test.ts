import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { registerChromeCdp } from "../extensions/chrome-cdp/index.ts";

const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
const previousCdpPort = process.env.UGK_CDP_PORT;
const testAgentDir = mkdtempSync(path.join(os.tmpdir(), "ugk-cdp-extension-agent-"));
process.env.PI_CODING_AGENT_DIR = testAgentDir;
process.on("exit", () => {
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	if (previousCdpPort === undefined) delete process.env.UGK_CDP_PORT;
	else process.env.UGK_CDP_PORT = previousCdpPort;
	rmSync(testAgentDir, { recursive: true, force: true });
});

function makePi() {
	delete process.env.UGK_CDP_PORT;
	rmSync(path.join(testAgentDir, "settings.json"), { force: true });
	const tools = new Map<string, any>();
	const commands = new Map<string, any>();
	return {
		tools,
		commands,
		pi: {
			registerTool(tool: any) {
				tools.set(tool.name, tool);
			},
			registerCommand(name: string, options: any) {
				commands.set(name, options);
			},
		},
	};
}

function makeCtx(confirmResult: boolean | string = true) {
	const notifications: string[] = [];
	const selections: Array<{ title: string; options: string[] }> = [];
	const confirms: Array<{ title: string; message: string }> = [];
	return {
		notifications,
		selections,
		confirms,
		ctx: {
			hasUI: true,
			ui: {
				notify(message: string) {
					notifications.push(message);
				},
				confirm: async (title: string, message: string) => {
					confirms.push({ title, message });
					return confirmResult === true;
				},
				select: async (title: string, options: string[]) => {
					selections.push({ title, options });
					return typeof confirmResult === "string" ? confirmResult : confirmResult ? options[0] : options.at(-1);
				},
			},
		},
	};
}

test("registerChromeCdp registers chrome_cdp tool and /cdp command", () => {
	const { pi, tools, commands } = makePi();

	registerChromeCdp(pi as any);

	assert.ok(tools.has("chrome_cdp"));
	assert.ok(commands.has("cdp"));
	assert.match(tools.get("chrome_cdp").description, /Do not use for public web search/);
});

test("/cdp command manages ask on off modes and port", async () => {
	const { pi, commands } = makePi();
	const { ctx, notifications } = makeCtx();
	registerChromeCdp(pi as any, {
		getStatus: async () => ({ online: false, port: 9222, error: "offline" }),
		listTabs: async () => [],
	});

	const command = commands.get("cdp");
	await command.handler("off", ctx);
	await command.handler("on", ctx);
	await command.handler("ask", ctx);
	await command.handler("port 9444", ctx);
	await command.handler("status", ctx);

	assert.match(notifications.join("\n"), /off/);
	assert.match(notifications.join("\n"), /on/);
	assert.match(notifications.join("\n"), /ask/);
	assert.match(notifications.join("\n"), /9444/);
});

test("/cdp with no args opens an action menu", async () => {
	const { pi, commands } = makePi();
	const { ctx, notifications, selections } = makeCtx("查看标签页");
	registerChromeCdp(pi as any, {
		getStatus: async () => ({ online: false, port: 9222, error: "offline" }),
		listTabs: async () => [{ id: "tab-1", type: "page", title: "Private", url: "https://private.example.com" }],
	});

	await commands.get("cdp").handler("", ctx);

	assert.equal(selections.length, 1);
	assert.equal(selections[0].title, "Chrome CDP");
	assert.deepEqual(selections[0].options, [
		"查看状态",
		"查看标签页",
		"启动 Chrome",
		"Mode: ask",
		"Mode: on",
		"Mode: off",
		"设置端口",
		"退出",
	]);
	assert.match(notifications.join("\n"), /tab-1/);
});

test("/cdp menu follows UI language", async () => {
	const { pi, commands } = makePi();
	writeFileSync(path.join(testAgentDir, "settings.json"), JSON.stringify({ uiLanguage: "en-US" }));
	const { ctx, notifications, selections } = makeCtx("View tabs");
	registerChromeCdp(pi as any, {
		getStatus: async () => ({ online: false, port: 9222, error: "offline" }),
		listTabs: async () => [{ id: "tab-1", type: "page", title: "Private", url: "https://private.example.com" }],
	});

	await commands.get("cdp").handler("", ctx);

	assert.deepEqual(selections[0].options, [
		"Status",
		"View tabs",
		"Launch Chrome",
		"Mode: ask",
		"Mode: on",
		"Mode: off",
		"Set port",
		"Exit",
	]);
	assert.match(notifications.join("\n"), /tab-1/);
});

test("/cdp port reports invalid values without throwing", async () => {
	const { pi, commands } = makePi();
	const { ctx, notifications } = makeCtx();
	const statusPorts: number[] = [];
	registerChromeCdp(pi as any, {
		getStatus: async (port) => {
			statusPorts.push(port);
			return { online: false, port, error: "offline" };
		},
		listTabs: async () => [],
	});

	const command = commands.get("cdp");
	await assert.doesNotReject(() => command.handler("port nope", ctx));
	await command.handler("status", ctx);

	assert.match(notifications.join("\n"), /CDP 端口无效/);
	assert.deepEqual(statusPorts, [9222]);
});

test("chrome_cdp tool blocks browser operations when mode is off", async () => {
	const { pi, tools, commands } = makePi();
	const { ctx } = makeCtx();
	registerChromeCdp(pi as any, { listTabs: async () => [] });
	await commands.get("cdp").handler("off", ctx);

	const result = await tools.get("chrome_cdp").execute(
		"tool-1",
		{ action: "tabs", reason: "Needs logged-in Chrome", normalAccessAttempted: true },
		undefined,
		undefined,
		ctx,
	);

	assert.match(result.content[0].text, /Chrome CDP 已关闭/);
});

test("chrome_cdp tool asks for confirmation in ask mode before browser operations", async () => {
	const { pi, tools } = makePi();
	const { ctx } = makeCtx(true);
	let tabsCalled = false;
	registerChromeCdp(pi as any, {
		listTabs: async () => {
			tabsCalled = true;
			return [{ id: "tab-1", type: "page", title: "Private", url: "https://private.example.com" }];
		},
	});

	const result = await tools.get("chrome_cdp").execute(
		"tool-1",
		{ action: "tabs", reason: "Requires logged-in Chrome session", normalAccessAttempted: true },
		undefined,
		undefined,
		ctx,
	);

	assert.equal(tabsCalled, true);
	assert.match(result.content[0].text, /tab-1/);
});

test("chrome_cdp tool launches through deps without confirmation", async () => {
	const { pi, tools } = makePi();
	const { ctx, selections } = makeCtx(true);
	let launchedPort = 0;
	registerChromeCdp(pi as any, {
		launch: async (port) => {
			launchedPort = port;
			return `launched ${port}`;
		},
	});

	const result = await tools.get("chrome_cdp").execute(
		"tool-1",
		{ action: "launch", reason: "Start local Chrome CDP profile", normalAccessAttempted: false },
		undefined,
		undefined,
		ctx,
	);

	assert.equal(launchedPort, 9222);
	assert.equal(selections.length, 0);
	assert.match(result.content[0].text, /launched 9222/);
});

test("chrome_cdp tool refuses non-status actions when normal access was not attempted", async () => {
	const { pi, tools } = makePi();
	const { ctx } = makeCtx(true);
	let tabsCalled = false;
	registerChromeCdp(pi as any, {
		listTabs: async () => {
			tabsCalled = true;
			return [];
		},
	});

	const result = await tools.get("chrome_cdp").execute(
		"tool-1",
		{ action: "tabs", reason: "Open a public page", normalAccessAttempted: false },
		undefined,
		undefined,
		ctx,
	);

	assert.equal(tabsCalled, false);
	assert.match(result.content[0].text, /普通访问/);
});

test("chrome_cdp can be allowed for the current session without prompting again", async () => {
	const allowForSession = "本会话允许";
	const { pi, tools } = makePi();
	const { ctx, selections } = makeCtx(allowForSession);
	let tabsCalled = 0;
	registerChromeCdp(pi as any, {
		listTabs: async () => {
			tabsCalled += 1;
			return [{ id: "tab-1", type: "page", title: "Private", url: "https://private.example.com" }];
		},
	});

	await tools.get("chrome_cdp").execute(
		"tool-1",
		{ action: "tabs", reason: "Requires logged-in Chrome session", normalAccessAttempted: true },
		undefined,
		undefined,
		ctx,
	);
	await tools.get("chrome_cdp").execute(
		"tool-2",
		{ action: "tabs", reason: "Requires logged-in Chrome session", normalAccessAttempted: true },
		undefined,
		undefined,
		ctx,
	);

	assert.equal(tabsCalled, 2);
	assert.equal(selections.length, 1);
	assert.deepEqual(selections[0].options, ["允许一次", "本会话允许", "拒绝"]);
});

// ponytail: per-worker 会话 tab 隔离。sessionTabId 来自 UGK_CDP_TAB_ID env(worker 进程注入)。
// 工具 execute 应把它作为 navigate/evaluate 的默认 target,显式 params.target 压过它。
test("chrome_cdp defaults navigate target to the session tab from UGK_CDP_TAB_ID env", async () => {
	const previousTabId = process.env.UGK_CDP_TAB_ID;
	const previousAllow = process.env.UGK_TASK_ALLOW_CHROME_CDP;
	process.env.UGK_CDP_TAB_ID = "session-tab-1";
	process.env.UGK_TASK_ALLOW_CHROME_CDP = "1"; // skip ask confirmation
	try {
		const { pi, tools } = makePi();
		let navigatedTarget: string | undefined;
		registerChromeCdp(pi as any, {
			navigate: async (_port, target, _url) => {
				navigatedTarget = target;
				return {};
			},
		});

		await tools.get("chrome_cdp").execute(
			"tool-1",
			{ action: "navigate", url: "https://example.com", reason: "Requires logged-in Chrome", normalAccessAttempted: true },
			undefined,
			undefined,
			{ hasUI: false } as any, // non-interactive → deny confirmation not needed; sessionAllowed already true
		);

		assert.equal(navigatedTarget, "session-tab-1");
	} finally {
		if (previousTabId === undefined) delete process.env.UGK_CDP_TAB_ID;
		else process.env.UGK_CDP_TAB_ID = previousTabId;
		if (previousAllow === undefined) delete process.env.UGK_TASK_ALLOW_CHROME_CDP;
		else process.env.UGK_TASK_ALLOW_CHROME_CDP = previousAllow;
	}
});

test("explicit params.target overrides the session tab", async () => {
	const previousTabId = process.env.UGK_CDP_TAB_ID;
	const previousAllow = process.env.UGK_TASK_ALLOW_CHROME_CDP;
	process.env.UGK_CDP_TAB_ID = "session-tab-2";
	process.env.UGK_TASK_ALLOW_CHROME_CDP = "1";
	try {
		const { pi, tools } = makePi();
		let navigatedTarget: string | undefined;
		registerChromeCdp(pi as any, {
			navigate: async (_port, target, _url) => {
				navigatedTarget = target;
				return {};
			},
		});

		await tools.get("chrome_cdp").execute(
			"tool-1",
			{ action: "navigate", target: "explicit-tab", url: "https://example.com", reason: "Requires logged-in Chrome", normalAccessAttempted: true },
			undefined,
			undefined,
			{ hasUI: false } as any,
		);

		assert.equal(navigatedTarget, "explicit-tab");
	} finally {
		if (previousTabId === undefined) delete process.env.UGK_CDP_TAB_ID;
		else process.env.UGK_CDP_TAB_ID = previousTabId;
		if (previousAllow === undefined) delete process.env.UGK_TASK_ALLOW_CHROME_CDP;
		else process.env.UGK_TASK_ALLOW_CHROME_CDP = previousAllow;
	}
});
