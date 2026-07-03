/**
 * requirements.mjs — 专家权限声明、检查、应用、注入。
 *
 * 三类权限(专家在 agent.json 声明):
 *   requiredTools     — 受保护工具(如 chrome_cdp)。需要用户"同意"(consent)。
 *                       安全约束:consent 只能由 CLI doctor 写,MCP doctor tool 拒绝。
 *   requiredEnv       — 环境变量(如 API key)。doctor 可写进 config.json。
 *   requiredBinaries  — 系统可执行文件(如 yt-dlp)。只检查存在性,不"同意"。
 *
 * 状态持久化:每个专家包目录下 config.json(用户私有,doctor 写入,runner 读取):
 *   { consents: { chrome_cdp: true }, env: { KEY: "..." }, configuredAt: "ISO" }
 *
 * 三用:
 *   - CLI doctor(gateway/doctor.mjs)调 checkRequirements + applyConfig
 *   - MCP doctor tool 调 checkRequirements + applyConfig(env only)
 *   - runner.mjs 调 checkRequirements(预检) + getEffectiveEnv(spawn 注入)
 */

import fs from "node:fs";
import path from "node:path";

/** config.json 文件名(在每个专家包目录下) */
const CONFIG_FILENAME = "config.json";

/**
 * consent 类工具白名单:只有这里列的受保护工具才接受 consent。
 * 防止专家包声明任意名字骗 consent。
 */
const CONSENTABLE_TOOLS = new Set(["chrome_cdp"]);

/**
 * @typedef {Object} Requirement
 * @property {"consent"|"env"|"binary"} type
 * @property {string} name
 * @property {boolean} satisfied   — 当前是否满足
 * @property {string} howToFix     — 给 agent/用户看的具体修复指令
 */

/**
 * @typedef {Object} ExpertConfig
 * @property {Record<string, boolean>} [consents]
 * @property {Record<string, string>} [env]
 * @property {string} [configuredAt]
 */

/**
 * 读专家包的 config.json。不存在返回 null。
 * @param {import("./registry.mjs").ExpertPackage} pkg
 * @returns {ExpertConfig | null}
 */
export function loadConfig(pkg) {
	const configPath = path.join(pkg.dir, CONFIG_FILENAME);
	try {
		return JSON.parse(fs.readFileSync(configPath, "utf8"));
	} catch {
		return null;
	}
}

/**
 * 写专家包的 config.json。
 * @param {import("./registry.mjs").ExpertPackage} pkg
 * @param {ExpertConfig} config
 */
export function saveConfig(pkg, config) {
	const configPath = path.join(pkg.dir, CONFIG_FILENAME);
	fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf8");
}

/**
 * 最小 binary 探测(不依赖 TS 文件,纯 fs + PATH)。
 * @param {string} command
 * @returns {boolean}
 */
function isBinaryAvailable(command) {
	const pathValue = process.env.PATH ?? "";
	const exts = process.platform === "win32"
		? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean)
		: [""];
	for (const dir of pathValue.split(path.delimiter).filter(Boolean)) {
		for (const ext of exts) {
			const lowerCmd = command.toLowerCase();
			const candidate = path.join(dir, lowerCmd.endsWith(ext.toLowerCase()) ? command : `${command}${ext}`);
			try {
				if (fs.existsSync(candidate)) return true;
			} catch {
				// 不可读的 PATH 条目跳过
			}
		}
	}
	return false;
}

/**
 * 检查某专家的所有权限声明,返回每项状态 + 缺失清单。
 * @param {import("./registry.mjs").ExpertPackage} pkg
 * @returns {Promise<{requirements: Requirement[], missing: Requirement[]}>}
 *  missing 是 requirements 中 satisfied=false 的子集
 */
