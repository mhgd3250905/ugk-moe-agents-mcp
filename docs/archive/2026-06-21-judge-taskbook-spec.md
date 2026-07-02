# Judge 任务书(Taskbook)机制需求规格

> 状态: **已实现并验收通过(2026-06-21)**
> 日期: 2026-06-21
> 基线: main `75905d1`(v2.0.0,Flow 已移除,Judge+Driver 已稳定)
> 角色: 本文档为设计规格,记录已实现的设计与决策,供后续维护参考
> 关联: `docs/judge.md`(Judge 当前事实)、`extensions/judge/`(实现)

---

## 一、目标(一句话)

给 Judge+Driver 加一层**任务书沉淀与复用**能力:一次成功的 Judge+Driver run 沉淀为可命名的「任务书」,下次同类任务 `/judge run <name>` 加载任务书**跳过 ALIGN 对齐、保留完整 Judge 监督(DECIDE + FINALIZE)**直接开跑;任务书可随时编辑;失败 run 的经验也沉淀为重来起点。

**核心信念**: 执行 agent 永远不靠谱,所以 Judge 永远不能撤。任务书不是「撤掉 Judge 的自动化」,是「让 Judge+Driver 带着领域经验起步,而不是每次从零对齐」。

---

## 二、调研结论(已核实事实)

执行 agent 不需要重新调研,以下事实已核实,直接采信:

### 2.1 现有 Judge+Driver 流程的三个关键挂载点

| 挂载点 | 文件:行 | 说明 |
|---|---|---|
| **Spec 产出点** | `extensions/judge/judge.ts:561-568` | aligning 阶段 LLM 输出 JSON,`extractRequirementsSpec` 解析后 `setRequirementsSpec` 写入 state。这是 Spec 成为 run 权威的唯一位置 |
| **Driver 创建点** | `extensions/judge/judge.ts:658` | `createDriver(...)` 调用,参数在 `:585-779` 组装 |
| **Finalize 点** | `extensions/judge/judge.ts:677-752` | `onFinalize` 钩子,PASS/FAIL 在 `:688` 确定,delivery report 在 `:689-704` 构造广播 |

### 2.2 Spec 当前**不落盘**

`RequirementsSpec` 只存在于:
- `JudgeState.spec`(内存 + pi `judge-state` session log entry)
- driver `initialPrompt` 字符串
- decider prompt

**没有任何独立的 spec 文件**。任务书需要首次把 Spec 持久化为独立文件。

### 2.3 steer 当前**只有计数器,没历史**

- `DriverSummary.steerCount`(`judge-state.ts:36`)在 `judge-driver.ts:294` 累加
- `JudgeState.steerCount`(`judge-state.ts:48`)通过 `recordJudgeSteer`(`:121-126`)累加
- steer 的 direction/reason 文本(`judge-driver.ts:307` 发给 driver,`:280` 写 live.log)**没有结构化存储**

任务书要沉淀「关键 steer」,必须先给 `DriverSummary` 加 `steerHistory` 字段。

### 2.4 失败信息已有载体

- `DriverSummary.aborted` / `abortReason`(`judge-state.ts:38-39`)—— abort 时已填
- `DriverSummary.lastError`(`judge-state.ts:34`)
- `JudgeFinalVerdict.reason` / `evidence`(`judge-utils.ts:38-40`)

**场景 2(失败暴露)的数据载体已存在**,只需在 finalize 时落盘。

### 2.5 `/judge` 命令派发现状

- 单一 `pi.registerCommand("judge", ...)`(`judge.ts:452`)
- 当前用**整串比较**派发:`action === "ack"` 等(`judge.ts:458-482`)
- **无法支持带参数子命令**(`/judge save <name>`),因为 `save foo` 整串不等于 `save`
- 模板: `extensions/mcp/commands.ts:70` 已用 `split(/\s+/)` 模式,直接借鉴

### 2.6 已废弃的先例(不复活)

`docs/superpowers/specs/2026-06-17-flow-task-design.md` 有一套相似的「flow」设计(Task/Run 框架),**但 flow 已在 v2.0.0 整体移除**。本规格**不复活 flow**,而是在已验证的 Judge+Driver 底座上叠加任务书层,复用现有 Spec 产出/finalize/driver 创建挂载点,不重造 runtime。

### 2.7 现有 UI 原语(全部复用)

- `ctx.ui.select(title, options)` —— 列表菜单(Judge 现有 `JUDGE_COMMAND_MENU_OPTIONS` `judge.ts:73`)
- `ctx.ui.editor(title, initialText)` —— 多行编辑器(`judge.ts:805` 「改需求」已用)
- `ctx.ui.notify(msg, level)` —— 提示
- `ctx.ui.confirm(title, body)` —— 确认

