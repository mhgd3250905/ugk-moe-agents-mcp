import { renderTerminalTable } from "./terminal-table.ts";

export interface CronJob {
	id: string;
	name: string;
	schedule: string;
	prompt: string;
	model?: string;
	cwd?: string;
	enabled: boolean;
	createdAt: string;
}

export interface CronRun {
	id: string;
	jobId: string;
	jobName: string;
	startedAt: string;
	finishedAt?: string;
	exitCode: number | null;
	outputFile?: string;
	stderrSnippet?: string;
}

export interface CronHealth {
	jobs: number;
	scheduled: number;
	port: number;
}

export const CRON_PATHS = {
	health: "/health",
	jobs: "/jobs",
	job: (id: string) => `/jobs/${id}`,
	jobRuns: (id: string) => `/jobs/${id}/runs`,
	runs: "/runs",
} as const;

export function formatCronHealth(health: CronHealth, baseUrl: string): string {
	return [
		"⏱️ Cron service",
		"",
		renderTerminalTable(
			["项目", "状态"],
			[
				["服务", "✅ online"],
				["jobs", `${health.jobs}`],
				["scheduled", `${health.scheduled}`],
				["port", `${health.port}`],
				["地址", baseUrl],
			],
		),
	].join("\n");
}

export function formatCronJobList(jobs: CronJob[]): string {
	const rows = jobs.length
		? jobs.map((j) => [
				j.enabled ? "✅" : "⏸️",
				j.name,
				j.schedule,
				j.model ? `${j.prompt} · ${j.model}` : j.prompt,
				j.id,
			])
		: [["📭", "没有定时任务。用 action=add 新增(schedule + prompt)。", "", "", ""]];
	return [`📋 定时任务(${jobs.length} 个):`, "", renderTerminalTable(["状态", "任务", "调度", "描述", "id"], rows)].join("\n");
}

export function formatCronJobCreated(job: CronJob): string {
	return `✅ 已新增任务: ${job.name}\n⏰ 调度: ${job.schedule}\n🧾 任务: ${job.prompt}${job.model ? `\n🤖 模型: ${job.model}` : ""}\n🆔 id: ${job.id}\n\n到点会自动执行,结果在 ~/.pi/agent/cron-output/`;
}

export function formatCronRunHistory(runs: CronRun[]): string {
	const rows = runs.flatMap((r) => {
		const icon = r.exitCode === 0 ? "✅" : r.exitCode === null ? "⏳" : "❌";
		const result = r.finishedAt ? `exit=${r.exitCode}` : "进行中";
		const main = [icon, r.jobName, r.startedAt, result, r.outputFile ?? ""];
		if (!r.stderrSnippet || r.exitCode === 0 || r.exitCode === null) return [main];
		return [main, ["↳", r.jobName, "错误", `💥 ${r.stderrSnippet}`, ""]];
	});
	const tableRows = rows.length ? rows : [["📭", "没有执行历史(任务还没到点触发过)。", "", "", ""]];
	return [`📜 执行历史(最近 ${runs.length} 条):`, "", renderTerminalTable(["状态", "任务", "开始", "结果", "输出"], tableRows)].join("\n");
}
