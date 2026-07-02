# CDP Per-Worker Tab 隔离设计

> 日期：2026-06-26
> 关联提交：`3876026` `0dd8f7b` `dc8a9e4` `7b2b3fa`
> 解决问题：并行 task worker 共享一台 Chrome 时抢同一个 `tabs[0]`，导致标题/下载流地址串号、内容重复（bilibili-downloader 40 视频 23 重复）。

## 背景：bug 根因

`chrome_cdp` 工具的 `findTab`（`client.ts:61-71`）不传 `target` 时 fallback 到 `tabs[0]`。

单任务时没问题。但 `run_task` / `subagent` 的 parallel 模式会同时 spawn 多个 worker 进程，它们共享同一台物理 Chrome（都连 `127.0.0.1:9222`），各自 navigate 到不同页面，却都命中 `tabs[0]` —— 后到的覆盖先到的，worker 从被污染的页面里抓到错误的标题/链接。

证据（bilibili-downloader 40 视频实测）：同一秒 spawn 的 4 个 worker，3 个都下了 "Loop Engineering" 这个标题，BV 号却不同；MD5 校验 23 个文件重复，实际只有 17 个不同视频。

## 为什么不是更简单的方案

| 方案 | 评价 |
|---|---|
| 进程内 CDP 互斥锁 | ❌ worker 是独立进程，进程内锁只锁一个进程自己，5 个 worker 各有一把自己的锁，互不感知 → 照抢 |
| subagent→worker 全局串行 | ❌ 单点故障：一个 worker hang 全堵（且 worker 没有硬超时，靠 checker abort 或用户手动 stop） |
| 多浏览器实例 | ❌ YAGNI，资源重，一个 Chrome 多 tab 就够 |

**关键洞察**：Chrome 本身支持多 tab。真正的根因不是"CDP 不能并发"，是 `chrome_cdp` 工具缺一个"为这次会话开/绑专属 tab"的原语。补上它即可，不用加锁也不用降级到串行。

## 设计：main 进程代码管理 per-worker tab 生命周期

**核心原则：tab 由 main 进程的不思考代码管理，不是 LLM。**

为什么不能让 LLM（worker agent）管 tab：
- LLM 会忘关、会幻觉关错别人的 tab
- worker 被 SIGKILL 时，进程内任何 `finally` 都不执行

main 进程的 `proc.on('close')` + `try/finally` 是同步铁律，worker 无论正常退出、被 abort、被 SIGKILL，main 的 close 事件都必然触发 → 在 finally 里关 tab。

### 流程

```
main 进程 (subagent.ts runSingleAgent)
  ├─ spawn 前: lifecycle.beforeSpawn(extraEnv)
  │     └─ createChromeTab(about:blank) → tabId → extraEnv.UGK_CDP_TAB_ID
  ├─ spawn worker (env 带 UGK_CDP_TAB_ID)
  │     └─ worker 进程内 chrome_cdp 工具读 env → sessionTabId → 默认绑它
  └─ worker close 后 (finally): lifecycle.afterClose()
        └─ closeChromeTab(tabId)  // best-effort，吞错
```

### 并发隔离

`dispatchWorker` 每次调用 `factory(port)` 创建**新的 lifecycle 闭包**，`tabId` 是闭包私有变量。5 个并行 worker 各拿独立 lifecycle → 各开各的 tab，互不共享。

### 解耦：依赖反转（架构守卫强制）

`tests/task-extension.test.ts:34` 强制 `extensions/task/` 不能 import `chrome-cdp/`。所以不能让 task-worker 直接 import `makeCdpTabLifecycle`。

解法：`extensions/shared/worker-lifecycle.ts` 提供中立契约 + 注册表：

```
shared/worker-lifecycle.ts
  ├─ WorkerLifecycle 接口 (beforeSpawn / afterClose)
  └─ setWorkerLifecycleFactory / peekWorkerLifecycleFactory  // 模块级注册表

chrome-cdp/index.ts: registerChromeCdp 时 setWorkerLifecycleFactory(makeCdpTabLifecycle)
task/task-worker.ts: dispatchWorker 时 peekWorkerLifecycleFactory() 拿工厂
```

