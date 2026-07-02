import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findCommandOnPath } from "../shared/binary.ts";

export interface ChromeLaunchCommand {
	command: string;
	args: string[];
	profilePath: string;
}

export interface ChromeBinaryResolution {
	found: boolean;
	command: string;
}

export function getDefaultChromeProfilePath(homeDir = os.homedir()): string {
	return path.join(homeDir, ".ugk", "chrome-cdp-profile");
}

// Windows 上 Chrome 可能装在 Program Files / Program Files (x86) / 用户目录,按顺序找
function findWindowsChrome(): string | null {
	const candidates = [
		path.join(process.env.PROGRAMFILES ?? "C:\\Program Files", "Google", "Chrome", "Application", "chrome.exe"),
		path.join(
			process.env["PROGRAMFILES(X86)"] ?? "C:\\Program Files (x86)",
			"Google",
			"Chrome",
			"Application",
			"chrome.exe",
		),
		path.join(
			process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"),
			"Google",
			"Chrome",
			"Application",
			"chrome.exe",
		),
	];
	for (const c of candidates) {
		try {
			if (fs.existsSync(c)) return c;
		} catch {
			/* 忽略权限/路径错误,继续找下一个 */
		}
	}
	return null;
}

export function resolveChromeBinary(options: {
	platform?: NodeJS.Platform;
	env?: NodeJS.ProcessEnv;
} = {}): ChromeBinaryResolution {
	const platform = options.platform ?? process.platform;
	if (platform === "darwin") {
		const command = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
		return { command, found: fs.existsSync(command) };
	}
	if (platform === "win32") {
		const installed = findWindowsChrome();
		if (installed) return { command: installed, found: true };
		const onPath = findCommandOnPath("chrome.exe", options.env);
		return { command: onPath ?? "chrome.exe", found: Boolean(onPath) };
	}
	const onPath = findCommandOnPath("google-chrome", options.env);
	return { command: onPath ?? "google-chrome", found: Boolean(onPath) };
}

export function getChromeLaunchCommand(options: {
	port: number;
	homeDir?: string;
	platform?: NodeJS.Platform;
}): ChromeLaunchCommand {
	const profilePath = getDefaultChromeProfilePath(options.homeDir);
	const platform = options.platform ?? process.platform;
	let command: string;
	if (platform === "darwin") {
		command = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
	} else if (platform === "win32") {
		command = findWindowsChrome() ?? "chrome.exe"; // 找不到就交给 PATH 兜底
	} else {
		command = "google-chrome";
	}
	return {
		command,
		profilePath,
		args: [`--remote-debugging-port=${options.port}`, `--user-data-dir=${profilePath}`],
	};
}

// ponytail: ugk 自己起的调试 Chrome 的端口登记。agent 退出时按 port 查杀残留进程,
// 避免 --remote-debugging-port + 用户登录态 Chrome 永久驻留(持久攻击面)。
//
// 为什么用 port 而不是 child 句柄:Windows 上 Chrome 的 spawn child 是个 stub 进程,
// 它派生真正的工作进程后会立刻 exit(code=0,实测 ~150ms)。child.on("exit") 一触发
// 就把句柄删了,teardown 时 Set 空、没东西可杀 —— 真正的 Chrome 成孤儿永久残留。
// 真正可靠的锚点是 port:命令行含 --remote-debugging-port=<port> 的 Chrome 都是 ugk 起的,
// 按这个特征查杀能覆盖 stub-exit 后的所有工作进程(主进程 + renderer/gpu/crashpad 整棵树)。
const managedChromePorts = new Set<number>();
let teardownHookInstalled = false;

// ponytail: 按 port 杀所有命令行含 --remote-debugging-port=<port> 的 Chrome 进程整棵树。
// Windows:PowerShell 查进程 + taskkill /T 杀树;Unix:pgrep -f 查 + kill。
// 这些命令都同步、best-effort,失败(进程已退/查不到)不抛。
function killChromeByPort(port: number): void {
	try {
		if (process.platform === "win32") {
			// 查所有 chrome.exe 命令行含 --remote-debugging-port=<port> 的 PID,逐个 taskkill /T。
			const r = spawnSync("powershell", [
				"-NoProfile", "-Command",
				`Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | ` +
					`Where-Object { $_.CommandLine -match '--remote-debugging-port=${port}' } | ` +
					`ForEach-Object { $_.ProcessId }`,
			], { windowsHide: true, encoding: "utf8" });
			const pids = (r.stdout || "").split(/\s+/).map((s) => Number(s)).filter((n) => n > 0);
			for (const pid of pids) {
				try { spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }); } catch {}
			}
		} else {
			// pgrep -f 全命令行匹配;kill 整组。best-effort。
			const r = spawnSync("pgrep", ["-f", `--remote-debugging-port=${port}`], { encoding: "utf8" });
			const pids = (r.stdout || "").split(/\s+/).map((s) => Number(s)).filter((n) => n > 0);
			for (const pid of pids) {
				try { process.kill(pid, "SIGTERM"); } catch {}
			}
		}
	} catch { /* best-effort:查/杀失败忽略 */ }
}

