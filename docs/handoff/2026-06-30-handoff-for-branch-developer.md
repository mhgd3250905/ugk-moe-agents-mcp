# UGK 项目交接手册 — 给分支开发的同事

> 日期：2026-06-30
> 交接对象：**要在 UGK 上做分支开发的同事**
> 基线 commit：`6f0a627`（main，测试 471/471/0）
> 读完这份你能：搭好环境、跑通测试、知道代码怎么改、知道怎么交回 PR。

---

## 第一件事：网络（重要，先看）

这台机器的 **git bash 环境不会自动走系统代理**，导致 `git push`/`git fetch` 直连 GitHub 超时，但浏览器能开 GitHub（因为走代理）。

系统代理是 `127.0.0.1:10808`。git push/fetch 卡住时，加这个前缀：

```bash
git -c http.proxy=http://127.0.0.1:10808 -c https.proxy=http://127.0.0.1:10808 <git命令>
```

想一劳永逸（只给 github.com 走代理，不影响别的仓库）：

```bash
git config --global http.https://github.com/.proxy http://127.0.0.1:10808
```

> 如果你的环境代理端口不是 10808，查一下：PowerShell 跑 `Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings' | Select ProxyServer`。

---

## 这个项目是什么

**UGK**（ugk-pi-agent）是基于 [pi](https://github.com/earendil-works/pi)（pi-coding-agent）深度定制的终端编码 agent。

- **面向用户**：开发者，主打键盘流、低刺激荧光绿主题、本地登录态 Chrome 控制、常驻定时工作流、固定任务委托（taskbook）
- **分发**：npm 两个包 —— `ugk-agent`（主包）+ `ugk-install`（一键安装器）
- **仓库**：https://github.com/mhgd3250905/ugk-tui.git，分支 `main`
- **当前发布**：`ugk-agent@2.1.2` + `ugk-install@0.1.0`

---

## 环境怎么搭

```bash
# 1. clone
git clone https://github.com/mhgd3250905/ugk-tui.git
cd ugk-tui

# 2. 装依赖
npm install

# 3. 跑测试，确认基线（应该 471/471/0，约 7-10 秒）
npm test

# 4. 本地跑 ugk（开发模式，加载本地代码）
node bin/ugk.js
```

**必备工具**：
- **Node.js 18+**（项目用 ESM + node --test，老版本不行）
- **Git Bash**（Windows 上 bash 工具走 Git Bash，不是 WSL；命令用 Linux 语法，Windows 路径用正斜杠）

---

## 分支开发流程（你每天怎么干）

### 1. 开分支

```bash
git checkout main
git pull origin main
git checkout -b feat/<你的功能名>   # feat/fix/docs/perf/refactor 前缀
```

### 2. 改代码、跑测试

```bash
npm test                              # 全量，471 个，~7-10s
node --test tests/task-extension.test.ts          # 单文件
node --test tests/a.test.ts tests/b.test.ts       # 多文件
npm run test:integration              # 集成测试（涉及真实 spawn）
```

### 3. 提交（commit message 约定）

用约定式提交前缀，中文描述可以：

```
feat(task): 加了 xxx 功能
fix(subagent): 修了 yyy bug
perf(cron): 优化 zzz
docs: 更新交接文档
refactor(doctor): 删除死代码
```

### 4. 推分支 + 开 PR

```bash
git push -u origin feat/<你的功能名>
# 然后去 GitHub 开 PR，base 选 main
```

PR 描述写清楚：改了啥、为啥、怎么验证（`npm test` 绿 + 贴测试数）。

### 5. 网络问题

push 超时见上面「第一件事」。**push 前确认 fetch 拉到最新 main**，避免基线过期（基线过期的 PR 合并时会带进一堆无关变更，审起来很痛苦）。

---

## 项目结构速查

```
ugk-core/
├── bin/                    # CLI 入口 + runtime patch + 更新机制
│   ├── ugk.js              # 极薄入口：调 pi main + -e 注入扩展
│   ├── update-core.js      # 更新检查/应用（git pull 或 npm install -g）
│   └── ugk-startup-settings.js
├── extensions/             # 核心能力（随包 -e 加载）
│   ├── index.ts            # 主入口：工具/命令注册 + @mention + 权限门
│   ├── subagent*.ts        # 子代理委派（single/parallel/chain）
│   ├── task/               # ★ 固定任务委托系统（taskbook 创造/复用）
│   ├── chrome-cdp/         # 受保护本地 Chrome 控制
│   ├── mcp/                # MCP stdio client 接入
│   ├── doctor/             # /doctor 引导式环境配置
│   ├── shared/             # settings-io / language / worker-lifecycle 等
│   └── ui-*.ts             # 品牌 UI（header/footer/title）
├── cron/                   # 独立常驻定时服务
├── agents/                 # 预设 subagent（scout/planner/reviewer/checker/worker）
├── skills/                 # 随包 skill
├── themes/                 # ugk-geek（默认）+ 16 社区主题
├── prompts/                # /implement /scout-and-plan 等
├── install/                # 独立 npm 包 ugk-install（不进主包！）
└── tests/                  # node:test 逻辑覆盖 + integration/
```

**重点：`extensions/task/` 是项目核心**，task 系统是这次合并的重点（requiredEnv + progress 流式推送刚加），如果你要改 task 相关，先读下面「必读文档」。

---

## 必读文档（改代码前按顺序读）

1. **`AGENTS.md`**（仓库根）— agent 运行时上下文，讲已实现能力 + 关键约定
2. **`docs/DEVELOPMENT.md`** — **开发侧约定，改代码前必读**（目录职责、agent 定义部署、bash 路径、同步 spec 规则）
3. **`docs/extension-contracts.md`** — 扩展契约（settings 读写/BOM 规则等硬约束）
4. **本目录 `2026-06-30-handoff-for-new-developer.md`** — 更详细的总交接（项目来龙去脉、历史坑）

---

## 改代码的关键约定（踩坑警告，必看）

### 1. 测试 mock 必须全套，漏一个全量套件挂几分钟
改涉及 mock 的测试时，**确认 worker/dispatcher/checker 都 mock 全**。真实教训：`subtask-tool.test.ts` 曾只 mock worker/dispatcher 漏了 checker，verify 失败后真实 spawn checker 子进程，全量套件从 8 秒退化到 7 分钟。

### 2. settings.json 读写必须 BOM-safe
Windows PowerShell 写文件带 UTF-8 BOM，裸 JSON.parse 会崩。**复用 `extensions/shared/settings-io.ts` 的 `readSettingsJson`/`updateSettingsJson`/`stripBom`**，别自己写。

### 3. auth.json 的 key 结构是 `{type:"api_key", key}`，不是 `apiKey`
pi 的 `AuthStorage.getApiKey` 读 `cred.type === "api_key"` + `cred.key`。写 auth.json 用这个结构。

### 4. `chrome-cdp/config.ts` 的 `checkChromeCdpPolicy` ≠ doctor 的 `checkChromeCdp`
同名前缀但完全不同：前者是 chrome-cdp 访问策略闸门（运行时在用，**别误删**），后者已是死代码。

### 5. subagent 路径拿不到 CDP 授权
`buildSubagentChildEnv`（subagent.ts）主动删 `UGK_TASK_ALLOW_CHROME_CDP`。worker 调 CDP 必须直接在 worker 进程内用 `chrome_cdp` 工具，别想通过 subagent 中转。

### 6. 打包必须排除 install/ 和 .tmp/
`.npmignore` 已排除 `install/`（独立包）和 `.tmp/`（测试临时文件）。改 .npmignore 后用 `npm publish --dry-run` 验证。曾因漏排导致打包 169MB。

### 7. ponytail 工作风格
本项目代码风格基于 **ponytail** 原则：最短可用 diff、根因修复（不是治标）、非平凡逻辑必须留一个可跑的 check、刻意简化用 `ponytail:` 注释标记。
**代码里的 `ponytail:` 注释是刻意简化，不是 ignorance，别轻易推翻。**

---

## 当前 main 状态（你的起点）

| 项 | 值 |
|---|---|
| main HEAD | `6f0a627` |
| 测试基线 | **471/471/0**（`npm test`，约 7-10 秒） |
| npm 发布 | `ugk-agent@2.1.2` + `ugk-install@0.1.0`（均已上线） |
| 工作树 | 干净 |

最近 4 个提交（task 系统刚加了一波功能）：

```
6f0a627 fix(task): setx 持久化失败不再静默,notify 警告用户
95f3281 fix(task): worker 多轮后流式 progress 不再丢失
eecd12e perf(task): parallel run_task 批次级集中 hydrate requiredEnv 去重
556d404 feat(task): contract.requiredEnv 前置校验 + subagent progress 流式推送 (#25)
```

---

## task 系统速览（如果需求涉及 task，先看这个）

task 是 UGK 的核心，`extensions/task/` 13 个文件。核心概念：

- **taskbook** = 一份已机器验收的可复用固定任务，存 5 个文件：`taskbook.json`（元数据+历史）、`spec.json`（需求）、`skill.md`（worker 指南）、`verify.mjs`（机器验收脚本）、`contract.json`（工件契约）
- **两条执行路径**：`/task run`（你手动跑，可弹窗交互）和 `run_task` 工具（agent 自动跑，含 parallel，**绝不弹窗**）
- **四阶段**：planning（对齐需求）→ executing（亲手做）→ reviewing（产 skill+verify）→ landed（落盘）
- **受保护工具授权**：worker 要调 chrome_cdp/MCP 时弹一次 confirm，本会话同 taskbook 不再问

权威设计文档：`docs/design/2026-06-26-task-atomic-unit-and-parallel-primitive.md`（task 原子单元 + 并行原语，改 task 前必读）。

`task.ts` 有 ~2200 行（巨型文件，承载命令分发+工具注册+事件钩子+渲染），所有 `ponytail:` 注释都解释了存在理由。

---

## 怎么验证你的改动

1. `npm test` — 全量，471 个，~7-10s（基线 471/471/0）
2. `npm run test:integration` — 集成测试（涉及真实 spawn）
3. 改了打包相关 → `npm publish --dry-run` 看打包内容
4. 改了 agent 定义 → 新开 ugk 进程验证（`node bin/ugk.js`）

---

## 开发完怎么交回 PR

1. 确认 `npm test` 全绿，贴上测试数（如 `472/472/0`）
2. push 分支（网络问题见顶部）
3. GitHub 开 PR，base 选 `main`
4. PR 描述写：改了啥 / 为啥 / 怎么验证
5. 等审核反馈，需要改就继续在同分支提交 push

**PR 合并方式**：通常 squash merge（压成 1 个干净 commit）。

---

## 发布流程（如果你的改动要发版，重要）

UGK 是 **两个 npm 包**，发布顺序：**先发主包 ugk-agent，再发安装器 ugk-install**。

```bash
# 1. 改 package.json 版本号（主包），或 npm version patch
# 2. 主包
npm publish --dry-run        # 先看打包内容
npm publish                  # 真发

# 3. 安装器（独立包）
cd install
npm publish --dry-run
npm publish
cd ..

# 4. 验证
npm view ugk-agent version
npm view ugk-install version
```

**npm 账号**：`mhgd3250905`，2FA 是 security key 模式，命令行无法 `--otp`，必须用 **Granular Access Token**（read and write + 绕过 2FA）发布。

**版本号占用不可逆**：发出去的版本号永久占用，72 小时内不能 unpublish，错了只能发新版本 + deprecate。

> ⚠️ 发版是不可逆的外部副作用，**操作前一定要跟项目负责人确认**。

---

## 有问题怎么办

- **项目历史**：全在 git log + `docs/handoff/`（历史专题）+ `docs/design/`（设计文档）
- **核心约定**：`AGENTS.md` + `docs/DEVELOPMENT.md`
- **代码里的 `ponytail:` 注释**：刻意简化的标记，解释了"为什么这样写"，遇事可查
- **交接前**：可问上一任维护者（mhgd3250905）

---

## 你接手后建议先做的几件事（熟悉项目）

1. **跑一遍 `npm test`**，确认基线 471/471/0
2. **新开 ugk 跑一下**：`node bin/ugk.js`，试 `/ugk`、`/plan`、`/task`
3. **读 `AGENTS.md` + `docs/DEVELOPMENT.md`**，理解运行时上下文和开发约定
4. **读 `extensions/index.ts`**，理解工具/命令注册和权限门怎么接线
5. **拿到需求后**：先在 `extensions/` 找相关代码，读懂再改；改完跑测试

---

> 改 ugk-core 代码的开发者：见 `docs/DEVELOPMENT.md`（开发侧约定，不在运行时注入）。
