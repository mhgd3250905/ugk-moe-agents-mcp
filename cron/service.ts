/**
 * ugk cron 定时服务(常驻后台进程,独立于 ugk 实例)
 *
 * 职责:
 *   1. 用 node-cron 调度任务(标准 5 段 crontab 语法)
 *   2. 提供本地 HTTP API(127.0.0.1),供任意 ugk 实例增删改查
 *   3. 到点触发 → spawn `ugk --print "<prompt>"` 子进程跑 agent 任务
 *   4. 结果写文件 + 执行历史持久化(重启不丢)
 *
 * 启动:npm run cron:start  或  node cron/service.ts
 * 端口:默认 17741,可用环境变量 UGK_CRON_PORT 覆盖
 *
 * 存储(都在 ~/.pi/agent/ 下):
 *   cron-jobs.json    任务清单
 *   cron-runs.json    执行历史(最近 100 条)
 *   cron-output/      每次执行的完整输出文件
 */

import cron from "node-cron";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { homedir } from "node:os";
import { CRON_PATHS, type CronJob, type CronRun } from "../extensions/cron-contract.ts";
import { getCronAgentBin } from "./agent-bin.ts";

// ---- 配置 ----
const PORT = parseInt(process.env.UGK_CRON_PORT || "17741", 10);
const HOST = "127.0.0.1"; // 只监听本机回环,不对外
const PI_DIR = path.join(homedir(), ".pi", "agent");
const JOBS_FILE = path.join(PI_DIR, "cron-jobs.json");
const RUNS_FILE = path.join(PI_DIR, "cron-runs.json");
const OUTPUT_DIR = path.join(PI_DIR, "cron-output");
const MAX_RUNS = 100; // 历史上限,超出删最旧

// ---- 存储 ----
function ensureDirs() {
	for (const d of [PI_DIR, OUTPUT_DIR]) {
		fs.mkdirSync(d, { recursive: true });
	}
}

function loadJobs(): CronJob[] {
	try {
		return JSON.parse(fs.readFileSync(JOBS_FILE, "utf8"));
	} catch {
		return [];
	}
}

function saveJobs(jobs: CronJob[]) {
	fs.writeFileSync(JOBS_FILE, JSON.stringify(jobs, null, 2));
}

function loadRuns(): CronRun[] {
	try {
		return JSON.parse(fs.readFileSync(RUNS_FILE, "utf8"));
	} catch {
		return [];
	}
}

function saveRuns(runs: CronRun[]) {
	// 保留最近 MAX_RUNS 条
	const trimmed = runs.slice(-MAX_RUNS);
	fs.writeFileSync(RUNS_FILE, JSON.stringify(trimmed, null, 2));
}

function appendRun(run: CronRun) {
	const runs = loadRuns();
	runs.push(run);
	saveRuns(runs);
}

function updateRun(id: string, patch: Partial<CronRun>) {
	const runs = loadRuns();
	const idx = runs.findIndex((r) => r.id === id);
	if (idx >= 0) {
		runs[idx] = { ...runs[idx], ...patch };
		saveRuns(runs);
	}
}

// ---- 调度器:任务 id → node-cron 的 ScheduledTask ----
const scheduled = new Map<string, cron.ScheduledTask>();

