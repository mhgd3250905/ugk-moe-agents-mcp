# ugk MCP 集成计划书

> 状态: **⚠️ 已被取代,仅作历史背景参考**
> 本文档存在同事审核揪出的事实错误(docs/npmignore、权限门位置),且 P0/P1 划分已被推翻。
> **权威文档已变更为:**
> - 需求规格: `mcp-integration-spec.md`
> - 执行方案: `mcp-integration-action-plan.md`
> 执行 agent 请勿依据本文档实现,冲突时以 spec/action-plan 为准。
>
> 原始草稿保留如下(历史记录)。

---

作者: ugk-dev
日期: 2026-06-20
基线: v1.1.0 (`ce1f6dc`)

## 一、背景与目标

### 1.1 现状

ugk 当前(v1.1.0)的工具体系是**封闭**的:所有工具(`bash`/`read`/`edit`/`scrcpy`/`subagent`/`chrome_cdp` 等)都写死在 `extensions/index.ts` 里,用户无法在不改代码的前提下接入外部工具。这与 Claude Code / Cursor / Cline 等主流 agent 已普遍支持的 MCP(Model Context Protocol)生态形成能力差距。

### 1.2 目标

让 ugk 作为 **MCP client** 接入外部 MCP server,使用户通过配置文件即可挂载任意外部工具(filesystem / github / 数据库 / 自建 server 等),无需改 ugk 代码。

**非目标(明确不做):**

- ❌ 不把 ugk 自身暴露成 MCP server 对外提供服务
- ❌ 不在 ugk 内重新实现 MCP 协议层(直接用官方 SDK)
- ❌ 不改动 pi 内核(pi 0.79.4 无内置 MCP,全部走扩展层)

### 1.3 角色定位

| 项 | ugk 在 MCP 中的角色 |
|---|---|
| 角色 | **MCP Client**(消费方) |
| 连接方向 | ugk → 外部 MCP server |
| 能力 | 拉取 server 的 tools,转成 ugk 工具供 LLM 调用 |

## 二、调研结论

### 2.1 pi 官方确实没有 MCP 实现

**已核实,不是猜测。** 证据链:

1. `pi-coding-agent@0.79.4` 的 `package.json` 直接依赖里**无** `@modelcontextprotocol/sdk`,也无任何 mcp 命名包:
   ```
   pi-agent-core, pi-ai, pi-tui, photon-node, chalk, cross-spawn,
   diff, glob, highlight.js, hosted-git-info, ignore, jiti,
   minimatch, proper-lockfile, semver, typebox, undici, yaml
   ```
2. 在 pi 源码中 grep `mcp|modelcontextprotocol`,命中全部位于 `node_modules/@mistralai/` 和 `node_modules/openai/` —— 这是第三方 provider SDK 的附属物(Mistral 的云端 beta Connectors 命名碰巧含 mcp),与 pi 是否集成 MCP 无关。
3. pi 扩展 API(`dist/core/extensions/types.d.ts`)中**没有任何 MCP 专用入口**。

**结论:pi 层面无现成 MCP 能力,必须在扩展层自建 client 桥接。**

### 2.2 但 pi 扩展 API 完全够用

`extensions/index.ts` 已确认可用、且 `dynamic-tools.ts` 官方示例证实的 API:

| API | 用途 | MCP 场景 |
|---|---|---|
| `pi.registerTool(tool)` | 运行时动态注册工具 | 把每个 MCP tool 注册成 ugk 工具 |
| `pi.getActiveTools()` / `pi.setActiveTools()` | 控制工具对 LLM 可见性 | 按需启用,控 token 成本 |
| `pi.on("session_start")` | 会话开始钩子 | 连接 MCP server 子进程 |
| `pi.on("session_shutdown")` | 会话结束钩子 | 关闭子进程,防僵尸 |
| `pi.on("tool_call")` | 工具调用前拦截,可 `block` | MCP 工具的权限门 |
| `pi.registerCommand()` | slash 命令 | `/mcp status` 等 |

**无需 fork pi,无内核改动,纯扩展层实现。**

### 2.3 官方 SDK 能力面(`@modelcontextprotocol/sdk`)

Tier 1 官方 TypeScript SDK,TS 原生,transport/client 齐全:

| 类别 | 能力 | ugk 采纳 |
|---|---|---|
| Client → Server(主动) | `listTools`/`callTool`/`listResources`/`readResource`/`listPrompts`/`getPrompt` | ✅ tools 一期;resources/prompts 二期 |
| Server → Client(回调) | `sampling/createMessage`/`elicitation/create`/`roots/list` | ⚠️ sampling 有安全+成本风险,默认拒,二期白名单 |
| Transport | `StdioClientTransport`(本地进程)/ `StreamableHTTPClientTransport`(远程) | ✅ stdio 一期;HTTP 二期 |

