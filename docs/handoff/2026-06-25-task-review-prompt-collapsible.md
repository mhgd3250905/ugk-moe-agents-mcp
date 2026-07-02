# task review/edit prompt 折叠渲染

> **交接对象**:接手 task 模块的同事。
> **背景**:用户反馈 Task Edit / Review 时,那段超长的 `[TASK REVIEW MODE]` prompt(给 LLM 的复盘指令)被完整渲染在对话里,刷屏且无用。本次让它默认折叠。
> **基线**:`npm test` 491 pass / 0 fail(改动前后都绿)。
> **状态**:已实现 + 单测覆盖,已 commit 推送。UI 折叠效果待用户交互式确认。

---

## 1. 现象与根因

**现象**:`/task edit <name>` 或进入 review 阶段时,一段几十行的 `[TASK REVIEW MODE]` prompt 占满对话区。

**根因**:这段 prompt 通过 `pi.sendUserMessage(text, {deliverAs:"followUp"})` 注入。pi 把 `sendUserMessage` 的内容**强制渲染成完整 user 气泡**,ugk 的 extension API 改不了 user 气泡的折叠行为——user 气泡的渲染归 pi 内部管。

## 2. 关键发现:已有可复用模式

调查发现 task 模块**已有现成的"可折叠 custom message"模式**:

- `task-progress`(`extensions/task/task.ts` 的 `sendTaskProgressMessage` + `renderTaskProgressMessage`)用 `pi.sendMessage({customType, content, display:true, details})` 发消息,配 `pi.registerMessageRenderer` 注册自定义渲染器,实现"折叠显示 N 条 + `(Ctrl+O to expand)` 展开"。

并且 review prompt **本来就有两条注入路径**(故意分离,见 `docs/design/task-extension-spec.md` §2.2 实现注记):

1. **context 主路径**(`before_agent_start` 事件,`display:false`)——只进 LLM context,用户不可见。这是 review agent 拿到完整 prompt 的主通道。
2. **触发路径**(原 `sendUserMessage`)——职责是主动启动 review turn + 把 prompt 显示给用户。

也就是说,`sendUserMessage` 那条路径对 LLM 来说内容是**冗余的**(主路径已注入),它真正的职责是**触发 turn**(`before_agent_start` 是被动触发,不能自己启动 turn)。这条路径才是用户看到刷屏的来源。

## 3. 改动方案

把三处 `sendUserMessage(buildTaskReviewPrompt(...), {deliverAs:"followUp"})` 改成 custom message + 折叠 renderer,复用 `task-progress` 同款模式。

**关键参数**(经 pi 源码验证):
- `sendMessage` 的 `triggerTurn` 默认 falsy,**必须显式传 `triggerTurn:true`** 否则不触发 turn(idle 时走 `agent-session.js` 的 triggerTurn 分支启动 turn,与 `sendUserMessage` 殊途同归到 `_runAgentPrompt`)。
- `deliverAs:"followUp"` 复刻 streaming 时的排队行为。
- `display:true` 必须为 true 才能触发 renderer(`display:false` 时 pi 连组件都不 new)。
- content 仍作为 `role:user` 进 LLM context(`convertToLlm` 的 `case "custom"` 无条件转,见 `messages.js`)。

## 4. 改动清单(单文件 `extensions/task/task.ts`)

- 新增常量 `TASK_REVIEW_PROMPT_TYPE = "task-review-prompt"`。
- 新增 `sendTaskReviewPromptMessage(pi, content, details)`:发 `task-review-prompt` custom message,`triggerTurn:true, deliverAs:"followUp"`。
- 新增 `renderTaskReviewPromptMessage`:折叠态 `▸ [TASK REVIEW MODE] 已注入复盘指令 (N 行)`,展开态显示全文。返回 `Text` 组件。
- `registerTask` 内注册 renderer(紧挨 `task-progress` 注册)。
- 替换三处调用点(review 入口、execute→review 转换、edit/repair 入口 `startTaskbookEdit`),edit 路径在 details 里带 `{mode:"edit"}`。

**没动的**:
- `before_agent_start` 的 `display:false` context 主路径 —— 保持原样。
- 其他十几处 `sendUserMessage` —— 那些是短提示(纠错、追问、闸门拒绝),不存在折叠需求。
- plan-mode / judge 的同类超长 prompt —— 超出本次范围。

## 5. 测试

`tests/task-extension.test.ts` 同步更新:
- 两处 review 触发测试:断言从 `userMessages` 改为 `sentMessages`,验证 `customType === "task-review-prompt"`、`display === true`、`options` 为 `{triggerTurn:true, deliverAs:"followUp"}`。
- 三处 edit/repair 测试:断言 `sentMessages.at(-1).message.content` 含原 prompt 内容。
- cancel 测试:`sentMessages.length === 0`。
- 新增 renderer 折叠自检(在 `/task run shows progress...` 测试内):折叠态含"N 行"不含正文、展开态含正文。

**基线**:全量 `npm test` 491 pass / 0 fail。

## 6. 用户侧效果

Task Edit / Review 进入时:
- 默认看到折叠条:`▸ [TASK REVIEW MODE] 已注入复盘指令 (N 行)`
- 按 `Ctrl+O`(pi 全局展开 toggle)展开看全文,再按折叠。
- LLM 行为不变:仍拿到完整 review prompt,仍正常执行 review。

## 7. 已知限制 / 后续可选

- **折叠是全局 toggle,非单组件点击**:pi 的 `Ctrl+O` 一次展开/折叠所有可展开组件(tool 输出、diff、custom message 等)。per-component 点击展开需要碰 pi 键位,超出范围。全局 toggle 已满足"需要展开再展开"。
- **smoke:task 不覆盖此路径**:`scripts/smoke-task.mjs` 只跑 `/task run` 复用,不触发 review/edit 注入。本次改动的覆盖来自单测(直接断言 sendMessage 出的 custom message)。
- **plan-mode / judge 的同类超长 prompt** 未改。如需统一,可复用本 helper 模式(命名上已隔离 `TASK_REVIEW_PROMPT_TYPE`,不耦合)。
