# `/task` 完整 e2e smoke 计划

> **状态:已完成(2026-06-23)。** `npm run smoke:task` 已实现并跑通(场景 B:预置 taskbook + `/task run`),报告落 `.tmp/smoke-task/latest/`。场景 A(完整创造)未实现,留作后续扩展。实现以 `scripts/smoke-task.mjs` 代码为准。
>
> **原始用途**:给执行 agent 的交接文档,实现完整 e2e smoke。本文自包含。
>
> **更新时间**:2026-06-23

---

## 背景

### UGK `/task` 是什么

`/task` 是 UGK 的固定任务委托系统。完整流程:

```
创造:planning(对齐 Spec)→ executing(主 agent 亲手做)→ reviewing(产 skill+verify+contract)→ landed
复用:/task run <name> <自然语言>→ dispatcher agent 理解 input → worker spawn → verify 机器验收 → PASS/FAIL
```

用户交互:全程只敲 `/task` + 答 questionnaire + 按 Enter + 贴一句话。

### 已有 smoke 模板(必读,本次要复刻它的模式)

**`E:\AII\ugk-core\scripts\smoke-judge.mjs`** —— 这是最近的模板,263 行。核心结构:

1. **临时 workspace**(line 39-93):在 `.tmp/smoke-judge/<stamp>/workspace/` 建独立工作区,预置 package.json + taskbook
2. **RPC 模式 spawn**(line 151-160):`node bin/ugk.js --mode rpc --no-session --model deepseek/deepseek-v4-pro`
3. **JSON 事件流**(line 167-188):stdout 按行 parse 成事件,存 `rpc-events.jsonl`
4. **`extension_ui_request` 自动响应**(line 124-135):模拟用户在 UI 上点选项/确认/取消
5. **DeepSeek key fallback**(line 95-114):Windows 上从 `[Environment]::GetEnvironmentVariable` 读 user scope 的 key
6. **报告**(line 246-255):落 `.tmp/smoke-judge/latest/report.md`,exit code 反映 pass/fail

**关键机制**:`respondToUi(child, request)` 函数——RPC 模式下,extension 调 `ctx.ui.select/confirm/notify` 时,pi runtime 会通过 stdout 发 `extension_ui_request` 消息,smoke 脚本要回写 `extension_ui_response` 到 stdin 来模拟用户操作。

### 必读文档

- `E:\AII\ugk-core\docs\design\task-extension-spec.md` — `/task` 需求规格
- `E:\AII\ugk-core\docs\design\task-extension-followup-4.md` — 交互层重构(Enter gate、dispatcher、菜单化)
- `E:\AII\ugk-core\scripts\smoke-judge.mjs` — **主要参考模板**
- `E:\AII\ugk-core\scripts\smoke-tui.mjs` — 另一个 smoke 参考(有 parseDriver/chooseDriver 等辅助函数)

### 现有 `/task` 代码

```
extensions/task/
  task.ts            主入口,837 行
  task-state.ts      状态机
  task-book.ts       taskbook 落盘
  task-prompts.ts    prompts
  task-verify.ts     verify runner
  task-worker.ts     worker spawn
  task-checker.ts    checker spawn
  task-dispatcher.ts dispatcher(理解 input)
```

### 必读约束

- 始终中文(注释/commit),代码标识符用英文
- 遵守 `E:\AII\ugk-core\AGENTS.md`(bash 走 Git Bash,Linux 语法)
- **不要碰 Judge 代码** / smoke-tui / 旧 untracked docs
- **不要 commit、不要 stage**
- 改完跑 `npm test` 确认 406/406 基线

---

## 核心目标

实现 `npm run smoke:task`,跑 `/task` 完整 e2e,**模拟一个完全不懂 `/task` 的用户**,只发最简单的命令(`/task`、答 questionnaire、按 Enter、`/task run <一句话>`),验证整个创造+复用闭环。

**关键判断标准**:smoke 能跑通以下场景之一(或多个),报告 pass:

