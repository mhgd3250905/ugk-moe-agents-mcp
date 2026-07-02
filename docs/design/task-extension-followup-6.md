# `/task` smoke 复盘发现的缺陷清单

> ⚠️ **本文中"缺陷 1:dispatcher fallback"相关描述已过时(v2.1.1 起)。**
> - 本文记录了 dispatcher `return undefined` 静默降级、"只有 dispatcher 失败才 fallback 到交互式"的行为。
> - v2.1.1 起,dispatcher 模型/auth 不可用时**显式抛错**,不再 `return undefined` 降级;`localRuntimeInput` 只接确定性结构化语法(field=value/JSON),自然语言/裸值一律走 dispatcher,无本地捷径。
> - 因此"dispatcher fallback""return undefined fallback""fallback 到交互式"等描述**不再成立**。权威实现见 `extensions/task/task-dispatcher.ts`。

> **状态:已完成(2026-06-23)。** 5 个缺陷全部修复或合理处理,`npm test` 415/415 pass,`npm run smoke:task` pass 且复盘事件流确认 dispatcher 真跑(0 次 input fallback)。详见本文末尾"实际修复结果"。
>
> **补充(2026-06-28):** 本文"缺陷 3"提到的 `judge-driver-view`/`judge-mode` UI 污染,涉及整个 Judge 模块,该模块已于 `ddd5520` 整体删除。文中对这些 UI 元素的引用仅作历史记录。
>
> **原始用途**:给执行 agent 的交接文档,修复 smoke 复盘发现的 5 个缺陷。本文自包含。
>
> **更新时间**:2026-06-23

---

## 背景

### UGK `/task` 是什么

固定任务委托系统。复用流程:`/task run <name> <自然语言>` → dispatcher agent 理解 input → worker spawn 执行 → verify 机器验收 → PASS/FAIL。

### smoke 现状

`npm run smoke:task` 跑场景 B(预置 taskbook + `/task run`),report 显示 pass。但**复盘 `rpc-events.jsonl` 发现 PASS 背后有 5 个缺陷**,有些是 smoke 脚本的,有些是 `/task` 本身的。

### 必读文档/代码

- `E:\AII\ugk-core\docs\design\task-extension-spec.md` — `/task` 规格
- `E:\AII\ugk-core\docs\design\task-extension-followup-4.md` — 交互层重构(含 dispatcher 设计)
- `E:\AII\ugk-core\scripts\smoke-task.mjs` — smoke 脚本(本次复盘对象)
- `E:\AII\ugk-core\extensions\task\task-dispatcher.ts` — dispatcher 实现
- `E:\AII\ugk-core\scripts\smoke-judge.mjs` — smoke 参考模板

### 必读约束

- 始终中文(注释/commit),代码标识符用英文
- 遵守 `E:\AII\ugk-core\AGENTS.md`
- **不要碰 Judge 代码** / smoke-tui / 旧 untracked docs
- **不要 commit、不要 stage**
- 改完跑 `npm test` 确认基线 412/412 pass

---

## 复盘证据(必读,这是缺陷的事实依据)

### smoke 跑完的事件流(`.tmp/smoke-task/latest/rpc-events.jsonl`,17 个事件)

关键事件序列(简化):
```
0  [in] get_commands
1  setTitle "ugk - workspace"
2  setStatus turn-progress
3  setStatus plan-mode
4  setWidget content="undefined"           ← 缺陷 1:widget content 读不到
5  response id=startup
6  [in] prompt "/task run smoke_name_count ..."
7  input title="task input: request"        ← 缺陷 2:dispatcher 没跑,fallback 到交互式
8  setWidget content="undefined"
9  setWidget content="undefined"
10 notify "✅ PASS..."                       ← 最终 PASS
11 setWidget content="undefined"
12 response id=run
13 setTitle "π - workspace"
14 setWidget "judge-driver-view"            ← 缺陷 3:跨 extension 污染
15 setStatus judge-mode                     ← 缺陷 3 续
16 setStatus task-mode
```

### notify 的完整内容(证明 worker 真的 spawn 并产出了)

```
✅ taskbook "smoke_name_count" PASS(尝试 1 次, 12.5s)
产出:
  E:\AII\ugk-core\.tmp\smoke-task\...\output\nname.json (20 bytes)
  内容: {"name":"smoke-pkg"}
verify: 全过
worker 摘要:
  ## 完成
  读取 workspace 的 package.json,提取 name 字段值 smoke-pkg,写入 contract 要求的 name.json。
  ## 产出
  - .tasks/runs/.../output/name.json — {"name":"smoke-pkg"}
```

