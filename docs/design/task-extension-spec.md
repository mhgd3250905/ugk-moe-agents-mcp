# `/task` 设计文档 v1.0

> **状态:v1 已实现并 dogfood 验证通过(2026-06-22)。** 实现细节以 `extensions/task/` 代码 + `tests/task-*.test.ts` 测试为准;本文是设计意图的权威说明,如跟代码冲突以代码为准。
>
> 本文档把多轮架构讨论的结论固化成可实现的规格。落地范围:**one-step 固定任务的 taskbook 创造 + 复用闭环**。multi-step 编排留到 v2。
>
> 核心信念(贯穿全文):**任务的定义 = 验收标准的定义**。sub-agent 只是手段,验收单才是权威。

---

## 一、定位与边界

### 1.1 `/task` 是什么

`/task` 是 UGK 的**固定任务委托系统**:把一次性调教好的成功经验,沉淀成 `skill + verify + contract` 三件套,之后任何 session 都能一键复用,worker 执行、verify 验收、checker 归因,**main 不下场、不消耗 main 的 context**。

### 1.2 one-step 边界(v1 硬约束)

v1 **只做 one-step 任务**——每个 taskbook 就是一个原子验收单元,内部不再拆分阶段。理由:
- one-step 是自验证的原子闭环,跑通一个就有信心跑通十个
- 避开 multi-step 编排的所有复杂性(上下游产出传递、DAG 调度、失败传播)
- 把"taskbook 这套结构本身"先打磨好,再往上叠复杂度

**不适合 v1 的任务类型**(显式拒绝):
- 创意/设计/文案(没有可机器判定的验收)
- 探索性调研(没有固定路径)
- bug 调试(路径不可预测)
- 需要多阶段串联的复杂任务

**适合 v1 的任务类型**(甜区):
- 下载视频、转换格式、批量重命名
- 代码类小改动 + 测试通过验收
- 数据统计、报告生成(schema 校验)
- 配置文件生成、脚手架搭建

### 1.3 跟 Judge 的关系

**独立 extension,复用零件,不复用状态机。** Judge 按现状继续运行,两者并行,直到用户主动下线 Judge。

不复用的根因:Judge 的状态机(`extensions/judge/judge-state.ts`)那些 `aligningQuestionnaireUsed`、`pendingTaskbookRun`、`wakeupGeneration` 都是**监督别人**才需要的机制,自己跑用不上。硬塞会扭曲两者。

---

## 二、四阶段流程

### 2.1 阶段总览

```
planning → executing → reviewing → landed
```

| 阶段 | 干什么 | context 策略 | 主要工具/机制 |
|---|---|---|---|
| **planning** | 跟人对齐目标、约束、验收 | 长 context(后续 execute 共享) | questionnaire + Spec 解析(探索性 bash 可跑脚本/测试验证可行性,write/edit 禁用,破坏性命令仍拦) |
| **executing** | main **亲手**把任务做一遍 | **同一个 context 继续**(保留决策链) | 继承 main session active tools,只排除 subagent,补 task_complete |
| **reviewing** | 复盘产 skill + verify + contract | **新 context**(注入执行摘要,不看原始过程) | questionnaire + 落盘 |
| **landed** | taskbook 已就绪,等下次 `/task run` 复用 | 静态文件,不进任何 session context | 文件 |

### 2.2 为什么 plan + execute 共享 context,review 用新 context

**plan+execute 共享**:taskbook 创造场景下,plan 阶段的对齐信息("你说的 X 其实是 Y")是宝贵的执行上下文,不是污染。记录"为什么这么干"的完整决策链,是 review 阶段能写出高质量 skill 的前提。

**review 用新 context**:复盘要冷静看整个执行过程,不能被执行阶段的兴奋带偏。review 看的是执行**摘要**(产出了什么、走了哪几步),不是原始 transcript,避免被过程细节淹没。

**v1 实现注记**:review 阶段不开新 session(避免 command-handler-only API 的 `ctx.newSession()` 在 `agent_end` 触发链路里的复杂度),而是用 **context filter** 模拟新 context:进入 reviewing 阶段后,`before_agent_start` 注入 `task-review-context` custom message(`display:false`,只进 LLM context 不渲染),`context` 事件过滤掉旧的 `task-plan-context`,只保留 review prompt + 执行摘要。效果等价于新 context:review agent 看不到 plan 阶段的完整 transcript。如果 v2 发现 review 质量受影响(比如 review agent 仍被早期 plan 推理带偏),再升级到真正的 `ctx.newSession()`。

**review prompt 的两条注入路径**(故意分离):
1. **context 主路径**(`display:false`)— `before_agent_start` 注入 `task-review-context` custom message,只进 LLM context,用户不可见。这是 review agent 拿到完整 prompt 的主通道。
2. **触发 + 折叠展示路径**(`display:true`)— 进入 reviewing 时 `sendTaskReviewPromptMessage` 发 `task-review-prompt` custom message(`triggerTurn:true, deliverAs:"followUp"`),职责是(a)主动启动 review turn(`before_agent_start` 是被动的,不能自己启动 turn);(b)给用户一个可折叠的 prompt 预览(注册 `renderTaskReviewPromptMessage` renderer,默认折叠成 `▸ [TASK REVIEW MODE] 已注入复盘指令 (N 行)`,`Ctrl+O` 全局展开)。content 仍作为 `role:user` 进 LLM context(pi 的 `convertToLlm` 把 custom message 转 user role,两条路径内容对 LLM 一致)。

早期实现这条路径用 `pi.sendUserMessage`,prompt 被 pi 强制渲染成完整 user 气泡,无法折叠。改用 custom message + renderer 是为了让超长 prompt 默认折叠,用户需要时再展开。`task-progress` 是同款模式的先例(可折叠的 custom message renderer)。

**questionnaire 结果折叠**:`questionnaire` 工具(`extensions/judge/questionnaire.ts`,plan/review 共用)的 `registerTool` 挂了 `renderCall` + `renderResult`,走 pi 的工具自定义渲染机制(同 bash/edit 的 `builtin-tool-render.ts`)。折叠态结果框只显示一行汇总(`✓ answered N questions` / `✗ cancelled after N answers`),`Ctrl+O` 展开看逐题明细。`execute` 返回的 content 文本(进 LLM context,给 agent 看的答案原文)不受 renderer 影响——两处格式化职责分离,content 给 LLM、renderer 给用户。早期 questionnaire 没写 `renderResult`,走 pi 的全量文本 fallback,逐题明细默认铺满屏;补 renderer 后默认折叠。

