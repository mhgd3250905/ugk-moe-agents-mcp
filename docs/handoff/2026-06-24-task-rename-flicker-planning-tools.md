# 修改报告:task 重命名 / 输入闪烁 / planning 工具集

> **提交对象**:代码实现同事
> **报告日期**:2026-06-24
> **改动范围**:3 个独立问题,优先级 P2 / P2 / P3,可分 3 个 commit
> **风险等级**:中(问题 1 涉及目录改名 + 历史迁移)、低(问题 2、3)
> **测试基线**:开工前确认 `npm test` 全绿(当前 451 pass / 0 fail)

---

## 总览

| # | 问题 | 根因定位 | 难度 | 建议 |
|---|---|---|---|---|
| 1 | taskbook 无法改名 | 名字 = 目录名 + `taskbook.json:name`,无 rename 动作 | 中(有迁移细节) | 做,见方案 A |
| 2 | questionnaire 弹出时输入文字闪烁 | pi runtime 的 `Working...` spinner(loader)在工具执行期持续 80ms 重渲染,与扩展 overlay 抢渲染 | 低(单点停 spinner) | 做,见方案 B |
| 3 | planning 阶段报"只能只读" | `TASK_PLANNING_TOOLS` 写死成只读集,是有意为之 | 低(改常量) | 做,见方案 C(需用户确认范围) |

---

## 问题 1:taskbook 重命名功能

### 1.1 用户场景

> 我创建了一个 task 比如 `toolify-top20`,后来不断优化实际功能变成了 `toolify-topN`,可是我现在无法修改名字,旧名字明显不准确。

### 1.2 根因(已通过代码确认)

名字在系统里有 **两处真相源**,且互相绑定:

1. **目录名**:`<root>/<name>/`(`task-book.ts:53` `taskDir()`)
   - user scope:`~/.pi/agent/tasks/<name>/`
   - project scope:`<cwd>/.tasks/<name>/`
2. **`taskbook.json` 的 `name` 字段**(`task-book.ts:26`、`isTaskbook()` 校验它)

关键:**`spec.json` / `skill.md` / `verify.mjs` / `contract.json` 内部不存名字**(`task-spec.ts` 已确认纯数据)。所以改名 = 改目录名 + 改 JSON 一行,**内容文件零修改**,副作用面小。

### 1.3 当前命名的其他出现点(全部是**瞬时状态**,不是真相源,改名不用同步)

| 位置 | 性质 | 改名影响 |
|---|---|---|
| `state.taskbookName`(`task-state.ts:25`) | 单次会话内存状态,`appendEntry` 持久化但只在该次创造流里有意义 | 无,下次 `/task` 进来重新选 |
| `.tasks/runs/task-<name>-<ts>/`(`task.ts:677、799、997`) | 一次性 run 临时目录,**不按名字反查**,每次 run 各自独立 | 无,旧 run 目录可留可清,不影响加载 |
| `lastTaskRunReview.taskbookName`(`task.ts:74`) | 内存变量,会话结束即失效 | 无 |
| prompt 文案 / notify 文案里展示的名字 | 运行时拼接,读的是 `loaded.taskbook.name` | 自动跟随 |

### 1.4 实现方案(方案 A:`rename` 动作)

**新增函数 `extensions/task/task-book.ts`**:

```typescript
export async function renameTaskbook(
    scope: "user" | "project",
    cwd: string,
    oldName: string,
    newName: string,
): Promise<Taskbook> {
    if (!isValidTaskbookName(newName)) throw new Error(`Invalid taskbook name: ${newName}`);
    if (oldName === newName) throw new Error("新名字与旧名字相同");
    const oldDir = taskDir(scope, cwd, oldName);
    const newDir = taskDir(scope, cwd, newName);
    const loaded = await loadFromDir(scope, oldDir);
    if (!loaded) throw new Error(`Taskbook not found: ${oldName}`);
    // 目标名已存在 → 拒绝(避免覆盖)
    if (await loadFromDir(scope, newDir).catch(() => null)) {
        throw new Error(`名字 "${newName}" 已存在,拒绝覆盖`);
    }
    // 1. 先把目录搬过去
    await mkdir(path.dirname(newDir), { recursive: true });
    await rename(oldDir, newDir);  // node:fs/promises 的 rename
    // 2. 改 taskbook.json 的 name + updatedAt,保留 createdAt / runs[]
    const taskbook: Taskbook = {
        ...loaded.taskbook,
        name: newName,
        updatedAt: new Date().toISOString(),
    };
    await writeJson(path.join(newDir, "taskbook.json"), taskbook);
    return taskbook;
}
```

