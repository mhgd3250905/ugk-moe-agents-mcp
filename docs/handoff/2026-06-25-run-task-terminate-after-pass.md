# run_task PASS 后 TUI 卡死修复

> **交接对象**:接手 task 模块的同事。
> **背景**:用户 `/task run` PASS 后,主 agent 进入工具后的自动总结轮,界面卡在 "Steering:" 状态,Esc 无法中断,发消息一直排队。详见同事的问题记录分析(已附在 commit)。
> **基线**:`npm test` 496 pass / 0 fail。
> **状态**:已实现 + 单测覆盖,已 commit 推送。

---

## 1. 根因(已追到底)

我核了三个文件证实链路:

1. `interactive-mode.js:1945,3159` — Esc 在 streaming 时**确实**调 `agent.abort()`(不是没绑定)
2. `agent.js:196-197` — `abort()` **确实**触发 `abortController.abort()`(signal 发出了)
3. `agent-loop.js:192` — signal **确实**传给了 streamFunction

**结论:abort signal 发了,但接不住。** run_task PASS → 工具结果返回 → loop 继续 `streamAssistantResponse` 让主 agent 总结 → 这一轮 provider 请求卡住(或某 await 不响应 abort)→ Esc 的 signal 无法中断 → 卡死。

**这个"provider stream 卡住时 Esc 接不住"是真根因,但它在 pi runtime 层(provider stream / fetch),不在 ugk extensions 能修的范围。**

## 2. 本次的修复(ugk 层,止血 + 语义修正)

不碰 pi runtime。在 ugk 层让"卡死轮次根本不发生":

### 改动 A:run_task 返回 `terminate: true`

`task.ts` 的 run_task execute 正常返回处加 `terminate: true`。pi-agent-core(README:113):工具返回 `terminate:true` hint 跳过工具后的自动 follow-up LLM call。

**为什么这是正确语义,不是 hack**:run_task 是一次性确定性任务,PASS/FAIL + 产物路径已在 content 里,主 agent 没必要再总结一轮。跳过那轮既避开卡死,也符合工具语义。

**limit**:并行 batch 里 `terminate` 只在**整批所有工具都 terminate** 时才生效(pi 文档原话)。run_task 是单工具,不受影响。

### 改动 B:workerSummary 移出 content,只留 details

`formatSubtaskToolText` 去掉 `workerSummary` 那行。workerSummary 仍在 `details.results[].workerSummary`(UI/调试照常可取),但不再进 LLM context。

**理由**:workerSummary 可能很长(产物摘要表格等),白占 token,还会放大后续轮次卡顿概率。与卡死无直接因果,但独立有价值,顺手做。

## 3. 测试

`tests/subtask-tool.test.ts` 的 PASS 测试加三条断言:
- `result.terminate === true`(PASS 后 terminate)
- `result.details.results[0].workerSummary` 仍含摘要(留在 details)
- `result.content[0].text` 不含 `workerSummary`(不进 LLM context)

现有测试无需改:它们本来就断言 workerSummary 走 `details.results[]`,没人断言 content 含它。

## 4. 没修的(明确边界)

- **"provider stream 卡住时 Esc 接不住"是 pi runtime 层问题**,ugk extensions 改不到 streamFn 内部。本次只在 ugk 层绕过(run_task 不进那轮)。普通对话场景若遇 provider 卡,本次修复无效,需 pi 上游修或单独处理。
- **runVerify 不响应 abort**(已知缺口):verify 期间 `/task stop` 要等子进程跑完。与本次无关。

## 5. 用户侧效果

run_task PASS/FAIL 后:
- 主 agent **不再进入自动总结轮**,直接回到 idle。
- 用户可立即继续操作,不会再卡在 "Steering:" 等死状态。
- PASS/FAIL 结果、outputDir、artifacts 仍在工具结果里完整呈现。