### 2.3 C-2 闸(强制对齐)

复用 Judge 的 C-2 机制 idiom,应用到 `/task` 的两个边界:

- **plan→execute 闸**:execute 前必须调过 questionnaire。flag=false 就拒绝执行,用 `pi.sendUserMessage` 把 agent 拽回 planning。
- **review→land 闸**:产 skill+verify 前必须用 questionnaire 跟人核对过。flag=false 就拒绝落盘。

实现要点:phase 名用 `/task` 自己的(`"planning"`/`"executing"`/`"reviewing"`/`"landed"`),不跟 Judge 的 `"aligning"` 冲突。两个 extension 的 `pi.on("tool_call")` listener 都会触发,靠 phase 字段区分。

---

## 三、Taskbook 结构

### 3.1 目录布局

**全局默认**(跨项目,跨 session):
```
~/.pi/agent/tasks/<name>/
  taskbook.json   # 元数据 + run 历史
  spec.json       # RequirementsSpec(对齐产物)
  skill.md        # 最优路径引导(给 worker 读)
  verify.mjs      # 验收脚本(给机器跑)
  contract.json   # 产出契约(worker/verify/checker 的共同语言)
```

**项目级可选**(`/task save <name> --project`):
```
<cwd>/.tasks/<name>/
  (同上 5 个文件)
```

加载顺序:**项目级覆盖全局**(类似 MCP scope 合并)。同名 taskbook,项目级优先。

**context 零污染保证**:taskbook 文件只在三种情况被读取——`/task run <name>`(只加载被调用的这一个)、`/task list`(只读 name+description)、`/task edit <name>`。绝不预加载到 session context。这跟 UGK 现有的 `~/.pi/agent/agents/` 和 `skills/` 机制完全一致。

### 3.2 taskbook.json schema

```json
{
  "name": "bilibili-download",
  "description": "下载 B 站视频到本地,校验完整性",
  "scope": "user",
  "createdAt": "2026-06-22T...",
  "updatedAt": "2026-06-22T...",
  "tags": ["video", "download"],
  "runs": [
    {
      "timestamp": "...",
      "status": "pass",
      "input": "https://www.bilibili.com/video/...",
      "exitCode": 0,
      "verifyFailures": [],
      "duration": 12.5
    }
  ]
}
```

字段说明:
- `scope`: `"user"`(全局) | `"project"`
- `tags`: 可选,用于 `/task list --tag` 筛选
- `runs[]`: 保留最近 10 条(复用 Judge taskbook 的 `sortAndTrimRuns` idiom)
- 单个 run 的 `status`: `"pass"` | `"fail"`
- `verifyFailures`: verify 失败项数组,空数组 = PASS
- **save 语义**:重新 `/task save <name>` 会覆盖 `spec.json`/`skill.md`/`verify.mjs`/`contract.json` 和 `taskbook.json` 的 description/tags/updatedAt,但**保留 `runs[]` 历史和 `createdAt`**——重新 review 不应清掉运行历史。

### 3.3 spec.json schema

`/task` 使用自己的 `RequirementsSpec` 数据形状,定义在 `extensions/task/task-spec.ts`。字段刻意和 Judge 的早期形状保持一致,但实现不 import Judge 模块:

```json
{
  "goal": "把给定 B 站视频下载到本地,保证文件完整可播放",
  "hardConstraints": ["必须用 yt-dlp", "必须保留原始画质"],
  "acceptance": [
    "视频文件存在且 ≥1MB",
    "ffprobe 能解析,判定为有效视频",
    "时长 ≥ 输入预期时长的 95%",
    "meta.json 记录 sourceUrl 和 title"
  ],
  "forbidden": ["不得下载弹幕", "不得转码降画质"],
  "context": "用户的 B 站登录态在 Chrome 9222 端口,worker 需要用 chrome_cdp 工具传 cookie"
}
```

Spec 解析、校验和格式化由 `extensions/task/task-spec.ts` 提供,保持 `/task` 作为独立扩展。

### 3.4 skill.md 格式

**Markdown 格式的操作引导**,给 worker subagent 读。这是 worker 的"操作手册",但**不包含验收标准**(验收是 verify 的事,不是 skill 的事)。

```markdown
# 下载 B 站视频

## 前置
- 确认 yt-dlp 已安装(`yt-dlp --version` 能跑)
- 从 chrome_cdp 工具读取 B 站登录 cookie,传给 yt-dlp

## 步骤
1. 用 chrome_cdp 导出 bilibili.com 的 cookie 到 /tmp/cookies.txt
2. 跑 yt-dlp 下载:
   yt-dlp --cookies /tmp/cookies.txt -o "<outputDir>/video.mp4" "<url>"
3. 生成 meta.json,记录 sourceUrl 和视频 title

## 产出契约
- <outputDir>/video.mp4
- <outputDir>/meta.json
```

skill 来自 review 阶段**重构最简路径**(不是从 execute transcript 机械摘抄)。它给 worker 恰到好处的自由度——不是死脚本,而是"该做什么"的引导。如果 review 发现某任务的 skill 写出来像 shell 脚本(每步都是固定命令),那它应该直接脚本化,不该走 worker agent。

### 3.5 verify.mjs 格式(关键)

**Node 脚本,能 spawn 任意外部工具**。用 Node 内置 `assert` 做结构断言,用 `child_process.spawnSync` 调外部工具做物理断言。

