# Judge edit 改造 + ALIGN 补充问题 — 执行交接 Message

> 本文件是一份**自包含的交接 message**,写给执行 agent(worker)。
> worker 对项目零认知,读这一份就能上手。可整段粘为 `@worker` 触发消息。

---

## 工作目录

**你的 cwd 是 `E:\AII\ugk-core`(项目根目录)。** 所有相对路径都以这里为根。`npm test` 在这里跑。不要 cd 到别处。

---

## 你是谁,在干什么

你被委派到 **ugk-core** 项目执行一个**小范围 UX 改造**任务。ugk-core 是基于 pi(pi-coding-agent)定制的 TypeScript 编码 agent。本次只改两个交互点,不改架构、不动数据模型。

**项目当前状态**: 分支 `codex/judge-taskbook`,工作树有未提交改动(任务书功能 + 之前的 prompt 修复),`npm test` 346 pass / 0 fail。你的改动**叠加在上面**,不破坏现有功能。

---

## ⚠️ 开工前必读(按顺序)

1. **`AGENTS.md`**(项目根)— 项目约定。重点:bash 走 **Git Bash**(`D:\Git\bin\bash.exe`),命令用 Linux 语法,Windows 路径用正斜杠;危险操作前确认。
2. **`docs/judge.md`** — Judge 模式当前事实。
3. **`extensions/judge/questionnaire.ts`** — questionnaire 工具完整实现(API、返回结构)。本次改造的核心工具。
4. **`extensions/judge/judge-prompts.ts` 的 `ALIGN_PROMPT`** — 新建任务的 Judge 对齐 prompt。
5. **`extensions/judge/judge.ts` 的 `handleTaskbookEdit` 函数** — 本次要重写的函数(搜索这个函数名)。

---

## 任务一句话

两个独立的小改造:
1. **`/judge edit <name>` 改成交互式 questionnaire**:不再让用户手改 JSON,而是用 questionnaire 工具逐字段问 spec 的 5 个字段,问完再追加一题「还有什么要补充的吗?」。
2. **ALIGN_PROMPT 强制追加补充题**:无论新建还是 edit,**所有 questionnaire 调用末尾必须追加一题**「你还有什么要补充的吗?」,用户输入的自由文本拼到 spec 的 `context` 字段。

---

## 任务一:`/judge edit` 改成交互式 questionnaire(路径 1)

### 背景

当前 `handleTaskbookEdit`(`extensions/judge/judge.ts`,搜函数名定位)的实现是:
- 弹 `ctx.ui.editor("编辑任务书 spec", JSON.stringify(loaded.spec, null, "\t"))` 让用户改 JSON
- parse + 校验 + 存回

**问题**:让用户手改 JSON 太蠢,违背 Judge 模式「agent 帮你精确化需求」的精神。

### 目标实现

把 `handleTaskbookEdit` 重写为**逐字段问卷**(不用 Judge LLM,直接在 handler 里手动构造问题,用 `ctx.ui.select` / `ctx.ui.editor` 原语,不通过 questionnaire 工具——因为 questionnaire 工具是给 Judge LLM 调的,handler 里直接用 ctx.ui 更简单)。

**6 题固定问卷**:
1. goal(当前值,允许改成「Type another answer」走 `ctx.ui.editor`)
2. hardConstraints(当前值,数组,允许改)
3. acceptance(当前值,数组,允许改)
4. forbidden(当前值,数组,允许改)
5. context(当前值,允许改)
6. **「你还有什么要补充的吗?」**(必加,free-form editor,允许空)

**交互规则**:
- 每题给 2 个选项:`"保持当前:<当前值摘要>"` 和 `"修改"`。选「修改」时弹 `ctx.ui.editor` 让用户输入新值。
- 数组字段(hardConstraints/acceptance/forbidden)在 editor 里用**一行一条**的格式(用户输入多行,代码按 `\n` split + trim + filter)。
- 第 6 题必答但允许空:用户不输入就空字符串,不报错。
- 第 6 题的答案**拼到 context 末尾**(格式:`<原 context>\n\n补充: <用户输入>`,空则不拼)。
- 全部走完后调 `updateTaskbookSpec(cwd, name, newSpec)` 存回,notify「任务书 <name> 已更新」。
- 任何一步用户取消(空返回),整个 edit 中止,notify「编辑已取消」,不存。

### 容错

- loadTaskbook 失败 notify warning 退出(现有逻辑保留)
- editor 返回 undefined 视为取消该字段(保持原值),不报错
- 整个流程 try/catch 包住,异常 notify warning 不抛

---

## 任务二:ALIGN_PROMPT 强制追加补充题

### 背景

当前 `ALIGN_PROMPT`(`extensions/judge/judge-prompts.ts`)告诉 Judge 在 aligning 阶段调 questionnaire,但没有强制「最后一题必须是自由补充」。

### 目标实现

改 `ALIGN_PROMPT`,在「MANDATORY: confirm your assumptions」那段之后追加**硬性要求**:

