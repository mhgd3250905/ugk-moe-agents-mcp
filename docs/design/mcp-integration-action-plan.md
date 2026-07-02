# ugk MCP 集成执行行动方案 (Action Plan)

> 状态: **交付执行**
> 日期: 2026-06-20
> 角色: 本方案为执行 agent 的操作手册。ugk-dev 负责审核,不亲自实现。
> 权威文档: `mcp-integration-spec.md`(需求规格)。冲突时以规格为准。

本方案把规格拆成**有严格顺序的步骤**,每步可独立验证。执行 agent 按顺序执行,每步完成后停下等我审核,不要跳步。

## 执行原则

1. **TDD**:每层先写测试再实现。测试命名 `tests/mcp-*.test.ts`,加入 `package.json` 的 test 脚本。
2. **小步提交**:每个 Step 一个 commit,前缀 `feat(mcp):` / `test(mcp):` / `chore(mcp):`。
3. **自底向上**:client → registry → config → tools → permissions → index,避免大爆炸集成。
4. **每步停下等审核**:完成 Step N 的验证后,在回复里给出 `npm test` 结果和该 step 产出,等我 PASS 再进 Step N+1。
5. **不擅自扩大范围**:规格没写的(如 resources/sampling)不要顺手做。

---

## Step 0:前置准备

**目标**:建分支,锁依赖,修配套文件。

**操作**
1. `git checkout -b feat/mcp-client`(从 main `ce1f6dc`)
2. `npm install @modelcontextprotocol/sdk@1.29.0`(精确版本,见规格 D1)
3. 确认 `package.json` dependencies 含锁定版本,无 `^`/`~` 漂移
4. 修 `.npmignore`:加 `docs/` 规则(规格 N5,修正计划书错误)
5. 修 `.gitignore`:加 `.mcp.local.json`(规格配套)

**验证**
- `git status` 显示新分支
- `package.json` 有 `@modelcontextprotocol/sdk@1.29.0`
- `npm test` 仍 474 pass(不动业务代码,不回归)
- `npm pack --dry-run` 不再含 `docs/`(重点验证!)

**产出**:commit `chore(mcp): 锁定SDK依赖+配置文件配套`
**完成后停下等审核。**

---

## Step 1:client.ts — SDK 封装层

**目标**:把官方 SDK 包成可测的薄封装,先打通连接/close。

**规格对应**:F2(连接)、F3(清理)、F6(close)、F11(timeout)

**新建** `extensions/mcp/client.ts`:
```
导出:
- createMcpClient({ name, version }): Client
- connectStdio(client, { command, args, env }, opts: { timeoutMs, signal }): Promise<void>
- listTools(client, opts?): Promise<Tool[]>
- callTool(client, name, args, opts?): Promise<CallToolResult>
- closeClient(client): Promise<void>  // 必须幂等
```
- 所有操作带 timeout(opts.timeoutMs,规格 F11:connect 30s/list 10s/call 60s)
- 所有操作接受 AbortSignal
- closeClient 幂等(已关闭再调不抛)

**测试** `tests/mcp-client.test.ts`(TDD 先写):
- ✅ connect 一个 stub server(node 子进程通过 stdio),listTools 返回数组
- ✅ callTool 拿到结果
- ✅ closeClient 后子进程退出(进程存活判断)
- ✅ closeClient 幂等(调两次不抛)
- ✅ connect timeout 触发(用一个永不响应的 stub)
- ✅ abort signal 能中断 connect

> stub server 怎么搭:在 tests/fixtures/ 下放一个最小 MCP server(node 脚本,用 StdioServerTransport 暴露 1-2 个工具),测试连接它。执行 agent 自己造这个 fixture。

**验证**:`npm test -- --test tests/mcp-client.test.ts` 全绿
**产出**:commit `feat(mcp): client.ts SDK封装+stub fixture`
**完成后停下等审核。**

---

## Step 2:registry.ts — 多 server 连接管理 + 清理

**目标**:管理多个 McpConnection,含强制清理(P0 安全底线,不可推迟)。

