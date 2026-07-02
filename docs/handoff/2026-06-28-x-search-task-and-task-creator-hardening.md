# Handoff — x-search task + task-creator 基建强化

> 日期：2026-06-28
> 上一份 handoff：`/tmp/ugk-handoff-2026-06-28-dev.md`(临时,已废,内容已被本份取代)
> 代码基线：本会话开始时 `4f7f6c0`,446/446/0;本会话结束 449/449/0,**改动尚未 commit**(用户未要求)
> 工作树：3 个 tracked 文件改 + 1 个 untracked user-skill 本地残留(见末尾"清理状态")

---

## 本次会话做了什么(3 个主题)

### 主题一：CDP autolaunch 机制(taskbook 运行前置)

**问题**：`/task run` 一个声明了 `chrome_cdp` 的 taskbook,若 Chrome 没带调试端口跑,会在 `beforeSpawn` 开 tab 阶段直接抛 `Chrome CDP 未连接(port 9222)`,**整 task 异常退出,worker 子进程根本不 spawn**。worker 进程内的 skill.md 指令(CDP 检查/launch/重试)是**死代码**——它执行的时刻 worker 还没出生。

**根因**：CDP 就绪检查的职责边界没被 task-creator 讲清楚;agent 把它写进了 worker skill.md(跑不到的层)。

**修法**：
- `extensions/chrome-cdp/tab-session.ts`：`beforeSpawn` 首次开 tab 遇连接类错(`fetch failed`/`ECONNREFUSED`)时,**自动调 `launchChromeCdpAndWait` + 重试开 tab**,不再直接 throw。加 `UGK_CDP_AUTOLAUNCH` 开关(默认开,`=0` 关回退老行为)。`launch` DI 供测试注入。
- `tests/chrome-cdp-tab-session.test.ts`：+3 个 check(自愈成功 / autolaunch 关了抛原 hint / launch 后仍开不了抛清晰错)。
- 已验证真实生效：cdp-tab.log 有 `ERROR fetch failed → AUTOLAUNCH → OPEN autolaunch=1` 铁证。

### 主题二：x-search task(纯 task 架构,取代旧 skill + save-server)

**问题演进**：用户最初有 `x-searcher` skill(带 `local-save-server.cjs` HTTP server 落地 + subagent 分块摘要)。诊断出三个致命问题:
1. save-server 撞 Chrome PNA 预检雷区(POST `/save` 失败)
2. 浏览器下载弹窗,无人值守/并行不可用
3. subagent 分块是死代码(subagent 拿不到 worker 的 CDP tab 授权 + tab id)

**决策**:用户要"稳定可交付 + headless + 并行",skill 的灵活触发用不上 → **纯 task 架构**。skill 和 taskbook 各自做自己擅长的事,不混。

**交付**:`~/.pi/agent/tasks/x-search/`(user scope)
- 五件套 + `scripts/`(dom-collector.js / anchor-scroll.js / dump-result.js)
- 数据落地范式:**worker 分块 evaluate `dump-result.js`(offset+=50)→ append 写 `$TASK_OUTPUT_DIR/x_search_results.json`**。零 HTTP、零弹窗、零 PNA。worker 是一次性进程,退出即销毁上下文,分块不撑爆。
- 已验证真实跑通:`/task run x-search "GPT5" "3h"` → PASS,104s,215 行全量落地,text 不截断。

**已清理**:旧 `user-skills/x-searcher/` skill、旧 `x-query-task`/`x-searcher-json`/`x-search-latest` taskbook 全删。

### 主题三：task-creator 基建强化(治"agent 反复试错"的根)

**问题**：用户反馈"用 task-creator 流程创建 task 经常多轮试错,最好的 LLM 都不稳定"。诊断根因:**不是 LLM 能力问题,是 task-creator 缺"机制全景"**。它教了五件套格式 + 流程,但没教 task 在机制里怎么跑、哪些路径是死的。agent 因此会:CDP 检查写进 skill.md(死代码)、造 save-server(PNA 雷)、忘全量落地契约、拿真跑试错。

