# MCP 集成收尾任务单(P1-修复后,合并前最后一批)

> 角色: 执行 agent 实现以下任务,ugk-dev 审核
> 基线: feat/mcp-client 分支当前工作区(P1 已改未提交)
> 原则: **全部做完一次性提交**,不留尾巴。每项带测试。

本任务单是 PR #10 合并前的最后收尾。做完后 PR 可直接合并,无遗留 follow-up。

---

## 任务总览

| # | 任务 | 性质 | 估时 |
|---|---|---|---|
| T1 | `_process` 私有字段加防御性日志 + 单测 | 隐患防御 | 0.5h |
| T2 | 真实 SIGINT 退出时序端到端测试 | 验证缺口(审核人未跑通) | 1h |
| T3 | `/mcp enable` 对 stale server 给清晰提示 | P2-1 | 0.5h |
| T4 | `install` scope 信任语义文档化(spec + SKILL) | P2-2 | 0.5h |
| T5 | `hasInteractiveUi` 判定统一 + reload 路径修正 | P2-3 | 1h |
| T6 | 全量回归 + npm pack + 自查 | 验证 | 0.5h |

全部做完,**一次性 commit**:`fix(mcp): 收尾隐患防御+P2补全+退出时序测试`。

---

## T1:`_process` 私有字段防御性日志

**背景**:`client.ts:94` 访问 SDK 内部私有字段 `transport._process`。SDK 升级若改字段名,kill 会静默失效。spec D1 锁定了 1.29.0,但加防御能及早发现失效。

**改动** `extensions/mcp/client.ts`:
- `killClientProcess` 中,当 `transport` 存在但 `_process` 取不到时,**不要静默 return**
- 改为:`process.stderr.write("ugk-mcp: warning: StdioClientTransport._process unavailable, child may not be killed (SDK version drift?)\n")` 后再 return
- 同时把 `_process` 的类型声明补全(避免 TS 报隐式 any):

```typescript
type StdioClientTransportWithProcess = StdioClientTransport & {
  _process?: {
    stdin: { destroy: () => void } | null;
    stdout: { destroy: () => void } | null;
    stderr: { destroy: () => void } | null;
    exitCode: number | null;
    kill: (signal?: string) => boolean;
  } | null;
};
```
(这个类型声明 client.ts 里**可能已存在**,如果已有就只改逻辑不改类型。先读再改。)

**测试** `tests/mcp-client.test.ts` 补一例:
- ✅ `_process` 为 undefined 时,killClientProcess 不抛、写 stderr 警告(可用 spy 捕获 process.stderr.write,或重定向 stderr 验证包含 "warning")

**验证**:`node --test tests/mcp-client.test.ts` 全绿

---

## T2:真实 SIGINT 退出时序端到端测试

**背景**:审核人尝试自造此测试但脚本没跑通(环境问题)。P1-1 的核心价值是"主进程被信号杀掉时,mcp 子进程被同步清理",目前只有单元测试,缺端到端。

**要求**:写一个正式的 `tests/mcp-exit-timing.test.ts`,用项目现有 fixture(`tests/fixtures/mcp-stub-server.mjs`)。

**实现思路**(避免审核人踩的坑):
- **不要**用 `node -e` + ES module import(审核人在这栽了)
- **用 spawn 一个独立的 runner 脚本文件**:在测试里写一个临时 `.mjs` 文件到 os.tmpdir(),内容是动态 import registry + 连接 stub + `setInterval` 保活
- 或者更稳:**直接测 `killMcpCleanupRegistryProcesses` + `killAllProcesses` 的组合行为**,配合进程树验证
- 关键断言:触发清理后,`tasklist`(Win)/ `pgrep`(unix)查不到 `mcp-stub-server.mjs` 进程

**最小可行实现**(推荐,跨平台):

