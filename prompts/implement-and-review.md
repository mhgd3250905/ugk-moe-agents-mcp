---
description: 实现+审查 — worker 先实现,reviewer 审查,worker 按反馈修订
---
用 subagent 工具的 chain 参数执行此流程:

1. 先用 "worker" agent 实现:$@
2. 然后用 "reviewer" agent 审查上一步的改动({previous})
3. 最后用 "worker" agent 按 reviewer 的反馈修订({previous})

作为 chain 执行,通过 {previous} 传递。
