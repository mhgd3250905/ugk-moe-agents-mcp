# `/task` worker 工具集策略调整

> **给执行 agent 的小交接。** 改一处 agent 定义 + 一处测试断言。
>
> **你是干净 context**,本文自包含,不需要读其他文档。
>
> **更新时间**:2026-06-22

---

## 背景

UGK 的 `/task` 系统派 worker subagent 执行任务时,worker 的工具集由 `agents/worker.md` 的 frontmatter `tools` 字段决定。

当前 worker.md 显式写了 `tools: read, write, edit, bash, grep, find, ls`——这个白名单**把所有非内置工具都排除了**,包括:
- `chrome_cdp`(本地登录态 Chrome,SSO/cookie/CAPTCHA)
- 所有 MCP 工具(外部能力,动态注册的 `server__tool` 名)
- 未来新增的自定义工具

但用户的设计意图是:**worker 只禁止派 subagent(避免无限嵌套),其他环境工具(cdp/mcp 等)都应该能用**。比如 B 站下载任务,worker 需要用 `chrome_cdp` 读登录 cookie;接 MCP 数据源的任务,worker 需要用 MCP 工具。

显式白名单无法覆盖动态工具(MCP 名字运行时才知道),所以选了**做法 B:删掉 tools 字段,让 worker 继承全部默认工具,在 prompt 里禁止派 subagent**。

## 必读约束

- 始终中文(注释/commit),代码标识符用英文
- 遵守 `E:\AII\ugk-core\AGENTS.md`(bash 走 Git Bash,Linux 语法)
- **不要碰 Judge 代码**(`extensions/judge/**`、`tests/judge-*.test.ts`)
- **不要碰 smoke-tui**(`scripts/smoke-tui.mjs`、`tests/smoke-tui.test.ts`)
- **不要 `git add` 8 个未跟踪的旧 docs**(git status 里 `??` 的旧文档)
- **不要 commit、不要 stage**
- 改完跑 `npm test` 确认基线 401/401 pass(你改测试后断言数不变,只改内容)

---

## 改动 1:`agents/worker.md` 删 tools 字段 + prompt 禁止 subagent

文件:`E:\AII\ugk-core\agents\worker.md`

**当前内容**:

```markdown
---
name: worker
description: 通用执行 agent,拥有完整工具能力,在隔离 context 中完成被委派的任务
model: deepseek-v4-pro
tools: read, write, edit, bash, grep, find, ls
---

你是一个 worker agent,拥有完整工具能力。你在隔离的 context window 中工作,不污染主对话。

启用前把本文件复制到 `~/.pi/agent/agents/worker.md`。

自主完成被分配的任务,按需使用所有工具。

工作原则:
1. 先理解任务,不确定就先 grep/read 摸清现状
2. 小步改动,每步可验证
3. 改完跑一遍相关测试或 lint 确认没改坏
4. 遵循现有代码风格(命名、注释密度、缩进)
```

**改成**:

```markdown
---
name: worker
description: 通用执行 agent,拥有完整工具能力,在隔离 context 中完成被委派的任务
model: deepseek-v4-pro
---

你是一个 worker agent,拥有完整工具能力。你在隔离的 context window 中工作,不污染主对话。

启用前把本文件复制到 `~/.pi/agent/agents/worker.md`。

自主完成被分配的任务,按需使用所有工具(包括 chrome_cdp、mcp 等环境能力)。

**硬约束:不得调用 subagent 工具。** worker 嵌套派 subagent 会导致 context 树失控和无限递归风险。所有步骤必须 worker 自己用现有工具完成,需要协作的就自己做完每一步。

工作原则:
1. 先理解任务,不确定就先 grep/read 摸清现状
2. 小步改动,每步可验证
3. 改完跑一遍相关测试或 lint 确认没改坏
4. 遵循现有代码风格(命名、注释密度、缩进)
5. **禁止派 subagent**,需要的能力直接用(包括 chrome_cdp / mcp)
```