> import:`rename` from `node:fs/promises`,`loadFromDir` 已是模块私有函数可直接复用。

**接线 `extensions/task/task.ts`**:

1. `MENU_TO_ACTION` 加 `["重命名 taskbook", "rename"]`(`task.ts:103-128`)。
2. `getTaskCommandMenuOptions` 的 idle 分支(`task.ts:154`)把 "重命名 taskbook" 插到 "删除 taskbook" 前面。
3. 新增 `handleTaskRename`:

```typescript
async function handleTaskRename(ctx: any, name: string | undefined, tokens: string[]): Promise<void> {
    const oldName = await chooseTaskbookName(ctx, name);
    if (!oldName) return;
    const loaded = await loadTaskbook(cwdOf(ctx), oldName);
    if (!loaded) { ctx.ui.notify(`taskbook "${oldName}" 不存在`, "warning"); return; }
    const newName = await ctx.ui?.input?.(`重命名 "${oldName}" 为`, oldName);
    if (!newName?.trim() || newName.trim() === oldName) { ctx.ui.notify("已取消重命名。", "info"); return; }
    try {
        await renameTaskbook(loaded.scope, cwdOf(ctx), oldName, newName.trim());
        ctx.ui.notify(`taskbook "${oldName}" 已重命名为 "${newName.trim()}"。`, "info");
    } catch (error) {
        ctx.ui.notify(`重命名失败: ${error instanceof Error ? error.message : String(error)}`, "error");
    }
}
```

4. `handleTaskCommand` 里(`task.ts:1304` 附近,`if (action === "delete") ...` 那一行后)加:

```typescript
if (action === "rename") return await handleTaskRename(ctx, name, tokens);
```

5. `/task rename <old> <new>` 直传也支持:`parseTaskCommand`(`task.ts:317`)已经把 `tokens[1]` 当 name。要让 `<new>` 作为新名,可在 `handleTaskRename` 里读 `tokens[2]`:

```typescript
const newName = tokens[2]?.trim() || await ctx.ui?.input?.(...);
```

### 1.5 必须注意的坑

- **跨 scope 不允许**:user 和 project 同名时加载优先 project(`task-book.ts:182-185`)。重命名只在**原 scope 内**改目录,不接受 `--user`/`--project` 跨 scope。`scope` 用 `loaded.scope`,忽略 `tokens` 里的 scope flag(或显式报错)。
- **runs[] 历史保留**:`loaded.taskbook.runs` 随 taskbook.json 一起带走,不要清。
- **不要用 copy+delete**:`fs.rename` 原子且快;copy+delete 在 verify.mjs 被占读时(Windows)会失败。
- **Windows 跨盘符 rename 会报 EXDEV**:user scope 在 `C:`、project scope 也基本在 `C:`,同 scope 内 rename 同盘,无此问题。但保险起见 catch EXDEV 时 fallback 到 `cp -r` + `rm`(或用 `fs.cp` + `rm`)。

### 1.6 测试要求(`tests/task-extension.test.ts` 或新文件)

- `/task rename a b` 成功:`listTaskbooks` 不再有 a,有 b;`taskbook.json.name === "b"`;`runs[]` 数量不变;`createdAt` 不变、`updatedAt` 变。
- 新名已存在 → 拒绝,旧 taskbook 原样不动。
- 新名非法(`toolify topN`、`a/b`)→ `isValidTaskbookName` 拒绝。
- 新名与旧名相同 → 取消 / 报错,不写盘。

---

## 问题 2:questionnaire 弹出时输入文字闪烁

### 2.1 用户场景

> Working 一直在运行,然后我输入文字的时候文字会一直闪烁,体验很糟糕。

```
⠋ Working...          ← spinner 一直转
─────────────────────
 PTT 论坛有多个板块...
─────────────────────
你帮我找吧我也不熟悉   ← 用户在这里打字,闪烁
```

### 2.2 根因(已通过 pi runtime 源码确认)

**不是** task 扩展的 bug,是 pi runtime 的 **Working spinner 与扩展 overlay 共存的渲染冲突**,链路如下:

1. agent loop 跑工具时,`message_start`/`retry` 等事件里 `statusContainer.addChild(this.loadingAnimation)`(`pi-coding-agent/dist/modes/interactive/interactive-mode.js:1374-1375、2242-2244`),这个 `Loader` 实例每 **80ms** `setInterval` 调 `ui.requestRender()`(`pi-tui/dist/components/loader.js:54-57`)。
2. 工具内部调 `ctx.ui.select` / `ctx.ui.input` → `showExtensionSelector` / `showExtensionInput`(`interactive-mode.js:1659、1710`),把 `ExtensionSelectorComponent` / `ExtensionInputComponent` 加进 **`editorContainer`** 并 `setFocus` 到它。
3. 此时屏幕上同时存在:① `statusContainer` 里 80ms 跳一次的 spinner 行;② `editorContainer` 里用户正在打字的 Input。
4. spinner 每跳一帧,`requestRender` → `doRender`(`pi-tui/dist/tui.js:475-522`,节流 `MIN_RENDER_INTERVAL_MS = 16ms`)→ 全树 `render(width)` 重新生成行数组 → 逐行 diff(`tui.js:1046-1059`)→ 命中 spinner 那行变了 → 重画。
5. 每次重画末尾 `positionHardwareCursor`(`tui.js:1288-1317`)会重新 `hideCursor`/`showCursor` + 移动硬件光标到 Input 的列。**12.5 次/秒的光标重定位 + 同步输出块**,与用户的击键/IME 合成竞速,肉眼即表现为"输入在闪"。

> 关键判据:overlay 的 Input 本身只在按键时 update,不主动 requestRender;**是 spinner 把它拖进了高频重渲染**。停掉 spinner 就不闪。

### 2.3 实现方案(方案 B:overlay 打开时停 Working spinner)

这是 **pi runtime 层** 的修法,改 `pi-coding-agent`。UGK 固定 pi 版本(见 AGENTS.md"运行时发行策略"),所以改法是**在 UGK 仓库内 vendor 一个 patch,或向上游 pi 提 PR**。考虑到 UGK 的工作模式,推荐:

**方案 B-1(推荐,最小改动):在 `showExtensionSelector` / `showExtensionInput` / `showExtensionEditor` / `showExtensionConfirm` 打开 overlay 前 `setWorkingVisible(false)`,关闭后恢复。**

改 `node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/interactive-mode.js`(及对应 `.d.ts` 如有):

```javascript
showExtensionSelector(title, options, opts) {
    return new Promise((resolve) => {
        // ... 原有 abort 处理
        const wasWorkingVisible = this.workingVisible;
        if (wasWorkingVisible) this.setWorkingVisible(false);   // ← 新增:停 spinner
        this.extensionSelector = new ExtensionSelectorComponent(title, options, (option) => {
            opts?.signal?.removeEventListener("abort", onAbort);
            this.hideExtensionSelector();
            if (wasWorkingVisible) this.setWorkingVisible(true); // ← 新增:恢复
            resolve(option);
        }, () => {
            opts?.signal?.removeEventListener("abort", onAbort);
            this.hideExtensionSelector();
            if (wasWorkingVisible) this.setWorkingVisible(true); // ← 新增:恢复
            resolve(undefined);
        }, { /* ... */ });
        // ... 原有 addChild / setFocus / requestRender
    });
}
```

`showExtensionInput` / `showExtensionEditor`(`interactive-mode.js:1710、1748` 附近)同样在 Promise 头尾各加一对。`showExtensionConfirm` 内部调 `showExtensionSelector`,自动覆盖,无需单独改。

> `setWorkingVisible(false)`(`interactive-mode.js:1365-1378`)会 `stopWorkingLoader()` 并 `statusContainer.clear()`,overlay 关闭后 `setWorkingVisible(true)` 重建 spinner——agent 还在跑(`session.isStreaming` 仍为 true),重建逻辑会自然恢复转圈。

**方案 B-2(更彻底,改 pi-tui):让 `Loader` 在被 `statusContainer` 之外的 focusable overlay 抢焦点时自停。** 风险大,涉及焦点状态机,不推荐本次做。

### 2.4 为什么不在 task 扩展里修

task 扩展调的是 `ctx.ui.select/input`,看不到也不该操作 `loadingAnimation`(那是 interactive-mode 的私有状态)。修在 runtime 层一处,所有扩展(questionnaire、judge、cdp、mcp confirm)全部受益。

### 2.5 落地约束

