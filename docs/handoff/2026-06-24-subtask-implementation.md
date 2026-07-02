# subtask 实现交接文档

> **交接对象**:负责把 subtask 设计落地的同事。
> **日期**:2026-06-24
> **必读顺序**:先读 `docs/design/subtask-extension-spec.md`(设计契约)→ 再读本文(落地地图)。两份配套,缺一不可。
> **自包含**:本文假设你没参与设计讨论,读完能直接动手。

---

## 一、你要做什么(一句话)

给 task 模块加一个 LLM 可调用的 `run_task` 工具,让 main agent 能像调 `subagent` 一样调 taskbook。**不改动 task 现有的核心逻辑,只在外面包一层 + 注入。**

---

## 二、最关键的认知(先建立,再看代码)

### 2.1 `handleTaskRun` 不能复用(最大的坑)

`task.ts:628` 的 `handleTaskRun` 是 `/task run` 命令的实现,看起来 run_task 该复用它,**但绝对不能**。三个原因:

1. **fire-and-forget**:它 `return Promise<void>`,真正的执行在内部一个不 await 的 `runPromise`(line 669 `const runPromise = (async () => {...})();`),你拿不到结果。
2. **UI 交互式**:里面全是 `ctx.ui.notify` / `setTaskRunWidget`,run_task 是 LLM 工具,不能弹 UI。
3. **闭包状态依赖**:它读写 `registerTask` 闭包里的 `activeTaskRun` / `lastTaskRunReview` / `taskRunPromiseForTests`,这些是命令模式的状态,工具模式不该碰。

**正确做法**:run_task 自己写一个 headless 编排函数(下文 §4 给出),逐个调用已验证可复用的**底层函数**(都是纯逻辑、返回结构化结果、不依赖 UI)。底层函数列表见 spec §5 的表格。

### 2.2 两条铁律(违反就跑偏)

1. **需求驱动**:LLM 带着任务来,不是来逛 taskbook。清单只放 name + description,不放参数表。
2. **责任归 LLM**:dispatcher 翻不出来参数就报错返回,不要兜底、不要猜默认值。

---

## 三、代码地图(task 模块现状)

模块现在 **11 个文件、2527 行**(注意:代码仍在演进,动手前用 `wc -l extensions/task/*.ts` 确认行号没漂移太多)。

| 文件 | 职责 | run_task 是否涉及 |
|---|---|---|
| `task.ts` (1289行) | 核心:状态机、命令、pi 事件 hook、UI 编排 | **主战场**(加工具+注入+block+导出函数) |
| `task-state.ts` | 纯状态机函数 | 不动 |
| `task-spec.ts` | RequirementsSpec 解析 | 不动 |
| `task-book.ts` | taskbook 持久化、CRUD、runs 历史 | **复用**(loadTaskbook/appendRunToTaskbook/listTaskbooks) |
| `task-worker.ts` | dispatchWorker:spawn worker 子进程 | **复用** + 改 ~10 行(workerModel) |
| `task-checker.ts` | verify 失败后 checker 反馈 | run_task 单跑可不用(见 §4.3) |
| `task-dispatcher.ts` | 翻译人话→runtimeInput | **复用** + 改 ~10 行(dispatcherModel) |
| `task-run-reviewer.ts` | run 后的复盘 agent | 不涉及 |
| `task-verify.ts` | spawn verify.mjs | **复用**(runVerify) |
| `task-prompts.ts` | TASK_ALIGN/REVIEW prompt | 不涉及 |
| `task-utils.ts` | bash 白名单、摘要 | 不涉及 |

---

## 四、接线清单(改哪里、怎么改)

### 4.1 新文件 `extensions/task/task-registry.ts`(解耦注入层)

纯函数,扫 taskbook → 生成清单文本。谁需要(judge/cron 将来)都能复用。

```typescript
import { listTaskbooks } from "./task-book.ts";

/** 扫描所有 taskbook,生成 system prompt 用的清单文本。纯函数,无状态。 */
export async function buildTaskbookPrompt(cwd: string): Promise<string> {
    const items = await listTaskbooks(cwd);
    if (items.length === 0) return "";
    const lines = items.map((item) => `- ${item.name} — ${item.description}`);
    return [
        "## 可用 task(确定性、已机器验收的固定任务)",
        "下列 task 可用 run_task 工具复用。只有当你的任务明确匹配其中某项时才调用:",
        "",
        ...lines,
    ].join("\n");
}
```

**为什么单独成文件**:spec §6 的解耦原则。清单逻辑写一份,调用方不管格式。

