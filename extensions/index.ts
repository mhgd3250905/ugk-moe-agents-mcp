/**
 * ugk-pi-agent extension
 *
 * 复用官方示例模式(不造轮子):
 *  - 自定义工具:  packages/coding-agent/examples/extensions/hello.ts
 *  - 权限门:      packages/coding-agent/examples/extensions/permission-gate.ts
 *  - slash 命令:  packages/coding-agent/docs/extensions.md (registerCommand)
 *
 * 注:DeepSeek 由 pi 0.79+ 原生支持,设环境变量 DEEPSEEK_API_KEY 即可,
 *     /login 菜单可选 deepseek,模型 deepseek-chat / deepseek-reasoner。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AutocompleteProvider } from "@earendil-works/pi-tui";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import registerBuiltinToolRenderers from "./builtin-tool-render.ts";
import registerSubagent from "./subagent.ts";
import registerSubagentCommand from "./subagent-command.ts";
import { discoverAgents } from "./subagent-agents.ts";
import registerUiStatusline from "./ui-statusline.ts";
import registerUgkBrandUi from "./ui-brand.ts";
import registerCron from "./cron.ts";
import registerPlanMode from "./plan-mode.ts";
import registerTask from "./task/task.ts";
import registerQuestionnaire from "./questionnaire.ts";
import registerChromeCdp from "./chrome-cdp/index.ts";
import registerDoctor from "./doctor/index.ts";
import registerMcp from "./mcp/index.ts";
import { registerUgkUpdate } from "./update-check.ts";
import { getDeepSeekStatus } from "./deepseek-status.ts";
import { renderTerminalTable } from "./terminal-table.ts";
import { AUTOPILOT_PROMPT_SNIPPET, isAutopilotOn, setAutopilot } from "./shared/autopilot.ts";
import { buildLanguagePromptSnippet, clearLanguage, getLanguage, setLanguage } from "./shared/language.ts";
import {
	clearUiLanguage,
	formatUiLanguage,
	getUiLanguage,
	setUiLanguage,
	SUPPORTED_UI_LANGUAGES,
	uiText,
	type UiLanguage,
} from "./shared/ui-language.ts";

function autopilotMenuOptions(): string[] {
	return uiText(["查看状态", "开启", "关闭", "退出"], ["Status", "Turn on", "Turn off", "Exit"]);
}

function languageMenuOptions(): string[] {
	return uiText(["查看状态", "设置回答语言", "清除", "退出"], ["Status", "Set reply language", "Clear", "Exit"]);
}

function uiLanguageMenuOptions(): string[] {
	return uiText(["查看状态", "设置界面语言", "清除", "退出"], ["Status", "Set UI language", "Clear", "Exit"]);
}

function uiLanguageChoiceOptions(): string[] {
	return [...SUPPORTED_UI_LANGUAGES.map((language) => language.label), uiText("返回", "Back")];
}

function isNaturalBareAtPrefix(lines: string[], cursorLine: number, cursorCol: number): boolean {
	const currentLine = lines[cursorLine] || "";
	const textBeforeCursor = currentLine.slice(0, cursorCol);
	return /(?:^|\s)@[^/\s"~.]*$/.test(textBeforeCursor);
}

export function suppressNaturalAtAutocomplete(current: AutocompleteProvider): AutocompleteProvider {
	return {
		...current,
		async getSuggestions(lines, cursorLine, cursorCol, options) {
			if (!options.force && isNaturalBareAtPrefix(lines, cursorLine, cursorCol)) {
				// ponytail: @agent owns bare @ text; file completion still works via Tab or path-like @./.
				return null;
			}
			return current.getSuggestions(lines, cursorLine, cursorCol, options);
		},
		applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
			return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
		},
	};
}

function formatDeepSeekSummary(deepseekStatus: string, language: UiLanguage): string {
	if (/未配置|not configured/i.test(deepseekStatus)) {
		return uiText("DeepSeek 未配置(设 DEEPSEEK_API_KEY 或运行 /login 启用)", "DeepSeek not configured (set DEEPSEEK_API_KEY or run /login)", language);
	}
	if (/DEEPSEEK_API_KEY/.test(deepseekStatus)) {
		return uiText("DeepSeek 已配置(DEEPSEEK_API_KEY, deepseek-chat/默认模型可用)", "DeepSeek configured (DEEPSEEK_API_KEY, deepseek-chat/default model available)", language);
	}
	return uiText("DeepSeek 已配置(pi login/auth.json, deepseek-chat/默认模型可用)", "DeepSeek configured (pi login/auth.json, deepseek-chat/default model available)", language);
}

function formatUgkStatusTable(deepseekStatus: string): string {
	const language = getUiLanguage();
	const apiConfigured = /已配置|configured/i.test(deepseekStatus) && !/未配置|not configured/i.test(deepseekStatus);
	const apiIcon = apiConfigured ? "✅" : "❌";
	const apiSummary = formatDeepSeekSummary(deepseekStatus, language);
	const rows = [
		[uiText("🧰 工具", "🧰 Tools", language), "✅ subagent  ✅ cron  ✅ chrome_cdp  ✅ mcp"],
		[uiText("🤖 代理", "🤖 Agents", language), uiText("✅ @agent 提及  ✅ /implement 流水线  ✅ 隔离摘要", "✅ @agent mention  ✅ /implement pipeline  ✅ isolated summaries", language)],
		[uiText("⌨️ 命令", "⌨️ Commands", language), "/ugk  /doctor  /update  /plan  /cdp  /mcp  /ugk-ui  /ui-language  /ugk-autopilot  /language"],
		["📡 API", `${apiIcon} ${apiSummary}`],
		[uiText("🛡️ 防护", "🛡️ Guardrails", language), uiText("危险 bash 门禁已启用", "Dangerous bash gate enabled", language)],
	] as const;

	return [
		uiText("🟢 UGK 已启用", "🟢 UGK enabled", language),
		"",
		renderTerminalTable(uiText(["模块", "状态"], ["Module", "Status"], language), rows),
	].join("\n");
}

export default function (pi: ExtensionAPI) {
	const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

	// 0) 内置工具精简渲染(必须最先,覆盖默认 bash/edit)
	registerBuiltinToolRenderers(pi);


	// 1.1) subagent 工具(从官方 subagent 示例搬运 + Windows spawn 适配)
	registerSubagent(pi);
	registerSubagentCommand(pi);

	// 1.2) UI 美化(从官方示例搬运,三处区域互不冲突)
	//   - footer:底栏 token 统计 + git 分支 + 模型名(/footer 开关)
	//   - statusline:底部状态条显示回合进度(●第N轮... / ✓完成)
	//   - titlebar:agent 工作时终端标题栏转盲文 spinner
	registerUgkBrandUi(pi);
	registerUiStatusline(pi);
	pi.on("session_start", async (_event, ctx) => {
		ctx.ui.addAutocompleteProvider?.(suppressNaturalAtAutocomplete);
	});

	// 1.3) cron 定时任务(代理常驻 cron 服务的 HTTP API)
	registerCron(pi);

	// 1.3b) plan-mode:只读探索模式(/plan 切换,bash 白名单,计划提取+进度跟踪)
	registerPlanMode(pi);

	// 1.3c) questionnaire:通用多选问卷工具(让 agent 向用户提问)。原属 judge 目录,
	// judge 删除后独立出来 —— 它是通用能力,不只 judge 用。
	registerQuestionnaire(pi);

	// 1.3b.3) task:固定任务 taskbook 创造/复用系统
	registerTask(pi);

	// 1.3c) chrome-cdp:受保护的本地登录态 Chrome 控制器(/cdp + chrome_cdp tool)
	registerChromeCdp(pi);

	// 1.3c.1) mcp:外部 MCP stdio tools 集成(/mcp + session lifecycle)
	registerMcp(pi, { packageRoot });

	// 1.3c.2) doctor: legacy entrypoint for guided environment troubleshooting skill.
	registerDoctor(pi);

	// 1.3d) UGK 自管更新:只暴露 UGK 更新,不暴露 pi update
	registerUgkUpdate(pi);

	// 1.4) @mention 手动触发:输入 @<agent名> <任务> → 改写为指示主 agent 委派的消息
	//      agent 名从 discoverAgents 动态读(不写死),保持可配置。
	//      模式借自 inline-bash.ts:pi.on("input") 返回 { action: "transform", text }
	pi.on("input", async (event, _ctx) => {
		const text = event.text;
		// 匹配行首或空格后的 @agentname,后接任务文本
		const match = text.match(/^\s*@([\w-]+)\s+([\s\S]+)/);
		if (!match) return { action: "continue" };

		const agentName = match[1];
		const task = match[2].trim();

		// 确认是已注册的 agent(避免误吞 @github 用户名等)
		const { agents } = discoverAgents(process.cwd(), "user");
		if (!agents.some((a) => a.name === agentName)) {
			return { action: "continue" };
		}

		// 改写为明确的委派指令,让主 agent 调 subagent 工具
		const transformed = `用 subagent 工具完成以下任务(强制指定 agent="${agentName}",task 内容如下):\n\n${task}`;
		return { action: "transform", text: transformed, images: event.images };
	});

	// 2) slash 命令
	pi.registerCommand("ugk", {
		description: "Show ugk-pi-agent status",
		handler: async (_args, ctx) => {
			ctx.ui.notify(formatUgkStatusTable(getDeepSeekStatus()), "info");
		},
	});

	// 2.0) /ugk-autopilot:统一工具确认总开关(①②类工具确认受管,危险命令门不受管)。
	//   on  = 普通工具确认(CDP/MCP/未来工具)一律放行 + 注入"别问范围问题"指令(治 ③类)。
	//   off = 恢复默认(工具各自回 ask)。
	//   状态只在会话内存,关 ugk 即忘。危险动作(rm -rf 等)永远走人确认,autopilot 管不到。
	pi.registerCommand("ugk-autopilot", {
		description: "Toggle autopilot: auto-approve reversible tool confirmations",
		handler: async (args, ctx) => {
			let arg = (args || "").trim().toLowerCase();
			if (arg === "" && ctx.ui?.select) {
				const options = autopilotMenuOptions();
				const selection = await ctx.ui.select(uiText("自动放行", "Autopilot"), options);
				if (!selection || selection === options[3]) return;
				if (selection === options[0]) arg = "status";
				if (selection === options[1]) arg = "on";
				if (selection === options[2]) arg = "off";
			}
			if (arg === "on" || arg === "off") {
				setAutopilot(arg === "on");
				ctx.ui.notify(
					uiText(`自动放行: ${arg === "on" ? "开" : "关"}\n`, `Autopilot: ${arg === "on" ? "on" : "off"}\n`) +
						(arg === "on"
							? uiText("可逆的工具确认(CDP/MCP 等)自动放行;危险命令(rm -rf 等)仍归人。", "Reversible tool confirmations (CDP/MCP, etc.) are auto-approved; dangerous commands still require you.")
							: uiText("工具确认回到各工具自己的模式。", "Tool confirmations return to each tool's own mode.")),
					"info",
				);
				return;
			}
			if (arg === "status" || arg === "") {
				ctx.ui.notify(uiText(`自动放行: ${isAutopilotOn() ? "开" : "关"}`, `Autopilot: ${isAutopilotOn() ? "on" : "off"}`), "info");
				return;
			}
			ctx.ui.notify(uiText("用法: /ugk-autopilot on|off|status", "Usage: /ugk-autopilot on|off|status"), "warning");
		},
	});

	// 2.0b) before_agent_start 注入动态指令(autopilot 范围问卷 + 用户语言偏好)。
	//   一个钩子处理两段 prompt,比两个钩子少一次 systemPrompt 读写。
	pi.on("before_agent_start", async (event: { systemPrompt?: string } = {}) => {
		const snippets: string[] = [];
		if (isAutopilotOn()) snippets.push(AUTOPILOT_PROMPT_SNIPPET);
		const langSnippet = buildLanguagePromptSnippet(getLanguage());
		if (langSnippet) snippets.push(langSnippet);
		if (snippets.length === 0) return undefined;

		const prompt = event.systemPrompt ?? "";
		const toAdd = snippets.filter((s) => !prompt.includes(s));
		if (toAdd.length === 0) return undefined;
		return { systemPrompt: [prompt, "", ...toAdd].join("\n") };
	});

	// 2.0c) /language:用户语言偏好(跨会话持久,自由字符串)。
	//   /language <语言>  = 设(如 /language English、/language 日本語)
	//   /language status  = 看当前
	//   /language clear   = 清除,回到 AGENTS.md 默认(优先中文)
	//   无参 = 交互输入(支持时)
	pi.registerCommand("language", {
		description: "Set the language the agent speaks (persists across sessions)",
		handler: async (args, ctx) => {
			let raw = (args || "").trim();
			if (raw === "" && ctx.ui?.select) {
				const options = languageMenuOptions();
				const selection = await ctx.ui.select(uiText("回答语言", "Reply Language"), options);
				if (!selection || selection === options[3]) return;
				if (selection === options[0]) raw = "status";
				if (selection === options[2]) raw = "clear";
				if (selection === options[1]) {
					if (!ctx.ui?.input) {
						ctx.ui.notify(uiText("设置回答语言需要交互输入支持。请使用 /language <语言>。", "Setting reply language needs interactive input. Use /language <language>."), "warning");
						return;
					}
					const input = await ctx.ui.input(uiText("AI 回答优先用什么语言?", "Which language should AI replies prefer?"), "English / 中文 / 日本語");
					if (!input?.trim()) {
						ctx.ui.notify(uiText("未设置,保持当前语言偏好。", "Not set; keeping current reply language preference."), "info");
						return;
					}
					const set = setLanguage(input);
					ctx.ui.notify(uiText(`语言偏好已设为: ${set}\n下个回合起生效。`, `Reply language set to: ${set}\nTakes effect next turn.`), "info");
					return;
				}
			}
			const arg = raw.toLowerCase();

			if (arg === "status" || (arg === "" && !ctx.ui?.input)) {
				const current = getLanguage();
				ctx.ui.notify(
					current
						? uiText(`当前语言偏好: ${current}\n(/language <语言> 修改,/language clear 清除回默认)`, `Current reply language: ${current}\n(/language <language> to change, /language clear to reset)`)
						: uiText(`当前语言偏好: 默认(优先中文)\n(/language <语言> 设置)`, `Current reply language: default (Chinese preferred)\n(/language <language> to set)`),
					"info",
				);
				return;
			}
			if (arg === "clear") {
				clearLanguage();
				ctx.ui.notify(uiText("语言偏好已清除,回到默认(优先中文)。", "Reply language cleared; back to default (Chinese preferred)."), "info");
				return;
			}
			if (arg === "") {
				// ponytail: 无参且有 input 能力时,交互问一句。避免命令解析对 input 能力的耦合。
				const input = await ctx.ui.input(uiText("AI 回答优先用什么语言?", "Which language should AI replies prefer?"), "English / 中文 / 日本語");
				if (!input?.trim()) {
					ctx.ui.notify(uiText("未设置,保持当前语言偏好。", "Not set; keeping current reply language preference."), "info");
					return;
				}
				const set = setLanguage(input);
				ctx.ui.notify(uiText(`语言偏好已设为: ${set}\n下个回合起生效。`, `Reply language set to: ${set}\nTakes effect next turn.`), "info");
				return;
			}
			const set = setLanguage(raw);
			ctx.ui.notify(uiText(`语言偏好已设为: ${set}\n下个回合起生效。`, `Reply language set to: ${set}\nTakes effect next turn.`), "info");
		},
	});

	pi.registerCommand("ui-language", {
		description: "Set UGK menu/UI language (separate from /language)",
		handler: async (args, ctx) => {
			let raw = (args || "").trim();
			if (raw === "" && ctx.ui?.select) {
				const options = uiLanguageMenuOptions();
				const selection = await ctx.ui.select(uiText("界面语言", "UI Language"), options);
				if (!selection || selection === options[3]) return;
				if (selection === options[0]) raw = "status";
				if (selection === options[2]) raw = "clear";
				if (selection === options[1]) {
					const choices = uiLanguageChoiceOptions();
					const choice = await ctx.ui.select(uiText("选择界面语言", "Select UI Language"), choices);
					if (!choice || choice === choices.at(-1)) return;
					const selected = SUPPORTED_UI_LANGUAGES[choices.indexOf(choice)];
					if (!selected) return;
					raw = selected.code;
				}
			}

			const arg = raw.toLowerCase();
			if (arg === "status" || arg === "") {
				const current = getUiLanguage();
				ctx.ui.notify(uiText(`当前界面语言: ${formatUiLanguage(current)}`, `Current UI language: ${formatUiLanguage(current)}`), "info");
				return;
			}
			if (arg === "clear") {
				const language = getUiLanguage();
				clearUiLanguage();
				ctx.ui.notify(uiText("界面语言已清除,回到默认: 简体中文", "UI language cleared; back to default: Simplified Chinese", language), "info");
				return;
			}
			const set = setUiLanguage(raw);
			if (!set) {
				ctx.ui.notify(uiText("用法: /ui-language zh-CN|English|status|clear", "Usage: /ui-language zh-CN|English|status|clear"), "warning");
				return;
			}
			ctx.ui.notify(`${uiText("界面语言已设为", "UI language set to", set)}: ${formatUiLanguage(set)}`, "info");
		},
	});


	// 3) 权限门(照搬 permission-gate.ts 模式)
	//    拦截危险 bash 命令,交互模式弹确认,非交互模式直接拦截(fail-safe)
	//    ponytail: rm 的 -r/-f 是顺序无关的独立 flag,旧正则 /\brm\s+(-rf?|--recursive)/ 锁定
	//    了 r 在 f 前,可被 rm -fr / rm -f -r / rm --force --recursive 绕过。改为"\brm\b 后
	//    (同一命令段内,不跨 |;& 分隔符)出现含 r 的短选项或 --recursive",顺序无关、分写/长选项
	//    均命中。chmod/chown 777 同理用 [^|;&]* 容忍 -R/空格。
	const dangerousPatterns = [
		/\brm\b[^|;&]*(-\w*r\w*|--recursive)/i,
		/\bsudo\b/i,
		/\b(chmod|chown)\b[^|;&]*777/i,
	];

	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "bash") return undefined;

		const command = event.input.command as string;
		if (!dangerousPatterns.some((p) => p.test(command))) return undefined;

		if (!ctx.hasUI) {
			// 非交互模式:默认拦截(fail-safe)
			return { block: true, reason: "Dangerous command blocked (no UI for confirmation)" };
		}

		const options = uiText(["允许", "拒绝"], ["Yes", "No"]);
		const choice = await ctx.ui.select(
			uiText(`⚠️ 危险命令:\n\n  ${command}\n\n是否允许?`, `⚠️ Dangerous command:\n\n  ${command}\n\nAllow?`),
			options,
		);
		if (choice !== options[0]) {
			return { block: true, reason: "Blocked by user" };
		}

		return undefined;
	});

	// 4) resources_discover:让 skills/prompts 随包走
	//    bin/ugk.js 用 -e 加载本扩展(只管扩展文件),skills/prompts 靠这个事件带上。
	//    扫描包内的 skills/<name>/SKILL.md 和 prompts/*.md,返回绝对路径。
	//    模式借自官方 examples/extensions/dynamic-resources。
	//
	//    skills = 系统自带(跟包走,更新覆盖);user-skills = 用户手动安装/创建,
	//    同样在包目录下,跟着 git clone 走(用户在哪运行 ugk 都用同一批)。
	//    两者用同一个 scanSkillPaths,来源统一、加载机制统一。
	pi.on("resources_discover", () => {
		return {
			skillPaths: [
				...scanSkillPaths(path.join(packageRoot, "skills")),
				...scanSkillPaths(path.join(packageRoot, "user-skills")),
			],
			promptPaths: scanFilesByExtension(path.join(packageRoot, "prompts"), ".md"),
			themePaths: scanFilesByExtension(path.join(packageRoot, "themes"), ".json"),
		};
	});
}

/** Scan <dir>/<name>/SKILL.md for each subdirectory; missing dir returns []. */
export function scanSkillPaths(skillsDir: string): string[] {
	const paths: string[] = [];
	try {
		for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			const skillFile = path.join(skillsDir, entry.name, "SKILL.md");
			if (fs.existsSync(skillFile)) paths.push(skillFile);
		}
	} catch {
		// skills 目录不存在则跳过
	}
	return paths;
}

/** Scan <dir> for files ending in ext; missing dir returns []. */
function scanFilesByExtension(dir: string, ext: string): string[] {
	const paths: string[] = [];
	try {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			if (!entry.isFile() || !entry.name.endsWith(ext)) continue;
			paths.push(path.join(dir, entry.name));
		}
	} catch {
		// 目录不存在则跳过
	}
	return paths;
}