**规格对应**:F2、F3(重点)、F11

**新建** `extensions/mcp/registry.ts`:
```
class McpConnection {
  name, client, transport, tools[], status: "connected"|"failed"|"disconnected"
  static create(name, config): McpConnection
  callTool(toolName, args, opts): Promise<result>
  disconnect(): Promise<void>  // 幂等
}
class McpRegistry {
  connections: Map<name, McpConnection>
  connect(name, config, opts): Promise<void>  // 含 spawn policy 钩子(Step 5 接入,此处留接口)
  get(name): McpConnection | undefined
  disconnect(name): Promise<void>
  disconnectAll(): Promise<void>  // 遍历 + 幂等
}
```

**测试** `tests/mcp-registry.test.ts`:
- ✅ connect 成功,tools 缓存
- ✅ 多 server,get 能路由
- ✅ disconnect 后 client 关闭
- ✅ disconnectAll 所有连接关闭
- ✅ **重复 disconnect/disconnectAll 幂等**(规格 F3)
- ✅ 连接失败(server 崩)抛清晰错误,**资源回收**(transport close),不崩
- ✅ callTool 路由到正确 server

**验证**:`npm test -- --test tests/mcp-registry.test.ts` 全绿
**产出**:commit `feat(mcp): registry多server管理+强制清理`
**完成后停下等审核。**

---

## Step 3:config.ts — 三档 scope 合并 + 校验

**规格对应**:F7、F8、D3、D4

**新建** `extensions/mcp/config.ts`:
```
interface McpServerConfig { command: string; args?: string[]; env?: Record<string,string> }
interface McpConfig { servers: Map<name, { config, scope }> }

loadUserConfig(): McpConfig   // ~/.config/ugk/mcp.json (Win: %APPDATA%\ugk\mcp.json)
loadProjectConfig(cwd): McpConfig  // cwd/.mcp.json
loadLocalConfig(cwd): McpConfig    // cwd/.mcp.local.json
mergeConfigs(user, project, local): McpConfig  // 高覆盖低
validateServerConfig(name, cfg): { ok: boolean; error?: string }
interpolateEnv(env): { ok, value?, missingVar? }  // ${VAR},缺失返回 missingVar(不静默置空)
```

**测试** `tests/mcp-config.test.ts`:
- ✅ 合法 .mcp.json 解析
- ✅ 三档合并优先级(user < project < local)
- ✅ 同名 server 高 scope 完全覆盖
- ✅ command 缺失 → 失败 + 错误信息
- ✅ `${VAR}` 插值生效;**VAR 缺失返回 missingVar,不静默置空**(规格 F7)
- ✅ 无文件返回空
- ✅ 格式错误清晰报错
- ✅ Windows home 解析(`os.homedir` / APPDATA)

**验证**:`npm test -- --test tests/mcp-config.test.ts` 全绿
**产出**:commit `feat(mcp): config三档scope合并+env插值`
**完成后停下等审核。**

---

## Step 4:tools.ts — 工具注册 + 命名规范化 + schema 适配

**规格对应**:F4、F5、F9、F10(审核重点)

**新建** `extensions/mcp/tools.ts`:
```
normalizeServerName(raw): string  // provider-safe: 小写,非法字符→-,≤32
normalizeToolName(raw): string    // 同上,≤64
buildToolName(serverName, toolName): string  // "server__tool"
adaptSchema(mcpInputSchema): TSchema  // 优先 Type.Unsafe 原样透传(规格 F10)
registerMcpTool(pi, connection, mcpTool): void  // pi.registerTool,execute 内含 policy 占位
```

**测试** `tests/mcp-tools.test.ts`:
- ✅ 工具名 = `server__tool` 格式正确
- ✅ 命名规范化:大写→小写、特殊字符→`-`、超长截断(规格 F9)
- ✅ 重名冲突检测:规范化后重名的 tool 跳过 + 警告
- ✅ **schema 适配覆盖(审核重点 F10)**:
  - 基础:string/number/boolean/object/array
  - **enum**
  - **oneOf / anyOf**
  - **nullable**
  - **additionalProperties**
  - **$defs 引用**
