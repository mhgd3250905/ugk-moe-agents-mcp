# `/task` 交互层重构(v2)

> ⚠️ **本文"改动 4:dispatcher"的设计描述已过时(v2.1.1 起),关于 dispatcher 失败/降级的部分不再成立。**
> - 本文 line ~213-214、~235、~434 描述 dispatcher "失败 fallback 到 questionnaire 收集"、"类似 extractRequirementsSpec 的三级 fallback"。
> - v2.1.1 起,dispatcher 是唯一自然语言解析路径:`localRuntimeInput` 只接确定性结构化语法(JSON / field=value),自然语言/裸值一律走 dispatcher、无本地捷径;dispatcher 模型/auth 不可用时**显式抛错**(`dispatcher 模型不可用`),不再 `return undefined` 降级到逐字段 UI 问。
> - 因此"dispatcher 失败 fallback""questionnaire fallback""三级 fallback"等描述**不再成立**。dispatcher 设计的权威来源是 `extensions/task/task-dispatcher.ts` + 本仓库 v2.1.1 提交记录。
> - 文档其余部分(交互层重构、阶段过渡、save 走 questionnaire)不受影响。

> **状态:已完成(2026-06-23)。** 6 个改动全部落地,当时基线 `npm test` 406/406 pass。核心承诺(用户零命令记忆、自然语言 input)由执行 agent + 审核 subagent 共同保证。当前实现以 `extensions/task/` 代码为准。详见本文末尾"实际修复结果"。
>
> **原始用途**:给执行 agent 的交接文档,执行交互层重构。本文自包含,包含完整 UGK `/task` 背景。
>
> **更新时间**:2026-06-23

---

## 背景

### UGK `/task` 是什么

`/task` 是 UGK 的固定任务委托系统。四阶段流程:

```
planning(对齐 Spec)→ executing(主 agent 亲手做)→ reviewing(产 skill+verify+contract)→ landed
```

复用:`/task run <name> <input>` → spawn worker → verify → 报结果。

### 必读文档

修改前**必读**:
1. `E:\AII\ugk-core\docs\design\task-extension-spec.md` — 需求规格(权威)
2. `E:\AII\ugk-core\docs\design\task-extension-followup-2.md` — 上一轮 dogfood 问题修复(已完成的 6 个问题)

### 现有代码

```
extensions/task/
  task.ts            主入口,~700 行
  task-state.ts      状态机
  task-book.ts       taskbook 落盘
  task-prompts.ts    prompts
  task-verify.ts     verify runner
  task-worker.ts     worker spawn
  task-checker.ts    checker spawn

tests/task-*.test.ts 6 个测试文件,401/401 pass 是基线
```

### dogfood 暴露的根本问题

上一轮 dogfood 跑通了一个 B 站下载 taskbook,但暴露了**交互范式的根本错误**(不是单个 bug,是设计层错误):

1. **用户被迫当专家**:现在要求用户记得 `/task continue-review <长摘要>`、`/task save <name> --output-dir <路径> --input <JSON>`、要手动检查 verify.mjs、要记得复制 agent 定义……这些**全都不该让用户做**。

2. **复盘责任错放**:`continue-review` 让用户手写执行摘要。这是 agent 该干的活(整理过程、提炼最优路径),不该推给用户。正确做法:agent 自己读 session 过程,自己整理,然后 questionnaire 一项项核对。

3. **环节之间没有过渡引导**:每个阶段做完系统就停了,用户不知道下一步该敲什么。状态栏显示 `🔧 executing` 然后没了——没有任何"现在该做 X"的提示。

4. **命令拼装太复杂**:`--output-dir` `--input` `--input-file` `--input-json` 这些 flag 用户根本记不住。复杂参数应该交互式收集,不该走命令行。

5. **`/task run` 的 input 解析脆弱**:`split(/\s+/)` + JSON.parse 注定处理不了带空格、带中文、带特殊字符的输入。

---

## 核心原则(所有改动必须遵守)

> **用户是傻瓜,不是专家。** 用户只会敲 `/task` + 会做 questionnaire 选择题 + 会贴一句话自然语言。其他事情(整理过程、组装参数、推进阶段、提示下一步)**全是 agent 的责任**。