### 2.8 存储 scope 模式

MCP 用 4 级 scope(install/user/project/local),subagent 用 user+project。**任务书只用 project scope**(`<cwd>/.judge/taskbooks/`),跟现有 `.judge/<runId>/` 同根,不引入新 scope 概念。理由: 「什么算 PASS」强项目相关,跨项目复用价值存疑,保持单一 scope 最简单。

---

## 三、已拍板决策表

| # | 决策点 | 定论 | 理由 |
|---|---|---|---|
| **D1** | 任务书存储位置 | **项目级** `<cwd>/.judge/taskbooks/<name>/` | 跟 `.judge/<runId>/` 同根,版本管理友好,团队共享 |
| **D2** | 重跑形态 | **保留完整 Judge 监督**(只跳过 ALIGN 对齐,DECIDE + FINALIZE 不变) | 忠于「执行 agent 永远不靠谱,Judge 永远不能撤」核心信念 |
| **D3** | 经验沉淀深度 | **中等**: Spec 骨架 + 关键 steer 历史 + 失败原因 + 验收证据 | 「最小」覆盖不了场景 1/2;「全量回放」是过度工程,下次跑的是不同输入,精确回放无意义 |
| **D4** | experience.md 更新策略 | **PASS 时由 Judge 起草直接覆盖**,**不弹 editor**(用户可随时 `/judge edit` 改) | 避免打断「照本宣科重跑」的流畅性;编辑入口随时可用 |
| **D5** | 失败 run 沉淀 | **只 append 到 taskbook.json 的 runs[] 历史当反面教材,不改 experience.md** | experience.md 是「怎么做对」,失败进历史,语义清晰 |
| **D6** | 任务书触发 | **用户显式命令**(`/judge run <name>` / `/judge save <name>`),无自动触发 | 可控、可预测 |
| **D7** | scope | **只 project,不做 user/install** | 单一 scope 最简单;有需求再加 |
| **D8** | 是否破坏现有流程 | **完全不破坏**,任务书是**可选叠加**,不传 name 时行为零变化 | 保护 v2.0.0 已验证的 Judge+Driver |
| **D9** | steer 历史是否暴露给 driver | **是**,作为 driver initialPrompt 的 `context` **补充**(非 acceptance 替代) | 经验要起作用必须让 driver 看到,但 Spec.acceptance 始终是硬底线 |
| **D10** | experience.md 起草主体 | **纯函数渲染**(taskbook.ts 的 `draftExperienceMd`,Judge 不直接写文件) | 关注点分离;渲染逻辑可独立测试 |

---

## 四、核心设计:任务书结构

一个任务书是一个目录 `.judge/taskbooks/<name>/`:

```
.judge/taskbooks/<name>/
  taskbook.json      # 元数据 + 运行历史
  spec.json          # RequirementsSpec 骨架
  experience.md      # 人可读经验总结(渲染产出,用户可改)
```

### 4.1 `taskbook.json` schema

```jsonc
{
  "name": "string",           // 任务书名,与目录名一致
  "description": "string",    // 一句话描述,用于 /judge list 展示
  "createdAt": "ISO8601",     // 首次创建时间
  "updatedAt": "ISO8601",     // 最近一次 run 沉淀时间
  "runs": [                  // 运行历史,只存摘要,默认保留最近 10 条
    {
      "timestamp": "ISO8601",
      "status": "pass" | "fail",
      "steerCount": "number",
      "failReason": "string?",   // status=fail 时填,来自 finalVerdict.reason 或 abortReason
      "evidence": "string[]?"    // status=pass 时填,来自 finalVerdict.evidence
    }
  ]
}
```

### 4.2 `spec.json` schema

直接复用 `RequirementsSpec`(`judge-state.ts:3-9`):

```jsonc
{
  "goal": "string",
  "hardConstraints": ["string"],
  "acceptance": ["string"],
  "forbidden": ["string"],
  "context": "string"
}
```

### 4.3 `experience.md` 内容(渲染函数 `draftExperienceMd` 产出)

固定结构(渲染函数只读 taskbook.json + spec.json,不存额外数据,保证单一事实源):

```markdown
# <name> 经验

## 目标
<spec.goal>

## 验收标准
- <spec.acceptance[i]>
- ...

## 关键避坑点(来自历史 steer)
- steer #1 (turn N): <direction> —— 原因: <reason>
- steer #2 (turn N): ...

## 已知失败模式(来自 fail 历史)
- <runs[].failReason>
- ...
```

