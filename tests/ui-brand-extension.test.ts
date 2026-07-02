import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import registerUgkBrandUi from "../extensions/ui-brand.ts";

const PACKAGE_VERSION = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
const PACKAGE_VERSION_PATTERN = new RegExp(`ugk v${PACKAGE_VERSION.replaceAll(".", "\\.")}`);

function tempAgentDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "ugk-ui-brand-"));
}

test("ugk brand extension installs through safe extension UI hooks", async () => {
	const handlers = new Map<string, Function>();
	const commands = new Map<string, { handler: Function }>();
	const flags = new Map<string, unknown>();
	const pi = {
		on(event: string, handler: Function) {
			handlers.set(event, handler);
		},
		registerCommand(name: string, options: { handler: Function }) {
			commands.set(name, options);
		},
		registerFlag(name: string, options: unknown) {
			flags.set(name, options);
		},
		getFlag() {
			return undefined;
		},
		getSessionName() {
			return "demo";
		},
	};

	registerUgkBrandUi(pi as any);

	assert.ok(handlers.has("session_start"));
	assert.ok(handlers.has("session_shutdown"));
	assert.ok(commands.has("ugk-ui"));
	assert.ok(flags.has("ugk-ui-off"));

	const calls: string[] = [];
	let headerFactory: Function | undefined;
	let footerFactory: Function | undefined;
	const ctx = {
		cwd: "/Users/shengkai/projects/ugk-tui",
		model: { id: "deepseek-v4-pro" },
		sessionManager: {
			getCwd: () => "/Users/shengkai/projects/ugk-tui",
			getEntries: () => [],
			getBranch: () => [],
		},
		getContextUsage: () => ({ percent: 12.3, contextWindow: 1000000 }),
		ui: {
			setHeader: (factory: unknown) => {
				headerFactory = factory as Function;
				calls.push(`header:${typeof factory}`);
			},
			setFooter: (factory: unknown) => {
				footerFactory = factory as Function;
				calls.push(`footer:${typeof factory}`);
			},
			setTitle: (title: string) => calls.push(`title:${title}`),
			setEditorComponent: () => calls.push("editor"),
			notify: (message: string) => calls.push(`notify:${message}`),
			theme: {},
		},
	};

	await handlers.get("session_start")!({ reason: "startup" }, ctx);

	assert.deepEqual(calls.slice(0, 3), ["header:function", "footer:function", "title:ugk - demo - ugk-tui"]);
	assert.equal(calls.includes("editor"), false);

	const theme = {
		fg: (_color: string, text: string) => text,
		bold: (text: string) => text,
	};
	const tui = { requestRender() {} };
	const footerData = {
		getGitBranch: () => "feature/ui-optimization",
		getExtensionStatuses: () => new Map([["turn-progress", "✓ 第 1 轮完成"]]),
		onBranchChange: () => () => {},
	};

	const header = headerFactory!(tui, theme);
	const footer = footerFactory!(tui, theme, footerData);
	assert.match(header.render(80).join("\n"), PACKAGE_VERSION_PATTERN);
	assert.match(footer.render(80).join("\n"), /feature\/ui-optimization/);
	assert.match(footer.render(80).join("\n"), /第 1 轮完成/);

	const coloredHeader = headerFactory!(tui, {
		fg: (color: string, text: string) => {
			assert.ok(["success", "error", "warning", "accent", "dim", "muted"].includes(color), `unknown color ${color}`);
			return `<${color}>${text}</${color}>`;
		},
		bold: (text: string) => `<b>${text}</b>`,
	}).render(96).join("\n");
	assert.match(coloredHeader, /<success>█+/);
	assert.match(coloredHeader, /<b><error>██╗<\/error><\/b>/);
	assert.match(coloredHeader, /<b><accent>██║<\/accent><\/b>/);
	assert.match(coloredHeader, /<b><accent>╚═════╝<\/accent><\/b>/);
	assert.match(coloredHeader, /<b><success>◆ 最近更新<\/success><\/b>/);
	assert.match(coloredHeader, /› <success>\/plan<\/success>/);
	assert.doesNotMatch(coloredHeader, /^<b><success>│.*最近更新/m);
	header.dispose?.();
});