- **场景 A(完整创造)**:从 `/task` 开始,走完 planning → executing → reviewing → landed,产出可用 taskbook
- **场景 B(复用预置 taskbook)**:workspace 里预置一个 taskbook,只跑 `/task run <name> <一句话>`,验证 worker → verify → PASS
- **场景 C(Enter gate + 菜单交互)**:验证 UI 响应,不验证 LLM

**两个场景都建议做**:
- 场景 A 验证创造流程(主 agent 用 LLM 做 Spec 对齐 + execute)
- 场景 B 验证复用流程(dispatcher + worker + verify),成本低、稳定

---

## 必须先解决的工程障碍(关键!)

### 障碍 1:RPC 模式下 Enter gate 不触发(必须改代码)

**问题**:`task.ts:786-807` 的 input handler 要求 `event.source !== "interactive"` 才跳过:

```typescript
pi.on("input", async (event, ctx) => {
    if (!state.pendingTransition || event.source !== "interactive") return;
    ...
});
```

RPC 模式下用户消息的 source 是 `"rpc"`(不是 `"interactive"`),所以 **Enter gate 永远不会推进**。这会让 smoke 卡死在"按 Enter 进 review"那一步。

**三种解法,任选其一**:

**解法 A(改 task.ts)**:把 `"interactive"` 放宽为 `"interactive" 或 "rpc"`:
```typescript
if (!state.pendingTransition || (event.source !== "interactive" && event.source !== "rpc")) return;
```
风险:RPC 模式下的其他消息也会触发 Enter gate,可能误推进。

**解法 B(RPC 模式自动推进)**:smoke 脚本检测到 pendingTransition 时,主动发一个 source 标记的空消息。但 RPC message 的 source 由 runtime 决定,smoke 控制不了。

**解法 C(改 task.ts,只在 pendingTransition 时放宽)**:
```typescript
pi.on("input", async (event, ctx) => {
    if (!state.pendingTransition) return;
    // pendingTransition 存在时,允许 rpc source 也能推进(RPC smoke 场景)
    if (event.source !== "interactive" && event.source !== "rpc") return;
    ...
});
```
**推荐解法 C**——只在有 pendingTransition 时放宽,不影响其他场景。改完加测试覆盖。

**验收**:smoke 跑到 Enter gate 时,smoke 脚本发空 prompt 能推进阶段。

### 障碍 2:questionnaire 在 RPC 模式怎么响应

**问题**:planning/review 阶段 agent 会调 questionnaire,questionnaire 内部用 `ctx.ui.select` + `ctx.ui.editor`。RPC 模式下这些会变成 `extension_ui_request`。

**解法**:`respondToUi` 函数要识别 `select` 类型的 request 并自动选第一个选项(或 "Type another answer" → 回固定文本)。

参考 smoke-judge.mjs:124-135 的 `respondToUi`,但要扩展处理:
- `select` → 自动选第一个非 "Exit" 选项,或专门识别 questionnaire 题
- `input` → 自动回一个固定值(taskbook 名字、字段值等)
- `editor` → 自动回一段固定文本(执行摘要 fallback)
- `confirm` → 自动回 true(delete taskbook 等场景)

**注意**:questionnaire 的题(看 `extensions/judge/questionnaire.ts`)每次 select 都是一个 `extension_ui_request`,要按顺序响应。最后一题固定是 `extras`,选"没有了"或回空。

### 障碍 3:execute 阶段 agent 会调真实工具

**问题**:execute 阶段 main agent 会用 read/write/edit/bash/task_complete 真的去做任务。smoke 的 workspace 必须有可做的任务。

**解法**:选一个**纯本地、零外部依赖**的任务作为 smoke 任务。推荐:**"统计 workspace 里 package.json 的 name 字段,输出到 name.json"**——agent 能用 read + write 完成,verify 好写(文件存在 + JSON 合法 + name 字段匹配)。

**不推荐**:任何依赖网络、外部工具(yt-dlp/ffprobe)、Chrome CDP 的任务。

---

## 实现步骤

### 步骤 1:解决障碍 1(改 task.ts,放宽 Enter gate source)

按"解法 C"改 `extensions/task/task.ts:786-787`:
```typescript
pi.on("input", async (event, ctx) => {
    if (!state.pendingTransition) return;
    if (event.source !== "interactive" && event.source !== "rpc") return;
    ...
});
```

