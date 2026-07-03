/**
 * runner.mjs — 专家实例 spawn + 异步 job 管理 + verify gate。
 *
 * 核心流程(每次 startExpert):
 *  1. 加载专家包(skillPath + verifyPath + requiredTools)
 *  2. 生成 jobId + outputDir
 *  3. spawn 干净 ugk 实例(--mode json -p --no-session),env 注入:
 *       UGK_ONLY_SKILL=<skillPath>        → 只加载这个 skill(见 extensions/index.ts)
 *       TASK_OUTPUT_DIR=<outputDir>       → 产物落盘处
 *       TASK_INPUT=<JSON input>           → 专家的输入
 *       UGK_TASK_ALLOW_CHROME_CDP=1       → chrome_cdp 授权(如专家声明)
 *       UGK_TASK_ALLOW_MCP_TOOLS=<list>   → MCP 工具授权(如专家声明)
 *  4. 不等子进程,立即返回 jobId
 *  5. 后台:监听 stdout JSON 事件流 → 子进程退出 → runVerify → 更新 job 状态
 *
 * job 状态机:running → pass | fail | error
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { runVerify } from "./verify.mjs";
import { loadExperts, getAgentDir } from "./registry.mjs";
import { checkRequirements, getEffectiveEnv, missingRequirementsError } from "./requirements.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(__dirname, "..");

/**
 * @typedef {"running"|"pass"|"fail"|"error"} JobStatus
 *
 * @typedef {Object} Job
 * @property {string} jobId
 * @property {string} expert
 * @property {JobStatus} status
 * @property {string} outputDir
 * @property {string} [summary]       — 专家一句话摘要(子进程最终输出)
 * @property {string} [errorMessage]  — error/fail 时的诊断
 * @property {import("./verify.mjs").VerifyFailure[]} [failures] — verify FAIL 的结构化原因
 * @property {string[]} artifacts     — 产物绝对路径
 * @property {number} startedAt
 * @property {number} [endedAt]
 * @property {string} [progress]      — running 时的进度文本
 */

/** @type {Map<string, Job>} */
const jobs = new Map();

let jobCounter = 0;

/** @returns {string} */
function newJobId() {
	jobCounter += 1;
	return `job-${Date.now()}-${jobCounter}`;
}

/**
 * 解析 ugk 子进程的 JSON 事件流,取最终 assistant 文本作为摘要。
 * 参考 subagent-runtime.ts 的 getFinalOutput。
 * @param {string[]} messages — 收集到的 message_end 事件
 * @returns {string}
 */
function getFinalOutput(messages) {
	for (let i = messages.length - 1; i >= 0; i -= 1) {
		const evt = messages[i];
		if (evt?.type === "message_end" && evt.message?.content) {
			const textParts = evt.message.content
				.filter((/** @type {any} */ c) => c.type === "text")
				.map((/** @type {any} */ c) => c.text);
			if (textParts.length) return textParts.join("");
		}
	}
	return "";
}

/**
 * 启动专家任务。立即返回 jobId,后台 spawn + verify。
 * 权限预检:缺权限时不 spawn(省 token),返回结构化缺失清单。
 *
 * @param {{expert: string, input: unknown}} params
 * @returns {Promise<{jobId: string} | {missingRequirements: import("./requirements.mjs").Requirement[]}>}
 * @throws {Error} 专家不存在
 */
export async function startExpert({ expert, input }) {
	const experts = await loadExperts();
	const pkg = experts.get(expert);
	if (!pkg) {
		throw new Error(`专家 "${expert}" 不存在。已安装:${expert.size ? [...experts.keys()].join(", ") : "(无)"}`);
	}

	// 权限门:先预检,缺了就不 spawn(省 token 省 time),直接返回结构化缺失清单
	const { missing } = await checkRequirements(pkg);
	if (missing.length > 0) {
		return { missingRequirements: missing };
	}

	const jobId = newJobId();
	const runsDir = path.join(getAgentDir(), "expert-runs");
	await fs.promises.mkdir(runsDir, { recursive: true });
	const outputDir = path.join(runsDir, jobId);
	await fs.promises.mkdir(outputDir, { recursive: true });

	/** @type {Job} */
	const job = {
		jobId,
		expert,
		status: "running",
		outputDir,
		artifacts: [],
		startedAt: Date.now(),
		progress: "spawn 专家实例中",
	};
	jobs.set(jobId, job);

	// 后台跑,不 await
	runExpertBackground(job, pkg, input).catch((err) => {
		job.status = "error";
		job.errorMessage = `runner 异常: ${err?.message || String(err)}`;
		job.endedAt = Date.now();
	});

	return { jobId };
}

/**
 * @param {Job} job
 * @param {import("./registry.mjs").ExpertPackage} pkg
 * @param {unknown} input
 */