test("ugk footer totals subagent and run_task api usage by model", async () => {
	const handlers = new Map<string, Function>();
	const pi = {
		on(event: string, handler: Function) {
			handlers.set(event, handler);
		},
		registerCommand() {},
		registerFlag() {},
		getFlag() {
			return undefined;
		},
		getSessionName() {
			return "demo";
		},
	};
	let footerFactory: Function | undefined;
	const ctx = {
		cwd: "/Users/shengkai/projects/ugk-tui",
		model: { id: "deepseek-v4-pro" },
		sessionManager: {
			getCwd: () => "/Users/shengkai/projects/ugk-tui",
			getEntries: () => [
				{
					type: "message",
					message: {
						role: "toolResult",
						toolName: "subagent",
						details: {
							results: [
								{ model: "deepseek-v4-pro", usage: { input: 1000000, output: 200000, cacheRead: 10000, cacheWrite: 0, cost: 0.02 } },
							],
						},
					},
				},
				{
					type: "message",
					message: {
						role: "toolResult",
						toolName: "run_task",
						details: {
							results: [
								{
									model: "deepseek-v4-flash",
									usage: { input: 9000000, output: 900000, cacheRead: 0, cacheWrite: 0, cost: 0.03 },
									apiUsage: [
										{ model: "deepseek-v4-flash", usage: { input: 500000, output: 50000, cacheRead: 0, cacheWrite: 0, cost: 0.003 } },
										{ model: "deepseek-v4-pro", usage: { input: 300000, output: 40000, cacheRead: 0, cacheWrite: 0, cost: 0.004 } },
									],
								},
							],
						},
					},
				},
			],
			getBranch: () => [],
		},
		getContextUsage: () => ({ percent: 12.3, contextWindow: 1000000 }),
		ui: {
			setHeader: () => {},
			setFooter: (factory: unknown) => {
				footerFactory = factory as Function;
			},
			setTitle: () => {},
		},
	};

	registerUgkBrandUi(pi as any);
	await handlers.get("session_start")!({ reason: "startup" }, ctx);

	const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
	const footerData = { getGitBranch: () => null, getExtensionStatuses: () => new Map([["ready", "就绪"]]), onBranchChange: () => () => {} };
	const footer = footerFactory!({ requestRender() {} }, theme, footerData);
	const text = footer.render(160).join("\n");

	assert.match(text, /deepseek-v4-pro Σ1\.55M ↑1\.30M ↓0\.24M R0\.01M/);
	assert.match(text, /deepseek-v4-flash Σ0\.55M ↑0\.50M ↓0\.05M/);
	assert.doesNotMatch(text, /9\.90M/);
	assert.match(text, /就绪/);
});

test("ugk brand header and footer tolerate stale extension ctx during render", async () => {
	const handlers = new Map<string, Function>();
	const pi = {
		on(event: string, handler: Function) {
			handlers.set(event, handler);
		},
		registerCommand() {},
		registerFlag() {},
		getFlag() {
			return undefined;
		},
		getSessionName() {
			return "demo";
		},
	};
	let headerFactory: Function | undefined;
	let footerFactory: Function | undefined;
	let stale = false;
	const ctx = {
		cwd: "/Users/shengkai/projects/ugk-tui",
		model: { id: "deepseek-v4-pro" },
		get sessionManager() {
			if (stale) throw new Error("This extension ctx is stale after session replacement or reload.");
			return {
				getCwd: () => "/Users/shengkai/projects/ugk-tui",
				getEntries: () => [],
				getBranch: () => [],
			};
		},
		getContextUsage() {
			if (stale) throw new Error("This extension ctx is stale after session replacement or reload.");
			return { percent: 0, contextWindow: 1000000 };
		},
		ui: {
			setHeader: (factory: unknown) => {
				headerFactory = factory as Function;
			},
			setFooter: (factory: unknown) => {
				footerFactory = factory as Function;
			},
			setTitle: () => {},
		},
	};

	registerUgkBrandUi(pi as any);
	await handlers.get("session_start")!({ reason: "startup" }, ctx);
	const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
	const footerData = { getGitBranch: () => null, getExtensionStatuses: () => new Map(), onBranchChange: () => () => {} };
	const header = headerFactory!({ requestRender() {} }, theme);
	const footer = footerFactory!({ requestRender() {} }, theme, footerData);
	stale = true;

	assert.match(header.render(80).join("\n"), PACKAGE_VERSION_PATTERN);
	assert.match(footer.render(80).join("\n"), /ugk /);
});

