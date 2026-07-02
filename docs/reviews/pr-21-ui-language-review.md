# PR #21 Review — Selectable UI Languages

> PR: https://github.com/mhgd3250905/ugk-tui/pull/21
> Branch: `codex/dev-20260628-main`
> 审核日期: 2026-06-28
> 审核方式: 本地 checkout + 双 subagent 代码/设计审核 + 合并冲突模拟
> 结论: **NEEDS REBASE + FIXES(不能直接合并)**

---

## 🚨 必须先做:rebase 到最新 main(否则会覆盖主干工作)

**你的分支基础已过时,直接合并会丢失主干上的重要机制层改动。**

你的分支是从 `4f7f6c0` 拉的。在那之后,main 上合并了 3 个机制层 commit(都在你的分支基础之后):

| main commit | 内容 | 冲突文件 |
|---|---|---|
| `d3eaa5a` | feat(chrome_cdp): **CDP autolaunch on worker spawn** | `extensions/chrome-cdp/tab-session.ts`、`tests/chrome-cdp-tab-session.test.ts` |
| `853c315` | feat(task): dispatcher 值有效门禁 + 注入当前日期 | `extensions/task/task-dispatcher.ts`、`tests/task-dispatcher.test.ts` |
| `0a0bb8f` | docs(task-creator): +机制全景/dispatcher真相/两层防线 | `skills/task-creator/SKILL.md` |

**最严重的冲突**:`extensions/chrome-cdp/tab-session.ts`

- main 版本:加了 **CDP autolaunch 机制**(worker spawn 前 Chrome 没起 → 自动 launch + 重试开 tab),含 `UGK_CDP_AUTOLAUNCH` 开关、`launchChromeCdpAndWait` 调用、`isValidRuntimeValue` 门禁
- 你的分支版本:基于旧 `tab-session.ts`,**完全没有 autolaunch 代码**
- 实测:`git diff origin/main..origin/codex/dev-20260628-main -- extensions/chrome-cdp/tab-session.ts` 有 98 行差异

**如果直接合并(merge commit):Git 会用你的旧版覆盖 main 的 autolaunch 实现,CDP autolaunch 机制被静默删除。** 这是我们最不能接受的回归。

### 你要做的事

```bash
# 1. 更新本地 main
git fetch origin
git checkout main && git pull origin main

# 2. 回到你的分支,rebase 到最新 main
git checkout codex/dev-20260628-main
git rebase main

# 3. 解决冲突(重点):
#    - extensions/chrome-cdp/tab-session.ts:
#      保留 main 的 autolaunch 逻辑(beforeSpawn 里的 launch+重试、UGK_CDP_AUTOLAUNCH 开关、launch DI)
#      你的改动应该只是"文本本地化" —— 如果你对 tab-session.ts 的改动里有非文本的内容,说明改错了文件
#    - tests/chrome-cdp-tab-session.test.ts:
#      保留 main 的 3 个 autolaunch 测试 + 你原有的 tab 生命周期测试
#      不要删除这个文件(见下方发现 #1)
#    - extensions/task/task-dispatcher.ts:
#      保留 main 的 isValidRuntimeValue / coversRequired 升级 / 注入当前日期
#      你的改动如果不涉及 dispatcher,应该没冲突
#    - skills/task-creator/SKILL.md:
#      保留 main 新增的 5 节(机制全景/dispatcher真相/扁平字段/两层防线/数据落地/自验清单)

# 4. 冲突解决后,全量测试必须通过
npm test   # 当前 main 基线是 457,你的 PR 加 UI 语言测试后应该是 ~460-465

# 5. force push 更新 PR
git push origin codex/dev-20260628-main --force-with-lease
```

**冲突解决原则:主干(main)的机制层改动优先保留;你的 PR 是"UI 文本本地化",不应触及机制层逻辑。** 如果你的 diff 里有非文本的机制改动,那部分应该丢弃,只保留文本本地化部分。

---

## 审核发现(按严重度排序)

### 🔴 发现 #1(严重):`tests/chrome-cdp-tab-session.test.ts` 被整文件删除

