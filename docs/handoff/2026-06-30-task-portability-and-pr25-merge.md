# UGK 会话交接 — task 可移植性基建 + PR #25 合并轮

> 日期：2026-06-30
> 交接对象：**下一个会话继续开发 ugk 的我（或接手者）**
> 当前基线：`9e4e0f0`（main，测试 **475/475/0**，工作树干净）
> 这一轮做了什么：合并 PR #25 + 加 requiredBinaries（task 可移植性基建）+ 一轮 sub agent 审查闭环

---

## 当前 main 状态（你的起点）

| 项 | 值 |
|---|---|
| main HEAD | `9e4e0f0` |
| 测试基线 | **475/475/0**（`npm test`，约 10-12 秒） |
| npm 发布 | `ugk-agent@2.1.2` + `ugk-install@0.1.0`（**未发新版**，本轮全是未发版的 main 改动） |
| 工作树 | 干净 |

### 本轮新增的 7 个提交（从老基线 `f424b57` 起）

```
9e4e0f0 fix(task): requiredBinaries 三处过滤规则统一(滤空白)         ← 审查 nit 修复
cd474fa feat(task): contract.requiredBinaries 外部 CLI 依赖前置校验   ← task 可移植性主功能
1b72561 docs: 给分支开发新同事的交接手册(基于基线 6f0a627)
6f0a627 fix(task): setx 持久化失败不再静默,notify 警告用户
95f3281 fix(task): worker 多轮后流式 progress 不再丢失               ← sub agent 审出的 bug
eecd12e perf(task): parallel run_task 批次级集中 hydrate requiredEnv 去重
556d404 feat(task): contract.requiredEnv 前置校验 + subagent progress 流式推送 (#25)
```

**老基线是 `f424b57`**（上一次交接的稳定点）。这一轮在它之上加了 7 个提交，全是 task 系统的基建强化 + 一个 PR 合并 + 一个交接手册。

---

## 本轮做了啥（一句话总结）

**让 task 真正可移植**：task 现在能自描述依赖（env + 外部 CLI + 受保护工具），运行前校验，缺啥就明确反馈给 agent/人，装完重试。加上 PR #25 合并 + sub agent 审查修了一个真 bug。

### 三块功能（都在 task 系统）

#### 1. requiredEnv（PR #25 合并，`556d404`）
taskbook 的 contract 声明必需环境变量。`/task run` 交互式 hydrate+prompt+setx 持久化；`run_task` headless 缺则直接 FAIL。

#### 2. progress 流式推送（PR #25 合并 + `95f3281` 修 bug）
子进程 `tool_execution_update`（yt-dlp 百分比等）经 subagent 注入 → worker 回调 → task UI。
**注意**：PR #25 原版的 progress 在 worker 多轮后丢失（messages 非空时被 formatMessageProgress 吞掉），`95f3281` 修了——content 文本无条件优先推送。`task-worker.ts` 的 onUpdate 回调逻辑现在很关键，别乱改。

#### 3. requiredBinaries（`cd474fa` + `9e4e0f0`，本轮主线）
taskbook 的 contract 声明外部 CLI 依赖（yt-dlp/ffmpeg/python 等）。运行前查 PATH，缺则：
- `run_task`（agent 自动）→ 那个 task FAIL + 提示"装完重新调用 run_task"，main agent 自己决定装不装
- `/task run`（手动）→ notify + 安装渠道提示
- parallel → 该 task FAIL 不炸批次

**不自动安装**（task 原子单元，环境决策归 agent/人）；**不校验版本**。

---

## task 系统现在的 contract 结构（重要，改 task 必读）

contract.json 现在支持这些字段（都是可选，向后兼容）：

```json
{
  "outputDir": "<绝对路径或 runtime 默认>",
  "artifacts": [{ "name": "report.json", "type": "file", "required": true }],
  "runtimeInput": ["字段名1", "字段名2"],
  "runtimeInputMeta": { "字段名1": { "default": "...", "required": true } },
  "requiredEnv": ["MIMO_API_KEY"],
  "requiredTools": ["chrome_cdp"],
  "requiredBinaries": ["yt-dlp", "ffmpeg"],
  "dispatcherModel": "...",
  "workerModel": "..."
}
```

### 三个依赖字段的分工（别混淆）

| 字段 | 管什么 | 校验方式 | 缺失行为 |
|---|---|---|---|
| `requiredEnv` | 环境变量（API key 等） | `missingRequiredEnv` 读 process.env + Windows User env hydrate | /task run 弹窗问；run_task FAIL |
| `requiredTools` | **ugk 内部**受保护工具（chrome_cdp/MCP） | `protectedToolsForTaskbook` 走授权门 | 弹授权 confirm |
| `requiredBinaries` | **外部 CLI**（yt-dlp/ffmpeg 等） | `missingRequiredBinaries` 用 `isBinaryAvailable` 查 PATH | /task run notify；run_task FAIL |

