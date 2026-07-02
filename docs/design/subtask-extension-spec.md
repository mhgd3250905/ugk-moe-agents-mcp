# subtask 设计文档 v0.1(待实现)

> **状态:设计已核对闭合(2026-06-24),待实现。** 本文是 subtask 的设计意图权威说明,如跟代码冲突以代码为准。
>
> 本文档把多轮讨论的结论固化成可实现规格。**不改动现有 task 模块的 7 个核心函数**,只在外面包一层工具 + 注入。

---

## 一、定位(一句话)

把 taskbook 的复用链路(dispatcher → worker → verify)封装成一个 LLM 可调用的工具 `run_task`,与 `subagent` 平级,让 main agent 能"像用 subagent 一样用 taskbook"。

核心价值:**task 是最小单位,不可嵌套**。taskbook 是确定性的积木,run_task 让 LLM 在编排时调用这些积木。

---

## 二、两个原语的对偶关系

| 维度 | subagent | run_task |
|---|---|---|
| 触发 | LLM 判断该用 | LLM 判断该用 |
| 输入 | 一句 task 人话 | 一句 input 人话 |
| 中间 | 直接 spawn agent | dispatcher 翻译 → worker 干活 |
| 返回 | 人话(LLM 自称成功) | **PASS/FAIL + 产物(机器验收)** |
| 失败处理 | 返回错误,LLM 决策 | 返回错误,LLM 决策 |
| 局部确定性 | 低 | **高** |

**本质差异只有一条**:subtask 回来的是机器验收的硬信号,main 可直接信、直接汇报;subagent 回来的是 agent 自述,main 要复查。这是 subtask 存在的核心理由。

---

## 三、两条铁律(设计共识)

### 3.1 需求驱动,因果不反

LLM 是带着任务来的,不是来逛 taskbook 商店的。**先有明确任务,发现有一个明确可快速执行的 task,才选择 run_task。** 不是"拿到 task 想怎么填参数",而是"有任务才用它"。

因此 taskbook 清单在 system prompt 里只放 name + 一句 description,让 LLM "想起来",不放参数表。

### 3.2 责任归 LLM

怎么填、填得对不对是 LLM 的责任。系统不加智能、不兜底、不猜默认值。dispatcher 翻不出来就返回错误,让 LLM 改。

---

## 四、工具形态:`run_task`

### 4.1 参数

```
run_task({
  name: string,              // taskbook 名(必填)
  input: string,             // 一句人话(必填,LLM 负责说清楚)
  tasks?: [{name, input}]    // parallel 模式:批量(三选一)
})
```

### 4.2 三种模式(对齐 subagent,先不做 chain)

- **single**:`{name, input}`
- **parallel**:`{tasks: [{name, input}, ...]}`,复用 subagent 的 `mapWithConcurrencyLimit`(MAX_CONCURRENCY=4, MAX=8)

**不做 chain**:task 输出是文件不是文本,串联语义别扭;真有需求再加。

### 4.3 返回(每个 task)

- status: `pass` / `fail`
- verifyFailures(失败时)
- artifacts: 产物路径列表(绝对路径)
- outputDir: 该 task 的独立输出目录(绝对路径)
- workerSummary: worker 的一句话摘要
- duration / attempts

parallel 聚合返回 `N/M succeeded` + 每个 task 的摘要,**整体成败判断留给 main**(跟 subagent parallel 一个套路)。

### 4.4 run_task 工具 description(LLM 选择指导)

```
run_task:复用一个已存在、已通过机器验收的固定任务(taskbook)来执行一件确定性的工作。

什么时候用 run_task:
- 你的任务本身已经明确、可验收(例:下载指定视频、统计指定文件、转换指定格式),
  并且存在一个恰好能完成它的 taskbook。

什么时候用 subagent 而不是 run_task:
- 任务还不明确、需要探索和判断、或者没有匹配的 taskbook。
- 需要灵活地完成一件一次性的事。

参数:
- name:必须是 system prompt "可用 task" 清单里列出的 taskbook 名,写错会报错并列出可用项。
- input:用一句人话说明这次的具体参数(例:"下载 https://b23.tv/xxx")。
  能否正确填写是你的责任。

返回每个 task 的 PASS/FAIL(机器验收,不是 agent 自述)和产物路径。整体成败由你判断。
```