test("/ugk-ui with no args opens an action menu", async () => {
	const handlers = new Map<string, Function>();
	const commands = new Map<string, { handler: Function }>();
	const pi = {
		on(event: string, handler: Function) {
			handlers.set(event, handler);
		},
		registerCommand(name: string, options: { handler: Function }) {
			commands.set(name, options);
		},
		registerFlag() {},
		getFlag() {
			return undefined;
		},
		getSessionName() {
			return "demo";
		},
	};
	const calls: string[] = [];
	const selections: Array<{ title: string; options: string[] }> = [];
	const ctx = {
		cwd: "/Users/shengkai/projects/ugk-tui",
		sessionManager: {
			getCwd: () => "/Users/shengkai/projects/ugk-tui",
			getEntries: () => [],
		},
		ui: {
			setHeader: () => calls.push("header"),
			setFooter: () => calls.push("footer"),
			setTitle: () => {},
			select: async (title: string, options: string[]) => {
				selections.push({ title, options });
				return "关闭";
			},
			notify: (message: string) => calls.push(`notify:${message}`),
		},
	};

	registerUgkBrandUi(pi as any);
	await commands.get("ugk-ui")!.handler("", ctx);

	assert.deepEqual(selections, [
		{
			title: "UGK UI",
			options: ["查看状态", "关闭", "开启", "退出"],
		},
	]);
	assert.ok(calls.includes("header"));
	assert.ok(calls.includes("footer"));
	assert.match(calls.join("\n"), /UGK UI 已关闭/);
});

test("/ugk-ui menu follows UI language", async () => {
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const agentDir = tempAgentDir();
	fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ uiLanguage: "en-US" }));
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		const handlers = new Map<string, Function>();
		const commands = new Map<string, { handler: Function }>();
		const pi = {
			on(event: string, handler: Function) {
				handlers.set(event, handler);
			},
			registerCommand(name: string, options: { handler: Function }) {
				commands.set(name, options);
			},
			registerFlag() {},
			getFlag() {
				return undefined;
			},
			getSessionName() {
				return "demo";
			},
		};
		const selections: Array<{ title: string; options: string[] }> = [];
		const calls: string[] = [];
		const ctx = {
			cwd: "/Users/shengkai/projects/ugk-tui",
			sessionManager: {
				getCwd: () => "/Users/shengkai/projects/ugk-tui",
				getEntries: () => [],
			},
			ui: {
				setHeader: () => calls.push("header"),
				setFooter: () => calls.push("footer"),
				setTitle: () => {},
				select: async (title: string, options: string[]) => {
					selections.push({ title, options });
					return "Turn off";
				},
				notify: (message: string) => calls.push(`notify:${message}`),
			},
		};

		registerUgkBrandUi(pi as any);
		await commands.get("ugk-ui")!.handler("", ctx);

		assert.deepEqual(selections, [
			{
				title: "UGK UI",
				options: ["Status", "Turn off", "Turn on", "Exit"],
			},
		]);
		assert.match(calls.join("\n"), /UGK UI disabled/);
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	}
});