### 4.2 `task.ts` 改动 1:导出 `resolveTaskWorkerEnv`

现在它在 `registerTask` 闭包内(`task.ts:337`),是内部函数。run_task 工具(在闭包外/工具 execute 里)要用它做受保护工具授权,必须导出。

- **现状签名**:`async function resolveTaskWorkerEnv(ctx, loaded: LoadedTaskbook, activeTools: string[]): Promise<Record<string,string|undefined> | null>`
- **做法**:把它从闭包内提到模块顶层(顶层函数),加 `export`。闭包内的调用点(`handleTaskRun` line 649)改成直接调顶层函数(签名不变,行为不变)。
- **它做什么**:检查 taskbook 声明的受保护工具(chrome_cdp / MCP `server__*`),弹 confirm 授权,返回 worker env 或 null(用户拒绝)。**返回 null 表示未授权,调用方应取消。**

### 4.3 `task.ts` 改动 2:新增 headless 编排函数

这是 run_task 的核心。放在 `handleTaskRun` 附近,作为顶层 async 函数。**参考 `handleTaskRun` 的逻辑骨架,但去掉所有 UI 交互,改成返回结构化结果。**

```typescript
export interface SubtaskResult {
    status: "pass" | "fail";
    outputDir: string;
    artifacts: string[];
    verifyFailures: VerifyFailure[];
    workerSummary: string;
    attempts: number;
    duration: number;
}

/**
 * run_task 工具的 headless 执行。复用底层函数,不碰 UI 闭包状态。
 * 注意:不包含 retry/checker 循环(spec 未要求;如需可后续加)。
 */
async function executeSubtask(
    ctx: any,
    name: string,
    input: string,
    activeTools: string[],
    signal?: AbortSignal,
): Promise<SubtaskResult> {
    // 1. load
    const loaded = await loadTaskbook(ctx.cwd, name);
    if (!loaded) {
        throw new Error(`taskbook "${name}" 不存在。可用: ${(await listTaskbooks(ctx.cwd)).map(i => i.name).join(", ")}`);
    }
    // 2. 翻译人话 → runtimeInput
    const runtimeInput = await resolveRuntimeInputFromText(ctx, loaded.skill, loaded.contract, input);
    // 3. 受保护工具授权
    const workerEnv = await resolveTaskWorkerEnv(ctx, loaded, activeTools);
    if (workerEnv === null) throw new Error(`taskbook "${name}" 需要受保护工具授权,但未获授权`);
    // 4. 独立 outputDir(随机后缀防 parallel 撞)
    const runDir = path.join(ctx.cwd, ".tasks", "runs", `task-${name}-${Date.now()}-${Math.random().toString(36).slice(2,8)}`);
    const outputDir = path.join(runDir, "output");
    await mkdir(outputDir, { recursive: true });
    // 5. worker
    const startedAt = Date.now();
    const workerResult = await dispatchWorker(
        { skill: loaded.skill, contract: loaded.contract, runtimeInput, outputDir },
        { cwd: ctx.cwd, env: workerEnv, signal },
    );
    // 6. verify
    const verifyResult = await runVerify({
        verifyPath: path.join(loaded.dir, "verify.mjs"),
        outputDir, input: runtimeInput,
    });
    const status = verifyResult.passed ? "pass" : "fail";
    // 7. 记 run 历史
    await appendRunToTaskbook(loaded.scope, ctx.cwd, name, {
        timestamp: new Date().toISOString(), status, input: runtimeInput,
        exitCode: verifyResult.exitCode ?? 1, verifyFailures: verifyResult.failures,
        duration: (Date.now() - startedAt) / 1000,
    });
    // 8. 收集 artifacts(按 contract.artifacts,缺省扫 outputDir)
    const artifacts = await collectArtifacts(loaded.contract, outputDir);
    return {
        status, outputDir, artifacts,
        verifyFailures: verifyResult.failures,
        workerSummary: workerResult.ok ? workerResult.summary : (workerResult.errorMessage ?? "worker failed"),
        attempts: 1, duration: (Date.now() - startedAt) / 1000,
    };
}
```

**关于 retry/checker**:spec §4 没要求 run_task 带 retry 循环。第一版**只跑一次**(worker → verify → 返回)。如需 retry,参考 `handleTaskRun` line 671-747 的 `for (attempt...)` + `dispatchChecker` 循环,但那是后续增强,不在本次范围。**别一开始就抄 retry,先做最小可用。**

`collectArtifacts`:参考现有 `formatArtifacts`(`task.ts`,搜这个函数名),它读 `contract.artifacts` 列表、缺省扫 outputDir。把它的"格式化成文本"改成"返回路径数组"即可。

