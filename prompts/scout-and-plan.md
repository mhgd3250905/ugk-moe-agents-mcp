---
description: 侦察+计划 — scout 收集上下文,planner 出方案,不实际写代码
---
用 subagent 工具的 chain 参数执行此流程:

1. 先用 "scout" agent 调查以下内容:$@
2. 然后用 "planner" agent 基于上一步的上下文({previous})制定方案

作为 chain 执行,通过 {previous} 传递。只到计划为止,不进入实现。
