# 对抗性模块边界审查 — ugk-core

> 日期: 2026-07-02
> 审查对象: `E:\AII\worktrees\ugk-core\codex-scratch-20260702`
> 审查方法: 第一性原则 + ponytail full + subagent 并行初审 + 主线程对抗复核
> 结论: 未发现必须立即修复的运行时 P0/P1 安全 bug；发现一批明确的发布包边界污染、过期文档、测试口径混用和可删死代码。
> 本轮未改代码,仅输出审查报告。

---

## 审查范围

本轮重点不是找业务 bug,而是看项目边界是否变脏:

- 运行时代码: `bin/`, `agents/`, `cron/`, `extensions/`, `functions/`, `skills/`, `themes/`, `scripts/`, `prompts/`
- 测试: `tests/*.test.ts`, `tests/integration/*.test.ts`, smoke 脚本
- 文档: `README.md`, `AGENTS.md`, `docs/**`, `install/README.md`
- 发布边界: `package.json`, `.npmignore`, `wrangler.toml`, `npm pack --dry-run`

并行子代理分工:

| 子代理 | 范围 | 目标 |
|---|---|---|
| 运行时代码 | `extensions/bin/cron/functions/skills` | 找死代码、浅模块、重复策略、跨边界依赖 |
| 测试 | `tests/`, package scripts | 找过期测试、默认未覆盖、脆弱实现细节断言 |
| 文档 | README/AGENTS/docs | 找冲突文档、过期 handoff、当前事实不一致 |
| 依赖/脚本 | npm 包、`.npmignore`, scripts | 找发布包污染、无用依赖、脚本边界错位 |

主线程对每条高价值结论做了复核。没有调用链或实测证据的项不列为主问题。

---

## 验证结果

```bash
npm test
```

结果: `551` total, `549` pass, `2` skipped, `0` fail。

注意: `docs/handoff/2026-07-01-v2.2.0-release-handoff.md` 写的是 `551/551 pass`,与当前 Node test 汇总不一致。

```bash
npm run test:integration
```

结果: `36/36` pass。

注意: integration 不在默认 `npm test` 覆盖里。

```bash
npm pack --dry-run --json
```

结果: npm 包包含 `177` 个文件,unpacked size `971789` bytes。确认 `functions/`, `migrations/`, `scripts/`, `wrangler.toml` 会进入主包。

---

## 已确认问题

### P1: npm 发布包带了半个 Cloudflare 项目

**证据**

- `.npmignore` 排除了 `docs/`,但没有排除 `functions/`, `migrations/`, `wrangler.toml`, `scripts/`。
- `npm pack --dry-run --json` 确认这些文件全部进入 `ugk-agent@2.2.0` 包。
- `wrangler.toml:3` 指向 `pages_build_output_dir = "docs/task-share"`,但 npm 包里没有 `docs/task-share/`。

**影响**

npm 包本应是 CLI/agent runtime,现在混入 Cloudflare Pages Functions、D1 migrations 和 smoke dev 脚本。更糟的是它不是完整 marketplace 部署包,而是缺静态站的半包。

**最小处理**

把这些加入 `.npmignore`:

```gitignore
functions/
migrations/
wrangler.toml
scripts/
```

如果项目决定 npm 包必须包含 marketplace 后端,那就反过来:不要排除 `docs/task-share/`,并把这个边界写进 README。但按当前 CLI 包定位,排除更合理。

---

### P1: `smoke:tui` 名不副实,且仍跑已删除的 `/judge`

**证据**

- `package.json:17-18` 暴露 `smoke:task` 和 `smoke:tui`。
- `scripts/smoke-tui.mjs:28-34` 动态 import `node-pty`,但 package 没声明该依赖。
- 默认 `auto` 在无 `node-pty` 时退到 RPC,不是真 TUI。
- `scripts/smoke-tui.mjs:107-108` 仍输入 `/judge` 和 ESC,而当前扩展命令列表已无 `/judge`。

**影响**

维护者看到 `smoke:tui` 会以为跑过真实终端 UI；实际上大多数机器只跑 RPC fallback。`/judge` 场景也会继续把历史能力混进当前 smoke 报告。

**最小处理**

- 删除 `loadNodePty`, `runTuiSmoke`, `--driver=tui` 分支。
- 保留 RPC smoke,把脚本名或报告里的 driver 说清楚。
- 删除 `judge-menu-exit` / `judge-menu-cancel` 场景。

---

### P1: 当前文档仍承诺不存在的“投屏”能力

**证据**

- `README.md:5` 写 `npm i -g ugk-agent` 后拥有“投屏、子代理、定时任务...”。
- `docs/automated-reviews/2026-06-30-a9e29b4.md:16` 明确记录 Android 默认工具和 adb/scrcpy skills 已删除。

**影响**

用户会寻找不存在的投屏能力；agent 也可能把历史 Android/ADB 能力当成当前可用能力。

**最小处理**

删掉 README 首段里的“投屏”。

---

### P1: `AGENTS.md` 的当前能力列表落后于代码

**证据**

