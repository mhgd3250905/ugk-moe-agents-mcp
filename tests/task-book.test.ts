import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
	appendRunToTaskbook,
	deleteTaskbook,
	isRequirementsSpec,
	listTaskbooks,
	loadTaskbook,
	renameTaskbook,
	saveTaskbook,
	taskDir,
	tasksRootUser,
} from "../extensions/task/task-book.ts";

const spec = {
	goal: "生成报告",
	hardConstraints: ["只输出 JSON"],
	acceptance: ["schema 通过"],
	forbidden: [],
	context: "",
};

const contract = {
	outputDir: "<runtime>",
	artifacts: [{ name: "report.json", type: "file", required: true }],
	runtimeInput: ["source"],
	runtimeInputMeta: { source: { type: "string", default: "repo" } },
};

const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
const testAgentDir = mkdtempSync(path.join(os.tmpdir(), "ugk-task-agent-"));
process.env.PI_CODING_AGENT_DIR = testAgentDir;
process.on("exit", () => {
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	rmSync(testAgentDir, { recursive: true, force: true });
});

function tempCwd() {
	return mkdtempSync(path.join(os.tmpdir(), "ugk-task-book-"));
}

function run(timestamp: string, status: "pass" | "fail" = "pass") {
	return {
		timestamp,
		status,
		input: { source: timestamp },
		exitCode: status === "pass" ? 0 : 1,
		verifyFailures: status === "pass" ? [] : [{ assertion: "a", expected: "e", actual: "x" }],
		duration: 1,
	};
}

