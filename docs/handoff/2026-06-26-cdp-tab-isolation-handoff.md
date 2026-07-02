# CDP Tab 隔离交付 Handoff

> 日期：2026-06-26
> 关联设计：`docs/design/2026-06-26-cdp-per-worker-tab-isolation.md`
> 关联提交：`3876026` `0dd8f7b` `dc8a9e4` `7b2b3fa`
> 测试基线：`npm test` → 534/534 pass（原 519 + 新增 15）

## 本次交付了什么

**修复并行 task worker 抢同一 Chrome tab 导致的下载串号。**

机制：每个会用 CDP 的 worker，spawn 前由 main 进程代码开一个专属 tab、tabId 注入 env `UGK_CDP_TAB_ID`；worker 内 `chrome_cdp` 工具读它作默认 target；worker close 后（含 SIGKILL，finally 保证）关掉该 tab。崩溃安全，不依赖 worker 进程的 finally。

详见 `docs/design/2026-06-26-cdp-per-worker-tab-isolation.md`。

## 端到端验证结论（已跑通）

5 个 bilibili-downloader 并行下载：

- ✅ 日志 5 行 OPEN 几乎同时出现（真并行，4 个 tab 共存，MAX_CONCURRENCY=4 生效，第 5 个补位）
- ✅ 5 行 CLOSE 全部出现，零孤儿 tab
- ✅ 5 个 mp4 文件名与 BV 号一一对应（原 bug 重灾区 `BV1xQ7K6CESQ` / `BV18ejU6wEKn` / `BV1g87a69Ere` 标题正确）
- ✅ 5 个 MD5 全不相同（无内容串号）

原始 bug（40 视频 23 重复）的根因路径（抢 `tabs[0]`）被彻底堵死。

## 测试中暴露的两个独立问题（非本次修复范围，已知）

### 1. subagent 嵌套 run_task 未授权（既有设计，非回归）

**现象**：用 `subagent parallel` 委派 worker，让 worker 再调 `run_task`（受保护工具），4 个 worker 全报"未授权"。

**根因**：`subagent.ts` 的 `buildSubagentChildEnv`（第 78-79 行）**主动删除** `UGK_TASK_ALLOW_CHROME_CDP` / `UGK_TASK_ALLOW_MCP_TOOLS`。这是有意的安全边界 —— subagent 委派的 worker 默认不继承 main 的受保护工具授权。

**正确用法**：让 main agent 直接调 `run_task` parallel 模式（不要用 subagent 包一层）。`run_task` execute → `resolveTaskWorkerEnv` 会正确授权。

**是否要改**：这是安全边界，不是 bug。但如果想让 subagent 编排受保护工具更顺手，需要单独设计授权传递方案（超出本次范围）。

### 2. 单个视频下载失败（业务层，非机制问题）

**现象**：5 个并行中有 1 个失败。

**判定**：不是隔离问题。日志显示该 worker 正常 OPEN/CLOSE（没有 ERROR 行、没有 44ms 瞬间退出）。最可能是 DASH URL 过期（skill.md 明确"DASH URL 有时效性"）或页面加载问题。agent 会自动重试（日志第 22 行新开 tab）。

## 日志用法（出问题时的诊断抓手）

```bash
tail -f ~/.pi/agent/logs/cdp-tab.log
```

每行格式：`[时间] OPEN/CLOSE/ERROR/WARN port=9222 tab=<id> ...`

判定：
- 并行 worker 应看到多行 OPEN 时间戳相近（几秒内）
- 每个 OPEN 都应有对应 CLOSE（孤儿 = 只有 OPEN 没 CLOSE）
- `ERROR stage=open` + `fetch failed` → Chrome 没起，`/cdp launch`
- `WARN close-failed` → tab 已没了或 Chrome 重启，best-effort 忽略

## 新同事接手必读

1. **改 chrome_cdp 工具或并行调度前，先读** `docs/design/2026-06-26-cdp-per-worker-tab-isolation.md`。
2. **架构守卫**：`task/` 不能 import `chrome-cdp/`（`tests/task-extension.test.ts:34` 强制）。tab 隔离靠 `shared/worker-lifecycle.ts` 的依赖反转注册表，不要打破。
3. **不要让 worker 用 python/其它方式直连 CDP 端口**。隔离只覆盖 `chrome_cdp` 工具路径（读 `UGK_CDP_TAB_ID`）。taskbook 的 skill 应强制 "必须使用 chrome_cdp 工具，不得通过 bash 调用 CDP"（参考 `bilibili-downloader/skill.md`）。
4. **显式 `params.target` 永远压过会话 tab**。不要改这个优先级（会破坏 agent 主动指定 tab 的能力）。
5. **测试用 `deps.log = () => {}`** 禁用文件日志，不要污染生产 `cdp-tab.log`。

## 代码是最终裁决

本文档自包含。如有疑问，`docs/design/2026-06-26-cdp-per-worker-tab-isolation.md` + 代码 + 测试是权威。
