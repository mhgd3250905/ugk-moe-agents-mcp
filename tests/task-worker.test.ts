import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { makeCdpTabLifecycle } from "../extensions/chrome-cdp/tab-session.ts";
import { setWorkerLifecycleFactory } from "../extensions/shared/worker-lifecycle.ts";
import { buildTaskWorkerPrompt, dispatchWorker, setTaskWorkerRunnerForTests } from "../extensions/task/task-worker.ts";

test("buildTaskWorkerPrompt injects skill contract runtime input outputDir and feedback", () => {
	const prompt = buildTaskWorkerPrompt({
		skill: "# Skill",
		contract: { artifacts: [{ name: "report.json" }] },
		runtimeInput: { source: "a" },
		outputDir: "E:/out",
		feedback: [{ assertion: "文件存在", actual: "missing" }],
	});

	assert.match(prompt, /所有产出必须落到: E:\/out/);
	assert.match(prompt, /# Skill/);
	assert.match(prompt, /report\.json/);
	assert.match(prompt, /"source": "a"/);
	assert.match(prompt, /上一轮失败反馈/);
	assert.doesNotMatch(prompt, /verify\.mjs/);
});

test("buildTaskWorkerPrompt 注入 TASK_DIR 提示当且仅当传入 taskDir", () => {
	// ponytail: 验证 scripts/ 自带脚本机制——已落盘 taskbook 的 run 注入 TASK_DIR 提示,创建自证阶段不注入
	const withDir = buildTaskWorkerPrompt({
		skill: "# Skill",
		contract: { artifacts: [] },
		runtimeInput: {},
		outputDir: "E:/out",
		feedback: [],
	}, "E:/tasks/foo");
	assert.match(withDir, /TASK_DIR=E:\/tasks\/foo/);
	assert.match(withDir, /scripts\//);

	const withoutDir = buildTaskWorkerPrompt({
		skill: "# Skill",
		contract: { artifacts: [] },
		runtimeInput: {},
		outputDir: "E:/out",
		feedback: [],
	});
	assert.doesNotMatch(withoutDir, /TASK_DIR/);
});

test("dispatchWorker maps subagent result to task worker result", async () => {
	let receivedTask = "";
	setTaskWorkerRunnerForTests(async (_defaultCwd, _agents, agentName, task) => {
		receivedTask = task;
		return {
			agent: agentName,
			agentSource: "user",
			task,
			model: "deepseek-v4-pro",
			exitCode: 0,
			messages: [{
				role: "assistant",
				content: [{ type: "text", text: "生成了 report.json" }],
				usage: { input: 10, output: 5, cost: { total: 0.01 }, totalTokens: 15 },
			}],
			stderr: "",
			usage: { input: 10, output: 5, cacheRead: 7, cacheWrite: 3, cost: 0.01, contextTokens: 25, turns: 1 },
		} as any;
	});
	try {
		const result = await dispatchWorker({
			skill: "# Skill",
			contract: { artifacts: [] },
			runtimeInput: {},
			outputDir: "E:/out",
		}, { cwd: process.cwd() });

		assert.equal(result.ok, true);
		assert.equal(result.outputDir, "E:/out");
		assert.equal(result.summary, "生成了 report.json");
		assert.equal(result.model, "deepseek-v4-pro");
		assert.deepEqual(result.usage, { input: 10, output: 5, cacheRead: 7, cacheWrite: 3, cost: 0.01 });
		assert.match(receivedTask, /# Skill/);
	} finally {
		setTaskWorkerRunnerForTests(undefined);
	}
});

test("dispatchWorker reports failed worker result", async () => {
	setTaskWorkerRunnerForTests(async () => ({
		agent: "worker",
		agentSource: "unknown",
		task: "task",
		exitCode: 1,
		messages: [],
		stderr: "Unknown agent",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
	}) as any);
	try {
		const result = await dispatchWorker({
			skill: "# Skill",
			contract: {},
			runtimeInput: {},
			outputDir: "E:/out",
		}, { cwd: process.cwd() });

		assert.equal(result.ok, false);
		assert.match(result.errorMessage ?? "", /Unknown agent/);
	} finally {
		setTaskWorkerRunnerForTests(undefined);
	}
});

test("dispatchWorker passes extra env to the child agent", async () => {
	let receivedEnv: Record<string, string | undefined> | undefined;
	setTaskWorkerRunnerForTests(async (...args: any[]) => {
		receivedEnv = args[9];
		return {
			agent: "worker",
			agentSource: "user",
			task: "task",
			exitCode: 0,
			messages: [],
			stderr: "",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		} as any;
	});
	try {
		await dispatchWorker({
			skill: "# Skill",
			contract: {},
			runtimeInput: {},
			outputDir: "E:/out",
		}, { cwd: process.cwd(), env: { UGK_TASK_ALLOW_CHROME_CDP: "1" } });

		assert.equal(receivedEnv?.UGK_TASK_ALLOW_CHROME_CDP, "1");
	} finally {
		setTaskWorkerRunnerForTests(undefined);
	}
});

test("dispatchWorker forwards progress partials when result messages are still empty", async () => {
	const updates: string[] = [];
	setTaskWorkerRunnerForTests(async (...args: any[]) => {
		const onUpdate = args[7];
		onUpdate?.({
			content: [{ type: "text", text: "[download] 18.4% at 5.2MiB/s ETA 01:02" }],
			details: { mode: "single", results: [{ messages: [] }] },
		});
		return {
			agent: "worker",
			agentSource: "user",
			task: "task",
			exitCode: 0,
			messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }],
			stderr: "",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 },
		} as any;
	});
	try {
		await dispatchWorker({
			skill: "# Skill",
			contract: {},
			runtimeInput: {},
			outputDir: "E:/out",
		}, { cwd: process.cwd(), onUpdate: (text) => updates.push(text) });

		assert.deepEqual(updates, ["[download] 18.4% at 5.2MiB/s ETA 01:02"]);
	} finally {
		setTaskWorkerRunnerForTests(undefined);
	}
});

