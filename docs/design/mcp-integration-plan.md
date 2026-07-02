# ugk MCP 集成实施计划

> 状态: **⚠️ 已被取代,仅作历史背景参考**
> 本文档的 P0/P1 划分已被审核推翻(权限和清理必须上移到 P0),且含 npmignore 事实错误。
> **权威执行文档: `mcp-integration-action-plan.md`**(Step 0-8)。
> 执行 agent 请勿依据本文档实施。
>
> 原始草稿保留如下(历史记录)。

---

作者: ugk-dev
日期: 2026-06-20
基线: v1.1.0 (`ce1f6dc`)

本计划是计划书的执行拆解。先读计划书理解决策动机,本文件只讲**怎么做、做多久、做到什么程度**。
建议用 TDD 驱动(ugk 现有测试约定见 `package.json` 的 test 脚本),每步结束跑相关测试。

## 前置条件

- [ ] 计划书的「六、决策待确认事项」全部拍板
- [ ] 从 `main`(`ce1f6dc`)新建 feature 分支 `feat/mcp-client`
- [ ] 基线测试通过:`npm test`(474 pass)
- [ ] 确认 `@modelcontextprotocol/sdk` 在本机/CI 可装

## 模块依赖顺序

```
client.ts (SDK 封装)
   ↓
registry.ts (连接生命周期,依赖 client)
   ↓
config.ts (scope 合并) ──┐
                         ├→ tools.ts (工具注册,依赖 registry + config)
permissions.ts (策略) ───┘
                         ↓
                  index.ts (注册入口,串起全部 + 钩子/命令)
                         ↓
                  extensions/index.ts (挂载)
```

按「自底向上」实现,每层带测试,避免大爆炸式集成。

---

## P0 — 最小可用(跑通一个 server)

**目标**:配一个 filesystem server,模型能用它的工具。先不碰权限和清理。

### P0.1 引入 SDK + client.ts 封装

**改动**

- `package.json`: `dependencies` 加 `"@modelcontextprotocol/sdk": "<精确版本>"`
- 新建 `extensions/mcp/client.ts`:薄封装 `Client` + `StdioClientTransport`
  - 导出 `createMcpClient({ name, version })`
  - 导出 `connectStdio(client, { command, args, env })`
  - 导出 `listTools(client)` / `callTool(client, name, args)` / `closeClient(client)`
- 跑 `npm install`,确认 lockfile 更新

**测试** `tests/mcp-client.test.ts`
- ✅ connect 一个真实 stub server(node 子进程,stdio),listTools 返回数组
- ✅ callTool 能拿到结果
- ✅ closeClient 后子进程退出(用进程存活判断)

**验证**:`npm test -- mcp-client` 通过

### P0.2 registry.ts — 单 server 连接管理

**改动** 新建 `extensions/mcp/registry.ts`:
- `class McpConnection`:封装 `{ name, client, transport, tools[] }`
- `connectServer(name, config)`:连接 + listTools 缓存
- `getTool(name)` / `callTool(name, args)`:路由到对应 server
- `disconnect()`:关闭单个 server

**测试** `tests/mcp-registry.test.ts`
- ✅ connectServer 成功,tools 缓存正确
- ✅ getTool 能从多 server 取到正确工具
- ✅ disconnect 后 client 关闭
- ✅ 连接失败(server 启动报错)抛清晰错误,不崩 ugk

**验证**:`npm test -- mcp-registry` 通过

### P0.3 config.ts — 单档配置加载(先只 project scope)

**改动** 新建 `extensions/mcp/config.ts`:
- `interface McpServerConfig { command; args?; env? }`
- `loadProjectConfig(cwd)`:读 `<cwd>/.mcp.json`,解析 `mcpServers`
- schema 校验:command 必填,args/env 可选,类型校验
- `${VAR}` 环境变量插值(避免明文 token)
- 无文件 → 返回空 map(不报错)

**测试** `tests/mcp-config.test.ts`
- ✅ 合法 .mcp.json 解析正确
- ✅ 缺 command 抛错
- ✅ `${VAR}` 插值生效
- ✅ 无文件返回空
- ✅ 格式错误给清晰报错

**验证**:`npm test -- mcp-config` 通过

### P0.4 tools.ts — MCP tool 注册成 ugk 工具

