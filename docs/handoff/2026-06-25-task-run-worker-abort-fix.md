# task 运行停止报"运行异常: Subagent was aborted"修复

> **交接对象**:接手 task 模块的同事。
> **背景**:用户 `/task run` 期间请求停止(`/task stop`),结果报错 `taskbook "xxx" 运行异常: Subagent was aborted`,而不是走预期的"已停止"分支。
> **基线**:`npm test` 495 pass / 0 fail(改动前后都绿)。
> **状态**:已实现 + 单测覆盖,已 commit 推送。

---

## 1. 现象

`/task run <name>` 执行中,用户输入 `/task stop`,得到:
```
已请求停止 taskbook "bilibili-downloader"。
Error: taskbook "bilibili-downloader" 运行异常: Subagent was aborted
```

期望:报"已停止 taskbook ... 运行",并提示可用 `/task` 选"复盘上次运行"。

## 2. 根因(数据流)

`runSingleAgent`(`extensions/subagent.ts:234`)在 signal abort 时 **throw `Subagent was aborted`**,而非返回 `{ok:false}`。这个 throw 一路逃逸:

```
runSingleAgent throws "Subagent was aborted"
  → dispatchWorker (task-worker.ts:64) 无 try/catch,异常逃逸
  → runTaskWithRetry (task.ts:901) 无 try/catch,异常逃逸
  → handleTaskRun catch (task.ts:1164) 兜住,报"运行异常"
```

下游 `runTaskWithRetry` 的 abort 判定(task.ts:915-917 `if (!workerResult.ok) { if (signal.aborted) workerAborted=true; }`)和 `handleTaskRun` 的"已停止"分支(task.ts:1116)**全部失效**——因为 `dispatchWorker` 根本没返回,异常直接逃逸,`workerResult.ok` 那段判断到不了。

**为什么没被发现**:测试只覆盖了 checker-abort,从没测过"用户 signal abort 触发 runSingleAgent throw"这条路。现有的 `/task run can be stopped` 测试 mock runner **返回**(非 throw),绕过了真实路径。

## 3. 修复(单文件 `extensions/task/task-worker.ts`)

在 `dispatchWorker` 的 `runSingleAgent` 调用外包 try/catch:
- catch 到异常且 `signal.aborted` 为 true → 转成 `{ok:false, errorMessage:"worker 被中断"}` 正常返回。
- 非 abort 异常 → 照常 `throw error`,不掩盖真 bug。

这样下游 `runTaskWithRetry` 现成的 abort 判定立即生效,`handleTaskRun` 走"已停止"分支,行为符合预期。

**为什么改 dispatchWorker 而不是 runSingleAgent**:subagent 是通用工具(task worker / guide / reviewer / judge driver / 普通委派共用),改它的返回契约影响面大。dispatchWorker 是 task worker 的唯一出口,在这里接住是单源真相、最小改动。

## 4. 测试(`tests/task-extension.test.ts`)

新增 `/task run user abort (worker throws) reports stopped, not exception`:
- mock runner 在 `signal.aborted` 时 **throw**(复刻真实 runSingleAgent)。
- 断言:走"已停止 taskbook"分支,不报"运行异常"。

这个测试在修复前会失败(报运行异常),修复后通过——证明 fix 有效。

## 5. 关联已知缺口

`runVerify` **不响应 abort**(交接文档已记录):verify 期间 `/task stop` 要等子进程跑完。本次修复的是 **worker 阶段**的 abort 逃逸;verify 阶段的 abort 支持是另一个独立缺口(需给 runVerify 加 signal 支持),本次不涉及。
