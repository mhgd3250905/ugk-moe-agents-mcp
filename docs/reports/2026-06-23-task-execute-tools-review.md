# Code Review 报告:`/task` execute 阶段放开环境工具

> **提交对象**:code review
> **改动日期**:2026-06-23
> **改动范围**:4 个代码/设计文件,+119/-26 行(净增 93 行)
> **测试**:原 review `npm test` 422/422 pass; 最新回归 424/424 pass
> **风险等级**:低(纯 bug fix,改动面小,有完整测试覆盖)

---

## 一、要解决的问题

`/task` 创造流程的 **execute 阶段**(task-creator 亲手做一遍验证可行性),task-creator 报:

> "我现在的工具集里没有直接的 CDP 工具可以调用……我只能用 bash、read、write、edit 这四个工具。"

导致需要环境工具的任务(如 B 站下载要 chrome_cdp 读 cookie)在创造阶段就做不下去。

### 根因(已通过 pi runtime 源码确认)

execute 阶段工具集被写死成 allowlist:

```typescript
const TASK_EXECUTING_TOOLS = ["read", "write", "edit", "bash", "task_complete"];
```

pi runtime 的 `setActiveTools` 是**纯白名单**(`node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js:543-557`):

```js
setActiveToolsByName(toolNames) {
    const tools = [];
    for (const name of toolNames) {
        const tool = this._toolRegistry.get(name);  // 只挑列出的
        if (tool) { tools.push(tool); }
    }
    this.agent.state.tools = tools;  // 完全替换,不在列表的一律丢失
}
```

不在列表的工具(chrome_cdp、mcp 等)**物理屏蔽**——这就是根因。

### 设计意图冲突(需 reviewer 注意)

这是 spec 当时的疏漏。spec 4.1 节写 task-creator 工具集 = `read/write/edit/bash,禁止 subagent`,当时没考虑环境工具。但**同一项目的 worker agent**(`agents/worker.md`)已经在更早的 commit(`6791387`)明确改成"删 tools 字段继承全部工具,只 prompt 禁 subagent"——理由就是 B 站下载需要 chrome_cdp。本次改动让 execute 的 task-creator 跟 worker 做法对齐。

---

## 二、改动方案(用户已拍板)

**execute 阶段继承 main session 全部工具,只排除 subagent。**

具体采用"从 task 进入前的 active snapshot 或当前 active set 减 subagent,再加 task_complete",**叠加 `tool_call` 硬 block subagent 作为双保险**。

---

## 三、改动逐项说明

### 改动 1:新增 `applyExecuteTools` helper(`extensions/task/task.ts:81-92`)

```typescript
function applyExecuteTools(pi: ExtensionAPI): void {
    const blocked = new Set(["subagent"]);
    const next = (typeof pi.getActiveTools === "function" ? pi.getActiveTools() : TASK_NORMAL_TOOLS)
        .filter((tool) => !blocked.has(tool));
    if (!next.includes("task_complete")) next.push("task_complete");
    pi.setActiveTools?.(next);
}
```

**为什么用 active set/snapshot 不用 `getAllTools()`**:`getAllTools()` 返回完整注册表,会打开从未在 main session 启用过的注册工具。这里只从 task 进入前的 active snapshot 或当前 active set 里减 subagent,不扩大到全注册表。

### 改动 2:删 `TASK_EXECUTING_TOOLS` 常量(`extensions/task/task.ts`,原 line 39)

彻底删除,避免误用。所有引用点改用 `applyExecuteTools(pi)`。

### 改动 3:`startTaskExecute` 进 execute 前先恢复全集(`extensions/task/task.ts:545-551`)

```typescript
restoreToolsSnapshot ??= typeof pi.getActiveTools === "function" ? pi.getActiveTools() : TASK_NORMAL_TOOLS;
// execute 阶段放开所有环境工具(含 chrome_cdp/mcp),只排除 subagent。
// planning 阶段曾把工具窄化成只读集,先恢复进入 task 前的全集再减 subagent。
if (restoreToolsSnapshot) pi.setActiveTools?.(restoreToolsSnapshot);
applyExecuteTools(pi);
```

**⚠️ 这是本次最关键的改动点,请 reviewer 重点审查。**