### 4.4 `task.ts` 改动 3:注册 `run_task` 工具

在 `registerTask(pi)` 里,`pi.registerTool?.(taskCompleteTool)`(line 998 附近)旁边加:

```typescript
pi.registerTool?.({
    name: "run_task",
    label: "Run Task",
    description: `<spec §4.4 的完整 description 文本>`,
    parameters: Type.Object({
        name: Type.Optional(Type.String({ description: "..." })),
        input: Type.Optional(Type.String({ description: "..." })),
        tasks: Type.Optional(Type.Array(Type.Object({
            name: Type.String(), input: Type.String(),
        }), { description: "parallel 模式" })),
    }),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
        // 三选一(single/parallel),对齐 subagent 的 modeCount 校验
        // single: executeSubtask(ctx, params.name, params.input, ctx 的 activeTools, signal)
        // parallel: mapWithConcurrencyLimit(params.tasks, 4, t => executeSubtask(...)), 聚合返回 N/M
        // 失败 isError: true,让 LLM 决策
    },
});
```

**activeTools 怎么拿**:工具 execute 的 `ctx` 是 `ExtensionContext`,没有直接 `getActiveTools`。需要的是"当前 main session 的 active tools"用来判断受保护工具授权。参考 `handleTaskRun` 的调用点(line 1108)传的是 `pi.getActiveTools()`。**工具 execute 里拿不到 pi**,所以要在 `registerTask` 闭包里把 `pi.getActiveTools` 的引用捕获进去(闭包能访问 pi)。具体:execute 内部调一个闭包内的 helper `() => typeof pi.getActiveTools === "function" ? pi.getActiveTools() : TASK_NORMAL_TOOLS`。

### 4.5 `task.ts` 改动 4:executing 阶段 block run_task

在 `tool_call` handler(line 1173)里,现有 block subagent 的那段(line 1183-1188)旁边加 run_task 的 block:

```typescript
if (state.phase === "executing") {
    if (event.toolName === "subagent" || event.toolName === "run_task") {
        return {
            block: true,
            reason: "Task executing 阶段禁止调用 subagent/run_task(task 不可嵌套)。",
        };
    }
    // ... 现有 recordExecuteProcessEntry 逻辑
}
```

**复用现有 block 机制,不新建。** spec §7.2。

### 4.6 `task.ts` 改动 5:before_agent_start 注入清单

现有 `before_agent_start` handler(line 1149)现在只在 reviewing/planning 返回 message。**新增**:无论什么 phase,都返回 `systemPrompt` 拼接 taskbook 清单。

```typescript
// session_start 时缓存清单(在现有 session_start handler 里加)
let cachedTaskbookPrompt = "";
pi.on("session_start", async (_event, ctx) => {
    cachedTaskbookPrompt = await buildTaskbookPrompt(ctx.cwd);  // 加这行
    // ... 现有逻辑
});

pi.on("before_agent_start", async () => {
    const result: any = {};
    // 现有 reviewing/planning 的 message 逻辑保留
    if (state.phase === "reviewing") { result.message = {...}; }
    else if (state.phase === "planning") { result.message = {...}; }
    // 新增:注入清单
    if (cachedTaskbookPrompt) result.systemPrompt = cachedTaskbookPrompt;
    return Object.keys(result).length ? result : undefined;
});
```

**机制依据**:pi 的 `BeforeAgentStartEventResult.systemPrompt` 字段(types.d.ts:760-763),多个 extension 链式拼接。注入的文本会追加到系统提示词,**不是替换**。

### 4.7 `task-dispatcher.ts`:支持 dispatcherModel

`callDispatcher`(task-dispatcher.ts:56)现在用 `ctx.model`。改成优先用传入的 model:

```typescript
async function callDispatcher(ctx, skill, contract, rawInput, modelOverride?: string): Promise<unknown | undefined> {
    if (dispatcherForTests) return await dispatcherForTests(ctx, skill, contract, rawInput);
    const model = modelOverride
        ? (ctx.modelRegistry?.find?.(parseProvider(modelOverride), modelOverride) ?? ctx.model)
        : ctx.model;
    // ... 其余不变
}
```

`resolveRuntimeInputFromText` 也要透传 modelOverride(从 contract 里读 `dispatcherModel`)。`parseProvider` 参考 `subagent-runtime.ts` 的 `normalizeAgentModelForCli` 思路——`deepseek-v4-flash` → provider `deepseek`。