**加测试**:`tests/task-extension.test.ts` 加一个 case,模拟 RPC source 的空消息能推进 pendingTransition。

**验收**:`npm test` 仍 406/407 pass(允许 +1)。

### 步骤 2:创建 `scripts/smoke-task.mjs`

**结构**(复刻 smoke-judge.mjs,但适配 `/task`):

```javascript
#!/usr/bin/env node
// 复刻 smoke-judge.mjs 结构:
// 1. 临时 workspace(.tmp/smoke-task/<stamp>/workspace/)
// 2. RPC 模式 spawn
// 3. JSON 事件流
// 4. respondToUi 自动响应 questionnaire/input/select/confirm
// 5. 报告落 .tmp/smoke-task/latest/report.md

const root = path.resolve(...);
const taskbookName = "smoke_name_count";  // smoke 任务的 taskbook 名

// === 导出的纯函数(可测试,跟 smoke-judge 一样) ===
export function hasTaskPass(events) { /* 检测 run PASS 的 notify */ }
export function hasTaskLanded(events) { /* 检测 landed 的 notify */ }
export function buildTaskReport(run) { /* 构造 report.md 内容 */ }

// === 内部函数 ===
async function prepareDirs() { /* .tmp/smoke-task/<stamp>/ + latest/ */ }
async function prepareWorkspace(workspace) {
    // 建一个简单的 workspace:package.json(name: "smoke-pkg", version: "0.0.1")
    // 不预置 taskbook(场景 A 要从零创造)
    // 或预置一个 taskbook(场景 B,见步骤 4)
}

function respondToUi(child, request) {
    // 扩展 smoke-judge 的版本:
    // - notify/setStatus/setWidget/setTitle:忽略
    // - select:按 title 决定
    //     - "Task" 菜单:选 "新建任务"(场景 A)或对应选项
    //     - questionnaire 题:选第一个非"Exit"选项
    //     - taskbook 选择:选 smoke 预置的那个
    // - input:回固定值(taskbook 名字、字段值)
    // - editor:回固定文本(执行摘要 fallback,虽然改动 1 已自动生成,但兜底)
    // - confirm:回 true
}

async function runTaskSmoke(runDir, workspace) {
    // spawn RPC,事件流,DeepSeek env fallback
    // 场景 A 流程:
    //   1. 发 /task
    //   2. respondToUi 选"新建任务"
    //   3. agent 进 planning,调 questionnaire 对齐 Spec(respondToUi 自动答)
    //   4. Spec 对齐 → pendingTransition="execute" → 发空消息(模拟 Enter)
    //   5. agent 进 execute,做任务,调 task_complete
    //   6. pendingTransition="review" → 发空消息
    //   7. agent 进 review,调 questionnaire(respondToUi 自动答)
    //   8. reviewResult 解析 → pendingTransition="save" → 发空消息
    //   9. save + verify 自证 → landed
    //   10. 发 /task run smoke_name_count <某句话>
    //   11. dispatcher + worker + verify → PASS
    // 报告:hasTaskLanded + hasTaskPass
}

async function main() {
    // 跟 smoke-judge.mjs:246-256 同构
}
```

**验收**:
- 文件创建,导出 hasTaskPass/hasTaskLanded/buildTaskReport
- 单元测试覆盖这 3 个纯函数(参考 smoke-judge 的测试方式)

### 步骤 3:实现 `respondToUi` 的 questionnaire 自动响应

这是 smoke 最难的部分。需要识别不同 `extension_ui_request` 并给合理响应:

