import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runVerify } from "../extensions/task/task-verify.ts";

function tempDir() {
	return mkdtempSync(path.join(os.tmpdir(), "ugk-task-verify-"));
}

test("runVerify returns pass result for exit 0", async () => {
	const dir = tempDir();
	try {
		const verifyPath = path.join(dir, "verify.mjs");
		await writeFile(verifyPath, "console.log(process.env.TASK_OUTPUT_DIR); process.exit(0);\n", "utf8");
		const result = await runVerify({ verifyPath, outputDir: dir, input: { ok: true } });

		assert.equal(result.passed, true);
		assert.deepEqual(result.failures, []);
		assert.match(result.stdout, new RegExp(dir.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")));
		assert.equal(result.exitCode, 0);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("runVerify parses structured JSON failures", async () => {
	const dir = tempDir();
	try {
		const verifyPath = path.join(dir, "verify.mjs");
		await writeFile(verifyPath, `console.log(JSON.stringify([{
			assertion: "文件存在",
			expected: "report.json",
			actual: "missing",
			hint: "检查输出目录"
		}])); process.exit(1);\n`, "utf8");
		const result = await runVerify({ verifyPath, outputDir: dir, input: {} });

		assert.equal(result.passed, false);
		assert.deepEqual(result.failures, [{
			assertion: "文件存在",
			expected: "report.json",
			actual: "missing",
			hint: "检查输出目录",
		}]);
		assert.equal(result.exitCode, 1);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("runVerify wraps malformed failure output", async () => {
	const dir = tempDir();
	try {
		const verifyPath = path.join(dir, "verify.mjs");
		await writeFile(verifyPath, "console.log('boom'); process.exit(2);\n", "utf8");
		const result = await runVerify({ verifyPath, outputDir: dir, input: {} });

		assert.equal(result.passed, false);
		assert.equal(result.failures[0].assertion, "verify.mjs 输出结构化失败");
		assert.match(result.failures[0].actual, /boom/);
		assert.equal(result.exitCode, 2);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("runVerify times out slow scripts", async () => {
	const dir = tempDir();
	try {
		const verifyPath = path.join(dir, "verify.mjs");
		await writeFile(verifyPath, "setTimeout(() => process.exit(0), 1000);\n", "utf8");
		const result = await runVerify({ verifyPath, outputDir: dir, input: {}, timeoutMs: 20 });

		assert.equal(result.passed, false);
		assert.equal(result.failures[0].actual, "timeout");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("runVerify passes TASK_INPUT to verify.mjs", async () => {
	const dir = tempDir();
	try {
		const outputDir = path.join(dir, "out");
		await mkdir(outputDir);
		const verifyPath = path.join(dir, "verify.mjs");
		await writeFile(verifyPath, `
const input = JSON.parse(process.env.TASK_INPUT);
if (input.name !== "report") process.exit(1);
process.exit(0);
`, "utf8");
		const result = await runVerify({ verifyPath, outputDir, input: { name: "report" } });

		assert.equal(result.passed, true);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
