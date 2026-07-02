import test from "node:test";
import assert from "node:assert/strict";
import {
	CRON_PATHS,
	formatCronHealth,
	formatCronJobCreated,
	formatCronJobList,
	formatCronRunHistory,
} from "../extensions/cron-contract.ts";

test("defines cron HTTP paths in one place", () => {
	assert.equal(CRON_PATHS.health, "/health");
	assert.equal(CRON_PATHS.jobs, "/jobs");
	assert.equal(CRON_PATHS.job("job_123"), "/jobs/job_123");
	assert.equal(CRON_PATHS.jobRuns("job_123"), "/jobs/job_123/runs");
	assert.equal(CRON_PATHS.runs, "/runs");
});

test("formats cron health, job list, created job, and history text", () => {
	assert.match(formatCronHealth({ jobs: 2, scheduled: 1, port: 17741 }, "http://127.0.0.1:17741"), /^⏱️ Cron service/);
	assert.match(formatCronHealth({ jobs: 2, scheduled: 1, port: 17741 }, "http://127.0.0.1:17741"), /│\s*服务\s*│\s*✅ online\s*│/);
	assert.match(formatCronHealth({ jobs: 2, scheduled: 1, port: 17741 }, "http://127.0.0.1:17741"), /│\s*jobs\s*│\s*2\s*│/);
	assert.match(formatCronJobList([]), /│\s*📭\s*│\s*没有定时任务。用 action=add 新增\(schedule \+ prompt\)。\s*│/);
	assert.match(
		formatCronJobList([
			{ id: "job_1", name: "daily", schedule: "0 9 * * *", prompt: "日报", enabled: true, createdAt: "2026-06-16T00:00:00.000Z" },
		]),
		/│\s*✅\s*│\s*daily\s*│\s*0 9 \* \* \*\s*│\s*日报\s*│\s*job_1\s*│/,
	);
	assert.equal(
		formatCronJobCreated({
			id: "job_1",
			name: "daily",
			schedule: "0 9 * * *",
			prompt: "日报",
			model: "deepseek-v4-pro",
			enabled: true,
			createdAt: "2026-06-16T00:00:00.000Z",
		}),
		"✅ 已新增任务: daily\n⏰ 调度: 0 9 * * *\n🧾 任务: 日报\n🤖 模型: deepseek-v4-pro\n🆔 id: job_1\n\n到点会自动执行,结果在 ~/.pi/agent/cron-output/",
	);
	assert.match(formatCronRunHistory([]), /│\s*📭\s*│\s*没有执行历史\(任务还没到点触发过\)。\s*│/);
	assert.match(
		formatCronRunHistory([
			{
				id: "run_1",
				jobId: "job_1",
				jobName: "daily",
				startedAt: "2026-06-16T00:00:00.000Z",
				finishedAt: "2026-06-16T00:00:02.000Z",
				exitCode: 0,
				outputFile: "out.txt",
			},
		]),
		/│\s*✅\s*│\s*daily\s*│\s*2026-06-16T00:00:00.000Z\s*│\s*exit=0\s*│\s*out.txt\s*│/,
	);
});

test("formatCronRunHistory includes stderr snippets for failed runs", () => {
	const text = formatCronRunHistory([
		{
			id: "run_1",
			jobId: "job_1",
			jobName: "daily",
			startedAt: "2026-06-16T00:00:00.000Z",
			finishedAt: "2026-06-16T00:00:02.000Z",
			exitCode: 1,
			outputFile: "out.txt",
			stderrSnippet: "missing API key",
		},
	]);

	assert.match(text, /│\s*❌\s*│\s*daily\s*│\s*2026-06-16T00:00:00.000Z\s*│\s*exit=1\s*│\s*out.txt\s*│/);
	assert.match(text, /│\s*↳\s*│\s*daily\s*│\s*错误\s*│\s*💥 missing API key\s*│/);
});
