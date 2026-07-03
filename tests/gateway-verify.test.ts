import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runVerify } from "../gateway/verify.mjs";

/**
 * runVerify 是专家 agent 的结果闸门:spawn verify 脚本,判定 PASS/FAIL。
 * 这组测试覆盖核心契约:exit 0=PASS、VerifyFailure[] 解析、malformed 兜底、超时。
 */

function makeTmpDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "moe-verify-"));
}

function writeVerifyScript(dir: string, body: string): string {
	const p = path.join(dir, "verify.mjs");
	fs.writeFileSync(p, body);
	return p;
}

test("runVerify returns pass for exit 0", async () => {
	const dir = makeTmpDir();
	const verifyPath = writeVerifyScript(dir, "console.log('PASS');");
	const result = await runVerify({ verifyPath, outputDir: dir, input: {} });
	assert.equal(result.passed, true);
	assert.deepEqual(result.failures, []);
	assert.equal(result.exitCode, 0);
});

test("runVerify parses structured VerifyFailure[] on FAIL", async () => {
	const dir = makeTmpDir();
	const verifyPath = writeVerifyScript(dir, `
		console.log(JSON.stringify([
			{ assertion: "file exists", expected: "output.json", actual: "missing", hint: "worker must write" }
		]));
		process.exit(1);
	`);
	const result = await runVerify({ verifyPath, outputDir: dir, input: {} });
	assert.equal(result.passed, false);
	assert.equal(result.failures.length, 1);
	assert.equal(result.failures[0].assertion, "file exists");
	assert.equal(result.failures[0].expected, "output.json");
	assert.equal(result.failures[0].actual, "missing");
	assert.equal(result.failures[0].hint, "worker must write");
});

test("runVerify wraps malformed failure output into a single failure", async () => {
	const dir = makeTmpDir();
	// 非 JSON 输出 → 兜底成一条结构化 failure
	const verifyPath = writeVerifyScript(dir, "console.log('not json at all'); process.exit(1);");
	const result = await runVerify({ verifyPath, outputDir: dir, input: {} });
	assert.equal(result.passed, false);
	assert.equal(result.failures.length, 1);
	assert.equal(result.failures[0].assertion, "verify 输出结构化失败");
});

test("runVerify rejects failure array missing required string fields", async () => {
	const dir = makeTmpDir();
	// assertion 是 number 不是 string → normalizeFailures 返回 undefined → 兜底
	const verifyPath = writeVerifyScript(dir, `
		console.log(JSON.stringify([{ assertion: 123, expected: "x", actual: "y" }]));
		process.exit(1);
	`);
	const result = await runVerify({ verifyPath, outputDir: dir, input: {} });
	assert.equal(result.passed, false);
	assert.equal(result.failures.length, 1);
	assert.equal(result.failures[0].assertion, "verify 输出结构化失败");
});

test("runVerify times out slow scripts", async () => {
	const dir = makeTmpDir();
	const verifyPath = writeVerifyScript(dir, "setTimeout(() => {}, 10000);");
	const result = await runVerify({ verifyPath, outputDir: dir, input: {}, timeoutMs: 200 });
	assert.equal(result.passed, false);
	assert.equal(result.failures[0].actual, "timeout");
});

test("runVerify passes TASK_INPUT and TASK_OUTPUT_DIR to verify script env", async () => {
	const dir = makeTmpDir();
	// verify 读 env 验证注入
	const verifyPath = writeVerifyScript(dir, `
		const input = JSON.parse(process.env.TASK_INPUT || '{}');
		if (input.keyword !== 'test') { console.log(JSON.stringify([{assertion:'keyword',expected:'test',actual:input.keyword}])); process.exit(1); }
		if (!process.env.TASK_OUTPUT_DIR) { console.log(JSON.stringify([{assertion:'outputDir set',expected:'non-empty',actual:'missing'}])); process.exit(1); }
		console.log('PASS');
	`);
	const result = await runVerify({ verifyPath, outputDir: dir, input: { keyword: "test" } });
	assert.equal(result.passed, true);
});

test("runVerify passes optional TASK_DIR when provided", async () => {
	const dir = makeTmpDir();
	const verifyPath = writeVerifyScript(dir, `
		if (process.env.TASK_DIR !== '${dir.replace(/\\/g, "\\\\")}') {
			console.log(JSON.stringify([{assertion:'TASK_DIR',expected:'${dir.replace(/\\/g,"\\\\")}',actual:process.env.TASK_DIR||'unset'}]));
			process.exit(1);
		}
		console.log('PASS');
	`);
	const result = await runVerify({ verifyPath, outputDir: dir, input: {}, taskDir: dir });
	assert.equal(result.passed, true);
});