```javascript
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { stat, readFile } from "node:fs/promises";

const outputDir = process.env.TASK_OUTPUT_DIR;
const input = JSON.parse(process.env.TASK_INPUT);

const failures = [];
function check(name, fn) {
  try { fn(); } catch (e) { failures.push({ assertion: name, expected: "...", actual: e.message }); }
}

// 1. 来源地址(字符串断言)
const meta = JSON.parse(await readFile(`${outputDir}/meta.json`, "utf8"));
check("meta.sourceUrl 等于输入 url", () => assert.equal(meta.sourceUrl, input.url));

// 2. 视频名称(字符串断言)
check("meta.title 非空", () => assert.match(meta.title, /\S+/));

// 3. 视频文件完整性(外部工具断言)
const { size } = await stat(`${outputDir}/video.mp4`);
check("视频文件 ≥ 1MB", () => assert.ok(size > 1024 * 1024, `实际 ${size} 字节`));

const probe = spawnSync("ffprobe", ["-v", "quiet", "-print_format", "json",
                                   "-show_format", `${outputDir}/video.mp4`]);
check("ffprobe 能解析(有效视频)", () => assert.equal(probe.status, 0));
const info = JSON.parse(probe.stdout.toString());
check("时长 ≥ 预期 95%", () => assert.ok(info.format.duration > input.expectedDuration * 0.95));

if (failures.length > 0) {
  console.log(JSON.stringify(failures, null, 2));
  process.exit(1);
}
```

**verify 约定**(硬规则):
- PASS:exit 0,stdout 任意
- FAIL:exit !=0,stdout 输出 JSON 数组,每条:`{ assertion, expected, actual, hint? }`
- 每条断言必须有**人类可读的 assertion 名字**(不是 "assert 47 failed")
- **断言要覆盖正反两面**:正向(该有的产出有)+ 负向(不该动的东西没动,如果有)+ 回归(原有功能还过,如果有)
- **verify 必须先在第一次的成功产出上跑过一次 PASS**,才能固化进 taskbook(自证脚本正确)

### 3.6 contract.json 格式

**worker、verify、checker 的共同语言**。定义产出物的位置、名称、schema:

```json
{
  "outputDir": "<runtime>",
  "artifacts": [
    {
      "name": "video.mp4",
      "type": "file",
      "required": true,
      "minBytes": 1048576
    },
    {
      "name": "meta.json",
      "type": "file",
      "required": true,
      "schema": {
        "type": "object",
        "required": ["sourceUrl", "title"],
        "properties": {
          "sourceUrl": { "type": "string" },
          "title": { "type": "string" }
        }
      }
    }
  ],
  "runtimeInput": ["url", "expectedDuration"],
  "runtimeInputMeta": {
    "expectedDuration": {
      "type": "number",
      "default": 60,
      "description": "用于 verify 的预期视频秒数"
    }
  }
}
```

**contract 的作用**:
- worker 的 skill 里写死"产出必须落在 contract.outputDir 下、按 artifacts 命名"
- verify 按 contract 验每个 artifact(存在性、大小、schema)
- checker 读 contract 知道该有哪些产出,做归因
- `runtimeInputMeta` 是可选轻量元数据:只给 `runtimeInput` 字段补说明和默认值;落盘时拒绝未声明字段的 meta。

worker 只被告知 contract(产出规范),**永远不被告知 verify 内容**。这是关键隔离——worker 不能 overfit 验收。

---

## 四、三方角色与 context 策略

### 4.1 角色定义

| 角色 | 何时存在 | context 性质 | 持有什么 | 工具集 |
|---|---|---|---|---|
| **task-creator**(`/task` planning+executing) | 创造阶段全程 | 长 context(plan+execute 共享) | Spec + 完整执行决策链 | planning 探索性只读(write/edit 禁,bash 可跑脚本/测试但拦破坏性命令);executing 继承 active tools,只排除 subagent |
| **reviewer**(`/task` reviewing) | 复盘阶段 | 短 context(注入执行摘要) | 执行摘要 + Spec,不看原始 transcript | questionnaire + read |
| **worker**(复用时) | 每次 `/task run` 派出 | 短 context(注入 skill) | skill + contract,**不看 verify** | 继承默认工具,不得调用 subagent |
| **checker**(verify fail 时) | verify 失败时派出 | 短 context(注入失败输出) | 失败信息 + contract schema,**不看 worker 过程** | 只读(read/grep/find/ls/bash) |

### 4.2 关键隔离原则

- **worker 不知道 verify 内容**:防止 overfit,worker 只看 contract(产出规范)
- **checker 不知道 worker 过程**:防止被 worker 辩解带偏,只看产出 + 失败输出
- **task-creator 不派 subagent**:execute 阶段是"亲手干一次",不是"派别人干"。skill 记录的是任务本身怎么干,不是"main 怎么派 subagent"

### 4.3 main 在复用阶段的角色:**编排代码,不是 LLM**

这是方案 A 的核心。复用阶段(`/task run <name>`)的 main 是**`/task` 程序的代码逻辑**,不是 LLM。它按固定流程编排:

```
1. 加载 taskbook(skill + verify + contract + spec)
2. spawn worker 子进程,注入 skill + contract + 运行时输入
3. 等 worker 完成,拿到产出位置
4. 跑 verify.mjs(纯脚本,零 LLM),捕获 stdout
5. PASS → 记 run、通知用户、结束
6. FAIL → spawn checker 子进程,注入失败 JSON + contract
7. checker 返回归因反馈 → 反馈给 worker(retry,最多 N 次)
8. retry 耗尽或 checker 判 abort → 终止,记 fail run
```

**整个复用流程没有一个 LLM 在做"该不该派 worker"的决策**——派是代码决定的事,代码按规则跑。LLM 只在 worker 和 checker 各自的子进程里跑,各管各的任务。这保证 main context 不被 worker 摘要污染。

---

## 五、复用 worker + checker 的失败反馈协议

verify 失败时,checker 拿到结构化失败 JSON,产出**给 worker 的反馈**:

```json
{
  "status": "fail",
  "failures": [
    {
      "assertion": "ffprobe 能解析(有效视频)",
      "expected": "ffprobe exit 0",
      "actual": "exit 1: invalid header",
      "hint": "文件可能下载不完整,建议检查 yt-dlp 输出和网络"
    }
  ],
  "verdict": "retry",
  "retryBudget": 2
}
```

