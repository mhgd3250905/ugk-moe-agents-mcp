---
name: task-creator
description: Use when the user wants to create a /task taskbook — whether via /task new, or directly in conversation ("帮我做个 XX 的 task", "把这个搜索能力做成 task", "我要一个能稳定复用的抓取任务"). Also when asking where taskbooks live, what files a taskbook needs, or why a task failed. Teaches storage location, five-file format, the standard flow, AND the mechanism map (what happens at each layer when /task runs), data-landing path selection, and a self-verify checklist — so the taskbook passes on the first real run without trial-and-error.
---

# Task Creator 指南

把一个已有能力（skill / 脚本 / 抓取流程）封装成可复用的 `/task` taskbook。
**这份指南告诉你存放位置、五件套格式、标准流程——不需要满仓 grep 去找。**

## 存放位置（最关键，别再乱找）

taskbook 只有两个 scope，目录就是固定的，别猜、别 find：

| scope | 目录 | 用途 |
|---|---|---|
| **user**（默认） | `~/.pi/agent/tasks/<name>/` | 跟用户走，所有项目可用 |
| **project** | `<cwd>/.tasks/<name>/` | 跟项目走，只在当前项目可用 |

- `<name>` 用 kebab-case，简短达意，如 `x-search-latest`、`bili-up-homepage-spider`。
- 创建前先 `ls ~/.pi/agent/tasks/` 看已有样本（照一个真实样本改，比凭空捏造靠谱）。
- **不要**放到 `~/.agents/`、`~/.pi/agent/skills/`、或任何 `skills/` 目录下——那是 skill 的地方，不是 taskbook 的。taskbook 和 skill 是两回事。

## 自带脚本（scripts/ 子目录，可选）

如果你已有成熟脚本（Python/Node/Shell 都行），想让它随 taskbook 走、worker 直接调用：

- 放到 taskbook 目录下的 **`scripts/` 子目录**，如 `~/.pi/agent/tasks/x-searcher/scripts/x_search.py`
- worker 运行时环境变量 **`TASK_DIR`** 会被注入为 taskbook 绝对路径
- skill.md 里这样引用：`python "$TASK_DIR/scripts/x_search.py" "{keyword}"`（**别写相对路径或裸文件名**，worker 在用户 cwd 执行，找不到）
- verify.mjs 同样能读 `$TASK_DIR/scripts/`（如需跑脚本生成预期值对比）

**不带脚本**的 taskbook 不用建 `scripts/`，零侵入。带脚本时五件套 + `scripts/` 共存，`loadTaskbook` 不读 scripts 内容（worker 自己调），只需路径约定。

## skill vs task：别复刻，要调用

skill 和 task 是两层，别混：

- **skill** = 解决一类问题的能力，独立装在 `<ugk>/skills/`（系统自带，跟包走）或 `<ugk>/user-skills/<name>/`（你装的），被任何 agent/task 复用
- **task** = 固定参数化任务的复用入口（外部输入 + 机器验收），它的活儿是**调用**能力，不是复制能力

**关键事实：worker 子进程已经能加载所有已安装的 skill。** worker 跑起来时，已装 skill 会出现在它的可用能力里（系统自带的 + user-skills 都能看到）。所以：

- **把 skill 转成 task 时，默认让 task 调用 skill，不要把 skill 的脚本/逻辑复制进 taskbook 重写。**
- task 的 skill.md 只写"调用 `<skill名>` 完成 `<目标>`"，加运行参数，不抄 skill 的实现。
- 如果被调用的 skill 需要 `chrome_cdp` / MCP 工具，在 task 的 `contract.requiredTools` 里**显式声明**——这是 worker 工具授权门和 CDP tab 隔离的数据源，写了才生效（否则 skill 的 CDP 调用会打到未隔离的共享 tab，污染数据）。

### 外部工具就绪性：声明在哪，检查在哪（别写错层）

