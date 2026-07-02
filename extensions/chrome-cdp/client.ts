import fs from "node:fs";
import path from "node:path";

export interface ChromeTab {
	id: string;
	type: string;
	title?: string;
	url?: string;
	webSocketDebuggerUrl?: string;
}

export interface ChromeCdpClient {
	port: number;
	fetch: typeof fetch;
	WebSocket: typeof WebSocket;
}

export interface ChromeCdpStatus {
	online: boolean;
	port: number;
	tabs?: ChromeTab[];
	error?: string;
}

export function createChromeCdpClient(options: {
	port: number;
	fetch?: typeof fetch;
	WebSocket?: typeof WebSocket;
}): ChromeCdpClient {
	return {
		port: options.port,
		fetch: options.fetch ?? fetch,
		WebSocket: options.WebSocket ?? WebSocket,
	};
}

function endpoint(client: ChromeCdpClient, route: string): string {
	return `http://127.0.0.1:${client.port}${route}`;
}

export async function listChromeTabs(client: ChromeCdpClient): Promise<ChromeTab[]> {
	const response = await client.fetch(endpoint(client, "/json/list"));
	if (!response.ok) throw new Error(`Chrome CDP returned HTTP ${response.status}`);
	const targets = (await response.json()) as ChromeTab[];
	return targets.filter((target) => target.type === "page" && target.webSocketDebuggerUrl);
}

