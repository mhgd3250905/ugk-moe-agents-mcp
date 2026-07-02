# Push 前 Review 交接 — Judge 任务书 + 修复批次

> 状态: **待 review**
> 日期: 2026-06-22
> 角色: 本文件是 push 前 review 的交接,写给执行 agent(reviewer)
> 工作目录: `E:\AII\ugk-core`(项目根)
> 目的: 把这批 4 个 commit(本地 main 领先 origin/main 4 个 commit)**review 通过后**才能 push 到 origin/main

---

## 你的任务

你是独立 reviewer。你的工作**不是改代码**,而是:

1. 把 4 个 commit 改的内容审一遍,**找出潜在问题**
2. 判断**能否 push 到 origin/main**
3. 出具一份明确的 review 结论(可以 push / 不能 push / 需要修正后 push)

**你不需要修补代码**。如果发现问题,在报告里列出,由原作者(我/ugk-dev)决定怎么处理。

**不要做橡皮图章**。如果你觉得某个地方有风险、或不该这样改、或没测试到位,**直接说**。push 是不可逆对外操作,这一关的价值就在挑刺。

---

## ⚠️ 开工前必读

1. **`AGENTS.md`** — 项目约定
2. **`docs/design/2026-06-21-judge-taskbook-spec.md`** — 整批改动的需求规格(圣经)
3. **`docs/judge.md`** — Judge 模式当前事实(可能被这批改动更新了)
4. 本交接文档附录 A(4 个 commit 的内容摘要)

---

## 待 review 的范围

### 本地 main 领先 origin/main 的 4 个 commit

```
9ff12ff feat(judge): driving 中途用户插话转发给 Driver
aab42fc fix(judge): 用户拒绝 PASS 交付后回到 driving 继续修
7867d29 feat(judge): /judge edit 改造为复用 ALIGN 流程的交互式编辑
c35bed6 feat(judge): 任务书机制 + 知乎场景验证暴露的 Judge/Driver 修复
```

基线: `75905d1`(v2.0.0)= origin/main

### 改动规模

29 文件,**+4376 / -272 行**,其中:
- 2 个新核心文件:`extensions/judge/taskbook.ts`(215 行)、`tests/taskbook.test.ts`(168 行)
- 9 个新文档(design + handoff)
- 改动 18 个文件(`judge.ts` 改动最大 +790/-...)

### 实测状态

- `npm test`: **359 pass / 0 fail**(v2.0.0 的 327 + 32 新增)
- 用户已实测知乎热榜场景全套:`/judge save` → `/judge run`(重跑成功,经验复用生效) → `/judge edit`(Judge 亲自问) → driving 中途插话(driver 收到)
- `git diff --check`: 干净

---

## Review 检查清单(必须逐项核对)

### 1. 功能正确性(最重要)

#### 1.1 任务书 CRUD
- [ ] `extensions/judge/taskbook.ts` 实现的 saveTaskbook/loadTaskbook/listTaskbooks/appendRunToTaskbook/updateTaskbookSpec 正确
- [ ] schema 校验(`isTaskbook`、`isRequirementsSpec`)能拦住坏数据
- [ ] appendRunToTaskbook 限 10 条 runs 不膨胀
- [ ] 经验沉淀:PASS 覆盖 experience.md,FAIL 只进 runs[] 不改 experience.md
- [ ] `/judge save/run/edit/list` 四个命令派发正确(尤其 split-args 模式)

**抽查方法**:读 `extensions/judge/taskbook.ts` + `extensions/judge/judge.ts` 的 4 个 handler。

#### 1.2 `/judge edit` 复用 ALIGN
- [ ] `aligningMode: "new" | "edit"` 字段正确,enterAligning 复位为 "new"
- [ ] EDIT_PROMPT 在 edit 模式注入(对照 buildEditPrompt)
- [ ] edit 产出 Spec 后弹 `["存回任务书", "继续调整", "放弃"]`,不弹「委派 driver」
- [ ] 所有 edit 退出路径(存回/继续/放弃)清 aligningMode,不污染下次 ALIGN
- [ ] edit 模式 C-2 闸:Judge 没调 questionnaire 就产 Spec → 拒绝存回
- [ ] 普通 ALIGN(`aligningMode === "new"` 或 undefined)行为零变化(回归保护)

**抽查方法**:读 `judge-prompts.ts` 的 EDIT_PROMPT + `judge-state.ts` 的 aligningMode + `judge.ts` 的 before_agent_start 和 agent_end edit 分支。

#### 1.3 用户插话(driving 中途)
- [ ] input hook 只在 `driving + interactive source + activeDriver 存在` 时拦截
- [ ] 其他 phase / 非 interactive / 无 driver 一律放行 continue
- [ ] 转发用 `activeDriver.sendUserInput`(自动处理 streaming/idle)
- [ ] 加工格式 `[USER INTERJECTION during driving]` 让 driver 知道来源
- [ ] 异常容错(activeDriver 不存在、sendUserInput 失败)只 notify,不崩

