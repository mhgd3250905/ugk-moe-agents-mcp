# TUI 内上传 task 到市场 — 需求文档 + 行动计划

> **日期**:2026-07-01
> **状态**:需求已定,待实现(交接到新会话)
> **规范**:ponytail full(最短可用 diff、复用优先、每步留可跑 check)
> **前置阅读**:`docs/handoff/2026-07-01-marketplace-r2-direct-and-frontend-rewrite.md`(市场架构)、`docs/handoff/2026-07-01-frontend-ui-optimization-handoff.md`(前端结构)

---

## 0. 一句话需求

用户在 UGK TUI 里跑出 landed task 后,输入 `/task publish`,把本地 taskbook 上传到 task 分享市场(`https://ugk-task-share.pages.dev`),无需切到浏览器上传。首次上传时通过市场网站 OAuth 中转拿登录凭证,之后凭证存本地复用。

---

## 1. 用户操作流程(已和用户对齐)

### 首次上传(无凭证)

```
1. 用户在 TUI 跑出 landed task
2. 输入 /task publish(或 /task 菜单选"上传到市场")
3. TUI 检测本地无凭证(~/.pi/agent/task-share.json 不存在或无 token)
4. TUI 生成 challenge(随机码),POST /api/cli/auth/start
5. TUI 显示授权 URL:
   ┌───────────────────────────────────────────────┐
   │ 首次上传需要授权。请在浏览器打开:            │
   │ https://ugk-task-share.pages.dev/cli-auth?c=xxx │
   │ 等待授权中...(浏览器登录后会自动继续)        │
   └───────────────────────────────────────────────┘
6. 用户浏览器打开 → 点 Sign in with GitHub → GitHub 授权
7. 市场网页显示"✅ 授权成功,请回到终端"
8. TUI 轮询 /api/cli/auth/poll 拿到 cli_token + login → 存 task-share.json
9. TUI 让用户确认/输入 version(默认 1.0.0)
10. TUI 读 taskbook 5 文件 → 打包 → 带 cli_token 上传
11. TUI 显示"✅ 已提交,等待审核"
```

### 后续上传(有凭证)

```
1. 输入 /task publish
2. TUI 检测有凭证 → 直接读 taskbook → 问 version → 上传
3. "✅ 已提交"
```

---

## 2. 六个决策点(已定)

| # | 决策点 | 选择 | 依据 |
|---|---|---|---|
| ① | 上传入口 | **`/task publish` 独立子命令 + 菜单项** | 符合现有 action 模式(task.ts:2011-2173) |
| ② | 上传哪个 task | **从 landed/已存 taskbook 列表选** | publish 不依赖当前 session state(可能没 active task) |
| ③ | version | **每次问用户,默认 1.0.0** | 用 `ctx.ui.input` 做单次输入;重复发布需要升版本 |
| ③ | title/description | **从 taskbook.json 自动取** | taskbook.description 已是结构化字段;减少摩擦 |
| ④ | 授权 URL | **TUI 尝试自动打开浏览器,失败则显示 URL** | 复用 launcher.ts 平台判断模式 |
| ⑤ | 上传后 | **进 admin 待审核队列** | 复用现有 submitTask 流程,不改 publish 逻辑 |
| ⑥ | scripts/ 子目录 | **本轮只传 5 个核心文件,scripts 丢弃** | REQUIRED_FILES 只认 5 个;scripts 支持是独立大需求 |

---

## 3. 认证方案:市场网站 OAuth 中转(PKCE 式)

### 核心思路

市场网站已有的 GitHub OAuth(`functions/_lib/marketplace.js:193-260`)直接复用。TUI 不直接碰 GitHub,而是让市场网站当 OAuth 中转:终端生成 challenge → 用户去市场网页登录(复用已有 OAuth)→ 终端轮询拿 cli_token。

### 数据流