**改动** 新建 `extensions/mcp/tools.ts`:
- `registerMcpTools(pi, connection)`:遍历 connection.tools,逐个 `pi.registerTool`
- 工具名 = `connection.name + "__" + tool.name`(D2 决策)
- `parameters`:把 MCP 的 JSON Schema 转成 TypeBox(pi 要求)
- `execute`:内部调 `connection.callTool(toolName, params)`,结果转 pi 的 `{content, details}` 格式
- `promptSnippet`:生成 `"<serverName__toolName>: <description>"`

**测试** `tests/mcp-tools.test.ts`
- ✅ 工具名带正确前缀
- ✅ JSON Schema → TypeBox 转换(常见类型:string/number/boolean/object/array)
- ✅ execute 调用路由到正确 server
- ✅ 结果格式适配 pi

**验证**:`npm test -- mcp-tools` 通过

### P0.5 index.ts — 串起来 + session 钩子

**改动**
- 新建 `extensions/mcp/index.ts`:`registerMcp(pi)` 导出
  - `pi.on("session_start")`:loadConfig → connectServer → registerMcpTools
  - 先只读不写权限,工具直接可用(P0 简化)
- `extensions/index.ts`:import + 调用 `registerMcp(pi)`

**测试** `tests/mcp-extension.test.ts`
- ✅ session_start 触发连接 + 注册
- ✅ 无配置时无副作用(不报错、不注册工具)
- ✅ 端到端:stub server → 工具注册 → 模拟调用 → 结果正确

**验证**:
- `npm test -- mcp-extension` 通过
- **手动 smoke**:项目根放 `.mcp.json`(filesystem server),`ugk` 启动,模型能调用 `filesystem__list_files`

### P0 出口标准

- [ ] 4 个测试文件全绿
- [ ] 全量 `npm test` 不回归(≥474 pass)
- [ ] 手动 smoke 跑通 filesystem server
- [ ] commit:`feat(mcp): P0 minimal stdio client + tool registration`

---

## P1 — 生产可用(权限 + 清理 + 多 scope)

**目标**:安全可上线,不漏僵尸进程,支持团队共享配置。

### P1.1 session_shutdown 清理(防僵尸进程)

**改动** `extensions/mcp/registry.ts` + `index.ts`:
- `Registry` 持有所有 McpConnection
- `pi.on("session_shutdown")`:遍历 disconnect 所有连接
- 进程退出兜底:`process.on("exit")` / `SIGINT`/`SIGTERM` 强制清理

**测试** `tests/mcp-registry.test.ts` 补充:
- ✅ disconnectAll 后所有子进程退出
- ✅ 重复 disconnect 幂等
- ✅ Windows 进程清理验证(tasklist 判断)

### P1.2 permissions.ts — 权限门(对齐 chrome-cdp)

**改动** 新建 `extensions/mcp/permissions.ts`:
- `McpPermissionMode = "off" | "ask" | "on"`(复用 chrome-cdp 模式)
- `checkMcpPolicy(state, request)`:对齐 `checkChromeCdpPolicy` 的返回结构
- `index.ts`:`pi.on("tool_call")` 拦截 `serverName__` 开头的工具名
  - off → block
  - ask + 未授权 → `ctx.ui.confirm` 弹窗
  - on / 已授权 → 放行

**测试** `tests/mcp-permissions.test.ts`
- ✅ off 模式全 block
- ✅ on 模式全放行
- ✅ ask 模式未授权需确认
- ✅ ask 模式 session allow 后不再问(对齐 chrome-cdp `grantChromeCdpSessionAllow`)
- ✅ 非 mcp 工具名不受影响

### P1.3 config.ts — 多 scope 合并

**改动** 扩展 `extensions/mcp/config.ts`:
- `loadUserConfig()`:`~/.config/ugk/mcp.json`(Windows: `%APPDATA%\ugk\mcp.json`)
- `loadLocalConfig()`:本地覆盖(不入库,如 `.mcp.local.json`)
- `mergeConfigs(user, project, local)`:高 scope 覆盖低 scope
- `/mcp` 命令显示各 server 来自哪个 scope

**测试** `tests/mcp-config.test.ts` 补充:
- ✅ 三档合并优先级正确
- ✅ 同名 server 高 scope 覆盖
- ✅ Windows 路径处理
- ✅ 跨平台 home 目录解析

### P1.4 commands.ts — /mcp 命令

**改动** 新建 `extensions/mcp/commands.ts`:
- `/mcp status`:已连接 server + 工具数 + 权限模式(对齐 chrome-cdp formatter)
- `/mcp on|off|ask`:切换权限模式
- `/mcp reload`:断开重连所有 server
- `/mcp add <name>`:交互式添加(引导输 command/args/env,选 scope)