**抽查方法**:读 `judge.ts` 的 `pi.on("input")` handler。

### 2. Bug 修复正确性

#### 2.1 DECIDE prompt(acceptance vs context)
- [ ] DECIDE_PROMPT 明确区分 acceptance 和 context
- [ ] 拒绝「driver 只响应 context 就 PASS」
- [ ] tests/judge-summary.test.ts 断言改成「对照 acceptance」

#### 2.2 driver.md 不推活硬约束
- [ ] driver.md 加了「自己干,不许推活给用户」
- [ ] driver.md 在仓库 `agents/` 改了(但运行时读 `~/.pi/agent/agents/`,可能要手动 cp,见 AGENTS.md)

#### 2.3 ALIGN_PROMPT 补充题
- [ ] ALIGN_PROMPT 强制末尾 `extras` 题,用户输入拼到 context

#### 2.4 questionnaire 强制 Type another answer
- [ ] `extensions/judge/questionnaire.ts` 无条件加「Type another answer」,不受 LLM 传 false 影响

#### 2.5 继续澄清/改需求红字崩溃
- [ ] 三处 `pi.sendUserMessage` 加 `{ deliverAs: "followUp" }`(agent_end 内必须)
- [ ] plan-mode.ts 的同类调用也修了

**抽查方法**:读对应文件,搜关键字。

### 3. 架构决策的两个偏离(spec 记录)

worker(执行 agent)实际实现时**偏离了 spec 的两个设计决策**,详见 `docs/design/2026-06-21-judge-taskbook-spec.md` 附录 C。你需要 review 这两个偏离是否合理:

- [ ] **偏离 1**:driving 逻辑抽成共享函数 `startActiveJudgeDriver`(spec 原案是不抽取,让 /judge run 复用现有 agent_end driving 分支)。**理由**:消除代码重复,所有现有测试全绿证明行为等价。→ 你判断:可接受?
- [ ] **偏离 2**:taskbook.json **不存** steerHistory(spec 原案没明确,首版实现曾存,后来改回不存)。**理由**:experience.md 作为经验唯一落盘载体,避免双事实源。→ 你判断:可接受?

### 4. 测试覆盖

- [ ] `npm test` 359/0 fail 是真的(自己跑一遍)
- [ ] 任务书测试覆盖 save/load/list/appendRun/draftExperience/isValidName/updateTaskbook
- [ ] edit 测试覆盖进 edit aligning / 弹三选项 / 存回 / 继续 / 放弃 / C-2 闸
- [ ] 插话测试覆盖 拦截转发 / 非 driving 放行 / 非 interactive 放行 / 无 driver 容错 / sendUserInput 异常
- [ ] reject PASS 测试覆盖 拒绝 + 有预算回到 driving

### 5. 文档一致性

- [ ] `docs/judge.md` 描述的所有命令和当前代码行为一致
- [ ] `AGENTS.md` 加的任务书约定准确
- [ ] spec 文档附录 C 的实现记录跟实际代码一致
- [ ] 没有过期/错误的描述

### 6. 回归保护(关键)

- [ ] v2.0.0 原有功能全部保留(Judge 普通 aligning、driver 监督、cron、mcp、chrome_cdp、plan-mode、subagent 等等)
- [ ] 所有 v2.0.0 的测试都没被删/被弱化

**抽查方法**:对比 `git diff main~4 main -- tests/`,看测试改动是「新增」还是「修改了已有断言」。修改已有断言的要重点 review——可能是合理更新(比如 prompt 改了断言也改),也可能是被弱化。

### 7. 安全 / 边界

- [ ] `isValidTaskbookName` 拒绝路径分隔符(`../x` 之类),防路径穿越
- [ ] loadTaskbook 对坏 JSON 抛错而非崩溃
- [ ] sendUserMessage 失败不会让整个 Judge session 崩
- [ ] 用户插话不会触发死循环(driver 处理插话又触发新一轮插话?)

### 8. 已知遗留(不是 blocker 但要记)

