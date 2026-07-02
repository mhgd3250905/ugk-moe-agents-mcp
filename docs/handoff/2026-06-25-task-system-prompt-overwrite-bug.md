# task 扩展 system prompt 覆盖 bug（skill 从不触发）

> 日期：2026-06-25
> 关联提交：`7e01175`

## 现象

换 MiMo、DeepSeek 两个模型，skill（ugk-guide/mcp-guide/bash-guide/test-hello）**一个都没进 LLM context**。问"有哪些 skill"时模型瞎编工具名/MCP/taskbook，从不报真实 skill。session 文件铁证：搜不到任何 skill description。

## 根因

`extensions/task/task.ts` 的 `before_agent_start` 处理器：

```ts
pi.on("before_agent_start", async () => {
    // ...
    if (cachedTaskbookPrompt) result.systemPrompt = cachedTaskbookPrompt;  // ← 整体覆盖!
});
```

`cachedTaskbookPrompt` 只是 taskbook 清单文本（`## 可用 task...`）。当机器上有任何 taskbook 时，它**整体覆盖** pi 组装好的完整 system prompt——把 skill 清单、工具说明、项目上下文全部吃掉。

**关键链条**：
1. pi 组装好含 skill 的 system prompt（`_rebuildSystemPrompt`，含 15 个 skill）
2. pi 触发 `before_agent_start`，把完整 prompt 通过 event 传给扩展
3. task 扩展无视 event.systemPrompt，直接返回纯 task 清单作为新 systemPrompt
4. pi 的 `emitBeforeAgentStart`（runner.js:774）：`if (result.systemPrompt !== undefined) currentSystemPrompt = result.systemPrompt` → 整体替换
5. LLM 收到的 system prompt 只剩 task 清单，skill 全没

**为什么一直没发现**：只要有 taskbook 存在，bug 一直触发。但不影响 task 功能本身（task 清单还在），平时用 task 没感觉——直到要验证 skill 触发才暴露。

## 修复

`task.ts:1723` 改为接收 event、追加而非覆盖：

```ts
pi.on("before_agent_start", async (event: any) => {
    // ...
    if (cachedTaskbookPrompt) {
        const base = typeof event?.systemPrompt === "string" ? event.systemPrompt : "";
        result.systemPrompt = `${base}\n\n${cachedTaskbookPrompt}`;
    }
});
```

pi 的 `before_agent_start` 事件本就是为这种 chaining 设计的（会把当前 prompt 传给扩展）。

## 影响

这个 bug 让**所有 skill（含系统自带的 ugk-guide/mcp-guide/bash-guide）从来没真正进过 LLM context**。修复后，skill 体系才第一次真正打通。之前以为是"模型不支持 skill 触发"，实际是 prompt 被覆盖了。

## 调查教训

- "skill 不触发"不要先怀疑模型，要查 session 文件里 system prompt 到底有没有 skill。
- `before_agent_start` 返回 `systemPrompt` 是**整体替换**语义，扩展要追加必须自己拼 `event.systemPrompt + 新内容`。
