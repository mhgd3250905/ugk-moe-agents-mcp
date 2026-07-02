import { discoverAgents } from "../subagent-agents.ts";
import { getFinalOutput, isFailedResult, type SingleResult } from "../subagent-runtime.ts";
import { runSingleAgent } from "../subagent.ts";
import type { LoadedTaskbook } from "./task-book.ts";
import { formatRequirementsSpec } from "./task-spec.ts";

type RunSingleAgentLike = typeof runSingleAgent;
let guideRunnerForTests: RunSingleAgentLike | undefined;

export function setTaskGuideRunnerForTests(runner: RunSingleAgentLike | undefined): void {
	guideRunnerForTests = runner;
}

export function buildTaskGuidePrompt(loaded: LoadedTaskbook): string {
	return [
		"你是 /task taskbook 导览 reviewer。只读分析,不改文件,不调用工具。",
		"把现有 taskbook 拆成用户可按编号编辑的环节列表。",
		"输出要求: 只输出有序号列表,每项一行,格式为 `1. 环节名: 简短说明`。不要输出原始文件全文。",
		"",
		`Taskbook: ${loaded.taskbook.name}`,
		`Description: ${loaded.taskbook.description}`,
		"",
		"spec.json:",
		"```json",
		formatRequirementsSpec(loaded.spec),
		"```",
		"",
		"skill.md:",
		"```md",
		loaded.skill.trim(),
		"```",
		"",
		"contract.json:",
		"```json",
		JSON.stringify(loaded.contract, null, "\t"),
		"```",
		"",
		"verify.mjs:",
		"```js",
		loaded.verify.trim(),
		"```",
	].join("\n");
}

export async function dispatchTaskGuide(loaded: LoadedTaskbook, opts: { cwd: string; signal?: AbortSignal }): Promise<string> {
	const discovery = discoverAgents(opts.cwd, "both");
	const runner = guideRunnerForTests ?? runSingleAgent;
	const result: SingleResult = await runner(
		opts.cwd,
		discovery.agents,
		"reviewer",
		buildTaskGuidePrompt(loaded),
		opts.cwd,
		undefined,
		opts.signal,
		undefined,
		(results) => ({
			mode: "single",
			agentScope: "both",
			projectAgentsDir: discovery.projectAgentsDir,
			results,
		}),
	);
	const output = getFinalOutput(result.messages).trim();
	if (isFailedResult(result)) throw new Error(result.stderr || output || "task guide reviewer failed");
	return output;
}