**坑的说明**:进入 execute 阶段前,planning 阶段已经把工具集窄化成 `TASK_PLANNING_TOOLS`(只读集)。如果直接调 `applyExecuteTools`,`pi.getActiveTools()` 返回的是 planning 窄集,环境工具还是丢。所以必须**先恢复 `restoreToolsSnapshot`**(进入 task 前存的 main 全集),再 `applyExecuteTools`。

`restoreToolsSnapshot` 是首次 `enableTask` 时存的"进入 task 前的 main 全集",用 `??=` 保证只存一次,后续 review/save/exit 仍用它恢复。边界:如果 planning 期间其他扩展独立修改 active tools,task 扩展没有可靠状态源去区分"被 planning 临时隐藏"和"被用户禁用",因此不在这里猜测外部扩展状态。

### 改动 4:session restore 同步(`extensions/task/task.ts:724`)

```typescript
if (state.phase === "executing") applyExecuteTools(pi);
```

resume 到 executing 阶段时,`restoreToolsSnapshot` 已在 line 722 存了当前 active 集(即 main 启动全集),`applyExecuteTools` 从它减 subagent 加 task_complete。语义与正常进入 execute 一致。

### 改动 5:subagent 硬 block(`extensions/task/task.ts:768-775`,tool_call handler 内)

```typescript
if (state.phase === "executing") {
    // spec 4.2 硬约束:task-creator 禁止派 subagent(必须亲手做)。
    if (event.toolName === "subagent") {
        return {
            block: true,
            reason: "Task executing 阶段禁止调用 subagent(task-creator 必须亲手做)。",
        };
    }
    // ... 原有 processLog 记录逻辑
}
```

**为什么需要双保险**:放开工具集后,subagent 可能仍在 active 集里(取决于用户 main session 配置)。原来 subagent 禁止靠"工具集隐式排除"(白名单里没它),放开后这条防线失效。spec 4.2 节明确要求"task-creator 禁止派 subagent",必须用 `tool_call` 显式 block 补上,比 prompt 口头要求(`task.ts:551` "- 不要调用 subagent 工具")可靠。写法仿 planning 的 bash block(`task.ts:786-792`)。

### 改动 6:测试(`tests/task-extension.test.ts`)

- `makePi` 加 `initialActiveTools` 参数,让新测试能注入含 chrome_cdp 的初始集
- 改 3 处 execute 工具集断言:`["read","write","edit","bash","task_complete"]` → `["read","bash","edit","write","task_complete"]`(按 getActiveTools 原序 + 末尾追加 task_complete)
- **新增测试** `/task execute keeps environment tools, logs them, and blocks subagent via tool_call`:验证 execute 保留 chrome_cdp/MCP 风格环境工具、记录环境工具调用、并 block subagent
- **新增测试** `/task session restore keeps environment tools during executing`:验证 resume 到 executing 时仍保留环境工具并排除 subagent

### 改动 7:文档

- `docs/design/task-extension-spec.md` 更新 task-creator/executing 工具集说明,并在末尾加"execute 工具集修正(2026-06-23)"注记
- `docs/design/task-extension-followup-4.md` 末尾追加修复记录

---

## 四、请 reviewer 重点审查的点

1. **改动 3 的快照恢复逻辑**(`task.ts:545-551`):先 `setActiveTools(restoreToolsSnapshot)` 恢复全集,再 `applyExecuteTools` 减 subagent。这个顺序对吗?有没有边界情况导致 restoreToolsSnapshot 为空或过时?

2. **改动 5 的双保险必要**性:`tool_call` block subagent 是否冗余?(我的判断:不冗余,因为放开工具集后 subagent 可能仍在 active 集;但 reviewer 可能有不同看法)

3. **planning 阶段当时没动**:`TASK_PLANNING_TOOLS`(只读集)+ bash 命令白名单在本轮保持不变。2026-06-24 已部分调整为探索性 bash(C-3),write/edit 仍禁。

4. **worker 路径没动**:`agents/worker.md`(复用阶段 spawn 的子进程)走独立的 `--tools` CLI flag 机制,不经过 main session 的 setActiveTools。本次不改。确认范围合理。

---

## 五、未做的事(显式声明,避免范围蔓延)