```
TUI                              市场网站(Cloudflare)              GitHub
───                              ──────────────────              ──────
1. 生成 challenge(32 字节随机 hex)
   存本地 task-share.json {challenge}
        │
        ↓ POST /api/cli/auth/start {challenge}
                                 记录 challenge 到 D1 cli_auth_pending
                                 返回授权 URL
        │                                             ← {url: ".../cli-auth?c=<challenge>"}
   显示/打开 URL
        │
   (用户浏览器打开)
        │                      2. /cli-auth?c=<challenge> 页面
        │                         存 challenge 到 cookie,跳 /api/auth/github
        │                      3. 用户点 Sign in ──→ GitHub OAuth
        │                                             ← GitHub 回调 /api/auth/callback
        │                      4. callback 检测有 cli_challenge cookie
        │                         签 cli_token(HMAC user_id + 随机)
        │                         写 D1 cli_tokens(challenge→token→user_id)
        │                         删除 cli_auth_pending
        │                         显示"✅ 回到终端"
        │
   轮询 POST /api/cli/auth/poll {challenge}
        │                      5. 查 cli_tokens 有无此 challenge
        │   ← {token, login, avatarUrl} 或 {pending: true}
        │
   存 cli_token 到 task-share.json {token, login}
   后续上传带 Authorization: Bearer <cli_token>
```

### 安全性

- challenge 是 32 字节随机(TUI 生成,只存本地),市场只存它的 hash 或原文(短期,授权后删)
- cli_token 是长期凭证(HMAC 签名 user_id),存本地,可吊销
- OAuth state 复用现有机制(marketplace.js:198),不引入新 CSRF 风险
- cli_token 通过 `Authorization: Bearer` 传,不走 cookie

---

## 4. 改动清单(三端)

### 4.1 后端(Cloudflare Pages Functions)

| # | 文件 | 改动 | 行数估 |
|---|---|---|---|
| B1 | `migrations/0007_cli_auth.sql` | 新建 `cli_auth_pending`(challenge,created_at)+ `cli_tokens`(token PRIMARY KEY,user_id,challenge,created_at)两张表 | ~12 |
| B2 | `functions/_lib/marketplace.js` | 新增 `startCliAuth`(POST,记录 challenge)+ `pollCliAuth`(POST,查 token)+ `createCliToken`(callback 里调,签 token 写 D2) | ~50 |
| B3 | `functions/_lib/marketplace.js` `githubCallback` | 检测 `cli_challenge` cookie:有则走 CLI 授权分支(签 cli_token),无则正常登录(签 session cookie) | ~15 |
| B4 | `functions/_lib/marketplace.js` `requireUser` | 支持 `Authorization: Bearer <cli_token>` 鉴权(查 cli_tokens 表),不只是 cookie session | ~10 |
| B5 | `functions/api/cli/auth/start.js` | thin endpoint POST → `startCliAuth` | ~5 |
| B6 | `functions/api/cli/auth/poll.js` | thin endpoint POST → `pollCliAuth` | ~5 |

### 4.2 网页(docs/task-share)

| # | 文件 | 改动 | 行数估 |
|---|---|---|---|
| W1 | `docs/task-share/cli-auth/index.html` | 新页面:接 `?c=<challenge>` → 存 cookie → 跳 `/api/auth/github` → 回调后显示"回到终端" | ~40 |

> 复用 styles.css(W1 用 `<link href="../styles.css">`)。页面逻辑极简:读 `?c` → document.cookie → location.href='/api/auth/github'。回调后 URL 会有 `?cli=done`,页面显示成功提示。

### 4.3 TUI(extensions/task/)

| # | 文件 | 改动 | 行数估 |
|---|---|---|---|
| T1 | `extensions/task/task-share-auth.ts` | **新建**:challenge 生成 + task-share.json 读写(复用 settings-io 模式)+ start/poll fetch + openBrowser(复用 launcher.ts 平台判断) | ~100 |
| T2 | `extensions/task/task-share-publish.ts` | **新建**:读 taskbook 5 文件 → 构造 FormData(zip 或 multipart)→ 带 Bearer token POST /api/tasks/submit | ~60 |
| T3 | `extensions/task/task.ts` | `MENU_TO_ACTION` 加 `["上传到市场","publish"]`;`getTaskCommandMenuOptions` landed 分支加"上传到市场";`handleTaskCommand` 加 `if(action==="publish")` 分支调 T1+T2 | ~20 |
| T4 | `extensions/task/task.ts` | 兜底 Usage 文案(task.ts:2173)加 `publish` | ~1 |

