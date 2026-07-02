# 并行编排被截断 + dispatcher 解析失败根因分析

> 日期：2026-06-26
> 触发场景：`帮我把这个up主的第一页视频都下载下来`（先抓列表 → 再批量下载的两段式组合任务）
> 关联提交：`d46726b`

## 现象

1. 第一步 `run_task bili-up-homepage-spider` PASS 后，agent 不自动继续做第二步（下载），用户必须手动说"继续吧"。
2. 第二步 `run_task bilibili-downloader` 报：`dispatcher 未能从输入解析出 runtimeInput(字段: bilibili_url）`。

## 根因

### 问题一：第一步 PASS 后 agent loop 退出

**机制确认（不是猜测）**：`terminate` 字段由 `pi-agent-core`（agent loop 真正所在）消费，不在 `pi-coding-agent`：

- `node_modules/@earendil-works/pi-agent-core/dist/agent-loop.js:119`：
  ```js
  hasMoreToolCalls = !executedToolBatch.terminate;
  ```
- `run_task` 的 tool result 无条件带 `terminate: true`（旧 task.ts:1549）。
- `terminate:true` → `hasMoreToolCalls=false` → 内层循环退出 → 无排队 steering/follow-up → 外层循环退出 → `agent_end` → 控制权交还用户。

**`terminate:true` 的历史**：当初为解决"PASS 后进入 Steering 卡死"加的。那个卡死的根因是工具后的**自动总结轮**若 provider 卡住，Esc 接不住。terminate 避开那轮。但副作用是**截断组合任务**——agent 没机会自动决定下一步。

> 调查教训：第一轮在 `pi-coding-agent` dist 搜 `terminate` 零命中，误判"pi 不读 terminate"。实际在依赖包 `pi-agent-core`。grep 要覆盖整个 `node_modules/@earendil-works/*`。

### 问题二：dispatcher 解析不出 bilibili_url

**根因**：bilibili-downloader 的 contract 写得太"裸"：

```json
// 改前（缺 description）
{
  "runtimeInput": ["bilibili_url"],
  "requiredTools": ["chrome_cdp", "bash"]
}
```

- 只有字段名 `bilibili_url`，**没有 runtimeInputMeta、没有 description**。
- dispatcher（无论 local 正则还是 LLM）拿不到字段格式说明，抽不出来。
- 对比 bili-up-homepage-spider 的 contract 有完整 description，所以那个能解析成功。
- **这是 taskbook 作者的 contract 质量问题，不是框架 bug。**

### 问题三：是否支持并行编排

支持：`{tasks:[{name,input}]}` 格式，最多 8 个（`SUBTASK_MAX`），并发 4（`SUBTASK_CONCURRENCY`，task.ts:47）。40 个视频需分批。但每个 task 的 `input` 都走 dispatcher 解析，contract 质量差时批量解析更易集体失败。

## 修复

### 1. 彻底移除 run_task 的 terminate（task.ts，提交 d89d189）

terminate 策略经过三次迭代，最终结论是**彻底移除**：

| 阶段 | 策略 | 问题 |
|---|---|---|
| 最初（64f1317） | 所有模式 `terminate:true` | 组合任务被截断，PASS 后必须手动"继续" |
| 第一次改（d46726b） | single terminate / parallel 不 terminate | **漏洞**：多步编排第一步往往是 single（抓列表只有1个task），仍被截断 |
| 最终（d89d189） | **彻底移除 terminate** | agent 永远能继续决策 |

**为什么彻底移除是对的**：
- terminate 当初是为绕开"工具后自动总结轮 provider 卡死"，但那是 **provider 层**问题，terminate 只是**回避**不是**修复**。
- 回避的代价是截断所有后续 agent 决策——多步编排的第一步被截断，逼用户手动驱动。
- 若 provider 卡死重现，应从 abort/provider 层修，不在 task 工具层用 terminate 兜底。
- 移除后：agent 拿到 PASS/FAIL + 产物路径，自行判断是结束还是继续下一步。

### 2. dispatcher required 门禁 + fail-fast（提交 bf0ed04 / bae0334）

详见 `2026-06-25-dispatcher-required-field-gate.md`。要点：
- `resolveRuntimeInputFromText` 检查 local/dispatcher 是否覆盖所有 required 字段，缺 required 不 short-circuit。
- headless 模式下 dispatcher 也补不全 required 时，**立即抛错**（fail fast），不让 worker 拿残缺 input 白跑。
- 修复了"worker 凭上下文猜出 url 产物正确，但 verify 检查 runtimeInput.url 失败"的迷惑性 FAIL。

### 3. 补 bilibili-downloader contract（user scope，不在仓库）

```json
"runtimeInputMeta": {
  "bilibili_url": {
    "description": "B站视频链接,格式 https://www.bilibili.com/video/BVxxxxxx 或纯 BV号。dispatcher 从用户输入里抽取这个 URL。",
    "required": true
  }
}
```

### 4. 测试（tests/subtask-tool.test.ts）

single 和 parallel 两个测试都断言 `terminate` 不为 true。507/507 全绿。

## 修复后的预期行为

`帮我把这个up主第一页视频都下载下来`：
1. agent `run_task bili-up-homepage-spider`（single）→ 抓到 40 条 → PASS → **不 terminate**
2. **agent 自动继续**（无需用户说"继续"）→ 读 JSON → 提取 BV 号
3. agent `run_task {tasks:[...]}`（parallel）→ 分批下载 → **不 terminate**
4. dispatcher 能解析 bilibili_url（contract 补了 description）

## 未决 / 后续

- **provider 卡死风险**：移除 terminate 后，若重现"工具后总结轮 provider 卡住、Esc 接不住"，需从 abort/provider 层修（pi-agent-core 的 streamFunction abort 链），不在 task 层兜底。
- **框架级 contract 校验**（备选，本次未做）：taskbook 保存时强制每个 runtimeInput 字段必须有 description。防止未来再出现裸 contract。需项目组确认是否要做。
- **组合任务的最优并行度**：40 个视频分批，每批 8 个并发 4，是当前上限。是否要调高 SUBTASK_MAX/CONCURRENCY 需观察实际 CDP/下载负载。
