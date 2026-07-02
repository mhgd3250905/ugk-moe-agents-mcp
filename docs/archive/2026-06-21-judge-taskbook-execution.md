# Judge 任务书机制 — 执行交接 Message

> 本文件是一份**自包含的交接 message**,写给执行 agent(worker)。
> worker 对本项目零认知,读这一份就能上手。
> 也可整段复制粘贴为 `@worker` 的触发消息。

---

## 工作目录

**你的 cwd 是 `E:\AII\ugk-core`(项目根目录)。** 所有相对路径都以这里为根。`npm test` 在这里跑。worker 通过 `@worker` 触发时继承主对话的 cwd,主对话已经在这里,所以你进来默认就在这——**不要 cd 到别处**。

---

## 你是谁,在干什么

你被委派到 **ugk-core** 项目执行一个功能开发任务。ugk-core 是基于 [pi](https://github.com/earendil-works/pi)(pi-coding-agent)定制的编码 agent(ugk-pi-agent),用 TypeScript 写的。你这次要做的是**给 Judge+Driver 模式加一层「任务书(Taskbook)」沉淀与复用能力**。

**项目当前状态**: 已发布 v2.0.0,HEAD `75905d1`,工作树干净(除未跟踪的文档/技能)。Judge+Driver 模式已稳定,有 327 个测试全绿。你的任务是**纯叠加**,不破坏任何现有功能。

---

## ⚠️ 开工前必读(按顺序,不可跳过)

1. **`AGENTS.md`**(项目根)— 项目约定,**最重要**。重点:
   - bash 工具走 **Git Bash**(`D:\Git\bin\bash.exe`),命令用 **Linux 语法**,Windows 路径用**正斜杠**
   - 危险操作前确认(`rm -rf` / `sudo` / `chmod 777` 已被权限门拦截)
   - subagent 的 agent 定义在仓库 `agents/*.md`,需复制到 `~/.pi/agent/agents/` 才生效
   - 模型全局默认 `deepseek-v4-pro`
2. **`docs/design/2026-06-21-judge-taskbook-spec.md`** — 本次任务的**完整需求规格**,这是你的圣经。含:
   - 10 条已拍板决策(D1-D10),全部定死,**不得自行更改**
   - 四块详细设计(steerHistory / taskbook.ts / finalize 钩子 / CLI 命令)
   - 任务书 schema、状态机扩展、TDD 实施计划(5 阶段 A-E)
   - 附录 A:关键文件:行索引(速查表)
3. **`docs/design/2026-06-21-judge-taskbook-delegation.md`** — 分阶段委派脚本,每个阶段(A-E)有自包含的执行 prompt。你按当前阶段复制对应 prompt 执行。
4. **`docs/judge.md`** — Judge 模式的当前事实文档。只读不改,用来理解现有流程。

---

## 任务一句话

一次成功的 Judge+Driver run 沉淀为可命名的「任务书」,下次 `/judge run <name>` 加载任务书**跳过 ALIGN 对齐、保留完整 Judge 监督(DECIDE + FINALIZE)**直接开跑;任务书可编辑;失败 run 的经验也沉淀为重来起点。

**核心信念(不可违背)**: 执行 agent 永远不靠谱,所以 Judge 永远不能撤。任务书不是「撤掉 Judge 的自动化」,是「让 Judge+Driver 带着领域经验起步」。重跑时 DECIDE + FINALIZE 监督**必须完整保留**。

---

## 不可违反的硬约束

| # | 约束 | 违反后果 |
|---|---|---|
| HC1 | **先写测试后改代码**(TDD),每阶段 `npm test` 全绿才进下一阶段 | 回归风险,任务失败 |
| HC2 | **不破坏现有 `/judge` 从零对齐流程**,不传 name 时行为零变化 | 破坏 v2.0.0 已验证功能 |
| HC3 | **重跑保留完整 Judge 监督**,只跳过 ALIGN,DECIDE/FINALIZE 不变 | 违背核心信念 |
| HC4 | **不改 `agents/driver.md` / `agents/judge.md`**,经验进 driver initialPrompt 不进 agent 定义 | 影响所有 Judge run |
| HC5 | **不复活 flow**(`docs/superpowers/specs/2026-06-17-flow-task-design.md` 是已废弃先例) | 引入已移除的复杂度 |
| HC6 | **存储只用 project scope**(`<cwd>/.judge/taskbooks/`),不做 user/install | 违反 D7 |
| HC7 | **bash 走 Git Bash + Linux 语法**,Windows 路径用正斜杠(见 AGENTS.md) | 命令执行失败 |
| HC8 | **不做 multi-driver / subagent 并行**(已否决) | 偏离任务范围 |
| HC9 | **taskbook.ts 是纯模块**,不依赖 Judge 运行时,可独立测试 | 耦合,难测试 |
| HC10 | 所有新代码**容错**:磁盘 IO/校验失败只 notify warning,不抛未捕获异常 | 用户流程被打断 |

---

## 执行方式(严格串行,5 阶段)

**总原则**: 阶段 A → B → C → D → E,串行。每阶段做完跑 `npm test`,全绿才能进下一阶段。挂了就在本阶段修,不跳级。

| 阶段 | 内容 | 产物 |
|---|---|---|
| **A** | DriverSummary 加 steerHistory 字段(基础设施) | judge-state.ts + judge-driver.ts 改动 + 测试 |
| **B** | taskbook.ts 读写层(纯模块) | 新文件 extensions/judge/taskbook.ts + tests/taskbook.test.ts |
| **C** | finalize 钩子 + run 沉淀 | judge-state.ts + judge.ts 的 onFinalize/initialPrompt 改动 + 测试 |
| **D** | CLI 命令 + 重跑流程 | judge.ts 的 /judge handler 派发 + 4 handler + 测试 |
| **E** | 文档 | docs/judge.md + AGENTS.md 更新 |

每阶段的**详细执行 prompt** 在 `docs/design/2026-06-21-judge-taskbook-delegation.md` 里。你当前阶段对应那一节,复制执行。

---

## 验证标准

- `npm test` 全绿(现有 327 + 新增 ~23)
- 现有所有测试**零失败**(回归保护是硬指标)
- 验收对照 spec §十二「验收标准」6 条

---

## 报告格式(每阶段完成时回报)

1. 改了/新建哪些文件(列表)
2. 新增测试数 + `npm test` 结果(贴关键输出:pass/fail 数)
3. 有没有偏离 spec(如果有,说明原因)
4. 是否可以进下一阶段(绿了才能说可以)

---

## 你的第一步

1. 读 `AGENTS.md`
2. 读 `docs/design/2026-06-21-judge-taskbook-spec.md`(全文)
3. 读 `docs/design/2026-06-21-judge-taskbook-delegation.md` 的「阶段 A」一节
4. 读 spec 附录 A 列出的关键文件相关行(建立代码认知)
5. 开始阶段 A:先写测试,再改代码,跑 `npm test`,绿了报告

**不确定就停下来问,不要猜。** spec 文档是权威,spec 没覆盖的才问 ugk-dev。

---

## 速查:关键文件

| 用途 | 文件 |
|---|---|
| 项目约定 | `AGENTS.md` |
| 任务规格(圣经) | `docs/design/2026-06-21-judge-taskbook-spec.md` |
| 分阶段 prompt | `docs/design/2026-06-21-judge-taskbook-delegation.md` |
| Judge 现状 | `docs/judge.md` |
| Judge 主代码 | `extensions/judge/judge.ts` |
| Driver 状态机 | `extensions/judge/judge-state.ts` |
| Driver 编排 | `extensions/judge/judge-driver.ts` |
| Driver 底座 | `extensions/shared/driver-session.ts` |
| Driver agent 定义 | `agents/driver.md`(只读) |
| Judge agent 定义 | `agents/judge.md`(只读) |
| split-args 派发模板 | `extensions/mcp/commands.ts:70` |
