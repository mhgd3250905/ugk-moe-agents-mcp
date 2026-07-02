# `/task` v1 Dogfood 发现的问题修复清单

> **状态:已完成(2026-06-22)。** 保留作历史材料。6 个问题全部修复(详见本文末尾"实际修复结果")或合理跳过,`npm test` 401/401 pass。当前实现以 `extensions/task/` 代码为准。
>
> **原始用途**:给执行 agent 的交接文档,修复 `/task` v1 在 dogfood 中发现的 6 个问题。
>
> **背景**:本文是干净 context 写的,包含完整 UGK `/task` 背景知识。
>
> **更新时间**:2026-06-22

---

## 背景知识(必读)

### UGK `/task` 是什么

`/task` 是 UGK 的固定任务委托系统:把一次性调教好的成功经验,沉淀成 `skill + verify + contract` 三件套(称为 taskbook),之后任何 session 都能一键复用。

四阶段流程:
```
planning(对齐 Spec) → executing(主 agent 亲手做) → reviewing(产 skill+verify+contract) → landed
```

复用阶段:
```
/task run <name> <input>
  → spawn worker 子进程,注入 skill + contract
  → worker 按 skill 产出
  → 跑 verify.mjs(机器验收,零 LLM)
  → PASS 记录一条 pass run,FAIL 派 checker 归因后 retry
```

### 必读文档(必读)

**修改前必读这两份**:

1. **`E:\AII\ugk-core\docs\design\task-extension-spec.md`** — 需求规格,定义了 `/task` 的全部设计契约、schema、流程。**所有修改不能违反这份文档的硬约束**(比如 worker 不能看 verify、execute 阶段不能派 subagent、verify 必须机器可判定等)。
2. **`E:\AII\ugk-core\docs\design\task-extension-action-plan.md`** — 行动计划,包含现有代码的文件结构、复用点、实现细节。

### 现有代码结构(必读)

```
extensions/task/
  task.ts            主入口,注册 /task 命令、事件 handler、状态机
  task-state.ts      状态机纯函数(转换器、C-2 闸)
  task-book.ts       taskbook 落盘/加载/scope 合并
  task-prompts.ts    TASK_ALIGN_PROMPT、TASK_REVIEW_PROMPT
  task-verify.ts     verify.mjs runner(spawn + 解析失败 JSON)
  task-worker.ts     worker spawn 派遣
  task-checker.ts    checker spawn 派遣

agents/
  worker.md          worker agent 定义(tools: read, write, edit, bash, grep, find, ls)
  checker.md         checker agent 定义(tools: read, grep, find, ls, bash)

tests/
  task-*.test.ts     6 个测试文件,397/397 pass 是基线
```

### 必读约束

- **始终中文**(注释/文档/commit),代码标识符用英文
- **遵守 `E:\AII\ugk-core\AGENTS.md`**:bash 工具走 Git Bash(`D:\Git\bin\bash.exe`),Linux 语法,Windows 路径用正斜杠
- **最小改动,Node stdlib 优先**,不新增依赖
- **不要碰 Judge 代码**(`extensions/judge/**`、`tests/judge-*.test.ts`)
- **不要碰 smoke-tui 文件**(`scripts/smoke-tui.mjs`、`tests/smoke-tui.test.ts`)
- **不要 `git add` 8 个未跟踪的旧 docs 文件**(在 git status 里是 `??` 的旧文档)
- **不要 commit、不要 stage**
- **每个修改完成后跑 `npm test`** 确认测试全过(基线 397/397,你新增测试后会增加,但不能减少)

---

## 问题清单(按严重度排序,逐个修)

---

### 🔴 问题 1:`/task` 命令行参数不支持带空格/花括号的 JSON input(严重)

#### 现象

用户跑:
```
/task save grapheme-count --input {"text":"Hello 世界 👨‍👩‍👧‍👦!"}
```

期望 input 被解析成 `{text: "Hello 世界 👨‍👩‍👧‍👦!"}`,实际被 `task.ts` 的 `split(/\s+/)` 切散成多个 token,`optionValue(tokens, "--input")` 只取下一个 token(即 `{"text":"Hello`),JSON.parse 失败,fall back 成字符串。

**更严重的衍生问题**:`/task run grapheme-count {"text":"..."}` 带花括号时,**命令可能根本没被 pi-tui 识别为 slash command**(用户报告"输入了没反应")。pi-tui 的输入解析对 `{` 有特殊处理。

#### 影响

