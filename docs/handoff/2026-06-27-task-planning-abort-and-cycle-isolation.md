# task planning/reviewing 中断与周期隔离修复

> 日期：2026-06-27
> 关联提交：`a8c41be`、`8a859fc`、`724b676`

## 背景：一条贯穿的根因

本次连续排查 task 的 planning/reviewing 阶段，表面是三个独立 bug，底层共享同一个机制：

> **task 的 `agent_end` handler 只会"没产出合法产物就发 followUp 让 agent 重来"，而 pi 的 `_handlePostAgentRun`（session.cjs:688-690 注释明示）会自动 drain 队列里的 followUp 并 `continue()` 起新一轮。**

只要 task 判错"该不该停"，就会把 agent 拉起来反复转。ESC、问卷取消、上下文污染，都是这个机制的不同触发面。三处修复的核心都是：**让 task 学会识别各种"该停下"的真实信号**，而不是无脑续命。

---

## 缺陷一：ESC abort 退出不了 planning/reviewing

> commit `a8c41be`

### 现象

task 的 planning 阶段，按 ESC 后 agent 反复自转、退出不了。

### 根因

ESC 走 `session.abort()` → `abortController.abort()` → pi 的 `handleRunFailure`（dist-agent.cjs:330-340），产出的 assistant message 是 `{content:[{text:""}], stopReason:"aborted"}` —— **空内容 + 结构化中止信号**。

task 的 `isCancelledAssistantText` 只认文本正则，空串恒不匹配（`/.../i.test("")` 恒为 false），把 ESC 误判成"没产出 spec"，发 followUp。pi 的 `_handlePostAgentRun` 自动 drain 队列续命，agent 起死回生。

**ESC 本身每次都生效了**，是被 followUp 自动续命抵消。

### 修复

`isCancelledAssistantText(text)` → `isCancelledAssistant(message)`，优先看结构化的 `message.stopReason === "aborted"`（可靠信号），文本正则退为兜底（questionnaire 取消 + 兼容既有纯文本测试）。planning、reviewing 两个调用点统一改传 message。

一个判定点修好，两条路径都堵住。

---

## 缺陷二：问卷取消后 agent 自循环重跑

> commit `8a859fc`

### 现象

questionnaire 里按 ESC 取消，agent 反思后又调一遍问卷，循环。

### 根因

questionnaire 取消是 **tool result**（`User cancelled the questionnaire`），不是 abort 信号。assistant 之后正常输出"已取消，等你指示"然后停下。但 task 的 `agent_end` 把"没产出 Spec"一律当"该重试"，发 followUp；pi 自动续命，agent 又被 prompt 强制调问卷（task 的 ALIGN_PROMPT 用 MANDATORY 措辞逼它非调问卷不可）—— 死循环。

### 修复

1. **prompt**（task-prompts.ts）：questionnaire 被取消时停下等指令，不自循环重开、不猜答案。
2. **task.ts**：识别"本次 turn 里有 questionnaire 取消"，planning/reviewing 两处都停下、不发 followUp。

---

## 缺陷三：新建 task 复用上个 task 的对话污染重建

> commit `8a859fc`

### 现象

task 里（可能乱填）答完问卷后退出，再 `/task new` 建同样任务，agent 跳过问卷，直接引用上个 task 的答案吐 Spec。

### 根因

task 对话上下文没按周期隔离：
- `abortTask`（task-state.ts:131）/ `enableTask`（task.ts:1460）**只改 state，完全不碰对话历史**。
- `filterTaskContextMessages` 只删 task 自注入的 context message（task-plan-context），**保留所有普通对话**（上个 task 的问卷答案、Spec）。
- 新建 task 时，上个 task 的问答残留在 session，agent 在 context 里看得到 → 跳过问卷。

### 用户需求（B2）

- 主 session 对话不动（用户平时聊的留着）
- 上个 task 的问答清掉（乱填的答案别污染重建）
- **用户退出 task 后的闲聊保留**（常先对话探寻细节再进 task）

### 修复（数据层隔离，不是 prompt 哄）

复用 pi 已有能力，不绕框架、不开新 session（会清掉用户平时聊的，且 ctx 失效复杂）：