export async function getChromeCdpStatus(client: ChromeCdpClient): Promise<ChromeCdpStatus> {
	try {
		const tabs = await listChromeTabs(client);
		return { online: true, port: client.port, tabs };
	} catch (error) {
		return {
			online: false,
			port: client.port,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

async function findTab(client: ChromeCdpClient, target?: string): Promise<ChromeTab> {
	const tabs = await listChromeTabs(client);
	const tab =
		(target
			? tabs.find((item) => item.id === target || item.url?.includes(target) || item.title?.includes(target))
			: tabs[0]) ?? null;
	if (!tab?.webSocketDebuggerUrl) {
		throw new Error(`Chrome tab not found${target ? `: ${target}` : ""}`);
	}
	return tab;
}

function sendCdpCommand(
	WebSocketCtor: typeof WebSocket,
	webSocketUrl: string,
	method: string,
	params: Record<string, unknown>,
	timeoutMs = 10000,
	signal?: AbortSignal,
): Promise<any> {
	// ponytail: 钳位 1s~5min。下限防 0/负数立即触发(等于没超时保护);上限防 LLM 乱传
	// 天文数字让 evaluate 长时间挂起占用 CDP tab/worker 进程。5min 够任何滚动循环。
	const clampedTimeoutMs = Math.min(Math.max(timeoutMs, 1000), 300000);
	// 已 abort 直接拒,不建 WebSocket(避免无谓连接)。
	if (signal?.aborted) return Promise.reject(abortError());
	return new Promise((resolve, reject) => {
		const socket = new WebSocketCtor(webSocketUrl);
		const id = 1;
		const cleanup = () => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
		};
		const timer = setTimeout(() => {
			try { socket.close(); } catch {}
			signal?.removeEventListener("abort", onAbort);
			reject(new Error(`Timed out waiting for CDP response: ${method}`));
		}, clampedTimeoutMs);
		// ponytail: ESC 中断走 pi 的 agent.signal(execute 第3参数)。signal abort 时立即 close socket
		// + reject AbortError,让卡在长 evaluate 的 CDP 调用瞬间返回,不再等它自己跑完/超时。
		const onAbort = () => {
			clearTimeout(timer);
			try { socket.close(); } catch {}
			reject(abortError());
		};
		signal?.addEventListener("abort", onAbort, { once: true });

		socket.onopen = () => {
			socket.send(JSON.stringify({ id, method, params }));
		};
		socket.onerror = (event) => {
			cleanup();
			reject(new Error(`CDP WebSocket error: ${String(event)}`));
		};
		socket.onmessage = (event) => {
			// ponytail: Chrome 发来的帧理论上是合法 JSON,但畸形帧(多帧拼接/二进制/协议错)
			// 会让 JSON.parse 抛出。无 try/catch 时 cleanup() 不会执行、timer 不清、socket 不关,
			// promise 挂起到 timeout(最长 5min)。parse 失败立即 cleanup + reject,不挂起。
			let message: any;
			try {
				message = JSON.parse(String(event.data));
			} catch {
				cleanup();
				try { socket.close(); } catch {}
				reject(new Error(`CDP returned malformed message: ${String(event.data).slice(0, 200)}`));
				return;
			}
			if (message.id !== id) return;
			cleanup();
			socket.close();
			if (message.error) {
				reject(new Error(message.error.message || `CDP command failed: ${method}`));
				return;
			}
			resolve(message.result);
		};
	});
}

function abortError(): Error {
	const err = new Error("chrome_cdp operation aborted");
	err.name = "AbortError";
	return err;
}

export async function navigateChromeTab(client: ChromeCdpClient, target: string | undefined, url: string, signal?: AbortSignal) {
	const tab = await findTab(client, target);
	return sendCdpCommand(client.WebSocket, tab.webSocketDebuggerUrl!, "Page.navigate", { url }, 10000, signal);
}

export async function evaluateChromeExpression(
	client: ChromeCdpClient,
	target: string | undefined,
	expression: string,
	timeoutMs?: number,
	signal?: AbortSignal,
) {
	const tab = await findTab(client, target);
	const result = await sendCdpCommand(
		client.WebSocket,
		tab.webSocketDebuggerUrl!,
		"Runtime.evaluate",
		{
			expression,
			returnByValue: true,
			awaitPromise: true,
		},
		// ponytail: evaluate 含 awaitPromise:true,页面内 async(反爬 sleep/滚动循环)也受此超时罩着。
		// 默认 10s 对短操作够用;长循环(30 轮滚动抓取)显式传大值,让整个循环在一个 evaluate 内跑完。
		// 不设上限——调用方负责合理值(CDP 本身有连接级超时兜底)。
		timeoutMs,
		signal,
	);
	return result.result;
}

export async function captureChromeScreenshot(client: ChromeCdpClient, target: string | undefined, filePath: string, signal?: AbortSignal) {
	const tab = await findTab(client, target);
	const result = await sendCdpCommand(client.WebSocket, tab.webSocketDebuggerUrl!, "Page.captureScreenshot", {
		format: "png",
		fromSurface: true,
	}, 10000, signal);
	const data = Buffer.from(String(result.data || ""), "base64");
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, data);
	return { path: filePath, bytes: data.length };
}

/**
 * 新建一个 Chrome tab(Chrome 原生 HTTP 端点 PUT /json/new)。返回新 tab 描述符(含 id)。
 * 用于 per-worker tab 隔离:每个 worker spawn 前开一个专属 tab,避免并行 worker 抢 tabs[0]。
 */
export async function createChromeTab(client: ChromeCdpClient, url?: string): Promise<ChromeTab> {
	const route = url ? `/json/new?${encodeURIComponent(url)}` : "/json/new";
	const response = await client.fetch(endpoint(client, route), { method: "PUT" });
	if (!response.ok) throw new Error(`Chrome CDP /json/new returned HTTP ${response.status}`);
	return (await response.json()) as ChromeTab;
}

/**
 * 关闭一个 Chrome tab(Chrome 原生 HTTP 端点 GET /json/close/<id>)。best-effort。
 * ponytail: 不检查返回。失败说明 tab 已没了或 Chrome 重启 —— 不该阻塞 worker 回收。
 */
export async function closeChromeTab(client: ChromeCdpClient, targetId: string): Promise<void> {
	await client.fetch(endpoint(client, `/json/close/${targetId}`), { method: "GET" });
}