用户不能传任何带空格的 input:
- 不能传 `"Hello world"`
- 不能传带空格的 URL(B 站标题)
- 不能传任何复杂 JSON

这让 `/task` 在真实场景几乎不可用(B 站下载、文本处理等都需要带空格 input)。

#### 根因

`extensions/task/task.ts:366`:
```typescript
const tokens = resolvedArgs.trim().split(/\s+/).filter(Boolean);
```

然后用 `optionValue(tokens, "--input")` 取下一个 token,只能拿单个 token。带空格的 JSON 在这一步被切碎。

#### 修复要求

**提供至少一种可靠的复杂 input 传递方式**。三个备选方案,你可以选其中一种或组合,在交接总结里说明选了哪种:

**方案 A:文件 input**
新增 `--input-file <path>` 参数:
```typescript
const inputPath = optionValue(tokens, "--input-file");
const runtimeInput = inputPath ? JSON.parse(await readFile(inputPath, "utf8")) : parseRuntimeInputOption(optionValue(tokens, "--input"));
```

**方案 B:Base64 input**
新增 `--input-json <base64>` 参数:
```typescript
const b64 = optionValue(tokens, "--input-json");
const runtimeInput = b64 ? JSON.parse(Buffer.from(b64, "base64").toString("utf8")) : ...;
```

**方案 C:智能默认(零参数)**
`/task save` 不传 `--output-dir` 和 `--input` 时,自动扫 execute 阶段的 runDir(在 `E:/AII/<cwd>/.tasks/runs/task-<name>-<timestamp>/output/` 下),用那里的产出做 verify 自证。`/task run` 不传 input 时,从 contract.runtimeInput 字段定义交互式询问(用 `ctx.ui.input` 单行询问每个字段)。

**推荐方案**:**C + A**。
- C 让常用场景零摩擦(save 时不用手填 outputDir,run 时不用填 input)
- A 处理需要特殊 input 的情况

**注意方案 C 的 save 自动扫 runDir**:execute 阶段没有把 runDir 路径存进 state(看 `task-state.ts`),所以 `/task save` 现在不知道 execute 产在哪。修复时**要在 TaskState 加一个字段 `executeRunDir?: string`,execute 阶段写入这个字段**(在 `task.ts` 的 `execute` action 或 `continue-review` action 里)。

#### 验收

- 写测试覆盖:`--input-file` / `--input-json` / 零参数智能默认三个路径
- 测试用例里必须有一个**带空格的 input**(`"Hello world"`)能正确传到 verify
- `npm test` 全过

---

### 🔴 问题 2:`/task run` 完成后用户看不到产出(严重,体验硬伤)

#### 现象

用户跑 `/task run grapheme-count xyz789`,看到:
```
taskbook "grapheme-count" PASS(尝试 1 次)
```

**仅此而已**。用户完全不知道:
- 实际产出文件在哪
- count 是多少(任务的核心结果)
- worker 干了什么
- verify 通过的具体证据是什么

#### 影响

这是**最严重的体验问题**。用户用 `/task` 是为了**得到结果**,不是为了看一个 PASS 标记。一个只输出 PASS 不输出结果的系统,对用户来说等于没用。

#### 修复要求

**`/task run` 完成时,notify 必须包含产出信息**。具体要求:

1. **PASS 时显示**:
   - 产出文件路径(每个 artifact 的绝对路径)
   - 产出的关键内容摘要(如果 artifact 是 JSON,显示其内容;如果是文件,显示文件大小)
   - verify 通过的断言数量
   - 示例格式:
     ```
     ✅ taskbook "grapheme-count" PASS(尝试 1 次, 0.8s)

     产出:
       E:/AII/TUI/.tasks/runs/task-grapheme-count-1719045600000/output/count.json (45 bytes)
       内容: {"count":6}

     verify: 6 条断言全过
     ```

2. **FAIL 时显示**:
   - 失败的断言(已有,在 verifyFailures 里)
   - worker 的执行摘要(worker 输出的最后一条 assistant message)
   - 示例格式:
     ```
     ❌ taskbook "grapheme-count" FAIL(尝试 3 次)

     失败断言:
       - count 等于 grapheme cluster 数: 预期 6, 实际 5

     worker 摘要:
       我按 skill 用 Intl.Segmenter 统计了 xyz789...
     ```

