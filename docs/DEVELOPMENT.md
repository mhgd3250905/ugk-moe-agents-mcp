# 开发约定(ugk-moe-agents-mcp)

> 本文档放**开发侧**约定(怎么改代码、怎么测试、怎么验证)。运行时上下文见 [AGENTS.md](../AGENTS.md)——那是注入给 agent 的,只含运行时要点,开发规则不进 AGENTS.md。

## 测试

```bash
npm test                                  # 全量(当前 245 pass / 0 fail)
node --test tests/gateway-verify.test.ts  # 单文件
node --test tests/gateway-*.test.ts       # 只跑网关相关
```

**基线不能掉。** 改完代码 `npm test` 必须 ≥ 245 pass / 0 fail。删了功能就连同测试一起删;加了功能就补测试。

## 验证(改完代码必做)

1. `npm test` 全绿
2. 端到端 echo 链路:起网关 → run_expert(echo) → 轮询 check_job → get_result,期望 status:"pass"(模式见 [HANDOFF.md](./HANDOFF.md) §4)
3. 权限场景不破:run_expert 缺权限返回 missing_requirements;doctor apply consent 被拒

## 改动红线

详见 [AGENTS.md](../AGENTS.md) 设计红线段 + [DESIGN.md](../DESIGN.md)。核心:
- 不加过程脚手架(四阶段/dispatcher/checker/白名单)
- 专家 = 标准 skill + verify,不发明概念
- UGK_ONLY_SKILL 是地基,别破坏 resources_discover 的 env 分支
- 异步句柄不能改同步
- consent 只能 CLI doctor 写

## 分支与发布

- `main` — 发布分支,保持稳定
- `feat/expert-gateway` — 网关开发分支
- 新功能起 `feat/<xxx>` 分支

## 接手

新接手者先读 [HANDOFF.md](./HANDOFF.md)。
