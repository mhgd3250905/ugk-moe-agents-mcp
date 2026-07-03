# ugk-moe-agents-mcp

> 专家 agent 集合 + MCP 网关。每个专家是一个**懂一件事**的独立 agent,通过标准 MCP 接口对外提供服务,自带机器验收保证结果可靠。

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node](https://img.shields.io/badge/node-%3E%3D18-green)](https://nodejs.org)
[![Tests](https://img.shields.io/badge/tests-323%20pass-brightgreen)](#测试)

---

## 这是什么

普通 MCP server 提供的是**确定性函数**——你调它,它 deterministic 地返回结果。

`ugk-moe-agents-mcp` 提供的是**会干活的 agent**。每个"专家"内部跑着一个完整的 LLM agent,它能:

- **自适应你的本地环境**——第一次在新机器上跑,它会自己摸索环境(找 Chrome、试登录态、处理弹窗),不靠硬编码路径
- **处理不确定性**——网页结构变了、登录态过期、接口报错,它自己重试和调整
- **保证结果可靠**——每个专家自带 `verify.mjs` 验收脚本,产物不合格就 FAIL,不返回垃圾

一句话:**普通的 MCP 是"死工具",这里的专家是"活的、会适应的、有质量保证的 agent"。**

## 为什么需要它

让 LLM agent 完成一件复杂的事(比如"搜 X 上周的推文整理成 JSON"),你只有两个传统选项,都不好:

| 方案 | 问题 |
|---|---|
| 让主 agent 自己干 | 吃光主 agent 的 context(翻几百条推文),且每次都要从零摸索环境 |
| 写个普通脚本/MCP tool | 网页一变就崩,登录态一过期就死,换个机器就跑不通 |

`ugk-moe-agents-mcp` 给你第三条路:**把"会处理不确定性的 agent"封装成可复用的专家,通过 MCP 标准接口调用,结果有 verify 兜底。**

- 主 agent 不消耗 context——专家在自己的隔离进程里跑完,只回结果
- 专家能适应环境——它是 agent,不是死脚本
- 结果可靠——verify.mjs 是客观闸门,PASS 才返回

## 架构(30 秒看懂)

```
你的 agent (ugk / Claude / 任何 MCP client)
    │
    │  MCP 标准调用
    ▼
┌─────────────────────────────────────────────┐
│  ugk-experts MCP 网关 (gateway/server.mjs)   │
│                                              │
│  run_expert(expert, input) → jobId           │
│  check_job(jobId)           → 状态           │
│  get_result(jobId)          → 结果/产物      │
└──────────────┬──────────────────────────────┘
               │ spawn 干净 ugk 实例
               ▼
   ┌────────────────────────┐
   │ 专家实例 (x-search)     │
   │ ├ 加载 x-search skill   │
   │ ├ 用 chrome_cdp 等工具  │
   │ └ 产物写到 outputDir    │
   └───────────┬────────────┘
               │ 跑 verify.mjs 验收
               ▼
        PASS → 返回产物路径
        FAIL → 返回结构化失败原因
```

**关键设计**:每个专家 = 一个标准 skill + 一个 verify 脚本,跑在一个干净的 ugk 实例里(只加载这一个 skill)。专家之间互相隔离(x-search 不知道 linkedin-search 存在)。完整设计思路见 [DESIGN.md](./DESIGN.md)。

## 快速开始

### 1. 安装

```bash
git clone https://github.com/mhgd3250905/ugk-moe-agents-mcp.git
cd ugk-moe-agents-mcp
npm install
```

需要 Node 18+。专家实例是完整的 ugk,需要配 LLM API key(DeepSeek/OpenAI 等,经环境变量)。

### 2. 装一个专家包

专家包装在 `~/.pi/agent/experts/<name>/`,每个含三件套:

```
~/.pi/agent/experts/x-search/
├── agent.json     # 元数据 + 输入 schema + 工具声明
├── SKILL.md       # 标准 skill(告诉专家怎么做)
├── scripts/       # 跟随 skill 的脚本(可选)
└── verify.mjs     # 验收脚本(客观判定 PASS/FAIL)
```

可以从 `examples/experts/` 复制样本到你的专家目录:

```bash
mkdir -p ~/.pi/agent/experts
cp -r examples/experts/echo ~/.pi/agent/experts/echo
```

### 3. 把网关接入你的 MCP client

在你的 MCP 配置(ugk 的 `~/.config/ugk/mcp.json`,或 Claude Desktop 的 `claude_desktop_config.json`)加一条:

```json
{
  "mcpServers": {
    "ugk-experts": {
      "command": "node",
      "args": ["/path/to/ugk-moe-agents-mcp/gateway/server.mjs"]
    }
  }
}
```

### 4. 调用专家

接入后,你的 agent 会看到三个工具。工作流是**异步三步**(因为专家跑一次可能要几分钟,避开 MCP 的 60s 超时):

```
# 1. 启动任务,立即拿 jobId(<5秒)
run_expert(expert="x-search", input={keyword="AI", startIso=..., endIso=...})
  → { jobId: "job-...", status: "running" }

# 2. 轮询状态(每几秒一次)
check_job(jobId="job-...")
  → { status: "running", progress: "调用工具: chrome_cdp" }
  → { status: "pass" }   # 或 fail / error

# 3. 取结果
get_result(jobId="job-...")
  → { status: "pass", artifacts: ["/path/x_search_results.json"], summary: "..." }
```

`fail` 时会返回结构化的失败原因(`assertion/expected/actual/hint`),你的 agent 能据此判断要不要重试或换参数。

## 专家包怎么写

专家包是本项目的主要扩展方式。三件套:

### agent.json — 接口声明

```json
{
  "name": "my-expert",
  "description": "这个专家干什么",
  "version": "1.0.0",
  "inputSchema": {
    "type": "object",
    "properties": { "query": { "type": "string" } },
    "required": ["query"]
  },
  "requiredTools": [],
  "artifacts": ["result.json"]
}
```

- `inputSchema`:标准 JSON Schema,决定 `run_expert` 接收什么参数
- `requiredTools`:声明的受保护工具(如 `chrome_cdp`),网关会自动透传授权
- `artifacts`:预期产物文件名,网关据此回收产物路径

### SKILL.md — 执行方法

遵循 [skill-creator 规范](./skills/skill-creator/SKILL.md)的标准 skill。带 YAML frontmatter(`name` + `description`),body 写执行步骤。专家实例激活后读它,按里面的指引干活。

**环境变量契约**(网关注入,SKILL.md 里直接用):
- `TASK_INPUT` — JSON 格式的输入参数
- `TASK_OUTPUT_DIR` — 产物落盘目录
- `TASK_DIR` — 专家包目录(含 scripts/)

### verify.mjs — 验收脚本

Node ESM 脚本,客观判定产物是否合格。契约:

```javascript
// 读输入和产物
const input = JSON.parse(process.env.TASK_INPUT || '{}');
const outDir = process.env.TASK_OUTPUT_DIR;

// 收集失败项
const failures = [];
if (!fileExists) failures.push({
  assertion: 'output exists',
  expected: 'result.json',
  actual: 'missing',
  hint: '专家必须写产物文件'
});

// FAIL:打印 VerifyFailure[] JSON + exit 1
if (failures.length) { console.log(JSON.stringify(failures, null, 2)); process.exit(1); }
// PASS:exit 0
console.log('PASS');
```

`VerifyFailure` schema:`{ assertion: string, expected: string, actual: string, hint?: string }`。

参考样本:`examples/experts/echo/verify.mjs`(最简)、`examples/experts/x-search/verify.mjs`(真实复杂场景)。

## 测试

```bash
npm test              # 全量(当前 323 pass)
node --test tests/gateway-verify.test.ts      # 单文件
```

## 项目结构

```
gateway/                 # MCP 网关(核心)
├── server.mjs           # MCP server 入口(run_expert/check_job/get_result)
├── registry.mjs         # 专家包发现
├── runner.mjs           # spawn 专家实例 + 异步 job + verify gate
└── verify.mjs           # runVerify 实现

extensions/              # ugk 扩展(专家实例的能力来源)
├── index.ts             # 扩展入口(含 UGK_ONLY_SKILL 单 skill 加载)
├── chrome-cdp/          # chrome_cdp 工具(x-search 等需要)
├── mcp/                 # MCP client(专家实例可连其他 MCP server)
└── ...

bin/                     # ugk CLI 入口
examples/experts/        # 专家包样本(echo / x-search)
skills/                  # 标准 skill(含 skill-creator 规范)
tests/                   # 测试
```

## 设计文档

- [DESIGN.md](./DESIGN.md) — 完整设计说明:为什么是 MoE(Mixture of Experts)、为什么用 MCP、专家包格式的设计取舍、与旧 task 系统的对比
- [gateway/](./gateway/) — 网关源码,每个文件头有详细注释

## 已知限制

- **专家实例需要 API key**:专家底层是 LLM agent,跑一次会消耗 token
- **chrome_cdp 专家需要本地 Chrome**:x-search 这类依赖登录态的专家,需要你本地 Chrome 已登录目标网站
- **异步模式需要 agent 配合**:调用方 agent 要会"轮询"(run_expert → check_job → get_result),不能阻塞等待
- **冗余代码**:本仓库 fork 自 [ugk-core](https://github.com/mhgd3250905/ugk-tui),还保留了 ugk 的完整 CLI 能力(cron/plan-mode/ui-brand 等)。这些不影响网关运行,会逐步清理

## 致谢

本项目 fork 自 [ugk-tui(ugk-core)](https://github.com/mhgd3250905/ugk-tui),基于 [pi (pi-coding-agent)](https://github.com/earendil-works/pi) 构建。专家包的 verify 机制继承自 ugk-core 的 task 系统。社区主题来自 [pi-community-themes](https://github.com/hasit/pi-community-themes)(MIT)。

## License

[MIT](./LICENSE)
