# task 使用问题排查修改引导

> **交接对象**:负责修这两个 TUI 使用问题的同事。
> **背景**:subtask 主链路已验证通过。用户 dogfood 发现 2 个明显的交互问题。本文是排查+修改引导,问题 1 根因已定位(可直接改),问题 2 给了根因方向和调试方法(需动态确认)。
> **基线**:`npm test` 451 pass / 0 fail。改完应无回归。
> **不要 commit**,改完留给 review。

---

## 问题 1(根因已定位,可直接改):复盘时无状态反馈

### 现象

任务跑完 → 输入 `/task` 选"复盘上次运行" → 弹输入框问"你觉得刚刚的运行结果有什么问题吗?" → 用户输入复盘疑问回车发出 → **界面没有任何提示,不知道当前什么状态,发消息也没反应** → 过一会儿才更新复盘结果。

### 根因(已确认)

`extensions/task/task.ts:1191-1198`,`review-last-run` 分支:

```typescript
if (action === "review-last-run" && lastTaskRunReview) {
    const userObservation = await ctx.ui?.input?.("你觉得刚刚的运行结果有什么问题吗?", "");
    const result = await dispatchTaskRunReviewer({        // ← 这里同步 await,阻塞十几秒
        runContext: lastTaskRunReview.content,
        userObservation: userObservation ?? "",
    }, { cwd: cwdOf(ctx) });
    ctx.ui.notify(result.summary, result.ok ? "info" : "warning");  // ← 跑完才 notify
    return;
}
```

`dispatchTaskRunReviewer`(`task-run-reviewer.ts:41`)会 spawn 一个 reviewer 子进程(`runSingleAgent` → `pi --print`),可能跑十几秒。**这期间没有任何 UI 反馈**:
- 没有"正在分析复盘"的提示
- 没有 spinner / working indicator
- `setStatus` 没设状态

用户看到的就是"发出去了但没反应"。实际是在等 reviewer 子进程返回。

### 对比:handleTaskRun 是怎么处理长任务的

`handleTaskRun`(`task.ts:628`)跑 worker 时用了三层反馈:
1. `setTaskRunWidget(ctx, [...])` —— widget 显示"运行中... 尝试 N/M"
2. `onUpdate` 回调流式更新进展
3. 状态栏 `setStatus`

review-last-run 这三层都没有。这是 UX 不一致,也是问题根因。

### 修改要求

给 `review-last-run` 分支加上等待期间的反馈。**最小改动方案**(推荐):

```typescript
if (action === "review-last-run" && lastTaskRunReview) {
    const userObservation = await ctx.ui?.input?.("你觉得刚刚的运行结果有什么问题吗?", "");
    // ↓ 新增:进入分析前的反馈
    ctx.ui.setStatus?.("task-mode", "📋 复盘分析中...");
    ctx.ui.setWorkingMessage?.("正在复盘上次运行,reviewer 分析中...");
    try {
        const result = await dispatchTaskRunReviewer({
            runContext: lastTaskRunReview.content,
            userObservation: userObservation ?? "",
        }, { cwd: cwdOf(ctx) });
        ctx.ui.notify(result.summary, result.ok ? "info" : "warning");
    } finally {
        // ↓ 新增:结束时恢复
        ctx.ui.setStatus?.("task-mode", undefined);
        ctx.ui.setWorkingMessage?.();
    }
    return;
}
```

**机制说明**(查 `node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts`):
- `ctx.ui.setWorkingMessage(text)` —— 设置流式期间显示的 loading 文本,这是 pi 官方的"正在工作"提示机制(types.d.ts 的 ExtensionUIContext)。调 `setWorkingMessage()` 无参恢复默认。
- `ctx.ui.setStatus(key, text)` —— 状态栏文本,`task-mode` 是 task 模块已在用的 key。

**进阶方案**(可选,体验更好):如果 `setWorkingMessage` 在非流式(命令 handler)场景下不显示,改用 widget:

```typescript
// 用 widget 模拟 handleTaskRun 的进度反馈
ctx.ui.setWidget?.("task-run-view", [
    `📋 正在复盘 taskbook "${lastTaskRunReview.taskbookName}"...`,
    "reviewer 分析中,请稍候",
], { placement: "aboveEditor" });
try {
    // ... dispatchTaskRunReviewer ...
} finally {
    ctx.ui.setWidget?.("task-run-view", undefined);
}
```

**注意**:`setWorkingMessage` 是否在命令 handler(非 agent 流式)中生效需要实测确认。如果实测不显示,用 widget 方案(`setWidget` 是确定在所有场景生效的,handleTaskRun 就靠它)。**优先用 widget 方案,因为已有先例可循。**

