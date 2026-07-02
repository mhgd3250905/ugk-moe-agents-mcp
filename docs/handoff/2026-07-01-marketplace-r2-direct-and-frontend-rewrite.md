# UGK Task Marketplace — R2 直存 + 前端重写交接

> **日期**:2026-07-01
> **前置**:`docs/design/2026-07-01-task-marketplace-r2-direct-storage.md`(设计文档)、`docs/handoff/2026-07-01-v2.1.2-marketplace-and-hardening.md`(PR #27 现状)
> **生产站点**:https://ugk-task-share.pages.dev
> **测试基线**:`npm test` = 519/519 pass / 0 fail

---

## 1. 本轮做了什么

把 task 分享市场从"静态构建链路(`build-task-share.mjs` + git 提交 taskbooks)"改为"**R2 直存 + 动态 manifest + 现代 SaaS 前端**"。两个 commit 已落 main:

| commit | 内容 |
|---|---|
| `102717d` | R2 直存后端:zip 解包 → 散文件存 R2 → 动态 manifest → CLI 零改动 |
| `8b98174` | 前端重写:4 页现代 SaaS 风 + 动态数据 + upload 表单修正 |

另有一批修复(uncommitted,本次一起提交):wrapper strip、INSERT 占位符修复、Community 区去重。

---

## 2. 架构(改后)

```
创作者                         Cloudflare                    用户
──────                         ──────────                    ────
upload 页拖 zip  ──────→  Pages Function(submitTask)
                              │ fflate 解包 + 校验
                              │ wrapper strip
                              ↓
                           R2(tasks/<name>/<ver>/<file>)   ← 散文件,非 zip
                              ↓
                           D1(task_submissions → pending)
                              ↓ admin review → publish
                           D1(tasks.latest_version + task_versions)
                              ↓
                           /api/manifest(动态生成)  ←  CLI 安装入口
                           /api/tasks/<name>/files?f=<file>  ←  R2 散文件代理
                              ↓
                           前端 JS 动态渲染卡片
```

### CLI 安装链路(零改动)
```
ugk task install <name>
  → fetch /api/manifest
  → 逐文件 fetch /api/tasks/<name>/files?f=<filename>
  → 结构校验(isTaskbook 等)
  → 原子 rename 落盘 ~/.pi/agent/tasks/<name>/
```

---

## 3. 关键设计决策

1. **R2 存散文件,不存 zip** → CLI 完全不用碰 zip 解压(最短 diff)。上传收 zip,服务端 fflate 解包后存散文件。
2. **version 一等字段** → `task_submissions.version` 独立列,不从路径解析。
3. **file_list 存 D1** → manifest 读 D1 不触发 R2 list(Class A 计费),CLI 的 files URL 从 file_list 生成。
4. **校验函数两份等价** → CLI(Node)和 Functions(Workers runtime)各一份,跨 runtime 强行共享引入打包复杂度。互指注释。
5. **?f= query 参数** → 规避 Wrangler Pages 不支持 `[...path]` wildcard 路由。
6. **砍掉 Community 区** → 所有 task 走同一 R2 流程,无"官方/社区"双轨,catalog 是唯一列表源(`/api/manifest`)。

---

## 4. 数据模型

### migration 0006(已应用到生产 D1)
```sql
ALTER TABLE tasks ADD COLUMN latest_version TEXT;
ALTER TABLE task_submissions ADD COLUMN version TEXT;
ALTER TABLE task_submissions ADD COLUMN file_list TEXT NOT NULL DEFAULT '[]';
```

### R2 key 规范
```
tasks/<name>/<version>/<filename>     ← 散文件,写入后不可变
  例:tasks/video-downloader/1.0.0/taskbook.json
     tasks/video-downloader/1.0.0/scripts/download-video.mjs
```

### task 包格式(上传时校验)
```
zip 内必需 5 文件(根级,服务端自动 strip 单层 wrapper 文件夹):
  taskbook.json  spec.json  skill.md  verify.mjs  contract.json
+ scripts/ 可选
```

---

## 5. 部署踩坑记录(重要,接手必读)

这些是部署/真机验证时踩的坑,文档不会写,只有实操才知道:

1. **`wrangler r2 object put` 默认写本地模拟器** → 必须加 `--remote` 才写远端 bucket。报 "Upload complete" 但远端空。
2. **Wrangler Pages 不支持 `[...path]` wildcard 路由** → 参数名报错 "must only contain alphanumeric"。改用 `?f=<filename>` query 参数。
3. **fflate `unzipSync` 是同步阻塞** → Workers 免费层 10ms CPU 限制下,大包可能超时。目前 task 包 <100KB 无问题,大包需改异步解压。
4. **D1 INSERT 占位符数错** → 列名 12 个但 VALUES 写了 13 个 `?`,Workers runtime 报 `D1_ERROR: 13 values for 12 columns`。**测试 mock DB 不校验占位符数,这种错只有真机才暴露**。
5. **manifest 与 stats 查询语义不一致** → manifest 查 `WHERE latest_version IS NOT NULL`(旧 seed task 无此字段不显示),stats 查 `COUNT(*)`(含旧 task)。生产 D1 已清旧 seed。
6. **Community 区与 catalog 数据重叠** → `communityTasks` 查 `task_submissions WHERE status='published'`,publish 时同时写 tasks 表,导致同一 task 在两个区都显示。已砍 Community 区。

---

## 6. 生产环境当前状态(2026-07-01)

| 组件 | 状态 |
|---|---|
| R2 bucket `ugk-task-uploads` | ✅ 已创建,有内容 |
| D1 schema | ✅ 含 0006 三个新字段 |
| D1 数据 | 2 个 published task(video-downloader, linkedin-search),无 pending |
| Pages Functions | ✅ 已部署 |
| OAuth | ✅ 已配置(GitHub Client ID/Secret + Session Secret) |
| Admin 白名单 | `ADMIN_GITHUB_LOGINS=mhgd3250905` |
| Cloudflare 绑卡 | ✅ R2 已开通($0/月,免费额度内) |

### 已发布的真实 task
- `video-downloader` v1.0.0(@mhgd3250905)
- `linkedin-search` v1.0.0(@mhgd3250905)

---

## 7. 上传 → 发布流程(创作者视角)

1. 浏览器打开 https://ugk-task-share.pages.dev → 右上角 Sign in(GitHub OAuth)
2. /upload 页:填 name + version(semver) + title + description + 拖 zip
3. 提交成功 → submission 进队列(status=pending)
4. /admin 页(admin 白名单用户可见)→ 点 Publish
5. 主页刷新 → task 卡片出现(catalog 动态渲染)

> ⚠️ admin Publish 按钮的前端逻辑已实现(点 → 调 `/api/admin/submissions/<id>` → refreshAdmin),但**本轮未做真机点按验证**(publish 都是用 D1 直接写完成)。接手后建议先验证 admin 页 Publish 按钮端到端。

---

## 8. 已知债 / 待办

1. **admin Publish 按钮未真机验证** —— 前端逻辑在,但本轮 publish 都走 D1 直接写。需验证点击 → API → 刷新链路。
2. **下载计数刷量未做** —— `recordDownload` 无去重无限流(handoff §8 已知债 #2 延续)。
3. **fflate 同步解压的 CPU 风险** —— 大包(>1MB)可能超 Workers 10ms CPU 限制。当前 task 包都 <100KB,暂无问题。
4. **HTML 是手写非生成** —— 之前有 `build-task-share.mjs` 生成 HTML,现已删。4 个 HTML 是手维护的,改一处样式要同步改 4 个文件(已用统一 CSS 变量降低成本)。
5. **reviewSubmission 无 try-catch** —— publish 时的 D1 写入(two INSERT)无错误捕获,如果失败 Worker 会崩成 HTML 500。submitTask 已加,reviewSubmission 没加。

---

## 9. 工作流约定(延续)

- **ponytail full**:最短可用 diff、根因修复、复用优先
- **对抗式审查**:设计/排查派 sub agent 审,然后逐条自己读源码复核
- **改坏验证**:每个修复临时改回 buggy 确认测试转红
- **真机验证不可省**:Workers runtime 行为和 Node 不同(D1 占位符数、R2 --remote、fflate 同步 CPU),单元测试 mock 抓不到

---

> 其他总约定见 `AGENTS.md`(运行时)+ `docs/DEVELOPMENT.md`(开发)+ `docs/design/2026-07-01-task-marketplace-r2-direct-storage.md`(本设计)。
