import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadExperts, listExpertNames, getExpertsDir } from "../gateway/registry.mjs";

/**
 * registry 发现专家包:扫 <agentDir>/experts/<name>/{agent.json,SKILL.md,verify.mjs}。
 * 用 UGK_AGENT_DIR 指到临时目录,避免污染真实专家。
 */

function makeAgentDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "moe-reg-"));
}

function writeExpert(agentDir: string, name: string, opts: {
	agentJson?: object;
	withSkill?: boolean;
	withVerify?: boolean;
} = {}) {
	const dir = path.join(agentDir, "experts", name);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, "agent.json"), JSON.stringify(opts.agentJson ?? {
		name,
		description: `${name} test expert`,
		version: "1.0.0",
		inputSchema: { type: "object", properties: { msg: { type: "string" } } },
		requiredTools: [],
		artifacts: [],
	}));
	if (opts.withSkill !== false) fs.writeFileSync(path.join(dir, "SKILL.md"), `---\nname: ${name}\n---\n# ${name}`);
	if (opts.withVerify !== false) fs.writeFileSync(path.join(dir, "verify.mjs"), "console.log('PASS');");
	return dir;
}

test("loadExperts returns empty Map when experts dir missing", async () => {
	const agentDir = makeAgentDir();
	process.env.UGK_AGENT_DIR = agentDir;
	try {
		const experts = await loadExperts();
		assert.equal(experts.size, 0);
	} finally {
		delete process.env.UGK_AGENT_DIR;
	}
});

test("loadExperts discovers complete expert packages", async () => {
	const agentDir = makeAgentDir();
	process.env.UGK_AGENT_DIR = agentDir;
	try {
		writeExpert(agentDir, "alpha");
		writeExpert(agentDir, "beta", { agentJson: {
			name: "beta", description: "beta", version: "2.0.0",
			inputSchema: { type: "object" }, requiredTools: ["chrome_cdp"], artifacts: ["out.json"],
		} });
		const experts = await loadExperts();
		assert.equal(experts.size, 2);
		assert.ok(experts.has("alpha"));
		assert.ok(experts.has("beta"));
		const beta = experts.get("beta")!;
		assert.equal(beta.version, "2.0.0");
		assert.deepEqual(beta.requiredTools, ["chrome_cdp"]);
		assert.deepEqual(beta.artifacts, ["out.json"]);
		assert.ok(fs.existsSync(beta.skillPath));
		assert.ok(fs.existsSync(beta.verifyPath));
	} finally {
		delete process.env.UGK_AGENT_DIR;
	}
});

test("loadExperts skips incomplete packages (missing SKILL.md or verify.mjs)", async () => {
	const agentDir = makeAgentDir();
	process.env.UGK_AGENT_DIR = agentDir;
	try {
		writeExpert(agentDir, "complete");
		writeExpert(agentDir, "no-skill", { withSkill: false });
		writeExpert(agentDir, "no-verify", { withVerify: false });
		const experts = await loadExperts();
		assert.equal(experts.size, 1);
		assert.ok(experts.has("complete"));
		assert.ok(!experts.has("no-skill"));
		assert.ok(!experts.has("no-verify"));
	} finally {
		delete process.env.UGK_AGENT_DIR;
	}
});

test("loadExperts skips package with invalid agent.json", async () => {
	const agentDir = makeAgentDir();
	process.env.UGK_AGENT_DIR = agentDir;
	try {
		writeExpert(agentDir, "good");
		// 建一个 agent.json 解析失败的坏包(SKILL.md + verify.mjs 齐全,只是 agent.json 坏)
		const badDir = path.join(agentDir, "experts", "bad");
		fs.mkdirSync(badDir, { recursive: true });
		fs.writeFileSync(path.join(badDir, "agent.json"), "{ not valid json");
		fs.writeFileSync(path.join(badDir, "SKILL.md"), "---\nname: bad\n---\n# bad");
		fs.writeFileSync(path.join(badDir, "verify.mjs"), "console.log('PASS');");
		const experts = await loadExperts();
		assert.equal(experts.size, 1);
		assert.ok(experts.has("good"));
	} finally {
		delete process.env.UGK_AGENT_DIR;
	}
});

test("loadExperts skips package missing name or inputSchema in agent.json", async () => {
	const agentDir = makeAgentDir();
	process.env.UGK_AGENT_DIR = agentDir;
	try {
		writeExpert(agentDir, "good");
		writeExpert(agentDir, "no-name", { agentJson: { description: "x", inputSchema: { type: "object" } } });
		writeExpert(agentDir, "no-schema", { agentJson: { name: "no-schema", description: "x" } });
		const experts = await loadExperts();
		assert.equal(experts.size, 1);
		assert.ok(experts.has("good"));
	} finally {
		delete process.env.UGK_AGENT_DIR;
	}
});

test("listExpertNames returns names array", async () => {
	const agentDir = makeAgentDir();
	process.env.UGK_AGENT_DIR = agentDir;
	try {
		writeExpert(agentDir, "zeta");
		writeExpert(agentDir, "alpha");
		const names = await listExpertNames();
		assert.equal(names.length, 2);
		assert.ok(names.includes("zeta"));
		assert.ok(names.includes("alpha"));
	} finally {
		delete process.env.UGK_AGENT_DIR;
	}
});

test("getExpertsDir respects UGK_AGENT_DIR", () => {
	const tmp = makeAgentDir();
	process.env.UGK_AGENT_DIR = tmp;
	try {
		assert.equal(getExpertsDir(), path.join(tmp, "experts"));
	} finally {
		delete process.env.UGK_AGENT_DIR;
	}
});
