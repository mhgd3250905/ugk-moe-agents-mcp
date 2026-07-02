# /judge edit 改造方案 (a) — 复用 ALIGN 流程

> 本文件是一份**自包含的交接 message**,写给执行 agent(worker)。
> worker 对项目零认知,读这一份就能上手。可整段粘为 `@worker` 触发消息。

---

## 工作目录

**你的 cwd 是 `E:\AII\ugk-core`(项目根目录)。** 所有相对路径都以这里为根。`npm test` 在这里跑。不要 cd 到别处。

---

## 你是谁,在干什么

ugk-core 是基于 pi(pi-coding-agent)的 TypeScript 编码 agent。本次任务只改一个交互点:**把 `/judge edit <name>` 从「写死 5 题用 ctx.ui.select 弹菜单」改造成「复用 ALIGN 流程,让 Judge agent 亲自拿着现有 spec 一条一条问用户」**。

**项目当前状态**: 分支 `codex/judge-taskbook`,HEAD `c35bed6` 已提交(任务书 + 多个 bug 修复)。`npm test` 348 pass / 0 fail。你的改动叠加在上面,不破坏现有功能。

---

## ⚠️ 开工前必读(按顺序)

1. **`AGENTS.md`** — 项目约定。bash 走 Git Bash(`D:\Git\bin\bash.exe`),Linux 语法,Windows 路径用正斜杠;危险操作前确认。
2. **`docs/judge.md`** — Judge 模式当前事实。
3. **`extensions/judge/judge-prompts.ts`** — ALIGN_PROMPT 的写法(你要照着写 EDIT_PROMPT)。
4. **`extensions/judge/judge.ts`** — 核心改动文件。重点读:
   - `enableJudge`(`:401-410`) — 进 aligning 的入口
   - `pi.on("before_agent_start", ...)`(`:964-973`) — **ALIGN_PROMPT 的注入点,你要改这里**
   - `pi.on("agent_end", ...)`(`:1031` 起)— Spec 提取 + 菜单逻辑,你要加 edit 模式分支
   - `handleTaskbookEdit`(`:825` 起)— **要重写**
5. **`extensions/judge/judge-state.ts`** — JudgeState 类型,`state.spec` 字段装 RequirementsSpec,edit 时要用。

---

## 背景与用户意图

### 当前 `/judge edit` 的问题(必须改掉)

现在 `handleTaskbookEdit` 是写死的:弹 6 次 `ctx.ui.select`,每题只有「保持当前/修改」两个选项,选「修改」才弹 editor。**用户讨厌这种「土味表单」体验**,明确要求:

> 我要的是 **judge agent 拿着这五条一条一条问我确认,像 question 环节一样**。

也就是:edit 应该**和新建任务 ALIGN 阶段的体验完全一致**——Judge LLM 亲自读现有 spec,自己决定问什么(可能 goal 没问题就跳过,可能 acceptance 第 2 条歧义就专门问那条),用 questionnaire 工具问,自然语言对话,**不是写死的固定流程**。

### 关键决策(已和用户 ugk-dev 拍板)

| # | 决策 | 定论 |
|---|---|---|
| D1 | edit 用哪种交互 | **(a) 让 Judge LLM 亲自问**——复用 ALIGN 流程,只是 prompt 换成 EDIT_PROMPT,起点是已有 spec |
| D2 | Judge 产出新 Spec 后走哪条路 | **(ii) 弹专门菜单 `["存回任务书", "继续调整", "放弃"]`**——不直接覆盖,给用户确认机会 |

---

## 核心设计:复用 ALIGN 三件事

ALIGN 流程的本质是 3 件事,edit 全部复用,只是参数不同:

| 步骤 | ALIGN(新建) | EDIT(改造后) |
|---|---|---|
| 1. 进 phase | `enableJudge` → `enterAligning(state)` | `handleTaskbookEdit` → `enterAligning(setRequirementsSpec(state, loaded.spec))` + 设置 `state.aligningMode = "edit"` + `state.taskbookName = name` |
| 2. 注入 prompt | before_agent_start 注入 `ALIGN_PROMPT` | before_agent_start 根据 `state.aligningMode` 注入 `ALIGN_PROMPT` 或 `EDIT_PROMPT`(后者含 `state.spec` 序列化) |
| 3. Spec 提取 + 菜单 | agent_end 提取 Spec → 弹 `["委派 driver 执行", "继续澄清", "改需求"]` | agent_end 提取 Spec → **若 `state.aligningMode === "edit"`,弹 `["存回任务书", "继续调整", "放弃"]`,不弹「委派 driver」** |

