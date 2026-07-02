import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import registerUgkExtension, { suppressNaturalAtAutocomplete } from "../extensions/index.ts";
import { createAutopilotState, installAutopilotState, isAutopilotOn } from "../extensions/shared/autopilot.ts";

function tempAgentDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "ugk-command-"));
}

function registerCommands() {
	const commands = new Map<string, { handler: Function }>();
	const pi = {
		registerTool() {},
		registerCommand(name: string, options: { handler: Function }) {
			commands.set(name, options);
		},
		registerFlag() {},
		registerShortcut() {},
		on() {},
		getFlag() {
			return undefined;
		},
		getSessionName() {
			return "demo";
		},
	};
	registerUgkExtension(pi as any);
	return commands;
}

function registerWithHandlers() {
	const commands = new Map<string, { handler: Function }>();
	const handlers = new Map<string, Function[]>();
	const pi = {
		registerTool() {},
		registerCommand(name: string, options: { handler: Function }) {
			commands.set(name, options);
		},
		registerFlag() {},
		registerShortcut() {},
		on(eventName: string, handler: Function) {
			const existing = handlers.get(eventName) ?? [];
			existing.push(handler);
			handlers.set(eventName, existing);
		},
		getFlag() {
			return undefined;
		},
		getSessionName() {
			return "demo";
		},
	};
	registerUgkExtension(pi as any);
	return { commands, handlers };
}

test("/ugk renders a structured status panel", async () => {
	const previousApiKey = process.env.DEEPSEEK_API_KEY;
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	delete process.env.DEEPSEEK_API_KEY;
	process.env.PI_CODING_AGENT_DIR = tempAgentDir();
	try {
		const commands = new Map<string, { handler: Function }>();
		const pi = {
			registerTool() {},
			registerCommand(name: string, options: { handler: Function }) {
				commands.set(name, options);
			},
			registerFlag() {},
			registerShortcut() {},
			on() {},
			getFlag() {
				return undefined;
			},
			getSessionName() {
				return "demo";
			},
		};
		const notifications: string[] = [];

		registerUgkExtension(pi as any);
		await commands.get("ugk")!.handler("", {
			ui: {
				notify(message: string) {
					notifications.push(message);
				},
			},
		});

		const text = notifications.join("\n");
		assert.match(text, /^🟢 UGK 已启用/);
		assert.match(text, /┌─+┬─+┐/);
		assert.doesNotMatch(text, /│\s*🧰 工具\s*│.*✅ greet/);
		assert.match(text, /│\s*🧰 工具\s*│.*✅ mcp/);
		assert.match(text, /│\s*🤖 代理\s*│\s*✅ @agent 提及/);
		assert.match(text, /│\s*⌨️ 命令\s*│\s*\/ugk/);
		assert.match(text, /│\s*⌨️ 命令\s*│.*\/mcp/);
		assert.doesNotMatch(text, /│\s*⌨️ 命令\s*│.*\/flow/);
		assert.match(text, /│\s*📡 API\s*│\s*❌ DeepSeek 未配置/);
		assert.match(text, /│\s*🛡️ 防护\s*│\s*危险 bash 门禁已启用/);
		assert.doesNotMatch(text, /🧰 工具:/);
	} finally {
		if (previousApiKey === undefined) delete process.env.DEEPSEEK_API_KEY;
		else process.env.DEEPSEEK_API_KEY = previousApiKey;
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	}
});

test("/ugk-autopilot with no args opens an action menu", async () => {
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = tempAgentDir();
	installAutopilotState(createAutopilotState(false));
	try {
		const commands = registerCommands();
		const selections: Array<{ title: string; options: string[] }> = [];
		const notifications: string[] = [];

		await commands.get("ugk-autopilot")!.handler("", {
			ui: {
				notify(message: string) {
					notifications.push(message);
				},
				select(title: string, options: string[]) {
					selections.push({ title, options });
					return "开启";
				},
			},
		});

		assert.equal(selections[0].title, "自动放行");
		assert.deepEqual(selections[0].options, ["查看状态", "开启", "关闭", "退出"]);
		assert.equal(isAutopilotOn(), true);
		assert.match(notifications.join("\n"), /自动放行: 开/);
	} finally {
		installAutopilotState(createAutopilotState(false));
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	}
});