**关键约定**:
- **hint 给方向不给答案**。写"问题在视频完整性,方向是下载环节",不写"把 line 47 改成 X"。否则 worker 退化成 checker 的提线木偶,失去思考能力。
- **checker 持有 verdict 权**(retry/abort),不是 worker。verdict="abort" 时即使 retryBudget 还有,也终止,转人工。这是防止 worker 死循环浪费 token。
- **retryBudget 全局上限**(建议 3 次)。超过就强制 abort,记 fail run。

---

## 六、实现:独立模块与 idiom 复用清单

### 6.1 可共享入口

| 资产 | 文件:行 | 用途 |
|---|---|---|
| questionnaire 工具 | `extensions/judge/questionnaire.ts:55` | `registerQuestionnaire(pi)` 注册一次,plan/review 都能用 |

### 6.2 `/task` 自有实现

| 资产 | 文件 | 用途 |
|---|---|---|
| `RequirementsSpec` / `extractRequirementsSpec` / `formatRequirementsSpec` | `extensions/task/task-spec.ts` | task 自己的 Spec 解析、校验、格式化 |
| `summarizeToolArgs` / `extractArtifactsFromToolInput` / `isSafeCommand` | `extensions/task/task-utils.ts` | task 自己的工具摘要、产物提取、只读命令判断 |
| `saveTaskbook`/`loadTaskbook` idiom | `extensions/judge/taskbook.ts:94/116` | 复用模式,参数化根路径到 `~/.pi/agent/tasks/` 或 `.tasks/` |
| `sortAndTrimRuns` | `extensions/judge/taskbook.ts:80` | runs 截断到最近 10 条 |

### 6.3 idiom 复用(复制模式,换名字)

| 资产 | 来源 | 改动 |
|---|---|---|
| 状态机转换器 | `judge-state.ts:97-207` | 写 `task-state.ts`,phase 换成 planning/executing/reviewing/landed |
| C-2 闸 | `judge-state.ts:113` + `judge.ts:1136` | idiom 复用,字段名 `planQuestionnaireUsed`/`reviewQuestionnaireUsed`,phase 用 `/task` 自己的 |
| 单命令 args 解析 | `judge.ts:421/983` | 写 `/task` 版的 `resolveTaskCommandArgs` + `getTaskCommandMenuOptions` |
| `appendEntry` 持久化 | `judge.ts:296` | 写 `persistTaskState(pi, state)`,customType 用 `"task-state"` |
| footer status 标签 | `judge.ts:409` | `ctx.ui.setStatus("task-mode", "📋 task")` 等,品牌 UI 层会自动拾取 |
| widget(可选) | `judge.ts:617` | `ctx.ui.setWidget("task-view", lines, {placement:"aboveEditor"})`,展示当前阶段 |

### 6.4 必须新写

| 资产 | 文件 | 说明 |
|---|---|---|
| `task-state.ts` | 新建 | `/task` 自己的状态机:TaskState 类型 + 转换器 |
| `task-prompts.ts` | 新建 | `TASK_ALIGN_PROMPT`(fork ALIGN_PROMPT,保留 questionnaire 契约)+ `TASK_REVIEW_PROMPT`(全新,产 skill+verify+contract) |
| `task.ts` | 新建 | 主入口:`registerTask(pi)`,注册 `/task` 命令 + 事件 handler |
| `task-worker.ts` | 新建 | 复用阶段的 worker 派遣:基于 `subagent.ts:73` 的 `runSingleAgent` 模式 fork 一份(或导出复用) |
| `task-verify.ts` | 新建 | verify.mjs runner:spawn `node verify.mjs`,捕获 stdout/exit,解析失败 JSON |
| `task-checker.ts` | 新建 | checker 派遣:spawn checker agent,注入失败 JSON + contract,拿归因反馈 |
| `task-book.ts` | 新建 | taskbook 落盘/加载,参数化根路径(全局 vs 项目级) |
| `agents/worker.md` | 已存在 | 复用,确认 frontmatter 合理 |
| `agents/checker.md` | 新建 | 只读工具集,定义验收归因输出格式 |

### 6.4 关键实现决策

**worker/checker 派遣用 spawn 模式,不用 driver-session**。理由:
- worker/checker 是"丢任务拿结果",不需要 Judge 那种实时 steer/abort 监督
- spawn 模式天然进程隔离,worker context 不污染 main
- driver-session 是为 Judge 实时监督设计的重底座,过重

> 注:driver-session 和整个 Judge 模块已于 `ddd5520`(2026-06-27)删除,当前 /task 用 spawn 模式。本条作为设计决策记录保留,解释为何从一开始就没采用 driver-session。

具体做法:`extensions/subagent.ts:73` 的 `runSingleAgent` 是完整范本,可逐行照搬。建议先把它和 `getPiInvocation` 从 `subagent.ts` export 出来,`/task` 直接 import 复用——最小改动。如果不愿动 subagent.ts,就 fork 一份到 `task-worker.ts`。

**不引入新依赖**。全 Node stdlib(`child_process`/`fs`/`path`)+ 复用 UGK 现有模块。verify 用 `.mjs` 保证 ESM import。

---

## 七、slash 命令(交互模板:复刻 `/cdp` + `/judge`)

### 7.1 交互范式(硬约束,复用 `/cdp` 和 `/judge` 的交互 idiom)

`/task` 的交互要和 `/cdp`、`/judge` 保持同类体验,但实现保持独立。具体规则:

1. **无参弹菜单**:`/task` 不带参数时,走 `ctx.ui.select` 弹中文菜单。参考 `resolveCdpArgs`(`extensions/chrome-cdp/index.ts:197`)和 `resolveJudgeCommandArgs`(`extensions/judge/judge.ts:983`)。
2. **菜单按状态变化**:`getTaskCommandMenuOptions()` 根据 `state.phase` 返回不同选项。参考 `getJudgeCommandMenuOptions`(`judge.ts:421`),Judge 在 aligning/driving/delivering 三种 phase 下菜单完全不同。`/task` 在 planning/executing/reviewing/landed 四种 phase 下菜单也要不同。
3. **中文菜单项 + 英文 action**:菜单显示中文(如"新建任务"),`resolveTaskCommandArgs` 内部映射到英文 action(如"new")。参考 Judge 的 `"新建监督任务" → "align"` 映射(`judge.ts:990`)。
4. **`Exit` 作为终止选项**:菜单末尾永远是 `Exit`,选中返回 `undefined`,handler 直接 return。参考 `judge.ts:989`。
5. **args 兼容多形态**:`/task` / `/task list` / `/task run bilibili-download https://...` 三种都能用。参考 `/cdp status` / `/cdp` / `/cdp port 9222`。
6. **危险操作二次确认**:删除等危险动作走 `ctx.ui.confirm` 或 `ctx.ui.select`。参考 `confirmChromeCdpUse`(`chrome-cdp/index.ts:67`)。
7. **状态反馈走 `ctx.ui.notify`**:成功/失败/警告都 notify,不写 stdout。参考两个 extension 的所有 handler。

