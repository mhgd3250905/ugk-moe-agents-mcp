import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	captureChromeScreenshot,
	createChromeCdpClient,
	evaluateChromeExpression,
	getChromeCdpStatus,
	listChromeTabs,
	navigateChromeTab,
	type ChromeTab,
} from "./client.ts";
import {
	checkChromeCdpPolicy,
	createChromeCdpState,
	grantChromeCdpSessionAllow,
	resolveChromeCdpPort,
	resolveChromeCdpTarget,
	setChromeCdpMode,
	setChromeCdpPort,
	type ChromeCdpAction,
	type ChromeCdpState,
} from "./config.ts";
import { formatChromeCdpStatus, formatChromeTabs } from "./formatter.ts";
import { launchChromeCdpAndWait } from "./launcher.ts";
import { makeCdpTabLifecycle } from "./tab-session.ts";
import { setWorkerLifecycleFactory } from "../shared/worker-lifecycle.ts";
import { uiText } from "../shared/ui-language.ts";

type ToolResult = { content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> };
type ChromeCdpConfirmation = "allow-once" | "allow-session" | "deny";

function chromeCdpConfirmOptions(): string[] {
	return uiText(["允许一次", "本会话允许", "拒绝"], ["Allow once", "Allow for session", "Deny"]);
}

function cdpMenuOptions(): string[] {
	return uiText(
		["查看状态", "查看标签页", "启动 Chrome", "Mode: ask", "Mode: on", "Mode: off", "设置端口", "退出"],
		["Status", "View tabs", "Launch Chrome", "Mode: ask", "Mode: on", "Mode: off", "Set port", "Exit"],
	);
}

export interface ChromeCdpDeps {
	getStatus?: (port: number) => Promise<Awaited<ReturnType<typeof getChromeCdpStatus>>>;
	listTabs?: (port: number) => Promise<ChromeTab[]>;
	navigate?: (port: number, target: string | undefined, url: string, signal?: AbortSignal) => Promise<unknown>;
	evaluate?: (port: number, target: string | undefined, expression: string, timeoutMs?: number, signal?: AbortSignal) => Promise<unknown>;
	screenshot?: (port: number, target: string | undefined, path: string, signal?: AbortSignal) => Promise<unknown>;
	launch?: (port: number) => Promise<string>;
}
function textResult(text: string, details: Record<string, unknown> = {}): ToolResult {
	return { content: [{ type: "text", text }], details };
}

function defaultDeps(): Required<ChromeCdpDeps> {
	return {
		getStatus: async (port) => getChromeCdpStatus(createChromeCdpClient({ port })),
		listTabs: async (port) => listChromeTabs(createChromeCdpClient({ port })),
		navigate: async (port, target, url, signal) => navigateChromeTab(createChromeCdpClient({ port }), target, url, signal),
		evaluate: async (port, target, expression, timeoutMs, signal) =>
			evaluateChromeExpression(createChromeCdpClient({ port }), target, expression, timeoutMs, signal),
		screenshot: async (port, target, filePath, signal) =>
			captureChromeScreenshot(createChromeCdpClient({ port }), target, filePath, signal),
		launch: async (port) => launchChromeCdpAndWait(port),
	};
}

async function confirmChromeCdpUse(ctx: any, params: any): Promise<ChromeCdpConfirmation> {
	if (!ctx.hasUI) return "deny";
	const prompt = [
		uiText("允许 Chrome CDP?", "Allow Chrome CDP?"),
		"",
		[
			uiText("agent 想控制你本机已登录的 Chrome 会话。", "The agent wants to control your local logged-in Chrome session."),
			params.url ? `URL: ${params.url}` : params.target ? `Target: ${params.target}` : "",
			uiText(`原因: ${params.reason}`, `Reason: ${params.reason}`),
			uiText("是否允许这次浏览器操作?", "Allow this browser operation?"),
		]
			.filter(Boolean)
			.join("\n"),
	]
		.filter(Boolean)
		.join("\n");

	if (ctx.ui?.select) {
		const options = chromeCdpConfirmOptions();
		const choice = await ctx.ui.select(prompt, options);
		if (choice === options[1]) return "allow-session";
		if (choice === options[0]) return "allow-once";
		return "deny";
	}

	if (!ctx.ui?.confirm) return "deny";
	return (await ctx.ui.confirm(
		uiText("允许 Chrome CDP?", "Allow Chrome CDP?"),
		[
			uiText("agent 想控制你本机已登录的 Chrome 会话。", "The agent wants to control your local logged-in Chrome session."),
			params.url ? `URL: ${params.url}` : params.target ? `Target: ${params.target}` : "",
			uiText(`原因: ${params.reason}`, `Reason: ${params.reason}`),
			uiText("是否允许这次浏览器操作?", "Allow this browser operation?"),
		]
			.filter(Boolean)
			.join("\n"),
	))
		? "allow-once"
		: "deny";
}