```javascript
function respondToUi(child, request) {
    const { method, id, title, options } = request;
    
    // 静默 UI 调用,忽略
    if (["notify", "setStatus", "setWidget", "setTitle", "set_editor_text"].includes(method)) return;
    
    // select 选择
    if (method === "select") {
        // 1. 主菜单(/task 弹的):按当前阶段选
        if (title === "Task") {
            // 根据 state 选,但 smoke 不知道 state。
            // 启发式:优先选"新建任务",其次"运行 taskbook"
            const choice = options.find(o => o.includes("新建任务")) 
                || options.find(o => o.includes("运行")) 
                || options[0];
            child.stdin.write(response(id, { value: choice }));
            return;
        }
        // 2. questionnaire 题:选第一个非 Exit 选项
        //    最后一题 extras 要选"没有了"(option[0] 通常是)
        const choice = options.find(o => !o.includes("Exit")) || options[0];
        child.stdin.write(response(id, { value: choice }));
        return;
    }
    
    // input 单行输入
    if (method === "input") {
        // 按 title 或 placeholder 决定回什么
        // - taskbook 名字:回 "smoke_name_count"
        // - task input 字段:回一个固定值
        // - TASK_OUTPUT_DIR:回 workspace 的 output 路径
        let value = "smoke-value";
        if (/名字|name/i.test(title)) value = "smoke_name_count";
        child.stdin.write(response(id, { value }));
        return;
    }
    
    // editor 多行
    if (method === "editor") {
        // 改动 1 已让 review summary 自动生成,但 editor 兜底
        child.stdin.write(response(id, { value: "smoke execution summary" }));
        return;
    }
    
    // confirm
    if (method === "confirm") {
        child.stdin.write(response(id, { confirmed: true }));
        return;
    }
    
    // 未知 request:取消
    child.stdin.write(response(id, { cancelled: true }));
}

function response(id, payload) {
    return `${JSON.stringify({ type: "extension_ui_response", id, ...payload })}\n`;
}
```

**注意**:
- 实际的 request payload 结构要看 pi runtime 的真实输出。**先跑一次 RPC 看 stdout 的真实消息结构**,再调 respondToUi。
- 如果某个 request 类型没识别对,smoke 会卡。**建议先做诊断模式**(只 log 不响应),看清楚结构再做响应。

**验收**:respondToUi 能处理 select/input/editor/confirm 四类 request。

### 步骤 4:场景 A 的 workspace 准备

**任务**:统计 workspace 里 package.json 的 name 字段,输出到 name.json。

`prepareWorkspace`:
```javascript
async function prepareWorkspace(workspace) {
    // 1. workspace 根的 package.json
    await writeJson(path.join(workspace, "package.json"), {
        name: "smoke-pkg",
        version: "0.0.1"
    });
    
    // 2. 不预置 taskbook(场景 A 从零创造)
    // 全局 taskbook 目录(~/.pi/agent/tasks/)的清理见步骤 6
}
```

**注意**:agent 在 planning 阶段会问用户想做什么任务。smoke 脚本发 `/task` 选"新建任务"后,agent 会主动问。smoke 脚本要发一个明确的任务描述作为第一句话,比如:

```
统计 workspace 里 package.json 的 name 字段,把结果以 {"name": "<value>"} 格式写入 name.json
```

agent 收到后开始 questionnaire 对齐。respondToUi 自动答。

**验收**:workspace 就绪,任务描述清晰。

### 步骤 5:实现场景 B(复用预置 taskbook)

如果场景 A 太慢/太贵(完整创造一次要好几分钟),建议**同时做场景 B**作为快速验证:

`prepareWorkspaceForReuse`:
```javascript
async function prepareWorkspaceForReuse(workspace) {
    // 1. workspace 根的 package.json(任务要读的文件)
    await writeJson(path.join(workspace, "package.json"), {
        name: "smoke-pkg",
        version: "0.0.1"
    });
    
    // 2. 预置一个 taskbook 到 workspace/.tasks/<name>/
    const taskbookDir = path.join(workspace, ".tasks", taskbookName);
    await fs.mkdir(taskbookDir, { recursive: true });
    
    // taskbook.json
    await writeJson(path.join(taskbookDir, "taskbook.json"), {
        name: taskbookName,
        description: "Smoke: read package.json name into name.json",
        scope: "project",
        createdAt: now,
        updatedAt: now,
        tags: ["smoke"],
        runs: []
    });
    
    // spec.json
    await writeJson(path.join(taskbookDir, "spec.json"), {
        goal: "把 workspace package.json 的 name 字段输出到 name.json",
        hardConstraints: ["只用 Node stdlib"],
        acceptance: ["name.json 存在", "name.json 是合法 JSON 含 name 字段"],
        forbidden: [],
        context: ""
    });
    
    // skill.md(给 worker 读)
    await fs.writeFile(path.join(taskbookDir, "skill.md"),
        "# 读 package.json name\n\n## 步骤\n1. read workspace 的 package.json\n2. 提取 name 字段\n3. 写 {name: <value>} 到 <outputDir>/name.json\n",
        "utf8");
    
    // verify.mjs(给机器验)
    await fs.writeFile(path.join(taskbookDir, "verify.mjs"),
        `import { readFile, stat } from "node:fs/promises";