test("/language with no args opens an action menu before input", async () => {
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = tempAgentDir();
	try {
		const commands = registerCommands();
		const selections: Array<{ title: string; options: string[] }> = [];
		const inputs: string[] = [];
		const notifications: string[] = [];

		await commands.get("language")!.handler("", {
			ui: {
				notify(message: string) {
					notifications.push(message);
				},
				select(title: string, options: string[]) {
					selections.push({ title, options });
					return "设置回答语言";
				},
				input(prompt: string) {
					inputs.push(prompt);
					return "English";
				},
			},
		});

		assert.equal(selections[0].title, "回答语言");
		assert.deepEqual(selections[0].options, ["查看状态", "设置回答语言", "清除", "退出"]);
		assert.equal(inputs[0], "AI 回答优先用什么语言?");
		assert.match(notifications.join("\n"), /语言偏好已设为: English/);
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	}
});

test("/ui-language switches UGK UI copy without changing agent reply language", async () => {
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const agentDir = tempAgentDir();
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		const commands = registerCommands();
		const notifications: string[] = [];

		await commands.get("ui-language")!.handler("English", {
			ui: {
				notify(message: string) {
					notifications.push(message);
				},
			},
		});

		await commands.get("ugk")!.handler("", {
			ui: {
				notify(message: string) {
					notifications.push(message);
				},
			},
		});

		const text = notifications.join("\n");
		assert.match(text, /UI language set to: English/);
		assert.match(text, /^UI language set to: English[\s\S]*🟢 UGK enabled/);
		assert.match(text, /Tools/);
		assert.doesNotMatch(text, /UGK 已启用/);

		const settings = JSON.parse(fs.readFileSync(path.join(agentDir, "settings.json"), "utf8"));
		assert.equal(settings.uiLanguage, "en-US");
		assert.equal("language" in settings, false);
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	}
});

test("/ui-language clear follows the active UI language before resetting", async () => {
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const agentDir = tempAgentDir();
	fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ uiLanguage: "en-US" }));
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		const commands = registerCommands();
		const notifications: string[] = [];

		await commands.get("ui-language")!.handler("clear", {
			ui: {
				notify(message: string) {
					notifications.push(message);
				},
			},
		});

		assert.equal(notifications.at(-1), "UI language cleared; back to default: Simplified Chinese");
		const settings = JSON.parse(fs.readFileSync(path.join(agentDir, "settings.json"), "utf8"));
		assert.equal("uiLanguage" in settings, false);
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	}
});

test("dangerous bash gate localizes the prompt but preserves the block reason contract", async () => {
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const agentDir = tempAgentDir();
	fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ uiLanguage: "en-US" }));
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		const { handlers } = registerWithHandlers();
		const selections: Array<{ title: string; options: string[] }> = [];
		const toolCallHandlers = handlers.get("tool_call") ?? [];
		assert.ok(toolCallHandlers.length > 0);

		let result: unknown;
		for (const handler of toolCallHandlers) {
			result = await handler(
				{ toolName: "bash", input: { command: "rm -rf tmp" } },
				{
					hasUI: true,
					ui: {
						select(title: string, options: string[]) {
							selections.push({ title, options });
							return options[1];
						},
					},
				},
			);
			if (result) break;
		}

		assert.match(selections[0].title, /Dangerous command/);
		assert.deepEqual(selections[0].options, ["Yes", "No"]);
		assert.deepEqual(result, { block: true, reason: "Blocked by user" });
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	}
});

