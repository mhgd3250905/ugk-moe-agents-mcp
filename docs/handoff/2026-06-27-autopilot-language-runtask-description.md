# Autopilot / Language / run_task description Handoff

> 日期：2026-06-27
> 测试基线：`npm test` → 564/564 pass（原 552 + 新增 12）
> 关联提交：见本次 git log

## 本次交付了什么

三项独立的运行时引导增强，都围绕"减少 agent 打断用户"这个主题。

### 1. `/ugk-autopilot` —— 工具确认总开关

**问题**：CDP / MCP / run_task 受保护工具三类工具级确认各自独立，用户想"放飞"得逐个 `/mcp on` `/cdp on`，且每加一个有副作用的新工具就多一个确认点。

**方案**：统一内核 `extensions/shared/autopilot.ts`，全局单例 + 会话内存态。所有工具级确认的 policy 函数末尾包一层 `suppressConfirmation()`。autopilot ON 时短路为"直接放行"。

**三条接入路径**（同一规则，一行接入）：

| 路径 | 文件 | 接入点 |
|---|---|---|
| CDP 工具确认 | `extensions/chrome-cdp/config.ts` | `checkChromeCdpPolicy` |
| MCP 工具确认 | `extensions/mcp/permissions.ts` | `checkMcpToolPolicy` |
| run_task 受保护工具授权 | `extensions/task/task.ts` | `resolveTaskWorkerEnv` |

**不管什么**：
- **危险命令门**（`rm -rf` / `sudo` / `chmod 777`）不接 autopilot，永远走人确认 —— 用户硬要求。
- **LLM 自发问卷**（③类，如"39 个视频要不要全下"）靠 `before_agent_start` 注入 `AUTOPILOT_PROMPT_SNIPPET` 治，是 prompt 层不是铁律。

**用法**：
```
/ugk-autopilot on|off|status
```

### 2. `/language` —— 用户语言偏好

**问题**：agent 默认语言无法配置，用户想换语言（英文/日文）只能每次口头说。

**方案**：`extensions/shared/language.ts`，持久化在 settings.json 的 `language` 字段（BOM-safe，跨会话）。自由字符串，不做枚举校验（与 autopilot 一致）。AGENTS.md 默认"优先中文"，`/language` 覆盖。`before_agent_start` 注入语言指令片段。

**与 autopilot 的区别**：autopilot 是会话内存（临时放飞），language 是持久偏好（用户偏好该跨会话）—— 刻意不同。

**用法**：
```
/language English     # 设(任意字符串,跨会话记住)
/language 日本語       # 自由语言名都行
/language status      # 看当前
/language clear       # 清除,回默认中文
```

### 3. `run_task` 工具 description 重写

**问题**：`docs/design/2026-06-26-task-atomic-unit-and-parallel-primitive.md` 早就诊断过 —— agent 反复绕开 `run_task({tasks:[...]})`，改用 subagent 包 run_task（必然授权失败）。根因是引导不对称：run_task 的 parallel 模式藏在参数注释第二行，subagent 的写在 description 第一行。

**方案**：把 run_task description 的 parallel 模式提到首行（与 subagent 同等可见），并加显式反例 e.g.（subagent 是错路）。落地设计文档早就立下、但一直没执行的"发现性铁律"。

## 验证结论（已实测）

- ✅ autopilot ON：CDP 工具确认不弹（用户实测确认）
- ✅ autopilot ON：run_task 受保护工具授权不弹（用户实测确认 + 单测）
- ✅ autopilot 不影响危险命令门（单测覆盖 off 路径 + 边界单测）
- ✅ language 跨会话持久化（单测覆盖往返/保留无关键/清除/trim/非字符串）

## 测试新增

| 文件 | 新增数 |
|---|---|
| `tests/autopilot.test.ts` | 7 |
| `tests/language.test.ts` | 11 |
| `tests/chrome-cdp-config.test.ts` | 3（autopilot CDP 覆盖） |
| `tests/mcp-permissions.test.ts` | 2（autopilot MCP 覆盖） |
| `tests/subtask-tool.test.ts` | 1（autopilot ON 跳过 protected-tool 确认） |

## 设计取舍记录

- **没做"占位符 + 模板"语言系统**：AGENTS.md 是 pi 静态全文加载，占位符 pi 不认、要替换得改 pi 内部。直接写死默认 + 动态覆盖，两者正交。
- **没做语言枚举/i18n 框架**：自由字符串零维护，与 autopilot 一致。→ add when 需标准化语言代码（对接 TTS/语音）时再加。
- **没做"托管 agent"模式**：用进程模拟布尔值，YAGNI 反面，永不建议。
- **没把 questionnaire 工具硬接 autopilot**：用户本轮选了 prompt 治理（选项一）。若实测发现 ③类 prompt 治不住，回头接（见下）。

## 已知残留 / 后续

- **③类（LLM 自发问卷）非铁律**：autopilot 靠 prompt 指令治，模型偶尔仍会问。若需硬拦，把 questionnaire 工具接进统一 policy 层（让它可被 autopilot 短路），改动稍大，但改变 agent 协作语义。
- **统一 policy 层只抽了一半**：autopilot 是全局开关，但 CDP/MCP/run_task 仍各自维护 ask/on/off 三态 state（autopilot 短路它们）。若未来工具确认涨到 5+ 个，可再抽 `ToolPolicyRegistry`，让每个工具注册 gate、autopilot 统一覆盖。当前 3 个路径够用，YAGNI。

## 改动文件清单

新增：
- `extensions/shared/autopilot.ts`
- `extensions/shared/language.ts`
- `tests/autopilot.test.ts`
- `tests/language.test.ts`

修改：
- `AGENTS.md`（默认中文 + 两个命令清单项）
- `docs/extension-contracts.md`（§7 autopilot 接入契约 + 检查清单项）
- `extensions/index.ts`（两个命令 + 合并的 before_agent_start 钩子 + 状态表）
- `extensions/chrome-cdp/config.ts`（一行接入 autopilot）
- `extensions/mcp/permissions.ts`（一行接入 autopilot）
- `extensions/task/task.ts`（autopilot 接入 run_task + run_task description 重写）
- `tests/chrome-cdp-config.test.ts` / `tests/mcp-permissions.test.ts` / `tests/subtask-tool.test.ts`（autopilot 覆盖测试）