- `AGENTS.md:60` 的 `/task` 子命令漏 `publish`。
- `extensions/task/task.ts:2224` 已实现 `publish` action。
- `extensions/task/task.ts:2236` usage 文案也漏了 `rename`。
- `README.md:198` 有 `/subagent`,但 `AGENTS.md` slash 命令列表没有。
- `extensions/plan-mode.ts:136` 注册 `/todos`,README 有,AGENTS 没有。

**影响**

`AGENTS.md` 是运行时注入上下文。它落后时,agent 会低估当前能力,尤其是 `/task publish`, `/subagent`, `/todos` 这些用户入口。

**最小处理**

- `AGENTS.md` 的 `/task` 清单补 `publish`。
- `AGENTS.md` slash 命令列表补 `/subagent` 和 `/todos`。
- `extensions/task/task.ts:2236` usage 补 `rename`。

---

### P1: 测试口径混用,发布交接写错

**证据**

- `package.json:19` 默认 `npm test` 只跑 `tests/*.test.ts`。
- `package.json:20` integration 单独跑 `tests/integration/*.test.ts`。
- 实跑 `npm test`: `551 total / 549 pass / 2 skipped`。
- `docs/handoff/2026-07-01-v2.2.0-release-handoff.md:51` 写 `551/551 pass`。
- `tests/runtime-policy.test.ts:45-46` 明确把默认测试和 integration 分离作为期望。

**影响**

后续发布可能把 `npm test` 当“全项目测试全绿”。MCP stdio/process 类问题只在 `test:integration` 覆盖。

**最小处理**

二选一:

1. 新增 `test:all`: `npm test && npm run test:integration`,发布文档只引用 `test:all`。
2. 文档明确写: `npm test = 549 pass / 2 skipped`; `npm run test:integration = 36/36 pass`。

---

### P2: 真死代码 `DriverTranscriptTail`

**证据**

- `extensions/shared/driver-view.ts` 只导出 `DriverTranscriptTail`。
- `rg "DriverTranscriptTail|driver-view"` 无生产 import。
- 其它 `judge-driver-view` 命中在历史文档、smoke 清理事件和 session-view patch 测试里,不是这个模块的调用链。

**影响**

小死代码,但名字会继续暗示旧 driver/judge UI 仍在。

**最小处理**

删除 `extensions/shared/driver-view.ts`。

---

### P2: cron daemon 反向依赖 extension formatter 边界

**证据**

- `cron/service.ts:25` import `../extensions/cron-contract.ts`。
- `extensions/cron-contract.ts:1` import `renderTerminalTable`。
- daemon 实际只需要 `CRON_PATHS`, `CronJob`, `CronRun`。

**影响**

后台 daemon 侧被迫依赖 extension/TUI formatter 侧。现在没炸,但边界是浅的。

**最小处理**

拆成:

- `cron/contract.ts` 或 `extensions/shared/cron-contract.ts`: types + `CRON_PATHS`
- `extensions/cron-format.ts`: `formatCronHealth`, `formatCronJobList`, `formatCronRunHistory`

---

### P2: extension 反向 import `bin/update-core.js`

**证据**

- `extensions/update-check.ts:10` 从 `../bin/update-core.js` 引入核心更新函数。
- 同文件又 re-export 一批 bin 内部函数给测试用。

**影响**

`bin/` 本应是 CLI adapter,extension 不该依赖 bin。现在 update core 同时服务启动 preflight 和 `/update`,应放到中立层。

**最小处理**

把 `bin/update-core.js` 移到 `shared/update-core.js` 或 `lib/update-core.js`,然后 bin 和 extension 同级引用。

---

### P2: 危险命令策略重复三份

**证据**

- `extensions/plan-mode-utils.ts`
- `extensions/task/task-utils.ts`
- `extensions/index.ts`

三处都有危险命令/安装命令/curl 变更类匹配。`extensions/index.ts` 已经修过 `rm -fr` 绕过,但 plan/task 侧仍各维护一套。

**影响**

策略漂移迟早再次发生。安全规则应该共享 primitive,各模式只加自己的差异。

**最小处理**

抽一个小 helper,例如:

- `isRecursiveRm(command)`
- `isPrivilegeEscalation(command)`
- `isPackageMutation(command)`
- `isCurlMutation(command)`

plan/task/runtime gate 各自组合,不要强行做一张全局大表。

---

### P2: LLM JSON 提取重复四份

**证据**

- `extensions/task/task-dispatcher.ts`
- `extensions/task/task-checker.ts`
- `extensions/task/task-spec.ts`
- `extensions/task/task-prompts.ts`

四处都做 fenced JSON / candidate JSON / `JSON.parse` / normalize。

**影响**

不是立刻的 bug,但解析策略一改会漏。

**最小处理**

抽一个很小的 `extractJsonObject(text, normalize)`。不要引入新 parser,沿用现有规则。

---

### P2: taskbook contract 校验重复在 runtime/CLI/marketplace

**证据**

- `extensions/task/task-book.ts:115`
- `bin/task-install.js:66`
- `functions/_lib/marketplace.js:121`

三处都有 contract 校验,但字段覆盖不完全一致。

