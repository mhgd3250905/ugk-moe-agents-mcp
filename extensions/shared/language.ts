/**
 * 用户语言偏好(跨会话持久化)。
 *
 * 设计:
 * - 持久化在 settings.json 的 `language` 字段(BOM-safe,见 settings-io.ts)。
 * - 自由字符串,不做枚举校验:用户写"中文"/"English"/"日本語"都存原文。
 * - AGENTS.md 默认"优先中文";settings 里设了就以 settings 为准(覆盖默认)。
 * - before_agent_start 注入一句指令,告诉 agent 用什么语言交流。
 *
 * 与 autopilot 的区别:autopilot 是会话内存(临时放飞),language 是持久偏好。
 */

import fs from "node:fs";
import path from "node:path";
import { readSettingsJson, resolveSettingsPath, updateSettingsJson, type SettingsIoDeps } from "./settings-io.ts";

const LANGUAGE_KEY = "language";

/** 读已设语言;未设返回 undefined(此时走 AGENTS.md 默认"优先中文")。 */
export function getLanguage(deps: SettingsIoDeps = {}): string | undefined {
	const settings = readSettingsJson(deps);
	const value = settings?.[LANGUAGE_KEY];
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** 设语言(自由字符串,存 settings.json)。空串/纯空白 = 清除,回到默认。 */
export function setLanguage(language: string, deps: SettingsIoDeps = {}): string | undefined {
	const trimmed = language.trim();
	if (!trimmed) {
		clearLanguage(deps);
		return undefined;
	}
	updateSettingsJson({ [LANGUAGE_KEY]: trimmed }, deps);
	return trimmed;
}

/** 清除语言偏好,回到 AGENTS.md 默认。 */
export function clearLanguage(deps: SettingsIoDeps = {}): void {
	const settings = readSettingsJson(deps);
	if (!settings || !(LANGUAGE_KEY in settings)) return;
	// ponytail: updateSettingsJson 没有删 key 的能力,删语言是低频操作,
	// 不值得给 settings-io 加 delete 参数。这里读-改-删-写整文件。
	delete settings[LANGUAGE_KEY];
	const settingsPath = resolveSettingsPath(deps);
	const writeFile = deps.writeFile ?? ((p: string, c: string) => fs.writeFileSync(p, c));
	const mkdir = deps.mkdir ?? ((p: string, o: { recursive: true }) => fs.mkdirSync(p, o));
	mkdir(path.dirname(settingsPath), { recursive: true });
	writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
}

/**
 * 生成注入 agent system prompt 的语言指令。
 * language 为空时不注入(走 AGENTS.md 默认"优先中文")。
 */
export function buildLanguagePromptSnippet(language: string | undefined): string | undefined {
	if (!language || !language.trim()) return undefined;
	return `[语言偏好] 请优先用「${language.trim()}」与用户交流。代码、命令、标识符不随语言切换。`;
}
