/**
 * ⚠️ task 模块设计红线 —— 改这里前必读(改 description/并行逻辑尤甚)。
 * 权威说明: docs/design/2026-06-26-task-atomic-unit-and-parallel-primitive.md
 *
 * 1. task = 原子单元。用户验收过的 task 对调用方是不可分割的"单位 1"。
 *    内部做 1 步还是 100 步对调用方不可见。调用方不拆 task、不替它做拆分决策。
 *
 * 2. 并行编排是工具层能力,不是用户 skill 的责任。run_task 与 subagent 平级:
 *    - single:  run_task({name, input})            ↔ subagent({agent, task})
 *    - parallel:run_task({tasks:[{name,input}]})   ↔ subagent({tasks:[{agent,task}]})
 *    想并行 N 个 task(N≤8),只有 run_task({tasks:[...]}) 一条正路。
 *
 * 3. 三条禁止(违反即 bug):
 *    ① 不把"教 agent 并行"下放给用户 skill.md —— 换个偏科 task 就失效。
 *    ② 不让 agent 绕 subagent 做并行 task —— subagent worker 会丢受保护工具授权
 *       (buildSubagentChildEnv, subagent.ts:78-79),必授权失败。
 *    ③ 不让 agent 用 bash/python 中转构造 JSON 喂 run_task —— 工具参数由 LLM 直接构造。
 *
 * 4. 发现性铁律:run_task 的 parallel 模式必须和 subagent 同等可见(写在 description
 *    首行,不是藏在参数注释里)。发现性退化 = agent 绕路 = bug。
 */
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { spawn } from "node:child_process";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
	extractArtifactsFromToolInput,
	isPlanningAllowedCommand,
	summarizeToolArgs,
} from "./task-utils.ts";
import { extractRequirementsSpec, formatRequirementsSpec } from "./task-spec.ts";
import {
	abortTask,
	createTaskState,
	enterPlanning,
	enterReviewing,
	landTask,
	markPlanQuestionnaireUsed,
	markReviewQuestionnaireUsed,
	recordExecuteProcessEntry,
	setPendingTransition,
	setTaskSpec,
	setTaskReviewResult,
	startExecuting,
	type LastRunReview,
	type TaskPhase,
	type TaskState,
} from "./task-state.ts";
import { appendRunToTaskbook, assertValidContract, deleteTaskbook, listTaskbooks, loadTaskbook, renameTaskbook, saveTaskbook, type LoadedTaskbook } from "./task-book.ts";
import { ensureCliAuth, readTaskShareConfig, writeTaskShareConfig } from "./task-share-auth.ts";
import { publishTask } from "./task-share-publish.ts";
import { dispatchChecker } from "./task-checker.ts";
import { resolveRuntimeInputFromText } from "./task-dispatcher.ts";
import { buildTaskReviewPrompt, extractTaskReviewResult, TASK_ALIGN_PROMPT } from "./task-prompts.ts";
import { buildTaskbookPrompt } from "./task-registry.ts";
import { dispatchTaskGuide } from "./task-guide.ts";
import { dispatchTaskRunReviewer } from "./task-run-reviewer.ts";
import { runVerify, type VerifyFailure } from "./task-verify.ts";
import { dispatchWorker, type TaskWorkerResult } from "./task-worker.ts";
import { mapWithConcurrencyLimit } from "../subagent-runtime.ts";
import { isAutopilotOn } from "../shared/autopilot.ts";
import { isBinaryAvailable } from "../shared/binary.ts";

const TASK_STATE_TYPE = "task-state";
const TASK_PLAN_CONTEXT_TYPE = "task-plan-context";
const TASK_REVIEW_CONTEXT_TYPE = "task-review-context";
const TASK_REVIEW_PROMPT_TYPE = "task-review-prompt";
// ponytail: task 周期"止"边界。退出 task 时注入(display:false 静默),标记"上个 task
// 的对话到此为止"。filterTaskContextMessages 用它成对定位"已结束的 task 周期"并整体滤掉,
// 避免上个 task 的问卷答案/Spec 污染新建 task 的 agent 上下文。用户退出后的闲聊在它之后,
// 不属任何周期,保留。跨 session 复活(appendCustomMessageEntry 持久化)。
const TASK_CONTEXT_END_TYPE = "task-context-end";
const TASK_PLANNING_TOOLS = ["read", "bash", "grep", "find", "ls", "questionnaire"];
const TASK_NORMAL_TOOLS = ["read", "bash", "edit", "write", "subagent"];
const PREVIEW_TEXT_EXTENSIONS = new Set([".md", ".txt", ".json", ".csv", ".tsv", ".html", ".htm"]);
const MAX_ARTIFACT_PREVIEW_CHARS = 12000;
// 并发上限:并行 task 是工具层原语,见文件头红线①②③④ + docs/design/2026-06-26-task-atomic-unit-and-parallel-primitive.md §2.2
// 改这两个常数前先确认没有破坏 run_task({tasks:[...]}) 与 subagent({tasks:[...]}) 的对偶语义。
const SUBTASK_MAX = 8;
const SUBTASK_CONCURRENCY = 4;

type SubtaskRequest = { name: string; input: string };
type SubtaskResult = {
	name: string;
	status: "pass" | "fail";
	outputDir: string;
	artifacts: string[];
	verifyFailures: Awaited<ReturnType<typeof runVerify>>["failures"];
	workerSummary: string;
	duration: number;
	attempts: number;
	usage?: TaskWorkerResult["usage"];
	model?: string;
	apiUsage?: TaskApiUsage[];
	phases?: Record<string, number>; // ponytail: 诊断用,各阶段耗时(ms)
	parseFailed?: boolean; // ponytail: 此 FAIL 源自输入解析失败(非 worker/verify),run_task 层据此判断是否标 isError
};

type TaskApiUsage = {
	model?: string;
	usage: TaskWorkerResult["usage"];
};

type TaskRunFailure = {
	taskbookName: string;
	taskbookScope: LoadedTaskbook["scope"];
	spec: LoadedTaskbook["spec"];
	runDir: string;
	summary: string;
};

type ActiveTaskRun = {
	taskbookName: string;
	abortController: AbortController;
	progress: string[];
	notes: string[];
};

type LastTaskRunReview = {
	taskbookName: string;
	content: string;
};

type TaskProgressDetails = {
	taskbookName: string;
	status: "PASS" | "FAIL";
	lines: string[];
};

let activeTaskRun: ActiveTaskRun | undefined;
let lastTaskRunReview: LastTaskRunReview | undefined;
let taskRunPromiseForTests: Promise<void> = Promise.resolve();
// ponytail: 会话级受保护工具授权缓存。用户在本次会话授权过某 taskbook 用受保护工具
// (chrome_cdp/mcp),后续 run_task / /task run 不再弹 confirm。报告场景:下 40 个视频时
// main 反复 run_task bilibili-downloader,每次都弹"允许受保护工具"打断用户。
// 粒度=taskbook 名:授权是"这个 taskbook 本会话可信",不是"这次调用"。
const protectedToolGrants = new Set<string>();

export function resetTaskProtectedToolGrantsForTests(): void {
	protectedToolGrants.clear();
}

export function waitForTaskRunForTests(): Promise<void> {
	return taskRunPromiseForTests;
}

// ponytail: 测试 spy hook —— 验证 parallel 入口集中 hydrate 去重(批次级 reader 只调用去重后的次数)。
export function setWindowsUserEnvReaderForTests(reader: ((name: string) => Promise<string | undefined>) | undefined): void {
	readWindowsUserEnvImpl = reader ?? defaultReadWindowsUserEnvImpl;
}

const taskCompleteTool = defineTool({
	name: "task_complete",
	label: "Task Complete",
	description: "Signal that /task executing phase has completed and review can start.",
	parameters: Type.Object({
		summary: Type.Optional(Type.String({ description: "Short completion summary" })),
	}),
	async execute(_toolCallId, params) {
		const summary = typeof params.summary === "string" ? params.summary : "";
		return {
			content: [{ type: "text", text: summary ? `task_complete received: ${summary}` : "task_complete received." }],
			details: { completed: true, summary },
		};
	},
});

const MENU_TO_ACTION = new Map<string, string | undefined>([
	["新建任务", "new"],
	["开始执行", "execute"],
	["继续对齐", "clarify"],
	["修改当前 Spec", "change-spec"],
	["运行 taskbook", "run"],
	["运行 taskbook(复用)", "run"],
	["查看 taskbook 详情", "show"],
	["编辑 taskbook", "edit"],
	["重命名 taskbook", "rename"],
	["列出 taskbook", "list"],
	["保存为 taskbook", "save"],
	["自动保存并自证", "save"],
	["自动保存 taskbook", "save"],
	["删除 taskbook", "delete"],
	["上传到市场", "publish"],
	["进入复盘", "continue-review"],
	["继续复盘", "continue-review"],
	["修正本 taskbook", "repair"],
	["重新运行", "rerun"],
	["放弃", "abort"],
	["停止本次执行", "stop"],
	["停止当前运行", "stop"],
	["查看运行进展", "run-status"],
	["复盘上次运行", "review-last-run"],
	["退出 Task", "exit"],
	["Exit", undefined],
]);

function isActivePhase(phase: TaskPhase): boolean {
	return phase === "planning" || phase === "executing" || phase === "reviewing";
}

// execute 阶段的 task-creator 继承 main session 全部工具(含 chrome_cdp/mcp 等环境工具),
// 只排除 subagent(spec 4.2:task-creator 必须亲手做),并补 task_complete 信号工具。
// 用 active snapshot/current active set,不用 getAllTools 全量注册表,避免打开从未启用的注册工具。
function applyExecuteTools(pi: ExtensionAPI): void {
	const blocked = new Set(["subagent"]);
	const next = (typeof pi.getActiveTools === "function" ? pi.getActiveTools() : TASK_NORMAL_TOOLS)
		.filter((tool) => !blocked.has(tool));
	if (!next.includes("task_complete")) next.push("task_complete");
	pi.setActiveTools?.(next);
}

export function getTaskCommandMenuOptions(state: TaskState): string[] {
	if (state.pendingTransition === "repair") return ["修正本 taskbook", "重新运行", "查看 taskbook 详情", "放弃", "Exit"];
	if (state.phase === "planning") {
		return state.spec
			? ["开始执行", "继续对齐", "修改当前 Spec", "退出 Task", "Exit"]
			: ["继续对齐", "退出 Task", "Exit"];
	}
	if (state.phase === "executing") return ["进入复盘", "停止本次执行", "Exit"];
	if (state.phase === "reviewing") return ["自动保存并自证", "继续复盘", "放弃", "退出 Task", "Exit"];
	return ["新建任务", "运行 taskbook(复用)", "查看 taskbook 详情", "编辑 taskbook", "重命名 taskbook", "删除 taskbook", "上传到市场", "Exit"];
}

export async function resolveTaskCommandArgs(args: string, ctx: any, state: TaskState, runActive = false, hasLastRunReview = false): Promise<string | undefined> {
	if (args.trim()) return args;
	if (runActive && ctx.ui?.select) {
		const selection = await ctx.ui.select("Task", ["停止当前运行", "查看运行进展", "Exit"]);
		return selection ? MENU_TO_ACTION.get(selection) : undefined;
	}
	if (!ctx.ui?.select) return "list";
	const options = getTaskCommandMenuOptions(state);
	const selection = await ctx.ui.select("Task", hasLastRunReview && !isActivePhase(state.phase)
		? ["复盘上次运行", ...options]
		: options);
	return selection ? MENU_TO_ACTION.get(selection) : undefined;
}

function cwdOf(ctx: any): string {
	return ctx.cwd ?? process.cwd();
}

function isAssistantMessage(message: any): boolean {
	return message?.role === "assistant" && Array.isArray(message.content);
}

function getTextContent(message: any): string {
	return message.content
		.filter((block: any) => block.type === "text")
		.map((block: any) => block.text)
		.join("\n");
}

// ponytail: abort 的可靠信号是结构化的 stopReason,不是 assistant 文本。ESC 走
// handleRunFailure,产出的 assistant content 是空串,文本正则永远匹配不到——所以
// task 把它误判成"没输出合法 spec",发 followUp 让 agent 重跑(pi 的 _handlePostAgentRun
// 会自动 drain 队列续命),ESC 退出不了。优先看 stopReason,文本回退只兜 questionnaire 取消。
function isCancelledAssistant(message: any): boolean {
	if (message?.stopReason === "aborted") return true;
	return /\bOperation aborted\b|User cancelled the questionnaire/i.test(getTextContent(message));
}

// ponytail: questionnaire 被用户取消 ≠ agent 没本事吐 spec。取消是 tool result(不是
// abort 信号),assistant 之后会正常输出"已取消,等你指示"。若 task 仍按 !spec 分支发
// followUp,pi 会自动续命重跑问卷(agent 也会因 prompt 强制调问卷而照办)—— 又死循环。
// 这里识别"本次 turn 里有 questionnaire 取消",让 task 停下交还控制权。
// ponytail: 取消是不可恢复语义——一旦取消,本次 turn 产物就该作废。所以扫整条序列找
// 取消信号,而不是只看"最后一条 toolResult"。否则取消后 agent 再调一个 tool(read 等),
// 新 toolResult 会把取消的盖掉,task 又误判成"没产物该重试",死循环原样复发。
function hasQuestionnaireCancellation(messages: any[]): boolean {
	return messages.some((message) =>
		message?.role === "toolResult" && /\bUser cancelled the questionnaire\b/i.test(getTextContent(message)));
}

function isTaskPlanContextMessage(message: any): boolean {
	return message?.role === "custom" && message.customType === TASK_PLAN_CONTEXT_TYPE;
}

function isTaskReviewContextMessage(message: any): boolean {
	return message?.role === "custom" && message.customType === TASK_REVIEW_CONTEXT_TYPE;
}

function isTaskContextEndMessage(message: any): boolean {
	return message?.role === "custom" && message.customType === TASK_CONTEXT_END_TYPE;
}

// 起边界:planning 阶段认 plan-context,reviewing 阶段认 review-context。
function isTaskStartBoundary(message: any, phase: TaskState["phase"]): boolean {
	return phase === "planning" ? isTaskPlanContextMessage(message) : isTaskReviewContextMessage(message);
}

