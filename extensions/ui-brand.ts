import fs from "node:fs";
import path from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ContextUsage, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
	buildUgkFooterLines,
	buildUgkHeaderLines,
	buildUgkStartupScreenLines,
	classifyUgkStatusTone,
	resolveUgkDisplayModelId,
	UGK_BLOCK_LOGO_TONES,
	type UgkApiUsage,
	type UgkFooterUsage,
} from "./ui-brand-utils.ts";
import { getDeepSeekStatus } from "./deepseek-status.ts";
import { readSettingsJson } from "./shared/settings-io.ts";
import { getUiLanguage, uiText } from "./shared/ui-language.ts";

function readUgkVersion(): string {
	try {
		const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
		return typeof pkg.version === "string" && pkg.version ? pkg.version : "unknown";
	} catch {
		return "unknown";
	}
}

const VERSION = readUgkVersion();
const ENABLED_ENV_VALUES = new Set(["1", "true", "yes", "on"]);
const DISABLED_ENV_VALUES = new Set(["0", "false", "no", "off"]);
function ugkUiMenuOptions(): string[] {
	return uiText(["查看状态", "关闭", "开启", "退出"], ["Status", "Turn off", "Turn on", "Exit"]);
}

function envDisablesBrandUi(): boolean {
	const raw = process.env.UGK_UI;
	return raw ? DISABLED_ENV_VALUES.has(raw.toLowerCase()) : false;
}

function envEnablesBrandUi(): boolean {
	const raw = process.env.UGK_UI;
	return raw ? ENABLED_ENV_VALUES.has(raw.toLowerCase()) : false;
}

function formatTitle(pi: ExtensionAPI, cwd: string): string {
	const cwdName = path.basename(cwd);
	const session = pi.getSessionName();
	return session ? `ugk - ${session} - ${cwdName}` : `ugk - ${cwdName}`;
}

function getTitleCwd(ctx: ExtensionContext): string {
	return ctx.sessionManager?.getCwd?.() ?? ctx.cwd ?? process.cwd();
}

// ponytail: spinner 动画从 ui-titlebar 并入(修 title 抢占 bug)。ugk 品牌标题优先,
// 工作态前缀盲文帧、idle 态恢复静态 ugk 标题;off 时 stop,不抢 title。
const BRAILLE_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPINNER_INTERVAL_MS = 80;

function formatSpinningTitle(pi: ExtensionAPI, frame: string, cwd: string): string {
	const cwdName = path.basename(cwd);
	const session = pi.getSessionName();
	return session ? `${frame} ugk - ${session} - ${cwdName}` : `${frame} ugk - ${cwdName}`;
}

function shouldClearStartupScreen(): boolean {
	const rawEnv = process.env.UGK_CLEAR_STARTUP;
	if (rawEnv && DISABLED_ENV_VALUES.has(rawEnv.toLowerCase())) return false;
	if (rawEnv && ENABLED_ENV_VALUES.has(rawEnv.toLowerCase())) return true;

	// BOM-safe 读取(见 shared/settings-io.ts):settings.json 可能带 UTF-8 BOM,
	// 旧实现裸 JSON.parse 会抛错静默降级,这里改用 helper 剥离 BOM。
	const settings = readSettingsJson();
	return (settings?.clearStartupScreen ?? true) !== false;
}

function clearStartupScreen(ctx: ExtensionContext): void {
	if ((ctx as any).hasUI === false || !process.stdout.isTTY) return;
	if (!shouldClearStartupScreen()) return;
	process.stdout.write("\x1b[2J\x1b[3J\x1b[H");
}

function hasSessionMessages(ctx: { sessionManager?: { getEntries?: () => unknown[]; getBranch?: () => unknown[] } }): boolean {
	const entries = ctx.sessionManager?.getEntries?.() ?? ctx.sessionManager?.getBranch?.() ?? [];
	return entries.length > 0;
}