---

## 具体改动清单

### 改动 1:`extensions/judge/judge-state.ts` 加字段

`JudgeState` 加一个字段:

```ts
aligningMode?: "new" | "edit";   // 缺省/undefined = "new"(普通 ALIGN);"edit" = edit 任务书模式
```

加一个 state 转换函数:

```ts
export function setAligningMode(state: JudgeState, mode: "new" | "edit"): JudgeState {
  return { ...state, aligningMode: mode };
}
```

**`enterAligning` 要复位 aligningMode**:`enterAligning` 重置字段时把 `aligningMode` 也重置回 `"new"`(避免上次 edit 残留)。

**`enableJudge` 路径**:`enableJudge`(`judge.ts:405`)调 `enterAligning({...state, taskbookName: undefined})`——这里也要确保 `aligningMode` 是 `"new"`,但 `enterAligning` 复位了就够。

### 改动 2:`extensions/judge/judge-prompts.ts` 加 EDIT_PROMPT

照着 ALIGN_PROMPT 的结构写,关键差异:
- **告诉 Judge 这是 edit,不是新建**——起点是用户给定的 RequirementsSpec(已提供)
- **Judge 的任务是「对照现有 spec,找出该问用户的点」**——不是从零收集需求,是找出 spec 里模糊/可改进/需确认的地方
- **保留 ALIGN_PROMPT 的硬约束**:MANDATORY questionnaire、5 个维度、末尾必加 `extras` 补充题(详见 ALIGN_PROMPT)
- **要求 Judge 不要为了问而问**——如果 spec 已经清晰,可以少问;但绝不能不调 questionnaire 就直接产出 Spec(C-2 闸仍然适用)

签名建议:

```ts
export const EDIT_PROMPT = `[JUDGE EDIT MODE]
You are Judge, editing an existing taskbook's RequirementsSpec together with the user.

The user has an existing RequirementsSpec (provided below as ExistingSpec). They want to revise it. Your job:
- Read ExistingSpec carefully. Identify points that are ambiguous, outdated, missing, or worth reconsidering.
- Use the questionnaire tool to confirm each such point with the user, offering your read of the current value and alternatives.
- Do NOT ask about everything — only the points that genuinely benefit from user confirmation. If a field is already clear, skip it.
- But you MUST call questionnaire at least once before emitting the revised Spec (C-2 gate still applies).
- Cover the standard dimensions (scope/source/timeliness/format/strictness) only where ExistingSpec is weak.

[复用 ALIGN_PROMPT 的 MANDATORY closing question 段落 — 末尾必加 extras 补充题,用户输入拼到 context]

When done, emit the revised RequirementsSpec JSON in the same shape as ALIGN (goal/hardConstraints/acceptance/forbidden/context).

## ExistingSpec
\`\`\`json
<这里在运行时用 buildEditPrompt 填入 state.spec 序列化>
\`\`\`
`;
```

加一个 builder:

```ts
export function buildEditPrompt(existingSpec: RequirementsSpec): string {
  return [
    EDIT_PROMPT_TEMPLATE,  // 不含 ExistingSpec 内容的模板
    "",
    "```json",
    JSON.stringify(existingSpec, null, "\t"),
    "```",
  ].join("\n");
}
```

(把 EDIT_PROMPT 拆成「模板 + builder」,因为 ExistingSpec 内容是运行时填的。或者直接 EDIT_PROMPT 是模板,builder 负责拼接——按 ALIGN_PROMPT 现有风格来。)

### 改动 3:`extensions/judge/judge.ts` 改 before_agent_start

现在(`:964-973`):
```ts
pi.on("before_agent_start", async () => {
  if (state.phase !== "aligning") return undefined;
  return {
    message: { customType: "judge-align-context", content: ALIGN_PROMPT, display: false },
  };
});
```

改成根据 `state.aligningMode` 选 prompt:
```ts
pi.on("before_agent_start", async () => {
  if (state.phase !== "aligning") return undefined;
  const content = state.aligningMode === "edit" && state.spec
    ? buildEditPrompt(state.spec)
    : ALIGN_PROMPT;
  return {
    message: { customType: "judge-align-context", content, display: false },
  };
});
```

### 改动 4:`extensions/judge/judge.ts` 改 agent_end 的菜单分支

现在 agent_end 提取 Spec 后弹 `["委派 driver 执行", "继续澄清", "改需求"]`。改成:**edit 模式弹不同菜单**。

找到现在的菜单逻辑(应该在 `:1052` 附近,搜 `JUDGE_MENU_OPTIONS`),加分支:

```ts
const menuOptions = state.aligningMode === "edit"
  ? ["存回任务书", "继续调整", "放弃"]
  : JUDGE_MENU_OPTIONS;  // ["委派 driver 执行", "继续澄清", "改需求"]