function genId(): string {
	return `job_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

/** 到点触发:spawn ugk --print 跑任务 */
async function executeJob(job: CronJob) {
	const runId = `run_${Date.now().toString(36)}`;
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	const safeName = job.name.replace(/[^\w-]+/g, "_");
	const outputFile = path.join(OUTPUT_DIR, `${safeName}-${stamp}.txt`);

	const run: CronRun = {
		id: runId,
		jobId: job.id,
		jobName: job.name,
		startedAt: new Date().toISOString(),
		exitCode: null,
		outputFile,
	};
	appendRun(run);
	console.log(`[${run.startedAt}] 触发任务: ${job.name} (${runId})`);

	// 构造命令:优先 ugk(npm i -g ugk-agent PATH 上有),否则 node + 随包 bin/ugk.js(克隆/本地兜底)。
	// getCronAgentBin 在后者场景返回带引号的 "node abs/path" 字符串,必须经 shell 执行才能正确解析。
	const agentBin = getCronAgentBin();
	const args = ["--print", job.prompt];
	if (job.model) {
		args.push("--model", job.model);
	}

	const child = spawn(agentBin, args, {
		cwd: job.cwd || process.cwd(),
		shell: true, // cron 非交互,统一 shell 执行(兼容裸命令名和 "node abspath" 两种形态)
		stdio: ["ignore", "pipe", "pipe"],
	});

	const out = fs.createWriteStream(outputFile);
	let stderrBuf = "";

	child.stdout.on("data", (d) => out.write(d));
	child.stderr.on("data", (d) => {
		out.write(d);
		stderrBuf += d.toString();
	});

	child.on("close", (code) => {
		out.end();
		updateRun(runId, {
			finishedAt: new Date().toISOString(),
			exitCode: code ?? -1,
			stderrSnippet: stderrBuf.slice(-500) || undefined,
		});
		console.log(
			`[${new Date().toISOString()}] 完成: ${job.name} exit=${code} → ${outputFile}`,
		);
	});

	child.on("error", (err) => {
		out.end();
		updateRun(runId, {
			finishedAt: new Date().toISOString(),
			exitCode: -1,
			stderrSnippet: `spawn error: ${err.message}`,
		});
		console.error(`任务 ${job.name} 启动失败:`, err.message);
	});
}

function scheduleJob(job: CronJob) {
	// 先取消旧的(若有)
	const old = scheduled.get(job.id);
	if (old) old.stop();

	if (!job.enabled) return;

	// 校验 cron 表达式
	if (!cron.validate(job.schedule)) {
		console.error(`任务 ${job.name} 的 cron 表达式无效: ${job.schedule}`);
		return;
	}

	const task = cron.schedule(job.schedule, () => {
		executeJob(job).catch((e) => console.error(`执行 ${job.name} 出错:`, e));
	});
	scheduled.set(job.id, task);
	console.log(`已调度: ${job.name} [${job.schedule}]`);
}

function unscheduleJob(id: string) {
	const task = scheduled.get(id);
	if (task) {
		task.stop();
		scheduled.delete(id);
	}
}

// ---- HTTP server ----
function send(res: any, status: number, body: unknown) {
	const json = JSON.stringify(body);
	res.writeHead(status, {
		"Content-Type": "application/json; charset=utf-8",
		"Content-Length": Buffer.byteLength(json),
	});
	res.end(json);
}

function readBody(req: any): Promise<any> {
	return new Promise((resolve, reject) => {
		let buf = "";
		req.on("data", (c: Buffer) => (buf += c.toString()));
		req.on("end", () => {
			try {
				resolve(buf ? JSON.parse(buf) : {});
			} catch (e) {
				reject(e);
			}
		});
		req.on("error", reject);
	});
}

const server = createServer(async (req, res) => {
	const url = new URL(req.url || "/", `http://${HOST}`);
	const p = url.pathname;
	const method = req.method || "GET";

	try {
		// CORS / 预检(本机用,宽松)
		res.setHeader("Access-Control-Allow-Origin", "*");
		res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
		res.setHeader("Access-Control-Allow-Headers", "Content-Type");
		if (method === "OPTIONS") {
			res.writeHead(204);
			return res.end();
		}

		// GET /health
		if (p === CRON_PATHS.health && method === "GET") {
			return send(res, 200, {
				ok: true,
				service: "ugk-cron",
				jobs: loadJobs().length,
				scheduled: scheduled.size,
				port: PORT,
			});
		}

		// GET /jobs
		if (p === CRON_PATHS.jobs && method === "GET") {
			return send(res, 200, { jobs: loadJobs() });
		}

		// POST /jobs
		if (p === CRON_PATHS.jobs && method === "POST") {
			const body = await readBody(req);
			if (!body.schedule || !body.prompt) {
				return send(res, 400, { error: "schedule 和 prompt 必填" });
			}
			if (!cron.validate(body.schedule)) {
				return send(res, 400, { error: `无效的 cron 表达式: ${body.schedule}` });
			}
			const job: CronJob = {
				id: genId(),
				name: body.name?.trim() || `cron-${Date.now().toString(36)}`,
				schedule: body.schedule.trim(),
				prompt: body.prompt,
				model: body.model?.trim() || undefined,
				cwd: body.cwd?.trim() || undefined,
				enabled: body.enabled !== false,
				createdAt: new Date().toISOString(),
			};
			const jobs = loadJobs();
			jobs.push(job);
			saveJobs(jobs);
			scheduleJob(job);
			return send(res, 201, { job });
		}

		// DELETE /jobs/:id
		const delMatch = p.match(/^\/jobs\/([\w-]+)$/);
		if (delMatch && method === "DELETE") {
			const id = delMatch[1];
			const jobs = loadJobs();
			const idx = jobs.findIndex((j) => j.id === id);
			if (idx < 0) return send(res, 404, { error: "任务不存在" });
			jobs.splice(idx, 1);
			saveJobs(jobs);
			unscheduleJob(id);
			return send(res, 200, { ok: true, id });
		}

		// GET /jobs/:id/runs
		const runMatch = p.match(/^\/jobs\/([\w-]+)\/runs$/);
		if (runMatch && method === "GET") {
			const id = runMatch[1];
			const runs = loadRuns()
				.filter((r) => r.jobId === id)
				.slice(-20);
			return send(res, 200, { runs });
		}

		// GET /runs(全部历史,最近 50)
		if (p === CRON_PATHS.runs && method === "GET") {
			return send(res, 200, { runs: loadRuns().slice(-50) });
		}

		return send(res, 404, { error: `未知路由: ${method} ${p}` });
	} catch (e: any) {
		return send(res, 500, { error: e?.message || String(e) });
	}
});

// ---- 启动 ----
ensureDirs();
const jobs = loadJobs();
for (const job of jobs) scheduleJob(job);

server.listen(PORT, HOST, () => {
	console.log(`ugk cron 服务已启动:`);
	console.log(`  HTTP  → http://${HOST}:${PORT}`);
	console.log(`  任务  → ${jobs.length} 个已加载,${scheduled.size} 个已调度`);
	console.log(`  存储  → ${PI_DIR}`);
	console.log(`  输出  → ${OUTPUT_DIR}`);
	console.log(`(Ctrl+C 退出)`);
});

// 优雅退出
const shutdown = () => {
	console.log("\n正在停止...");
	for (const task of scheduled.values()) task.stop();
	scheduled.clear();
	server.close(() => process.exit(0));
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
