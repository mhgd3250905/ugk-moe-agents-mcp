import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
	buildTaskCheckerPrompt,
	dispatchChecker,
	parseCheckerResult,
	setTaskCheckerRunnerForTests,
} from "../extensions/task/task-checker.ts";

const failures = [{ assertion: "文件存在", expected: "report.json", actual: "missing" }];

test("buildTaskCheckerPrompt includes failures contract outputDir and retry budget", () => {
	const prompt = buildTaskCheckerPrompt({
		failures,
		contract: { artifacts: [{ name: "report.json" }] },
		outputDir: "E:/out",
		retryBudget: 2,
	});

	assert.match(prompt, /E:\/out/);
	assert.match(prompt, /retryBudget: 2/);
	assert.match(prompt, /文件存在/);
	assert.match(prompt, /report\.json/);
});

test("parseCheckerResult accepts fenced, bare, and embedded JSON", () => {
	const expected = { hint: "检查输出路径", verdict: "retry" as const, reason: "缺文件可修复" };

	assert.deepEqual(parseCheckerResult(`\`\`\`json\n${JSON.stringify(expected)}\n\`\`\``), expected);
	assert.deepEqual(parseCheckerResult(JSON.stringify(expected)), expected);
	assert.deepEqual(parseCheckerResult(`结果:${JSON.stringify(expected)}.`), expected);
	assert.equal(parseCheckerResult("{}"), undefined);
});

test("dispatchChecker returns parsed checker JSON", async () => {
	setTaskCheckerRunnerForTests(async (_defaultCwd, _agents, agentName, task) => ({
		agent: agentName,
		agentSource: "user",
		task,
		exitCode: 0,
		messages: [{
			role: "assistant",
			content: [{ type: "text", text: "```json\n{\"hint\":\"检查输出路径\",\"verdict\":\"retry\",\"reason\":\"缺文件可修复\"}\n```" }],
		}],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 },
	}) as any);
	try {
		const result = await dispatchChecker({ failures, contract: {}, outputDir: "E:/out", retryBudget: 1 }, { cwd: process.cwd() });

		assert.deepEqual(result, { hint: "检查输出路径", verdict: "retry", reason: "缺文件可修复" });
	} finally {
		setTaskCheckerRunnerForTests(undefined);
	}
});

test("dispatchChecker aborts on failed or unparseable checker output", async () => {
	setTaskCheckerRunnerForTests(async () => ({
		agent: "checker",
		agentSource: "user",
		task: "task",
		exitCode: 1,
		messages: [],
		stderr: "checker missing",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
	}) as any);
	try {
		const failed = await dispatchChecker({ failures, contract: {}, outputDir: "E:/out", retryBudget: 1 }, { cwd: process.cwd() });
		assert.equal(failed.verdict, "abort");
		assert.match(failed.hint, /checker missing/);
	} finally {
		setTaskCheckerRunnerForTests(undefined);
	}

	setTaskCheckerRunnerForTests(async () => ({
		agent: "checker",
		agentSource: "user",
		task: "task",
		exitCode: 0,
		messages: [{ role: "assistant", content: [{ type: "text", text: "not json" }] }],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 },
	}) as any);
	try {
		const unparseable = await dispatchChecker({ failures, contract: {}, outputDir: "E:/out", retryBudget: 1 }, { cwd: process.cwd() });
		assert.equal(unparseable.verdict, "abort");
		assert.match(unparseable.reason, /not parseable/);
	} finally {
		setTaskCheckerRunnerForTests(undefined);
	}
});

test("checker agent is read-only and defines JSON verdict output", () => {
	const source = readFileSync(path.resolve("agents/checker.md"), "utf8");

	assert.match(source, /^tools: read, grep, find, ls, bash$/m);
	assert.match(source, /"verdict": "retry"/);
});
