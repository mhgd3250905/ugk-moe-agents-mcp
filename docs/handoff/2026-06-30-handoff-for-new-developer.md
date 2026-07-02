# UGK 项目交接文档 — 给新接手的开发者

> 日期：2026-06-30
> 交接对象：**新接手 UGK 开发的同事**（首次接触本项目）
> 这是你上手的第一份文档。读完它你应该能：理解项目、跑通开发环境、知道当前状态、知道怎么继续动手。

---

## 第一步：新开 ugk 进程（重要）

`ugk` 命令如果是指向开发仓库的符号链接（`npm link` 或全局装指向本地），**每次新开 ugk 进程才加载最新代码**。接手后第一件事：关掉所有旧的 ugk 进程，新开。

---

## 这个项目是什么

**UGK**（ugk-pi-agent）是基于 [pi](https://github.com/earendil-works/pi)（pi-coding-agent）深度定制的终端编码 agent。

- **面向用户**：开发者，主打键盘流、低刺激荧光绿主题、本地登录态 Chrome 控制、常驻定时工作流、固定任务委托（taskbook）
- **分发**：npm 两个包 —— `ugk-agent`（主包）+ `ugk-install`（一键安装器）
- **仓库**：`E:/AII/ugk-core`，git 远程 https://github.com/mhgd3250905/ugk-tui.git，分支 `main`

### 核心入口文档（按顺序读）
1. `AGENTS.md`（仓库根）— agent 运行时上下文，讲已实现能力 + 关键约定
2. `docs/DEVELOPMENT.md` — **开发侧约定，改代码前必读**
3. `docs/extension-contracts.md` — 扩展契约（settings 读写/BOM 规则等硬约束）
4. 本文档 — 当前状态 + 怎么动手

---

## 当前稳定基线（你的起点）

| 项 | 值 |
|---|---|
| 当前 main HEAD | `18b13cf` |
| 测试基线 | **464/464/0**（`npm test`，约 7 秒） |
| npm 发布 | `ugk-agent@2.1.2` + `ugk-install@0.1.0`（均已上线 registry） |
| 工作树 | 干净（无未提交改动） |

**这是已发布、可用的稳定版。** 用户现在能用 `npx ugk-install` 或 `npm i -g ugk-agent` 装上。

---

## 开发环境怎么搭

```bash
# 1. clone（或你已经有了）
git clone https://github.com/mhgd3250905/ugk-tui.git
cd ugk-tui

# 2. 装依赖
npm install

# 3. 跑测试，确认基线
npm test          # 应该 464/464/0，约 7 秒

# 4. 本地跑 ugk（开发模式，加载本地代码）
node bin/ugk.js   # 或 npm link 后用 ugk
```

### 必备工具
- Node.js 18+（项目用 ESM + node --test，老版本不行）
- Git Bash（Windows 上 bash 工具走 Git Bash，不是 WSL）

---

## 项目结构速查

```
ugk-core/
├── bin/                    # CLI 入口 + runtime patch + 更新机制
│   ├── ugk.js              # 极薄入口：调 pi main + -e 注入扩展
│   ├── update-core.js      # 更新检查/应用（git pull 或 npm install -g）
│   └── ugk-startup-settings.js  # 首启自动写默认 settings.json
├── extensions/             # 核心能力（随包 -e 加载）
│   ├── index.ts            # 主入口：工具/命令注册 + @mention + 权限门
│   ├── subagent*.ts        # 子代理委派（single/parallel/chain）
│   ├── task/               # 固定任务委托系统（taskbook 创造/复用）
│   ├── chrome-cdp/         # 受保护本地 Chrome 控制（per-worker tab 隔离）
│   ├── mcp/                # MCP stdio client 接入
│   ├── doctor/             # /doctor 引导式环境配置（已精简）
│   ├── shared/             # settings-io / language / worker-lifecycle 等
│   └── ui-*.ts             # 品牌 UI（header/footer/title）
├── cron/                   # 独立常驻定时服务（node-cron + HTTP）
│   ├── service.ts          # 常驻服务，到点 spawn ugk --print
│   └── agent-bin.ts        # cron 专用的 bin 解析（ugk→node+随包 bin/ugk.js）
├── agents/                 # 预设 subagent（scout/planner/reviewer/checker/worker）— 随包自动加载
├── skills/                 # 随包 skill（task-creator/ugk-environment-doctor 等）
├── themes/                 # ugk-geek（默认）+ 16 社区主题
├── prompts/                # /implement /scout-and-plan 等（随包加载）
├── install/                # 独立 npm 包 ugk-install（一键安装器，不进主包）
└── tests/                  # node:test 逻辑覆盖 + integration/
```

---

## 怎么改代码（关键约定）

### 必读
- **`docs/DEVELOPMENT.md`** —— 目录职责、agent 定义部署、bash 路径、同步 spec 规则
- **`docs/extension-contracts.md`** —— settings 读写必须 BOM-safe（Windows PowerShell 写文件带 BOM 会让裸 JSON.parse 崩，复用 `extensions/shared/settings-io.ts`）

### 改完怎么验证
1. `npm test` —— 全量测试，约 7 秒（基线 464/464/0）
2. `npm run test:integration` —— 集成测试（涉及真实 spawn 的）
3. 改了打包相关 → `npm publish --dry-run` 看打包内容对不对（`.npmignore` 排除 install/、docs/、tests/、.tmp/ 等）
4. 改了 agent 定义 → 新开 ugk 进程验证

### 发布流程（重要）
UGK 是 **两个 npm 包**，发布顺序：**先发主包 ugk-agent，再发安装器 ugk-install**。

```bash
# 1. 改 package.json 版本号（主包）
#    或 npm version patch
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

**npm 账号**：`mhgd3250905`，2FA 是 security key 模式，命令行无法 `--otp`，必须用 **Granular Access Token**（read and write + 绕过 2FA）发布。token 在 https://www.npmjs.com/settings/mhgd3250905/tokens 生成。

**版本号占用不可逆**：发出去的版本号（如 2.1.2）永久占用，72 小时内不能 unpublish，错了只能发新版本 + deprecate。

---

## 已知的坑 / 容易踩的（重要）

### 1. 测试 mock 必须全套，漏一个会让全量套件挂几分钟
**真实教训**：`tests/subtask-tool.test.ts` 的 `run_task parallel` 测试曾只 mock worker/dispatcher 漏了 checker，导致 verify 失败后真实 spawn checker 子进程，全量套件从 8 秒退化到 7 分钟。**改涉及 mock 的测试时，确认 worker/dispatcher/checker 都 mock 全。** 详见 commit `6c82599`。

### 2. auth.json 的 key 结构是 `{type:"api_key", key}`，不是 `apiKey`
pi 的 `AuthStorage.getApiKey`（auth-storage.js:387）读 `cred.type === "api_key"` + `cred.key`。ugk 自己的测试曾用错成 `apiKey`（status 显示已配置但实际调 API 拿不到值）。写 auth.json 用这个结构。详见 install/bin/install.js 的 writeAuthJson。

### 3. settings.json 读写必须 BOM-safe
Windows PowerShell 的 Set-Content 默认带 UTF-8 BOM，裸 JSON.parse 会崩。**复用 `extensions/shared/settings-io.ts` 的 `readSettingsJson`/`updateSettingsJson`/`stripBom`**，不要自己写。

### 4. 损坏文件保护语义
`updateSettingsJson` 对"文件存在但解析失败"的处理是**保护性 return 不覆盖**（避免覆盖损坏文件）。`getAgentDir()` 读 `PI_CODING_AGENT_DIR` 环境变量（测试时设它指向空临时目录隔离本机 `~/.pi/agent`）。

### 5. `chrome-cdp/config.ts` 的 `checkChromeCdpPolicy` ≠ doctor 的 `checkChromeCdp`
同名前缀但完全不同：前者是 chrome-cdp 访问策略闸门（运行时在用，**别误删**），后者已在 commit `18b13cf` 作为死代码删除。

### 6. subagent 路径拿不到 CDP 授权
`buildSubagentChildEnv`（subagent.ts）主动删 `UGK_TASK_ALLOW_CHROME_CDP`。所以 worker 内调 subagent 读 CDP 数据是死路。worker 调 CDP 必须直接在 worker 进程内用 `chrome_cdp` 工具。

### 7. 打包必须排除 install/ 和 .tmp/
`.npmignore` 必须排除 `install/`（独立包，不能嵌套进主包）和 `.tmp/`（测试/smoke 临时文件，曾因漏排导致打包 169MB）。改 .npmignore 后用 `npm publish --dry-run` 验证。

---

## 怎么跑相关测试

```bash
npm test                              # 全量（464 个，~7s）
node --test tests/task-extension.test.ts   # 单文件
node --test tests/subagent-agents.test.ts tests/cron-agent-bin.test.ts  # 多文件

npm run test:integration              # 集成测试（含真实 spawn）
```

---

## 历史 handoff（按需精读，不用全读）

最新 → 最旧，**只在改到相关主题时读**：

- `2026-06-30-clone-user-onboarding-and-test-perf.md` —— 克隆用户开箱可用性审核 + 测试性能修复（subagent 随包加载、cron spawn、测试性能 bug）
- `2026-06-30-handoff-for-new-developer.md` —— **本文档**（总交接）
- `2026-06-29-task-run-progress-visibility.md` —— task 运行进度可见性（worker summary 透传）
- `2026-06-28-linkedin-search-task.md` —— linkedin-search task 迁移（task 范式参考）
- `2026-06-28-x-search-task-and-task-creator-hardening.md` —— x-search task + dispatcher 门禁 + task-creator 基建（task 系统核心机制）
- `2026-06-27-architecture-debt-from-pr18.md` —— 架构债记录
- 更早的在 `docs/handoff/` 里，多为 judge/早期 task 系统历史

---

## 建议 skills（你接手后用 ugk 开发时）

- **ponytail** —— 全程遵循（lazy/最短可用 diff/非平凡判断必须实测验证）。本项目代码风格、测试习惯都基于它，AGENTS.md 的工作风格段也写了
- **task-creator** —— 创建新 taskbook 时被命中（已强化，含机制全景）
- **skill-creator** —— 创建/改进 skill 时

---

## 接手后建议先做的几件事（熟悉项目）

1. **跑一遍 `npm test`**，确认基线 464/464/0
2. **新开 ugk 跑一下**：`node bin/ugk.js`，试 `/ugk`、`/plan`、`@scout 列目录`、`/task`
3. **读 `AGENTS.md` + `docs/DEVELOPMENT.md`**，理解运行时上下文和开发约定
4. **读 `extensions/index.ts`**，理解工具/命令注册和权限门怎么接线
5. **挑一个 task 跑**：`/task run x-search "GPT5" "3h"`（需要登录态 Chrome），看 worker→verify→checker 流程

---

## 有问题找谁

交接前可问上一任维护者（mhgd3250905）。项目历史全在 git log + `docs/handoff/` + `docs/design/` 里，遇事可查。**核心约定在 AGENTS.md + DEVELOPMENT.md，代码里的 `ponytail:` 注释标记的是刻意简化（不是 ignorance，别轻易推翻）。**

---

> 改 ugk-core 代码的开发者：见 `docs/DEVELOPMENT.md`（开发侧约定，不在运行时注入）。
