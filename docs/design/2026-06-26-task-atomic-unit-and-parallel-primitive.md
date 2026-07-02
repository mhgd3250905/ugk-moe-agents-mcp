# task 是原子单元,run_task 是并行原语(设计准则)

> 日期:2026-06-26
> 触发场景:agent 反复绕开 `run_task({tasks:[...]})`,改用 subagent 包裹或 bash 喂 JSON,导致并行 task 测试失败/越绕越远。
> 本文是**任何修改 task 模块前必读的红线**,与 `extensions/task/task.ts` 文件头注释互为镜像,改一处同步另一处。

---

## 一、问题:agent 为什么会绕路

实测证据(`~/.pi/agent/tasks/bilibili-downloader/taskbook.json`):10 次 run 全部 single 模式,**从没成功发出过 `run_task({tasks:[...]})`**。agent 的绕路姿势有三种,每一种都暴露了同一个根因:

1. **套 subagent**:`subagent parallel(4 tasks)` 里每个 worker 调 `run_task single` → 撞 `buildSubagentChildEnv` 删 `UGK_TASK_ALLOW_CHROME_CDP`(subagent.ts:78-79),worker 拿不到 CDP 授权,4 个全 "未获授权" FAIL。
2. **同 turn 发 N 个 single**:失去统一授权检查(`resolveTaskWorkerEnv` 被调 N 次)、失去统一 PASS/FAIL 汇总,且并发性取决于 pi runtime 的同 turn 多工具调度——**不可控**。
3. **bash/python 生成 JSON 喂 run_task**:把工具调用当命令行命令,是对 runtime 工具调用机制的根本认知错位。工具参数直接由 LLM 构造 JSON,不需要任何中转。

**根因不是机制坏,是引导不对称**:`run_task` 的 parallel 模式藏在参数注释第二行,`subagent` 的写在 description 第一行。agent 看不见正路,就去试错。

---

## 二、设计准则(红线)

### 2.1 task = 原子单元,不可拆解

用户设计并通过机器验收的 task,对调用方(run_task / agent)就是**不可分割的单位 1**。
- 内部下载 1 个视频还是 100 个、做 1 步还是 10 步,**对调用方不可见,也不该可见**。
- 调用方不拆 task、不要求 task 透露内部结构、不替 task 做拆分决策。
- "单位 1"指**调用语义**:一次 `run_task({name, input})` = 一次单位 1。叠加多个单位 1(并行 N 个相同 task)是 run_task 的事,不是用户 skill 的事。

### 2.2 并行编排是工具层的能力,不是用户 skill 的责任

类比 subagent:它的并行能力写在 description 第一行,换任何 agent 都通用,**不依赖任何 agent 配置**。run_task 必须同等:

| | subagent | run_task |
|---|---|---|
| 单个 | `subagent({agent, task})` | `run_task({name, input})` |
| 并发 | `subagent({tasks:[{agent,task}]})` | `run_task({tasks:[{name,input}]})` |
| 并发上限 | `MAX_CONCURRENCY=4 / MAX=8` | `SUBTASK_CONCURRENCY=4 / MAX=8` |
| 并发单元 | agent | task(单位 1) |

**关键约束**:agent 是否知道"想并行 N 个 task 就用 `run_task({tasks:[...]})`",必须**完全由 run_task 工具自身的 description 决定**,不能依赖某个 task 的 skill.md 有没有写"批量用法"。

### 2.3 三条禁止

1. **禁止把"教 agent 并行"的责任推给用户 skill.md。** 用户写的 task 可能偏科、可能只描述单视频——这不能导致 agent 不会并行。在 `bilibili-downloader/skill.md` 加"请用 parallel"是打补丁,换一个偏科 task 就失效。
2. **禁止让 agent 绕去 subagent 做并行 task。** subagent 的 worker 子进程会丢掉 task 的受保护工具授权(设计如此,subagent.ts:78-79),用它包 run_task 必然授权失败。并行 task 只有 `run_task({tasks:[...]})` 一条正路。
3. **禁止让 agent 通过 bash/python 中转构造 JSON 喂 run_task。** 工具参数的 JSON 由 LLM 直接构造,不需要中转。

---

## 三、谁负责什么(责任边界)

| 角色 | 负责什么 | 不负责什么 |
|---|---|---|
| **用户** | 把 task 设计好(单步或批量,随意),通过机器验收 | 教 agent 怎么并行调用 task |
| **run_task 工具层** | 让 agent 天然知道 parallel 模式存在且可用 | 关心 task 内部结构 |
| **agent (LLM)** | 有并行需求时用 `run_task({tasks:[...]})`,N≤8 | 通过 subagent/bash 绕路 |
| **task 模块维护者** | 保证 run_task description 发现性与 subagent 对齐 | 为单个 task 写专属并行指引 |

---

## 四、验证清单(改 task 模块前/后对照)

修改 `extensions/task/` 任何文件后,确认以下几点未被破坏:

- [ ] `SUBTASK_MAX = 8` / `SUBTASK_CONCURRENCY = 4` 仍存在且语义未变(task.ts:47-48)
- [ ] `run_task` description 的 parallel 模式与 subagent 同等可见(不是藏在参数注释里)
- [ ] `run_task` description 没有"需要通过 bash 构造 JSON"之类的误导
- [ ] parallel 模式仍走 `mapWithConcurrencyLimit`(task.ts:1575),没有退化成串行
- [ ] 没有为任何**特定 task** 加并行指引(那是 skill.md 的职责,不是工具层)

---

## 五、反模式(出现即错)

- ❌ 在某 task 的 skill.md 写"多视频请用 run_task parallel" → 把工具层职责下放给用户(违反 2.3.1)
- ❌ 测试 task 并行时用 `subagent parallel` 包 `run_task single` → 授权丢失(违反 2.3.2)
- ❌ 修 description 时把 parallel 又藏回参数注释 → 发现性退化(违反 2.2)
- ❌ 为了"安全"给 task 加串行降级开关 → 破坏并行原语语义(违反 2.1 单元不可拆)
- ❌ 给 run_task 加 chain 模式"方便串联" → task 输出是文件不是文本,串联语义别扭,YAGNI

---

## 六、与既有文档的关系

- `docs/design/subtask-extension-spec.md`:subtask 的总设计规格,本文是其 §4.2 parallel 模式的**发现性约束**补充。
- `docs/design/2026-06-26-cdp-per-worker-tab-isolation.md`:并行 task 的 **tab 隔离机制**(已实现),本文是并行 task 的**调用语义准则**(待落地到 description)。两者正交:tab 隔离保证并行安全,本文保证 agent 知道用并行。
- `extensions/task/task.ts` 文件头注释:本文的镜像,代码层红线,改一处同步另一处。