**关键区别**：`requiredTools` 是 ugk 内部的（走 CDP/MCP 授权），`requiredBinaries` 是系统命令（查 PATH）。别把 yt-dlp 写进 requiredTools。

---

## 改 task 代码的关键位置（文件:行号索引）

按 ponytail 原则，每处都有 `ponytail:` 注释说明设计意图。改之前先读注释。

### 依赖校验链（task.ts）
- `missingRequiredEnv` — env 检查（读 process.env）
- `missingRequiredBinaries` — binary 检查（用 `isBinaryAvailable` 查 PATH）
- `hydrateRequiredEnvForTaskbooks` — parallel 批次级 hydrate 去重（run_task 入口集中做，不在每个 subtask 各做）
- `promptMissingRequiredEnv` — /task run 交互式 hydrate+prompt+setx
- `formatMissingEnvMessage` / `formatMissingBinariesMessage` — 提示文案
- **两条检查路径**：`executeSubtask`（headless，task.ts 约 1276）+ `handleTaskRun`（交互式，约 1454）。顺序都是 env → binary，都在 worker 启动前

### 契约校验（task-book.ts）
- `assertValidContract` — 现在校验 runtimeInput/runtimeInputMeta + requiredEnv/requiredTools/requiredBinaries 都是可选 string[]
- **之前完全不校验后三个**（独立 bug，本轮顺带修的）

### progress 链路（易踩，单独说）
- 注入端：`subagent.ts` 的 `progressTextFromToolEvent` + runSingleAgent 里注入 onUpdate
- 接收端：`task-worker.ts` 的 dispatchWorker onUpdate 回调
- **`95f3281` 的修复点**：content 流式文本**无条件优先推送**，messages 遍历作补充。别改回 `!result?.messages?.length` 判定（多轮 progress 会丢）
- 测试 `dispatchWorker forwards progress partials even when result messages are non-empty (multi-round)` 钉死了这个回归

### binary 检查实现（shared/binary.ts）
- `findCommandOnPath` — 从 chrome-cdp 抽来的纯 Node which/where（无子进程，跨平台）
- `isBinaryAvailable` — 薄封装
- **为什么在 shared/**：task/ 不能 import chrome-cdp/（架构守卫强制），所以必须下沉到共享层。chrome-cdp/launcher.ts 现在 import 自 shared

---

## 已知非阻塞债（可不做，记着就行）

1. **executeSubtask headless FAIL 路径无单独测试** — 逻辑极简（一个 if+return），requiredEnv/requiredBinaries 各有间接覆盖。纯洁癖。
2. **prompt 没说"别声明 node/bash"** — sub agent 提的 nit，我没采纳（正向例子已足够，over-specification）。
3. **requiredBinaries 不校验版本** — 有意为之（版本校验是深坑），只验"存在"。如果将来需要版本校验，是独立大需求。

---

## 网络提醒（这台机器的坑）

这个 git bash 环境**不自动走系统代理**，`git push`/`fetch` 会直连 GitHub 超时（浏览器能开是因为走代理）。

系统代理 `127.0.0.1:10808`。push/fetch 卡住时加前缀：
```bash
git -c http.proxy=http://127.0.0.1:10808 -c https.proxy=http://127.0.0.1:10808 <命令>
```
或一劳永逸（只给 github.com）：
```bash
git config --global http.https://github.com/.proxy http://127.0.0.1:10808
```

---

## 验证基线

```bash
cd E:/AII/ugk-core
npm test          # 应该 475/475/0，约 10-12 秒
node bin/ugk.js   # 本地跑 ugk 验证
```

---

## 工作风格（这次会话一直遵循的）

- **ponytail full**：最短可用 diff、根因修复、非平凡逻辑留可跑的 check、`ponytail:` 注释标刻意简化
- **审查模式**：复杂改动派 sub agent 审（用 ponytail skill），然后**逐条核实**——真问题修、误报/over-engineering 不采纳。两轮审查（PR #25、requiredBinaries）都审出真东西，没流于形式
- **测试抓回归**：每个修复都临时禁用验证测试会红

---

## 接手后建议先确认

1. `npm test` 跑通 475/475/0
2. `git log --oneline -8` 看本轮提交
3. 读 `extensions/task/task.ts` 的 `ponytail:` 注释（尤其 progress 链路 + 依赖校验链）
4. 如果继续做 task 相关，先读 `docs/design/2026-06-26-task-atomic-unit-and-parallel-primitive.md`（task 原子单元 + 并行原语，权威设计）

---

> 其他总约定见 `AGENTS.md` + `docs/DEVELOPMENT.md` + `docs/handoff/2026-06-30-handoff-for-branch-developer.md`（分支开发手册）。