**注意**:model 字符串格式(`deepseek/deepseek-v4-flash` vs 裸 `deepseek-v4-flash`)在 `normalizeAgentModelForCli` 里有处理逻辑(subagent-runtime.ts:38),dispatcher 这边要对齐同一套规范化,别各写一套。

### 4.8 `task-worker.ts`:支持 workerModel

`dispatchWorker`(task-worker.ts:58)现在 spawn worker 用 worker.md 默认 model。`runSingleAgent` 的第 5 个参数之后没有直接的 model 参数——model 是靠 agent 定义 frontmatter + `--model` flag。

看 `subagent.ts:113-115`:`if (model) args.push("--model", model)`,这个 model 来自 `normalizeAgentModelForCli(agent.model)`。worker agent 的 model 在 `agents/worker.md` frontmatter。

**所以 workerModel 的覆盖路径**:dispatchWorker 读 contract.workerModel → 如果有,传给 runSingleAgent 的 extraEnv 或新增 model 参数。但 `runSingleAgent` 签名(subagent.ts:85)没有 model override 槽位,它的 model 完全来自 agent 配置。

**这里有个实现选择**,需要你(实现者)判断,或回头确认:
- **方案 A**:给 `runSingleAgent` 加一个可选 model override 参数(改 subagent.ts 签名,影响面稍大但干净)
- **方案 B**:dispatchWorker 读到 workerModel 后,临时写一个 override 的 agent config 传进去(不改 runSingleAgent,但 hacky)

**建议先确认这条**:workerModel 是否值得为它动 runSingleAgent 的签名。如果第一版想极简,**workerModel 可以缓做**(缺省用 worker.md),只先做 dispatcherModel(dispatcher 是 `complete()` 调用,加参数很容易)。spec §8.3 本来就允许两个字段都缺省。

### 4.9 model 配置的读取点

contract 是 `unknown`,读 model 字段参考现有 `runtimeFields`(`task.ts:279`)的防御式读法:

```typescript
function taskbookModel(contract: unknown, field: "dispatcherModel" | "workerModel"): string | undefined {
    if (!contract || typeof contract !== "object" || Array.isArray(contract)) return undefined;
    const value = (contract as Record<string, unknown>)[field];
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
```

---

## 五、测试怎么写

### 5.1 现有 mock 框架(直接抄)

看 `tests/task-extension.test.ts`:
- `makePi(initialActiveTools)`(line 41):mock 的 ExtensionAPI,带 commands/handlers/entries/activeTools。**你不用改它**,run_task 工具会通过 `pi.registerTool` 被收进 `tools` 数组。
- `makeCtx()`(line 83):mock 的 ctx,带 notify/select/setStatus/setWidget/confirm。**可能要加 `model`/`modelRegistry` 字段**(如果测 dispatcherModel)。
- handlers 触发:`handlers.get("tool_call")![0](event, ctx)` 这种方式调 handler。

### 5.2 注入点测试(已有先例)

`setTaskWorkerRunnerForTests` / `setTaskDispatcherForTests` / `setTaskCheckerRunnerForTests` 都是"注入假 runner"的模式(避免真 spawn 子进程)。**run_task 的测试照抄**:用 `setTaskWorkerRunnerForTests(fakeRunner)` + `setTaskDispatcherForTests(fakeDispatcher)`,这样 executeSubtask 不真 spawn,只验证编排逻辑。

### 5.3 必须覆盖的 case(对应 spec §14 验收清单)

1. single 模式 PASS:造个临时 taskbook(`mkdtempSync` + `saveTaskbook`),调 run_task,mock worker/verify 返回 ok → 断言 status=pass + artifacts/outputDir 有值
2. single 模式 FAIL:mock verify 返回 failures → 断言 status=fail + verifyFailures
3. taskbook 不存在:断言抛错 + 错误信息含可用名
4. parallel 模式:tasks 传 3 个(2 pass 1 fail)→ 断言聚合返回 "2/3 succeeded"
5. executing block:`makeCtx` 走到 executing phase,触发 tool_call with toolName="run_task" → 断言返回 `{block:true}`
6. buildTaskbookPrompt 是纯函数:单测它,造 2 个 taskbook,断言输出文本含两个 name

**worker spawn 测试参考**:`tests/task-worker.test.ts`(看它怎么 mock runSingleAgent)。

---

## 六、项目硬约束(容易踩雷)

这些来自 `AGENTS.md` 和既有惯例,**务必遵守**:

1. **bash 走 Git Bash**(`D:\Git\bin\bash.exe`),命令用 Linux 语法,Windows 路径用正斜杠。代码里的 spawn 已适配,别破坏。
2. **中文注释,英文标识符**。看现有 task.ts 注释风格。
3. **不要碰** Judge 代码(`extensions/judge/`)、smoke-tui、旧 untracked docs。
4. **不要 commit / push**,除非明确要求。改完留在工作区。
5. **改完跑 `npm test`**。动手前先 `npm test` 确认基线全过(记录当前 pass 数,改完对比,不应有回归)。
6. **task 模块独立性**:`tests/task-extension.test.ts:33` 有个测试,断言 task 模块文件不 import plan-mode/judge/chrome-cdp/mcp。**run_task 新代码也要保持这个独立性**——run_task 是 task 自己的能力,别反向依赖别的 extension。
7. **dangerous bash 门**:`extensions/index.ts` 有全局权限门拦 `rm -rf`/`sudo`/`chmod 777`。run_task 不涉及,别绕过。

---

## 七、验证(怎么知道做对了)

### 7.1 自动化

```bash
npm test                                    # 全过,无回归
node --test tests/subtask-tool.test.ts      # 新测试全过
node --test tests/task-extension.test.ts    # 既有测试无回归
```

### 7.2 手动 e2e(可选但推荐)

如果环境有 DeepSeek key,造个最简 taskbook(如 grapheme-count),在 TUI 里让 main agent 调 run_task:
```
帮我统计 "abc" 的字素数,用 task
```
预期:main 调 run_task(grapheme-count, "abc"),返回 pass + 产物路径,main 汇报结果。

**注意**:真实 e2e 需要 worker spawn 真起子进程。先确保 `npm run smoke:task`(`scripts/smoke-task.mjs`)还能跑通,它覆盖了底层链路。

---

## 八、风险点 / 待确认(动手前先想清楚)

1. **§4.8 workerModel 的实现路径未定**(方案 A 改 runSingleAgent 签名 vs 方案 B hacky)。建议第一版缓做 workerModel,只做 dispatcherModel。**这是唯一可能需要回头问设计者的点。**

2. **§4.4 activeTools 在工具 execute 里拿不到 pi**。已给方案(闭包捕获),但实现时要确认 `ctx` 和 `pi` 的可达性——工具 execute 的 ctx 是 `ExtensionContext`,不含 getActiveTools;pi 是 `registerTask` 的参数,闭包内可达。

3. **行号会漂移**。本文行号基于 2026-06-24 的代码(task.ts 1289 行)。动手前用 grep 重新定位符号(关键词:`handleTaskRun`、`resolveTaskWorkerEnv`、`pi.on("tool_call"`、`pi.registerTool?.(taskCompleteTool)`)。

4. **task.ts 在持续演进**。最近加了 activeTaskRun/waitForTaskRunForTests/task-run-reviewer。rebase/合并时注意冲突。

---

## 九、改动文件清单(总览)

| 文件 | 类型 | 说明 |
|---|---|---|
| `extensions/task/task-registry.ts` | 新增 | buildTaskbookPrompt 纯函数 |
| `extensions/task/task.ts` | 改 | 导出 resolveTaskWorkerEnv + executeSubtask + 注册 run_task + executing block + before_agent_start 注入 |
| `extensions/task/task-dispatcher.ts` | 改 ~10行 | callDispatcher 支持 dispatcherModel |
| `extensions/task/task-worker.ts` | 改(或缓做) | dispatchWorker 支持 workerModel(见 §4.8) |
| `tests/subtask-tool.test.ts` | 新增 | 见 §5.3 |

---

## 十、完成后

- 跑 `npm test` 确认全过
- 跑 §7.2 手动验证(如有 key)
- 在本文末尾追加"实际完成结果"小节(参考其他 handoff 文档的格式),记录:改了哪些文件、npm test 数、遇到的偏差、workerModel 是否缓做
- 不要 commit,留给 review

## 十一、实际完成结果(2026-06-24)

- 已实现 `run_task` 工具:single/parallel 两种模式,headless 编排,不复用 `handleTaskRun`。
- 已新增 `extensions/task/task-registry.ts`,在 `session_start` 缓存 taskbook 清单并于 `before_agent_start` 注入 systemPrompt。
- 已导出并复用 `resolveTaskWorkerEnv`,parallel 模式会合并受保护工具并一次确认。
- 已支持 `dispatcherModel`;`workerModel` 第一版按交接 §4.8 建议缓做,未改 `runSingleAgent` 签名。
- 已新增/更新测试:新增 `tests/subtask-tool.test.ts`,补充 dispatcherModel 覆盖。
- 验证:改前 `npm test` 为 441 pass / 0 fail;改后 `npm test` 为 449 pass / 0 fail。