const failures = [];
function check(name, fn) { try { fn(); } catch(e) { failures.push({assertion:name, expected:"...", actual:e.message}); } }
const outputDir = process.env.TASK_OUTPUT_DIR;
const st = await stat(outputDir + "/name.json").catch(()=>null);
check("name.json 存在", () => { if (!st) throw new Error("missing"); });
const content = await readFile(outputDir + "/name.json", "utf8");
const parsed = JSON.parse(content);
check("name 字段存在", () => { if (typeof parsed.name !== "string") throw new Error("no name"); });
check("name 等于 smoke-pkg", () => { if (parsed.name !== "smoke-pkg") throw new Error("got " + parsed.name); });
if (failures.length > 0) { console.log(JSON.stringify(failures, null, 2)); process.exit(1); }`,
        "utf8");
    
    // contract.json
    await writeJson(path.join(taskbookDir, "contract.json"), {
        outputDir: "<runtime>",
        artifacts: [{ name: "name.json", type: "file", required: true }],
        runtimeInput: []
    });
}
```

场景 B 的流程极简:
```
1. spawn RPC
2. 发 /task run smoke_name_count
3. dispatcher(无 input 字段,直接 {})
4. worker spawn,读 package.json 写 name.json
5. verify PASS
6. 报告 hasTaskPass
```

**不需要 questionnaire/Enter gate**,跑得快、稳定。**强烈建议优先实现场景 B**,场景 A 作为后续扩展。

**验收**:场景 B 能稳定跑通,hasTaskPass 返回 true。

### 步骤 6:全局 taskbook 清理(避免污染)

**问题**:`/task save` 默认存到 `~/.pi/agent/tasks/<name>/`(全局)。smoke 跑完会留下垃圾 taskbook。

**解法**:
- 场景 A 优先用 `--project` 存到 workspace(但 v2 重构后 save 不接受 flag,看实际实现)
- 或 smoke 跑完后 `rm -rf ~/.pi/agent/tasks/<smoke-name>/`
- 或 smokeEnv 设置一个隔离的 PI_CODING_AGENT_DIR,让全局 taskbook 路径指向临时目录

**推荐**:smokeEnv 里设 `PI_CODING_AGENT_DIR`(看 smoke-judge.mjs:87 已经在用),让 `~/.pi` 路径指向 `.tmp/smoke-task/<stamp>/pi-home/`,完全隔离。

**验收**:smoke 跑完不污染 `~/.pi/agent/tasks/`。

### 步骤 7:加 `smoke:task` 脚本到 package.json

```json
"smoke:task": "node scripts/smoke-task.mjs"
```

**验收**:`npm run smoke:task` 能跑。

### 步骤 8:测试

- **纯函数测试**:`tests/smoke-task.test.ts`,测 hasTaskPass/hasTaskLanded/buildTaskReport(参考 `tests/smoke-tui.test.ts` 的结构)
- **手动 e2e 验证**:`npm run smoke:task` 实际跑一遍,确认 report 是 pass

---

## 报告格式

`report.md` 应该包含(参考 smoke-judge 的 buildJudgeReport):

```markdown
# UGK Task Smoke Report

Exit code: 0
Timed out: no
Stderr: empty
Phase reached: landed/review/execute/planning(场景 A)
Taskbook landed: yes/no
Task PASS: detected/missing(场景 B 的 run)
Duration: 45s

Result: pass/fail

## 场景 B 验证(如果跑了)
- taskbook load: ok
- dispatcher: ok
- worker: ok(exit 0)
- verify: 3 条断言全过
- PASS notify: detected
```