你的 PR 删除了 `tests/chrome-cdp-tab-session.test.ts`(99 行)。这个文件覆盖 **per-worker CDP tab 隔离机制**(`makeCdpTabLifecycle` 的 beforeSpawn/afterClose/幂等/best-effort 吞错),与 UI 语言完全无关。

**为什么删了**:你的分支基础(`4f7f6c0`)时这个文件存在,但 main 之后给这个文件**新增了 3 个 autolaunch 测试**(`d3eaa5a`)。你的分支没见过这些新测试,合并时整个文件的命运取决于冲突解决 —— 如果误删,per-worker tab 隔离 + autolaunch **两个关键机制都失去单测保护**。

**要求**:**rebase 后必须保留完整的 `tests/chrome-cdp-tab-session.test.ts`**(既有 tab 生命周期测试 + main 新增的 3 个 autolaunch 测试)。不要删除。

---

### 🟡 发现 #2(中):本地化覆盖不一致 —— 硬编码中文未走 `uiText`

PR 标题宣称"9 种 UI 语言",但多处改了文本却**硬编码中文**,设 `/ui-language en-US` 后这些地方**仍显示中文**。与同目录走 `uiText` 的做法自相矛盾:

| 文件 | 位置 | 问题 |
|---|---|---|
| `extensions/index.ts` | 第 337 行 | `/ui-language clear` 的反馈 `"界面语言已清除,回到默认: 简体中文"` 硬编码中文,周围 status/set 分支都用了 uiText,独独这行漏了 |
| `extensions/mcp/index.ts` | 第 44-46, 305-316, 321-340 行 | `MCP_ALLOW_ONCE="允许一次"` 常量、`confirmSpawn`、`confirmTool` 全硬编码中文,而同目录 `mcp/commands.ts` 走 uiText |
| `extensions/builtin-tool-render.ts` | 多处 | `"运行中..."`/`"完成"`/`"已应用"` 硬编码 |
| `extensions/questionnaire.ts` | 第 147, 154 行 | `"✗ 取消"`/`"✓ 已回答 N 个"` 硬编码 |
| `extensions/subagent-command.ts` | 第 40, 57, 67 行 | `"子代理"`/`"继承"` 硬编码 |
| `extensions/index.ts` | 第 373-379 行 | 危险命令拦截确认弹窗 `["允许","拒绝"]` 硬编码 |

**要求**:二选一 ——
- **(推荐)** 把这些硬编码点也接 `uiText`,实现真正的全 UI 本地化;
- 或在 PR 描述里**明确声明**这些是"已知未本地化缺口",列出清单,作为后续 follow-up。

**至少第 337 行那处(`界面语言已清除`)必须修** —— 它本身就是 `/ui-language` 的反馈消息,用中文显示给选了英文 UI 的用户,自相矛盾。

---

### 🟡 发现 #3(中):危险命令拦截的 `reason` 契约文本被改,可能影响下游

`extensions/index.ts:373-379` 把危险 bash 拦截的 `reason` 从英文(`"Dangerous command blocked"`)改成中文(`"用户已拒绝"`)。

`reason` 是 `tool_call` 钩子返回给 pi 框架/下游消费者的**契约字段**。任何匹配该 reason 文本的下游(日志解析、聚合、外部工具)会断。

**要求**:确认这个 reason 变更不破坏任何下游消费者。如果不确定,**保持 reason 为英文**(契约字段不本地化),只本地化用户可见的弹窗文本。另外 `plan-mode.ts` 的 reason 走了 uiText(中英都变),两处拦截器策略不一致,要统一。

---

### 🟢 发现 #4(低):菜单控制流从"字符串匹配"改成"数组下标匹配"

`extensions/index.ts:255-268` 等多处菜单,把原先的 `if (selection === "Exit")` 改成 `if (selection === options[3])`。

功能等价(测试覆盖了),但**顺序敏感**:任何对 `languageMenuOptions()` 数组顺序的重排都会静默改语义,而当前没有"选项顺序契约"的断言。

