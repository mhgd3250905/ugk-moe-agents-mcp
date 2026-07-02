/**
 * Per-worker CDP tab 生命周期 —— 消除并行 worker 抢同一 Chrome tab 导致的数据错乱。
 *
 * 机制:每个 worker spawn 前由 main 进程代码(subagent.ts 的 runSingleAgent)开一个专属 tab,
 * 把 tabId 注入 env `UGK_CDP_TAB_ID`;worker 进程内的 chrome_cdp 工具读它作默认 target
 * (见 config.ts 的 resolveChromeCdpTarget),不再 fallback 到 tabs[0]。
 * worker 进程 close 后(含 SIGKILL,由 main 的 finally 保证)关掉这个 tab。
 *
 * 边界:本模块只负责 tab 的开/关。target 的"默认绑定"逻辑在 config.ts(它读 env,与 worker 无关)。
 * subagent.ts 只认识 WorkerLifecycle 契约,不认识 chrome-cdp —— 解耦点。
 *
 * 可观测性:每次 open/close/error 写一行到 cdp-tab.log(tail -f 可看实时进度)。
 * 默认开;UGK_CDP_TAB_LOG=0 关。诊断并行隔离问题、Chrome 连接问题的唯一抓手。
 *
 * ponytail: 不做启动时孤儿 tab 扫描。finally 必回收,孤儿只在 main 自身崩溃时残留(概率低)。
 * ceiling:若日后 main 崩溃残留 tab 变多,升级路径是启动时扫 title 前缀关掉(给 worker tab 打标记)。
 */
import { appendFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { WorkerLifecycle } from "../shared/worker-lifecycle.ts";
import { closeChromeTab, createChromeCdpClient, createChromeTab } from "./client.ts";
import { launchChromeCdpAndWait } from "./launcher.ts";

// ponytail: 连接类错误的特征串。命中即"Chrome 没起"(而非 tab 配额/协议错),
// 才值得花一次 autolaunch 去救。
const CDP_CONNECT_ERROR = /fetch failed|ECONNREFUSED|Failed to fetch|NetworkError/i;

// ponytail: autolaunch 默认开 —— taskbook 声明了 chrome_cdp = 用户已知情同意,
// 主进程代为起 CDP 不算越权。UGK_CDP_AUTOLAUNCH=0 关掉,回退到"没起就报错等用户"。
function autolaunchEnabled(): boolean {
	return process.env.UGK_CDP_AUTOLAUNCH !== "0";
}

// ponytail: 简单 appendFileSync + 时间戳前缀,够用。写到 agent 目录下,跨 run 保留,
// worker 子进程也能写(同一文件系统)。要并发/轮转再升级。
function cdpTabLogPath(): string {
	const agentDir = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
	return path.join(agentDir, "logs", "cdp-tab.log");
}

function tabLog(line: string): void {
	// ponytail: 默认开(诊断必须),UGK_CDP_TAB_LOG=0 关。写失败静默(日志不能阻塞主流程)。
	if (process.env.UGK_CDP_TAB_LOG === "0") return;
	try {
		const logPath = cdpTabLogPath();
		mkdirSync(path.dirname(logPath), { recursive: true });
		const ts = new Date().toISOString();
		appendFileSync(logPath, `[${ts}] ${line}\n`);
	} catch {
		/* 日志写入失败不该影响 tab 生命周期 */
	}
}

export interface CdpTabLifecycleDeps {
	// ponytail: 可选 DI,供测试注入 fake fetch。生产路径不传,走全局 fetch(与 client.ts 一致)。
	fetch?: typeof fetch;
	// ponytail: 可选日志注入(测试默认禁用,避免污染生产 cdp-tab.log)。
	log?: (line: string) => void;
	// ponytail: 可选 autolaunch 注入。生产不传 → launchChromeCdpAndWait(真起 Chrome)。
	// 测试必须注入 fake,否则 beforeSpawn 重试会真 spawn Chrome。
	launch?: (port: number) => Promise<string>;
}

export function makeCdpTabLifecycle(port: number, deps: CdpTabLifecycleDeps = {}): WorkerLifecycle {
	const client = () => createChromeCdpClient({ port, fetch: deps.fetch });
	// 测试传 deps.log=()=>{} 禁用日志;生产不传 → tabLog(写文件,默认开)。
	const log = deps.log ?? tabLog;
	// ponytail: launch DI。生产走 launchChromeCdpAndWait(真起 Chrome + 轮询就绪);
	// 测试注入 fake 避免真 spawn。延迟到调用点解析,让测试能注入 fake、生产走真实 launcher。
	const launch = deps.launch ?? ((p: number) => launchChromeCdpAndWait(p));
	let tabId: string | undefined;
	// ponytail: openTab = 在当前 client 上开一个 about:blank tab。抽出来让 beforeSpawn 的
	// 初次/重试两条路共用同一段调用,避免 autolaunch 重试时复制粘贴 createChromeTab 调用。
	const openTab = () => createChromeTab(client(), "about:blank");
	return {
		async beforeSpawn(env) {
			// ponytail: about:blank 起 tab。worker 进程内 navigate 到真实目标页(B 站 BV 页等)。
			// 首次失败若是连接类错误(Chrome 没起),autolaunch 一次再重试 —— 不让"CDP 没起"
			// 直接整 task 崩;worker 根本没机会自救(它 spawn 之前就跑到这里了)。
			try {
				const tab = await openTab();
				tabId = tab.id;
				env.UGK_CDP_TAB_ID = tabId;
				log(`OPEN  port=${port} tab=${tabId} url=about:blank`);
			} catch (error) {
				const msg = error instanceof Error ? error.message : String(error);
				log(`ERROR port=${port} stage=open msg=${msg}`);
				if (!CDP_CONNECT_ERROR.test(msg) || !autolaunchEnabled()) {
					// 非连接类错(tab 配额/协议错),或用户关了 autolaunch:翻译成可操作提示。
					const hint = CDP_CONNECT_ERROR.test(msg)
						? `Chrome CDP 未连接(port ${port})。请先运行 /cdp launch 启动带调试端口的 Chrome。`
						: `CDP 开 tab 失败(port ${port}): ${msg}`;
					throw new Error(hint);
				}
				// 连接类错 + autolaunch 开:起 Chrome 再开一次 tab。launchChromeCdpAndWait 内含
				// waitForChromeCdpReady 轮询,解决 spawn→fetch 的启动竞态。
				log(`AUTOLAUNCH port=${port} reason=connect-error launching managed Chrome`);
				try {
					await launch(port);
				} catch (launchErr) {
					const launchMsg = launchErr instanceof Error ? launchErr.message : String(launchErr);
					log(`ERROR port=${port} stage=autolaunch msg=${launchMsg}`);
					throw new Error(
						`Chrome CDP 未连接(port ${port})且自动启动失败: ${launchMsg}。请手动运行 /cdp launch。`,
					);
				}
				try {
					const tab = await openTab();
					tabId = tab.id;
					env.UGK_CDP_TAB_ID = tabId;
					log(`OPEN  port=${port} tab=${tabId} url=about:blank autolaunch=1`);
				} catch (retryErr) {
					// ponytail: launch 成功但仍开不了 tab —— 真有问题(端口被占/profile 损坏)。
					// ceiling: 此时重试也没用,直接报清晰错让用户介入。
					const retryMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
					log(`ERROR port=${port} stage=open-retry msg=${retryMsg}`);
					throw new Error(
						`已自动启动 Chrome(port ${port})但仍无法开 tab: ${retryMsg}。请检查端口/profile,或手动 /cdp launch。`,
					);
				}
			}
		},
		async afterClose() {
			// finally 保证调到这里。tabId 空说明 beforeSpawn 没成功开 tab(幂等,不炸)。
			if (!tabId) return;
			const closingTabId = tabId;
			tabId = undefined;
			try {
				await closeChromeTab(client(), closingTabId);
				log(`CLOSE port=${port} tab=${closingTabId} ok`);
			} catch (error) {
				// ponytail: close 是 best-effort。失败说明 tab 已没了或 Chrome 重启 —— 不阻塞 worker 回收,但记下来。
				const msg = error instanceof Error ? error.message : String(error);
				log(`WARN  port=${port} tab=${closingTabId} close-failed msg=${msg}`);
			}
		},
	};
}