```typescript
// tests/mcp-exit-timing.test.ts
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert";

const stubPath = fileURLToPath(new URL("./fixtures/mcp-stub-server.mjs", import.meta.url));
const registryPath = fileURLToPath(new URL("../extensions/mcp/registry.ts", import.meta.url));
const indexPath = fileURLToPath(new URL("../extensions/mcp/index.ts", import.meta.url));

function findStubProcesses(): number {
  // 跨平台:用 wmic(Win)或 pgrep(unix)
  if (process.platform === "win32") {
    const r = spawnSync("wmic", ["process","where","name='node.exe'","get","commandline","/format:csv"], { encoding: "utf8" });
    return r.stdout.split("\n").filter((l) => l.includes("mcp-stub-server.mjs")).length;
  }
  const r = spawnSync("pgrep", ["-f", "mcp-stub-server.mjs"], { encoding: "utf8" });
  return r.stdout.trim().split("\n").filter(Boolean).length;
}

test("SIGINT to host process synchronously-kills mcp child processes", { timeout: 30000 }, async () => {
  // 写一个临时 runner(避免 -e 的 module 问题)
  const runner = path.join(os.tmpdir(), `ugk-exit-test-${Date.now()}.mjs`);
  fs.writeFileSync(runner, `
    import { registerMcp } from ${JSON.stringify("file:///" + indexPath.replace(/\\\\/g,"/"))};
    import { McpRegistry } from ${JSON.stringify("file:///" + registryPath.replace(/\\\\/g,"/"))};
    const pi = { on(){}, registerTool(){}, registerCommand(){}, getActiveTools(){return[]}, setActiveTools(){} };
    const state = registerMcp(pi, { registry: new McpRegistry() });
    await state.registry.connect("stub", { command: process.execPath, args: [${JSON.stringify(stubPath)}] });
    process.stderr.write("READY\\n");
    setInterval(() => {}, 1000);
  `);

  try {
    const child = spawn(process.execPath, [runner], { stdio: ["pipe","pipe","pipe"] });
    const ready = new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("READY timeout")), 15000);
      child.stderr.on("data", (d) => { if (d.toString().includes("READY")) { clearTimeout(t); resolve(); } });
    });
    await ready;

    assert.ok(findStubProcesses() >= 1, "stub process should exist before signal");

    child.kill("SIGINT");
    await new Promise<void>((resolve) => child.on("exit", () => resolve()));

    // 给 OS 一点回收时间
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(findStubProcesses(), 0, "stub process should be killed after host SIGINT");
  } finally {
    fs.rmSync(runner, { force: true });
  }
});
```

**注意**:
- 上面是参考实现,可能需微调路径转义(Windows 反斜杠)。跑通为准。
- 如果跨平台 `wmic` 在新版 Windows 不可用(已弃用),改用 `Get-CimInstance`(PowerShell)或 `tasklist /v` + 解析 commandline。**先验证 findStubProcesses 在本机能工作**。
- 跑通后加入 `package.json` test 脚本(`tests/mcp-exit-timing.test.ts`)。

**验证**:`node --test tests/mcp-exit-timing.test.ts` 通过(真实验证 SIGINT 后无残留)

---

## T3:`/mcp enable` 对 stale server 给清晰提示

**背景**:`commands.ts:102` enableServer 只查 `state.serverTools`,stale server 在 `staleServerTools`,enable 对 stale server 返回 "not found" 会让用户困惑。

**改动** `extensions/mcp/commands.ts` 的 `enableServer`:
```typescript
function enableServer(pi: ExtensionAPI, state: McpCommandState, serverName?: string): string {
  if (!serverName) {
    return "Missing server. Usage: /mcp enable <server>";
  }

  // 新增:stale server 提示
  if (state.staleServerTools?.has(serverName)) {
    return `MCP server "${serverName}" is stale (disconnected during reload). ` +
      `Run /mcp reload to reconnect, or fix its config first.`;
  }

  const tools = state.serverTools.get(serverName);
  if (!tools) {
    return `MCP server "${serverName}" not found.`;
  }
  // ... 原逻辑不变
}
```

**测试** `tests/mcp-commands.test.ts` 补一例:
- ✅ 对 stale server 调 enable,返回包含 "stale" 的提示(不报 not found)
- ✅ 真正 not found 的 server 仍返回 "not found"

**验证**:`node --test tests/mcp-commands.test.ts` 全绿

---

## T4:`install` scope 信任语义文档化

**背景**:执行 agent 新增了 `install` scope(UGK 安装目录级配置),在 `permissions.ts:56` 和 user scope 同级直接放行。spec F1 只写了 user/project/local 三档。这是合理扩展但**超出了规格**,需补文档避免歧义。

**改动**(纯文档,无代码改动):

1. `docs/design/mcp-integration-spec.md` §3.1 F1 的规则表,新增 install scope 行:
   - 在 "user scope" 行下方加:"install scope(UGK 安装目录 `mcp.json`,项目维护者控制)— 可直接连接,与 user 同级可信"

2. `skills/mcp-guide/SKILL.md` 配置 scope 说明章节,补 install scope:
   - 位置:`~/.npm-global/lib/node_modules/ugk-agent/mcp.json`(或对应全局安装路径)
   - 用途:UGK 发版时随包带的默认 MCP server 配置
   - 信任级:与 user scope 同,默认放行(项目维护者背书)

3. `README.md` MCP 章节(如果有 scope 说明)同步补一行

**验证**:文档无矛盾,scope 列表完整(user/install/project/local 四档清晰)

---

## T5:`hasInteractiveUi` 判定统一 + reload 路径修正