### 测试

`review-last-run` 这条路径目前**没有自动化测试**(它是 UI 交互,难 mock)。但可以加一个轻量测试验证"调用前后 status/widget 被正确设置和清理":

参考 `tests/task-extension.test.ts` 的 `makeCtx`,它的 ctx 已 mock 了 `setStatus`/`setWidget`(收集到 `statusCalls`/`widgetCalls`)。可以断言 review-last-run 触发后 `widgetCalls` 或 `statusCalls` 有"复盘分析中"的记录。但**这条路径依赖 `dispatchTaskRunReviewer` spawn 真子进程**,测试里要 mock——参考 `setTaskWorkerRunnerForTests` 模式,看 `task-run-reviewer.ts` 是否有 `setTaskRunReviewerRunnerForTests`(有,见 task-run-reviewer.ts:18)。

**最小验证**:手动 TUI 实测(改完后在 TUI 里跑一遍复盘,确认等待期间有提示)。

---

## 问题 2(根因方向已给,需动态调试定位):表格滚动到顶部

### 现象

TUI 渲染 markdown 表格时,**滚动位置滑动一定会滚到最顶部**(必现)。其他 markdown 元素(代码块、列表、普通文本)滚动正常,只有表格触发。

### 根因方向(高度怀疑,需动态确认)

**表格渲染导致内容高度变化,触发父容器重新测量,滚动状态被重置到顶部。**

证据链:
1. 表格渲染在 `node_modules/@earendil-works/pi-tui/dist/components/markdown.js`,`renderTable`(line 509)。
2. 表格有特殊路径:`renderTable:520` 当宽度不够时 fallback 到原始 markdown 文本(`wrapTextWithAnsi(token.raw, availableWidth)`)——**这会导致行数在宽度变化时剧变**。
3. 表格 cell 换行(`wrapCellText` line 502)也随宽度变化产出不同行数。
4. 当用户滑动时,如果触发了 markdown 重新渲染(width 变化或重排),表格产出的行数变化 → 父消息容器内容总高度变化 → **滚动偏移(scrollTop/offset)基于旧行数,重算后失效,被重置到 0(顶部)**。

这是典型的"虚拟列表/滚动容器在内容高度变化时没锚定滚动位置"的问题。

### 必读代码(排查对象)

- `node_modules/@earendil-works/pi-tui/dist/components/markdown.js:509-651` —— `renderTable` + `wrapCellText`,表格行数计算
- `node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/assistant-message.js` —— 谁渲染 markdown(找它怎么把 markdown 行交给滚动容器)
- 持有滚动状态的代码:**还没定位到具体文件**。滚动偏移(scrollTop / offset / viewport top)在管理消息列表的外层,需动态调试找到。

### 调试方法(关键,光静态读不够)

这个问题**必须动态调试定位**,静态读代码无法确认滚动状态到底存在哪、什么时候被重置。步骤:

1. **确认滚动状态持有者**:在 interactive mode 启动后,grep 消息列表渲染处。线索:谁持有"当前滚动到第几行"的变量。可能在 `interactive-mode.js` 或专门的 scroll/chat 组件。用 `grep -rn "offset\|scrollTop\|viewport\|userScroll" node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/` 找(我已查 interactive-mode.js 没有,可能在 import 的子模块)。

2. **加日志确认触发点**:在怀疑的滚动重置点(找到持有者后)加 `console.error` 日志,打印"滚动被重置"时的调用栈和触发条件。然后在 TUI 里复现:渲染含表格的消息 → 滚动 → 看日志什么时候触发重置。

3. **二分确认**:如果怀疑是 `renderTable` 的 fallback/wrap 导致行数变化,临时把表格渲染改成固定行数(比如禁用 fallback、固定 cell 不换行),看滚动 bug 是否消失。消失则确认根因是行数不稳定。

### 修改方案(定位根因后)

**这取决于根因落在哪一层:**

**情况 A:滚动重置在 pi-tui 内部(markdown 之外)**
→ 必须走 patch 机制(`bin/ugk-session-view-patch.js`),hook 持有滚动状态的方法,在内容高度变化时保持滚动锚点。参考现有 patch 怎么 hook `InteractiveMode` prototype。

**情况 B:表格行数不稳定导致重排**
→ 这是 markdown.js 的 bug。但 markdown.js 在 node_modules,不能直接改(升级会丢)。两条路:
- B1:patch `Markdown.prototype.renderTable`,稳定行数输出(如固定列宽、禁用 fallback)。
- B2:向 pi 上游报告 bug(根因层在 pi-tui,正解是上游修)。

