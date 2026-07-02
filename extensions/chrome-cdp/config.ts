import os from "node:os";
import path from "node:path";
import { readSettingsJson, updateSettingsJson } from "../shared/settings-io.ts";
import { suppressConfirmation } from "../shared/autopilot.ts";
import { uiText } from "../shared/ui-language.ts";

export type ChromeCdpMode = "off" | "ask" | "on";
export type ChromeCdpAction = "status" | "tabs" | "launch" | "navigate" | "evaluate" | "screenshot";

export interface ChromeCdpState {
	mode: ChromeCdpMode;
	sessionAllowed: boolean;
	runtimePort?: number;
	envPort?: number;
	// ponytail: per-worker 会话 tab。worker 进程从 env UGK_CDP_TAB_ID 读到(main 进程的 tab-session.ts 注入),
	// 作为 navigate/evaluate/screenshot 的默认 target,避免并行 worker 抢 tabs[0]。
	sessionTabId?: string;
}

export interface ChromeCdpPolicyRequest {
	action: ChromeCdpAction;
	url?: string;
	reason: string;
	normalAccessAttempted: boolean;
}

export type ChromeCdpPolicyResult =
	| { allowed: true; requiresConfirmation: boolean; reason?: undefined }
	| { allowed: false; requiresConfirmation: false; reason: string };

const DEFAULT_PORT = 9222;

export interface ChromeCdpPortDeps {
	agentDir?: string;
	exists?: (p: string) => boolean;
	readFile?: (p: string) => string;
	writeFile?: (p: string, content: string) => void;
	mkdir?: (p: string, opts: { recursive: true }) => void;
}

function parsePort(value: unknown): number | undefined {
	if (typeof value === "string" && value.trim()) {
		const parsed = Number(value);
		return Number.isInteger(parsed) && parsed > 0 && parsed <= 65535 ? parsed : undefined;
	}
	if (typeof value === "number" && Number.isInteger(value) && value > 0 && value <= 65535) {
		return value;
	}
	return undefined;
}

export function resolveUgkSettingsPath(deps: ChromeCdpPortDeps = {}): string {
	return path.join(deps.agentDir ?? (process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent")), "settings.json");
}

export function readPersistedCdpPort(deps: ChromeCdpPortDeps = {}): number | undefined {
	// BOM-safe 读取(见 shared/settings-io.ts):旧实现裸 JSON.parse 遇 BOM 会失败,
	// 导致持久化端口读不到、回退默认 9222。
	const settings = readSettingsJson(deps);
	return parsePort(settings?.cdpPort);
}

export function persistCdpPort(port: number, deps: ChromeCdpPortDeps = {}): void {
	// BOM-safe 读-改-写(见 shared/settings-io.ts):值相同则跳过,写回不带 BOM。
	updateSettingsJson({ cdpPort: port }, deps);
}

export function createChromeCdpState(
	env: Record<string, string | undefined> = process.env,
	deps: ChromeCdpPortDeps = {},
): ChromeCdpState {
	const persistedPort = readPersistedCdpPort(deps);
	if (persistedPort && env === process.env) process.env.UGK_CDP_PORT = String(persistedPort);
	return {
		mode: "ask",
		sessionAllowed: env.UGK_TASK_ALLOW_CHROME_CDP === "1",
		runtimePort: persistedPort,
		envPort: parsePort(env.UGK_CDP_PORT),
		sessionTabId: env.UGK_CDP_TAB_ID,
	};
}

export function setChromeCdpMode(state: ChromeCdpState, mode: ChromeCdpMode): void {
	state.mode = mode;
	clearChromeCdpSessionAllow(state);
}

export function grantChromeCdpSessionAllow(state: ChromeCdpState): void {
	state.sessionAllowed = true;
}

export function clearChromeCdpSessionAllow(state: ChromeCdpState): void {
	state.sessionAllowed = false;
}

export function setChromeCdpPort(state: ChromeCdpState, port: number, deps: ChromeCdpPortDeps = {}): void {
	const parsed = parsePort(port);
	if (!parsed) throw new Error(`Invalid CDP port: ${port}`);
	state.runtimePort = parsed;
	process.env.UGK_CDP_PORT = String(parsed);
	persistCdpPort(parsed, deps);
}

export function resolveChromeCdpPort(state: ChromeCdpState, params: { port?: number }): number {
	return parsePort(params.port) ?? state.runtimePort ?? state.envPort ?? DEFAULT_PORT;
}

/**
 * 解析最终 target。显式 params.target 永远压过会话 tab(不破坏 agent 主动指定 tab 的能力);
 * 两者都没有时返回 undefined,client.ts 的 findTab 再 fallback 到 tabs[0](保持旧行为)。
 */
export function resolveChromeCdpTarget(state: ChromeCdpState, params: { target?: string }): string | undefined {
	return params.target ?? state.sessionTabId;
}

export function checkChromeCdpPolicy(
	state: ChromeCdpState,
	request: ChromeCdpPolicyRequest,
): ChromeCdpPolicyResult {
	if (request.action === "status") {
		return { allowed: true, requiresConfirmation: false };
	}

	if (state.mode === "off") {
		return {
			allowed: false,
			requiresConfirmation: false,
			reason: uiText("Chrome CDP 已关闭。请让用户运行 /cdp ask 或 /cdp on。", "Chrome CDP is off. Ask the user to run /cdp ask or /cdp on."),
		};
	}

	if (request.action === "launch") {
		return { allowed: true, requiresConfirmation: false };
	}

	if (!request.normalAccessAttempted && !/local chrome|cdp|devtools|logged-in|logged in/i.test(request.reason)) {
		return {
			allowed: false,
			requiresConfirmation: false,
			reason: uiText("Chrome CDP 仅用于普通访问不足时的本机已登录 Chrome 访问。", "Chrome CDP is only for local logged-in Chrome access when ordinary access is insufficient."),
		};
	}

	return {
		allowed: true,
		// autopilot on 时,ask 模式的确认被短路为直接放行(见 shared/autopilot.ts)。
		requiresConfirmation: suppressConfirmation(state.mode === "ask" && !state.sessionAllowed),
	};
}