CDP/MCP 这类「有外部依赖（要起进程/连端口）」的工具，就绪检查有**固定分层**，写错位置就是死代码：

- **声明层（`contract.json` 的 `requiredTools`）是唯一正确的位置。** 声明 `chrome_cdp` 会触发机制在 worker 子进程 spawn **之前**自动开隔离 tab；若此时 CDP 没起，机制会**自动 launch 一次受管理的 Chrome 再重试**（默认行为，`UGK_CDP_AUTOLAUNCH=0` 可关）。worker 进程一进来，tab 已就绪。
- **worker 进程内（`skill.md`）只管用工具，绝不碰「工具怎么起来的」。** **不要**写「先 `chrome_cdp status` 检查 → 没起就 `chrome_cdp action=launch` → 重试」——这是**死代码**：这些指令要执行的时刻，beforeSpawn 已经把 CDP 的事办完了（成功则 tab 就绪，失败则 task 直接异常退出，worker 子进程根本没 spawn，skill.md 一个字都跑不到）。

一句话：**task 创建者只在 `contract.requiredTools` 声明，worker 进程内不写任何工具启动/检查/重试逻辑。** `chrome_cdp action=launch` 这类调用如果出现在 task 的 `skill.md` 里，几乎肯定是写错了层。

> MCP 工具同理：声明在 `requiredTools`，机制负责连接；worker 进程内不重试 MCP 连接。

### 迁移旧 skill（含本地不兼容配置）的标准动作

源 skill 往往带别的环境的配置（Docker sidecar 桥接、`/app/runtime/` 路径、`CLAUDE_*` env）。**先把 skill 改造成本机能用、再让 task 调用它**，而不是把逻辑塞进 taskbook 重写：

1. 把 skill 装进 `<ugk>/user-skills/<name>/`（系统自带 skill 跟包走，别动）
2. 改造不兼容部分（grep 出来逐个换）：
   - Docker/web-access 桥接（`host-bridge.mjs`、`127.0.0.1:3456`、`docker:chrome`）→ 换成 `chrome_cdp` 工具
   - 容器硬编码路径（`/app/runtime/...`）→ 换成 `$TASK_DIR`（taskbook 脚本）或相对路径
   - 其他 agent 的 env（`CLAUDE_AGENT_ID`、`WEB_ACCESS_*`）→ 用标准 env 或去掉
3. 验证改造后的 skill 本身能跑（直接触发它试一次）
4. 再创建 task 调用它，`contract.requiredTools` 声明 skill 用到的受保护工具

只有当 skill 的逻辑**几乎全不兼容、改造成本超过重写**时，才退回上一节的 `scripts/` 自带脚本方案。

## 机制全景：`/task run` 时到底发生了什么（设计前必读）

不读懂这一节，设计出的 task 大概率踩坑。task 不是"写五个文件就完事"，它跑起来有一套**固定的层和职责边界**。设计时脑子里要有这张图：

```
/task run <name> <自然语言输入>
  │
  ├─ ① dispatcher agent：把自然语言翻译成 runtimeInput 的值（按 runtimeInputMeta.description）
  │
  ├─ ② 机制层 beforeSpawn（worker 进程 spawn 之前，在主进程执行）
  │     └─ contract.requiredTools 含 chrome_cdp → 自动开一个隔离 CDP tab，注入 UGK_CDP_TAB_ID
  │         · CDP 没起 → 自动 launch Chrome 再重试（UGK_CDP_AUTOLAUNCH，默认开）
  │         · 开不了 → 整 task 异常退出，worker 根本不 spawn（此时 skill.md 一个字都跑不到）
  │
  ├─ ③ worker 子进程 spawn（独立 pi 进程，上下文隔离）
  │     · 环境变量：UGK_TASK_ALLOW_CHROME_CDP=1（若声明了）、UGK_CDP_TAB_ID、TASK_DIR、TASK_OUTPUT_DIR
  │     · 工具授权：只继承声明的 requiredTools；subagent 路径主动删除这些授权（安全边界）
  │     · 读 skill.md + contract + spec → 执行 → 产出写到 $TASK_OUTPUT_DIR
  │
  ├─ ④ verify.mjs（worker 退出后，主进程执行）
  │     · 读 TASK_INPUT（runtimeInput 的 JSON）+ TASK_OUTPUT_DIR 校验产物
  │     · 失败输出 failures JSON + exit 1；通过 exit 0
  │
  └─ ⑤ task.ts 收尾：PASS/FAIL 记进 taskbook.runs，结果汇报给用户
```

