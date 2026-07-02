import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { getUiLanguage, uiText, type UiLanguage } from "./shared/ui-language.ts";

export const UGK_BRAND_COLORS = {
	accent: "#9be564",
	cyan: "#79e6d9",
	text: "#d8fff7",
	muted: "#7c8588",
	dim: "#5e6669",
	panel: "#20242f",
	panelStrong: "#262b37",
	error: "#ff6b7a",
	warning: "#e4c766",
} as const;

export interface UgkHeaderOptions {
	version: string;
	cwdName: string;
	modelId?: string;
	width: number;
	uiLanguage?: UiLanguage;
}

export interface UgkStartupScreenOptions extends UgkHeaderOptions {
	rows: number;
}

export interface UgkFooterUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextPercent: number | null;
	contextWindow: number;
}

export interface UgkApiUsage {
	model: string;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
}

export interface UgkFooterOptions {
	cwd: string;
	branch: string | null;
	modelId: string;
	thinkingLevel?: string;
	statuses: string[];
	usage: UgkFooterUsage;
	apiUsage?: UgkApiUsage[];
	width: number;
	uiLanguage?: UiLanguage;
}

export type UgkStatusTone = "error" | "warning" | "success" | "dim";

export function resolveUgkDisplayModelId(modelId: string | undefined, deepSeekStatus: string, language: UiLanguage = getUiLanguage()): string | undefined {
	if (!modelId) return undefined;
	const isDeepSeekModel = modelId.toLowerCase().startsWith("deepseek");
	if (isDeepSeekModel && /未配置|not configured/i.test(deepSeekStatus)) return uiText("❌ API 未配置", "❌ API not configured", language);
	return modelId;
}

export function classifyUgkStatusTone(text: string): UgkStatusTone {
	const normalized = text.toLowerCase();
	if (/\[fail\]|✗|未配置|不可用|未加载|缺失|未找到|失败|错误|api not configured|unavailable|not loaded|missing|failed|error/.test(normalized)) {
		return "error";
	}
	if (/\[warn\]|⚠|警告|无法连接|未就绪|超时|已跳过|warn|not reachable|not ready|timeout|skipped/.test(normalized)) return "warning";
	if (/\[pass\]|✓|已配置|可用|已加载|可连接|在线|成功|configured|available|loaded|reachable|online|success/.test(normalized)) return "success";
	return "dim";
}

// ponytail: logo 文本 + 着色标记(人工挑选的稳定区分子串 + tone),改 logo 时同处维护。
// marker 是每行能区分其他行的最短片段,不是自动可提取的——区分度藏在行中间特定位置。
// 曾试 split(/\s/)[0] 自动提取,但行1/2/3 都得 "██║" 无法区分,作废。原硬编码搬过来,零行为变化。
// 子串匹配仍受窄终端截断影响(已知天花板),根治需按渲染行索引定位,代价过大暂不做。
export const UGK_BLOCK_LOGO_TONES = [
	{ marker: "██╗   ██╗", tone: "error" },
	{ marker: "██║   ██║██╔════╝", tone: "error" },
	{ marker: "██║   ██║██║  ███╗", tone: "warning" },
	{ marker: "██║   ██║██║   ██║", tone: "accent" },
	{ marker: "╚██████╔╝", tone: "success" },
	{ marker: "╚═════╝", tone: "accent" },
];

export const UGK_BLOCK_LOGO = [
	"██╗   ██╗ ██████╗ ██╗  ██╗",
	"██║   ██║██╔════╝ ██║ ██╔╝",
	"██║   ██║██║  ███╗█████╔╝ ",
	"██║   ██║██║   ██║██╔═██╗ ",
	"╚██████╔╝╚██████╔╝██║  ██╗",
	" ╚═════╝  ╚═════╝ ╚═╝  ╚═╝",
];