- [ ] driver.md 改了仓库,但运行时读 `~/.pi/agent/agents/`,需用户手动 `cp`(README/AGENTS.md 是否说明?)
- [ ] taskbook-zhihu 是测试遗留(`E:\AII\TUI\.judge\taskbooks\`),不是本仓库的事,不影响 push

---

## Review 结论模板

完成后,按以下格式出报告:

### 总体结论
- [ ] **可以 push**(没有 blocker,可有 minor 建议)
- [ ] **不能 push,需要修正**(列出 blocker)
- [ ] **需要更多调查**(发现疑点但无法确定)

### Blocker(必须改才能 push)
- 每条:文件:行 + 问题描述 + 建议改法

### Minor 建议(改不改不影响 push)
- 每条:文件:行 + 描述

### 已验证 OK 的点
- 列出你抽查过、确认没问题的项

### 风险点(改不改都行,但要提醒)
- 比如某个设计决策的潜在副作用、未来可能踩的坑

---

## 硬约束(reviewer 也要遵守)

| # | 约束 |
|---|---|
| HC1 | **不修补代码**,只 review。发现问题写进报告 |
| HC2 | bash 走 Git Bash + Linux 语法 |
| HC3 | 不要被 commit message 带偏,看实际 diff |
| HC4 | 不要被「用户已实测」带偏,实测覆盖有限,代码层面要 review |
| HC5 | **回归保护是重点**:v2.0.0 的 327 测试不能有任何被弱化 |
| HC6 | 如果发现 spec 文档和代码不一致,标记出来——文档可能是错的,代码可能是错的,需要人判断 |

---

## 关键文件速查

| 关注点 | 文件 |
|---|---|
| 任务书核心实现 | `extensions/judge/taskbook.ts` |
| Judge 主代码(改动最大) | `extensions/judge/judge.ts` |
| Judge state machine | `extensions/judge/judge-state.ts` |
| Judge prompts | `extensions/judge/judge-prompts.ts` |
| Driver 编排 | `extensions/judge/judge-driver.ts` |
| Driver session(被改 source 标记) | `extensions/shared/driver-session.ts` |
| questionnaire(Type another answer) | `extensions/judge/questionnaire.ts` |
| plan-mode(deliverAs 修复) | `extensions/plan-mode.ts` |
| 任务书测试 | `tests/taskbook.test.ts` |
| Judge 主测试 | `tests/judge-extension.test.ts`、`tests/judge-delivery.test.ts`、`tests/judge-driver.test.ts`、`tests/judge-state.test.ts`、`tests/judge-summary.test.ts`、`tests/judge-utils.test.ts` |
| shared driver session 测试 | `tests/shared-driver-session.test.ts` |
| 需求规格(圣经) | `docs/design/2026-06-21-judge-taskbook-spec.md` |
| Judge 当前事实 | `docs/judge.md` |

---

## 你的第一步

1. 读 `AGENTS.md`
2. `git log --oneline main~4..main` 确认 4 个 commit
3. `git diff main~4 main --stat` 看整体改动
4. 跑 `npm test` 确认 359/0 fail
5. 按 review 检查清单逐项 review(优先级:1 → 2 → 6 → 7 → 3 → 4 → 5 → 8)
6. 出 review 结论报告

**不确定就标记成「需要更多调查」,不要拍脑袋放过。** push 是不可逆的。

---

## 附录 A:4 个 commit 的内容摘要

### c35bed6 — feat(judge): 任务书机制 + 知乎场景验证暴露的 Judge/Driver 修复

- 任务书 CRUD(save/run/edit/list 四命令)+ taskbook.ts 读写层
- DECIDE prompt 修复:acceptance vs context(知乎热榜测试发现 Judge 把「响应 context」当进展误判 PASS)
- driver.md 硬约束:Driver 不许推活给用户
- ALIGN_PROMPT 补充题:questionnaire 末尾必加 extras
- questionnaire 强制 Type another answer
- 继续澄清/改需求红字崩溃修复(`deliverAs: "followUp"`)
- 文档:spec、delegation、handoff、docs/judge.md、AGENTS.md

### 7867d29 — feat(judge): /judge edit 改造为复用 ALIGN 流程的交互式编辑

- JudgeState 加 `aligningMode: "new" | "edit"`
- EDIT_PROMPT_TEMPLATE + buildEditPrompt
- before_agent_start 根据 aligningMode 注入 EDIT_PROMPT 或 ALIGN_PROMPT
- agent_end edit 分支弹 `["存回任务书", "继续调整", "放弃"]`
- edit 模式 C-2 闸:没调 questionnaire 拒绝存回
- 持久化 aligningMode

### aab42fc — fix(judge): 用户拒绝 PASS 交付后回到 driving 继续修

- 区分「无 confirm UI」和「用户点 No」(原来都当未确认统一进 pendingAck)
- 拒绝 + 有 steer 预算 → startDriving + steer 让 driver 继续修
- 拒绝 + 无预算 → 仍 markPendingAck + notify 提示
- 无 confirm UI → 原延后接受路径不变

### 9ff12ff — feat(judge): driving 中途用户插话转发给 Driver

- input hook 只在 driving + interactive + activeDriver 存在时拦截
- 加工 `[USER INTERJECTION during driving]` 前缀转发
- 内部 prompt 标 `source: "extension"`(driver-session.ts)
- `/judge run` 后台启动 driver(不 await start()),TUI 不被卡住
- 普通 ALIGN 委派路径保持原行为

---

## 附录 B:已知遗留问题(不是 blocker,但 reviewer 要知道)

1. **driver.md 运行时同步**:仓库 `agents/driver.md` 改了,但 pi 运行时读 `~/.pi/agent/agents/`,需要手动 cp。文档里说了。
2. **taskbook-zhihu 测试遗留**:在 `E:\AII\TUI\.judge\taskbooks/`,不在本仓库,不影响 push。
3. **spec 附录 C 记录的 2 个偏离**(已在 review 清单 §3 单独 review)。