**修法**(只追加不改写,既有流程全保留)：
- `skills/task-creator/SKILL.md` 新增 4 节:
  1. **机制全景**:`/task run` 时各层发生什么(beforeSpawn → worker spawn → 工具授权门 → `$TASK_OUTPUT_DIR` → verify),ASCII 流程图 + 职责边界表
  2. **dispatcher 能力真相**:dispatcher 是会推理的 LLM(reasoningEffort=medium),**能算日期/跨语言/输出结构化计算值**;设计参数第一反应是"dispatcher 能算就让它算",别在 worker 重造解析轮子(反例:270 行穷举正则)
  3. **数据落地路径速查表**:CDP evaluate 返回 / worker fs 直写 是活路;HTTP server / 浏览器下载 是死路;CDP 大数据用分块 dump 范式
  4. **写完自验清单**:JSON 解析 + verify 三路径模拟(happy/empty/truncation)+ 契约一致性自查。不扔给 `/task run` 真跑试错
- description 升级:强化对话创建命中("帮我做个 XX 的 task"),点明带"机制图 + 自验"
- 反模式 +3 条:CDP 检查写错层 / save-server 雷 / 拿真跑试错 / worker 重造 dispatcher 能力

---

## x-search 的 timeWindow 设计教训(本次会话最后修的 bug)

**现象**:`/task run x-search "medtrum" "上周"` **第一次失败**(dispatcher 未能解析出必填字段 timeWindow),第二次成功。

**根因**:我把 `range`(用户原话)和 `timeWindow`(range 的计算结果)拆成了**两个独立 required 字段**。dispatcher(medium reasoning 轻量模型)对"提取了 range 还得推导计算 timeWindow"这种**隐式字段依赖**理解不稳定。

**修法(ponytail 删减)**:合并 range 进 timeWindow。
- runtimeInput 从 4 个减到 3 个(keyword / timeWindow / maxSteps)
- `timeWindow.raw` 记录用户原话,其余字段是 dispatcher 计算结果
- 单字段消除"range 有但 timeWindow 没算"的不一致失败模式
- description 强化三点:`"You are an LLM, so COMPUTE the actual ISO dates"` + 3 个完整 input→output 例子 + single field

**这条教训已固化进 task-creator 的"dispatcher 能力真相"节 + 反模式**。

### 续:嵌套对象 → 扁平字段的二次修复(真实复现)

合并 range 进 timeWindow 后,真实测试仍失败。`taskbook.runs` 铁证:

```
input.timeWindow: "{mode:"   ← 字符串,不是对象,且被截断
verifyFailures: ["TASK_INPUT.timeWindow.raw is provided ...", "timeWindow is object ..."]
```

**二次根因**:让 dispatcher 输出**嵌套对象** `{raw, mode, amount, unit, startIso, endIso, canonical}` 对 medium reasoning 模型太重 —— JSON 输出不稳,被 `extractRuntimeInputFromText` 正则截断成 `"{mode:"`。而且 worker 拿到残缺 timeWindow 后**现编默认 7 天**(输出 raw = `"past 7 days (runtime input timeWindow was truncated; default applied)"`),违反契约。

**二次修法(ponytail 删减:扁平化)**:把 7 字段嵌套对象拍平成顶层标量 runtimeInput 字段:

```
runtimeInput: [keyword, timePhrase, timeMode, timeAmount, timeUnit, startIso, endIso, canonical, maxSteps]
```

全是标量(string/number),dispatcher 输出稳,正则不会截断。worker 收到后自己组装成 timeWindow 对象写进输出。同时:
- skill.md 加"输入校验"段:扁平字段缺失/非标量 = dispatcher 失败,**worker 直接报错退出,不现编默认**
- verify 校验 `timeWindow.raw == TASK_INPUT.timePhrase` + `timeWindow.startIso == TASK_INPUT.startIso`(组装一致性),worker 现编会被精确抓住

**教训升级(dispatcher 能力真相节已体现)**:dispatcher(medium 模型)输出**复杂嵌套对象不可靠**。设计 runtimeInput 字段时,**优先扁平标量**,把"组装对象"的活留给 worker(完整 LLM,组装稳)。这条已补进 task-creator。

### 三次修复:机制层治本 + 两层防线架构(最终方案)