具体地:
- **用户不该记任何带 flag 的命令**(没有 `--output-dir`/`--input`/`--input-file`/`--input-json`)
- **用户不该写任何长文本摘要**(执行摘要由 agent 自动生成)
- **用户不该自己想"下一步该敲什么命令"**(系统主动提示或自动推进)
- **每阶段的产出该被 agent 主动核对**,用户只点 yes/no 或微调

---

## 改动清单(按实现顺序)

### 改动 1:execute 阶段自动收集过程信息(解决问题 2)

**目标**:execute 完成时,系统已经自动记录了"调过哪些工具、产出哪些文件、走过哪些关键 bash 命令",review 阶段直接用,**不用问用户要摘要**。

**当前状态**:`task.ts:529-545` 的 `continue-review` action 强制要用户写摘要:
```typescript
const inlineSummary = tokens.slice(1).join(" ").trim();
const summary = inlineSummary || await ctx.ui?.editor?.("执行摘要", "...");
if (!summary?.trim()) {
    ctx.ui.notify("缺少执行摘要,无法复盘。", "warning");
    return;
}
```

**修改要求**:

1. **在 TaskState 加字段**(`task-state.ts`):
   ```typescript
   interface TaskState {
     // ... 现有字段
     executeProcessLog: ExecuteProcessEntry[];  // 新增
   }
   
   interface ExecuteProcessEntry {
     kind: "tool_call" | "artifact";
     toolName: string;        // tool_call 才有
     argsSummary: string;     // tool_call 才有(bash 命令、write 路径等)
     artifactPath?: string;   // artifact 才有
     timestamp: string;
   }
   ```

2. **在 execute 阶段订阅 tool_call 事件**(`task.ts` 的 tool_call handler):
   - 进入 executing 阶段后,把 tool_call 事件追加到 `state.executeProcessLog`
   - 重点记录:`bash` 的 command、`write`/`edit` 的 filePath、`chrome_cdp` 的 action
   - **message_update/text_delta 不记**(太碎)
   - **退出 executing 阶段或进 reviewing 时停止记录**

3. **进 review 时自动生成摘要**:
   - 把 `executeProcessLog` 格式化成执行摘要文本(类似 Judge 的 live.log 格式)
   - 存进 `state.summary`,**不再问用户**
   - `continue-review` action 删掉"强制要摘要"的逻辑(见改动 2)

**参考**:(历史)已删除的 judge 模块的 `judge-driver.ts` 曾做过类似的事(维护 pathsTried、artifacts),数据结构可借鉴。该模块已整体删除,仅作历史参考。

**验收**:
- execute 阶段调过的 bash/write/edit 都被记录进 `state.executeProcessLog`
- 进 review 时 `state.summary` 自动有内容
- 测试:模拟 execute 阶段触发几个 tool_call,确认 processLog 被正确收集

---

### 改动 2:阶段过渡自动化 + Enter 确认(解决问题 3)

**目标**:execute 完成 → 自动准备 review,但**留一个 Enter 确认停顿**(用户可以介入或反馈)。review 完成 → 自动准备 save。**用户不需要敲 continue-review 或 save 命令**。

**关键决策**(用户已拍板):**Enter 确认,不是完全自动**。每个过渡点:
- agent 完成本阶段工作后,notify 提示:"本阶段完成。按 Enter 继续,或输入反馈。"
- 用户按 Enter → 自动进下一阶段
- 用户输入文字 → 当作反馈,带回本阶段让 agent 处理

**修改要求**:

1. **`continue-review` action 改成"进 review"自动触发**(不需要用户敲):
   - execute 阶段的 agent_end 事件触发时,如果 main agent 表示"做完了"(看 transcript tail,或新增一个 `task_execute_complete` 自定义工具让 main 主动报告完成),自动:
     - 收集 executeProcessLog 生成 summary
     - 进 reviewing 阶段
     - notify: "execute 完成,产出在 <path>。按 Enter 进 review 复盘,或输入意见。"

2. **新增完成信号机制**(避免误判 agent 是否做完):
   - 方案 A:execute 阶段的 prompt 里要求 main agent 完成时**显式说"EXECUTE COMPLETE"**,代码检测这个关键词触发 review 准备
   - 方案 B(推荐):execute 阶段禁用 subagent,但保留一个 `task_complete` 工具,main 完成时调它,代码在 tool_call 里捕获
   - 参考 Judge 的 `judge_complete` 工具(`extensions/judge/judge.ts` 里有)

