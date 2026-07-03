/**
 * verify.mjs — 专家 agent 结果闸门。
 *
 * 移植自 extensions/task/task-verify.ts,去 TS 类型,逻辑不变。
 * 契约:spawn verify 脚本,注入 TASK_OUTPUT_DIR/TASK_INPUT/TASK_DIR 三个 env。
 *   exit 0 = PASS;非 0 = FAIL,stdout 必须是 VerifyFailure[] JSON。
 *
 * VerifyFailure = { assertion: string, expected: string, actual: string, hint?: string }
 */

import { spawn } from "node:child_process";

/**
 * @typedef {Object} VerifyFailure
 * @property {string} assertion
 * @property {string} expected
 * @property {string} actual
 * @property {string} [hint]
 */

/**
 * @typedef {Object} VerifyResult
 * @property {boolean} passed
 * @property {VerifyFailure[]} failures
 * @property {string} stdout
 * @property {string} stderr
 * @property {(number|null)} exitCode
 * @property {number} durationMs
 */

/**
 * @param {unknown} value
 * @returns {VerifyFailure[] | undefined}
 */
function normalizeFailures(value) {
	if (!Array.isArray(value)) return undefined;
	/** @type {VerifyFailure[]} */
	const failures = [];
	for (const item of value) {
		if (!item || typeof item !== "object" || Array.isArray(item)) return undefined;
		const record = /** @type {Record<string, unknown>} */ (item);
		if (
			typeof record.assertion !== "string" ||
			typeof record.expected !== "string" ||
			typeof record.actual !== "string"
		) {
			return undefined;
		}
		/** @type {VerifyFailure} */
		const f = {
			assertion: record.assertion,
			expected: record.expected,
			actual: record.actual,
			...(typeof record.hint === "string" ? { hint: record.hint } : {}),
		};
		failures.push(f);
	}
	return failures;
}

/**
 * @param {string} stdout
 * @param {string} stderr
 * @returns {VerifyFailure[]}
 */
function parseFailures(stdout, stderr) {
	try {
		const parsed = normalizeFailures(JSON.parse(stdout));
		if (parsed) return parsed;
	} catch {
		// fall through
	}
	return [{
		assertion: "verify 输出结构化失败",
		expected: "stdout 为 VerifyFailure[] JSON",
		actual: stdout.trim() || stderr.trim() || "no output",
	}];
}

/**
 * @param {{verifyPath: string, outputDir: string, input: unknown, timeoutMs?: number, taskDir?: string}} opts
 * @returns {Promise<VerifyResult>}
 */
export async function runVerify(opts) {
	const startedAt = Date.now();
	const child = spawn(process.execPath, [opts.verifyPath], {
		env: {
			...process.env,
			TASK_OUTPUT_DIR: opts.outputDir,
			TASK_INPUT: JSON.stringify(opts.input),
			// ponytail: 对称注入 TASK_DIR,让 verify 能引用专家包自带 scripts/
			...(opts.taskDir ? { TASK_DIR: opts.taskDir } : {}),
		},
		stdio: ["ignore", "pipe", "pipe"],
	});

	let stdout = "";
	let stderr = "";
	child.stdout.setEncoding("utf8");
	child.stderr.setEncoding("utf8");
	child.stdout.on("data", (chunk) => { stdout += chunk; });
	child.stderr.on("data", (chunk) => { stderr += chunk; });

	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		child.kill("SIGTERM");
	}, opts.timeoutMs ?? 30_000);

	const exitCode = await new Promise((resolve) => {
		child.on("error", () => resolve(1));
		child.on("close", (code) => resolve(code));
	});
	clearTimeout(timer);

	if (timedOut) {
		return {
			passed: false,
			failures: [{
				assertion: "verify 在超时内完成",
				expected: `${opts.timeoutMs ?? 30_000}ms 内退出`,
				actual: "timeout",
			}],
			stdout,
			stderr,
			exitCode,
			durationMs: Date.now() - startedAt,
		};
	}

	return {
		passed: exitCode === 0,
		failures: exitCode === 0 ? [] : parseFailures(stdout, stderr),
		stdout,
		stderr,
		exitCode,
		durationMs: Date.now() - startedAt,
	};
}