核心区分词:**"明确(已确定) vs 需探索"**。不用"重复性",以免误伤"只跑一次但任务确定"的场景(如数据迁移)。

---

## 五、内部数据流(headless 编排,复用底层函数)

> **关键区分**:`handleTaskRun`(`task.ts:628`)是**不可复用**的——它是 UI 交互式(notify/widget)、fire-and-forget(返回 void,内部跑 runPromise 不 await)、且依赖 `registerTask` 闭包内的 `activeTaskRun`/`lastTaskRunReview` 状态。run_task **必须自己写一个 headless 版编排**,逐个调用下列**已验证可复用的底层函数**。

可复用的底层函数(纯逻辑,返回结构化结果,不依赖 UI 闭包):

| 函数 | 位置 | 签名要点 | 状态 |
|---|---|---|---|
| `loadTaskbook` | `task-book.ts:180` | `(cwd, name) => LoadedTaskbook \| null` | 已导出 ✅ |
| `dispatchWorker` | `task-worker.ts:58` | `(input, opts) => Promise<{ok,outputDir,summary,errorMessage,usage}>` | 已导出 ✅ |
| `runVerify` | `task-verify.ts:52` | `(opts) => Promise<{passed,failures,...}>` | 已导出 ✅ |
| `appendRunToTaskbook` | `task-book.ts:219` | `(scope, cwd, name, run) => Promise<Taskbook>` | 已导出 ✅ |
| `resolveRuntimeInputFromText` | `task-dispatcher.ts:75` | `(ctx, skill, contract, rawInput) => Promise<unknown>` | 已导出 ✅ |
| `resolveTaskWorkerEnv` | `task.ts:337`(闭包内,未导出) | `(ctx, loaded, activeTools) => Promise<env\|null>` | **需导出** ⚠️ |

数据流:

```
LLM 调 run_task(name, input="下载 https://...")
  ↓
1. loadTaskbook(name)                              ← task-book.ts
   不存在 → 报错 + 列可用 taskbook 名(对齐 subagent)
  ↓
2. resolveRuntimeInputFromText(ctx, skill, contract, input)
   └─ callDispatcher: 一次 complete() LLM 调用     ← task-dispatcher.ts
       翻译成 {url:"https://..."}
       翻失败 → 直接返回错误给 LLM(不兜底)
  ↓
3. resolveTaskWorkerEnv(ctx, loaded, activeTools)  ← task.ts(需导出)
   └─ parallel 模式:合并去重受保护工具,一次 confirm 覆盖整批
  ↓
4. dispatchWorker(skill, contract, runtimeInput, outputDir)  ← task-worker.ts
   └─ spawn worker 子进程,signal 透传
  ↓
5. runVerify(verifyPath, outputDir, input)         ← task-verify.ts
  ↓
6. appendRunToTaskbook(scope, cwd, name, run)      ← task-book.ts
  ↓
返回 PASS/FAIL + 产物 + summary + outputDir
```

**改动**:`resolveTaskWorkerEnv` 需从 `registerTask` 闭包内提到模块顶层并 export(其余 5 个不动)。`dispatcher/worker/verify/checker/book/state` 核心逻辑零改动。

---

## 六、taskbook 清单注入(解耦接口层)

### 6.1 解耦原则

taskbook 清单的生成逻辑**独立成纯函数**,不绑死在任何 extension 的 system prompt 拼接里。谁需要(judge、cron 将来都可能)都能复用。

```
┌──────────────────────────────────┐
│  taskbook 清单生成器(纯函数)      │  输入 cwd,输出清单文本
│  buildTaskbookPrompt(cwd): string │  只写一份,无状态
└──────────┬───────────────────────┘
           │ 复用
     ┌─────┼─────┬──────────┐
     ▼     ▼     ▼          ▼
  run_task  /task  judge    cron
   注入     显示   (将来)   (将来)
```

放 `extensions/task/task-registry.ts`(新文件)或 `task-book.ts` 内导出。纯函数,扫描 taskbook → 生成 name+description+选择提示文本。

### 6.2 清单格式(buildTaskbookPrompt 输出)