test("saveTaskbook writes and loadTaskbook reads all five files", async () => {
	const cwd = tempCwd();
	try {
		const taskbook = await saveTaskbook("project", cwd, "report", {
			description: "生成报告",
			spec,
			skill: "# 生成报告\n",
			verify: "process.exit(0);\n",
			contract,
			tags: ["report"],
		});
		const loaded = await loadTaskbook(cwd, "report");

		assert.equal(taskbook.scope, "project");
		assert.equal(loaded?.scope, "project");
		assert.equal(loaded?.taskbook.description, "生成报告");
		assert.deepEqual(loaded?.spec, spec);
		assert.equal(loaded?.skill, "# 生成报告\n");
		assert.equal(loaded?.verify, "process.exit(0);\n");
		assert.deepEqual(loaded?.contract, contract);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("saveTaskbook rejects runtimeInputMeta fields that are not declared", async () => {
	const cwd = tempCwd();
	try {
		await assert.rejects(() => saveTaskbook("project", cwd, "bad-contract", {
			description: "bad",
			spec,
			skill: "# 生成报告\n",
			verify: "process.exit(0);\n",
			contract: {
				runtimeInput: ["source"],
				runtimeInputMeta: { missing: { type: "string", default: "repo" } },
			},
		}), /runtimeInputMeta/);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("project taskbook overrides user taskbook with the same name", async () => {
	const cwd = tempCwd();
	try {
		await saveTaskbook("user", cwd, "same", { description: "user", spec, skill: "u", verify: "u", contract });
		await saveTaskbook("project", cwd, "same", { description: "project", spec, skill: "p", verify: "p", contract });

		const loaded = await loadTaskbook(cwd, "same");
		assert.equal(loaded?.scope, "project");
		assert.equal(loaded?.taskbook.description, "project");
	} finally {
		await deleteTaskbook("user", cwd, "same");
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("listTaskbooks merges scopes, project wins, supports tag filtering and skips broken entries", async () => {
	const cwd = tempCwd();
	try {
		await saveTaskbook("user", cwd, "alpha", { description: "user alpha", spec, skill: "s", verify: "v", contract, tags: ["a"] });
		await saveTaskbook("user", cwd, "shared", { description: "user shared", spec, skill: "s", verify: "v", contract, tags: ["old"] });
		await saveTaskbook("project", cwd, "shared", { description: "project shared", spec, skill: "s", verify: "v", contract, tags: ["p"] });
		await mkdir(path.join(cwd, ".tasks", "broken"), { recursive: true });
		await writeFile(path.join(cwd, ".tasks", "broken", "taskbook.json"), "{", "utf8");

		const all = await listTaskbooks(cwd);
		assert.deepEqual(all.map((item) => `${item.name}:${item.scope}:${item.description}`), [
			"alpha:user:user alpha",
			"shared:project:project shared",
		]);
		assert.deepEqual((await listTaskbooks(cwd, "p")).map((item) => item.name), ["shared"]);
	} finally {
		await deleteTaskbook("user", cwd, "alpha");
		await deleteTaskbook("user", cwd, "shared");
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("appendRunToTaskbook keeps only the newest 10 runs", async () => {
	const cwd = tempCwd();
	try {
		await saveTaskbook("project", cwd, "runs", { description: "runs", spec, skill: "s", verify: "v", contract });
		for (let index = 0; index < 12; index += 1) {
			await appendRunToTaskbook("project", cwd, "runs", run(`2026-06-22T00:00:${String(index).padStart(2, "0")}.000Z`));
		}

		const loaded = await loadTaskbook(cwd, "runs");
		assert.equal(loaded?.taskbook.runs.length, 10);
		assert.equal(loaded?.taskbook.runs[0].timestamp, "2026-06-22T00:00:02.000Z");
		assert.equal(loaded?.taskbook.runs.at(-1)?.timestamp, "2026-06-22T00:00:11.000Z");
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("renameTaskbook renames the directory and taskbook name without dropping history", async () => {
	const cwd = tempCwd();
	try {
		await saveTaskbook("project", cwd, "old-name", { description: "old", spec, skill: "s", verify: "v", contract });
		const before = await appendRunToTaskbook("project", cwd, "old-name", run("2026-06-24T00:00:00.000Z"));

		const renamed = await renameTaskbook("project", cwd, "old-name", "new-name");

		assert.equal(existsSync(taskDir("project", cwd, "old-name")), false);
		assert.equal(existsSync(taskDir("project", cwd, "new-name")), true);
		assert.equal(renamed.name, "new-name");
		assert.equal((await loadTaskbook(cwd, "new-name"))?.taskbook.name, "new-name");
		assert.equal((await loadTaskbook(cwd, "new-name"))?.taskbook.createdAt, before.createdAt);
		assert.equal((await loadTaskbook(cwd, "new-name"))?.taskbook.runs.length, 1);
		assert.equal(await loadTaskbook(cwd, "old-name"), null);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("renameTaskbook rejects existing, invalid, and unchanged names", async () => {
	const cwd = tempCwd();
	try {
		await saveTaskbook("project", cwd, "one", { description: "one", spec, skill: "s", verify: "v", contract });
		await saveTaskbook("project", cwd, "two", { description: "two", spec, skill: "s", verify: "v", contract });

		await assert.rejects(() => renameTaskbook("project", cwd, "one", "two"), /已存在/);
		await assert.rejects(() => renameTaskbook("project", cwd, "one", "bad/name"), /Invalid taskbook name/);
		await assert.rejects(() => renameTaskbook("project", cwd, "one", "one"), /相同/);
		assert.equal((await loadTaskbook(cwd, "one"))?.taskbook.name, "one");
		assert.equal((await loadTaskbook(cwd, "two"))?.taskbook.name, "two");
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("loadTaskbook reports corrupt project taskbooks and invalid names", async () => {
	const cwd = tempCwd();
	try {
		await mkdir(taskDir("project", cwd, "bad"), { recursive: true });
		await writeFile(path.join(taskDir("project", cwd, "bad"), "taskbook.json"), "{}", "utf8");

		await assert.rejects(() => loadTaskbook(cwd, "bad"), /Invalid taskbook|ENOENT/);
		await assert.rejects(() => loadTaskbook(cwd, "../bad"), /Invalid taskbook name/);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("deleteTaskbook removes the selected scope only", async () => {
	const cwd = tempCwd();
	try {
		await saveTaskbook("project", cwd, "gone", { description: "gone", spec, skill: "s", verify: "v", contract });
		await deleteTaskbook("project", cwd, "gone");
		assert.equal(existsSync(taskDir("project", cwd, "gone")), false);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("task-book exposes user root and spec guard", () => {
	assert.equal(tasksRootUser(), path.join(testAgentDir, "tasks"));
	assert.equal(isRequirementsSpec(spec), true);
	assert.equal(isRequirementsSpec({ goal: "missing arrays" }), false);
});

// 并发 append 回归测试: run_task parallel 多 worker 同时调 appendRunToTaskbook。
// 修复前是 read-modify-write 无锁并发 → 末尾多出 `}` 写坏 JSON(见 taskbook.json 实测),
// 且各 worker 的 run 互相覆盖丢失。本测试同时守这两条:文件不坏 + run 不丢。
test("appendRunToTaskbook is safe under concurrent appends (parallel run_task regression)", async () => {
	const cwd = tempCwd();
	try {
		await saveTaskbook("project", cwd, "concurrent", { description: "concurrent", spec, skill: "s", verify: "v", contract });
		// N=8: 低于 sortAndTrimRuns 的 10 条上限,断言"全部保留"才成立
		const N = 8;
		const starts = Array.from({ length: N }, (_, i) =>
			appendRunToTaskbook("project", cwd, "concurrent", run(`2026-06-22T00:00:${String(i).padStart(2, "0")}.000Z`, i % 2 === 0 ? "pass" : "fail")));
		await Promise.all(starts);

		// 1) 文件必须仍是合法 JSON(修复前会写坏,loadTaskbook 直接抛 JSON parse error)
		const loaded = await loadTaskbook(cwd, "concurrent");
		assert.ok(loaded, "taskbook should still load after concurrent appends");
		// 2) 所有 N 条 run 都必须保留(修复前 read-modify-write 互相覆盖,只剩最后写的 1 条)
		assert.equal(loaded?.taskbook.runs.length, N, "no run lost to concurrent append");
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});