---

## 5. 详细 API 契约

### POST /api/cli/auth/start

**请求**:
```json
{ "challenge": "<32 字节 hex>" }
```

**响应 200**:
```json
{ "url": "https://ugk-task-share.pages.dev/cli-auth?c=<challenge>" }
```

**逻辑**:写 `cli_auth_pending(challenge, created_at)`,返回授权 URL。challenge 5 分钟过期(轮询和 pending 表都按此清理)。

### POST /api/cli/auth/poll

**请求**:
```json
{ "challenge": "<32 字节 hex>" }
```

**响应(授权完成)**:
```json
{ "status": "ok", "token": "<cli_token>", "login": "mhgd3250905", "avatarUrl": "..." }
```

**响应(未完成)**:
```json
{ "status": "pending" }
```

**逻辑**:先查 `cli_tokens` 有无此 challenge → 有则返回 token + join users 拿 login;无则查 `cli_auth_pending` 确认 challenge 还有效(没过期)→ 返回 pending;都不在 → 返回 error(challenge 无效或过期)。

### POST /api/tasks/submit(改动:支持 Bearer)

**新增鉴权**:`requireUser` 先查 `Authorization: Bearer <token>` → 查 `cli_tokens` 拿 user_id → join users;无 Bearer 则 fallback 到现有 cookie session。

**其余不变**:仍是 multipart FormData(name/version/title/description/artifact=zip)。

---

## 6. TUI 侧实现细节

### 6.1 task-share.json 格式

```json
{
  "token": "<cli_token>",
  "login": "mhgd3250905",
  "marketplaceUrl": "https://ugk-task-share.pages.dev",
  "challenge": null
}
```

存 `<agentDir>/task-share.json`(agentDir = `~/.pi/agent/`)。challenge 字段:授权中暂存,拿到 token 后置 null。

**读写复用**:`readJsonBomSafe`(settings-io.ts:119)读;写用新函数照抄 `updateSettingsJson` 模式(settings-io.ts:74-108)。

### 6.2 challenge 生成

```ts
import { randomBytes } from "node:crypto";
const challenge = randomBytes(32).toString("hex");  // 64 字符
```

### 6.3 打开浏览器(复用 launcher.ts 平台判断)

```ts
import { spawn } from "node:child_process";
function openBrowser(url: string) {
  const cmd = process.platform === "win32" ? "cmd" : process.platform === "darwin" ? "open" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", url] : [url];
  try { spawn(cmd, args, { detached: true, stdio: "ignore" }).unref(); }
  catch { /* 失败则 TUI 显示 URL 让用户手动开 */ }
}
```

### 6.4 轮询(复用 launcher.ts:203-225 模式)

```ts
async function pollForToken(challenge, marketplaceUrl, timeoutMs = 120000, intervalMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await fetch(`${marketplaceUrl}/api/cli/auth/poll`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ challenge }),
    });
    const data = await res.json();
    if (data.status === "ok") return data;
    if (data.status === "error") throw new Error(data.error);
    await new Promise(r => setTimeout(r, intervalMs));
  }
  throw new Error("授权超时");
}
```

### 6.5 打包上传

LoadedTaskbook 已含全量内容(task-book.ts:40-48)。组装 FormData:

```ts
import { zipSync } from "fflate";  // 已是依赖(package.json)
const files = {
  "taskbook.json": JSON.stringify(loaded.taskbook, null, "\t") + "\n",
  "spec.json": JSON.stringify(loaded.spec, null, "\t") + "\n",
  "contract.json": JSON.stringify(loaded.contract, null, "\t") + "\n",
  "skill.md": loaded.skill,
  "verify.mjs": loaded.verify,
};
const zip = zipSync(Object.fromEntries(Object.entries(files).map(([k,v]) => [k, new TextEncoder().encode(v)])));
const form = new FormData();
form.set("name", name);
form.set("version", version);
form.set("title", title || loaded.taskbook.description);
form.set("description", loaded.taskbook.description);
form.set("artifact", new File([zip], `${name}-${version}.zip`, { type: "application/zip" }));
const res = await fetch(`${marketplaceUrl}/api/tasks/submit`, {
  method: "POST", headers: { Authorization: `Bearer ${token}` }, body: form,
});
```

