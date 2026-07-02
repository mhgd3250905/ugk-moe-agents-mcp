# 会话交接:TUI 内上传 task 到市场 — 实现完成 + 真机验证通过

> **日期**:2026-07-01
> **交接对象**:接手"TUI 内上传 task"后续工作(发布到市场/admin 审核/后续优化)的会话
> **上一会话产出**:需求文档 `docs/design/2026-07-01-task-publish-from-tui.md` + 三份交接
> **本会话产出**:Phase 1-4 全部代码 + 测试 + **部署 + 真机验证通过**(首次 OAuth 中转 + 后续凭证复用两条路径)
> **状态**:**547/547 pass**,已部署到生产 `ugk-task-share.pages.dev`,migration 0007+0008 已应用
> **分支**:`feat/tui-publish-task`(3 个 commit,待合并)

---

## 1. 本会话做了什么

实现"TUI 内 `/task publish` 上传 taskbook 到市场"功能。需求文档 §4 改动清单全部落地,并经**对抗式代码审查**修复了一批真问题。

### 三端改动

| 端 | 文件 | 内容 |
|---|---|---|
| **后端** | `migrations/0007_cli_auth.sql` | 新建 `cli_auth_pending` + `cli_tokens` 两表 |
| | `functions/_lib/marketplace.js` | `startCliAuth` / `pollCliAuth` / `createCliToken` / `requireBearerUser`(隔离的 Bearer 鉴权);`githubCallback` 加 cli 分支;`submitTask` 支持 Bearer+cookie 双鉴权 |
| | `functions/api/cli/auth/start.js` `poll.js` | thin endpoints |
| **网页** | `docs/task-share/cli-auth/index.html` | 中转页:`?c=<challenge>` 写 cookie 跳 OAuth;`?cli=done` 显示成功 |
| **TUI** | `extensions/task/task-share-auth.ts` | challenge 生成 + task-share.json 读写(BOM-safe)+ start/poll 轮询 + openBrowser |
| | `extensions/task/task-share-publish.ts` | 打包 zip(清空 runs)+ Bearer 上传 |
| | `extensions/task/task.ts` | `MENU_TO_ACTION` + 菜单项 + `publish` action + `handleTaskPublish` |
| **测试** | `tests/task-marketplace-functions.test.ts` | +10 测试(cli auth 全链路 + 审查修复) |
| | `tests/task-share-auth.test.ts` | 新建,9 测试 |
| | `tests/task-share-publish.test.ts` | 新建,7 测试 |
| | `tests/task-extension.test.ts` | 菜单断言同步更新(+1 项"上传到市场") |

### 测试基线

`npm test` = **545/545 pass**(原 519 + 新增 26)。每处核心逻辑都做了**改坏验证**(临时破坏代码确认测试转红再恢复)。

---

## 2. 对抗式审查的修复(重要,接手必读)

派 sub agent 做了对抗式审查,审查报告识别了多个真问题,本会话修复了其中影响正确性/安全的核心项。**未修复的作为已知债(§4)**。

### 已修复

| 审查编号 | 问题 | 修复 |
|---|---|---|
| **H1** | `requireUser` 加 Bearer 分支后,**所有 cookie 写端点**(like/favorite/report/submit)都接受了 Bearer,攻击面被无意扩大 | 拆出独立的 `requireBearerUser`,**只有 `submitTask` 接受 Bearer**;其余端点仍纯 cookie。`submitTask` 用 `hasBearer` 分流 |
| **H2/M1** | `createCliToken` 不校验 challenge 是否在 pending → stale cli cookie 会劫持后续普通网页登录;且同 challenge 可能签多 token | `createCliToken` 先查 pending,**不在则返回 null 不签 token**;callback 见 null 则走普通 `/` 重定向。这一个修复同时根治了 H2(token 堆积)和 M1(cookie 残留污染) |
| **H3** | `pollCliAuth` 的"single-use"注释承诺清 sibling token,代码没做 | poll 返回 token 时 `DELETE sibling`(留最新的)。注:claimed token 保留(因 submit 按 token 查非按 challenge);同 challenge 重复 poll 返回同一有效 token,对 TUI 重试是合理幂等,且只有 32 字节随机 challenge 持有者能 poll |
| **N4** | 死代码:`CLI_TOKEN_COOKIE_TTL` 常量定义了从未用 | 删除 |

### 未修复(已评估,作为已知债)

详见 §4。核心判断:**C1(state-challenge 未绑定)/ C2(challenge cookie 无 HttpOnly)** 属纵深防御,challenge 本身是 5min 单次握手标识(非长期凭证,真正凭证 cli_token 从不进 cookie),且攻击前提需要 XSS/中间人(另一层)。本轮保持与设计文档一致,不扩大改动面。

