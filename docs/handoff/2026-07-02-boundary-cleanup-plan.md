# ugk-core 边界清理修改计划

> **日期**:2026-07-02
> **性质**:执行计划(交原作者执行,审核方对照复核)
> **来源**:对抗式审查复核 `docs/reviews/2026-07-02-subagent-boundary-codebase-review.md` 后产出
> **基准**:worktree `E:\AII\worktrees\ugk-core\codex-scratch-20260702`(HEAD `4ac084b`,v2.2.0)。所有行号以此为准。
> **修正了原报告 3 处精度瑕疵**(见各条"⚠️ 修正")。
> **结构债(P2)本轮不含**,按 ponytail 原则留待"碰相关文件时做",见末尾附录。

---

## PR1:发布包边界 + smoke 去旧 + driver-view 死代码清理

> driver-view 清理从原报告 PR2 **并入 PR1**:删 `driver-view.ts` 前必须先清 smoke 断言和测试桩,存在测试依赖,合并一个 PR 才能保证每一步测试都绿。

### 1.1 `.npmignore` —— 排除 Cloudflare 半包

当前 `.npmignore` 排除了 `docs/` 等,但**没排除** `functions/`、`migrations/`、`wrangler.toml`、`scripts/`。实测 39 个文件进了主包。

**改法**:在 `.npmignore` 末尾(`.flow/` 之后)加 4 行:
```gitignore
functions/
migrations/
wrangler.toml
scripts/
```

**验证**:`npm pack --dry-run --json` 后,`functions/*`、`migrations/*`、`wrangler.toml`、`scripts/*` 应全部消失,文件总数从 177 降到约 138。

### 1.2 `scripts/smoke-tui.mjs` —— 删假 TUI + 已删 `/judge` 场景

`node-pty` 未在 package.json 的 deps/devDeps 声明,`smoke:tui` 名义是真 TUI 实际跑 RPC fallback;`/judge` 命令已从扩展删除但 smoke 仍测。

**改法**:
- 删 `loadNodePty` 函数(L28-34 附近)及其在 L255 的 `const pty = await loadNodePty();` 调用
- 删 `runTuiSmoke` / `--driver=tui` 分支(整段 pty 驱动逻辑)
- 删 `/judge` 场景:L107 `await input("judge-menu-exit", "/judge\r", 1000);` 和 L230 `scenarios.push(await command("judge-menu-exit", { type: "prompt", message: "/judge" }));`
- 保留 RPC smoke;若脚本/报告里有 driver 字样,改成明确的 `rpc` 表述
- 评估是否把 `smoke:tui` 重命名为 `smoke:rpc`(更名实副)—— 若重命名,同步改 `package.json:18` 的 script 名

### 1.3 `tests/smoke-tui.test.ts` —— 同步 smoke-tui 改动

当前 L20-27 测试 `chooseDriver`/`parseDriver` 固化了 `--driver=tui` 和 `hasNodePty` 的 fallback 行为。删了 TUI 分支后这些断言会失效。

**改法**:
- 删 `parseDriver(["--driver","tui"])` 断言(L22)和 `chooseDriver("tui", { hasNodePty: false })` 断言(L25-27)中依赖已删分支的部分
- 保留 RPC 路径的断言
- 若重命名为 smoke:rpc,测试文件名和 import 路径同步

### 1.4 `extensions/shared/driver-view.ts` —— 删死代码(46 行)

`DriverTranscriptTail` 在生产代码零 import(仅定义自身)。但**有第二处活引用原报告漏了**:

⚠️ **修正原报告**:原报告 P2 只点了 `driver-view.ts` 死代码文件,但 `scripts/smoke-task.mjs:44` 仍在断言 `judge-driver-view` widget,`tests/smoke-task.test.ts:78-82` 还有 driver/judge 的 mock 测试桩。删文件前必须先清这两处,否则留下隐蔽残留。

**改法(必须按此顺序,顺序反了会导致中间态测试红)**:
1. `scripts/smoke-task.mjs:44` —— 删 `if (msg.method === "setWidget" && msg.widgetKey === "judge-driver-view") ...` 这条 widget 断言
2. `tests/smoke-task.test.ts:78-82` —— 删 `judge-driver-view` widget 和 `judge-mode` status 的 mock 数据(L78、L79、L82)
3. **最后**删 `extensions/shared/driver-view.ts` 整个文件

### PR1 验证
```bash
npm test                      # 默认测试全绿(549 pass + 2 skipped,与改前同口径)
npm pack --dry-run --json     # 确认 39 文件消失,主包无 functions/migrations/wrangler/scripts
```

---

## PR2:当前文档事实修正 + 测试口径修正

### 2.1 `README.md:5` —— 删不存在的"投屏"

当前:`...装完就拥有全部能力(投屏、子代理、定时任务、plan 模式、MCP tools 接入等)。`
"投屏"能力(adb/scrcpy skills)已在 2026-06-30 删除(见 `docs/automated-reviews/2026-06-30-a9e29b4.md:16`)。

**改法**:删掉"投屏、"三个字。

### 2.2 `AGENTS.md` —— 补齐 slash 命令清单(落后于代码)