test("ugk brand footer hides DeepSeek model when API credentials are missing", async () => {
	const previousApiKey = process.env.DEEPSEEK_API_KEY;
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	delete process.env.DEEPSEEK_API_KEY;
	process.env.PI_CODING_AGENT_DIR = tempAgentDir();
	try {
		const handlers = new Map<string, Function>();
		const pi = {
			on(event: string, handler: Function) {
				handlers.set(event, handler);
			},
			registerCommand() {},
			registerFlag() {},
			getFlag() {
				return undefined;
			},
			getSessionName() {
				return "demo";
			},
		};
		let footerFactory: Function | undefined;
		const ctx = {
			cwd: "/Users/shengkai/projects/ugk-tui",
			model: { id: "deepseek-v4-pro" },
			sessionManager: {
				getCwd: () => "/Users/shengkai/projects/ugk-tui",
				getEntries: () => [],
				getBranch: () => [],
			},
			getContextUsage: () => ({ percent: 0, contextWindow: 1000000 }),
			ui: {
				setHeader: () => {},
				setFooter: (factory: unknown) => {
					footerFactory = factory as Function;
				},
				setTitle: () => {},
			},
		};

		registerUgkBrandUi(pi as any);
		await handlers.get("session_start")!({ reason: "startup" }, ctx);
		const footer = footerFactory!({ requestRender() {} }, { fg: (_color: string, text: string) => text }, {
			getGitBranch: () => null,
			getExtensionStatuses: () => new Map(),
			onBranchChange: () => () => {},
		});
		const text = footer.render(100).join("\n");

		assert.doesNotMatch(text, /deepseek-v4-pro/);
		assert.match(text, /❌ API 未配置/);
	} finally {
		if (previousApiKey === undefined) delete process.env.DEEPSEEK_API_KEY;
		else process.env.DEEPSEEK_API_KEY = previousApiKey;
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	}
});

test("ugk brand footer colors stateful fields by severity", async () => {
	const previousApiKey = process.env.DEEPSEEK_API_KEY;
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	delete process.env.DEEPSEEK_API_KEY;
	process.env.PI_CODING_AGENT_DIR = tempAgentDir();
	try {
		const handlers = new Map<string, Function>();
		const pi = {
			on(event: string, handler: Function) {
				handlers.set(event, handler);
			},
			registerCommand() {},
			registerFlag() {},
			getFlag() {
				return undefined;
			},
			getSessionName() {
				return "demo";
			},
		};
		let footerFactory: Function | undefined;
		const ctx = {
			cwd: "/Users/shengkai/projects/ugk-tui",
			model: { id: "deepseek-v4-pro" },
			sessionManager: {
				getCwd: () => "/Users/shengkai/projects/ugk-tui",
				getEntries: () => [],
				getBranch: () => [],
			},
			getContextUsage: () => ({ percent: 0, contextWindow: 1000000 }),
			ui: {
				setHeader: () => {},
				setFooter: (factory: unknown) => {
					footerFactory = factory as Function;
				},
				setTitle: () => {},
			},
		};

		registerUgkBrandUi(pi as any);
		await handlers.get("session_start")!({ reason: "startup" }, ctx);
		const theme = {
			fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
			bold: (text: string) => text,
		};
		const footer = footerFactory!({ requestRender() {} }, theme, {
			getGitBranch: () => null,
			getExtensionStatuses: () =>
				new Map([
					["bash", "bash 不可用"],
					["subagent", "subagent 未加载"],
					["turn-progress", "✓ 第 1 轮完成"],
				]),
			onBranchChange: () => () => {},
		});
		const text = footer.render(140).join("\n");

		assert.match(text, /<error>🤖 ❌ API 未配置<\/error>/);
		assert.doesNotMatch(text, /<success>configured<\/success>/);
		assert.match(text, /<error>bash 不可用<\/error>/);
		assert.match(text, /<error>subagent 未加载<\/error>/);
		assert.match(text, /<success>✓ 第 1 轮完成<\/success>/);
	} finally {
		if (previousApiKey === undefined) delete process.env.DEEPSEEK_API_KEY;
		else process.env.DEEPSEEK_API_KEY = previousApiKey;
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	}
});

