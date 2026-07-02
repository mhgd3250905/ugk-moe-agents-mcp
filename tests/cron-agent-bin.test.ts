import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { getCronAgentBin } from "../cron/agent-bin.ts";

test("getCronAgentBin prefers ugk when it is available", () => {
	const calls: string[] = [];

	assert.equal(
		getCronAgentBin({
			execSync(command) {
				calls.push(command);
			},
		}),
		"ugk",
	);
	assert.deepEqual(calls, ["ugk --version"]);
});

test("getCronAgentBin falls back to node + bundled bin/ugk.js when ugk is unavailable", () => {
	// ponytail: 克隆用户 PATH 上既无 ugk 也无 pi,回退 pi 会 ENOENT。
	// 应改为 node + 随包 bin/ugk.js 绝对路径(经 shell 执行)。
	const result = getCronAgentBin({
		execSync() {
			throw new Error("missing");
		},
	});
	// 形态:被引号包裹的 "node绝对路径" "bin/ugk.js绝对路径"
	assert.match(result, /node(\.exe)?"/, `should be a node invocation, got: ${result}`);
	assert.match(result, /bin[\\/]ugk\.js"/, `should reference bundled bin/ugk.js, got: ${result}`);
	// 不应再回退 pi
	assert.equal(result === "pi", false, "must not fall back to bare pi");
});

// ponytail: 非平凡逻辑必须留 check。fallback 返回的带引号 node 命令经 shell 执行,
// 只有真实 spawn 才能验证(空格路径/Windows cmd/引号包裹)。强制走 fallback(ugk 不可用),
// 真实 spawn 它跑 --version,确认克隆用户的 cron 到点能起 agent 子进程。
test("getCronAgentBin fallback command actually spawns and runs", () => {
	const command = getCronAgentBin({
		execSync() {
			throw new Error("ugk not on PATH (clone scenario)");
		},
	});
	// 用 shell 执行完整命令(和 service.ts 的 spawn 一致),跑 --version
	const result = spawnSync(command, ["--version"], { shell: true, encoding: "utf8", timeout: 30000 });
	assert.equal(result.status, 0, `fallback command should run ugk --version successfully; stderr: ${result.stderr ?? ""}`);
	// ugk --version 输出版本号
	assert.match(result.stdout, /\d+\.\d+\.\d+/, `expected a version string, got: ${JSON.stringify(result.stdout)}`);
});