worktree 版 AGENTS.md 落后代码三处。

⚠️ **修正原报告**:原报告说"usage 漏 publish"是错的。实测 `task.ts` usage 行**已有 publish、缺 rename**;而 AGENTS 的 `/task` 清单**已有 rename、缺 publish**。两处缺漏正好相反,对齐目标:两边都应是 `list|show|new|run|edit|rename|save|delete|publish|toggle|exit`。

**改法**:
- **`AGENTS.md:60`** —— `/task` 子命令清单补 `publish`(当前为 `list|show|new|run|edit|rename|save|delete|toggle|exit`,缺 publish)
- **`AGENTS.md` slash 列表(L74-85)** —— 补 `/subagent` 和 `/todos` 两行。参照已有格式:
  ```
  - `/subagent` — 子代理委派(single/parallel/chain)
  - `/todos` — 待办清单(plan-mode 注册,见 `extensions/plan-mode.ts:136`)
  ```
- **`extensions/task/task.ts:2240`** —— usage 文案补 `rename`(当前为 `list|show|new|run|edit|save|delete|publish|toggle|exit`,代码 L2224 有 `handleTaskRename` 但 usage 没列)

### 2.3 测试口径修正

`npm test`(默认,只跑 `tests/*.test.ts`)实测 **549 pass + 2 skipped**;`npm run test:integration` 实测 **36/36 pass**(不在默认覆盖里)。但 `docs/handoff/2026-07-01-v2.2.0-release-handoff.md:51` 写"551/551 pass",与事实不符。`runtime-policy.test.ts:45-46` 把"默认测试与 integration 分离"作为受保护的设计。

**改法**(二选一,推荐 A):

- **A(推荐,ponytail:不为单次需要加 script)**:改文档口径,不改 script。
  - `docs/handoff/2026-07-01-v2.2.0-release-handoff.md:51` 改为:
    `| 测试 | **npm test: 549 pass / 2 skipped**;**npm run test:integration: 36/36 pass** |`
  - 在该 handoff 或 README 测试章节补一句说明:默认 `npm test` 不含 integration,integration 需单独跑(这是 `runtime-policy.test.ts` 保护的有意设计)。

- **B(若项目认为发布应一键全跑)**:`package.json` 加 `"test:all": "npm test && npm run test:integration"`,发布文档只引用 `test:all`。

### PR2 验证
```bash
npm test                                # 仍 549 pass + 2 skipped(口径未变,只是文档诚实了)
grep -n "投屏" README.md                # 应无输出
grep -n "publish" AGENTS.md             # 应命中 /task 清单
grep -n "/subagent\|/todos" AGENTS.md   # 应命中
```

---

## 附录:P2 结构债(本轮不含,留待碰相关文件时做)

按 ponytail 第一性原则,结构债不为本轮清理单独立项,仅在后续触碰相关文件时顺手收敛:

| 项 | 触发时机 | 最小改法 |
|---|---|---|
| 危险命令策略三处重复(`extensions/index.ts` / `plan-mode-utils.ts` / `task/task-utils.ts`) | 下次改命令门规则时 | 抽 `isRecursiveRm/isPrivilegeEscalation/isPackageMutation/isCurlMutation` 小 helper,各模式组合。注意 `task-utils.ts` 内部就有两套策略且已漂移(后者多 pip3/uv/cargo) |
| LLM JSON 提取四处重复(task-dispatcher/checker/spec/prompts) | 下次改 JSON 解析逻辑时 | 抽 `extractJsonObject(text, normalize)`,沿用现有规则不引新 parser |
| taskbook contract 校验三处不一致(task-book.ts / bin/task-install.js / functions/marketplace.js) | 下次改 contract 校验时 | 先修字段差异;跨环境共享需注意 Cloudflare Functions 不能直接 import TS |
| cron daemon 反向依赖 extension formatter | 下次改 cron 边界时 | 拆 `cron/contract.ts`(types+CRON_PATHS)与 `extensions/cron-format.ts`。注意 daemon 当前只用纯类型+常量,是轻耦合,优先级低于前三项 |
| extension 反向 import bin/update-core.js | 下次改更新逻辑时 | 移到 `shared/update-core.js`,bin 和 extension 同级引用 |

---

## 交付与审核

- **PR1 和 PR2 相互独立,可并行或分先后**。
- 每个 PR 完成后跑 `npm test` 确认全绿(549 pass + 2 skipped)。
- PR1 额外跑 `npm pack --dry-run --json` 验证包内容。
- **原作者执行要点**(最容易出错的两处,计划里已写,在此强调):
  1. **PR1 driver-view 清理必须按顺序**:先清 `smoke-task.mjs:44` 和 `smoke-task.test.ts:78-82`,**最后**才删 `driver-view.ts` 文件。顺序反了会导致中间态测试红。
  2. **AGENTS.md / task.ts 的缺漏正好相反**:AGENTS 的 `/task` 清单缺 `publish`,task.ts 的 usage 缺 `rename`。别按原报告(原报告把这两个搞反了)—— 以本计划 §2.2 为准。
- 改完后由审核方对照本计划逐条复核:行号、改法、测试影响、验证命令、有无顺手引入未计划的改动。
