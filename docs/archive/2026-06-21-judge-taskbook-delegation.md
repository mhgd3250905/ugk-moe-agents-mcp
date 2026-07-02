# Judge 任务书实施 — 分阶段委派 prompt

> 这份文件不是给执行 agent 看的规格,是给 **ugk-dev(你)** 用的「分发脚本」。
> 每个阶段是一个**自包含的 `@worker` 触发 prompt**——复制粘贴到主对话或新会话里执行即可。
> 规格全文在 `docs/design/2026-06-21-judge-taskbook-spec.md`,执行 agent 会读。
>
> **执行节奏**: 严格串行,阶段 A 跑完且 `npm test` 全绿,再触发阶段 B,以此类推。
> 这样既隔离 context(执行细节不污染主对话),又可回滚(哪阶段挂了就知道改哪)。

---

## 阶段 A: steerHistory 基础设施

**触发 prompt**:

```
@worker 按 docs/design/2026-06-21-judge-taskbook-spec.md 的「阶段 A」实现。

只做阶段 A(块 1),不碰其他块。具体:

1. 先读规格文档 §五「块 1」和附录 A 的文件:行索引,理解改动范围。
2. TDD:先写测试后改代码。
   - 扩展 tests/judge-driver.test.ts:断言 steer 后 summary.steerHistory 含 {direction, reason, turnIndex}
   - 断言 cloneSummary 深拷贝 steerHistory(改副本不影响原)
   - 断言旧 summary(无 steerHistory 字段)反序列化时 steerHistory ?? [] 容错
3. 改 extensions/judge/judge-state.ts:
   - 新增 SteerRecord interface {direction, reason, turnIndex}
   - DriverSummary 加 steerHistory: SteerRecord[]
4. 改 extensions/judge/judge-driver.ts:
   - summary 初始化(judge-driver.ts:224-231 附近)加 steerHistory: []
   - cloneSummary(judge-driver.ts:82-98)深拷贝 steerHistory
   - steer 分支(judge-driver.ts:294 附近)summary.steerCount += 1 后 push SteerRecord
5. 改 extensions/judge/judge.ts 持久化:restoreJudgeState(judge.ts:306-333)反序列化时容错 steerHistory ?? []
6. 跑 npm test,现有 327 测试 + 新增必须全绿。
7. 完成后报告:改了哪些文件、新增测试数、npm test 结果。

严格遵守:
- 不改其他块的内容,不做 taskbook.ts、不改 CLI 派发、不改 onFinalize
- 不破坏现有行为,所有现有测试必须通过
- 代码风格对齐周边代码(看相邻行的写法)
```

---

## 阶段 B: taskbook.ts 读写层

**触发 prompt**:

```
@worker 按 docs/design/2026-06-21-judge-taskbook-spec.md 的「阶段 B」实现。

前提:阶段 A 已合并(steerHistory 字段已存在)。只做阶段 B(块 2),不碰 CLI 和 onFinalize。

1. 先读规格文档 §五「块 2」和 §四「任务书结构」,理解 schema 和 API。
2. TDD:先写 tests/taskbook.test.ts 覆盖规格 §七.阶段B 列出的所有 case:
   - saveTaskbook 写出 3 文件(taskbook.json/spec.json/experience.md),目录自动 mkdir recursive
   - loadTaskbook 读回 + schema 校验通过
   - loadTaskbook 不存在返回 null(不抛错)
   - loadTaskbook schema 错(缺字段/类型错)抛错
   - listTaskbooks 扫 .judge/taskbooks/*/taskbook.json 正确,返回 name+description+lastRun
   - appendRunToTaskbook 读-改-写 runs[],按 timestamp 排序,保留最近 10 条
   - draftExperienceMd 渲染正确结构(目标/验收/避坑点/失败模式四节),纯函数不读磁盘
   - isValidTaskbookName 拒绝路径分隔符、空、点号;接受字母数字-_-
3. 新建 extensions/judge/taskbook.ts 实现 §五「块 2」列出的全部 API:
   - Taskbook / RunSummary interface
   - taskbookDir / taskbooksRoot / isValidTaskbookName
   - saveTaskbook / loadTaskbook / listTaskbooks / appendRunToTaskbook / updateTaskbookSpec
   - draftExperienceMd(纯函数)/ isTaskbook
   - 用 node:fs/promises,参考现有 isRequirementsSpec(judge.ts:293-304)和 normalizeSpec(judge-utils.ts:208-224)风格
4. 跑 npm test,全绿。
5. 报告:新文件行数、测试 case 数、npm test 结果。

严格遵守:
- 不改 judge-state.ts / judge-driver.ts / judge.ts(阶段 A 已完成的不再动)
- taskbook.ts 是纯模块,不依赖 Judge 运行时,可独立测试
- 不暴露任何新 slash 命令
```

