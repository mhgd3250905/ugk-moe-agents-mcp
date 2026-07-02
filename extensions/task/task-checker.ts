import { discoverAgents } from "../subagent-agents.ts";
import { getFinalOutput, isFailedResult, type SingleResult, type UsageStats } from "../subagent-runtime.ts";
import { runSingleAgent } from "../subagent.ts";
import type { VerifyFailure } from "./task-book.ts";

export interface CheckerInput {
	failures: VerifyFailure[];
	contract: unknown;
	outputDir: string;
	retryBudget: number;
}

export interface CheckerResult {
	hint: string;
	verdict: "retry" | "abort";
	reason: string;
	model?: string;
	usage?: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number };
}

type RunSingleAgentLike = typeof runSingleAgent;
let checkerRunnerForTests: RunSingleAgentLike | undefined;

export function setTaskCheckerRunnerForTests(runner: RunSingleAgentLike | undefined): void {
	checkerRunnerForTests = runner;
}

export function buildTaskCheckerPrompt(input: CheckerInput): string {
	return [
		"你是 /task checker。只读分析 worker 产出和 verify 失败,给 worker 方向性反馈。",
		"",
		`产出目录: ${input.outputDir}`,
		`剩余 retryBudget: ${input.retryBudget}`,
		"",
		"verify failures:",
		JSON.stringify(input.failures, null, "\t"),
		"",
		"contract.json:",
		JSON.stringify(input.contract, null, "\t"),
		"",
		"输出 fenced JSON: {\"hint\":\"...\",\"verdict\":\"retry|abort\",\"reason\":\"...\"}",
	].join("\n");
}

function normalizeCheckerResult(value: unknown): CheckerResult | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const record = value as Record<string, unknown>;
	if (typeof record.hint !== "string" || !record.hint.trim()) return undefined;
	if (record.verdict !== "retry" && record.verdict !== "abort") return undefined;
	if (typeof record.reason !== "string" || !record.reason.trim()) return undefined;
	return {
		hint: record.hint.trim(),
		verdict: record.verdict,
		reason: record.reason.trim(),
	};
}

function parseCandidate(candidate: string): CheckerResult | undefined {
	try {
		return normalizeCheckerResult(JSON.parse(candidate));
	} catch {
		return undefined;
	}
}

export function parseCheckerResult(text: string): CheckerResult | undefined {
	const fencedPattern = /```(?:json)?\s*([\s\S]*?)```/gi;
	for (const match of text.matchAll(fencedPattern)) {
		const result = parseCandidate(match[1].trim());
		if (result) return result;
	}
	const trimmed = text.trim();
	const direct = parseCandidate(trimmed);
	if (direct) return direct;
	const firstBrace = trimmed.indexOf("{");
	const lastBrace = trimmed.lastIndexOf("}");
	return firstBrace >= 0 && lastBrace > firstBrace
		? parseCandidate(trimmed.slice(firstBrace, lastBrace + 1))
		: undefined;
}

function compactUsage(usage: UsageStats): CheckerResult["usage"] {
	return {
		input: usage.input,
		output: usage.output,
		cacheRead: usage.cacheRead,
		cacheWrite: usage.cacheWrite,
		cost: usage.cost,
	};
}

function usageDetails(result: SingleResult): Pick<CheckerResult, "model" | "usage"> {
	const usage = compactUsage(result.usage)!;
	return {
		...(result.model ? { model: result.model } : {}),
		...(usage.input + usage.output + usage.cacheRead + usage.cacheWrite > 0 ? { usage } : {}),
	};
}

export async function dispatchChecker(
	input: CheckerInput,
	opts: { cwd: string; signal?: AbortSignal },
): Promise<CheckerResult> {
	const discovery = discoverAgents(opts.cwd, "both");
	const runner = checkerRunnerForTests ?? runSingleAgent;
	const result: SingleResult = await runner(
		opts.cwd,
		discovery.agents,
		"checker",
		buildTaskCheckerPrompt(input),
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
	const output = getFinalOutput(result.messages);
	if (isFailedResult(result)) {
		return {
			hint: result.stderr || output || "checker 执行失败",
			verdict: "abort",
			reason: "checker agent failed",
			...usageDetails(result),
		};
	}
	const parsed = parseCheckerResult(output);
	return parsed ? { ...parsed, ...usageDetails(result) } : {
		hint: output || "checker 未输出结构化结果",
		verdict: "abort",
		reason: "checker output was not parseable JSON",
		...usageDetails(result),
	};
}
