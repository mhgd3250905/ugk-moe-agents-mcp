---
name: ugk-guide
description: UGK project context guide. Use for ugk-core repository conventions, current architecture docs, feature ownership, and where to find authoritative project facts; read AGENTS.md first.
---

# ugk-core 指南

## 事实源顺序

1. 先读仓库根目录 `AGENTS.md`。它是当前会话的最高优先级项目约定。
2. 再按任务读取对应文档，不要用历史 handoff 覆盖当前事实。

## 常用入口

| 场景 | 读取 |
|---|---|
| Judge 实时监督模式 | `docs/judge.md` |
| `/task` 固定任务委托 | `docs/design/task-extension-spec.md` |
| `run_task` 编排 | `docs/design/subtask-extension-spec.md` |
| MCP 配置/权限/排障 | `skills/mcp-guide/SKILL.md` |
| Chrome CDP 本地浏览器控制 | `skills/chrome-cdp-guide/SKILL.md` |

## 工作原则

- 优先复用 pi/UGK 已有 extension、skill、slash 命令。
- 只改与当前请求直接相关的文件。
- 改 task/Judge 核心契约时，同步对应设计文档。