依赖方向单向无环：`task-worker` → `shared/worker-lifecycle` ← `chrome-cdp`，两者互不 import。

### 触发信号

`task-worker` 用现有 env `UGK_TASK_ALLOW_CHROME_CDP`（由 `resolveTaskWorkerEnv` 按 taskbook 是否声明 chrome_cdp 设置）判断是否注入 lifecycle。subagent parallel/chain/single、checker、guide、reviewer 路径都不传 lifecycle（undefined），零行为变化。

## Target 解析

`config.ts` 加 `sessionTabId` 字段（从 env `UGK_CDP_TAB_ID` 读）+ `resolveChromeCdpTarget`：

```ts
resolveChromeCdpTarget(state, { target }) = params.target ?? state.sessionTabId
```

**显式 `params.target` 永远压过会话 tab** —— 不破坏 agent 主动指定 tab 的能力。两者都没有时返回 undefined，`findTab` 再 fallback 到 `tabs[0]`（main agent 自调场景保持旧行为）。

`index.ts` 的工具 execute 在 navigate/evaluate/screenshot 前 resolve target，与 `resolveChromeCdpPort` 同形。

## 可观测性

`tab-session.ts` 的 `tabLog` 把每次 open/close/error 写一行到 `~/.pi/agent/logs/cdp-tab.log`（简单的 `appendFileSync` + 时间戳前缀,可 `tail -f`）：

```
[2026-06-26T08:25:48.546Z] OPEN  port=9222 tab=F4E6... url=about:blank
[2026-06-26T08:26:06.390Z] CLOSE port=9222 tab=471A... ok
[2026-06-26T08:06:19.305Z] ERROR port=9222 stage=open msg=fetch failed
```

- 默认开（诊断必须），`UGK_CDP_TAB_LOG=0` 关
- 连接类错（ECONNREFUSED / fetch failed）翻译成可操作提示："Chrome CDP 未连接，请先 /cdp launch"
- close 失败只 WARN 不抛（best-effort）
- 测试通过 `deps.log = () => {}` 禁用，不污染生产日志

## 已知边界（ceiling）

- **不做启动时孤儿 tab 扫描**：A1a 下 finally 必回收，孤儿只在 main 自身崩溃时残留（概率低）。升级路径：给 worker tab 打 title 前缀（如 `[ugk]`），启动时扫前缀关掉。代码注释标了。
- **只覆盖 `chrome_cdp` 工具路径**：worker 内若用 python/其它方式直连 CDP 端口（如 `pychrome.Browser(9222)`），不读 `UGK_CDP_TAB_ID`，隔离无效。bilibili-downloader 的 skill 已强制 "必须使用 chrome_cdp 工具，不得通过 bash 调用 CDP"，规避了这点。新 taskbook 应遵循同样约束。

## 验证（端到端，真实 Chrome + LLM）

5 个 bilibili-downloader 并行下载，对比修复前后：

| 项 | 修复前 | 修复后 |
|---|---|---|
| 并行 worker tab | 全抢 tabs[0] | 5 个独立 tab 共存（日志 5 行 OPEN） |
| tab 回收 | N/A | 5 OPEN + 5 CLOSE 成对，零孤儿 |
| 文件名 ↔ BV 号 | 串号 | 5/5 一一对应 |
| MD5 | 23 重复 / 40 | 5/5 全不同 |

并行隔离机制验证有效，原始 bug 根因被消除。

## 相关文件

- `extensions/shared/worker-lifecycle.ts` — 中立契约 + 依赖反转注册表
- `extensions/chrome-cdp/client.ts` — `createChromeTab` / `closeChromeTab`（HTTP `/json/new`、`/json/close`）
- `extensions/chrome-cdp/tab-session.ts` — `makeCdpTabLifecycle` 封装 + 日志
- `extensions/chrome-cdp/config.ts` — `sessionTabId` + `resolveChromeCdpTarget`
- `extensions/chrome-cdp/index.ts` — 工具 resolve target + 注册 lifecycle 工厂
- `extensions/subagent.ts` — `runSingleAgent` 加 `lifecycle?` 参数（spawn 前 beforeSpawn，finally afterClose）
- `extensions/task/task-worker.ts` — peek 工厂注入 lifecycle（不 import chrome-cdp）
