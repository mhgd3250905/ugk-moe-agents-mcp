# task-extension-followup-8 — task 运行进度可见性增强

> **状态:已完成(2026-06-29)。** 改善 `/task run` 的运行时反馈:回车后即响应(消除静默期)+ 运行中显示大概步骤和关键失败节点。设计经三轮迭代收敛。`npm test` 478/478 pass。
>
> **交接文档**:`docs/handoff/2026-06-29-task-run-progress-visibility.md`(含完整摸排链路和测试基线)
>
> **更新时间**:2026-06-29

---

## 背景

用户反馈两个体验问题:

1. **回车后静默**:`/task run <name> <input>` 回车后,先持续显示空白 ╌╌╌,过一会才出现"⏳ 运行中..."。
2. **运行中死寂**:`worker 执行中...` 一直不变,看不到 worker 在干什么,第一轮失败时也不知道具体原因。

两者本质是同一类问题——**进度可见性缺失**,但发生在不同阶段。

---

## 根因摸排(都是机制缺失,非 task 内部声明)

task 内部(taskbook 的 skill.md/verify.mjs/contract.json)**没有任何手段**控制运行中日志丰富度。日志链路完全由机制层决定。

### 阶段一:回车后静默(真凶 = dispatcher LLM 调用)

回车后到 worker spawn 的执行顺序:

| 步骤 | 耗时 | UI 反馈 |
|---|---|---|
| chooseTaskbookName / loadTaskbook | 快 | 无 |
| resolveTaskWorkerEnv(CDP/MCP 授权) | 快/弹确认 | 无 |
| **resolveRuntimeInput → callDispatcher** | **数秒~十几秒 (LLM)** | **无 ← 真凶** |
| runTaskWithRetry → onWorkerStart | — | ⏳ 运行中 |

`resolveRuntimeInput`(task.ts)→ `callDispatcher`(task-dispatcher.ts)是一次**阻塞的 dispatcher LLM 调用**,把自然语言 input 翻译成结构化参数。这期间 UI 完全静默。

**关键证据:对称缺口**。headless 路径(`executeSubtask`/run_task 工具)在 task.ts:1124 **早就有** `setTaskRunWidget(ctx, [title, "正在解析输入..."])`。交互式路径 `handleTaskRun` **漏了**。

### 阶段二:运行中死寂(真凶 = onUpdate 只取最终输出)

旧 `task-worker.ts` 的 onUpdate 回调只取 `partial.content` 的 text——而这是 `subagent.ts` 的 `emitUpdate` 用 `getFinalOutput(currentResult.messages)` 算出的**最终输出文本**(从后往前找最后一条 assistant text)。

问题:`getFinalOutput` 在 worker 调工具的轮次(该轮 assistant 没 text)会返回空或占位 `(running...)` → "worker 执行中..."一直不变。而真正的进度信息(每轮 summary、失败的 toolResult)藏在 `partial.details.results[0].messages` 里,被丢弃了。

**数据本来就有,是机制把信息源切窄了。**

---

## 设计:三轮迭代收敛

| 迭代 | 设计 | 用户反馈 |
|---|---|---|
| v1 | 透传全部 ToolCall + 成功/失败 toolResult | "太繁琐太细节" |
| v2 | 只报失败的 toolResult | "worker 执行中...一直不变"(summary 被丢了) |
| **v3(最终)** | **每轮 summary 首行(大概步骤)+ 失败 toolResult(关键节点)** | "没啥大问题" |

### 最终取舍规则

| 信号源 | 是否显示 | 理由 |
|---|---|---|
| worker 每轮 assistant 的文字 summary(首行) | ✅ | 大概步骤,精简又能体现进度 |
| ✖ 失败的 toolResult | ✅ | 关键节点,命中"失败想看原因"痛点 |
| 🔧 工具调用(ToolCall) | ❌ | 太细节,逐条报繁琐 |
| ✔ 成功的 toolResult | ❌ | 噪音,worker 正常干活无需逐条报 |

**关键洞察**:LLM 在调工具时那一轮的 assistant message 经常**没有 text**(直接调工具不说话)。所以 v2 只报失败 toolResult 时,运行中会长时间无任何输出。真正的"大概步骤"是 LLM **会说话的那几轮**的 summary——抓住这些,进度感就回来了。

---

## 实现

### 改动 A:`/task run` 回车后补"正在解析输入"提示

**文件**:`extensions/task/task.ts`(`handleTaskRun`)

在 `resolveRuntimeInput` 之前补一行(与 headless 路径 task.ts:1124 对称):
```ts
setTaskRunWidget(ctx, [`⏳ taskbook "${finalName}" 准备中...`, "正在解析输入..."]);
```

