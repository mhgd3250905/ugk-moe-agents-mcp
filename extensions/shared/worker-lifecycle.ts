/**
 * WorkerLifecycle — 通用 worker 子进程生命周期钩子契约。
 *
 * 中立接口,不 import 任何具体扩展(subagent 不认识 chrome-cdp,反之亦然)。
 * 依赖方向:subagent.ts / chrome-cdp/ / task/ 都依赖本契约,互不依赖实现。
 *
 * 使用方(subagent.ts 的 runSingleAgent)在 spawn 前调 beforeSpawn(可往 env 注入资源句柄,
 * 如 UGK_CDP_TAB_ID),在 worker 进程 close 后的 finally 里调 afterClose(回收资源)。
 * finally 保证正常退出/abort/SIGKILL 三条路都回收。
 *
 * 实现方(如 chrome-cdp/tab-session.ts 的 makeCdpTabLifecycle)把具体的资源(一个 CDP tab)
 * 绑定在这两个钩子上,实现 per-worker 资源隔离。
 */
export interface WorkerLifecycle {
	/**
	 * spawn 前调用。可修改 env(注入资源句柄)。抛错则阻止 spawn。
	 */
	beforeSpawn?: (env: Record<string, string | undefined>) => Promise<void>;
	/**
	 * worker 进程 close 后调用。无论正常退出还是被 kill 都会执行(finally 保证)。best-effort,不抛错。
	 */
	afterClose?: () => Promise<void>;
}

/**
 * 依赖反转变体(DIP):task/ 不允许 import chrome-cdp/(有架构守卫测试强制)。
 * 但 task-worker 需要在 CDP worker 上挂 per-worker tab 生命周期。解法:
 * chrome-cdp 通过 setWorkerLifecycleFactory 把工厂注册到这里(组合根接线时),
 * task-worker 通过 peekWorkerLifecycleFactory 读它。两者都只依赖本中立模块,互不 import。
 */
type WorkerLifecycleFactory = (port: number) => WorkerLifecycle;

let workerLifecycleFactory: WorkerLifecycleFactory | undefined;

export function setWorkerLifecycleFactory(factory: WorkerLifecycleFactory | undefined): void {
	workerLifecycleFactory = factory;
}

export function peekWorkerLifecycleFactory(): WorkerLifecycleFactory | undefined {
	return workerLifecycleFactory;
}

