# UGK 扩展开发契约

> 本文档记录 UGK 扩展层(`extensions/` + `bin/`)开发时必须遵守的硬规则,来自真实踩坑。
> 写新扩展、改现有扩展、或出修改报告前必读。

---

## 0. 为什么有这份文档

UGK 基于 pi 定制。pi 给扩展层提供能力,但有些能力是**隐式的**(运行时魔法,类型层面看不到)。扩展作者(包括 AI agent 出的修改报告)经常因为不知道这些隐式契约,写出"单测通过、真实环境爆雷"的代码。

本文档把这些隐式契约显式化,作为扩展开发的硬约束。

---

## 1. 覆盖 pi 原生工具的契约(最高危)

pi 的内置工具(read/bash/edit/write/grep/find/ls)在原生注册时,会从内部 `settingsManager` 注入**用户看不见的隐式配置**。

**若用同名 `registerTool` 覆盖某个内置工具,必须自己补回这些注入,否则功能静默失效或行为不一致。**

| 工具 | pi 原生注入 | 覆盖时必须补回 |
|---|---|---|
| bash | `shellPath` | ✅ 必须 |
| bash | `commandPrefix` | ✅ 应补 |
| read | `autoResizeImages` | ✅ 覆盖 read 时必须补 |
| edit/write/grep/find/ls | 无 | 正常委托即可 |

### 硬规则
- 覆盖 bash 前,必读 `resolveShellPath` + `resolveShellCommandPrefix` 并传给 `createBashTool(cwd, { shellPath, commandPrefix })`。
- 覆盖 read 前,必读 `autoResizeImages` 传给 `createReadTool(cwd, { autoResizeImages })`。
- **不要直接抄 pi 官方示例的 `createBashTool(process.cwd())`**——那是演示用的。

---

## 2. 读 pi 管理的 JSON 文件的契约(中危,易复发)

Windows 上 PowerShell 的 `Set-Content` / `Out-File` 默认写 UTF-8 BOM,而 Node 的 `JSON.parse` 遇 BOM 会抛 `SyntaxError`。

### pi 管理的 JSON 文件清单

| 文件 | 读取点 |
|---|---|
| `settings.json` | ui-brand / doctor-checks / chrome-cdp-config / bin-ugk-startup-settings |
| `auth.json` | deepseek-status |
| `mcp.json` / `.mcp.json` / `.mcp.local.json` | mcp/config |
| taskbook 的 `spec.json` / `contract.json` | task/task-book |

### 硬规则
- 读上述任何文件,**禁止裸 `JSON.parse`**。
- 必须先剥离 BOM: `JSON.parse(stripBom(content))`。
- 通用 BOM-safe 解析用 `readJsonBomSafe(path)` 或 `stripBom(content)`。
- 读 `settings.json` 用专用 `readSettingsJson()`。

---

## 3. `ExtensionContext.sessionManager` 的能力边界

`ctx.sessionManager` 是 `ReadonlySessionManager`,只暴露少数 session 读取方法。

### 硬规则
- **只能调 Pick 列表里的方法**。
- 要拿配置(shellPath/theme/quietStartup 等):读 settings.json。
- 要拿 session 数据(消息树/分支/条目):用 `getEntries` / `getBranch` / `getTree`。

---

## 4. 静默降级的方向必须安全

扩展里很多 `try/catch` 会吞错返回默认值。**降级方向决定隐患严重度**:

| 降级方向 | 安全性 |
|---|---|
| fail-closed | ✅ 安全 |
| fail-open | ⚠️ 看场景 |

### 硬规则
- 涉及安全/权限的降级,必须 fail-closed。
- 涉及配置读取的降级,默认值要符合"最不可能造成损害"原则。
- 吞错时,至少在能 surface 的地方留下线索。

---

## 5. 出修改报告时的契约

报告里的代码建议会被人照抄,报告里的盲区会变成代码里的 bug。

### 硬规则
- 若报告涉及覆盖 pi 原生工具:必须显式列出隐式注入清单。
- 若报告涉及读 pi 管理的 JSON 文件:必须标注 BOM-safe。
- 若不确定某个 pi API 是否对扩展可用:先查 `ExtensionAPI` 类型定义。
- 报告里抄官方示例代码时,必须审视示例的简化假设是否适用于 UGK 真实环境。

---

## 6. 改动触及核心时的检查清单

- [ ] 改了工具注册?核对是否覆盖了 pi 内置工具
- [ ] 改了文件读取?核对是否读 pi 管理的 JSON
- [ ] 用了 `ctx.sessionManager`?核对方法在 Pick 列表内
- [ ] 加了 `try/catch`?核对降级方向是否安全
- [ ] 改了 task 核心函数签名/状态机?同步 `docs/design/subtask-extension-spec.md`
- [ ] 加了带确认的新工具?用 `suppressConfirmation()` 接入 autopilot(见 §7)
- [ ] 改了用户可见 slash 命令或菜单?同步 `README.md` 和 `AGENTS.md`

---

## 7. autopilot 统一工具确认总开关

`/ugk-autopilot` 无参打开中文菜单(查看状态 / 开启 / 关闭 / 退出),也支持 `/ugk-autopilot on|off|status`。它是所有"工具级确认"的总开关。内核在 `extensions/shared/autopilot.ts`,全局单例,状态只在会话内存(关 ugk 即忘)。

**管什么**:普通工具确认(CDP / MCP / 未来加的有副作用的工具)。autopilot on 时,这些工具的 `requiresConfirmation` 被短路为"直接放行"。

**不管什么**:
- **危险命令门(rm -rf / sudo / chmod 777)**:不接 autopilot,永远走人确认。这是用户硬要求。
- **LLM 自发的 questionnaire(③类)**:靠 `before_agent_start` 注入 `AUTOPILOT_PROMPT_SNIPPET` 治,不是工具层能硬拦的。

### 硬规则:新工具如何接入 autopilot

新工具的 policy 函数末尾,把"需要确认"的判定包一层 `suppressConfirmation()`:

```ts
import { suppressConfirmation } from "../shared/autopilot.ts";
// ...
return {
	allowed: true,
	requiresConfirmation: suppressConfirmation(/* 原本的判定 */ state.mode === "ask" && !sessionAllowed),
};
```

一行接入,**禁止**复制 ask/on/off 三态逻辑——autopilot 是统一的,不要每家自搞一套。测试用 `installAutopilotState(createAutopilotState(...))` 隔离单例。

**绝对不能接入 autopilot 的**:删除级、花钱级、不可逆外部副作用的动作。这些永远归人。

---

## 附:已发生的同类事故

| 时间 | 事故 | 根因类别 | 状态 |
|---|---|---|---|
| 2026-06 | bash 走 WSL,curl 全 exit 1 | 覆盖 bash 丢 shellPath | ✅ 已修(`3d8d848`) |
| 2026-06 | settings.json BOM → 外部 skill 全加载 + 标题显示 | 裸 JSON.parse | ✅ 已修(`3d8d848`) |
| 2026-06 | auth.json/mcp.json/taskbook.json BOM | 同类坑未清剿 | ✅ 已修(本次 hardening) |
| 2026-06 | bash 丢 commandPrefix | 潜伏不一致 | ✅ 已修(本次 hardening) |

新增事故请继续追加到此表。
