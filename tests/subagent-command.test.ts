import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import registerSubagentCommand from "../extensions/subagent-command.ts";

async function withTempAgentDir(fn: (agentDir: string, cwd: string) => Promise<void> | void) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "ugk-subagent-command-"));
	const old = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = path.join(root, "agent");
	fs.mkdirSync(path.join(process.env.PI_CODING_AGENT_DIR, "agents"), { recursive: true });
	try {
		return await fn(process.env.PI_CODING_AGENT_DIR, root);
	} finally {
		if (old === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = old;
		fs.rmSync(root, { recursive: true, force: true });
	}
}

function fakeModel(id: string, name: string) {
	return { provider: "deepseek", id, name };
}

test("/subagent writes selected model into agent frontmatter", async () => {
	await withTempAgentDir(async (agentDir, cwd) => {
		const file = path.join(agentDir, "agents", "scout.md");
		fs.writeFileSync(file, "---\nname: scout\ndescription: Scan code\n---\nPrompt\n", "utf8");

		let handler: Function | undefined;
		registerSubagentCommand({
			registerCommand(name: string, options: { handler: Function }) {
				if (name === "subagent") handler = options.handler;
			},
		} as any);
		assert.ok(handler);

		const notices: string[] = [];
		await handler("", {
			cwd,
			modelRegistry: { getAvailable: () => [fakeModel("deepseek-v4-flash", "DeepSeek V4 Flash")] },
			ui: {
				// 第一步选 agent:随包 install agent 也出现在列表里,必须按名精确选 scout(不能靠 model 字符串碰运气)。
				// 第二步选 model:选项含完整 "deepseek/deepseek-v4-flash" id。
				select: (_title: string, options: string[]) =>
					options.find((option) => option.startsWith("scout ·")) ??
					options.find((option) => option.includes("deepseek/deepseek-v4-flash")) ??
					options[0],
				notify: (message: string) => notices.push(message),
			},
		});

		const saved = fs.readFileSync(file, "utf8");
		assert.match(saved, /model: "deepseek\/deepseek-v4-flash"/);
		assert.match(notices.at(-1) ?? "", /下一次 subagent 调用生效/);
	});
});

test("/subagent can clear an agent model override", async () => {
	await withTempAgentDir(async (agentDir, cwd) => {
		const file = path.join(agentDir, "agents", "scout.md");
		fs.writeFileSync(file, "---\nname: scout\ndescription: Scan code\nmodel: old/model\n---\nPrompt\n", "utf8");

		let handler: Function | undefined;
		registerSubagentCommand({
			registerCommand(name: string, options: { handler: Function }) {
				if (name === "subagent") handler = options.handler;
			},
		} as any);
		assert.ok(handler);

		await handler("", {
			cwd,
			modelRegistry: { getAvailable: () => [fakeModel("deepseek-v4-flash", "DeepSeek V4 Flash")] },
			ui: {
				// 第一步选 agent:随包 install agent 在列表里,按名精确选 scout。
				// 第二步选 model:options[0] = 继承(清除 override,正是本测试要验证的)。
				select: (_title: string, options: string[]) =>
					options.find((option) => option.startsWith("scout ·")) ?? options[0],
				notify: () => {},
			},
		});

		assert.doesNotMatch(fs.readFileSync(file, "utf8"), /^model:/m);
	});
});

test("/subagent lists user and project agents", async () => {
	await withTempAgentDir(async (agentDir, cwd) => {
		fs.writeFileSync(
			path.join(agentDir, "agents", "user-agent.md"),
			"---\nname: user-agent\ndescription: User agent\n---\nPrompt\n",
			"utf8",
		);
		const projectAgents = path.join(cwd, ".pi", "agents");
		fs.mkdirSync(projectAgents, { recursive: true });
		fs.writeFileSync(
			path.join(projectAgents, "project-agent.md"),
			"---\nname: project-agent\ndescription: Project agent\n---\nPrompt\n",
			"utf8",
		);

		let handler: Function | undefined;
		registerSubagentCommand({
			registerCommand(name: string, options: { handler: Function }) {
				if (name === "subagent") handler = options.handler;
			},
		} as any);
		assert.ok(handler);

		let seenOptions: string[] = [];
		await handler("", {
			cwd,
			modelRegistry: { getAvailable: () => [] },
			ui: {
				select: (_title: string, options: string[]) => {
					seenOptions = options;
					return undefined;
				},
				notify: () => {},
			},
		});

		assert.ok(seenOptions.some((option) => option.startsWith("user-agent ")));
		assert.ok(seenOptions.some((option) => option.startsWith("project-agent ")));
	});
});

test("/subagent menu follows UI language", async () => {
	await withTempAgentDir(async (agentDir, cwd) => {
		fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ uiLanguage: "en-US" }));
		fs.writeFileSync(
			path.join(agentDir, "agents", "scout.md"),
			"---\nname: scout\ndescription: Scan code\n---\nPrompt\n",
			"utf8",
		);

		let handler: Function | undefined;
		registerSubagentCommand({
			registerCommand(name: string, options: { handler: Function }) {
				if (name === "subagent") handler = options.handler;
			},
		} as any);
		assert.ok(handler);

		const selections: Array<{ title: string; options: string[] }> = [];
		const notices: string[] = [];
		await handler("", {
			cwd,
			modelRegistry: { getAvailable: () => [] },
			ui: {
				select(title: string, options: string[]) {
					selections.push({ title, options });
					return options[0];
				},
				notify: (message: string) => notices.push(message),
			},
		});

		assert.equal(selections[0].title, "Subagents");
		// scout 是继承 model 的(无 frontmatter model),它一定在列表里 → 应有含 inherit 的选项。
		// 不能断言 options[0]:随包 install agent(checker/planner/...)带 model,可能排在 scout 前面。
		assert.ok(selections[0].options.some((o) => /inherit/i.test(o)), `expected an inherit option, got: ${JSON.stringify(selections[0].options)}`);
		assert.match(notices.at(-1) ?? "", /No models available/);
	});
});