const choice = await ctx.ui.select("Judge next step", menuOptions);

if (state.aligningMode === "edit") {
  if (choice === "存回任务书") {
    // state.spec 是 Judge 刚产出的新 Spec
    await updateTaskbookSpec(getCwd(ctx), state.taskbookName!, state.spec!);
    // 注意:updateTaskbookSpec 当前不重渲 experience.md(上次决定),保持
    ctx.ui.notify(`任务书 "${state.taskbookName}" 已更新。`, "info");
    // 退出 edit 模式:phase done,清 aligningMode
    state = completeJudge({...state, aligningMode: undefined});
    persistState(pi, state);
    restoreActiveTools();
    setJudgeStatus(ctx, undefined);
    return;
  }
  if (choice === "继续调整") {
    // 继续 aligning,但保留 state.spec 作为新起点?还是清掉重问?
    // 设计决定:保留 state.spec(Judge 上一轮产出的新 Spec),让 Judge 继续基于它问
    // 不需要再调 sendUserMessage,因为 agent 已经 end;用 followUp 触发新一轮
    pi.sendUserMessage("用户想继续调整 Spec。请针对用户不满意的地方继续用 questionnaire 确认,然后重新产出 Spec。", { deliverAs: "followUp" });
    return;
  }
  if (choice === "放弃") {
    ctx.ui.notify(`已放弃对任务书 "${state.taskbookName}" 的修改。`, "info");
    state = abortJudge({...state, aligningMode: undefined});
    persistState(pi, state);
    restoreActiveTools();
    setJudgeStatus(ctx, undefined);
    return;
  }
  return;
}