### 7.2 命令清单

| 命令 | 阶段行为 | 说明 |
|---|---|---|
| `/task`(无参) | 显示菜单 | 按当前 state.phase 显示可用选项 |
| `/task new` | 进入 planning | 开一个干净 task-creator context |
| `/task save <name> [--project]` | landed 阶段触发 | 把 skill+verify+contract 落盘,默认全局,--project 存项目内 |
| `/task run <name> [input...]` | 复用 | 加载 taskbook,走 worker→verify→checker 流程 |
| `/task list [--tag <tag>]` | 只读 | 列出所有 taskbook(name + description + lastRun) |
| `/task edit <name>` | 更新模式 | 先问用户修改点,再加载现有 taskbook 直接进入增量复盘;基于旧 spec/skill/verify/contract 做最小修改 |
| `/task rename <old> <new>` | 改名 | 改 taskbook 名(目录 + `taskbook.json:name` 一起搬,保留 `runs[]`/`createdAt`);仅原 scope 内改名,目标名已存在或同名则拒绝 |
| `/task show <name>` | 导览/编辑入口 | 选择 taskbook 后进入二级菜单:`task 导览` 用只读 reviewer 生成编号环节列表;`task 编辑` 复用 `/task edit` |
| `/task delete <name>` | 危险 | 删除 taskbook,要确认 |
| `/task toggle` | 开关 | 开关 `/task` 模式(类似 `/judge toggle`) |
| `/task exit` | 退出 | 退出当前 `/task` 流程,清理状态 |

### 7.3 菜单按 phase 变化的具体映射(照搬 Judge 模式)

```typescript
function getTaskCommandMenuOptions(): string[] {
  // planning 阶段:有 Spec 后才能进 execute
  if (state.phase === "planning") {
    return state.spec
      ? ["开始执行", "继续对齐", "修改当前 Spec", "退出 Task", "Exit"]
      : ["继续对齐", "退出 Task", "Exit"];
  }
  // executing 阶段:main 正在亲手跑,可确认完成后进 review
  if (state.phase === "executing") {
    return ["进入复盘", "停止本次执行", "Exit"];
  }
  // reviewing 阶段:复盘产 skill+verify
  if (state.phase === "reviewing") {
    return ["自动保存并自证", "继续复盘", "放弃", "退出 Task", "Exit"];
  }
  // landed 或未启用:主菜单
  return ["新建任务", "运行 taskbook", "编辑 taskbook", "列出 taskbook", "Exit"];
}
```

菜单中文项 → 英文 action 映射(照搬 Judge 的 `resolveJudgeCommandArgs` 模式):

```typescript
"新建任务"           → "new"        // → enableTask(ctx) 进入 planning
"开始执行"           → "execute"    // → 进入 executing
"继续对齐"           → "clarify"    // → 继续 planning
"修改当前 Spec"      → "change-spec"
"运行 taskbook"      → "run"
"编辑 taskbook"      → "edit"
"重命名 taskbook"    → "rename"    // → handleTaskRename 改目录 + taskbook.json:name
"列出 taskbook"      → "list"
"保存为 taskbook"    → "save"
"自动保存并自证"     → "save"
"进入复盘"           → "continue-review"
"继续复盘"           → "continue-review"
"放弃"               → "abort"
"停止本次执行"       → "stop"
"退出 Task"          → "toggle"
"Exit"               → undefined
```

### 7.4 命令 handler 结构(照搬 Judge)

```typescript
pi.registerCommand("task", {
  description: "UGK task delegation system",
  handler: async (args, ctx) => {
    const resolvedArgs = await resolveTaskCommandArgs(args, ctx);
    if (resolvedArgs === undefined) return;
    const tokens = resolvedArgs.trim().split(/\s+/).filter(Boolean);
    const action = (tokens[0] ?? "").toLowerCase();
    const name = tokens[1];
    // 按 action 分发,每个分支对应一个 enable/dispatch 函数
    if (action === "new") { enableTask(ctx); return; }
    if (action === "execute") { ... return; }
    // ...
  },
});
```

**实现要点**:
- 单命令 `task`,所有子命令靠 args 解析,不注册多个命令
- 每个 action 对应一个独立处理函数(`enableTask`/`handleTaskRun`/`handleTaskSave`...),参考 Judge 的 `enableJudge`/`handleTaskbookRun`/`handleTaskbookSave`
- 危险操作(delete)在 handler 内 `await ctx.ui.confirm(...)` 二次确认

---

## 八、状态持久化与恢复

复用 Judge 的 `appendEntry` idiom:
- `persistTaskState(pi, state)` 写 `customType: "task-state"` 的 custom entry
- `session_start` 时从 `ctx.sessionManager.getEntries()` 读最后一条,恢复 state
- 子进程(worker/checker)不持久化到 task-state,只把产出落在 run 目录
- 重启时如果 state.phase 是 `executing`,提示用户继续或退出(不自动恢复 worker 执行,因为 one-step 任务重跑成本低)
- **session 恢复**:task state 持久化在 session JSONL 里,但需要用 `ugk -r`(resume)启动才能加载。直接 `ugk` 是新 session,task state 不会自动恢复。这是 pi 的设计,不是 bug。如果用户希望默认 resume,需要在 UGK 启动入口配置。

---

## 九、验证策略

### 9.1 第一个真实 taskbook:B 站下载