3. **save 自动触发**:
   - review 的 agent_end 触发时,如果解析到 reviewResult,自动:
     - 选 taskbook 名字(问用户或自动用 taskbookName 字段)
     - notify: "复盘完成。按 Enter 自动保存(会跑 verify 自证),或输入修改意见。"
   - 用户按 Enter → 自动 save + verify 自证
   - **`save` 命令保留但变成可选**(高级用户可手动调)

4. **删掉 `continue-review` 命令**(变成内部自动触发)
   - 或保留为"手动进 review"的兜底入口,但默认不走它

**验收**:
- execute 完成 → 自动提示进 review,用户按 Enter 进入
- review 完成 → 自动提示保存,用户按 Enter 自动 save
- 用户全程不需要敲 `continue-review` 或 `save <name> --xxx`
- 测试:模拟 main 调 task_complete → 自动准备 review;模拟用户按 Enter → 自动进 review

---

### 改动 3:save 的所有参数走 questionnaire(解决问题 4)

**目标**:`/task save` 不再接受任何 flag(`--output-dir`/`--input`/`--input-file`/`--input-json`),需要的信息全部通过 questionnaire 或自动推断。

**修改要求**:

1. **outputDir 自动推断**(已在改动 1 部分 covered):
   - 优先用 `state.executeRunDir`(execute 阶段记录的)
   - 如果没有,扫 `.tasks/runs/task-<name>-*/output/` 找最新的
   - **不再问用户**

2. **input 自动推断或交互式问**:
   - 优先尝试用 contract 的 runtimeInput 字段映射一些默认值(空字符串)
   - 如果 verify 自证失败,**用 questionnaire 问用户**:"verify 自证需要一个示例输入,请提供 <字段名>:"
   - 用户答完,再跑 verify
   - **不再用 `--input` flag**

3. **taskbook 名字交互式问**(已有 `ctx.ui.input`),保留

4. **删掉所有 input 相关 flag**:
   - `--input`/`--input-file`/`--input-json`/`--output-dir` 全部删
   - 这些路径要么自动推断,要么 questionnaire 问

**验收**:
- save 流程零 flag
- 用户只通过 questionnaire 或 Enter 推进
- 测试覆盖:save 自动用 executeRunDir 做 verify 自证、save 在 verify 失败时交互式问 input

---

### 改动 4:`/task run` 的 input 走 agent 理解(解决问题 5)

**目标**:用户 `/task run <name> <随便什么自然语言>`,dispatcher agent 读 skill 后理解输入,组装 runtimeInput,**统一走 agent**(用户已拍板:不智能触发,永远调)。

**当前状态**:`task.ts:200-246` 用代码 `split(/\s+/)` + JSON.parse 处理 input,带空格/JSON 全炸。

**修改要求**:

1. **新增 dispatcher 模式**(`task.ts` 的 `handleTaskRun`):
   - 用户输入 `/task run <name> <rawInput>`,代码不再 parse rawInput
   - 把 rawInput 原样 + skill + contract 喂给一个轻量 LLM 调用
   - LLM 输出结构化 runtimeInput JSON
   - 把 runtimeInput 传给 worker

2. **dispatcher 的实现**:
   - 不开新子进程(太重),用主 session 的 LLM 调用一次即可
   - 构造一个 prompt:"以下是 task 的 skill 和 contract。用户输入是 `<rawInput>`。请按 contract.runtimeInput 的字段定义,从用户输入提取并组装成 JSON。输出 fenced JSON。"
   - 用 `extractRuntimeInputFromText(text)` 解析(类似 extractRequirementsSpec 的三级 fallback)
   - 失败 fallback:问用户"请明确提供 <字段>",questionnaire 收集

3. **dispatcher 用便宜模型**:
   - 简单理解任务,用 deepseek-v4-flash 就够
   - 通过 pi 的 model API 调用(不开 worker 子进程,直接 LLM call)

4. **worker prompt 不变**:worker 还是收到结构化 runtimeInput JSON,按 skill 执行

5. **删掉所有 input 解析代码**:
   - `parseRuntimeInputTokens`、`parseRuntimeInputValue`、`resolveRuntimeInput` 全删
   - 删掉 `--input`/`--input-file`/`--input-json` 处理(改动 3 也要求)