```
## 可用 task(确定性、已机器验收的固定任务)
下列 task 可用 run_task 工具复用。只有当你的任务明确匹配其中某项时才调用:

- bilibili-download — 输入 B 站视频链接,下载视频文件 (input: url)
- v2ex-hot — 抓取 V2EX 技术区块前 N 条 (input: topN=10)
- grapheme-count — 输入文本,统计字素(grapheme)数量并输出 (input: text)
- <name> — <taskbook.description>
```

有 `contract.runtimeInput` 时,清单行追加 `(input: field1, field2)`。若 `runtimeInputMeta.<field>.default` 存在,显示为 `field=default`。只暴露字段名/默认值,不注入完整 `contract.json`,避免 system prompt 膨胀。

### 6.3 注入时机

- `session_start` 时调 `listTaskbooks` 扫描,缓存清单文本
- `before_agent_start` 时通过返回 `systemPrompt` 字段拼入(pi 支持多 extension 链式拼接)
- taskbook 增删后,`/reload` 触发 session_start 重扫

**不做 list 工具**:违反"需求驱动"——LLM 带着任务来,prompt 里有清单直接就能想起来,不需要再调一次工具查。

---

## 七、嵌套防护(task 是最小单位)

**task 不可嵌套。** task 中运行的 agent 不具备再调用 task 的能力,也不具备调用 subagent 的能力。

### 7.1 worker 子进程:天然无 run_task

run_task 只在 **main session** 注册。worker 是 `runSingleAgent` 用 `pi --print --no-session` 起的独立子进程,工具集由 `agents/worker.md` + `--tools` flag 控制,**不会加载 task 扩展**。因此 worker 天然调不到 run_task,坑自动消失,无需额外代码。

worker 调 subagent 已被 `agents/worker.md` prompt 禁止(独立进程内的约束)。

### 7.2 executing 阶段的 task-creator:显式 block

main agent 自己在 task 的 executing 阶段干活时,不能调 run_task(等于 task 嵌套 task)。对齐现有 subagent 的 block 机制:

- 扩展 `registerTask` 里的 `tool_call` handler
- 当 `state.phase === "executing"` 时,把 `run_task` 加进禁用名单(现已有 subagent 的 block)
- 返回 `{ block: true, reason: "Task executing 阶段禁止调用 run_task(task 不可嵌套)。" }`

---

## 八、model 配置(taskbook 级,细分)

参考 subagent 给 agent 单独配 model 的机制,细分到**不同 taskbook 设置独立的 model**。

### 8.1 两个角色分别配

| 角色 | 现状 | taskbook 级配置 |
|---|---|---|
| **dispatcher**(翻译人话) | 用 `ctx.model` | taskbook 声明 `dispatcherModel`,callDispatcher 优先用它 |
| **worker**(干活) | 用 `agents/worker.md` 的 `deepseek-v4-pro` | taskbook 声明 `workerModel`,dispatchWorker 时用 `--model` 覆盖 |

### 8.2 配置位置:contract.json

```json
{
  "dispatcherModel": "deepseek-v4-flash",   // 可选,缺省用 ctx.model
  "workerModel": "deepseek-v4-flash",        // 可选,缺省用 worker.md 默认
  "outputDir": "...",
  "artifacts": [],
  "runtimeInput": [],
  "requiredTools": []
}
```

放 contract 而非另开文件:contract 已是 taskbook 的"执行规格"(outputDir/artifacts/runtimeInput/requiredTools 都在这),model 是同类执行参数,放一起最内聚。review 阶段产出 contract 时一起定。

### 8.3 降级默认

两个字段都缺省时,行为跟现状完全一致(dispatcher 用 ctx.model,worker 用 worker.md)。**零配置可用,需要省钱的 taskbook 才显式配。**

---

## 九、授权(批量,镜像 subagent)

