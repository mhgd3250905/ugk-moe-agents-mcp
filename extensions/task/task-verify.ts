import { spawn } from "node:child_process";
import type { VerifyFailure } from "./task-book.ts";

export type { VerifyFailure } from "./task-book.ts";

export interface VerifyResult {
	passed: boolean;
	failures: VerifyFailure[];
	stdout: string;
	stderr: string;
	exitCode: number | null;
	durationMs: number;
}

function normalizeFailures(value: unknown): VerifyFailure[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const failures: VerifyFailure[] = [];
	for (const item of value) {
		if (!item || typeof item !== "object" || Array.isArray(item)) return undefined;
		const record = item as Record<string, unknown>;
		if (
			typeof record.assertion !== "string" ||
			typeof record.expected !== "string" ||
			typeof record.actual !== "string"
		) {
			return undefined;
		}
		failures.push({
			assertion: record.assertion,
			expected: record.expected,
			actual: record.actual,
			...(typeof record.hint === "string" ? { hint: record.hint } : {}),
		});
	}
	return failures;
}

function parseFailures(stdout: string, stderr: string): VerifyFailure[] {
	try {
		const parsed = normalizeFailures(JSON.parse(stdout));
		if (parsed) return parsed;
	} catch {
		// fall through
	}
	return [{
		assertion: "verify.mjs 输出结构化失败",
		expected: "stdout 为 VerifyFailure[] JSON",
		actual: stdout.trim() || stderr.trim() || "no output",
	}];
}

export async function runVerify(opts: {
	verifyPath: string;
	outputDir: string;
	input: unknown;
	timeoutMs?: number;
	taskDir?: string;
}): Promise<VerifyResult> {
	const startedAt = Date.now();
	const child = spawn(process.execPath, [opts.verifyPath], {
		env: {
			...process.env,
			TASK_OUTPUT_DIR: opts.outputDir,
			TASK_INPUT: JSON.stringify(opts.input),
			// ponytail: 对称注入 TASK_DIR,让 verify 能引用 taskbook 自带 scripts/(如跑脚本生成预期值对比)
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

	const exitCode = await new Promise<number | null>((resolve) => {
		child.on("error", () => resolve(1));
		child.on("close", (code) => resolve(code));
	});
	clearTimeout(timer);

	if (timedOut) {
		return {
			passed: false,
			failures: [{
				assertion: "verify.mjs 在超时内完成",
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
