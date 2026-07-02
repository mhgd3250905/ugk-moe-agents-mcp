# ugk-core 项目说明书

> **当前版本**:v2.3.0(tag `v2.3.0`,commit `c744038`)
> **更新日期**:2026-07-02
> **读者**:接手 ugk-core 开发/维护的工程师。读完这一份,就能建立完整心智模型。
> **定位**:项目全景快照。与现有文档分工——
> - `README.md`:用户向(怎么装、怎么用)
> - `docs/DEVELOPMENT.md`:开发约定(改代码的硬规则)
> - `docs/handoff/`:单次任务/修复的来龙去脉
> - **本文**:当前项目"是什么样、怎么上手、关键在哪"

---

## 1. 这是什么项目

**ugk** 是基于 [pi](https://github.com/earendil-works/pi)(`pi-coding-agent`)定制的终端编码 agent。一条命令 `npm i -g ugk-agent` 装完,打 `ugk` 即用。

核心定位:**用户无需关心 pi**。pi 是 UGK 的内部 runtime,版本由 UGK 发行版固定管理;用户只更新 UGK,不单独跑 `pi update`。

技术栈:Node.js 18+ / TypeScript / Cloudflare Pages Functions(marketplace 后端)/ D1 + R2(task 市场存储)。

---

## 2. 快速上手(开发环境)

```bash
git clone <repo> ugk-core
cd ugk-core
npm install
npm link              # 让全局 ugk 指向本仓库(开发时改代码即时生效)
npm test              # 568 pass / 0 fail(默认测试)
npm run test:integration   # 36/36(integration,默认不跑)
```

**关键**:`npm link` 后,全局 `ugk` 命令直接跑仓库代码。改 `extensions/`、`bin/` 立即生效,无需重装。

**两条测试口径**(有意设计,受 `tests/runtime-policy.test.ts` 保护):
- `npm test` = 只跑 `tests/*.test.ts`(单元/逻辑覆盖)
- `npm run test:integration` = 只跑 `tests/integration/*.test.ts`(MCP stdio/process 等需真实环境的)

发布前两者都要绿。

---

## 3. 项目结构(当前真实状态)

```
ugk-core/
├── package.json              # name=ugk-agent, version=2.3.0, bin=ugk
├── bin/
│   ├── ugk.js                # CLI 入口(薄壳:启动期 dispatch + 调 pi main + -e 注入扩展)
│   ├── task-install.js       # task install/remove/update CLI 命令(v2.3.0 新增 remove/update)
│   ├── ugk-cli-args.js       # 透传用户参数 + 追加 -e
│   ├── ugk-runtime-policy.js # applyUgkRuntimePolicy(压制 pi 更新面)
│   ├── ugk-*-patch.js        # pi runtime patch(session-view/package-update/extension-overlay/editor-border)
│   ├── update-core.js        # /update + 启动 preflight 共用的核心更新逻辑
│   ├── update-preflight.js   # 启动入口更新检查
│   └── workspace-trust.js    # 工作区信任门
├── AGENTS.md                 # 运行时注入上下文(agent 人设 + 项目准则,pi 自动加载)
├── extensions/               # ★ 主能力区
│   ├── index.ts              # 主入口:工具/命令注册 + @mention + 权限门 + resources_discover
│   ├── task/                 # task 系统(task.ts 2300+ 行 + task-book/share-publish/verify 等)
│   ├── chrome-cdp/           # 本地登录态 Chrome CDP 控制
│   ├── mcp/                  # MCP stdio client/registry/tools/permissions
│   ├── cron.ts + cron-contract.ts
│   ├── subagent.ts + subagent-runtime/ + agents.ts
│   ├── plan-mode.ts + plan-mode-utils.ts + plan-mode-state.ts
│   ├── ui-brand.ts           # 品牌 UI(header/footer/title)
│   ├── ui-brand-utils.ts / ui-brand-extension.ts
│   └── shared/               # 跨扩展共享(driver-view.ts 已于 v2.3.0 删除)
├── cron/service.ts           # 常驻定时服务(node-cron + HTTP,npm run cron:start)
├── agents/                   # 预设 subagent(scout/planner/reviewer/checker/worker,随包加载)
├── skills/                   # 随包 skill(resources_discover 自动发现)
├── themes/                   # ugk-geek 默认 + 16 社区主题
├── prompts/                  # /implement /scout-and-plan 等
├── functions/                # ★ Cloudflare Pages Functions(marketplace 后端)
│   ├── _lib/marketplace.js   # 核心业务(OAuth/session/submitTask/manifest/like/favorite...)
│   └── api/                  # REST 端点
├── migrations/               # D1 数据库 migration(task marketplace 表)
├── scripts/                  # smoke-task/smoke-rpc(RPC-only,非 TUI)
├── docs/                     # 本文档 + handoff/design/reports
└── tests/                    # Node test runner(*.test.ts + integration/)
```

---

## 4. 能力清单(当前版本)

### 自定义工具
| 工具 | 作用 |
|---|---|
| `subagent` | 子代理委派(single/parallel/chain 三模式,隔离 context 只回摘要) |
| `cron` | 定时任务管理(独立常驻进程,到点起 `ugk --print` 子进程) |
| `chrome_cdp` | 受保护的本地登录态 Chrome 控制(默认 ask-gated) |
| `mcp` | MCP stdio client,连外部 server 注册为 `server__tool` |
| `run_task` | subtask 工具:复用已机器验收的 taskbook,返回 PASS/FAIL + 产物 |

### task 系统(v2.3.0 重点)
- **四阶段**:`planning` → `executing` → `reviewing` → `landed`(taskbook 就绪)
- **CLI 命令**:`ugk task install|update|remove <name>`(v2.3.0 补齐 update/remove)
- **市场**:Cloudflare Pages + D1 + R2,publish 走 Bearer token OAuth 中转
- **taskbook 契约**:5 个核心文件(taskbook/spec/skill/verify/contract)+ 可选 `scripts/` 子目录

### slash 命令(v2.3.0 已对齐代码)
`/ugk` `/welcome` `/subagent` `/update` `/cdp` `/mcp` `/ugk-ui` `/ui-language` `/ugk-autopilot` `/language` `/plan` `/todos` `/task`(`/task list|show|new|run|edit|rename|save|delete|publish|toggle|exit`)

---

## 5. 关键架构契约(改代码前必知)

1. **pi 是内部 runtime,版本钉死**:`package.json` 里 `@earendil-works/*` 全部固定,pi 升级只能通过 UGK 主动升依赖 + 兼容验证 + 发新版。
2. **pi runtime patch**:`bin/ugk-*.js` 在启动时安装(Symbol.for 守卫防重复),pi 升级后每个 patch 的 descriptor 检查可能失效,需回归。
3. **UI 组件不得在 render 阶段持有 ExtensionContext**:必须在 `session_start` 抽取普通 session 数据,防 session replacement 后 stale ctx 崩溃。
4. **bash 走 Git Bash**:Linux 语法,Windows 路径用正斜杠;Git Bash 路径由 `doctor/checks.ts` 解析或用户 `settings.json` 的 `shellPath` 提供。
5. **task 打包/下载契约**(v2.3.0 修复):publish 打包**扫描目录**(含 `scripts/`,排除 `*.test.mjs`);`REQUIRED_FILES`(5 个)是"最小必需校验集",**不是打包全集**;引用完整性两端校验(本地 publish + 服务端 submitTask)。

详见 `docs/DEVELOPMENT.md` 和 `docs/extension-contracts.md`。

---

## 6. 测试与发布

### 测试
```bash
npm test                      # 单元/逻辑(568 pass / 0 fail)
npm run test:integration      # 集成(36/36,需真实环境)
npm pack --dry-run --json     # 验证 npm 包内容(应无 functions/migrations/scripts/wrangler)
```

**注意**:`npm test` 的通过数随环境浮动——`environment-doctor-skill` 的 2 个 `realBash` 守卫测试在 bash 可用时执行、不可用时 skip。两者都算全绿,不要写死具体数字。

### 发布流程(已验证的约定)
1. 改动走 PR(分支 → push → `gh pr create` → 审核自合 → 本地 main 拉取)
2. 合并后升版本号(语义化:feat 升 minor,fix 升 patch)
3. 改 `package.json` version → commit `chore(release): vX.X.X` → 打 annotated tag `vX.X.X` → push main + tag
4. tag 号与 `package.json` version **严格对齐**(仓库既有习惯)
5. (可选)`npm publish` 发 npm 包

---

## 7. 最近做了什么(v2.2.0 → v2.3.0)

| 版本/PR | 内容 | 文档 |
|---|---|---|
| **v2.3.0 PR #32** | fix: publish 打包漏传 scripts/ + 链路引用校验 | `docs/handoff/2026-07-02-task-publish-scripts-fix-handoff.md` |
| **v2.3.0 PR #31** | feat: task update / remove CLI 命令(补齐更新环节) | 同上 |
| **v2.3.0 PR #30** | chore: 边界清理(npm 包/smoke/死代码/文档事实) | `docs/handoff/2026-07-02-boundary-cleanup-plan.md` |
| v2.2.0 | 发布交接(marketplace r2 直连 + 前端改写 + hardening) | `docs/handoff/2026-07-01-v2.2.0-release-handoff.md` |

**接手必读**:`docs/handoff/2026-07-02-task-publish-scripts-fix-handoff.md` —— 它汇总了 task 系统当前状态、三个 PR 的根因/修法、三层验证方法。

---

## 8. 已知待办 / 待决策(非阻塞)

- **结构债(P2,按 ponytail 留待碰相关文件时做)**:危险命令策略三处重复、LLM JSON 提取四处重复、taskbook contract 校验三处不一致、cron daemon 反向依赖 extension formatter、extension 反向 import bin/update-core.js。详见 `docs/handoff/2026-07-02-boundary-cleanup-plan.md` 附录。
- **x-search JSON 截断**:偶发,根因是 worker 把整个 JSON 当文本生成撞 token 上限。未改代码,等第二次复现确认。详见 `docs/handoff/2026-07-02-x-search-json-truncation-diagnosis.md`。
- **`/task publish` 体验缺陷**:一路回车会用默认标题/描述提交,易误发重复 submission。非 bug,留待决策。

---

## 9. 文档导航

| 想了解 | 看哪 |
|---|---|
| 用户怎么装/用 | `README.md` |
| 改代码的硬规则 | `docs/DEVELOPMENT.md` + `docs/extension-contracts.md` |
| 项目当前全景(本文) | `docs/PROJECT-GUIDE.md` |
| 某次改动为什么这么做 | `docs/handoff/`(按日期) |
| 设计契约 | `docs/design/`(task-extension-spec / subtask-extension-spec 等) |
| 历史审查/体检 | `docs/reports/` + `docs/reviews/` + `docs/automated-reviews/` |

---

## 10. 维护本文

本文是**当前状态快照**,版本演进后需更新:能力清单(§4)、最近改动(§7)、待办(§8)。改代码发新版时,顺手同步本文 + 写对应 handoff。