**预期效果**:
- `/task run bilibili-download https://www.bilibili.com/video/BV1GJ411x7h7` → dispatcher 提取 `{url: "..."}`
- `/task run bilibili-download 把这个下下来 https://b23.tv/xxx` → dispatcher 提取 `{url: "https://b23.tv/xxx"}`
- `/task run grapheme-count Hello 世界` → dispatcher 提取 `{text: "Hello 世界"}`
- 用户不用懂 contract schema,agent 帮他组装

**验收**:
- 测试覆盖:mock dispatcher 的 LLM 调用,验证不同 rawInput 都能正确组装成 runtimeInput
- 自然语言、URL、带空格、带中文 都能处理
- 失败时 questionnaire fallback

---

### 改动 5:每阶段结束有明确"下一步"提示(解决问题 3 的另一半)

**目标**:用户在每个阶段结束时**不需要猜下一步**,系统主动告诉他。

**修改要求**:

1. **planning 完成**(Spec 对齐):
   - 当前 notify: `"Spec 已对齐。用 /task 进入菜单,选"开始执行"。"`
   - 改成: `"Spec 已对齐。按 Enter 进 execute 阶段(我亲手做一遍验证可行性),或输入修改意见。"`

2. **execute 完成**(改动 2 的 task_complete 触发):
   - notify: `"execute 完成,产出在 <path>。按 Enter 进 review 复盘,或输入意见。"`

3. **review 完成**(reviewResult 解析):
   - notify: `"复盘完成。按 Enter 自动保存(会跑 verify 自证),或输入修改意见。"`

4. **save 成功**(landed):
   - notify: `"taskbook <name> 已就绪。以后用 \`/task run <name> <一句话>\` 复用。"`

5. **run 完成**(PASS/FAIL):
   - 已有 `formatRunResult`,保留并加强:
     - PASS:结构化显示任务、产物路径/大小、常见文本产物内容、verify 自证、引用块形式的 worker 摘要
     - FAIL:结构化显示任务、失败断言、引用块形式的 worker 摘要、可手动检查 outputDir

**实现提示**:"按 Enter 继续"这个交互需要 TUI 层支持。如果 pi-tui 没有现成的"等待 Enter"机制,可以:
- 方案 A:弹一个 questionnaire,只有一个选项 `["继续", "Exit"]`,用户选"继续"等于按 Enter
- 方案 B:notify 提示 + 等 `/task` 菜单触发(用户敲 `/task` 选"继续 execute/review/save")
- 推荐 **方案 A**(更接近"按 Enter 继续"的体验)

**验收**:
- 每个阶段结束都有明确的"下一步"提示
- 用户按 Enter(或选"继续")能自动进下一阶段
- 用户输入文字能作为反馈带回当前阶段

---

### 改动 6:命令菜单化,简化用户输入(解决问题 1 的另一半)

**目标**:大部分场景用户只敲 `/task`,其他命令收进菜单。

**当前命令清单**(从 spec.md 第七节):
```
/task                  显示菜单
/task new             进入 planning
/task save <name>     落盘
/task run <name>      复用
/task list            列出
/task edit <name>     编辑
/task show <name>     显示
/task delete <name>   删除
/task toggle         开关
/task exit           退出
```

**修改要求**:

1. **用户直接敲的命令**保留两个:
   - `/task`(进菜单)
   - `/task run <name> <自然语言>`(复用,因为复用是高频操作)

2. **其他命令全部进菜单**:
   - `/task` 弹菜单,按当前 state.phase 显示选项
   - 用户选"新建任务" → 内部触发 planning(等价于现在的 `/task new`)
   - 用户选"列出 taskbook" → 内部触发 list
   - 等等

3. **菜单选项要"傻瓜化"**(中文 + 描述清楚):
   - `"新建任务"` 而不是 `"new"`
   - `"运行 taskbook(复用)"` 而不是 `"run"`
   - `"查看 taskbook 详情"` 而不是 `"show"`
   - `"删除 taskbook"` 而不是 `"delete"`

4. **现有命令保留为高级入口**(不删,但文档不主推):
   - `/task new`、`/task save` 等还能用,只是菜单里也提供等价选项
   - 这样高级用户可以脚本化,普通用户用菜单

**验收**:
- 用户只敲 `/task` + 选菜单,能完成所有操作(除 run 外)
- 菜单选项是中文 + 清楚描述
- 测试覆盖菜单各选项的分发

