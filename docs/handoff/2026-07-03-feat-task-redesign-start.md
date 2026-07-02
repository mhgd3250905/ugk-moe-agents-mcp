# feat/task-redesign 开发起点

> **创建**:2026-07-03
> **分支**:`feat/task-redesign`(基于 main `60abc7e`)
> **worktree**:`E:/AII/worktrees/ugk-core/feat-task-redesign`
> **目的**:task 设计相关的重新思考/迭代。本文档只给"起点快照 + 代码指针 + 设计约束",不预设具体方向。

---

## 1. 起点状态(本 worktree 创建时实测)

| 维度 | 值 |
|---|---|
| main HEAD | `60abc7e` = origin/main(三方对齐,线上也是) |
| 本分支 | `feat/task-redesign`,ahead=0(纯净 main 副本) |
| 测试基线 | `npm test` → pass 577 / fail 0 |
| 工作区 | 干净 |

最近 4 个 main commit(都和 task 强相关,是本次设计的直接前置):
```
60abc7e fix(task): reject undeclared dispatcher fields instead of silent drop (#39)
1da5024 fix(task): surface FAIL reason to agent context (#38)
b33f09e Merge pull request #35 (product homepage)
6297024 chore(skill): add terminal-recorder skill (#37)
```

---

## 2. ⚠️ 改 task 前必读的两道红线

### 红线 A:`task.ts` 顶部注释(权威)

`extensions/task/task.ts` 文件头有 24 行设计红线注释,**改任何并行/discovery 逻辑前必读**。核心四条:

1. **task = 原子单元**。对调用方不可分割,内部 1 步还是 100 步不可见。
2. **并行编排是工具层能力**,不是用户 skill 的责任。`run_task` 与 `subagent` 平级:
   - single:`run_task({name, input})` ↔ `subagent({agent, task})`
   - parallel:`run_task({tasks:[{name,input}]})` ↔ `subagent({tasks:[{agent,task}]})`
3. **三条禁止**(违反即 bug):
   - ① 不把"教 agent 并行"下放给用户 skill.md
   - ② 不让 agent 绕 subagent 做并行 task(会丢受保护工具授权)
   - ③ 不让 agent 用 bash/python 中转构造 JSON 喂 run_task
4. **发现性铁律**:parallel 模式必须和 subagent 同等可见(写在 description 首行)。

### 红线 B:AGENTS.md 的两条铁律

> `run_task` — subtask 工具:让 main agent 复用已机器验收的 taskbook,返回 PASS/FAIL + 产物路径。**两条铁律:需求驱动(任务确定才匹配 taskbook);责任归 LLM(dispatcher 翻译失败直接报错,headless 不弹 UI)。task 是最小单位,不可嵌套。**

---

## 3. 代码地图

### task 模块(`extensions/task/`,16 个文件)

| 文件 | 大小 | 职责 |
|---|---:|---|
| **task.ts** | 110KB | 🎯 核心。`run_task` 工具定义、single/parallel、dispatcher 调用、FAIL 反馈 |
| task-dispatcher.ts | 20KB | LLM 输出解析 + 字段校验(刚加 `unknownRuntimeFields` 检测) |
| task-book.ts | 12KB | taskbook 结构/加载 |
| task-prompts.ts | 11KB | buildTaskDispatcherPrompt 等提示词 |
| task-worker.ts | 7KB | subagent worker 执行器 |
| task-share-publish.ts | 7KB | `/task publish` 上线 marketplace |
| task-share-auth.ts | 7KB | task 分享的 cli-auth 流 |
| task-utils.ts | 6KB | 工具函数 |
| task-state.ts | 5KB | task 状态机 |
| task-worker.ts | 7KB | worker 执行 |
| task-checker.ts | 4KB | 校验 |
| task-registry.ts | 3KB | taskbook 注册表 |
| task-verify.ts | 3KB | 机器验收 |
| task-run-reviewer.ts | 2KB | run 回顾 |
| task-guide.ts | 2KB | `/task` 菜单 |
| task-spec.ts | 2KB | spec 定义 |

> `task.ts` 110KB 偏大,若本次设计涉及拆分,注意它是高频改动文件(近 4 个 PR 都动它)。

### 测试(`tests/`,15 个 task 相关)

