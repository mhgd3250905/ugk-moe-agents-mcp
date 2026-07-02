import * as fs from "node:fs";
import * as path from "node:path";
import { homedir } from "node:os";
import { stripBom } from "./shared/settings-io.ts";
import { uiText } from "./shared/ui-language.ts";

export interface DeepSeekStatusDeps {
	env?: Record<string, string | undefined>;
	authPath?: string;
	readFile?: (filePath: string) => string;
}

function getAuthPath(env: Record<string, string | undefined>, authPath?: string): string {
	if (authPath) return authPath;
	const configDir = env.PI_CODING_AGENT_DIR || path.join(homedir(), ".pi", "agent");
	return path.join(configDir, "auth.json");
}

function hasDeepSeekAuth(rawAuth: string): boolean {
	try {
		// BOM-safe:auth.json 可能被 PowerShell 重写带 UTF-8 BOM,裸 parse 会抛错
		// 静默返回 false,误报 deepseek 未配置。
		const auth = JSON.parse(stripBom(rawAuth));
		return Boolean(auth?.deepseek);
	} catch {
		return false;
	}
}

export function getDeepSeekStatus(deps: DeepSeekStatusDeps = {}): string {
	const env = deps.env ?? process.env;
	if (env.DEEPSEEK_API_KEY) {
		return uiText("deepseek: 已配置(DEEPSEEK_API_KEY, deepseek-chat/默认模型可用)", "deepseek: configured(DEEPSEEK_API_KEY, deepseek-chat/default model available)");
	}

	const readFile = deps.readFile ?? ((filePath: string) => fs.readFileSync(filePath, "utf8"));
	try {
		if (hasDeepSeekAuth(readFile(getAuthPath(env, deps.authPath)))) {
			return uiText("deepseek: 已配置(pi login/auth.json, deepseek-chat/默认模型可用)", "deepseek: configured(pi login/auth.json, deepseek-chat/default model available)");
		}
	} catch {
		// Missing or unreadable auth.json means DeepSeek is not configured through pi login.
	}

	return uiText("deepseek: 未配置(设 DEEPSEEK_API_KEY 或运行 /login 启用)", "deepseek: not configured(set DEEPSEEK_API_KEY or run /login)");
}