// ponytail: tone 规则来自 ui-brand-utils 的 UGK_BLOCK_LOGO_TONES,改 logo 时同处维护,
// 不再两处维护(PR#18 shrink 项)。逻辑与原硬编码 includes 完全等价——首个命中的 marker 决定 tone。
function logoTone(line: string): string | undefined {
	for (const { marker, tone } of UGK_BLOCK_LOGO_TONES) {
		if (line.includes(marker)) return tone;
	}
	return undefined;
}

function colorLogoGlyphs(line: string, theme: any): string {
	const tone = logoTone(line);
	if (!tone) return line.replace(/█+/g, (block) => theme.bold(theme.fg("success", block)));
	return line.replace(/[█╗║╔╝╚═]+/g, (glyphs) => theme.bold(theme.fg(tone, glyphs)));
}

function colorHeaderLine(line: string, index: number, theme: any): string {
	const trimmed = line.trimStart();
	if (logoTone(line) && !trimmed.startsWith("│")) {
		return colorLogoGlyphs(line, theme);
	}
	const logoColoredLine = colorLogoGlyphs(line, theme);
	if (/[░▒▓]/.test(line) || trimmed.startsWith("╭")) {
		return theme.fg("dim", line);
	}
	if (!line.trim()) return line;
	if (/^[┌├└]/.test(trimmed)) {
		return logoColoredLine
			.replace("ugk", theme.bold(theme.fg("success", "ugk")))
			.replace("快捷操作", theme.fg("success", "快捷操作"))
			.replace("Quick Actions", theme.fg("success", "Quick Actions"))
			.replace("模型", theme.fg("success", "模型"))
			.replace("Model", theme.fg("success", "Model"));
	}
	if (trimmed.startsWith("│")) {
		const colored = logoColoredLine
			.replace(/(工作区|代理|能力|模型|Workspace|Agent|Capabilities|Model)/, theme.fg("dim", "$1"))
			.replace("◆ 入门提示", theme.bold(theme.fg("success", "◆ 入门提示")))
			.replace("◆ 最近更新", theme.bold(theme.fg("success", "◆ 最近更新")))
			.replace("◆ Getting Started", theme.bold(theme.fg("success", "◆ Getting Started")))
			.replace("◆ Recent Updates", theme.bold(theme.fg("success", "◆ Recent Updates")))
			.replace("/plan", theme.fg("success", "/plan"))
			.replace("/implement", theme.fg("success", "/implement"))
			.replace("/doctor", theme.fg("success", "/doctor"))
			.replace("@agent", theme.fg("success", "@agent"));
		return colorStatefulText(colored, theme);
	}
	if (line.startsWith("  ")) return theme.fg("success", line);
	if (index === 0) return theme.fg("muted", line);
	return line
		.replace("模型", theme.fg("dim", "模型"))
		.replace("Model", theme.fg("dim", "Model"))
		.replace("/plan", theme.fg("success", "/plan"))
		.replace("/implement", theme.fg("success", "/implement"))
		.replace("/doctor", theme.fg("success", "/doctor"))
		.replace("@agent", theme.fg("success", "@agent"));
}

function colorStatefulText(text: string, theme: any): string {
	const statefulValues = [
		"❌ API 未配置",
		"❌ API not configured",
		"api not configured",
		"未选择模型",
		"model not selected",
		"bash 不可用",
		"bash unavailable",
		"subagent 未加载",
		"subagent not loaded",
	];
	return statefulValues.reduce((current, value) => {
		if (!current.includes(value)) return current;
		return current.replace(value, theme.fg(classifyUgkStatusTone(value), value));
	}, text);
}

function classifyContextProgressTone(contextText: string): "success" | "warning" | "error" | "dim" {
	const match = /([0-9]+(?:\.[0-9]+)?)%\//.exec(contextText);
	if (!match) return "dim";
	const percent = Number(match[1]);
	if (percent >= 90) return "error";
	if (percent >= 70) return "warning";
	return "success";
}

function colorFooterUsageText(usage: string, theme: any): string {
	const match = /^(.*?🧠 )([█▒]{8})( .*)$/.exec(usage);
	if (!match) return theme.fg("dim", usage);
	const filled = match[2].match(/^█*/)?.[0] ?? "";
	const empty = match[2].slice(filled.length);
	return `${theme.fg("dim", match[1])}${filled ? theme.fg(classifyContextProgressTone(match[3]), filled) : ""}${empty ? theme.fg("dim", empty) : ""}${theme.fg("dim", match[3])}`;
}

