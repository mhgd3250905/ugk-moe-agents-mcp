import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Shared helpers for reading/writing the agent settings.json.
 *
 * 为什么要单独建这个文件:settings.json 在 Windows 上常因 PowerShell 的
 * Set-Content/Out-File 默认带 UTF-8 BOM (EF BB BF)。Node 的 JSON.parse 遇到
 * BOM 会抛 SyntaxError,而各个 extension 都用裸 JSON.parse 读取,导致配置
 * 静默降级为空对象 {}——shellPath/cdpPort/quietStartup/clearStartupScreen 全
 * 部失效。这里集中做 BOM 剥离,所有调用点统一复用,避免再各处 inline。
 */

/** 可注入的依赖(便于单测,不碰真实文件系统)。 */
export interface SettingsIoDeps {
	agentDir?: string;
	exists?: (filePath: string) => boolean;
	readFile?: (filePath: string) => string;
	writeFile?: (filePath: string, content: string) => void;
	mkdir?: (filePath: string, options: { recursive: true }) => void;
}

/** 剥离开头的 UTF-8 BOM。其余字符不动。 */
export function stripBom(content: string): string {
	return content.replace(/^\uFEFF/, "");
}

/** 解析 agent 目录:`PI_CODING_AGENT_DIR` 优先,否则 `~/.pi/agent`。 */
export function resolveAgentDir(deps: SettingsIoDeps = {}): string {
	return deps.agentDir ?? (process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent"));
}

/** settings.json 的完整路径。 */
export function resolveSettingsPath(deps: SettingsIoDeps = {}): string {
	return path.join(resolveAgentDir(deps), "settings.json");
}

/**
 * BOM-safe 读取并解析 settings.json。
 * - 文件不存在:返回 `{}`
 * - 解析失败(含 BOM 残留、非法 JSON):返回 `undefined`
 * - 解析成功但非对象:返回 `{}`
 *
 * 调用方按需处理 undefined(通常等同降级到默认值)。各处原先的 try/catch
 * 语义保持不变,只是 BOM 不再让解析失败。
 */
export function readSettingsJson(deps: SettingsIoDeps = {}): Record<string, unknown> | undefined {
	const settingsPath = resolveSettingsPath(deps);
	const readFile = deps.readFile ?? ((p: string) => fs.readFileSync(p, "utf8"));
	// exists 可选:未注入时不做存在性预检,直接 readFile(文件不存在会让
	// readFile 抛错进 catch,等价于"不存在返回 {}")。这样既兼容生产(注入真实
	// exists 做精确判断),也兼容只注入 readFile 的单测(原 readShellPathFromSettings
	// 等 helper 就不要求 exists)。
	const exists = deps.exists;
	const fileExists = exists ? exists(settingsPath) : true;
	try {
		if (!fileExists) return {};
		const parsed = JSON.parse(stripBom(readFile(settingsPath)));
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
	} catch {
		return fileExists ? undefined : {};
	}
}

/**
 * BOM-safe 写回 settings.json(读-改-写)。
 * 保留已有字段,只更新传入的键;写入时不带 BOM(2 空格缩进 + 尾随换行,
 * 与 bin/ugk-startup-settings.js 一致)。
 *
 * 文件损坏保护:若文件存在但解析失败(剥离 BOM 后仍是非法 JSON),**不写入**,
 * 避免覆盖损坏的文件。只有文件不存在或解析成功才继续。
 */
export function updateSettingsJson(updates: Record<string, unknown>, deps: SettingsIoDeps = {}): void {
	const settingsPath = resolveSettingsPath(deps);
	const readFile = deps.readFile ?? ((p: string) => fs.readFileSync(p, "utf8"));
	const writeFile = deps.writeFile ?? ((p: string, c: string) => fs.writeFileSync(p, c));
	const mkdir = deps.mkdir ?? ((p: string, o: { recursive: true }) => fs.mkdirSync(p, o));
	// exists 可选(见 readSettingsJson):未注入时假设文件存在,直接 readFile。
	const exists = deps.exists;
	const fileExists = exists ? exists(settingsPath) : true;
	let settings: Record<string, unknown> | undefined = {};
	let parseFailed = false;
	try {
		if (fileExists) {
			const parsed = JSON.parse(stripBom(readFile(settingsPath)));
			settings = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
		}
	} catch {
		// 文件存在但解析失败:标记,后面据此决定是否覆盖。
		parseFailed = fileExists;
		settings = undefined;
	}
	// 文件存在但解析失败(剥离 BOM 后仍非法):不覆盖损坏的文件
	//(与 doctor persistBashResolutionForChildAgents 旧语义一致)。
	if (parseFailed) return;
	if (!settings) return;
	let changed = false;
	for (const [key, value] of Object.entries(updates)) {
		if (!Object.prototype.hasOwnProperty.call(settings, key) || settings[key] !== value) {
			settings[key] = value;
			changed = true;
		}
	}
	if (!changed) return;
	mkdir(path.dirname(settingsPath), { recursive: true });
	writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
}

/**
 * BOM-safe 读取并解析任意 JSON 文件。
 *
 * 与 readSettingsJson 的区别:不做"不存在返回 {}"的静默假设,解析失败/文件
 * 不存在都抛错,由调用方用自己的 try/catch 决定降级语义(auth→false、
 * mcp→errors 列表、taskbook→null 各自不同)。这样改动最小、不破坏现有语义。
 *
 * 用于 auth.json / mcp.json / taskbook JSON 等 pi 管理、但路径不固定的文件。
 */
export function readJsonBomSafe(
	filePath: string,
	deps: { readFile?: (p: string) => string } = {},
): unknown {
	const readFile = deps.readFile ?? ((p: string) => fs.readFileSync(p, "utf8"));
	return JSON.parse(stripBom(readFile(filePath)));
}
