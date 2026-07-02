# 对抗性代码审查 — ugk-core 全架构

> 日期：2026-06-30
> 审查对象：基线 `26bd68f`(main,测试 475/475/0)
> 审查方法：第一性原则 + ponytail + 对抗性(每条 sub agent 结论都自己复核源码)
> 结论：**3 处真问题已全部修复**(478/478/0),5 处误报已排除并记录
> 修复后基线：测试 **478/478/0**(+3 回归测试)

---

## 审查范围与方法

对 `extensions/`(约 11000 行 TS)做全架构对抗审查,重点:
- 安全敏感:权限门正则、chrome-cdp(本地登录态 Chrome)、命令注入面
- 复杂逻辑:task.ts(2340 行,依赖校验/重试/abort/并行)、并行原语
- 资源管理:子进程 spawn/kill、CDP tab、MCP transport

**对抗流程**:派 sub agent 初审 → **逐条复核源码**(不轻信) → 真问题修、误报标明排除。本轮 sub agent 的初始结论有部分过时/误报,复核纠正了 5 处。这正是对抗审查的意义。

---

## 已修复的真问题(3 处)

### P0-1(安全):权限门正则可绕过 `rm -fr /` 等

**根因**：`extensions/index.ts:349` 旧正则 `/\brm\s+(-rf?|--recursive)/i` 锁定了 `-r` 必须在 `-f` 前。但 rm 的 `-r`/`-f` 是**顺序无关的独立 flag**。

**实测绕过**（node 矩阵验证）：
```
放行(危险)  rm -fr /          # f 在 r 前
放行(危险)  rm -f -r /        # 分写且 f 在前
放行(危险)  rm --force --recursive /  # long flag 反序
```

**修复**：改为顺序无关的"rm 后(同一命令段内,不跨 `|;&` 分隔符)出现含 r 的短选项或 `--recursive`"：
```ts
/\brm\b[^|;&]*(-\w*r\w*|--recursive)/i
```
chmod/chown 777 同理改 `[^|;&]*`。**29 条变体矩阵全过**(node 实测 + 测试钉死)。

**回归测试**：`tests/ugk-command.test.ts` 加参数化用例,18 条应拦截 + 11 条应放行,覆盖所有 flag 顺序/分写/长短选项组合。

---

### P0-2(资源泄漏/攻击面):Chrome 进程永不回收

**根因（初版判断，部分正确）**：`extensions/chrome-cdp/launcher.ts:92` `launchChromeCdp` 用 `spawn({detached:true})` + `child.unref()`,child 句柄用完即丢。**全仓 grep kill 零命中**——没有任何代码关闭这个 Chrome。带 `--remote-debugging-port` + 用户登录态的 Chrome 永久驻留桌面,端口持续监听。

**初版修复（37900c4 + c4d4d81，失败）**：用 child 句柄 + `taskkill /T` 杀进程树。单元测试 + 端到端测试（cmd /c ping）全绿。**但真机验证失败**——Ctrl+C 后 Chrome 仍残留。

**真根因（第一性原理诊断，0bde2a7 修复）**：用 debug 日志锁定因果链断点：

```
ADD child pid=18416
EXIT pid=18416 code=0 sig=null → delete   ← 153ms 后 child 报告退出!
teardownManagedChrome children=0          ← Set 空,没东西可杀
```

Windows Chrome 的 `spawn` child 是个 **stub 进程**：它派生真正的工作进程后**立刻 exit(code=0)**。`child.on("exit")` 一触发就把句柄从 Set 删掉,teardown 时 Set 空、没东西可杀 → 真正的 Chrome 成孤儿永久残留。

**为什么初版的测试没抓住**：端到端测试用 `cmd /c ping` 模拟进程树,但 cmd 不像 Chrome 那样 stub-exit——cmd 持续存活,测错了模型。这是"测试通过但真机失败"的典型教训:**模拟用例和真实目标的进程生命周期模型不同时,测试会给假信心**。