- ✅ execute 调用路由到 connection.callTool
- ✅ 结果转 pi 格式 `{content, details}`

**验证**:`npm test -- --test tests/mcp-tools.test.ts` 全绿
**产出**:commit `feat(mcp): 工具注册+命名规范化+schema适配`
**完成后停下等审核。**

---

## Step 5:permissions.ts — spawn policy + per-tool policy

**目标**:P0 安全底线核心(审核第 1、6 条)。两层防护。

**规格对应**:F1(spawn policy)、F5(per-tool policy)

**新建** `extensions/mcp/permissions.ts`:
```
type McpPermissionMode = "off" | "ask" | "on"
interface McpPermissionState { mode; sessionAllowedServers: Set<name> }

// 连接前(规格 F1)— 危险点在 spawn,不是 tool call
checkSpawnPolicy(state, { serverName, scope, command }, hasUI): {
  allowed: boolean; requiresConfirmation: boolean; reason?: string
}
// 规则:
//   user scope → allowed, no confirm
//   project/local scope → ask(首次);非交互模式 fail-closed(只允许 user)

// 调用时(规格 F5)— execute 内,对齐 chrome-cdp
checkToolPolicy(state, { serverName, toolName, reason }, hasUI): {
  allowed: boolean; requiresConfirmation: boolean; reason?: string
}
// 规则:off→block; on→allow; ask+未授权→confirm; allow-session 后不再问

grantSessionAllow(state, serverName): void
setMode(state, mode): void
```

**测试** `tests/mcp-permissions.test.ts`:
- ✅ spawn policy:user scope 直接放行
- ✅ spawn policy:project scope 默认 ask
- ✅ spawn policy:local scope 默认 ask
- ✅ spawn policy:**非交互(hasUI=false)project/local → fail-closed**(规格 F1,审核重点)
- ✅ spawn policy:非交互 user scope 放行
- ✅ tool policy:off 全 block
- ✅ tool policy:on 全放行
- ✅ tool policy:ask 未授权需 confirm
- ✅ tool policy:grantSessionAllow 后不再问(对齐 chrome-cdp)
- ✅ setMode 生效

**验证**:`npm test -- --test tests/mcp-permissions.test.ts` 全绿
**产出**:commit `feat(mcp): 双层权限spawn+per-tool policy`
**完成后停下等审核。**

---

## Step 6:commands.ts — /mcp 命令 + reload(stale 处理)

**规格对应**:F6(reload 约束)、F13

**新建** `extensions/mcp/commands.ts` + `formatter.ts`:
```
// commands: /mcp status | on | off | ask | reload | enable <server> | disable <server>
// reload 实现要点(规格 F6,pi 无 unregisterTool):
//   1. disconnectAll
//   2. 重连
//   3. 消失的 server 的工具:用 setActiveTools 排除(无法删 map,但下线 active)
//   4. stale 工具被调时返回"server disconnected"错误
```

**测试** `tests/mcp-commands.test.ts`:
- ✅ status 输出格式(连接数/工具数/权限模式/失败 server 标红)
- ✅ reload 后工具重新注册
- ✅ **reload 后 stale 工具从 active set 下线**(规格 F6)
- ✅ stale 工具被调返回断开错误
- ✅ enable/disable 控制 active tools
- ✅ mode 切换生效

**验证**:`npm test -- --test tests/mcp-commands.test.ts` 全绿
**产出**:commit `feat(mcp): /mcp命令+reload stale处理`
**完成后停下等审核。**

---

## Step 7:index.ts — 串起来 + session 钩子 + instructions 注入

**规格对应**:F2(session_start)、F3(session_shutdown)、F12(instructions)、F14(doctor)

**新建** `extensions/mcp/index.ts`:
```
registerMcp(pi):
  - pi.on("session_start"): loadConfig → spawn policy → connect → registerTools
  - pi.on("session_shutdown"): disconnectAll + 进程兜底
  - pi.on("before_agent_start"): 追加 server instructions 到 systemPrompt(规格 F12)
  - 注册 /mcp 命令
```
**改** `extensions/index.ts`:import + 调用 `registerMcp(pi)`

