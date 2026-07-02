import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { registerTask, getTaskCommandMenuOptions, resolveTaskCommandArgs, waitForTaskRunForTests, looksLikeMissingArtifact } from "../extensions/task/task.ts";
import { createTaskState, enterPlanning, enterReviewing, markPlanQuestionnaireUsed, markReviewQuestionnaireUsed, setTaskReviewResult, setTaskSpec, startExecuting } from "../extensions/task/task-state.ts";
import { appendRunToTaskbook, assertValidContract, loadTaskbook, saveTaskbook } from "../extensions/task/task-book.ts";
import { setTaskCheckerRunnerForTests } from "../extensions/task/task-checker.ts";
import { setTaskDispatcherForTests } from "../extensions/task/task-dispatcher.ts";
import { setTaskGuideRunnerForTests } from "../extensions/task/task-guide.ts";
import { buildTaskReviewPrompt, extractTaskReviewResult, TASK_ALIGN_PROMPT, TASK_REVIEW_PROMPT } from "../extensions/task/task-prompts.ts";
import { setTaskRunReviewerRunnerForTests } from "../extensions/task/task-run-reviewer.ts";
import { setTaskWorkerRunnerForTests } from "../extensions/task/task-worker.ts";

const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
const testAgentDir = mkdtempSync(path.join(os.tmpdir(), "ugk-task-extension-agent-"));
process.env.PI_CODING_AGENT_DIR = testAgentDir;
process.on("exit", () => {
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	rmSync(testAgentDir, { recursive: true, force: true });
});

const spec = {
	goal: "生成报告",
	hardConstraints: ["只输出 JSON"],
	acceptance: ["schema 通过"],
	forbidden: [],
	context: "",
};

