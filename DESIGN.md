# ugk-moe-agents-mcp 设计说明

> 本文档记录项目的设计动机、核心决策、以及与旧 task 系统的对比。它是"为什么这么设计"的答案,README 是"是什么/怎么用"的答案。

---

## 1. 出身:这个项目从一个设计审查中来

本项目 fork 自 [ugk-core](https://github.com/mhgd3250905/ugk-tui)。ugk-core 有一个叫 **task** 的系统——把"调教好的成功经验"沉淀成可复用的 taskbook,主 agent 通过 `run_task` 工具调用它,跑完用 `verify.mjs` 机器验收,返回 PASS/FAIL。

task 的设计初衷是好的:把确定性工作从 agent 的判断域里剥离出来,交给机器验收托管。但在演进过程中,它积累了越来越重的"过程脚手架"——四阶段强制流程、dispatcher(LLM 翻译输入)、checker(重试反馈)、工具白名单、状态机、context 过滤……

**问题来了**:这些脚手架的本意是"防 agent 犯错",但它们在和 agent 的天性对抗。agent 的本质是**不确定性 + 可纠错重试**,而 task 的演进方向是用越来越多的规则把它框进一条确定性路径。每发现一个 agent 会绕路的点就加一条规则,规则又产生新的边界情况,需要更多规则——复杂度失控。

本项目是对这个问题的回答:**承认 agent 的不确定性是特性不是 bug,把"防犯错"的脚手架砍掉,只在结果处设一道 verify 闸门。过程完全放开,只管结果。**

## 2. 第一性原则:从"只要结果可判断"重新推导

如果我们只关心**结果可判断**(verify.mjs 能客观判 PASS/FAIL),不关心过程,会得到什么?

### 三条前提

1. **唯一有价值的东西 = verify.mjs**(客观判定 + 产物存在性)
2. **过程是 agent 的事**,不是框架的事——agent 怎么走到结果,自由发挥、绕路、犯错、重试
3. **框架的职责 = 提供 verify 能跑的前提条件**,不提供"让 agent 不犯错"的护栏

### 这三条推翻了什么

| 旧 task 的机制 | 为什么被推翻 |
|---|---|
| 四阶段强制流程(planning→executing→reviewing→landed) | 过程脚手架。造一个专家 = 产出一个能跑通的 skill + verify,不需要强制流程框定 |
| dispatcher(LLM 翻译自然语言→结构化输入) | MCP 工具的入参是结构化 JSON schema,调用方 agent 直接构造,根本不需要翻译层 |
| checker(verify FAIL 后的方向性重试反馈) | FAIL 原因直接回给专家实例本身,不需要独立的 checker 子 agent |
| 工具白名单(planning/execute 的受限工具集) | 专家用什么工具走到 verify PASS 是它自己的事,框架不预设 |
| 状态机 + context filter | 专家是无状态工具(每次调用起独立进程),不需要"进入模式"的概念 |

### 这三条保留了什么

- **verify.mjs + VerifyFailure schema** — 结果闸门,核心价值,原样继承
- **spawn 干净实例的能力** — 专家需要隔离的执行环境
- **并发上限原语** — 多专家并行时需要(`mapWithConcurrencyLimit`)

## 3. 核心决策:专家 = 标准 skill + verify,跑在干净 ugk 实例里

### 为什么专家用"标准 skill"而不是新造的概念

旧 task 有自己的 `skill.md`(简化的 worker 执行手册)。我们决定**抛弃它,用 skill-creator 规范的标准 SKILL.md**。

理由第一性:专家"怎么做"完全由 skill 决定。skill-creator 已经有成熟的规范(frontmatter name+description 触发机制、body ≤500 行、scripts/references 渐进式加载),没必要重造。**本项目不发明任何新概念,只组装已有结构:**

| 概念 | 来源 |
|---|---|
| 经验引导(怎么做) | **标准 skill**(skill-creator 规范) |
| 隔离执行(干净实例) | **标准 ugk**(`--mode json -p` 子进程) |
| 外部调用(像 tool) | **标准 MCP**(server 暴露 tool) |
| 结果判定(做到了吗) | **verify.mjs**(task 系统唯一遗产) |

### 为什么用 MCP 暴露专家

专家可以有很多种暴露方式(为什么选 MCP):

1. **标准化接口**——MCP 是公认协议,任何 MCP client(ugk / Claude Desktop / 其他)都能接入
2. **发现性**——专家通过 `tools/list` 自动暴露给 agent,不靠文本引导(旧 task 的发现性问题就是这么解不开的)
3. **零转换透传**——MCP 的 inputSchema 是标准 JSON Schema,ugk 用 `Type.Unsafe` 原样透传给 LLM,不需要任何适配代码
4. **天然隔离**——网关是独立进程,专家 spawn 的子进程也是独立的,x 不知道 linkedin 存在

### 为什么是异步句柄模式(run_expert / check_job / get_result)

MCP client 对单次 `callTool` 有 60 秒超时。但真实专家(如 x-search)跑一次要 5 分钟。如果用同步调用,ugk client 端会超时报错。

异步句柄模式:**`run_expert` 只负责 spawn 专家进程并立即返回 jobId(<5s),任务在后台跑。`check_job` 查状态,`get_result` 取结果。** 每次调用都在 60s 内。

代价:调用方 agent 要会"轮询"。但这是处理长任务的正确方式,且 LLM agent 完全能理解这个三步协议(网关的 `instructions` 字段会写清)。

## 4. 专家实例怎么"只懂一件事":UGK_ONLY_SKILL

### 问题

ugk 启动时默认加载**所有** skill(`extensions/index.ts` 的 `resources_discover` 全量扫描 `skills/` + `user-skills/`)。但专家实例必须**只加载自己的 skill**——否则它不是"x 搜索专家",而是"什么都会的通用 agent"。

### 解法

在 `extensions/index.ts` 的 `resources_discover` handler 加一个 env 分支:

```ts
pi.on("resources_discover", () => {
    const onlySkill = process.env.UGK_ONLY_SKILL?.trim();
    if (onlySkill) {
        const resolved = path.isAbsolute(onlySkill) ? onlySkill : path.resolve(packageRoot, onlySkill);
        return { skillPaths: [resolved], promptPaths: [], themePaths: [] };
    }
    // 不设 env → 保持全量加载行为不变
    return { skillPaths: [...scanSkillPaths(...), ...], ... };
});
```

网关 spawn 专家实例时,env 注入 `UGK_ONLY_SKILL=<专家的 SKILL.md 绝对路径>`。配合 ugk 启动时的 `--no-skills`(屏蔽 pi 内置 skill 发现),专家实例就只加载这一个 skill。

**为什么安全**:不设 env 时行为完全不变(全量加载),只有网关起专家时才用。这个 env 经 `buildSubagentChildEnv` 的 env 透传机制自动传给子进程,零额外接线。

## 5. verify gate:结果闸门的设计

### 契约

verify.mjs 是 Node ESM 脚本,网关注入三个 env:
- `TASK_OUTPUT_DIR` — 产物目录
- `TASK_INPUT` — JSON 格式的本轮输入
- `TASK_DIR` — 专家包目录(让 verify 能引用 scripts/)

判定:**exit 0 = PASS;非 0 = FAIL,stdout 必须是 `VerifyFailure[]` JSON**。

### VerifyFailure schema

```typescript
interface VerifyFailure {
  assertion: string;   // 断言名/描述(必填)
  expected: string;    // 期望值(必填)
  actual: string;      // 实际值(必填)
  hint?: string;       // 修复提示(可选)
}
```

### 为什么 verify 只管产物层,不管输入层

旧 task 的 dispatcher 负责输入校验,verify 负责产物校验,两者分层。新架构里**没有 dispatcher**——输入由调用方 agent 按 MCP schema 直接构造,结构上不会错(错就调不通工具)。所以 verify 只需要管"产物合不合格",不需要重复输入校验。

### FAIL 怎么反馈

verify FAIL 时,`failures[]` 经网关传回调用方(`get_result` 的返回值)。调用方 agent 拿到结构化的 `assertion/expected/actual/hint`,能判断:
- 是不是参数给错了(重试,换参数)
- 是不是环境问题(如 Chrome 没登录,提示用户)
- 是不是专家 skill 有 bug(报告问题)

这是旧 task #38("surface FAIL reason to agent context")的延续——**框架职责是把错误显式反馈,不静默吞**。

## 6. 与旧 task 系统的对比

| 维度 | 旧 task (ugk-core) | 本项目 (moe-agent) |
|---|---|---|
| 定位 | 有状态的会话模式 | 无状态的 MCP 工具 |
| 暴露方式 | `run_task` 工具(ugk 内部) | 标准 MCP server(任何 client 可接入) |
| 经验载体 | taskbook(skill.md + contract.json + spec.json + verify.mjs) | 专家包(标准 SKILL.md + verify.mjs) |
| 输入处理 | dispatcher(LLM 翻译自然语言→结构化) | MCP schema(agent 直接构造结构化 JSON) |
| 创造流程 | 四阶段强制流程(planning→executing→reviewing→landed) | 自由(造专家 = 写 skill + verify) |
| 过程护栏 | 工具白名单 + 状态机 + context filter | 无(过程完全放开) |
| FAIL 重试 | checker 子 agent 产方向性 hint | FAIL 原因直接回专家(重试由调用方决定) |
| 隔离 | taskbook scope(共享 session) | 进程级隔离(每次调用起独立 ugk) |
| 可外部调用 | 否(只在 ugk 内部) | 是(标准 MCP) |
| 可教导改进 | 否(锁死在 runtime 内) | 设计已留位(专家包是标准 skill,可交互式教) |

## 7. 已知的设计张力(诚实记录)

这些是设计过程中识别到、但当前选择接受的张力:

### 张力①:专家实例消耗 token

专家是 LLM agent,跑一次要消耗 API token。对于高频调用场景,成本可能显著。当前没有缓存/优化机制——每次调用都是 fresh session。缓解:专家的 skill 引导它高效执行(少绕路),verify 兜底质量。

### 张力②:异步模式增加调用方复杂度

`run_expert → check_job → get_result` 三步,比"一次调用拿结果"复杂。当前靠网关 `instructions` 字段教 agent 这个协议。未来可考虑:让网关在 `run_expert` 时就阻塞到完成(如果任务短)、或在 MCP 层用 progress notification。

### 张力③:专家的可靠性依赖 skill 质量

专家会不会犯错,主要取决于 SKILL.md 写得好不好。我们提供了 skill-creator 规范来指导写 skill,但没有强制校验"skill 写得对不对"。这是有意的:强制校验 = 过程脚手架 = 我们正在砍的东西。信任 skill + 用 verify 兜底结果,是当前的选择。

## 8. 不在当前范围内(YAGNI)

- **TUI 教导通道**:设计已为"交互式教专家改 skill"留位(专家包是标准 skill,在专家目录起交互 ugk 即可),但未实现
- **专家包市场/分发**:旧 task 有 marketplace,本项目暂不做
- **并行多专家**:`mapWithConcurrencyLimit` 可复用,但当前是单任务模式
- **冗余清理**:fork 自 ugk-core 的 cron/plan-mode/ui-brand 等还在(不影响网关),逐步清理

## 9. 演进方向(开放)

这个架构是 MoE(Mixture of Experts)思想的落地。长期看,可以:

- **专家自动发现环境特性**:第一次跑时自己摸索,把经验固化进 skill,越用越准
- **专家间的协作编排**:网关层支持"先 x-search 找线索,再 linkedin-search 深挖"这种链式
- **专家质量度量**:记录每个专家的 PASS 率、平均耗时,自动暴露给调用方做选择

但这些都是"足够好用之后"的事。当前 0.1.0 的目标是:**证明这个架构跑得通,专家包格式可复用,verify 兜底有效。** 端到端测试已验证这一点。