function filterTaskContextMessages(messages: any[], state: TaskState): any[] {
	// ponytail: 非 task 阶段,清掉所有 task 标记(本阶段的起、对方阶段的起、所有止)。
	if (state.phase !== "planning" && state.phase !== "reviewing") {
		return messages.filter((message) =>
			!isTaskPlanContextMessage(message) && !isTaskReviewContextMessage(message) && !isTaskContextEndMessage(message));
	}
	// planning/reviewing:按 task 周期分段。
	// 起边界:本阶段认本阶段的 context(plan-ctx 或 review-ctx);对方阶段的 context 一律滤掉。
	// 止边界:task-context-end。
	// 规则:成对的(起 ... 止)之间(含起止本身)整体滤掉 = 已结束的 task 周期。
	//       最后一段未闭合的(起 ... 无止)= 当前进行中的 task,保留。
	//       止之后、下一起之前的消息(用户退出 task 后的闲聊)= 不属任何周期,保留。
	const keep = new Array(messages.length).fill(true);
	let pendingStart = -1; // 当前未闭合"起"的 index
	for (let index = 0; index < messages.length; index += 1) {
		const message = messages[index];
		if (isTaskContextEndMessage(message)) {
			if (pendingStart >= 0) {
				// 闭合:起...止 整段滤掉(已结束的 task 周期)
				for (let j = pendingStart; j <= index; j += 1) keep[j] = false;
				pendingStart = -1;
			} else {
				keep[index] = false; // 孤立的止(session 恢复残留),滤掉自身
			}
		} else if (isTaskStartBoundary(message, state.phase)) {
			// 同一周期内多次注入起边界(每轮 before_agent_start 都注入一条),旧的该清掉避免重复。
			// 注意:只滤起边界本身,它之后的对话内容仍属本周期,保留(除非被止闭合)。
			if (pendingStart >= 0) keep[pendingStart] = false;
			pendingStart = index; // 新起覆盖
		} else if (state.phase === "planning" ? isTaskReviewContextMessage(message) : isTaskPlanContextMessage(message)) {
			keep[index] = false; // 对方阶段的起边界,滤掉
		}
	}
	// ponytail: 循环结束 pendingStart >= 0 的未闭合段 = 当前 task,保留(默认 keep=true)。
	return messages.filter((_, index) => keep[index]);
}

function restoreTaskState(data: unknown): TaskState | undefined {
	if (!data || typeof data !== "object" || Array.isArray(data)) return undefined;
	const record = data as Partial<TaskState>;
	if (
		record.phase !== "planning" &&
		record.phase !== "executing" &&
		record.phase !== "reviewing" &&
		record.phase !== "landed" &&
		record.phase !== "aborted" &&
		record.phase !== "done"
	) {
		return undefined;
	}
	return {
		...createTaskState(),
		...record,
		spec: record.spec ?? null,
		taskbookScope: record.taskbookScope === "user" || record.taskbookScope === "project" ? record.taskbookScope : undefined,
		summary: typeof record.summary === "string" ? record.summary : "",
		retryCount: typeof record.retryCount === "number" ? record.retryCount : 0,
		maxRetry: typeof record.maxRetry === "number" ? record.maxRetry : 3,
		planQuestionnaireUsed: record.planQuestionnaireUsed === true,
		reviewQuestionnaireUsed: record.reviewQuestionnaireUsed === true,
		executeRunDir: typeof record.executeRunDir === "string" ? record.executeRunDir : undefined,
		executeProcessLog: Array.isArray(record.executeProcessLog) ? record.executeProcessLog as TaskState["executeProcessLog"] : [],
		pendingTransition: record.pendingTransition === "execute" || record.pendingTransition === "review" || record.pendingTransition === "save" || record.pendingTransition === "repair"
			? record.pendingTransition
			: undefined,
		lastRunReview: record.lastRunReview && typeof record.lastRunReview === "object"
			&& typeof (record.lastRunReview as LastRunReview).taskbookName === "string"
			&& typeof (record.lastRunReview as LastRunReview).content === "string"
			? record.lastRunReview as LastRunReview
			: undefined,
	};
}

function formatTaskList(items: Awaited<ReturnType<typeof listTaskbooks>>): string {
	if (items.length === 0) return "No taskbooks found.";
	return items
		.map((item) => {
			const last = item.lastRun ? ` last=${item.lastRun.status}` : " last=-";
			return `${item.name} [${item.scope}]${last} — ${item.description}`;
		})
		.join("\n");
}

function tagFromTokens(tokens: string[]): string | undefined {
	const index = tokens.indexOf("--tag");
	return index >= 0 ? tokens[index + 1] : undefined;
}

async function handleTaskList(ctx: any, tokens: string[]): Promise<void> {
	ctx.ui.notify(formatTaskList(await listTaskbooks(cwdOf(ctx), tagFromTokens(tokens))), "info");
}

async function chooseTaskbookName(ctx: any, name: string | undefined, tag?: string): Promise<string | undefined> {
	if (name) return name;
	const items = await listTaskbooks(cwdOf(ctx), tag);
	if (items.length === 0) {
		ctx.ui.notify("No taskbooks found.", "warning");
		return undefined;
	}
	if (!ctx.ui?.select) return items[0].name;
	const selected = await ctx.ui.select("选择 taskbook", items.map((item) => item.name));
	return selected || undefined;
}

type TaskGuideItem = {
	id: number;
	title: string;
	detail: string;
};

function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function summarizeContractArtifacts(contract: unknown): string {
	const artifacts = asRecord(contract).artifacts;
	if (!Array.isArray(artifacts) || artifacts.length === 0) return "未声明固定产物";
	return artifacts.map((item) => {
		if (typeof item === "string") return item;
		const record = asRecord(item);
		return [record.path, record.description].filter((part) => typeof part === "string" && part).join(" - ");
	}).filter(Boolean).join("; ") || "未声明固定产物";
}

function summarizeRuntimeInput(contract: unknown): string {
	const runtimeInput = asRecord(contract).runtimeInput;
	return Array.isArray(runtimeInput) && runtimeInput.length > 0
		? runtimeInput.filter((item) => typeof item === "string").join(", ")
		: "无额外输入字段";
}

function summarizeRequiredTools(contract: unknown): string {
	const requiredTools = asRecord(contract).requiredTools;
	return Array.isArray(requiredTools) && requiredTools.length > 0
		? requiredTools.filter((item) => typeof item === "string").join(", ")
		: "未声明受保护工具";
}

// ponytail: 外部 CLI 依赖( yt-dlp/ffmpeg/python 等)的展示。task 可移植的关键:依赖自描述。
// 过滤规则与 missingRequiredBinaries 对齐(滤空白),避免 ["yt-dlp",""] 显示成尾随逗号。
function summarizeRequiredBinaries(contract: unknown): string {
	const requiredBinaries = asRecord(contract).requiredBinaries;
	const names = Array.isArray(requiredBinaries)
		? requiredBinaries.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
		: [];
	return names.length > 0 ? names.join(", ") : "无外部 CLI 依赖";
}

function missingRequiredEnv(contract: unknown, env: Record<string, string | undefined> = process.env): string[] {
	const requiredEnv = asRecord(contract).requiredEnv;
	return Array.isArray(requiredEnv)
		? requiredEnv.filter((name): name is string => typeof name === "string" && name.trim().length > 0)
			.filter((name) => !env[name]?.trim())
		: [];
}

// ponytail: 外部 CLI 依赖的缺失检查,与 missingRequiredEnv 同模式。用 isBinaryAvailable 查 PATH。
// 不校验版本(YAGNI),只验"在不在"。缺失即 FAIL/notify,让 agent/人补装后重试。
function missingRequiredBinaries(contract: unknown): string[] {
	const requiredBinaries = asRecord(contract).requiredBinaries;
	return Array.isArray(requiredBinaries)
		? requiredBinaries.filter((name): name is string => typeof name === "string" && name.trim().length > 0)
			.filter((name) => !isBinaryAvailable(name))
		: [];
}

function requiredEnvValues(contract: unknown): Record<string, string> {
	const requiredEnv = asRecord(contract).requiredEnv;
	if (!Array.isArray(requiredEnv)) return {};
	const values: Record<string, string> = {};
	for (const name of requiredEnv) {
		if (typeof name === "string" && process.env[name]?.trim()) values[name] = process.env[name]!;
	}
	return values;
}

async function readWindowsUserEnv(name: string): Promise<string | undefined> {
	if (process.platform !== "win32") return undefined;
	return await readWindowsUserEnvImpl(name);
}

// ponytail: test override —— 让测试能 spy hydrate 实际调用次数(验证 parallel 去重),
// 不真开 powershell。生产路径用默认 impl。
let readWindowsUserEnvImpl: (name: string) => Promise<string | undefined> = defaultReadWindowsUserEnvImpl;
async function defaultReadWindowsUserEnvImpl(name: string): Promise<string | undefined> {
	return await new Promise((resolve) => {
		const child = spawn("powershell.exe", [
			"-NoProfile",
			"-Command",
			"[Environment]::GetEnvironmentVariable($env:UGK_ENV_NAME,'User')",
		], {
			windowsHide: true,
			env: { ...process.env, UGK_ENV_NAME: name },
			stdio: ["ignore", "pipe", "ignore"],
		});
		let stdout = "";
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
		});
		child.on("error", () => resolve(undefined));
		child.on("close", () => {
			const value = stdout.trim();
			resolve(value || undefined);
		});
	});
}

async function hydrateRequiredEnv(contract: unknown): Promise<void> {
	for (const name of missingRequiredEnv(contract)) {
		const value = await readWindowsUserEnv(name);
		if (value) process.env[name] = value;
	}
}

// ponytail: 批次级 hydrate —— run_task parallel 入口一次性补齐所有 task 声明的 requiredEnv,
// 避免每个 subtask 各开 powershell(N task × M env = N×M 次 spawn)。requiredEnv 去重后串行读一次即可。
async function hydrateRequiredEnvForTaskbooks(taskbooks: LoadedTaskbook[]): Promise<void> {
	const names = [...new Set(taskbooks.flatMap((item) => missingRequiredEnv(item.contract)))];
	for (const name of names) {
		const value = await readWindowsUserEnv(name);
		if (value) process.env[name] = value;
	}
}

async function persistWindowsUserEnv(name: string, value: string, ctx?: any): Promise<void> {
	if (process.platform !== "win32" || process.env.UGK_REQUIRED_ENV_PERSIST === "0") return;
	// ponytail: setx 失败要可观测。之前 error/close 都静默 resolve,用户填的 key 若因权限/策略没存进
	// Windows User env,当前会话能跑(值在进程内存)但下次新开 ugk 又被问,困惑"不是配过了吗"。
	// 这里捕获退出码,error/非0 都 notify 警告,让用户知道本次没持久化、需手动 setx。
	let outcome: "ok" | "fail" | undefined;
	await new Promise<void>((resolve) => {
		const child = spawn("powershell.exe", [
			"-NoProfile",
			"-Command",
			"[Environment]::SetEnvironmentVariable($env:UGK_ENV_NAME,$env:UGK_ENV_VALUE,'User')",
		], {
			windowsHide: true,
			env: { ...process.env, UGK_ENV_NAME: name, UGK_ENV_VALUE: value },
			stdio: "ignore",
		});
		child.on("error", () => { outcome = "fail"; resolve(); });
		child.on("close", (code) => { outcome = code === 0 ? "ok" : "fail"; resolve(); });
	});
	if (outcome === "fail") {
		ctx?.ui?.notify?.(
			`${name} 本次已生效,但持久化到 Windows 失败(权限或策略),下次新开会话可能需要重新配置。手动持久化: setx ${name} "你的值"`,
			"warning",
		);
	}
}

async function promptMissingRequiredEnv(ctx: any, contract: unknown): Promise<string[]> {
	await hydrateRequiredEnv(contract);
	const missing = missingRequiredEnv(contract);
	for (const name of missing) {
		const value = await ctx.ui?.input?.(`缺少必要配置 ${name}`, "");
		if (value?.trim()) {
			process.env[name] = value.trim();
			await persistWindowsUserEnv(name, value.trim(), ctx);
		}
	}
	return missingRequiredEnv(contract);
}

function formatMissingEnvMessage(names: string[]): string {
	return [
		`缺少必需环境变量: ${names.join(", ")}`,
		"请按提示填写后重试。",
		...names.map((name) => `PowerShell 持久配置: setx ${name} "你的值"`),
		...names.map((name) => `仅当前 PowerShell: $env:${name}='你的值'`),
		"不要把密钥写进 task 输入或聊天内容。",
	].join("\n");
}

// ponytail: 外部 CLI 依赖缺失提示。关键设计:不写死安装命令(跨包管理器 pip/winget/brew/cargo),
// 只列常见渠道作参考;但明确告诉 agent"装完重新调用 run_task",让 main agent 能自主补装后重试。
// 这是 task 可移植 + agent 自治的闭环:校验失败 → 结构化反馈 → agent 装 → 重试。
function formatMissingBinariesMessage(names: string[]): string {
	// ponytail: 提示要让 agent 能识别"这就是失败原因"并采取正确行动(装依赖),
	// 而不是猜测 cookie/CDP/重试等其他绕过。三个要点:
	//   1. 明确"这是本次失败的根因,别尝试绕过"——建立因果
	//   2. 安装渠道标注适用性(避免 pip 装 deno 这种非 python 包的误导)
	//   3. 装完要验证(--version)再重试——PATH 未刷新会继续失败
	return [
		`task 失败的根因:缺少必需外部命令 ${names.map((n) => `"${n}"`).join(", ")}(它们不在 PATH 里)。这不是 task 逻辑问题,也不是 cookie/网络/权限问题——就是环境缺命令。不要尝试 cookie、CDP、换号、重试等其他绕过,装上依赖即可解决。`,
		...names.map((name) => `安装 ${name}: Windows 用 \`winget install\` 或官网下载安装包;macOS 用 \`brew install\`;Linux 用包管理器。注意:不是所有命令都能用 pip/npm 装(如 deno/ffmpeg 是系统程序,不是 python/node 包),拿不准就查官网。装完在【新终端】里跑 \`${name} --version\` 验证有输出,再重试 task。`),
		"装完依赖后重新调用 run_task 即可,task 本身不用改。",
	].join("\n");
}

function buildTaskGuideItems(loaded: LoadedTaskbook): TaskGuideItem[] {
	const contract = loaded.contract;
	return [
		{ id: 1, title: "任务目标", detail: loaded.spec.goal },
		{ id: 2, title: "硬约束", detail: loaded.spec.hardConstraints.join("; ") || "无" },
		{ id: 3, title: "验收标准", detail: loaded.spec.acceptance.join("; ") || "无" },
		{ id: 4, title: "Worker 执行指引", detail: loaded.skill.trim().split(/\r?\n/).slice(0, 8).join(" ").replace(/\s+/g, " ").trim() || "空 skill" },
		{ id: 5, title: "产物契约", detail: summarizeContractArtifacts(contract) },
		{ id: 6, title: "运行输入", detail: summarizeRuntimeInput(contract) },
		{ id: 7, title: "工具要求", detail: summarizeRequiredTools(contract) },
		{ id: 8, title: "外部依赖", detail: summarizeRequiredBinaries(contract) },
		{ id: 9, title: "机器验证", detail: loaded.verify.trim().split(/\r?\n/).slice(0, 6).join(" ").replace(/\s+/g, " ").trim() || "空 verify" },
	];
}

function formatTaskGuide(loaded: LoadedTaskbook, items: TaskGuideItem[]): string {
	return [
		`# task 导览: ${loaded.taskbook.name} [${loaded.scope}]`,
		loaded.taskbook.description,
		"",
		...items.map((item) => `${item.id}. ${item.title}: ${item.detail}`),
	].join("\n");
}