**结论:核心复用链路(taskbook load → worker spawn → verify → PASS)真的跑通了。但 PASS 背后有缺陷。**

---

## 缺陷清单(5 个,按严重度排序)

---

### 🔴 缺陷 1:dispatcher agent 没真正运行,fallback 到交互式 input(严重)

**证据**:事件 7 是 `input title="task input: request"`——这表示 `/task run` 触发了**交互式字段询问**,而不是 dispatcher LLM 调用。

按 followup-4 的设计(改动 4),`/task run <name> <自然语言>` 应该:
1. 把自然语言 + skill + contract 喂给 dispatcher agent
2. dispatcher 用 `deepseek-v4-flash` 理解,输出结构化 runtimeInput
3. 只有 dispatcher 失败才 fallback 到交互式

**实际行为**:直接走了交互式 fallback,dispatcher 没跑。

**根因方向**(看 `extensions/task/task-dispatcher.ts:56-74`):
```typescript
const model = ctx.modelRegistry?.find?.("fireworks", "accounts/fireworks/models/deepseek-v4-flash") ??
    getModel("fireworks", "accounts/fireworks/models/deepseek-v4-flash");
const auth = model ? await ctx.modelRegistry?.getApiKeyAndHeaders?.(model) : undefined;
if (!model || !auth?.ok || !auth.apiKey) return undefined;  // ← 这里 return undefined,fallback
```

**疑似根因**:
- dispatcher 用 `fireworks` provider + `deepseek-v4-flash`
- 主进程的 model 是 `deepseek/deepseek-v4-pro`(DeepSeek 官方 provider)
- **`fireworks` provider 可能没配置 API key**(环境变量里只有 `DEEPSEEK_API_KEY`,没有 `FIREWORKS_API_KEY`)
- 所以 `auth?.ok` 是 false,dispatcher 直接 return undefined,fallback

**修复要求**:

dispatcher 不应该依赖 `fireworks` provider。两个选择:

**方案 A(推荐):dispatcher 跟主进程用同一个 model/provider**
- 不写死 `fireworks` + `deepseek-v4-flash`
- 改成用 `ctx.model`(当前 session 的 model)或 `ctx.modelRegistry` 里第一个可用的便宜模型
- 这样 dispatcher 自动用主进程已认证的 provider

**方案 B:dispatcher 显式回退到主 model**
- 先尝试 `deepseek-v4-flash`(fireworks),失败则用 `ctx.model`
- 保证至少有一种方式能跑

**推荐方案 A**——简单,跟随主进程配置,不需要额外环境变量。

**验收**:
- smoke 跑 `/task run` 时,dispatcher 真的调 LLM(看 rpc-events 应该有 dispatcher 的 LLM 调用痕迹,或至少不再触发 `input` fallback)
- 加测试:mock ctx.model,验证 dispatcher 用它
- 手动:smoke 的事件流里不应该出现 `input title="task input: ..."`(说明走了 dispatcher)

---

### 🟡 缺陷 2:smoke 的 `respondToUi` 没正确读 `setWidget` 的 widgetLines(中等,smoke 脚本问题)

**证据**:smoke 复盘时,所有 `setWidget` 事件的 `content` 都被读成 `"undefined"`(事件 4, 8, 9, 11, 14)。

**根因**:`smoke-task.mjs` 的复盘脚本(以及可能的报告生成逻辑)读 `msg.content`,但 pi runtime 的 setWidget request 实际字段是 `widgetLines`(看 stdout.log 里:`"method":"setWidget","widgetKey":"task-run-view","widgetLines":[...]`)。

**这是 smoke 脚本读字段错了**,不是 `/task` 的 bug。但影响 smoke 的诊断能力——看不到 widget 实际显示了什么。

**修复要求**:
- smoke 脚本(和它的测试)读 setWidget 时用 `msg.widgetLines` 不是 `msg.content`
- 报告里可以加一段"widget 时间线",展示 task-run-view 的变化(worker 中 → verify 中 → 清理),这样能直观看到 run 的进度

**验收**:
- smoke 复盘脚本能正确读出 widgetLines
- 报告(可选)加 widget 时间线

---