### 各层职责边界（踩坑都在这里）

| 层 | 谁负责 | 你（task 设计者）该做什么 | 绝对别做什么 |
|---|---|---|---|
| **CDP/MCP 就绪** | 机制层 beforeSpawn | `requiredTools` 声明 | ❌ 在 skill.md 写 status/launch/重试（死代码，worker 没出生就跑到了） |
| **工具授权** | 机制层 env 注入 | `requiredTools` 声明 | ❌ 期望 worker 内调 subagent 读 CDP（subagent 拿不到 tab 授权） |
| **执行逻辑** | worker 进程内 skill.md | 写清"怎么做" + 调 `$TASK_DIR/scripts/` | ❌ 复刻 skill 脚本逻辑现写 |
| **数据落地** | worker 进程内（有 node fs） | 写到 `$TASK_OUTPUT_DIR/<artifact>` | ❌ 造本地 HTTP server / 浏览器下载（见下一节路径速查） |
| **机器验收** | verify.mjs | 校验产物字段/格式/一致性 | ❌ 校验"做得好不好看"（机器判不了） |

**一句话记住：task 设计者只在三个地方下功夫——`requiredTools` 声明、`skill.md` 的执行流程、`verify.mjs` 的验收契约。其余的机制都帮你做了，别去碰。**

### 一个反直觉事实：worker 是一次性进程，退出即销毁上下文

这是"为什么全量数据可以进 worker 上下文"的关键。worker 跑完就退出，上下文不累积、不共享。所以"撑爆上下文"的担心对 worker 不成立——它就是要退出。你真正要担心的只是**单次工具返回值别超限**（一次 evaluate 返回 1MB JSON 会出问题），不是"上下文会撑爆"。

## dispatcher 能力真相：它是会推理的 LLM，不是死的字段提取器

`/task run <name> <自然语言>` 时，机制会先跑一个 **dispatcher agent**（`reasoningEffort=medium` 的 LLM，见 `task-dispatcher.ts`），把自然语言翻译成 `runtimeInput` JSON，再交给 worker。**理解 dispatcher 的真实能力，是避免过度工程的关键。**

### dispatcher 能做什么（别低估）

| 能力 | 说明 |
|---|---|
| **语义提取** | "下载 https://x 上的视频" → `url=https://x`、`quality=high`，不是整句当字段值 |
| **跨语言理解** | "俩月 / 最近3小时 / 上周 / past 2 months / la semana pasada" 都能懂，**任何语言** |
| **推理 + 计算** | "上周三" → 算出具体 ISO 日期；"俩月" → 算出 60 天前到现在的 startIso/endIso；"一个季度前" → 算出具体边界 |
| **输出结构化计算值** | 不是只能搬运原文，能直接吐算好的对象（startIso/endIso、amount/unit、canonical 等） |

**dispatcher 是 LLM。** 凡是 LLM 能做的（理解、翻译、算日期、推理模糊量词），它都能做。你只需要在 `runtimeInputMeta.<field>.description` 里**教它怎么做**。

### 设计参数时的第一反应：dispatcher 能算，就别让 worker 算

这是最高频的过度工程陷阱。遇到"用户输入需要解析/转换/计算"的参数，先问自己：**dispatcher 能直接算好吗？** 能的话，加一个 runtimeInput 字段，description 教 dispatcher 算，worker 只吃结构化结果。

