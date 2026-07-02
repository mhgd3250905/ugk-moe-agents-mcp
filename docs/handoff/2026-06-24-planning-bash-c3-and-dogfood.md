# 交接:planning 探索性 bash 放开(C-3)+ 真实 TUI dogfood

> **生成时间**:2026-06-24
> **交付对象**:接手开发的同事(**之前没接触过本项目,本文含完整项目上下文**)
> **仓库**:`E:\AII\ugk-core`
> **分支**:`main`(HEAD `3ac2feb`,已推送 origin/main)
> **测试基线**:`npm test` = 456 pass / 0 fail
> **两件事相互独立**:任务一改代码,任务二只跑不改。可一人全做,也可分给两人。

---

## 0. 这个项目是什么(必读,5 分钟)

**ugk-core**(代号 **UGK**)是一个终端编码 agent,基于 [pi](https://github.com/earendil-works/pi)(一个开源 coding agent 框架 `pi-coding-agent`)定制,定名 **ugk-pi-agent**。用户 `npm i -g ugk-agent` 装完,终端打 `ugk` 就能跟它对话写代码。

**项目最高优先级文档是 `AGENTS.md`(仓库根目录)** —— 角色、能力清单、约定、运行时发行策略全在里面,开工前必读。下面只摘这次任务用得到的。

### 0.1 这次要碰的核心模块:task 扩展

UGK 有个 `/task` 命令,让用户把"固定的一次性任务"沉淀成可复用的 **taskbook**(= 需求规格 + 操作指引 + 机器验收脚本 + 产出契约)。创建一个 taskbook 走四阶段:

```
planning → executing → reviewing → landed
对齐需求    动手做一遍   复盘产文档   taskbook 就绪
```

代码都在 `extensions/task/`(`task.ts` 主文件,`task-utils.ts` 工具函数,`task-prompts.ts` prompt 文案,`task-book.ts` 落盘)。

### 0.2 必须遵守的硬约定(违反会出事)

- **bash 工具走 Git Bash**(`D:\Git\bin\bash.exe`),命令一律用 Linux 语法,Windows 路径用正斜杠 `/`。
- **UGK 固定 pi 版本**:pi 是 UGK 的内部 runtime,`package.json` 里钉死 `@earendil-works/*` 都是 `0.79.4`。**不要让用户跑 `pi update`**,pi 升级只能靠 UGK 发新版本。
- **绝对不要直接改 `node_modules/`** 里的文件(改了 npm 升级会丢)。所有 pi 行为修正走 `bin/ugk-*.js` patch 机制(在 `bin/ugk.js` 启动时安装,仿 `installUgkSessionViewPatch` 的 idempotent 范式:`Symbol.for()` 守卫 + proto 包装 + 失败 `console.warn`)。
- **改 task 模块核心函数签名或状态机** → 必须同步更新 `docs/design/subtask-extension-spec.md`;**改 taskbook schema** → 更新 `docs/judge.md`。
- **危险操作前确认**(`rm -rf`/`sudo`/`chmod 777` 已挂权限门)。
- **本任务改完不要 commit/push**,改完发修改报告回来,由这边 review + 文档对齐 + commit。

### 0.3 怎么跑测试

```bash
npm test                              # 全量,当前 456 pass / 0 fail
node --test tests/task-extension.test.ts   # 单个文件
node --test tests/task-utils.test.ts       # 任务一要新建这个文件
```

> 命令在仓库根目录跑。bash 工具若报 WSL 错,见 README "Windows 用户:修复 bash 工具"一节,把 Git Bash 路径写进 `%USERPROFILE%\.pi\agent\settings.json`。

---

# 任务一:放开 planning 阶段的探索性 bash(方案 C-3)

## 1.1 为什么要做(一句话)

用户反馈:task 规划阶段(`planning`)planner 想用 bash 跑脚本/测试验证方案可行性(比如 `node build.js`、`npm test`、`python parse.py`),但被拦死了。**用户要的不是"放开全部写权限",而是"能跑命令看输出去探路"**。所以做精准中间档 **C-3**,不是原设计文档里的 C-2(全开)。

## 1.2 根因(已逐行确认,不用你再查)

两层 gate 卡住了 planning 的 bash:

**第一层:工具集**(`extensions/task/task.ts:40`)
```typescript
const TASK_PLANNING_TOOLS = ["read", "bash", "grep", "find", "ls", "questionnaire"];
```
**bash 本来就在里面**,工具没被禁。所以根因不在这一层。

**第二层:bash 命令白名单 hook**(`extensions/task/task.ts:1429-1435`)
```typescript
if (state.phase !== "planning" || event.toolName !== "bash") return undefined;
const command = event.input.command as string;
if (isSafeCommand(command)) return undefined;   // ← 命中白名单才放行
return {
    block: true,
    reason: `Task planning: command blocked (not read-only). Command: ${command}`,
};
```

**第三层:`isSafeCommand` 实现**(`extensions/task/task-utils.ts:163-167`)
```typescript
export function isSafeCommand(command: string): boolean {
    const isDestructive = DESTRUCTIVE_PATTERNS.some((pattern) => pattern.test(command));
    const isSafe = SAFE_PATTERNS.some((pattern) => pattern.test(command));
    return !isDestructive && isSafe;   // 必须命中白名单才放行
}
```
逻辑是"非破坏 **且** 命中白名单"。问题在两个 pattern 数组:
- `DESTRUCTIVE_PATTERNS`(`task-utils.ts:17-54`)里 **line 51**:`/(^|[|;&])\s*(sh|bash|zsh|fish|pwsh|powershell|cmd|node|python|python3|perl|ruby)\b/i` —— 把 `node`/`python`/`bash` 开头全标成破坏性。
- `SAFE_PATTERNS`(`task-utils.ts:56-107`)只列了 `cat`/`grep`/`ls`/`git status`/`npm list` 这种纯只读命令。

**结论**:要跑 `node build.js`、`npm test`、`python foo.py`,要么被"命中 node/python 破坏性 pattern"挡,要么被"不在白名单"挡,全过不去。

## 1.3 设计取舍:C-3 是什么(理解了再动手)

| | C-1(现状) | **C-3(本任务)** | C-2(放弃) |
|---|---|---|---|
| write/edit 工具 | 禁 | **禁** | 开 |
| 探索性 bash(`node`/`npm test`/`python`/`npm run`) | 拦 | **放行** | 放行 |
| 破坏性 bash(`rm`/`git commit`/`npm install`/重定向 `>`) | 拦 | **仍拦** | 放行 |
| 对齐价值(planner 不直接动手改代码) | 保 | **保** | 失 |

**C-3 的核心洞察**:planner 要验证方案可行性,需要的是"**跑命令看输出**",不是"改文件"。放开跑脚本/测试,但继续拦"会留下持久副作用的命令"(写盘、装包、git 变更、删文件)。这样 planner 能 `node -e "..."` 试个 API、跑测试看现状、跑构建确认链路,但**产不出任何落地产物**——要落产物只能进 executing,对齐价值不丢。

## 1.4 实现方案(改一个文件为主:`extensions/task/task-utils.ts`)

思路:把 planning 的判定从"命中白名单"改成"**非破坏即放行**",同时用更严的破坏性 pattern 集兜底。

### 改动 1:`extensions/task/task-utils.ts` 新增 `PLANNING_DESTRUCTIVE_PATTERNS`

在现有 `DESTRUCTIVE_PATTERNS` 数组(line 17-54)**之后**新增一个独立数组。关键:**相比原 `DESTRUCTIVE_PATTERNS`,删掉了 line 51 那条 `node`/`python`/`bash` 开头的拦截**(那正是卡探索性脚本的),其余写盘/git/包管理/系统类保留并扩充。

```typescript
// planning 阶段放开探索性 bash(跑脚本/测试/构建验证方案),但仍拦截留持久副作用的命令。
// 不再依赖 SAFE_PATTERNS 白名单(那是 C-1 只读语义);改为"非破坏即放行"。
const PLANNING_DESTRUCTIVE_PATTERNS = [
    // === 写盘 / 变更文件系统 ===
    /\brm\b/i, /\brmdir\b/i, /\bmv\b/i, /\bcp\b/i, /\bmkdir\b/i, /\btouch\b/i,
    /\bchmod\b/i, /\bchown\b/i, /\bchgrp\b/i, /\bln\b/i, /\btee\b/i, /\btruncate\b/i,
    /\bdd\b/i, /\bshred\b/i,
    /(^|[^<])>(?!>)/, />>/,                          // 输出重定向(写文件)
    /\bunzip\b/i, /\btar\s+.*(-x|--extract)/i,       // 解压(可能覆盖)
    // === 包管理(装/卸/升)===
    /\bnpm\s+(install|uninstall|update|ci|link|publish)/i,
    /\byarn\s+(add|remove|install|publish)/i,
    /\bpnpm\s+(add|remove|install|publish)/i,
    /\bpip\s*(install|uninstall)/i, /\bpip3\s*(install|uninstall)/i, /\buv\s+(pip\s+)?install/i,
    /\bapt(-get)?\s+(install|remove|purge|update|upgrade)/i,
    /\bbrew\s+(install|uninstall|upgrade)/i, /\bcargo\s+(install|publish)/i,
    // === git 变更 ===
    /\bgit\s+(add|commit|push|pull|merge|rebase|reset|checkout|switch|stash|cherry-pick|revert|tag|init|clone|clean|restore)/i,
    /\bgit\s+branch\s+-[dD]/i, /\bgit\s+worktree\s+(add|remove)/i,
    // === 进程 / 系统 / 权限 ===
    /\bsudo\b/i, /\bsu\b/i, /\bkill\b/i, /\bpkill\b/i, /\bkillall\b/i,
    /\breboot\b/i, /\bshutdown\b/i, /\bpoweroff\b/i,
    /\bsystemctl\s+(start|stop|restart|enable|disable)/i,
    /\bservice\s+\S+\s+(start|stop|restart)/i,
    // === 编辑器 / 持久 REPL ===
    /\b(vim?|nano|emacs|code|subl)\b/i,
    // === 危险网络下载到盘 ===
    /\bcurl\b.*(^|\s)(-o|--output|-O|--remote-name|--upload-file|-T)(\s|=|$)/i,
    /\bwget\b/i,                                      // wget 默认写盘
    /\bcurl\b.*(^|\s)(-d|--data|--data-raw|--data-binary|-F|--form|-X|--request)(\s|=|$)/i,
];
```

> **注意**:相比原 `DESTRUCTIVE_PATTERNS`(line 17-54),这里**删掉了 line 51 的 `/(^|[|;&])\s*(sh|bash|...|node|python|...)\b/i`** —— 这条删掉后 `node script.js`/`python foo.py`/`bash run.sh` 才能跑。其余写盘/git/包管理/系统类都保留并扩充。

### 改动 2:`extensions/task/task-utils.ts` 新增判定函数

在现有 `isSafeCommand` 函数(line 163-167)**下方**新增(不要改 `isSafeCommand` 本身):

```typescript
// planning 阶段判定:非破坏即放行(不再要求命中白名单)。
// 对比 isSafeCommand 的"非破坏 且 命中白名单"(C-1 只读语义)。
export function isPlanningAllowedCommand(command: string): boolean {
    return !PLANNING_DESTRUCTIVE_PATTERNS.some((p) => p.test(command));
}
```

### 改动 3:`extensions/task/task.ts` 接线 hook

**`extensions/task/task.ts:1429-1435`** 改成:

```typescript
if (state.phase !== "planning" || event.toolName !== "bash") return undefined;
const command = event.input.command as string;
if (isPlanningAllowedCommand(command)) return undefined;   // ← C-3:探索性放行
return {
    block: true,
    reason: `Task planning: command blocked (destructive or side-effecting). Command: ${command}`,
};
```

import 行(`task.ts:7` 附近,从 `./task-utils.ts` 的 import):把 `isSafeCommand` 换成 `isPlanningAllowedCommand`。

> ⚠️ **改之前先 grep 确认**:`grep -n "isSafeCommand" extensions/task/task.ts`,看 task.ts 里除 hook 这一处外还有没有别处用 `isSafeCommand`。若没有了,就从 import 删掉它(但 `task-utils.ts` 里的 `isSafeCommand` **函数本身保留不删**,别的模块可能在别处复用)。

### 改动 4:`extensions/task/task-prompts.ts` 更新 prompt 文案

**`task-prompts.ts:6-8`** 的 `TASK_ALIGN_PROMPT` 里:

```typescript
// 原(第 6-8 行):
- Keep tool use read-only: read, bash, grep, find, ls, questionnaire.
- Do not implement, edit files, run the requested work, or start subagents.
- If you need write-capable commands or real implementation probing to judge feasibility, 先用 questionnaire 跟用户确认进入 executing 阶段探路.

// 改成:
- Tool use is exploration-only: read, bash, grep, find, ls, questionnaire. write/edit are disabled.
- bash lets you run scripts/tests/builds to verify feasibility (node, npm test/run, python, etc.), but commands that leave persistent side-effects (file writes, npm install, git mutations, redirects like >) are blocked.
- Do not edit files or start subagents in this phase. If you need to actually produce artifacts or modify code, 先用 questionnaire 跟用户确认进入 executing 阶段.
```

> 目的:消除 planner 输出"我只能用读操作"那种困惑性措辞,改成"exploration-only",并明确"可跑脚本验证,但不能留产物"。

### 改动 5:文档同步(两处)

**`docs/design/task-extension-spec.md`**:

- **2.1 阶段总览表**(line 54)planning 行的"主要工具/机制"列:
  - 原:`questionnaire + Spec 解析`
  - 改:`questionnaire + Spec 解析(探索性 bash 可跑脚本/测试验证可行性,write/edit 禁用,破坏性命令仍拦)`
- **4.1 角色定义表**(line 272)task-creator 行工具说明:
  - 原:`planning 只读;executing 继承 active tools,只排除 subagent`
  - 改:`planning 探索性只读(write/edit 禁,bash 可跑脚本/测试但拦破坏性命令);executing 继承 active tools,只排除 subagent`
- **末尾追加注记**(仿 line 583 "v1 实现注记"格式):

```markdown
### planning 探索性 bash 放开(C-3,2026-06-24)

原 C-1 设计:planning bash 只放行 `isSafeCommand` 白名单(cat/grep/ls/git status 等)。dogfood 发现 planner 无法用 `node script.js`/`npm test`/`python foo.py` 验证方案可行性,被迫频繁跳 executing 探路再回来,打断对齐。

C-3 调整:planning bash 改为"非破坏即放行"(`isPlanningAllowedCommand`),放开探索性命令(跑脚本/测试/构建),但继续拦截留持久副作用的命令(写盘、npm install、git 变更、重定向)。write/edit 工具仍禁。reviewing 阶段不受影响(仍走只读集)。

边界:这是 C-1 和 C-2 之间的中间档——保留"planner 不动手做"的对齐价值,只补"能跑命令看输出"的探路能力。
```

**`docs/reports/2026-06-23-task-execute-tools-review.md`** 第五节(line 145):"未做的事"里 "没改 planning/reviewing 工具集" 这条更新为"已部分调整:planning 放开探索性 bash(C-3,详见 spec 注记),reviewing 仍只读"。

## 1.5 必须注意的坑

1. **绝对不要动 `extensions/plan-mode-utils.ts` 的 `isSafeCommand`**。那是另一个文件,被 `/plan` 命令(`extensions/plan-mode.ts:157`)和 Judge aligning(`extensions/judge/judge-utils.ts` re-export,`judge.ts:1145`)在用,语义是"纯只读探索",**这两个场景不该放开**(`/plan` 是只读计划模式;Judge aligning 只做对齐,更不该跑脚本)。task 有自己那份 `isSafeCommand`(`task-utils.ts:163`),**只改 task 的这份**。
2. **`isSafeCommand` 函数本身别删**(task-utils.ts:163),只新增 `isPlanningAllowedCommand`。原函数可能将来复用,删 export 有风险。
3. **`node`/`python`/`bash` 开头的破坏性 pattern 被删了**,但 `npm install`、`git commit`、`>` 重定向仍在新的 `PLANNING_DESTRUCTIVE_PATTERNS` 里。planner 可以 `node foo.js` 但不能 `node foo.js > out.txt`(后者命中重定向 pattern)。这是有意的——验证用 stdout 看就够,不需要落盘。
4. **管道 `|` 放开了**:原 line 51 pattern 用 `(^|[|;&])` 锚定,`echo foo | node` 会被命中而拦。删了这条 pattern 后,`cat data.json | node -e "..."` 现在合法。符合"探索性"语义,没问题。
5. **reviewing 阶段行为不变**:确认 `task.ts:1429` 的条件是 `state.phase !== "planning"` —— reviewing 阶段 phase 不是 planning,直接 return undefined 放行所有 bash(它只靠工具集 `TASK_PLANNING_TOOLS` 限制成 read/bash)。**C-3 不改变 reviewing**。
6. **测试文案同步**:现有测试 `tests/task-extension.test.ts:265-279` 用 `npm install` 验证 block,`npm install` 在新 pattern 集里**仍被拦**,所以断言 `block: true` 不用改,但 **reason 文案变了**(line 276),要把 expected reason 同步改成新文案 `"Task planning: command blocked (destructive or side-effecting). Command: npm install"`。

## 1.6 测试要求

### 新增测试一:`tests/task-extension.test.ts`(仿现有 line 265 那条)

```typescript
test("task planning allows exploratory bash (node/npm test/python) under C-3", async () => {
    const { pi, commands, handlers } = makePi();
    const { ctx } = makeCtx();
    registerTask(pi as any);
    await commands.get("task").handler("new", ctx);
    // 进 planning 的套路参考现有 line 266-271 的测试

    // 探索性命令应放行(返回 undefined = 不 block)
    for (const cmd of ["node build.js", "npm test", "npm run lint", "python parse.py", "node -e \"console.log(1)\""]) {
        const result = await handlers.get("tool_call")![0]({ toolName: "bash", input: { command: cmd } }, ctx);
        assert.equal(result, undefined, `${cmd} should be allowed in planning under C-3`);
    }
    // 破坏性命令仍拦
    const blocked = await handlers.get("tool_call")![0]({ toolName: "bash", input: { command: "npm install" } }, ctx);
    assert.equal(blocked?.block, true);
    // 写盘重定向仍拦
    const redirectBlocked = await handlers.get("tool_call")![0]({ toolName: "bash", input: { command: "echo x > out.txt" } }, ctx);
    assert.equal(redirectBlocked?.block, true);
    // git 变更仍拦
    const gitBlocked = await handlers.get("tool_call")![0]({ toolName: "bash", input: { command: "git commit -m x" } }, ctx);
    assert.equal(gitBlocked?.block, true);

    await commands.get("task").handler("exit", ctx);
});
```

> 进 planning 的具体 setup(怎么触发 `phase === "planning"`)看现有 line 265-279 那条测试是怎么做的,照搬。

### 新增测试二:`tests/task-utils.test.ts`(新建文件)

```typescript
import test from "node:test";
import assert from "node:assert/strict";
import { isPlanningAllowedCommand, isSafeCommand } from "../extensions/task/task-utils.ts";

test("isPlanningAllowedCommand allows exploratory commands (C-3)", () => {
    // 探索性:放行
    assert.equal(isPlanningAllowedCommand("node build.js"), true);
    assert.equal(isPlanningAllowedCommand("npm test"), true);
    assert.equal(isPlanningAllowedCommand("npm run lint"), true);
    assert.equal(isPlanningAllowedCommand("python parse.py"), true);
    assert.equal(isPlanningAllowedCommand("cat data.json | node -e \"\""), true);
    assert.equal(isPlanningAllowedCommand("grep foo README.md"), true);   // 原只读命令也仍放行
    assert.equal(isPlanningAllowedCommand("git status"), true);
});

test("isPlanningAllowedCommand blocks side-effecting commands (C-3)", () => {
    assert.equal(isPlanningAllowedCommand("npm install"), false);
    assert.equal(isPlanningAllowedCommand("git commit -m x"), false);
    assert.equal(isPlanningAllowedCommand("echo x > out.txt"), false);
    assert.equal(isPlanningAllowedCommand("rm file.txt"), false);
    assert.equal(isPlanningAllowedCommand("mkdir foo"), false);
    assert.equal(isPlanningAllowedCommand("wget https://x.com/a"), false);
    assert.equal(isPlanningAllowedCommand("node build.js > out.log"), false);  // 重定向写盘
});

test("isSafeCommand keeps original C-1 read-only semantics (unchanged)", () => {
    // 确认原 isSafeCommand 语义没被波及(它给别处用)
    assert.equal(isSafeCommand("node build.js"), false);   // 原语义:node 不在白名单
    assert.equal(isSafeCommand("git status"), true);
});
```

## 1.7 验证

按顺序跑,全过才算完:

```bash
node --test tests/task-utils.test.ts            # 新建文件,3 条全过
node --test tests/task-extension.test.ts        # 含 C-3 新测试 + 原 reason 文案改后全过
# 回归确认没波及 Judge / plan-mode(这两者用的是 plan-mode-utils.ts 那份 isSafeCommand,没动):
node --test tests/judge-extension.test.ts tests/judge-utils.test.ts tests/plan-mode-utils.test.ts
npm test                                          # 全量 ≥ 456 pass / 0 fail
```

最后 `git diff --check` 确认无 whitespace 错。

## 1.8 开工前自检清单

- [ ] `npm test` 基线确认(456 pass / 0 fail)
- [ ] `grep -n "isSafeCommand\|isPlanningAllowedCommand" extensions/task/task.ts extensions/task/task-utils.ts` 确认引用点
- [ ] 确认 `task.ts:1429` 之外 task 模块内没有别处调 `isSafeCommand`
- [ ] 确认 reviewing 阶段不经 hook(line 1429 条件),C-3 不改 reviewing 行为
- [ ] 改完**不要 commit/push**,发报告回来 review

## 1.9 改动文件清单

| 文件 | 改动 |
|---|---|
| `extensions/task/task-utils.ts` | 新增 `PLANNING_DESTRUCTIVE_PATTERNS` + `isPlanningAllowedCommand`;`isSafeCommand` 原样保留 |
| `extensions/task/task.ts` | line 1429-1435 hook 换用 `isPlanningAllowedCommand`;import 更新;line 1434 reason 文案改 |
| `extensions/task/task-prompts.ts` | `TASK_ALIGN_PROMPT` line 6-8 文案改"exploration-only" |
| `tests/task-extension.test.ts` | line 265 测试 reason 文案同步;新增 C-3 放行测试 |
| `tests/task-utils.test.ts`(新) | `isPlanningAllowedCommand` 单测 |
| `docs/design/task-extension-spec.md` | 2.1 表、4.1 表、末尾注记 |
| `docs/reports/2026-06-23-task-execute-tools-review.md` | 第五节"未做"更新 |

---

# 任务二:真实 TUI dogfood(只跑不改,验证上轮交付)

## 2.1 背景

上一轮(已 commit)交付了三项:**① overlay-spinner patch**(extension selector/input 打开时暂停 `Working...` spinner,解决输入闪烁);**② `/task rename`**(改 taskbook 名);**③ review-last-run widget**(复盘时显示"分析中"反馈)。

这三项**只过了单元测试**(mock 了 hook 调用),mock 覆盖不到真实终端的:**① 中文输入法合成;② 终端光标重定位;③ 真实目录改名的肉眼效果**。本任务就是在真实 TUI 里手动跑一遍,catch 单测看不到的问题。

**这个任务不改任何代码**,只在 UGK TUI 里操作 + 记录现象。发现问题就把现象记下来回报,由这边定位。

## 2.2 怎么启动 UGK TUI

仓库本身就是 UGK 源码。开发态跑 TUI:

```bash
# 仓库根目录
node bin/ugk.js
# 或如果全局装过 ugk-agent,直接
ugk
```

> 进 TUI 前如果 bash 工具报 WSL 错,按 README "Windows 用户:修复 bash 工具"一节,把 Git Bash 路径写进 `%USERPROFILE%\.pi\agent\settings.json`。这个跟本任务无关,但会影响你能不能顺利操作。

## 2.3 验证项 1:overlay-spinner patch(中文输入不闪)

**目标**:验证弹 questionnaire 时打中文不闪。

**步骤**:
1. 启动 UGK TUI。
2. 触发会弹 questionnaire 的场景:最直接的是 `/task new`,planning 阶段 planner 会调 questionnaire。
3. 等 questionnaire 弹出(overlay Input 出现)。
4. **在 Input 里打中文**:用输入法打一段中文(比如"我需要下载 B 站视频"),观察输入候选框和已输入文字。
5. 此时 agent 还在跑(`Working...` 本应在转)。

**预期(正常)**:
- 打字过程中文字**不闪烁**。
- 输入法候选框位置稳定。
- 提交后 overlay 关闭,`Working...` spinner 恢复转动。

**异常(需记录)**:
- 文字/候选框每 ~80ms 抖一下 → patch 没生效或 IME 场景有盲区。
- spinner 关了不回来 → `setWorkingVisible(true)` 恢复逻辑有 bug。
- overlay 关闭后光标位置错乱 → 光标重定位竞态。

**记录**:截图/录屏 + 描述现象 + 是否复现"原 bug(闪烁)"。

## 2.4 验证项 2:`/task rename` 真实目录改名

**目标**:验证交互菜单改名在真实 TUI 里工作正常。

**前置**:得有一个测试用 taskbook。可以 `/task new` 创建一个(随便对齐到完成),或用一个已存在的。

**步骤**:
1. `/task` → 菜单选"重命名 taskbook"。
2. 选要改名的 taskbook。
3. 在 Input 里输入新名。**重点测三种**:
   - **正常名**(如 `my-task-v2`)→ 应成功。
   - **带空格的非法名**(如 `my task`)→ 应被 `isValidTaskbookName` 拒绝,notify 报错。
   - **已存在的同名** → 应拒绝覆盖。
4. 改名后 `/task list` 确认旧名消失、新名出现。
5. `/task show <新名>` 确认 `runs[]` 和 `createdAt` 还在、`updatedAt` 变了。

**预期**:非法名/同名拒绝,旧 taskbook 原样不动;正常改名成功且历史保留。

**异常(需记录)**:改名后 `/task list` 仍显示旧名、JSON 没更新、runs 历史丢失、Windows 跨盘报 EXDEV 等。

## 2.5 验证项 3:review-last-run widget 反馈

**目标**:验证复盘时等待期间有"分析中"反馈,不再像卡住。

**前置**:得有一个 landed 的 taskbook 并跑过一次(这样才有"上次运行"可复盘)。若没有,先 `/task new` 走完一个完整流程(对齐→执行→复盘→保存),再 `/task run <name> <input>` 跑一次。

**步骤**:
1. 先跑一个 taskbook:`/task run <name> <input>`,等它跑完 PASS。
2. `/task` → 菜单(idle 态)应出现"复盘上次运行"选项。
3. 选"复盘上次运行" → 弹 Input 问"你觉得刚刚的运行结果有什么问题吗?"。
4. 输入一句复盘(比如"输出文件命名不太对")回车。

**预期(正常)**:
- 提交后**立即**看到 widget:两行"📋 正在复盘 taskbook '...'..."和"reviewer 分析中,请稍候"。
- 等待十几秒(reviewer 子进程跑),期间 widget 一直在。
- reviewer 返回后 widget 消失,notify 显示复盘结果。

**异常(需记录)**:
- 提交后没有任何提示,像"卡住" → widget 没显示(可能 `setWidget` 在非流式 handler 场景不生效)。
- widget 残留不消失 → `finally` 清理没执行。

## 2.6 反馈格式

跑完三项,用这个格式回报(方便这边对照定位):

```
## dogfood 结果(日期)
### 验证项 1 overlay-spinner
- 状态:✅ 通过 / ⚠️ 部分问题 / ❌ 复现原 bug
- 现象:...(若有问题,描述+截图)
### 验证项 2 rename
- 状态:...
- 现象:...
### 验证项 3 review widget
- 状态:...
- 现象:...
### 其他发现
- ...
```

---

# 附:关键文件与行号(开工时以当前 `git blame` 为准,行号可能漂移)

| 文件 | 关键位置 | 用途 |
|---|---|---|
| `extensions/task/task.ts` | `TASK_PLANNING_TOOLS:40`、`bash hook:1429-1435` | 任务一改 hook |
| `extensions/task/task-utils.ts` | `DESTRUCTIVE_PATTERNS:17-54`、`SAFE_PATTERNS:56-107`、`isSafeCommand:163-167` | 任务一加新 pattern + 新函数 |
| `extensions/task/task-prompts.ts` | `TASK_ALIGN_PROMPT:6-8` | 任务一改文案 |
| `tests/task-extension.test.ts` | `planning blocks bash 测试:265-279` | 任务一改 reason + 加测试 |
| `extensions/plan-mode-utils.ts` | `isSafeCommand:100` | **任务一不要碰**(`/plan` + Judge 用) |
| `docs/design/task-extension-spec.md` | `2.1 表:54`、`4.1 表:272` | 任务一文档同步 |
| `bin/ugk-extension-overlay-patch.js` | 整文件 | 任务二验证对象 |

---

# 关键文档索引(按需读)

| 路径 | 何时读 |
|---|---|
| `AGENTS.md` | **开工前必读**,项目最高优先级约定 |
| `docs/design/task-extension-spec.md` | 理解 task 四阶段设计(任务一要改这文档) |
| `docs/handoff/2026-06-24-task-rename-flicker-planning-tools.md` | 上一轮三项交付的完整报告(rename/闪烁/planning),任务二是验证它的产物 |
| `docs/reports/2026-06-23-task-execute-tools-review.md` | execute 工具集放开的历史 review,任务一要改它第五节 |

---

**一句话接手**:仓库 `E:\AII\ugk-core`,`main` 分支,456 测试全绿。任务一改 `extensions/task/` 把 planning bash 从"白名单只读"放开成"探索性放行+拦破坏性"(C-3);任务二在真实 TUI 跑一遍验证上轮三项。两件事独立。改完(任务一)或跑完(任务二)发报告回来,**不要自己 commit**。