---

## 3. 部署 + 真机验证(✅ 已完成)

本会话已部署到生产并通过真机验证。**核心功能可用**。

### 3.1 已部署状态(2026-07-01)

| 组件 | 状态 |
|---|---|
| migration 0007(cli_auth_pending + cli_tokens) | ✅ 已应用远端 |
| migration 0008(debug_log 开发期日志表) | ✅ 已应用远端 |
| Pages Functions(含 CLI auth 端点) | ✅ 已部署(`cbd90f2b`) |
| 主域名 `ugk-task-share.pages.dev` | ✅ 指向最新 main 部署 |
| `debug_log` 表 | ✅ 已建,带 500 行容量上限 |

### 3.2 真机验证结果(两条路径全通)

**路径 A:首次上传(OAuth 中转)**
- TUI `/task publish` → start 写 pending → 浏览器打开授权 URL → GitHub 登录 → callback 签 cli_token → TUI 轮询拿到 token → 上传 `x-search` v1.0.0
- ✅ D1 task_submissions 收到(id=5, pending)

**路径 B:后续上传(凭证复用)**
- TUI `/task publish` → 检测本地有 token → 跳过授权 → 直接上传 `subtitle-fluent-translator` v1.0.0
- ✅ D1 task_submissions 收到(id=6, pending),无新 OAuth 流程

**curl 链路**:start/poll/submit 七项全部符合预期(详见 debug_log 完整 6 节点链路)。

### 3.3 真机踩坑(本会话暴露的,文档不会写)

**⚠️ 踩坑 #1(关键):`crypto.randomUUID` 在 Workers 的 Illegal invocation**

`createCliToken` 原写法 `(deps.randomUUID ?? crypto.randomUUID)()` —— 把 `crypto.randomUUID` 当裸函数引用调用,丢失 `this` 绑定。**Node 的 crypto 宽容不报错(单测全过),但 Workers 严格校验 `this`,抛 `TypeError: Illegal invocation: function called with incorrect this reference`**(Worker 异常 → 前端看到 Error 1101)。

根因诊断极其困难:Error 1101 是 Worker 未捕获异常,不返回响应体。靠**开发期日志(debugLog → debug_log 表)** 才定位——日志显示 token_exchange/user_fetch 都成功,崩在 createCliToken。

**修复**:`deps.randomUUID ? deps.randomUUID() : crypto.randomUUID()`,直接在 `crypto` 上调用保 `this`。注释记 `ponytail:` 标明这是 Workers-only 差异。

**教训**:任何 `obj.method` 形式的引用脱离对象调用,在 Workers 都可能 Illegal invocation。`githubLogin` 里 `crypto.randomUUID()`(直接调用)是正确的,`createCliToken` 里(取引用后调用)是错的。**这类 bug 只有真机能抓**。

**⚠️ 踩坑 #2:Pages 分支部署 vs 主域名**

`wrangler pages deploy --branch feat/tui-publish-task` 会生成别名域名 `feat-tui-publish-task.ugk-task-share.pages.dev`,但**主域名 `ugk-task-share.pages.dev` 仍指向旧 main 部署**。curl 主域名会发现新 Functions 没生效(404/旧行为)。必须 `--branch main` 部署才更新主域名。

**⚠️ 踩坑 #3:`/cli-auth` URL 规范化**

Pages 对 `/cli-auth`(无尾斜驳)返回 308 重定向到 `/cli-auth/`(加尾斜杠,保留 query)。curl 默认不跟随重定向,测试时要加 `-L`。浏览器自动跟随,不影响真实用户。

---

## 4. 已知债(审查未修 + 待办)

> 优先级:**P0 安全必修** / **P1 应做** / **P2 可选优化**。本会话核心功能已验证,以下都不阻塞使用。

### ✅ 已修复(P0 全部 + 早期债)

- ~~**OAuth state 与 challenge 绑定 + 去 challenge cookie**(C1+C2,commit `6717fb8`)~~ → migration 0009 加 state 列;githubLogin 服务端绑定 state→challenge;callback 用已验证 state 反查 challenge(不再读 JS cookie);cli-auth 页改纯跳转。**已真机验证**(debug_log 全 6 节点,无 exception)
- ~~**cli_tokens 90 天过期**(H2,commit `6717fb8`)~~ → requireBearerUser 查询加 `created_at > cutoff` + lazy GC 删过期行
- ~~task-share.json 文件权限(L1)~~ → `chmodSync(filePath, 0o600)`
- ~~版本号重复静默失败(M6)~~ → submitTask 查 task_versions,重复 409
- ~~token 格式未校验(M4)~~ → ensureCliAuth 校验 `/^[0-9a-f]{32}$/`
- ~~reviewSubmission 无 try-catch~~ → INSERT/UPDATE 包 try-catch
- ~~debug_log 无限增长~~ → DEBUG_LOG_MAX_ROWS=500
- ~~卡片文案显示 taskbook 长指令~~ → publish 时让用户填 title/description