### 🟡 缺陷 3:task run 完成后设置了 judge 的 widget(中等,跨 extension 污染)

**证据**:事件 14 是 `setWidget "judge-driver-view"`,事件 15 是 `setStatus judge-mode`。这两个都是 **Judge extension** 的 UI 元素,但在 `/task run` 流程里被设置了。

**根因方向**:
- 可能是 pi runtime 在 RPC 模式下的 UI 状态清理问题
- 或者是某个 extension 的 session_shutdown/session_start 误触发了 Judge 的状态恢复
- 看事件 13 `setTitle "π - workspace"`——pi 把 title 从 "ugk - workspace" 改回 "π - workspace",可能是 session 切换/清理时触发了 Judge 的状态重置

**影响**:轻微,不影响功能。但在真实 TUI 里可能出现"task run 完了,status 栏却显示 judge-mode"的怪异现象。

**修复要求**:
- **先诊断**:看 `extensions/judge/judge.ts` 的 session_start/session_shutdown handler,确认是不是它在恢复 state 时无条件设置了 judge-mode status
- 如果是 Judge 的问题:Judge 在 session_start 恢复 state 时,应该只在 `state.phase` 是 active phase(aligning/driving/delivering)时才 setStatus,而不是无条件
- 如果是 `/task` 的问题:看 `/task` 的清理逻辑有没有误触

**注意**:这个缺陷可能不在 `/task` 代码里,改时要小心不要破坏 Judge。如果诊断后发现是 pi runtime 的行为,**在交接总结里说明,跳过**。

**验收**:
- 诊断清楚根因
- 如果能修:smoke 事件流里不再出现 judge-driver-view / judge-mode(在 task run 上下文)
- 如果不能修:交接总结说明原因

---

### 🟢 缺陷 4:contract 的 runtimeInput 字段没真传到 worker(低,但暴露契约问题)

**证据**:contract 声明 `runtimeInput: ["request"]`,worker 的摘要里说"读取 workspace 的 package.json"——但 **worker 没提到收到 `request` 字段**,而是直接按 skill 干活了。

**两种可能**:
1. dispatcher 失败(缺陷 1)→ fallback 到交互式 input → smoke 脚本回了 "request"(placeholder)→ worker 收到 `{request: "request"}`,但 worker 忽略了这个无意义的值,直接按 skill 做
2. worker 确实收到 input 但没用(因为 skill 没说要用 request 字段)

**这其实暴露了一个设计问题**:**contract 的 runtimeInput 跟 skill 不一致**。contract 说要 `request` 字段,但 skill(读 package.json name)根本不需要 input。这种不一致在 smoke 里被掩盖了(worker 自己搞定),但在真实任务里会出问题。

**修复要求**:
- 这主要是 **smoke 的 taskbook 设计问题**,不是 `/task` 代码问题
- 修 smoke 的预置 taskbook:`runtimeInput: []`(因为读 package.json name 不需要 input)
- 或者改 skill,让它真的用 request 字段(但这样任务就变复杂了)
- **推荐前者**:smoke 的 taskbook runtimeInput 改成 `[]`,跟 skill 一致

**验收**:smoke 预置 taskbook 的 contract 跟 skill 一致

---

### 🟢 缺陷 5:smoke 没验证场景 A(完整创造流程)(低,已知遗留)

**证据**:smoke 只跑了场景 B(复用预置 taskbook),场景 A(从 `/task new` 开始完整创造)没实现。

**影响**:创造流程(planning → execute → review → save)的 LLM 链路没被 smoke 覆盖。这部分只有单元测试覆盖,没有 e2e。

**修复要求**:
- 本次**可以不做**,作为后续扩展
- 如果做:参考 followup-5 的场景 A 描述,实现完整创造流程的 smoke
- 关键挑战:模拟 questionnaire 全程 + 多个 Enter gate

**验收**:可选,不阻塞本次交付

---

## 实现顺序建议

1. **缺陷 1**(dispatcher fallback)— 最高优先级,影响所有真实 `/task run`
2. **缺陷 2**(smoke widgetLines)— 快速修,提升 smoke 诊断能力
3. **缺陷 4**(smoke contract 一致性)— 快速修
4. **缺陷 3**(跨 extension 污染)— 先诊断,能修就修,不能修跳过
5. **缺陷 5**(场景 A)— 可选,本次可以不做

每个缺陷独立可验证,改完跑 `npm test` + `npm run smoke:task`。

---