function colorFooterUsageLine(line: string, theme: any): string {
	const separator = "  ";
	const index = line.lastIndexOf(separator);
	if (index === -1) return theme.fg("dim", line);
	const usage = line.slice(0, index);
	const modelOrState = line.slice(index + separator.length);
	let tone = classifyUgkStatusTone(modelOrState);
	if (modelOrState.startsWith("🤖 ") && tone === "dim" && !/\bno-model\b|model not selected|未选择模型/i.test(modelOrState)) {
		tone = "success";
	}
	const coloredModelOrState = theme.fg(tone, modelOrState);
	let modelChip = coloredModelOrState;
	if (modelOrState.startsWith("🤖 ") && typeof theme.bg === "function") {
		try {
			modelChip = theme.bg("toolSuccessBg", coloredModelOrState);
		} catch {
			modelChip = coloredModelOrState;
		}
	}
	return `${colorFooterUsageText(usage, theme)}${separator}${modelChip}`;
}

function colorFooterStatusLine(statuses: string[], fallback: string, theme: any): string {
	const values = statuses.length ? statuses : [fallback];
	return values.map((status) => theme.fg(classifyUgkStatusTone(status), status)).join(" ");
}

interface BrandUiSessionSource {
	cwd: string;
	thinkingLevel?: string;
	getModel?: () => { id?: string; contextWindow?: number } | undefined;
	getContextUsage?: () => ContextUsage | undefined;
	sessionManager?: {
		getCwd?: () => string;
		getEntries?: () => unknown[];
		getBranch?: () => unknown[];
	};
}

function createBrandUiSessionSource(ctx: ExtensionContext): BrandUiSessionSource {
	return {
		cwd: ctx.cwd ?? process.cwd(),
		thinkingLevel: (ctx as any).session?.state?.thinkingLevel,
		getModel: () => ctx.model,
		getContextUsage: ctx.getContextUsage?.bind(ctx),
		sessionManager: ctx.sessionManager,
	};
}

function getCurrentModel(source: BrandUiSessionSource): { id?: string; contextWindow?: number } | undefined {
	try {
		return source.getModel?.();
	} catch {
		return undefined;
	}
}

function collectEntries(source: BrandUiSessionSource): unknown[] {
	return source.sessionManager?.getEntries?.() ?? source.sessionManager?.getBranch?.() ?? [];
}

class UgkHeader implements Component {
	private readonly source: BrandUiSessionSource;
	private readonly theme: any;

	constructor(source: BrandUiSessionSource, theme: any) {
		this.source = source;
		this.theme = theme;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const cwd = this.source.sessionManager?.getCwd?.() ?? this.source.cwd;
		const language = getUiLanguage();
		const modelId = resolveUgkDisplayModelId(getCurrentModel(this.source)?.id, getDeepSeekStatus(), language);
		const options = {
			version: VERSION,
			cwdName: path.basename(cwd),
			modelId,
			width,
			uiLanguage: language,
		};
		const lines = hasSessionMessages(this.source)
			? buildUgkHeaderLines(options)
			: buildUgkStartupScreenLines({
					...options,
					rows: process.stdout.rows || 24,
				});
		const rendered = ["", ...lines.map((line, i) => colorHeaderLine(line, i, this.theme)), ""];
		return rendered;
	}
}

function collectUsage(source: BrandUiSessionSource): UgkFooterUsage {
	let input = 0;
	let output = 0;
	let cacheRead = 0;
	let cacheWrite = 0;
	let cost = 0;
	for (const entry of collectEntries(source)) {
		const message = (entry as any).message as AssistantMessage | undefined;
		if ((entry as any).type !== "message" || message?.role !== "assistant" || !message.usage) continue;
		input += message.usage.input || 0;
		output += message.usage.output || 0;
		cacheRead += message.usage.cacheRead || 0;
		cacheWrite += message.usage.cacheWrite || 0;
		cost += message.usage.cost?.total || 0;
	}
	let context: ContextUsage | undefined;
	try {
		context = source.getContextUsage?.();
	} catch {
		context = undefined;
	}
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		cost,
		contextPercent: context?.percent ?? null,
		contextWindow: context?.contextWindow ?? getCurrentModel(source)?.contextWindow ?? 0,
	};
}

