---
name: subagent-guide
description: 子代理(subagent)委派指南。把任务交给隔离 context 的专用 agent 处理,主对话只收摘要。涵盖 @mention 手动触发、single/parallel/chain 三种模式、自定义 agent、随包预设 agent。当用户提到委派、subagent、子代理、并行调查、@scout、@reviewer、隔离 context、不改主对话，或明确要求用 reviewer/隔离上下文做代码审查时使用本 skill；普通代码审查不必触发。
---

# 子代理(subagent)委派指南

## 是什么

subagent = 把一个子任务交给一个**隔离 context window** 的专用 agent 处理。它在自己的 context 里读文件、跑命令、思考,**只把最终摘要返回给主对话**——主对话不会被它的工具调用和中间过程污染。

业界共识(对标 Claude Code 的 Task 工具、OpenCode 的 subagent):**"隔离 + 只回摘要"** 是保持主 context 清洁、降低 token 成本的核心机制。

## 预设 agent

| agent | 用途 | 模型 | 工具 |
|---|---|---|---|
| `scout` | 快速代码侦察,返回压缩上下文 | deepseek-v4-flash | read,grep,find,ls,bash |
| `planner` | 制定实现计划,不写代码 | deepseek-v4-pro | read,grep,find,ls |
| `reviewer` | 代码审查,给修改建议 | deepseek-v4-pro | read,grep,find,ls,bash |
| `worker` | 通用执行,全工具 | deepseek-v4-pro | 全部默认 |

---

## ✅ 预设 agent(随包自动加载)

5 个预设 agent(`scout`/`planner`/`reviewer`/`checker`/`worker`)**随包自动加载,开箱即用,无需手动复制**。

- ugk 启动时 `discoverAgents` 会读随包 `agents/` 目录(install 级),作为兜底默认。
- 若 `~/.pi/agent/agents/` 有同名 `.md`(user 级),会覆盖随包默认 —— 用这个机制做自定义。
- 优先级:`install`(随包,最低) < `user`(`~/.pi/agent/agents/`) < `project`(项目 `.pi/agents/`,最高,且需交互确认)。

**自定义预设 agent**:把改后的 `.md` 放到 `~/.pi/agent/agents/`,同名即覆盖随包默认。改完重启 ugk 生效。

---

## 用法

### 1. @mention 手动触发(最快捷,推荐)

直接在对话里打 `@<agent名> <任务>`:

```
@scout 找一下项目里的认证逻辑在哪
@reviewer 审一下我刚才的改动
@planner 给 Redis 缓存加个方案
@worker 把 utils.ts 里的重复代码抽成函数
```

`@mention` 会被拦截,改写成强制指定该 agent 的 subagent 调用。

### 2. 自然语言(让主 agent 自己决定委派)

```
用 scout 找一下所有数据库相关代码
并行跑两个 scout:一个找 model,一个找 provider
```

主 agent 会自行判断是否调 subagent 工具。

### 3. 三种模式

| 模式 | 场景 | 参数 |
|---|---|---|
| **single** | 单个任务委派 | `{ agent, task }` |
| **parallel** | 多任务并行(最多 8 个 / 4 并发) | `{ tasks: [{agent, task}, ...] }` |
| **chain** | 串行流水线,上一步输出传下一步 | `{ chain: [{agent, task}, ...] }`,task 里用 `{previous}` 占位 |

**chain 示例**(scout 找代码 → planner 出方案 → worker 实现):
```
chain: [
  { agent: "scout",   task: "找到登录相关代码" },
  { agent: "planner", task: "基于 {previous} 制定加双因素认证的方案" },
  { agent: "worker",  task: "按 {previous} 的方案实现" }
]
```

### 4. workflow 命令(预设流水线)

| 命令 | 流程 |
|---|---|
| `/implement <需求>` | scout → planner → worker |
| `/scout-and-plan <需求>` | scout → planner(只到方案,不实现) |
| `/implement-and-review <需求>` | worker → reviewer → worker |

---

## 自定义 agent

在 `~/.pi/agent/agents/` 加 `.md` 文件(frontmatter + 系统 prompt):

```markdown
---
name: my-agent
description: 干什么用的(主 agent 靠这个判断何时委派)
tools: read, grep, find, ls          # 可选,限定工具子集(安全边界)
model: deepseek-v4-pro                # 可选,指定模型
---

这里写系统 prompt,定义这个 agent 的行为。
```

- `tools` 不写 = 继承全部默认工具;写了 = 只能用列出的(只读 agent 就别给 write/edit/bash)
- `model` 不写 = 继承全局默认模型
- 也可以在 ugk 里输入 `/subagent`,选择某个 agent 后设置/清除它的 `model`
- 改完**无需重启**(agent 每次调用时重新发现),但 @mention 的 agent 名列表在启动时读一次

### 单独设置 subagent 模型

`/model` 只影响 main agent。subagent 的模型写在对应 agent `.md` 的 frontmatter 里:

```markdown
model: deepseek/deepseek-v4-flash
```

更省事的方式是在 ugk 里输入 `/subagent`,选择 agent,再选择模型。选择 `继承 main/default` 会删除该 agent 的 `model` 字段。设置后下一次 subagent 调用生效。

**project 级 agent**:放项目 `.pi/agents/*.md`,需在 subagent 工具调用时传 `agentScope: "both"` 并交互确认(安全:防仓库里的恶意 prompt 自动执行)。

---

## 工作原则(给 agent 的提示)

1. **委派时机**:探索性/产生噪音的任务(搜索、读多文件、调研)优先委派给 scout,别在主 context 里堆。
2. **只回摘要**:subagent 默认只返回最终输出(最后一条 assistant 消息),并行任务上限 50KB。这是设计如此,不是 bug。
3. **隔离即清洁**:subagent 的工具调用不会进主对话 context——这正是它的价值。
4. **运行中只看短尾**:运行中的折叠视图只显示最近几条日志;展开或完成后再看完整输出。
5. **@mention 名字要对**:必须匹配已加载的 agent 名(随包 5 个 + `~/.pi/agent/agents/` 自定义),否则 @mention 不生效(会当普通文本)。用 `/subagent` 查看当前全部可用 agent。
6. **"Unknown agent" 排查**:随包 agent 应自动可用;若报 "Unknown agent" 或可用列表为空,检查 ugk 是否最新版(老版本需手动复制),或 `~/.pi/agent/agents/` 是否放了损坏 `.md`。
7. **单层**:subagent 不能再开 subagent(业界一致,Claude Code 也是单层)。
8. **普通 review 不强行委派**:只有用户要求 `@reviewer`、隔离 context、并行审查或不污染主对话时,才用本 skill 处理代码审查。