// 以下是非 edit 模式的原逻辑(委派/继续澄清/改需求),保持不变
if (choice === "委派 driver 执行") { ... }
...
```

**关键细节**:
- 「存回任务书」用 `updateTaskbookSpec`(**不改 experience.md**——上次拍板的决定)
- 注意 `state.taskbookName` 此时一定有值(edit 模式进来的),用 `!` 断言
- 「继续调整」用 followUp 触发新一轮(注意 deliverAs,这是上轮 bug 修复学到的)
- 所有分支结束都要清 `aligningMode`,避免污染下次正常 ALIGN

### 改动 5:`extensions/judge/judge.ts` 重写 `handleTaskbookEdit`

把现在的 6 题 select 流程全部删掉,改成:

```ts
async function handleTaskbookEdit(ctx: ExtensionContext, rawName?: string): Promise<void> {
  const name = rawName || await chooseTaskbookName(ctx);
  if (!name) return;
  if (!isValidTaskbookName(name)) {
    ctx.ui.notify("任务书名无效,只能使用字母、数字、-、_。", "warning");
    return;
  }
  try {
    const loaded = await loadTaskbook(getCwd(ctx), name);
    if (!loaded) {
      ctx.ui.notify(`任务书 "${name}" 不存在。`, "warning");
      return;
    }
    // 进入 edit 模式的 aligning:预填 spec + 标记 mode + 标记 taskbookName
    restoreToolsSnapshot ??= typeof pi.getActiveTools === "function"
      ? pi.getActiveTools()
      : JUDGE_NORMAL_TOOLS;
    state = enterAligning(state);  // 复位(包括 aligningMode 回到 "new")
    state = setRequirementsSpec(state, loaded.spec);
    state = setAligningMode(state, "edit");
    state = setTaskbookForRun(state, name);  // 复用这个函数记 taskbookName
    pi.setActiveTools(JUDGE_ALIGNING_TOOLS);
    persistState(pi, state);
    setJudgeStatus(ctx, "⚖ edit");
    // 触发一轮 agent:用户会看到 Judge 用 questionnaire 问问题
    // before_agent_start 会注入 EDIT_PROMPT(含 loaded.spec)
    pi.sendUserMessage(`开始编辑任务书 "${name}"。请对照现有 Spec 用 questionnaire 确认需要修改的地方,然后产出修订后的 Spec。`, { deliverAs: "followUp" });
    ctx.ui.notify(`进入任务书 "${name}" 编辑模式。Judge 会逐条确认现有 Spec。`, "info");
  } catch (error) {
    ctx.ui.notify(`进入编辑模式失败: ${error instanceof Error ? error.message : String(error)}`, "warning");
  }
}
```

**注意**:这里调 `pi.sendUserMessage` 触发首轮。但 `sendUserMessage` 在 agent 已 idle 时是安全的(不在 streaming)——这是 command handler 上下文,不在 agent_end handler 里,所以**不需要 followUp**。但保险起见还是带上 followUp(若 idle 则 followUp 被忽略,不报错)。**重新核查这点**:`/judge edit` 是用户在 TUI 输入的命令,此时 agent 应该是 idle,不带 followUp 也行。但带上无害,且能防御 agent 还没完全 idle 的边界情况。

**注意 setJudgeStatus**:用 `"⚖ edit"` 区分编辑模式,让用户在 footer 看得到当前状态。

### 改动 6:清理旧 edit 实现

删掉旧的 6 题 select 流程(`ask` helper、`summarize`、`lines`、6 个 if cancelled 分支)。`updateTaskbookSpec` 的 import 保留(改动 4 还要用)。

### 改动 7:`extensions/judge/judge-state.ts` 持久化兼容

`persistState`(`judge.ts:295` 附近)和 `restoreJudgeState`(`:329` 附近)要带上 `aligningMode`:

```ts
// persistState 里加:
aligningMode: state.aligningMode,