function usageValue(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function addApiUsage(target: Map<string, UgkApiUsage>, model: unknown, usage: any): void {
	const key = typeof model === "string" && model.trim() ? model.trim() : "unknown";
	const current = target.get(key) ?? { model: key, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
	current.input += usageValue(usage?.input);
	current.output += usageValue(usage?.output);
	current.cacheRead += usageValue(usage?.cacheRead);
	current.cacheWrite += usageValue(usage?.cacheWrite);
	current.cost += usageValue(usage?.cost);
	target.set(key, current);
}

function collectApiUsage(source: BrandUiSessionSource): UgkApiUsage[] {
	const totals = new Map<string, UgkApiUsage>();
	for (const entry of collectEntries(source)) {
		const message = (entry as any).message;
		if ((entry as any).type !== "message" || message?.role !== "toolResult") continue;
		if (message.toolName !== "subagent" && message.toolName !== "run_task") continue;
		const results = Array.isArray(message.details?.results) ? message.details.results : [];
		for (const result of results) {
			const apiUsage = Array.isArray(result?.apiUsage) ? result.apiUsage : undefined;
			if (apiUsage) {
				for (const item of apiUsage) addApiUsage(totals, item?.model, item?.usage);
			} else {
				addApiUsage(totals, result?.model, result?.usage);
			}
		}
	}
	return [...totals.values()];
}

class UgkFooter implements Component {
	private unsubscribe?: () => void;
	private readonly source: BrandUiSessionSource;
	private readonly theme: any;
	private readonly footerData: any;
	private readonly tui: { requestRender(): void };

	constructor(source: BrandUiSessionSource, theme: any, footerData: any, tui: { requestRender(): void }) {
		this.source = source;
		this.theme = theme;
		this.footerData = footerData;
		this.tui = tui;
		this.unsubscribe = footerData.onBranchChange?.(() => this.tui.requestRender());
	}

	dispose(): void {
		this.unsubscribe?.();
	}

	invalidate(): void {}

	render(width: number): string[] {
		const statuses = Array.from(this.footerData.getExtensionStatuses?.().values?.() ?? []) as string[];
		const cwd = this.source.sessionManager?.getCwd?.() ?? this.source.cwd;
		const language = getUiLanguage();
		const lines = buildUgkFooterLines({
			cwd,
			branch: this.footerData.getGitBranch?.() ?? null,
			modelId: resolveUgkDisplayModelId(getCurrentModel(this.source)?.id, getDeepSeekStatus(), language) || uiText("未选择模型", "model not selected", language),
			thinkingLevel: this.source.thinkingLevel,
			statuses,
			usage: collectUsage(this.source),
			apiUsage: collectApiUsage(this.source),
			width,
			uiLanguage: language,
		});

		const [pwd, usage, ...rest] = lines;
		const coloredPwd = pwd.replace(/^ugk/, this.theme.fg("success", "ugk"));
		const rendered = [this.theme.fg("dim", coloredPwd), colorFooterUsageLine(usage, this.theme)];
		for (let i = 0; i < rest.length; i += 1) {
			const line = rest[i];
			if (!line.trim()) continue;
			rendered.push(i === rest.length - 1 ? colorFooterStatusLine(statuses, line, this.theme) : this.theme.fg("dim", line));
		}
		return rendered.map((line) => {
			if (visibleWidth(line) <= width) return line;
			return truncateToWidth(line, width, this.theme.fg("dim", "..."));
		});
	}
}

function applyBrandUi(pi: ExtensionAPI, ctx: ExtensionContext): void {
	const source = createBrandUiSessionSource(ctx);
	ctx.ui.setHeader((_tui, theme) => new UgkHeader(source, theme));
	ctx.ui.setFooter((tui, theme, footerData) => new UgkFooter(source, theme, footerData, tui));
	ctx.ui.setTitle(formatTitle(pi, source.sessionManager?.getCwd?.() ?? source.cwd));
}

function clearBrandUi(ctx: ExtensionContext): void {
	ctx.ui.setHeader(undefined);
	ctx.ui.setFooter(undefined);
}

export default function registerUgkBrandUi(pi: ExtensionAPI): void {
	let enabled = !envDisablesBrandUi();
	let spinnerTimer: ReturnType<typeof setInterval> | null = null;
	let spinnerFrame = 0;

	function stopSpinnerTitle(ctx: ExtensionContext): void {
		if (spinnerTimer) {
			clearInterval(spinnerTimer);
			spinnerTimer = null;
		}
		spinnerFrame = 0;
		if (enabled) {
			try {
				ctx.ui.setTitle(formatTitle(pi, getTitleCwd(ctx)));
			} catch {
				// session 可能在 replacement/reload 拆除时已 stale。
			}
		}
	}

	function startSpinnerTitle(ctx: ExtensionContext): void {
		stopSpinnerTitle(ctx);
		if (!enabled) return;
		spinnerTimer = setInterval(() => {
			try {
				const frame = BRAILLE_FRAMES[spinnerFrame % BRAILLE_FRAMES.length];
				ctx.ui.setTitle(formatSpinningTitle(pi, frame, getTitleCwd(ctx)));
				spinnerFrame++;
			} catch {
				if (spinnerTimer) {
					clearInterval(spinnerTimer);
					spinnerTimer = null;
				}
			}
		}, SPINNER_INTERVAL_MS);
	}

	pi.registerFlag("ugk-ui-off", {
		description: "Disable ugk branded header/footer UI",
		type: "boolean",
		default: false,
	});

	pi.registerCommand("ugk-ui", {
		description: "Toggle ugk branded header/footer UI (on/off/status)",
		handler: async (args, ctx) => {
			let action = args.trim().toLowerCase();
			if (!action && ctx.ui?.select) {
				const options = ugkUiMenuOptions();
				const selection = await ctx.ui.select("UGK UI", options);
				if (!selection || selection === options[3]) return;
				if (selection === options[0]) action = "status";
				if (selection === options[1]) action = "off";
				if (selection === options[2]) action = "on";
			}
			if (!action) action = "status";
			if (action === "on" || action === "enable") {
				enabled = true;
				applyBrandUi(pi, ctx);
				ctx.ui.notify(uiText("UGK UI 已开启", "UGK UI enabled"), "info");
				return;
			}
			if (action === "off" || action === "disable") {
				enabled = false;
				stopSpinnerTitle(ctx);
				clearBrandUi(ctx);
				ctx.ui.notify(uiText("UGK UI 已关闭", "UGK UI disabled"), "info");
				return;
			}
			ctx.ui.notify(uiText(`UGK UI 当前已${enabled ? "开启" : "关闭"}。使用 /ugk-ui on 或 /ugk-ui off。`, `UGK UI is ${enabled ? "enabled" : "disabled"}. Use /ugk-ui on or /ugk-ui off.`), "info");
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		const disabledByFlag = pi.getFlag("ugk-ui-off") === true;
		if (disabledByFlag || (envDisablesBrandUi() && !envEnablesBrandUi()) || !enabled) {
			clearBrandUi(ctx);
			return;
		}
		enabled = true;
		clearStartupScreen(ctx);
		applyBrandUi(pi, ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		stopSpinnerTitle(ctx);
		clearBrandUi(ctx);
	});

	// ponytail: spinner 动画驱动(原 ui-titlebar 职责并入)。工作态盲文帧 + ugk 标题,
	// 结束恢复静态 ugk 标题。off 时 startSpinnerTitle 直接 return,不抢 title。
	pi.on("agent_start", async (_event, ctx) => {
		startSpinnerTitle(ctx);
	});

	pi.on("agent_end", async (_event, ctx) => {
		stopSpinnerTitle(ctx);
	});
}