function hardTruncate(text: string, width: number): string {
	if (width <= 0) return "";
	return truncateToWidth(text, width, "").replace(/\x1b\[[0-9;]*m/g, "");
}

function padEndVisible(text: string, width: number): string {
	return `${text}${" ".repeat(Math.max(0, width - visibleWidth(text)))}`;
}

function formatTokens(count: number): string {
	if (!count) return "0";
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

function formatMillionTokens(count: number): string {
	return `${(count / 1000000).toFixed(2)}M`;
}

function totalApiTokens(item: UgkApiUsage): number {
	return item.input + item.output + item.cacheRead + item.cacheWrite;
}

function formatApiUsageLine(items: UgkApiUsage[] | undefined): string {
	const visible = (items ?? [])
		.filter((item) => item.model && totalApiTokens(item) > 0)
		.sort((a, b) => totalApiTokens(b) - totalApiTokens(a))
		.slice(0, 3);
	if (visible.length === 0) return "";
	return `API ${visible.map((item) => [
		item.model,
		`Σ${formatMillionTokens(totalApiTokens(item))}`,
		`↑${formatMillionTokens(item.input)}`,
		`↓${formatMillionTokens(item.output)}`,
		item.cacheRead ? `R${formatMillionTokens(item.cacheRead)}` : "",
		item.cacheWrite ? `W${formatMillionTokens(item.cacheWrite)}` : "",
	].filter(Boolean).join(" ")).join(" | ")}`;
}

function formatContextProgress(percent: number | null): string {
	const cells = 8;
	const clamped = Math.max(0, Math.min(100, percent ?? 0));
	const filled = Math.round((clamped / 100) * cells);
	return `${"█".repeat(filled)}${"▒".repeat(cells - filled)}`;
}

function formatCwd(cwd: string): string {
	const home = process.env.HOME || process.env.USERPROFILE;
	if (home && cwd.startsWith(home)) {
		return `~${cwd.slice(home.length)}`;
	}
	return cwd;
}

function panelWidth(width: number): number {
	if (width <= 0) return 0;
	return Math.min(width, 64);
}

function welcomePanelWidth(width: number): number {
	if (width <= 0) return 0;
	return Math.min(width, 120);
}

function fitVisible(text: string, width: number, align: "left" | "center" = "left"): string {
	const clipped = hardTruncate(text, width);
	const padding = Math.max(0, width - visibleWidth(clipped));
	if (align === "center") {
		const left = Math.floor(padding / 2);
		return `${" ".repeat(left)}${clipped}${" ".repeat(padding - left)}`;
	}
	return `${clipped}${" ".repeat(padding)}`;
}

function panelRule(left: string, label: string, right: string, width: number): string {
	const ruleWidth = panelWidth(width);
	if (ruleWidth <= 0) return "";
	const prefix = `${left}─ ${label} `;
	const fill = "─".repeat(Math.max(0, ruleWidth - prefix.length - right.length));
	return hardTruncate(`${prefix}${fill}${right}`, width);
}

function panelEdge(left: string, right: string, width: number): string {
	const ruleWidth = panelWidth(width);
	if (ruleWidth <= 0) return "";
	const fill = "─".repeat(Math.max(0, ruleWidth - left.length - right.length));
	return hardTruncate(`${left}${fill}${right}`, width);
}

function panelRow(label: string, value: string, width: number): string {
	const rowWidth = panelWidth(width);
	if (rowWidth <= 0) return "";
	const bodyWidth = Math.max(0, rowWidth - 4);
	const labelText = label ? `${label.padEnd(12)}${value}` : value;
	const body = hardTruncate(labelText, bodyWidth);
	return hardTruncate(`│ ${padEndVisible(body, bodyWidth)} │`, width);
}

function welcomePanelRule(label: string, width: number): string {
	const rowWidth = welcomePanelWidth(width);
	if (rowWidth <= 0) return "";
	const prefix = `┌─ ${label} `;
	return `${prefix}${"─".repeat(Math.max(0, rowWidth - visibleWidth(prefix) - 1))}┐`;
}

function welcomePanelEdge(width: number): string {
	const rowWidth = welcomePanelWidth(width);
	if (rowWidth <= 0) return "";
	return `└${"─".repeat(Math.max(0, rowWidth - 2))}┘`;
}

function welcomePanelRow(left: string, right: string, rowWidth: number, leftWidth: number): string {
	const rightWidth = Math.max(0, rowWidth - leftWidth - 7);
	return `│ ${fitVisible(left, leftWidth)} │ ${fitVisible(right, rightWidth)} │`;
}

export function buildUgkLogoLines(width: number): string[] {
	return UGK_BLOCK_LOGO.map((line) => hardTruncate(line, width));
}

function buildUgkInfoPanelLines(options: UgkHeaderOptions): string[] {
	const language = options.uiLanguage ?? getUiLanguage();
	const model = options.modelId || uiText("未选择模型", "model not selected", language);
	return [
		panelRule("┌", `ugk v${options.version}`, "┐", options.width),
		panelRow(uiText("工作区", "Workspace", language), options.cwdName, options.width),
		panelRow(uiText("代理", "Agent", language), uiText("终端编码代理", "Terminal coding agent", language), options.width),
		panelRow(uiText("能力", "Capabilities", language), "plan · subagents · cron · task", options.width),
		panelRule("├", uiText("快捷操作", "Quick Actions", language), "┤", options.width),
		panelRow("", "/plan  /implement  /doctor  @agent", options.width),
		panelRow(uiText("模型", "Model", language), model, options.width),
		panelEdge("└", "┘", options.width),
	];
}

function buildUgkWelcomePanelLines(options: UgkHeaderOptions): string[] {
	const language = options.uiLanguage ?? getUiLanguage();
	const rowWidth = welcomePanelWidth(options.width);
	if (rowWidth < 72) {
		return [
			...buildUgkLogoLines(options.width),
			"",
			...buildUgkInfoPanelLines(options),
		];
	}

	const model = options.modelId || uiText("未选择模型", "model not selected", language);
	const leftWidth = Math.max(28, Math.floor((rowWidth - 7) * 0.45));
	const logoWidth = Math.max(...UGK_BLOCK_LOGO.map((line) => visibleWidth(line)));
	const leftRows = [
		uiText("欢迎回来。", "Welcome back.", language),
		"",
		...UGK_BLOCK_LOGO.map((line) => fitVisible(padEndVisible(line, logoWidth), leftWidth, "center")),
		"",
		`${uiText("工作区", "Workspace", language)}  ${options.cwdName}`,
		`${uiText("模型", "Model", language)}    ${model}`,
	];
	const rightRows = [
		uiText("◆ 入门提示", "◆ Getting Started", language),
		uiText("› /plan      修改前先拟计划", "› /plan      Plan before editing", language),
		uiText("› /implement 运行引导流程", "› /implement Run guided flow", language),
		uiText("› /doctor 环境配置引导", "› /doctor Environment help", language),
		"",
		uiText("◆ 最近更新", "◆ Recent Updates", language),
		uiText("› task 显示 worker 进度", "› task shows worker progress", language),
		uiText("› footer 显示用量和就绪状态", "› footer shows usage and readiness", language),
		uiText("› @agent 委派专注任务", "› @agent delegates focused work", language),
	];

	const rowCount = Math.max(leftRows.length, rightRows.length);
	return [
		welcomePanelRule(`ugk v${options.version}`, options.width),
		...Array.from({ length: rowCount }, (_, i) => welcomePanelRow(leftRows[i] ?? "", rightRows[i] ?? "", rowWidth, leftWidth)),
		welcomePanelEdge(options.width),
	];
}

export function buildUgkHeaderLines(options: UgkHeaderOptions): string[] {
	return buildUgkWelcomePanelLines(options);
}

export function buildUgkStartupScreenLines(options: UgkStartupScreenOptions): string[] {
	if (options.width < 72 || options.rows < 16) {
		return buildUgkHeaderLines(options);
	}

	const targetRows = Math.max(12, options.rows - 5);
	const content = buildUgkHeaderLines(options);

	const missing = Math.max(0, targetRows - content.length);
	const topPadding = Math.floor(missing / 2);
	const bottomPadding = missing - topPadding;
	return [...Array(topPadding).fill(""), ...content, ...Array(bottomPadding).fill("")];
}

export function buildUgkFooterLines(options: UgkFooterOptions): string[] {
	const branch = options.branch ? ` (${options.branch})` : "";
	const context =
		options.usage.contextPercent === null
			? `?/${formatTokens(options.usage.contextWindow)}`
			: `${options.usage.contextPercent.toFixed(1)}%/${formatTokens(options.usage.contextWindow)}`;
	const usage = [
		`↑${formatTokens(options.usage.input)}`,
		`↓${formatTokens(options.usage.output)}`,
		options.usage.cacheRead ? `R ${formatTokens(options.usage.cacheRead)}` : "",
		options.usage.cacheWrite ? `W ${formatTokens(options.usage.cacheWrite)}` : "",
		`💰 $${options.usage.cost.toFixed(3)}`,
		`🧠 ${formatContextProgress(options.usage.contextPercent)} ${context}`,
	].filter(Boolean);
	const model = options.thinkingLevel ? `🤖 ${options.modelId} · ${options.thinkingLevel}` : `🤖 ${options.modelId}`;
	const apiUsage = formatApiUsageLine(options.apiUsage);

	return [
		hardTruncate(`ugk ${formatCwd(options.cwd)}${branch}`, options.width),
		hardTruncate(`${usage.join(" ")}  ${model}`, options.width),
		...(apiUsage ? [hardTruncate(apiUsage, options.width)] : []),
		hardTruncate(options.statuses.join(" "), options.width),
	];
}
