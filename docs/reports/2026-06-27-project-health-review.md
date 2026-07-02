# UGK core 项目体检汇报

日期: 2026-06-27
范围: `E:\AII\ugk-core-pi-patch` 当前代码
状态: 体检报告 + 首轮清理记录

## 结论先说

这个项目不是“不能维护”或“马上要重写”的状态。真实情况是: 核心功能已经跑起来了, 测试也不少, 但复杂度集中在几个地方。继续往上加能力时, 如果不先收一收, 后面修 bug 会越来越容易牵一发动全身。

本报告建议先处理 4 类问题:

1. `task` 模块太重, 需要把执行链路收成一个更深的 Module。
2. MCP 状态分散, 先修掉一个 import cycle, 再考虑集中 runtime 状态。
3. UI 标题/footer ownership 重叠, 优先删重复入口, 不要先加抽象。
4. cron 要先做产品决策: 保留为核心功能就加深, 不是核心就移到系统计划任务方案。

本轮已处理:

- 删除旧 Flow 迁移清理代码: `bin/flow-cleanup.js`、对应启动调用和测试已移除。
- 删除文件名明确属于 Flow 的历史设计、计划、报告。
- 删除 16 个社区主题和 `themes/NOTICE.md`, 默认只保留 `themes/ugk-geek.json`。

仍需项目组决定:

- `judge` 模块是否拆分或移除: 本轮不硬删, 因为它仍是当前公开能力。
- `skills/docx/scripts/office/schemas/**` 是否继续随默认包发布。
- `skills/skill-creator` 的 eval/viewer 是否继续随默认包发布。

## 背景

本次体检用了两个视角:

- `ponytail-audit`: 找可删除、可简化、过度设计、重复逻辑。
- `improve-codebase-architecture`: 找浅 Module、错误 Seam、测试困难点、长期维护摩擦。

子 agent 已经分别看过:

- 全仓 over-engineering。
- 核心编排: `task` / `judge` / `subagent`。
- 运行时能力: MCP / CDP / cron / doctor / UI / startup。

## 当前项目真实状态

### 好的地方

- 核心能力不是裸奔, `task`、`judge`、MCP、CDP 都有测试。
- 很多历史坑已经有文档记录, 例如 `docs/DEVELOPMENT.md` 里的 extension 契约。
- `chrome-cdp` 的 per-worker tab 隔离设计是清楚的, 不是拍脑袋堆代码。
- `taskbook`、`run_task`、`judge_complete` 这类关键流程有实际行为测试。

### 主要风险

- 大逻辑集中在少数文件, 尤其是 `extensions/task/task.ts` 和 `extensions/judge/judge.ts`。
- 有些 Module 看起来拆开了, 但状态事实仍分散在多处, MCP 是代表。
- UI 模块之间对同一个用户可见区域有重复 ownership。
- 一些功能是“产品决策问题”, 不能只靠工程判断删除, 例如 cron、内置主题、大型 skill 资源。

## 重点问题 1: `task` 模块太重

涉及文件:

- `extensions/task/task.ts`
- `extensions/task/task-book.ts`
- `extensions/task/task-dispatcher.ts`
- `extensions/task/task-worker.ts`
- `extensions/task/task-verify.ts`
- `extensions/task/task-checker.ts`
- `tests/task-extension.test.ts`
- `tests/subtask-tool.test.ts`

### 真实情况

`task.ts` 接近 1900 行。它现在同时负责:

- `/task` 命令菜单。
- planning/executing/reviewing 状态。
- `run_task` 工具注册。
- worker 执行。
- verify 验收。
- checker 重试归因。
- 受保护工具授权。
- 运行结果落盘。
- UI 进度展示。

这些能力都重要, 但放在一个 Module 里会让接口变宽。后续如果改 `/task run`, 很容易忘了 `run_task` 也有同类行为; 如果改 `run_task`, 也容易漏掉交互式 `/task run`。

### 影响

