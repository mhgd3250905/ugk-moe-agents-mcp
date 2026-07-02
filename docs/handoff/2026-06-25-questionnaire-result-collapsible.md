# questionnaire 结果框折叠渲染

> **交接对象**:接手 task/judge 模块的同事。
> **背景**:用户反馈 Task Edit/新建走完 questionnaire 后,结果框(那段 `verify_artifacts: user selected: 1. ...` 逐题明细)默认全量铺屏,占屏无用。本次让它默认折叠。
> **基线**:`npm test` 494 pass / 0 fail(改动前后都绿)。
> **状态**:已实现 + 单测覆盖,已 commit 推送。UI 折叠效果待用户交互式确认。

---

## 1. 现象与根因

**现象**:`/task` 走到 planning/reviewing 的 questionnaire 环节,答完题后工具结果框把每题答案逐行铺出来,占一大段。

**根因**:`questionnaire` 是 ugk 自己注册的工具(`extensions/judge/questionnaire.ts`,judge 和 task 共用这一个),但 `registerTool` **只写了 execute,没写 renderResult**。pi 对没写 renderer 的工具走全量 fallback(`tool-execution.js:109-115` 直接 `new Text(全部 content)`),既不折叠、`Ctrl+O` 全局展开开关也管不到它(`expanded` flag 只在 renderer 内部生效)。

## 2. 关键发现:已有可复用模式

ugk 的 bash/edit 工具**已经**用 `renderResult` 实现了带折叠的渲染(`extensions/builtin-tool-render.ts:66-89`),照搬即可。纯 extension 层,不碰 pi 内部、不碰持久化。

`execute` 本来就返回 `details: { answers, cancelled }`,renderer 直接从 `result.details.answers` 取数据,无需改 execute 的返回结构。

## 3. 改动清单(单文件 `extensions/judge/questionnaire.ts`)

- 抽 `formatAnswerLine(answer)` 公共函数(execute 内联的格式化逻辑和 renderer 展开态完全一样,真实重复,消除它)。
- `registerTool` 补两个字段:
  - **`renderCall(args, theme)`** — call 框一行:`questionnaire  N questions (label1, label2...)`,label 超 3 个截断。
  - **`renderResult(result, {expanded, isPartial}, theme)`** — 四态:
    - `isPartial`(执行中):`Asking...`
    - 折叠态正常:`✓ answered N questions`
    - 折叠态 cancelled:`✗ cancelled after N answers`
    - 展开态:逐题明细,复用 `formatAnswerLine`

**没动的**:
- execute 逻辑、content 文本、details 结构 —— 只把内联格式化换成调 `formatAnswerLine`,行为等价。
- assistant 文本里的 taskbook JSON 代码块折叠 —— 那块需 `message_end` 改持久化 message + custom message 承载 + 同步改 `extractTaskReviewResult` 解析链,风险高,本次明确不做,以后单独评估。

## 4. 测试

`tests/judge-questionnaire.test.ts` 新增 3 个测试(直接调 `tool.renderResult` / `tool.renderCall`,theme 用 passthrough stub):
- 折叠态含 `answered 2 questions`、不含逐题明细;展开态含逐题明细。
- cancelled 态返回 `cancelled after 1 answer`。
- renderCall 显示问题数 + 前 3 个 label。

**基线**:全量 `npm test` 494 pass / 0 fail。

## 5. 用户侧效果

questionnaire 答完后:
- 默认看到一行:`✓ answered N questions`
- 按 `Ctrl+O`(pi 全局展开 toggle)展开看逐题明细,再按折叠。
- LLM 行为不变:execute 的 content 文本(答案原文)照常进 LLM context。

## 6. 已知限制 / 后续可选

- **折叠是全局 toggle,非单组件点击**(同 review-prompt 折叠):pi 的 `Ctrl+O` 一次展开/折叠所有可展开组件。
- **isPartial 态可能不触发**:questionnaire 的 `ctx.ui.select` 是阻塞调用,partial 态实际可能不渲染;但仍保留 `Asking...` 处理作保险。
- **assistant 里的 taskbook JSON 折叠未做**:见 §3,风险高,单独评估。