- **planning 已部分调整**:planning 放开探索性 bash(C-3,详见 spec 注记),reviewing 仍只读
- **没改 `agents/worker.md`**(路径独立,已无 tools 字段)
- **没改 `restoreToolsSnapshot` 机制**(planning/reviewing 仍需要)
- **没碰 Judge 代码**、smoke-tui、8 个旧 untracked docs
- **没 commit/push**(改动都在工作区,等 review 通过再定)
- **没用 `getAllTools()`**(会把别的 extension 关掉的工具重开)

---

## 六、验证结果

| 验证项 | 命令 | 结果 |
|---|---|---|
| 单元测试 | `npm test` | ✅ 原 review 422/422 pass; 最新回归 424/424 pass |
| 新增测试 | `node --test tests/task-extension.test.ts` | ✅ 含新测试全过 |
| 无残留引用 | `grep TASK_EXECUTING_TOOLS extensions/task/task.ts` | ✅ 空(常量已删,引用全换) |
| planning 回归 | planning/reviewing 工具集断言 | ✅ 仍 pass |

### smoke:task 的说明(非本次回归)

`npm run smoke:task` 本次 fail,但**经对照实验确认是既有问题,非本次改动引入**:

- 用 `git stash` 回退到本次改动前的代码,跑 smoke:**同样 fail**,完全相同的现象
- 根因:smoke 脚本的 worker spawn 存在 cwd 漂移,worker 偶尔读到仓库根的 package.json(name=`ugk-agent`)而非 smoke workspace 的(name=`smoke-pkg`),verify 失败
- 这是 smoke 脚本/worker spawn 的独立 issue,跟本次工具集改动无关,留给后续处理

---

## 七、核心 diff 摘要

> 下面只保留关键改动摘录,准确完整内容以当前 `git diff` 为准。

### `extensions/task/task.ts`(核心改动)

```diff
@@ -36,7 +36,6 @@
 const TASK_PLAN_CONTEXT_TYPE = "task-plan-context";
 const TASK_REVIEW_CONTEXT_TYPE = "task-review-context";
 const TASK_PLANNING_TOOLS = ["read", "bash", "grep", "find", "ls", "questionnaire"];
-const TASK_EXECUTING_TOOLS = ["read", "write", "edit", "bash", "task_complete"];
 const TASK_NORMAL_TOOLS = ["read", "bash", "edit", "write", "subagent"];

@@ -79,6 +78,17 @@
  return phase === "planning" || phase === "executing" || phase === "reviewing";
 }

+// execute 阶段的 task-creator 继承 main session 全部工具(含 chrome_cdp/mcp 等环境工具),
+// 只排除 subagent(spec 4.2:task-creator 必须亲手做),并补 task_complete 信号工具。
+// 用 active snapshot/current active set,不用 getAllTools 全量注册表,避免打开从未启用的注册工具。
+function applyExecuteTools(pi: ExtensionAPI): void {
+	const blocked = new Set(["subagent"]);
+	const next = (typeof pi.getActiveTools === "function" ? pi.getActiveTools() : TASK_NORMAL_TOOLS)
+		.filter((tool) => !blocked.has(tool));
+	if (!next.includes("task_complete")) next.push("task_complete");
+	pi.setActiveTools?.(next);
+}

@@ -534,7 +545,10 @@
    state = startExecuting(state, executeRunDir);
    restoreToolsSnapshot ??= typeof pi.getActiveTools === "function" ? pi.getActiveTools() : TASK_NORMAL_TOOLS;
-    pi.setActiveTools?.(TASK_EXECUTING_TOOLS);
+    // execute 阶段放开所有环境工具(含 chrome_cdp/mcp),只排除 subagent。
+    // planning 阶段曾把工具窄化成只读集,先恢复进入 task 前的全集再减 subagent。
+    if (restoreToolsSnapshot) pi.setActiveTools?.(restoreToolsSnapshot);
+    applyExecuteTools(pi);
    persistState();

@@ -707,7 +721,7 @@
        if (state.phase === "planning") pi.setActiveTools?.(TASK_PLANNING_TOOLS);
-        if (state.phase === "executing") pi.setActiveTools?.(TASK_EXECUTING_TOOLS);
+        if (state.phase === "executing") applyExecuteTools(pi);
        if (state.phase === "reviewing") pi.setActiveTools?.(TASK_PLANNING_TOOLS);

@@ -751,6 +765,15 @@
    if (state.phase === "executing") {
+			// spec 4.2 硬约束:task-creator 禁止派 subagent(必须亲手做)。
+			// 工具集已放开环境工具,subagent 不再靠 setActiveTools 隐式排除,
+			// 这里显式 block 作为双保险(仿 planning 的 bash block)。
+			if (event.toolName === "subagent") {
+				return {
+					block: true,
+					reason: "Task executing 阶段禁止调用 subagent(task-creator 必须亲手做)。",
+				};
+			}
			state = recordExecuteProcessEntry(state, {
				kind: "tool_call",
				toolName: event.toolName,
				argsSummary: summarizeToolArgs(event.input),
				timestamp: new Date().toISOString(),
			});
			for (const artifact of extractArtifactsFromToolInput(event.toolName, event.input)) {
				state = recordExecuteProcessEntry(state, {
					kind: "artifact",
					artifactPath: artifact.path,
					timestamp: new Date().toISOString(),
				});
			}
			persistState();
```