**反面案例（别这么干）：** 用户输入各种时间表达（俩月/上周/last week），你在 worker 里写 270 行穷举正则 + 中文数字解析 + 多语言单位映射试图覆盖所有情况。永远列举不完，而且你在 worker 里**重新发明了 dispatcher 已经有的能力**。

**正面案例：** 加一个 `timeWindow` runtimeInput 字段，description 写清"把 range 算成 {mode, amount, unit, startIso, endIso, canonical} 对象，rolling/calendar/calendar_to_now 三种模式"。dispatcher 直接吐算好的结构，worker 零解析逻辑。参考 `~/.pi/agent/tasks/x-search/contract.json` 的 `timeWindow` 字段——这是已验证的范式。

### 怎么用 description 教 dispatcher

description 是 dispatcher 的"函数签名 + 文档"。写法：

1. **定义输出结构**：清楚说明这个字段是什么类型的值（标量 / 对象 / 数组）。
2. **给出计算规则**：列出所有情况的处理方式（如"最近/过去 → rolling；上周/上月 → calendar"）。
3. **给具体例子**：在 description 里塞 2-3 个输入→输出的映射示例，LLM 照着仿。
4. **声明边界**：哪些是必填子字段、用什么单位、排他还是包含。

description 写得好，dispatcher 就准；写得含糊，dispatcher 就猜——但**猜也是 LLM 的猜，比正则强**。

### 什么时候 dispatcher 不够（退回 worker）

- **确定性要求极高**：如金额计算、加密、严格格式转换——LLM 可能算错，worker 用代码算更稳。
- **需要外部数据才能定值**：如"查 DB 拿配置再决定参数"——dispatcher 拿不到外部数据，得 worker 干。
- **极简单的字段**：如裸 URL/路径，dispatcher 原样提取即可，不用教它算什么。

除了这三种，**优先让 dispatcher 算**。worker 只吃结构化结果，不重造解析轮子。

### ⚠️ dispatcher 输出扁平标量，别让它吐嵌套对象

dispatcher 是 **medium reasoning 轻量模型**，输出**复杂嵌套 JSON 对象不可靠**——多行对象容易被 `extractRuntimeInputFromText` 的正则截断（实测被截成 `"{mode:"` 这种残片）。这是真实踩过的坑。

**铁律：runtimeInput 字段优先扁平标量（string/number），别让 dispatcher 吐嵌套对象。**

| 需求 | ❌ 别这么设计 | ✅ 正确设计 |
|---|---|---|
| 时间窗口（需算 startIso/endIso + 元数据） | 一个 `timeWindow` 对象字段（7 子字段嵌套） | 拍平成 `timePhrase`/`timeMode`/`timeAmount`/`timeUnit`/`startIso`/`endIso`/`canonical` 7 个标量字段，worker 组装成对象 |
| 多维配置 | 一个 `config` 对象 | 拆成多个标量字段 |

**把"组装对象"的活留给 worker**（worker 是完整 LLM，组装稳）。dispatcher 只负责算出每个标量值。参考 `~/.pi/agent/tasks/x-search/contract.json` 的扁平时间字段——这是踩坑后的修复范式。

**配套：禁止 worker 现编默认值。** 若扁平字段缺失/非标量（说明 dispatcher 失败），worker 必须**报错退出**，不能自己补默认（现编会产出错误结果且难排查）。在 skill.md 里写明这条输入校验。

### 两层防线：dispatcher 管输入，verify 管产物（别越界）

外部输入到最终产物，有**两层独立的校验**，各管各的边界，不要互相重复或互相指望：

