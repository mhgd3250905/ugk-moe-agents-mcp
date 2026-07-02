/**
 * TUI → 市场 CLI 授权(市场网站中转 GitHub OAuth)。
 *
 * 设计见 docs/design/2026-07-01-task-publish-from-tui.md §3。
 * TUI 不直接碰 GitHub:终端生成 challenge → POST /api/cli/auth/start →
 * 用户浏览器登录(复用市场已有 OAuth)→ 终端轮询 /api/cli/auth/poll 拿 cli_token。
 * cli_token 存本地 task-share.json,后续上传带 Authorization: Bearer。
 *
 * 复用 settings-io.ts 的 DI + BOM-safe 读写模式(同一 agent 目录,同类配置文件)。
 */

import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { stripBom } from "../shared/settings-io.ts";

/** 本地存储的授权凭证。 */
export interface TaskShareConfig {
	token: string | null;
	login: string | null;
	/** 写死默认市场地址;允许 override 便于测试/自托管。 */
	marketplaceUrl: string;
	/** 授权进行中暂存,拿到 token 后置 null。 */
	challenge: string | null;
}

/** 可注入依赖(便于单测,不碰真实文件系统/网络/进程)。 */
export interface TaskShareAuthDeps {
	agentDir?: string;
	exists?: (p: string) => boolean;
	readFile?: (p: string) => string;
	writeFile?: (p: string, c: string) => void;
	mkdir?: (p: string, o: { recursive: true }) => void;
	fetchFn?: typeof fetch;
	spawnFn?: typeof spawn;
}

const DEFAULT_MARKETPLACE_URL = "https://ugk-task-share.pages.dev";