> **MANDATORY closing question**: 不管你问了几个维度,**questionnaire 的最后一题**必须是 id=`"extras"`、prompt=`"你还有什么要补充的吗?(没有可留空)"`、只有一个选项 `{"value":"none","label":"没有了"}`、`allowOther: true` 的自由补充题。用户输入的自由文本必须**完整拼到 RequirementsSpec.context 字段**(格式:`<你原本要写的 context>\n\n补充: <用户输入>`,空则不拼)。这一题**不可省略**,不可用「不需要补充」之类的理由跳过。

**注意**:这题由 Judge LLM 在它构造 questionnaire 时自己加,不是 handler 强制加的。我们只改 prompt 强制 Judge 这么做。

### 兼容性

- 现有 ALIGN_PROMPT 测试可能断言 prompt 里某些字样,改完跑 `npm test` 看哪些挂了,同步改测试断言(参考之前 DECIDE prompt 改动时改 `tests/judge-summary.test.ts` 的做法)。
- Judge LLM 可能偶尔不遵守「必加补充题」——这是 LLM 行为,我们只能靠 prompt 强约束,不能 100% 保证。测试不验证 LLM 行为,只验证 prompt 文本含必加要求。

---

## 不可违反的硬约束

| # | 约束 | 违反后果 |
|---|---|---|
| HC1 | **先写测试后改代码**(TDD),`npm test` 全绿才算完成 | 回归风险 |
| HC2 | **不破坏现有 `/judge` 从零对齐流程**和 `/judge save/run/list` | 破坏已验证功能 |
| HC3 | **edit 改造不引入 Judge LLM 调用**——路径 1 是纯 handler 实现,直接用 `ctx.ui` 原语 | 偏离方案,引入复杂度 |
| HC4 | **taskbook.ts 不改**(updateTaskbookSpec 已经存在,直接用) | 不必要的改动 |
| HC5 | **driver.md / judge.md agent 定义不改** | 影响所有 run |
| HC6 | bash 走 Git Bash + Linux 语法 | 命令失败 |
| HC7 | 所有新代码**容错**:用户取消/输入异常只 notify,不抛未捕获异常 | 流程被打断 |
| HC8 | **edit 流程的 6 题必须按顺序**问完,不能中途断(除非用户主动取消) | UX 不一致 |

---

## TDD 实施步骤

### 步骤 A:`/judge edit` 改造
1. 读 `extensions/judge/judge.ts` 找到 `handleTaskbookEdit`,理解当前实现
2. 写测试 `tests/judge-extension.test.ts`:
   - `/judge edit foo` 弹 6 次 select(5 字段 + 补充题)
   - 选「修改」时弹 editor
   - 数组字段按 `\n` split
   - 补充题答案拼到 context
   - 用户中途取消(某次 select 返回空)→ 中止 + notify
   - 走完调 updateTaskbookSpec
3. 重写 `handleTaskbookEdit`
4. 跑 `npm test`,改挂的测试

### 步骤 B:ALIGN_PROMPT 改造
1. 写/改测试 `tests/judge-utils.test.ts` 或 `tests/judge-summary.test.ts`:
   - ALIGN_PROMPT 含「extras」「你还有什么要补充的吗」「context」字样
2. 改 `extensions/judge/judge-prompts.ts` 的 `ALIGN_PROMPT`
3. 跑 `npm test`,改挂的测试

### 步骤 C:确认
- `npm test` 全绿(346 + 新增)
- 手动试 `/judge edit <某个已有任务书>`(在 `E:\AII\TUI` 那个项目下试,那边有 taskbook-zhihu)
- 报告改动

---

## 报告格式

1. 改了哪些文件(列表)
2. 新增测试数 + `npm test` 结果(pass/fail 数)
3. `/judge edit` 的交互流程描述(6 题顺序 + 取消行为)
4. ALIGN_PROMPT 改动的关键段落(贴出来)
5. 有没有偏离本交接文档(如果有,说明原因)

---

## 速查:关键文件

| 用途 | 文件 |
|---|---|
| 项目约定 | `AGENTS.md` |
| Judge 现状 | `docs/judge.md` |
| questionnaire 工具 | `extensions/judge/questionnaire.ts` |
| ALIGN_PROMPT | `extensions/judge/judge-prompts.ts` |
| handleTaskbookEdit(要重写) | `extensions/judge/judge.ts`(搜函数名) |
| taskbook.ts(只读,用 updateTaskbookSpec) | `extensions/judge/taskbook.ts` |
| edit 测试要加在 | `tests/judge-extension.test.ts` |
| prompt 测试在 | `tests/judge-utils.test.ts` / `tests/judge-summary.test.ts` |

---

## 你的第一步

1. 读 `AGENTS.md`
2. 读 `extensions/judge/questionnaire.ts`(理解问卷原语)
3. 读 `extensions/judge/judge.ts` 里 `handleTaskbookEdit` 当前实现
4. 读 `extensions/judge/judge-prompts.ts` 的 `ALIGN_PROMPT`
5. 开始步骤 A:先写 edit 的测试,再重写 handler
6. 步骤 B:改 ALIGN_PROMPT
7. `npm test` 全绿报告

**不确定就停下来问,不要猜。** 本文档是权威。
