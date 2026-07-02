# subtask 代码审核修改报告

> ⚠️ **本文"问题 1"及所附代码片段已过时(v2.1.1 起)。**
> - 本文记录并修复了"dispatcher 失败时弹交互式 `ctx.ui.input` 输入框",修复方式是给 `callDispatcher(...)` 加 `.catch(() => undefined)` 让其静默降级,再走 fallback 分支。
> - v2.1.1 起,这个 `.catch(() => undefined)` **已被移除**:`callDispatcher` 在模型/auth 不可用时**显式抛错**(`dispatcher 模型不可用`),`resolveRuntimeInputFromText` 不再 catch、不再 fallback 到交互式 UI。`complete()` 运行时错误仍在 `callDispatcher` 内部 catch。
> - 因此本文 line ~14、~32、~74 的 `callDispatcher(...).catch(() => undefined)` 代码片段与"弹交互式输入框"描述**均不再成立**。**不要照抄这些片段。** 权威实现见 `extensions/task/task-dispatcher.ts`。
> - 文档其余部分(批量授权、注入、block 等)不受影响。

> **交接对象**:subtask 第一版实现者。
> **背景**:你的实现整体质量高(结构清晰、测试用了正确 mock 模式、批量授权/注入/block 都到位,7 个测试全过)。审核发现 **1 个必须修的实质问题 + 1 个建议的健壮性增强**。本文是修改清单。
> **基线**:`npm test` 当前 449 pass / 0 fail。修改后应 ≥ 450,无回归。
> **不要 commit**,改完留给 review。

---

## 🔴 问题 1(必须修):dispatcher 失败时会弹交互式输入框

### 现象

当 taskbook 的 contract 声明了 `runtimeInput` 字段(如 `["url"]`),而 LLM 调 run_task 时传入的 input 经 dispatcher 翻译失败(`callDispatcher` 返回 undefined 或抛错被 catch),执行流会走到 `resolveRuntimeInputFromText` 的 fallback 分支,弹出**交互式 `ctx.ui.input` 输入框**。

### 为什么是问题

这个 fallback 是为**人手动敲 `/task run`** 设计的(人在屏幕前逐个字段填)。但 run_task 是 **LLM 调用的工具**:

1. **违反 spec §3.2"责任归 LLM,dispatcher 翻不出来就报错返回,不兜底"**。这是 subtask 设计的两条铁律之一。
2. **parallel 模式下灾难性**:N 个 task 并发跑 dispatcher,如果都失败,会弹 N 次 input 框,阻塞或行为异常。
3. 工具调用场景根本不该有 UI 交互兜底——LLM 看不到弹框,只会卡死。

### 根因位置

`extensions/task/task-dispatcher.ts`,`resolveRuntimeInputFromText` 末尾:

```typescript
export async function resolveRuntimeInputFromText(ctx, skill, contract, rawInput, modelOverride?): Promise<unknown> {
	const fields = runtimeFields(contract);
	if (rawInput.trim()) {
		const dispatched = await callDispatcher(ctx, skill, contract, rawInput, modelOverride).catch(() => undefined);
		if (dispatched) return dispatched;
	}
	if (fields.length === 0) return {};
	// ↓ 这里是问题:有 runtimeInput 字段 + dispatcher 失败 → 弹交互框
	const entries: Array<[string, string]> = [];
	for (const field of fields) {
		const value = await ctx.ui?.input?.(`task input: ${field}`, field);  // ← 工具场景不该走到这
		entries.push([field, value ?? ""]);
	}
	return Object.fromEntries(entries);
}
```

### 为什么测试没抓到

所有 run_task 测试都 mock 了 dispatcher 返回成功:
```typescript
setTaskDispatcherForTests(async () => ({ text: "hello" }));  // 永远成功,没测失败路径
```
经典的 happy-path 盲区。

### 修改要求

**给 `resolveRuntimeInputFromText` 加一个 `headless` 标志**(或新增一个 headless 变体函数)。区分两种调用场景:

- **人敲 `/task run`(有 UI)**:保持现状,dispatcher 失败可弹 input 兜底(人能答)。
- **run_task 工具调用(headless)**:dispatcher 失败 → **直接 throw**,不要弹 UI,不要兜底。

建议的签名变更:

```typescript
export async function resolveRuntimeInputFromText(
	ctx: any,
	skill: string,
	contract: unknown,
	rawInput: string,
	modelOverride?: string,
	headless = false,           // ← 新增,默认 false 保持现有行为
): Promise<unknown> {
	const fields = runtimeFields(contract);
	if (rawInput.trim()) {
		const dispatched = await callDispatcher(ctx, skill, contract, rawInput, modelOverride).catch(() => undefined);
		if (dispatched) return dispatched;
	}
	if (fields.length === 0) return {};
	// headless 模式:不弹 UI,翻译失败就报错,让 LLM 看到错误自己重试
	if (headless) {
		throw new Error(
			`dispatcher 未能从输入解析出 runtimeInput(字段: ${fields.join(", ")}）。` +
			`请用更明确、完整的 input 重试,或确认 taskbook 的 runtimeInput 定义。`
		);
	}
	// 交互模式:保持现状,弹 input
	const entries: Array<[string, string]> = [];
	for (const field of fields) {
		const value = await ctx.ui?.input?.(`task input: ${field}`, field);
		entries.push([field, value ?? ""]);
	}
	return Object.fromEntries(entries);
}
```

### 调用点改动

`extensions/task/task.ts` 里有两处调 `resolveRuntimeInput`:

1. **`executeSubtask` 内**(headless,必须传 true):
   ```typescript
   // task.ts executeSubtask 里
   const runtimeInput = await resolveRuntimeInput(ctx, loaded.skill, loaded.contract, request.input);
   ```
   需要让 `resolveRuntimeInput`(task.ts 内的 wrapper,line 384)把 headless 透传下去,且 executeSubtask 调用时传 `true`。

2. **`handleTaskRun` 内**(人交互,保持 false):不动。

具体:`resolveRuntimeInput` wrapper 也加 `headless` 参数透传:

```typescript
async function resolveRuntimeInput(ctx, skill, contract, rawInput, headless = false): Promise<unknown> {
	return await resolveRuntimeInputFromText(ctx, skill, contract, rawInput, taskbookModel(contract, "dispatcherModel"), headless);
}
```

executeSubtask 里:`await resolveRuntimeInput(ctx, loaded.skill, loaded.contract, request.input, true)`。

### 必须补的测试

在 `tests/subtask-tool.test.ts` 新增:

```typescript
test("run_task fails cleanly when dispatcher cannot parse input (no UI prompt)", async () => {
	const { pi, tools } = makePi();
	const { cwd, ctx } = makeCtx();
	let inputPrompted = 0;
	ctx.ui.input = () => { inputPrompted += 1; return "should-not-reach"; };
	registerTask(pi as any);
	// dispatcher 返回 undefined(模拟翻译失败),且 taskbook 声明了 runtimeInput 字段
	setTaskDispatcherForTests(async () => undefined);
	try {
		await saveFixtureTask(cwd, "needs-input");  // fixture 里 contract 有 runtimeInput: ["text"]
		const tool = tools.find((item) => item.name === "run_task");

		const result = await tool.execute("call-1", { name: "needs-input", input: "含糊不清的输入" }, undefined, undefined, ctx);

		// 关键断言:
		assert.equal(result.isError, true, "应返回错误而非弹 UI 兜底");
		assert.equal(inputPrompted, 0, "绝对不能弹 ctx.ui.input");
		assert.match(result.content[0].text, /runtimeInput|解析/);
	} finally {
		setTaskDispatcherForTests(undefined);
		rmSync(cwd, { recursive: true, force: true });
	}
});
```

**这个测试的核心断言是 `inputPrompted === 0`** —— 确保工具场景下绝不触发 UI 交互。

---

## 🟡 问题 2(建议修):executeSubtask 异常会炸掉整批 parallel

### 现象

`mapWithConcurrencyLimit` 里任何一个 `executeSubtask` **抛异常**,整个 Promise reject,execute 的 try/catch 把整批变成 `isError: true` 返回。

### 为什么(当前)影响有限

`executeSubtask` 的设计是 worker 失败、verify 失败都走 `status: "fail"`(不抛)。`loadSubtask`(taskbook 不存在)会抛,但它在 workerEnv 之前的 `Promise.all` 阶段,整批 error 是**期望行为**(名字写错就该让 LLM 看到全部可用项)。

**但**:`dispatchWorker` 内部若抛未预期异常(spawn 失败、子进程崩溃等),会冒泡出 executeSubtask,炸掉整批。一个 task 的 worker spawn 偶发失败,不该让同批其他成功的 task 一起丢失。

### 修改要求(健壮性增强)

给 `executeSubtask` 包一层 try/catch,未预期异常时返回 `{status:"fail"}` 而非抛出,保证**单 task 异常隔离**:

```typescript
async function executeSubtask(ctx, request, loaded, workerEnv, signal?): Promise<SubtaskResult> {
	try {
		// ... 现有全部逻辑 ...
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			name: request.name,
			status: "fail",
			outputDir: "(errored)",
			artifacts: [],
			verifyFailures: [],
			workerSummary: `执行异常: ${message}`,
			duration: 0,
			attempts: 1,
		};
	}
}
```

**注意边界**:这样改之后,`loadSubtask`(taskbook 不存在)的异常会被吞掉变成单个 fail,而不是整批 error。

这带来一个取舍,需要你判断:
- **方案 A(推荐)**:loadSubtask 仍放 execute 的 `Promise.all` 阶段(在 executeSubtask 之外),保持"名字错误=整批 error 列出所有可用项";executeSubtask 内部只包 worker/verify 阶段的异常。即:load 阶段的错误炸整批(让 LLM 看到可用列表),执行阶段的错误隔离成单 task fail。
- **方案 B**:全部包进 executeSubtask,load 错误也变成单 task fail。简单但 LLM 看不到可用 taskbook 列表(只在那个 task 的 summary 里)。

**建议方案 A**:保留现在的 load 在外层、执行在内的结构,executeSubtask 的 try/catch 只覆盖 worker+verify 部分(dispatchWorker 调用之后)。这样两种失败语义都正确。

### 建议补的测试

```typescript
test("run_task parallel isolates a single task's execution failure from the batch", async () => {
	const { pi, tools } = makePi();
	const { cwd, ctx } = makeCtx();
	registerTask(pi as any);
	// 第一个 task worker 正常,第二个 task 的 worker 抛异常
	let callCount = 0;
	setTaskWorkerRunnerForTests(async () => {
		callCount += 1;
		if (callCount === 2) throw new Error("spawn crashed");
		return workerOk("done");
	});
	setTaskDispatcherForTests(async () => ({ text: "x" }));
	try {
		await saveFixtureTask(cwd, "good");
		await saveFixtureTask(cwd, "crashy");
		const tool = tools.find((item) => item.name === "run_task");

		const result = await tool.execute("call-1", {
			tasks: [{ name: "good", input: "a" }, { name: "crashy", input: "b" }],
		}, undefined, undefined, ctx);

		// 关键:整批不是 isError,单 task 隔离成 fail
		assert.equal(result.isError, undefined);
		assert.match(result.content[0].text, /1\/2 succeeded/);
	} finally {
		setTaskWorkerRunnerForTests(undefined);
		setTaskDispatcherForTests(undefined);
		rmSync(cwd, { recursive: true, force: true });
	}
});
```

---

## 修改顺序建议

1. **问题 1**(headless 标志)—— 最高优先级,违反 spec 铁律
2. **问题 2**(异常隔离)—— 健壮性,一起做省得再来一轮

两个都改完跑 `npm test`,应在 449 基础上 +2(两个新测试)= 451 pass / 0 fail。

---

## 不要做的事

- 不要改 `handleTaskRun` 的 dispatcher 调用(那是人交互场景,保持 false)
- 不要删 fallback 逻辑(人敲 `/task run` 还需要它)
- 不要 commit
- 不要"顺手"改无关代码

---

## 完成后

在本文末尾追加"实际完成结果",记录:
- 问题 1 是否按建议改(headless 标志 vs 你选了别的方案)
- 问题 2 选了方案 A 还是 B
- `npm test` 最终数
- 任何偏差

## 实际完成结果(2026-06-24)

- 问题 1:按建议给 `resolveRuntimeInputFromText` 增加 `headless` 标志;`run_task` 传 `true`,dispatcher 失败直接返回工具错误,不再弹 `ctx.ui.input`。
- 问题 2:选择方案 A;`loadSubtask` 仍在外层,缺失 taskbook 继续整批错误并列出可用项;`executeSubtask` 只隔离 worker/verify 执行异常为单 task fail。
- 新增测试 2 个:`run_task fails cleanly when dispatcher cannot parse input (no UI prompt)` 和 `run_task parallel isolates a single task's execution failure from the batch`。
- 验证:`npm test` 最终为 451 pass / 0 fail。
- 偏差:无。