// restoreJudgeState 里加(容错):
aligningMode: record.aligningMode === "edit" ? "edit" : "new",
```

让 session 重启后 edit 模式状态能恢复。

### 改动 8:文档更新

- **`docs/judge.md`** 的任务书章节:`/judge edit` 描述改成「进入 Judge 对齐编辑模式,Judge 会逐条确认现有 Spec;完成后可选择存回/继续调整/放弃」
- **`docs/design/2026-06-21-judge-taskbook-spec.md`** 加一个附录 D:记录 edit 改造决策((a) + (ii)),以及为什么之前 6 题 select 方案被否

---

## 不可违反的硬约束

| # | 约束 |
|---|---|
| HC1 | **TDD**,先写测试后改代码,`npm test` 全绿(348 + 新增)才完成 |
| HC2 | **不破坏现有 ALIGN 流程**——`aligningMode === "new"`(或 undefined)时所有行为零变化 |
| HC3 | **edit 模式必须复用 ALIGN 三件事**(进 phase / 注入 prompt / Spec 提取),不要新写一套 |
| HC4 | **edit 模式产出 Spec 后弹 `["存回任务书", "继续调整", "放弃"]`**,绝不弹「委派 driver」 |
| HC5 | **存回用 updateTaskbookSpec,不改 experience.md**(上次决定) |
| HC6 | **aligningMode 在 edit 结束时必须清掉**(存回/放弃/任何退出路径),避免污染下次正常 ALIGN |
| HC7 | **EDIT_PROMPT 保留 ALIGN_PROMPT 的所有硬约束**:MANDATORY questionnaire、5 维度、末尾 extras 补充题 |
| HC8 | `pi.sendUserMessage` 在 agent_end handler 内调用时**必须带 `{ deliverAs: "followUp" }`**(上轮 bug 学到的,agent_end 触发时 agent 还不是 idle) |
| HC9 | bash 走 Git Bash + Linux 语法 |
| HC10 | 所有新代码容错:用户取消/磁盘失败只 notify,不抛未捕获异常 |
| HC11 | **C-2 闸仍然适用 edit 模式**——Judge 必须调 questionnaire 才能产出 Spec,edit 也不能跳过 |

---

## TDD 实施步骤

### 步骤 A:state 字段 + EDIT_PROMPT
1. 写测试 `tests/judge-state.test.ts`:`setAligningMode` 正确设置;`enterAligning` 复位 aligningMode 为 "new"
2. 写测试 `tests/judge-utils.test.ts` 或新建 prompt 测试文件:`buildEditPrompt` 含 EDIT_PROMPT 关键字 + 序列化的 spec
3. 改 `judge-state.ts`(加字段 + 转换函数 + enterAligning 复位)
4. 改 `judge-prompts.ts`(加 EDIT_PROMPT + buildEditPrompt)
5. `npm test` 通过

### 步骤 B:before_agent_start 分支
1. 写测试:aligningMode="edit" 时 before_agent_start 注入 EDIT_PROMPT;="new"/undefined 时注入 ALIGN_PROMPT
2. 改 `judge.ts` before_agent_start handler
3. `npm test` 通过

### 步骤 C:handleTaskbookEdit 重写
1. 写测试 `/judge edit foo` 进入 edit aligning(state.phase=aligning, aligningMode="edit", taskbookName="foo", spec 预填)
2. 重写 `handleTaskbookEdit`,删旧 6 题逻辑
3. `npm test` 通过

### 步骤 D:agent_end 菜单分支
1. 写测试:edit 模式产出 Spec 后弹 `["存回任务书", "继续调整", "放弃"]`;选「存回」调 updateTaskbookSpec;选「继续调整」followUp 继续问;选「放弃」abortJudge
2. 改 `judge.ts` agent_end 菜单逻辑
3. `npm test` 通过

### 步骤 E:持久化兼容 + 文档
1. 写测试:session 重启后 aligningMode 恢复
2. 改 persistState/restoreJudgeState
3. 改 docs/judge.md 和 spec 文档
4. `npm test` 全绿(348 + 新增)

---

## 报告格式

完成后报告:
1. 改了哪些文件(列表)
2. 新增测试数 + `npm test` 结果(pass/fail 数)
3. EDIT_PROMPT 的关键段落(贴出来)
4. edit 模式的菜单长什么样
5. 是否有偏离本交接文档

---

## 速查:关键文件

| 用途 | 文件 |
|---|---|
| 项目约定 | `AGENTS.md` |
| Judge 现状 | `docs/judge.md` |
| ALIGN_PROMPT 模板 | `extensions/judge/judge-prompts.ts` |
| JudgeState 类型 | `extensions/judge/judge-state.ts` |
| enableJudge / before_agent_start / agent_end | `extensions/judge/judge.ts` |
| handleTaskbookEdit(要重写) | `extensions/judge/judge.ts:825` |
| updateTaskbookSpec(存回用) | `extensions/judge/taskbook.ts` |
| 现有 edit 测试(要改) | `tests/judge-extension.test.ts:514,559` |
| 持久化 persistState/restoreJudgeState | `extensions/judge/judge.ts:295,329` |

---

## 你的第一步

1. 读 `AGENTS.md`
2. 读 `extensions/judge/judge-prompts.ts`(ALIGN_PROMPT 全文)— 照着写 EDIT_PROMPT
3. 读 `extensions/judge/judge.ts` 的 enableJudge / before_agent_start / agent_end 三段
4. 读 `extensions/judge/judge-state.ts` 的 JudgeState + enterAligning
5. 开始步骤 A:state 字段 + EDIT_PROMPT(先写测试)
6. 按步骤 B/C/D/E 推进
7. `npm test` 全绿报告

**不确定就停下来问,不要猜。** 本文档是权威。

---

## 附录:用户原话(为什么是这个方案)

> 这个编辑我很不满意 ... 我要的是 judge agent 拿着这五条一条一条问我确认 像 question 环节一样

用户两次否定写死的表单式交互(第一次是手改 JSON,第二次是 6 题 select 菜单),明确要求「像 ALIGN 一样,Judge 亲自问」。本次 (a) 方案忠实实现这个意图:edit = 起点 spec 已有的 ALIGN,完全复用 ALIGN 的体验。