- bug 修复容易只修一个入口。
- 测试需要构造很重的 fake UI/fake worker。
- 新人或子 agent 读代码时容易迷路。

### 建议

不要直接“大拆文件”。先收一个更深的 `Task execution Module`。

它应该集中处理这条链路:

```text
load taskbook -> 解析 input -> 授权 env -> worker -> verify -> checker retry -> record run -> return result
```

然后:

- `/task run` 只是一个 UI Adapter。
- `run_task` 只是一个 tool Adapter。
- 两者调用同一个执行 Module。

### 项目组需要决定

- 是否把这个作为下一轮重构主线。
- 是否先补 characterization tests, 锁住现有行为再搬代码。

### 推荐优先级

高。这个是后续继续做 task 系统的最大维护成本来源。

## 重点问题 4: MCP runtime 状态分散

涉及文件:

- `extensions/mcp/index.ts`
- `extensions/mcp/commands.ts`
- `extensions/mcp/formatter.ts`
- `extensions/mcp/permissions.ts`
- `extensions/mcp/tools.ts`
- `extensions/mcp/registry.ts`
- `tests/mcp-commands.test.ts`
- `tests/integration/mcp-extension.test.ts`

### 真实情况

MCP 文件拆得不少, 表面看是分层的。但一个 MCP server 的真实状态分散在多处:

- 是否 connected。
- 是否 failed。
- 注册了哪些 tools。
- 哪些 tools stale。
- 当前 active tools 里有什么。
- 权限模式是 ask/on/off。
- cleanup 时要关哪些进程。

另外发现了一个明确结构问题:

```text
extensions/mcp/commands.ts -> extensions/mcp/formatter.ts -> extensions/mcp/commands.ts
```

`formatter.ts` 只是为了拿 `McpCommandState` 类型, 反向 import 了 `commands.ts`, 形成 import cycle。

### 影响

- 状态变化路径多, 后续容易出现 status 显示和真实工具注册不一致。
- 测试会跟着内部 Map 细节走, 而不是从一个清楚的 runtime Interface 验证行为。
- import cycle 不一定马上坏, 但会增加维护和打包风险。

### 建议

先做小修:

- 让 `formatter.ts` 接收一个更窄的数据 shape。
- 或把 `McpCommandState` 类型搬到独立 types 文件。
- 目标是先消除 import cycle, 不改变行为。

后续再考虑:

- 建一个更深的 `MCP runtime Module`, 集中处理 reload、stale tools、active tools、permission decisions。

### 项目组需要决定

- 是否把 MCP runtime 深化列为中期重构。
- 是否先批准一个小 PR 只修 import cycle。

### 推荐优先级

中高。先修 import cycle 是小成本高确定性收益。

## 重点问题 5: UI title/footer ownership 重叠

涉及文件:

- `extensions/ui-brand.ts`
- `extensions/ui-footer.ts`
- `extensions/ui-titlebar.ts`
- `extensions/ui-statusline.ts`
- `tests/ui-brand-extension.test.ts`
- `tests/ui-titlebar.test.ts`

### 真实情况

`ui-brand` 已经负责 UGK 的品牌 header/footer/title。
但 `ui-footer` 也有 `/footer` toggle, `ui-titlebar` 也会设置终端标题和工作态动画。

也就是说, 多个 Module 在管同一个用户可见区域:

- footer 谁说了算?
- terminal title 谁说了算?
- 工作时标题显示 `ugk` 还是 `pi` 风格?

### 影响

- UI 看起来可能偶发不一致。
- 后续改品牌样式时, 可能改了 `ui-brand`, 但被 `ui-titlebar` 覆盖。
- 新人不知道哪个 Module 是真实 owner。

### 建议

优先删除重复, 不要先抽象。

建议项目组确认:

- 如果 `ui-brand` 是唯一品牌 UI owner, 删除 `ui-footer`。
- 如果 `ui-brand` 的 title 足够, 删除 `ui-titlebar`。
- 保留 `ui-statusline`, 因为它更像独立的 turn progress 显示。

### 项目组需要决定