export function taskShareConfigPath(deps: TaskShareAuthDeps = {}): string {
	const agentDir = deps.agentDir ?? (process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent"));
	return path.join(agentDir, "task-share.json");
}

/** 读 task-share.json;不存在返回未授权的默认 config。 */
export function readTaskShareConfig(deps: TaskShareAuthDeps = {}): TaskShareConfig {
	const filePath = taskShareConfigPath(deps);
	const exists = deps.exists ?? ((p: string) => fs.existsSync(p));
	const readFile = deps.readFile ?? ((p: string) => fs.readFileSync(p, "utf8"));
	const fallback: TaskShareConfig = { token: null, login: null, marketplaceUrl: DEFAULT_MARKETPLACE_URL, challenge: null };
	if (!exists(filePath)) return fallback;
	try {
		const parsed = JSON.parse(stripBom(readFile(filePath)));
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return fallback;
		return {
			token: typeof parsed.token === "string" ? parsed.token : null,
			login: typeof parsed.login === "string" ? parsed.login : null,
			marketplaceUrl: typeof parsed.marketplaceUrl === "string" ? parsed.marketplaceUrl : DEFAULT_MARKETPLACE_URL,
			challenge: typeof parsed.challenge === "string" ? parsed.challenge : null,
		};
	} catch {
		return fallback;
	}
}

/**
 * 写 task-share.json(整体覆盖,配置极简无需读-改-写)。
 * cli_token 是长期 Bearer 凭证,等同密码,生产路径用 0600 权限收紧
 * (review L1:默认 0644 同机其他用户可读)。Windows 的 chmod 会忽略,
 * 无害;Unix 生效。DI 的 writeFile 只验内容,不走真实 fs 故不受影响。
 */
export function writeTaskShareConfig(config: TaskShareConfig, deps: TaskShareAuthDeps = {}): void {
	const filePath = taskShareConfigPath(deps);
	const isProd = !deps.writeFile;
	const writeFile = deps.writeFile ?? ((p: string, c: string) => fs.writeFileSync(p, c, { mode: 0o600 }));
	const mkdir = deps.mkdir ?? ((p: string, o: { recursive: true }) => fs.mkdirSync(p, o));
	mkdir(path.dirname(filePath), { recursive: true });
	writeFile(filePath, `${JSON.stringify(config, null, 2)}\n`);
	// 只在生产真实 fs 路径补权限(DI 单测注入的 writeFile 无此选项)。
	if (isProd) { try { fs.chmodSync(filePath, 0o600); } catch { /* Windows/no-op */ } }
}

/** 生成 32 字节随机 challenge(hex 编码 → 64 字符)。 */
export function generateChallenge(): string {
	return randomBytes(32).toString("hex");
}

/** 平台无关打开浏览器;失败不抛(调用方已显示 URL 兜底)。 */
export function openBrowser(url: string, deps: TaskShareAuthDeps = {}): void {
	const spawnFn = deps.spawnFn ?? spawn;
	const cmd = process.platform === "win32" ? "cmd" : process.platform === "darwin" ? "open" : "xdg-open";
	const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
	try {
		spawnFn(cmd, args, { detached: true, stdio: "ignore" }).unref();
	} catch {
		// 静默失败:TUI 已显示 URL,用户手动打开。
	}
}

export interface CliAuthResult {
	ok: true;
	config: TaskShareConfig;
}

/**
 * 完整授权流程(无 token 时调用):
 * 1. 生成 challenge → POST /api/cli/auth/start
 * 2. 显示并尝试自动打开授权 URL
 * 3. 轮询 /api/cli/auth/poll 拿 cli_token
 * 4. 存 task-share.json
 *
 * @param notify 进度回调(把 URL / 状态刷给 TUI 用户)
 * @throws Error 授权失败/超时
 */
export async function ensureCliAuth(
	notify: (message: string, level: "info" | "warning") => void,
	deps: TaskShareAuthDeps = {},
	timeoutMs = 120000,
	intervalMs = 2000,
): Promise<CliAuthResult> {
	const fetchFn = deps.fetchFn ?? fetch;
	const config = readTaskShareConfig(deps);
	const challenge = generateChallenge();

	const startRes = await fetchFn(`${config.marketplaceUrl}/api/cli/auth/start`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ challenge }),
	});
	if (!startRes.ok) throw new Error(`授权启动失败 (${startRes.status})`);
	const startBody = await startRes.json();
	const authUrl = String(startBody.url ?? `${config.marketplaceUrl}/cli-auth?c=${challenge}`);

	notify(`首次上传需要授权。请在浏览器打开:\n${authUrl}\n等待授权中...(浏览器登录后会自动继续)`, "info");
	openBrowser(authUrl, deps);

	// 写入进行中的 challenge(崩溃恢复时可看到上次状态)。
	writeTaskShareConfig({ ...config, challenge }, deps);

	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const res = await fetchFn(`${config.marketplaceUrl}/api/cli/auth/poll`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ challenge }),
		});
		const data = await res.json().catch(() => ({}));
		if (data.status === "ok") {
			// review M4: validate token shape (createCliToken emits uuid-minus-
			// dashes = 32 hex). A malformed/empty token must NOT be stored — every
			// later submit would 401 with an opaque "invalid_token". status:ok with
			// a bad token means the server misbehaved; fail fast, don't keep polling.
			const tok = typeof data.token === "string" && /^[0-9a-f]{32}$/.test(data.token) ? data.token : null;
			if (!tok) throw new Error("授权异常:服务端返回的 token 格式无效,请重新执行 /task publish");
			const finalConfig: TaskShareConfig = {
				token: tok,
				login: typeof data.login === "string" ? data.login : null,
				marketplaceUrl: config.marketplaceUrl,
				challenge: null,
			};
			writeTaskShareConfig(finalConfig, deps);
			notify(`✅ 授权成功${finalConfig.login ? `(已登录为 ${finalConfig.login})` : ""}`, "info");
			return { ok: true, config: finalConfig };
		}
		if (data.status === "error") throw new Error(`授权失败:${String(data.error ?? "unknown")}`);
		await new Promise((r) => setTimeout(r, intervalMs));
	}
	throw new Error("授权超时(120 秒内未完成浏览器登录),请重新执行 /task publish");
}