| 层 | 谁负责 | 抓什么 | 抓不了什么 |
|---|---|---|---|
| **第一层：dispatcher 门禁**（输入层） | `task-dispatcher.ts` 的 `coversRequired` | required 字段**缺失**、值为**空值/空白/null/空对象** | 字段值是"合法但无意义的残片字符串"（如 `"{mode:"` 对机制层是无法判别的非空字符串） |
| **第二层：verify 产物校验**（产物层） | taskbook 的 `verify.mjs` | worker 是否按 contract 产出了**有效结果**（字段能 parse 成预期类型、全量落地、值在合理范围） | 输入是否完整（那是 dispatcher 的事） |

**关键认知：verify 不是"重复 dispatcher 的工作"，而是"校验 worker 是否守信地用了 dispatcher 给的值并产出了合格结果"。** 这两层职责不同：

- dispatcher 给了残片字符串（机制层判不出），worker 若**原样用**，verify 通过**产物语义校验**抓住（如 startIso parse 不成日期就 FAIL）。这是 verify 的本职，不是补丁。
- dispatcher 没给某个 required 字段，**机制层直接 throw**，worker 根本拿不到 runtimeInput，task 早失败，**不需要 verify 再判一遍 input 是否齐全**。

**设计 verify 时的原则：**
- ✅ 校验产物语义：字段能 parse 成预期类型、results 全量落地（条数 == filteredRows）、每条结果符合契约、时间戳落在窗口内
- ❌ 不重复输入校验：不要在 verify 里判 `TASK_INPUT.xxx is provided`（dispatcher 门禁已管，重复 = 死代码）
- ❌ 不做"字符串内容是否合理"的穷举校验（如用正则判"这个关键词是不是真的像关键词"）——那是 LLM 的活，不是 verify 的

参考 `~/.pi/agent/tasks/x-search/verify.mjs`：它只校验产物（timeWindow.startIso 能 parse 成日期、results 全量、postedAt 在窗口内），不重复判 TASK_INPUT 字段是否齐全。

## 数据落地路径速查表：worker 怎么把外部数据弄出来

这是 task 设计的高频踩坑区。数据从外部（Chrome 页面 / 远程 API / 数据库）到 `$TASK_OUTPUT_DIR`，只有几条路是活的：

| 数据来源 | 活路 | 死路 |
|---|---|---|
| **CDP 页面（JS 全局变量/收集结果）** | ✅ `chrome_cdp evaluate` 返回值（小数据一次返回；大数据分块 offset 循环取） | ❌ 页面 fetch 到本地 HTTP server（Chrome PNA 雷区）；❌ 浏览器下载（弹窗，无人值守/并行不可用）；❌ 页面 JS 直写文件（无文件系统权限） |
| **远程 HTTP API** | ✅ worker 用 node fetch/bash curl 拿到，`fs.writeFileSync` 到输出目录 | ❌ 期望 API 直接写到 $TASK_OUTPUT_DIR（API 不在你的进程里） |
| **数据库** | ✅ worker 用 node 连库查，写文件 | ❌ 期望 DB 导出文件自动出现在 $TASK_OUTPUT_DIR |
| **大文件/二进制** | ✅ 流式下载直接写文件，不进上下文 | ❌ 整个读进内存再写（撑爆） |

### CDP 大数据落地的标准范式（分块 dump）

Chrome 页面收集完大数据（如几百条推文）后，**分块 evaluate 取回 + append 写文件**：

```
worker 循环：
  evaluate("取 rows[offset..offset+50]") → 返回这一块（~20-40KB，安全）
  → 立即 append 写进 $TASK_OUTPUT_DIR/xxx.json
  → offset += 50，直到 hasMore=false
worker 退出，上下文销毁
```

每块进 worker 上下文一次就写盘丢弃，**峰值永远是一块的大小**，不是全量。参考 `~/.pi/agent/tasks/x-search/` 的 `dump-result.js` + `skill.md` 第 6 步——这是已经跑通的范式。

### 判断"该不该担心上下文"的速查

