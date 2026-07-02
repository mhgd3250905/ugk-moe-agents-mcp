# Handoff — task 运行进度可见性增强

> 日期：2026-06-29
> 上一份 handoff：`docs/handoff/2026-06-28-linkedin-search-task.md`
> 代码基线：会话开始 `cf54a8f`(477/477/0)→ 会话结束 `e917910`(**478/478/0**)
> 工作树：干净(已全部 commit)

---

## 本次会话做了什么(3 个 commit + 1 个 PR 审核干预 + 1 份功能文档)

核心：把 `/task run` 从"回车后死寂 + worker 执行中一直不变"改善为"回车即响应 + 运行中能看到大概步骤和关键失败节点"。

用户原始诉求经过三轮迭代收敛到最终设计：

| 迭代 | 设计 | 用户反馈 |
|---|---|---|
| v1 | 透传全部 ToolCall + 成功/失败 toolResult | "太繁琐太细节" |
| v2 | 只报失败的 toolResult | "worker 执行中...一直不变"（summary 被丢了） |
| **v3（最终）** | **每轮 summary 首行（大概步骤）+ 失败 toolResult（关键节点）** | "没啥大问题" |

---

## 最终设计（v3）

### 用户运行 `/task run` 时看到的进度链路

```
[回车]
  → ⏳ taskbook "x-search" 准备中...        ← 改动 A：消除回车后静默期
     正在解析输入...                         ←   （dispatcher LLM 调用期间）
  → ⏳ taskbook "x-search" 运行中...
     尝试 1/4
     worker 执行中...
     正在导航到 X 搜索页                      ← 改动 B：worker 每轮 summary 首行（大概步骤）
     正在解析搜索结果                         ←
     ✖ chrome_cdp: selector not found        ← 改动 B：失败 toolResult（关键节点）
     换选择器重试                             ←
[完成]
  → ▸ taskbook "x-search" 运行过程: PASS (18 条)
```

### 进度信息的取舍规则（改动 B，`formatMessageProgress`）

| 信号源 | 是否显示 | 理由 |
|---|---|---|
| worker 每轮 assistant 的文字 summary（首行） | ✅ | 大概步骤，精简又能体现进度 |
| ✖ 失败的 toolResult | ✅ | 关键节点，命中"失败想看原因"痛点 |
| 🔧 工具调用（ToolCall） | ❌ | 太细节，逐条报繁琐 |
| ✔ 成功的 toolResult | ❌ | 噪音，worker 正常干活无需逐条报 |

**重要洞察**：LLM 在调工具时那一轮的 assistant message 经常**没有 text**（直接调工具不说话）。所以 v2 只报失败 toolResult 时，运行中会长时间无任何输出。真正的"大概步骤"是 LLM **会说话的那几轮**的 summary——抓住这些，进度感就回来了。

---

## 改动详情

### 改动 A：`/task run` 回车后补"正在解析输入"提示

**文件**：`extensions/task/task.ts`（`handleTaskRun`）

**根因**：回车后到 worker spawn 之间，`resolveRuntimeInput` → `callDispatcher` 是一次**阻塞的 LLM 调用**（数秒~十几秒），这期间 UI 完全静默，用户只看到 ╌╌╌。

**对称缺口证据**：headless 路径（`executeSubtask`/run_task 工具）在 task.ts:1124 **早就有** `setTaskRunWidget(ctx, [title, "正在解析输入..."])`。交互式路径 `handleTaskRun` **漏了**。修法就是照搬这一行到 `resolveRuntimeInput` 之前。

**不改**：dispatcher 契约、abort/repair 语义（widget 是独立 UI 反馈，`activeTaskRun` 仍在 resolveRuntimeInput 之后创建）。

### 改动 B：worker 运行中进度透传（最终为 summary 首行 + 失败 toolResult）

**文件**：`extensions/task/task-worker.ts`（`dispatchWorker` 的 onUpdate 回调 + `formatMessageProgress`）

**根因（机制缺失）**：旧 onUpdate 只取 `partial.content` 的 text（`getFinalOutput` 的最终输出），丢弃了 `partial.details.results[0].messages`。而 `getFinalOutput` 是"从后往前找最后一条 assistant text"——worker 调工具时若没说话，这个就是空或占位，导致"worker 执行中..."一直不变。

**修法**：
- onUpdate 改为**增量遍历 messages**（`lastSeenIndex` 增量索引，只发新增 message，不重发历史；下游 `appendUniqueProgressLines` 兜底去重）
- `formatMessageProgress(msg)` 按上面的取舍规则转进度行：
  - assistant message → 取 `TextContent` 首行（若该轮没说话则返回空数组）
  - 失败的 toolResult → `✖ <toolName>: <错误首行>`
- `details/messages` 缺失（部分模拟场景）→ fallback 到旧文本路径

