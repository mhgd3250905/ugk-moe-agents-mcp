# 会话交接:TUI 内上传 task 到市场

> **日期**:2026-07-01
> **交接对象**:接手"TUI 内上传 task"功能开发的新会话
> **上一会话产出**:需求文档 + 行动计划(`docs/design/2026-07-01-task-publish-from-tui.md`)
> **当前 main HEAD**:`6285306`

---

## 1. UGK 是什么(30 秒上下文)

**ugk**(读"乌克")是基于 [pi](https://github.com/earendil-works/pi)(pi-coding-agent)定制的终端 AI 编码 agent。

- 包名 `ugk-agent`,npm 全局安装,`ugk` 命令启动
- 引擎依赖 `@earendil-works/pi-*@0.79.4`(peer,**不能单独更新 pi,要更新整个 UGK**)
- 入口 `bin/ugk.js`(极薄包装,用 `-e` 注入 `extensions/index.ts`)
- 运行平台 Windows / macOS / Linux(bash 工具走 Git Bash,Windows 路径正斜杠)

**一句话定位**:把 pi 当引擎,UGK 叠了"任务系统 + 浏览器控制 + MCP 接入 + 定时任务 + 多 agent 协作 + 品牌化 TUI + **task 分享市场**"。

> 完整运行时上下文见 `AGENTS.md`,开发侧约定见 `docs/DEVELOPMENT.md`。

---

## 2. task 分享市场现状(本会话的产出)

### 2.1 本会话做了什么(7 个 commit)

| commit | 内容 |
|---|---|
| `102717d` | **R2 直存**:市场从"静态构建链路"改为"R2 直存 + 动态 manifest"。上传 zip → fflate 解包 → 散文件存 R2 → CLI 零改动 |
| `8b98174` | **前端重写**:4 页现代 SaaS 风 + 动态数据 + upload 表单修正(加 version、删 sourceUrl) |
| `c380602` | **修复**:上传链路 INSERT 占位符 / zip wrapper strip / R2+DB try-catch / Community 区去重 |
| `bc75063` | 前端 UI 优化交接手册 |
| `a9843a1` | **合并 PR #28**:提取 styles.css(392 行)+ 荧光绿主题 + 无障碍 + toast/dialog |

### 2.2 当前架构

```
创作者                         Cloudflare                    用户
──────                         ──────────                    ────
upload 页拖 zip  ──────→  Pages Function(submitTask)
                              │ fflate 解包 + 校验 + wrapper strip
                              ↓
                           R2(tasks/<name>/<ver>/<file>)   ← 散文件
                              ↓
                           D1(task_submissions → pending)
                              ↓ admin review → publish
                           D1(tasks.latest_version + task_versions)
                              ↓
                           /api/manifest(动态)  ←  CLI 安装入口
                           /api/tasks/<name>/files?f=<file>  ←  R2 代理
```

### 2.3 生产环境状态(已就绪)

| 组件 | 状态 |
|---|---|
| 站点 | **https://ugk-task-share.pages.dev** |
| R2 bucket `ugk-task-uploads` | ✅ 已创建,有内容 |
| D1 schema | ✅ 含 0006(latest_version/version/file_list) |
| D1 数据 | 2 个 published task(video-downloader, linkedin-search),无 pending |
| Pages Functions | ✅ 已部署 |
| OAuth | ✅ GitHub Client ID/Secret + Session Secret 已配 |
| Admin 白名单 | `ADMIN_GITHUB_LOGINS=mhgd3250905` |
| Cloudflare 账户 | `294851575@qq.com`,account_id `36f7672020cfc6c515e198c5786d99da` |

### 2.4 部署方式

```bash
# 需要 Cloudflare API token(问项目负责人要,或用 wrangler login)
# token 不要写入任何文件,只在 shell 环境变量里用

# 跑 D1 migration(新增 migration 后)
npx wrangler d1 migrations apply ugk-task-share-db --remote

# 部署(HTML + Functions 一起)
npx wrangler pages deploy docs/task-share --project-name ugk-task-share --commit-dirty=true

# 临时改 D1 数据(调试用)
npx wrangler d1 execute ugk-task-share-db --remote --command "SELECT ..."

# 写 R2(注意:必须加 --remote,否则只写本地模拟器!)
npx wrangler r2 object put ugk-task-uploads/<key> --file <本地文件> --remote
```

---

## 3. 本会话踩过的坑(接手必读,文档不会写)

这些是真机验证时踩的,每一条都耗了时间:

1. **`wrangler r2 object put` 默认写本地模拟器** → 必须加 `--remote` 才写远端。报 "Upload complete" 但远端空,极误导。
2. **Wrangler Pages 不支持 `[...path]` wildcard 路由** → 参数名报错。改用 `?f=<filename>` query 参数。
3. **fflate `unzipSync` 是同步阻塞** → Workers 免费层 10ms CPU 限制,大包可能超时。当前 task 包 <100KB 无问题。
4. **D1 INSERT 占位符数错** → 列名 12 个但 VALUES 写了 13 个 `?`,Workers 报 `13 values for 12 columns`。**测试 mock DB 不校验占位符数,只有真机暴露**。
5. **manifest 与 stats 查询语义不一致** → manifest 查 `WHERE latest_version IS NOT NULL`,stats 查 `COUNT(*)`。已清旧 seed 统一。
6. **Community 区与 catalog 数据重叠** → 同一 task 在两个区都显示。已砍 Community 区。
7. **fflate CJS 入口在 Node 24 有递归 bug** → ESM 入口正常。task.ts 是 ESM,`import { zipSync } from "fflate"` 应该没问题,但要测(新功能相关)。
8. **错误信息不透明** → R2/DB 写入无 try-catch 时 Worker 崩成 HTML 500,前端只显示 `submit_failed`。已在 submitTask 加 try-catch 返回 JSON 详情。**reviewSubmission 还没加**(已知债)。

---

## 4. 下一步:TUI 内上传功能

### 需求文档
**`docs/design/2026-07-01-task-publish-from-tui.md`** — 完整需求 + 行动计划,**这是新会话的主要实现依据**。

### 一句话需求
用户在 TUI 里跑出 landed task → `/task publish` → 上传到市场,无需切浏览器。

### 认证方案(核心难点)
市场网站 OAuth 中转(PKCE 式):TUI 生成 challenge → 用户去市场网页登录(复用已有 GitHub OAuth)→ TUI 轮询拿 cli_token → 存本地复用。

### 三端改动
- **后端**:migration 0007 + `/api/cli/auth/start` + `/api/cli/auth/poll` + requireUser 支持 Bearer + callback 加 cli 分支(~80 行)
- **网页**:`/cli-auth` 中转页(~40 行)
- **TUI**:task-share-auth.ts + task-share-publish.ts + task.ts 菜单/action 集成(~180 行)

### 实现顺序(Phase 1-4)
1. **Phase 1 后端**(可独立 curl 验证)
2. **Phase 2 网页**(1 个新页面)
3. **Phase 3 TUI 核心**(auth + publish + 菜单)
4. **Phase 4 收尾**(测试 + 真机 + 交接)

每个 Phase 完成后部署 + 验证再进下一个。

---

## 5. 关键文件索引

### 新会话最先要读的
| 文件 | 作用 |
|---|---|
| `docs/design/2026-07-01-task-publish-from-tui.md` | **实现依据**(需求 + 行动计划 + API 契约 + 代码索引) |
| `AGENTS.md` | 运行时上下文 |
| 本文档 | 项目上下文 + 本会话产出 + 踩坑 |

### 市场相关(本会话改的)
| 文件 | 作用 |
|---|---|
| `functions/_lib/marketplace.js` | 市场核心逻辑(OAuth/session/submitTask/manifest) |
| `functions/api/**` | thin endpoints |
| `migrations/0001-0006` | D1 表结构 |
| `docs/task-share/*.html` + `styles.css` | 前端 4 页 + 共享样式 |
| `bin/task-install.js` | CLI 安装逻辑(zip 解包反向) |
| `wrangler.toml` | 部署配置 |

### TUI 相关(新功能要碰的)
| 文件 | 作用 |
|---|---|
| `extensions/task/task.ts` | /task 命令 + 菜单 + dispatch(2393 行) |
| `extensions/task/task-book.ts` | taskbook 存储加载 |
| `extensions/shared/settings-io.ts` | 配置读写模式(复用) |
| `extensions/cron.ts` | fetch 调用模板(复用) |
| `extensions/chrome-cdp/launcher.ts` | 轮询 + 浏览器打开模板(复用) |

---

## 6. 工作约定(本项目一直遵循的)

- **ponytail full**:最短可用 diff、根因修复、复用优先、`ponytail:` 注释标刻意简化
- **对抗式审查**:设计/排查派 sub agent 审,然后逐条自己读源码复核
- **改坏验证**:每个修复临时改回 buggy 确认测试转红
- **真机验证不可省**:Workers runtime 行为和 Node 不同(D1 占位符、R2 --remote、fflate CPU),单元测试 mock 抓不到
- **bash 工具走 Git Bash**,Linux 语法,Windows 路径正斜杠
- **危险操作前确认**(权限门拦 `rm -rf`/`sudo`/`chmod 777`)
- **测试基线**:`npm test` = 519/519 pass(本会话维持)

---

> 其他历史交接见 `docs/handoff/` 各文档。市场架构详见 `docs/handoff/2026-07-01-marketplace-r2-direct-and-frontend-rewrite.md`。