### 🔴 P0 待配置(代码已就绪,需 dashboard 操作)

1. **`/api/cli/auth/start` 速率限制**(M3):零代码方案,需在 Cloudflare dashboard 加 Rate Limiting rule。**配置说明**:
   - 进 dash.cloudflare.com → 选 `ugk-task-share` 项目 → Security → WAF → Rate limiting rules → Create
   - **Rule name**: `cli-auth-start-rate-limit`
   - **Expression**: `(http.request.uri.path eq "/api/cli/auth/start")`
   - **Characteristics**: `cf.colo.id` + `ip.src`(按 IP 限流)
   - **Period**: 60 seconds
   - **Requests**: 10(每 IP 每分钟 10 次授权启动,正常使用远低于此)
   - **Action**: Block
   - 注:Cloudflare Rate Limiting as-code(wrangler.toml 管理)仍在推进,暂用 dashboard

### 🟡 P1 应做

5. **开发期日志待清理**:流程稳定后删 `debugLog` 调用点 + `debug_log` 表 + migration 0008 + 定义。当前留着(本次定位 Illegal invocation 靠它),有 500 行上限不爆。
6. **`handleTaskPublish` 无集成测试**:菜单/action/Usage 有测,但编排(ensureCliAuth→问 version→publishTask)只单测覆盖内部调用,没测 task.ts 胶水逻辑。需像其他 `handleTask*` 建集成测(注入 mock ctx.ui + mock 模块)。

### ⚪ P2 可选优化

7. **`openBrowser` URL 未引用**(审查 L2):win32 `start` 对含 `&` 的 URL 敏感。当前 URL 安全(marketplace 固定 + challenge 纯 hex)。有 URL 兜底显示,影响有限。
8. **轮询无 jitter**(审查 L3):固定 2s 间隔。超时文案硬编码"120 秒"但 `timeoutMs` 可注入 → 文案与实际不符。

---

## 5. 关键文件索引(本会话新增/改动)

### 新增
| 文件 | 作用 |
|---|---|
| `migrations/0007_cli_auth.sql` | cli_auth_pending + cli_tokens 表 |
| `migrations/0008_debug_log.sql` | 开发期 debug_log 表(流程稳定后删) |
| `functions/api/cli/auth/start.js` `poll.js` | thin endpoints |
| `docs/task-share/cli-auth/index.html` | OAuth 中转页 |
| `extensions/task/task-share-auth.ts` | TUI 授权(challenge/json/轮询/openBrowser/token 格式校验) |
| `extensions/task/task-share-publish.ts` | TUI 打包上传 |
| `tests/task-share-auth.test.ts` `task-share-publish.test.ts` | TUI 单测 |

### 改动
| 文件 | 改动点 |
|---|---|
| `functions/_lib/marketplace.js` | 顶部常量 + `debugLog`(开发期);`requireBearerUser`(新,隔离 Bearer)+ `requireUser`(恢复纯 cookie);`startCliAuth`/`pollCliAuth`/`createCliToken`(新,含 Illegal invocation 修复);`githubCallback` cli 分支 + try-catch;`submitTask` 双鉴权 + 版本查重;`reviewSubmission` try-catch |
| `extensions/task/task.ts` | import;`MENU_TO_ACTION`;菜单选项;`publish` action;`handleTaskPublish`;Usage 文案 |
| `tests/task-marketplace-functions.test.ts` | mock DB 加 cli 两表 + task_versions 查重支持;+11 测试 |
| `tests/task-extension.test.ts` | 菜单断言 +1 项 |

---

## 6. 工作约定(延续)

- **ponytail full**:最短可用 diff、根因修复、复用优先、`ponytail:` 注释标刻意简化
- **对抗式审查**:设计/排查派 sub agent 审,逐条自己读源码复核(本次审查报告见 §2)
- **改坏验证**:每个核心逻辑实现/修复后,临时改回 buggy 确认测试转红
- **真机验证不可省**:Workers runtime ≠ Node——本会话正是靠真机 + debugLog 日志定位了 `crypto.randomUUID` Illegal invocation(Node 宽容、Workers 严格,单测抓不到)
- **bash 走 Git Bash**,Linux 语法,Windows 路径正斜杠
- **危险操作前确认**

---

> 本会话实现依据:`docs/design/2026-07-01-task-publish-from-tui.md`。市场架构:`docs/handoff/2026-07-01-marketplace-r2-direct-and-frontend-rewrite.md`。上一会话交接:`docs/handoff/2026-07-01-session-handoff-tui-publish.md`。
