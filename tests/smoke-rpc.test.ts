import test from "node:test";
import assert from "node:assert/strict";
import { buildReport, chooseDriver, hasCrashText, parseDriver } from "../scripts/smoke-rpc.mjs";

test("smoke report marks failed scenarios and crash text", () => {
	const scenarios = [
		{ name: "startup", ok: true },
		{ name: "doctor", ok: false, detail: "timeout" },
	];
	const report = buildReport(scenarios, { exitCode: 1, timedOut: false, stderr: "TypeError: stale ctx" });

	assert.equal(hasCrashText("TypeError: stale ctx"), true);
	assert.match(report, /^# UGK RPC Smoke Report/);
	assert.match(report, /- ✅ startup/);
	assert.match(report, /- ❌ doctor — timeout/);
	assert.match(report, /Crash text: detected/);
	assert.match(report, /Exit code: 1/);
});

test("smoke driver selection is explicitly RPC-only", () => {
	assert.equal(parseDriver([]), "auto");
	assert.equal(parseDriver(["--driver=rpc"]), "rpc");

	assert.throws(() => parseDriver(["--driver", "tui"]), /Unsupported smoke driver/);
	assert.equal(chooseDriver("auto", { hasNodePty: true }), "rpc");
	assert.equal(chooseDriver("auto", { hasNodePty: false }), "rpc");
});