| 你的数据规模 | 该怎么做 |
|---|---|
| 小（< 50KB，如摘要+少量结果） | 一次 evaluate 返回，直接写文件，不用分块 |
| 中（50KB-1MB，如几百条结构化记录） | 分块 evaluate（offset 循环），每块 append 写文件 |
| 大（> 1MB，如原始 HTML/大 JSON） | 别进 worker 上下文——让数据源直接写文件（CDP 没这能力时，考虑这个 task 是否该拆） |

## 五件套格式（照真实样本）

一个 taskbook 是一个目录，下面五个文件，缺一不可。字段都从真实运行过的 taskbook 提取，照着填：

### 1. `taskbook.json` — 索引（运行记录自动追加，创建时写头部即可）
```json
{
  "name": "bili-up-homepage-spider",
  "description": "一句话说清这个 task 干什么：给定什么输入，产出什么",
  "scope": "user",
  "createdAt": "2026-06-25T13:37:50.857Z",
  "tags": ["bilibili", "scraper"],
  "runs": []
}
```
> `runs` 数组由 `/task run` 自动写入，创建时留空 `[]`。

### 2. `spec.json` — RequirementsSpec（给 worker 的需求）
```json
{
  "goal": "给定 X，产出 Y，保存为 Z",
  "hardConstraints": ["硬性约束1", "链接格式必须是 ..."],
  "acceptance": ["验收项1：程序能从输入提取 ...", "输出文件为有效 JSON"],
  "forbidden": ["不要做 ...", "不要过度请求避免被封"],
  "context": "实现提示：可以先用 HTTP，失败再用 CDP；时间格式需补全等"
}
```

### 3. `contract.json` — 契约（输入输出 + 依赖工具）
```json
{
  "outputDir": "<runtime>",
  "artifacts": ["output_page{page}.json"],
  "runtimeInput": ["keyword", "days"],
  "runtimeInputMeta": {
    "keyword": { "description": "搜索关键词", "required": true },
    "days": { "description": "最近 N 天", "required": false, "default": 30 }
  },
  "requiredTools": ["chrome_cdp"]
}
```
> - `outputDir` 固定写 `"<runtime>"`，由系统在运行时注入实际输出目录。
> - `runtimeInput` 是**外部每次运行传入的参数名**，参数化任务全靠它。
> - 枚举字段在 `runtimeInputMeta.<field>` 写 `allowedValues`，如 `["normal","talkative"]`；机制会把可选值展示给 main agent，并阻止非法 `field=value` 覆盖 dispatcher 的规范化结果。
> - `requiredTools` 填 worker 需要的受保护工具（如 `chrome_cdp`），没有就空数组。

### 4. `skill.md` — worker 执行指令
写清楚 worker 拿到参数后**具体怎么做**：输入字段、执行命令、输出文件名、输出 JSON 结构、技术要点。这是 worker agent 的操作手册。

### 5. `verify.mjs` — 机器验收脚本
**契约**：用 `TASK_INPUT`（JSON 环境变量，含 runtimeInput）和 `TASK_OUTPUT_DIR`（输出目录）校验产物。
- 失败：`console.log(JSON.stringify(failures, null, 2))` + `process.exit(1)`
- 通过：`console.log("PASS")` + `process.exit(0)`
- `failures` 是数组，每项 `{ assertion, expected, actual, hint }`

骨架：
```js
import { strict as assert } from "node:assert";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const failures = [];
function fail(assertion, expected, actual, hint) {
  failures.push({ assertion, expected, actual, hint });
}

const taskInput = JSON.parse(process.env.TASK_INPUT || "{}");
const taskOutputDir = process.env.TASK_OUTPUT_DIR || ".";
// ... 校验产物 ...

if (failures.length > 0) {
  console.log(JSON.stringify(failures, null, 2));
  process.exit(1);
} else {
  console.log("PASS");
  process.exit(0);
}
```

## 标准创建流程（5 步，替代满仓乱扫）