---

## 五、详细设计(分四块,按依赖顺序)

### 块 1: `DriverSummary` 加 steer 历史(基础设施)

**为什么先做**: 任务书的经验数据来自这里。改动集中,可独立测试。

**改动 1.1** `extensions/judge/judge-state.ts`:

新增类型与字段(在 `DriverSummary` 内):

```ts
export interface SteerRecord {
  direction: string;
  reason: string;
  turnIndex: number;
}

export interface DriverSummary {
  pathsTried: DriverPathTried[];
  artifacts: DriverArtifact[];
  runningTools: DriverRunningTool[];
  lastError?: string;
  turnCount: number;
  steerCount: number;
  steerHistory: SteerRecord[];   // 新增
  completed: boolean;
  aborted?: boolean;
  abortReason?: string;
}
```

- `createJudgeDriver`(`judge-driver.ts:224-231`)初始化 summary 时加 `steerHistory: []`
- `cloneSummary`(`judge-driver.ts:82-98`)深拷贝时复制 `steerHistory`(map 新数组)

**改动 1.2** `extensions/judge/judge-driver.ts:292-308`(steer 分支):

在 `summary.steerCount += 1`(`:294`)后加一行:

```ts
summary.steerHistory.push({
  direction: verdict.direction,
  reason: verdict.reason ?? "",
  turnIndex: summary.turnCount,
});
```

**改动 1.3** 持久化兼容: `persistState`(`judge.ts:276-287`)序列化的 `judge-state` entry 若含旧 summary(无 steerHistory),`restoreJudgeState`(`judge.ts:306-333`)反序列化时 `steerHistory ?? []` 容错。

### 块 2: 任务书读写层(纯函数,无 Judge 耦合)

**为什么独立**: 让 Judge 主流程和任务书机制解耦。纯 IO + 类型校验,可独立测试。

**新文件** `extensions/judge/taskbook.ts`(约 250 行):

```ts
// 公开 API
export interface Taskbook {
  name: string;
  description: string;
  createdAt: string;
  updatedAt: string;
  runs: RunSummary[];
}

export interface RunSummary {
  timestamp: string;
  status: "pass" | "fail";
  steerCount: number;
  failReason?: string;
  evidence?: string[];
}

// 路径解析
export function taskbookDir(cwd: string, name: string): string;     // <cwd>/.judge/taskbooks/<name>
export function taskbooksRoot(cwd: string): string;                  // <cwd>/.judge/taskbooks
export function isValidTaskbookName(name: string): boolean;          // 字母数字-_-, 不含路径分隔符

// CRUD
export function saveTaskbook(cwd: string, name: string, data: {
  description: string;
  spec: RequirementsSpec;
  summary: DriverSummary;
  finalVerdict?: JudgeFinalVerdict;
}): Promise<Taskbook>;   // 写 taskbook.json + spec.json + experience.md,返回 Taskbook

export function loadTaskbook(cwd: string, name: string): Promise<{
  taskbook: Taskbook;
  spec: RequirementsSpec;
} | null>;   // 读回 + schema 校验,不存在返回 null,校验失败抛错

export function listTaskbooks(cwd: string): Promise<Array<{name: string; description: string; lastRun?: RunSummary}>>;

export function appendRunToTaskbook(cwd: string, name: string, run: RunSummary): Promise<Taskbook>;   // 读-改-写 runs[],保留最近 10 条

export function updateTaskbookSpec(cwd: string, name: string, spec: RequirementsSpec): Promise<void>;   // /judge edit 用

// 渲染(纯函数,供 saveTaskbook 内部和 /judge edit 预览用)
export function draftExperienceMd(name: string, spec: RequirementsSpec, taskbook: Taskbook): string;

// 校验(参考现有 isRequirementsSpec judge.ts:293-304 风格)
export function isTaskbook(value: unknown): value is Taskbook;
```

**实现约定**:
- 文件 IO 用 `node:fs/promises`,目录不存在则 `mkdir recursive`
- `spec.json` 复用现有 `normalizeSpec`(`judge-utils.ts:208-224`)+ `isRequirementsSpec`(`judge.ts:293-304`)校验
- `runs[]` 追加时按 `timestamp` 排序,超过 10 条砍最旧
- `draftExperienceMd` 不读磁盘,纯函数,签名只拿内存对象
- `saveTaskbook` 写入流程: mkdir → 写 spec.json → 调 draftExperienceMd → 写 experience.md → 写 taskbook.json(含首次 runs 为空数组)→ 返回 Taskbook
- `appendRunToTaskbook`: 读 taskbook.json → push run → 砍到 10 条 → 更新 updatedAt → 写回