**影响**

一个入口接受、另一个入口拒绝的情况会继续出现。marketplace、install、runtime 是同一个 taskbook 契约。

**最小处理**

抽 runtime-neutral validator。注意 Cloudflare Functions 不能直接 import TS,所以可选路线:

1. 放一个纯 JS validator,TS 侧也 import。
2. 或暂时只同步规则,不做跨环境共享。ponytail 下第一步可以先修差异,不急着建包。

---

## 测试债

### 默认测试不覆盖 integration

这是项目有意设计,`tests/runtime-policy.test.ts` 也在保护它。但发布说明必须按这个事实写。

最小处理: 新增 `test:all` 或修文档口径。

### environment doctor helper 在无真实 bash 时跳过

`tests/environment-doctor-skill.test.ts` 两个测试都依赖 `realBash`。本机实跑结果是 2 skipped。

最小处理: 保留真实 bash smoke,另补一条纯 Node/假 bash 契约测试,避免默认测试零覆盖这个 helper。

### bundled skill 测试断言文案过多

`tests/bundled-skills.test.ts` 对 skill 正文短语断言很多。改 prose 会红,但用户契约未必坏。

最小处理: 保留 frontmatter 可解析、关键脚本存在、`configure_mcp.py` 行为；正文短语只留少数关键 guard。

### UI 品牌测试偏快照

`tests/ui-brand-extension.test.ts` 和 `tests/ui-brand-utils.test.ts` 钉住很多 glyph/文案/装饰。保留宽度、语言切换、隐藏 API、刷新模型等行为断言即可。

---

## 文档债

### 历史 handoff 污染当前事实

例子:

- `docs/handoff/2026-07-01-v2.1.2-marketplace-and-hardening.md` 仍说 `docs/task-share/**/*.html` 由 `scripts/build-task-share.mjs` 生成。
- `docs/handoff/2026-07-01-marketplace-r2-direct-and-frontend-rewrite.md` 已说明脚本删除、HTML 手写。

这类不需要逐个修正文,更合理的处理是给旧 handoff 加 `Superseded by ...` 横幅,或移动到 archive。

### 旧审查报告本身也可能过期

`docs/reports/2026-06-27-project-health-review.md` 写“删除 16 个社区主题”,但当前 `themes/` 和 README 确认社区主题存在。

最小处理: 不把旧报告当当前事实。若保留在 active docs,加“historical snapshot”标记。

---

## 降级或排除项

这些子代理提出过,但主线程未列为高优先级修复:

| 项 | 处理 | 原因 |
|---|---|---|
| 删除所有测试专用 export / `*ForTests` | 降级 | 会引入更多参数穿透,收益不如先清包边界和文档事实 |
| 删除 `shared/worker-lifecycle` service locator | 降级 | 当前有架构守卫,且是为 task 不 import chrome-cdp 的小型接线；不是当前最大噪音 |
| 抽 raw TTY menu helper | 降级 | `workspace-trust` 和 `update-preflight` 有重复,但只在 bin 侧,不阻塞 |
| 安装器改 `readline/promises` | 降级 | 可净化,但不是边界问题 |
| 安装器 `node --version` 改 `process.versions.node` | 降级 | 对,但收益小 |
| 大规模归档 60-75 个文档 | 降级 | 方向对,但需要项目组确认哪些 handoff 仍有追溯价值 |

---

## 推荐执行顺序

### PR 1: 发布包边界 + smoke 去旧

最小改动:

- `.npmignore` 排除 `functions/`, `migrations/`, `wrangler.toml`, `scripts/`
- `scripts/smoke-tui.mjs` 删除 TUI/`node-pty` 分支和 `/judge` 场景
- 对应更新 `tests/smoke-tui.test.ts`
- 跑 `npm pack --dry-run --json` 验证包内容

预期收益:

- npm 包少约 39 个文件
- 少约 76.9KB 包内容
- smoke 名称和实际行为一致

### PR 2: 当前文档事实修正 + 删除死代码

最小改动:

- README 删“投屏”
- AGENTS 补 `/task publish`, `/subagent`, `/todos`
- `extensions/task/task.ts` usage 补 `rename`
- v2.2.0 handoff 修测试口径
- 删除 `extensions/shared/driver-view.ts`

预期收益:

- 当前上下文不再误导 agent/维护者
- 删除一个旧 driver/judge 残留

### PR 3: 小 helper 收敛

只在碰相关文件时做:

- command policy primitive
- JSON extraction helper
- taskbook contract validator

不要先开大重构。`extensions/task/task.ts` 虽然 2300+ 行,但当前已有大量行为测试,先删边界噪音比硬拆文件更划算。

---

## 估算净收益

| 类别 | 估算 |
|---|---:|
| 发布包可移除 | 约 39 个文件,约 76.9KB |
| 源码可删/合并 | 约 250 行 |
| 测试可删/合并 | 约 330-430 行 |
| 可归档历史文档 | 约 60-75 个文件,需人工确认 |

ponytail 结论: 先删发布包污染、过期 smoke 和当前文档错事实。抽象和大模块重构排后面。
