# Bug 调查任务:Judge 用户插话功能失效 + phase 异常

> 状态: **待调查**
> 日期: 2026-06-21
> 角色: 本文档为 bug 调查交接,供执行 agent 独立调查根因并修复
> 工作目录: `E:\AII\ugk-core`(项目根)
> 用户(ugk-dev)愿意配合重现和抓数据,你可以直接要求他做操作

---

## 你的任务

独立调查**两个关联 bug** 的真正根因,给出**经过验证的修法**(改代码 + 跑 `npm test` 全绿 + 说明为什么这次是对的)。

**不要轻信前人猜测,从代码事实出发**。前人(我)已经在 input hook 上做了一次失败的实施,加了一版诊断日志拿到关键数据,但没能定位根因。你需要基于这些数据进一步深挖。

---

## Bug 现象

用户在 ugk TUI 里跑 `/judge run <taskbook>`,driver 应该开始干活。用户在 driving phase 中途打字插话(比如「先把日志加上」),**期望**:
- 插话被 input hook 拦截
- notify「已转发用户插话给 Driver: 先把日志加上」(黄字)
- driver 收到插话并响应

**实际**:
- **黄字 notify 没出现**(用户确认)
- driver 似乎没收到插话
- 用户的插话被放行走了主 session(普通聊天)

---

## 关键诊断数据(已抓到,直接采信)

### 数据 1:`.judge/debug.log` 抓到的 input-hook 日志

```
[2026-06-21T15:21:53.843Z] input-hook verdict=skip:phase=aborted phase=aborted source=interactive hasDriver=false text=[JUDGE DRIVER TASK]
[2026-06-21T15:21:58.337Z] input-hook verdict=skip:phase=aborted phase=aborted source=interactive hasDriver=false text=[JUDGE DECIDE MODE]
[2026-06-21T15:22:00.715Z] input-hook verdict=skip:phase=aborted phase=aborted source=interactive hasDriver=false text=[JUDGE DECIDE MODE]
[2026-06-21T15:22:03.947Z] input-hook verdict=skip:phase=aborted phase=aborted source=interactive hasDriver=false text=[JUDGE DECIDE MODE]
[2026-06-21T15:22:07.140Z] input-hook verdict=skip:phase=aborted phase=interactive hasDriver=false text=[JUDGE DECIDE MODE]
[2026-06-21T15:22:10.227Z] input-hook verdict=skip:phase=aborted phase=aborted source=interactive hasDriver=false text=[JUDGE DECIDE MODE]
[2026-06-21T15:22:16.534Z] input-hook verdict=skip:phase=aborted phase=aborted source=interactive hasDriver=false text=[JUDGE DECIDE MODE]
[2026-06-21T15:22:33.576Z] input-hook verdict=skip:phase=aborted phase=aborted source=interactive hasDriver=false text=[JUDGE DECIDE MODE]
[2026-06-21T15:22:38.624Z] input-hook verdict=skip:phase=aborted phase=aborted source=interactive hasDriver=false text=[JUDGE DECIDE MODE]
```

日志代码位置:`extensions/judge/judge.ts:995-1019`(pi.on("input") 内的开头)

### 数据 2:用户的观察

- 用户确认**没有看到黄字 notify**
- 用户跑了 `/judge run <taskbook>` 进入 driving(他以为是 driving)
- 在 driving 中途发了 2 条插话
- 但日志里**根本没有用户那两条插话的文本**——只有 `[JUDGE DRIVER TASK]` 和 `[JUDGE DECIDE MODE]` 这种内部 prompt

---

## 数据揭示的两个独立问题

### 问题 A:phase 一直是 `aborted`,不是 `driving`

**所有 9 条 input event,phase 都是 `aborted`**。这意味着:
- `state.phase === "driving"` 的判断**从来没成立过**
- hook 一直在 `skip:phase=aborted` 分支放行
- 用户以为自己在 driving,但实际 Judge 已经 aborted

**子问题 A1**:`/judge run` 后 phase 应该是 `driving`,为什么变成了 `aborted`?
- 可能 `/judge run` 启动失败了(比如 loadTaskbook 抛错、createJudgeDriver 失败),但流程没给用户清晰反馈
- 可能 driving 一开始就被某个异常路径 abort 了
- 可能 disableJudge 被意外触发

**子问题 A2**:`input-hook` 里 `text=[JUDGE DRIVER TASK]` / `[JUDGE DECIDE MODE]` 这种是什么?
- 这些是 Judge 内部 prompt 的开头(参见 `extensions/judge/judge-prompts.ts`)
- 说明 Judge/Driver 内部消息触发了 input event
- 这意味着 input event 不只用户输入触发,内部 sendUserMessage 也触发
- **`source=interactive` 这个判断根本不可靠**——内部消息也是 interactive source