1. **读源能力** — 读要封装的 skill/脚本本体，搞懂它接受什么、产出什么。只读这一个目录，别扩散。**如果源是现成脚本（.py/.mjs/.sh），记下它——稍后复制进 taskbook 的 `scripts/` 子目录让 worker 直接调用，别让 worker 现写一份。**
2. **定参数** — 哪些值每次运行会变？把它们定为 `contract.json` 的 `runtimeInput`。固定值写进脚本/spec，别参数化。
3. **照样本写五件套** — `ls ~/.pi/agent/tasks/` 找一个**真实样本**对照，按上面格式填五个文件。**有现成脚本就一并建 `scripts/` 子目录把脚本放进去，skill.md 里用 `$TASK_DIR/scripts/xxx` 引用**（见上方"自带脚本"段）。
4. **手验 verify.mjs** — 自己设 `TASK_INPUT` / `TASK_OUTPUT_DIR` 环境变量跑一遍 verify，确认它真能判对错。这步省不得，验收脚本错了 task 永远过不了或假通过。详见下方"写完自验清单"——**这一步做扎实，第 5 步才能一次 PASS，不用反复试错。**
5. **落盘 + 试跑** — 五件套（+ scripts/）写到 scope 目录，`/task run <name> <自然语言输入>` 试一次，看 PASS。**前提是第 4 步自验过了**；自验没过就 `/task run` 是拿真跑当调试，浪费 token 和时间。

## 写完自验清单（不扔给 /task run 真跑试错的底气）

这是"一次做好"的核心工程化动作。写完五件套**先在本地自验，再 `/task run`**。自验通过的 task，真跑基本一次过。三轮自验，按顺序做：

### 自验 1：JSON 可解析 + 脚本语法

```bash
# 五件套里的 JSON 文件都能 parse
for f in taskbook.json spec.json contract.json; do node -e "JSON.parse(require('fs').readFileSync('$f','utf8'))" && echo "OK $f" || echo "FAIL $f"; done
# verify.mjs + scripts/*.js 语法没炸
node --check verify.mjs
for f in scripts/*.js; do node --check "$f" && echo "OK $f" || echo "FAIL $f"; done
```

### 自验 2：verify 三路径模拟（最关键）

verify 是 PASS/FAIL 的判官，但它自己也可能判错（假通过/永远不过）。**模拟三种输出跑 verify**，确认它判得对：

```bash
# happy path：有结果，字段齐全，全量一致 → 应 PASS
TMP=$(mktemp -d) && export TASK_OUTPUT_DIR="$TMP"
export TASK_INPUT='{"keyword":"test","range":"3h"}'  # 换成你的 runtimeInput
# 写一个符合 contract 的样例 JSON 到 $TMP/x_search_results.json（或你的 artifact 名）
node ~/.pi/agent/tasks/<你的task>/verify.mjs; echo "exit=$?"  # 应该是 0

# empty path：合法空结果（X 返回空、DB 查无）→ 应 PASS
# 写一个 results:[] 的 JSON，benchmark 照记 → verify 应 exit 0

# truncation path：结果数与 benchmark 不一致 → 应 FAIL
# 写 results 少于 benchmark.filteredRows 的 JSON → verify 应 exit 1 并指出
```

**empty path 必测**——很多 task 在"外部返回空"时 worker 写不出正确 JSON，verify 又没容错，导致永远 FAIL。你的 task 如果涉及外部数据源（X/API/DB），empty path 必须是合法 PASS。

### 自验 3：契约一致性自查

对照 contract.json 和 verify.mjs，自查这几个高频不一致：

- `contract.artifacts` 里的文件名 == verify.mjs 读的文件名 == skill.md 让 worker 写的文件名？（三者必须一致）
- `contract.runtimeInput` 的每个字段，verify 都校验了？（漏校验 = 假通过风险）
- verify 校验的字段，skill.md 都让 worker 写了？（verify 要 worker 没写的字段 = 永远 FAIL）
- `requiredTools` 声明的工具，skill.md 用到了？（声明了不用是噪音；用了没声明是 worker 拿不到授权）