export async function checkRequirements(pkg) {
	const config = loadConfig(pkg) || { consents: {}, env: {} };
	const consents = config.consents || {};
	const configEnv = config.env || {};

	/** @type {Requirement[]} */
	const requirements = [];

	// 1. requiredTools(consent 类)
	for (const tool of pkg.requiredTools || []) {
		const ok = CONSENTABLE_TOOLS.has(tool) ? consents[tool] === true : true;
		requirements.push({
			type: "consent",
			name: tool,
			satisfied: ok,
			howToFix: ok ? "" : `需要同意控制 ${tool}。运行 \`node gateway/doctor.mjs\` 在 CLI 中同意(consent 只能由用户在命令行授予,MCP 无法代写)`,
		});
	}

	// 2. requiredEnv
	for (const envName of pkg.requiredEnv || []) {
		// 优先 config.json 的 env,其次进程环境变量
		const hasIt = Boolean(configEnv[envName] || process.env[envName]);
		requirements.push({
			type: "env",
			name: envName,
			satisfied: hasIt,
			howToFix: hasIt ? "" : `配置 ${envName}(调 MCP doctor tool 带 action:"apply" + env:{${envName}:"值"},或设环境变量,或跑 CLI doctor)`,
		});
	}

	// 3. requiredBinaries
	for (const bin of pkg.requiredBinaries || []) {
		const ok = isBinaryAvailable(bin);
		requirements.push({
			type: "binary",
			name: bin,
			satisfied: ok,
			howToFix: ok ? "" : `安装 ${bin}(用 bash/apt/pip/brew 等,具体看工具文档)`,
		});
	}

	const missing = requirements.filter((r) => !r.satisfied);
	return { requirements, missing };
}

/**
 * 应用配置更新(合并写回 config.json)。
 * 注意:MCP doctor tool 调用时,consents 参数会被拒绝(安全约束)。
 *
 * @param {import("./registry.mjs").ExpertPackage} pkg
 * @param {{consents?: Record<string, boolean>, env?: Record<string, string>}} updates
 * @param {{allowConsent?: boolean}} [opts]  allowConsent=false 时 consents 被拒绝
 * @returns {ExpertConfig} 更新后的 config
 */
export function applyConfig(pkg, updates, opts = {}) {
	const config = loadConfig(pkg) || { consents: {}, env: {} };
	if (!config.consents) config.consents = {};
	if (!config.env) config.env = {};

	// consent 类:只在 allowConsent=true 时接受(CLI doctor 传 true,MCP tool 不传)
	if (updates.consents && opts.allowConsent) {
		for (const [k, v] of Object.entries(updates.consents)) {
			if (CONSENTABLE_TOOLS.has(k)) {
				config.consents[k] = Boolean(v);
			}
			// 非 consentable 的 tool 名忽略(防注入)
		}
	}

	if (updates.env) {
		for (const [k, v] of Object.entries(updates.env)) {
			if (typeof v === "string" && v.length > 0) {
				config.env[k] = v;
			}
		}
	}

	config.configuredAt = new Date().toISOString();
	saveConfig(pkg, config);
	return config;
}

/**
 * runner 用:算出专家实例该注入的 env(含 consent 授权信号 + 配置的 API key)。
 * @param {import("./registry.mjs").ExpertPackage} pkg
 * @returns {Record<string, string>}
 */
export function getEffectiveEnv(pkg) {
	const config = loadConfig(pkg) || { consents: {}, env: {} };
	const consents = config.consents || {};
	const configEnv = config.env || {};

	/** @type {Record<string, string>} */
	const env = {};

	// consent → 授权信号(chrome_cdp 同意了才注入 UGK_TASK_ALLOW_CHROME_CDP)
	// 修复之前的漏洞:不再无条件注入,只在 config.json 明确同意时才给
	if (consents.chrome_cdp === true) {
		env.UGK_TASK_ALLOW_CHROME_CDP = "1";
	}

	// requiredEnv:优先 config.json,次选进程环境(已在 runner 的 ...process.env 透传)
	// 这里显式注入 config.json 的值,覆盖进程环境(让用户 doctor 配的优先)
	for (const envName of pkg.requiredEnv || []) {
		if (configEnv[envName]) {
			env[envName] = configEnv[envName];
		}
	}

	// MCP 工具授权:声明了 server__tool 形态的,透传(consent 模型暂只覆盖 chrome_cdp,
	// 未来可扩展,这里保留对 __ 格式的兼容)
	const mcpTools = (pkg.requiredTools || []).filter((t) => t.includes("__") && consents[t] === true);
	if (mcpTools.length) {
		env.UGK_TASK_ALLOW_MCP_TOOLS = mcpTools.join(",");
	}

	return env;
}

/**
 * 缺权限时,生成 MCP CallToolResult 的结构化错误体。
 * @param {Requirement[]} missing
 * @returns {{isError: true, status: string, missing: Requirement[]}}
 */
export function missingRequirementsError(missing) {
	return {
		isError: true,
		status: "missing_requirements",
		missing: missing.map((r) => ({
			type: r.type,
			name: r.name,
			howToFix: r.howToFix,
		})),
	};
}

export { CONSENTABLE_TOOLS };