**测试** `tests/mcp-extension.test.ts` 补充:
- ✅ status 输出格式正确
- ✅ reload 后工具重新注册
- ✅ mode 切换生效

### P1.5 doctor 集成 + 文档

**改动**
- `extensions/doctor/index.ts`:加 MCP 体检项(server 连接状态、SDK 版本)
- 新建 `skills/mcp-guide/SKILL.md`:使用指南(对齐现有 skill 结构)
- 更新 `README.md` / `AGENTS.md`:MCP 能力说明
- `.npmignore`:确认 `docs/` 不进包(docs 不发包,只 skills 发)

### P1 出口标准

- [ ] 全量 `npm test` 不回归,新增测试全绿
- [ ] `tasklist`(Win)验证无僵尸 mcp 子进程
- [ ] `npm pack --dry-run` 通过,entryCount 合理(预计 +8 左右)
- [ ] 手动:filesystem + github 双 server 无工具名冲突
- [ ] commit:`feat(mcp): P1 permissions, cleanup, multi-scope, /mcp command`

---

## P2 — 能力扩展(按需,审核后再定优先级)

P2 各项独立,审核后按实际需求排优先级,不必全做。

### P2.1 HTTP transport
- `StreamableHTTPClientTransport` 支持
- config schema 加 `url` 字段(对齐 Cursor 远程 server)
- 远程 server 默认 ask 模式(安全)
- 测试:mock HTTP server

### P2.2 resources / prompts
- `listResources` / `readResource` → 接 pi 的 `resources_discover` 或独立命令
- `listPrompts` / `getPrompt` → slash 命令或 `@prompt-name`
- 测试:stub server 带 resources/prompts

### P2.3 sampling 白名单
- config 加 `sampling: { allow: ["serverName"] }`
- `client.setRequestHandler("sampling/createMessage", ...)` 转发到当前模型
- 成本上限:maxTokens 限制
- 测试:白名单内外行为

### P2.4 roots 暴露
- `client.setRequestHandler("roots/list", ...)`:暴露 cwd 给 server
- 测试:server 能拿到 roots

### P2.5 工具按需启用(控 token)
- 工具数多时默认不全注册,`/mcp enable <server>` 按需开
- 配合 `pi.setActiveTools()`

---

## 工作量估算

| 阶段 | 模块数 | 测试文件 | 预估工时 | 产出 |
|---|---|---|---|---|
| P0 | 5 模块 | 4 文件 | ~1.5-2 天 | 能跑通一个 stdio server |
| P1 | 5 模块 | 2 文件(扩) | ~2-3 天 | 生产可用 |
| P2 | 5 可选项 | 视选择 | 每项 ~0.5-1 天 | 按需扩展 |

> 估时为理想投入,实际看决策反馈和 stub server 搭建成本。

## 风险节点(执行时盯紧)

1. **Windows 僵尸进程**:P0.1 client.ts 就要把 close 路径走通,P1.1 加退出兜底,别拖到最后。
2. **TypeBox 转换**:MCP JSON Schema → pi TypeBox 是最容易出 corner case 的地方,P0.4 要覆盖常见类型。
3. **pi registerTool 运行时行为**:虽然 `dynamic-tools.ts` 示例证实可行,但 MCP 可能一次注册几十个工具,需验证 pi 对大批量动态注册的性能和稳定性。
4. **session_start 时机**:确认此时 `pi.registerTool` 已可用(参考 dynamic-tools 示例),否则改用更晚的钩子。

## 提交策略

- 每个 P0.x / P1.x 单独一个 commit,消息前缀 `feat(mcp):` / `test(mcp):`
- P0、P1 各成一个 PR(或 P0+P1 合一),走 code review(skill: `requesting-code-review`)
- 不直接 push main,走 feature 分支 + PR
- 合并后更新 `README.md` / `AGENTS.md` / 版本号

## 验收清单(全部完成后)

- [ ] 计划书「五、验证标准」全部满足
- [ ] `npm test` 全绿且无回归
- [ ] `npm pack --dry-run` 通过,包大小合理
- [ ] 手动验证:filesystem + github 双 server 端到端可用
- [ ] Windows 无僵尸进程
- [ ] 文档更新完毕(SKILL.md / README / AGENTS)
- [ ] 版本号 bump(如 1.2.0)
