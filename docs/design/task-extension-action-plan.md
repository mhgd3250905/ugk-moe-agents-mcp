# `/task` 实现行动计划

> **状态:已完成(2026-06-22)。** 保留作历史材料,记录 v1 主实现的步骤和决策依据。当前实现细节以 `extensions/task/` 代码 + `docs/design/task-extension-spec.md` 的"v1 实现注记"为准。
>
> **原始用途**:给执行 agent 的交接文档,让它按顺序把 `/task` 这个新功能做出来。
>
> **必读前置**:`docs/design/task-extension-spec.md`(需求规格,说"做什么")。本文是行动计划,说"怎么做"。
>
> **工作目录**:`E:\AII\ugk-core`,当前分支 `main`。
>
> **更新时间**:2026-06-22

---

## 必读约束(违反任何一条都算交付失败)

- **始终中文交流**(代码注释、commit message、文档全中文;代码标识符用英文)。
- **遵守 `E:\AII\ugk-core\AGENTS.md`**:bash 工具走 Git Bash(`D:\Git\bin\bash.exe`),Linux 语法,Windows 路径用正斜杠。
- **最小改动,Node stdlib 优先**,不新增依赖(AGENTS.md 的 ponytail 原则)。
- **不要提交未跟踪的旧文档**。`git status` 显示的 8 个未跟踪 `docs/` 文件(flow-removal-*, mcp-menu-redesign, v2-cleanup-pr-a, 2026-06-19/21-*, agent-a-pr2-*, 2026-06-21-*)是历史材料,不是你的工作范围,不要 `git add` 它们。
- **不要输出或复述任何 API key**。
- **不要碰 Judge 代码**(`extensions/judge/**`、`tests/judge-*.test.ts`)。`/task` 复用 Judge 的零件(import 纯函数),但绝不修改 Judge 的实现。如果发现 Judge 的某个函数签名不够用,**fork 一份到 `/task` 自己的目录,不要改 Judge**。
- **不要碰未提交的 smoke-tui 改动**(`scripts/smoke-tui.mjs`、`tests/smoke-tui.test.ts` 有 M 标记)。
- **每个步骤完成后跑 `npm test` 确认 352 个测试全过**(基线数字,可能因你新增测试而增加,但原有测试不能减少)。

---

## 已有的基线信息(你不用重新探索)

执行前先知道这些,省去探索时间:

### 仓库技术栈
- TypeScript ESM(`"type": "module"`),Node 原生跑(不是 tsc 编译)
- 测试:`node --test "tests/*.test.ts"`,集成测试在 `tests/integration/`
- pi 版本:`@earendil-works/pi-coding-agent@0.79.4`
- 扩展入口:`extensions/index.ts:75` 的默认导出工厂,内部调各 `registerXxx(pi)`

### 必读的 3 个参考实现(交互模板的来源)
- `extensions/chrome-cdp/index.ts`:`/cdp` 命令的完整实现,**菜单驱动模式的范本**(看 `resolveCdpArgs:197`、`CDP_MENU_OPTIONS:31`)
- `extensions/judge/judge.ts`:`/judge` 命令的完整实现,**状态机+菜单+子命令分发的范本**(看 `registerJudge:403`、`getJudgeCommandMenuOptions:421`、`resolveJudgeCommandArgs:983`、命令 handler `1007-1116`)
- `extensions/judge/taskbook.ts`:taskbook 落盘/加载的**纯函数范本**(看 `saveTaskbook:94`、`loadTaskbook:116`、`sortAndTrimRuns:80`、`draftExperienceMd:202`)

### 可直接 import 的 Judge 零件(零改动复用)
| 函数/类型 | 文件:行 | 用途 |
|---|---|---|
| `RequirementsSpec` 类型 | `extensions/judge/judge-state.ts:3` | Spec 结构 |
| `registerQuestionnaire(pi)` | `extensions/judge/questionnaire.ts:55` | 注册 questionnaire 工具,**全局工具不要重复注册**——如果 Judge 已注册,`/task` 不要再注册一次 |
| `extractRequirementsSpec(text)` | `extensions/judge/judge-utils.ts:234` | 从 LLM 输出捞 Spec(三级 fallback) |
| `normalizeSpec(value)` | `extensions/judge/judge-utils.ts:208` | Spec 校验(strict 版) |
| `formatRequirementsSpec(spec)` | `extensions/judge/judge-utils.ts:254` | Spec 格式化 |
| `isRequirementsSpec(value)` | `extensions/judge/taskbook.ts:38` | Spec 校验(lax 版,加载用) |
| `sortAndTrimRuns(runs)` | `extensions/judge/taskbook.ts:80` | runs 截断到最近 10 条 |