**测试** `tests/mcp-extension.test.ts`(端到端):
- ✅ session_start 启动连接 + 注册
- ✅ 无配置零副作用
- ✅ session_shutdown 全部 disconnect
- ✅ **session_shutdown 后无僵尸进程**(tasklist 验证,规格 N4)
- ✅ instructions 注入 systemPrompt
- ✅ doctor MCP 项:只读校验,不 spawn(规格 F14)
- ✅ 端到端:stub server → 工具注册 → 调用 → 结果

**验证**:
- `npm test -- --test tests/mcp-extension.test.ts` 全绿
- **手动 smoke**:项目根放 `.mcp.json`(filesystem),`ugk` 启动,首次弹 spawn 确认,模型能调 `filesystem__list_files`
- **手动验证**:会话退出后 `tasklist | findstr node` 无残留 mcp 子进程

**产出**:commit `feat(mcp): 集成入口+session钩子+instructions`
**完成后停下等审核。**

---

## Step 8:全量验证 + 文档

**目标**:全量回归,补文档,准备合并。

**操作**
1. 全量 `npm test`(≥474 + 所有 mcp 测试全绿)
2. `npm pack --dry-run`:确认 docs/ 不在包、新增 extensions/mcp + skills 合理
3. 更新 `README.md` + `AGENTS.md`:MCP 能力段
4. 新建 `skills/mcp-guide/SKILL.md`:使用指南(配置示例、/mcp 命令、scope 说明)
5. 更新 `extensions/index.ts` 的 `/ugk` status 表(加 mcp)
6. 手动端到端:filesystem + stub 双 server

**验证**(规格 §六验收标准全部):
- [ ] F1-F14 全实现 + 测试
- [ ] spawn policy 生效(project 首次确认,非交互 fail-closed)
- [ ] tasklist 无僵尸
- [ ] npm test 不回归
- [ ] npm pack 通过,docs/ 不在包
- [ ] .gitignore 含 .mcp.local.json

**产出**:commit `docs(mcp): 使用指南+README/AGENTS更新`
**完成后停下等审核。**

---

## 审核检查清单(我会在每个 Step 用这些核对)

| 检查项 | 每个 Step |
|---|---|
| TDD:测试先写且覆盖规格对应 F 条目 | ✅ |
| `npm test` 该 step 测试全绿 | ✅ |
| 没扩大范围(没顺手做 resources/sampling) | ✅ |
| commit 信息符合 `feat(mcp):` 规范 | ✅ |
| 没碰未跟踪个人材料 | ✅ |
| 危险操作前确认(spawn/删除) | ✅ |
| 报告真实(测试失败说失败,不粉饰) | ✅ |

## 给执行 agent 的硬约束

1. **每个 Step 完成后停下**,在回复给出:`npm test` 输出 + 本 step 产出文件 + 对应 F 条目覆盖情况。等我 PASS 再进下一步。
2. **遇到规格没覆盖的情况,不要自行发挥**,停下来问我。
3. **测试失败就报失败**,不要为了过测试改测试预期去迎合实现。
4. **spawn 任何子进程前**(测试里的 stub server 除外),确认是否需要 spawn policy。
5. **Step 0 必须先验证 `npm pack` 不再含 docs/**,这是审核反馈揪出的真实问题。

## 风险节点(执行时我重点盯)

1. **Step 2 清理幂等性**:Windows 僵尸进程是头号风险,重复 disconnect/disconnectAll 必须幂等。
2. **Step 4 schema 适配**:审核重点,必须覆盖 enum/oneOf/$defs,优先 `Type.Unsafe`。
3. **Step 5 spawn policy 非交互 fail-closed**:这是安全底线,测试必须明确覆盖 hasUI=false 场景。
4. **Step 6 reload stale 工具**:pi 无 unregisterTool 是硬约束,不能假装能"移除"。
5. **Step 7 session_shutdown 进程清理**:tasklist 实测,不是嘴上说。
