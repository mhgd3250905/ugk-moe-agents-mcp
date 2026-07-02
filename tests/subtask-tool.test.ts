import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { registerTask, formatPhaseBreakdown } from "../extensions/task/task.ts";
import { saveTaskbook, loadTaskbook } from "../extensions/task/task-book.ts";
import { buildTaskbookPrompt } from "../extensions/task/task-registry.ts";
import { setTaskDispatcherForTests } from "../extensions/task/task-dispatcher.ts";
import { setTaskWorkerRunnerForTests } from "../extensions/task/task-worker.ts";
import { setTaskCheckerRunnerForTests } from "../extensions/task/task-checker.ts";
import { resetTaskProtectedToolGrantsForTests, setWindowsUserEnvReaderForTests } from "../extensions/task/task.ts";
import { createAutopilotState, installAutopilotState } from "../extensions/shared/autopilot.ts";

const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
const testAgentDir = mkdtempSync(path.join(os.tmpdir(), "ugk-subtask-tool-agent-"));
process.env.PI_CODING_AGENT_DIR = testAgentDir;
process.on("exit", () => {
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	rmSync(testAgentDir, { recursive: true, force: true });
});

const spec = {
	goal: "生成报告",
	hardConstraints: ["只写输出目录"],
	acceptance: ["verify pass"],
	forbidden: [],
	context: "",
};

function makePi(initialActiveTools = ["read", "bash", "edit", "write", "subagent"]) {
	const commands = new Map<string, any>();
	const tools: any[] = [];
	const handlers = new Map<string, Function[]>();
	const entries: Array<{ customType: string; data: unknown }> = [];
	let currentActiveTools = [...initialActiveTools];
	return {
		commands,
		handlers,
		entries,
		tools,
		pi: {
			registerCommand(name: string, options: any) {
				commands.set(name, options);
			},
			registerTool(tool: any) {
				tools.push(tool);
			},
			appendEntry(customType: string, data: unknown) {
				entries.push({ customType, data });
			},
			getActiveTools() {
				return [...currentActiveTools];
			},
			setActiveTools(names: string[]) {
				currentActiveTools = [...names];
			},
			sendUserMessage() {},
			on(event: string, handler: Function) {
				handlers.set(event, [...(handlers.get(event) ?? []), handler]);
			},
		},
	};
}

function makeCtx(cwd = mkdtempSync(path.join(os.tmpdir(), "ugk-subtask-tool-"))) {
	return {
		cwd,
		ctx: {
			cwd,
			sessionManager: { getEntries: () => [] },
			ui: {
				notify() {},
				select(_title: string, options: string[]) {
					return options[0];
				},
				setStatus() {},
				setWidget() {},
				editor(_title: string, value: string) {
					return value;
				},
				input(_title: string, value: string) {
					return value;
				},
				confirm() {
					return true;
				},
			},
		},
	};
}

function workerOk(summary = "done") {
	return {
		agent: "worker",
		agentSource: "user",
		task: "task",
		model: "deepseek-v4-pro",
		exitCode: 0,
		messages: [{ role: "assistant", content: [{ type: "text", text: summary }] }],
		stderr: "",
		usage: { input: 1000000, output: 200000, cacheRead: 10000, cacheWrite: 0, cost: 0.02, contextTokens: 1210000, turns: 1 },
	} as any;
}

async function saveFixtureTask(cwd: string, name: string, verify = "process.exit(0);\n") {
	await saveTaskbook("project", cwd, name, {
		description: `${name} description`,
		spec,
		skill: "# Skill",
		verify,
		contract: { runtimeInput: ["text"], artifacts: [{ name: "report.txt", type: "file", required: true }] },
	});
}

