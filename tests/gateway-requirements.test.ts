import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkRequirements, applyConfig, getEffectiveEnv, loadConfig, CONSENTABLE_TOOLS } from "../gateway/requirements.mjs";

/**
 * 权限逻辑测试。重点覆盖安全约束:
 *  - consent 类(chrome_cdp)只在 allowConsent=true 时写入
 *  - getEffectiveEnv 只在 consent=true 时注入授权信号(漏洞修复验证)
 *  - 缺权限时 checkRequirements 返回 missing 清单
 */

/**
 * @param {object} [overrides]
 * @returns {import("../gateway/requirements.mjs").ExpertPackage & {dir: string}}
 */
function makePkg(overrides = {}) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "moe-req-"));
	const pkg = {
		name: "test-expert",
		description: "test",
		version: "1.0.0",
		inputSchema: { type: "object" },
		requiredTools: [],
		requiredEnv: [],
		requiredBinaries: [],
		artifacts: [],
		skillPath: path.join(dir, "SKILL.md"),
		verifyPath: path.join(dir, "verify.mjs"),
		dir,
		...overrides,
	};
	return pkg;
}

test("checkRequirements returns empty missing when nothing required", async () => {
	const pkg = makePkg();
	const { requirements, missing } = await checkRequirements(pkg);
	assert.equal(requirements.length, 0);
	assert.equal(missing.length, 0);
});

test("checkRequirements detects missing consent for chrome_cdp", async () => {
	const pkg = makePkg({ requiredTools: ["chrome_cdp"] });
	const { missing } = await checkRequirements(pkg);
	assert.equal(missing.length, 1);
	assert.equal(missing[0].type, "consent");
	assert.equal(missing[0].name, "chrome_cdp");
	assert.match(missing[0].howToFix, /doctor/);
});

test("checkRequirements detects missing env (not in config.json or process.env)", async () => {
	const uniqueKey = "MOE_TEST_KEY_" + Date.now();
	const pkg = makePkg({ requiredEnv: [uniqueKey] });
	const { missing } = await checkRequirements(pkg);
	assert.equal(missing.length, 1);
	assert.equal(missing[0].type, "env");
	assert.equal(missing[0].name, uniqueKey);
});

test("checkRequirements satisfied when env in process.env", async () => {
	const uniqueKey = "MOE_TEST_ENV_OK_" + Date.now();
	process.env[uniqueKey] = "value";
	try {
		const pkg = makePkg({ requiredEnv: [uniqueKey] });
		const { missing } = await checkRequirements(pkg);
		assert.equal(missing.length, 0);
	} finally {
		delete process.env[uniqueKey];
	}
});

test("checkRequirements satisfied when env in config.json", async () => {
	const pkg = makePkg({ requiredEnv: ["MOE_CFG_KEY"] });
	applyConfig(pkg, { env: { MOE_CFG_KEY: "from-config" } }, { allowConsent: false });
	const { missing } = await checkRequirements(pkg);
	assert.equal(missing.length, 0);
});

test("checkRequirements detects missing binary", async () => {
	const pkg = makePkg({ requiredBinaries: ["definitely-not-a-real-binary-xyz123"] });
	const { missing } = await checkRequirements(pkg);
	assert.equal(missing.length, 1);
	assert.equal(missing[0].type, "binary");
	assert.equal(missing[0].name, "definitely-not-a-real-binary-xyz123");
});

test("checkRequirements satisfied when binary exists", async () => {
	const pkg = makePkg({ requiredBinaries: ["node"] });
	const { missing } = await checkRequirements(pkg);
	assert.equal(missing.length, 0);
});

// === 安全约束:consent 类 ===

test("applyConfig writes consent when allowConsent=true (CLI doctor)", () => {
	const pkg = makePkg({ requiredTools: ["chrome_cdp"] });
	applyConfig(pkg, { consents: { chrome_cdp: true } }, { allowConsent: true });
	const cfg = loadConfig(pkg);
	assert.equal(cfg?.consents?.chrome_cdp, true);
});

test("applyConfig REJECTS consent when allowConsent=false (MCP tool)", () => {
	const pkg = makePkg({ requiredTools: ["chrome_cdp"] });
	applyConfig(pkg, { consents: { chrome_cdp: true } }, { allowConsent: false });
	const cfg = loadConfig(pkg);
	// consent 没写进去
	assert.equal(cfg?.consents?.chrome_cdp, undefined);
});

test("applyConfig REJECTS consent when allowConsent omitted (MCP tool default)", () => {
	const pkg = makePkg({ requiredTools: ["chrome_cdp"] });
	applyConfig(pkg, { consents: { chrome_cdp: true } });
	const cfg = loadConfig(pkg);
	assert.equal(cfg?.consents?.chrome_cdp, undefined);
});

test("applyConfig still writes env when allowConsent=false (MCP can configure API keys)", () => {
	const pkg = makePkg();
	applyConfig(pkg, { env: { SOME_API_KEY: "sk-xxx" } }, { allowConsent: false });
	const cfg = loadConfig(pkg);
	assert.equal(cfg?.env?.SOME_API_KEY, "sk-xxx");
});

test("applyConfig ignores unknown consent tool names (prevent injection)", () => {
	const pkg = makePkg();
	// "arbitrary-tool" 不在 CONSENTABLE_TOOLS 里,即使 allowConsent=true 也该被忽略
	applyConfig(pkg, { consents: { "arbitrary-tool": true } }, { allowConsent: true });
	const cfg = loadConfig(pkg);
	assert.equal(cfg?.consents?.["arbitrary-tool"], undefined);
});

// === 漏洞修复验证:getEffectiveEnv ===

test("getEffectiveEnv does NOT inject UGK_TASK_ALLOW_CHROME_CDP without consent (bug fix)", () => {
	const pkg = makePkg({ requiredTools: ["chrome_cdp"] });
	// 没 consent
	const env = getEffectiveEnv(pkg);
	assert.equal(env.UGK_TASK_ALLOW_CHROME_CDP, undefined);
});

test("getEffectiveEnv injects UGK_TASK_ALLOW_CHROME_CDP only after consent", () => {
	const pkg = makePkg({ requiredTools: ["chrome_cdp"] });
	applyConfig(pkg, { consents: { chrome_cdp: true } }, { allowConsent: true });
	const env = getEffectiveEnv(pkg);
	assert.equal(env.UGK_TASK_ALLOW_CHROME_CDP, "1");
});

test("getEffectiveEnv injects requiredEnv from config.json", () => {
	const pkg = makePkg({ requiredEnv: ["MY_KEY"] });
	applyConfig(pkg, { env: { MY_KEY: "cfg-val" } }, { allowConsent: false });
	const env = getEffectiveEnv(pkg);
	assert.equal(env.MY_KEY, "cfg-val");
});

test("CONSENTABLE_TOOLS contains chrome_cdp", () => {
	assert.ok(CONSENTABLE_TOOLS.has("chrome_cdp"));
});