前两次修复(合并 range 进 timeWindow、扁平化字段)都是在**特定参数层打补丁**。用户指出:无论多少参数、怎么写,都该交给 dispatcher 整理提取,从机制层解决,不要针对特定 task 打补丁。x-search 作为试金石,目标是淬炼 task 基建。

**真实根因复盘**:`input.timeWindow: "{mode:"` —— dispatcher 输出的 JSON 合法,但某字段值是无意义残片字符串。旧 `coversRequired` 只看 key 存在 → 放行 → worker 拿到残片现编默认。

**机制层治本(`task-dispatcher.ts`)**：
1. `isValidRuntimeValue()`:判"值有效"——非空字符串/有限数/非空对象。抓住空值/空白/空对象
2. `coversRequired` 升级:required 字段不仅要"存在",还要"有有效值"。缺失/无效都视为 dispatcher 失败(headless 抛错)
3. 报错区分"缺失字段"vs"字段值无效",给精准反馈
4. `buildTaskDispatcherPrompt` 强化:说明 dispatcher 是 LLM 能推理计算 + 要求输出完整有效值 + 禁止截断/半成品

**重要边界(测试暴露的真相)**:机制层**无法通用判别"残片字符串"**。`"{mode:"` 对机制层是合法非空字符串,和 `"2026-06-15"` 无法区分。强行判 = 针对特定字段格式打补丁(违背"别做字符串比对")。

**正解:两层防线,各管边界**:
| 层 | 职责 | 抓什么 |
|---|---|---|
| dispatcher 门禁(输入层) | `coversRequired` | required 缺失 / 空值 / 空对象 —— **通用可判,所有 taskbook 受益** |
| verify(产物层) | taskbook 自己的 verify.mjs | 产物语义:字段能 parse 成预期类型、全量落地、值在窗口内 —— **抓 worker 用了残片(startIso parse 不成日期就 FAIL)** |

**关键认知(已凝练进 task-creator)**:verify 不是"重复 dispatcher",是"校验 worker 是否守信地产出了合格结果"。dispatcher 给了残片(机制层判不出),worker 原样用,verify 通过产物语义校验(startIso 能否 parse 成日期)抓住。两层协作,不重复不越界。

**x-search 回归**：verify 删掉输入层重复校验(`TASK_INPUT.startIso is provided` 等 —— dispatcher 门禁已管),只留产物层语义校验(startIso parse 日期、results 全量、postedAt 在窗口内)。

**测试基线**：449 → **456/456/0**(+7 个 dispatcher 机制层测试:有效值通过/空值拒绝/空对象拒绝/报错区分缺失无效/非required不门禁/prompt强化)。x-search verify 四路径自验全过(happy/empty/truncation/残片用进产物)。

### 四次修复:dispatcher 注入当前日期(被真实测试抓住的机制层缺陷)

x-search 真实测试 `/task run x-search "medtrum" "上周"` PASS,但结果落在 **2025-02-26 ~ 2025-02-28**(比真实"上周"早 16 个月)。

**根因**:dispatcher(medium reasoning 模型)**没有"今天"概念**。算"上周"时它用了训练数据截止附近的旧日期(2025 年初),然后整条链路忠实执行:
- dispatcher 算出 startIso=2025-02-24(有效 ISO,机制层放行)
- worker 按 2025-02-24 当 cutoff 过滤,滚到 2025 年 2 月抓到 DUKPC2025 展会帖子
- verify 校验:3 条 postedAt 都在 [2025-02-24, 2025-03-03) ✓,startIso 能 parse ✓ → PASS

**整条链路零 bug,唯一错的是 dispatcher 不知道今天是哪天。** 这是新类型失败:机制层和 verify 都抓不到,因为"日期值本身有效",只是"算错了日期"。

**机制层治本**:`buildTaskDispatcherPrompt` 注入当前时间(UTC ISO + 本地时间 + 星期几),明示"算相对时间时必须以此为基准,不要用训练数据日期"。这是机制层修复,任何需要算日期的 taskbook 都受益。

**测试**：449 → **457/457/0**(+1 当前日期注入测试)。prompt 改动零破坏既有 dispatcher 契约(30/30 dispatcher 测试通过)。

