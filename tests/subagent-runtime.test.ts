import test from "node:test";
import assert from "node:assert/strict";
import {
	formatTokens,
	formatUsageStats,
	getDisplayItems,
	getFinalOutput,
	getResultOutput,
	isFailedResult,
	mapWithConcurrencyLimit,
	normalizeAgentModelForCli,
	truncateParallelOutput,
} from "../extensions/subagent-runtime.ts";
import { buildSubagentChildEnv } from "../extensions/subagent.ts";

test("formats token and usage summaries for subagent results", () => {
	assert.equal(formatTokens(999), "999");
	assert.equal(formatTokens(1500), "1.5k");
	assert.equal(formatTokens(12500), "13k");

	assert.equal(
		formatUsageStats(
			{
				input: 1200,
				output: 345,
				cacheRead: 0,
				cacheWrite: 20,
				cost: 0.01234,
				contextTokens: 4567,
				turns: 2,
			},
			"deepseek-v4-pro",
		),
		"2 turns ↑1.2k ↓345 W20 $0.0123 ctx:4.6k deepseek-v4-pro",
	);
});

test("normalizes UGK DeepSeek agent model ids for CLI subagents", () => {
	assert.equal(normalizeAgentModelForCli("deepseek-v4-pro"), "deepseek/deepseek-v4-pro");
	assert.equal(normalizeAgentModelForCli("deepseek-v4-flash"), "deepseek/deepseek-v4-flash");
	assert.equal(normalizeAgentModelForCli("openai/gpt-5.4"), "openai/gpt-5.4");
});

test("subagent child env strips task-local tool authorization unless explicitly passed", () => {
	const baseEnv = {
		PI_CODING_AGENT_DIR: "E:/agents",
		UGK_TASK_ALLOW_CHROME_CDP: "1",
		UGK_TASK_ALLOW_MCP_TOOLS: "alpha__echo",
		KEEP_ME: "yes",
	};

	const normal = buildSubagentChildEnv({}, baseEnv);
	assert.equal(normal.KEEP_ME, "yes");
	assert.equal(normal.PI_CODING_AGENT_DIR, "E:/agents");
	assert.equal(normal.UGK_TASK_ALLOW_CHROME_CDP, undefined);
	assert.equal(normal.UGK_TASK_ALLOW_MCP_TOOLS, undefined);

	const explicit = buildSubagentChildEnv({ UGK_TASK_ALLOW_CHROME_CDP: "1" }, baseEnv);
	assert.equal(explicit.UGK_TASK_ALLOW_CHROME_CDP, "1");
	assert.equal(explicit.UGK_TASK_ALLOW_MCP_TOOLS, undefined);
});

test("extracts final output and display items from subagent messages", () => {
	const messages = [
		{
			role: "assistant",
			content: [
				{ type: "text", text: "first" },
				{ type: "toolCall", name: "read", arguments: { path: "extensions/subagent.ts" } },
			],
		},
		{
			role: "assistant",
			content: [{ type: "text", text: "final" }],
		},
	] as any[];

	assert.equal(getFinalOutput(messages), "final");
	assert.deepEqual(getDisplayItems(messages), [
		{ type: "text", text: "first" },
		{ type: "toolCall", name: "read", args: { path: "extensions/subagent.ts" } },
		{ type: "text", text: "final" },
	]);
});

test("classifies failed results and chooses the right result output", () => {
	const success = {
		exitCode: 0,
		messages: [{ role: "assistant", content: [{ type: "text", text: "ok" }] }],
	} as any;
	const failure = {
		exitCode: 1,
		stderr: "spawn failed",
		messages: [{ role: "assistant", content: [{ type: "text", text: "ignored" }] }],
	} as any;

	assert.equal(isFailedResult(success), false);
	assert.equal(getResultOutput(success), "ok");
	assert.equal(isFailedResult(failure), true);
	assert.equal(getResultOutput(failure), "spawn failed");
});

test("truncates oversized parallel output while preserving small output", () => {
	assert.equal(truncateParallelOutput("small", 10), "small");
	const truncated = truncateParallelOutput("abcdefghij", 5);
	assert.ok(truncated.startsWith("abcde\n\n[Output truncated:"));
});

test("maps with a concurrency limit while preserving result order", async () => {
	const active: number[] = [];
	let maxActive = 0;
	const result = await mapWithConcurrencyLimit([1, 2, 3, 4], 2, async (item) => {
		active.push(item);
		maxActive = Math.max(maxActive, active.length);
		await new Promise((resolve) => setTimeout(resolve, 10));
		active.pop();
		return item * 2;
	});

	assert.deepEqual(result, [2, 4, 6, 8]);
	assert.equal(maxActive, 2);
});