**不改**：
- `task.ts` / `formatProgressLines` / widget —— 推的是普通 text 行，经现有管道（去 markdown / 去重 / `.slice(-5)` / 截 120 字）处理，零改动
- `subagent.ts` 通用 `OnUpdateCallback` 契约 —— 只改 task-worker 这个消费方
- widget 固定 5 行窗口 —— 够用，未放宽

**实测验证**（用户实跑 `/task run x-search "GPT5" "3h"`，PASS）：
```
▸ taskbook "x-search" 运行过程: PASS (18 条)
  ...
  ✖ chrome_cdp: Validation failed for tool "chrome_cdp": ...   ← 第一轮失败的具体原因，改动前看不到
  ...
```

### PR #22 审核干预（已合并，非代码改动）

PR #22 是 codex 自动化审核报告（纯文档 +55/-0）。审核结论：
- ✅ 事实层准确（scope/模块清单/跳过理由核实无误）
- ⚠️ Candidate 1（给 settings-io 加 delete helper）**不建议执行**：违反代码里已用 `ponytail:` 注释固化的 YAGNI 决策。`withDefaultExists` **不是死防御**——实测删除后 `setUiLanguage` 在 settings.json 不存在时会静默失败（`updateSettingsJson` 把 ENOENT 误判为"文件损坏"而保护性 return，不创建文件）。报告称"净 -20~-35 行"夸大。
- ✅ Candidate 2/3 报告自身已标注"别做"，认同。

**留痕**：PR 评论 https://github.com/mhgd3250905/ugk-tui/pull/22#issuecomment-4827800826，squash 合并后 main `cf54a8f` → `c149a79`。

**ponytail 教训**：审核 `withDefaultExists` 时**两次推演都错**（先说"死防御可删"，改口"不注入 exists 安全"），最终靠 `node --test` 临时证明脚本钉死真相。非平凡逻辑必须留 check，不能凭推演。

---

## 设计意图核验（改之前做的边界确认）

1. **subagent 通用契约不动** —— 只改 task-worker 一个消费方，`OnUpdateCallback` 类型签名未变 ✓
2. **task.ts 管道不动** —— 推的是普通 text 行，经现有 `formatProgressLines` 处理，零改动 ✓
3. **activeTaskRun 状态语义不动** —— "正在解析输入"widget 在 `activeTaskRun` 创建之前设置，但不破坏 abort/repair 语义（task-extension 62/62 通过）✓
4. **dispatcher 契约不动** —— 只在调用前加 UI 提示，不改 dispatcher 行为 ✓

---

## 测试基线

- 会话开始：`cf54a8f`（477/477/0）
- 会话结束：**478/478/0**（`e917910`，+1 个 onUpdate 进度测试）

新增测试 `tests/task-worker.test.ts`："dispatchWorker streams assistant summary + failed tool results via onUpdate" —— 覆盖：每轮 summary 首行被推、多行只取首行、失败 toolResult 被推、ToolCall/成功 toolResult 不被推。

---

## 改动文件清单（全部已 commit）

| commit | 文件 | 改动 |
|---|---|---|
| `7b4b7a4` | `extensions/task/task-worker.ts` | onUpdate 增量遍历 messages + `formatMessageProgress`（v1，后经 v2/v3 迭代） |
| `7b4b7a4` | `tests/task-worker.test.ts` | +1 onUpdate 进度测试（随设计迭代同步更新） |
| `260d22b` | `extensions/task/task.ts` | `handleTaskRun` 补"正在解析输入"widget（改动 A） |
| `aa0a0f6` | `extensions/task/task-worker.ts` | v2 精简：删 ToolCall/成功 toolResult |
| `e917910` | `extensions/task/task-worker.ts` | v3 最终：增加 assistant summary 首行 |
| `c149a79` | `docs/automated-reviews/2026-06-29-cf54a8f.md` | PR #22 合并进来的自动化审核报告（非本会话产出） |

---

## 已知边界 / 本次不做

- **stderr 实时透传**：worker 子进程崩溃时 stderr 在 `subagent.ts` 累加但只在结束后进 `errorMessage`，运行中没推给 UI。需动 `subagent.ts`（通用契约层），是另一条线。worker 正常调工具的失败已被改动 B 的 ✖ 行覆盖，此缺口仅影响"子进程本身崩溃"的边角场景。
- **worker 不说话的轮次无 summary**：LLM 调工具时若该轮没写 text，那轮就没有 summary 行——这是 LLM 行为，机制层无法凭空生成。进度感依赖 LLM 会说话的轮次。

---

## 待验证项（新会话/用户操作）

- 新开 ugk 进程跑 `/task run x-search "GPT5" "3h"`，确认：
  1. 回车后立即看到"正在解析输入..."（不再 ╌╌╌）
  2. 运行中看到 worker summary（大概步骤）+ ✖ 失败行（关键节点）
  3. 不再看到 ToolCall/成功 toolResult
- 其他 task（非 CDP）同样有 summary + 失败行效果

---

## 建议 skills（新会话）

- **ponytail** — 全程遵循（审核 `withDefaultExists` 靠测试钉底；进度设计经三轮迭代收敛）
