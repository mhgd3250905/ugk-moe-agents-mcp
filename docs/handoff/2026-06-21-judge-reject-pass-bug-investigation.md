# Bug 调查任务:Judge 交付被拒后卡死

> 状态: **待调查**
> 日期: 2026-06-21
> 角色: 本文档为 bug 调查交接,供执行 agent 独立调查根因并修复
> 工作目录: `E:\AII\ugk-core`(项目根)

---

## 你的任务

独立调查一个 bug 的**真正根因**,给出**经过验证的修法**(改代码 + 跑 `npm test` 全绿 + 说明为什么这次是对的)。

**不要轻信前人猜测,从代码事实出发**。

---

## Bug 现象

用户在 ugk TUI 里跑 Judge 模式。Driver 完成一轮任务后,Judge 给出 PASS verdict,提示用户:

```
Warning: Judge delivery is waiting for user acknowledgement. Run /judge ack to accept it later.
```

**用户选了「No」(拒绝接受这次 PASS 交付)**,然后**就卡住了**——没有任何下一步提示,也回不到正常 Judge 流程,用户不知道该做什么。

**关键**:用户拒绝 PASS 交付后,Judge 流程没有定义「拒绝后的退路」。这是流程设计/代码实现的缺陷。

---

## 已核实的事实(直接采信)

### F1. PASS 交付确认的代码位置

`extensions/judge/judge.ts` 的 `onFinalize` 钩子内。搜代码里的 `pendingAckStatus` 和 `"Judge PASS"` 字样定位。

具体路径(基于最近的 commit `7867d29`):
- `onFinalize` 钩子:`judge.ts` 的 `startActiveJudgeDriver` 函数内
- PASS 分支:调 `ctx.ui.confirm("Judge PASS", "Accept this delivery?")`
- 用户选 No(acknowledged === false)→ 进 `markPendingAck(enterDelivering(...), "pass")` 分支
- 状态变成 `phase: "delivering"`, `pendingAckStatus: "pass"`

### F2. `/judge ack` 命令处理

`/judge ack` 的 handler 在 `extensions/judge/judge.ts` 搜 `action === "ack"` 定位。
当前实现只接受 `pendingAckStatus === "pass"` 时的 ack,行为是 `completeJudge(state)` → 任务结束。

### F3. 卡死的本质

用户拒绝 PASS 后,状态停在 `phase="delivering"` + `pendingAckStatus="pass"`。这时:
- `/judge ack` 会再次「接受」PASS → 任务结束(但用户明明拒绝了,这语义不对)
- **没有任何命令或路径让用户说「我不要这个 PASS,继续干/重来/退出」**
- `/judge toggle` 关闭 Judge 会丢失进度(可能太重)
- 用户陷入「我也不知道怎么往前走」的状态

### F4. 基线代码状态

- 分支: `codex/judge-taskbook`
- HEAD: `7867d29`(feat(judge): /judge edit 改造为复用 ALIGN 流程)
- `npm test`: 352 pass / 0 fail(改完必须保持全绿)

---

## 你的调查方向(不限定,但建议覆盖)

### Q1. 当前 `markPendingAck` 后到底有没有任何用户入口能往前走?
- 读 `extensions/judge/judge.ts`,把所有 `pendingAckStatus === "pass"` 的处理路径列清楚
- `/judge ack` 之外,还有别的命令能处理这个状态吗?
- TUI 里有没有别的交互入口(比如直接输入消息)?

### Q2. 用户拒绝 PASS 后,**应该**发生什么?
这是设计问题,你需要判断合理的行为。候选(可多选/组合):
- (a) 把这次 PASS 转成 FAIL-with-budget,driver 继续修(如果还有 steer 预算)
- (b) 弹菜单让用户选:「让 driver 继续修 / 放弃 / 接受(改主意了)」
- (c) 至少 notify 一条清晰提示,告诉用户接下来能做什么
- (d) 让 `/judge ack` 支持反向操作(`/judge reject`?或 `ack` 带参数?)

**参考现有 FAIL 分支的语义**:`onFinalize` 里 FAIL-with-budget 会 `startDriving` + 发 steer 让 driver 继续修。用户拒绝 PASS ≈ 用户认为这轮交付不够好 ≈ 类似 FAIL-with-budget 的语义。

### Q3. 修法最小化
不要重写 finalize 流程。最小改动可能是:
- 在用户选 No 后,弹一个菜单「让 driver 继续修 / 放弃任务」
- 或直接按 FAIL-with-budget 处理(转 steer 让 driver 继续修)
- 加一条 notify 告诉用户当前状态和下一步

---

## 修复要求

### 必须满足
1. **用户拒绝 PASS 后,有明确的下一步**(不能卡死)
2. `npm test` 全绿(352 pass),新增测试覆盖修复路径
3. 不破坏现有流程(接受 PASS 的 `/judge ack` 路径仍工作)
4. 修法最小化,不顺手重构无关代码

### 加分项
- 弹菜单让用户在「继续修/放弃/改主意接受」之间选,而不是替用户决定
- 文档更新(docs/judge.md 说明拒绝 PASS 的行为)

---

## 硬约束

| # | 约束 |
|---|---|
| HC1 | **不要猜,读代码确认事实**。改完能用一句话说清「为什么这次对」 |
| HC2 | `npm test` 全绿(352 pass + 新增) |
| HC3 | 不破坏现有 `/judge ack` 接受 PASS 的路径 |
| HC4 | bash 走 Git Bash + Linux 语法 |
| HC5 | 改动最小化,不重构无关代码 |
| HC6 | 如果根因需要新设计决策(比如「拒绝后该干啥」),参考 onFinalize 现有 FAIL 分支的语义,保持一致 |

---

## 关键文件索引

| 关注点 | 位置 |
|---|---|
| onFinalize 钩子 | `extensions/judge/judge.ts` 的 `startActiveJudgeDriver` 内,搜 `onFinalize` |
| PASS 确认 + markPendingAck | 同上,搜 `"Judge PASS"` 和 `markPendingAck` |
| `/judge ack` handler | `extensions/judge/judge.ts`,搜 `action === "ack"` |
| JudgeState.pendingAckStatus | `extensions/judge/judge-state.ts` |
| markPendingAck 转换函数 | `extensions/judge/judge-state.ts`,搜 `markPendingAck` |
| FAIL-with-budget 分支(参考语义) | `onFinalize` 内,搜 `canContinueAfterFail` |
| 现有测试 | `tests/judge-extension.test.ts` / `tests/judge-delivery.test.ts` |

---

## 报告格式

1. **根因**(一句话 + 代码 file:line 证据)
2. **修法**(改了什么 + 为什么这次能 work + 设计决策的理由)
3. **新增测试** + `npm test` 结果(pass/fail 数)
4. 如果选了某种「拒绝后该干啥」的设计,说明为什么不选其他方案
5. 有无偏离本交接文档

---

## 你的第一步

1. 读 `AGENTS.md`(项目约定)
2. 读 `extensions/judge/judge.ts` 的 `onFinalize` 钩子全文(搜 `async onFinalize`)
3. 把 PASS 被拒后(`acknowledged === false` 分支)的所有代码路径列出来
4. 判断「拒绝后应该发生什么」,参考 FAIL-with-budget 分支的语义
5. 改代码 + 写测试 + `npm test` 全绿
6. 报告

**不确定就停下来问,不要猜。** 本文档是权威。