async function buildTaskGuideText(ctx: any, loaded: LoadedTaskbook, items: TaskGuideItem[]): Promise<string> {
	try {
		const guide = await dispatchTaskGuide(loaded, { cwd: cwdOf(ctx) });
		return [
			`# task 导览: ${loaded.taskbook.name} [${loaded.scope}]`,
			loaded.taskbook.description,
			"",
			guide,
		].join("\n");
	} catch (error) {
		ctx.ui.notify(`task 导览 agent 失败,使用本地摘要: ${error instanceof Error ? error.message : String(error)}`, "warning");
		return formatTaskGuide(loaded, items);
	}
}

function formatTaskbookRawDetails(loaded: LoadedTaskbook): string {
	return [
		`# ${loaded.taskbook.name} [${loaded.scope}]`,
		loaded.taskbook.description,
		"",
		"## Spec",
		formatRequirementsSpec(loaded.spec),
		"",
		"## Skill",
		loaded.skill.trim(),
		"",
		"## Verify",
		loaded.verify.trim(),
		"",
		"## Contract",
		JSON.stringify(loaded.contract, null, 2),
	].join("\n");
}

function buildGuideEditRequest(input: string, items: TaskGuideItem[]): string {
	const match = input.trim().match(/^(\d+)\s*(.*)$/);
	if (!match) return input.trim();
	const id = Number(match[1]);
	const item = items.find((candidate) => candidate.id === id);
	if (!item) return input.trim();
	const note = match[2]?.trim();
	return [
		`用户选择导览项 ${item.id}: ${item.title}`,
		`当前内容: ${item.detail}`,
		note ? `修改意见: ${note}` : "修改意见: 请围绕该导览项做最小必要调整",
	].join("\n");
}

async function handleTaskShow(ctx: any, name: string | undefined, onEdit: (loaded: LoadedTaskbook, request?: string) => Promise<void>): Promise<void> {
	const finalName = await chooseTaskbookName(ctx, name);
	if (!finalName) return;
	const loaded = await loadTaskbook(cwdOf(ctx), finalName);
	if (!loaded) {
		ctx.ui.notify(`taskbook "${finalName}" 不存在`, "warning");
		return;
	}
	if (!ctx.ui?.select) {
		ctx.ui.notify(formatTaskbookRawDetails(loaded), "info");
		return;
	}
	const action = await ctx.ui.select(`taskbook: ${loaded.taskbook.name}`, ["task 导览", "task 编辑", "Exit"]);
	if (!action || action === "Exit") return;
	if (action === "task 编辑") {
		await onEdit(loaded);
		return;
	}
	if (action !== "task 导览") return;
	const items = buildTaskGuideItems(loaded);
	ctx.ui.notify(await buildTaskGuideText(ctx, loaded, items), "info");
	const next = await ctx.ui.select("task 导览", ["了解返回", "编辑"]);
	if (next !== "编辑") return;
	const request = await ctx.ui?.input?.("输入要编辑的编号和修改意见", "");
	if (request === undefined || !request.trim()) return;
	await onEdit(loaded, buildGuideEditRequest(request, items));
}

function scopeFromTokens(tokens: string[]): "user" | "project" {
	return tokens.includes("--project") ? "project" : "user";
}

function explicitScopeFromTokens(tokens: string[]): "user" | "project" | undefined {
	if (tokens.includes("--project")) return "project";
	if (tokens.includes("--user")) return "user";
	return undefined;
}

function parseTaskCommand(resolvedArgs: string): { action: string; name?: string; tokens: string[]; rawInput: string } {
	const tokens = resolvedArgs.trim().split(/\s+/).filter(Boolean);
	const action = (tokens[0] ?? "list").toLowerCase();
	const name = tokens[1];
	const prefix = name ? `${tokens[0]} ${name}` : tokens[0] ?? "";
	const rawInput = prefix ? resolvedArgs.slice(prefix.length).trim() : "";
	return { action, name, tokens, rawInput };
}

function runtimeFields(contract: unknown): string[] {
	if (!contract || typeof contract !== "object" || Array.isArray(contract)) return [];
	const value = (contract as Record<string, unknown>).runtimeInput;
	return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : [];
}

function runtimeDefault(contract: unknown, field: string): string | undefined {
	if (!contract || typeof contract !== "object" || Array.isArray(contract)) return undefined;
	const meta = (contract as Record<string, unknown>).runtimeInputMeta;
	if (!meta || typeof meta !== "object" || Array.isArray(meta)) return undefined;
	const fieldMeta = (meta as Record<string, unknown>)[field];
	if (!fieldMeta || typeof fieldMeta !== "object" || Array.isArray(fieldMeta) || !("default" in fieldMeta)) return undefined;
	return String((fieldMeta as Record<string, unknown>).default);
}

function contractToolNames(contract: unknown): string[] {
	if (!contract || typeof contract !== "object" || Array.isArray(contract)) return [];
	const record = contract as Record<string, unknown>;
	const values = [...(Array.isArray(record.requiredTools) ? record.requiredTools : []), ...(Array.isArray(record.protectedTools) ? record.protectedTools : [])];
	return values.filter((value): value is string => typeof value === "string" && value.trim().length > 0);
}

function mentionsTool(text: string, tool: string): boolean {
	const escaped = tool.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return new RegExp(`(^|[^A-Za-z0-9_-])${escaped}([^A-Za-z0-9_-]|$)`).test(text);
}

// ponytail: taskbook 单粒度的 protected tool 命中。用于精确缓存:只缓存真正用到
// protected tool 的 taskbook,而不是整批(批次里夹带的纯 read taskbook 不该入缓存)。
function protectedToolsForTaskbook(item: LoadedTaskbook, activeTools: string[]): string[] {
	const declared = new Set(contractToolNames(item.contract));
	const uses = (tool: string) => declared.has(tool) || mentionsTool(item.skill, tool);
	return [
		...(activeTools.includes("chrome_cdp") && uses("chrome_cdp") ? ["chrome_cdp"] : []),
		...activeTools.filter((tool) => tool.includes("__") && uses(tool)),
	];
}

// ponytail: 授权 key = scope:name:sortedTools。scope:name 唯一(同名 user/project 不串);
// 工具集区分"授权了 cdp,后来 taskbook 加了 mcp 工具"—— 工具集变 → 重新确认。
function protectedToolGrantKey(item: LoadedTaskbook, tools: string[]): string {
	return `${item.scope}:${item.taskbook.name}:${[...tools].sort().join(",")}`;
}

export async function resolveTaskWorkerEnv(
	ctx: any,
	loaded: LoadedTaskbook | LoadedTaskbook[],
	activeTools: string[],
): Promise<Record<string, string | undefined> | null> {
	const taskbooks = Array.isArray(loaded) ? loaded : [loaded];
	// 按 taskbook 粒度算命中,只保留真用 protected tool 的。
	const perTaskbook = taskbooks
		.map((item) => ({ item, tools: protectedToolsForTaskbook(item, activeTools) }))
		.filter((entry) => entry.tools.length > 0);
	if (perTaskbook.length === 0) return {};
	const names = [...new Set(perTaskbook.flatMap((entry) => entry.tools))];
	const taskbookNames = perTaskbook.map((entry) => entry.item.taskbook.name).join(", ");
	// ponytail: 本会话已授权过全部这些 (taskbook,工具集) → 直接复用,不再弹 confirm。
	// 批次里任一 taskbook 的工具集没授权过 → 弹一次(覆盖整个批次),通过后全部入缓存。
	// autopilot on 时:这条"受保护工具授权"确认被短路为直接放行(见 shared/autopilot.ts),
	// 仍属于可逆的工具级确认(授权只传 worker、不改全局、关 ugk 即忘),不涉及危险动作。
	const allGranted = perTaskbook.every((entry) => protectedToolGrants.has(protectedToolGrantKey(entry.item, entry.tools)));
	if (!allGranted && !isAutopilotOn()) {
		const allowed = await ctx.ui?.confirm?.(
			"允许本次 task 使用受保护工具?",
			[
				`taskbook "${taskbookNames}" 声明会使用: ${names.join(", ")}`,
				"",
				"授权只传给 worker 子进程,不改变 /cdp 或 /mcp 的全局模式。本会话内同一 taskbook(同工具集)不再询问。",
			].join("\n"),
		);
		if (!allowed) return null;
	}
	if (!allGranted) {
		for (const entry of perTaskbook) protectedToolGrants.add(protectedToolGrantKey(entry.item, entry.tools));
	}
	const chromeCdp = names.includes("chrome_cdp");
	const mcpTools = names.filter((tool) => tool !== "chrome_cdp");
	return {
		...(chromeCdp ? { UGK_TASK_ALLOW_CHROME_CDP: "1" } : {}),
		...(chromeCdp && process.env.UGK_CDP_PORT ? { UGK_CDP_PORT: process.env.UGK_CDP_PORT } : {}),
		...(mcpTools.length > 0 ? { UGK_TASK_ALLOW_MCP_TOOLS: mcpTools.join(",") } : {}),
	};
}

async function resolveRuntimeInput(
	ctx: any,
	skill: string,
	contract: unknown,
	rawInput: string,
	headless = false,
	onApiUsage?: (item: TaskApiUsage) => void,
): Promise<unknown> {
	return await resolveRuntimeInputFromText(ctx, skill, contract, rawInput, taskbookModel(contract, "dispatcherModel"), headless, onApiUsage);
}

async function resolveSelfCheckInput(ctx: any, contract: unknown): Promise<unknown> {
	const fields = runtimeFields(contract);
	if (fields.length === 0) return {};
	return Object.fromEntries(fields.map((field) => [field, runtimeDefault(contract, field) ?? ""]));
}

async function askSelfCheckInput(ctx: any, contract: unknown): Promise<unknown> {
	const fields = runtimeFields(contract);
	if (fields.length === 0) return {};
	const entries: Array<[string, string]> = [];
	for (const field of fields) {
		const defaultValue = runtimeDefault(contract, field) ?? field;
		const suffix = runtimeDefault(contract, field) === undefined ? "" : ` (default: ${defaultValue})`;
		const value = await ctx.ui?.input?.(`verify 自证示例输入: ${field}${suffix}`, defaultValue);
		entries.push([field, value ?? defaultValue]);
	}
	return Object.fromEntries(entries);
}

function artifactNames(contract: unknown): string[] {
	if (!contract || typeof contract !== "object" || Array.isArray(contract)) return [];
	const artifacts = (contract as Record<string, unknown>).artifacts;
	if (!Array.isArray(artifacts)) return [];
	return artifacts
		.map((artifact) => artifact && typeof artifact === "object" && !Array.isArray(artifact)
			? (artifact as Record<string, unknown>).name
			: undefined)
		.filter((name): name is string => typeof name === "string");
}

function resolveRunOutputDir(contract: unknown, fallbackOutputDir: string): string {
	if (!contract || typeof contract !== "object" || Array.isArray(contract)) return fallbackOutputDir;
	const outputDir = (contract as Record<string, unknown>).outputDir;
	return typeof outputDir === "string" && path.isAbsolute(outputDir) ? outputDir : fallbackOutputDir;
}

async function withTempVerify(cwd: string, verify: string, fn: (verifyPath: string, tempDir: string) => Promise<void>): Promise<void> {
	const tempDir = path.join(cwd, ".tasks", "tmp", `verify-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	await mkdir(tempDir, { recursive: true });
	try {
		const verifyPath = path.join(tempDir, "verify.mjs");
		await writeFile(verifyPath, verify, "utf8");
		await fn(verifyPath, tempDir);
	} finally {
		await rm(tempDir, { recursive: true, force: true });
	}
}

function malformedVerifyFailureOutput(verifyResult: Awaited<ReturnType<typeof runVerify>>): boolean {
	return verifyResult.failures.length === 0 ||
		verifyResult.failures.some((failure) => failure.assertion === "verify.mjs 输出结构化失败");
}

async function formatArtifact(outputDir: string, name: string): Promise<string[]> {
	const filePath = path.resolve(outputDir, name);
	try {
		const info = await stat(filePath);
		const lines = [`- ${name} (${info.size} bytes)`, `  路径: ${filePath}`];
		const extension = path.extname(name).toLowerCase();
		if (PREVIEW_TEXT_EXTENSIONS.has(extension)) {
			const content = await readFile(filePath, "utf8");
			const preview = content.length > MAX_ARTIFACT_PREVIEW_CHARS
				? `${content.slice(0, MAX_ARTIFACT_PREVIEW_CHARS)}\n\n...内容过长,已截断;完整内容见文件。`
				: content;
			lines.push("", `### ${name}`, preview.trimEnd());
		}
		return lines;
	} catch (error) {
		return [`- ${name} (missing: ${(error as Error).message})`, `  路径: ${filePath}`];
	}
}

async function formatArtifacts(contract: unknown, outputDir: string): Promise<string[]> {
	const names = artifactNames(contract);
	const actualNames = names.length > 0
		? names
		: (await readdir(outputDir).catch(() => []));
	const lines = ["## 产物"];
	for (const name of actualNames) lines.push(...await formatArtifact(outputDir, name));
	return lines;
}

async function collectArtifactPaths(contract: unknown, outputDir: string): Promise<string[]> {
	const names = artifactNames(contract);
	const actualNames = names.length > 0
		? names
		: (await readdir(outputDir).catch(() => []));
	return actualNames.map((name) => path.resolve(outputDir, name));
}