3. **数据来源**:
   - 产出路径:`handleTaskRun` 已经创建了 `outputDir`,直接用
   - 产出内容:读 `outputDir` 下 contract.artifacts 声明的文件
   - worker 摘要:`dispatchWorker` 返回的 `TaskWorkerResult.summary`(已有)
   - verify 通过数:`runVerify` 返回的 `VerifyResult.failures`(失败数 = 总断言数 - 已知?实际上我们不知道总断言数,只能显示"全过"或失败列表)

#### 实现提示

`task.ts:236-314` 的 `handleTaskRun` 里有这两个关键位置:

```typescript
// PASS 路径(task.ts:276-287)
if (lastVerifyResult.passed) {
  await appendRunToTaskbook(...);
  ctx.ui.notify(`taskbook "${name}" PASS(尝试 ${attempt + 1} 次)`, "info");  // ← 这里要扩充
  return;
}

// FAIL 路径(task.ts:305-313)
await appendRunToTaskbook(...);
ctx.ui.notify(`taskbook "${name}" FAIL`, "error");  // ← 这里要扩充
```

扩充逻辑大致:
```typescript
async function formatRunResult(
  loaded: LoadedTaskbook,
  outputDir: string,
  workerResult: TaskWorkerResult,
  verifyResult: VerifyResult,
  passed: boolean,
): Promise<string> {
  // 读 outputDir 下 contract.artifacts 声明的文件,格式化路径 + 内容摘要
  // 拼 worker summary
  // 拼 verify 结果
}
```

#### 验收

- 写测试覆盖 PASS 和 FAIL 两条路径的 notify 内容
- PASS notify 必须包含:产出文件路径、文件内容摘要、verify 通过提示
- FAIL notify 必须包含:失败断言、worker 摘要
- 测试用 mock worker/verify(参考 `tests/task-extension.test.ts:398-475` 的写法)

---

### 🟡 问题 3:`ctx.ui.editor()` 在 pi-tui 里崩溃(高,可能不是 /task 专属)

#### 现象

用户跑 `/task continue-review`(无 inline 摘要)或 `/task`(无参,弹菜单),UGK 崩溃退出:

```
pi exiting due to uncaughtException:
TypeError: this.autocompleteProvider.applyCompletion is not a function
    at CustomEditor.handleInput (.../pi-tui/dist/components/editor.js:554:62)
    at CustomEditor.handleInput (.../pi-coding-agent/dist/modes/interactive/components/custom-editor.js:67:15)
    ...
```

#### 影响

- `/task continue-review` 无 inline 摘要路径完全不可用
- 可能影响其他用 editor 的命令(`/judge change-spec` 等也可能踩)
- UGK 崩溃退出,用户损失未保存的 session 状态

#### 根因方向

`extensions/index.ts:94` 注册了 `suppressNaturalAtAutocomplete`:
```typescript
pi.on("session_start", async (_event, ctx) => {
    ctx.ui.addAutocompleteProvider?.(suppressNaturalAtAutocomplete);
});
```

`suppressNaturalAtAutocomplete`(`extensions/index.ts:44-55`)返回一个 provider,但**这个 provider 可能缺 `applyCompletion` 方法**,而 pi-tui 的 editor 组件期望这个方法存在。

#### 修复要求

**先诊断再修**。具体步骤:

1. **查 pi-tui 的 AutocompleteProvider 接口定义**:在 `node_modules/@earendil-works/pi-tui/dist/` 下找类型定义文件,确认 `AutocompleteProvider` 接口需要哪些方法(`getSuggestions`、`applyCompletion` 等)。

2. **确认 `suppressNaturalAtAutocomplete` 缺哪些方法**:对比接口定义和当前实现(`extensions/index.ts:44-55`)。

3. **补齐缺失的方法**:
   - 如果 `applyCompletion` 是必需的,在 `suppressNaturalAtAutocomplete` 返回的 provider 里加一个透传实现:
     ```typescript
     export function suppressNaturalAtAutocomplete(current: AutocompleteProvider): AutocompleteProvider {
         return {
             ...current,
             async getSuggestions(...) { ... },  // 现有逻辑
             applyCompletion: (...args) => current.applyCompletion?.(...args),  // 透传
         };
     }
     ```
   - 或者用 Proxy 做更彻底的透传。

4. **验证修复**:
   - 启动 UGK,跑 `/task`(无参),确认弹菜单不再崩溃
   - 跑 `/task continue-review`(无 inline 摘要),确认弹 editor 不再崩溃
   - 跑 `/judge change-spec`,确认没破坏 Judge

#### 注意