1. **"止"边界**：新增 `TASK_CONTEXT_END_TYPE = "task-context-end"`。exit/stop/abort 时用 `pi.sendMessage({customType, content, display:false}, {triggerTurn:false})` 注入一条**静默标记**（进 LLM context、可过滤、TUI 不显示、不触发新轮次）。
2. **"起"边界**：复用已有的 `TASK_PLAN_CONTEXT` / `TASK_REVIEW_CONTEXT`（每次进 planning/reviewing 由 `before_agent_start` 注入，持久化、跨 session 复活）。
3. **重写 `filterTaskContextMessages`**：成对定位（起 plan/review-ctx … 止 task-context-end）的**已结束周期**整体滤掉；**当前未闭合周期**（进行中的 task）保留；**止之后、新起之前的闲聊**保留。保留原语义：同周期内多条起边界清掉旧的。

**为什么是真修复**：在数据层把上个 task 的对话从 agent 视角切掉，agent 根本看不到答案 → 自然重新调问卷。session 历史不动（B2），往上翻还能看到，只是新 task 的 agent 戴了眼罩。

### 实测验证（session 019f07bd）

新建 task 用了**新**问卷答案（非上次乱填的），证明上个 task 污染被隔离；问卷取消后 agent 正确停下。

---

## 审核修复：取消信号被后续 tool 掩盖（缺陷二的复发隐患）

> commit `724b676`

### 问题

`lastMessageIsQuestionnaireCancellation` 只看**最后一条 toolResult**。如果问卷取消后 agent 又调了别的 tool（如 `read` 探索），新 toolResult 会**盖掉取消信号**，task 又误判"没产物该重试"，死循环原样复发。

review 阶段尤其危险：agent 取消 skill design gate 问卷后，很可能去 `read` 现有 taskbook 再停下。

### 修复

改为 `hasQuestionnaireCancellation`：**扫整条消息序列**找取消信号，而不是只看最后一条。取消是不可恢复语义 —— 一旦取消，本次 turn 产物就该作废，不管后面 agent 干了啥。顺带复用 `getTextContent` 去掉重复的文本提取逻辑。

---

## 测试

`npm test`：437/437 全绿。

新增回归（均 fail-if-broken）：
- planning/reviewing ESC abort（空 content + stopReason aborted）不触发 retry
- planning/reviewing questionnaire cancellation 不触发 retry
- **问卷取消被后续 tool 掩盖时仍正确停下**（审核修复）
- **reviewing 过滤 planning 起边界但保留当前周期**（跨阶段，覆盖对方阶段分支）
- 上个 task 退出后新建，其问答被滤掉、退出后闲聊 + 新 task 保留
- 首次未退出：当前周期完整保留
- reviewing 周期对称隔离
- exit 注入边界：customType/display/triggerTurn 正确

---

## 调查教训（写给下次）

1. **症状 → 猜测 → 补丁**是病。第一次给的 ESC 诊断是两头押注（content 可能空也可能含 aborted），被用户戳破"你确定是根因"。逼到 pi 内部 trace 实证（`_handlePostAgentRun` 注释 + `handleRunFailure` 写死的 message 结构）才定位真因。中间几度靠 session 实测避免了基于错误假设写代码。

2. **pi 的 followUp 续命是显式设计**（session.cjs:688-690 注释明示："messages queued by agent_end extension handlers need a continuation"）。task 作为 extension **不该在 abort/取消场景塞 followUp** —— 那等于主动触发这个续命机制。

3. **中断的可靠信号是结构化的**（`stopReason`、tool result 的 customType），不是 assistant 文本。文本正则只能兜底，因为 abort 产物是空串。

4. **对话上下文要按 task 周期隔离**，否则上个 task 的答案（尤其乱填的）会污染重建。隔离用 pi 已有的 custom_message + context 事件过滤能力，不碰 session 生命周期。

---

## 已知遗留（诚实保留）

- **compaction 截断风险**：session 压缩若恰好截掉 `task-context-end` 止边界，那段 task 问答会"看似未闭合"而保留。代码留 `// ponytail:` 注释，未观测到，真遇到加 timestamp 兜底。
- 两个 commit 在本地 main，未 push origin。

## 关键文件

| 关注点 | 文件 |
|---|---|
| 中断判定（ESC/取消） | `extensions/task/task.ts` — `isCancelledAssistant`、`hasQuestionnaireCancellation` |
| 周期隔离过滤 | `extensions/task/task.ts` — `filterTaskContextMessages` |
| 止边界注入 | `extensions/task/task.ts` — exit/stop/abort 分支（约 1856 行） |
| 取消语义 prompt | `extensions/task/task-prompts.ts` — TASK_ALIGN_PROMPT |
| 测试 | `tests/task-extension.test.ts` |