- **UGK 固定 pi 版本**:改 `node_modules` 后,UGK 必须发新版本锁定该 patched pi;不能让用户 `pi update`。流程见 AGENTS.md"运行时发行策略"。
- 若团队倾向不碰 `node_modules`,可**向上游 pi 仓库提 issue + PR**(带上本报告 2.2 的根因定位和 `interactive-mode.js` 行号),等 pi 发版后 UGK 升级依赖。建议两手都做:先提上游 issue,本地 patch 兜底。

### 2.6 验证

- 手动:跑任一 task `/task new` → planning 阶段触发 questionnaire → 打字不闪。
- 回归:spinner 在普通对话(无 overlay)时仍正常转(证明只是 overlay 期停,不是永久关)。

---

## 问题 3:planning 阶段工具集——给规划者 worker 同等的权限

### 3.1 用户场景

> 这是 task 规划阶段的输出,我认为这个阶段要给规划者和 worker 一样的权限能力。
> "哦,我不能执行写操作或启动实现。在任务规划阶段,我只能使用读操作:read, bash (只读), grep, find, ls, questionnaire。"

### 3.2 根因(已确认,有意为之的设计)

`extensions/task/task.ts:40`:

```typescript
const TASK_PLANNING_TOOLS = ["read", "bash", "grep", "find", "ls", "questionnaire"];
```

planning 和 reviewing 两阶段都用这个只读集(`task.ts:981、1034、1241、1331、1333`)。这是 spec 当初的**有意决定**——见 `docs/design/task-extension-spec.md` 2.1/4.1 节"只读探索语义",以及 `docs/reports/2026-06-23-task-execute-tools-review.md` 第五节"未做的事"明确声明"没改 planning/reviewing 工具集(只读探索,有意为之)"。

设计意图:planning 阶段只跟人对齐 Spec,**不该动手做**;真正做是 executing 阶段的事(那时已放开全部工具,只排除 subagent,见 `applyExecuteTools`)。

### 3.3 这是需求变更,需先跟用户确认范围

用户现在说"给规划者和 worker 一样的权限能力",这与原设计冲突,有两条路,**请把 3.4 的选择项发回给用户拍板后再改**。我倾向 **C-1**,理由见下。

### 3.4 方案

**方案 C-1(推荐):planning 仍只读,但把"需要动手探路才能对齐"的诉求,引导到 executing。**

- 不改 `TASK_PLANNING_TOOLS`。
- 在 planning 的 prompt(`buildTaskPlanPrompt` / `task-prompts.ts`)里补一句:"如果你需要实际跑命令/写文件才能判断验收标准是否可行,先用 questionnaire 跟用户确认进入 executing 阶段探路;探路产出可复用,不算浪费。"
- 理由:planning 的核心价值是**对齐 Spec + 机器验收标准**,不是做。放开写权限后,planner 容易直接开干,跳过对齐(人机协作的最大价值就丢了),且产出的过程文件污染后续 executing 的 context。这正是原设计把它设成只读的原因。

**方案 C-2(按用户字面要求):planning 阶段继承 main session 全部工具,仅排除 subagent。**

- 直接复用 `applyExecuteTools` 的同款逻辑(但 planning 不需要 `task_complete`,要减掉)。
- 改动点:
  - `enableTask`(`task.ts:978-985`)把 `pi.setActiveTools?.(TASK_PLANNING_TOOLS)` 换成"恢复 `restoreToolsSnapshot` 再减 subagent"(仿 `startTaskExecute:999-1004`)。
  - session restore(`task.ts:1331`)`if (state.phase === "planning")` 分支同样换。
  - reviewing 阶段(`task.ts:1034、1333`)**保持只读不动**——reviewing 是产 skill/verify/contract 的复盘,不需要写,放开反而让 reviewer 跑偏去改产物。
  - bash 白名单(plan-mode 的只读 bash 限制,若 planning 复用了它的校验)要一起放开,否则 write 工具放了 bash 还是不能装包/跑脚本。需查 `task.ts` 是否对 planning bash 做了白名单拦截。
- 风险:违背 spec 原设计,要同步更新 `docs/design/task-extension-spec.md` 2.1/4.1 节和 `docs/reports/2026-06-23-task-execute-tools-review.md` 第五节。
- 测试:planning 工具集断言(现有测试 `tests/task-extension.test.ts` 里 planning 用 `TASK_PLANNING_TOOLS` 的地方)全部要改;补一条"planning 保留 chrome_cdp、排除 subagent"的测试(仿 execute 那条)。

### 3.5 给用户的决策点(建议照抄发回)