**这个 bug 可能不是 `/task` 引入的**,而是 `suppressNaturalAtAutocomplete`(为了修 @ autocomplete 卡顿,commit `2a17cbc`)引入的。修复时要小心不要破坏 @ autocomplete 的原始修复(参考 commit `2a17cbc Avoid @agent autocomplete scans` 的意图)。

#### 验收

- 手动验证 `/task` 无参、`/task continue-review` 无 inline 都不再崩溃
- 现有的 autocomplete 测试全过
- `npm test` 全过

---

### 🟡 问题 4:session 恢复需要 `-r` 标志(低,文档问题)

#### 现象

直接 `ugk` 启动是全新 session,task state 丢失。需要 `ugk -r`(resume)才能恢复上次 session 的 task-state entry。

#### 影响

用户不知道要加 `-r`,session 中断后重启会以为 task 状态丢了,实际是没 resume。

#### 修复要求

**不是 bug,是 pi 的设计**。修复方向是**文档说明 + UI 提示**:

1. 在 `docs/design/task-extension-spec.md` 的"状态持久化"章节(第八节)加一条说明:
   ```markdown
   **session 恢复**:task state 持久化在 session JSONL 里,但需要用 `ugk -r`(resume)启动才能加载。直接 `ugk` 是新 session,task state 不会自动恢复。这是 pi 的设计,不是 bug。如果用户希望默认 resume,需要在 UGK 启动入口配置。
   ```

2. (可选)在 `/task` 命令的 notify 里提示:如果 state 是初始 aborted,提示用户"如果想恢复上次的 task,用 `ugk -r` 启动"。

#### 验收

- 设计文档更新
- (可选)UI 提示加好

---

### 🟢 问题 5:`/task save` 的 input placeholder 容易误导(低,UX)

#### 现象

`task.ts:463` 的 placeholder 是 `"首次成功产出的输出目录"`,用户不知道这是占位符还是字面值,可能随便填或照搬字面。

#### 修复要求

**已经被问题 1 的方案 C 覆盖**(智能默认,不用手填)。如果问题 1 选了方案 C,这个问题自动消失。

如果问题 1 没选方案 C,则需要改进 placeholder 的措辞,明确告诉用户"这是 execute 阶段产出的实际目录的绝对路径,例如 E:/AII/TUI/.tasks/runs/.../output"。

#### 验收

- 跟问题 1 一起测,确认 save 流程对用户友好

---

### 🟢 问题 6:worker 子进程没有进度反馈(低,UX)

#### 现象

`/task run` 时,worker 在后台 spawn 跑,TUI 没有任何进度指示(没有 spinner、没有 widget)。用户跑命令后"没反应",要等 30-60 秒才出 notify。

#### 修复要求

**用 `ctx.ui.setWidget` 显示 worker 进度**。参考 Judge 的 widget 实现(`extensions/judge/judge.ts:617-621`)。

具体:在 `handleTaskRun` 的 retry 循环里:
- 进入循环前:`ctx.ui.setWidget("task-run-view", ["⏳ taskbook '<name>' 运行中...", "尝试 1/3", "worker 执行中..."], { placement: "aboveEditor" })`
- worker 完成、verify 开始:更新 widget 行
- verify 完成:清掉 widget(`ctx.ui.setWidget("task-run-view", undefined, ...)`)

#### 实现提示

`task.ts` 没有 widget 相关代码,需要新加。参考 Judge 的:
- `JUDGE_DRIVER_WIDGET_KEY` 常量
- `clearJudgeDriverWidget(ui)` 函数
- `refreshDriverWidget()` 函数

简化版:不需要 Judge 那么复杂(不需要订阅 driver 事件),只要在 handleTaskRun 关键节点更新 widget 文本即可。

#### 验收

- `/task run` 时能看到 widget 显示当前阶段(worker 中/verify 中/完成)
- 跑完 widget 自动清掉
- 写测试(用 mock ctx.ui.setWidget 验证调用)

---

## 实现顺序建议

按依赖关系排序:

1. **问题 3**(editor 崩溃)— 先修,因为后续测试其他问题时会频繁触发它
2. **问题 1**(args 解析)— 修完后 save/run 命令好用
3. **问题 2**(产出可见)— 修完后用户体验质变
4. **问题 6**(进度 widget)— 体验优化
5. **问题 4 + 5**(文档 + UX 细节)— 最后扫尾

每个问题修完跑一次 `npm test` 确认基线。

---

## 最终交付清单

修改完所有问题后:

**代码修改**(预期):
- [ ] `extensions/task/task.ts` — args 解析、产出展示、widget、智能默认 runDir
- [ ] `extensions/task/task-state.ts` — 加 `executeRunDir?: string` 字段(问题 1 方案 C 需要)
- [ ] `extensions/index.ts` — 修 `suppressNaturalAtAutocomplete` 的 applyCompletion(问题 3)
- [ ] `docs/design/task-extension-spec.md` — 文档更新(问题 4)

**测试新增/修改**(预期):
- [ ] `tests/task-extension.test.ts` — 加 args 解析、产出展示、widget 的测试
- [ ] 可能新增 `tests/task-args.test.ts` 或类似

**全局验证**:
- [ ] `npm test` 全过(基线 397 + 新增测试)
- [ ] `git diff --check` 通过
- [ ] 手动跑一遍 `/task run grapheme-count xyz789`,确认看到完整产出

**不要做**:
- 不要 commit
- 不要碰 Judge / smoke-tui / 旧 untracked docs
- 不要"顺手优化"不在清单里的东西

---

## 完成后的交接总结模板

```
dogfood 问题修复完成。

问题 1(args 解析):
- 选了方案: A / B / C / C+A
- 改动: <简述>

问题 2(产出可见):
- 改动: <简述>
- PASS notify 示例: <贴一个实际的 notify 内容>

问题 3(editor 崩溃):
- 根因: <诊断结果>
- 改动: <简述>

问题 4(session 恢复文档):
- 改动: <简述>

问题 5(input placeholder):
- 状态: 被问题 1 方案 C 覆盖 / 单独修复
- 改动: <简述>

问题 6(worker 进度 widget):
- 改动: <简述>

验证:
- npm test: <总测试数>/<总测试数> pass
- 手动测试: <跑了一遍 /task run grapheme-count xyz789,notify 显示了完整产出>

已知遗留(如果有):
- <列出没修的及原因>
```

---

## 给执行 agent 的最后的话

这份清单是 `/task` v1 dogfood 的真实问题反馈,优先级排序已经做好。你按"实现顺序建议"逐个修,每个问题独立可验证。**不要一次改全部**,改完一个跑一次测试,确认没问题再下一个。

如果某个问题诊断后发现根因跟清单描述不符(比如问题 3 其实是 pi-tui 本身的 bug,`suppressNaturalAtAutocomplete` 只是受害者),**先在交接总结里说明,不要硬改**——根因判断错了改了反而会引入新问题。

如果某个问题修不了(比如需要改 pi runtime 本身),**跳过并在交接总结里说明**,留给后续处理。

完成所有问题后,按交接总结模板填好返回,review agent(我)会对照验收。

---

## 实际修复结果(2026-06-22 完成)

执行 agent 完成了全部 6 个问题,`npm test` 401/401 pass。修复细节:

| # | 问题 | 修复 |
|---|---|---|
| 1 | args 不支持带空格 JSON | 方案 **C+A+B 全选**:`/task run` 支持 `--input-file`/`--input-json`/`--input` 三种;`/task execute` 记录 `executeRunDir`,`/task save` 无 `--output-dir` 时默认用 execute 产出目录自证 |
| 2 | `/task run` 看不到产出 | `formatRunResult`(`task.ts:284`)在 PASS/FAIL notify 中显示 artifact 路径 + 大小 + JSON 内容 + verify 结果 + worker 摘要 |
| 3 | editor/select 崩溃 | 根因:`AutocompleteProvider.applyCompletion` 是必需方法,wrapper 展开 class provider 时丢 prototype 方法。修复:`suppressNaturalAtAutocomplete`(`extensions/index.ts`)显式透传 `applyCompletion`,加回归测试 `tests/ugk-command.test.ts` |
| 4 | session 恢复需 `-r` | 文档说明(`task-extension-spec.md` 状态持久化章节 + v1 实现注记) |
| 5 | input placeholder 误导 | 被问题 1 方案 C 覆盖 |
| 6 | worker 无进度反馈 | `setTaskRunWidget`(`task.ts:317`)在 worker/verify 阶段更新 `task-run-view` widget,run 结束清理 |

**已知遗留**(v1 不修):
- 命令行直接传带空格 JSON 不支持(用 `--input-file` / `--input-json` 绕过,真要做 shell-like parser 留 v1.1)
- 真实 TUI dogfood 只跑了 `grapheme-count` 一个 taskbook

**Goal 用量**:161,563 tokens,约 7 分 7 秒。
