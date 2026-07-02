# Judge driving 中途用户插话 — 执行交接 Message

> 本文件是一份**自包含的交接 message**,写给执行 agent(worker)。
> worker 对项目零认知,读这一份就能上手。可整段粘为 `@worker` 触发消息。

---

## 工作目录

**你的 cwd 是 `E:\AII\ugk-core`(项目根目录)。** 所有相对路径都以这里为根。`npm test` 在这里跑。不要 cd 到别处。

---

## 你是谁,在干什么

ugk-core 是基于 pi(pi-coding-agent)的 TypeScript 编码 agent。本次任务加一个新交互能力:**用户在 Judge driving phase 中途打字,这条消息通过 Judge 转发给 Driver**。

**项目当前状态**: 分支 `codex/judge-taskbook`,HEAD `aab42fc` 已提交。`npm test` 353 pass / 0 fail。你的改动叠加在上面,不破坏现有功能。

---

## ⚠️ 开工前必读(按顺序)

1. **`AGENTS.md`** — 项目约定。bash 走 Git Bash(`D:\Git\bin\bash.exe`),Linux 语法,Windows 路径用正斜杠;危险操作前确认。
2. **`docs/judge.md`** — Judge 模式当前事实。
3. **`extensions/judge/judge.ts`** — 核心改动文件。重点读:
   - `pi.on(...)` 现有 hook 列表(参考写法,搜 `pi.on(`)
   - `startActiveJudgeDriver` 函数内 `activeDriver` 的用法(怎么 steer driver)
   - `state.phase === "driving"` 的判断位置
4. **`extensions/shared/driver-session.ts`** — `DriverSessionLike` 接口(`:48-57`),`steer(text)` 方法
5. **`extensions/judge/judge-driver.ts`** — `JudgeDriverHandle` 接口,看怎么对 driver 发指令

---

## 任务一句话

**在 Judge driving phase,用户在 TUI 打字 → 拦截这条输入 → 通过 activeDriver 转发给 Driver**。

设计哲学:用户不直接给 Driver 发消息,而是统一走 Judge(Judge 作为永久中间层)。但本任务的实现**不需要 Judge LLM 判断要不要转发**,而是**无条件加工转发**(详见 D1)。

---

## 已拍板决策表(不可更改)

| # | 决策 | 定论 | 理由 |
|---|---|---|---|
| **D1** | 转发策略 | **(i) 永远传**:用户插话无条件加工成 steer 转给 driver | 用户核心信念是「Judge 永远不撤」是架构层面——不是说 Judge 要审批用户每句话。Judge 的价值体现在事后监督(DECIDE 循环持续在跑),不是事前审批。加判断层违背「立即」 |
| **D2** | 用户入口 | **不搞前缀/不搞命令**:用户在 driving 中途直接在 TUI 输入框打字,统一走 Judge | 用户原话「换个方式 不区分对象了 我发一句话 就是发给 judge 他理解之后 发给 driver 不要搞太复杂」|
| **D3** | 触发条件 | **只在 driving phase 拦截**:其他 phase(aligning/delivering/aborted/done)用户输入走原逻辑 | 避免污染 aligning/delivering 流程 |
| **D4** | 转发方式 | **steer**(立即插入当前轮),不是 followUp(下一轮) | 用户插话要立即影响 driver,steer 是「当前轮插消息」语义 |
| **D5** | 加工方式 | **轻加工**:用固定模板包一层「用户插话」上下文,告诉 driver「这是用户在 driving 中途给的指导」,但保留用户原文 | driver 需要知道这条消息的来源(是用户插话不是 Judge steer),否则会混淆 |
| **D6** | 边界处理 | **activeDriver 不存在时**:notify「Driver 不在运行,无法转发」+ 不拦截(让消息走默认路径)| 防御性容错 |

---

## 技术方案

### 核心机制:`pi.on("input")` 拦截

pi 提供的 input 事件(`node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts:590-617`):

```ts
export interface InputEvent {
  type: "input";
  text: string;
  images?: ImageContent[];
  source: InputSource;  // "interactive" | "rpc" | "extension"
  streamingBehavior?: "steer" | "followUp";
}

export type InputEventResult =
  | { action: "continue" }      // 放行,走默认 agent 处理
  | { action: "transform"; text: string; images?: ImageContent[] }  // 改写后继续
  | { action: "handled" };      // 拦截,不再走默认处理
```

