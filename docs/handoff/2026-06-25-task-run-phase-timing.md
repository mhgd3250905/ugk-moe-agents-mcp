# task 运行分段耗时记录

> **交接对象**:接手 task 模块的同事。
> **背景**:用户反馈某次 `/task run`(bili-up-homepage-spider)从开始到打开 CDP 感觉等了 1 分钟,实际总耗时 224.9s。但系统只记总耗时,没有分段数据,"到底慢在哪"只能猜。本次加分段计时,纯诊断、不改执行逻辑。
> **基线**:`npm test` 497 pass / 0 fail。
> **状态**:已实现 + 单测覆盖,已 commit 推送。

---

## 1. 为什么要做

之前 taskbook run 记录只有 `duration`(总秒数)。worker 子进程启动、首轮 LLM、造脚本/连 CDP、verify、重试——各占多少,全无数据。同事分析"慢在 worker 启动+首轮模型+造脚本"是**合理推断,但无证据**。要定位真瓶颈,得先有数据。

## 2. 改了什么(纯诊断,零执行逻辑改动)

在 `runTaskWithRetry` 的关键节点打时间戳,记进 run 记录的可选 `phases` 字段:

| 字段 | 含义 | 回答什么 |
|---|---|---|
| `workerFirstOutputMs` | runTaskWithRetry 进入 → worker 子进程首次产出 | "启动慢不慢"(子进程冷启动 + 首轮 LLM 延迟,即用户感受的"开始运行就卡") |
| `workerMs` | 所有 worker dispatch 累计 | worker 整体(含造脚本/连 CDP/跑脚本) |
| `verifyMs` | 所有 verify 累计 | 校验阶段 |

**worker 子进程内部细分**(回答"是 agent 启动慢、还是启动后开始工作慢")——在 `subagent.ts` 的子进程事件流里打点,带 `worker.` 前缀:

| 字段 | 含义 | 优化决策 |
|---|---|---|
| `worker.coldStartMs` | spawn → 子进程首个事件 | Node 启动 + pi runtime 初始化。高 → pi 层问题,ugk 改不了多少 |
| `worker.llmDecisionMs` | 首个事件 → 首个 tool_execution_start | 模型读完 taskbook、决定怎么干。高 → taskbook 太长,或模型本身慢 |
| `worker.toolMs` | 所有 tool_execution 累计 | 写脚本/连 CDP/抓取/sleep。高 → 在 taskbook skill 里优化(减少 sleep 等) |

这三个细分正是"启动 vs 工作"的精确拆分:看到数据就知道该优化哪段。

**不改任何执行流程**:worker 该怎么跑还怎么跑、结果一模一样。只是顺手在事件流和 await 前后 `Date.now()` 记一下差值。

### 数据流

`runTaskWithRetry` 返回 `outcome.phases` → 两条路径:
- `executeSubtask`(run_task 工具)→ `SubtaskResult.phases` + `appendRunToTaskbook` 的 `phases`
- `handleTaskRun`(/task run)→ `appendRunToTaskbook` 的 `phases`

phases 最终落盘进 `taskbook.json` 的 `runs[].phases`。

### 报告展示

`formatRunResult` 在"耗时"行下加"耗时分解"段,例如:
```
耗时: 224.9s

耗时分解:
  worker 启动+首轮: 58.0s
  worker 整体: 180.0s
    ├ 冷启动(Node+pi): 8.0s
    ├ LLM 决策: 20.0s
    └ 工具执行(CDP/脚本): 60.0s
  verify: 8.0s
```

用户在 PASS/FAIL 报告里直接看到分段,不用翻 taskbook.json。

## 3. 向后兼容

- `TaskRun.phases` 是**可选**字段,`isTaskRun` 不强制校验它。
- 老 run 记录(无 phases)照常加载、照常显示(报告里"耗时分解"段不出现)。

## 4. 测试

- `formatPhaseBreakdown` 导出单测:无 phases 空;task 层分段可读;worker 子进程内部细分(冷启动/LLM决策/工具执行)可读。
- 现有 PASS 测试加断言:`run.phases.workerMs` / `verifyMs` 是 number(落盘生效)。
- subagent 事件计时(coldStartMs/llmDecisionMs/toolMs)逻辑简单(直白的 Date.now() 打点),嵌在 processLine 闭包内,靠真实子进程事件流验证,不为此造 spawn mock。

## 5. 这个粒度够不够

回答"是 agent 启动慢、还是启动后开始工作慢"——**够**:
- `worker.coldStartMs` = 启动(Node+pi 初始化)
- `worker.llmDecisionMs` = 启动后、开始干活前(模型思考)
- `worker.toolMs` = 真正干活(CDP/脚本/sleep)

看到这三个数就知道该优化哪段。这是优化决策的直接依据。

回答"工具执行里 CDP 连接多久 vs sleep 多久"——**还不够**:toolMs 是所有工具调用累计,内部单个 sleep/CDP 的细分要看 worker 的 bash 工具输出。但绝大多数情况下 toolMs 是大头就够了——如果 toolMs 高,就去 taskbook skill 里减少 sleep/优化 CDP;如果 coldStartMs 高,那是 pi runtime 层;如果 llmDecisionMs 高,精简 taskbook。

## 6. 后续(本次不做)

- **工具执行内部细分**(单个 CDP 连接 / 单次 sleep):需在 worker 的 bash 工具层加时间戳,或解析 worker stdout,改动面大。先靠 toolMs 总值定位,确认是它后再深入。
- **taskbook 内容沉淀**(同事说的机制问题:bilibili_scraper.py 没进 taskbook、相对时间没写):那是 taskbook 质量问题,不是计时能解决的,属另一个方向。