async function runExpertBackground(job, pkg, input) {
	const ugkBin = path.join(PACKAGE_ROOT, "bin", "ugk.js");

	// 授权 env:从 config.json 算出(consent 类只在用户明确同意时才注入)。
	// 修复之前的漏洞:不再无条件注入 UGK_TASK_ALLOW_CHROME_CDP。
	// 见 requirements.mjs getEffectiveEnv。
	const effectiveEnv = getEffectiveEnv(pkg);

	const childEnv = {
		...process.env,
		UGK_ONLY_SKILL: pkg.skillPath,
		TASK_OUTPUT_DIR: job.outputDir,
		TASK_INPUT: JSON.stringify(input),
		TASK_DIR: pkg.dir,
		// 专家实例是 headless 受控 spawn,跳过 workspace trust 交互门
		UGK_SKIP_WORKSPACE_TRUST: "1",
		...effectiveEnv,
	};

	// 专家实例的初始 prompt:激活它的 skill,告知环境变量契约。
	// skill 本身(经 UGK_ONLY_SKILL 加载,description 触发 LLM 读 SKILL.md)指导具体执行。
	const prompt = [
		`你是 ${pkg.name} 专家。`,
		"环境变量已注入:",
		"- TASK_INPUT(JSON):你的输入参数,先读它。",
		"- TASK_OUTPUT_DIR:产物落盘目录,最终结果写到这里。",
		"- TASK_DIR:你的专家包目录(含 scripts/ 可调用脚本)。",
		"",
		`先 read 你的 SKILL.md(${pkg.skillPath})了解执行方法,`,
		"然后按 SKILL.md 的指引执行任务,把产物写到 TASK_OUTPUT_DIR。",
		"完成后只回复一句话摘要(产物路径 + 关键统计),不要贴产物内容。",
	].join("\n");

	const args = ["--mode", "json", "-p", "--no-session", prompt];
	const child = spawn(process.execPath, [ugkBin, ...args], {
		env: childEnv,
		stdio: ["ignore", "pipe", "pipe"],
	});

	/** @type {string[]} */
	const events = [];
	let stderr = "";
	let stdoutBuf = "";

	child.stdout.setEncoding("utf8");
	child.stderr.setEncoding("utf8");
	child.stdout.on("data", (chunk) => {
		stdoutBuf += chunk;
		// 按行解析 JSON 事件
		let nl;
		while ((nl = stdoutBuf.indexOf("\n")) >= 0) {
			const line = stdoutBuf.slice(0, nl).trim();
			stdoutBuf = stdoutBuf.slice(nl + 1);
			if (!line) continue;
			try {
				const evt = JSON.parse(line);
				events.push(evt);
				if (evt.type === "tool_call" && evt.toolName) {
					job.progress = `调用工具: ${evt.toolName}`;
				}
			} catch {
				// 非 JSON 行忽略
			}
		}
	});
	child.stderr.on("data", (chunk) => { stderr += chunk; });

	const exitCode = await new Promise((resolve) => {
		child.on("error", () => resolve(1));
		child.on("close", (code) => resolve(code));
	});

	job.summary = getFinalOutput(events) || "(专家无文本输出)";

	if (exitCode !== 0) {
		job.status = "error";
		job.errorMessage = `专家实例退出码 ${exitCode}${stderr ? `\nstderr: ${stderr.slice(-500)}` : ""}`;
		job.endedAt = Date.now();
		return;
	}

	// verify gate
	job.progress = "验收中";
	try {
		const result = await runVerify({
			verifyPath: pkg.verifyPath,
			outputDir: job.outputDir,
			input,
			taskDir: pkg.dir,
		});
		// 回收产物
		job.artifacts = (pkg.artifacts || [])
			.map((name) => path.join(job.outputDir, name))
			.filter((p) => fs.existsSync(p));
		if (job.artifacts.length === 0) {
			// 未声明 artifacts 或都不存在 → 收 outputDir 下全部文件
			try {
				job.artifacts = fs.readdirSync(job.outputDir)
					.map((name) => path.join(job.outputDir, name))
					.filter((p) => fs.statSync(p).isFile());
			} catch {
				job.artifacts = [];
			}
		}

		if (result.passed) {
			job.status = "pass";
			job.endedAt = Date.now();
		} else {
			job.status = "fail";
			job.failures = result.failures;
			job.errorMessage = result.stderr?.trim() || undefined;
			job.endedAt = Date.now();
		}
	} catch (err) {
		job.status = "error";
		job.errorMessage = `verify 运行失败: ${err?.message || String(err)}`;
		job.endedAt = Date.now();
	}
}

/**
 * @param {string} jobId
 * @returns {Job | undefined}
 */
export function checkJob(jobId) {
	return jobs.get(jobId);
}

/**
 * @param {string} jobId
 * @returns {{status: JobStatus, artifacts?: string[], summary?: string, failures?: import("./verify.mjs").VerifyFailure[], errorMessage?: string} | undefined}
 */
export function getResult(jobId) {
	const job = jobs.get(jobId);
	if (!job) return undefined;
	return {
		status: job.status,
		...(job.artifacts.length ? { artifacts: job.artifacts } : {}),
		...(job.summary ? { summary: job.summary } : {}),
		...(job.failures?.length ? { failures: job.failures } : {}),
		...(job.errorMessage ? { errorMessage: job.errorMessage } : {}),
	};
}

/** 清理已结束的旧 job(防内存泄漏,保留最近 100 个)。 */
export function gcJobs() {
	if (jobs.size <= 100) return;
	const ended = [...jobs.entries()]
		.filter(([, j]) => j.status !== "running")
		.sort((a, b) => (a[1].endedAt || 0) - (b[1].endedAt || 0));
	const toRemove = ended.slice(0, jobs.size - 100);
	for (const [id] of toRemove) jobs.delete(id);
}