// ponytail: 钉死多轮 progress 回归 —— worker 完成 ≥1 轮(message_end 已 push)后,subagent 注入的
// progress partial 里 messages 非空。旧实现用 messages.length 判定走文本分支,此时会丢 progressText。
// 修复后 content 文本无条件优先推送,messages 遍历仅作补充(此例 messages 含旧 assistant,会被 formatMessageProgress
// 推成 summary,但 progressText 必须在其中,不被丢弃)。
test("dispatchWorker forwards progress partials even when result messages are non-empty (multi-round)", async () => {
	const updates: string[] = [];
	setTaskWorkerRunnerForTests(async (...args: any[]) => {
		const onUpdate = args[7];
		// 模拟多轮:worker 已完成 1 轮,messages 里已有 assistant summary;第 2 轮工具流式进度来了
		onUpdate?.({
			content: [{ type: "text", text: "[download] 45.2% at 5.2MiB/s ETA 00:30" }],
			details: {
				mode: "single",
				results: [{ messages: [{ role: "assistant", content: [{ type: "text", text: "第一轮分析完成" }] }] }],
			},
		});
		return {
			agent: "worker",
			agentSource: "user",
			task: "task",
			exitCode: 0,
			messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }],
			stderr: "",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 },
		} as any;
	});
	try {
		await dispatchWorker({
			skill: "# Skill",
			contract: {},
			runtimeInput: {},
			outputDir: "E:/out",
		}, { cwd: process.cwd(), onUpdate: (text) => updates.push(text) });

		// progressText 必须被推出(不被 messages 遍历吞掉);旧 assistant summary 也会被推(formatMessageProgress),
		// 但关键是 progress 在里面。
		assert.ok(updates.includes("[download] 45.2% at 5.2MiB/s ETA 00:30"),
			`多轮 progress 必须转发,实际 updates: ${JSON.stringify(updates)}`);
	} finally {
		setTaskWorkerRunnerForTests(undefined);
	}
});

