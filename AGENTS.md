# ugk-moe-agents-mcp 运行时上下文

## 角色

这是 **ugk-moe-agents-mcp**——一个 MoE(Mixture of Experts)专家 agent 集合 + MCP 网关项目。每个"专家"是一个**只懂一件事**的独立 agent,通过标准 MCP 接口对外暴露,自带 `verify.mjs` 机器验收保证结果可靠。本项目 fork 自 [ugk-core](https://github.com/mhgd3250905/ugk-tui) 但**独立演进**,设计哲学不同(见下方红线)。

你是被调用、进来改这个项目代码的开发 agent。进来的第一件事:**理解运作方式和红线**。

## 语言

**默认用中文交流。** 代码、命令、标识符不随语言切换。

## 工作风格

- 简洁,优先复用已有结构(skill-creator 规范、标准 ugk、标准 MCP),不发明新概念
- 改完代码跑测试套件(详见 [docs/DEVELOPMENT.md](./docs/DEVELOPMENT.md),当前 245 pass)
- 危险操作前确认

---

## 核心架构(必读)

```
调用方 agent (ugk / Claude / 任何 MCP client)
    │ MCP 标准调用
    ▼
┌─────────────────────────────────────────────┐
│  ugk-experts MCP 网关 (gateway/server.mjs)   │
│  run_expert(expert, input) → jobId          │
│  check_job(jobId)           → 状态          │
│  get_result(jobId)          → 结果/产物     │
│  doctor(expert?, action?)   → 权限查询/配置 │
└──────────────┬──────────────────────────────┘
               │ spawn 干净 ugk 实例(只加载一个 skill)
               ▼
   ┌────────────────────────┐
   │ 专家实例                │
   │ ├ UGK_ONLY_SKILL 限加载 │
   │ ├ 用声明授权的工具      │
   │ └ 产物写到 TASK_OUTPUT_DIR│
   └───────────┬────────────┘
               │ runVerify 验收
               ▼
        PASS → 返回产物路径 + 摘要
        FAIL → 返回结构化失败原因(VerifyFailure[])
```

四个关键点:
1. **专家 = 标准 skill + verify.mjs**,跑在干净 ugk 实例里(经 `UGK_ONLY_SKILL` 只加载一个 skill)。专家之间进程级隔离。
2. **网关暴露 4 个 MCP tool**:`run_expert` / `check_job` / `get_result` / `doctor`(`gateway/server.mjs`)。
3. **异步句柄模式**:`run_expert` 立即返回 jobId(<5s),任务后台跑。避开 MCP 60s callTool 超时。
4. **verify gate**:专家跑完自动调 `verify.mjs` 验收。PASS 返产物,FAIL 返结构化失败原因。

---

## 设计红线(违反即错)

> 这是本项目相对 ugk-core 旧 task 系统的核心转向。改代码前先消化。

**1. 专家 = 标准 skill + verify,不发明新概念**
不要新造 taskbook/contract.json/spec.json/dispatcher/checker。本项目只组装已有结构:标准 skill + 标准 ugk + 标准 MCP + verify.mjs(唯一遗产)。

**2. 过程放开,只在结果处设 verify 闸门**
不要加"防 agent 犯错"的过程脚手架——四阶段流程、工具白名单、状态机、context filter、方向性重试 checker。这些正是本项目从旧 task 砍掉的。框架只在出口判 PASS/FAIL。

**3. `UGK_ONLY_SKILL` 是专家实例地基**
`extensions/index.ts` 的 `resources_discover` 命中 `UGK_ONLY_SKILL` env 时只返回一个 skill。不设 env 时行为不变(全量加载)。不要改这个分支,也不要绕开它。

**4. 网关是异步句柄,不要改成同步阻塞**
`run_expert` 必须立即返回 jobId 不等子进程。专家跑一次可能几分钟,同步会撞 60s 超时。轮询是调用方 agent 的事。

**5. consent 类权限只能 CLI doctor 写,MCP doctor tool 拒绝**
`chrome_cdp` 这类控制性权限只能由用户在命令行跑 `node gateway/doctor.mjs` 授予。MCP `doctor` tool 的 `applyConfig` 调用 `allowConsent=false`。**这是安全硬边界。** `CONSENTABLE_TOOLS` 白名单只有 `chrome_cdp`,防专家包声明任意名字骗 consent。

---

## 权限模型

专家在 `agent.json` 声明三类权限,`gateway/requirements.mjs` 统一处理:

| 权限类 | 字段 | 例子 | 怎么满足 |
|---|---|---|---|
| **consent** | `requiredTools` | `chrome_cdp` | CLI doctor 同意;MCP **拒绝**代写 |
| **env** | `requiredEnv` | `DEEPSEEK_API_KEY` | doctor 写 config.json,或环境变量 |
| **binary** | `requiredBinaries` | `yt-dlp` | 只检查 PATH |

**安全分治**:env 类可 MCP 代写(小白友好);consent 类只能 CLI 写(控制本地资源必须人亲手同意)。状态持久化在每个专家包的 `config.json`。

`run_expert` 有**权限预检**:缺权限不 spawn(省 token),返结构化缺失清单(`status:"missing_requirements"` + 每项 `howToFix`)。

---

## 专家包格式

装在 `~/.pi/agent/experts/<name>/`(样本在 `examples/experts/`):

| 文件 | 作用 |
|---|---|
| `agent.json` | `name`/`description`/`inputSchema`/`requiredTools`/`requiredEnv`/`requiredBinaries`/`artifacts` |
| `SKILL.md` | 标准 skill(skill-creator 规范,frontmatter `name`+`description`) |
| `verify.mjs` | 验收脚本:`exit 0`=PASS;非 0=FAIL 且 stdout 是 `VerifyFailure[]` JSON |

**环境变量契约**(网关注入):`TASK_INPUT`(JSON 输入)/ `TASK_OUTPUT_DIR`(产物目录)/ `TASK_DIR`(专家包目录)。

**VerifyFailure**:`{ assertion, expected, actual, hint? }`。FAIL 原因经 `get_result` 显式回调用方,不静默吞。

---

## 关键约定

- **bash 走 Git Bash**,Linux 语法,Windows 路径正斜杠
- **改完跑测试**(245 pass 基线);开发/测试约定见 [docs/DEVELOPMENT.md](./docs/DEVELOPMENT.md)
- 危险操作前确认

---

> 完整设计推导见 [DESIGN.md](./DESIGN.md)。本文件是 agent 能快速消化的运行时要点。