> **注意**:taskbook.json 里可能含 `runs` 历史(你的 video-downloader 就有 10 条 run 记录)。上传前**清空 runs**(只传 `[]`),避免把本地运行历史传到市场。

### 6.6 publish action 集成(task.ts)

```
新增菜单项 → MENU_TO_ACTION["上传到市场"] = "publish"
新增菜单显示 → getTaskCommandMenuOptions 的 else 分支(landed)加 "上传到市场"
新增 action 分支 → handleTaskCommand 加:
  if (action === "publish") {
    await handleTaskPublish(ctx, name, tokens);
    return;
  }
新增 handleTaskPublish 函数:
  1. 如 name 缺失 → ctx.ui.select 从 listTaskbooks 选
  2. loadTaskbook(cwd, name) → 拿全量内容
  3. 检查 task-share.json 有无 token → 无则走 auth 流程(T1)
  4. ctx.ui.input 问 version(默认 "1.0.0")
  5. 调 T2 打包上传
  6. ctx.ui.notify 结果
```

---

## 7. 行动计划(实现顺序,每步留可跑 check)

### Phase 1:后端(可独立验证,不依赖 TUI)

| 步骤 | 做什么 | check |
|---|---|---|
| 1.1 | migration 0007 建两张表 | `wrangler d1 migrations apply --remote` 成功 |
| 1.2 | marketplace.js 加 `startCliAuth` + `pollCliAuth` + `createCliToken` | curl POST /api/cli/auth/start 返回 url |
| 1.3 | marketplace.js `githubCallback` 加 cli_challenge 分支 | 手动测:cookie 带 cli_challenge → 回调签 cli_token |
| 1.4 | marketplace.js `requireUser` 支持 Bearer | curl 带 Bearer 调 /api/tasks/submit 不报 401 |
| 1.5 | 建 functions/api/cli/auth/start.js + poll.js | 端到端 curl 走通 start→poll |
| 1.6 | 部署 | wrangler pages deploy |

### Phase 2:网页(1 个新页面)

| 步骤 | 做什么 | check |
|---|---|---|
| 2.1 | docs/task-share/cli-auth/index.html | 浏览器打开 ?c=test 显示授权入口 |
| 2.2 | 部署 | 浏览器走完 OAuth 显示"回到终端" |

### Phase 3:TUI(核心)

| 步骤 | 做什么 | check |
|---|---|---|
| 3.1 | task-share-auth.ts:challenge + task-share.json 读写 + start/poll + openBrowser | 单元测:生成 challenge + 读写 json |
| 3.2 | task-share-publish.ts:打包 zip + fetch 上传 | 单元测:LoadedTaskbook → FormData(用 mock fetch) |
| 3.3 | task.ts 加菜单项 + action 分支 + handleTaskPublish | `/task publish` 菜单出现 |
| 3.4 | 端到端:`/task publish` 走通(需后端已部署) | 上传成功,市场 admin 队列出现 |

### Phase 4:收尾

| 步骤 | 做什么 | check |
|---|---|---|
| 4.1 | npm test 全绿 | 519+ 新测试全 pass |
| 4.2 | 真机验证:首次授权 + 上传 + 后续上传 | 三条路径都走通 |
| 4.3 | 交接文档 | 记录踩坑 + 已知债 |

---

## 8. 测试策略

### 后端(扩展现有 task-marketplace-functions.test.ts)

- `startCliAuth` 写 pending 表 + 返回 url
- `pollCliAuth` pending/ok/error 三态
- `createCliToken` 签 token + 写 cli_tokens
- `requireUser` Bearer 鉴权:有效 token → user;无效 → 401;无 Bearer → fallback cookie

### TUI(新建 task-share-auth.test.ts + task-share-publish.test.ts)

- challenge 生成(32 字节 hex 格式)
- task-share.json 读写(复用 settings-io DI 模式)
- pollForToken:mock fetch 返回 ok/pending/error
- 打包:LoadedTaskbook → zip(验 5 文件都在 + runs 清空)
- openBrowser:不实际开(spawn mock)

### 改坏验证

每个核心逻辑(鉴权/打包/轮询)实现后,临时改回 buggy 确认测试转红。