### 改动点:`extensions/judge/judge.ts`

在 `registerJudge` 内,现有 `pi.on(...)` 那批 hook 旁边,加一个新的 `pi.on("input", ...)`:

```ts
pi.on("input", async (event, ctx) => {
  // 只在 driving phase 拦截;其他 phase 放行(D3)
  if (state.phase !== "driving") return { action: "continue" };

  // 只拦截交互式输入;extension/rpc 来源的输入放行
  if (event.source !== "interactive") return { action: "continue" };

  // activeDriver 必须存在(D6)
  if (!activeDriver) {
    ctx.ui.notify("Driver 未运行,无法转发用户消息。", "warning");
    return { action: "continue" };  // 放行,让消息走默认路径
  }

  // 加工 + 转发(D1 + D5)
  const wrapped = [
    "[USER INTERJECTION during driving]",
    "The user typed the following while you were working. Treat it as authoritative guidance from the user (not a Judge steer). Incorporate it into your current work or revise as needed.",
    "",
    event.text,
  ].join("\n");

  try {
    await activeDriver.sendUserInput(wrapped);  // 或 steer,取决于 driver 当前状态
    ctx.ui.notify(`已转发用户插话给 Driver: ${event.text.slice(0, 50)}${event.text.length > 50 ? "..." : ""}`, "info");
  } catch (error) {
    ctx.ui.notify(`转发用户插话给 Driver 失败: ${error instanceof Error ? error.message : String(error)}`, "warning");
  }

  return { action: "handled" };  // 拦截,不再走默认 agent 处理
});
```

### 关键技术细节

**1. `activeDriver.sendUserInput` vs `steer`**

看 `extensions/shared/driver-session.ts:235-241`:

```ts
async sendUserInput(text: string) {
  if (session.isStreaming) {
    await session.steer(text);  // driver 正在跑 → steer(插入当前轮)
    return;
  }
  await session.prompt(text);   // driver idle → 新一轮
}
```

**`sendUserInput` 已经自动处理了 streaming/idle 两种情况**——直接用它,不用判断。这正是我们要的 D4(steer 立即插入)+ 自动兼容 idle 边界。

**2. 注意不要和现有 input hook 冲突**

当前 extensions 里没有 `pi.on("input")` 注册(已确认)。但要小心 plan-mode 等其他 extension 的 input 处理。如果 plan-mode 也有 input hook,本 hook 必须只在 driving phase 拦截(D3 已经保证),其他 phase 放行让其他 extension 处理。

**3. 拦截后 Judge 主 session 的行为**

`{ action: "handled" }` 意味着 Judge 主 session **不会启动新一轮 turn**——这正是我们要的(用户插话是给 driver 的,不是给 judge 的)。Judge 主 session 保持 idle,继续等下一个事件(driver 的 agent_end 等)。

### 不需要改的

- **driver.md 不改**——driver 本来就接受 `sendUserInput`,加一层「[USER INTERJECTION]」前缀告诉它来源即可
- **state 不改**——不需要在 JudgeState 加新字段
- **持久化不改**——插话不持久化,只在当前 run 内有效
- **菜单不改**——用户在 driving phase 不会看到 menu(driver 在跑,没弹 menu)

---

## 不可违反的硬约束

| # | 约束 |
|---|---|
| HC1 | **TDD**,先写测试后改代码,`npm test` 全绿(353 + 新增) |
| HC2 | **只在 driving phase 拦截**——其他 phase 必须返回 `{action: "continue"}`,行为零变化 |
| HC3 | **不破坏现有流程**:`/judge save/run/edit/list/ack/toggle`、aligning、driving、delivering、agent_end 所有现有逻辑保持不变 |
| HC4 | **转发策略是「永远传」(D1)**——不要加 Judge LLM 判断「要不要传」,直接加工转发 |
| HC5 | **用 activeDriver.sendUserInput**,不用别的 API——它已经自动处理 streaming/idle 两种状态 |
| HC6 | **所有异常容错**:activeDriver 不存在、sendUserInput 失败、source 非 interactive——只 notify warning,不抛未捕获异常,不让用户流程崩 |
| HC7 | **加工格式固定**(D5):`[USER INTERJECTION during driving]` 前缀 + 用户原文,让 driver 知道是用户插话 |
| HC8 | bash 走 Git Bash + Linux 语法 |
| HC9 | 改动最小化,不重构无关代码 |