作为 dogfood 任务,完整跑一遍创造 + 复用流程,验证:
- planning 阶段 questionnaire 能对齐出合理的 Spec
- executing 阶段 main 能亲手跑通下载
- reviewing 阶段能产出 skill + verify(含 ffprobe 那条关键断言)+ contract
- verify 在第一次产出上确实 PASS(自证)
- `/task run bilibili-download <url>` 能跑通 worker→verify→PASS 全链路
- 故意制造失败(给坏 url),验证 checker 归因 + retry 机制

### 9.2 测试覆盖

- **task-book.ts**:落盘/加载/校验/项目级覆盖全局的 scope 合并
- **task-state.ts**:状态转换、C-2 闸、持久化/恢复
- **task-verify.ts**:verify runner 解析 PASS/FAIL、结构化失败 JSON
- **task-prompts.ts**:review prompt + taskbook JSON 解析
- **集成测试**:用 mock spawn 模拟 worker/checker,跑完整 `/task run` 流程
- **回归**:确认没破坏 Judge(questionnaire 全局工具不重复注册、Spec 解析函数没改)

---

## 十、不做的事(v1 边界)

显式列出 v1 **不做**的,避免范围蔓延:

- **multi-step 编排**:不做串联/并联,不做 DAG,不做上下游产出传递
- **动态验收**:v1 的 verify 全是静态脚本断言,不做 LLM 验收
- **taskbook 自动发现/推荐**:不主动建议"这个任务适合做成 taskbook",靠用户主动调教
- **taskbook 版本管理**:不存 skill/verify/contract 的历史版本(重新 save 覆盖内容);但 `runs[]` 运行历史不被 save 覆盖,只按 `sortAndTrimRuns` 自然淘汰到最近 10 条
- **跨机器同步**:不自动同步 `~/.pi/agent/tasks/`,用户自己用 git/syncthing
- **并发执行多个 taskbook**:v1 只支持一次跑一个 `/task run`
- **taskbook 市场/分享**:不做导出导入、不做社区分享

这些留给 v2+,等 v1 跑通、积累了 5-10 个真实 taskbook 后,再根据实际痛点决定优先级。

---

## 十一、实现顺序建议

落地时按这个顺序,每步独立可验证:

1. **task-state.ts + task-book.ts**:状态机和落盘骨架,纯函数,先写测试
2. **task.ts 注册器 + `/task list/show` 命令**:能列能看,但不跑
3. **task-prompts.ts + planning 阶段**:能 `/task new` 跟人对齐出 Spec
4. **executing 阶段**:main 接管正常 agent 流程跑一遍(这步几乎没新代码,主要是状态切换 + 工具集管理)
5. **reviewing 阶段**:TASK_REVIEW_PROMPT + questionnaire 核对 + 落盘
6. **task-verify.ts**:verify runner
7. **task-worker.ts**:worker spawn 派遣
8. **task-checker.ts**:checker spawn + retry 循环
9. **`/task run` 完整流程**:串起来
10. **dogfood**:B 站下载 taskbook 完整跑一遍

每步完成后跑对应测试,确保没破坏现有功能(尤其 Judge)。

---

## 十二、风险与对策

| 风险 | 对策 |
|---|---|
| verify 写得太软,worker 假 PASS | 设计文档明确 verify 必须覆盖正反两面 + 先在基线自证;review 阶段 questionnaire 强制核对 verify 质量 |
| skill 写得太死,worker 失去灵活性 | skill 只写"做什么"不写"怎么做";review 阶段判断是否该直接脚本化 |
| taskbook 堆多了 `/task list` 乱 | description 必填 + tags 筛选 |
| worker overfit 验收 | worker 永远不看 verify 内容,只看 contract |
| checker 跟 worker 形成循环 | retryBudget 全局上限(3 次)+ checker 持有 verdict=abort 权 |
| 环境依赖缺失(yt-dlp/ffprobe 没装) | verify 开头先 `assert(toolExists(...))`,缺工具直接 FAIL 给清晰提示 |
| 跟 Judge 命名冲突 | phase 字段完全独立,customType 用 `"task-state"` 不用 `"judge-state"`,taskbook 目录 `.tasks/` 或 `~/.pi/agent/tasks/` 不碰 `.judge/` |

---

## 设计已收敛的确认点(用户已拍板)

1. ✅ `/task` 是独立 extension,复用零件,未来淘汰 Judge
2. ✅ plan+execute 共享 context,review 用新 context
3. ✅ worker 和 checker 都是独立 subagent,不是 main
4. ✅ execute 阶段 main 刻意不派 subagent(亲手干一次)
5. ✅ 复用阶段 main 是编排代码,不是 LLM(方案 A)
6. ✅ taskbook 默认全局 `~/.pi/agent/tasks/`,支持 `--project` 存项目内
7. ✅ context 零污染:taskbook 按需加载,不预进 context
8. ✅ review 阶段 main 起草 skill+verify,人用 questionnaire 核对后落盘
9. ✅ verify 是 Node 脚本,能 spawn 任意外部工具(ffprobe/yt-dlp)
10. ✅ contract 是 worker/verify/checker 的共同语言,worker 只看 contract 不看 verify
11. ✅ v1 只做 one-step,multi-step 留 v2

---

## v1 实现注记(2026-06-22 dogfood 后更新)

v1 已实现并跑通 dogfood(`grapheme-count` taskbook:planning → executing → reviewing → landed → run PASS)。实现与最初设计的差异和补充约定如下,以代码为准。

### 实现差异(跟 2.2 / 3.2 节的微调,已在正文标注)

- **review 阶段不开新 session**,用 context filter 模拟新 context(见 2.2 节 v1 实现注记)。
- **save 保留 runs[] 历史**和 createdAt(见 3.2 节 save 语义)。

### 命令行 input 的三种方式(dogfood 后新增)

`/task save` 和 `/task run` 的 input 解析用 `split(/\s+/)`,**不支持命令行直接传带空格的 JSON**。v1 提供三种可靠方式:

1. **零参数 + 智能默认**(推荐常用场景):
   - `/task save <name>`:不传 `--output-dir` 时,自动用 execute 阶段记录的 `executeRunDir`(state 字段)做 verify 自证,不再强制弹 input。
   - `/task run <name>`:不传 input 时,按 contract.runtimeInput 字段顺序映射位置参数(`/task run foo bar` → `{field1: "foo", field2: "bar"}`),或逐字段交互式询问。