**背景**:`index.ts:336` `hasInteractiveUi` 要求 `hasUI !== false && (confirm || select)`。但 reload 命令路径(`commands.ts` reloadMcp → `deps.reload(context)`)的 context 可能没传 hasUI,导致 project scope server 在 reload 时被 spawn policy fail-closed。执行 agent 在测试 `treats command contexts with confirm UI as interactive even without hasUI` 里加了 workaround,但 workaround 脆弱。

**改动** `extensions/mcp/index.ts` 的 `hasInteractiveUi`:

当前逻辑问题:`hasUI !== false` 严格——若 hasUI 是 undefined(命令路径常见),`undefined !== false` 为 true,但需要同时有 confirm/select 才算交互。问题在于命令路径可能只传了 confirm 没明确 hasUI。

**修正方案**(推荐,消除 workaround):
- `hasInteractiveUi` 放宽:**只要传了 confirm 或 select 函数,就视为交互**(因为只有真实 TUI 才会注入这些函数;测试/非交互场景不会注入)
- 去掉对 `hasUI !== false` 的硬性要求(或保留但默认 undefined 当 true)

```typescript
function hasInteractiveUi(ctx: McpRuntimeContext | undefined): boolean {
  if (!ctx) return false;
  // 只要注入了 confirm/select,就视为交互式(mcp-extension 测试里的特殊处理可移除)
  return Boolean(ctx.ui?.confirm || ctx.ui?.select);
}
```

**改动** `extensions/mcp/index.ts`:
- 改完检查 `confirmSpawn` 和 `resolveToolPolicy` 是否还依赖 hasUI 的原语义,同步调整
- 如果 mcp-extension.test.ts 里有针对 "command contexts with confirm UI" 的特殊处理代码,**可以移除**(因为判定改了不再需要)。但**移除前确认对应测试仍通过**。

**测试** `tests/mcp-extension.test.ts` 补/改:
- ✅ 命令路径(无 hasUI 但有 confirm)reload project scope server,spawn policy 正常询问(不再 fail-closed)
- ✅ 完全无 UI(无 confirm 无 select)仍 fail-closed
- 确保原有测试不回归

**验证**:`node --test tests/mcp-extension.test.ts` 全绿

**风险提示**:这个改动触及 spawn policy 判定核心,**改完必须重跑 mcp-permissions + mcp-extension + mcp-commands 全部测试**。如果有测试因判定放宽而失败,不要为了过测试改测试预期迎合实现——先分析是测试对还是实现对。

---

## T6:全量回归 + npm pack + 自查(收尾)

全部 T1-T5 做完后:

1. **全量 mcp 测试**:`node --test tests/mcp-*.test.ts`(含新增 mcp-exit-timing)全绿
2. **全量回归**:`npm test` 不破坏现有
3. **npm pack 验证**:
   - `npm pack --dry-run` → version 1.2.0
   - docs/ 不在包内
   - 新增 tests/mcp-exit-timing.test.ts 在包内(测试文件应打包?确认项目惯例——看现有 tests/ 是否进包)
4. **自查清单**:
   - [ ] 没有扩大范围(只做 T1-T5,没顺手加 resources/sampling)
   - [ ] 没碰未跟踪个人材料(website/、wangnuanwei-*.md 等)
   - [ ] commit 信息符合规范
   - [ ] T2 的端到端测试在本地真实跑通过(不是猜的)
5. **提交**:`git add` 相关文件 + 一次 commit
   - commit msg: `fix(mcp): 收尾隐患防御+P2补全+退出时序测试`
   - 不要提交未跟踪的个人材料

---

## 执行约束

1. **T1-T5 可以并行思考但必须 T6 一次性验证**,因为 T5 改 spawn policy 可能影响其他
2. **T2 是难点**(端到端测试),如果实在跑不通跨平台进程检测,**至少保证 Windows 跑通**(项目主平台),unix 路径标记 skip 并留 TODO
3. **T4 纯文档,先做**(不阻塞其他),T1/T3 独立,T5 最后做(动核心逻辑风险最高)
4. 做完回复给:每项的测试结果 + npm test 汇总 + npm pack version
5. **不要 push,不要发 review comment**,做完等审核

---

## 验收标准(我审核时核对)

- [ ] T1:`_process` 缺失有 stderr 警告 + 测试覆盖
- [ ] T2:真实 SIGINT 退出后无 mcp-stub-server.mjs 残留(端到端,非单元)
- [ ] T3:enable 对 stale server 返回 "stale" 提示而非 "not found"
- [ ] T4:spec + SKILL + README 四档 scope 完整文档化
- [ ] T5:reload 路径 project scope 不再 fail-closed(无 hasUI 有 confirm 场景)
- [ ] T6:npm test 全绿,npm pack 1.2.0,无范围扩大
- [ ] 一次 commit,无尾巴