**建议(非阻塞)**:要么加注释标明"options 顺序是契约",要么加一个测试断言顺序。可以 follow-up。

---

### 🟢 发现 #5(低):测试计数与 PR 声明不符

PR 描述写 `npm test => 463/463 passed`,但实测是 **460/460**。

**要求**:rebase + 解决冲突后,用真实的测试数更新 PR 描述。当前 main 基线 457,你的 PR 加了 UI 语言测试,rebase 后应该是 460 左右(取决于冲突解决后保留多少)。

---

### 🟢 发现 #6(低):动态插值字符串的 fallback 体验

PR 声称"English fallback for untranslated dynamic strings"。核验结果:fallback 机制本身健壮(`translateString` 第 122-124 行 `TRANSLATIONS[zhCN]?.[language] ?? enUS ?? zhCN` 三级回退正确)。

但**实际效果是半本地化界面**:像 `uiText(\`已连接 server: ${n}\`, \`Connected servers: ${n}\`)` 这种插值字符串,简中部分不在 TRANSLATIONS 表里,所以非中/非英语言全部回退英文。结果:日语用户看到表头是日文(`MCP 状态`),但状态行是英文(`Connected servers: 3`),界面中英日混杂。

**这不是 bug,是设计权衡**。但 PR 描述"本地化状态面板"的措辞过于乐观。

**建议(非阻塞)**:要么扩充 TRANSLATIONS 覆盖插值模式(给每个动态字符串加占位符模板),要么在 PR 描述里**如实声明**:"菜单、表头、面板标签已本地化;动态状态正文(含实时数字)回退英文"。

---

## 做得好的地方(确认通过)

- ✅ **核心设计合理**:`extensions/shared/ui-language.ts` 的数据结构、9 语言枚举、英文 fallback 链都健壮
- ✅ **`/language` 与 `/ui-language` 真正解耦**:不同设置键(`language` vs `uiLanguage`)、不同文件、零交叉导入、独立持久化。`/ui-language` 不影响 AI 回复,`/language` 不重渲染 UI。
- ✅ **持久化兼容**:老用户升级默认 zh-CN(与升级前一致),不崩;config schema 纯追加,不破坏既有字段。
- ✅ **`uiText` 向后兼容**:第三参 `language` 有默认值,旧调用方零影响;14 个调用方都更新了,无遗漏。
- ✅ **formatter 只触文本层**:chrome-cdp/doctor/mcp 的 formatter 改动是纯文本,行为逻辑零改动;`doctor/checks.ts` 的正则升级是必要的兼容修复(中英都判),行为等价。
- ✅ **新增测试健康**:有"设 uiLanguage=en-US 后验证英文渲染"的专项测试,是增强不是弱化。

---

## 合并放行条件 Checklist

rebase + 解决冲突后,确认以下全部满足才能合并:

- [ ] **`extensions/chrome-cdp/tab-session.ts` 保留 main 的 autolaunch 机制**(beforeSpawn launch+重试、`UGK_CDP_AUTOLAUNCH` 开关、`launch` DI)
- [ ] **`tests/chrome-cdp-tab-session.test.ts` 完整保留**(既有 tab 测试 + 3 个 autolaunch 测试,不删除)
- [ ] **`extensions/task/task-dispatcher.ts` 保留 main 的机制层**(isValidRuntimeValue / coversRequired 升级 / 注入当前日期)
- [ ] **`skills/task-creator/SKILL.md` 保留 main 新增的 5 节**
- [ ] **全量 `npm test` 通过**(rebase 后真实计数,更新 PR 描述)
- [ ] **发现 #2 至少修第 337 行**(ui-language clear 反馈必须本地化)
- [ ] **发现 #3 确认 reason 契约不破坏下游**(或保持英文)
- [ ] PR 描述的测试计数与实测一致

---

## 联系

审核人:ugk-dev(本地 main 维护者)
审核报告:`docs/reviews/pr-21-ui-language-review.md`
有问题在 PR 评论里讨论。