**情况 C:滚动状态本身有 bug(不锚定)**
→ 这是 pi-coding-agent 或 pi-tui 的滚动容器 bug,patch 难修(滚动逻辑复杂)。优先向上游报告 + 在 UGK 层做 workaround(如检测到表格时不启用滚动锚定,或表格强制折叠)。

### 建议处理顺序

1. **先用调试方法定位滚动状态持有者**(这是阻塞点,定位不了就没法修)
2. 根据根因落在 A/B/C,选对应方案
3. 如果根因在 pi-tui/pi-coding-agent 深处且 patch 难修,**在交接总结里如实说明,作为已知遗留向上游报告**,不要硬改导致 regression

### 风险提示

- 问题 2 的根因层在 node_modules(pi-tui / pi-coding-agent),改这些有升级丢失风险,优先 patch(`bin/ugk-*.js`)而非直接改 node_modules
- 滚动/重排逻辑复杂,**不要在没有动态复现的情况下凭猜测改**,容易引入新 bug(比如其他 markdown 元素的滚动也被影响)
- 如果发现是上游 bug 且 UGK 层无法干净 patch,**跳过,在总结里说明**,不要为了修一个表格滚动搞坏整个消息滚动

---

## 修改顺序建议

1. **问题 1** —— 根因清楚,直接改,~15 分钟(加 widget 反馈 + 可选测试)
2. **问题 2** —— 先花时间动态调试定位,可能 1-2 小时;定位后看是否能干净 patch,不能就如实上报遗留

两个问题独立,可以分开做。

---

## 不要做的事

- 不要直接改 `node_modules/` 里的文件(改了升级丢,且违反 npm 规范)。所有 node_modules 修复走 `bin/ugk-*.js` patch
- 不要在没动态复现的情况下凭猜测改问题 2
- 不要 commit
- 不要"顺手"改无关代码

---

## 完成后

在本文末尾追加"实际完成结果",记录:
- 问题 1:用了 widget 方案还是 setWorkingMessage 方案,实测等待期间是否有反馈
- 问题 2:滚动状态持有者定位到哪个文件/方法,根因是 A/B/C 哪种,是否修了还是上报遗留
- `npm test` 数
- 任何偏差

---

## 实际完成结果(2026-06-24)

### 问题 1:已修

- 采用 widget 方案,在 `review-last-run` 调用 reviewer 前显示:
  - `📋 正在复盘 taskbook "<name>"...`
  - `reviewer 分析中,请稍候`
- reviewer 完成或失败后用 `finally` 清理 widget,避免残留等待态。
- 自动化覆盖:复用 `/task run shows progress and reviews last run with a clean reviewer` 测试,断言复盘路径会写入包含"正在复盘"的 widget。
- 已跑 `node --test tests/task-extension.test.ts`:39 pass / 0 fail。

### 问题 2:定位为上游 pi-tui 遗留,本轮不硬修

- 滚动/视口状态持有者定位到 `node_modules/@earendil-works/pi-tui/dist/tui.js`:
  - `TUI.previousViewportTop` 持有上一轮 viewport top。
  - `TUI.doRender()` 根据 `previousViewportTop`、终端高宽、渲染后行数决定 diff render 还是 `fullRender(true)`。
  - `fullRender(true)` 会输出 `ESC[2J ESC[H ESC[3J` 清屏并清 scrollback,然后把 `previousViewportTop` 重算为 `Math.max(0, bufferLength - height)`。
- 动态探针结果:同一 Markdown 表格在 90 列和 45 列之间切换时,渲染行数从 9 变 14;`doRender()` 触发带 `ESC[3J` 的 full render,`previousViewportTop` 从 0 变为 2,再切回 90 列时再次 full render 并回到 0。
- 根因归类:偏情况 C(渲染器/视口状态没有保留用户滚动锚点),情况 B(表格随宽度/fallback 产生行数变化)是触发因素。
- 未修原因:修复点在 `pi-tui` 的全局重绘/scrollback 策略或 Markdown table 稳定高度策略。直接改 `node_modules` 不可接受;在 UGK 层 monkey patch `TUI.doRender()` 或 `Markdown.renderTable()` 都容易影响所有消息渲染和终端 resize 行为。本轮按要求作为已定位上游遗留上报。

### 偏差

- 完整验证:已跑 `npm test`,451 pass / 0 fail,与基线一致。
- 问题 1 未做真实 TUI 手动 dogfood,但已有命令 handler 自动化测试验证 widget 写入与 reviewer mock 链路。
- 问题 2 做了最小动态探针确认状态持有者和 full render 行为,未在真实 TUI 会话里改 node_modules 加日志。
