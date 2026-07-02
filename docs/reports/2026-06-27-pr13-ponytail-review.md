# Ponytail Review 记录 — PR #13

日期: 2026-06-27
范围: PR #13 `[codex] v2.1.2 release hardening and UGK UI polish`(merge `63a1798`,已合并)。事后质量审计,目的找遗留问题,非拦合并。
关联提交: `3884f5d`(本次评审产出的修复)

## PR 改了什么

三块:
- UGK 资源隔离(`--no-extensions/skills/prompt-templates/themes` + 显式 `-e`)
- run_task 进度 widget(`runTaskWithRetry` 加可选回调,worker/verify 阶段显示状态)
- UGK 启动 logo / footer 进度条美化

## 已直接修改

- `tests/ugk-cli-args.test.ts:L7,L25`: `path.resolve("D:\\AII\\ugk-tui")` → `path.resolve()`。`buildUgkCliArgs` 是纯函数,测试和断言用同一个硬编码假路径自洽,任何机器都绿——但没真正验证"用传入的 packageRoot 拼路径"这个契约,等于自欺。改成 `path.resolve()`(无参=cwd)让 packageRoot 成为真实可控输入。

## 发现但未改(经 ponytail 拷问判定为不改)

- **UI 测试 deepEqual 整行**:初始直觉判它"强耦合该改成断言不变量",ponytail 拷问后撤回。deepEqual 抓住任何像素变动正是它的价值;改成"含 modelId"反而更弱(logo 改坏也绿)。强耦合在此是特性不是 bug。
- **logo 反复横跳的 commit**(slim→readable→restore original→thicken):已合并,历史改不了,提它零行动价值。

## Ponytail findings

`tests/ugk-cli-args.test.ts:L7`: delete: hardcoded machine-absolute path `D:\AII\ugk-tui`. `path.resolve()`, 1 line. 测试自洽但不验契约。

`run_task 进度 widget`: keep. 每个 `setTaskRunWidget` 都配 `finally { setTaskRunWidget(ctx, undefined) }`(1126/1377/1723/1750 四处),无泄漏;`onWorkerUpdate` 可选回调,两个调用点对称,旧路径不受影响;`appendUniqueProgressLines` + `slice(-5)` 防膨胀。纯增量,复用已有接口,没有为进度造新状态机。

`UGK 资源隔离`: keep. 4 行 flag + 显式 `-e` 解决多 ugk 安装互染,最懒的有效解。没造隔离框架/白名单。

## 自我纠正(评审方法论)

第一版评审列了"2 问题 + 1 流程问题",ponytail 砍完只剩 1 个真问题:
1. 问题1(硬编码路径)——真问题,但严重性说重了(不是"CI 会红",是"测试无效")。
2. 问题2(UI 强耦合)——判反了,撤回。
3. 流程问题(logo 该 squash)——马后炮,撤回。

教训:别为"凑完整报告"列问题。没真问题就说没有,deletion over addition。

## 与本次会话 task 修复的关系

PR#13 改的区域(executeSubtask ~1038、runTaskWithRetry ~1003、工具注册 ~1602)与本会话改的区域(filterTaskContextMessages ~275、agent_end ~2015、exit 边界 ~1856)完全不重叠。437/437 测试在含 PR#13 的 main 之上跑,全绿,无回归。

测试数 524(PR 时)→ 437(现在)的差异是 PR 之后 `ddd5520 删除 judge 模块`造成的,与本 PR 无关。
