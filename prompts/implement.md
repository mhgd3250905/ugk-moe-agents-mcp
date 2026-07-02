---
description: 完整实现流程 — scout 收集上下文,planner 制定计划,worker 实现
---
用 subagent 工具的 chain 参数执行此流程:

1. 先用 "scout" agent 找到所有与以下相关的代码:$@
2. 然后用 "planner" agent 基于上一步的上下文制定实现计划("$@"),用 {previous} 占位符接收上文
3. 最后用 "worker" agent 按上一步的计划实现({previous} 占位符)

作为 chain 执行,通过 {previous} 在步骤间传递输出。
