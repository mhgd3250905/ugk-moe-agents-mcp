# dispatcher required 门禁（修复 URL 丢失）

> ⚠️ **本文描述的 dispatcher 行为已过时(v2.1.1 起)。** 继续阅读前请注意:
> - 本文写于 dispatcher「不可用时静默降级(`return undefined`/`.catch(()=>undefined)`/交互式 fallback)」的年代。
> - v2.1.1 起,dispatcher 是唯一自然语言解析路径,模型/auth 不可用时**显式抛错**(`dispatcher 模型不可用`),不再降级到本地解析或逐字段 UI 问。`complete()` 的运行时错误(网络/限流)仍在内部 catch。
> - 本文中"降级安全,不崩""dispatcher 不可用降级"等描述均**不再成立**。权威实现见 `extensions/task/task-dispatcher.ts`。

> 日期：2026-06-25
> 关联提交：`bf0ed04`

## 现象

用户输入 `URL, page=1`（自然地给 URL 顺手带个 page 参数），run_task 报 verify 失败 `url is required`。只有显式写成 `url=... page=1` 才成功。

## 根因（已用代码 + 复现确证）

`resolveRuntimeInputFromText`（task-dispatcher.ts:137）的 short-circuit：

```ts
const local = localRuntimeInput(contract, rawInput);
if (local) return runtimeInputWithDefaults(contract, local);  // ← 抽到【部分】字段就返回
const dispatched = await callDispatcher(...);                  // ← LLM 兜底被跳过
```

`localRuntimeInput` 用正则抽 `field=value`，**抽到任何字段就返回 truthy**，不检查是否抽全。复现结果：

| 输入 | localRuntimeInput 返回 | 结果 |
|---|---|---|
| 裸 URL | `undefined` | → 走 LLM dispatcher |
| `URL, page=1` | `{page:1}` | → **url 丢了!** 直接返回，dispatcher 没机会跑 |
| `url=... page=1` | `{url,page}` | → 成功 |

**设计缺陷**：local 部分命中就 short-circuit，既跳过了更聪明的 LLM dispatcher，也不检查 required 字段。`required` 是 contract 里的死字段（`runtimeInputMeta.url.required: true` 存在但无代码消费）。

## 修复：纯本地 required 门禁（不依赖 LLM）

核心洞察：报告要的"参数门禁"可纯本地实现，不需把 LLM 提前（那会引入成本和无 key 降级问题）。

**新增** `runtimeRequiredFields(contract)`：从 `runtimeInputMeta` 提取 `required: true` 的字段名（required 默认 true，显式 false 才可选）。

**改 `resolveRuntimeInputFromText`**：local 抽取后检查是否覆盖所有 required 字段，缺 required 就不 short-circuit，让 dispatcher 兜底：

```ts
if (local && coversRequired(local)) return runtimeInputWithDefaults(contract, local);
const dispatched = await callDispatcher(...).catch(() => undefined);
if (dispatched && coversRequired(dispatched)) return runtimeInputWithDefaults(contract, dispatched);
const partial = dispatched ?? local;
if (partial) return runtimeInputWithDefaults(contract, partial);
```

**效果**：`URL, page=1` → local 抽到 `{page:1}` 但缺 required url → 走 dispatcher 补全 url → 成功。

**降级安全**：dispatcher 没 API key / 抽不出时，仍用 local 部分结果补 default，不比改前差，也不崩。

## 为什么不把 LLM 提前到 local 之前

那会让每次 `/task run` 多一次 LLM 调用（成本+延迟），且无 API key 时 LLM 完全不工作。只在"local 缺 required"时才调 LLM，兼顾准确性和成本。

## 修复后行为对照

| 输入 | 改前 | 改后 |
|---|---|---|
| 裸 URL | undefined→dispatcher | 不变 |
| `URL, page=1` | `{page:1}` 直接返回→url 丢→verify 死循环 | `{page:1}` 缺 required→走 dispatcher 补 url→成功 |
| `url=... page=1` | `{url,page}` 返回 | 不变（快路径，dispatcher 不调用）|

## 测试

`tests/task-dispatcher.test.ts` 新增 5 个 required 门禁用例（用 Faux provider）：partial hit→dispatcher 补全、full hit 快路径、裸 URL 路由、dispatcher 不可用降级、无 required 声明的向后兼容。501→506 全绿。

## 教训

- `required` 字段定义了就要消费，否则是死字段误导人。
- local 抽取器部分命中时不该 short-circuit 更可靠的兜底。
- 设计"门禁"不一定要依赖 LLM，本地 required 检查更便宜更可靠。