- **single run_task**:沿用现有 `resolveTaskWorkerEnv`(确认 chrome_cdp / MCP 受保护工具)
- **parallel run_task**:合并去重所有 task 用到的受保护工具,**一次 confirm 覆盖整批**
- 授权只传 worker 子进程 env(`UGK_TASK_ALLOW_CHROME_CDP` / `UGK_TASK_ALLOW_MCP_TOOLS`),不改全局 `/cdp` `/mcp` 模式(现有机制)
- 用 chrome_cdp 时,worker env 同时携带 `UGK_CDP_PORT`(取主进程 `process.env.UGK_CDP_PORT`,由 `/cdp port` 写入),让 worker 子进程连与主进程一致的端口而非默认 9222
- 非交互模式(rpc/json/print):无 UI 无法 confirm → 复用现有 fail-closed,只有不涉及受保护工具的 task 能跑

---

## 十、outputDir 隔离

- 每次 run 生成独立目录:`.tasks/runs/task-<name>-<timestamp>-<随机>/output`
- parallel 时即使 name 相同(同一 taskbook 跑不同 input),也各自独立 outputDir,产物不互相覆盖
- run_task 返回**必须带每个 task 的 outputDir 绝对路径**,main 拿到 PASS 后能直接定位产物

---

## 十一、超时与中断(对齐 subagent)

**不引入时间维度的超时**,只做 AbortSignal 传导(pi 的既有范式:长任务靠用户/main 主动 abort,不靠系统定时杀)。

- run_task 工具 `execute` 收到的 `signal`(pi runtime 传)→ 透传给 `dispatchWorker` → worker spawn
- parallel 模式下,abort 触发时整批杀掉(一个 signal 挂在所有 worker 上)
- verify 那层保留现有 30s 超时(`runVerify` 内置,针对 verify.mjs 卡死)

---

## 十二、显式不做的事

1. **不做 chain 模式**:task 输出是文件不是文本,串联语义别扭
2. **不固化编排/工作流**:编排是 main 的智能,我们只给积木。不做 orchestrate.yaml 之类
3. **不给 contract 加默认值机制**:违反"责任归 LLM"
4. **不改 taskbook 的 one-step 契约**:taskbook 保持确定可验收,编排是它上面的一层
5. **不替 LLM 做整体成败判断**:7/10 pass 算不算成功是 main 的事,run_task 只如实返回局部结果
6. **不做 list 工具**:违反"需求驱动"
7. **不引入定时器超时**:对齐 subagent,只传导 AbortSignal

---

## 十三、改动清单(预估)

| 文件 | 改动 | 大小 |
|---|---|---|
| `extensions/task/task-registry.ts` | **新增**:`buildTaskbookPrompt(cwd)` 纯函数(解耦注入层) | 新增 ~60 行 |
| `extensions/task/task.ts` | 加 `run_task` 工具 + before_agent_start 注入 + executing 阶段 block + model 配置读取 + 批量授权;**导出 `resolveTaskWorkerEnv`**(从闭包提到顶层) | 改+新增 ~260 行 |
| `extensions/task/task-dispatcher.ts` | callDispatcher 支持 `dispatcherModel` 参数(可选) | 改 ~10 行 |
| `extensions/task/task-worker.ts` | dispatchWorker 支持 `workerModel` → 透传给 runSingleAgent 的 `--model`(可选) | 改 ~10 行 |
| `extensions/task/task-book.ts` / `task-verify.ts` / `task-checker.ts` / `task-state.ts` / `task-spec.ts` | **零改动** | 0 |
| `tests/subtask-tool.test.ts` | 新增,复用现有 mock 框架 | 新增 ~200 行 |

---

## 十四、验收标准(实现完成时核对)

- [ ] run_task single 模式:跑通一个已存在 taskbook,PASS 返回产物路径
- [ ] run_task parallel 模式:N 个 task 并行,各自独立 outputDir,聚合返回 N/M
- [ ] taskbook 不存在:报错 + 列出可用名
- [ ] executing 阶段调 run_task:被 block,返回明确原因
- [ ] worker 子进程:确认调不到 run_task(天然)
- [ ] dispatcherModel / workerModel:缺省时行为同现状,显式配置时生效
- [ ] taskbook 清单:system prompt 里有,taskbook 增删后 reload 刷新
- [ ] abort:signal 传导,parallel 整批可杀
- [ ] 受保护工具:parallel 一次 confirm 覆盖整批
- [ ] buildTaskbookPrompt 是纯函数,可独立单测
- [ ] `npm test` 全过
