# 体检报告处置 Handoff

> 日期：2026-06-27
> 触发：合并 PR #14（clean up Flow leftovers and theme bundle）后，阅读其附带的
> `docs/reports/2026-06-27-project-health-review.md`，逐条核实并处置。
> 关联提交：见末尾清单

## 本次做了什么

体检报告质量高（事实层用 grep 核实全部属实），但**行动优先级有调整**。逐条处置如下。

---

## 已处理（小、稳、零风险）

### 1. MCP import cycle —— 已修

**报告论断**：`commands.ts → formatter.ts → commands.ts`，formatter 只为拿 `McpCommandState` 类型反向 import。**核实属实**（formatter.ts:2 确实 import commands）。

**报告建议**：把 `McpCommandState` 搬到独立 types 文件。**未采用**——该类型天然属于 commands，搬走打散内聚。

**实际改法**：formatter 自描述它真正读取的窄状态 shape（`McpStatusStateShape`，structural typing 鸭子兼容 `McpCommandState`），删掉对 commands.ts 的 import。commands.ts 零改动，行为零变化。

- 改：`extensions/mcp/formatter.ts`
- 守卫测试：`tests/mcp-formatter-cycle.test.ts`（断言 formatter.ts 不再 import commands.ts，cycle 一旦回归即失败）

### 2. UI title/footer ownership —— 已整合

**报告论断**：`ui-brand` 与 `ui-footer`/`ui-titlebar` 对 footer/title 区域 ownership 重叠。**核实属实，且 title 是真 bug**。

- **title（真 bug）**：`ui-titlebar` 的 80ms `setTitle` 循环在工作期间用 π 风格标题（`π - session - cwd`）覆盖 `ui-brand` 的 ugk 标题；agent 结束恢复的也是 π 风格，**ugk 品牌标题被实质架空**。
- **footer（冗余）**：`ui-footer` 的 `/footer` 视图是 `ui-brand` UgkFooter 的**严格子集**（少 cwd、少上下文进度条、无品牌色），且关闭时 `setFooter(undefined)` 退回 pi 内置 footer 而非 ugk 品牌 footer。

**改法（用户选 A：ugk 品牌优先）**：
- 删 `ui-titlebar.ts`：spinner 动画并入 `ui-brand`（`agent_start` 启动盲文帧 + ugk 标题，`agent_end` 恢复静态 ugk 标题，受 `/ugk-ui off` 保护）。ctx stale 容错测试迁移到 ui-brand。
- 删 `ui-footer.ts`：ui-brand 的 UgkFooter 成为唯一 footer owner。
- `ui-statusline`（`✓ 第 N 轮完成`，turn 进度）原样保留——它是独立职责，报告也建议保留。

净减 72 行。README 目录树注释同步。

---

## 已评估但决定不动

### task.ts（2024 行）—— 不拆

**报告**：列为"重点问题 1，高优先级"，建议建 Task execution Module。

**核实后的反对依据（基于实测数据）**：

1. **子模块其实已切好**。报告称"worker/verify/checker 集中在 task.ts"是**不准确**的——它们早独立成文件（`task-worker.ts` 126 行、`task-verify.ts` 110 行、`task-checker.ts` 115 行 等）。task.ts 只是调用它们。task 目录 13 个文件，task.ts 之外全是 33~285 行的健康小文件。

2. **报告担心的"双入口分叉"风险已化解**。`/task run`（interactive 命令）和 `run_task`（tool）**已共用** `resolveTaskWorkerEnv` + `executeSubtask`（本轮接 autopilot 时实测确认两入口走同一执行路径）。报告担心的"改一个漏另一个"在当前架构下不会发生。

3. **task.ts 大 ≠ 难维护**。它是"命令菜单 + 编排胶水"，函数多但都小（中位数 ~10 行），内聚度高。强行拆只会得到"几个互相 import 的碎片"。

4. **报告自己的退路未触发**。"先补 characterization tests"的前提是现有测试不够，但 task 相关测试 20+ 个，行为覆盖扎实。

**决策**：按 ponytail，拆分是新增复杂度，必须有"改一处漏一处"的真实 bug 证据才动手。当前无此证据，YAGNI。task.ts 保持现状，**除非未来出现真 bug 或要加大量新执行逻辑**。

---

## 仍需产品决策（非工程问题，未触碰）

报告列入"项目组需拍板"的，本轮一律未动：

- cron 是否核心能力（方向 A 深化 / 方向 B 改系统计划任务）
- 社区主题是否重新引入（本轮已随 PR #14 删除 16 个，只留 ugk-geek）
- `skills/docx` 的 Office schemas（~1MB）是否拆可选包
- `skills/skill-creator` 的 eval/viewer 是否属默认运行时
- `docs/handoff/**` 是否归档到仓库外
- judge 模块是否拆分（报告正确地判断它仍是公开功能、不硬删）

## 报告"其他优化"建议 —— 评估后暂缓

报告建议抽取的 helper（JSON 提取 / tool summary / command policy / numbered-choice）：
- 多为"形似但语境不同"的代码，强行抽 helper 易造"一个函数两套语义"。
- 等真正改其中一处时顺手抽，别为抽而抽。YAGNI。

---

## 测试基线

`npm test` → 561/561 pass。

各步测试变化：
- 合并 PR #14 后：564 → 559（删除 5 个 cleanup-flow 测试）
- MCP cycle 修复：+2 → 561
- UI 整合：净持平（删 ui-titlebar 测试内容、迁移为 ui-brand spinner 容错测试）

## 改动提交清单

1. `8591ff6` fix: break MCP import cycle
2. `1e2c2d0` refactor: consolidate UI ownership into ui-brand

（PR #14 的合并 `fb60fce` 在此之前，由 `git merge --no-ff` 完成，autopilot/language 两侧改动均保留。）