### `tests/task-extension.test.ts`

```diff
@@ -29,13 +29,13 @@
-function makePi() {
+function makePi(initialActiveTools = ["read", "bash", "edit", "write", "subagent"]) {
  ...
-	let currentActiveTools = ["read", "bash", "edit", "write", "subagent"];
+	let currentActiveTools = [...initialActiveTools];

@@ -258,7 +258,7 @@
-	assert.deepEqual(activeTools.at(-1), ["read", "write", "edit", "bash", "task_complete"]);
+	assert.deepEqual(activeTools.at(-1), ["read", "bash", "edit", "write", "task_complete"]);

@@ -280,7 +280,7 @@
-	assert.deepEqual(activeTools.at(-1), ["read", "write", "edit", "bash", "task_complete"]);
+	assert.deepEqual(activeTools.at(-1), ["read", "bash", "edit", "write", "task_complete"]);

@@ -310,6 +310,33 @@
+test("/task execute keeps environment tools, logs them, and blocks subagent via tool_call", async () => {
+	const { pi, commands, handlers, activeTools, entries } = makePi(["read", "bash", "edit", "write", "subagent", "chrome_cdp", "alpha__echo"]);
+	const { ctx } = makeCtx();
+	registerTask(pi as any);
+
+	await commands.get("task").handler("new", ctx);
+	await handlers.get("tool_call")![0]({ toolName: "questionnaire" }, ctx);
+	await handlers.get("agent_end")![0]({
+		messages: [{
+			role: "assistant",
+			content: [{ type: "text", text: `\`\`\`json\n${JSON.stringify(spec)}\n\`\`\`` }],
+		}],
+	}, ctx);
+	await commands.get("task").handler("execute", ctx);
+
+	assert.deepEqual(activeTools.at(-1), ["read", "bash", "edit", "write", "chrome_cdp", "alpha__echo", "task_complete"]);
+	await handlers.get("tool_call")![0]({ toolName: "alpha__echo", input: { query: "ping" } }, ctx);
+	assert.match((entries.at(-1)?.data as any).executeProcessLog.at(-1).toolName, /alpha__echo/);
+
+	const blocked = await handlers.get("tool_call")![0]({ toolName: "subagent", input: {} }, ctx);
+	assert.deepEqual(blocked, {
+		block: true,
+		reason: "Task executing 阶段禁止调用 subagent(task-creator 必须亲手做)。",
+	});
+});

@@ -330,7 +357,7 @@
-		assert.deepEqual(activeTools.at(-1), ["read", "write", "edit", "bash", "task_complete"]);
+		assert.deepEqual(activeTools.at(-1), ["read", "bash", "edit", "write", "task_complete"]);
```

---

## 八、review 后的后续

- review 通过:用户决定何时 commit/push
- 如 review 有修改意见:在本工作区基础上改,无需重来
- 真实 TUI dogfood(B 站下载创造流程):review 通过后由用户本机实测,验证 chrome_cdp 在 execute 阶段可用
