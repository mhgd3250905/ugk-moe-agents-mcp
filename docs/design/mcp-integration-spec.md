# ugk MCP 集成需求规格 (RequirementsSpec)

> 状态: **已定稿,交付执行**
> 日期: 2026-06-20
> 基线: v1.1.0 (`ce1f6dc`)
> 角色: 本文档为**执行规格**,供执行 agent 实现,由 ugk-dev 审核
> 关联: `mcp-integration-proposal.md`(设计背景)、`mcp-integration-plan.md`(将被本文档取代)

本规格已吸收同事审核反馈(7 大条 + 补充点)。执行 agent 须以本文件为准,proposal/plan 仅作参考背景,冲突时以本规格为准。

## 一、目标(一句话)

让 ugk 作为 MCP client 接入外部 MCP server(stdio),用户通过配置文件挂载外部工具,模型可调用,且**不引入安全或生命周期风险**。

**非目标:** 不做 MCP server;不改 pi 内核;一期不做 HTTP/resources/prompts/sampling。

## 二、已拍板的设计决策

| # | 决策 | 定论 |
|---|---|---|
| D1 | SDK | 锁定 `@modelcontextprotocol/sdk@1.29.0`(v1 精确版本)。**明确暂不采用 v2 alpha**(理由:v2 pre-alpha 且拆包为 `@modelcontextprotocol/client`/`server`;v2 client 要 Node>=20)。注:项目 README/package.json 无 engines 字段,但 v2 仍是 pre-alpha,锁 v1 为稳妥选择。 |
| D2 | 工具命名 | `serverName__toolName` 双下划线前缀。serverName/toolName 须做 provider-safe 规范化(见 §3.4) |
| D3 | 配置 scope | install(UGK 安装目录 `mcp.json`)+ user(`~/.config/ugk/mcp.json`)+ project(项目根 `.mcp.json`)+ local(`.mcp.local.json`,**必须进 .gitignore**) |
| D4 | 配置格式 | `{ "mcpServers": { name: { command, args?, env? } } }` 标准格式 |
| D5 | 安全底线(改) | **P0 必须含:连接前 spawn policy + session_shutdown 清理**。不是可选项 |
| D6 | 权限位置(改) | **execute 内 per-tool policy(对齐 chrome-cdp 真实模式)+ 连接前 spawn policy**。不用全局 tool_call 门(那只用于危险 bash) |
| D7 | 一期能力 | 只做 stdio + tools。resources/prompts/sampling/HTTP 放 P2 |
| D8 | sampling | 一期默认拒,二期白名单 |
| D9 | transport | 一期 stdio,二期 HTTP |
| D10 | pi 改动 | 零内核改动,纯扩展层 |

## 三、功能需求

### 3.1 连接与生命周期

**F1 spawn policy(连接前,强制 P0)**
- 连接任何 server 前,按 scope 判断:
  - **install scope**(UGK 安装目录 `mcp.json`,项目维护者控制):与 user scope 同级可信,**可直接连接**
  - **user scope**:`command` 已由用户全局配置,视为可信,**可直接连接**
  - **project scope**(来自 `.mcp.json`):**默认 ask**,首次连接弹 `ctx.ui.confirm`("server X 将执行 command Y,是否允许?")
  - **local scope**(来自 `.mcp.local.json`):**默认 ask**,同 project
- **非交互模式(无 UI):fail-closed**。project/local scope 一律拒绝连接,只允许 install/user scope
- 连接被拒:该 server 不连接、不注册工具,`/mcp status` 标红显示"blocked by spawn policy"

**F2 连接(session_start 触发)**
- 监听 `pi.on("session_start")`,reason 为 `startup`/`reload` 时触发连接流程
- 流程:loadConfig(合并三档) → 逐 server spawn policy → 连接 → listTools 缓存 → registerTools
- 连接超时:**30s**,超时标记失败不阻塞其他 server
- 启动失败(server 崩溃/command 不存在):回收资源(close transport),记录失败,`/mcp status` 标红,**不崩 ugk**

**F3 清理(强制 P0)**
- 监听 `pi.on("session_shutdown")`,reason 为 `quit`/`reload`/`new`/`resume`/`fork` 时 disconnect 所有连接
- **重复 disconnect 必须幂等**(多次调用不报错)
- 兜底:`process.on("exit")` + `SIGINT`/`SIGTERM` 强制清理所有未关闭子进程
- Windows 必须验证无僵尸进程

### 3.2 工具注册与调用

**F4 工具注册**
- 每个 MCP tool 注册成 ugk 工具,名称 = `<serverName>__<toolName>`
- 参数 schema:**优先 `Type.Unsafe(mcpInputSchema)` 原样透传**(审核建议,见 §3.5),不做手写窄转换
- execute 内部:`checkMcpToolPolicy` → `connection.callTool(name, args)` → 转换结果

**F5 per-tool 权限(execute 内,对齐 chrome-cdp)**
- 每个 MCP 工具的 `execute` 第一件事:`checkMcpToolPolicy(state, { serverName, toolName, reason })`
- 三态(复用 chrome-cdp 语义):
  - off → 直接返回 blocked
  - on → 放行
  - ask + 未授权 → `ctx.ui.confirm` 弹窗;allow-session 后本会话不再问(对齐 `grantChromeCdpSessionAllow`)
- 权限失败时返回 `{ content: [{type:"text", text: reason}], details: { blocked: true } }`