### spawn 子进程的范本(用于 worker/checker 派遣)
- `extensions/subagent.ts:73` 的 `runSingleAgent` 是完整范本(**注意:它目前是模块私有,没 export**)。
- `extensions/subagent.ts:51` 的 `getPiInvocation` 也是私有的。
- **建议**:把 `runSingleAgent` 和 `getPiInvocation` 从 `subagent.ts` export 出来,`/task` 直接 import。这是最小改动。如果你不想动 subagent.ts,**fork 一份到 `extensions/task/task-spawn.ts`,逐行照搬**。

### pi ExtensionAPI 关键能力(`@earendil-works/pi-coding-agent` 的类型定义)
- `pi.registerCommand(name, {description, handler})`:注册 slash 命令,handler 拿 `(args, ctx: ExtensionCommandContext)`
- `pi.registerTool(tool)`:注册工具
- `pi.on(event, handler)`:订阅事件(`session_start`/`session_shutdown`/`before_agent_start`/`tool_call`/`input`/`agent_end`)
- `pi.appendEntry(customType, data?)`:持久化 state 到 session JSONL(参考 `judge.ts:296` 的 `persistState`)
- `pi.setActiveTools(names)`:切换工具集(参考 `judge.ts:443`)
- `pi.getActiveTools()`:拿当前工具集
- `pi.sendUserMessage(text, {deliverAs})`:给 agent 注入消息
- `ctx.ui.select(title, options)` / `ctx.ui.confirm(title, msg)` / `ctx.ui.input(title, placeholder)` / `ctx.ui.notify(msg, level)` / `ctx.ui.setStatus(key, value)` / `ctx.ui.setWidget(key, lines, {placement})` / `ctx.ui.editor(title, prefill)`

### 测试基线
- `npm test` 当前是 **352/352 pass**
- 你每加一个功能,加对应的 `tests/*.test.ts` 文件
- 测试用 `node:test` + `node:assert/strict`,参考现有 `tests/judge-*.test.ts` 的写法

---

## 实现步骤(按顺序执行,每步独立可验证)

### 步骤 0:准备工作

1. `git status` 确认当前工作区,看到 `M scripts/smoke-tui.mjs`、`M tests/smoke-tui.test.ts` 和 8 个未跟踪 docs 文件——**这些都不是你的工作范围,不要动**。
2. 新建工作目录:`extensions/task/`(放所有 `/task` 的 .ts 文件)
3. 新建测试文件目录(就用现有 `tests/`):`tests/task-*.test.ts`

**验收**:目录就绪,`npm test` 还是 352/352 pass。

---

### 步骤 1:`task-state.ts` + `task-book.ts` + 测试(纯函数,无副作用)

**目标**:`/task` 的状态机和 taskbook 落盘骨架,纯函数,先写测试驱动。

#### 1.1 创建 `extensions/task/task-state.ts`

照搬 `extensions/judge/judge-state.ts:1-207` 的 idiom,但:

- `TaskPhase = "planning" | "executing" | "reviewing" | "landed" | "aborted" | "done"`
- `TaskState` 字段:
  ```typescript
  interface TaskState {
    phase: TaskPhase;
    spec: RequirementsSpec | null;
    taskbookName?: string;
    summary: string;          // 执行摘要,review 阶段用
    retryCount: number;       // 复用阶段 worker 重试次数
    maxRetry: number;         // 默认 3
    planQuestionnaireUsed: boolean;   // C-2 闸:plan→execute
    reviewQuestionnaireUsed: boolean; // C-2 闸:review→land
  }
  ```
- 转换器(参考 judge-state.ts:97-207):
  - `createTaskState()`
  - `enterPlanning(state)` → phase="planning",复位 `planQuestionnaireUsed=false`
  - `startExecuting(state)` → phase="executing",**前置检查 `planQuestionnaireUsed===true`,否则 throw**
  - `enterReviewing(state, summary)` → phase="reviewing",存 summary
  - `landTask(state)` → phase="landed"
  - `abortTask(state)` → phase="aborted"
  - `completeTask(state)` → phase="done"
  - `markPlanQuestionnaireUsed(state)` → 幂等,仅 planning 阶段置位
  - `markReviewQuestionnaireUsed(state)` → 幂等,仅 reviewing 阶段置位
- 导出类型 + 所有转换器

#### 1.2 创建 `extensions/task/task-book.ts`

照搬 `extensions/judge/taskbook.ts` 的 idiom,但参数化根路径:

- `tasksRootUser()`:返回 `~/.pi/agent/tasks/`(用 `os.homedir()` 拼路径,**Windows 上是 `C:\Users\<user>\.pi\agent\tasks\`**)
- `tasksRootProject(cwd)`:返回 `<cwd>/.tasks/`
- `taskDir(scope, cwd, name)`:按 scope 返回对应目录
- `Taskbook` 类型(参考 `taskbook.ts:14-20`,但加 `scope: "user"|"project"`、`tags?: string[]`、run 结构按设计文档 3.2 节):
  ```typescript
  interface TaskRun {
    timestamp: string;
    status: "pass" | "fail";
    input: unknown;              // 本次运行时输入
    exitCode: number;
    verifyFailures: VerifyFailure[];
    duration: number;
  }
  interface Taskbook {
    name: string;
    description: string;
    scope: "user" | "project";
    createdAt: string;
    updatedAt: string;
    tags?: string[];
    runs: TaskRun[];
  }
  ```
- `saveTaskbook(scope, cwd, name, data:{description, spec, skill, verify, contract, tags?})`:
  - 校验 `isValidTaskbookName(name)`(`/^[A-Za-z0-9_-]+$/`)
  - `mkdir -p` 目录
  - 写 5 个文件:`taskbook.json`、`spec.json`、`skill.md`、`verify.mjs`、`contract.json`
  - **目录不存在时创建,存在时覆盖**(v1 不做版本管理)
- `loadTaskbook(cwd, name)`:**先查 project scope(`.tasks/<name>/`),再查 user scope(`~/.pi/agent/tasks/<name>/`)**。project 优先。返回 `{ taskbook, spec, skill, verify, contract, scope, dir }` 或 null
- `listTaskbooks(cwd)`:合并 user + project scope,按 name 排序,跳过损坏项。支持 `--tag` 筛选
- `appendRunToTaskbook(scope, cwd, name, run)`:追加 run,`sortAndTrimRuns` 保留最近 10 条(复用 Judge 的)
- `deleteTaskbook(scope, cwd, name)`:删除整个目录

#### 1.3 创建测试 `tests/task-book.test.ts` 和 `tests/task-state.test.ts`

参考 `tests/judge-extension.test.ts` 的写法,覆盖:
- `task-state.ts`:每个转换器、C-2 闸(startExecuting 前必须 planQuestionnaireUsed=true)、幂等性
- `task-book.ts`:落盘/加载/project 覆盖 user/损坏检测/list 合并/tag 筛选/runs 截断

**验收**:
- `npm test` 通过,新增的 task 测试全过
- 没破坏 Judge 测试(352 个原测试还在)

---

### 步骤 2:`task.ts` 注册器 + `/task list/show` 命令(能列能看,但不跑)

**目标**:把 `/task` 注册到 pi,实现只读命令。

#### 2.1 创建 `extensions/task/task.ts`

照搬 `extensions/judge/judge.ts:403-466` 的注册器结构:

```typescript
export function registerTask(pi: ExtensionAPI): void {
  let state = createTaskState();
  let restoreToolsSnapshot: string[] | undefined;

  function setTaskStatus(ctx, label?) { /* ctx.ui.setStatus("task-mode", label) */ }
  function isTaskActive() { /* phase in planning|executing|reviewing */ }
  function persistState(pi, state) { /* pi.appendEntry("task-state", {...}) */ }
  function restoreTaskState(data) { /* 从 appendEntry 数据恢复 */ }
  // ...

  registerQuestionnaire(pi); // 复用 Judge 的 questionnaire
  pi.registerCommand("task", { /* 见 2.2 */ });
  pi.on("session_start", ...);  // 恢复 state
  pi.on("session_shutdown", ...); // 清理
  pi.on("tool_call", ...);  // C-2 闸:planning/reviewing 阶段标记 questionnaire 已用
}
export default registerTask;
```

**注意**:`registerQuestionnaire(pi)` 只在 **questionnaire 没被注册过**时调。Judge 也会调它(全局工具名 "questionnaire"),重复注册会报错。判断方式:用 try/catch,或检查 `pi.getActiveTools()` / 维护一个全局 flag。**最稳妥:不重复调,让 Judge 负责注册,** `/task` 直接用。

#### 2.2 实现 `/task` 命令 handler(只做 list/show 部分)

照搬 `judge.ts:1007-1116` 的结构:

```typescript
pi.registerCommand("task", {
  description: "UGK task delegation system",
  handler: async (args, ctx) => {
    const resolvedArgs = await resolveTaskCommandArgs(args, ctx);
    if (resolvedArgs === undefined) return;
    const tokens = resolvedArgs.trim().split(/\s+/).filter(Boolean);
    const action = (tokens[0] ?? "").toLowerCase();
    const name = tokens[1];

    if (action === "list") return await handleTaskList(ctx, tokens);
    if (action === "show") return await handleTaskShow(ctx, name);
    // 其他 action 在后续步骤加
    ctx.ui.notify("Usage: /task list|show|new|run|edit|save|delete|toggle|exit", "warning");
  },
});
```

实现 `resolveTaskCommandArgs` 和 `getTaskCommandMenuOptions`(设计文档 7.3 节有完整代码)。**当前阶段菜单显示精简版**:未启用时只显示 `["新建任务", "运行 taskbook", "编辑 taskbook", "列出 taskbook", "Exit"]`(不显示 phase 相关项,因为后续步骤才加)。

#### 2.3 实现 `handleTaskList` 和 `handleTaskShow`

- `handleTaskList`:调 `listTaskbooks(ctx.cwd)`,格式化成表格(name + scope + description + lastRun.status),`ctx.ui.notify` 显示。支持 `--tag` 过滤
- `handleTaskShow`:调 `loadTaskbook`,显示 spec + skill + verify + contract 摘要

#### 2.4 连进 `extensions/index.ts`

参考 `index.ts:104` 的 `registerJudge(pi)`,在 `index.ts:75` 的默认工厂里加:
```typescript
import registerTask from "./task/task.ts";
// ...
registerTask(pi);
```
**位置**:放在 `registerJudge(pi)` 之后(line 104 之后),因为 `/task` 复用 Judge 注册的 questionnaire。

**验收**:
- `npm test` 通过
- 手动测试 `/task list`(空列表也能正常显示)和 `/task show <不存在的 name>`(给合理错误提示)
- `/task`(无参)能弹菜单

---

### 步骤 3:`task-prompts.ts` + planning 阶段

**目标**:实现 `/task new`,能跟人对齐出 Spec。

#### 3.1 创建 `extensions/task/task-prompts.ts`

**fork** Judge 的 `ALIGN_PROMPT`(`judge-prompts.ts:1-40`),改名 `TASK_ALIGN_PROMPT`。**保留以下契约**(否则 Spec 解析会失败):

- 强制使用 questionnaire 工具
- **强制结尾题** `id="extras"`, prompt="你还有什么要补充的吗?(没有可留空)",唯一 option `{"value":"none","label":"没有了"}`,`allowOther:true`
- 输出 fenced JSON 块,shape 是 RequirementsSpec 五字段
- 必填字段:`goal`、`hardConstraints`、`acceptance`;可选:`forbidden`、`context`

**修改**:
- 角色从 "Judge" 改为 "Task planning agent"
- 删掉 "do not start driver sessions" 这类 Judge 专属的话
- 加一句:"这是 one-step 固定任务,Spec 的 acceptance 必须**可机器判定**(文件存在、exit code、测试通过、schema 校验等),不要写'质量良好'这种主观标准"

#### 3.2 实现 planning 阶段

参考 `judge.ts` 的 `enableJudge` 和 aligning 流程:

```typescript
function enableTask(ctx) {
  restoreToolsSnapshot ??= pi.getActiveTools();
  state = enterPlanning(state);
  pi.setActiveTools(TASK_PLANNING_TOOLS); // ["read", "bash", "grep", "find", "ls", "questionnaire"]
  setTaskStatus(ctx, "📋 task");
  persistState(pi, state);
  ctx.ui.notify("Task planning mode. 用 questionnaire 跟用户对齐需求。", "info");
}
```

#### 3.3 注入 `TASK_ALIGN_PROMPT`

参考 `judge.ts:1118` 的 `before_agent_start`:

```typescript
pi.on("before_agent_start", (event, ctx) => {
  if (state.phase !== "planning") return;
  // 注入 customType: "task-plan-context" 的 message,display: false
  return {
    customMessage: { customType: "task-plan-context", content: TASK_ALIGN_PROMPT, display: false }
  };
});
```

还要在 `pi.on("context", ...)` 里过滤掉旧的 `task-plan-context` message(参考 `judge.ts:1132`),避免每轮都注入。

#### 3.4 `agent_end` 时解析 Spec

参考 `judge.ts:1224-1318`:

```typescript
pi.on("agent_end", (event, ctx) => {
  if (state.phase !== "planning") return;
  const lastMessage = event.messages.at(-1);
  const spec = extractRequirementsSpec(getMessageText(lastMessage));
  if (spec) {
    state = setTaskSpec(state, spec);  // 新转换器,写 state.spec
    persistState(pi, state);
    ctx.ui.notify("Spec 已对齐。用 /task 进入菜单,选'开始执行'。", "info");
  }
});
```

**验收**:
- `npm test` 通过
- 手动测试 `/task new`,agent 能用 questionnaire 问问题、产出合法 Spec
- 没调 questionnaire 直接产出 Spec 时,C-2 闸拦截 `/task execute`(下一步才实现 execute,这步先确保 flag 正确)

---

### 步骤 4:executing 阶段(main 亲手跑)

**目标**:planning 产出 Spec 后,main 在**同一个 context**继续把任务做一遍。

这步**几乎没新代码**,主要是状态切换 + 工具集管理。

#### 4.1 实现 `execute` action

```typescript
if (action === "execute") {
  if (!state.spec) { ctx.ui.notify("没有 Spec,先用 /task new 对齐。", "warning"); return; }
  if (!state.planQuestionnaireUsed) {
    ctx.ui.notify("planning 阶段未用 questionnaire,拒绝执行。", "warning");
    pi.sendUserMessage("请先用 questionnaire 跟用户确认 Spec 假设,再重新输出 Spec。", {deliverAs: "followUp"});
    return;
  }
  state = startExecuting(state);
  restoreToolsSnapshot ??= pi.getActiveTools();
  pi.setActiveTools(TASK_EXECUTING_TOOLS); // ["read", "write", "edit", "bash"]  —— 不含 subagent!
  persistState(pi, state);
  setTaskStatus(ctx, "🔧 executing");
  pi.sendUserMessage(`现在请在**同一个对话**里亲手把任务做完。Spec:\n\n${formatRequirementsSpec(state.spec)}\n\n要求:\n- 必须实际产出文件,不能只描述\n- 不要调 subagent 工具,亲手做\n- 完成后调 /task 进入菜单选'复盘'`, {deliverAs: "followUp"});
  return;
}
```

**关键约束**:`TASK_EXECUTING_TOOLS` **不含 subagent**(设计文档 4.2 节)。这强制 main 亲手做,不派 subagent。

#### 4.2 工具集恢复

main 做完后,用户调 `/task` 选"复盘",这时要恢复工具集(把 subagent 放回来给 review 阶段用——虽然 review 不一定需要 subagent,但保险起见)。

**验收**:
- `npm test` 通过
- 手动测试完整 plan→execute 流程,main 真的能在同一对话里把任务做完
- 验证 executing 阶段调 subagent 工具会被拦截(`pi.setActiveTools` 排除了 subagent)

---

### 步骤 5:reviewing 阶段(产 skill + verify + contract)

**目标**:execute 完成后,用**新 context**复盘,产出三件套。

#### 5.1 创建 `TASK_REVIEW_PROMPT`

全新写。要求 LLM:

- 输入:execute 阶段的**执行摘要**(不是完整 transcript)+ Spec
- 产出三个东西的草稿:
  1. **skill.md**:重构最简路径(不是摘抄),markdown 格式,**不含验收标准**
  2. **verify.mjs**:Node 脚本,能 spawn 任意外部工具。用 `failures[]` 数组 + `process.exit(1)` 模式(设计文档 3.5 有完整示例)
  3. **contract.json**:产出契约,artifacts 带 schema
- 强制使用 questionnaire 跟人核对:
  - "这条 skill 步骤是关键吗?"
  - "这条 verify 断言够硬吗?能挡住 [具体失败模式] 吗?"
  - "contract 的 artifact schema 完整吗?"
- 结尾必须有 `id="extras"` 题(同 ALIGN_PROMPT 契约)
- 输出 fenced JSON,shape:
  ```json
  {
    "skill": "markdown 内容",
    "verify": "javascript 内容",
    "contract": {...}
  }
  ```

#### 5.2 实现 review 流程

用户在 executing 完成后调 `/task`,菜单显示 `["保存为 taskbook", "继续复盘", "放弃", "退出 Task", "Exit"]`(设计文档 7.3)。选"继续复盘"时:

1. 收集 execute 阶段的执行摘要(从 session 拿 messages,或要求用户手写一个摘要)
2. **开新 session**做 review(用 `ctx.newSession()` 或 `ctx.fork()`)。注入 `TASK_REVIEW_PROMPT` + 执行摘要 + Spec
3. review agent 用 questionnaire 跟人核对
4. review agent 产出 `{skill, verify, contract}` JSON
5. 用 `extractTaskReviewResult(text)` 解析(类似 `extractRequirementsSpec` 的三级 fallback)

#### 5.3 实现"保存为 taskbook" action

```typescript
if (action === "save") {
  if (!state.reviewResult) { ctx.ui.notify("没有 review 产出,先复盘。", "warning"); return; }
  if (!state.reviewQuestionnaireUsed) { ctx.ui.notify("review 未用 questionnaire 核对,拒绝保存。", "warning"); return; }
  const scope = tokens.includes("--project") ? "project" : "user";
  const finalName = name ?? await ctx.ui.input("taskbook 名字", "my-task");
  await saveTaskbook(scope, ctx.cwd, finalName, {
    description: state.reviewResult.description,
    spec: state.spec,
    skill: state.reviewResult.skill,
    verify: state.reviewResult.verify,
    contract: state.reviewResult.contract,
    tags: state.reviewResult.tags,
  });
  // 关键:在刚跑完的产出上跑一次 verify,自证
  await runVerifyAndReport(ctx, finalName);
  state = landTask(state);
  persistState(pi, state);
  ctx.ui.notify(`taskbook "${finalName}" 已保存(${scope})。`, "info");
}
```

**自证**(设计文档 3.5 硬规则):save 完立刻跑一次 verify,必须 PASS。如果 FAIL,提示用户 review 的 verify 写错了,不直接 land。

**验收**:
- `npm test` 通过
- 手动测试完整 plan→execute→review→save 流程
- 验证 save 后立刻跑 verify,产出 PASS

---

### 步骤 6:`task-verify.ts`(verify runner)

**目标**:能 spawn `node verify.mjs`,捕获 stdout/exit,解析失败 JSON。

#### 6.1 创建 `extensions/task/task-verify.ts`

```typescript
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";

export interface VerifyFailure {
  assertion: string;
  expected: string;
  actual: string;
  hint?: string;
}

export interface VerifyResult {
  passed: boolean;
  failures: VerifyFailure[];
  stdout: string;
  stderr: string;
  exitCode: number | null;
  durationMs: number;
}

export async function runVerify(opts: {
  verifyPath: string;       // verify.mjs 的绝对路径
  outputDir: string;        // 设为 env.TASK_OUTPUT_DIR
  input: unknown;           // 设为 env.TASK_INPUT (JSON.stringify)
  timeoutMs?: number;       // 默认 30000
}): Promise<VerifyResult> {
  // 1. spawn `node <verifyPath>`
  // 2. env: { ...process.env, TASK_OUTPUT_DIR: opts.outputDir, TASK_INPUT: JSON.stringify(opts.input) }
  // 3. 捕获 stdout/stderr/exitCode
  // 4. exitCode===0 → passed=true, failures=[]
  // 5. exitCode!==0 → 尝试 JSON.parse(stdout),失败则把整个 stdout 包成一条 VerifyFailure
  // 6. 返回 VerifyResult
}
```

#### 6.2 测试 `tests/task-verify.test.ts`

写一个真的 verify.mjs(放 `tests/fixtures/`),跑 pass/fail/timeout/解析失败 四个 case。

**验收**:
- `npm test` 通过
- task-verify 的 4 个测试 case 全过

---

### 步骤 7:`task-worker.ts`(worker spawn 派遣)

**目标**:复用阶段 spawn worker 子进程,注入 skill + contract + 运行时输入。

#### 7.1 处理 `runSingleAgent` 复用问题

两个选择,**优先选 A**:

**A. 改 `extensions/subagent.ts`** 把 `runSingleAgent` 和 `getPiInvocation` export 出来:
```typescript
// subagent.ts 末尾
export { runSingleAgent, getPiInvocation };
```
然后 `task-worker.ts` 直接 `import { runSingleAgent } from "../subagent.ts"`。**这是最小改动,且让两个模块共享同一套 spawn 逻辑**。

**B. fork 到 `extensions/task/task-spawn.ts`**:逐行复制 `runSingleAgent`。**只在 A 行不通时用**(比如 pi 内部 API 改了导致 subagent 跟 task 需求冲突)。

#### 7.2 创建 `extensions/task/task-worker.ts`

```typescript
export interface TaskWorkerInput {
  skill: string;          // skill.md 内容
  contract: Contract;     // contract.json
  runtimeInput: unknown;  // 用户传的 /task run <name> <input>
  outputDir: string;      // worker 必须把产出落这里
  feedback?: WorkerFeedback; // checker 的失败反馈(retry 时)
}

export interface TaskWorkerResult {
  ok: boolean;
  outputDir: string;
  summary: string;        // worker 自己写的产出摘要
  errorMessage?: string;
  usage: { input: number; output: number; cost: number };
}

export async function dispatchWorker(input: TaskWorkerInput, opts: { cwd: string; signal?: AbortSignal }): Promise<TaskWorkerResult> {
  // 1. 构造 systemPrompt:把 skill + contract + runtimeInput + outputDir 告诉 worker
  //    systemPrompt 里必须明确:
  //    - "把所有产出文件落到 <outputDir>,严格按 contract.artifacts 命名"
  //    - "不要试图猜测验收标准,只管按 contract 产出"
  //    - feedback 存在时:"上一轮失败:<feedback>,请修正"
  // 2. 调 runSingleAgent(agentName="worker", task=<systemPrompt>)
  // 3. 解析 worker 的 final output,提取产出位置
  // 4. 返回 TaskWorkerResult
}
```

#### 7.3 确认 `agents/worker.md` 存在且合理

`agents/worker.md` 已存在。**确认它的 frontmatter**(`name`、`description`、`tools`)合理:
- `tools` 应包含 `read, write, edit, bash`(不加 subagent,worker 不能再派)
- description 要让 main agent 知道什么时候派 worker

**注意 AGENTS.md 第 96 行**:agent 定义文件需要复制到 `~/.pi/agent/agents/` 才生效。在 `agents/worker.md` 顶部注释提醒用户:`cp agents/worker.md ~/.pi/agent/agents/`。

**验收**:
- `npm test` 通过
- 手动测试 dispatchWorker 能 spawn worker、worker 能按 contract 产出

---

### 步骤 8:`task-checker.ts`(checker spawn + retry 循环)

**目标**:verify 失败时 spawn checker,拿归因反馈,决定 retry/abort。

#### 8.1 创建 `agents/checker.md`

**新建**。frontmatter:
```yaml
---
name: checker
description: Verify task worker's output against failures, produce root-cause hints. Read-only.
tools: read, grep, find, ls, bash
---
```

body 定义输出格式:
```markdown
你是 task checker。你会收到:
- verify 的失败信息(JSON 数组,每条 {assertion, expected, actual})
- 产出契约 contract.json
- worker 的产出目录(只读访问)

你的任务:
1. 分析失败的根因(多条失败可能是同一个根因)
2. 给 worker 写一条**方向性 hint**,不给答案
   - 对:"问题在视频完整性,方向是下载环节,检查 yt-dlp 输出"
   - 错:"把 line 47 改成 ffprobe -i ..."
3. 判断 verdict:retry(worker 能改)还是 abort(根本性问题,改不了)
4. 输出 fenced JSON:
   {
     "hint": "给 worker 的方向性提示",
     "verdict": "retry" | "abort",
     "reason": "为什么 retry/abort"
   }
```

#### 8.2 创建 `extensions/task/task-checker.ts`

```typescript
export interface CheckerInput {
  failures: VerifyFailure[];
  contract: Contract;
  outputDir: string;
  retryBudget: number;     // 剩余 retry 次数
}

export interface CheckerResult {
  hint: string;
  verdict: "retry" | "abort";
  reason: string;
}

export async function dispatchChecker(input: CheckerInput, opts: { cwd: string; signal?: AbortSignal }): Promise<CheckerResult> {
  // 1. 构造 prompt:failures + contract + "请读 <outputDir> 分析"
  // 2. spawn checker agent
  // 3. 解析输出的 {hint, verdict, reason}
  // 4. 返回 CheckerResult
}
```

**验收**:
- `npm test` 通过
- 手动测试:故意制造 verify 失败,checker 能给出合理 hint + verdict

---

### 步骤 9:`/task run` 完整流程(串起来)

**目标**:实现 `/task run <name> [input...]`,走 worker→verify→checker 完整流程。

#### 9.1 在 `task.ts` 实现 `handleTaskRun`

```typescript
async function handleTaskRun(ctx, name, inputTokens) {
  // 1. 加载 taskbook
  const loaded = await loadTaskbook(ctx.cwd, name);
  if (!loaded) { ctx.ui.notify(`taskbook "${name}" 不存在`, "warning"); return; }

  // 2. 准备运行时环境
  const runId = `task-${name}-${Date.now()}`;
  const runDir = path.join(ctx.cwd, ".tasks", "runs", runId);
  const outputDir = path.join(runDir, "output");
  await mkdir(outputDir, { recursive: true });

  // 3. 解析运行时输入(从 inputTokens 或交互式询问 contract.runtimeInput 字段)
  const runtimeInput = await resolveRuntimeInput(ctx, loaded.contract, inputTokens);

  // 4. retry 循环
  const maxRetry = 3;
  let lastVerifyResult;
  for (let attempt = 0; attempt <= maxRetry; attempt++) {
    // 4a. dispatch worker
    const workerResult = await dispatchWorker({
      skill: loaded.skill,
      contract: loaded.contract,
      runtimeInput,
      outputDir,
      feedback: attempt > 0 ? lastVerifyResult.failures : undefined,
    }, { cwd: ctx.cwd });

    if (!workerResult.ok) {
      ctx.ui.notify(`worker 执行失败: ${workerResult.errorMessage}`, "error");
      break;
    }

    // 4b. run verify
    lastVerifyResult = await runVerify({
      verifyPath: path.join(loaded.dir, "verify.mjs"),
      outputDir,
      input: runtimeInput,
    });

    // 4c. PASS → 落定
    if (lastVerifyResult.passed) {
      await appendRunToTaskbook(loaded.scope, ctx.cwd, name, {
        timestamp: new Date().toISOString(),
        status: "pass",
        input: runtimeInput,
        exitCode: 0,
        verifyFailures: [],
        duration: ...,
      });
      ctx.ui.notify(`✅ taskbook "${name}" PASS(尝试 ${attempt+1} 次)`, "info");
      return;
    }

    // 4d. FAIL → 最后一次不再 retry
    if (attempt === maxRetry) break;

    // 4e. dispatch checker
    const checkerResult = await dispatchChecker({
      failures: lastVerifyResult.failures,
      contract: loaded.contract,
      outputDir,
      retryBudget: maxRetry - attempt - 1,
    }, { cwd: ctx.cwd });

    if (checkerResult.verdict === "abort") {
      ctx.ui.notify(`checker 判 abort: ${checkerResult.reason}`, "warning");
      break;
    }

    // checker 的 hint 会通过 feedback 字段传给下一轮 worker
  }

  // 5. FAIL 落定
  await appendRunToTaskbook(loaded.scope, ctx.cwd, name, {
    timestamp: new Date().toISOString(),
    status: "fail",
    input: runtimeInput,
    exitCode: 1,
    verifyFailures: lastVerifyResult?.failures ?? [],
    duration: ...,
  });
  ctx.ui.notify(`❌ taskbook "${name}" FAIL(retry 耗尽)`, "error");
}
```

#### 9.2 接进 `/task` 命令 handler 的 action 分发

```typescript
if (action === "run") return await handleTaskRun(ctx, name, tokens.slice(2));
```

**验收**:
- `npm test` 通过
- 手动测试 `/task run <name>` 完整流程

---

### 步骤 10:dogfood —— B 站下载 taskbook

**目标**:用真实的 B 站下载任务验证整套流程。

#### 10.1 准备环境

确认这些工具装了(没装给安装命令):
- `yt-dlp`(`pip install yt-dlp` 或 `winget install yt-dlp`)
- `ffprobe`(ffmpeg 套件,`winget install ffmpeg`)

#### 10.2 跑完整创造流程

```
1. /task
2. 选"新建任务"
3. 跟 agent 对齐(下载 B 站视频,校验完整性)
4. 选"开始执行",main 亲手下载一个视频
5. 选"复盘",agent 产 skill + verify(含 ffprobe 断言)+ contract
6. 选"保存为 taskbook",命名 bilibili-download
7. 验证 save 后跑 verify 自证 PASS
```

#### 10.3 跑复用流程

```
/task run bilibili-download https://www.bilibili.com/video/<某个视频>
```

观察:worker 跑 → verify 跑 → PASS。

#### 10.4 故意制造失败

给一个坏 URL,观察:
- verify 失败
- checker 归因("视频不存在/链接无效")
- retry 或 abort

**验收**:
- B 站下载 taskbook 能完整创造 + 复用
- 故意失败时 checker 归因合理

---

## 最终交付清单(全部完成后)

**新增文件**:
- [ ] `docs/design/task-extension-spec.md`(已存在,设计文档)
- [ ] `docs/design/task-extension-action-plan.md`(本文,行动计划)
- [ ] `extensions/task/task-state.ts`
- [ ] `extensions/task/task-book.ts`
- [ ] `extensions/task/task-prompts.ts`
- [ ] `extensions/task/task.ts`
- [ ] `extensions/task/task-verify.ts`
- [ ] `extensions/task/task-worker.ts`
- [ ] `extensions/task/task-checker.ts`
- [ ] `agents/checker.md`(新建)
- [ ] `agents/worker.md`(确认 frontmatter,可能小改)
- [ ] `tests/task-state.test.ts`
- [ ] `tests/task-book.test.ts`
- [ ] `tests/task-verify.test.ts`
- [ ] 其他测试文件

**修改文件**:
- [ ] `extensions/index.ts`:加 `registerTask(pi)` 调用
- [ ] `extensions/subagent.ts`:export `runSingleAgent` 和 `getPiInvocation`(步骤 7 选 A 时)

**全局验证**:
- [ ] `npm test` 全过(基线 352 + 新增测试)
- [ ] `git diff --check` 无空白错误
- [ ] 手动跑 `/task` 菜单、`/task list`、`/task new` 流程顺畅
- [ ] 手动跑 B 站下载完整 dogfood

**不要做**:
- 不要 commit(让用户 review 后自己决定)
- 不要碰 Judge 代码
- 不要碰未提交的 smoke-tui 改动
- 不要 `git add` 未跟踪的旧 docs 文件

---

## 遇到问题时

- **不确定某个交互细节**:看 `extensions/judge/judge.ts` 里 Judge 是怎么做的,照搬模式
- **不确定 Spec 怎么解析**:用 `extractRequirementsSpec`(judge-utils.ts:234),已经处理了三级 fallback
- **pi API 不知道怎么用**:看 `extensions/chrome-cdp/index.ts` 和 `extensions/judge/judge.ts` 的用法,这两个是完整范本
- **测试怎么写**:看 `tests/judge-extension.test.ts` 的结构
- **设计文档跟代码冲突**:以设计文档 `task-extension-spec.md` 为准,实现按它来。如果发现设计文档有明显错误,**先在文档里改,再实现**,不要默默偏离

---

## 执行 agent 完成后给 review agent 的交接

完成后,执行 agent 应该在 PR description 或交接文档里写明:
- 实现了哪些步骤,哪些跳过及原因
- 跟设计文档的偏离点(如果有)
- 手动测试的结果
- 已知的 limitation 或后续待办

review agent(也就是写这份行动计划的我)会对照**最终交付清单**逐条验收。