### 问题 B:用户的插话根本没进 input hook

日志里**没有用户的插话文本**。只有内部 prompt。这说明:
- 用户的插话可能根本没触发 input event(被别的什么拦截了)
- 或者触发了但被别的 extension 抢先 handled 了
- 或者 input hook 注册得有问题(只在某些情况触发)

---

## 已核实的事实(直接采信)

### F1. 当前代码状态
- 分支: `codex/judge-taskbook`
- HEAD: `aab42fc` 之后有未提交改动(包括用户插话功能的实现 + 诊断日志)
- `npm test`: 358 pass / 0 fail(诊断日志加进去后保持全绿)

### F2. input hook 当前实现

`extensions/judge/judge.ts:995-1040` 左右(pi.on("input"))。完整代码:
```ts
pi.on("input", async (event, ctx) => {
  // [DEBUG 2026-06-21] 诊断日志(写在前面,记录所有 input event)
  try { ... 写 .judge/debug.log ... } catch {}

  if (state.phase !== "driving") return { action: "continue" };
  if (event.source !== "interactive") return { action: "continue" };

  if (!activeDriver) {
    ctx.ui.notify("Driver 未运行,无法转发用户消息。", "warning");
    return { action: "continue" };
  }

  const wrapped = [...].join("\n");  // [USER INTERJECTION during driving] 前缀

  try {
    await activeDriver.sendUserInput(wrapped);
    ctx.ui.notify(`已转发用户插话给 Driver: ${...}`, "info");
  } catch (error) { ctx.ui.notify(..., "warning"); }

  return { action: "handled" };
});
```

### F3. pi input event 定义
`node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts:590-617`:
```ts
export type InputSource = "interactive" | "rpc" | "extension";
export interface InputEvent {
  type: "input";
  text: string;
  images?: ImageContent[];
  source: InputSource;
  streamingBehavior?: "steer" | "followUp";
}
export type InputEventResult =
  | { action: "continue" }
  | { action: "transform"; text: string; images?: ImageContent[] }
  | { action: "handled" };
```

### F4. 全局 ugk 读的就是源码
- `which ugk` → `/c/Users/29485/AppData/Roaming/npm/ugk`
- `readlink .../ugk-agent` → `/e/AII/ugk-core`(符号链接)
- 用户在 `E:\AII\TUI` 跑 ugk,加载的是 ugk-core 源码,改动生效

### F5. Judge 状态机
phase 类型:`"aligning" | "driving" | "delivering" | "aborted" | "done"`(`extensions/judge/judge-state.ts`)
- `enterAligning` / `startDriving` / `enterDelivering` / `abortJudge` / `completeJudge` 是转换函数
- `disableJudge` 会调 `abortJudge`

### F6. handleTaskbookRun 路径(可能 phase 在这里出错)
`extensions/judge/judge.ts` 的 `handleTaskbookRun`:
- loadTaskbook
- setRequirementsSpec + setTaskbookForRun + startDriving
- persistState
- 调 `startActiveJudgeDriver(ctx, loaded.spec)` 启动 driver

---

## 你的调查方向(不限定,但必须覆盖)

### Q1. 为什么 phase=aborted?追踪 phase 转换路径

读 `extensions/judge/judge.ts` 全文,把所有 `state = ...` 改 phase 的地方列出来:
- `enableJudge` / `disableJudge`
- `handleTaskbookRun` / `handleTaskbookEdit`
- `startActiveJudgeDriver` 内的 onFinalize / onAbort / onEscalate
- `pi.on("agent_end")` handler
- `pi.on("session_start")` 的 restoreJudgeState

**追踪**:`/judge run` 用户敲下后,phase 从 `aborted`(初始)→ ?→ ?→ 最终是什么?
- 哪一步把 phase 改成了 `aborted`?
- 是 `startDriving` 没生效?还是 `startDriving` 之后立刻被别的 hook 改了?

**重要**:你可以在每个 phase 转换点加诊断日志(写到 `.judge/debug.log`),然后请用户重现,看 phase 真实流转路径。

### Q2. 为什么用户的插话没进 input hook?

排查:
- 是否有别的 extension 注册了 `pi.on("input")` 并抢先返回 `{action: "handled"}`?(grep 整个 extensions/)
- pi 的 input event 是否只在某些状态触发?(读 pi 源码:input event 的触发条件)
- 用户的插话如果走了主 session,会在主 session 启动一轮 turn——你可以在 `pi.on("agent_start")` 加日志,看主 session 是否被启动

### Q3. `[JUDGE DECIDE MODE]` 这种内部 prompt 为何触发 input event?

这是关键。如果 Judge 内部 sendUserMessage 也触发 input event,那:
- input hook 会收到所有内部消息
- 用 `source=interactive` 区分用户输入根本无效

