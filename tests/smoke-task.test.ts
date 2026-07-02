import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
	addDeepSeekEnvFallback,
	buildTaskReport,
	getWidgetTimeline,
	hasActiveJudgeUiPollution,
	hasTaskFail,
	hasTaskInputFallback,
	hasTaskLanded,
	hasTaskPass,
} from "../scripts/smoke-task.mjs";

test("package exposes task smoke script", async () => {
	const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));

	assert.equal(pkg.scripts["smoke:task"], "node scripts/smoke-task.mjs");
});

test("task smoke report requires PASS evidence", () => {
	const events = [
		{ msg: { type: "extension_ui_request", method: "notify", message: "## 任务结果\n✅ taskbook \"smoke_name_count\" PASS\n任务: smoke\n尝试: 1 次\n耗时: 1.0s\n\n## 验证\nverify 自证: 全过" } },
	];
	const report = buildTaskReport({
		exitCode: 0,
		timedOut: false,
		stderr: "",
		events,
		taskbookRuns: [{ status: "pass" }],
	});

	assert.equal(hasTaskPass(events), true);
	assert.equal(hasTaskLanded(events), false);
	assert.match(report, /Task PASS: detected/);
	assert.match(report, /Taskbook run: pass/);
	assert.match(report, /Result: pass/);
	assert.match(report, /dispatcher fallback input: absent/);
});

test("task smoke detects landed notify", () => {
	const events = [
		{ msg: { type: "extension_ui_request", method: "notify", message: 'taskbook "smoke_name_count" 已就绪。' } },
	];

	assert.equal(hasTaskLanded(events), true);
});

test("task smoke detects FAIL notify", () => {
	const events = [
		{ msg: { type: "extension_ui_request", method: "notify", message: '❌ taskbook "smoke_name_count" FAIL(尝试 4 次, 2.2s)' } },
	];

	assert.equal(hasTaskFail(events), true);
	assert.match(buildTaskReport({ exitCode: 0, timedOut: false, stderr: "", events, taskbookRuns: [{ status: "fail" }] }), /Taskbook run: fail/);
});

test("task smoke replaces malformed process DeepSeek key with user key", () => {
	assert.deepEqual(addDeepSeekEnvFallback({ DEEPSEEK_API_KEY: "DeepSeek" }, "sk-user"), { DEEPSEEK_API_KEY: "sk-user" });
	assert.deepEqual(addDeepSeekEnvFallback({ DEEPSEEK_API_KEY: "sk-existing" }, "sk-user"), { DEEPSEEK_API_KEY: "sk-existing" });
});

test("task smoke reads setWidget widgetLines into timeline", () => {
	const events = [
		{ msg: { type: "extension_ui_request", method: "setWidget", widgetKey: "task-run-view", widgetLines: ["worker 执行中", "尝试 1/4"] } },
		{ msg: { type: "extension_ui_request", method: "setWidget", widgetKey: "task-run-view" } },
	];

	assert.deepEqual(getWidgetTimeline(events), ["worker 执行中 / 尝试 1/4", "(cleared)"]);
	assert.match(buildTaskReport({ exitCode: 0, timedOut: false, stderr: "", events, taskbookRuns: [] }), /worker 执行中 \/ 尝试 1\/4/);
});

test("task smoke distinguishes fallback input and Judge cleanup from active pollution", () => {
	assert.equal(hasTaskInputFallback([
		{ msg: { type: "extension_ui_request", method: "input", title: "task input: request" } },
	]), true);
	assert.equal(hasActiveJudgeUiPollution([
		{ msg: { type: "extension_ui_request", method: "setStatus", statusKey: "judge-mode" } },
	]), false);
	assert.equal(hasActiveJudgeUiPollution([
		{ msg: { type: "extension_ui_request", method: "setStatus", statusKey: "judge-mode", statusText: "⚖ driving" } },
	]), true);
});