2. **`--input-file <path>`**:从 JSON 文件读 input,适合复杂/带空格/带 unicode 的值。
3. **`--input-json <base64>`**:Base64 编码的 JSON,适合脚本化调用。

`TaskState` 新增 `executeRunDir?: string` 字段,execute action 写入,save action 读取,实现"零参数自证"。

### `/task run` 完成时显示产出(dogfood 后新增)

`formatRunResult`(`task.ts:284`)在 run 完成时把产出展示进 notify:

- **PASS**:结构化显示任务、artifact 路径/大小、常见文本产物内容预览、`verify 自证: 全过`、引用块形式的 worker 摘要
- **FAIL**:结构化显示任务、失败断言(含 expected/actual)、引用块形式的 worker 摘要

不再只显示一个 PASS 标记。

### `/task run` 输出目录规则(dogfood 后新增)

默认产出仍写到本次 run 沙箱目录 `<cwd>/.tasks/runs/task-.../output`。如果 taskbook 的 `contract.outputDir` 是绝对路径,说明用户显式指定了最终交付目录,worker/verify/checker 的 `TASK_OUTPUT_DIR` 改用这个目录;run 沙箱目录仍创建用于本次运行记录。

### `/task run` 进度 widget(dogfood 后新增)

`setTaskRunWidget`(`task.ts`)在 worker/verify 阶段用 `ctx.ui.setWidget("task-run-view", ...)` 显示当前状态(尝试 N/4、worker 中/verify 中),worker 有阶段性输出时追加 `最近进展` 编号列表,run 结束清理。

运行中 `/task` 会显示停止/查看进展入口,`/task stop` 会通过 AbortSignal 请求停止 worker。用户在运行中发送普通消息时不丢弃:运行时记录为本次备注并提示可用 `/task stop` 中断。PASS/FAIL 报告会包含最近进展和运行中用户备注,用于事后复盘 worker 早期判断。

run 结束或被 `/task stop` 中断后只保留最近一次运行的复盘上下文。普通对话不会自动注入这段上下文;用户必须从 `/task` 菜单选择"复盘上次运行"。该入口先询问"你觉得刚刚的运行结果有什么问题吗?",再启动隔离 reviewer agent,只把 `[TASK RUN REVIEW]` 上下文和用户观察交给 reviewer,最后用 notify 展示复盘结论。

### `/task run` 失败后可选修正(dogfood 后新增)

`/task run` 最终 FAIL 后进入 `pendingTransition: "repair"`。用户可输入意见进入修正复盘,或在 `/task` 菜单选择"复盘上次运行 / 修正本 taskbook / 重新运行 / 查看 taskbook 详情 / 放弃"。修正复用 reviewing/save 流程,上下文包含失败断言、worker 摘要、旧 skill/verify/contract,不引入 plan mode 依赖。

### 阶段完成后直接给下一步菜单(dogfood 后新增)

planning/executing/reviewing 完成并设置 `pendingTransition` 后,TUI 上下文会立即打开同一套 `/task` 下一步菜单,例如"开始执行"、"进入复盘"、"自动保存并自证"。空 Enter 的 `input` hook 仍保留为兼容兜底,但提示文案不再要求用户按 Enter,避免终端没有提交空输入时卡住。

### `/task edit` 是更新已有 taskbook(dogfood 后新增)

`/task edit <name>` 不再进入 planning/executing 从头创建。它先询问用户要改什么(可留空,Esc 取消),再加载现有 `spec.json`、`skill.md`、`verify.mjs`、`contract.json`,直接进入 reviewing,并要求 reviewer 以用户修改点为主、基于旧内容做最小增量修改。保存默认回写原 taskbook scope,保留 `runs[]` 历史;因为没有本次 execute outputDir,更新保存不会做首次产物自证,而是提示用户重新 `/task run` 验证。

有明确修改点时,reviewer 的 questionnaire 只确认相关变化和最终补充项;未提到的旧 source/method/runtime/tool 选择默认保留,不重复追问。

### `/task show` 是 taskbook 导览工作台(2026-06-24)

`/task show <name>` 和菜单"查看 taskbook 详情"不再直接打印 `spec/skill/verify/contract` 原文。选择 taskbook 后先出现二级菜单:

- `task 导览`:启动只读 reviewer 分析现有 `spec.json`、`skill.md`、`contract.json`、`verify.mjs`,输出带编号的 taskbook 环节列表,例如来源方式、数据提取、产物契约、运行输入、工具要求、机器验证。
- `task 编辑`:复用 `/task edit` 的更新流程,先询问用户修改点,再进入 reviewing。

导览结束后提供"了解返回 / 编辑"选择。选择"编辑"时,用户输入编号和修改意见(如 `5 不要保存 html`),runtime 会把对应导览项和用户意见合并成 `UserEditRequest`,交给现有 reviewing/save 流程。编号到环节的映射由 runtime 的本地稳定摘要提供,避免 reviewer 文案格式漂移导致编辑目标错位;导览 reviewer 失败时退回本地摘要。

### skill/verify 设计先于文件书写(dogfood 后新增)

review/update/repair 阶段在输出 JSON 前必须先用 questionnaire 确认两类设计。先确认 `skill.md` 的可复用执行路径,包括 source/method、required steps、noise to omit、output path and format;再确认 `verify.mjs` 的验收设计,包括 artifacts、assertions、failure cases、runtime input、allowed variability、empty-output negative case。确认后才写文件内容,避免 agent 只盯 verify 或先脑补脚本再让用户被动接受。

如果 planning/review/save 的机器验收失败,运行时会自动 follow-up 打回负责 agent,而不是让用户手工解释格式或验证问题:

- planning 输出无法解析成 RequirementsSpec 时,打回 planner 重输完整 JSON。
- review 输出无法解析成包含 `skill`、`verify`、`contract` 的合法 taskbook JSON 时,打回 reviewer 重输机器可读 JSON。
- review 未走 questionnaire 设计门时,打回 reviewer 先核对 skill/verify/contract 设计。
- save 自证阶段发现 verify 输出格式错误、空 outputDir 也 PASS、或真实产物 verify FAIL 时,打回 reviewer 修正 taskbook。

