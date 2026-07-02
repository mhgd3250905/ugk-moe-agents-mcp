# ugk-core 远程开发交接说明

> **生成时间**:2026-06-24
> **交接对象**:远程接手开发者(**全新加入,本文自含完整项目上下文**)
> **仓库**:`E:\AII\ugk-core` → GitHub `mhgd3250905/ugk-tui`
> **分支**:`main`(本地与 `origin/main` 已同步,HEAD `5a89782`)
> **测试基线**:`npm test` = **460 pass / 0 fail**
> **工作区**:干净,仅 8 个与本轮无关的 untracked 历史文档(见第 6 节)

---

## 1. 项目一句话 + 必读文档

**ugk-core**(代号 **UGK**)是一个终端编码 agent,基于 [pi](https://github.com/earendil-works/pi)(开源 coding agent 框架 `pi-coding-agent`)定制,对外名 **ugk-pi-agent**。用户 `npm i -g ugk-agent` 装完,终端打 `ugk` 即可对话写代码。

**开工第一件事:读仓库根目录的 `AGENTS.md`。** 它是项目最高优先级文档——角色、能力清单、约定、运行时发行策略全在里面,覆盖任何默认行为。下面的摘要是为了让你快速进入,细节以 `AGENTS.md` 为准。

UGK 在 pi 之上叠加的能力(都在 `extensions/`):`/task` 固定任务委托、`/judge` 实时监督、`subagent` 子代理委派、`cron` 定时任务、`scrcpy` 安卓投屏、`chrome_cdp` 本地浏览器控制、`/mcp` MCP tools 接入、`/plan` 只读计划模式、ugk 品牌 UI、更新检查。

## 2. 必须遵守的硬约定(违反会出事)

- **bash 工具走 Git Bash**(`D:\Git\bin\bash.exe`),命令用 Linux 语法,Windows 路径用正斜杠 `/`。
- **UGK 固定 pi 版本**:`package.json` 里 `@earendil-works/*` 全钉 `0.79.4`。**不要让用户跑 `pi update`**,pi 升级只能靠 UGK 发新版本。
- **绝对不要直接改 `node_modules/`**(改了 npm 升级会丢)。所有 pi 行为修正走 `bin/ugk-*.js` patch 机制(在 `bin/ugk.js` 启动时安装,仿 `installUgkSessionViewPatch` 的 idempotent 范式:`Symbol.for()` 守卫 + proto 包装 + 失败 `console.warn`)。
- **改 task 模块核心函数签名/状态机** → 同步更新 `docs/design/subtask-extension-spec.md`;**改 taskbook schema / Judge agent 定义** → 同步更新 `docs/judge.md`。
- **危险操作前确认**(`rm -rf`/`sudo`/`chmod 777` 已挂权限门)。
- **改完不要擅自 commit/push** 除非用户明确要求(本项目用户偏好"你给修改报告我让同事去改,改完回报未 commit,这边 review + 文档 + commit/push"的工作流)。

## 3. 怎么跑

```bash
npm test                                    # 全量,当前 460 pass / 0 fail
node --test tests/task-extension.test.ts    # 单个文件
node --test tests/task-utils.test.ts
node bin/ugk.js                             # 开发态启动 TUI(或全局装过直接 ugk)
```

> bash 工具若报 WSL 错(`WSL ERROR: execvpe /bin/bash failed 2`),按 README "Windows 用户:修复 bash 工具"一节,把 Git Bash 路径写进 `%USERPROFILE%\.pi\agent\settings.json`。

---

## 4. 当前开发焦点:task 扩展模块(`extensions/task/`)

最近 5 个 commit 全围绕 `/task` 系统。`/task` 让用户把"固定的一次性任务"沉淀成可复用的 **taskbook**(= 需求规格 `spec.json` + 操作指引 `skill.md` + 机器验收 `verify.mjs` + 产出契约 `contract.json` + 元数据 `taskbook.json`)。

### 4.1 四阶段创造流程

```
planning → executing → reviewing → landed
对齐需求    动手做一遍   复盘产文档   taskbook 就绪
```

- **planning**:跟用户对齐 RequirementsSpec(goal/约束/机器可验收标准)。
- **executing**:task-creator 亲手把任务做一遍(放开环境工具,禁 subagent/run_task)。
- **reviewing**:复盘产 skill + verify + contract(产文档前必须用 questionnaire 跟用户核对)。
- **landed**:taskbook 落盘,等 `/task run <name>` 复用。

### 4.2 模块文件地图(`extensions/task/`)

| 文件 | 职责 |
|---|---|
| `task.ts` | 主注册器:命令 handler、阶段状态机、工具集切换、bash hook |
| `task-book.ts` | taskbook 落盘/加载/重命名(目录 = `~/.pi/agent/tasks/<name>/` 或 `<cwd>/.tasks/<name>/`) |
| `task-state.ts` | 四阶段状态机 |
| `task-prompts.ts` | `TASK_ALIGN_PROMPT`(planning)/ `TASK_REVIEW_PROMPT`(reviewing) |
| `task-dispatcher.ts` | 复用时单次 LLM 调用,把自然语言 input 翻译成 runtimeInput |
| `task-worker.ts` | spawn worker 子进程执行 skill |
| `task-verify.ts` | 跑 verify.mjs 机器验收 |
| `task-checker.ts` | verify fail 时派 checker 归因 |
| `task-run-reviewer.ts` | `/task` 复盘上次运行(reviewer 子进程) |
| `task-registry.ts` | `buildTaskbookPrompt` 注入 system prompt |
| `task-spec.ts` / `task-utils.ts` | 数据解析 / 工具摘要 + `isSafeCommand` + `isPlanningAllowedCommand` |

### 4.3 最近 5 个 commit(本开发线的全部产出)

| commit | 内容 |
|---|---|
| `5a89782` | **C-3 planning 探索性 bash**:planning 阶段放开 `node`/`npm test`/`python` 等探索性命令验证方案可行性,只拦留持久副作用的命令(写盘、`npm install`、git 变更、重定向)。write/edit 仍禁,reviewing 不变。走新增的 `isPlanningAllowedCommand`(非破坏即放行),`isSafeCommand` 原样保留给别处 |
| `3ac2feb` | `/task rename` 改名(目录+JSON 一起搬,保留 runs/createdAt);extension overlay patch(overlay 打开时停 Working spinner,消输入闪烁);planning 文案引导进 executing 探路 |
| `1f8258e` | review-last-run 加 widget 反馈(原同步 await reviewer 十几秒无状态);定位 pi-tui 表格滚动到顶 bug(上游遗留,未硬修) |
| `1208dc2` | 文档:AGENTS.md/README 记录 task 扩展和 run_task |
| `3a55e4a` | **run_task subtask 工具**:main agent 编排已验收 taskbook,返回 PASS/FAIL。dispatcher→worker→verify,headless 不弹 UI。两条铁律:需求驱动、责任归 LLM |

### 4.4 一个关键细节:`isSafeCommand` 有两份(别搞混)

- **`extensions/task/task-utils.ts`** 的 `isSafeCommand` + `isPlanningAllowedCommand` —— **只给 `/task` 的 planning 用**。C-3 只改了这份。
- **`extensions/plan-mode-utils.ts`** 的 `isSafeCommand` —— 给 `/plan` 命令(`plan-mode.ts:157`)和 Judge aligning(`judge-utils.ts` re-export,`judge.ts:1145`)用,**语义是纯只读探索,不该放开**。

改 task 的 bash 判定**绝对不要动 plan-mode-utils.ts 那份**,否则会误伤 `/plan` 和 Judge。测试 `tests/plan-mode-utils.test.ts` + `tests/judge-utils.test.ts` 是这个隔离的回归保护。

---

## 5. 已知遗留 / 下一步候选(按优先级)

### 5.1 【未做】真实 TUI dogfood(P2,阻塞收尾)

上一轮(overlay-spinner patch / `/task rename` / review widget)和 C-3 **都只过了单元测试**,mock 覆盖不到真实终端的:① 中文输入法合成;② 终端光标重定位;③ 真实目录改名肉眼效果。

**需要在真实终端补跑三项**:
1. `/task new` → planning 弹 questionnaire → 打中文,验证不闪(`bin/ugk-extension-overlay-patch.js` 的效果)。
2. `/task rename <old> <new>` → 实测改名菜单、非法名/同名拒绝、runs 历史保留。
3. 跑一个 taskbook → `/task` 选"复盘上次运行" → 验证等待期间有"📋 正在复盘..."widget 反馈。

详细流程见 `docs/handoff/2026-06-24-planning-bash-c3-and-dogfood.md` 任务二(第 2.3-2.6 节)。C-3 本身也要顺手验证:`/task new` 时 planner 能否跑 `node`/`npm test` 探索。

### 5.2 【挂遗留】pi-tui 表格滚动到顶 bug(P3,上游问题)

TUI 渲染 markdown 表格时,一滚动就跳回顶部,必现。**根因已完全定位**:`node_modules/@earendil-works/pi-tui/dist/tui.js:1133`,宽度变化导致表格行数变化 → 触发 `fullRender(true)` 输出 `ESC[3J` 清 scrollback 重置视口。

**为何没修**:根因在上游 pi-tui 的全局差分渲染/滚动锚点策略,UGK 层 monkey-patch `TUI.doRender()` 或 `Markdown.renderTable()` 风险高(会牵动所有消息渲染和终端 resize)。用户决定"算了"暂不处理。

**若将来要做**:正解是向上游 pi-tui 报 issue(带 `tui.js:1133` 根因 + 复现步骤)。需先征得用户同意再起草外发。详见 `docs/handoff/2026-06-24-task-ux-fixes.md` 问题 2。

### 5.3 【决策点】planning 工具集是否要进一步放开到 C-2(P3,待用户拍板)

当前 planning 是 **C-3**(探索性 bash 放开,write/edit 禁,破坏性命令拦)。若用户将来要求"planning 像 execute 一样全开写权限"(C-2),改动点:
- `enableTask`(`task.ts:978-985`)把 `pi.setActiveTools?.(TASK_PLANNING_TOOLS)` 换成"恢复 `restoreToolsSnapshot` 再减 subagent"。
- session restore(`task.ts:1354`)同改。
- reviewing 阶段保持只读不动。
- 同步改 spec 2.1/4.1、AGENTS.md、测试。

**决策权在用户**,不要擅自做。C-1/C-2/C-3 的对比见 `docs/design/task-extension-spec.md` 末尾 C-3 注记。

### 5.4 【缓做】workerModel 第二版

当前 dispatcher 有 `dispatcherModel` 覆盖,workerModel 暂缓实现。

---

## 6. 工作区的 8 个 untracked 文档(待你决定去留)

这 8 个文件挂了好几个会话,**与 task 扩展开发线无关**,是更早的 v2.0.0 周期和其他议题的产物。接手时请确认它们是否还要推进:

| 文件 | 内容 |
|---|---|
| `docs/design/flow-removal-action-plan.md` | Flow 模块移除执行行动方案(状态:交付执行) |
| `docs/design/flow-removal-spec.md` | Flow 模块移除需求规格(已定稿) |
| `docs/design/mcp-menu-redesign.md` | `/mcp` 菜单化改造(交付执行) |
| `docs/design/v2-cleanup-pr-a.md` | PR-A 基础清理(发给执行 agent) |
| `docs/handoff/2026-06-19-unsigned-read-paths.md` | 签名链未验签读取路径(状态分裂 bug) |
| `docs/handoff/2026-06-21-v2-release-handoff.md` | v2.0.0 发布后交接 |
| `docs/handoff/agent-a-pr2-flow-removal.md` | PR2 Flow 移除任务(发给 agent A) |
| `docs/reports/2026-06-21-v2-architecture-review.md` | v2.0.0 全方位架构审查 |

**建议**:先问用户这些是否还在推进。若已废弃可删除或归档;若是活跃任务,接手时单独处理。**不要在不知情时擅自 commit 或删除**。

---

## 7. 关键文档索引(按需读)

| 路径 | 何时读 |
|---|---|
| **`AGENTS.md`** | **开工前必读**,项目最高优先级约定 |
| `README.md` | 安装、Windows bash 修复、能力概览 |
| `docs/design/task-extension-spec.md` | task 四阶段设计契约(创造+复用),含命令清单、菜单映射、C-3 注记 |
| `docs/design/subtask-extension-spec.md` | run_task 编排设计(§5 记录 handleTaskRun 不可复用、headless 编排) |
| `docs/judge.md` | Judge 实时监督模式 + 任务书章节(改 Judge 必读) |
| `docs/handoff/2026-06-24-planning-bash-c3-and-dogfood.md` | C-3 完整实现方案 + dogfood 流程(含项目上下文,适合新人入门) |
| `docs/handoff/2026-06-24-task-rename-flicker-planning-tools.md` | 上上轮三项(rename/闪烁/planning)的修改报告 |
| `docs/handoff/2026-06-24-task-ux-fixes.md` | UX 排查(复盘反馈 + 表格滚动 bug 根因) |
| `docs/reports/2026-06-23-task-execute-tools-review.md` | execute 工具集放开的历史 review |

---

## 8. 工作风格(用户偏好,接手务必遵守)

- **简洁**。优先复用 pi 已有能力,不新建。
- **修改报告要可直接执行**:根因 + 方案 + 坑 + 测试要求 + 行号。用户常让同事照报告改,改完回报"已完成未 commit",然后由这边 review + 文档对齐 + commit/push。
- **不擅自做违背原设计的事**(如 planning 放开全部工具、改 node_modules),先列决策点让用户拍板。
- **代码风格匹配周边代码**(注释密度、命名、idiom);runtime patch 严格仿现有 `bin/ugk-*.js` 范式。
- **改完任何东西**:`npm test` 全绿 + `git diff --check` 无 whitespace 错,再交付。用户在意基线。

---

## 9. 一句话接手

在 `E:\AII\ugk-core` 的 `main` 分支(已推送,`5a89782`,460 测试全绿),task 扩展模块功能完整、文档同步。接手先读 `AGENTS.md` 和 `docs/handoff/2026-06-24-planning-bash-c3-and-dogfood.md`(后者含项目上下文入门)。下一步看用户想做:① 真实 TUI dogfood 补跑(5.1);② pi-tui 滚动 bug(5.2,用户已说暂挂);③ planning 进一步放开 C-2(5.3,待拍板);④ 第 6 节那 8 个历史文档的去留;⑤ 新需求。