test("task extension stays independent from plan, judge, CDP, and MCP modules", () => {
	const taskDir = path.resolve("extensions", "task");
	for (const file of readdirSync(taskDir).filter((name) => name.endsWith(".ts"))) {
		const source = readFileSync(path.join(taskDir, file), "utf8");
		assert.doesNotMatch(source, /from\s+["']\.\.\/(?:plan-mode|judge|chrome-cdp|mcp)\b/, `${file} should stay independent from other extension internals`);
	}
});

function makePi(initialActiveTools = ["read", "bash", "edit", "write", "subagent"]) {
	const commands = new Map<string, any>();
	const tools: any[] = [];
	const handlers = new Map<string, Function[]>();
	const entries: Array<{ customType: string; data: unknown }> = [];
	const renderers = new Map<string, Function>();
	const activeTools: string[][] = [];
	let currentActiveTools = [...initialActiveTools];
	const sentMessages: Array<{ message: any; options?: any }> = [];
	const userMessages: Array<{ text: string; options?: any }> = [];
	return {
		commands,
		handlers,
		entries,
		renderers,
		activeTools,
		sentMessages,
		userMessages,
		pi: {
			registerCommand(name: string, options: any) {
				commands.set(name, options);
			},
			registerTool(tool: any) {
				tools.push(tool);
			},
			registerMessageRenderer(customType: string, renderer: Function) {
				renderers.set(customType, renderer);
			},
			appendEntry(customType: string, data: unknown) {
				entries.push({ customType, data });
			},
			getActiveTools() {
				return [...currentActiveTools];
			},
			setActiveTools(names: string[]) {
				currentActiveTools = [...names];
				activeTools.push(names);
			},
			sendMessage(message: any, options?: any) {
				sentMessages.push({ message, options });
			},
			sendUserMessage(text: string, options?: any) {
				userMessages.push({ text, options });
			},
			on(event: string, handler: Function) {
				handlers.set(event, [...(handlers.get(event) ?? []), handler]);
			},
		},
		tools,
	};
}

function makeCtx(cwd = mkdtempSync(path.join(os.tmpdir(), "ugk-task-extension-"))) {
	const notifications: Array<{ message: string; type?: string }> = [];
	const selections: Array<{ title: string; options: string[] }> = [];
	const statusCalls: Array<{ key: string; value: unknown }> = [];
	const widgetCalls: Array<{ key: string; lines: string[] | undefined; options?: unknown }> = [];
	return {
		cwd,
		notifications,
		selections,
		statusCalls,
		widgetCalls,
		ctx: {
			cwd,
			sessionManager: { getEntries: () => [] },
			ui: {
				notify(message: string, type?: string) {
					notifications.push({ message, type });
				},
				select(title: string, options: string[]) {
					selections.push({ title, options });
					return options[0];
				},
				setStatus(key: string, value: unknown) {
					statusCalls.push({ key, value });
				},
				setWidget(key: string, lines: string[] | undefined, options?: unknown) {
					widgetCalls.push({ key, lines, options });
				},
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

function latestTaskMessage(sentMessages: Array<{ message: any; options?: any }>): string {
	const sent = [...sentMessages].reverse().find((item) => item.message?.customType === "task-message");
	assert.equal(sent?.message.display, true);
	assert.deepEqual(sent?.options, { triggerTurn: false });
	return sent?.message.content ?? "";
}

function mockTaskGuideRunner(text = "1. 来源方式: 使用现有来源\n2. 产物契约: 保留声明产物") {
	setTaskGuideRunnerForTests(async (_cwd, _agents, agentName, task) => ({
		agent: agentName,
		agentSource: "user",
		task,
		exitCode: 0,
		messages: [{ role: "assistant", content: [{ type: "text", text }] }],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 },
	}) as any);
}

test("task menu changes by phase and maps selection to action", async () => {
	const planning = setTaskSpec(enterPlanning(createTaskState()), spec);
	const executing = startExecuting(markPlanQuestionnaireUsed(planning));
	const reviewing = enterReviewing(executing, "done");

	assert.deepEqual(getTaskCommandMenuOptions(createTaskState()), ["新建任务", "运行 taskbook(复用)", "查看 taskbook 详情", "编辑 taskbook", "重命名 taskbook", "删除 taskbook", "上传到市场", "Exit"]);
	assert.deepEqual(getTaskCommandMenuOptions(enterPlanning(createTaskState())), ["继续对齐", "退出 Task", "Exit"]);
	assert.deepEqual(getTaskCommandMenuOptions(planning), ["开始执行", "继续对齐", "修改当前 Spec", "退出 Task", "Exit"]);
	assert.deepEqual(getTaskCommandMenuOptions(executing), ["进入复盘", "停止本次执行", "Exit"]);
	assert.deepEqual(getTaskCommandMenuOptions(reviewing), ["自动保存并自证", "继续复盘", "放弃", "退出 Task", "Exit"]);

	const { ctx } = makeCtx();
	ctx.ui.select = () => "运行 taskbook(复用)";
	assert.equal(await resolveTaskCommandArgs("", ctx, createTaskState()), "run");
	ctx.ui.select = () => "进入复盘";
	assert.equal(await resolveTaskCommandArgs("", ctx, executing), "continue-review");
	ctx.ui.select = () => "Exit";
	assert.equal(await resolveTaskCommandArgs("", ctx, createTaskState()), undefined);
	assert.equal(await resolveTaskCommandArgs("show foo", ctx, createTaskState()), "show foo");
});

test("registerTask registers /task list and show", async () => {
	const { pi, commands } = makePi();
	const { cwd, ctx, notifications } = makeCtx();
	registerTask(pi as any);
	mockTaskGuideRunner("1. 任务目标: 生成报告\n5. 产物契约: 未声明固定产物");

	try {
		await saveTaskbook("project", cwd, "report", {
			description: "生成报告",
			spec,
			skill: "# 生成报告\n",
			verify: "process.exit(0);\n",
			contract: { artifacts: [] },
			tags: ["task-extension-test"],
		});

		await commands.get("task").handler("list --tag task-extension-test", ctx);
		assert.match(notifications.at(-1)?.message ?? "", /report \[project\]/);

		await commands.get("task").handler("show report", ctx);
		assert.match(notifications.at(-1)?.message ?? "", /# task 导览: report \[project\]/);
		assert.match(notifications.at(-1)?.message ?? "", /1\. 任务目标/);
		assert.match(notifications.at(-1)?.message ?? "", /5\. 产物契约/);

		await commands.get("task").handler("show missing", ctx);
		assert.match(notifications.at(-1)?.message ?? "", /不存在/);
	} finally {
		setTaskGuideRunnerForTests(undefined);
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("task session restore and questionnaire flags persist state", async () => {
	const { pi, commands, handlers, entries } = makePi();
	const { ctx, statusCalls } = makeCtx();
	registerTask(pi as any);

	ctx.sessionManager.getEntries = () => [{
		customType: "task-state",
		data: { ...enterPlanning(createTaskState()), spec, planQuestionnaireUsed: false },
	}];
	await handlers.get("session_start")![0]({}, ctx);
	assert.deepEqual(statusCalls.at(-1), { key: "task-mode", value: "📋 task" });

	await handlers.get("tool_call")![0]({ toolName: "questionnaire" }, ctx);
	assert.equal((entries.at(-1)?.data as any).planQuestionnaireUsed, true);

	await commands.get("task").handler("exit", ctx);
	assert.equal((entries.at(-1)?.data as any).phase, "aborted");
	assert.deepEqual(statusCalls.at(-1), { key: "task-mode", value: undefined });
});

test("/task new enters planning, injects prompt, filters stale context, and parses Spec", async () => {
	const { pi, commands, handlers, activeTools, entries } = makePi();
	const { ctx, notifications } = makeCtx();
	registerTask(pi as any);

	await commands.get("task").handler("new", ctx);
	assert.deepEqual(activeTools.at(-1), ["read", "bash", "grep", "find", "ls", "questionnaire"]);

	const injected = await handlers.get("before_agent_start")![0]({}, ctx);
	assert.equal(injected.message.customType, "task-plan-context");
	assert.equal(injected.message.content, TASK_ALIGN_PROMPT);

	const oldContext = { role: "custom", customType: "task-plan-context", content: "old" };
	const newContext = { role: "custom", customType: "task-plan-context", content: "new" };
	const userMessage = { role: "user", content: [{ type: "text", text: "run" }] };
	const filtered = await handlers.get("context")![0]({ messages: [oldContext, userMessage, newContext] }, ctx);
	assert.deepEqual(filtered.messages, [userMessage, newContext]);

	await handlers.get("tool_call")![0]({ toolName: "questionnaire" }, ctx);
	await handlers.get("agent_end")![0]({
		messages: [{
			role: "assistant",
			content: [{ type: "text", text: `\`\`\`json\n${JSON.stringify(spec)}\n\`\`\`` }],
		}],
	}, ctx);

	assert.deepEqual((entries.at(-1)?.data as any).spec, spec);
	assert.match(notifications.at(-1)?.message ?? "", /Spec 已对齐/);
});

test("/task planning parse failure asks the planner to re-output RequirementsSpec JSON", async () => {
	const { pi, commands, handlers, userMessages } = makePi();
	const { ctx, notifications } = makeCtx();
	registerTask(pi as any);

	await commands.get("task").handler("new", ctx);
	await handlers.get("agent_end")![0]({
		messages: [{
			role: "assistant",
			content: [{ type: "text", text: "需求已经很清楚，我直接开始做。" }],
		}],
	}, ctx);

	assert.match(notifications.at(-1)?.message ?? "", /Task planning did not find/);
	assert.match(userMessages.at(-1)?.text ?? "", /重新输出/);
	assert.match(userMessages.at(-1)?.text ?? "", /RequirementsSpec/);
});

test("task pending transition opens the next-step menu in TUI", async () => {
	const { pi, commands, handlers, activeTools, entries } = makePi();
	const { ctx } = makeCtx();
	(ctx as any).hasUI = true;
	ctx.ui.select = () => "开始执行";
	registerTask(pi as any);

	await commands.get("task").handler("new", ctx);
	await handlers.get("tool_call")![0]({ toolName: "questionnaire" }, ctx);
	await handlers.get("agent_end")![0]({
		messages: [{
			role: "assistant",
			content: [{ type: "text", text: `\`\`\`json\n${JSON.stringify(spec)}\n\`\`\`` }],
		}],
	}, ctx);

	assert.equal((entries.at(-1)?.data as any).phase, "executing");
	assert.deepEqual(activeTools.at(-1), ["read", "bash", "edit", "write", "task_complete"]);
});

test("task planning blocks side-effecting bash and removes plan context when inactive", async () => {
	const { pi, commands, handlers } = makePi();
	const { ctx } = makeCtx();
	registerTask(pi as any);

	await commands.get("task").handler("new", ctx);
	const safe = await handlers.get("tool_call")![0]({ toolName: "bash", input: { command: "git status --short" } }, ctx);
	assert.equal(safe, undefined);
	const blocked = await handlers.get("tool_call")![0]({ toolName: "bash", input: { command: "npm install" } }, ctx);
	assert.deepEqual(blocked, {
		block: true,
		reason: "Task planning: command blocked (destructive or side-effecting). Command: npm install",
	});

	await commands.get("task").handler("exit", ctx);
	const staleContext = { role: "custom", customType: "task-plan-context", content: "old" };
	const filtered = await handlers.get("context")![0]({ messages: [staleContext] }, ctx);
	assert.deepEqual(filtered.messages, []);
});

test("task planning allows exploratory bash under C-3", async () => {
	const { pi, commands, handlers } = makePi();
	const { ctx } = makeCtx();
	registerTask(pi as any);

	await commands.get("task").handler("new", ctx);
	for (const cmd of ["node build.js", "npm test", "npm run lint", "python parse.py", "node -e \"console.log(1)\""]) {
		const result = await handlers.get("tool_call")![0]({ toolName: "bash", input: { command: cmd } }, ctx);
		assert.equal(result, undefined, `${cmd} should be allowed in planning under C-3`);
	}
	for (const cmd of ["npm install", "echo x > out.txt", "git commit -m x"]) {
		const result = await handlers.get("tool_call")![0]({ toolName: "bash", input: { command: cmd } }, ctx);
		assert.equal(result?.block, true, `${cmd} should be blocked in planning under C-3`);
	}

	await commands.get("task").handler("exit", ctx);
});

test("TASK_ALIGN_PROMPT requires questionnaire extras and machine-checkable acceptance", () => {
	assert.match(TASK_ALIGN_PROMPT, /questionnaire/);
	assert.match(TASK_ALIGN_PROMPT, /id="extras"/);
	assert.match(TASK_ALIGN_PROMPT, /你还有什么要补充的吗\?\(没有可留空\)/);
	assert.match(TASK_ALIGN_PROMPT, /machine-checkable/);
	assert.match(TASK_ALIGN_PROMPT, /进入 executing 阶段/);
});

test("/task execute enforces C-2 and switches to non-subagent tools", async () => {
	const { pi, commands, handlers, activeTools, userMessages, entries } = makePi();
	const { ctx, notifications, statusCalls } = makeCtx();
	registerTask(pi as any);

	await commands.get("task").handler("new", ctx);
	await handlers.get("agent_end")![0]({
		messages: [{
			role: "assistant",
			content: [{ type: "text", text: `\`\`\`json\n${JSON.stringify(spec)}\n\`\`\`` }],
		}],
	}, ctx);
	await commands.get("task").handler("execute", ctx);
	assert.match(notifications.at(-1)?.message ?? "", /未用 questionnaire/);
	assert.match(userMessages.at(-1)?.text ?? "", /questionnaire/);

	await handlers.get("tool_call")![0]({ toolName: "questionnaire" }, ctx);
	await commands.get("task").handler("execute", ctx);
	assert.deepEqual(activeTools.at(-1), ["read", "bash", "edit", "write", "task_complete"]);
	assert.equal((entries.at(-1)?.data as any).phase, "executing");
	assert.deepEqual(statusCalls.at(-1), { key: "task-mode", value: "🔧 executing" });
	assert.match(userMessages.at(-1)?.text ?? "", /不要调用 subagent/);
});

test("RPC input can advance an Enter-gated task transition", async () => {
	const { pi, commands, handlers, activeTools, entries } = makePi();
	const { ctx } = makeCtx();
	registerTask(pi as any);

	await commands.get("task").handler("new", ctx);
	await handlers.get("tool_call")![0]({ toolName: "questionnaire" }, ctx);
	await handlers.get("agent_end")![0]({
		messages: [{
			role: "assistant",
			content: [{ type: "text", text: `\`\`\`json\n${JSON.stringify(spec)}\n\`\`\`` }],
		}],
	}, ctx);

	await handlers.get("input")![0]({ source: "rpc", text: "" }, ctx);

	assert.deepEqual(activeTools.at(-1), ["read", "bash", "edit", "write", "task_complete"]);
	assert.equal((entries.at(-1)?.data as any).phase, "executing");
});

test("task review prompt parses skill verify contract output", () => {
	const prompt = buildTaskReviewPrompt(spec, "写入 output/report.json");
	assert.match(prompt, /TASK REVIEW MODE/);
	assert.match(prompt, /RequirementsSpec/);
	assert.match(prompt, /ExecutionSummary/);
	assert.match(TASK_REVIEW_PROMPT, /id="extras"/);
	assert.match(TASK_REVIEW_PROMPT, /SKILL DESIGN GATE/);
	assert.match(TASK_REVIEW_PROMPT, /source\/method/);
	assert.match(TASK_REVIEW_PROMPT, /required steps/);
	assert.match(TASK_REVIEW_PROMPT, /noise to omit/);
	assert.match(TASK_REVIEW_PROMPT, /output path and format/);
	assert.match(TASK_REVIEW_PROMPT, /contract\.outputDir/);
	assert.match(TASK_REVIEW_PROMPT, /requiredTools/);
	assert.match(TASK_REVIEW_PROMPT, /runtimeInputMeta/);
	assert.match(TASK_REVIEW_PROMPT, /VERIFY DESIGN GATE/);
	assert.match(TASK_REVIEW_PROMPT, /artifacts/);
	assert.match(TASK_REVIEW_PROMPT, /assertions/);
	assert.match(TASK_REVIEW_PROMPT, /failure cases/);
	assert.match(TASK_REVIEW_PROMPT, /runtime input/);
	assert.match(TASK_REVIEW_PROMPT, /allowed variability/);
	assert.match(TASK_REVIEW_PROMPT, /empty-output negative case/);
	assert.match(TASK_REVIEW_PROMPT, /process\.cwd\(\)/);
	assert.match(TASK_REVIEW_PROMPT, /import\.meta\.url/);
	assert.match(TASK_REVIEW_PROMPT, /VerifyFailure\[\]/);
	assert.match(TASK_REVIEW_PROMPT, /\{"failures":\[/);

	const parsed = extractTaskReviewResult(`\`\`\`json
{
  "description": "生成报告",
  "tags": ["report"],
  "skill": "# Skill",
  "verify": "process.exit(0)",
  "contract": {"artifacts":[]}
}
\`\`\``);
	assert.deepEqual(parsed, {
		description: "生成报告",
		tags: ["report"],
		skill: "# Skill",
		verify: "process.exit(0)",
		contract: { artifacts: [] },
	});
	assert.equal(extractTaskReviewResult("{}"), undefined);
});

test("assertValidContract rejects malformed runtimeInput so save never reaches the throw site", () => {
	const good = extractTaskReviewResult(`\`\`\`json
{
  "skill": "# Skill",
  "verify": "process.exit(0)",
  "contract": { "runtimeInput": ["topic"], "runtimeInputMeta": { "topic": { "default": "x" } } }
}
\`\`\``);
	assert.ok(good, "well-formed review result must parse");
	assert.doesNotThrow(() => assertValidContract(good!.contract));

	// ponytail: 修复回归 — LLM 误把 runtimeInput 写成对象时,解析能过但 contract 非法。
	// 在解析阶段就拦住,不让 reviewResult 进 state 后才在 saveTaskbook 抛错。
	const badRuntimeInput = extractTaskReviewResult(`\`\`\`json
{
  "skill": "# Skill",
  "verify": "process.exit(0)",
  "contract": { "runtimeInput": { "topic": "something" } }
}
\`\`\``);
	assert.ok(badRuntimeInput, "malformed-runtimeInput review result still parses at extract layer");
	assert.throws(() => assertValidContract(badRuntimeInput!.contract), /Invalid contract\.runtimeInput/);

	// runtimeInputMeta 里出现 runtimeInput 未声明的字段,同样拒绝
	const orphanMeta = extractTaskReviewResult(`\`\`\`json
{
  "skill": "# Skill",
  "verify": "process.exit(0)",
  "contract": { "runtimeInput": [], "runtimeInputMeta": { "ghost": {} } }
}
\`\`\``);
	assert.ok(orphanMeta);
	assert.throws(() => assertValidContract(orphanMeta!.contract), /not declared in runtimeInput/);
});

test("task edit prompt keeps questionnaire focused on the user edit request", () => {
	const prompt = buildTaskReviewPrompt(spec, "existing taskbook", "md only, no html");

	assert.match(prompt, /UserEditRequest:/);
	assert.match(prompt, /md only, no html/);
	assert.match(prompt, /Do NOT re-confirm unchanged source\/method\/runtime\/tool choices/);
	assert.match(prompt, /ask only about the requested change/);
	assert.match(prompt, /md-only output\/artifact\/verification/);
});

test("/task execute keeps environment tools, logs them, and blocks subagent via tool_call", async () => {
	// 模拟 main session 装了 chrome_cdp(环境工具),验证 execute 阶段保留它、只排除 subagent
	const { pi, commands, handlers, activeTools, entries } = makePi(["read", "bash", "edit", "write", "subagent", "chrome_cdp", "alpha__echo"]);
	const { ctx } = makeCtx();
	registerTask(pi as any);

	await commands.get("task").handler("new", ctx);
	await handlers.get("tool_call")![0]({ toolName: "questionnaire" }, ctx);
	await handlers.get("agent_end")![0]({
		messages: [{
			role: "assistant",
			content: [{ type: "text", text: `\`\`\`json\n${JSON.stringify(spec)}\n\`\`\`` }],
		}],
	}, ctx);
	await commands.get("task").handler("execute", ctx);

	// execute 工具集保留 chrome_cdp,排除 subagent,末尾补 task_complete
	assert.deepEqual(activeTools.at(-1), ["read", "bash", "edit", "write", "chrome_cdp", "alpha__echo", "task_complete"]);
	await handlers.get("tool_call")![0]({ toolName: "alpha__echo", input: { query: "ping" } }, ctx);
	assert.match((entries.at(-1)?.data as any).executeProcessLog.at(-1).toolName, /alpha__echo/);

	// subagent 调用被 tool_call 硬 block(双保险,spec 4.2)
	const blocked = await handlers.get("tool_call")![0]({ toolName: "subagent", input: {} }, ctx);
	assert.deepEqual(blocked, {
		block: true,
		reason: "Task executing 阶段禁止调用 subagent(task-creator 必须亲手做)。",
	});
});

test("/task session restore keeps environment tools during executing", async () => {
	const { pi, handlers, activeTools } = makePi(["read", "bash", "edit", "write", "subagent", "chrome_cdp", "alpha__echo"]);
	const { ctx, statusCalls } = makeCtx();
	registerTask(pi as any);

	ctx.sessionManager.getEntries = () => [{
		customType: "task-state",
		data: startExecuting(markPlanQuestionnaireUsed(setTaskSpec(enterPlanning(createTaskState()), spec)), "run-dir"),
	}];
	await handlers.get("session_start")![0]({}, ctx);

	assert.deepEqual(activeTools.at(-1), ["read", "bash", "edit", "write", "chrome_cdp", "alpha__echo", "task_complete"]);
	assert.deepEqual(statusCalls.at(-1), { key: "task-mode", value: "🔧 executing" });
});

test("/task menu lets user enter review from executing with a completion summary", async () => {
	const { pi, commands, handlers, entries } = makePi();
	const { ctx, notifications } = makeCtx();
	registerTask(pi as any);

	await commands.get("task").handler("new", ctx);
	await handlers.get("tool_call")![0]({ toolName: "questionnaire" }, ctx);
	await handlers.get("agent_end")![0]({
		messages: [{
			role: "assistant",
			content: [{ type: "text", text: `\`\`\`json\n${JSON.stringify(spec)}\n\`\`\`` }],
		}],
	}, ctx);
	await commands.get("task").handler("execute", ctx);

	ctx.ui.select = () => "进入复盘";
	ctx.ui.input = () => "已完成报告抓取";
	await commands.get("task").handler("", ctx);

	const latestState = entries.at(-1)?.data as any;
	assert.equal(latestState.pendingTransition, "review");
	assert.match(latestState.summary, /AgentSummary: 已完成报告抓取/);
	assert.match(notifications.at(-1)?.message ?? "", /请选择下一步/);
});

test("/task menu enters review when execute completion is already pending", async () => {
	const { pi, commands, handlers, entries, activeTools, sentMessages } = makePi();
	const { ctx, statusCalls } = makeCtx();
	registerTask(pi as any);

	await commands.get("task").handler("new", ctx);
	await handlers.get("tool_call")![0]({ toolName: "questionnaire" }, ctx);
	await handlers.get("agent_end")![0]({
		messages: [{
			role: "assistant",
			content: [{ type: "text", text: `\`\`\`json\n${JSON.stringify(spec)}\n\`\`\`` }],
		}],
	}, ctx);
	await commands.get("task").handler("execute", ctx);
	await commands.get("task").handler("continue-review 已完成报告抓取", ctx);

	ctx.ui.select = () => "进入复盘";
	await commands.get("task").handler("", ctx);

	assert.equal((entries.at(-1)?.data as any).phase, "reviewing");
	assert.deepEqual(activeTools.at(-1), ["read", "bash", "grep", "find", "ls", "questionnaire"]);
	assert.deepEqual(statusCalls.at(-1), { key: "task-mode", value: "📋 reviewing" });
	const reviewPrompt = sentMessages.at(-1);
	assert.equal(reviewPrompt?.message?.customType, "task-review-prompt");
	assert.match(reviewPrompt?.message?.content ?? "", /TASK REVIEW MODE/);
	assert.equal(reviewPrompt?.message?.display, true);
	assert.deepEqual(reviewPrompt?.options, { triggerTurn: true, deliverAs: "followUp" });
});

test("task_complete records process log and Enter gates review/save transitions", async () => {
	const { pi, commands, handlers, entries, activeTools, tools, sentMessages } = makePi();
	const { cwd, ctx, notifications, statusCalls } = makeCtx();
	registerTask(pi as any);

	try {
		assert.ok(tools.some((tool) => tool.name === "task_complete"));
		await commands.get("task").handler("new", ctx);
		await handlers.get("tool_call")![0]({ toolName: "questionnaire" }, ctx);
		await handlers.get("agent_end")![0]({
			messages: [{
				role: "assistant",
				content: [{ type: "text", text: `\`\`\`json\n${JSON.stringify(spec)}\n\`\`\`` }],
			}],
		}, ctx);
		await commands.get("task").handler("execute", ctx);
		await handlers.get("tool_call")![0]({ toolName: "bash", input: { command: "npm test" } }, ctx);
		await handlers.get("tool_call")![0]({ toolName: "write", input: { path: path.join(cwd, "report.json") } }, ctx);
		await handlers.get("tool_call")![0]({ toolName: "task_complete", input: { summary: "已生成 report.json" } }, ctx);

		assert.deepEqual(activeTools.at(-1), ["read", "bash", "edit", "write", "task_complete"]);
		assert.deepEqual(statusCalls.at(-1), { key: "task-mode", value: "🔧 executing" });
		assert.equal((entries.at(-1)?.data as any).phase, "executing");
		assert.ok((entries.at(-1)?.data as any).executeProcessLog.length >= 2);

		await handlers.get("tool_execution_end")![0]({ toolName: "task_complete", isError: false, result: { details: { summary: "已生成 report.json" } } }, ctx);
		assert.equal((entries.at(-1)?.data as any).phase, "executing");
		assert.equal((entries.at(-1)?.data as any).pendingTransition, "review");
		assert.match(notifications.at(-1)?.message ?? "", /请选择下一步/);

		await handlers.get("input")![0]({ source: "interactive", text: "" }, ctx);
		assert.deepEqual(activeTools.at(-1), ["read", "bash", "grep", "find", "ls", "questionnaire"]);
		assert.deepEqual(statusCalls.at(-1), { key: "task-mode", value: "📋 reviewing" });
		assert.equal((entries.at(-1)?.data as any).phase, "reviewing");
		const reviewPrompt = sentMessages.at(-1);
		assert.equal(reviewPrompt?.message?.customType, "task-review-prompt");
		assert.match(reviewPrompt?.message?.content ?? "", /TASK REVIEW MODE/);
		assert.equal(reviewPrompt?.message?.display, true);
		assert.deepEqual(reviewPrompt?.options, { triggerTurn: true, deliverAs: "followUp" });

		const injected = await handlers.get("before_agent_start")![0]({}, ctx);
		assert.equal(injected.message.customType, "task-review-context");
		assert.match(injected.message.content, /npm test/);
		assert.match(injected.message.content, /report\.json/);

		await handlers.get("tool_call")![0]({ toolName: "questionnaire" }, ctx);
		await handlers.get("agent_end")![0]({
			messages: [{
				role: "assistant",
				content: [{ type: "text", text: `\`\`\`json
{"description":"生成报告","skill":"# Skill","verify":"process.exit(0)","contract":{"artifacts":[]}}
\`\`\`` }],
			}],
		}, ctx);
		assert.equal((entries.at(-1)?.data as any).phase, "reviewing");
		assert.equal((entries.at(-1)?.data as any).pendingTransition, "save");
		assert.equal(await loadTaskbook(cwd, "my-task"), null);

		await handlers.get("input")![0]({ source: "interactive", text: "" }, ctx);
		assert.equal((entries.at(-1)?.data as any).phase, "landed");
		assert.match(notifications.at(-1)?.message ?? "", /已就绪/);
		assert.deepEqual(statusCalls.at(-1), { key: "task-mode", value: undefined });
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("/task review parse failure asks the reviewer to re-output machine-readable JSON", async () => {
	const { pi, handlers, userMessages } = makePi();
	const { ctx, notifications } = makeCtx();
	registerTask(pi as any);

	ctx.sessionManager.getEntries = () => [{
		customType: "task-state",
		data: enterReviewing(startExecuting(markPlanQuestionnaireUsed(setTaskSpec(enterPlanning(createTaskState()), spec)), "run-dir"), "done"),
	}];
	await handlers.get("session_start")![0]({}, ctx);

	await handlers.get("agent_end")![0]({
		messages: [{
			role: "assistant",
			content: [{ type: "text", text: `明白了。现在输出最终 taskbook JSON：

\`\`\`json
{
  "description": "x",
  "skill": "# Skill
\`\`\`bash
echo hi
\`\`\`",
  "verify": "process.exit(0)",
  "contract": {"artifacts":[]}
}
\`\`\`` }],
		}],
	}, ctx);

	assert.match(notifications.at(-1)?.message ?? "", /Task review did not find/);
	assert.match(userMessages.at(-1)?.text ?? "", /重新输出/);
	assert.match(userMessages.at(-1)?.text ?? "", /合法 JSON/);
	assert.match(userMessages.at(-1)?.text ?? "", /不要输出 markdown 代码块/);
});

test("/task review questionnaire cancellation does not trigger JSON retry loop", async () => {
	const { pi, handlers, userMessages, entries } = makePi();
	const { ctx, notifications } = makeCtx();
	registerTask(pi as any);

	ctx.sessionManager.getEntries = () => [{
		customType: "task-state",
		data: enterReviewing(startExecuting(markPlanQuestionnaireUsed(setTaskSpec(enterPlanning(createTaskState()), spec)), "run-dir"), "done"),
	}];
	await handlers.get("session_start")![0]({}, ctx);
	const entriesBefore = entries.length;

	await handlers.get("agent_end")![0]({
		messages: [{
			role: "assistant",
			content: [{ type: "text", text: "Operation aborted" }],
		}],
	}, ctx);

	assert.equal(userMessages.length, 0);
	assert.equal(entries.length, entriesBefore);
	assert.match(notifications.at(-1)?.message ?? "", /cancelled/);
});

test("/task planning questionnaire cancellation does not trigger spec retry loop", async () => {
	const { pi, handlers, userMessages, entries } = makePi();
	const { ctx, notifications } = makeCtx();
	registerTask(pi as any);

	ctx.sessionManager.getEntries = () => [{
		customType: "task-state",
		data: enterPlanning(createTaskState()),
	}];
	await handlers.get("session_start")![0]({}, ctx);
	const entriesBefore = entries.length;

	await handlers.get("agent_end")![0]({
		messages: [{
			role: "assistant",
			content: [{ type: "text", text: "User cancelled the questionnaire" }],
		}],
	}, ctx);

	assert.equal(userMessages.length, 0);
	assert.equal(entries.length, entriesBefore);
	assert.match(notifications.at(-1)?.message ?? "", /cancelled/);
});

// ponytail: ESC abort 的真实产物是空 content + stopReason:"aborted"(pi 的
// handleRunFailure 写死)。文本正则永远匹配不到空串,task 会误判成没产出 spec,
// 发 followUp 让 pi 的 _handlePostAgentRun 自动续命 —— ESC 退出不了 planning。
// 这个测试断言 stopReason 被识别为中断,不发 followUp(userMessages.length === 0)。
test("/task planning ESC abort (empty content + stopReason aborted) does not trigger spec retry loop", async () => {
	const { pi, handlers, userMessages, entries } = makePi();
	const { ctx, notifications } = makeCtx();
	registerTask(pi as any);

	ctx.sessionManager.getEntries = () => [{
		customType: "task-state",
		data: enterPlanning(createTaskState()),
	}];
	await handlers.get("session_start")![0]({}, ctx);
	const entriesBefore = entries.length;

	await handlers.get("agent_end")![0]({
		messages: [{
			role: "assistant",
			content: [{ type: "text", text: "" }],
			stopReason: "aborted",
		}],
	}, ctx);

	assert.equal(userMessages.length, 0, "ESC abort must not queue a followUp that revives the agent");
	assert.equal(entries.length, entriesBefore);
	assert.match(notifications.at(-1)?.message ?? "", /cancelled/);
});

test("/task reviewing ESC abort (empty content + stopReason aborted) does not trigger review retry loop", async () => {
	const { pi, handlers, userMessages, entries } = makePi();
	const { ctx, notifications } = makeCtx();
	registerTask(pi as any);

	ctx.sessionManager.getEntries = () => [{
		customType: "task-state",
		data: enterReviewing(startExecuting(markPlanQuestionnaireUsed(setTaskSpec(enterPlanning(createTaskState()), spec)), "run-dir"), "done"),
	}];
	await handlers.get("session_start")![0]({}, ctx);
	const entriesBefore = entries.length;

	await handlers.get("agent_end")![0]({
		messages: [{
			role: "assistant",
			content: [{ type: "text", text: "" }],
			stopReason: "aborted",
		}],
	}, ctx);

	assert.equal(userMessages.length, 0, "ESC abort must not queue a followUp that revives the agent");
	assert.equal(entries.length, entriesBefore);
	assert.match(notifications.at(-1)?.message ?? "", /cancelled/);
});

// ponytail: questionnaire 被用户取消是 tool result(不是 abort),assistant 之后会正常
// 输出"已取消,等你指示"然后停。若 task 仍按 !spec 发 followUp,pi 会自动续命重跑问卷,
// agent 也因 prompt 强制调问卷而照办 —— ESC 取消问卷退出不了。这里断言:最后一条是
// cancelled 的 questionnaire tool result 时,task 停下交还控制权,不发 followUp。
test("/task planning questionnaire cancellation stops instead of followUp-reviving the agent", async () => {
	const { pi, handlers, userMessages, entries } = makePi();
	const { ctx, notifications } = makeCtx();
	registerTask(pi as any);

	ctx.sessionManager.getEntries = () => [{
		customType: "task-state",
		data: enterPlanning(createTaskState()),
	}];
	await handlers.get("session_start")![0]({}, ctx);
	const entriesBefore = entries.length;

	// 真实消息序列:assistant 调问卷 → 问卷被取消(tool result)→ assistant 说"已取消"并停。
	await handlers.get("agent_end")![0]({
		messages: [
			{ role: "assistant", content: [{ type: "text", text: "Let me confirm assumptions." }] },
			{ role: "toolResult", content: [{ type: "text", text: "User cancelled the questionnaire" }] },
			{ role: "assistant", content: [{ type: "text", text: "好的，已取消。你随时可以重新发起。" }] },
		],
	}, ctx);

	assert.equal(userMessages.length, 0, "questionnaire cancellation must not queue a followUp that revives the agent");
	assert.equal(entries.length, entriesBefore);
	assert.match(notifications.at(-1)?.message ?? "", /取消/);
});

test("/task reviewing questionnaire cancellation stops instead of followUp-reviving the agent", async () => {
	const { pi, handlers, userMessages, entries } = makePi();
	const { ctx, notifications } = makeCtx();
	registerTask(pi as any);

	ctx.sessionManager.getEntries = () => [{
		customType: "task-state",
		data: enterReviewing(startExecuting(markPlanQuestionnaireUsed(setTaskSpec(enterPlanning(createTaskState()), spec)), "run-dir"), "done"),
	}];
	await handlers.get("session_start")![0]({}, ctx);
	const entriesBefore = entries.length;

	await handlers.get("agent_end")![0]({
		messages: [
			{ role: "assistant", content: [{ type: "text", text: "Let me confirm the skill design." }] },
			{ role: "toolResult", content: [{ type: "text", text: "User cancelled the questionnaire" }] },
			{ role: "assistant", content: [{ type: "text", text: "好的，已取消。等你下一步指示。" }] },
		],
	}, ctx);

	assert.equal(userMessages.length, 0, "questionnaire cancellation must not queue a followUp that revives the agent");
	assert.equal(entries.length, entriesBefore);
	assert.match(notifications.at(-1)?.message ?? "", /取消/);
});

// ponytail: 取消问卷后,agent 可能再调别的 tool(如 read 探索)再停下。旧的"只看最后一条
// toolResult"判定会被 read 的 toolResult 盖掉取消信号,误判"没产物该重试",死循环复发。
// 改成扫整条序列找取消信号后,这种场景必须正确停下。
test("/task planning questionnaire cancellation still recognized when a later tool masks it", async () => {
	const { pi, handlers, userMessages, entries } = makePi();
	const { ctx, notifications } = makeCtx();
	registerTask(pi as any);

	ctx.sessionManager.getEntries = () => [{
		customType: "task-state",
		data: enterPlanning(createTaskState()),
	}];
	await handlers.get("session_start")![0]({}, ctx);
	const entriesBefore = entries.length;

	// 取消问卷 → agent 又调 read(产生新 toolResult,掩盖取消信号)→ agent 停下。
	await handlers.get("agent_end")![0]({
		messages: [
			{ role: "assistant", content: [{ type: "text", text: "Let me confirm." }] },
			{ role: "toolResult", content: [{ type: "text", text: "User cancelled the questionnaire" }] },
			{ role: "assistant", content: [{ type: "text", text: "已取消,我先 read 一下相关文件。" }] },
			{ role: "toolResult", content: [{ type: "text", text: "file contents here" }] },
			{ role: "assistant", content: [{ type: "text", text: "好的,先停在这里等你指示。" }] },
		],
	}, ctx);

	assert.equal(userMessages.length, 0, "取消信号被后续 toolResult 掩盖时仍须停下,不发 followUp");
	assert.equal(entries.length, entriesBefore);
	assert.match(notifications.at(-1)?.message ?? "", /取消/);
});

// ponytail: planning→reviewing 在同一 session 内切换时,messages 会混着 plan-ctx 和
// review-ctx 两种起边界。filterTaskContextMessages 的"对方阶段起边界"分支(只滤起本身,
// 不动内容)此前无测试触达。
test("/task reviewing filters out planning start-boundaries but keeps reviewing cycle intact", async () => {
	const { pi, handlers } = makePi();
	const { ctx } = makeCtx();
	registerTask(pi as any);

	// 进入 reviewing 态。
	ctx.sessionManager.getEntries = () => [{
		customType: "task-state",
		data: enterReviewing(startExecuting(markPlanQuestionnaireUsed(setTaskSpec(enterPlanning(createTaskState()), spec)), "run-dir"), "done"),
	}];
	await handlers.get("session_start")![0]({}, ctx);

	// 混合:旧的 plan-ctx(planning 残留)+ 当前 review-ctx。
	const planCtx = { role: "custom", customType: "task-plan-context", content: "stale from planning" };
	const reviewCtx = { role: "custom", customType: "task-review-context", content: "current review" };
	const qa = { role: "assistant", content: [{ type: "text", text: "review 内容" }] };
	const filtered = await handlers.get("context")![0]({ messages: [planCtx, reviewCtx, qa] }, ctx);

	// plan-ctx(对方阶段起边界)滤掉;review 当前周期(起 + 内容)保留。
	assert.deepEqual(filtered.messages, [reviewCtx, qa]);
});

test("/task new after a previous exited task strips the previous task's Q&A but keeps post-exit chat", async () => {
	const { pi, commands, handlers } = makePi();
	const { ctx } = makeCtx();
	registerTask(pi as any);

	await commands.get("task").handler("new", ctx); // 进入 planning(state.phase=planning)

	const planCtx1 = { role: "custom", customType: "task-plan-context", content: "old" };
	const qa1 = { role: "assistant", content: [{ type: "text", text: "上个 task 的问卷问答" }] };
	const exitBoundary = { role: "custom", customType: "task-context-end", content: "task session ended" };
	const chat = { role: "user", content: [{ type: "text", text: "退出后用户探寻实现可能的闲聊" }] };
	const planCtx2 = { role: "custom", customType: "task-plan-context", content: "new" };
	const qa2 = { role: "assistant", content: [{ type: "text", text: "新 task 的问答" }] };

	const filtered = await handlers.get("context")![0]({
		messages: [planCtx1, qa1, exitBoundary, chat, planCtx2, qa2],
	}, ctx);

	// 上个 task 的 plan-ctx + 问答 + 止边界 整段滤掉;闲聊 + 新 task 内容保留。
	assert.deepEqual(filtered.messages, [chat, planCtx2, qa2]);
});

test("/task new first time (no prior exit) keeps the current planning cycle intact", async () => {
	const { pi, commands, handlers } = makePi();
	const { ctx } = makeCtx();
	registerTask(pi as any);

	await commands.get("task").handler("new", ctx);

	const planCtx = { role: "custom", customType: "task-plan-context", content: "new" };
	const qa = { role: "assistant", content: [{ type: "text", text: "当前 task 问答" }] };
	const filtered = await handlers.get("context")![0]({ messages: [planCtx, qa] }, ctx);

	// 未闭合的周期 = 当前进行中的 task,全保留。
	assert.deepEqual(filtered.messages, [planCtx, qa]);
});

test("/task reviewing isolates prior reviewing cycles symmetrically", async () => {
	const { pi, handlers } = makePi();
	const { ctx } = makeCtx();
	registerTask(pi as any);

	// 用 session_start 恢复到 reviewing 态。
	ctx.sessionManager.getEntries = () => [{
		customType: "task-state",
		data: enterReviewing(startExecuting(markPlanQuestionnaireUsed(setTaskSpec(enterPlanning(createTaskState()), spec)), "run-dir"), "done"),
	}];
	await handlers.get("session_start")![0]({}, ctx);

	const reviewCtx1 = { role: "custom", customType: "task-review-context", content: "old" };
	const qa1 = { role: "assistant", content: [{ type: "text", text: "上个 review 的问答" }] };
	const exitBoundary = { role: "custom", customType: "task-context-end", content: "task session ended" };
	const chat = { role: "user", content: [{ type: "text", text: "闲聊" }] };
	const reviewCtx2 = { role: "custom", customType: "task-review-context", content: "new" };
	const filtered = await handlers.get("context")![0]({
		messages: [reviewCtx1, qa1, exitBoundary, chat, reviewCtx2],
	}, ctx);

	assert.deepEqual(filtered.messages, [chat, reviewCtx2]);
});

test("/task exit injects a silent task-context-end boundary marker", async () => {
	const { pi, commands, sentMessages } = makePi();
	const { ctx, notifications } = makeCtx();
	registerTask(pi as any);

	await commands.get("task").handler("new", ctx);
	const sentBefore = sentMessages.length;
	await commands.get("task").handler("exit", ctx);

	const boundary = sentMessages.at(-1);
	assert.ok(boundary, "exit 应注入一条 task-context-end 边界消息");
	assert.equal(boundary.message.customType, "task-context-end");
	assert.equal(boundary.message.display, false);
	assert.equal(boundary.options?.triggerTurn, false);
	assert.equal(sentMessages.length, sentBefore + 1, "exit 只注入一条边界,不多发");
	assert.match(notifications.at(-1)?.message ?? "", /Task disabled/);
});

test("/task save without review questionnaire asks reviewer to run the design gates", async () => {
	const { pi, commands, handlers, userMessages } = makePi();
	const { ctx, notifications } = makeCtx();
	registerTask(pi as any);

	const reviewing = enterReviewing(startExecuting(markPlanQuestionnaireUsed(setTaskSpec(enterPlanning(createTaskState()), spec)), "run-dir"), "done");
	ctx.sessionManager.getEntries = () => [{
		customType: "task-state",
		data: setTaskReviewResult(reviewing, {
			description: "x",
			skill: "# Skill",
			verify: "process.exit(0)",
			contract: { artifacts: [] },
		}),
	}];
	await handlers.get("session_start")![0]({}, ctx);
	await commands.get("task").handler("save no-gate", ctx);

	assert.match(notifications.at(-1)?.message ?? "", /review 未用 questionnaire/);
	assert.match(userMessages.at(-1)?.text ?? "", /questionnaire/);
	assert.match(userMessages.at(-1)?.text ?? "", /skill\/verify/);
});

test("/task save blocks malformed contract without throwing (resumed dirty state)", async () => {
	// ponytail: 回归 — saveCurrentTask 消费从持久层反序列化回来的 reviewResult.contract。
	// resumed 旧会话可能带回修复前产生的非法 contract,runtimeInput 是对象 / runtimeInputMeta 有孤儿 key。
	// 单点防御在 saveCurrentTask 入口拦住,友好反馈,不抛 raw assertValidContract 错误冒泡成 Extension error。
	const { pi, commands, handlers, userMessages } = makePi();
	const { ctx, notifications } = makeCtx();
	registerTask(pi as any);

	// reviewQuestionnaireUsed=true 绕过第一个 guard,直接命中 contract 校验这条路径
	const reviewing = markReviewQuestionnaireUsed(enterReviewing(startExecuting(markPlanQuestionnaireUsed(setTaskSpec(enterPlanning(createTaskState()), spec)), "run-dir"), "done"));
	ctx.sessionManager.getEntries = () => [{
		customType: "task-state",
		data: setTaskReviewResult(reviewing, {
			description: "脏数据",
			skill: "# Skill",
			verify: "process.exit(0)",
			// LLM 常见错误:把 runtimeInput 写成对象而非字符串数组
			contract: { runtimeInput: { topic: "something" } },
		}),
	}];
	await handlers.get("session_start")![0]({}, ctx);

	await assert.doesNotReject(() => commands.get("task").handler("save dirty --project", ctx));

	assert.match(notifications.at(-1)?.message ?? "", /contract.*不合法/);
	assert.match(userMessages.at(-1)?.text ?? "", /Invalid contract\.runtimeInput/);
	assert.match(userMessages.at(-1)?.text ?? "", /runtimeInput 必须是字符串数组/);
	assert.equal((ctx.sessionManager.getEntries().at(-1)?.data as any).phase, "reviewing");
});

test("/task save runs verify self-check before landed", async () => {
	const { pi, commands, handlers, entries, userMessages } = makePi();
	const { cwd, ctx, notifications } = makeCtx();
	registerTask(pi as any);

	try {
		await commands.get("task").handler("new", ctx);
		await handlers.get("tool_call")![0]({ toolName: "questionnaire" }, ctx);
		await handlers.get("agent_end")![0]({
			messages: [{
				role: "assistant",
				content: [{ type: "text", text: `\`\`\`json\n${JSON.stringify(spec)}\n\`\`\`` }],
			}],
		}, ctx);
		await commands.get("task").handler("execute", ctx);
		await handlers.get("tool_call")![0]({ toolName: "task_complete", input: { summary: "已生成 report.json" } }, ctx);
		await handlers.get("tool_execution_end")![0]({ toolName: "task_complete", isError: false, result: { details: { summary: "已生成 report.json" } } }, ctx);
		await handlers.get("input")![0]({ source: "interactive", text: "" }, ctx);
		await handlers.get("tool_call")![0]({ toolName: "questionnaire" }, ctx);
		await handlers.get("agent_end")![0]({
			messages: [{
				role: "assistant",
				content: [{ type: "text", text: `\`\`\`json
{"description":"坏 verify","skill":"# Skill","verify":"console.log(JSON.stringify([{assertion:'a',expected:'e',actual:'x'}])); process.exit(1)","contract":{"artifacts":[]}}
\`\`\`` }],
			}],
		}, ctx);

		const beforeSaveMessages = userMessages.length;
		await commands.get("task").handler("save bad --project", ctx);

		assert.match(notifications.at(-1)?.message ?? "", /verify 自证失败/);
		assert.ok(userMessages.length > beforeSaveMessages);
		assert.match(userMessages.at(-1)?.text ?? "", /verify 自证失败/);
		assert.match(userMessages.at(-1)?.text ?? "", /修正 taskbook/);
		assert.equal((entries.at(-1)?.data as any).phase, "reviewing");
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("/task save rejects malformed verify failure output before writing taskbook", async () => {
	const { pi, commands, handlers, entries, userMessages } = makePi();
	const { cwd, ctx, notifications } = makeCtx();
	registerTask(pi as any);

	try {
		await commands.get("task").handler("new", ctx);
		await handlers.get("tool_call")![0]({ toolName: "questionnaire" }, ctx);
		await handlers.get("agent_end")![0]({
			messages: [{
				role: "assistant",
				content: [{ type: "text", text: `\`\`\`json\n${JSON.stringify(spec)}\n\`\`\`` }],
			}],
		}, ctx);
		await commands.get("task").handler("execute", ctx);
		const executeRunDir = (entries.at(-1)?.data as any).executeRunDir;
		await writeFile(path.join(executeRunDir, "output", "report.md"), "# ok\n", "utf8");
		await handlers.get("tool_execution_end")![0]({ toolName: "task_complete", isError: false, result: { details: { summary: "已生成 report.md" } } }, ctx);
		await handlers.get("input")![0]({ source: "interactive", text: "" }, ctx);
		await handlers.get("tool_call")![0]({ toolName: "questionnaire" }, ctx);
		await handlers.get("agent_end")![0]({
			messages: [{
				role: "assistant",
				content: [{ type: "text", text: `\`\`\`json
{
  "description":"坏失败格式",
  "skill":"# Skill",
  "verify":"import {readdir} from 'node:fs/promises'; const files = await readdir(process.env.TASK_OUTPUT_DIR).catch(() => []); if (files.length === 0) { console.log(JSON.stringify({failures:['empty']})); process.exit(1); } process.exit(0);",
  "contract":{"artifacts":[{"name":"report.md","type":"file"}]}
}
\`\`\`` }],
			}],
		}, ctx);

		const beforeSaveMessages = userMessages.length;
		await commands.get("task").handler("save malformed --project", ctx);

		assert.match(notifications.at(-1)?.message ?? "", /verify 失败输出格式错误/);
		assert.ok(userMessages.length > beforeSaveMessages);
		assert.match(userMessages.at(-1)?.text ?? "", /VerifyFailure\[\]/);
		assert.equal(await loadTaskbook(cwd, "malformed"), null);
		assert.equal((entries.at(-1)?.data as any).phase, "reviewing");
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("/task save reruns empty-output negative check after asking runtime input", async () => {
	const { pi, commands, handlers, entries, userMessages } = makePi();
	const { cwd, ctx, notifications } = makeCtx();
	ctx.ui.input = () => "ok";
	registerTask(pi as any);

	try {
		await commands.get("task").handler("new", ctx);
		await handlers.get("tool_call")![0]({ toolName: "questionnaire" }, ctx);
		await handlers.get("agent_end")![0]({
			messages: [{
				role: "assistant",
				content: [{ type: "text", text: `\`\`\`json\n${JSON.stringify(spec)}\n\`\`\`` }],
			}],
		}, ctx);
		await commands.get("task").handler("execute", ctx);
		const executeRunDir = (entries.at(-1)?.data as any).executeRunDir;
		await writeFile(path.join(executeRunDir, "output", "report.md"), "# ok\n", "utf8");
		await handlers.get("tool_execution_end")![0]({ toolName: "task_complete", isError: false, result: { details: { summary: "已生成 report.md" } } }, ctx);
		await handlers.get("input")![0]({ source: "interactive", text: "" }, ctx);
		await handlers.get("tool_call")![0]({ toolName: "questionnaire" }, ctx);
		await handlers.get("agent_end")![0]({
			messages: [{
				role: "assistant",
				content: [{ type: "text", text: `\`\`\`json
{
  "description":"runtime input bad negative",
  "skill":"# Skill",
  "verify":"const input = JSON.parse(process.env.TASK_INPUT); if (input.token !== 'ok') { console.log(JSON.stringify([{assertion:'token',expected:'ok',actual:String(input.token)}])); process.exit(1); } process.exit(0);",
  "contract":{"runtimeInput":["token"],"artifacts":[{"name":"report.md","type":"file"}]}
}
\`\`\`` }],
			}],
		}, ctx);

		const beforeSaveMessages = userMessages.length;
		await commands.get("task").handler("save runtime-negative --project", ctx);

		assert.match(notifications.at(-1)?.message ?? "", /空 outputDir 也通过/);
		assert.ok(userMessages.length > beforeSaveMessages);
		assert.match(userMessages.at(-1)?.text ?? "", /空 outputDir/);
		assert.match(userMessages.at(-1)?.text ?? "", /修正 verify/);
		assert.equal(await loadTaskbook(cwd, "runtime-negative"), null);
		assert.equal((entries.at(-1)?.data as any).phase, "reviewing");
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("/task edit loads an existing taskbook into update review", async () => {
	const { pi, commands, entries, sentMessages, activeTools } = makePi();
	const { cwd, ctx } = makeCtx();
	registerTask(pi as any);
	ctx.ui.input = () => "结果只要 md 文件不要 html";

	try {
		await saveTaskbook("project", cwd, "editable", {
			description: "editable",
			spec,
			skill: "# Skill",
			verify: "process.exit(0)",
			contract: { artifacts: [] },
		});
		await commands.get("task").handler("edit editable", ctx);

		assert.equal((entries.at(-1)?.data as any).phase, "reviewing");
		assert.deepEqual((entries.at(-1)?.data as any).spec, spec);
		assert.equal((entries.at(-1)?.data as any).taskbookName, "editable");
		assert.equal((entries.at(-1)?.data as any).taskbookScope, "project");
		assert.deepEqual(activeTools.at(-1), ["read", "bash", "grep", "find", "ls", "questionnaire"]);
		const reviewPrompt = sentMessages.at(-1);
		assert.equal(reviewPrompt?.message?.customType, "task-review-prompt");
		assert.equal(reviewPrompt?.message?.details?.mode, "edit");
		assert.match(reviewPrompt?.message?.content ?? "", /UserEditRequest:/);
		assert.match(reviewPrompt?.message?.content ?? "", /结果只要 md 文件不要 html/);
		assert.match(reviewPrompt?.message?.content ?? "", /更新已有 taskbook/);
		assert.match(reviewPrompt?.message?.content ?? "", /现有 skill\.md/);
		assert.match(reviewPrompt?.message?.content ?? "", /现有 verify\.mjs/);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("/task edit cancels when the first edit request prompt is cancelled", async () => {
	const { pi, commands, entries, sentMessages } = makePi();
	const { cwd, ctx } = makeCtx();
	registerTask(pi as any);
	ctx.ui.input = () => undefined;

	try {
		await saveTaskbook("project", cwd, "editable-cancel", {
			description: "editable cancel",
			spec,
			skill: "# Skill",
			verify: "process.exit(0)",
			contract: { artifacts: [] },
		});
		await commands.get("task").handler("edit editable-cancel", ctx);

		assert.equal(entries.length, 0);
		assert.equal(sentMessages.length, 0);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("/task show task edit reuses the edit request flow", async () => {
	const { pi, commands, entries, sentMessages } = makePi();
	const { cwd, ctx } = makeCtx();
	registerTask(pi as any);
	ctx.ui.select = (title: string) => title.startsWith("taskbook:") ? "task 编辑" : "Exit";
	ctx.ui.input = () => "结果只要 md 文件不要 html";

	try {
		await saveTaskbook("project", cwd, "show-edit", {
			description: "show edit",
			spec,
			skill: "# Skill",
			verify: "process.exit(0)",
			contract: { artifacts: [] },
		});
		await commands.get("task").handler("show show-edit", ctx);

		assert.equal((entries.at(-1)?.data as any).phase, "reviewing");
		assert.equal((entries.at(-1)?.data as any).taskbookName, "show-edit");
		const reviewPrompt = sentMessages.at(-1);
		assert.equal(reviewPrompt?.message?.customType, "task-review-prompt");
		assert.match(reviewPrompt?.message?.content ?? "", /UserEditRequest:/);
		assert.match(reviewPrompt?.message?.content ?? "", /结果只要 md 文件不要 html/);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("/task show guide edit passes the selected guide item into edit", async () => {
	const { pi, commands, entries, sentMessages } = makePi();
	const { cwd, ctx, notifications } = makeCtx();
	registerTask(pi as any);
	mockTaskGuideRunner("1. 任务目标: 生成报告\n5. 产物契约: report.md; snapshot.html");
	ctx.ui.select = (title: string) => {
		if (title.startsWith("taskbook:")) return "task 导览";
		if (title === "task 导览") return "编辑";
		return "Exit";
	};
	ctx.ui.input = () => "5 不要保存 html";

	try {
		await saveTaskbook("project", cwd, "guide-edit", {
			description: "guide edit",
			spec,
			skill: "# Skill",
			verify: "process.exit(0)",
			contract: { artifacts: [{ path: "report.md" }, { path: "snapshot.html" }] },
		});
		await commands.get("task").handler("show guide-edit", ctx);

		assert.match(notifications.at(-1)?.message ?? "", /# task 导览: guide-edit \[project\]/);
		assert.equal((entries.at(-1)?.data as any).phase, "reviewing");
		const reviewPrompt = sentMessages.at(-1);
		assert.equal(reviewPrompt?.message?.customType, "task-review-prompt");
		assert.match(reviewPrompt?.message?.content ?? "", /用户选择导览项 5: 产物契约/);
		assert.match(reviewPrompt?.message?.content ?? "", /snapshot\.html/);
		assert.match(reviewPrompt?.message?.content ?? "", /不要保存 html/);
	} finally {
		setTaskGuideRunnerForTests(undefined);
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("/task edit save overwrites the existing taskbook scope and preserves runs", async () => {
	const { pi, commands, handlers } = makePi();
	const { cwd, ctx, notifications } = makeCtx();
	registerTask(pi as any);

	try {
		await saveTaskbook("project", cwd, "editable-save", {
			description: "old",
			spec,
			skill: "# Old",
			verify: "process.exit(0)",
			contract: { artifacts: [] },
		});
		await appendRunToTaskbook("project", cwd, "editable-save", {
			timestamp: new Date().toISOString(),
			status: "pass",
			input: {},
			exitCode: 0,
			verifyFailures: [],
			duration: 1,
		});

		await commands.get("task").handler("edit editable-save", ctx);
		await handlers.get("tool_call")![0]({ toolName: "questionnaire" }, ctx);
		await handlers.get("agent_end")![0]({
			messages: [{
				role: "assistant",
				content: [{ type: "text", text: `\`\`\`json
{"description":"new","skill":"# New","verify":"process.exit(0)","contract":{"artifacts":[]}}
\`\`\`` }],
			}],
		}, ctx);
		await commands.get("task").handler("save", ctx);

		const loaded = await loadTaskbook(cwd, "editable-save");
		assert.equal(loaded?.scope, "project");
		assert.equal(loaded?.taskbook.description, "new");
		assert.equal(loaded?.skill, "# New");
		assert.equal(loaded?.taskbook.runs.length, 1);
		assert.match(notifications.at(-1)?.message ?? "", /已更新/);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("/task delete removes a confirmed taskbook", async () => {
	const { pi, commands } = makePi();
	const { cwd, ctx, notifications } = makeCtx();
	registerTask(pi as any);

	try {
		await saveTaskbook("project", cwd, "delete-me", {
			description: "delete me",
			spec,
			skill: "# Skill",
			verify: "process.exit(0)",
			contract: { artifacts: [] },
		});
		await commands.get("task").handler("delete delete-me --project", ctx);

		assert.equal(await loadTaskbook(cwd, "delete-me"), null);
		assert.match(notifications.at(-1)?.message ?? "", /已删除/);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("/task rename changes the selected taskbook name", async () => {
	const { pi, commands } = makePi();
	const { cwd, ctx, notifications } = makeCtx();
	registerTask(pi as any);

	try {
		await saveTaskbook("project", cwd, "rename-me", {
			description: "rename me",
			spec,
			skill: "# Skill",
			verify: "process.exit(0)",
			contract: { artifacts: [] },
		});
		await appendRunToTaskbook("project", cwd, "rename-me", {
			timestamp: new Date().toISOString(),
			status: "pass",
			input: {},
			exitCode: 0,
			verifyFailures: [],
			duration: 1,
		});

		await commands.get("task").handler("rename rename-me renamed", ctx);

		assert.equal(await loadTaskbook(cwd, "rename-me"), null);
		const loaded = await loadTaskbook(cwd, "renamed");
		assert.equal(loaded?.taskbook.name, "renamed");
		assert.equal(loaded?.taskbook.runs.length, 1);
		assert.match(notifications.at(-1)?.message ?? "", /已重命名/);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("/task menu selects taskbook name for show edit delete and run", async () => {
	const { pi, commands, entries, sentMessages } = makePi();
	const { cwd, ctx, notifications } = makeCtx();
	registerTask(pi as any);
	mockTaskGuideRunner("1. 任务目标: 生成报告\n5. 产物契约: 未声明固定产物");
	setTaskWorkerRunnerForTests(async () => ({
		agent: "worker",
		agentSource: "user",
		task: "task",
		exitCode: 0,
		messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 },
	}) as any);
	setTaskDispatcherForTests(async () => ({ text: "一句话" }));

	try {
		for (const name of ["menu-show", "menu-edit", "menu-delete", "menu-run"]) {
			await saveTaskbook("project", cwd, name, {
				description: name,
				spec,
				skill: "# Skill",
				verify: name === "menu-run"
					? "const input = JSON.parse(process.env.TASK_INPUT); if (input.text !== '一句话') process.exit(1); process.exit(0);\n"
					: "process.exit(0);\n",
				contract: name === "menu-run" ? { runtimeInput: ["text"], artifacts: [] } : { artifacts: [] },
			});
		}

		ctx.ui.select = (title: string) => {
			if (title === "Task") return "查看 taskbook 详情";
			if (title.startsWith("taskbook:")) return "task 导览";
			if (title === "task 导览") return "了解返回";
			return "menu-show";
		};
		await commands.get("task").handler("", ctx);
		assert.match(notifications.at(-1)?.message ?? "", /# task 导览: menu-show \[project\]/);
		assert.match(notifications.at(-1)?.message ?? "", /1\. 任务目标/);

		ctx.ui.select = (title: string) => title === "Task" ? "编辑 taskbook" : "menu-edit";
		await commands.get("task").handler("", ctx);
		assert.equal((entries.at(-1)?.data as any).taskbookName, "menu-edit");

		await commands.get("task").handler("exit", ctx);
		ctx.ui.select = (title: string) => title === "Task" ? "运行 taskbook(复用)" : "menu-run";
		ctx.ui.input = () => "一句话";
		await commands.get("task").handler("", ctx);
		await waitForTaskRunForTests();
		assert.match(latestTaskMessage(sentMessages), /PASS/);
		assert.deepEqual((await loadTaskbook(cwd, "menu-run"))?.taskbook.runs.at(-1)?.input, { text: "一句话" });

		ctx.ui.select = (title: string) => title === "Task" ? "删除 taskbook" : "menu-delete";
		await commands.get("task").handler("", ctx);
		assert.equal(await loadTaskbook(cwd, "menu-delete"), null);
	} finally {
		setTaskGuideRunnerForTests(undefined);
		setTaskWorkerRunnerForTests(undefined);
		setTaskDispatcherForTests(undefined);
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("/task run executes worker, verify, and records a pass run", async () => {
	const { pi, commands, sentMessages, entries } = makePi();
	const { cwd, ctx, notifications } = makeCtx();
	registerTask(pi as any);
	setTaskWorkerRunnerForTests(async () => ({
		agent: "worker",
		agentSource: "user",
		task: "task",
		exitCode: 0,
		messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 },
	}) as any);
	setTaskDispatcherForTests(async () => ({ url: "https://x" }));
	try {
		await saveTaskbook("project", cwd, "runner", {
			description: "runner",
			spec,
			skill: "# Skill",
			verify: "const input = JSON.parse(process.env.TASK_INPUT); if (input.url !== 'https://x') process.exit(1); process.exit(0);\n",
			contract: { runtimeInput: ["url"], artifacts: [] },
		});

		await commands.get("task").handler("run runner 把这个下下来 https://x", ctx);
		await waitForTaskRunForTests();
		const loaded = await loadTaskbook(cwd, "runner");

		assert.match(latestTaskMessage(sentMessages), /PASS/);
		assert.equal(loaded?.taskbook.runs.at(-1)?.status, "pass");
		assert.deepEqual(loaded?.taskbook.runs.at(-1)?.input, { url: "https://x" });
		// ponytail: run 后 lastRunReview 应持久化进 task-state entry,让退出重进能恢复复盘
		const stateEntry = [...entries].reverse().find((e) => e.customType === "task-state");
		assert.equal(stateEntry?.data?.lastRunReview?.taskbookName, "runner");
		assert.match(stateEntry?.data?.lastRunReview?.content ?? "", /TASK RUN REVIEW/);
	} finally {
		setTaskWorkerRunnerForTests(undefined);
		setTaskDispatcherForTests(undefined);
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("/task run blocks before worker when contract requiredEnv is missing", async () => {
	const { pi, commands } = makePi();
	const { cwd, ctx, notifications } = makeCtx();
	const previous = process.env.UGK_TEST_MISSING_ENV;
	delete process.env.UGK_TEST_MISSING_ENV;
	let workerCalled = false;
	registerTask(pi as any);
	setTaskWorkerRunnerForTests(async () => {
		workerCalled = true;
		throw new Error("worker should not run");
	});
	try {
		await saveTaskbook("project", cwd, "needs-env", {
			description: "needs env",
			spec,
			skill: "# Skill",
			verify: "process.exit(0);\n",
			contract: { runtimeInput: [], artifacts: [], requiredEnv: ["UGK_TEST_MISSING_ENV"] },
		});

		await commands.get("task").handler("run needs-env", ctx);
		await waitForTaskRunForTests();

		assert.equal(workerCalled, false);
		assert.match(notifications.at(-1)?.message ?? "", /UGK_TEST_MISSING_ENV/);
		assert.match(notifications.at(-1)?.message ?? "", /setx UGK_TEST_MISSING_ENV/);
		const loaded = await loadTaskbook(cwd, "needs-env");
		assert.equal(loaded?.taskbook.runs.length, 0);
	} finally {
		setTaskWorkerRunnerForTests(undefined);
		if (previous === undefined) delete process.env.UGK_TEST_MISSING_ENV;
		else process.env.UGK_TEST_MISSING_ENV = previous;
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("/task run prompts for missing requiredEnv and passes it to worker", async () => {
	const { pi, commands } = makePi();
	const { cwd, ctx } = makeCtx();
	const previous = process.env.UGK_TEST_REQUIRED_ENV;
	const previousPersist = process.env.UGK_REQUIRED_ENV_PERSIST;
	delete process.env.UGK_TEST_REQUIRED_ENV;
	process.env.UGK_REQUIRED_ENV_PERSIST = "0";
	let workerEnv: Record<string, string | undefined> | undefined;
	ctx.ui.input = () => "secret-from-user";
	registerTask(pi as any);
	setTaskWorkerRunnerForTests(async (...args: any[]) => {
		workerEnv = args[9];
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
		await saveTaskbook("project", cwd, "needs-env-input", {
			description: "needs env",
			spec,
			skill: "# Skill",
			verify: "process.exit(0);\n",
			contract: { runtimeInput: [], artifacts: [], requiredEnv: ["UGK_TEST_REQUIRED_ENV"] },
		});

		await commands.get("task").handler("run needs-env-input", ctx);
		await waitForTaskRunForTests();

		assert.equal(workerEnv?.UGK_TEST_REQUIRED_ENV, "secret-from-user");
		assert.equal(process.env.UGK_TEST_REQUIRED_ENV, "secret-from-user");
		const loaded = await loadTaskbook(cwd, "needs-env-input");
		assert.equal(loaded?.taskbook.runs.at(-1)?.status, "pass");
	} finally {
		setTaskWorkerRunnerForTests(undefined);
		if (previous === undefined) delete process.env.UGK_TEST_REQUIRED_ENV;
		else process.env.UGK_TEST_REQUIRED_ENV = previous;
		if (previousPersist === undefined) delete process.env.UGK_REQUIRED_ENV_PERSIST;
		else process.env.UGK_REQUIRED_ENV_PERSIST = previousPersist;
		rmSync(cwd, { recursive: true, force: true });
	}
});

// ponytail: contract 依赖字段校验(顺带修的独立 bug)。requiredEnv/requiredTools/requiredBinaries
// 都必须是可选 string[],之前完全不校验、乱写运行时才炸。
test("assertValidContract rejects malformed requiredEnv/requiredTools/requiredBinaries", () => {
	// 合法:三个都是可选 string[]
	assertValidContract({ runtimeInput: [], artifacts: [], requiredEnv: ["A"], requiredTools: ["chrome_cdp"], requiredBinaries: ["yt-dlp"] });
	// 合法:缺省也行(老 taskbook 兼容)
	assertValidContract({ runtimeInput: [], artifacts: [] });
	// 非法:不是数组
	assert.throws(() => assertValidContract({ requiredEnv: "MIMO_API_KEY" }), /Invalid contract.requiredEnv/);
	assert.throws(() => assertValidContract({ requiredTools: "chrome_cdp" }), /Invalid contract.requiredTools/);
	assert.throws(() => assertValidContract({ requiredBinaries: "yt-dlp" }), /Invalid contract.requiredBinaries/);
	// 非法:数组里含非字符串
	assert.throws(() => assertValidContract({ requiredBinaries: ["yt-dlp", 123] }), /Invalid contract.requiredBinaries/);
});

// ponytail: /task run(交互式)缺外部 CLI → notify warning + 不跑 worker。
// 钉死可移植性闭环:依赖缺失前置拦截,引导用户安装,而不是跑一半才炸。
test("/task run blocks before worker when contract requiredBinaries is missing", async () => {
	const { pi, commands } = makePi();
	const { cwd, ctx, notifications } = makeCtx();
	let workerCalled = false;
	registerTask(pi as any);
	setTaskWorkerRunnerForTests(async () => {
		workerCalled = true;
		throw new Error("worker should not run");
	});
	try {
		await saveTaskbook("project", cwd, "needs-binary", {
			description: "needs yt-dlp",
			spec,
			skill: "# Skill",
			verify: "process.exit(0);\n",
			contract: { runtimeInput: [], artifacts: [], requiredBinaries: ["definitely-missing-xyz-12345"] },
		});

		await commands.get("task").handler("run needs-binary", ctx);
		await waitForTaskRunForTests();

		assert.equal(workerCalled, false);
		assert.match(notifications.at(-1)?.message ?? "", /definitely-missing-xyz-12345/);
		assert.match(notifications.at(-1)?.message ?? "", /重新调用 run_task/);
		const loaded = await loadTaskbook(cwd, "needs-binary");
		assert.equal(loaded?.taskbook.runs.length, 0);
	} finally {
		setTaskWorkerRunnerForTests(undefined);
		rmSync(cwd, { recursive: true, force: true });
	}
});

// ponytail: requiredBinaries 声明的是已存在的 CLI(node 一定在)→ 正常跑 worker,不误拦。
test("/task run proceeds when declared requiredBinaries are all available", async () => {
	const { pi, commands } = makePi();
	const { cwd, ctx } = makeCtx();
	registerTask(pi as any);
	setTaskWorkerRunnerForTests(async () => ({
		agent: "worker", agentSource: "user", task: "task", exitCode: 0,
		messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 },
	} as any));
	try {
		await saveTaskbook("project", cwd, "has-node", {
			description: "needs node",
			spec,
			skill: "# Skill",
			verify: "process.exit(0);\n",
			contract: { runtimeInput: [], artifacts: [], requiredBinaries: ["node"] },
		});

		await commands.get("task").handler("run has-node", ctx);
		await waitForTaskRunForTests();

		const loaded = await loadTaskbook(cwd, "has-node");
		assert.equal(loaded?.taskbook.runs.at(-1)?.status, "pass");
	} finally {
		setTaskWorkerRunnerForTests(undefined);
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("/task run uses absolute contract outputDir as the final output directory", async () => {
	const { pi, commands, sentMessages } = makePi();
	const { cwd, ctx, notifications } = makeCtx();
	const finalOutputDir = path.join(cwd, "B站视频下载");
	let workerPrompt = "";
	registerTask(pi as any);
	setTaskWorkerRunnerForTests(async (...args: any[]) => {
		workerPrompt = args[3];
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
	setTaskDispatcherForTests(async () => ({ url: "https://x", expectedOutputDir: finalOutputDir }));
	try {
		await saveTaskbook("project", cwd, "custom-output", {
			description: "custom output",
			spec,
			skill: "# Skill",
			verify: "import {writeFile} from 'node:fs/promises'; if (process.env.TASK_OUTPUT_DIR !== JSON.parse(process.env.TASK_INPUT).expectedOutputDir) process.exit(1); await writeFile(`${process.env.TASK_OUTPUT_DIR}/ok.txt`, 'ok', 'utf8'); process.exit(0);\n",
			contract: { outputDir: finalOutputDir, runtimeInput: ["url"], artifacts: [{ name: "ok.txt", type: "file" }] },
		});

		await commands.get("task").handler("run custom-output https://x", ctx);
		await waitForTaskRunForTests();

		assert.match(latestTaskMessage(sentMessages), /PASS/);
		assert.match(workerPrompt, new RegExp(finalOutputDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
		assert.equal(readFileSync(path.join(finalOutputDir, "ok.txt"), "utf8"), "ok");
	} finally {
		setTaskWorkerRunnerForTests(undefined);
		setTaskDispatcherForTests(undefined);
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("/task run preserves natural language input with spaces and sends pass artifacts to transcript", async () => {
	const { pi, commands, sentMessages } = makePi();
	const { cwd, ctx, notifications, widgetCalls } = makeCtx();
	registerTask(pi as any);
	setTaskWorkerRunnerForTests(async () => {
		const outputDir = path.join(cwd, ".tasks", "runs");
		return {
			agent: "worker",
			agentSource: "user",
			task: "task",
			exitCode: 0,
			messages: [{ role: "assistant", content: [{ type: "text", text: "写好了 count.json" }] }],
			stderr: "",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 },
		} as any;
	});
	setTaskDispatcherForTests(async () => ({ text: "Hello world" }));
	try {
		await saveTaskbook("project", cwd, "runner-file", {
			description: "runner file",
			spec,
			skill: "# Skill",
			verify: "import {writeFile} from 'node:fs/promises'; const input = JSON.parse(process.env.TASK_INPUT); if (input.text !== 'Hello world') process.exit(1); await writeFile(`${process.env.TASK_OUTPUT_DIR}/count.json`, JSON.stringify({count:11}), 'utf8'); process.exit(0);\n",
			contract: { runtimeInput: ["text"], artifacts: [{ name: "count.json", type: "file", required: true }] },
		});

		await commands.get("task").handler("run runner-file Hello world", ctx);
		await waitForTaskRunForTests();

		const sent = sentMessages.at(-1);
		assert.equal(sent?.message.customType, "task-message");
		assert.equal(sent?.message.display, true);
		assert.deepEqual(sent?.options, { triggerTurn: false });
		const message = sent?.message.content ?? "";
		assert.match(message, /PASS/);
		assert.match(message, /任务: runner file/);
		assert.match(message, /count\.json/);
		assert.match(message, /\{"count":11\}/);
		assert.match(message, /## 任务结果/);
		assert.match(message, /## 产物/);
		assert.match(message, /## 验证/);
		assert.match(message, /verify 自证: 全过/);
		assert.match(message, /## 执行摘要/);
		assert.ok(widgetCalls.some((call) => call.lines?.some((line) => /worker 执行中/.test(line))));
		assert.doesNotMatch(notifications.at(-1)?.message ?? "", /## /);
		assert.equal(widgetCalls.at(-1)?.lines, undefined);
	} finally {
		setTaskWorkerRunnerForTests(undefined);
		setTaskDispatcherForTests(undefined);
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("/task run shows progress and reviews last run with a clean reviewer", async () => {
	const { pi, commands, userMessages, sentMessages, renderers } = makePi();
	const { cwd, ctx, notifications, selections, widgetCalls } = makeCtx();
	let reviewerPrompt = "";
	registerTask(pi as any);
	assert.equal(typeof renderers.get("task-progress"), "function");
	assert.equal(typeof renderers.get("task-review-prompt"), "function");
	const reviewRenderer = renderers.get("task-review-prompt");
	const reviewMessage = { content: "line1\nline2\nline3", details: {} };
	const collapsedText = String(reviewRenderer(reviewMessage, { expanded: false }, { fg: (_c: string, t: string) => t, bold: (t: string) => t })?.text ?? "");
	const expandedText = String(reviewRenderer(reviewMessage, { expanded: true }, { fg: (_c: string, t: string) => t, bold: (t: string) => t })?.text ?? "");
	assert.match(collapsedText, /3 行/);
	assert.doesNotMatch(collapsedText, /line1/);
	assert.match(expandedText, /line1/);
	setTaskWorkerRunnerForTests(async (...args: any[]) => {
		const onUpdate = args[7];
		onUpdate?.({
			content: [{ type: "text", text: "打开 Today 页面\n解析工具列表" }],
			details: { mode: "single", agentScope: "both", projectAgentsDir: null, results: [] },
		});
		onUpdate?.({
			content: [{ type: "text", text: "打开 Today 页面\n解析工具列表\n解析工具列表" }],
			details: { mode: "single", agentScope: "both", projectAgentsDir: null, results: [] },
		});
		return {
			agent: "worker",
			agentSource: "user",
			task: "task",
			exitCode: 0,
			messages: [{ role: "assistant", content: [{ type: "text", text: "写好了" }] }],
			stderr: "",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 },
		} as any;
	});
	setTaskRunReviewerRunnerForTests(async (...args: any[]) => {
		reviewerPrompt = args[3];
		// ponytail: 模拟 reviewer 流式吐思考过程,验证复盘点 onUpdate 透传 + widget 流式刷新
		args[7]?.({
			content: [{ type: "text", text: "正在分析 worker 的执行路径..." }],
			details: { mode: "single", agentScope: "both", projectAgentsDir: null, results: [] },
		});
		return {
			agent: args[2],
			agentSource: "user",
			task: args[3],
			exitCode: 0,
			messages: [{ role: "assistant", content: [{ type: "text", text: "复盘结论：worker 一开始没有按 CDP 步骤执行。" }] }],
			stderr: "",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 },
		} as any;
	});
	setTaskDispatcherForTests(async () => ({}));
	try {
		await saveTaskbook("project", cwd, "runner-progress", {
			description: "runner progress",
			spec,
			skill: "# Skill",
			verify: "process.exit(0);\n",
			contract: { artifacts: [] },
		});

		await commands.get("task").handler("run runner-progress", ctx);
		await waitForTaskRunForTests();
		const progressMessage = sentMessages.at(-2)?.message;
		assert.equal(progressMessage?.customType, "task-progress");
		assert.deepEqual(progressMessage?.details.lines, ["打开 Today 页面", "解析工具列表"]);
		assert.equal(sentMessages.at(-1)?.message.customType, "task-message");

		const progress = widgetCalls
			.map((call) => call.lines?.join("\n") ?? "")
			.find((text) => text.includes("最近进展"));
		assert.match(progress ?? "", /1\. 打开 Today 页面/);
		assert.match(progress ?? "", /2\. 解析工具列表/);
		const runReport = sentMessages.at(-1)?.message.content ?? "";
		assert.match(runReport, /## 最近进展/);
		assert.match(runReport, /打开 Today 页面/);
		assert.equal((runReport.match(/打开 Today 页面/g) ?? []).length, 1);
		assert.equal((runReport.match(/解析工具列表/g) ?? []).length, 1);
		assert.doesNotMatch(runReport, /\d+\.\s+\d+\./);

		ctx.ui.select = (title: string, options: string[]) => {
			selections.push({ title, options });
			// ponytail: 复盘汇报后新增的"让 reviewer 直接修"选项,此测试保持原语义选结束
			if (options.includes("结束复盘")) return "结束复盘";
			return "复盘上次运行";
		};
		ctx.ui.input = () => undefined;
		const widgetCountBeforeCancel = widgetCalls.length;
		await commands.get("task").handler("", ctx);

		assert.equal(reviewerPrompt, "");
		assert.equal(widgetCalls.length, widgetCountBeforeCancel);

		ctx.ui.input = () => "一开始没有按 skill 里的 CDP 方法做";
		await commands.get("task").handler("", ctx);

		// ponytail: 复盘成功后新增了"让 reviewer 直接修"select,at(-1) 不再是主菜单,改 some 查找
		assert.ok(selections.some((s) => s.options.includes("复盘上次运行")));
		assert.ok(widgetCalls.some((call) => (call.lines?.join("\n") ?? "").includes("正在复盘")));
		// ponytail: 验证 reviewer 思考过程流式刷到了 widget(不再干等静态文案)
		assert.ok(widgetCalls.some((call) => (call.lines?.join("\n") ?? "").includes("正在分析 worker 的执行路径")));
		assert.equal(userMessages.length, 0);
		assert.match(reviewerPrompt, /TASK RUN REVIEW/);
		assert.match(reviewerPrompt, /runner-progress/);
		assert.match(reviewerPrompt, /打开 Today 页面/);
		assert.match(reviewerPrompt, /一开始没有按 skill 里的 CDP 方法做/);
		const reviewMessage = sentMessages.at(-1);
		assert.equal(reviewMessage?.message.customType, "task-message");
		assert.equal(reviewMessage?.message.display, true);
		assert.deepEqual(reviewMessage?.options, { triggerTurn: false });
		assert.match(reviewMessage?.message.content ?? "", /复盘结论/);
		assert.doesNotMatch(notifications.at(-1)?.message ?? "", /复盘结论/);
	} finally {
		setTaskRunReviewerRunnerForTests(undefined);
		setTaskWorkerRunnerForTests(undefined);
		setTaskDispatcherForTests(undefined);
		rmSync(cwd, { recursive: true, force: true });
	}
});

test('/task review-last-run 选「让 reviewer 直接修」则用 summary 当指令进 edit', async () => {
	const { pi, commands, userMessages, sentMessages } = makePi();
	const { cwd, ctx, selections } = makeCtx();
	registerTask(pi as any);
	// worker 产出合法产物 verify 一次过 让 run 落 pass 以触发复盘上次运行
	setTaskWorkerRunnerForTests(async (...args: any[]) => {
		args[7]?.({ content: [{ type: "text", text: "执行中" }], details: { mode: "single", agentScope: "both", projectAgentsDir: null, results: [] } });
		return { agent: "worker", agentSource: "user", task: "t", exitCode: 0, messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }], stderr: "", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 } } as any;
	});
	// reviewer 复盘吐出明确诊断加建议的 summary
	setTaskRunReviewerRunnerForTests(async (...args: any[]) => {
		args[7]?.({ content: [{ type: "text", text: "分析中" }], details: { mode: "single", agentScope: "both", projectAgentsDir: null, results: [] } });
		return { agent: args[2], agentSource: "user", task: args[3], exitCode: 0, messages: [{ role: "assistant", content: [{ type: "text", text: "修复建议：把 vendored scripts 复制到 taskbook 目录。" }] }], stderr: "", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 } } as any;
	});
	setTaskDispatcherForTests(async () => ({}));
	try {
		await saveTaskbook("project", cwd, "fix-from-review", {
			description: "fix from review",
			spec,
			skill: "# Skill",
			verify: "process.exit(0);\n",
			contract: { artifacts: [] },
		});
		await commands.get("task").handler("run fix-from-review", ctx);
		await waitForTaskRunForTests();

		// 进入复盘 用户观察加复盘后选「让 reviewer 直接修」
		ctx.ui.input = () => "结果有问题";
		ctx.ui.select = (title: string, options: string[]) => {
			selections.push({ title, options });
			if (options.includes("让 reviewer 直接修")) return "让 reviewer 直接修";
			return "复盘上次运行";
		};
		await commands.get("task").handler("", ctx);

		// 断言 复盘汇报后给出了「让 reviewer 直接修」选项
		assert.ok(selections.some((s) => s.options.includes("让 reviewer 直接修")));
		// 选中后 startTaskbookEdit 用 summary 当 UserEditRequest 发 task-review-prompt 给主 agent
		const editPrompt = sentMessages.find((m) => m.message?.customType === "task-review-prompt"
			&& typeof m.message?.content === "string"
			&& m.message.content.includes("UserEditRequest:"));
		assert.ok(editPrompt, "应有含 UserEditRequest 的 task-review-prompt 消息");
		assert.match(editPrompt!.message.content, /修复建议：把 vendored scripts 复制到 taskbook 目录/);
		assert.equal(userMessages.length, 0);
	} finally {
		setTaskRunReviewerRunnerForTests(undefined);
		setTaskWorkerRunnerForTests(undefined);
		setTaskDispatcherForTests(undefined);
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("/task run can be stopped and records user notes while worker is running", async () => {
	const { pi, commands, handlers } = makePi();
	const { cwd, ctx, notifications, selections } = makeCtx();
	let workerStarted!: () => void;
	const started = new Promise<void>((resolve) => {
		workerStarted = resolve;
	});
	let signal: AbortSignal | undefined;
	registerTask(pi as any);
	setTaskWorkerRunnerForTests(async (...args: any[]) => {
		signal = args[6];
		workerStarted();
		await new Promise((resolve) => setTimeout(resolve, 25));
		return {
			agent: "worker",
			agentSource: "user",
			task: "task",
			exitCode: signal?.aborted ? 1 : 0,
			messages: [{ role: "assistant", content: [{ type: "text", text: "stopped" }] }],
			stderr: signal?.aborted ? "aborted" : "",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 },
		} as any;
	});
	setTaskDispatcherForTests(async () => ({}));
	try {
		await saveTaskbook("project", cwd, "runner-stop", {
			description: "runner stop",
			spec,
			skill: "# Skill",
			verify: "process.exit(0);\n",
			contract: { artifacts: [] },
		});

		const runPromise = commands.get("task").handler("run runner-stop", ctx);
		await started;
		assert.equal(await Promise.race([
			runPromise.then(() => "resolved"),
			new Promise((resolve) => setTimeout(() => resolve("timeout"), 5)),
		]), "resolved");
		const inputResult = await handlers.get("input")![0]({ source: "interactive", text: "它正在走错路径" }, ctx);
		const stopResult = await handlers.get("input")![0]({ source: "interactive", text: "/task stop" }, ctx);
		await runPromise;
		await waitForTaskRunForTests();

		assert.equal(inputResult?.handled, true);
		assert.equal(stopResult?.handled, true);
		assert.equal(signal?.aborted, true);
		assert.ok(notifications.some((item) => /已记录/.test(item.message)));
		assert.ok(notifications.some((item) => /已请求停止/.test(item.message)));
		assert.ok(notifications.some((item) => /复盘上次运行/.test(item.message)));

		ctx.ui.select = (title: string, options: string[]) => {
			selections.push({ title, options });
			return "Exit";
		};
		await commands.get("task").handler("", ctx);
		assert.ok(selections.at(-1)?.options.includes("复盘上次运行"));
	} finally {
		setTaskWorkerRunnerForTests(undefined);
		setTaskDispatcherForTests(undefined);
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("/task run user abort (worker throws) reports stopped, not exception", async () => {
	// ponytail: runSingleAgent 在 signal abort 时 throw "Subagent was aborted"。
	// dispatchWorker 必须接住转成 {ok:false},让 handleTaskRun 走"已停止"分支而非"运行异常"。
	const { pi, commands, handlers } = makePi();
	const { cwd, ctx, notifications } = makeCtx();
	let workerStarted!: () => void;
	const started = new Promise<void>((resolve) => {
		workerStarted = resolve;
	});
	registerTask(pi as any);
	setTaskWorkerRunnerForTests(async (...args: any[]) => {
		const signal = args[6] as AbortSignal | undefined;
		workerStarted();
		await new Promise((resolve) => setTimeout(resolve, 25));
		// 复刻真实 runSingleAgent:abort 时 throw(而非返回 error)
		if (signal?.aborted) throw new Error("Subagent was aborted");
		return {
			agent: "worker",
			agentSource: "user",
			task: "task",
			exitCode: 0,
			messages: [{ role: "assistant", content: [{ type: "text", text: "ok" }] }],
			stderr: "",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 },
		} as any;
	});
	setTaskDispatcherForTests(async () => ({}));
	try {
		await saveTaskbook("project", cwd, "runner-throw-abort", {
			description: "runner throw abort",
			spec,
			skill: "# Skill",
			verify: "process.exit(0);\n",
			contract: { artifacts: [] },
		});

		const runPromise = commands.get("task").handler("run runner-throw-abort", ctx);
		await started;
		await handlers.get("input")![0]({ source: "interactive", text: "/task stop" }, ctx);
		await runPromise;
		await waitForTaskRunForTests();

		assert.ok(notifications.some((item) => /已请求停止/.test(item.message)), "应发出停止请求通知");
		assert.ok(notifications.some((item) => /已停止 taskbook/.test(item.message)), "应走已停止分支");
		assert.ok(!notifications.some((item) => /运行异常/.test(item.message)), "不应报运行异常");
		// ponytail: abort 后应补记一条 fail run 到 taskbook,否则中断 run 成孤儿历史不全
		const afterAbort = await loadTaskbook(cwd, "runner-throw-abort");
		assert.ok(afterAbort?.taskbook.runs.some((r) => r.status === "fail"), "abort 应在 taskbook 补记 fail run");
	} finally {
		setTaskWorkerRunnerForTests(undefined);
		setTaskDispatcherForTests(undefined);
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("/task run preauthorizes mentioned protected tools for the worker", async () => {
	const { pi, commands } = makePi(["read", "bash", "edit", "write", "subagent", "chrome_cdp", "alpha__echo"]);
	const { cwd, ctx } = makeCtx();
	const prevCdpPort = process.env.UGK_CDP_PORT;
	process.env.UGK_CDP_PORT = "9666";
	const confirmations: Array<{ title: string; body?: string }> = [];
	let receivedEnv: Record<string, string | undefined> | undefined;
	ctx.ui.confirm = (title: string, body?: string) => {
		confirmations.push({ title, body });
		return true;
	};
	registerTask(pi as any);
	setTaskWorkerRunnerForTests(async (...args: any[]) => {
		receivedEnv = args[9];
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
	setTaskDispatcherForTests(async () => ({}));
	try {
		await saveTaskbook("project", cwd, "runner-tools", {
			description: "runner tools",
			spec,
			skill: "Use chrome_cdp and alpha__echo to finish.",
			verify: "process.exit(0);\n",
			contract: { artifacts: [], requiredTools: ["chrome_cdp", "alpha__echo"] },
		});

		await commands.get("task").handler("run runner-tools", ctx);
		await waitForTaskRunForTests();

		assert.equal(confirmations.length, 1);
		assert.match(confirmations[0].body ?? "", /chrome_cdp/);
		assert.match(confirmations[0].body ?? "", /alpha__echo/);
		assert.equal(receivedEnv?.UGK_TASK_ALLOW_CHROME_CDP, "1");
		assert.equal(receivedEnv?.UGK_CDP_PORT, "9666");
		assert.equal(receivedEnv?.UGK_TASK_ALLOW_MCP_TOOLS, "alpha__echo");
	} finally {
		if (prevCdpPort === undefined) delete process.env.UGK_CDP_PORT;
		else process.env.UGK_CDP_PORT = prevCdpPort;
		setTaskWorkerRunnerForTests(undefined);
		setTaskDispatcherForTests(undefined);
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("/task run does not preauthorize tools mentioned only in contract artifact names", async () => {
	const { pi, commands } = makePi(["read", "bash", "edit", "write", "subagent", "alpha__echo"]);
	const { cwd, ctx } = makeCtx();
	let confirmCalled = false;
	let receivedEnv: Record<string, string | undefined> | undefined;
	ctx.ui.confirm = () => {
		confirmCalled = true;
		return true;
	};
	registerTask(pi as any);
	setTaskWorkerRunnerForTests(async (...args: any[]) => {
		receivedEnv = args[9];
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
	setTaskDispatcherForTests(async () => ({}));
	try {
		await saveTaskbook("project", cwd, "runner-artifact-tool-name", {
			description: "runner artifact tool name",
			spec,
			skill: "Write the requested artifact.",
			verify: "process.exit(0);\n",
			contract: { artifacts: [{ name: "alpha__echo.md", type: "file" }] },
		});

		await commands.get("task").handler("run runner-artifact-tool-name", ctx);
		await waitForTaskRunForTests();

		assert.equal(confirmCalled, false);
		// ponytail: env 应只含 TASK_DIR(运行时注入),不含工具授权(artifact 名不算工具)
		assert.equal(receivedEnv?.UGK_TASK_PROTECTED_TOOLS_GRANT, undefined);
		assert.ok(receivedEnv?.TASK_DIR, "TASK_DIR 应被注入");
	} finally {
		setTaskWorkerRunnerForTests(undefined);
		setTaskDispatcherForTests(undefined);
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("/task run does not start worker when protected tool preauthorization is denied", async () => {
	const { pi, commands } = makePi(["read", "bash", "edit", "write", "subagent", "chrome_cdp"]);
	const { cwd, ctx, notifications } = makeCtx();
	let workerStarted = false;
	ctx.ui.confirm = () => false;
	registerTask(pi as any);
	setTaskWorkerRunnerForTests(async () => {
		workerStarted = true;
		throw new Error("should not run");
	});
	setTaskDispatcherForTests(async () => ({}));
	try {
		await saveTaskbook("project", cwd, "runner-denied", {
			description: "runner denied",
			spec,
			skill: "Use chrome_cdp.",
			verify: "process.exit(0);\n",
			contract: { artifacts: [], requiredTools: ["chrome_cdp"] },
		});

		await commands.get("task").handler("run runner-denied", ctx);

		assert.equal(workerStarted, false);
		assert.match(notifications.at(-1)?.message ?? "", /已取消/);
	} finally {
		setTaskWorkerRunnerForTests(undefined);
		setTaskDispatcherForTests(undefined);
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("/task run displays small markdown artifact content in the PASS report", async () => {
	const { pi, commands, sentMessages } = makePi();
	const { cwd, ctx, notifications } = makeCtx();
	registerTask(pi as any);
	setTaskWorkerRunnerForTests(async () => ({
		agent: "worker",
		agentSource: "user",
		task: "task",
		exitCode: 0,
		messages: [{ role: "assistant", content: [{ type: "text", text: "写好了 markdown" }] }],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 },
	}) as any);
	setTaskDispatcherForTests(async () => ({}));
	try {
		await saveTaskbook("project", cwd, "runner-md", {
			description: "runner md",
			spec,
			skill: "# Skill",
			verify: "import {writeFile} from 'node:fs/promises'; await writeFile(`${process.env.TASK_OUTPUT_DIR}/report.md`, '| Name | Desc |\\n|---|---|\\n| Kane CLI | Browser automation |\\n', 'utf8'); process.exit(0);\n",
			contract: { artifacts: [{ name: "report.md", type: "file", required: true }] },
		});

		await commands.get("task").handler("run runner-md", ctx);
		await waitForTaskRunForTests();

		const message = latestTaskMessage(sentMessages);
		assert.match(message, /任务: runner md/);
		assert.match(message, /### report\.md/);
		assert.match(message, /\| Kane CLI \| Browser automation \|/);
		assert.match(message, /## 执行摘要\n> 写好了 markdown/);
	} finally {
		setTaskWorkerRunnerForTests(undefined);
		setTaskDispatcherForTests(undefined);
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("/task run asks for missing input when no raw text is provided", async () => {
	const { pi, commands } = makePi();
	const { cwd, ctx } = makeCtx();
	registerTask(pi as any);
	setTaskWorkerRunnerForTests(async () => ({
		agent: "worker",
		agentSource: "user",
		task: "task",
		exitCode: 0,
		messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 },
	}) as any);
	setTaskDispatcherForTests(async () => undefined);
	try {
		await saveTaskbook("project", cwd, "runner-b64", {
			description: "runner b64",
			spec,
			skill: "# Skill",
			verify: "const input = JSON.parse(process.env.TASK_INPUT); if (input.text !== 'text') process.exit(1); process.exit(0);\n",
			contract: { runtimeInput: ["text"], artifacts: [] },
		});

		await commands.get("task").handler("run runner-b64", ctx);
		await waitForTaskRunForTests();
		const loaded = await loadTaskbook(cwd, "runner-b64");

		assert.equal(loaded?.taskbook.runs.at(-1)?.status, "pass");
		assert.deepEqual(loaded?.taskbook.runs.at(-1)?.input, { text: "text" });
	} finally {
		setTaskWorkerRunnerForTests(undefined);
		setTaskDispatcherForTests(undefined);
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("/task run sends verify failures to checker and records fail on abort", async () => {
	const { pi, commands, sentMessages } = makePi();
	const { cwd, ctx, notifications } = makeCtx();
	registerTask(pi as any);
	setTaskWorkerRunnerForTests(async () => ({
		agent: "worker",
		agentSource: "user",
		task: "task",
		exitCode: 0,
		messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 },
	}) as any);
	setTaskCheckerRunnerForTests(async () => ({
		agent: "checker",
		agentSource: "user",
		task: "task",
		exitCode: 0,
		messages: [{ role: "assistant", content: [{ type: "text", text: "```json\n{\"hint\":\"坏输入\",\"verdict\":\"abort\",\"reason\":\"无法修复\"}\n```" }] }],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 },
	}) as any);
	try {
		await saveTaskbook("project", cwd, "runner-fail", {
			description: "runner fail",
			spec,
			skill: "# Skill",
			verify: "console.log(JSON.stringify([{assertion:'a',expected:'e',actual:'x'}])); process.exit(1);\n",
			contract: { artifacts: [] },
		});

		await commands.get("task").handler("run runner-fail", ctx);
		await waitForTaskRunForTests();
		const loaded = await loadTaskbook(cwd, "runner-fail");
		const message = latestTaskMessage(sentMessages);

		assert.ok(notifications.some((item) => /checker 判 abort/.test(item.message)));
		assert.match(message, /FAIL/);
		assert.match(message, /任务: runner fail/);
		assert.match(message, /失败断言/);
		assert.match(message, /## 执行摘要\n> done/);
		assert.equal(loaded?.taskbook.runs.at(-1)?.status, "fail");
		assert.equal(loaded?.taskbook.runs.at(-1)?.verifyFailures[0].assertion, "a");
	} finally {
		setTaskWorkerRunnerForTests(undefined);
		setTaskCheckerRunnerForTests(undefined);
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("/task run failure offers optional taskbook repair", async () => {
	const { pi, commands, entries, userMessages, sentMessages } = makePi();
	const { cwd, ctx, notifications, selections } = makeCtx();
	registerTask(pi as any);
	setTaskWorkerRunnerForTests(async () => ({
		agent: "worker",
		agentSource: "user",
		task: "task",
		exitCode: 0,
		messages: [{ role: "assistant", content: [{ type: "text", text: "wrote bad links" }] }],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 },
	}) as any);
	setTaskCheckerRunnerForTests(async () => ({
		agent: "checker",
		agentSource: "user",
		task: "task",
		exitCode: 0,
		messages: [{ role: "assistant", content: [{ type: "text", text: "```json\n{\"hint\":\"修 verify\",\"verdict\":\"abort\",\"reason\":\"verify 太严\"}\n```" }] }],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 },
	}) as any);
	try {
		await saveTaskbook("project", cwd, "runner-repair", {
			description: "runner repair",
			spec,
			skill: "# Skill",
			verify: "console.log(JSON.stringify([{assertion:'link',expected:'toolify link',actual:'bad'}])); process.exit(1);\n",
			contract: { artifacts: [] },
		});

		await commands.get("task").handler("run runner-repair", ctx);
		await waitForTaskRunForTests();
		assert.match(latestTaskMessage(sentMessages), /用 \/task 选择修正/);

		ctx.ui.select = (title: string, options: string[]) => {
			selections.push({ title, options });
			return "修正本 taskbook";
		};
		await commands.get("task").handler("", ctx);

		assert.deepEqual(selections.at(-1)?.options, ["复盘上次运行", "修正本 taskbook", "重新运行", "查看 taskbook 详情", "放弃", "Exit"]);
		assert.equal((entries.at(-1)?.data as any).phase, "reviewing");
		const repairPrompt = sentMessages.at(-1);
		assert.equal(repairPrompt?.message?.customType, "task-review-prompt");
		assert.match(repairPrompt?.message?.content ?? "", /修正已有 taskbook/);
		assert.match(repairPrompt?.message?.content ?? "", /失败断言/);
		assert.match(repairPrompt?.message?.content ?? "", /link/);
	} finally {
		setTaskWorkerRunnerForTests(undefined);
		setTaskCheckerRunnerForTests(undefined);
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("/task save defaults to execute output dir when no output-dir is passed", async () => {
	const { pi, commands, handlers, entries, userMessages } = makePi();
	const { cwd, ctx, notifications } = makeCtx();
	registerTask(pi as any);

	try {
		await commands.get("task").handler("new", ctx);
		await handlers.get("tool_call")![0]({ toolName: "questionnaire" }, ctx);
		await handlers.get("agent_end")![0]({
			messages: [{
				role: "assistant",
				content: [{ type: "text", text: `\`\`\`json\n${JSON.stringify(spec)}\n\`\`\`` }],
			}],
		}, ctx);
		await commands.get("task").handler("execute", ctx);
		const executeRunDir = (entries.at(-1)?.data as any).executeRunDir;
		assert.match(userMessages.at(-1)?.text ?? "", /TASK_OUTPUT_DIR/);
		await mkdir(path.join(executeRunDir, "output"), { recursive: true });
		await writeFile(path.join(executeRunDir, "output", "report.json"), "{}", "utf8");

		await handlers.get("tool_call")![0]({ toolName: "task_complete", input: { summary: "已生成 report.json" } }, ctx);
		await handlers.get("tool_execution_end")![0]({ toolName: "task_complete", isError: false, result: { details: { summary: "已生成 report.json" } } }, ctx);
		await handlers.get("input")![0]({ source: "interactive", text: "" }, ctx);
		await handlers.get("tool_call")![0]({ toolName: "questionnaire" }, ctx);
		await handlers.get("agent_end")![0]({
			messages: [{
				role: "assistant",
				content: [{ type: "text", text: `\`\`\`json
{"description":"生成报告","skill":"# Skill","verify":"import {stat} from 'node:fs/promises'; try { await stat(process.env.TASK_OUTPUT_DIR + '/report.json'); process.exit(0); } catch { console.log(JSON.stringify([{assertion:'report.json exists',expected:'present',actual:'missing'}])); process.exit(1); }","contract":{"artifacts":[{"name":"report.json","type":"file"}]}}
\`\`\`` }],
			}],
		}, ctx);

		await commands.get("task").handler("save smart --project", ctx);

		assert.equal((entries.at(-1)?.data as any).phase, "landed");
		assert.match(notifications.at(-1)?.message ?? "", /已就绪/);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("looksLikeMissingArtifact flags missing-file failures and stays quiet otherwise", () => {
	// ponytail: 「文件不存在」是产物名漂移的典型症状。命中即提示,正常失败不误报。
	const miss = (actual: string) => [{ assertion: "产物存在", expected: "pass", actual }];
	assert.equal(looksLikeMissingArtifact([]), false);
	assert.equal(looksLikeMissingArtifact(miss("ENOENT: no such file")), true);
	assert.equal(looksLikeMissingArtifact(miss("文件 linux_do_post.json 不存在")), true);
	assert.equal(looksLikeMissingArtifact(miss("找不到 report.md")), true);
	assert.equal(looksLikeMissingArtifact(miss("not found")), true);
	assert.equal(looksLikeMissingArtifact(miss('字段 name 实际为 "wrong"')), false, "内容错误不算文件不存在");
	assert.equal(looksLikeMissingArtifact(miss("exit 1")), false, "非文件类失败不误报");
});