## 最终交付清单

**代码修改**(预期):
- [ ] `extensions/task/task-dispatcher.ts` — 改 model 来源(缺陷 1 方案 A)
- [ ] `scripts/smoke-task.mjs` — 修 widgetLines 读取(缺陷 2)、修 contract 一致性(缺陷 4)、可选加 widget 时间线到报告
- [ ] 可能 `extensions/judge/judge.ts` — 缺陷 3 如果根因在 Judge(小心改,不破坏 Judge)

**测试修改/新增**:
- [ ] `tests/task-dispatcher.test.ts` — 加 dispatcher 用 ctx.model 的测试(缺陷 1)
- [ ] `tests/smoke-task.test.ts` — 加 widgetLines 解析的测试(缺陷 2)

**全局验证**:
- [ ] `npm test` 全过(基线 412 + 新增)
- [ ] `npm run smoke:task` pass(用有效 DeepSeek key)
- [ ] **关键**:smoke 复盘事件流里:
  - 不再出现 `input title="task input: ..."` 的 fallback(缺陷 1 修复)
  - widgetLines 能正确读出(缺陷 2 修复)
  - 不再出现 judge-driver-view(缺陷 3 修复,如果能修)

**不要做**:
- 不要碰 smoke-tui / 旧 untracked docs
- 不要 commit / stage
- 不要"顺手优化"不在清单里的东西

---

## 完成后的交接总结模板

```
/task smoke 缺陷修复完成。

缺陷 1(dispatcher fallback):
- 根因: <确认是 fireworks provider 没 key 还是别的>
- 改法: 方案 A/B
- 验证: smoke 事件流不再有 input fallback

缺陷 2(smoke widgetLines):
- 改法: 读 msg.widgetLines
- 验证: 报告能显示 widget 内容

缺陷 3(跨 extension 污染):
- 根因: <诊断结果>
- 改法: <如果修了>
- 或: 跳过,原因 <说明>

缺陷 4(smoke contract 一致性):
- 改法: runtimeInput 改成 []
- 验证: contract 跟 skill 一致

缺陷 5(场景 A):
- 状态: 未做(本次遗留)/ 已做

验证:
- npm test: <总测试数> pass
- npm run smoke:task: pass/fail
- smoke 事件流: <贴关键事件确认缺陷 1/2/3 修复>
```

---

## 给执行 agent 的话

这次的核心是**让 smoke 不只是"PASS",而是"真正验证了每个环节"**。缺陷 1 最重要——dispatcher 不跑,followup-4 改动 4 的核心承诺("用户贴自然语言,agent 理解")就没兑现,所有 `/task run` 都在走 fallback。修好缺陷 1,v2 重构才算真正落地。

缺陷 3 可能不在 `/task` 代码里,诊断清楚最重要,不要硬改 Judge。

完成后按交接总结模板返回,review agent 会重新跑 smoke 并复盘事件流,确认每个缺陷真的修复了(不只是 report=pass)。

---

## 实际修复结果(2026-06-23 完成)

5 个缺陷全部处理,`npm test` 415/415 pass,`npm run smoke:task` pass。

| # | 缺陷 | 修复 |
|---|---|---|
| 1 | dispatcher fallback | **根因**:硬编码 `fireworks/deepseek-v4-flash`,本地无对应认证直接 return undefined。**改法**:改用当前 session 的 `ctx.model` 和同一套 `ctx.modelRegistry` 认证。**独立核实**:review agent 复跑 smoke,事件流 0 次 input fallback |
| 2 | smoke widgetLines | smoke 报告读 `msg.widgetLines`,新增 widget 时间线(worker → verify → cleared) |
| 3 | 跨 extension 污染 | **诊断**:事件里的 `judge-driver-view`/`judge-mode` 是 `session_shutdown` 清理事件(无 widgetLines/statusText),不是活跃污染。未改 Judge,smoke 复盘区分"清理事件"和"非空污染"。报告 `active Judge UI pollution: absent` |
| 4 | smoke contract 一致性 | smoke 预置 taskbook 的 `runtimeInput` 改成 `[]`,跟"读 package.json name"skill 对齐 |
| 5 | 场景 A | 未做,标记为可选遗留 |

**核心承诺兑现验证**:v2 重构改动 4(dispatcher 理解自然语言 input)现在真的生效——`/task run <name> <自然语言>` 走 dispatcher agent,不再 fallback 到交互式 input。