**自验全过，再 `/task run`。** 这套动作把"多轮试错"压成"一轮自验 + 一次真跑"。

## 铁律

- **taskbook 是最小单位，不可嵌套**。一个 taskbook = 一个原子任务。
- **参数只从 `runtimeInput` 进**。固定逻辑写进 skill.md/脚本，不要把"每次都一样的值"也参数化。
- **verify 是机器验收，不是人**。它只能看文件内容/格式，不能看"做得好不好看"。验收项要可机器判定。
- **`/task run` 的输入是自然语言**，dispatcher agent 会把它翻译成 `runtimeInput` 的值。contract.json 的 `runtimeInputMeta.description` 要写得让翻译不会出错。
- **需求驱动匹配**：别为了"凑 taskbook"而封装。只有这个能力会被**多次、参数化地**复用时，才值得做成 task。

## 反模式（别这么干）

- ❌ 满仓 `find **/*task*` 找 taskbook 存哪 —— 位置就在上面的表格里。
- ❌ 读 ugk-core 的 `task-guide.ts` 想搞懂"怎么创建" —— 那是"导览**已有** taskbook"的，不是创建指南。
- ❌ 凭空捏造五件套格式 —— 先 `ls ~/.pi/agent/tasks/` 找真实样本。
- ❌ 把 taskbook 放进 skills/ 目录 —— skill 和 taskbook 是两个系统，位置不同。
- ❌ 把 skill 的脚本/逻辑复制进 taskbook 重写 —— worker 已能加载已装 skill，应让 task 调用 skill，别复刻。只有当 skill 几乎全不兼容、重写更划算时才退回 `scripts/` 自带脚本。
- ❌ skill.md 里写裸脚本名（如 `python foo.py`）却不在 taskbook 自带 —— worker 在用户 cwd 跑，找不到。要么把脚本放进 `scripts/` 用 `$TASK_DIR/scripts/foo.py` 引用，要么让 worker 自己现写。
- ❌ 在 task 的 `skill.md` 里写「先 `chrome_cdp status` 检查 → 没起就 `chrome_cdp action=launch` → 重试」—— 这是**写错层**：工具就绪检查由 `contract.requiredTools` 声明触发，机制在 worker spawn 前就办完了；worker 进程内这些指令是跑不到的死代码。声明层管就绪，worker 只管用。
- ❌ 为了把 Chrome 页面数据写到文件，起本地 HTTP server 让页面 fetch POST —— worker 进程自己有 node fs，且 `$TASK_OUTPUT_DIR` 框架白给；走 HTTP 会撞 Chrome PNA 预检雷区。正确范式是 `chrome_cdp evaluate` 返回值（分块）+ worker `fs.writeFileSync`。
- ❌ 写完五件套直接 `/task run` 真跑当代调试 —— 应先做"写完自验清单"（JSON 解析 + verify 三路径模拟 + 契约一致性自查）。自验过的 task 真跑基本一次过，省 token 和时间。
- ❌ 在 worker 内调 subagent 去"分块摘要/读 CDP 数据" —— subagent 是独立 pi 进程，`buildSubagentChildEnv` 主动删 CDP 授权、不传 tab id，读不到 worker 的 tab 缓存。worker 自己分块 evaluate 即可，不需要 subagent。
- ❌ 遇到"用户输入需要解析/转换/计算"（如各种时间表达、模糊量词、跨语言），在 worker 里写穷举正则/多语言映射脚本 —— 这是**重新发明 dispatcher 已有的能力**。dispatcher 是会推理的 LLM，能算日期、能懂跨语言、能输出结构化计算值。正确做法：加一个 runtimeInput 字段，description 教 dispatcher 算，worker 只吃结构化结果。见上方"dispatcher 能力真相"。