---

## 最终交付清单

**新增**:
- [ ] `scripts/smoke-task.mjs` — 主 smoke 脚本(场景 B 优先,场景 A 可选)
- [ ] `tests/smoke-task.test.ts` — 纯函数测试

**修改**:
- [ ] `extensions/task/task.ts:786-787` — 放宽 Enter gate 的 source 判断(障碍 1 解法 C)
- [ ] `package.json` — 加 `"smoke:task": "node scripts/smoke-task.mjs"`
- [ ] 可能 `tests/task-extension.test.ts` — 加 Enter gate RPC source 的测试

**全局验证**:
- [ ] `npm test` 全过(基线 406 + 新增)
- [ ] `npm run smoke:task` 实际跑通,report 是 pass
- [ ] `git diff --check` 通过

**不要做**:
- 不要碰 Judge / smoke-tui / 旧 untracked docs
- 不要 commit / stage
- 不要"顺手优化"`/task` 的其他部分

---

## 实现顺序建议

1. **障碍 1 先解决**(改 task.ts + 测试)——否则 smoke 根本跑不动
2. **场景 B**(预置 taskbook + run)——最快见效,验证 RPC + dispatcher + worker + verify 全链路
3. **`respondToUi` 完善**——支持 questionnaire/input/editor
4. **场景 A**(完整创造)——可选,如果时间够
5. **package.json 接入 + 测试**

---

## 完成后的交接总结模板

```
/task smoke 实现完成。

障碍 1(Enter gate source):
- 改法: 解法 A/B/C
- 测试: <说明>

场景 B(复用预置 taskbook):
- 实现: <说明>
- 手动跑通: yes/no
- 报告: <贴 report.md 内容>

场景 A(完整创造,如果做了):
- 实现: <说明>
- 手动跑通: yes/no

respondToUi:
- 支持的 request 类型: select/input/editor/confirm
- questionnaire 自动响应策略: <说明>

清理:
- PI_CODING_AGENT_DIR 隔离: <说明>

验证:
- npm test: <总测试数> pass
- npm run smoke:task: pass/fail

已知遗留:
- <列出没做的及原因>
```

---

## 给执行 agent 的话

这次的核心是**复刻 smoke-judge.mjs 的模式**,适配 `/task` 的流程。最大的障碍是 Enter gate 的 source 判断(障碍 1),必须先改代码再写 smoke。

**优先做场景 B**(预置 taskbook + run),它不依赖完整创造流程,跑得快、稳定,能验证 dispatcher + worker + verify 全链路。场景 A(完整创造)复杂得多(要模拟 questionnaire 全程),如果时间紧可以先不做。

如果某个障碍无法解决(比如 RPC 模式下 questionnaire 实在响应不了),**在交接总结里说明,先做能做的**。smoke 的价值在于"能跑通的部分都被验证了",而不是"必须 100% 跑通"。

完成后按交接总结模板返回,review agent 会验收并实跑 `npm run smoke:task`。

---

## 实际完成结果(2026-06-23)

`npm run smoke:task` 已实现并跑通。

| 项 | 结果 |
|---|---|
| 障碍 1(Enter gate RPC source) | ✅ 解法 C 落地:`pendingTransition` 存在时允许 `interactive` 和 `rpc` |
| 场景 B(复用预置 taskbook) | ✅ 实现并真跑通(report=pass,worker spawn + verify 全链路) |
| 场景 A(完整创造) | ⏸️ 未做,留作后续扩展 |
| respondToUi | ✅ 处理 select/input/editor/confirm |
| PI_CODING_AGENT_DIR 隔离 | ✅ 每次跑用 `.tmp/smoke-task/<stamp>/agent` |

**首次跑通复盘发现的 5 个缺陷**(详见 `task-extension-followup-6.md`):dispatcher fallback、widgetLines 读取、跨 extension 污染诊断、contract 一致性、场景 A 遗留。5 个缺陷在 followup-6 修复后,smoke 事件流确认 dispatcher 真跑(0 次 input fallback)。