---

## 测试基线

- 会话开始:446/446/0(基线 `4f7f6c0`)
- 会话结束:**457/457/0**(+3 tab-session autolaunch + 8 dispatcher 机制层)
- x-search verify 四路径自验全过(happy/empty/truncation/残片用进产物)

---

## 改动文件清单

### tracked(未 commit)
| 文件 | 改动 |
|---|---|
| `extensions/chrome-cdp/tab-session.ts` | beforeSpawn autolaunch + `UGK_CDP_AUTOLAUNCH` 开关 + `launch` DI |
| `tests/chrome-cdp-tab-session.test.ts` | +3 个 autolaunch 测试 |
| `extensions/task/task-dispatcher.ts` | **机制层治本**:`isValidRuntimeValue` + `coversRequired` 升级(值有效门禁) + 报错区分缺失/无效 + prompt 强化(LLM 能力说明 + 完整输出要求) + **注入当前日期**(治"算错上周"根因) |
| `tests/task-dispatcher.test.ts` | +8 个机制层测试(有效值通过/空值拒绝/空对象拒绝/报错区分/非required不门禁/prompt强化/当前日期注入) |
| `skills/task-creator/SKILL.md` | +5 节(机制全景/dispatcher 真相/扁平字段/两层防线职责/数据落地/自验清单)+ description 升级 + 反模式 +4 |

### untracked(user scope,跟用户走,不进 repo)
| 路径 | 说明 |
|---|---|
| `~/.pi/agent/tasks/x-search/` | 本次交付的 taskbook(五件套 + 3 scripts) |

### 已删除(本会话清理)
- `user-skills/x-searcher/`(旧 skill,被 x-search task 取代)
- `~/.pi/agent/tasks/x-query-task`、`x-searcher-json`、`x-search-latest`(旧 taskbook)

---

## 设计意图核验(改之前做的,确认没破坏既有边界)

1. `UGK_TASK_ALLOW_CHROME_CDP` 授权门不动 —— autolaunch 只在已注入 lifecycle 的 worker 触发 ✓
2. subagent 安全边界不动(`subagent.ts:79` 主动删授权)—— subagent 路径不传 lifecycle,零影响 ✓
3. per-worker tab 隔离不动 —— 只多了"开不了就先 launch",隔离语义不变 ✓
4. launch 复用已有 `launchChromeCdpAndWait`(含就绪轮询),没重新发明 ✓
5. 保留"CDP 没起就停下等我"的老行为 —— `UGK_CDP_AUTOLAUNCH=0` ✓

---

## 待验证项(新会话/用户操作)

- **x-search 稳定性**:连跑几次 `/task run x-search "X" "上周"`,确认 timeWindow 合并后**第一次就成功**(不再 range/timeWindow 不一致失败)
- **task-creator 基建**:对话说"帮我做个 task",观察 agent 是否主动加载 task-creator + 走自验清单 + 不踩已知坑
- **autolaunch**:Chrome 没起时 `/task run` 一个 chrome_cdp task,应自动 launch(不再整 task 崩)

---

## 清理状态(提醒后续会话)

- **本会话改动未 commit**(用户未要求)。若要保存进 repo:`tab-session.ts` + test + `task-creator/SKILL.md` 这 3 个 tracked 文件。x-search taskbook 在 `~/.pi/agent/tasks/`,不进 repo(跟用户走)。
- **docs/ 无残留旧设计引用**(已 grep 核实)。提到 "x-search" 的 docs 都是机制层设计文档(cdp 隔离 / search-engines-api 等),不是 skill/task 实现笔记,不动。
- **`/tmp/ugk-handoff-2026-06-28-dev.md`** 是临时文件,内容已被本份取代,可忽略。

---

## 架构债(记录,非必修)

延续 `docs/handoff/2026-06-27-architecture-debt-from-pr18.md`:
- task.ts 拆分:无 bug 驱动,不动(YAGNI)
- ui-brand 状态聚合:已被 PR#20 部分缓解
- 本会话无新增架构债

## 建议 skills(新会话)

- **ponytail** — 全程遵循
- **task-creator** — 已强化,创建 task 时会被命中