排查:
- 读 pi 源码 `node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js:715-720`,看 input event 的 emitInput 在什么情况下被调用
- 内部 sendUserMessage 是否也走 emitInput?
- 如果是,有什么字段能区分「真正的用户输入」和「内部消息」?(text 内容?source?其他字段?)

### Q4. 修法是什么?

基于 Q1/Q2/Q3 的根因,给出修法。可能的修法方向(不限定):

**针对 phase=aborted**(子问题 A1):
- 如果是 `/judge run` 启动失败,要在失败点 notify 用户清晰错误,不要静默进 aborted
- 如果是 driving 后立刻被 abort,要找到 abort 路径并修

**针对用户插话没进 hook**(问题 B):
- 如果是别的 extension 拦截,要协调优先级
- 如果是 input event 触发条件问题,要换 hook 点(比如 turn_end、message_end)
- 或者用新机制:注册一个 `/judge say` 命令显式触发,绕开 input event

**针对内部消息触发 input**(子问题 A2):
- 必须找到比 `source=interactive` 更可靠的区分字段
- 或者改用命令式入口(`/judge say xxx`),根本不用 input event

---

## 修复要求

### 必须满足
1. **用户插话能可靠到达 driver**(无论用 input hook 还是别的机制)
2. **用户收到清晰反馈**(notify 或别的)知道插话已转发
3. **`npm test` 全绿**(358 pass),新增测试覆盖修复路径
4. **不破坏现有流程**:Judge 状态机、任务书、edit、ack、reject-pass 等所有已修复功能保持工作
5. 改动最小化,不重构无关代码

### 重要:你可以直接要求用户配合

用户明确说「我会配合他」。你可以:
- 在交接回复里列出「请用户做 X 操作」(比如重启 ugk / 跑 /judge run / 在某时刻打字插话 / 贴日志)
- 用户会执行并把结果贴给你
- 这是迭代调查的循环

---

## 硬约束

| # | 约束 |
|---|---|
| HC1 | **不要猜,读代码确认事实**。改完能用一句话说清「为什么这次对」 |
| HC2 | `npm test` 全绿(358 pass + 新增) |
| HC3 | **不破坏现有功能**(任务书、edit、ack、reject-pass 等) |
| HC4 | bash 走 Git Bash + Linux 语法 |
| HC5 | 改动最小化,不重构无关代码 |
| HC6 | 如果根因在 pi 内部,不要改 node_modules;在我们的代码里正确绕过 |
| HC7 | **如果需要用户配合抓数据,明确告诉用户做什么操作** |
| HC8 | 如果发现当前 input hook 方案根本不可行(比如内部消息无法区分),可以推翻重来,换机制(如 `/judge say` 命令),但必须说明理由 |

---

## 关键文件索引

| 关注点 | 位置 |
|---|---|
| input hook 实现 | `extensions/judge/judge.ts:995-1040` 左右 |
| 诊断日志代码 | `extensions/judge/judge.ts:998-1018` 左右 |
| handleTaskbookRun | `extensions/judge/judge.ts`(搜函数名) |
| startActiveJudgeDriver | `extensions/judge/judge.ts`(搜函数名) |
| JudgeState + 转换函数 | `extensions/judge/judge-state.ts` |
| pi input event 类型 | `node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts:588-617` |
| pi input event emit 实现 | `node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js:715-750` |
| 其他 extension 的 input hook | grep `pi.on("input"` extensions/ |
| 现有测试 | `tests/judge-extension.test.ts`(搜 input 相关) |

---

## 报告格式

1. **根因**(两个问题各自一句话 + 代码/pi 源码 file:line 证据)
2. **修法**(改了什么 + 为什么这次能 work + 设计决策的理由)
3. 如果推翻了 input hook 方案换新机制,说明理由
4. **新增/修改测试** + `npm test` 结果
5. 如果需要用户做验证操作,明确列出步骤
6. 有无偏离本交接文档

---

## 你的第一步

1. 读 `AGENTS.md`
2. 读 `extensions/judge/judge.ts` 的 input hook + handleTaskbookRun + startActiveJudgeDriver
3. 读 `extensions/judge/judge-state.ts` 的所有 phase 转换函数
4. 读 pi 源码的 input event emit 实现(为什么 `[JUDGE DECIDE MODE]` 这种内部 prompt 也触发 input?)
5. 形成对两个问题的根因假设
6. 如果需要更多数据,**列出请用户做的操作**,通过交接回复告知
7. 收到数据后修代码 + 写测试 + `npm test` 全绿
8. 报告

**不确定就停下来问,不要猜。** 本文档是权威。**用户愿意配合抓数据,主动要求他做操作。**
