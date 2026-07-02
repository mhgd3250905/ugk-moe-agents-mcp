# Bug 调查任务:Judge「继续澄清」红字报错

> 状态: **待调查**
> 日期: 2026-06-21
> 角色: 本文档为 bug 调查交接,供执行 agent 独立调查根因,**不要轻信前人的猜测**
> 工作目录: `E:\AII\ugk-core`(项目根)

---

## 你的任务

独立调查一个 bug 的**真正根因**,不要被前人的猜测带偏。前人(我)已经在这个 bug 上猜错三次,你需要重新从事实出发,找到真正的根因并给出**经过验证的修法**(改代码 + 跑 `npm test` 全绿 + 说明为什么这次是对的)。

---

## Bug 现象

用户在 ugk TUI 里跑 Judge 模式。**Judge aligning 阶段走完**(questionnaire 问完、Judge 产出 RequirementsSpec),弹出菜单 `["委派 driver 执行", "继续澄清", "改需求"]`。用户选「继续澄清」,**TUI 弹出红字错误**:

```
Extension "<runtime>" error: Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.
```

同样的报错也在选「改需求」时出现。**用户明确确认**:是通过点菜单选项触发的(不是在输入框打字)。

---

## 已核实的事实(直接采信,不要重复验证)

### F1. 报错来源
- 报错文本 `Extension "<runtime>" error` 中的 `<runtime>` 是 pi 的内部标签,不是我们的 extension
- 来自 `node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js:1741-1754`,pi 把 extension 调用的 `sendUserMessage` 用 try/catch 包了,错误通过 `runner.emitError({ extensionPath: "<runtime>" })` 抛出
- **关键**:这说明报错确实是 `pi.sendUserMessage(...)` 抛的,不是别的地方

### F2. 报错的直接原因(pi 源码)
`agent-session.js:737-739`:
```js
if (this.isStreaming) {
    if (!options?.streamingBehavior) {
        throw new Error("Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.");
    }
}
```
即:`this.isStreaming === true` 且 `options.streamingBehavior` 为 falsy。

### F3. 触发点(我们的代码)
`extensions/judge/judge.ts` 的 `pi.on("agent_end", ...)` handler 内,有三处调 `pi.sendUserMessage`:
- 「继续澄清」分支(原 judge.ts:1072)
- 「改需求」分支(原 judge.ts:1082)
- C-2 拒绝委派分支(原 judge.ts:1059)

这三处都在 `agent_end` handler 内,且都在 `await ctx.ui.select(...)` / `await ctx.ui.editor(...)` 之后调用。

### F4. agent_end 的语义(pi 源码)
`agent-session.js:688` 注释:
> The agent loop drains both queues before emitting agent_end.

理论上 agent_end 触发时队列已空。但 `isStreaming` 来自 `this.agent.state.isStreaming`(agent-session.js:504),**agent_end 事件触发时点 vs isStreaming 清零时点的关系未确认**——这是关键疑点。

### F5. 全局 ugk 读的就是源码
- `which ugk` → `/c/Users/29485/AppData/Roaming/npm/ugk`
- `readlink /c/Users/29485/AppData/Roaming/npm/node_modules/ugk-agent` → `/e/AII/ugk-core`(符号链接)
- 用户在 `E:\AII\TUI` 跑 ugk,加载的是 ugk-core 源码
- **所以源码改动是生效的**,不是「跑的旧代码」问题

---

## 前人已试过的错误修法(**不要重复尝试**)

### 猜测 1:`{ streamingBehavior: "followUp" }`(失败)
- 改三处 `pi.sendUserMessage(text)` → `pi.sendUserMessage(text, { streamingBehavior: "followUp" })`
- **失败**:用户重启 ugk 后仍报同样错误
- **为什么错**:`sendUserMessage` 的 option 字段不叫 `streamingBehavior`,那是 `prompt()` 的字段

### 猜测 2:`{ deliverAs: "followUp" }`(失败)
- 改三处 → `pi.sendUserMessage(text, { deliverAs: "followUp" })`
- 类型定义(`agent-session.d.ts:382-383`、`extensions/types.d.ts:294-295`)确实显示 `sendUserMessage` 的 option 字段是 `deliverAs`
- 实现链路也对:`sendUserMessage` 内部调 `prompt(text, { streamingBehavior: options?.deliverAs })`(`agent-session.js:1038`)
- **但用户重启后仍报错**——说明 `deliverAs: "followUp"` 传进去了,pi 仍然认为 `isStreaming === true` 且 `streamingBehavior` 没生效,或者还有别的层
- **为什么错(推测)**:可能 agent_end handler 是 async,handler 内 `await ctx.ui.select` 期间 agent 又被别的东西触发进入 streaming;或者 isStreaming 在 agent_end 触发时确实还是 true(pi 内部时序问题)