- 是否仍需要 `/footer` 命令。
- 是否仍需要动态 titlebar spinner。

### 推荐优先级

中。这个不是核心逻辑风险, 但适合作为第一批小删减。

## 重点问题 6: cron 是产品边界问题

涉及文件:

- `cron/service.ts`
- `cron/agent-bin.ts`
- `extensions/cron.ts`
- `extensions/cron-contract.ts`
- `package.json`
- `tests/cron-contract.test.ts`
- `tests/cron-agent-bin.test.ts`

### 真实情况

当前 cron 是内置能力:

- 有 HTTP 常驻服务。
- 用 `node-cron` 调度。
- `cron` tool 通过 HTTP 管理任务。
- 任务会起 `ugk --print` 子进程。

工程上有两个方向:

#### 方向 A: cron 是核心能力

那现在 `cron-contract.ts` 太浅, 只共享路径和格式化。真正的 job 存储、调度、HTTP 语义和 spawn 行为都在 `cron/service.ts`。

如果保留, 应该做一个更深的 `Cron runtime Module`:

```text
cron tool Adapter -> Cron runtime Module <- HTTP Adapter
```

这样 add/list/remove/history 的规则只有一份。

#### 方向 B: cron 不是核心能力

那可以考虑用系统计划任务替代:

- Windows Task Scheduler。
- Linux/macOS cron。
- 直接执行 `ugk --print "..."`。

这样可以删除 HTTP cron 服务和 `node-cron` 依赖。

### 影响

- 如果不决定方向, cron 会一直处于“既是产品能力, 但测试和 Module 深度又不够”的状态。
- 如果保留, 需要补更真实的 runtime 测试。
- 如果删除, 需要补迁移说明和使用指引。

### 项目组需要决定

- cron 是 UGK 的核心卖点吗?
- 用户是否需要在 UGK 内管理定时任务, 还是系统计划任务就够?

### 推荐优先级

中。先做产品决策, 再动代码。

## 保留问题 2: Judge 模块

涉及文件:

- `extensions/judge/judge.ts`
- `extensions/judge/judge-driver.ts`
- `extensions/shared/driver-session.ts`

### 当前判断

Judge 确实偏重, 但本轮没有直接移除。原因很简单: 它不是孤立旧代码, 而是当前公开能力。

它仍被这些地方使用:

- `/judge` 命令。
- `judge_complete` 工具。
- `agents/driver.md` 和 `agents/judge.md`。
- README / AGENTS 公开说明。
- `smoke:judge` 和大量 `tests/judge-*.test.ts`。

如果直接删, 不是“清理”, 而是删除一个现有产品功能。

真正应该先看的不是“删 Judge”, 而是:

- `DriverSession` 的 event Seam 是否放太低。
- `judge-driver` 是否知道了太多 runtime Implementation 细节。
- final verdict settlement 是否应该从 `judge.ts` 收出来。

### 后续建议

单独开一次 Judge 专项设计审查。不要和 UI/cron/历史文档清理混在一个 PR 里。

## 已处理 / 待决问题 3: 历史文档和大资源

涉及范围:

- 已删除: 文件名明确带 `flow` 的旧 specs / plans / design / reports。
- 已删除: `bin/flow-cleanup.js` 和 `tests/cleanup-flow.test.ts`。
- 已删除: 16 个社区主题 JSON 和 `themes/NOTICE.md`。
- 已保留: `docs/handoff/**` 近期交接文档, 避免误删仍可追溯的任务上下文。
- 已保留: `skills/docx/scripts/office/schemas/**`, 因为 docx validator 明确依赖。
- 已保留: `skills/skill-creator/**` 的 eval/viewer 脚本, 因为 `SKILL.md` 明确要求使用。

### 当前判断

这轮清掉了确定的历史包袱: Flow 已经不再是运行时功能, 对应迁移清理和旧设计资料继续留着只会增加噪音。

没有清掉的部分不是因为不敢删, 而是因为还和现有能力有明确耦合:

- docx schemas 约 1 MB, 但 validator 还在引用。
- skill-creator eval/viewer 约 225 KB, 但 skill 指南明确要求用这些脚本。
- `docs/handoff/**` 有很多近期任务交接, 不能按目录名直接删除。

### 后续建议

后续做一次 packaging / docs cleanup 专项。先分三类:

1. 运行时必须随包。
2. 可选安装。
3. 历史归档或删除。

## 其他优化和修复建议

### 1. 合并 JSON 提取 helper

多个地方都在做“从模型输出里提取 fenced JSON 或第一个 JSON object”。

涉及:

- `extensions/judge/judge-utils.ts`
- `extensions/task/task-spec.ts`
- `extensions/task/task-prompts.ts`
- `extensions/task/task-checker.ts`
- `extensions/task/task-dispatcher.ts`

建议:

- 抽一个小 helper。
- 不做复杂 parser。
- 只复用当前已经存在的简单规则。

优先级: 中。

### 2. 合并 tool summary / artifact extraction

`judge` 和 `task` 都有工具参数摘要、产物路径提取逻辑。

建议:

- 抽到 shared helper。
- 保持输入输出不变。

优先级: 中。

### 3. 合并 command policy 基础规则

`plan-mode` 和 `task` 都有 bash 安全/危险命令判断。

注意:

- 不能粗暴合并成一张表。
- plan-mode 是只读探索。
- task planning 允许的行为不完全一样。

建议:

- 抽共享基础 primitive。
- 各自保留自己的模式差异。

优先级: 中。

### 4. workspace trust / update preflight 菜单 helper

`bin/workspace-trust.js` 和 `bin/update-preflight.js` 都有 raw TTY 编号选择逻辑。

建议:

- 抽一个最小 numbered-choice helper。
- 不引入新依赖。

优先级: 低。

### 5. taskbook registry cache freshness

现在 taskbook prompt cache 在 `registerTask` 生命周期里。taskbook save/delete/rename 后, 同 session 的可用 task prompt 是否马上刷新, 需要测试确认。

建议:

- 先写一个小测试证明当前行为。
- 如果确实旧, 再把 refresh locality 收进 `task-registry.ts`。

优先级: 中低。

### 6. tests/support/judge-harness

Judge 测试里 fake driver/fake UI/fake context 重复较多。

建议:

- 先不单独重构测试。
- 等动 Judge/DriverSession 时顺手抽。

优先级: 低。

## 推荐执行顺序

### 第一批: 小、稳、容易 review

1. 删除或保留 `ui-footer`: 项目组先确认。
2. 删除或保留 `ui-titlebar`: 项目组先确认。
3. 修 MCP formatter import cycle。
4. 抽 shared JSON extraction helper。

### 第二批: 中等收益

1. 合并 tool summary / artifact extraction。
2. 合并 command policy 基础规则。
3. 检查 taskbook registry cache freshness。

### 第三批: 大改前准备

1. 给 task execution 链路补 characterization tests。
2. 设计 `Task execution Module`。
3. 搬 `/task run` 和 `run_task` 到同一个 execution Interface。

### 单独专项

- Judge 是否拆分或移除。
- docx / skill-creator 大资源是否拆成可选包。
- cron 产品方向。

## 项目组需要拍板的问题

1. cron 是否是核心能力?
2. `/footer` 是否还需要?
3. 动态 titlebar spinner 是否还需要?
4. 是否需要重新引入社区主题, 还是保持默认只带 `ugk-geek`?
5. docx Office schemas 是否必须随默认运行时发布?
6. skill-creator eval/viewer 是否属于默认运行时能力?
7. `docs/handoff/**` 近期交接资料是否归档到仓库外?

## 最后建议

不要现在做“大重写”。
建议先用 1-2 个小 PR 降噪:

- 一个删除类 PR: UI 重复项。
- 一个修复类 PR: MCP import cycle。

然后再开始 `task` 执行链路重构。这样风险最低, 项目组也最容易 review。
