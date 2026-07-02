# 架构债记录（源自 PR #18 自动审查）

> 日期：2026-06-27
> 来源：`docs/automated-reviews/2026-06-27-47beb72.md`（PR #18，codex 自动审查）
> 处置决策：**全部仅记录为债，不动代码**（无 bug 驱动，ponytail 不主动抽象）

## 为什么不做

PR #18 报告提了 3 个"架构候选"，全是"挪代码"的纯重构，无 bug 驱动：
- Candidate 1（报告标 Strong）拆 task.ts → task 对话周期模块
- Candidate 2（报告标 Worth exploring）ui-brand 状态聚合
- Candidate 3（报告自标 Speculative）runtime patch 注册归并

按 ponytail 铁律：**不主动抽象，later 自 scaffold**。报告本身也只是"建议探索"而非"必须修"，Candidate 3 报告自己都标 Speculative 跳过。重构风险 > 收益：task.ts 是刚修过 3 个 bug 的核心模块，行为正确、测试覆盖，为"挪代码"动它可能引入回归。

## 触发"该做了"的条件

债记录的意义是知道**什么时候从 YAGNI 变成必须做**：

- **Candidate 1（task.ts 拆分）**：当近期要往 task 模块加新的 turn 类型或周期规则时，2078 行里找位置的成本会超过拆分成本，那时做。当前 task 周期逻辑主要分布在：
  - `classifyTurn` 相关：`task.ts:236` 起（`isCancelledAssistant` / `hasQuestionnaireCancellation` 等）
  - 周期过滤：`task.ts:274` `filterTaskContextMessages`
  - 边界标记：`task.ts:69` `TASK_CONTEXT_END_TYPE` + 退出注入
- **Candidate 2（ui-brand 聚合）**：当 session replacement 或 usage-refresh 行为要改时。当前 header/footer/title/usage 在 `ui-brand.ts`（419 行）混在一起。
- **Candidate 3（runtime patch）**：当 patch 数量从当前的几个增长到需要统一注册顺序时。报告自标 Speculative，现在完全不碰。

## 已修的相关项（不在本债范围）

PR #18 报告的 `shrink` 项（logoTone 两处维护）**已在本会话修复**——`UGK_BLOCK_LOGO_TONES` 元数据移到 `ui-brand-utils.ts` 与 `UGK_BLOCK_LOGO` 同处维护，`ui-brand.ts` 的 `logoTone()` 改为数据驱动，零行为变化。

## 附带未修的已知天花板（有注释，不观测到就不动）

- **compaction 截断**：task 周期隔离依赖 `task-context-end` 边界标记，session 压缩截掉它会让那段 task 问答"看似未闭合"。位置：`task.ts` 的 `filterTaskContextMessages`，有 `// ponytail:` 注释，真遇到加 timestamp 兜底。
- **logoTone 窄终端截断**：`ui-brand.ts` 的 `logoTone()` 用子串 `includes` 匹配，窄终端截断会退化着色（不崩）。根治需按渲染行索引定位，代价过大，有注释标明天花板。