**生命周期最佳实践**(官方 client-quickstart):Client → connect(transport) → listTools 缓存 → 按需 callTool → close()。**重点:stdio 会 spawn 子进程,退出必须 close(),否则僵尸进程(Windows 尤甚)。**

### 2.4 主流客户端配置实践(决定 ugk 的兼容策略)

行业已收敛到**同一份 schema**(Claude Desktop / Claude Code / Cursor / Cline / Windsurf / Continue 共用):

```json
{
  "mcpServers": {
    "server-name": { "command": "...", "args": [], "env": {} }
  }
}
```

Claude Code 的**三档 scope** 模式是业内公认最佳实践:

| scope | 位置 | 用途 | 入库 |
|---|---|---|---|
| user(全局) | `~/.config/ugk/mcp.json` | 到处都要的 server(GitHub/Context7) | 否 |
| project(团队) | 项目根 `.mcp.json` | 团队共享 | 是 |
| local(实验) | 本地覆盖,不入库 | 实验 | 否 |

### 2.5 命名冲突 —— 多 server 头号坑

这是 MCP 多 server 场景**必须从设计阶段解决的问题**,Cursor forum、Microsoft Research 均点名:

- 多个 server 暴露同名工具(如都叫 `search`)→ 模型调错 server → 静默失败
- 安全风险:恶意 server 复刻 trusted 工具名钓鱼

**业内共识:client 层强制命名空间**,主流做法 `serverName__toolName`(双下划线)。ugk 必须照做。

## 三、设计方案

### 3.1 架构总览

```
用户 .mcp.json / ~/.config/ugk/mcp.json / local 覆盖
        │ (三档 scope 合并,project 覆盖 user)
        ▼
┌─────────────────────────────────────────────┐
│  extensions/mcp/                             │
│  ┌──────────────┐    ┌────────────────────┐ │
│  │ config.ts    │───▶│ registry.ts        │ │  ← 每个 server 一个 McpConnection
│  │ (scope 合并) │    │ connect/listTools/ │ │     管理子进程生命周期
│  │              │    │ callTool/close     │ │
│  └──────────────┘    └─────────┬──────────┘ │
│                                │ listTools()│
│                                ▼            │
│  ┌────────────────────────────────────────┐ │
│  │ tools.ts → pi.registerTool()           │ │  ← 每个 MCP tool 注册成 ugk 工具
│  │   name = "serverName__toolName"        │ │     带前缀避免冲突
│  └────────────────────────────────────────┘ │
│  permissions.ts → pi.on("tool_call") 权限门  │  ← 沿用 chrome-cdp 的 ask/on/off
│  commands.ts    → /mcp status|add|reload|... │
└─────────────────────────────────────────────┘
        │ session_start / session_shutdown 钩子
        ▼
   @modelcontextprotocol/sdk Client
   StdioClientTransport / HTTP transport
```

### 3.2 文件结构(对齐现有 chrome-cdp 模式)

```
extensions/mcp/
├── index.ts          registerMcp(pi): 工具/命令/钩子注册入口
├── config.ts         三档 scope 加载 + schema 校验 + 合并
├── registry.ts       McpConnection 类: 连接/列工具/调用/关闭生命周期
├── tools.ts          MCP tool → pi ToolDefinition 适配器(加 server 前缀)
├── permissions.ts    权限策略(对齐 chrome-cdp 的 ask/on/off)
├── formatter.ts      /mcp 状态渲染(对齐 chrome-cdp formatter)
└── client.ts         @modelcontextprotocol/sdk Client 薄封装
tests/
├── mcp-config.test.ts        scope 合并 + schema 校验
├── mcp-registry.test.ts      连接生命周期 + 僵尸进程防护
├── mcp-tools.test.ts         工具名前缀 + schema 适配
├── mcp-permissions.test.ts   ask/on/off 策略
└── mcp-extension.test.ts     端到端 session 钩子
```

### 3.3 关键设计决策(供审核逐条评议)

| # | 决策点 | 选择 | 理由 | 备选 |
|---|---|---|---|---|
| D1 | MCP SDK | 新增 dep `@modelcontextprotocol/sdk` | Tier 1 官方,不自造协议层 | 自实现协议(否决:重复造轮子) |
| D2 | 工具命名 | `serverName__toolName` 双下划线前缀 | 业内共识,解决多 server 冲突 | 不加前缀(否决:冲突) |
| D3 | 配置 scope | user + project + local 三档 | 对齐 Claude Code,迁移成本低 | 单一配置文件(否决:场景不够) |
| D4 | 配置格式 | `{ "mcpServers": {...} }` 标准格式 | 行业通用 schema | 自定义格式(否决:迁移成本) |
| D5 | 连接时机 | `session_start` 连接 + 注册工具;`session_shutdown` close | 复用 pi 生命周期钩子 | 启动时全连(否决:拖慢启动) |
| D6 | 权限模型 | 沿用 chrome-cdp 的 ask/on/off 三态 | ugk 已有成熟模式,体验一致 | 全开/全关(否决:不安全/不便) |
| D7 | resources/prompts | 一期只做 tools,二期补 | tools 是 80% 场景,先交付价值 | 全做(否决:周期长) |
| D8 | sampling 回调 | 一期默认拒,二期加白名单 | 安全 + token 成本可控 | 全开(否决:成本失控) |
| D9 | transport | 一期 stdio,二期 StreamableHTTP | stdio 覆盖本地 server 主流 | HTTP 一期(否决:复杂度) |
| D10 | pi 改动 | 零内核改动,纯扩展层 | 解耦,pi 升级无耦合 | 改 pi(否决:违反运行时发行策略) |