---

## 阶段 C: finalize 钩子 + run 沉淀

**触发 prompt**:

```
@worker 按 docs/design/2026-06-21-judge-taskbook-spec.md 的「阶段 C」实现。

前提:阶段 A、B 已合并(steerHistory 字段 + taskbook.ts 读写层就绪)。只做阶段 C(块 3)。

1. 读规格 §五「块 3」和附录 A 的 finalize 相关行号。
2. TDD:先扩展 tests/judge-extension.test.ts 覆盖:
   - PASS + state.taskbookName → 调 appendRunToTaskbook(pass) + experience.md 被覆盖
   - FAIL 终态 + state.taskbookName → 调 appendRunToTaskbook(fail) + experience.md 不变
   - FAIL-with-budget-resume(judge.ts:738-751)→ 不调 appendRunToTaskbook(run 未结束)
   - state.taskbookName 存在时 driver initialPrompt 含 experience 摘要 + 「非验收标准」标注
   - state.taskbookName undefined 时所有现有行为零变化(核心回归保护)
3. 改 extensions/judge/judge-state.ts:
   - JudgeState 加 taskbookName?: string
   - 新增 setTaskbookForRun(state, name) 转换函数
4. 改 extensions/judge/judge.ts:
   - judge.ts:586-592 构造 driver initialPrompt 处,taskbookName 存在时追加 experience 摘要(标题写明「补充参考,非验收标准」)
   - judge.ts:677-752 onFinalize 钩子,PASS 分支(judge.ts:706-727)接受交付后、completeJudge 前插入沉淀逻辑(appendRun pass + 覆盖 experience.md)
   - FAIL 终态分支(judge.ts:729-736)插入沉淀(appendRun fail,不动 experience.md)
   - FAIL-with-budget-resume(judge.ts:738-751)不沉淀
5. 跑 npm test,全绿。重点确认无 taskbookName 的回归测试全过。
6. 报告:改动行数、新增测试数、npm test 结果、哪些现有测试被改动(如果有)。

严格遵守:
- 不动 CLI 派发和 4 个 handler(那是阶段 D)
- taskbookName 默认 undefined,现有流程零感知
- 沉淀逻辑必须容错:磁盘 IO 失败只 notify warning,不阻断主流程
```

---

## 阶段 D: CLI 命令 + 重跑流程

**触发 prompt**:

```
@worker 按 docs/design/2026-06-21-judge-taskbook-spec.md 的「阶段 D」实现。

前提:阶段 A、B、C 已合并。这是最后一块代码改动。

1. 读规格 §五「块 4」和 §六「状态机扩展」。
2. TDD:先扩展 tests/judge-extension.test.ts 覆盖:
   - /judge save foo 派发到 handleTaskbookSave
   - /judge run foo 跳过 aligning,直接 startDriving,state.taskbookName === "foo"
   - /judge run foo 后下一次 agent_end 走 driving 分支(回归现有 driving 逻辑)
   - /judge edit foo 弹 editor + parse 校验 + updateTaskbookSpec
   - /judge list 展示 name+description+lastRun
   - 菜单选项(JUDGE_COMMAND_MENU_OPTIONS)映射正确
   - 现有 /judge、/judge ack、/judge toggle、/judge(无参)行为零变化(回归)
   - 无效 name 被 isValidTaskbookName 拒绝并 notify
3. 改 extensions/judge/judge.ts:452-485 的 /judge handler:
   - 把整串比较改成 split-args 模式(模板 mcp/commands.ts:70)
   - tokens = resolvedArgs.trim().split(/\s+/).filter(Boolean);action = tokens[0];name = tokens[1]
   - 保留 ack/toggle/check-bash-window 现有分支
   - 新增 save/run/edit/list 分支
4. 改 JUDGE_COMMAND_MENU_OPTIONS(judge.ts:73)和 resolveJudgeCommandArgs(judge.ts:437-447):
   - 菜单加「新建对齐(从零)」「运行任务书」「保存任务书」「编辑任务书」「列出任务书」
   - 映射到 action 字符串
5. 实现 4 个 handler(handleTaskbookSave/Run/Edit/List)按规格 §五「块 4.3」:
   - handleTaskbookRun 是核心:load taskbook → setRequirementsSpec → setTaskbookForRun → startDriving → 后续复用现有 driving 分支
   - 复用 ctx.ui.select / ctx.ui.editor / ctx.ui.confirm / ctx.ui.notify,不自造 widget
6. 跑 npm test,全绿。
7. 报告:改动行数、新增测试数、菜单现在长什么样、npm test 结果。

严格遵守:
- /judge(无参,从零对齐)流程必须零变化
- 所有 handler 容错:load 失败/校验失败只 notify,不抛未捕获异常
- experience.md 经验注入已在阶段 C 做好,这里只做 CLI 入口
```

---

## 阶段 E: 文档

**触发 prompt**:

```
@worker 按 docs/design/2026-06-21-judge-taskbook-spec.md 的「阶段 E」补文档。

前提:阶段 A-D 已合并,功能可用。

1. 改 docs/judge.md,新增「任务书(Taskbook)」章节:
   - 是什么: 一句话 + 核心信念(执行 agent 永远不靠谱,Judge 永远不撤)
   - 用法: /judge save <name>、/judge run <name>、/judge edit <name>、/judge list
   - 存储位置: .judge/taskbooks/<name>/{taskbook.json, spec.json, experience.md}
   - 重跑行为: 跳过 ALIGN,保留完整 Judge 监督
   - 经验沉淀: PASS 覆盖 experience.md,FAIL 进 runs[] 历史
   - 编辑入口: /judge edit 随时改 spec 和 experience
   - 一句话提醒: 旧 docs/handoff/ 和早期设计文档只作历史材料,不覆盖本节
2. 改 AGENTS.md 「关键约定」章节,加一条:
   "任务书存 .judge/taskbooks/<name>/,project scope。Judge+Driver 跑通一次可存为任务书,/judge run <name> 跳过 ALIGN 直接开跑但保留完整 Judge 监督。改 Judge/Driver 的 agent 定义或 taskbook schema 必须同步更新 docs/judge.md 任务书章节。"
3. .gitignore 不加 .judge/taskbooks/(任务书是版本管理资产)。
4. 跑 npm test 最终确认全绿(327 + 新增)。
5. 报告:改了哪些文件、章节标题、最终测试数。

严格遵守:
- 文档风格对齐 docs/judge.md 现有章节
- 不改设计文档(docs/design/2026-06-21-judge-taskbook-spec.md 已定稿)
```

---

## 触发顺序检查清单

每阶段触发前确认上一阶段已完成:

- [ ] 阶段 A:`npm test` 全绿,steerHistory 字段合并
- [ ] 阶段 B:`npm test` 全绿,taskbook.ts 就绪
- [ ] 阶段 C:`npm test` 全绿,onFinalize 沉淀生效
- [ ] 阶段 D:`npm test` 全绿,4 个 CLI 命令可用
- [ ] 阶段 E:文档更新,`npm test` 最终全绿

## 出问题怎么办

- 某阶段测试挂了: 让 `@worker` 在同一会话里修(给它失败的测试输出),不要直接跳下一阶段
- 阶段间合并冲突: 串行执行天然避免,若手动合并出错,回退到上一阶段绿色状态重来
- 执行 agent 跑偏(做了不该做的): 在 prompt 里明确「只做 X,不碰 Y」,重新触发