test("buildTaskbookPrompt lists task names, descriptions, and input fields", async () => {
	const { cwd } = makeCtx();
	try {
		await saveFixtureTask(cwd, "alpha");
		await saveFixtureTask(cwd, "beta");
		await saveTaskbook("project", cwd, "defaults", {
			description: "defaulted description",
			spec,
			skill: "# Skill",
			verify: "process.exit(0);\n",
			contract: {
				runtimeInput: ["topN", "section"],
				runtimeInputMeta: {
					topN: { type: "integer", default: 10 },
					section: { type: "string", default: "技术" },
				},
				artifacts: [],
			},
		});
		await saveTaskbook("project", cwd, "enumed", {
			description: "enumed description",
			spec,
			skill: "# Skill",
			verify: "process.exit(0);\n",
			contract: {
				runtimeInput: ["verbosity"],
				runtimeInputMeta: {
					verbosity: { default: "normal", allowedValues: ["normal", "talkative"] },
				},
				artifacts: [],
			},
		});

		const prompt = await buildTaskbookPrompt(cwd);

		assert.match(prompt, /## 可用 task/);
		assert.match(prompt, /- alpha — alpha description/);
		assert.match(prompt, /- beta — beta description/);
		assert.match(prompt, /input: text/);
		assert.match(prompt, /defaults — defaulted description \(input: topN=10, section=技术\)/);
		assert.match(prompt, /enumed — enumed description \(input: verbosity=normal\{normal\|talkative\}\)/);
		assert.doesNotMatch(prompt, /contract\.json/);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("run_task single returns machine-verifiable PASS and records the run", async () => {
	const { pi, tools } = makePi();
	const { cwd, ctx } = makeCtx();
	registerTask(pi as any);
	setTaskWorkerRunnerForTests(async () => workerOk("写好了"));
	setTaskDispatcherForTests(async () => ({ text: "hello" }));
	try {
		await saveFixtureTask(cwd, "single-pass", "import {writeFile} from 'node:fs/promises'; await writeFile(`${process.env.TASK_OUTPUT_DIR}/report.txt`, 'ok', 'utf8'); process.exit(0);\n");
		const tool = tools.find((item) => item.name === "run_task");

		const result = await tool.execute("call-1", { name: "single-pass", input: "hello" }, undefined, undefined, ctx);
		const loaded = await loadTaskbook(cwd, "single-pass");

		assert.equal(result.isError, undefined);
		assert.match(result.content[0].text, /PASS/);
		assert.equal(result.details.results[0].status, "pass");
		assert.equal(path.isAbsolute(result.details.results[0].outputDir), true);
		assert.equal(result.details.results[0].artifacts.length, 1);
		assert.equal(loaded?.taskbook.runs.at(-1)?.status, "pass");
		assert.deepEqual(loaded?.taskbook.runs.at(-1)?.input, { text: "hello" });
		// ponytail: 不 terminate。agent 拿到 PASS/FAIL 后自行决定是否结束或继续下一步
		// (如"先抓列表再下载"的组合编排)。terminate 会截断多步编排的第一步。
		assert.notEqual(result.terminate, true, "run_task 不应 terminate,要让 agent 决定是否继续");
		assert.match(result.details.results[0].workerSummary, /写好了/, "workerSummary 仍在 details");
		assert.equal(result.details.results[0].model, "deepseek-v4-pro");
		assert.deepEqual(result.details.results[0].usage, {
			input: 1000000,
			output: 200000,
			cacheRead: 10000,
			cacheWrite: 0,
			cost: 0.02,
		});
		assert.doesNotMatch(result.content[0].text, /workerSummary/, "workerSummary 不进 LLM context");
		// ponytail: phases 纯诊断,落盘进 run 记录(回答"到底慢在哪")。
		const runPhases = loaded?.taskbook.runs.at(-1)?.phases;
		assert.equal(typeof runPhases?.workerMs, "number", "workerMs 记录落盘");
		assert.equal(typeof runPhases?.verifyMs, "number", "verifyMs 记录落盘");
	} finally {
		setTaskWorkerRunnerForTests(undefined);
		setTaskDispatcherForTests(undefined);
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("run_task single shows startup widget before worker output", async () => {
	const { pi, tools } = makePi();
	const { cwd, ctx } = makeCtx();
	const widgetCalls: Array<{ key: string; lines: string[] | undefined }> = [];
	ctx.ui.setWidget = (key: string, lines: string[] | undefined) => {
		widgetCalls.push({ key, lines });
	};
	let sawWorkerStartup = false;
	let sawWorkerRunning = false;
	registerTask(pi as any);
	setTaskWorkerRunnerForTests(async () => {
		sawWorkerStartup = widgetCalls.some((call) =>
			call.key === "task-run-view" &&
			(call.lines ?? []).join("\n").includes("正在装载 subagent(worker)"));
		sawWorkerRunning = widgetCalls.some((call) =>
			call.key === "task-run-view" &&
			(call.lines ?? []).join("\n").includes("subagent(worker) 执行中"));
		return workerOk("done");
	});
	setTaskDispatcherForTests(async () => ({ text: "hello" }));
	try {
		await saveFixtureTask(cwd, "startup-widget");
		const tool = tools.find((item) => item.name === "run_task");

		await tool.execute("call-1", { name: "startup-widget", input: "hello" }, undefined, undefined, ctx);

		assert.ok(widgetCalls.some((call) => (call.lines ?? []).join("\n").includes("run_task 已启动")));
		assert.equal(sawWorkerStartup, true, "worker 启动前应已有装载提示");
		assert.equal(sawWorkerRunning, true, "worker 已开始执行时不应继续停在装载提示");
		assert.equal(widgetCalls.at(-1)?.lines, undefined, "run_task 结束后清掉 widget");
	} finally {
		setTaskWorkerRunnerForTests(undefined);
		setTaskDispatcherForTests(undefined);
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("run_task missing taskbook returns available task names as a tool error", async () => {
	const { pi, tools } = makePi();
	const { cwd, ctx } = makeCtx();
	registerTask(pi as any);
	try {
		await saveFixtureTask(cwd, "known");
		const tool = tools.find((item) => item.name === "run_task");

		const result = await tool.execute("call-1", { name: "missing", input: "hello" }, undefined, undefined, ctx);

		assert.equal(result.isError, true);
		assert.match(result.content[0].text, /missing/);
		assert.match(result.content[0].text, /known/);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("run_task fails cleanly when dispatcher cannot parse input (no UI prompt)", async () => {
	const { pi, tools } = makePi();
	const { cwd, ctx } = makeCtx();
	let inputPrompted = 0;
	ctx.ui.input = () => {
		inputPrompted += 1;
		return "should-not-reach";
	};
	registerTask(pi as any);
	setTaskDispatcherForTests(async () => undefined);
	try {
		await saveFixtureTask(cwd, "needs-input");
		const tool = tools.find((item) => item.name === "run_task");

		const result = await tool.execute("call-1", { name: "needs-input", input: "含糊不清的输入" }, undefined, undefined, ctx);

		assert.equal(result.isError, true);
		assert.equal(inputPrompted, 0);
		assert.match(result.content[0].text, /runtimeInput|解析/);
	} finally {
		setTaskDispatcherForTests(undefined);
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("taskbook prompt is injected before agent starts after session_start", async () => {
	const { pi, handlers } = makePi();
	const { cwd, ctx } = makeCtx();
	registerTask(pi as any);
	try {
		await saveFixtureTask(cwd, "injectable");

		await handlers.get("session_start")![0]({}, ctx);
		const injected = await handlers.get("before_agent_start")![0]({}, ctx);

		assert.match(injected.systemPrompt, /injectable/);
		assert.equal(injected.message, undefined);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("run_task parallel confirms protected tools once for the batch", async () => {
	const { pi, tools } = makePi(["read", "bash", "chrome_cdp"]);
	const { cwd, ctx } = makeCtx();
	let confirmCount = 0;
	ctx.ui.confirm = () => {
		confirmCount += 1;
		return true;
	};
	registerTask(pi as any);
	setTaskWorkerRunnerForTests(async () => workerOk("done"));
	setTaskDispatcherForTests(async (_ctx, _skill, _contract, rawInput) => ({ text: rawInput }));
	try {
		await saveTaskbook("project", cwd, "protected-a", {
			description: "protected a",
			spec,
			skill: "Use chrome_cdp.",
			verify: "process.exit(0);\n",
			contract: { requiredTools: ["chrome_cdp"], artifacts: [] },
		});
		await saveTaskbook("project", cwd, "protected-b", {
			description: "protected b",
			spec,
			skill: "Use chrome_cdp.",
			verify: "process.exit(0);\n",
			contract: { requiredTools: ["chrome_cdp"], artifacts: [] },
		});
		const tool = tools.find((item) => item.name === "run_task");

		const result = await tool.execute("call-1", {
			tasks: [
				{ name: "protected-a", input: "one" },
				{ name: "protected-b", input: "two" },
			],
		}, undefined, undefined, ctx);

		assert.equal(result.isError, undefined);
		assert.equal(confirmCount, 1);
	} finally {
		setTaskWorkerRunnerForTests(undefined);
		setTaskDispatcherForTests(undefined);
		rmSync(cwd, { recursive: true, force: true });
	}
});

// ponytail: parallel 入口集中 hydrate 去重。两个 task 声明同一个 requiredEnv,reader 只应被调一次
// (去重后),不是 N×M 次。钉死回归:若 hydrate 退回 executeSubtask 内部各调,reader 会被调 2 次。
test("run_task parallel hydrates requiredEnv once for the batch (dedup)", async () => {
	const { pi, tools } = makePi();
	const { cwd, ctx } = makeCtx();
	const envName = "UGK_TEST_PARALLEL_HYDRATE";
	const previous = process.env[envName];
	delete process.env[envName];
	let readerCalls = 0;
	registerTask(pi as any);
	setTaskWorkerRunnerForTests(async () => workerOk("done"));
	setTaskDispatcherForTests(async (_ctx, _skill, _contract, rawInput) => ({ text: rawInput }));
	// mock reader:模拟 Windows User env 有值,hydrate 后填进 process.env
	setWindowsUserEnvReaderForTests(async (name) => {
		readerCalls += 1;
		return name === envName ? "hydrated-value" : undefined;
	});
	try {
		await saveTaskbook("project", cwd, "needs-env-a", {
			description: "needs env a",
			spec,
			skill: "# Skill",
			verify: "process.exit(0);\n",
			contract: { runtimeInput: [], artifacts: [], requiredEnv: [envName] },
		});
		await saveTaskbook("project", cwd, "needs-env-b", {
			description: "needs env b",
			spec,
			skill: "# Skill",
			verify: "process.exit(0);\n",
			contract: { runtimeInput: [], artifacts: [], requiredEnv: [envName] },
		});
		const tool = tools.find((item) => item.name === "run_task");

		const result = await tool.execute("call-1", {
			tasks: [
				{ name: "needs-env-a", input: "one" },
				{ name: "needs-env-b", input: "two" },
			],
		}, undefined, undefined, ctx);

		assert.equal(result.isError, undefined, "批次应成功(hydrate 后 env 就位)");
		assert.equal(readerCalls, 1, "reader 应只调一次(批次级去重),实际: " + readerCalls);
		assert.equal(process.env[envName], "hydrated-value", "hydrate 应把值填进 process.env");
		const loadedA = await loadTaskbook(cwd, "needs-env-a");
		assert.equal(loadedA?.taskbook.runs.at(-1)?.status, "pass");
	} finally {
		setTaskWorkerRunnerForTests(undefined);
		setTaskDispatcherForTests(undefined);
		setWindowsUserEnvReaderForTests(undefined);
		if (previous === undefined) delete process.env[envName];
		else process.env[envName] = previous;
		rmSync(cwd, { recursive: true, force: true });
	}
});

// ponytail: parallel 路径缺 binary —— 该 task FAIL(workerSummary 含安装提示),不炸批次,
// 其他 task 正常执行。钉死 task 可移植闭环:依赖缺失不污染并发兄弟。
test("run_task parallel FAILs the missing-binary task without breaking the batch", async () => {
	const { pi, tools } = makePi();
	const { cwd, ctx } = makeCtx();
	registerTask(pi as any);
	setTaskWorkerRunnerForTests(async () => workerOk("done"));
	setTaskDispatcherForTests(async (_ctx, _skill, _contract, rawInput) => ({ text: rawInput }));
	try {
		await saveTaskbook("project", cwd, "missing-bin", {
			description: "missing bin",
			spec,
			skill: "# Skill",
			verify: "process.exit(0);\n",
			contract: { runtimeInput: [], artifacts: [], requiredBinaries: ["definitely-missing-xyz-12345"] },
		});
		await saveTaskbook("project", cwd, "has-node", {
			description: "has node",
			spec,
			skill: "# Skill",
			verify: "process.exit(0);\n",
			contract: { runtimeInput: [], artifacts: [], requiredBinaries: ["node"] },
		});
		const tool = tools.find((item) => item.name === "run_task");

		const result = await tool.execute("call-1", {
			tasks: [
				{ name: "missing-bin", input: "a" },
				{ name: "has-node", input: "b" },
			],
		}, undefined, undefined, ctx);

		// 批次不炸(没有 isError),各 task 独立结果
		assert.equal(result.isError, undefined, "批次不应被单个缺 binary 任务炸掉");
		const results = result.details.results;
		const missingBinResult = results.find((r: any) => r.name === "missing-bin");
		const hasNodeResult = results.find((r: any) => r.name === "has-node");
		assert.equal(missingBinResult.status, "fail");
		assert.match(missingBinResult.workerSummary, /definitely-missing-xyz-12345/);
		assert.match(missingBinResult.workerSummary, /重新调用 run_task/);
		assert.equal(hasNodeResult.status, "pass");
	} finally {
		setTaskWorkerRunnerForTests(undefined);
		setTaskDispatcherForTests(undefined);
		rmSync(cwd, { recursive: true, force: true });
	}
});

// ponytail: 会话级授权缓存。报告场景:main 反复 run_task 同一个 cdp taskbook 下视频,
// 每次都弹"允许受保护工具"打断用户。修复:本会话授权过该 taskbook 后不再弹。
test("run_task remembers protected-tool grant across calls in the same session", async () => {
	const { pi, tools } = makePi(["read", "bash", "chrome_cdp"]);
	const { cwd, ctx } = makeCtx();
	let confirmCount = 0;
	ctx.ui.confirm = () => {
		confirmCount += 1;
		return true;
	};
	registerTask(pi as any);
	setTaskWorkerRunnerForTests(async () => workerOk("done"));
	setTaskDispatcherForTests(async (_ctx, _skill, _contract, rawInput) => ({ text: rawInput }));
	resetTaskProtectedToolGrantsForTests();
	try {
		await saveTaskbook("project", cwd, "cdp-task", {
			description: "cdp task",
			spec,
			skill: "Use chrome_cdp.",
			verify: "process.exit(0);\n",
			contract: { requiredTools: ["chrome_cdp"], artifacts: [] },
		});
		const tool = tools.find((item) => item.name === "run_task");

		// 第一次:弹 confirm,授权入缓存
		await tool.execute("call-1", { name: "cdp-task", input: "one" }, undefined, undefined, ctx);
		assert.equal(confirmCount, 1, "首次调用弹一次 confirm");
		// 第二次:同 taskbook,本会话已授权 → 不再弹
		await tool.execute("call-2", { name: "cdp-task", input: "two" }, undefined, undefined, ctx);
		assert.equal(confirmCount, 1, "同 taskbook 第二次调用不该再弹 confirm");
		// 第三次:parallel 也复用缓存,不弹
		await tool.execute("call-3", {
			tasks: [
				{ name: "cdp-task", input: "a" },
				{ name: "cdp-task", input: "b" },
			],
		}, undefined, undefined, ctx);
		assert.equal(confirmCount, 1, "parallel 复用缓存,不弹 confirm");
	} finally {
		setTaskWorkerRunnerForTests(undefined);
		setTaskDispatcherForTests(undefined);
		resetTaskProtectedToolGrantsForTests();
		rmSync(cwd, { recursive: true, force: true });
	}
});

// ponytail: grant key 带 taskbook 工具集。报告场景:taskbook 编辑后新增了 mcp 工具,
// 旧缓存只记了 cdp → 新工具集没授权过 → 重新确认。防止免确认下发新受保护工具。
test("run_task re-confirms when a taskbook's protected-tool set changes", async () => {
	const { pi, tools } = makePi(["read", "bash", "chrome_cdp", "alpha__echo"]);
	const { cwd, ctx } = makeCtx();
	let confirmCount = 0;
	ctx.ui.confirm = () => {
		confirmCount += 1;
		return true;
	};
	registerTask(pi as any);
	setTaskWorkerRunnerForTests(async () => workerOk("done"));
	setTaskDispatcherForTests(async (_ctx, _skill, _contract, rawInput) => ({ text: rawInput }));
	resetTaskProtectedToolGrantsForTests();
	try {
		// 第一版:只用 chrome_cdp
		await saveTaskbook("project", cwd, "mixed-task", {
			description: "cdp task",
			spec,
			skill: "Use chrome_cdp.",
			verify: "process.exit(0);\n",
			contract: { requiredTools: ["chrome_cdp"], artifacts: [] },
		});
		const tool = tools.find((item) => item.name === "run_task");
		await tool.execute("call-1", { name: "mixed-task", input: "one" }, undefined, undefined, ctx);
		assert.equal(confirmCount, 1, "首次 cdp-only 授权,弹一次");
		// 第二次同工具集 → 命中缓存,不弹
		await tool.execute("call-2", { name: "mixed-task", input: "two" }, undefined, undefined, ctx);
		assert.equal(confirmCount, 1, "同工具集命中缓存,不弹");

		// 编辑 taskbook:加上 mcp 工具 alpha__echo
		await saveTaskbook("project", cwd, "mixed-task", {
			description: "cdp + mcp task",
			spec,
			skill: "Use chrome_cdp and alpha__echo.",
			verify: "process.exit(0);\n",
			contract: { requiredTools: ["chrome_cdp", "alpha__echo"], artifacts: [] },
		});
		await tool.execute("call-3", { name: "mixed-task", input: "three" }, undefined, undefined, ctx);
		assert.equal(confirmCount, 2, "工具集变了(cdp→cdp+mcp),必须重新确认");
	} finally {
		setTaskWorkerRunnerForTests(undefined);
		setTaskDispatcherForTests(undefined);
		resetTaskProtectedToolGrantsForTests();
		rmSync(cwd, { recursive: true, force: true });
	}
});

// ponytail: 只缓存真用 protected tool 的 taskbook。批次里夹带的纯 read taskbook 不入缓存,
// 也不影响 grant 判定 —— 它本来就不需要授权。
test("run_task batch only grants protected tools for taskbooks that actually use them", async () => {
	const { pi, tools } = makePi(["read", "bash", "chrome_cdp"]);
	const { cwd, ctx } = makeCtx();
	let confirmCount = 0;
	ctx.ui.confirm = () => {
		confirmCount += 1;
		return true;
	};
	registerTask(pi as any);
	setTaskWorkerRunnerForTests(async () => workerOk("done"));
	setTaskDispatcherForTests(async (_ctx, _skill, _contract, rawInput) => ({ text: rawInput }));
	resetTaskProtectedToolGrantsForTests();
	try {
		await saveTaskbook("project", cwd, "cdp-task", {
			description: "cdp task",
			spec,
			skill: "Use chrome_cdp.",
			verify: "process.exit(0);\n",
			contract: { requiredTools: ["chrome_cdp"], artifacts: [] },
		});
		await saveTaskbook("project", cwd, "plain-task", {
			description: "plain read task",
			spec,
			skill: "Just read.",
			verify: "process.exit(0);\n",
			contract: { requiredTools: ["read"], artifacts: [] },
		});
		const tool = tools.find((item) => item.name === "run_task");
		// parallel:cdp-task + plain-task 混批。confirm 只因 cdp-task 弹一次。
		await tool.execute("call-1", {
			tasks: [
				{ name: "cdp-task", input: "a" },
				{ name: "plain-task", input: "b" },
			],
		}, undefined, undefined, ctx);
		assert.equal(confirmCount, 1, "混批弹一次 confirm(覆盖 cdp-task)");
		// 再单独跑 plain-task:它不碰 protected tool → 不该弹 confirm
		await tool.execute("call-2", { name: "plain-task", input: "c" }, undefined, undefined, ctx);
		assert.equal(confirmCount, 1, "纯 read taskbook 不触发任何 protected-tool confirm");
	} finally {
		setTaskWorkerRunnerForTests(undefined);
		setTaskDispatcherForTests(undefined);
		resetTaskProtectedToolGrantsForTests();
		rmSync(cwd, { recursive: true, force: true });
	}
});

// ponytail: autopilot ON 时,run_task 的"受保护工具授权"确认被短路为直接放行。
// 这是第三条 autopilot 接入路径(CDP/MCP policy + run_task 受保护工具确认),与上面 off 路径互为镜像。
test("run_task skips protected-tool confirm when autopilot is on", async () => {
	installAutopilotState(createAutopilotState(true));
	try {
		const { pi, tools } = makePi(["read", "bash", "chrome_cdp"]);
		const { cwd, ctx } = makeCtx();
		let confirmCount = 0;
		ctx.ui.confirm = () => {
			confirmCount += 1;
			return true;
		};
		registerTask(pi as any);
		setTaskWorkerRunnerForTests(async () => workerOk("done"));
		setTaskDispatcherForTests(async (_ctx, _skill, _contract, rawInput) => ({ text: rawInput }));
		resetTaskProtectedToolGrantsForTests();
		try {
			await saveTaskbook("project", cwd, "protected-a", {
				description: "protected a",
				spec,
				skill: "Use chrome_cdp.",
				verify: "process.exit(0);\n",
				contract: { requiredTools: ["chrome_cdp"], artifacts: [] },
			});
			await saveTaskbook("project", cwd, "protected-b", {
				description: "protected b",
				spec,
				skill: "Use chrome_cdp.",
				verify: "process.exit(0);\n",
				contract: { requiredTools: ["chrome_cdp"], artifacts: [] },
			});
			const tool = tools.find((item) => item.name === "run_task");

			const result = await tool.execute("call-1", {
				tasks: [
					{ name: "protected-a", input: "one" },
					{ name: "protected-b", input: "two" },
				],
			}, undefined, undefined, ctx);

			assert.equal(result.isError, undefined);
			assert.equal(confirmCount, 0, "autopilot on 时受保护工具确认不该弹");
		} finally {
			setTaskWorkerRunnerForTests(undefined);
			setTaskDispatcherForTests(undefined);
			resetTaskProtectedToolGrantsForTests();
			rmSync(cwd, { recursive: true, force: true });
		}
	} finally {
		installAutopilotState(createAutopilotState(false));
	}
});

test("run_task parallel isolates a single task's execution failure from the batch", async () => {
	const { pi, tools } = makePi();
	const { cwd, ctx } = makeCtx();
	registerTask(pi as any);
	let callCount = 0;
	setTaskWorkerRunnerForTests(async () => {
		callCount += 1;
		if (callCount === 2) throw new Error("spawn crashed");
		return workerOk("done");
	});
	setTaskDispatcherForTests(async () => ({ text: "x" }));
	try {
		await saveFixtureTask(cwd, "good");
		await saveFixtureTask(cwd, "crashy");
		const tool = tools.find((item) => item.name === "run_task");

		const result = await tool.execute("call-1", {
			tasks: [{ name: "good", input: "a" }, { name: "crashy", input: "b" }],
		}, undefined, undefined, ctx);

		assert.equal(result.isError, undefined);
		assert.match(result.content[0].text, /1\/2 succeeded/);
		const failed = result.details.results.filter((item: any) => item.status === "fail");
		assert.equal(failed.length, 1);
		assert.match(failed[0].workerSummary, /spawn crashed/);
	} finally {
		setTaskWorkerRunnerForTests(undefined);
		setTaskDispatcherForTests(undefined);
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("run_task parallel isolates a single task's input-parse failure (does not abort the batch)", async () => {
	// 回归保护:parallel 模式下单个 task 的 resolveRuntimeInput 抛错(dispatcher 缺必填字段),
	// 不能上抛炸掉整个 run_task 工具(返回 isError + 空 results)。
	// 应转成该 task 的 FAIL,其他 task 正常返回。
	const { pi, tools } = makePi();
	const { cwd, ctx } = makeCtx();
	registerTask(pi as any);
	setTaskWorkerRunnerForTests(async () => workerOk("done"));
	// good 的 contract 不声明 required → 保守语义不门禁 → 部分输入也能解析成功
	// bad 的 contract 声明 required:text + 无 default → 解析失败抛错(模拟必填字段补不全)
	await saveFixtureTask(cwd, "good");
	await saveTaskbook("project", cwd, "gated", {
		description: "gated task",
		spec,
		skill: "do thing",
		verify: "process.exit(0);\n",
		contract: { runtimeInput: ["text"], runtimeInputMeta: { text: { required: true } }, artifacts: [] },
	});
	// dispatcher 对 good 返回完整 {text},对 gated 返回 undefined(模拟补不全必填)
	setTaskDispatcherForTests(async (_ctx: any, _skill: any, contract: any, _raw: string) => {
		const meta = contract?.runtimeInputMeta;
		return meta?.text?.required === true ? undefined : { text: "ok" };
	});
	try {
		const tool = tools.find((item) => item.name === "run_task");

		const result = await tool.execute("call-1", {
			tasks: [
				{ name: "good", input: "anything" },
				{ name: "gated", input: "incomplete" },
			],
		}, undefined, undefined, ctx);

		// 关键:不 isError(批次没被炸),两个 task 都有结果
		assert.equal(result.isError, undefined);
		assert.match(result.content[0].text, /1\/2 succeeded/);
		assert.equal(result.details.results.length, 2);
		const failed = result.details.results.filter((item: any) => item.status === "fail");
		assert.equal(failed.length, 1, "gated task FAIL,good task PASS");
	} finally {
		setTaskWorkerRunnerForTests(undefined);
		setTaskDispatcherForTests(undefined);
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("run_task parallel returns per-task output directories and aggregate count", async () => {
	const { pi, tools } = makePi();
	const { cwd, ctx } = makeCtx();
	registerTask(pi as any);
	setTaskWorkerRunnerForTests(async () => workerOk("done"));
	setTaskDispatcherForTests(async (_ctx, _skill, _contract, rawInput) => ({ text: rawInput }));
	// ponytail: 必须也 mock checker。否则 bad-task verify 失败后,runTaskWithRetry 会真实
	// spawn checker 子进程(runSingleAgent),在全量套件(无 API key/网络)下挂起数分钟。
	// 返回 abort 让重试内核立即停止,与"1/2 succeeded"断言一致。
	setTaskCheckerRunnerForTests(checkerAbortMock());
	try {
		await saveFixtureTask(cwd, "ok-task");
		await saveFixtureTask(cwd, "bad-task", "console.log(JSON.stringify([{assertion:'ok',expected:'true',actual:'false'}])); process.exit(1);\n");
		const tool = tools.find((item) => item.name === "run_task");

		const result = await tool.execute("call-1", {
			tasks: [
				{ name: "ok-task", input: "one" },
				{ name: "bad-task", input: "two" },
			],
		}, undefined, undefined, ctx);

		assert.match(result.content[0].text, /1\/2 succeeded/);
		assert.equal(result.details.results[0].status, "pass");
		assert.equal(result.details.results[1].status, "fail");
		assert.notEqual(result.details.results[0].outputDir, result.details.results[1].outputDir);
	} finally {
		setTaskWorkerRunnerForTests(undefined);
		setTaskDispatcherForTests(undefined);
		setTaskCheckerRunnerForTests(undefined);
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("run_task parallel does NOT terminate — lets the agent continue multi-step orchestration", async () => {
	const { pi, tools } = makePi();
	const { cwd, ctx } = makeCtx();
	registerTask(pi as any);
	setTaskWorkerRunnerForTests(async () => workerOk("done"));
	setTaskDispatcherForTests(async (_ctx, _skill, _contract, rawInput) => ({ text: rawInput }));
	try {
		await saveFixtureTask(cwd, "ok-task");
		const tool = tools.find((item) => item.name === "run_task");

		const result = await tool.execute("call-1", {
			tasks: [{ name: "ok-task", input: "one" }],
		}, undefined, undefined, ctx);

		// 所有模式都不 terminate:agent 拿到结果后自行决定是否继续编排下一步。
		assert.equal(result.isError, undefined);
		assert.notEqual(result.terminate, true, "parallel 模式不应 terminate,要让 agent 继续编排");
	} finally {
		setTaskWorkerRunnerForTests(undefined);
		setTaskDispatcherForTests(undefined);
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("task executing phase blocks nested run_task", async () => {
	const { pi, commands, handlers } = makePi();
	const { ctx } = makeCtx();
	registerTask(pi as any);

	await commands.get("task").handler("new", ctx);
	await handlers.get("tool_call")![0]({ toolName: "questionnaire" }, ctx);
	await handlers.get("agent_end")![0]({
		messages: [{ role: "assistant", content: [{ type: "text", text: `\`\`\`json\n${JSON.stringify(spec)}\n\`\`\`` }] }],
	}, ctx);
	await commands.get("task").handler("execute", ctx);

	const blocked = await handlers.get("tool_call")![0]({ toolName: "run_task", input: {} }, ctx);

	assert.equal(blocked.block, true);
	assert.match(blocked.reason, /禁止调用/);
});

// ponytail: run_task 现在和 /task run 一样有 worker→verify→checker→feedback 重试内核。
// 这组测试证明"worker 真的会带着失败信息回去改"——之前 run_task 零重试的核心缺口。
// verify 校验产出文件内容是合法 JSON:worker 第1次写非法 JSON → fail → checker 判 retry → 第2次写合法 → pass。

const JSON_VERIFY = `import { readFile } from 'node:fs/promises';
const raw = await readFile(process.env.TASK_OUTPUT_DIR + '/out.json', 'utf8').catch(() => '');
try { JSON.parse(raw); process.exit(0); }
catch (e) { console.log(JSON.stringify([{ assertion: 'json is valid', expected: 'valid JSON', actual: String(e.message) }])); process.exit(1); }
`;

// checker mock 返回 verdict=retry,提示修正 JSON
function checkerRetryMock() {
	return async () => ({
		agent: "checker",
		agentSource: "user",
		task: "task",
		exitCode: 0,
		messages: [{ role: "assistant", content: [{ type: "text", text: `\`\`\`json\n${JSON.stringify({ hint: "修正 JSON 语法", verdict: "retry", reason: "JSON 非法,可修" })}\n\`\`\`` }] }],
		stderr: "",
		model: "deepseek-v4-flash",
		usage: { input: 300000, output: 40000, cacheRead: 0, cacheWrite: 0, cost: 0.004, contextTokens: 340000, turns: 1 },
	} as any);
}

function checkerAbortMock() {
	return async () => ({
		agent: "checker",
		agentSource: "user",
		task: "task",
		exitCode: 0,
		messages: [{ role: "assistant", content: [{ type: "text", text: `\`\`\`json\n${JSON.stringify({ hint: "无法修复", verdict: "abort", reason: "死局" })}\n\`\`\`` }] }],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 },
	} as any);
}

// worker mock:按调用次数产出不同内容,内联在每个测试里(见下)。
// outputDir 从 worker prompt 文本里提取(真实 worker 也是从 prompt 知道路径,不走 env)。
function outputDirFromTask(task: string): string {
	const m = task.match(/所有产出必须落到:\s*(\S+)/);
	if (!m) throw new Error("outputDir not found in worker prompt");
	return m[1];
}

test("run_task retries worker after verify fail and passes on the second attempt", async () => {
	const { pi, tools } = makePi();
	const { cwd, ctx } = makeCtx();
	registerTask(pi as any);
	let workerCalls = 0;
	// ponytail: worker 第2次产出必须依赖 feedback —— prompt 里有"上一轮失败反馈"才写合法 JSON。
	// 这样如果 feedback 链路断了(checker→worker),第2次仍写非法,测试会失败,真正守住重试语义。
	const workerSpy = async (_d: unknown, _a: unknown, _n: string, task: string) => {
		workerCalls += 1;
		const { writeFile, mkdir } = await import("node:fs/promises");
		const dir = outputDirFromTask(task);
		await mkdir(dir, { recursive: true });
		const hasFeedback = /上一轮失败反馈/.test(task);
		await writeFile(path.join(dir, "out.json"), hasFeedback ? '{"ok": true}' : "{bad json", "utf8");
		return workerOk(hasFeedback ? "fixed" : "v1");
	};
	let checkerCalls = 0;
	setTaskWorkerRunnerForTests(workerSpy as any);
	setTaskCheckerRunnerForTests(async () => {
		checkerCalls += 1;
		return checkerRetryMock()();
	});
	setTaskDispatcherForTests(async () => ({ text: "x" }));
	try {
		await saveFixtureTask(cwd, "retry-pass", JSON_VERIFY);
		const tool = tools.find((item) => item.name === "run_task");

		const result = await tool.execute("call-1", { name: "retry-pass", input: "x" }, undefined, undefined, ctx);

		assert.equal(result.isError, undefined);
		assert.match(result.content[0].text, /PASS/);
		assert.equal(result.details.results[0].status, "pass");
		assert.equal(result.details.results[0].attempts, 2, "worker 应被调 2 次");
		assert.deepEqual(result.details.results[0].apiUsage, [
			{
				model: "deepseek-v4-pro",
				usage: { input: 2000000, output: 400000, cacheRead: 20000, cacheWrite: 0, cost: 0.04 },
			},
			{
				model: "deepseek-v4-flash",
				usage: { input: 300000, output: 40000, cacheRead: 0, cacheWrite: 0, cost: 0.004 },
			},
		]);
		assert.equal(workerCalls, 2);
		assert.equal(checkerCalls, 1, "checker 必须被调用以生成 feedback");
	} finally {
		setTaskWorkerRunnerForTests(undefined);
		setTaskCheckerRunnerForTests(undefined);
		setTaskDispatcherForTests(undefined);
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("run_task fails after exhausting all 4 attempts with verify failures", async () => {
	const { pi, tools } = makePi();
	const { cwd, ctx } = makeCtx();
	registerTask(pi as any);
	let workerCalls = 0;
	setTaskWorkerRunnerForTests(async (_d: unknown, _a: unknown, _n: string, task: string) => {
		workerCalls += 1;
		const { writeFile, mkdir } = await import("node:fs/promises");
		const dir = outputDirFromTask(task);
		await mkdir(dir, { recursive: true });
		// 一直写非法 JSON
		await writeFile(path.join(dir, "out.json"), "{always bad", "utf8");
		return workerOk("still bad");
	});
	setTaskCheckerRunnerForTests(checkerRetryMock());
	setTaskDispatcherForTests(async () => ({ text: "x" }));
	try {
		await saveFixtureTask(cwd, "retry-exhaust", JSON_VERIFY);
		const tool = tools.find((item) => item.name === "run_task");

		const result = await tool.execute("call-1", { name: "retry-exhaust", input: "x" }, undefined, undefined, ctx);

		assert.equal(result.details.results[0].status, "fail");
		assert.equal(result.details.results[0].attempts, 4, "maxRetry=3 共 4 次");
		assert.equal(workerCalls, 4);
		assert.ok(result.details.results[0].verifyFailures.length > 0, "带具体 verify 失败");
		assert.match(JSON.stringify(result.details.results[0].verifyFailures), /json is valid/);
	} finally {
		setTaskWorkerRunnerForTests(undefined);
		setTaskCheckerRunnerForTests(undefined);
		setTaskDispatcherForTests(undefined);
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("run_task stops early when checker judges abort", async () => {
	const { pi, tools } = makePi();
	const { cwd, ctx } = makeCtx();
	registerTask(pi as any);
	let workerCalls = 0;
	setTaskWorkerRunnerForTests(async (_d: unknown, _a: unknown, _n: string, task: string) => {
		workerCalls += 1;
		const { writeFile, mkdir } = await import("node:fs/promises");
		const dir = outputDirFromTask(task);
		await mkdir(dir, { recursive: true });
		await writeFile(path.join(dir, "out.json"), "{bad", "utf8");
		return workerOk("bad");
	});
	setTaskCheckerRunnerForTests(checkerAbortMock());
	setTaskDispatcherForTests(async () => ({ text: "x" }));
	try {
		await saveFixtureTask(cwd, "retry-abort", JSON_VERIFY);
		const tool = tools.find((item) => item.name === "run_task");

		const result = await tool.execute("call-1", { name: "retry-abort", input: "x" }, undefined, undefined, ctx);

		assert.equal(result.details.results[0].status, "fail");
		assert.equal(result.details.results[0].attempts, 1, "checker 判 abort,worker 只跑 1 次");
		assert.equal(workerCalls, 1);
	} finally {
		setTaskWorkerRunnerForTests(undefined);
		setTaskCheckerRunnerForTests(undefined);
		setTaskDispatcherForTests(undefined);
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("run_task reports clean FAIL with empty verifyFailures when worker fails without throwing", async () => {
	// ponytail: worker 返回 ok:false(非抛错)时,runTaskWithRetry 合成空 verifyResult。
	// 守住这条路径:verifyFailures 必须是 [](不是 undefined),status=fail,attempts=1,且 worker 不重试。
	const { pi, tools } = makePi();
	const { cwd, ctx } = makeCtx();
	registerTask(pi as any);
	let workerCalls = 0;
	let checkerCalls = 0;
	setTaskWorkerRunnerForTests(async () => {
		workerCalls += 1;
		// worker 失败但不抛:exitCode 1 + stderr → isFailedResult=true → ok:false
		return {
			agent: "worker",
			agentSource: "user",
			task: "task",
			exitCode: 1,
			messages: [{ role: "assistant", content: [{ type: "text", text: "worker crashed" }] }],
			stderr: "tool not found",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 },
		} as any;
	});
	setTaskCheckerRunnerForTests(async () => {
		checkerCalls += 1;
		return checkerRetryMock()();
	});
	setTaskDispatcherForTests(async () => ({ text: "x" }));
	try {
		await saveFixtureTask(cwd, "worker-fail", JSON_VERIFY);
		const tool = tools.find((item) => item.name === "run_task");

		const result = await tool.execute("call-1", { name: "worker-fail", input: "x" }, undefined, undefined, ctx);

		assert.equal(result.details.results[0].status, "fail");
		assert.equal(result.details.results[0].attempts, 1, "worker 失败不重试");
		assert.equal(workerCalls, 1);
		assert.equal(checkerCalls, 0, "worker 失败不调 checker");
		assert.deepEqual(result.details.results[0].verifyFailures, [], "未运行 verify,failures 为空数组非 undefined");
		assert.match(result.details.results[0].workerSummary, /tool not found/);
	} finally {
		setTaskWorkerRunnerForTests(undefined);
		setTaskCheckerRunnerForTests(undefined);
		setTaskDispatcherForTests(undefined);
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("formatPhaseBreakdown renders ms phases into readable seconds", () => {
	// ponytail: 纯展示函数。无 phases 时空;有时输出可读分段(回答"慢在哪")。
	assert.deepEqual(formatPhaseBreakdown(undefined), []);
	const lines = formatPhaseBreakdown({ workerFirstOutputMs: 12000, workerMs: 90000, verifyMs: 5000 });
	assert.ok(lines.some((l) => /worker 启动\+首轮: 12\.0s/.test(l)));
	assert.ok(lines.some((l) => /worker 整体: 90\.0s/.test(l)));
	assert.ok(lines.some((l) => /verify: 5\.0s/.test(l)));
	// worker 子进程内部细分:冷启动 / LLM 决策 / 工具执行(CDP/脚本)
	const detail = formatPhaseBreakdown({
		workerMs: 90000, verifyMs: 5000,
		"worker.coldStartMs": 8000, "worker.llmDecisionMs": 20000, "worker.toolMs": 60000,
	});
	assert.ok(detail.some((l) => /冷启动.*8\.0s/.test(l)), "细分冷启动");
	assert.ok(detail.some((l) => /LLM 决策.*20\.0s/.test(l)), "细分 LLM 决策");
	assert.ok(detail.some((l) => /工具执行.*60\.0s/.test(l)), "细分工具执行");
});
