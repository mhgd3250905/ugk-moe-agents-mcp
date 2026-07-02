import { discoverAgents } from "../subagent-agents.ts";
import { getFinalOutput, isFailedResult, type SingleResult } from "../subagent-runtime.ts";
import { runSingleAgent, type OnUpdateCallback } from "../subagent.ts";

export interface TaskRunReviewerInput {
	runContext: string;
	userObservation: string;
}

export interface TaskRunReviewerResult {
	ok: boolean;
	summary: string;
}

type RunSingleAgentLike = typeof runSingleAgent;
let reviewerRunnerForTests: RunSingleAgentLike | undefined;

export function setTaskRunReviewerRunnerForTests(runner: RunSingleAgentLike | undefined): void {
	reviewerRunnerForTests = runner;
}

export function buildTaskRunReviewerPrompt(input: TaskRunReviewerInput): string {
	return [
		"你是 /task run reviewer。只做复盘,不改文件,不调用工具。",
		"判断用户指出的问题是否成立,区分 worker 临场问题和 taskbook 设计问题。",
		"",
		"## 用户观察",
		input.userObservation.trim() || "(未填写)",
		"",
		"## 运行上下文",
		input.runContext,
		"",
		"输出:",
		"- 刚刚发生了什么",
		"- 用户指出的问题是否成立",
		"- 是 worker 临场问题还是 taskbook 设计问题",
		"- 下一步建议: 无需处理 / 重新运行 / 进入 /task edit",
	].join("\n");
}

export async function dispatchTaskRunReviewer(
	input: TaskRunReviewerInput,
	opts: { cwd: string; signal?: AbortSignal; onUpdate?: OnUpdateCallback },
): Promise<TaskRunReviewerResult> {
	const discovery = discoverAgents(opts.cwd, "both");
	const runner = reviewerRunnerForTests ?? runSingleAgent;
	const result: SingleResult = await runner(
		opts.cwd,
		discovery.agents,
		"reviewer",
		buildTaskRunReviewerPrompt(input),
		opts.cwd,
		undefined,
		opts.signal,
		opts.onUpdate,
		(results) => ({
			mode: "single",
			agentScope: "both",
			projectAgentsDir: discovery.projectAgentsDir,
			results,
		}),
	);
	const output = getFinalOutput(result.messages);
	if (isFailedResult(result)) {
		return { ok: false, summary: result.stderr || output || "reviewer 执行失败" };
	}
	return { ok: true, summary: output || "reviewer 未输出内容" };
}
