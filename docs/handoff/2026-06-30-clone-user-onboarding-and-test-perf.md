# Handoff — 克隆用户开箱可用性审核 + 修复

> 日期：2026-06-30
> 上一份 handoff：`docs/handoff/2026-06-29-task-run-progress-visibility.md`
> 代码基线：会话开始 `cf54a8f`(477/477/0)→ 会话结束 `5ac580f`(**479/479/0**)
> 工作树：干净(已全部 commit + push)

---

## 本次会话做了什么

主题：**审核"用户从 GitHub 克隆 → 配 key → 跟 doctor 走完 → 所有出场功能是否都能用"这条链路**，修复发现的阻塞，并顺带修了一个严重的测试性能 bug。

### 起点：系统性可用性审核

逐项核对 README 列的全部出场功能在"克隆 + npm install + 配 key + doctor 走完"后的可用性。发现 5 个问题（3 阻塞 + 2 隐患），逐一处理。

### 修复的 3 个真问题

#### 问题 1：subagent 预设 agent 不自动部署（阻塞）→ 修复 `b12e3db`
- **根因**：`discoverAgents` 只读 `~/.pi/agent/agents/`（user）和 `.pi/agents/`（project），不读随包 `agents/`。出厂发布的 .md 文件没人加载。
- **修法**：`discoverAgents` 开头加载随包 `agents/`（install 级，最低优先级，被 user/project 覆盖）。模块内自算 packageRoot（与 index.ts:115 同公式），**0 个调用点改签名**。
- **效果**：新用户配好 key + 进 ugk，`@scout`/`/implement`/`/task` 全链路开箱即用，无需 `cp agents/*.md`。

#### 问题 2：cron spawn 对克隆用户 ENOENT（阻塞）→ 修复 `5ac580f`
- **诊断（重要修正）**：实测发现 **subagent/task worker 不受影响**——`getPiInvocation` 分支 A 用 `process.execPath + argv[1]绝对路径`，克隆用户（`node bin/ugk.js` 启动）命中分支 A，不依赖 PATH 上的 ugk/pi。**只有 cron 是真断点**——它有独立的 bin 解析（`cron/agent-bin.ts`），不经 getPiInvocation。
- **修法**：`getCronAgentBin` 在 ugk 不可用时，回退 `node + 随包 bin/ugk.js` 绝对路径（不再回退不存在的 pi）；service.ts spawn 统一 `shell:true`（兼容裸命令名和 node abspath 两种形态）。
- **验证**：真实 spawn 冒烟测试（强制走 fallback，spawn 跑 `ugk --version` 验证退出码 0）。

#### 问题 4：windows-shell.md / checks.ts 残留本机路径（隐患）→ 修复 `f0248cc`
- **发现**：不止文档，连生产代码 `checks.ts` 的 candidates 都硬编码了 `D:\Git`/`E:\Application\Git`——同事本机/臆造路径。
- **修法**：候选只留 Git for Windows 官方默认位置（64/32 位 Program Files）。装别处的用户由 doctor 引导提供路径 + set_shell_path.mjs 写入 settings.json。

### 核查后判定为 YAGNI/误判的 2 个问题（不改）

#### 问题 3：cron/task 出厂无引导 → 确认 YAGNI
- **cron 引导充分**：README + cron-guide skill + 工具返回"服务未启动"会引导用户 `npm run cron:start`。
- **task 零内置是设计如此**：taskbook 是用户自建（`/task` 菜单入口 + task-creator skill），不是缺陷。

#### 问题 5：update-preflight 首启误报 → 确认误判
- subagent 假设"clone 的 HEAD 天然落后 main"。但实际 clone 当下 HEAD = clone 时刻 main sha，`detectUgkUpdate` 第 66 行 `currentRef === latestRef` 返回 undefined → **不提示**。只有 clone 后远程真有新提交才提示，那是正确行为。

### 额外修复：测试性能 bug（重要）→ 修复 `6c82599`
- **现象**：全量套件 7+ 分钟。单测试 932ms，全量里 373~433 秒。
- **根因**：`subtask-tool.test.ts` 的 `run_task parallel` 测试只 mock 了 worker/dispatcher，**漏了 checker**。bad-task verify 失败后真实 spawn checker 子进程，全量环境（无 API key/网络）下挂起。
- **修法**：补 `setTaskCheckerRunnerForTests(checkerAbortMock())`。全量套件 **7 分钟 → 8 秒**（约 50 倍提速）。既治性能，也治"测试依赖执行顺序"的脆弱性。

---

## 关键认知修正（ponytail 验证教训）

这次有几个判断被实测推翻，值得记录：

1. **问题 2 范围**：subagent 一开始说"subagent/cron/task 三大能力都 spawn ENOENT"。实测 `node bin/ugk.js` 时 `argv[1]` 存在 → getPiInvocation 分支 A 命中 → **只有 cron 是真断点**。修复范围从"改 getUgkBin + 全链路"缩到"只改 cron"。
2. **问题 5**：subagent 假设 clone HEAD 天然落后，实测 clone 当下 HEAD = main sha。
3. **测试性能 bug 根因**：不是"并发争抢端口"（最初猜测），是某测试漏 mock checker → 真实 spawn。

教训：**非平凡判断必须实测验证**（之前 `withDefaultExists` 翻车同源）。

---

## 测试基线

- 会话开始：`cf54a8f`（477/477/0）
- 会话结束：**479/479/0**（`5ac580f`，+2 新测试：discoverAgents 冒烟 + cron spawn 冒烟）
- 全量耗时：**8 秒**（修复前 7 分钟）

---

## 改动 commit 清单（后半程，按主题）

| commit | 内容 |
|---|---|
| `b12e3db` | feat: subagent 预设 agent 随包自动加载（install 级） |
| `f0248cc` | fix(doctor): 删 D:/E: 臆造路径，只留 Program Files |
| `6460962` | docs: 清理过期文档（DEVELOPMENT.md 部署说明 + README skill 表/checker.md） |
| `6c82599` | fix(tests): 慢测试补 checker mock，全量 7 分钟→8 秒 |
| `5ac580f` | fix(cron): getCronAgentBin 回退 node+随包 bin/ugk.js，克隆用户不再 ENOENT |

（前半程 task 进度可见性见 `2026-06-29-task-run-progress-visibility.md`；PR#23 environment-doctor + Android 移除见对应 merge commit）

---

## 不动的部分（边界已验证）

- **getPiInvocation 分支 A 不动** —— 实测克隆用户命中它，用 node+abspath，对克隆用户是好的
- **getUgkBin 不动** —— 它只是分支 C 的兜底，且 subagent/task worker 不经它（走分支 A）
- **discoverAgents 的 7 个调用点签名不动** —— 模块内自算 packageRoot
- **taskbook 零内置保留** —— 是设计如此（用户自建）

---

## 待验证项（新会话/用户操作）

- 新开 ugk，确认 `@scout`/`@planner`/`@reviewer`/`@checker`/`@worker` 直接可用（无需 cp）
- 克隆场景跑 `npm run cron:start`，确认 cron 到点能 spawn agent（不再 ENOENT）
- 跑 `npm test` 确认 8 秒级（不再是 7 分钟）

---

## 建议 skills（新会话）

- **ponytail** — 全程遵循（多次判断被实测推翻，证明"非平凡判断必须验证"的价值）