如果 worker 复用路径需要受保护工具,review 产出的 `contract.json` 应写 `requiredTools`,例如 `["chrome_cdp", "alpha__echo"]`。老 taskbook 没有该字段时,`/task run` 只从 `skill.md` 明确提及的当前 active tools 中识别受保护工具;不会扫描整个 `contract.json` 文本,避免 artifact 名字误触发授权。

`/task save` 在真正写 taskbook 前会把 `verify.mjs` 放到临时目录自检两次:空 outputDir 作为负例,真实 execute outputDir 作为正例。负例失败时 stdout 必须是 `VerifyFailure[]` JSON 数组,不能是 `{"failures":[...]}`;如果 taskbook 声明了 artifacts 但空 outputDir 仍 PASS,也拒绝保存。

### 已知遗留(v1 不修,留 v1.1+)

- **命令行直接传带空格 JSON 不支持**:用 `--input-file` 或 `--input-json` 绕过。真要做 slash command 内的 shell-like parser 留 v1.1。
- **真实 TUI dogfood 只跑了一个 taskbook**(grapheme-count)。B 站下载等带外部工具依赖的场景未实测。
- **multi-step 编排不做**(v1 边界,见第十节)。

### session 恢复需 `ugk -r`

task state 持久化在 session JSONL(`customType: "task-state"`)。**直接 `ugk` 是新 session,state 不自动恢复;用 `ugk -r`(resume)才能加载上次的 task-state**。这是 pi 的设计,不是 bug。

### execute 工具集修正(2026-06-23)

v1 原把 execute 阶段 task-creator 的工具集写死成 `read/write/edit/bash/task_complete` 白名单,这把 chrome_cdp、mcp 等环境工具**物理屏蔽**,导致需要读 cookie 的 B 站下载等任务在创造阶段就做不下去。

**修正**:execute 阶段继承 main session 的全部工具(含动态注册的 chrome_cdp/mcp),只排除 subagent。实现用 `applyExecuteTools`(`extensions/task/task.ts`):从 task 进入前的 active snapshot 或当前 active set 减 subagent,再加 task_complete。**不用 `getAllTools()`**(会把从未在 main session 启用过的注册工具也打开)。

subagent 的禁止从"工具集隐式排除"升级为**双保险**:① `applyExecuteTools` 不把它放进 active 集;② `tool_call` 事件显式 `block: true`(spec 4.2 硬约束的可靠实现,取代原来仅靠 prompt 口头要求的脆弱方式)。这跟 worker agent(`agents/worker.md` 删 tools 字段继承全部 + prompt 禁 subagent)的做法对齐。

此前 planning/reviewing 阶段共用只读工具集(`TASK_PLANNING_TOOLS` + bash 命令白名单)。2026-06-24 后 planning 改为 C-3 探索性 bash;reviewing 仍保持只读语义。

### planning 保持 write/edit 禁用 + 探路引导(2026-06-24)

planning 阶段不放开写权限(与 executing 区分)。若 planner 需要实际跑写命令/做实现才能判断验收标准是否可行,`TASK_ALIGN_PROMPT`(`task-prompts.ts`)会引导它先用 questionnaire 跟用户确认进入 executing 阶段——探路产出可复用,且不污染 planning 的对齐 context。探索性 bash 见下方 C-3;若改为放开全部工具(C-2)需用户拍板并同步更新本节与 4.1 节。

### planning 探索性 bash 放开(C-3,2026-06-24)

原 C-1 设计:planning bash 只放行 `isSafeCommand` 白名单(cat/grep/ls/git status 等)。dogfood 发现 planner 无法用 `node script.js`/`npm test`/`python foo.py` 验证方案可行性,被迫频繁跳 executing 探路再回来,打断对齐。

C-3 调整:planning bash 改为"非破坏即放行"(`isPlanningAllowedCommand`),放开探索性命令(跑脚本/测试/构建),但继续拦截留持久副作用的命令(写盘、npm install、git 变更、重定向)。write/edit 工具仍禁。reviewing 阶段不受影响(仍走只读集)。

边界:这是 C-1 和 C-2 之间的中间档——保留"planner 不动手做"的对齐价值,只补"能跑命令看输出"的探路能力。

### `/task rename` 改名(2026-06-24)

新增 `renameTaskbook`(`task-book.ts`):`fs.rename` 原子改目录 + 改 `taskbook.json` 的 `name` 字段,保留 `createdAt`/`runs[]`。`spec.json`/`skill.md`/`verify.mjs`/`contract.json` 内部不存名字,内容文件零修改。接线 `/task rename <old> <new>` 和菜单"重命名 taskbook"。约束:仅原 scope 内改名(不跨 user/project),目标名已存在或新旧同名则拒绝;`/task rename` 不带 `<new>` 时 `ctx.ui.input` 交互询问。`.tasks/runs/task-<name>-<ts>/` 是一次性目录、不按名反查,改名不影响历史 run 目录。


### `/task run` 受保护工具预授权(2026-06-23)

`/task run` 的 worker 是 `--no-session` 子进程,不会继承父会话里 `/cdp ask` 或 `/mcp ask` 的"本会话允许"内存状态。需要 CDP/MCP 的 taskbook 如果直接让子进程自己弹确认,非交互 worker 会 fail-close,表现为 worker 没做完、产物缺失。

**修正**:`/task run` 启动 worker 前,从当前 active tools 与 taskbook 声明交叉匹配受保护工具:

- `chrome_cdp`: taskbook 的 `contract.requiredTools`/`protectedTools` 或 skill/contract 文本明确提到,且当前 active tools 含 `chrome_cdp`
- MCP: 当前 active tools 中形如 `server__tool` 的工具,且 taskbook 明确提到该 registered tool name

命中后主进程只问用户一次:"允许本次 task 使用受保护工具?"。用户同意后,只给本次 worker 子进程传 env:

- `UGK_TASK_ALLOW_CHROME_CDP=1`
- `UGK_TASK_ALLOW_MCP_TOOLS=server__tool,...`

这个授权不改变 `/cdp` 或 `/mcp` 全局模式,也不打开 taskbook 没声明的工具。用户拒绝时 worker 不启动,避免进入"等确认但没人能点"的失败路径。
