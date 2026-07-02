# Task Marketplace:R2 直存方案

> **日期**:2026-07-01
> **状态**:设计待审
> **前置文档**:`docs/handoff/2026-07-01-v2.1.2-marketplace-and-hardening.md`(PR #27 现状)
> **规范**:ponytail full —— 最短可用 diff、复用优先、删除优于新增

---

## 1. 问题

PR #27 的 marketplace 有三条交付路径,但只有官方 task 能被 CLI 安装:

| 路径 | CLI 可装? | 问题 |
|---|---|---|
| 官方 task(manifest.json) | ✅ | 进主仓库 `docs/task-share/taskbooks/`,改一个 task 要改主仓库 + 重构建 + 重部署 |
| 社区上传 zip(R2) | ❌ | Web 能下载 zip,但 CLI 装不了;上传即冻结,无版本管理 |
| 社区贴 URL | ❌ | 同上,且外链易腐 |

根本矛盾:**内容与市场索引耦合在同一个 git 仓库里,且社区 task 没有 CLI 安装通道。**

曾考虑过"GitHub 一 task 一仓库"方案,评估后否决:task 包体量极小(11 个官方 task 共 **487KB**,单个 21-72KB),git 工作流是杀鸡用牛刀,且引入 GitHub API 限流 / 国内访问不稳等外部依赖。详见同目录评估记录。

## 2. 方案

**R2 直存**:task 文件包以 zip 形式直接存 R2,D1 只存索引和版本关系。CLI 从 R2 拉取安装。GitHub 不参与分发链路。

```
创作者                         Cloudflare(一个地方搞定)            用户
──────                         ──────────────────────              ────
拖文件 / 选 zip  ────────→     R2(存包,免费10GB)               CLI 安装
   task-package.zip                ↓                                ugk task install <name>
                                 D1(索引 + 版本 + 计数)            └─→ 从 R2 拉(稳定)
                                 Pages(展示)
```

### 为什么是这个方案(第一性)

1. **体量决定架构**:487KB / 11 个包,千个包 ≈ 45MB。R2 免费 10GB 够 2 万个 task。小文件存快照比建 git 仓库简单一个数量级。
2. **零外部依赖**:CLI 永远从 Cloudflare 拉,不担心 GitHub 限流或网络抖动。
3. **上传一步到位**:创作者拖文件即完事,不用先建 repo / 配 git。
4. **现有代码复用率高**:见下,80% 零件已存在。

## 3. 现有代码复用清单(ponytail rung 2:已在本仓库的)

| 现有能力 | 文件:行 | 方案 B 用途 | 改动 |
|---|---|---|---|
| zip 上传到 R2 | `marketplace.js:264-270` | 上传通道主体 | 加 version 字段 |
| `task_versions` 表 + `artifact_key` | `0004_task_submissions.sql:21` | 版本管理 | 加 `latest` 语义 |
| publish 时写 task_versions | `marketplace.js:360` | 发布写版本 | 复用 |
| `getTaskVersions` endpoint | `functions/api/tasks/[name]/versions.js` | 版本列表 API | 不动 |
| `downloadSubmissionArtifact` 从 R2 读 | `marketplace.js:394` | 分发 zip | 复用 |
| `assertSafeManifestPath` + 原子 rename + 结构校验 | `task-install.js:96-176` | CLI 安装 | 扩展支持 zip 源 |
| `manifest.json` 协议 | 构建脚本生成 | CLI 入口 | 扩展 files 字段 |

## 4. 数据模型(全删重来,2026-07-01 定)

D1 测试数据清空从零开始。删掉历史包袱 migration(0002 假 seed、0003 重置假计数)。保留 0001/0004/0005 表结构。

### 4.1 唯一新增:migration 0006

```sql
-- migrations/0006_task_latest_version.sql
ALTER TABLE tasks ADD COLUMN latest_version TEXT;
```

### 4.2 `task_versions.artifact_key` 语义转变

字段复用,值从"单个 zip 的 R2 key"变成"散文件目录前缀":
- 旧:`submissions/<uid>/<ts>-name.zip`
- 新:`tasks/<name>/<version>`(R2 前缀,逐文件 `tasks/<name>/<version>/<filename>`)

> ponytail: 不改表结构,语义自然扩展。值约束在代码层(R2 key 规范)。

### 4.3 R2 key 规范(散文件,非 zip)

```
tasks/<name>/<version>/<filename>     ← 每个版本每个文件一个 R2 对象
  例:tasks/foo/1.0.0/taskbook.json
     tasks/foo/1.0.0/scripts/run.mjs
```

不变量:写入后不可变。新版本 = 新前缀,旧版本永不覆盖。

### 4.3 R2 key 规范

```
tasks/<name>/<version>.zip     ← 每个版本一个完整快照
```

不变量:`tasks/<name>/<version>.zip` 写入后不可变。新版本 = 新 key,旧 key 永不覆盖。

## 5. task 包格式规范(定死,上传时校验)

```
task-package.zip
├── taskbook.json    ← 必需
├── spec.json        ← 必需
├── skill.md         ← 必需
├── verify.mjs       ← 必需
├── contract.json    ← 必需
└── scripts/         ← 可选
    └── *.mjs
```

5 个必需文件 = `task-install.js:8` 的 `REQUIRED_FILES`。上传时 Worker 用现有 `validateTaskbook` 等校验函数验结构,不合规直接拒。

> 这套校验逻辑(`isTaskbook`/`isRequirementsSpec`/`assertValidContract`)现在在 `task-install.js`(CLI 侧)。设计决策:上传校验放服务端,需要把这些校验函数提到共享位置(见 §8 改动清单)。

## 6. 三条流程

### 6.1 上传(创作者)

```
POST /api/tasks/submit   (multipart: name, version, title, description, artifact=zip)
  ↓
Worker:
  1. 校验 name / version / zip 结构(REQUIRED_FILES + isTaskbook 等)
  2. zip 存 R2: tasks/<name>/<version>.zip
  3. 写 task_submissions(status=pending)
  ↓
Admin review → published:
  4. 写 task_versions(task_name, version, artifact_key, ...)
  5. tasks 表 upsert + latest_version = <version>
```

### 6.2 安装(用户,CLI)

```
ugk task install <name>[@version]
  ↓
1. fetch manifest.json(R2/Pages)
2. 从 manifest 拿 files URL(指向 R2)或直接拉 zip
3. 校验 + 原子 rename 落盘 ~/.pi/agent/tasks/<name>/
```

**关键决策**:manifest.json 由 Worker 从 D1 动态生成(而非构建脚本静态生成),反映 latest 版本。CLI 不变,仍只认 manifest.json。

### 6.3 版本管理

- 创作者上传新 zip + 新 version → 新 submission → review → publish → 新 task_version + 更新 latest_version
- 回滚 = 改 `tasks.latest_version` 指针,不动 R2
- `ugk task install foo@1.0.0` = manifest 查特定 version 的 artifact_key

## 7. 上传解包:fflate(服务端唯一新增依赖)

对抗式审查结论(核实 Workers runtime 能力):
- DecompressionStream 原生支持但**解不了 zip**(zip 有 central directory 结构,不是纯 deflate 流)
- yauzl 排除(Node-only,依赖 `fs`)
- JSZip 排除(30KB+,主线程阻塞)
- **fflate**:纯 JS、零依赖、12.5KB min+gzip、async 非阻塞、Workers 验证可用 ✓

为什么上传收 zip 而非多文件直传:创作者手里是一个 task 目录(含 scripts/ 子目录),浏览器端逐文件上传丢目录结构且选文件麻烦。zip 上传最可靠,服务端 fflate 解包存散文件。

### CLI 零改动

R2 存散文件,manifest files URL 直接指 R2 对象。CLI 仍逐文件 fetch + 校验 + 落盘,一行不改。

> ponytail: 最小 diff = CLI 零改动。复杂度推到服务端一次性解包,客户端保持简单稳定。

## 8. 改动清单(全删重来,统一 R2)

| # | 文件 | 改动 |
|---|---|---|
| 1 | `migrations/0006_task_latest_version.sql` | `ALTER TABLE tasks ADD COLUMN latest_version` |
| 2 | `functions/_lib/marketplace.js` `submitTask` | 收 zip → fflate 解包 → 校验 → 散文件存 R2 `tasks/<name>/<version>/` |
| 3 | `functions/_lib/marketplace.js` `reviewSubmission` | publish 写 task_version + latest_version |
| 4 | `functions/_lib/marketplace.js` 新增 `buildManifest` | 从 D1 读 published task + latest → 拼 manifest(只此一个来源) |
| 5 | `functions/api/manifest.js` | thin endpoint |
| 6 | `bin/task-install.js` | `OFFICIAL_MANIFEST_URL` 指动态 endpoint(逻辑零改) |
| 7 | 删除 `scripts/build-task-share.mjs` | 不再生成静态站 |
| 8 | 删除 `docs/task-share/taskbooks/` | 不再有静态 taskbooks |
| 9 | 清 D1 假计数 | 删 migration 0002/0003,生产 D1 重置 |

### 校验函数

`task-install.js` 的 `isTaskbook` / `isRequirementsSpec` / `assertValidContract` 服务端上传校验需要同样规则。

**ponytail 决策**:不抽公共模块(CLI 是 Node、Functions 是 Workers runtime,打包边界不同)。服务端一份独立但等价的纯函数(~40 行),两份互指注释。

> ponytail: 跨 runtime 的"复用"如果引入打包复杂度,不如两份等价纯函数。`<task-install.js isTaskbook> <=> <marketplace.js validateTaskPackage>`

## 9. 官方 task

全删。官方 task 以后也走 R2 上传渠道(作者标 `UGK Official`),不再有静态/社区双轨。`docs/task-share/` 退化成纯静态展示站(HTML + JS),taskbooks 内容删掉。

官方包内容如果还要保留,后续手动用上传通道重新发布到 R2 即可。

## 10. 不做什么(ponytail YAGNI)

- **不做** GitHub 导入(用户没提需求,小文件拖拽够用)
- **不做** diff / 历史对比(version 存快照,看最新版就行)
- **不做** 独立的 latest 指针表(一个 ALTER COLUMN 够)
- **不做** zip 流式安装(散文件逐个拉,简单可靠)
- **不做** 跨 runtime 的校验函数共享(两份等价纯函数比打包配置简单)
- **不做** 下载计数防刷(本轮范围外,见 handoff §8 已知债 #2)

## 11. 已定决策(2026-07-01 拍板)

1. **版本号语义**:**semver**(`1.0.0` → `1.1.0`)。创作者自定版本号,和 `task_versions.UNIQUE(task_name, version)` 天然契合。服务端做 semver 格式校验(`/^\d+\.\d+\.\d+$/`),不做语义升级推断。
2. **官方 task 迁移**:**先 MVP 社区链路**,官方 task 暂保留 `docs/task-share/` 静态分发。社区 R2 链路跑通后,官方迁移作为 P2 cleanup(统一走 R2,删 `docs/task-share/taskbooks/`)。
3. **上传权限**:**保留 GitHub 登录 + review**。复用现有 OAuth + `requireUser` + admin review 逻辑。权限放开(匿名上传等)是后续需求。

### MVP 范围(本轮实现)

只做社区 R2 链路,不动官方 task:
- migration 0006(`latest_version` 列)
- 上传:zip → 解包 → 散文件存 R2 → submission
- review publish:写 task_version + latest_version
- manifest endpoint:合并官方静态 + 社区 R2 两个来源
- CLI:`OFFICIAL_MANIFEST_URL` 指向动态 endpoint(向后兼容,官方 task 的 files URL 不变)

官方 task 迁移、下载计数防刷、semver 升级推断 → 不在本轮。

## 12. 验证 check(每个非平凡改动留一个)

- `0006` migration 后:`tasks` 表有 `latest_version` 列
- 上传流程:不合规 zip 被拒(缺 REQUIRED_FILES / taskbook.name 不匹配)
- manifest endpoint:返回的 files URL 指向 R2,能逐文件拉到内容
- CLI 安装:`ugk task install <社区task>` 成功,结构校验通过
- 版本:上传 v2 后,`latest_version` 更新,CLI 默认装 v2

---

> 下一步:你审完这份设计,拍板 §11 三个决策,然后我按 §8 改动清单实现。