---

## 不要做的事

- **不要改 worker.md / checker.md**(followup-3 已处理,本次不动)
- **不要改 task-state.ts 的现有字段**(只加新字段,不改老的)
- **不要碰 Judge 代码** / smoke-tui / 旧 untracked docs
- **不要 commit / stage**
- **不要"顺手优化"**不在清单里的东西

---

## 实现顺序(按依赖关系)

1. **改动 1**(execute 自动收集)→ 改动 2 才有数据用
2. **改动 2**(阶段过渡 + Enter 确认)→ 核心流程改造
3. **改动 3**(save 参数走 questionnaire)→ 依赖改动 2 的"自动 save"
4. **改动 5**(下一步提示)→ 跟改动 2 强相关,一起改
5. **改动 4**(run input 走 agent)→ 独立,最后做
6. **改动 6**(菜单化)→ 独立,最后做

每个改动独立可验证,改完跑 `npm test`。

---

## 最终交付清单

**代码修改**(预期):
- [ ] `extensions/task/task.ts` — 大改:删 input flag、加 executeProcessLog 收集、阶段过渡自动化、dispatcher 调用、菜单扩充
- [ ] `extensions/task/task-state.ts` — 加 `executeProcessLog` 字段、相关转换器
- [ ] `extensions/task/task-prompts.ts` — 加 dispatcher prompt(理解 input)、可能微调 TASK_REVIEW_PROMPT(告诉 review agent summary 已自动生成)
- [ ] 可能新增 `extensions/task/task-dispatcher.ts` — dispatcher 逻辑(理解 input)

**测试修改/新增**:
- [ ] `tests/task-extension.test.ts` — 大改:覆盖新流程
- [ ] 可能新增 `tests/task-dispatcher.test.ts`
- [ ] 现有测试如果依赖 `--input` 等 flag,要同步删

**全局验证**:
- [ ] `npm test` 全过(基线 401 + 新增)
- [ ] `git diff --check` 通过
- [ ] **手动 dogfood**:完整跑一遍 `/task new` → planning → execute → (Enter) → review → (Enter) → save → `/task run <name> <自然语言>`,用户全程不敲带 flag 的命令

---

## 完成后的交接总结模板

```
/task 交互层重构完成。

改动 1(execute 自动收集):
- 加了 state.executeProcessLog 字段
- 改了 tool_call handler 收集 bash/write/edit
- 进 review 时自动生成 summary
- 测试: <说明>

改动 2(阶段过渡 + Enter 确认):
- 加了 task_complete 工具 / 或检测 EXECUTE COMPLETE 关键词
- execute 完成 → 提示按 Enter 进 review
- review 完成 → 提示按 Enter 自动 save
- 测试: <说明>

改动 3(save 参数走 questionnaire):
- 删了 --output-dir / --input / --input-file / --input-json
- outputDir 自动用 executeRunDir
- input 用 questionnaire(verify 自证失败时)
- 测试: <说明>

改动 4(run input 走 agent):
- 新增 dispatcher(用便宜模型)
- 用户随便输,agent 理解
- 删了 parseRuntimeInputTokens 等
- 测试: <说明>

改动 5(下一步提示):
- 每阶段 notify 加了"按 Enter 继续"
- 测试: <说明>

改动 6(菜单化):
- /task 弹中文菜单
- 选项傻瓜化
- 测试: <说明>

验证:
- npm test: <总测试数> pass
- 手动 dogfood: <跑了什么>

已知遗留:
- <列出没做的及原因>
```

---

## 给执行 agent 的话

这次重构比 followup-2 大得多,核心是把控制权从用户手里拿回 agent 手里。**关键判断标准**:实现完后,一个完全不懂 `/task` 的用户,只靠 `/task` + 选项 + 一句话输入,能不能完整跑通创造 + 复用?能,就成功了;不能,就还没改完。

改动 2(阶段过渡)是最难的,因为它涉及状态机改造 + pi-tui 的"等待 Enter"交互机制(可能需要用 questionnaire 模拟)。如果遇到 pi-tui API 限制无法实现"按 Enter",**用单选项 questionnaire 模拟**(`["继续", "Exit"]`)。

如果某个改动需要改 pi runtime 本身才能实现,**跳过并在交接总结里说明**,留给后续处理。