> planning 阶段放开全部工具(仅排除 subagent),意味着 planner 可以直接动手做,而不再只是对齐 Spec。这会让"对齐"和"做"的边界模糊。你想要哪种?
> - **A(推荐)**:planning 保持只读,需要动手探路时引导进 executing。
> - **B**:planning 放开全部工具(像 execute 那样),reviewing 仍保持只读。

---

## 落地顺序与分工建议

1. **问题 2 先做**(收益最高、改动最小、影响所有扩展的 questionnaire 体验),但涉及 pi runtime,按团队对 `node_modules` patch 的接受度决定走 B-1(本地 patch)还是上游 PR。
2. **问题 1 独立做**(纯 task 扩展,自包含,有清晰测试边界)。
3. **问题 3 等用户拍板**再动;若选 B,注意连文档一起改。

三个问题互不依赖,可并行、分 commit。

---

## 开工前自检清单(交给同事)

- [ ] `npm test` 基线确认(451 pass / 0 fail)
- [ ] 问题 1:`grep -n "TASK_PLANNING_TOOLS\|TASK_NORMAL_TOOLS" extensions/task/task.ts` 确认常量位置未漂移
- [ ] 问题 2:`wc -l node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/interactive-mode.js` 确认版本一致(当前 4823 行)
- [ ] 问题 3:动工前读一遍 `docs/design/task-extension-spec.md` 2.1/4.1 节和 `docs/reports/2026-06-23-task-execute-tools-review.md` 第五节,理解原设计意图
- [ ] 所有改动**不要 commit/push**,改完发修改报告回来 review

## 附:关键文件与行号(开工时以当前 `git blame` 为准,行号可能漂移)

| 文件 | 关键位置 | 用途 |
|---|---|---|
| `extensions/task/task-book.ts` | `taskDir:53`、`saveTaskbook:148`、`loadTaskbook:180`、`isValidTaskbookName:57`、`isTaskbook:90` | 加 `renameTaskbook` |
| `extensions/task/task.ts` | `MENU_TO_ACTION:103`、`getTaskCommandMenuOptions:145`、`handleTaskDelete:921`、`handleTaskCommand:1187`、`chooseTaskbookName:269`、`scopeFromTokens:307`、`TASK_PLANNING_TOOLS:40` | 加 rename action;若选 C-2 改 planning 工具集 |
| `node_modules/.../interactive-mode.js` | `showExtensionSelector:1659`、`showExtensionInput:1710`、`showExtensionEditor`、`setWorkingVisible:1365`、`statusContainer` | 问题 2 patch 点 |
| `node_modules/.../loader.js` | `setInterval:54`、`updateDisplay:59` | 问题 2 根因确认 |
| `node_modules/.../tui.js` | `requestRender:475`、`doRender` 的 diff 段 `1046-1137`、`positionHardwareCursor:1288` | 问题 2 根因确认 |

---

## 实际完成结果(2026-06-24)

### 已完成

1. **taskbook rename**
   - 新增 `renameTaskbook(scope, cwd, oldName, newName)`,只移动同 scope 目录并更新 `taskbook.json:name/updatedAt`。
   - `/task rename <old> <new>` 可直传;菜单新增 "重命名 taskbook"。
   - 保留 `createdAt` 和 `runs[]`;目标名存在、非法名、同名都会拒绝。

2. **questionnaire/input 闪烁**
   - 未直接修改 `node_modules`。
   - 新增 `bin/ugk-extension-overlay-patch.js`,在 UGK 入口安装 runtime patch:extension selector/input/editor 打开期间暂停 `Working...`,Promise 结束后恢复。

3. **planning 工具集**
   - 按本文推荐 C-1 落地:不放开 planning 写权限。
   - `TASK_ALIGN_PROMPT` 增加提示:需要写命令或实现探路时,先用 questionnaire 跟用户确认进入 executing 阶段探路。
   - C-2(像 execute 一样放开全部工具)仍需用户明确选择后再改。

### 验证

- 基线:开工前 `npm test` 为 451 pass / 0 fail。
- 红灯:目标测试先失败于缺少 `renameTaskbook`、菜单项、prompt 文案和 overlay patch。
- 目标测试: `node --test tests/task-book.test.ts tests/task-extension.test.ts tests/ugk-extension-overlay-patch.test.ts` 为 51 pass / 0 fail。
- 全量: `npm test` 为 456 pass / 0 fail。