**改动要点**:
- 删 frontmatter 的 `tools:` 行(让 worker 继承全部默认工具)
- 在"自主完成被分配的任务,按需使用所有工具"后加 `(包括 chrome_cdp、mcp 等环境能力)`
- 加一段加粗硬约束:禁止派 subagent + 解释原因
- 工作原则加第 5 条:重申禁止 subagent + 可以用 cdp/mcp

---

## 改动 2:`tests/task-worker.test.ts` 同步测试断言

文件:`E:\AII\ugk-core\tests\task-worker.test.ts`

**当前第 85-90 行**:

```typescript
test("worker agent declares bounded execution tools", () => {
	const source = readFileSync(path.resolve("agents/worker.md"), "utf8");

	assert.match(source, /^tools: read, write, edit, bash, grep, find, ls$/m);
	assert.match(source, /~\/\.pi\/agent\/agents\/worker\.md/);
});
```

**改成**(测试名和断言都要改):

```typescript
test("worker agent inherits all tools and forbids subagent in prompt", () => {
	const source = readFileSync(path.resolve("agents/worker.md"), "utf8");

	// 不写 tools 字段 = 继承全部默认工具(含 chrome_cdp / mcp)
	assert.doesNotMatch(source, /^tools:/m);
	// 但必须在 prompt 里禁止 subagent
	assert.match(source, /不得调用 subagent|禁止派 subagent|禁止.*subagent/);
	// 复制提示仍在
	assert.match(source, /~\/\.pi\/agent\/agents\/worker\.md/);
});
```

**改动要点**:
- 测试名从 `declares bounded execution tools` 改成 `inherits all tools and forbids subagent in prompt`(反映新策略)
- 断言 1:从"精确匹配 tools 行"改成"tools 行不存在"(`doesNotMatch`)
- 断言 2:**新增**——确认 prompt 里有禁止 subagent 的文字(保证不会忘记写禁令)
- 断言 3:复制提示还在

---

## 验证

改完后:

```powershell
npm test
# 期望:401/401 pass(测试数不变,只改了断言内容)

git diff agents/worker.md tests/task-worker.test.ts
# 确认只改了这两个文件
```

---

## 不要做的事

- 不要改 `agents/checker.md`(checker 保持只读白名单,设计文档 4.1 节明确写 checker 只读)
- 不要碰 worker.md 的其他部分(工作原则 1-4、输出格式、"启用前把..."提示都保留)
- 不要"顺手"加 `chrome_cdp` 到 checker.md(那是另一个设计决策,本次不动)
- 不要 commit
- 不要 stage
- 不要碰其他文件

---

## 完成后的交接总结模板

```
worker 工具集策略调整完成。

改动 1(worker.md):
- 删了 frontmatter 的 tools 字段
- 加了禁止 subagent 的硬约束(加粗)
- 工作原则加了第 5 条重申

改动 2(task-worker.test.ts):
- 测试名改成 inherits all tools and forbids subagent in prompt
- 断言改成 doesNotMatch tools + match 禁止 subagent + match 复制提示

验证:
- npm test: 401/401 pass
- git diff 只触及 agents/worker.md + tests/task-worker.test.ts
```

---

## 背景:为什么用做法 B 而不是其他

完整决策过程(供执行 agent 理解上下文):

worker 的工具集有三种可能做法:

**A. 显式白名单**:`tools: read, write, edit, bash, grep, find, ls, chrome_cdp`
- 缺点:每加一个新工具都要改 worker.md;**MCP 工具名是动态的**(`server__tool` 格式),不能预先列进 frontmatter

**B. 不写 tools + prompt 禁止 subagent**(本次采用)
- 优点:worker 天然能用所有环境工具(cdp/mcp/未来新增)
- 缺点:依赖 LLM 遵守 prompt 禁令(软约束),不如 `--tools` 硬限制可靠
- 缓解:pi runtime 和 subagent.ts 本身有嵌套限制,"subagent 不能再开 subagent"是 UGK 全局规则

**C. 白名单 + 完整环境工具清单**
- 跟 A 一样,MCP 名字动态,无法列全

所以选 B。checker 保持只读白名单不动,因为 checker 的职责就是只读归因,不需要环境工具。