```
smoke-task.test.ts          # 端到端 smoke(需真实环境,scripts/smoke-task.mjs)
subtask-tool.test.ts        # run_task 工具本身
task-book.test.ts           # taskbook
task-checker.test.ts
task-dispatcher.test.ts     # 🎯 dispatcher,最近 #38/#39 都在这加测试(38/38 全绿)
task-extension.test.ts
task-install.test.ts
task-marketplace-functions.test.ts
task-share-auth.test.ts
task-share-i18n.test.ts
task-share-publish.test.ts
task-state.test.ts
task-utils.test.ts
task-verify.test.ts
task-worker.test.ts
```

跑法:
```bash
npm test                                    # 全量(当前 577 pass)
node --test tests/task-dispatcher.test.ts   # 单文件(改 dispatcher 时用)
npm run smoke:task                          # 端到端(需真实 MCP/进程环境)
```

---

## 4. 设计文档指针(`docs/design/`)

| 文档 | 内容 |
|---|---|
| **2026-06-26-task-atomic-unit-and-parallel-primitive.md** | 🎯 权威。原子单元 + parallel 原语,task.ts 顶部注释的出处 |
| task-extension-spec.md | task 扩展总体 spec |
| task-extension-action-plan.md | 行动计划 |
| subtask-extension-spec.md | subtask(run_task)工具 spec |
| task-extension-followup.md ~ followup-8.md | 8 份迭代跟进(历史演进轨迹) |
| 2026-07-01-task-marketplace-r2-direct-storage.md | marketplace R2 直存 |
| 2026-07-01-task-publish-from-tui.md | `/task publish` 设计 |
| mcp-followup-tasks.md | MCP 后续任务 |

> 想了解"为什么这么设计",看 2026-06-26 那份 + followup 系列。followup-8 是最新的。

---

## 5. 最近 task 演进脉络(PR #36/#38/#39)

这三条修复串成一条"显式反馈"主线,**本次设计应延续这个原则**:

```
#36  缺依赖提示优化    → agent 遇缺 binary 不再绕路(建立因果 + 安装渠道 + PATH 验证)
#38  FAIL 根因进可见文本 → task FAIL 时 agent 看得到为什么(不再静默)
#39  未知字段硬检测    → dispatcher 字段写错能被检出并 FAIL(不静默吞)
```

共同原则(**摘自 #39 PR 说明**):
> "agent 会犯错是常态,框架的职责就是把明显能判断的错误显式反馈回去,而不是静默吞掉。静默 = 把 agent 的错变成我们的错。"

本次设计若有新错误路径,优先按此原则:检得出 → FAIL → 看得到 → agent 改正。

---

## 6. 待办/遗留(承自 PROJECT-GUIDE §8,与 task 相关)

- **结构债(P2)**:taskbook contract 校验三处不一致(cron daemon / extension 反向依赖也有关)。详见 `docs/handoff/2026-07-02-boundary-cleanup-plan.md` 附录。
- **`/task publish` 体验缺陷**:一路回车易误发。非 bug,留待决策。
- **`debug_log` 表**:`marketplace.js` 中的 `debugLog()` 调用点,flow 稳定后应删。

---

## 7. 本 worktree 工作约定

- **改完 push**:在 worktree 里 `git push -u origin feat/task-redesign`,然后开 PR
- **通知治理会话**:push PR 后告诉治理会话(主仓 `E:/AII/ugk-core`),它按 SOP v2 合并(先确认主仓切回 main)
- **测试**:改完跑 `npm test`(fail 0)+ 相关单文件测试
- **类型**:`npx tsc --noEmit`(0 错误)
- **不直接改 main**:本 worktree 改动只进 `feat/task-redesign`,主仓 main 由治理会话管

---

## 8. 想了解

| 想了解 | 看哪 |
|---|---|
| task 原子单元 + parallel 设计 | `docs/design/2026-06-26-task-atomic-unit-and-parallel-primitive.md` |
| task.ts 改动红线 | `extensions/task/task.ts` 文件头 24 行注释 |
| AGENTS.md task 铁律 | `AGENTS.md` 的 `run_task` 段 |
| 最近 task 演进 | 本文 §5 + git log `extensions/task/` |
| 测试怎么跑 | 本文 §3 末尾 |
| 历史结构债 | `docs/handoff/2026-07-02-boundary-cleanup-plan.md` |