### 3.4 用户配置示例

`.mcp.json`(项目根,可提交共享):
```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "."]
    },
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_TOKEN": "${GITHUB_TOKEN}" }
    }
  }
}
```

用户交互:
```
/mcp status     → 列出已连接 server + 工具数 + 权限模式
/mcp add <name> → 交互式添加 server 到指定 scope
/mcp reload     → 断开重连所有 server
/mcp on|off|ask → 切换权限模式(对齐 /cdp)
```

模型自动使用挂载的工具(如 `github__search_repos`、`filesystem__read_file`)。

### 3.5 scope 合并优先级

```
生效配置 = user(scope=低) ← project ← local(scope=高)
```

- 同名 server:高 scope 覆盖低 scope
- `env` 变量:支持 `${VAR}` 插值(避免明文 token 进 git)
- 无 server 时静默跳过,不报错

## 四、风险与边界

| 风险 | 影响 | 缓解 |
|---|---|---|
| 僵尸子进程(Windows 尤甚) | 资源泄漏 | `session_shutdown` 强制 close + 测试覆盖;退出钩子兜底 |
| 工具数量爆炸 → token 成本 | context 膨胀 | `setActiveTools` 按需启用;`/mcp status` 显示工具数 |
| 任意 server = 可执行任意代码 | 安全 | 默认 `ask` 模式,首次连接需确认(对齐 chrome-cdp) |
| 命名冲突 | 静默失败 | 强制 `serverName__` 前缀(D2) |
| pi 升级 API 变更 | 集成断裂 | 零内核改动 + 锁定 pi 版本(UGK 现有发行策略) |
| SDK 版本漂移 | 行为变化 | 锁定 SDK 精确版本,随 UGK 版本一起升 |

## 五、验证标准(Definition of Done)

一期(P0+P1)完成需满足:

1. ✅ 配置文件存在时自动连接,无配置时无副作用
2. ✅ `npx @modelcontextprotocol/server-filesystem .` 能被挂载,其工具可被 LLM 调用
3. ✅ 工具名带 `serverName__` 前缀,多 server 无冲突
4. ✅ 会话结束无僵尸进程(`tasklist` 验证)
5. ✅ 默认 ask 模式,首次连接弹确认
6. ✅ `npm test` 全绿(含新增 mcp 测试,现有 474 不回归)
7. ✅ `npm pack --dry-run` 通过,entryCount 合理增长(不打包 docs)
8. ✅ 新增依赖进入 dependencies,版本锁定

## 六、决策待确认事项(请审核人评议)

以下为需要拍板的决策点,审核时请逐条表态:

1. **是否同意新增 `@modelcontextprotocol/sdk` 依赖?**(D1)
2. **`serverName__toolName` 双下划线前缀是否接受?**(D2)
3. **三档 scope(user/project/local)是否合理?配置路径 `~/.config/ugk/mcp.json` 是否合适?**(D3)
4. **一期只做 stdio + tools,resources/prompts/sampling 放二期,是否同意?**(D7/D8/D9)
5. **权限模型直接复用 chrome-cdp 的 ask/on/off,是否同意?**(D6)
6. **分期交付(P0 先跑通 → P1 完善 → P2 扩展)是否 OK?还是要一次性做完?**

## 七、参考资料

- MCP TypeScript SDK 官方仓库: https://github.com/modelcontextprotocol/typescript-sdk
- MCP 官方文档 - 构建 Client: https://modelcontextprotocol.io/docs/develop/build-client
- Claude Code MCP 文档(三档 scope): https://code.claude.com/docs/en/mcp
- Tool Name Collisions - Vulnerable MCP Project: https://vulnerablemcp.info/vuln/tool-name-collisions.html
- Tool-space interference in the MCP era - Microsoft Research: https://www.microsoft.com/en-us/research/blog/tool-space-interference-in-the-mcp-era-designing-for-agent-compatibility-at-scale/
- Cursor 论坛: MCP 工具名冲突讨论: https://forum.cursor.com/t/mcp-tools-name-collision-causing-cross-service-tool-call-failures/70946
- pi 扩展 API 参考: `node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts`
- ugk 参考实现: `extensions/chrome-cdp/`(权限门模式)、`extensions/index.ts`(扩展注册)