**F6 reload(承认 pi 约束)**
- pi **无 `unregisterTool`**(`loader.js:157` registerTool 只增不减,已核实)
- `/mcp reload` 实现:disconnect 所有 → 重新连接 → 对**消失的 server 的工具调 `setActiveTools` 排除**(无法真正移除 map 项,但可从 active tools 下线)
- **必须文档化**:stale MCP 工具(stale server 的工具)被调用时返回"server 已断开"错误,不尝试重连
- 用户重新 `/mcp enable <server>` 可把工具加回 active set

### 3.3 配置

**F7 scope 合并**
- 优先级:install(低) ← user ← project ← local(高)
- 同名 server:高 scope 完全覆盖低 scope(不做字段级合并)
- env 插值:`${VAR}` → process.env。**变量缺失时不静默置空**:该 server 标记为失败,`/mcp status` 红字显示"env GITHUB_TOKEN missing",不连接
- 无任何配置:静默跳过,无副作用

**F8 配置校验**
- command 必填(string),缺失 → 该 server 失败 + 红字
- args 可选(string[]),env 可选(Record<string,string>)
- 格式错误(非 JSON / schema 不符):清晰报错,不崩 ugk

### 3.4 命名规范化(provider-safe)

**F9** serverName/toolName 在注册前规范化:
- 小写化、非法字符(非 `[a-z0-9-]`)替换为 `-`
- 长度截断(serverName ≤ 32,toolName ≤ 64)
- 冲突检测:规范化后若两个 server 重名,后者加 `-2` 后缀,并在 status 标黄警告
- 生成的 `serverName__toolName` 若与已注册工具重名,该 tool 跳过 + 警告

### 3.5 JSON Schema 适配(审核重点)

**F10** MCP tool 的 `inputSchema`(JSON Schema)→ pi 的 TypeBox:
- **优先方案:`Type.Unsafe(schema)` 原样透传**(让 pi/typebox 直接消化)
- 回退:若 `Type.Unsafe` 不可行,做**最小规范化**(只处理 pi/typebox 必需的顶层),保留 enum/oneOf/anyOf/nullable/additionalProperties/$defs 原样
- **禁止手写窄转换器**(只支持 string/number/boolean/object/array 的那种)
- 测试必须覆盖:enum、oneOf、nullable、$defs 引用、additionalProperties

### 3.6 timeout / abort

**F11**
- 连接:30s timeout
- listTools:10s timeout
- callTool:60s timeout(长任务如索引)
- 所有 MCP 操作接受 `ctx.signal`(agent abort 时取消进行中的 MCP 调用)

### 3.7 server instructions(待拍板项 → 本规格定:注入)

**F12** MCP server 可在 connect 后通过 `getServerCapabilities()` / instructions 字段提供说明:
- **决策:读取并追加到 ugk 系统提示**(官方 client 文档建议)
- 实现:通过 `pi.on("before_agent_start")` 的 `BeforeAgentStartEventResult.systemPrompt` 追加
- 缺失时无副作用

### 3.8 /mcp 命令

**F13**
- `/mcp status`:已连接 server 列表 + 工具数 + 权限模式 + 失败 server(标红)
- `/mcp on|off|ask`:切换权限模式
- `/mcp reload`:见 F6
- `/mcp enable <server>`/`/mcp disable <server>`:控制 active tools

### 3.9 doctor 集成(安全)

**F14** doctor 的 MCP 体检:
- **只做配置校验 + 当前 registry 状态读取**
- **绝不 spawn 任意 MCP server**(doctor 是只读体检)
- 显示:user/project/local 各有哪些 server、已连接几个、失败几个

## 四、非功能需求

- **N1** 零 pi 内核改动
- **N2** 全量 `npm test` 不回归(基线 474 pass)
- **N3** 新增测试覆盖所有 F1-F14
- **N4** Windows 无僵尸进程(tasklist 验证)
- **N5** `.npmignore` 排除 `docs/`(见 §五配套)
- **N6** `npm pack --dry-run` 通过,新增文件合理
- **N7** 不把个人未跟踪材料混入提交

## 五、配套文件改动(执行 agent 一并处理)

1. `.npmignore`:加 `docs/` 规则(修正计划书错误:docs 确实进了包)
2. `.gitignore`:加 `.mcp.local.json`(local scope 不入库)
3. `package.json`:`dependencies` 加锁定版本 `@modelcontextprotocol/sdk@1.29.0`
4. `extensions/index.ts`:挂载 `registerMcp(pi)`
5. `README.md` + `AGENTS.md`:加 MCP 能力说明(连接后补)
6. `skills/mcp-guide/SKILL.md`:使用指南(连接后补)

## 六、验收标准(Definition of Done)

执行 agent 完成后须满足:

1. ✅ F1-F14 全部实现且有测试
2. ✅ 配置无配置时零副作用;有配置时按 scope 安全连接
3. ✅ filesystem server(`@modelcontextprotocol/server-filesystem`)端到端可用
4. ✅ filesystem + 一个 stub server 双挂载,工具名 `server__tool` 无冲突
5. ✅ spawn policy 生效:project scope 首次连接弹确认,拒绝则不 spawn
6. ✅ 非交互模式 project/local scope fail-closed
7. ✅ session_shutdown 后 tasklist 无 mcp 子进程残留
8. ✅ `npm test` 全绿(≥474 + 新增 mcp 测试)
9. ✅ `npm pack --dry-run` 通过,docs/ 不在包内
10. ✅ .gitignore 含 .mcp.local.json

## 七、执行约束

- 从 `main`(`ce1f6dc`)新建分支 `feat/mcp-client`
- TDD:每层先写测试
- commit 前缀 `feat(mcp):` / `test(mcp):` / `chore(mcp):`
- 不直接 push main,走 feature 分支
- 每个逻辑模块独立 commit