// ponytail: test override —— 让测试注入 fake(避免真查/杀系统进程),
// 验证 teardown 是否对每个登记的 port 都调了 killChromeByPort。
let killChromeByPortImpl: (port: number) => void = killChromeByPort;

function teardownManagedChrome(): void {
	for (const port of managedChromePorts) {
		killChromeByPortImpl(port);
	}
	managedChromePorts.clear();
}

function ensureTeardownHook(): void {
	if (teardownHookInstalled) return;
	teardownHookInstalled = true;
	// beforeExit:Node 事件循环空了准备退出(正常退出路径)。
	// exit:进程即将退出(同步,最后兜底)。
	process.once("beforeExit", teardownManagedChrome);
	process.once("exit", teardownManagedChrome);
	// ponytail: 信号退出。Windows 无真实 SIGTERM/SIGKILL,但 Git Bash 下 SIGINT(Ctrl+C)可捕获。
	// 注册失败(已被占用/平台不支持)不阻塞 launch 主流程。
	try {
		process.once("SIGINT", () => { teardownManagedChrome(); process.exit(130); });
		process.once("SIGTERM", () => { teardownManagedChrome(); process.exit(143); });
	} catch { /* 信号 hook 注册失败忽略 */ }
}

export function launchChromeCdp(port: number): string {
	const { command, args, profilePath } = getChromeLaunchCommand({ port });
	try {
		// 绝对路径直接走 CreateProcess;只有 PATH 兜底(chrome.exe)时才需要 shell 解析
		const useShell = !path.isAbsolute(command);
		const child = spawn(command, args, {
			detached: true,
			stdio: "ignore",
			shell: useShell,
		});
		child.unref();
		// ponytail: child 句柄不可靠(Chrome stub 会立刻 exit),真正回收靠 port 查杀。
		// 这里只登记 port + 装 hook;child 不进 Set。
		managedChromePorts.add(port);
		ensureTeardownHook();
		return `Started Chrome CDP on 127.0.0.1:${port}\nProfile: ${profilePath}\nBinary: ${command}`;
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		throw new Error(
			`Failed to launch Chrome CDP: ${msg}\nLooked for: ${command}\nTry setting CHROME_PATH env var or installing Chrome.`,
		);
	}
}

// ponytail: 测试专用导出。不真 spawn Chrome,验证 port 登记 + teardown 查杀语义。
// killChromeByPort 导出:端到端测试直接验证"按 port 杀 Chrome 进程"的系统行为。
export const __testOnly = {
	get managedPorts(): Set<number> { return managedChromePorts; },
	teardown: teardownManagedChrome,
	killChromeByPort,
	resetTeardownHook(): void { teardownHookInstalled = false; },
	setKillImpl(fn: (port: number) => void): () => void {
		const prev = killChromeByPortImpl;
		killChromeByPortImpl = fn;
		return () => { killChromeByPortImpl = prev; };
	},
};

export interface ChromeCdpReadinessResult {
	ready: boolean;
	elapsedMs: number;
	error?: string;
}

// launch 后轮询 /json/version,直到 Chrome 真的能接连接或超时。
// 解决"spawn 完立刻 fetch → fetch failed"的启动竞态。
export async function waitForChromeCdpReady(options: {
	port: number;
	fetchImpl?: typeof fetch;
	timeoutMs?: number;
	intervalMs?: number;
}): Promise<ChromeCdpReadinessResult> {
	const { port, fetchImpl = fetch, timeoutMs = 15000, intervalMs = 250 } = options;
	const deadline = Date.now() + timeoutMs;
	let lastError = "";
	while (Date.now() < deadline) {
		try {
			const res = await fetchImpl(`http://127.0.0.1:${port}/json/version`);
			if (res.ok) {
				return { ready: true, elapsedMs: timeoutMs - (deadline - Date.now()) };
			}
			lastError = `HTTP ${res.status}`;
		} catch (err) {
			lastError = err instanceof Error ? err.message : String(err);
		}
		await new Promise((r) => setTimeout(r, intervalMs));
	}
	return { ready: false, elapsedMs: timeoutMs, error: lastError };
}

export async function launchChromeCdpAndWait(port: number): Promise<string> {
	const message = launchChromeCdp(port);
	const readiness = await waitForChromeCdpReady({ port });
	if (readiness.ready) {
		return `${message}\nReady (waited ${readiness.elapsedMs}ms).`;
	}
	return `${message}\nNot yet reachable after ${readiness.timeoutMs ?? 15000}ms (${readiness.error}). Chrome may still be starting — retry /cdp status in a moment.`;
}