test("ugk brand footer colors context progress by percentage", async () => {
	const handlers = new Map<string, Function>();
	const pi = {
		on(event: string, handler: Function) {
			handlers.set(event, handler);
		},
		registerCommand() {},
		registerFlag() {},
		getFlag() {
			return undefined;
		},
		getSessionName() {
			return "demo";
		},
	};
	let footerFactory: Function | undefined;
	const contextUsage = { percent: 0, contextWindow: 1000000 };
	const ctx = {
		cwd: "/Users/shengkai/projects/ugk-tui",
		model: { id: "mimo-v2.5-pro" },
		sessionManager: {
			getCwd: () => "/Users/shengkai/projects/ugk-tui",
			getEntries: () => [],
			getBranch: () => [],
		},
		getContextUsage: () => contextUsage,
		ui: {
			setHeader: () => {},
			setFooter: (factory: unknown) => {
				footerFactory = factory as Function;
			},
			setTitle: () => {},
		},
	};

	registerUgkBrandUi(pi as any);
	await handlers.get("session_start")!({ reason: "startup" }, ctx);
	const theme = {
		fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
		bold: (text: string) => text,
	};
	const footer = footerFactory!({ requestRender() {} }, theme, {
		getGitBranch: () => null,
		getExtensionStatuses: () => new Map(),
		onBranchChange: () => () => {},
	});

	assert.match(footer.render(140).join("\n"), /<dim>▒▒▒▒▒▒▒▒<\/dim>/);
	contextUsage.percent = 75;
	assert.match(footer.render(140).join("\n"), /<warning>██████<\/warning><dim>▒▒<\/dim>/);
	contextUsage.percent = 95;
	assert.match(footer.render(140).join("\n"), /<error>████████<\/error>/);
});

test("ugk brand footer refreshes context usage on each render", async () => {
	const handlers = new Map<string, Function>();
	const pi = {
		on(event: string, handler: Function) {
			handlers.set(event, handler);
		},
		registerCommand() {},
		registerFlag() {},
		getFlag() {
			return undefined;
		},
		getSessionName() {
			return "demo";
		},
	};
	let footerFactory: Function | undefined;
	let percent = 0;
	const ctx = {
		cwd: "/Users/shengkai/projects/ugk-tui",
		model: { id: "mimo-v2.5-pro", contextWindow: 1000000 },
		sessionManager: {
			getCwd: () => "/Users/shengkai/projects/ugk-tui",
			getEntries: () => [],
			getBranch: () => [],
		},
		getContextUsage: () => ({ percent, contextWindow: 1000000 }),
		ui: {
			setHeader: () => {},
			setFooter: (factory: unknown) => {
				footerFactory = factory as Function;
			},
			setTitle: () => {},
		},
	};

	registerUgkBrandUi(pi as any);
	await handlers.get("session_start")!({ reason: "startup" }, ctx);
	const footer = footerFactory!({ requestRender() {} }, { fg: (_color: string, text: string) => text }, {
		getGitBranch: () => null,
		getExtensionStatuses: () => new Map(),
		onBranchChange: () => () => {},
	});

	assert.match(footer.render(140).join("\n"), /0\.0%\/1\.0M/);
	percent = 42.5;
	assert.match(footer.render(140).join("\n"), /42\.5%\/1\.0M/);
});

test("ugk brand footer refreshes model on each render", async () => {
	const handlers = new Map<string, Function>();
	const pi = {
		on(event: string, handler: Function) {
			handlers.set(event, handler);
		},
		registerCommand() {},
		registerFlag() {},
		getFlag() {
			return undefined;
		},
		getSessionName() {
			return "demo";
		},
	};
	let footerFactory: Function | undefined;
	const ctx = {
		cwd: "/Users/shengkai/projects/ugk-tui",
		model: { id: "gpt-5.5", contextWindow: 1000000 },
		sessionManager: {
			getCwd: () => "/Users/shengkai/projects/ugk-tui",
			getEntries: () => [],
			getBranch: () => [],
		},
		getContextUsage: () => ({ percent: 0, contextWindow: ctx.model.contextWindow }),
		ui: {
			setHeader: () => {},
			setFooter: (factory: unknown) => {
				footerFactory = factory as Function;
			},
			setTitle: () => {},
		},
	};

	registerUgkBrandUi(pi as any);
	await handlers.get("session_start")!({ reason: "startup" }, ctx);
	const footer = footerFactory!({ requestRender() {} }, { fg: (_color: string, text: string) => text }, {
		getGitBranch: () => null,
		getExtensionStatuses: () => new Map(),
		onBranchChange: () => () => {},
	});

	assert.match(footer.render(140).join("\n"), /gpt-5\.5/);
	ctx.model = { id: "mimo-v2.5-pro", contextWindow: 1000000 };
	const refreshed = footer.render(140).join("\n");
	assert.match(refreshed, /mimo-v2\.5-pro/);
	assert.doesNotMatch(refreshed, /gpt-5\.5/);
});