不改 dispatcher 契约、abort/repair 语义(widget 是独立 UI 反馈,`activeTaskRun` 仍在 resolveRuntimeInput 之后创建)。

### 改动 B:worker 运行中进度透传(summary 首行 + 失败 toolResult)

**文件**:`extensions/task/task-worker.ts`(`dispatchWorker` 的 onUpdate 回调 + `formatMessageProgress`)

onUpdate 改为**增量遍历 messages**:
```ts
opts.onUpdate
    ? (() => {
        let lastSeenIndex = 0;
        return (partial: Parameters<OnUpdateCallback>[0]) => {
            const result = partial.details?.results?.[0];
            if (!result?.messages) {
                // fallback:部分模拟场景 details 缺失
                const text = partial.content.find((part) => part.type === "text")?.text;
                if (typeof text === "string") opts.onUpdate?.(text);
                return;
            }
            for (let i = lastSeenIndex; i < result.messages.length; i += 1) {
                for (const line of formatMessageProgress(result.messages[i])) opts.onUpdate?.(line);
            }
            lastSeenIndex = result.messages.length;
        };
    })()
    : undefined,
```

`formatMessageProgress(msg)`:
```ts
function formatMessageProgress(message: SingleResult["messages"][number]): string[] {
    if (message.role === "assistant") {
        // 每轮 assistant 的文字 summary —— 取首行,作为"大概步骤"
        const text = message.content.find((part) => part.type === "text")?.text ?? "";
        const head = text.split(/\r?\n/).find((line) => line.trim()) ?? "";
        return head.trim() ? [head.trim()] : [];
    }
    if (message.role === "toolResult" && message.isError) {
        const firstText = message.content.find((part) => part.type === "text")?.text ?? "";
        const head = firstText.split(/\r?\n/).find((line) => line.trim()) ?? "";
        const detail = head.length > 120 ? `${head.slice(0, 117)}...` : head;
        return [detail ? `✖ ${message.toolName}: ${detail}` : `✖ ${message.toolName}`];
    }
    return [];
}
```

---

## 不动的部分(边界确认)

1. **subagent 通用契约不动** —— 只改 task-worker 一个消费方,`OnUpdateCallback` 类型签名未变
2. **task.ts 管道不动** —— 推的是普通 text 行,经现有 `formatProgressLines`(去 markdown / 去重 / `.slice(-5)` / 截 120 字)处理,零改动
3. **activeTaskRun 状态语义不动** —— "正在解析输入"widget 在 `activeTaskRun` 创建之前设置,但不破坏 abort/repair 语义(task-extension 62/62 通过)
4. **dispatcher 契约不动** —— 只在调用前加 UI 提示,不改 dispatcher 行为

---

## 用户看到的最终效果

```
[回车]
  → ⏳ taskbook "x-search" 准备中...        ← 改动 A
     正在解析输入...
  → ⏳ taskbook "x-search" 运行中...
     尝试 1/4
     worker 执行中...
     正在导航到 X 搜索页                      ← 改动 B(大概步骤)
     正在解析搜索结果
     ✖ chrome_cdp: selector not found        ← 改动 B(关键节点)
     换选择器重试
[完成]
  → ▸ taskbook "x-search" 运行过程: PASS (18 条)
```

---

## 已知边界 / 不做

- **stderr 实时透传**:worker 子进程崩溃时 stderr 在 `subagent.ts` 累加但只在结束后进 `errorMessage`,运行中没推给 UI。需动 `subagent.ts`(通用契约层),是另一条线。worker 正常调工具的失败已被 ✖ 行覆盖,此缺口仅影响"子进程本身崩溃"的边角场景。
- **widget 固定 5 行窗口**:`formatProgressLines` 的 `.slice(-5)` 未放宽,够用。
- **worker 不说话的轮次无 summary**:LLM 调工具时若该轮没写 text,那轮就没有 summary 行——这是 LLM 行为,机制层无法凭空生成。进度感依赖 LLM 会说话的轮次。

---

## 测试

`tests/task-worker.test.ts` +1 测试:"dispatchWorker streams assistant summary + failed tool results via onUpdate" —— 覆盖:每轮 summary 首行被推、多行只取首行、失败 toolResult 被推、ToolCall/成功 toolResult 不被推、增量索引不重发历史。

基线:`cf54a8f`(477/477/0)→ `e917910`(**478/478/0**)。

---

## 改动 commit

| commit | 内容 |
|---|---|
| `7b4b7a4` | v1: onUpdate 增量遍历 messages + `formatMessageProgress` |
| `260d22b` | 改动 A:`handleTaskRun` 补"正在解析输入"widget |
| `aa0a0f6` | v2 精简:删 ToolCall/成功 toolResult |
| `e917910` | v3 最终:增加 assistant summary 首行 |