### 猜测 3:`continueAligningNextTick` helper(尚未验证)
- 包了一层 `queueMicrotask` + `setTimeout(50)` 兜底 + try/catch 降级
- **当前代码状态**(未提交):这个 helper 已加上,三处都换成调 helper
- **用户尚未验证**这个修法是否真的解决了问题
- **疑点**:这只是「延迟 + 错误降级」,如果 pi 的 isStreaming 在 agent_end handler 内始终为 true,延迟到 nextTick 也不一定够

---

## 你需要做的

### 第一步:独立验证根因(不要猜,要证明)

1. **读 pi 源码**,搞清楚:
   - `agent_end` 事件触发时,`this.agent.state.isStreaming` 到底是 true 还是 false?
   - 如果是 true,什么时候变 false?
   - `agent_end` handler 是 async 的,handler 内 `await ctx.ui.select(...)` 等用户操作期间(可能几秒到几分钟),agent 的 state 会发生什么变化?
   - 是否有可能 agent 在 handler await 期间被**别的机制**(比如工具结果返回、队列消息)重新激活进入 streaming?

2. **重点查这几个文件**:
   - `node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js`(主逻辑)
   - `node_modules/@earendil-works/pi-coding-agent/dist/core/agent.js` 或类似的 agent loop 实现
   - `node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/runner.js`(extension 事件分发)

3. **特别关注**:
   - `isStreaming` 的 getter 和它背后的 `agent.state.isStreaming` 何时被设置/清除
   - `_queueFollowUp` / `_queueSteer` 的调用条件
   - `emit({ type: "agent_end" })` 和 isStreaming 清零的先后顺序

### 第二步:给出真正经过验证的修法

基于第一步的根因,改 `extensions/judge/judge.ts`(或必要时也改 plan-mode.ts 的同类调用)。

**修法要求**:
- 不能再靠猜。你要能用一句话说清「为什么这次是对的」,并指出 pi 源码里对应的证据
- `npm test` 必须全绿(当前 348 pass)
- 不破坏现有 `/judge` 流程(回归保护)

### 第三步:报告

报告必须包含:
1. **根因**(一句话 + pi 源码 file:line 证据)
2. **为什么前人三次猜错**(各自的具体原因)
3. **你的修法**(改了什么 + 为什么这次能 work + pi 源码证据)
4. `npm test` 结果
5. **如果有多种修法**,列出 trade-off,说明你选这个的理由

---

## 关键文件索引

| 关注点 | 位置 |
|---|---|
| 报错的 pi 源码 | `node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js:737-739`(throw)|
| pi sendUserMessage 实现 | `agent-session.js:1013-1044` |
| pi prompt() streaming 分支 | `agent-session.js:715-750` |
| pi runtime 错误包装 | `agent-session.js:1741-1754` |
| pi isStreaming getter | `agent-session.js:504-505` |
| pi _queueFollowUp | `agent-session.js:940-955` |
| pi agent_end 发射点 | `agent-session.js:357-358` |
| 我们的三处调用 | `extensions/judge/judge.ts`(搜 `continueAligningNextTick` 和 `sendUserMessage`)|
| 类型定义 | `node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts:290-296, 860-870` |

---

## 硬约束

| # | 约束 |
|---|---|
| HC1 | **不要轻信前人的猜测**,从 pi 源码事实出发重新调查 |
| HC2 | **修法必须有 pi 源码证据**,不能是「我猜这次对了」 |
| HC3 | `npm test` 全绿(348 pass) |
| HC4 | 不破坏现有 `/judge` 流程 |
| HC5 | bash 走 Git Bash,Linux 语法 |
| HC6 | 改动最小化,不要顺手重构无关代码 |
| HC7 | 如果根因在 pi 内部(不是我们的代码),明确指出,不要硬改 pi 源码(node_modules),而是在我们的代码里正确绕过 |

---

## 你的第一步

1. 读 `AGENTS.md`(项目约定)
2. 读本报告的「已核实的事实」和「前人已试过的错误修法」两节,**记住别重蹈覆辙**
3. 打开 `node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js`,从第 504 行(isStreaming getter)开始读,搞清楚 isStreaming 何时清零
4. 追 agent_end 触发时序,确认 handler 执行时 isStreaming 的真实值
5. 给出根因 + 修法 + 报告

**不确定就停下来问,不要猜。**