**最终修复（port 锚定查杀）**：抛弃不可靠的 child 句柄,改用 port 作为锚点：
- `launchChromeCdp` 只登记 port（不再管 child 句柄,child 仍 unref）
- teardown 按 `--remote-debugging-port=<port>` 查所有 `chrome.exe` 进程（Windows: PowerShell `Win32_Process` + `taskkill /T /F`；Unix: `pgrep -f` + `kill`），覆盖 stub-exit 后的所有工作进程整棵树
- 真正可靠的锚点是 port：**不管 stub 怎么退出,真 Chrome 命令行都带这个 port,都能被查到**

**真机验证**：ugk `/cdp launch` → Ctrl+C 退出 → 调试 Chrome 自动消失 ✓（初版残留,修复后消失）。

**回归测试**：单元测试验证 port 登记 + teardown 对每个 port 调 `killChromeByPort` + 清空 + 幂等。port 查杀的系统行为（PowerShell + taskkill）靠真机验证兜底——单元层无法可靠 mock（生产按 `Name='chrome.exe'` 过滤,测试用 node 进程冒充会被过滤；node 又拒绝 `--remote-debugging-port` 参数,假绿）。

---

### P2-5(健壮性):CDP onmessage 的 JSON.parse 无 try/catch

**根因**：`extensions/chrome-cdp/client.ts:115` `socket.onmessage` 里 `JSON.parse(String(event.data))` 无防护。Chrome 发畸形帧(多帧拼接/二进制/协议错)时抛出,此时 `cleanup()` 未调用、`timer` 未清、`socket` 未关,promise 挂起到 timeout(钳位后最长 5min)。

**修复**：包 try/catch,parse 失败立即 cleanup + close + reject(含截断的原始帧前 200 字符便于诊断)。

**回归测试**：`tests/chrome-cdp-client.test.ts` 加 `MalformedWebSocket` 专用 mock,断言 reject `/malformed message/i` + socket.close 被调用 + 耗时 < 5s(不挂等到 timeout)。

---

## 已排除的误报(5 处,记录以防重复审查)

对抗复核纠正了 sub agent 初始审查的过时/误判:

| # | sub agent 初判 | 复核结论 | 依据 |
|---|---|---|---|
| 1 | PR #21 "未合并且高危,会静默删 CDP autolaunch" | **误报** | `gh pr view 21` 显示 **已 MERGED**(2026-06-28)。那份 review 文档是合并前的审查 |
| 2 | doctor/ 有 `checks.ts`/`formatter.ts` 死代码 | **误报** | 实际 `extensions/doctor/` 只剩 `index.ts`(47 行 legacy notice)。死代码**早已删除** |
| 3 | driver-session.ts 引用残留 | **部分真** | 代码层零引用(已彻底删,改名 `driver-view.ts`)。**仅 docs 残留**——文档债非代码债 |
| 4 | chrome-cdp autolaunch 绕过 ask 授权门 | **误报** | `task-worker.ts:101` 用 `UGK_TASK_ALLOW_CHROME_CDP` env 守门,该 env 只在 taskbook 声明 chrome_cdp **且通过 task 授权门**(`task.ts:767`)时设。授权链完整,设计正确 |
| 5 | findTab 无 target 时 fallback `tabs[0]` 是并发竞态 | **降级为 nit** | worker 路径注入 `UGK_CDP_TAB_ID` 到 sessionTabId,**正常路径不 fallback**。fallback 仅 `/cdp` 手动操作场景,是用户主动选当前 tab 的合理行为,非并发 |

---

## 核实为良好(不计入问题)