test("ugk brand footer renders model as a background chip", async () => {
	const handlers = new Map<string, Function>();
	const pi = {
		on(event: string, handler: Function) {
			handlers.set(event, handler);
		},
		registerCommand() {},
		registerFlag() {},
		getFlag() {
			return undefined;
		},
		getSessionName() {
			return "demo";
		},
	};
	let footerFactory: Function | undefined;
	const ctx = {
		cwd: "/Users/shengkai/projects/ugk-tui",
		model: { id: "mimo-v2.5-pro", contextWindow: 1000000 },
		sessionManager: {
			getCwd: () => "/Users/shengkai/projects/ugk-tui",
			getEntries: () => [],
			getBranch: () => [],
		},
		getContextUsage: () => ({ percent: 0, contextWindow: 1000000 }),
		ui: {
			setHeader: () => {},
			setFooter: (factory: unknown) => {
				footerFactory = factory as Function;
			},
			setTitle: () => {},
		},
	};

	registerUgkBrandUi(pi as any);
	await handlers.get("session_start")!({ reason: "startup" }, ctx);
	const footer = footerFactory!({ requestRender() {} }, {
		fg: (color: string, text: string) => `<fg:${color}>${text}</fg:${color}>`,
		bg: (color: string, text: string) => `<bg:${color}>${text}</bg:${color}>`,
	}, {
		getGitBranch: () => null,
		getExtensionStatuses: () => new Map(),
		onBranchChange: () => () => {},
	});

	assert.match(footer.render(300).join("\n"), /<bg:toolSuccessBg><fg:success>🤖 mimo-v2\.5-pro<\/fg:success><\/bg:toolSuccessBg>/);
});

test("ugk brand footer falls back when model chip background is unavailable", async () => {
	const handlers = new Map<string, Function>();
	const pi = {
		on(event: string, handler: Function) {
			handlers.set(event, handler);
		},
		registerCommand() {},
		registerFlag() {},
		getFlag() {
			return undefined;
		},
		getSessionName() {
			return "demo";
		},
	};
	let footerFactory: Function | undefined;
	const ctx = {
		cwd: "/Users/shengkai/projects/ugk-tui",
		model: { id: "mimo-v2.5-pro", contextWindow: 1000000 },
		sessionManager: {
			getCwd: () => "/Users/shengkai/projects/ugk-tui",
			getEntries: () => [],
			getBranch: () => [],
		},
		getContextUsage: () => ({ percent: 0, contextWindow: 1000000 }),
		ui: {
			setHeader: () => {},
			setFooter: (factory: unknown) => {
				footerFactory = factory as Function;
			},
			setTitle: () => {},
		},
	};

	registerUgkBrandUi(pi as any);
	await handlers.get("session_start")!({ reason: "startup" }, ctx);
	const footer = footerFactory!({ requestRender() {} }, {
		fg: (color: string, text: string) => `<fg:${color}>${text}</fg:${color}>`,
		bg: () => {
			throw new Error("Unknown theme background color: toolSuccessBg");
		},
	}, {
		getGitBranch: () => null,
		getExtensionStatuses: () => new Map(),
		onBranchChange: () => () => {},
	});

	const rendered = footer.render(300).join("\n");
	assert.match(rendered, /<fg:success>🤖 mimo-v2\.5-pro<\/fg:success>/);
	assert.doesNotMatch(rendered, /<bg:toolSuccessBg>/);
});