test("dispatchWorker injects a CDP tab lifecycle only when UGK_TASK_ALLOW_CHROME_CDP is set", async () => {
	let receivedLifecycle: unknown = undefined;
	setTaskWorkerRunnerForTests(async (...args: any[]) => {
		receivedLifecycle = args[10]; // lifecycle is the 11th positional arg (index 10)
		return {
			agent: "worker",
			agentSource: "user",
			task: "task",
			exitCode: 0,
			messages: [],
			stderr: "",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		} as any;
	});
	// ponytail: 模拟组合根接线 —— registerChromeCdp 把工厂注册到 shared 层。task-worker peek 出来用。
	setWorkerLifecycleFactory((port) => makeCdpTabLifecycle(port));

	try {
		// 有 CDP env → 传 lifecycle(非 undefined)
		receivedLifecycle = undefined;
		await dispatchWorker({
			skill: "# Skill",
			contract: {},
			runtimeInput: {},
			outputDir: "E:/out",
		}, { cwd: process.cwd(), env: { UGK_TASK_ALLOW_CHROME_CDP: "1" } });
		assert.notEqual(receivedLifecycle, undefined, "lifecycle should be injected when UGK_TASK_ALLOW_CHROME_CDP set");
		assert.equal(typeof (receivedLifecycle as any)?.beforeSpawn, "function");
		assert.equal(typeof (receivedLifecycle as any)?.afterClose, "function");

		// 无 CDP env → 不传 lifecycle(undefined)
		receivedLifecycle = "sentinel";
		await dispatchWorker({
			skill: "# Skill",
			contract: {},
			runtimeInput: {},
			outputDir: "E:/out",
		}, { cwd: process.cwd(), env: {} });
		assert.equal(receivedLifecycle, undefined, "lifecycle should be undefined when UGK_TASK_ALLOW_CHROME_CDP not set");
	} finally {
		setTaskWorkerRunnerForTests(undefined);
		setWorkerLifecycleFactory(undefined);
	}
});

test("worker agent inherits all tools and forbids subagent in prompt", () => {
	const source = readFileSync(path.resolve("agents/worker.md"), "utf8");

	// 不写 tools 字段 = 继承全部默认工具(含 chrome_cdp / mcp)
	assert.doesNotMatch(source, /^tools:/m);
	// 但必须在 prompt 里禁止 subagent
	assert.match(source, /不得调用 subagent|禁止派 subagent|禁止.*subagent/);
	// 复制提示仍在
	assert.match(source, /~\/\.pi\/agent\/agents\/worker\.md/);
});