### 块 3: finalize 钩子 + run 完成沉淀(场景 1+2 落地)

**为什么这步是核心**: 这是「跑通一次 → 沉淀」的实际发生点。

**改动 3.1** `extensions/judge/judge-state.ts`:

`JudgeState` 加字段:

```ts
export interface JudgeState {
  // ...现有字段...
  taskbookName?: string;   // 本次 run 绑定的任务书名;undefined 表示从零对齐的普通 run
}
```

`createJudgeState` / `enterAligning` / `startDriving` 等所有 state 转换函数保持 `taskbookName` 透传(spread `...state` 已覆盖,无需额外处理)。

**新增 state 转换** `setTaskbookForRun(state, name)`:

```ts
export function setTaskbookForRun(state: JudgeState, name: string): JudgeState {
  return { ...state, taskbookName: name };
}
```

**改动 3.2** `extensions/judge/judge.ts` 的 `onFinalize` 钩子(`:677-752`):

在 PASS 分支(`:706-727`)用户接受交付后、`completeJudge` 之前插入沉淀逻辑:

```ts
// 用户接受 PASS 后
if (state.taskbookName) {
  const runSummary: RunSummary = {
    timestamp: new Date().toISOString(),
    status: "pass",
    steerCount: context.summary.steerCount,
    evidence: finalVerdict.evidence,
  };
  await appendRunToTaskbook(getCwd(ctx), state.taskbookName, runSummary);
  // 更新 experience.md(渲染直接覆盖,D4)
  const loaded = await loadTaskbook(getCwd(ctx), state.taskbookName);
  if (loaded) {
    const experienceMd = draftExperienceMd(state.taskbookName, state.spec!, loaded.taskbook);
    await writeExperienceMd(getCwd(ctx), state.taskbookName, experienceMd);
  }
  ctx.ui.notify(`任务书 "${state.taskbookName}" 已沉淀 PASS 经验`, "info");
}
state = completeJudge(state);
```

在 FAIL 终态分支(`:729-736`)插入:

```ts
if (state.taskbookName) {
  const runSummary: RunSummary = {
    timestamp: new Date().toISOString(),
    status: "fail",
    steerCount: context.summary.steerCount,
    failReason: finalVerdict.reason || context.summary.abortReason || "unknown",
  };
  await appendRunToTaskbook(getCwd(ctx), state.taskbookName, runSummary);
  // 不更新 experience.md(D5)
  ctx.ui.notify(`任务书 "${state.taskbookName}" 已记录失败经验`, "info");
}
```

**注意**: FAIL-with-budget-resume 分支(`:738-751`)**不沉淀**(run 还没结束,driver 继续跑),只有终态才沉淀。

**改动 3.3** driver initialPrompt 注入经验(D9):

`judge.ts:586-592` 构造 driver `initialPrompt` 处,若 `state.taskbookName` 存在,在 Spec 后追加 experience 摘要:

```ts
let initialPrompt = specText;
if (state.taskbookName) {
  const loaded = await loadTaskbook(getCwd(ctx), state.taskbookName);
  if (loaded) {
    const exp = draftExperienceMd(state.taskbookName, loaded.spec, loaded.taskbook);
    initialPrompt = `${specText}\n\n## 历史经验(补充参考,非验收标准)\n${exp}`;
  }
}
```

**边界**: experience 标题明确写「补充参考,非验收标准」,Spec.acceptance 始终是硬底线。

### 块 4: CLI 命令 + 重跑流程(用户入口)

**为什么最后做**: 依赖前 3 块。

**改动 4.1** `extensions/judge/judge.ts:452-485` 的 `/judge` handler 改派发模式:

把现有整串比较改成 split-args 模式(模板 `mcp/commands.ts:70`):

```ts
pi.registerCommand("judge", {
  description: "Enter Judge aligning mode",
  handler: async (args, ctx) => {
    const resolvedArgs = await resolveJudgeCommandArgs(args, ctx);
    if (resolvedArgs === undefined) return;
    const tokens = resolvedArgs.trim().split(/\s+/).filter(Boolean);
    const action = (tokens[0] ?? "").toLowerCase();
    const name = tokens[1];   // 子命令参数

    // 现有无参子命令(保持兼容)
    if (action === "ack") { /* 现有逻辑 */ return; }
    if (action === "toggle") { /* 现有逻辑 */ return; }
    if (action === "check-bash-window" || action === "check-bash" || action === "bash-window") { /* 现有逻辑 */ return; }

    // 新子命令
    if (action === "save") { await handleTaskbookSave(ctx, name); return; }
    if (action === "run") { await handleTaskbookRun(ctx, name); return; }
    if (action === "edit") { await handleTaskbookEdit(ctx, name); return; }
    if (action === "list") { await handleTaskbookList(ctx); return; }

    // 默认: 进入 aligning
    enableJudge(ctx);
  },
});
```

**改动 4.2** `JUDGE_COMMAND_MENU_OPTIONS`(`judge.ts:73`)扩展 + `resolveJudgeCommandArgs`(`:437-447`)映射:

```ts
const JUDGE_COMMAND_MENU_OPTIONS = [
  "新建对齐(从零)",
  "运行任务书",
  "保存任务书",
  "编辑任务书",
  "列出任务书",
  "Toggle Judge",
  "检查 bash 新窗口打开",
  "Exit",
];
```

`resolveJudgeCommandArgs` 把菜单选择映射成对应 action 字符串(`"align"` / `"run"` / `"save"` / `"edit"` / `"list"` / `"toggle"` / `"check-bash-window"`)。

**改动 4.3** 四个 handler 实现(在 `judge.ts` 内新增函数):

**`handleTaskbookSave(ctx, name?)`**:
- 若 `!name`: 弹 `ctx.ui.editor` 让用户输入 name + description(格式 `name\ndescription`)
- 若 name 无效(`!isValidTaskbookName(name)`): notify 错误退出
- 要求当前有可沉淀的 run: `state.spec` 非空(`state.phase === "done"` 或最近完成)
- 若同名任务书已存在: `ctx.ui.confirm` 问覆盖还是改名
- 调 `saveTaskbook(cwd, name, {description, spec: state.spec, summary: lastSummary, finalVerdict})`
- notify 成功 + 提示可用 `/judge run <name>`

**`handleTaskbookRun(ctx, name?)`** —— **核心新流程**:
- 若 `!name`: 调 `listTaskbooks`,弹 `ctx.ui.select` 让用户选
- `loadTaskbook(cwd, name)`,不存在 notify 退出
- **跳过 ALIGN**(不调 `enableJudge`,不走 aligning):
  - `restoreToolsSnapshot` 保存当前 tools
  - `state = setRequirementsSpec(createJudgeState(), loaded.spec)`
  - `state = setTaskbookForRun(state, name)`
  - `state = startDriving(state)`
  - `pi.setActiveTools(JUDGE_NORMAL_TOOLS)`(driving phase 的工具集)
  - `setJudgeStatus(ctx, "⚖ judge(run)")`
  - `persistState(pi, state)`
- **后续 driving/delivering 完全复用现有流程**: 下一次 `agent_end` 触发时,`state.phase === "driving"` 走 `judge.ts:580-793` 的 driving 分支,`createDriver`(`:658`)正常起 driver,DECIDE/FINALIZE 原样跑
- **Judge 监督价值完整保留**(D2)

**`handleTaskbookEdit(ctx, name?)`**:
- 若 `!name`: list + select 选
- `loadTaskbook`,把 `spec.json` 内容喂给 `ctx.ui.editor("编辑任务书 spec", JSON.stringify(spec, null, 2))`(复用 `judge.ts:805` 模式)
- 用户保存后: parse + `normalizeSpec` + `isRequirementsSpec` 校验,通过则 `updateTaskbookSpec`,失败 notify
- 同样支持编辑 `experience.md`: 第二轮 `ctx.ui.editor("编辑经验", currentExperienceMd)`

**`handleTaskbookList(ctx)`**:
- `listTaskbooks(cwd)`,空则 notify "无任务书"
- 非空: 用 `ctx.ui.select` 或 `ctx.ui.notify` 展示 name + description + lastRun.status

---

## 六、状态机扩展

现有 phase: `aligning | driving | delivering | aborted | done`(`judge-state.ts:42`)**不变**。

任务书是**正交维度**(`state.taskbookName`),不引入新 phase:

| 入口 | phase 起始 | taskbookName | ALIGN | DECIDE | FINALIZE |
|---|---|---|---|---|---|
| `/judge`(从零) | aligning | undefined | ✓ 走 | ✓ | ✓ |
| `/judge run <name>` | driving | `<name>` | ✗ 跳过 | ✓ | ✓ |
| `/judge edit` 后 run | driving | `<name>` | ✗ 跳过 | ✓ | ✓ |

---

## 七、实施计划(TDD,严格顺序)

每阶段完成后跑 `npm test` 确保 0 fail 才进下一阶段。

### 阶段 A: 块 1(steerHistory)
1. 写测试 `tests/judge-driver.test.ts`: 断言 steer 后 `summary.steerHistory` 含 `{direction, reason, turnIndex}`
2. 写测试: `cloneSummary` 深拷贝 steerHistory
3. 写测试: 旧 summary(无 steerHistory)反序列化容错
4. 改 `judge-state.ts`(加 SteerRecord + steerHistory 字段)
5. 改 `judge-driver.ts:294`(push 记录)+ `cloneSummary`
6. 改 `judge.ts` 持久化容错
7. `npm test` 通过

### 阶段 B: 块 2(taskbook.ts)
1. 写测试 `tests/taskbook.test.ts`:
   - `saveTaskbook` 写出 3 文件,目录自动创建
   - `loadTaskbook` 读回 + schema 校验
   - `loadTaskbook` 不存在返回 null
   - `loadTaskbook` schema 错抛错
   - `listTaskbooks` 扫描正确
   - `appendRunToTaskbook` 保留最近 10 条
   - `draftExperienceMd` 渲染正确结构
   - `isValidTaskbookName` 拒绝路径分隔符
2. 实现 `taskbook.ts`
3. `npm test` 通过

### 阶段 C: 块 3(finalize 钩子)
1. 写测试 `tests/judge-extension.test.ts`:
   - PASS + taskbookName → appendRun(pass) + experience.md 更新
   - FAIL 终态 + taskbookName → appendRun(fail) + experience.md 不变
   - FAIL-with-budget-resume → 不沉淀
   - driver initialPrompt 含 experience 摘要 + 「非验收标准」标注
   - 无 taskbookName → 行为与现在完全一致(回归保护)
2. 改 `judge-state.ts`(加 taskbookName + setTaskbookForRun)
3. 改 `judge.ts:586-592`(initialPrompt 注入经验)
4. 改 `judge.ts:677-752`(onFinalize 沉淀逻辑)
5. `npm test` 通过

### 阶段 D: 块 4(CLI 命令)
1. 写测试:
   - `/judge save foo` 派发到 handleTaskbookSave
   - `/judge run foo` 跳过 aligning 直接 driving,taskbookName=foo
   - `/judge run foo` 后 agent_end 走 driving 分支(回归)
   - `/judge edit foo` 弹 editor + 校验 + 存回
   - `/judge list` 展示
   - 菜单选项映射正确
   - 现有 `/judge` / `/judge ack` / `/judge toggle` 行为零变化(回归)
2. 改 `judge.ts:452-485`(派发模式)
3. 改 `JUDGE_COMMAND_MENU_OPTIONS` + `resolveJudgeCommandArgs`
4. 实现 4 个 handler
5. `npm test` 通过

### 阶段 E: 文档
1. `docs/judge.md` 新增「任务书」章节(用法 + 存储位置 + 编辑入口)
2. `AGENTS.md` 关键约定加一条: 任务书存 `.judge/taskbooks/`,project scope,Judge 监督在任务书模式下仍完整保留
3. `.gitignore` **不**加 `.judge/taskbooks/`(任务书是要进版本管理的团队资产)
4. `npm test` 最终确认

---

## 八、测试要求

- 现有 327 个测试**全部必须通过**(回归保护)
- 新增测试覆盖: 块 1(~3)、块 2(~8)、块 3(~5)、块 4(~7),约 23 个新测试
- 重点回归: 无 taskbookName 时所有现有行为零变化
- 失败路径全覆盖: name 无效、taskbook 不存在、spec 校验失败、磁盘 IO 错误

---

## 九、交付物清单

| 类型 | 文件 | 说明 |
|---|---|---|
| 新文件 | `extensions/judge/taskbook.ts` | 任务书读写层,~250 行 |
| 新文件 | `tests/taskbook.test.ts` | 块 2 测试 |
| 改动 | `extensions/judge/judge-state.ts` | SteerRecord + steerHistory + taskbookName + setTaskbookForRun |
| 改动 | `extensions/judge/judge-driver.ts` | steer 分支 push 历史 + cloneSummary 深拷贝 |
| 改动 | `extensions/judge/judge.ts` | CLI 派发 + 4 handler + onFinalize 沉淀 + initialPrompt 注入 + 持久化容错 |
| 改动 | `tests/judge-driver.test.ts` | 块 1 测试 |
| 改动 | `tests/judge-extension.test.ts` | 块 3+4 测试 |
| 改动 | `docs/judge.md` | 任务书章节 |
| 改动 | `AGENTS.md` | 关键约定一条 |

**净增估计**: ~600 行代码 + ~250 行测试。

---

## 十、不做的事(明确边界)

- **不做** multi-driver / subagent 并行(上一轮已否决)
- **不做** user/install scope 任务书(D7,只 project)
- **不做** 全量 transcript 回放(D3,中等深度已够)
- **不做** 任务书自动触发(D6,用户显式命令)
- **不破坏** 现有 `/judge` 从零对齐流程(D8)
- **不复活** flow(§2.6)
- **任务书机制本身不改** driver.md / judge.md agent 定义(D9,经验进 initialPrompt 不进 agent 定义)。**注意**:同一批次另含一个 driver.md 硬约束修复(「不推活给用户」),那是知乎场景验证暴露的独立 bug 修复,不属于任务书机制本身的范畴

---

## 十一、风险与缓解

| 风险 | 缓解 |
|---|---|
| 样本量=1 过拟合: 任务书 PASS 一次不代表方法对 | runs[] 历史让用户看到 pass/fail 比;`/judge list` 展示 lastRun.status;多次 fail 提示重新审视。不阻断,只提示 |
| Judge 带经验后盲区: 套老经验盯新问题 | experience.md 标题明确「补充参考,非验收标准」;Spec.acceptance 始终硬底线;DECIDE/FINALIZE prompt 不变 |
| steerHistory 膨胀 | 一次 run steer 几次正常,极端 maxSteer=5 顶满也就 5 条;runs[] 限 10 条 |
| 任务书腐烂: 代码演进后老任务书失效 | 任务书是版本管理的团队资产,代码演进时 PR 一起更新;FAIL 沉淀让用户及时发现失效 |
| 任务书名冲突 / 路径穿越 | `isValidTaskbookName` 拒绝路径分隔符;save 前 confirm 覆盖 |

---

## 十二、验收标准(本文档完成的标志)

1. `/judge run <name>` 能加载任务书、跳过 ALIGN、保留 Judge 监督、跑完 PASS/FAIL
2. PASS/FAIL 后任务书 runs[] + experience.md 正确更新
3. `/judge save/edit/list` 三个命令可用
4. `/judge`(无参)从零对齐流程**零变化**
5. `npm test` 全绿(327 + 新增)
6. `docs/judge.md` + `AGENTS.md` 文档更新

---

## 附录 A: 关键文件:行索引(执行 agent 速查)

| 关注点 | 位置 |
|---|---|
| RequirementsSpec 类型 | `extensions/judge/judge-state.ts:3-9` |
| DriverSummary 类型 | `extensions/judge/judge-state.ts:30-40` |
| JudgeState 类型 | `extensions/judge/judge-state.ts:44-58` |
| Spec 产出 + setRequirementsSpec | `extensions/judge/judge.ts:561-568` |
| normalizeSpec / isRequirementsSpec | `extensions/judge/judge-utils.ts:208-224` / `judge.ts:293-304` |
| steer 计数(judge-driver) | `extensions/judge/judge-driver.ts:292-308` |
| cloneSummary | `extensions/judge/judge-driver.ts:82-98` |
| onFinalize 钩子 | `extensions/judge/judge.ts:677-752` |
| PASS 分支 | `extensions/judge/judge.ts:706-727` |
| FAIL 终态分支 | `extensions/judge/judge.ts:729-736` |
| FAIL-with-budget-resume | `extensions/judge/judge.ts:738-751` |
| driver initialPrompt 构造 | `extensions/judge/judge.ts:586-592` |
| createDriver 调用 | `extensions/judge/judge.ts:658` |
| driving 分支(agent_end) | `extensions/judge/judge.ts:580-793` |
| `/judge` 命令派发 | `extensions/judge/judge.ts:452-485` |
| JUDGE_COMMAND_MENU_OPTIONS | `extensions/judge/judge.ts:73` |
| resolveJudgeCommandArgs | `extensions/judge/judge.ts:437-447` |
| editor 模式参考 | `extensions/judge/judge.ts:804-812` |
| split-args 派发模板 | `extensions/mcp/commands.ts:70` |
| persistState | `extensions/judge/judge.ts:276-287` |
| restoreJudgeState | `extensions/judge/judge.ts:306-333` |
| getCwd | `extensions/judge/judge.ts:140-143` |
| JudgeFinalVerdict 类型 | `extensions/judge/judge-utils.ts:38-40` |
| parseJudgeFinalVerdict | `extensions/judge/judge-utils.ts:335-374` |

---

## 附录 B: 设计脉络(为什么是这个设计)

本规格源自 ugk-dev 与设计 agent 的多轮对话:
1. 最初设想「给 Judge 赋予 subagent 能力操纵多 driver」→ 评估复杂度过高且偏离 Judge 监督价值,否决
2. 转向「跑通一次的 Judge+driver 成为可复用单元」→ 设计 agent 误读为「蒸馏掉 Judge」,ugk-dev 纠正: **执行 agent 永远不靠谱,Judge 永远不能撤**
3. 厘清真实意图: **复用的不是「怎么不用 Judge」,而是「Judge+Driver 带领域经验起步」**;一次成功沉淀 Spec + steer 经验 + 失败原因,下次照本宣科但 Judge 监督完整保留
4. 明确最小复用单元 = 一对配好的 (Spec + 经验),任务书是这个单元的载体
5. 失败 run 也要沉淀(场景 2),作为重来起点

核心信念一句话: **Judge 是运行期永久质检员,不是开发期脚手架;任务书是给它和 Driver 积累领域经验,不是淘汰 Judge。**

---

## 附录 C: 实现记录(2026-06-21 验收)

实际实现与 spec 的两处偏离,经 ugk-dev 审核确认:

### C.1 driving 逻辑抽取为共享函数(接受)

**spec §五「块 4.3」原案**: `/judge run <name>` 后续 driving/delivering 「复用现有流程,下一次 agent_end 触发走 driving 分支」,不改现有 driving 代码。

**实际实现**: 把原 inline 在 `agent_end` handler 里的整段 driving 代码(widget、driver 创建、onFinalize、onEscalate)**抽成 `startActiveJudgeDriver` 函数**(`judge.ts:498-700`),让「从零对齐后的 driving」和「任务书 run 后的 driving」**调用同一个函数**。

**决策**: **接受**。这是纯抽取、行为等价的重构(所有现有测试全绿证明),消除了代码重复,比 spec 原案优雅。`agent_end` handler 改为:

```ts
if (state.phase === "driving" && state.spec && !activeDriver) {
  await startActiveJudgeDriver(ctx, state.spec);
  return;
}
```

### C.2 steer 不落盘,只进 experience.md(澄清)

**spec §4.1** taskbook.json schema **不含** `steerHistory`——steer 原始数据只在内存 `DriverSummary` 里,落盘形式只有 `experience.md`(渲染成品)。

**首版实现**曾把 `steerHistory` 写进 taskbook.json,经审核判定为冗余双事实源,已**改回 spec 原案**:
- `taskbook.json` 不存 steer,纯运行历史(runs[])
- `experience.md` 是经验的**唯一落盘载体**,成品文档
- `draftExperienceMd` 签名改为 `(name, spec, steerHistory, taskbook)` —— steer 从内存 DriverSummary 传入,渲染时用「本次 run 的 steer」
- `/judge run <name>` 注入 driver initialPrompt 时**直接读 experience.md 文件成品**,不重新渲染
- `/judge edit` 改 spec **不重渲** experience.md(经验是经验,spec 是 spec,语义分离)

### C.3 最终状态

- `npm test`: 346 pass / 0 fail(v2.0.0 的 327 + 任务书新增 19)
- 分支 `codex/judge-taskbook`,改动覆盖 taskbook.ts / judge-state.ts / judge-driver.ts / judge.ts + 测试 + 文档
- 未提交,等 ugk-dev commit

---

## 附录 D: `/judge edit` 改造决策(2026-06-21)

首版 `/judge edit` 是固定 6 题表单:每个字段先 `select` 选择保持/修改,再用 editor 写入。该方案被否,因为体验不像 Judge 对齐阶段,用户仍要自己理解和改 JSON 字段。

新决策:

- edit 复用 ALIGN 流程:进入 `aligning`,预填现有 `RequirementsSpec`,设置 `aligningMode="edit"` 和 `taskbookName`。
- prompt 换成 `EDIT_PROMPT`:Judge 对照现有 Spec,只追问模糊、过期、缺失或需确认的点,但仍必须调用 `questionnaire`,末尾保留 `extras` 补充题。
- 修订 Spec 产出后不弹普通 `委派 driver 执行` 菜单,而是弹 `存回任务书` / `继续调整` / `放弃`。
- `存回任务书` 只调用 `updateTaskbookSpec` 更新 `spec.json`,不重渲 `experience.md`;经验文档保持独立语义。
