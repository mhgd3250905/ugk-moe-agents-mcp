import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { discoverAgents, type AgentConfig } from "../extensions/subagent-agents.ts";

// ponytail: discoverAgents 此前零测试覆盖。加 install(随包)加载后,冒烟自检:
// ①随包 5 个 agent(scout/planner/reviewer/checker/worker)被加载,标 install
// ②project 同名 agent 覆盖 install(优先级正确)
// ③scope=user 也加载 install(兜底,不依赖 project 目录)
//
// 隔离:本机 ~/.pi/agent/agents/ 可能有同名 user agent 会覆盖 install,导致测不出 install 加载本身。
// 设 PI_CODING_AGENT_DIR 指向空临时目录(getAgentDir 读此环境变量),让 user 目录为空,
// 这样只剩 install(随包)agent 出现,断言才真自检。
function withEmptyAgentDir<T>(fn: () => T): T {
	const tmpAgentDir = fs.mkdtempSync(path.join(os.tmpdir(), "ugk-agent-test-"));
	const old = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = tmpAgentDir;
	try {
		return fn();
	} finally {
		if (old === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = old;
		fs.rmSync(tmpAgentDir, { recursive: true, force: true });
	}
}

test("discoverAgents loads bundled install agents from the package agents/ dir", () => {
	withEmptyAgentDir(() => {
		const { agents } = discoverAgents(process.cwd(), "user");
		const installAgents = agents.filter((a) => a.source === "install");
		const names = installAgents.map((a) => a.name);
		// user 目录空 → 只剩随包 install agent,5 个都得在
		for (const expected of ["scout", "planner", "reviewer", "checker", "worker"]) {
			assert.ok(names.includes(expected), `expected bundled agent ${expected} loaded as install, got: ${JSON.stringify(names)}`);
		}
		// frontmatter 解析正确:scout 带 tools 和 model
		const scout = installAgents.find((a) => a.name === "scout");
		assert.deepEqual(scout?.tools, ["read", "grep", "find", "ls", "bash"]);
		assert.equal(scout?.model, "deepseek-v4-flash");
		assert.ok(scout?.systemPrompt.length > 0, "scout should have a system prompt body");
	});
});

test("discoverAgents loads install agents even in pure user scope (fallback default)", () => {
	withEmptyAgentDir(() => {
		// scope=user 不读 project 目录,但 install(随包)应仍作为兜底默认加载。
		// user 目录空 → 若 install 没加载,agents 列表会为空。
		const { agents } = discoverAgents(process.cwd(), "user");
		assert.ok(agents.length >= 5, `install agents should load as fallback in user scope, got ${agents.length}`);
		assert.ok(agents.every((a) => a.source === "install"), "with empty user dir all agents should be install");
	});
});

test("discoverAgents: project agent overrides install agent of the same name", () => {
	withEmptyAgentDir(() => {
		// user 目录空,在临时 cwd 下造 .pi/agents/ 放同名 agent,断言 project 覆盖 install。
		const tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), "ugk-agent-prio-"));
		const projectDir = path.join(tmpCwd, ".pi", "agents");
		fs.mkdirSync(projectDir, { recursive: true });
		fs.writeFileSync(path.join(projectDir, "scout.md"), "---\nname: scout\ndescription: project override\n---\nproject scout body");
		try {
			const { agents } = discoverAgents(tmpCwd, "both");
			const scout = agents.find((a) => a.name === "scout") as AgentConfig | undefined;
			assert.ok(scout, "scout should be present");
			// project 优先级高于 install → scout 应来自 project
			assert.equal(scout.source, "project", `project scout should override install, got source=${scout.source}`);
			assert.equal(scout.description, "project override");
		} finally {
			fs.rmSync(tmpCwd, { recursive: true, force: true });
		}
	});
});