function taskbookModel(contract: unknown, field: "dispatcherModel" | "workerModel"): string | undefined {
	if (!contract || typeof contract !== "object" || Array.isArray(contract)) return undefined;
	const value = (contract as Record<string, unknown>)[field];
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function formatWorkerSummary(summary: string | undefined): string {
	const text = summary?.trim();
	if (!text) return "无";
	return text.split(/\r?\n/).map((line) => line ? `> ${line}` : ">").join("\n");
}

function formatOptionalSection(title: string, lines: string[] | undefined): string[] {
	const useful = (lines ?? []).map((line) => line.trim()).filter(Boolean);
	return useful.length > 0 ? ["", `## ${title}`, ...useful.map((line, index) => `${index + 1}. ${line}`)] : [];
}

function buildTaskRunReviewContext(taskbookName: string, report: string): string {
	return [
		"[TASK RUN REVIEW]",
		"请复盘这次 /task run。重点解释是否发生重试、失败、绕路或早期判断错误;如果需要修改 taskbook,建议用户进入 /task edit。",
		"",
		`Taskbook: ${taskbookName}`,
		"",
		report,
	].join("\n");
}

async function formatRunResult(
	loaded: LoadedTaskbook,
	outputDir: string,
	workerResult: TaskWorkerResult | undefined,
	verifyResult: Awaited<ReturnType<typeof runVerify>> | undefined,
	passed: boolean,
	attempts: number,
	durationSeconds: number,
	progress?: string[],
	notes?: string[],
	phases?: Record<string, number>,
): Promise<string> {
	const phaseLines = formatPhaseBreakdown(phases);
	if (passed) {
		return [
			"## 任务结果",
			`✅ taskbook "${loaded.taskbook.name}" PASS`,
			`任务: ${loaded.taskbook.description}`,
			`尝试: ${attempts} 次`,
			`耗时: ${durationSeconds.toFixed(1)}s`,
			...phaseLines,
			"",
			...await formatArtifacts(loaded.contract, outputDir),
			"",
			"## 验证",
			"verify 自证: 全过",
			"",
			"## 执行摘要",
			formatWorkerSummary(workerResult?.summary),
			...formatOptionalSection("最近进展", progress),
			...formatOptionalSection("运行中用户备注", notes),
		].filter(Boolean).join("\n");
	}
	const failures = verifyResult?.failures ?? [];
	return [
		"## 任务结果",
		`❌ taskbook "${loaded.taskbook.name}" FAIL`,
		`任务: ${loaded.taskbook.description}`,
		`尝试: ${attempts} 次`,
		`耗时: ${durationSeconds.toFixed(1)}s`,
		...phaseLines,
		"",
		"## 验证",
		"失败断言:",
		...(failures.length > 0
			? failures.map((failure) => `  - ${failure.assertion}: 预期 ${failure.expected}, 实际 ${failure.actual}`)
			: ["  - verify 未返回结构化失败"]),
		"",
		"## 执行摘要",
		formatWorkerSummary(workerResult?.summary),
		...formatOptionalSection("最近进展", progress),
		...formatOptionalSection("运行中用户备注", notes),
	].join("\n");
}

// ponytail: 纯诊断展示。把 phases(ms)转成可读分段,回答"到底慢在哪"。
// 两层:task 层(worker 整体/verify)给总览;worker 子进程内部细分(冷启动/LLM决策/工具执行)
// 回答"是 agent 启动慢、还是启动后开始工作慢"——这正是优化的决策依据。
export function formatPhaseBreakdown(phases?: Record<string, number>): string[] {
	if (!phases) return [];
	const s = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
	const lines = ["", "耗时分解:"];
	if (phases.workerFirstOutputMs !== undefined) lines.push(`  worker 启动+首轮: ${s(phases.workerFirstOutputMs)}`);
	if (phases.workerMs !== undefined) lines.push(`  worker 整体: ${s(phases.workerMs)}`);
	// worker 子进程内部细分(最后一次 worker):coldStart=Node+pi 冷启动;llmDecision=模型决定怎么干;tool=写脚本/连CDP/抓取/sleep
	if (phases["worker.coldStartMs"] !== undefined) lines.push(`    ├ 冷启动(Node+pi): ${s(phases["worker.coldStartMs"])}`);
	if (phases["worker.llmDecisionMs"] !== undefined) lines.push(`    ├ LLM 决策: ${s(phases["worker.llmDecisionMs"])}`);
	if (phases["worker.toolMs"] !== undefined) lines.push(`    └ 工具执行(CDP/脚本): ${s(phases["worker.toolMs"])}`);
	if (phases.verifyMs !== undefined) lines.push(`  verify: ${s(phases.verifyMs)}`);
	return lines;
}

async function formatRepairSummary(
	loaded: LoadedTaskbook,
	outputDir: string,
	workerResult: TaskWorkerResult | undefined,
	verifyResult: Awaited<ReturnType<typeof runVerify>> | undefined,
): Promise<string> {
	const failures = verifyResult?.failures ?? [];
	return [
		"[TASKBOOK REPAIR CONTEXT]",
		"修正已有 taskbook。请基于本次失败,用 questionnaire 逐项核对要改 skill、verify 还是 contract,最后输出完整 taskbook JSON。",
		"",
		`Taskbook: ${loaded.taskbook.name}`,
		`Description: ${loaded.taskbook.description}`,
		`OutputDir: ${outputDir}`,
		"",
		"失败断言:",
		...(failures.length > 0
			? failures.map((failure) => `- ${failure.assertion}: 预期 ${failure.expected}, 实际 ${failure.actual}`)
			: ["- verify 未返回结构化失败"]),
		...(looksLikeMissingArtifact(failures)
			? ["", "⚠️ 这次失败像是「文件不存在」。先别急着放宽 verify 或改执行方法,优先核对三处产物名是否一致:contract.artifacts[].name、skill.md 里写出的文件名、verify.mjs 里 stat/读取的路径。最常见的死循环就是三者名字写岔了。"]
			: []),
		"",
		"WorkerSummary:",
		workerResult?.summary?.trim() || "(none)",
		"",
		"现有 skill.md:",
		"```md",
		loaded.skill.trim(),
		"```",
		"",
		"现有 verify.mjs:",
		"```js",
		loaded.verify.trim(),
		"```",
		"",
		"现有 contract.json:",
		"```json",
		JSON.stringify(loaded.contract, null, "\t"),
		"```",
	].join("\n");
}

// ponytail: 文件不存在是产物名漂移的典型症状(三处名字写岔)。命中就给 reviewer
// 一条定向提示,别让它围着「文件不存在」症状改、回到「统一产物名」根因。
// 只匹配明确的不存在信号,不确定时不误报(宁可漏报让 reviewer 自己判断)。
export function looksLikeMissingArtifact(failures: { assertion: string; actual: string }[]): boolean {
	if (failures.length === 0) return false;
	const re = /ENOENT|not\s+found|找不到|不存在|no\s+such\s+file/i;
	return failures.some((f) => re.test(`${f.assertion} ${f.actual}`));
}

function formatTaskbookUpdateSummary(loaded: LoadedTaskbook): string {
	return [
		"[TASKBOOK UPDATE CONTEXT]",
		"更新已有 taskbook。请基于现有 spec/skill/verify/contract,用 questionnaire 逐项确认要调整哪些细节;不要把它当成新建任务从头重做。",
		"",
		`Taskbook: ${loaded.taskbook.name}`,
		`Scope: ${loaded.scope}`,
		`Description: ${loaded.taskbook.description}`,
		"",
		"现有 skill.md:",
		"```md",
		loaded.skill.trim(),
		"```",
		"",
		"现有 verify.mjs:",
		"```js",
		loaded.verify.trim(),
		"```",
		"",
		"现有 contract.json:",
		"```json",
		JSON.stringify(loaded.contract, null, "\t"),
		"```",
	].join("\n");
}

function setTaskRunWidget(ctx: any, lines: string[] | undefined): void {
	try {
		ctx.ui?.setWidget?.("task-run-view", lines, { placement: "aboveEditor" });
	} catch (error) {
		if (!String(error instanceof Error ? error.message : error).includes("extension ctx is stale")) throw error;
	}
}

function safeTaskNotify(ctx: any, content: string, level: "info" | "warning" | "error" = "info"): void {
	try {
		ctx.ui.notify(content, level);
	} catch (error) {
		if (!String(error instanceof Error ? error.message : error).includes("extension ctx is stale")) throw error;
	}
}

function sendTaskMessage(pi: ExtensionAPI, ctx: any, content: string, fallbackLevel: "info" | "warning" | "error" = "info"): void {
	if (typeof (pi as any).sendMessage === "function") {
		(pi as any).sendMessage({ customType: "task-message", content, display: true }, { triggerTurn: false });
		return;
	}
	safeTaskNotify(ctx, content, fallbackLevel);
}

function sendTaskProgressMessage(pi: ExtensionAPI, details: TaskProgressDetails): void {
	if (details.lines.length === 0 || typeof (pi as any).sendMessage !== "function") return;
	(pi as any).sendMessage({
		customType: "task-progress",
		content: `taskbook "${details.taskbookName}" ${details.status} process (${details.lines.length} updates)`,
		display: true,
		details,
	}, { triggerTurn: false });
}

function renderTaskProgressMessage(message: any, { expanded }: { expanded: boolean }, theme: any): Text {
	const details = message.details as TaskProgressDetails | undefined;
	const lines = details?.lines ?? [];
	const visible = expanded ? lines : lines.slice(-5);
	const title = `▸ taskbook "${details?.taskbookName ?? "unknown"}" 运行过程: ${details?.status ?? "DONE"} (${lines.length} 条)`;
	const body = visible.map((line, index) => `${index + 1}. ${line}`).join("\n");
	const hint = !expanded && lines.length > visible.length ? `\n${theme.fg("muted", "(Ctrl+O to expand)")}` : "";
	return new Text([theme.fg("toolTitle", theme.bold(title)), body, hint].filter(Boolean).join("\n"), 0, 0);
}

function sendTaskReviewPromptMessage(pi: ExtensionAPI, content: string, details: Record<string, unknown> = {}): void {
	if (typeof (pi as any).sendMessage !== "function") return;
	(pi as any).sendMessage({
		customType: TASK_REVIEW_PROMPT_TYPE,
		content,
		display: true,
		details,
	}, { triggerTurn: true, deliverAs: "followUp" });
}

function renderTaskReviewPromptMessage(message: any, { expanded }: { expanded: boolean }, theme: any): Text {
	const content = typeof message.content === "string" ? message.content : "";
	const lineCount = content ? content.split(/\r?\n/).length : 0;
	const title = `▸ [TASK REVIEW MODE] 已注入复盘指令 (${lineCount} 行)`;
	if (!expanded) {
		return new Text(theme.fg("toolTitle", theme.bold(`${title}  ${theme.fg("muted", "(Ctrl+O to expand)")}`)), 0, 0);
	}
	return new Text([theme.fg("toolTitle", theme.bold(title)), content].join("\n"), 0, 0);
}

function formatProgressLines(text: string): string[] {
	if (text.trim() === "(running...)") return [];
	return text
		.split(/\r?\n/)
		.map((line) => line.replace(/^#{1,6}\s*/, "").replace(/^[-*]\s*/, "").trim())
		.filter(Boolean)
		.slice(-5)
		.map((line) => line.length > 120 ? `${line.slice(0, 117)}...` : line);
}

function appendUniqueProgressLines(existing: string[], incoming: string[]): string[] {
	const seen = new Set(existing);
	const added: string[] = [];
	for (const line of incoming) {
		if (seen.has(line)) continue;
		seen.add(line);
		added.push(line);
	}
	existing.push(...added);
	return added;
}

function formatExecuteSummary(state: TaskState, completionSummary = ""): string {
	const lines = [
		"[TASK EXECUTE SUMMARY]",
		"",
		completionSummary.trim() ? `AgentSummary: ${completionSummary.trim()}` : "",
		state.executeRunDir ? `RunDir: ${state.executeRunDir}` : "",
		"",
		"ProcessLog:",
	];
	for (const entry of state.executeProcessLog) {
		if (entry.kind === "artifact") {
			lines.push(`[${entry.timestamp}] artifact ${entry.artifactPath}`);
		} else {
			lines.push(`[${entry.timestamp}] ${entry.toolName}: ${entry.argsSummary ?? ""}`);
		}
	}
	return lines.filter((line) => line !== "").join("\n");
}

function taskCompleteSummaryFromEvent(event: any): string {
	const candidates = [
		event?.result?.details?.summary,
		event?.result?.summary,
		event?.input?.summary,
	];
	return candidates.find((value) => typeof value === "string") ?? "";
}

async function loadSubtask(cwd: string, name: string): Promise<LoadedTaskbook> {
	const loaded = await loadTaskbook(cwd, name);
	if (loaded) return loaded;
	const available = (await listTaskbooks(cwd)).map((item) => item.name).join(", ") || "(none)";
	throw new Error(`taskbook "${name}" 不存在。可用: ${available}`);
}

// ponytail: 单源重试内核 — executeSubtask(run_task 工具)和 handleTaskRun(/task run 交互式)共用。
// 抽出来的纯逻辑:worker→verify→checker→feedback 循环。UI 耦合(widget/progress/notes/通知)留在调用方,
// 通过 onWorkerStart / onUpdate 回调按需注入,默认不传即纯函数式。两条路径行为由此保证一致。
interface TaskRetryOutcome {
	workerResult: TaskWorkerResult;
	verifyResult: Awaited<ReturnType<typeof runVerify>>;
	attempts: number; // 实际 worker 尝试次数 (1..maxRetry+1)
	aborted: boolean; // worker 被中断(worker.ok===false 且 signal.aborted),区别于普通失败
	checkerAborted?: boolean; // checker 主动判 abort 提前终止
	apiUsage: TaskApiUsage[];
	phases?: Record<string, number>; // ponytail: 纯诊断,各阶段累计耗时(ms)
}

function addTaskApiUsage(items: TaskApiUsage[], model: string | undefined, usage: TaskWorkerResult["usage"] | undefined): void {
	if (!usage) return;
	const key = model || "unknown";
	let item = items.find((candidate) => (candidate.model || "unknown") === key);
	if (!item) {
		item = { model: key, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 } };
		items.push(item);
	}
	item.usage.input += usage.input;
	item.usage.output += usage.output;
	item.usage.cacheRead += usage.cacheRead;
	item.usage.cacheWrite += usage.cacheWrite;
	item.usage.cost += usage.cost;
}

async function runTaskWithRetry(
	loaded: LoadedTaskbook,
	runtimeInput: unknown,
	outputDir: string,
	cwd: string,
	opts: {
		env: Record<string, string | undefined>;
		signal?: AbortSignal;
		maxRetry?: number;
		onWorkerStart?: (attempt: number, feedback: unknown) => void;
		onWorkerStarted?: (attempt: number, feedback: unknown) => void;
		onWorkerUpdate?: (text: string) => void;
		onVerifyStart?: (attempt: number) => void;
	},
): Promise<TaskRetryOutcome> {
	const maxRetry = opts.maxRetry ?? 3;
	const verifyPath = path.join(loaded.dir, "verify.mjs");
	let feedback: unknown;
	let workerResult: TaskWorkerResult | undefined;
	let verifyResult: Awaited<ReturnType<typeof runVerify>> | undefined;
	let attempts = 0;
	let checkerAborted = false;
	// ponytail: aborted 收窄为"worker 被中断"——worker.ok===false 且 signal 已 aborted。
	// 不用 Boolean(signal.aborted):那样 verify/checker 期间被 abort 也会算 aborted,
	// 而 worker 那轮其实成功了,会被 handleTaskRun 误判进 abort 分支或漏判 FAIL。
	let workerAborted = false;
	const apiUsage: TaskApiUsage[] = [];
	// ponytail: 纯诊断计时。workerFirstOutput = 从 runTaskWithRetry 进入到 worker 子进程
	// 首次产出(子进程启动 + 首轮 LLM 的延迟);workerMs/verifyMs = 各阶段累计。不改执行逻辑。
	const runStartMs = Date.now();
	let workerFirstOutputMs: number | undefined;
	let workerMs = 0;
	let verifyMs = 0;
	const wrappedOnWorkerUpdate = opts.onWorkerUpdate
		? (text: string) => {
			if (workerFirstOutputMs === undefined) workerFirstOutputMs = Date.now() - runStartMs;
			opts.onWorkerUpdate!(text);
		}
		: undefined;
	for (let attempt = 0; attempt <= maxRetry; attempt += 1) {
		opts.onWorkerStart?.(attempt + 1, feedback);
		attempts = attempt + 1;
		const workerStartMs = Date.now();
		opts.onWorkerStarted?.(attempt + 1, feedback);
		workerResult = await dispatchWorker({
			skill: loaded.skill,
			contract: loaded.contract,
			runtimeInput,
			outputDir,
			feedback,
		}, {
			cwd,
			// ponytail: 注入 TASK_DIR,让 worker 能调用 taskbook 自带的 scripts/(python "$TASK_DIR/scripts/xxx.py")
			env: { ...opts.env, TASK_DIR: loaded.dir },
			signal: opts.signal,
			onUpdate: wrappedOnWorkerUpdate,
		});
		workerMs += Date.now() - workerStartMs;
		addTaskApiUsage(apiUsage, workerResult.model, workerResult.usage);

		// worker 失败不重试(与 /task run 一致)。worker 被中断专门标记,区别于普通失败。
		if (!workerResult.ok) {
			if (opts.signal?.aborted) workerAborted = true;
			break;
		}

		opts.onVerifyStart?.(attempt + 1);
		const verifyStartMs = Date.now();
		verifyResult = await runVerify({ verifyPath, outputDir, input: runtimeInput, taskDir: loaded.dir });
		verifyMs += Date.now() - verifyStartMs;
		if (verifyResult.passed) break;

		// 最后一次或被中断:不再调 checker
		if (attempt === maxRetry || opts.signal?.aborted) break;

		const checkerResult = await dispatchChecker({
			failures: verifyResult.failures,
			contract: loaded.contract,
			outputDir,
			retryBudget: maxRetry - attempt - 1,
		}, { cwd, signal: opts.signal });
		addTaskApiUsage(apiUsage, checkerResult.model, checkerResult.usage);
		if (checkerResult.verdict === "abort") {
			checkerAborted = true;
			break;
		}
		feedback = checkerResult;
	}
	// ponytail: worker 失败(含 abort)时根本没跑 verify,verifyResult 仍是 undefined。
	// 合成一个"未验证"结果(passed:false, exitCode:null, 无 failures)让 outcome 字段恒有值,
	// 调用方不必散落 null-guard。exitCode:null 语义即"未运行 verify"。
	if (!verifyResult) {
		verifyResult = { passed: false, failures: [], stdout: "", stderr: "", exitCode: null, durationMs: 0 };
	}
	const phases: Record<string, number> = { workerMs, verifyMs };
	if (workerFirstOutputMs !== undefined) phases.workerFirstOutputMs = workerFirstOutputMs;
	// ponytail: 合并 worker 子进程内部细分(最后一次 worker 的)。带前缀,与 task 层 workerMs 区分。
	// 诊断用:回答"worker 里是冷启动慢、LLM 决策慢、还是工具执行(CDP)慢"。
	for (const [key, value] of Object.entries(workerResult?.phases ?? {})) {
		phases[`worker.${key}`] = value;
	}
	return { workerResult: workerResult!, verifyResult, attempts, aborted: workerAborted, checkerAborted, apiUsage, phases };
}

async function executeSubtask(
	ctx: any,
	request: SubtaskRequest,
	loaded: LoadedTaskbook,
	workerEnv: Record<string, string | undefined>,
	signal?: AbortSignal,
): Promise<SubtaskResult> {
	const startedAt = Date.now();
	const runDir = path.join(cwdOf(ctx), ".tasks", "runs", `task-${request.name}-${startedAt}-${Math.random().toString(36).slice(2, 8)}`);
	const outputDir = path.join(runDir, "output");
	// ponytail: hydrate 已在 run_task 入口集中做(hydrateRequiredEnvForTaskbooks),这里只检查。
	// /task run 单任务路径走 promptMissingRequiredEnv(内含 hydrate),也不经过这里。
	const missingEnv = missingRequiredEnv(loaded.contract);
	if (missingEnv.length > 0) {
		return {
			name: request.name,
			status: "fail",
			outputDir,
			artifacts: [],
			verifyFailures: [],
			workerSummary: formatMissingEnvMessage(missingEnv),
			duration: (Date.now() - startedAt) / 1000,
			attempts: 0,
		};
	}
	// ponytail: 外部 CLI 依赖前置校验,与 env 同位。缺则 FAIL + 安装提示,让 agent 补装后重试。
	const missingBinaries = missingRequiredBinaries(loaded.contract);
	if (missingBinaries.length > 0) {
		return {
			name: request.name,
			status: "fail",
			outputDir,
			artifacts: [],
			verifyFailures: [],
			workerSummary: formatMissingBinariesMessage(missingBinaries),
			duration: (Date.now() - startedAt) / 1000,
			attempts: 0,
		};
	}
	await mkdir(outputDir, { recursive: true });
	const maxRetry = 3;
	const title = `⏳ run_task 已启动: ${request.name}`;
	const progress: string[] = [];
	const apiUsage: TaskApiUsage[] = [];
	setTaskRunWidget(ctx, [title, "正在解析输入..."]);
	// ponytail: resolveRuntimeInput 的错误(如 dispatcher 缺必填字段)也要纳入单 task 隔离,
	// 否则 parallel 模式下单个 task 的解析失败会上抛,穿过 mapWithConcurrencyLimit,
	// 让整个 run_task 工具进 catch,返回 isError + 空 results —— 其他并发 task 的进度全丢。
	// 解析失败应转成该 task 的 FAIL,而非炸掉整个批次。
	let runtimeInput: unknown;
	let outcome: TaskRetryOutcome;
	try {
		runtimeInput = await resolveRuntimeInput(ctx, loaded.skill, loaded.contract, request.input, true, (item) => addTaskApiUsage(apiUsage, item.model, item.usage));
		outcome = await runTaskWithRetry(loaded, runtimeInput, outputDir, cwdOf(ctx), {
			env: { ...workerEnv, ...requiredEnvValues(loaded.contract) },
			signal,
			maxRetry,
			onWorkerStart: (attempt) => {
				setTaskRunWidget(ctx, [
					title,
					`尝试 ${attempt}/${maxRetry + 1}`,
					"正在装载 subagent(worker)...",
				]);
			},
			onWorkerStarted: (attempt) => {
				setTaskRunWidget(ctx, [
					title,
					`尝试 ${attempt}/${maxRetry + 1}`,
					"subagent(worker) 执行中...",
				]);
			},
			onWorkerUpdate: (text) => {
				const added = appendUniqueProgressLines(progress, formatProgressLines(text));
				if (added.length === 0) return;
				setTaskRunWidget(ctx, [
					title,
					"subagent(worker) 执行中...",
					"",
					"最近进展:",
					...progress.slice(-5).map((line, index) => `${index + 1}. ${line}`),
				]);
			},
			onVerifyStart: (attempt) => {
				setTaskRunWidget(ctx, [
					title,
					`尝试 ${attempt}/${maxRetry + 1}`,
					"verify 执行中...",
				]);
			},
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			name: request.name,
			status: "fail",
			outputDir,
			artifacts: [],
			verifyFailures: [],
			workerSummary: `执行异常: ${message}`,
			duration: (Date.now() - startedAt) / 1000,
			attempts: 1,
			apiUsage,
			// parseFailed 标记:此 FAIL 是输入解析失败(非 worker/verify 失败)。
			// run_task 工具层据此判断:单任务(single)全 parseFailed → 标 isError 让 agent 知道是输入问题;
			// 并行(parallel)部分 parseFailed → 不炸批次,各 task 独立 PASS/FAIL。
			parseFailed: true,
		} as SubtaskResult;
	}
	const duration = (Date.now() - startedAt) / 1000;
	for (const item of outcome.apiUsage) addTaskApiUsage(apiUsage, item.model, item.usage);
	const status = outcome.workerResult.ok && outcome.verifyResult.passed ? "pass" : "fail";
	await appendRunToTaskbook(loaded.scope, cwdOf(ctx), request.name, {
		timestamp: new Date().toISOString(),
		status,
		input: runtimeInput,
		exitCode: status === "pass" ? 0 : (outcome.verifyResult.exitCode ?? 1),
		verifyFailures: outcome.verifyResult.failures,
		duration,
		phases: outcome.phases,
	});
	return {
		name: request.name,
		status,
		outputDir,
		artifacts: await collectArtifactPaths(loaded.contract, outputDir),
		verifyFailures: outcome.verifyResult.failures,
		workerSummary: outcome.workerResult.ok ? outcome.workerResult.summary : (outcome.workerResult.errorMessage ?? "worker failed"),
		duration,
		attempts: outcome.attempts,
		usage: outcome.workerResult.usage,
		model: outcome.workerResult.model,
		apiUsage,
		phases: outcome.phases,
	};
}

function parseRunTaskParams(params: any): { mode: "single" | "parallel"; tasks: SubtaskRequest[] } {
	const hasSingle = typeof params?.name === "string" || typeof params?.input === "string";
	const hasParallel = Array.isArray(params?.tasks);
	if (hasSingle === hasParallel) throw new Error("run_task 需要提供 {name,input} 或 {tasks:[...]},二选一。");
	if (hasSingle) {
		if (typeof params.name !== "string" || !params.name.trim() || typeof params.input !== "string") {
			throw new Error("single 模式需要 name 和 input。");
		}
		return { mode: "single", tasks: [{ name: params.name.trim(), input: params.input }] };
	}
	const tasks = params.tasks;
	if (tasks.length === 0 || tasks.length > SUBTASK_MAX) throw new Error(`parallel 模式 tasks 数量必须是 1-${SUBTASK_MAX}。`);
	return {
		mode: "parallel",
		tasks: tasks.map((task: any) => {
			if (typeof task?.name !== "string" || !task.name.trim() || typeof task?.input !== "string") {
				throw new Error("parallel 模式每项都需要 name 和 input。");
			}
			return { name: task.name.trim(), input: task.input };
		}),
	};
}

function formatSubtaskToolText(mode: "single" | "parallel", results: SubtaskResult[]): string {
	const passed = results.filter((result) => result.status === "pass").length;
	const header = mode === "parallel" ? `${passed}/${results.length} succeeded` : `run_task ${results[0]?.status.toUpperCase() ?? "FAIL"}`;
	return [
		header,
		// ponytail: workerSummary 的取舍按 status 分流。
		// PASS —— 产物摘要可能很长(表格/路径清单),白占 token 还可能触发主 agent
		// 多一轮总结(那轮若 provider 卡住,Esc 也救不回来),所以 PASS 不带 summary,
		// 完整内容仍在 details.results[].workerSummary,UI/调试照常可取。
		// FAIL —— 失败原因正是 agent 此刻最需要的信息(缺命令/越界/质量打回/解析失败)。
		// 若 FAIL 也不带 summary,agent 收到的就是个光秃秃 "FAIL + outputDir(可能不存在)",
		// 无从判断根因 → 只能瞎猜绕过(去查 cookie、自己手跑 yt-dlp 等),违背 taskbook 闭环。
		// 实测(2026-07-02):FAIL summary 不进文本时,即使文案明确写"缺 deno、别绕过",
		// agent 仍全程未读 deno 一词,直接绕过 taskbook 自己 bash 跑 yt-dlp。
		// 因此 FAIL 把 workerSummary 带进文本,让 agent 看到诊断、按提示行动。
		...results.map((result) => [
			`- ${result.name}: ${result.status.toUpperCase()}`,
			`  outputDir: ${result.outputDir}`,
			result.artifacts.length > 0 ? `  artifacts: ${result.artifacts.join(", ")}` : "",
			result.verifyFailures.length > 0 ? `  verifyFailures: ${JSON.stringify(result.verifyFailures)}` : "",
			// FAIL 时附上诊断。trim 防空/纯空白。多行 summary 整体缩进对齐。
			result.status === "fail" && result.workerSummary && result.workerSummary.trim()
				? `  reason: ${result.workerSummary.trim().replace(/\n/g, "\n  ")}`
				: "",
		].filter(Boolean).join("\n")),
	].join("\n");
}

async function handleTaskRun(
	pi: ExtensionAPI,
	ctx: any,
	name: string | undefined,
	rawInput: string,
	onFail?: (failure: TaskRunFailure) => void,
	activeTools: string[] = TASK_NORMAL_TOOLS,
	onReviewReady?: (review: LastRunReview) => void,
): Promise<void> {
	if (activeTaskRun) {
		ctx.ui.notify(`taskbook "${activeTaskRun.taskbookName}" 正在运行。可用 /task stop 中断。`, "warning");
		return;
	}
	const finalName = await chooseTaskbookName(ctx, name);
	if (!finalName) return;
	const loaded = await loadTaskbook(cwdOf(ctx), finalName);
	if (!loaded) {
		ctx.ui.notify(`taskbook "${finalName}" 不存在`, "warning");
		return;
	}
	const missingEnv = await promptMissingRequiredEnv(ctx, loaded.contract);
	if (missingEnv.length > 0) {
		ctx.ui.notify(formatMissingEnvMessage(missingEnv), "warning");
		return;
	}
	// ponytail: 外部 CLI 依赖校验。/task run 是交互式,这里 notify + 安装提示引导用户,
	// 不自动装(task 原子单元,环境决策归人)。run_task 路径在 executeSubtask 已校验。
	const missingBinaries = missingRequiredBinaries(loaded.contract);
	if (missingBinaries.length > 0) {
		ctx.ui.notify(formatMissingBinariesMessage(missingBinaries), "warning");
		return;
	}
	const finalRawInput = !name && !rawInput.trim()
		? await ctx.ui?.input?.("一句话输入", "")
		: rawInput;
	const workerEnv = await resolveTaskWorkerEnv(ctx, loaded, activeTools);
	if (workerEnv === null) {
		ctx.ui.notify("已取消: 本次 task 未获得受保护工具授权。", "warning");
		return;
	}

	const startedAt = Date.now();
	const runDir = path.join(cwdOf(ctx), ".tasks", "runs", `task-${finalName}-${startedAt}`);
	const outputDir = resolveRunOutputDir(loaded.contract, path.join(runDir, "output"));
	await mkdir(runDir, { recursive: true });
	await mkdir(outputDir, { recursive: true });
	// ponytail: 对称缺口修复 —— headless 路径(executeSubtask,见 1124)在 dispatcher 调用前已显示
	// "正在解析输入...",交互式路径(/task run)漏了这一步,导致回车后到 worker spawn 之间
	// 有数秒~十几秒静默期(dispatcher 是一次阻塞 LLM 调用)。此处补齐,消除空白 ╌╌ 体验。
	setTaskRunWidget(ctx, [`⏳ taskbook "${finalName}" 准备中...`, "正在解析输入..."]);
	const runtimeInput = await resolveRuntimeInput(ctx, loaded.skill, loaded.contract, finalRawInput ?? "");
	const maxRetry = 3;
	const abortController = new AbortController();
	const runState: ActiveTaskRun = { taskbookName: finalName, abortController, progress: [], notes: [] };
	activeTaskRun = runState;

	const runPromise = (async () => {
	try {
		let currentAttempt = 1;
		const outcome = await runTaskWithRetry(loaded, runtimeInput, outputDir, cwdOf(ctx), {
			env: { ...workerEnv, ...requiredEnvValues(loaded.contract) },
			signal: abortController.signal,
			maxRetry,
			onWorkerStart: (attempt) => {
				currentAttempt = attempt;
				setTaskRunWidget(ctx, [
					`⏳ taskbook "${finalName}" 运行中...`,
					`尝试 ${attempt}/${maxRetry + 1}`,
					"worker 执行中...",
				]);
			},
			onWorkerUpdate: (text) => {
				const progress = formatProgressLines(text);
				const added = appendUniqueProgressLines(runState.progress, progress);
				if (added.length > 0) {
					setTaskRunWidget(ctx, [
						`⏳ taskbook "${finalName}" 运行中...`,
						`尝试 ${currentAttempt}/${maxRetry + 1}`,
						"worker 执行中...",
						"",
						"最近进展:",
						...runState.progress.slice(-5).map((line, index) => `${index + 1}. ${line}`),
					]);
				}
			},
			onVerifyStart: (attempt) => {
				setTaskRunWidget(ctx, [
					`⏳ taskbook "${finalName}" 运行中...`,
					`尝试 ${attempt}/${maxRetry + 1}`,
					"verify 执行中...",
				]);
			},
		});
		const { workerResult, verifyResult, attempts } = outcome;
		const duration = (Date.now() - startedAt) / 1000;
		const passed = workerResult.ok && verifyResult.passed;

		// abort:用户主动 /task stop 中断,不算失败,不发 onFail。但补记一条 run,
		// 让中断的 run 进 taskbook 历史(否则复盘数据不全——失败/中断的 run 散落在
		// .tasks/runs/ 成孤儿,taskbook 历史不认它)。status 记 fail(没成功),区别在
		// 不调 onFail 不触发修复流程。
		if (!workerResult.ok && outcome.aborted) {
			await appendRunToTaskbook(loaded.scope, cwdOf(ctx), finalName, {
				timestamp: new Date().toISOString(),
				status: "fail",
				input: runtimeInput,
				exitCode: 1,
				verifyFailures: [],
				duration,
				phases: outcome.phases,
			});
			const report = await formatRunResult(loaded, outputDir, workerResult, verifyResult, false, attempts, duration, runState.progress, runState.notes, outcome.phases);
			lastTaskRunReview = { taskbookName: finalName, content: buildTaskRunReviewContext(finalName, report) };
			onReviewReady?.(lastTaskRunReview);
			safeTaskNotify(ctx, `已停止 taskbook "${finalName}" 运行。下一步可用 /task 选择"复盘上次运行"。`, "info");
			return;
		}

		if (passed) {
			await appendRunToTaskbook(loaded.scope, cwdOf(ctx), finalName, {
				timestamp: new Date().toISOString(),
				status: "pass",
				input: runtimeInput,
				exitCode: 0,
				verifyFailures: [],
				duration,
				phases: outcome.phases,
			});
			const report = await formatRunResult(loaded, outputDir, workerResult, verifyResult, true, attempts, duration, runState.progress, runState.notes, outcome.phases);
			lastTaskRunReview = { taskbookName: finalName, content: buildTaskRunReviewContext(finalName, report) };
			onReviewReady?.(lastTaskRunReview);
			sendTaskProgressMessage(pi, { taskbookName: finalName, status: "PASS", lines: runState.progress });
			sendTaskMessage(pi, ctx, report, "info");
			return;
		}

		// FAIL: worker 失败 / verify 一直没过 / checker 主动 abort
		if (!workerResult.ok) {
			safeTaskNotify(ctx, `worker 执行失败: ${workerResult.errorMessage}`, "error");
		} else if (outcome.checkerAborted) {
			safeTaskNotify(ctx, "checker 判 abort,提前终止。", "warning");
		}
		await appendRunToTaskbook(loaded.scope, cwdOf(ctx), finalName, {
			timestamp: new Date().toISOString(),
			status: "fail",
			input: runtimeInput,
			exitCode: verifyResult.exitCode ?? 1,
			verifyFailures: verifyResult.failures,
			duration,
			phases: outcome.phases,
		});
		const report = await formatRunResult(loaded, outputDir, workerResult, verifyResult, false, attempts, duration, runState.progress, runState.notes, outcome.phases);
		lastTaskRunReview = { taskbookName: finalName, content: buildTaskRunReviewContext(finalName, report) };
		onReviewReady?.(lastTaskRunReview);
		sendTaskProgressMessage(pi, { taskbookName: finalName, status: "FAIL", lines: runState.progress });
		onFail?.({
			taskbookName: finalName,
			taskbookScope: loaded.scope,
			spec: loaded.spec,
			runDir,
			summary: await formatRepairSummary(loaded, outputDir, workerResult, verifyResult),
		});
		sendTaskMessage(pi, ctx, `${report}\n\n下一步: 输入修改意见修正 taskbook,或用 /task 选择修正/重新运行/查看/放弃。`, "error");
	} catch (error) {
		safeTaskNotify(ctx, `taskbook "${finalName}" 运行异常: ${error instanceof Error ? error.message : String(error)}`, "error");
	} finally {
		if (activeTaskRun === runState) activeTaskRun = undefined;
		setTaskRunWidget(ctx, undefined);
	}
	})();
	taskRunPromiseForTests = runPromise;
}

async function handleTaskDelete(ctx: any, name: string | undefined, tokens: string[]): Promise<void> {
	const finalName = await chooseTaskbookName(ctx, name);
	if (!finalName) return;
	const loaded = await loadTaskbook(cwdOf(ctx), finalName);
	if (!loaded) {
		ctx.ui.notify(`taskbook "${finalName}" 不存在`, "warning");
		return;
	}
	const scope = name ? scopeFromTokens(tokens) : loaded.scope;
	const ok = ctx.ui?.confirm
		? await ctx.ui.confirm("删除 taskbook", `删除 ${scope} taskbook "${finalName}"?`)
		: false;
	if (!ok) {
		ctx.ui.notify("已取消删除。", "info");
		return;
	}
	await deleteTaskbook(scope, cwdOf(ctx), finalName);
	ctx.ui.notify(`taskbook "${finalName}" 已删除。`, "info");
}

async function handleTaskRename(ctx: any, name: string | undefined, tokens: string[]): Promise<void> {
	const oldName = await chooseTaskbookName(ctx, name);
	if (!oldName) return;
	const loaded = await loadTaskbook(cwdOf(ctx), oldName);
	if (!loaded) {
		ctx.ui.notify(`taskbook "${oldName}" 不存在`, "warning");
		return;
	}
	const newName = tokens[2]?.trim() || await ctx.ui?.input?.(`重命名 "${oldName}" 为`, oldName);
	if (!newName?.trim() || newName.trim() === oldName) {
		ctx.ui.notify("已取消重命名。", "info");
		return;
	}
	try {
		await renameTaskbook(loaded.scope, cwdOf(ctx), oldName, newName.trim());
		ctx.ui.notify(`taskbook "${oldName}" 已重命名为 "${newName.trim()}"。`, "info");
	} catch (error) {
		ctx.ui.notify(`重命名失败: ${error instanceof Error ? error.message : String(error)}`, "error");
	}
}

// 上传 taskbook 到分享市场(首次走市场网站 OAuth 中转授权,凭证存本地复用)。
// 设计见 docs/design/2026-07-01-task-publish-from-tui.md §6.6。
async function handleTaskPublish(ctx: any, name: string | undefined): Promise<void> {
	const finalName = await chooseTaskbookName(ctx, name);
	if (!finalName) return;
	const loaded = await loadTaskbook(cwdOf(ctx), finalName);
	if (!loaded) {
		ctx.ui.notify(`taskbook "${finalName}" 不存在`, "warning");
		return;
	}

	// 1. 确保授权:无本地凭证则走 OAuth 中转(浏览器登录 → 轮询拿 cli_token)。
	let config = readTaskShareConfig();
	if (!config.token) {
		try {
			const auth = await ensureCliAuth((message, level) => ctx.ui?.notify?.(message, level));
			config = auth.config;
		} catch (error) {
			ctx.ui.notify(`授权失败: ${error instanceof Error ? error.message : String(error)}`, "error");
			return;
		}
	}

	// 2. 问版本号(默认 1.0.0;重复发布需升版本,由服务端 version 唯一约束兜底)。
	const version = await ctx.ui?.input?.(`上传版本号`, "1.0.0");
	if (!version?.trim()) {
		ctx.ui.notify("已取消上传。", "info");
		return;
	}

	// 3. 问市场展示文案。taskbook.description 是给 agent 的运行指令(常很长),
	// 不适合市场卡片给人看的标题/描述。这里让用户确认/改写,默认值取 taskbook
	// 字段但鼓励改短。title 默认用 name,description 默认截断取首句。
	const rawDesc = loaded.taskbook.description ?? "";
	const descDefault = rawDesc.length > 100 ? rawDesc.slice(0, 97) + "…" : rawDesc;
	const title = await ctx.ui?.input?.(`市场展示标题(简短)`, finalName);
	if (title === undefined) { ctx.ui.notify("已取消上传。", "info"); return; }
	const description = await ctx.ui?.input?.(`一句话描述(市场卡片用)`, descDefault);
	if (description === undefined) { ctx.ui.notify("已取消上传。", "info"); return; }

	// 4. 打包上传(内部清空 runs 历史,只传 5 核心文件)。
	ctx.ui.notify(`正在上传 "${finalName}" v${version.trim()}...`, "info");
	try {
		const result = await publishTask(loaded, version.trim(), config.token!, config.marketplaceUrl, title.trim() || undefined, description.trim() || undefined);
		ctx.ui.notify(`✅ 已提交 "${result.name}" v${result.version},等待管理员审核。`, "info");
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		// review: a 401/invalid_token means the stored cli_token expired (90d) or
		// was revoked. Clear it so the next /task publish re-runs OAuth instead of
		// reusing a dead token and failing the same opaque way.
		if (msg.includes("invalid_token")) {
			writeTaskShareConfig({ ...config, token: null, challenge: null });
			ctx.ui.notify(`授权已过期或失效,已清除本地凭证。请重新执行 /task publish 完成授权。`, "warning");
			return;
		}
		ctx.ui.notify(`上传失败: ${msg}`, "error");
	}
}

export function registerTask(pi: ExtensionAPI): void {
	(pi as any).registerMessageRenderer?.("task-progress", renderTaskProgressMessage);
	(pi as any).registerMessageRenderer?.(TASK_REVIEW_PROMPT_TYPE, renderTaskReviewPromptMessage);
	let state = createTaskState();
	let restoreToolsSnapshot: string[] | undefined;
	let cachedTaskbookPrompt = "";

	function getActiveTaskTools(): string[] {
		return typeof pi.getActiveTools === "function" ? pi.getActiveTools() : TASK_NORMAL_TOOLS;
	}

	function persistState(): void {
		pi.appendEntry(TASK_STATE_TYPE, state);
	}

	function setTaskStatus(ctx: any, label?: string): void {
		ctx.ui?.setStatus?.("task-mode", label);
	}

	function restoreActiveTools(): void {
		if (restoreToolsSnapshot && typeof pi.setActiveTools === "function") {
			pi.setActiveTools(restoreToolsSnapshot);
		}
		restoreToolsSnapshot = undefined;
	}

	async function startTaskbookEdit(ctx: any, loaded: LoadedTaskbook, userEditRequest = ""): Promise<void> {
		restoreToolsSnapshot ??= typeof pi.getActiveTools === "function" ? pi.getActiveTools() : TASK_NORMAL_TOOLS;
		state = enterReviewing({
			...state,
			spec: loaded.spec,
			taskbookName: loaded.taskbook.name,
			taskbookScope: loaded.scope,
		}, formatTaskbookUpdateSummary(loaded));
		pi.setActiveTools?.(TASK_PLANNING_TOOLS);
		persistState();
		setTaskStatus(ctx, "📋 reviewing");
		sendTaskReviewPromptMessage(
			pi,
			buildTaskReviewPrompt(state.spec, state.summary, userEditRequest),
			userEditRequest.trim() ? { mode: "edit", userEditRequest } : {},
		);
	}

	let promptingTaskMenu = false;
	async function promptTaskMenu(ctx: any): Promise<void> {
		if (!ctx.hasUI || !ctx.ui?.select || promptingTaskMenu) return;
		promptingTaskMenu = true;
		try {
			const selection = await ctx.ui.select("Task", getTaskCommandMenuOptions(state));
			const action = selection ? MENU_TO_ACTION.get(selection) : undefined;
			if (action) await handleTaskCommand(action, ctx);
		} finally {
			promptingTaskMenu = false;
		}
	}

	function enableTask(ctx: any): void {
		restoreToolsSnapshot ??= typeof pi.getActiveTools === "function" ? pi.getActiveTools() : TASK_NORMAL_TOOLS;
		state = enterPlanning(state);
		pi.setActiveTools?.(TASK_PLANNING_TOOLS);
		persistState();
		setTaskStatus(ctx, "📋 task");
		ctx.ui.notify("Task planning mode. 请用 questionnaire 对齐 one-step 任务和机器验收标准。", "info");
	}

	async function startTaskExecute(ctx: any): Promise<void> {
		if (!state.spec) {
			ctx.ui.notify("没有 Spec,先用 /task new 对齐。", "warning");
			return;
		}
		if (!state.planQuestionnaireUsed) {
			ctx.ui.notify("planning 阶段未用 questionnaire,拒绝执行。", "warning");
			pi.sendUserMessage?.("请先用 questionnaire 跟用户确认 Spec 假设,再重新输出 Spec。", { deliverAs: "followUp" });
			return;
		}
		const executeRunDir = path.join(cwdOf(ctx), ".tasks", "runs", `task-${state.taskbookName ?? "draft"}-${Date.now()}`);
		await mkdir(path.join(executeRunDir, "output"), { recursive: true });
		state = startExecuting(state, executeRunDir);
		restoreToolsSnapshot ??= typeof pi.getActiveTools === "function" ? pi.getActiveTools() : TASK_NORMAL_TOOLS;
		// execute 阶段放开所有环境工具(含 chrome_cdp/mcp),只排除 subagent。
		// planning 阶段曾把工具窄化成只读集,先恢复进入 task 前的全集再减 subagent。
		if (restoreToolsSnapshot) pi.setActiveTools?.(restoreToolsSnapshot);
		applyExecuteTools(pi);
		persistState();
		setTaskStatus(ctx, "🔧 executing");
		pi.sendUserMessage?.([
			"现在请在同一个对话里亲手把任务做完。",
			"",
			"Spec:",
			formatRequirementsSpec(state.spec),
			"",
			`TASK_OUTPUT_DIR: ${path.join(executeRunDir, "output")}`,
			"",
			"要求:",
			"- 必须实际产出文件,不能只描述",
			"- 产出默认放到 TASK_OUTPUT_DIR",
			"- 不要调用 subagent 工具",
			"- 完成后调用 task_complete 工具",
		].join("\n"), { deliverAs: "followUp" });
	}

	async function prepareReviewFromExecute(ctx: any, completionSummary = ""): Promise<void> {
		if (state.phase !== "executing") return;
		state = setPendingTransition({ ...state, summary: formatExecuteSummary(state, completionSummary) }, "review");
		persistState();
		ctx.ui.notify(`execute 完成,产出在 ${state.executeRunDir ? path.join(state.executeRunDir, "output") : "(unknown)"}。请选择下一步,或输入意见。`, "info");
		await promptTaskMenu(ctx);
	}

	async function enterReviewFromPending(ctx: any): Promise<void> {
		if (state.phase !== "executing" || state.pendingTransition !== "review") return;
		state = enterReviewing(state, state.summary);
		pi.setActiveTools?.(TASK_PLANNING_TOOLS);
		persistState();
		setTaskStatus(ctx, "📋 reviewing");
		sendTaskReviewPromptMessage(pi, buildTaskReviewPrompt(state.spec, state.summary));
	}

	async function enterRepairFromPending(ctx: any, note = ""): Promise<void> {
		if (state.pendingTransition !== "repair" || !state.spec) return;
		const summary = note.trim()
			? `${state.summary}\n\n用户补充修正意见:\n${note.trim()}`
			: state.summary;
		state = enterReviewing({ ...state, summary }, summary);
		pi.setActiveTools?.(TASK_PLANNING_TOOLS);
		persistState();
		setTaskStatus(ctx, "📋 reviewing");
		sendTaskReviewPromptMessage(pi, buildTaskReviewPrompt(state.spec, state.summary));
	}

	async function saveCurrentTask(ctx: any, name: string | undefined, tokens: string[]): Promise<void> {
		if (!state.spec || !state.reviewResult) {
			ctx.ui.notify("没有 review 产出,先复盘。", "warning");
			return;
		}
		if (!state.reviewQuestionnaireUsed) {
			ctx.ui.notify("review 未用 questionnaire 核对,拒绝保存。", "warning");
			pi.sendUserMessage?.("review 阶段还没有用 questionnaire 核对 skill/verify/contract 设计。请先用 questionnaire 确认 worker 路径和 verify 设计,然后重新输出 taskbook JSON。", { deliverAs: "followUp" });
			return;
		}
		// ponytail: 单点防御 — 覆盖 command:task、agent_end save、resumed 脏 state 三条路径。
		// 旧会话 resume 会带回修复前产生的非法 reviewResult.contract,agent_end guard 救不了已存数据。
		// 这里拦住后友好反馈,不让 raw assertValidContract 错误冒泡成 Extension error。
		let contractError: string | undefined;
		try {
			assertValidContract(state.reviewResult.contract);
		} catch (error) {
			contractError = (error as Error).message;
		}
		if (contractError) {
			ctx.ui.notify("复盘产出的 contract.json 不合法,拒绝保存。", "warning");
			pi.sendUserMessage?.(`复盘产出的 contract 不合法:${contractError}\n\ncontract 约定:runtimeInput 必须是字符串数组(字段名列表);runtimeInputMeta 是对象,每个 key 必须已在 runtimeInput 中声明。请按此约定修正 contract,重新输出完整 taskbook JSON。`, { deliverAs: "followUp" });
			return;
		}
		const finalName = name ?? state.taskbookName ?? await ctx.ui?.input?.("taskbook 名字", "my-task");
		if (!finalName?.trim()) {
			ctx.ui.notify("缺少 taskbook 名字。", "warning");
			return;
		}
		const scope = explicitScopeFromTokens(tokens) ?? state.taskbookScope ?? scopeFromTokens(tokens);
		const outputDir = state.executeRunDir ? path.join(state.executeRunDir, "output") : undefined;
		let runtimeInput = await resolveSelfCheckInput(ctx, state.reviewResult.contract);
		let positiveVerifyResult: Awaited<ReturnType<typeof runVerify>> | undefined;
		let blocked = false;
		await withTempVerify(cwdOf(ctx), state.reviewResult.verify, async (verifyPath, tempDir) => {
			const emptyOutputDir = path.join(tempDir, "empty-output");
			await mkdir(emptyOutputDir, { recursive: true });
			const runNegativeCheck = async (): Promise<boolean> => {
				const negativeResult = await runVerify({ verifyPath, outputDir: emptyOutputDir, input: runtimeInput });
				if (!negativeResult.passed && malformedVerifyFailureOutput(negativeResult)) {
					ctx.ui.notify(`verify 失败输出格式错误,拒绝保存。失败时 stdout 必须是 VerifyFailure[] JSON:\n${negativeResult.stdout.trim() || JSON.stringify(negativeResult.failures, null, 2)}`, "warning");
					pi.sendUserMessage?.(`verify 失败输出格式错误。请修正 verify.mjs: 失败时 stdout 必须只输出 VerifyFailure[] JSON 数组,不要输出 {"failures":[...]} 或普通文本。\n\n当前输出:\n${negativeResult.stdout.trim() || JSON.stringify(negativeResult.failures, null, 2)}`, { deliverAs: "followUp" });
					return false;
				}
				if (negativeResult.passed && artifactNames(state.reviewResult?.contract).length > 0) {
					ctx.ui.notify("verify 负例自检失败: 空 outputDir 也通过了,拒绝保存。", "warning");
					pi.sendUserMessage?.("verify 负例自检失败: 空 outputDir 也通过了。请修正 verify.mjs,必须检查 contract.artifacts 声明的产物真实存在,空目录应返回 VerifyFailure[] 并非 0 退出。", { deliverAs: "followUp" });
					return false;
				}
				return true;
			};
			if (!await runNegativeCheck()) {
				blocked = true;
				return;
			}
			if (!outputDir?.trim()) return;
			positiveVerifyResult = await runVerify({ verifyPath, outputDir, input: runtimeInput });
			if (!positiveVerifyResult.passed && runtimeFields(state.reviewResult?.contract).length > 0) {
				runtimeInput = await askSelfCheckInput(ctx, state.reviewResult?.contract);
				if (!await runNegativeCheck()) {
					blocked = true;
					return;
				}
				positiveVerifyResult = await runVerify({ verifyPath, outputDir, input: runtimeInput });
			}
		});
		if (blocked) return;
		if (!outputDir?.trim()) {
			if (state.taskbookName) {
				await saveTaskbook(scope, cwdOf(ctx), finalName.trim(), {
					description: state.reviewResult.description,
					spec: state.spec,
					skill: state.reviewResult.skill,
					verify: state.reviewResult.verify,
					contract: state.reviewResult.contract,
					tags: state.reviewResult.tags,
				});
				state = landTask(state);
				persistState();
				restoreActiveTools();
				setTaskStatus(ctx, undefined);
				ctx.ui.notify(`taskbook "${finalName.trim()}" 已更新。建议用 \`/task run ${finalName.trim()} <一句话>\` 重新验证。`, "info");
				return;
			}
			ctx.ui.notify("缺少首次成功产出的 outputDir,拒绝 landed。", "warning");
			return;
		}
		const verifyResult = positiveVerifyResult;
		if (!verifyResult.passed) {
			ctx.ui.notify(`verify 自证失败,未进入 landed:\n${JSON.stringify(verifyResult.failures, null, 2)}`, "warning");
			pi.sendUserMessage?.(`verify 自证失败。请根据失败断言修正 taskbook 的 skill、contract 或 verify,然后重新输出完整 taskbook JSON。\n\n失败断言:\n${JSON.stringify(verifyResult.failures, null, 2)}`, { deliverAs: "followUp" });
			return;
		}
		await saveTaskbook(scope, cwdOf(ctx), finalName.trim(), {
			description: state.reviewResult.description,
			spec: state.spec,
			skill: state.reviewResult.skill,
			verify: state.reviewResult.verify,
			contract: state.reviewResult.contract,
			tags: state.reviewResult.tags,
		});
		state = landTask(state);
		persistState();
		restoreActiveTools();
		setTaskStatus(ctx, undefined);
		ctx.ui.notify(`taskbook "${finalName.trim()}" 已就绪。以后用 \`/task run ${finalName.trim()} <一句话>\` 复用。`, "info");
	}

	pi.registerTool?.({
		name: "run_task",
		label: "Run Task",
		description: [
			"复用已通过机器验收的固定任务(taskbook)执行确定性工作。Modes: single (name + input), parallel (tasks: [{name,input}] 数组,最多 8 项,自动并发 4)。",
			"想并行跑多个 task(如批量下载、多账号抓取、N 个独立输入),用 parallel 模式:run_task({tasks:[{name,input},...]})。",
			"返回每个 task 的 PASS/FAIL(机器验收)、产物路径、outputDir。整体成败由你判断。",
			"⚠️ 并行 task 必须用本工具的 parallel 模式,不要用 subagent 包 run_task —— subagent 的 worker 子进程会丢掉 task 的受保护工具授权(CDP/MCP),必然授权失败。例如同时下载 39 个视频:正确做法是 run_task({tasks:[{name:'bili-download',input:'视频1'},...]}) 一批并发,不是 subagent parallel 4 个 worker 各调 run_task。",
		].join("\n"),
		parameters: Type.Object({
			name: Type.Optional(Type.String({ description: "taskbook 名(single 模式)" })),
			input: Type.Optional(Type.String({ description: "一句人话输入(single 模式)" })),
			tasks: Type.Optional(Type.Array(Type.Object({
				name: Type.String({ description: "taskbook 名" }),
				input: Type.String({ description: "一句人话输入" }),
			}), { description: "parallel 模式任务数组" })),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			try {
				const parsed = parseRunTaskParams(params);
				setTaskRunWidget(ctx, [
					"⏳ run_task 已启动",
					`任务数: ${parsed.tasks.length}`,
					"正在装载 taskbook...",
				]);
				const loaded = await Promise.all(parsed.tasks.map((task) => loadSubtask(cwdOf(ctx), task.name)));
				// ponytail: 批次级集中 hydrate —— 一次性补齐所有 task 的 requiredEnv(去重),
				// 避免 executeSubtask 内每个 subtask 各开 powershell(parallel 下 N×M 次 spawn)。
				await hydrateRequiredEnvForTaskbooks(loaded);
				const workerEnv = await resolveTaskWorkerEnv(ctx, loaded, getActiveTaskTools());
				if (workerEnv === null) throw new Error("run_task 需要受保护工具授权,但未获授权。");
				const results = await mapWithConcurrencyLimit(parsed.tasks, SUBTASK_CONCURRENCY, async (task, index) =>
					await executeSubtask(ctx, task, loaded[index], workerEnv, signal));
				// ponytail: 所有 task 都因输入解析失败而 FAIL → 标 isError。
				// 这保留 single 模式的旧行为(解析失败 = 调用失败,agent 据此重试输入);
				// parallel 模式下只要有任一 task 正常执行(PASS 或 worker/verify FAIL),不标 isError,
				// 各 task 独立结果在 content 里,批次不被单个解析失败炸掉。
				const allParseFailed = results.length > 0 && results.every((r) => r.parseFailed === true);
				if (allParseFailed) {
					return {
						content: [{ type: "text", text: results.map((r) => r.workerSummary).join("\n") || "所有 task 的输入解析失败" }],
						details: { mode: parsed.mode, results },
						isError: true,
					};
				}
				return {
					content: [{ type: "text", text: formatSubtaskToolText(parsed.mode, results) }],
					details: { mode: parsed.mode, results },
					// ponytail: 不 terminate。确定性任务的 PASS/FAIL + 产物路径已在 content 里,
					// agent 拿到后自行判断是否结束还是继续下一步(如"先抓列表再下载"的组合编排)。
					// 之前 terminate:true 是为绕开"工具后自动总结轮 provider 卡死",但那是 provider 层
					// 问题,terminate 只是回避不是修复,且代价是截断所有后续 agent 决策——多步编排的
					// 第一步(往往是 single)会被截断,逼用户手动"继续"。若 provider 卡死重现,应从
					// abort/provider 层修,不在 task 工具层用 terminate 兜底。
				};
			} catch (error) {
				return {
					content: [{ type: "text", text: (error as Error).message }],
					details: { mode: "single", results: [] },
					isError: true,
				};
			} finally {
				setTaskRunWidget(ctx, undefined);
			}
		},
	});

	pi.registerTool?.(taskCompleteTool);

	async function handleTaskCommand(args: string, ctx: any): Promise<void> {
			const resolvedArgs = await resolveTaskCommandArgs(args, ctx, state, activeTaskRun !== undefined, lastTaskRunReview !== undefined);
			if (resolvedArgs === undefined) return;
			const { action, name, tokens, rawInput } = parseTaskCommand(resolvedArgs);
			if (action === "review-last-run" && lastTaskRunReview) {
				const userObservation = ctx.ui?.input
					? await ctx.ui.input("你觉得刚刚的运行结果有什么问题吗?", "")
					: "";
				if (userObservation === undefined) return;
				// ponytail: 复盘时把 reviewer 的思考过程流式刷到 widget,复用 worker 的
				// formatProgressLines/appendUniqueProgressLines,避免干等静态"分析中"文案。
				const reviewProgress: string[] = [];
				const refreshReviewWidget = () => setTaskRunWidget(ctx, [
					`📋 正在复盘 taskbook "${lastTaskRunReview.taskbookName}"...`,
					...(reviewProgress.length > 0 ? reviewProgress : ["reviewer 分析中..."]),
				]);
				refreshReviewWidget();
				try {
					const result = await dispatchTaskRunReviewer({
						runContext: lastTaskRunReview.content,
						userObservation,
					}, {
						cwd: cwdOf(ctx),
						onUpdate: (partial) => {
							const text = partial.content?.[0]?.text;
							if (typeof text !== "string" || !text.trim()) return;
							const added = appendUniqueProgressLines(reviewProgress, formatProgressLines(text));
							if (added.length > 0) refreshReviewWidget();
						},
					});
					sendTaskMessage(pi, ctx, result.summary, result.ok ? "info" : "warning");
					// ponytail: reviewer 刚诊断完最懂怎么修,别让人回 /task edit 把诊断再说一遍。
					// 复盘成功时直接问一句,选"让 reviewer 修"就用 summary 当修改指令进 edit,
					// 形成 reviewer 自诊断→自我修复闭环。
					if (result.ok && ctx.ui?.select) {
						const next = await ctx.ui.select("复盘完成", ["让 reviewer 直接修", "仅查看建议", "结束复盘"]);
						if (next === "让 reviewer 直接修") {
							const loaded = await loadTaskbook(cwdOf(ctx), lastTaskRunReview.taskbookName);
							if (loaded) {
								await startTaskbookEdit(ctx, loaded, result.summary);
								return;
							}
							ctx.ui.notify(`taskbook "${lastTaskRunReview.taskbookName}" 加载失败,请手动 /task edit。`, "warning");
						}
					}
				} finally {
					setTaskRunWidget(ctx, undefined);
				}
				return;
			}
			if (action === "stop" && activeTaskRun) {
				activeTaskRun.abortController.abort();
				ctx.ui.notify(`已请求停止 taskbook "${activeTaskRun.taskbookName}"。`, "info");
				return;
			}
			if (action === "run-status" && activeTaskRun) {
				ctx.ui.notify([
					`taskbook "${activeTaskRun.taskbookName}" 运行中。`,
					...(activeTaskRun.progress.length > 0 ? ["", "最近进展:", ...activeTaskRun.progress.map((line, index) => `${index + 1}. ${line}`)] : []),
					...(activeTaskRun.notes.length > 0 ? ["", "用户备注:", ...activeTaskRun.notes.map((line, index) => `${index + 1}. ${line}`)] : []),
				].join("\n"), "info");
				return;
			}

			if (action === "new" || action === "clarify") {
				enableTask(ctx);
				return;
			}
			if (action === "edit") {
				const finalName = await chooseTaskbookName(ctx, name);
				if (!finalName) return;
				const userEditRequest = ctx.ui?.input
					? await ctx.ui.input("你想怎么修改这个 taskbook?(可留空)", "")
					: "";
				if (userEditRequest === undefined) return;
				const loaded = await loadTaskbook(cwdOf(ctx), finalName);
				if (!loaded) {
					ctx.ui.notify(`taskbook "${finalName}" 不存在`, "warning");
					return;
				}
				await startTaskbookEdit(ctx, loaded, userEditRequest);
				return;
			}
			if (action === "execute") {
				await startTaskExecute(ctx);
				return;
			}
			if (action === "continue-review") {
				if (state.phase !== "executing") {
					ctx.ui.notify("只有 executing 阶段完成后才能进入 review。", "warning");
					return;
				}
				if (state.pendingTransition === "review") {
					await enterReviewFromPending(ctx);
					return;
				}
				const completionSummary = rawInput.trim()
					? rawInput
					: await ctx.ui?.input?.("确认执行结果(可留空)", "");
				await prepareReviewFromExecute(ctx, completionSummary ?? "");
				return;
			}
			if (action === "repair") {
				await enterRepairFromPending(ctx);
				return;
			}
			if (action === "save") {
				await saveCurrentTask(ctx, name, tokens);
				return;
			}
			if (action === "change-spec") {
				if (!state.spec) {
					ctx.ui.notify("没有当前 Spec,先用 /task new 对齐。", "warning");
					return;
				}
				const edited = await ctx.ui?.editor?.("修改当前 Spec", formatRequirementsSpec(state.spec));
				if (edited?.trim()) {
					state = enterPlanning(state);
					persistState();
					pi.sendUserMessage?.(`按以下修改后的需求继续 /task planning：\n\n${edited.trim()}`, { deliverAs: "followUp" });
				}
				return;
			}
			if (action === "list") return await handleTaskList(ctx, tokens);
			if (action === "show") return await handleTaskShow(ctx, name ?? (state.pendingTransition === "repair" ? state.taskbookName : undefined), async (loaded, request) => {
				const userEditRequest = request ?? (ctx.ui?.input ? await ctx.ui.input("你想怎么修改这个 taskbook?(可留空)", "") : "");
				if (userEditRequest === undefined) return;
				await startTaskbookEdit(ctx, loaded, userEditRequest);
			});
			if (action === "run" || action === "rerun") return await handleTaskRun(pi, ctx, name ?? (action === "rerun" ? state.taskbookName : undefined), rawInput, (failure) => {
				state = setPendingTransition({
					...state,
					phase: "aborted",
					spec: failure.spec,
					taskbookName: failure.taskbookName,
					taskbookScope: failure.taskbookScope,
					summary: failure.summary,
					executeRunDir: failure.runDir,
					reviewResult: undefined,
					reviewQuestionnaireUsed: false,
				}, "repair");
				persistState();
				setTaskStatus(ctx, "📋 task");
			}, typeof pi.getActiveTools === "function" ? pi.getActiveTools() : TASK_NORMAL_TOOLS, (review) => {
				// ponytail: run 结束(含 abort/pass/fail)后把 lastRunReview 持久化进 state,
				// 让退出重进后 /task 仍能"复盘上次运行"。
				state = { ...state, lastRunReview: review };
				persistState();
			});
			if (action === "delete") return await handleTaskDelete(ctx, name, tokens);
			if (action === "rename") return await handleTaskRename(ctx, name, tokens);
			if (action === "publish") return await handleTaskPublish(ctx, name);
			if (action === "stop" || action === "exit" || action === "toggle" || action === "abort") {
				state = abortTask(state);
				persistState();
				setTaskStatus(ctx, undefined);
				restoreActiveTools();
				// 打"止"边界:把即将结束的 task 周期闭合,新建 task 时 filterTaskContextMessages
				// 会据此滤掉这段问答。display:false 静默,triggerTurn:false 不触发新轮次。
				pi.sendMessage?.({ customType: TASK_CONTEXT_END_TYPE, content: "task session ended", display: false }, { triggerTurn: false });
				ctx.ui.notify("Task disabled.", "info");
				return;
			}
			ctx.ui.notify("Usage: /task list|show|new|run|edit|rename|save|delete|publish|toggle|exit", "warning");
	}

	pi.registerCommand("task", {
		description: "UGK task delegation system",
		handler: handleTaskCommand,
	});

	pi.on("session_start", async (_event, ctx) => {
		cachedTaskbookPrompt = await buildTaskbookPrompt(cwdOf(ctx));
		const entries = ctx.sessionManager?.getEntries?.() ?? [];
		for (const entry of [...entries].reverse()) {
			if (entry.customType !== TASK_STATE_TYPE) continue;
			const restored = restoreTaskState(entry.data);
			if (!restored) break;
			state = restored;
			// ponytail: 从持久化的 state 恢复内存里的 lastTaskRunReview,让退出重进后
			// /task 菜单仍能显示"复盘上次运行"。content 直接复用,不用从 runDir 重建。
			if (state.lastRunReview) lastTaskRunReview = state.lastRunReview;
			if (isActivePhase(state.phase) || state.pendingTransition === "repair") {
				restoreToolsSnapshot ??= typeof pi.getActiveTools === "function" ? pi.getActiveTools() : TASK_NORMAL_TOOLS;
				if (state.phase === "planning") pi.setActiveTools?.(TASK_PLANNING_TOOLS);
				if (state.phase === "executing") applyExecuteTools(pi);
				if (state.phase === "reviewing") pi.setActiveTools?.(TASK_PLANNING_TOOLS);
				setTaskStatus(ctx, state.phase === "executing" ? "🔧 executing" : "📋 task");
			}
			break;
		}
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		setTaskStatus(ctx, undefined);
		restoreActiveTools();
	});

	// before_agent_start: 追加 taskbook 清单到 system prompt,而非整体覆盖。
	// 覆盖会吃掉 base prompt 里的 skill 清单/工具说明/项目上下文等全部内容,
	// 导致模型既看不到 skill 也触发不了。pi 把当前完整 systemPrompt 传给 event,
	// 我们只在其末尾追加 task 清单。
	pi.on("before_agent_start", async (event: any) => {
		const result: any = {};
		if (state.phase === "reviewing") {
			result.message = {
				customType: TASK_REVIEW_CONTEXT_TYPE,
				content: buildTaskReviewPrompt(state.spec, state.summary),
				display: false,
			};
		} else if (state.phase === "planning") {
			result.message = {
				customType: TASK_PLAN_CONTEXT_TYPE,
				content: TASK_ALIGN_PROMPT,
				display: false,
			};
		}
		if (cachedTaskbookPrompt) {
			const base = typeof event?.systemPrompt === "string" ? event.systemPrompt : "";
			result.systemPrompt = `${base}\n\n${cachedTaskbookPrompt}`;
		}
		return Object.keys(result).length > 0 ? result : undefined;
	});

	pi.on("context", async (event) => {
		return { messages: filterTaskContextMessages(event.messages, state) };
	});

	pi.on("tool_call", async (event) => {
		if (event.toolName === "questionnaire") {
			if (state.phase === "planning") state = markPlanQuestionnaireUsed(state);
			if (state.phase === "reviewing") state = markReviewQuestionnaireUsed(state);
			persistState();
		}
		if (state.phase === "executing") {
			// spec 4.2 硬约束:task-creator 禁止派 subagent(必须亲手做)。
			// 工具集已放开环境工具,subagent 不再靠 setActiveTools 隐式排除,
			// 这里显式 block 作为双保险(仿 planning 的 bash block)。
			if (event.toolName === "subagent") {
				return {
					block: true,
					reason: "Task executing 阶段禁止调用 subagent(task-creator 必须亲手做)。",
				};
			}
			if (event.toolName === "run_task") {
				return {
					block: true,
					reason: "Task executing 阶段禁止调用 run_task(task 不可嵌套)。",
				};
			}
			state = recordExecuteProcessEntry(state, {
				kind: "tool_call",
				toolName: event.toolName,
				argsSummary: summarizeToolArgs(event.input),
				timestamp: new Date().toISOString(),
			});
			for (const artifact of extractArtifactsFromToolInput(event.toolName, event.input)) {
				state = recordExecuteProcessEntry(state, {
					kind: "artifact",
					artifactPath: artifact.path,
					timestamp: new Date().toISOString(),
				});
			}
			persistState();
			return undefined;
		}
		if (state.phase !== "planning" || event.toolName !== "bash") return undefined;
		const command = event.input.command as string;
		if (isPlanningAllowedCommand(command)) return undefined;
		return {
			block: true,
			reason: `Task planning: command blocked (destructive or side-effecting). Command: ${command}`,
		};
	});

	pi.on("tool_execution_end", async (event, ctx) => {
		if (state.phase !== "executing" || event.toolName !== "task_complete" || event.isError) return;
		await prepareReviewFromExecute(ctx, taskCompleteSummaryFromEvent(event));
	});

	pi.on("input", async (event, ctx) => {
		const text = typeof event.text === "string" ? event.text.trim() : "";
		if (event.source !== "interactive" && event.source !== "rpc") return;
		if (activeTaskRun && text) {
			if (text === "/task" || text.startsWith("/task ")) {
				await handleTaskCommand(text.slice("/task".length).trim(), ctx);
				return { handled: true };
			}
			if (text.startsWith("/")) return undefined;
			activeTaskRun.notes.push(text);
			ctx.ui.notify(`已记录本次运行备注。需要中断请用 /task stop。`, "info");
			return { handled: true };
		}
		if (!state.pendingTransition) return;
		if (state.pendingTransition === "repair") {
			await enterRepairFromPending(ctx, text);
			return { handled: true };
		}
		if (text) {
			state = setPendingTransition(state, undefined);
			persistState();
			pi.sendUserMessage?.(`用户对当前 /task 阶段的补充或修改意见:\n\n${text}`, { deliverAs: "followUp" });
			return { handled: true };
		}
		if (state.pendingTransition === "execute") {
			await startTaskExecute(ctx);
			return { handled: true };
		}
		if (state.pendingTransition === "review") {
			await enterReviewFromPending(ctx);
			return { handled: true };
		}
		if (state.pendingTransition === "save") {
			await saveCurrentTask(ctx, undefined, []);
			return { handled: true };
		}
	});

	pi.on("agent_end", async (event, ctx) => {
		if (state.phase !== "planning" && state.phase !== "reviewing") return;
		const lastAssistant = [...event.messages].reverse().find(isAssistantMessage);
		if (!lastAssistant) return;
		if (state.phase === "reviewing") {
			if (isCancelledAssistant(lastAssistant)) {
				ctx.ui.notify("Task review cancelled; reviewing remains active.", "info");
				return;
			}
			if (hasQuestionnaireCancellation(event.messages)) {
				ctx.ui.notify("问卷已取消。reviewing 仍在进行,等你下一步指示或重新发起。", "info");
				return;
			}
			const text = getTextContent(lastAssistant);
			const result = extractTaskReviewResult(text);
			if (!result) {
				ctx.ui.notify("Task review did not find skill/verify/contract JSON yet.", "warning");
				pi.sendUserMessage?.("你刚才的 taskbook 结果没有被 /task 解析成合法 JSON。请重新输出一个合法 JSON 对象,包含 description、skill、verify、contract；不要输出 markdown 代码块或改动摘要；skill/verify 里的换行必须作为 JSON 字符串内容正确转义。", { deliverAs: "followUp" });
				return;
			}
			// ponytail: 早拦截。解析阶段就校验 contract,避免非法 reviewResult 进 state 后
			// 在 saveTaskbook 才抛 Invalid contract.runtimeInput —— 那时已误发"复盘完成"。
			// saveCurrentTask 入口和 saveTaskbook 各有一道校验,覆盖 resumed 脏 state 和物理写入。
			let contractError: string | undefined;
			try {
				assertValidContract(result.contract);
			} catch (error) {
				contractError = (error as Error).message;
			}
			if (contractError) {
				ctx.ui.notify("复盘产出的 contract.json 不合法,请修正后重新输出。", "warning");
				pi.sendUserMessage?.(`你刚才的 taskbook JSON 解析成功,但 contract 不合法:${contractError}\n\ncontract 约定:runtimeInput 必须是字符串数组(字段名列表);runtimeInputMeta 是对象,每个 key 必须已在 runtimeInput 中声明。请按此约定修正 contract,重新输出完整 taskbook JSON。`, { deliverAs: "followUp" });
				return;
			}
			state = setTaskReviewResult(state, result);
			state = setPendingTransition(state, "save");
			persistState();
			ctx.ui.notify("复盘完成。请选择下一步,或输入修改意见。", "info");
			await promptTaskMenu(ctx);
			return;
		}
		if (isCancelledAssistant(lastAssistant)) {
			ctx.ui.notify("Task planning cancelled; planning remains active.", "info");
			return;
		}
		if (hasQuestionnaireCancellation(event.messages)) {
			ctx.ui.notify("问卷已取消。planning 仍在进行,等你下一步指示或重新发起。", "info");
			return;
		}
		const text = getTextContent(lastAssistant);
		const spec = extractRequirementsSpec(text);
		if (!spec) {
			ctx.ui.notify("Task planning did not find a complete RequirementsSpec yet.", "warning");
			pi.sendUserMessage?.("你刚才没有输出可解析的 RequirementsSpec JSON。请先用 questionnaire 核对用户假设,然后重新输出完整 RequirementsSpec JSON,包含 goal、hardConstraints、acceptance。", { deliverAs: "followUp" });
			return;
		}
		state = setPendingTransition(setTaskSpec(state, spec), "execute");
		persistState();
		ctx.ui.notify("Spec 已对齐。请选择下一步,或输入修改意见。", "info");
		await promptTaskMenu(ctx);
		return undefined;
	});
}

export default registerTask;