function createChromeCdpTool(state: ChromeCdpState, deps: Required<ChromeCdpDeps>) {
	return defineTool({
		name: "chrome_cdp",
		label: "Chrome CDP",
		description:
			"Use only when the user explicitly wants to control their local logged-in Chrome session, or when normal network access cannot reach the target because it requires cookies, SSO, CAPTCHA, private workspace state, or an existing browser login. Do not use for public web search, ordinary documentation lookup, normal HTTP requests, or pages accessible through bash/fetch/browser-free methods.",
		promptSnippet:
			"chrome_cdp controls a local logged-in Chrome session through CDP only after ordinary access is insufficient or the user explicitly requests local Chrome.",
		promptGuidelines: [
			"Do not use chrome_cdp for public web search, documentation lookup, or pages accessible through normal network tools.",
			"Use chrome_cdp only for local logged-in Chrome state, SSO, CAPTCHA, cookies, private workspace pages, or explicit user requests.",
			"Before using chrome_cdp, explain why ordinary access is insufficient and pass reason plus normalAccessAttempted.",
		],
		parameters: Type.Object({
			action: Type.Union(
				[
					Type.Literal("status"),
					Type.Literal("launch"),
					Type.Literal("tabs"),
					Type.Literal("navigate"),
					Type.Literal("evaluate"),
					Type.Literal("screenshot"),
				],
				{ description: "status, launch, tabs, navigate, evaluate, or screenshot" },
			),
			port: Type.Optional(Type.Number({ description: "Local CDP port. Defaults to /cdp port, UGK_CDP_PORT, then 9222." })),
			target: Type.Optional(Type.String({ description: "Tab id, URL substring, or title substring." })),
			url: Type.Optional(Type.String({ description: "URL for navigate." })),
			expression: Type.Optional(Type.String({ description: "JavaScript expression for evaluate." })),
			timeoutMs: Type.Optional(
				Type.Number({
					description:
						"Optional. CDP response timeout in ms for evaluate. Defaults to 10000. Pass a larger value (e.g. 90000) when the expression runs a long in-page async loop (scroll-and-collect, polling) so the whole loop completes in one call instead of timing out. Other actions ignore this.",
				}),
			),
			path: Type.Optional(Type.String({ description: "Output path for screenshot PNG." })),
			reason: Type.String({ description: "Why CDP is needed for this operation." }),
			normalAccessAttempted: Type.Boolean({
				description: "Whether ordinary network/browser-free access was attempted or reasoned through first.",
			}),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const action = params.action as ChromeCdpAction;
			const policy = checkChromeCdpPolicy(state, {
				action,
				url: params.url,
				reason: params.reason,
				normalAccessAttempted: params.normalAccessAttempted,
			});
			if (!policy.allowed) return textResult(policy.reason, { blocked: true });
			if (policy.requiresConfirmation) {
				const confirmation = await confirmChromeCdpUse(ctx, params);
				if (confirmation === "deny") {
					return textResult(uiText("用户已拒绝 Chrome CDP 请求。", "User denied the Chrome CDP request."), { blocked: true });
				}
				if (confirmation === "allow-session") {
					grantChromeCdpSessionAllow(state);
				}
			}

			const port = resolveChromeCdpPort(state, { port: params.port });
			// ponytail: 显式 params.target 压过 worker 会话 tab;都没有则 undefined(→ client findTab fallback tabs[0])。
			// 与 resolveChromeCdpPort 同形:统一在 execute 层解析,deps 实现不变。
			const target = resolveChromeCdpTarget(state, { target: params.target });
			if (action === "status") {
				const status = await deps.getStatus(port);
				return textResult(formatChromeCdpStatus(status), status as any);
			}
			if (action === "launch") {
				return textResult(await deps.launch(port), { ok: true, port });
			}
			if (action === "tabs") {
				const tabs = await deps.listTabs(port);
				return textResult(formatChromeTabs(tabs), { tabs });
			}
			if (action === "navigate") {
				if (!params.url) return textResult(uiText("navigate 需要 url。", "navigate requires url."), { ok: false });
				const result = await deps.navigate(port, target, params.url, signal);
				return textResult(uiText(`已导航 Chrome 标签页到 ${params.url}`, `Navigated Chrome tab to ${params.url}`), { ok: true, result });
			}
			if (action === "evaluate") {
				if (!params.expression) return textResult(uiText("evaluate 需要 expression。", "evaluate requires expression."), { ok: false });
				const result = await deps.evaluate(port, target, params.expression, params.timeoutMs, signal);
				return textResult(JSON.stringify(result, null, 2), { ok: true, result });
			}
			if (action === "screenshot") {
				if (!params.path) return textResult(uiText("screenshot 需要 path。", "screenshot requires path."), { ok: false });
				const result = await deps.screenshot(port, target, params.path, signal);
				return textResult(uiText(`已保存 Chrome 截图到 ${params.path}`, `Saved Chrome screenshot to ${params.path}`), { ok: true, result });
			}
			return textResult(`未知 chrome_cdp action: ${String(action)}`, { ok: false });
		},
	});
}

export function registerChromeCdp(pi: ExtensionAPI, overrides: ChromeCdpDeps = {}): void {
	const state = createChromeCdpState();
	const deps = { ...defaultDeps(), ...overrides };
	// ponytail: 依赖反转 —— chrome-cdp 把 per-worker tab 生命周期工厂注册到 shared 中立层,
	// task-worker peek 出来用,无需 task/ import chrome-cdp/(架构守卫禁止)。组合根接线点。
	setWorkerLifecycleFactory((port) => makeCdpTabLifecycle(port));

	async function resolveCdpArgs(args: string, ctx: any): Promise<string | undefined> {
		if (args.trim()) return args;
		if (!ctx.ui?.select) return "status";

		const options = cdpMenuOptions();
		const selection = await ctx.ui.select("Chrome CDP", options);
		if (!selection || selection === options[7]) return undefined;
		if (selection === options[0]) return "status";
		if (selection === options[1]) return "tabs";
		if (selection === options[2]) return "launch";
		if (selection === options[3]) return "ask";
		if (selection === options[4]) return "on";
		if (selection === options[5]) return "off";
		if (selection === options[6]) {
			if (!ctx.ui?.input) {
				ctx.ui.notify(uiText("设置端口需要交互输入支持。请使用 /cdp port <1-65535>。", "Setting port needs interactive input. Use /cdp port <1-65535>."), "warning");
				return undefined;
			}
			const port = await ctx.ui.input("Chrome CDP port", "1-65535");
			return port?.trim() ? `port ${port.trim()}` : undefined;
		}
		return undefined;
	}

	pi.registerTool(createChromeCdpTool(state, deps));
	pi.registerCommand("cdp", {
		description: "Configure guarded local Chrome CDP access",
		handler: async (args, ctx) => {
			const resolvedArgs = await resolveCdpArgs(args, ctx);
			if (resolvedArgs === undefined) return;
			const [action, value] = resolvedArgs.trim().split(/\s+/);
			if (!action || action === "status") {
				const port = resolveChromeCdpPort(state, {});
				const status = await deps.getStatus(port);
				ctx.ui.notify(uiText(`CDP 模式: ${state.mode}\n`, `CDP mode: ${state.mode}\n`) + formatChromeCdpStatus(status), "info");
				return;
			}
			if (action === "ask" || action === "on" || action === "off") {
				setChromeCdpMode(state, action);
				ctx.ui.notify(uiText(`Chrome CDP 模式: ${action}`, `Chrome CDP mode: ${action}`), "info");
				return;
			}
			if (action === "port") {
				const port = Number(value);
				try {
					setChromeCdpPort(state, port);
				} catch {
					ctx.ui.notify(uiText(`CDP 端口无效: ${value || "(缺失)"}。请使用 /cdp port <1-65535>。`, `Invalid CDP port: ${value || "(missing)"}. Use /cdp port <1-65535>.`), "warning");
					return;
				}
				ctx.ui.notify(uiText(`Chrome CDP 端口: ${port}`, `Chrome CDP port: ${port}`), "info");
				return;
			}
			if (action === "tabs") {
				const tabs = await deps.listTabs(resolveChromeCdpPort(state, {}));
				ctx.ui.notify(formatChromeTabs(tabs), "info");
				return;
			}
			if (action === "launch") {
				ctx.ui.notify(await deps.launch(resolveChromeCdpPort(state, {})), "info");
				return;
			}
			ctx.ui.notify(uiText("用法: /cdp status|ask|on|off|port <number>|launch|tabs", "Usage: /cdp status|ask|on|off|port <number>|launch|tabs"), "warning");
		},
	});
}

export default function chromeCdpExtension(pi: ExtensionAPI): void {
	registerChromeCdp(pi);
}