完成后按交接总结模板返回,review agent 会对照验收,并**重新跑 dogfood**(B 站下载那个 taskbook)验证新流程。

---

## 实际修复结果(2026-06-23 完成)

执行 agent 完成了 6 个改动,当时基线 `npm test` 406/406 pass。执行 agent 还主动让一个 subagent 做了审核,审核发现了 4 个真实 bug 并修复了(这是 Actor+Supervisor 模式的实际运用)。

| # | 改动 | 落地 |
|---|---|---|
| 1 | execute 自动收集 | `state.executeProcessLog` 字段;executing 阶段订阅 tool_call 记录实际工具调用 + artifact 路径;review summary 自动生成 |
| 2 | 阶段过渡 + Enter 确认 | `pendingTransition` 状态字段 + `task_complete` 工具 + `tool_execution_end` 触发 + input 事件检测 Enter/反馈 |
| 3 | save 参数自动化 | 删 `--output-dir`/`--input`/`--input-file`/`--input-json`;save 默认用 `executeRunDir/output`;verify 失败且有 runtime fields 时才交互式问 |
| 4 | run input 走 agent | 新增 `extensions/task/task-dispatcher.ts`,用 `deepseek-v4-flash`;失败 fallback 到 questionnaire |
| 5 | 下一步提示 | planning/execute/review/save 四阶段都有"按 Enter 继续,或输入意见" |
| 6 | 菜单化 | `/task` 空命令弹中文菜单;show/edit/delete/run 菜单路径都先选 taskbook |

**subagent 审核 4 个修复**:
1. Enter 确认门缺失 → 修复后正常工作
2. `/task run` 本地 heuristic 绕过 dispatcher → 修复后真的"统一走 agent"
3. `task_complete` 在 `tool_call` 阶段提前切 review(race condition)→ 修复后只在 `tool_execution_end` 成功后才切
4. 菜单 action 只返回 bare action 导致 Usage 问题 → UX 细节修复

**已知遗留**:未跑真实 TUI dogfood(非交互环境跑真实 worker 会触发模型调用,自动化测试已覆盖关键路径)。

---

## 追加修复:execute 工具集放开环境工具(2026-06-23)

### 问题

dogfood 时发现 execute 阶段(创造流程的 task-creator)报"只有 bash/read/write/edit 四个工具",用不了 chrome_cdp。根因:`TASK_EXECUTING_TOOLS` 写死成白名单,把 chrome_cdp/mcp 物理屏蔽。`setActiveTools` 是纯 allowlist(pi runtime 确认),不在列表的工具一律丢失。

### 修正(对齐 worker.md "删 tools 字段继承全部"的做法)

- 删 `TASK_EXECUTING_TOOLS` 常量,新增 `applyExecuteTools(pi)`:从 task 进入前的 active snapshot 或当前 active set 减 subagent,再加 task_complete(不用 `getAllTools`,避免打开从未在 main session 启用过的注册工具)。
- `startTaskExecute` 进 execute 前**先恢复** `restoreToolsSnapshot`(进入 task 前的全集),再 `applyExecuteTools`——否则会继承 planning 阶段的只读窄集。
- subagent 禁止升级为**双保险**:`applyExecuteTools` 不放它进 active 集 + `tool_call` 事件显式 `block: true`(spec 4.2 硬约束的可靠实现)。
- planning/reviewing 的只读工具集**不动**(有意为之)。

### 验证

`npm test` 424/424 pass(基线 416 + 新增 8 个测试,覆盖 execute 保留 chrome_cdp/MCP 风格工具、记录环境工具调用、block subagent、session resume 到 executing 时仍保留环境工具、executing 菜单可进入复盘、pending review 状态下菜单可直接进入 review、PASS 报告内展示小型 Markdown 产物内容、worker 运行中进展展示、run 失败后可选修正 taskbook,以及 edit 增量更新 taskbook)。3 处 execute 工具集断言同步更新。

### 追加 UX 修复:executing 菜单暴露进入复盘(2026-06-23)

用户不需要记 `/task continue-review <摘要>`。executing 阶段 `/task` 菜单新增 `进入复盘`,映射到 `continue-review`;选择后弹 `确认执行结果(可留空)` 输入框,再进入原有 Enter 确认停顿。若已经处于"按 Enter 进 review"的 pending 状态,再次从 `/task` 选 `进入复盘` 会直接进入 review。
