# `/task` 收尾任务清单

> **状态:已完成(2026-06-22)。** 保留作历史材料。3 处改动(worker.md 工具集、2.2 节 review 注记、3.2 节 save 语义)都已落地并合入主实现。
>
> **原始用途**:给执行 agent 的收尾交接,只做 3 处精确修改 + 验证。
>
> **更新时间**:2026-06-22
> **预估工作量**:10-15 分钟

---

## 必读约束(跟上一轮一样)

- 始终中文(注释/commit/文档),代码标识符用英文
- 遵守 `E:\AII\ugk-core\AGENTS.md`
- 不要碰 Judge 代码(`extensions/judge/**`、`tests/judge-*.test.ts`)
- 不要碰 smoke-tui 文件(`scripts/smoke-tui.mjs`、`tests/smoke-tui.test.ts`)
- 不要 `git add` 8 个未跟踪的旧 docs 文件
- 不要 commit,改完留 working tree 给用户

---

## 任务 1:补 `agents/worker.md` 的工具集(必修)

**问题**:上一轮把 `worker.md` 的 frontmatter 改成 `tools: read, write, edit, bash`,**漏了 `grep`/`find`/`ls`**,导致 worker 做搜索类任务(统计代码行数、找调用方等)时能力受限。

**改动**:

文件 `E:\AII\ugk-core\agents\worker.md`,把 frontmatter 的 tools 行改成:

```yaml
tools: read, write, edit, bash, grep, find, ls
```

**验收**:
- `git diff agents/worker.md` 只看到 tools 行变化(从 4 个工具变 7 个)
- `npm test` 仍 397/397 pass(这个改动不影响测试,但跑一遍确认没误伤)

---

## 任务 2:设计文档 2.2 节加注 review 的 context 实现(必修)

**问题**:设计文档 2.2 节说"review 用新 context",但实际实现用的是 **context filter**(在 `task.ts` 的 `before_agent_start` + `context` 事件里过滤掉 `task-plan-context`,只保留 `task-review-context` + 执行摘要)。这是合理偏离(更简单,等价效果),但**文档跟实现不一致**,会让后人困惑。

**改动**:

文件 `E:\AII\ugk-core\docs\design\task-extension-spec.md`,定位到 2.2 节这段(约 63 行):

```markdown
**review 用新 context**:复盘要冷静看整个执行过程,不能被执行阶段的兴奋带偏。review 看的是执行**摘要**(产出了什么、走了哪几步),不是原始 transcript,避免被过程细节淹没。
```

在它**后面追加一段**实现说明:

```markdown
**v1 实现注记**:review 阶段不开新 session(避免 command-handler-only API 的 `ctx.newSession()` 在 `agent_end` 触发链路里的复杂度),而是用 **context filter** 模拟新 context:进入 reviewing 阶段后,`before_agent_start` 注入 `task-review-context` custom message,`context` 事件过滤掉旧的 `task-plan-context`,只保留 review prompt + 执行摘要。效果等价于新 context:review agent 看不到 plan 阶段的完整 transcript。如果 v2 发现 review 质量受影响(比如 review agent 仍被早期 plan 推理带偏),再升级到真正的 `ctx.newSession()`。
```

**验收**:
- `git diff docs/design/task-extension-spec.md` 只看到 2.2 节追加了一段
- 文档其他部分没动

---

## 任务 3:设计文档 3.2 节措辞跟实现对齐(必修)

**问题**:设计文档 3.2 节说 runs 保留最近 10 条,但没明说 **save 时是否保留旧 runs**。实际实现(`task-book.ts:170-178`)是:**save 覆盖 spec/skill/verify/contract/taskbook 元数据,但保留旧 runs 和 createdAt**——这是更好的行为(重新 review 不该清掉历史),但文档没写清楚。

另外 v1 边界(第 514 行)写的是"save 直接覆盖",容易被误读成"连 runs 也覆盖"。

**改动 A**:

文件 `E:\AII\ugk-core\docs\design\task-extension-spec.md`,定位到 3.2 节的"字段说明"末尾(约 128 行,`verifyFailures` 那条之后),追加一条:

```markdown
- **save 语义**:重新 `/task save <name>` 会覆盖 `spec.json`/`skill.md`/`verify.mjs`/`contract.json` 和 `taskbook.json` 的 description/tags/updatedAt,但**保留 `runs[]` 历史和 `createdAt`**——重新 review 不应清掉运行历史。
```

**改动 B**:

同文件第 514 行附近(十、不做的事 v1 边界),把:

```markdown
- **taskbook 版本管理**:不存历史版本,save 直接覆盖
```

改成:

```markdown
- **taskbook 版本管理**:不存 skill/verify/contract 的历史版本(重新 save 覆盖内容);但 `runs[]` 运行历史不被 save 覆盖,只按 `sortAndTrimRuns` 自然淘汰到最近 10 条
```

**验收**:
- `git diff docs/design/task-extension-spec.md` 看到 3.2 节字段说明加了一条 + 第十节那条措辞改了
- 文档其他部分没动

---

## 收尾验证(全做完后跑一次)

```powershell
# 1. 测试基线不能掉
npm test
# 期望:397/397 pass

# 2. 确认只改了这 3 个文件
git status --short
# 期望看到:
#  M agents/worker.md
#  M docs/design/task-extension-spec.md
# (其他 M/?? 都是上一轮主交付已有的,不算本次新增)

# 3. diff 一下确认改动精确
git diff agents/worker.md
git diff docs/design/task-extension-spec.md
```

---

## 完成后的交接总结模板(填好给 review agent)

```
收尾任务完成。

任务 1(worker.md 工具集):
- 状态: 已完成 / 跳过(原因)
- 改动: tools 行从 "read, write, edit, bash" → "read, write, edit, bash, grep, find, ls"

任务 2(2.2 节加注):
- 状态: 已完成 / 跳过
- 位置: docs/design/task-extension-spec.md 2.2 节末尾

任务 3(3.2 节措辞):
- 状态: 已完成 / 跳过
- 改动 A: 字段说明加了 save 语义一条
- 改动 B: 第十节那条改了措辞

验证:
- npm test: 397/397 pass
- git diff 只触及 agents/worker.md + docs/design/task-extension-spec.md
```

---

## 不要做的事

- 不要改 `extensions/task/**` 任何代码文件(实现已经过验收,这次只改文档 + worker.md frontmatter)
- 不要改测试文件
- 不要 commit
- 不要 stage
- 不要碰 Judge / smoke-tui / 旧 untracked docs
- 不要"顺手优化"其他地方——本轮就是这 3 处精确改动,改完就停