// ponytail: 钉死 rm 绕过回归。旧正则 /\brm\s+(-rf?|--recursive)/ 锁定 r 在 f 前,
// rm -fr / rm -f -r / rm --force --recursive 可静默绕过权限门。-r/-f 是顺序无关的独立 flag,
// 正则必须覆盖所有顺序组合 + 分写 + 长短选项。非交互(hasUI:false)走 fail-closed 直接拦截。
test("dangerous bash gate blocks rm recursive regardless of flag order or form (regression)", async () => {
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const agentDir = tempAgentDir();
	fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ uiLanguage: "en-US" }));
	process.env.PI_CODING_AGENT_DIR = agentDir;
	// hasUI:false → 命中危险模式直接 block,不依赖 select 交互,适合参数化批量断言。
	const nonInteractiveCtx = { hasUI: false } as any;

	const blocked = [
		"rm -rf /", "rm -fr /", "rm -f -r /", "rm -r -f /",
		"rm --recursive --force /", "rm --force --recursive /",
		"rm -rf", "rm -fr .", "rm -Rf /", "rm -rvf /", "rm -R /",
		"rm  -rf  /", "sudo rm -rf /",
		"chmod 777 x", "chmod -R 777 .", "chmod 0777 x", "chown 777 x",
		"ls; rm -rf /",
	];
	const allowed = [
		"rm file.txt", "rm a b c", "ls -la", "git status",
		"echo hello", "npm test", "cat README.md", "rm /",
		"rmdir foo", "chmod 755 x", "git rm file.txt",
	];
	try {
		const { handlers } = registerWithHandlers();
		const toolCallHandlers = handlers.get("tool_call") ?? [];
		assert.ok(toolCallHandlers.length > 0);

		const runGate = async (command: string): Promise<boolean> => {
			for (const handler of toolCallHandlers) {
				const r = await handler({ toolName: "bash", input: { command } }, nonInteractiveCtx);
				if (r && (r as any).block) return true;
			}
			return false;
		};
		for (const cmd of blocked) {
			assert.equal(await runGate(cmd), true, `应拦截: ${cmd}`);
		}
		for (const cmd of allowed) {
			assert.equal(await runGate(cmd), false, `应放行: ${cmd}`);
		}
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	}
});

test("/ui-language with no args uses nested selectable menus", async () => {
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const agentDir = tempAgentDir();
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		const commands = registerCommands();
		const selections: Array<{ title: string; options: string[] }> = [];
		const notifications: string[] = [];

		await commands.get("ui-language")!.handler("", {
			ui: {
				notify(message: string) {
					notifications.push(message);
				},
				select(title: string, options: string[]) {
					selections.push({ title, options });
					return selections.length === 1 ? "设置界面语言" : "日本語";
				},
			},
		});

		assert.deepEqual(selections, [
			{
				title: "界面语言",
				options: ["查看状态", "设置界面语言", "清除", "退出"],
			},
			{
				title: "选择界面语言",
				options: ["简体中文", "English", "日本語", "한국어", "Français", "Deutsch", "Español", "Português", "Русский", "返回"],
			},
		]);
		assert.match(notifications.join("\n"), /UI 言語を設定しました: 日本語/);
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	}
});

test("autocomplete wrapper leaves natural @agent text alone", async () => {
	let calls = 0;
	const provider = suppressNaturalAtAutocomplete({
		async getSuggestions() {
			calls += 1;
			return { items: [{ value: "x", label: "x" }], prefix: "@" };
		},
		applyCompletion(lines: string[], cursorLine: number, cursorCol: number) {
			return { lines, cursorLine, cursorCol };
		},
	});

	assert.equal(await provider.getSuggestions(["@"], 0, 1, { signal: new AbortController().signal }), null);
	assert.equal(await provider.getSuggestions(["@scout"], 0, 6, { signal: new AbortController().signal }), null);
	assert.equal(calls, 0);

	assert.notEqual(await provider.getSuggestions(["@"], 0, 1, { signal: new AbortController().signal, force: true }), null);
	assert.notEqual(await provider.getSuggestions(["@./"], 0, 3, { signal: new AbortController().signal }), null);
	assert.equal(calls, 2);
});

test("autocomplete wrapper preserves prototype applyCompletion", () => {
	class Provider {
		async getSuggestions() {
			return { items: [{ value: "x", label: "x" }], prefix: "@" };
		}

		applyCompletion(lines: string[], _cursorLine: number, _cursorCol: number) {
			return { lines: [...lines, "applied"], cursorLine: 1, cursorCol: 7 };
		}
	}

	const provider = suppressNaturalAtAutocomplete(new Provider() as any);
	assert.deepEqual(
		provider.applyCompletion(["@"], 0, 1, { value: "x", label: "x" }, "@"),
		{ lines: ["@", "applied"], cursorLine: 1, cursorCol: 7 },
	);
});