---

## 9. 不做什么(YAGNI)

- **不做** device flow(市场 OAuth 中转已够,device flow 要新建 GitHub OAuth App)
- **不做** scripts/ 子目录上传(5 核心文件先够,scripts 是独立需求)
- **不做** 上传进度条(zip 小,秒传)
- **不做** token 自动刷新(cli_token 长期有效,失效重新授权)
- **不做** 多市场支持(marketplaceUrl 写死在 task-share.json,够用)
- **不做** 上传前预览(直接传,市场网页可看)
- **不动** 现有 cookie session 逻辑(只加 Bearer 分支,不影响网页用户)

---

## 10. 已知风险

1. **OAuth App redirect_uri**:市场 OAuth App 的 redirect_uri 当前是 `/api/auth/callback`。CLI 中转流程回调也走这里(githubCallback 检测 cli_challenge cookie 分流),**不需要改 GitHub OAuth App 配置**。但要确认 cookie 在跨页(/cli-auth → /api/auth/github → GitHub → /api/auth/callback)间存活——SameSite=Lax 应该够(同站导航)。
2. **taskbook.json 的 runs 历史**:本地跑过的 task 有 runs 数组(可能很大),上传前必须清空。check:打包后验 zip 里 taskbook.json 的 runs=[]。
3. **fflate 在 TUI 侧**:TUI 是 Node 环境,fflate 的 CJS 入口在 Node 24 有递归 bug(本会话踩过),但 ESM 入口正常。task.ts 是 ESM,`import { zipSync } from "fflate"` 应该没问题,但要测。
4. **轮询超时**:用户可能开了 URL 不去登录。120 秒超时后 TUI 友好提示"授权超时,重试 /task publish"。pending 表也要清理(5 分钟过期)。

---

## 11. 关键代码位置索引(给新会话快速上手)

### TUI 侧
- 命令注册:`extensions/task/task.ts:2176`
- 菜单映射:`extensions/task/task.ts:168-194`(MENU_TO_ACTION)
- 菜单选项:`extensions/task/task.ts:211-221`(getTaskCommandMenuOptions)
- action dispatch:`extensions/task/task.ts:2011-2174`(handleTaskCommand)
- 参数解析:`extensions/task/task.ts:687-694`(parseTaskCommand)
- UI 方法:`ctx.ui.select/input/notify/confirm/editor`
- taskbook 加载:`extensions/task/task-book.ts:150-172`(loadFromDir),`207-213`(loadTaskbook)
- LoadedTaskbook 结构:`extensions/task/task-book.ts:40-48`
- listTaskbooks:`extensions/task/task-book.ts:215-245`
- 配置读写:`extensions/shared/settings-io.ts:48-125`(readSettingsJson/updateSettingsJson/readJsonBomSafe)
- fetch 模板:`extensions/cron.ts:30-56`(callCron)
- 轮询模板:`extensions/chrome-cdp/launcher.ts:203-225`(waitForChromeCdpReady)
- 浏览器打开:`extensions/chrome-cdp/launcher.ts:51-68`(平台判断模式)

### 后端侧
- OAuth login:`functions/_lib/marketplace.js:193-212`(githubLogin)
- OAuth callback:`functions/_lib/marketplace.js:214-260`(githubCallback)
- session 签名:`functions/_lib/marketplace.js:146-151`(createSessionCookie)
- session 校验:`functions/_lib/marketplace.js:153-167`(readSession/sessionUser)
- requireUser:`functions/_lib/marketplace.js:299-304`
- submitTask:`functions/_lib/marketplace.js:313-377`
- users 表:`migrations/0001_task_marketplace.sql:1-7`
- 现有 migration 序号:0001-0006,下一个是 **0007**

### 网页侧
- 共享样式:`docs/task-share/styles.css`(392 行)
- OAuth 路由:`functions/api/auth/github.js`、`functions/api/auth/callback.js`

---

> 本文档是新会话的实现依据。先读 §1-2(需求 + 决策)→ §4(改动清单)→ §7(行动计划)→ §11(代码索引),按 Phase 1-4 顺序实现。每个 Phase 完成后部署 + 验证再进下一个。