---

## TDD 实施步骤

### 步骤 A:测试用例

在 `tests/judge-extension.test.ts` 加测试:

1. **driving phase 用户输入被拦截 + 转发给 driver**
   - mock state.phase = "driving"
   - mock activeDriver.sendUserInput
   - 触发 input 事件 with text="把日志也加上"
   - 断言:sendUserInput 被调用,参数含 "[USER INTERJECTION during driving]" 和原文
   - 断言:返回 `{action: "handled"}`

2. **非 driving phase 放行**
   - state.phase = "aligning" / "delivering" / "done" / "aborted"
   - 断言:返回 `{action: "continue"}`
   - 断言:activeDriver.sendUserInput 不被调用

3. **source 非 interactive 放行**
   - state.phase = "driving" 但 source = "rpc"
   - 断言:返回 `{action: "continue"}`

4. **activeDriver 不存在时 notify + 放行**
   - state.phase = "driving" 但 activeDriver = undefined
   - 断言:notify 被调用(warning)
   - 断言:返回 `{action: "continue"}`(放行,不崩)

5. **sendUserInput 抛错时 notify warning 不崩**
   - mock sendUserInput 抛 Error
   - 断言:notify warning 被调用
   - 断言:仍然返回 `{action: "handled"}`(已经决定拦截,异常不改变拦截决定)

### 步骤 B:实现 input hook

改 `extensions/judge/judge.ts`,在 `registerJudge` 内加 `pi.on("input", ...)`。

### 步骤 C:跑测试 + 回归

- `npm test` 全绿(353 + 新增)
- 确认现有所有测试零失败

### 步骤 D:文档

- `docs/judge.md` 加一节「用户在 driving 中途插话」:说明 driving phase 用户打字会被转发给 Driver;Judge 仍在 DECIDE 监督;消息不持久化
- `docs/design/2026-06-21-judge-taskbook-spec.md` 不改(本特性跟任务书无关,是 Judge 模式的基础能力扩展)

---

## 报告格式

完成后报告:
1. 改了哪些文件(列表)
2. 新增测试数 + `npm test` 结果(pass/fail 数)
3. input hook 的关键代码(贴出来)
4. 用户插话的完整流程描述(从打字到 driver 收到)
5. 有无偏离本交接文档

---

## 速查:关键文件

| 用途 | 文件 |
|---|---|
| 项目约定 | `AGENTS.md` |
| Judge 现状 | `docs/judge.md` |
| pi input 事件定义 | `node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts:590-617` |
| 现有 pi.on hooks | `extensions/judge/judge.ts`(搜 `pi.on(`)|
| activeDriver 用法 | `extensions/judge/judge.ts` 的 `startActiveJudgeDriver` 函数 |
| sendUserInput 实现 | `extensions/shared/driver-session.ts:235-241`(自动处理 streaming/idle) |
| JudgeDriverHandle 接口 | `extensions/judge/judge-driver.ts` |
| 现有测试 | `tests/judge-extension.test.ts` |

---

## 你的第一步

1. 读 `AGENTS.md`
2. 读 `node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts:590-617`(input 事件 + 返回类型)
3. 读 `extensions/judge/judge.ts` 的 `pi.on(...)` 部分,理解现有 hook 写法
4. 读 `extensions/shared/driver-session.ts:235-241`,确认 `sendUserInput` 的行为
5. 开始步骤 A:先写测试
6. 步骤 B 实现input hook
7. 步骤 C/D:`npm test` 全绿 + 文档
8. 报告

**不确定就停下来问,不要猜。** 本文档是权威。

---

## 附录:用户对话脉络

用户原话:「换个方式 不区分对象了 我发一句话 就是发给 judge 他理解之后 发给 driver 不要搞太复杂」

用户拍板 D1(永远传,不加判断):理由是 Judge 的价值在事后监督(DECIDE 循环),不在事前审批;加判断层违背「立即」。

核心信念:**Judge 是永久中间层,不管谁(包括用户)要影响 driver,都走 Judge**。但 Judge 不审批用户的话,只是中转加工——用户的价值判断是终极的。