// ponytail: 进度自证 —— onUpdate 必须把 worker 的工具调用(ToolCall/toolResult)转成进度行。
// 这是"第一轮失败想看具体原因"的关键:旧实现只取 LLM 文本流,worker 调 chrome_cdp/bash 时全程静默。
test("dispatchWorker streams assistant summary + failed tool results via onUpdate", async () => {
	// ponytail: 用户要"大概步骤 + 关键节点(失败)"。
	// 大概步骤 = worker 每轮 assistant 的文字 summary(取首行);
	// 关键节点 = 工具调用失败(失败的 toolResult 成一行 ✖)。
	// 成功的工具调用和 toolResult、ToolCall 是噪音,不推。
	setTaskWorkerRunnerForTests(async (...args: any[]) => {
		const onUpdate = args[7];
		const makeDetails = args[8];
		const mkPartial = (messages: any[]) => ({
			content: [{ type: "text", text: "running" }],
			details: makeDetails([{ agent: "worker", agentSource: "user", task: "t", exitCode: 0, messages, stderr: "", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 } }]),
		});
		if (onUpdate) {
			// 第一轮:assistant 带 summary("正在导航到搜索页")+ ToolCall + 成功 toolResult
			// summary 应该报(大概步骤),ToolCall 和成功 toolResult 不该报
			onUpdate(mkPartial([
				{ role: "assistant", content: [{ type: "text", text: "正在导航到搜索页\n开始抓取" }, { type: "toolCall", id: "c1", name: "chrome_cdp", arguments: { action: "navigate", url: "https://example.com" } }], usage: { input: 1, output: 1, cost: { total: 0 }, totalTokens: 2 }, model: "m", stopReason: "toolUse", api: "anthropic-messages", provider: "anthropic", timestamp: 0 },
				{ role: "toolResult", toolCallId: "c1", toolName: "chrome_cdp", content: [{ type: "text", text: "navigated ok" }], isError: false, timestamp: 0 },
			]));
			// 第二轮:新增 assistant summary("解析结果失败")+ 失败的 bash toolResult
			// 新 summary 应该报,失败 toolResult 应该报(关键节点)
			onUpdate(mkPartial([
				{ role: "assistant", content: [{ type: "text", text: "正在导航到搜索页\n开始抓取" }, { type: "toolCall", id: "c1", name: "chrome_cdp", arguments: { action: "navigate", url: "https://example.com" } }], usage: { input: 1, output: 1, cost: { total: 0 }, totalTokens: 2 }, model: "m", stopReason: "toolUse", api: "anthropic-messages", provider: "anthropic", timestamp: 0 },
				{ role: "toolResult", toolCallId: "c1", toolName: "chrome_cdp", content: [{ type: "text", text: "navigated ok" }], isError: false, timestamp: 0 },
				{ role: "assistant", content: [{ type: "text", text: "运行命令解析结果" }, { type: "toolCall", id: "c2", name: "bash", arguments: { command: "jq ..." } }], usage: { input: 1, output: 1, cost: { total: 0 }, totalTokens: 2 }, model: "m", stopReason: "toolUse", api: "anthropic-messages", provider: "anthropic", timestamp: 0 },
				{ role: "toolResult", toolCallId: "c2", toolName: "bash", content: [{ type: "text", text: "command not found\nline2" }], isError: true, timestamp: 0 },
			]));
		}
		return { agent: "worker", agentSource: "user", task: "t", exitCode: 0, messages: [{ role: "assistant", content: [{ type: "text", text: "done" }], usage: { input: 1, output: 1, cost: { total: 0 }, totalTokens: 2 }, model: "m", stopReason: "stop", api: "anthropic-messages", provider: "anthropic", timestamp: 0 }], stderr: "", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 } } as any;
	});
	try {
		const progress: string[] = [];
		await dispatchWorker({
			skill: "# Skill",
			contract: {},
			runtimeInput: {},
			outputDir: "E:/out",
		}, { cwd: process.cwd(), onUpdate: (text) => progress.push(text) });

		// 大概步骤:每轮 assistant 的 summary 首行应该报
		assert.ok(progress.some((line) => /正在导航到搜索页/.test(line)), `expected first-round summary, got: ${JSON.stringify(progress)}`);
		assert.ok(progress.some((line) => /运行命令解析结果/.test(line)), `expected second-round summary, got: ${JSON.stringify(progress)}`);
		// 多行 summary 只取首行(不把"开始抓取"也推)
		assert.ok(!progress.some((line) => /开始抓取/.test(line)), `only first line of summary should be pushed, got: ${JSON.stringify(progress)}`);
		// 关键节点:失败的 bash toolResult 必须报
		assert.ok(progress.some((line) => /✖ bash.*command not found/.test(line)), `expected failed tool-result line, got: ${JSON.stringify(progress)}`);
		// ToolCall 不该报(太细节)
		assert.ok(!progress.some((line) => /🔧 chrome_cdp/.test(line)), `tool-call should NOT be streamed, got: ${JSON.stringify(progress)}`);
		// 成功的 toolResult 不该报(噪音)
		assert.ok(!progress.some((line) => /✔ chrome_cdp.*navigated ok/.test(line)), `successful tool-result should NOT be streamed, got: ${JSON.stringify(progress)}`);
	} finally {
		setTaskWorkerRunnerForTests(undefined);
	}
});