- **命令注入面**:`launcher.ts` 的 `port` 走 `parsePort`(严格 1-65535),spawn 用数组参数非 shell 拼接;`/json/new` 用 `encodeURIComponent`;`/json/close/<id>` 的 id 来自 Chrome 返回非用户输入。**无注入**。
- **task.ts 校验链**:env→binary 两条路径(executeSubtask + handleTaskRun)契约一致;`runTaskWithRetry` 的 abort 语义收窄(`workerAborted` vs `signal.aborted`);verifyResult 合成避免 null-guard 散落;parseFailed 隔离批次。**设计严谨,无 bug**。
- **并行原语**:`mapWithConcurrencyLimit`(worker pool,JS 单线程 nextIndex++ 原子,results 按索引保序)、`truncateParallelOutput`(while 切片)。**经典正确实现**。
- **subagent/mcp 资源清理**:subagent worker SIGTERM→超时→SIGKILL→finally;mcp `closingClients` WeakMap 防重复关闭 + `killClientProcess` 强杀 + `closeBestEffort` 带超时。**干净**。
- **DNS rebinding**:Chrome 66+ 内置 Host header 校验已防,本工具无需自己加。
- **仓库卫生**:`nul`/`wangnuanwei-*.md`/`website/` 全部 untracked + gitignored,无害。
- **架构守卫**:`tests/task-extension.test.ts` 用 `assert.doesNotMatch` 强制 task/ 不 import chrome-cdp/mcp/,依赖反转通过 `shared/worker-lifecycle.ts` 中立层。**真实存在且未被破坏**。

---

## 未做(留后续,ponytail YAGNI)

- **端口随机化**(P1-3):launcher 用固定 9222。`--remote-debugging-port=0` + 显式 `--remote-debugging-address=127.0.0.1` 可消除固定端口可预测性。超出本轮"全部修"确认范围,记此。
- **端口绑定显式声明**:launch 命令未显式传 `--remote-debugging-address=127.0.0.1`(靠 Chrome 默认)。纵深防御可补。
- **integration 测试缺口**:task/chrome-cdp/subagent 缺端到端 integration 层(目前只有 MCP 有)。非阻塞。

---

## 验证

```bash
cd E:/AII/ugk-core
npm test   # 478/478/0(+3 回归),8.9s
```

每块修复的回归测试均经过"反向验证"思路确认有效(权限门:旧正则放行 `rm -fr /` 已在初次矩阵测试中显示;teardown/JSON.parse:测试逻辑直接断言 kill/reject 语义)。

---

## 改动清单

## 提交历史（按时间倒序）

```
0bde2a7 fix(chrome-cdp): Chrome teardown 改用 port 查杀(child 句柄不可靠,根因修复)  ← P0-2 最终
c4d4d81 fix(chrome-cdp): Windows 进程树级联 kill(真实验证发现的缺陷)               ← P0-2 中间(后被 0bde2a7 重写)
7201007 docs: 对抗性代码审查报告(3 真问题修复 + 5 误报排除)
b49c9c0 fix(chrome-cdp): CDP onmessage 畸形 JSON 帧不再挂死                         ← P2-5
37900c4 fix(chrome-cdp): 调试 Chrome 进程 teardown 回收(资源泄漏/攻击面)            ← P0-2 初版(失败)
77001a2 fix(security): 权限门 rm flag 顺序绕过(根因修复)                            ← P0-1
```

P0-2 经历三轮:初版(child 句柄,37900c4)→ 进程树 kill(c4d4d81)→ port 查杀(0bde2a7)。前两轮单元/集成测试全绿但真机失败,第三轮用第一性原理诊断(debug 日志锁定 `children=0`)+ 真机验证通过。这条曲线本身是审查方法论的记录:**自动化测试不是充分条件,真机验证 + 第一性诊断不可省**。

## 最终改动清单（相对审查基线 26bd68f）

```
 extensions/chrome-cdp/client.ts   | 13 +-    (P2-5 try/catch)
 extensions/chrome-cdp/launcher.ts | 60 +-    (P0-2 port 查杀,经 3 轮迭代)
 extensions/index.ts               |  8 +-    (P0-1 正则)
 tests/chrome-cdp-client.test.ts   | 40 +     (P2-5 回归)
 tests/chrome-cdp-launcher.test.ts | 30 +     (P0-2 port 登记/teardown 单元)
 tests/ugk-command.test.ts         | 48 +     (P0-1 回归)
```

三块互不耦合,可独立 cherry-pick。
