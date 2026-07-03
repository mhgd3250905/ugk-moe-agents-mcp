/**
 * registry.mjs — 专家包发现与加载。
 *
 * 专家包装在 <agentDir>/experts/<name>/,每个含:
 *   agent.json   — 元数据(MCP 暴露信息 + inputSchema + 工具声明)
 *   SKILL.md     — 标准 skill(skill-creator 规范)
 *   scripts/     — 跟随 skill 的脚本(可选)
 *   verify.mjs   — 验收方案(VerifyFailure[] 契约)
 *
 * agentDir 默认 ~/.pi/agent(与 ugk 一致),可用 UGK_AGENT_DIR 覆盖。
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

/**
 * @typedef {Object} ExpertPackage
 * @property {string} name           — 专家名(目录名)
 * @property {string} description    — 专家用途
 * @property {string} version
 * @property {object} inputSchema    — 标准 JSON Schema(顶层 type:object)
 * @property {string[]} [requiredTools] — 受保护工具声明(如 ["chrome_cdp"])
 * @property {string[]} [artifacts]    — 产物文件名(如 ["x_search_results.json"])
 * @property {string} skillPath      — SKILL.md 绝对路径
 * @property {string} verifyPath     — verify.mjs 绝对路径
 * @property {string} dir            — 专家包目录绝对路径
 */

/** @returns {string} */
export function getAgentDir() {
	return process.env.UGK_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
}

/** @returns {string} */
export function getExpertsDir() {
	return path.join(getAgentDir(), "experts");
}

/**
 * 扫描所有已安装的专家包。
 * @returns {Promise<Map<string, ExpertPackage>>} name → package
 */
export async function loadExperts() {
	const expertsDir = getExpertsDir();
	/** @type {Map<string, ExpertPackage>} */
	const experts = new Map();
	let entries;
	try {
		entries = fs.readdirSync(expertsDir, { withFileTypes: true });
	} catch {
		// experts 目录不存在 → 无专家
		return experts;
	}
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const dir = path.join(expertsDir, entry.name);
		const agentJsonPath = path.join(dir, "agent.json");
		const skillPath = path.join(dir, "SKILL.md");
		const verifyPath = path.join(dir, "verify.mjs");
		if (!fs.existsSync(agentJsonPath) || !fs.existsSync(skillPath) || !fs.existsSync(verifyPath)) {
			continue; // 不完整的包跳过
		}
		try {
			const meta = JSON.parse(fs.readFileSync(agentJsonPath, "utf8"));
			if (!meta.name || !meta.inputSchema) continue;
			experts.set(meta.name, {
				name: meta.name,
				description: meta.description || "",
				version: meta.version || "0.0.0",
				inputSchema: meta.inputSchema,
				requiredTools: meta.requiredTools || [],
				artifacts: meta.artifacts || [],
				skillPath,
				verifyPath,
				dir,
			});
		} catch {
			// agent.json 解析失败 → 跳过这个包
		}
	}
	return experts;
}

/**
 * 取专家名列表(用于 MCP tool 的 expert enum)。
 * @returns {Promise<string[]>}
 */
export async function listExpertNames() {
	const experts = await loadExperts();
	return [...experts.keys()];
}
