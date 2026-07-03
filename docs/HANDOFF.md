# HANDOFF — ugk-moe-agents-mcp 接手文档

> 给**完全没参与过本设计的 agent**(Claude Code / Cursor / 另一个 ugk)看。读完这份 + README + DESIGN + AGENTS.md 就能干活。

---

## 0. 先做三件事(5 分钟)

1. 读 [README.md](../README.md)(是什么/怎么用)+ [DESIGN.md](../DESIGN.md)(为什么这么设计)+ [AGENTS.md](../AGENTS.md)(运行时红线)
2. `git log --oneline -10` 看最近做了什么
3. `npm test` —— 基线 **245 pass / 0 fail**

---

## 1. 项目当前状态

### 已实现

| 模块 | 文件 | 职责 |
|---|---|---|
| MCP 网关入口 | `gateway/server.mjs` | 4 个 tool:run_expert / check_job / get_result / doctor |
| 专家包发现 | `gateway/registry.mjs` | 扫 `~/.pi/agent/experts/<name>/` |
| spawn + job 管理 | `gateway/runner.mjs` | spawn 干净 ugk + 异步 job + verify gate |
| verify gate | `gateway/verify.mjs` | runVerify:exit 0=PASS / 非0=FAIL + VerifyFailure[] |
| 权限系统 | `gateway/requirements.mjs` | 三类权限 声明→检查→应用→注入 |
| CLI doctor | `gateway/doctor.mjs` | 交互式配权限(唯一能写 consent 的入口) |
| 单 skill 地基 | `extensions/index.ts` resources_discover | UGK_ONLY_SKILL env 分支 |

### 测试基线

```
npm test   →  tests 245 / pass 245 / fail 0
```

主要测试:`gateway-registry` / `gateway-verify` / `gateway-requirements`(16 cases,含安全约束)/ `mcp-*` / `chrome-cdp-*` / `subagent-*`。

**基线不能掉。改完 `npm test` 必须 ≥ 245 pass / 0 fail。**

### 专家包样本

- `examples/experts/echo/` — 最小链路验证(无依赖)
- `examples/experts/x-search/` — 真实检索(需 Chrome 登录态 + CDP)

### 已验证

- ✅ echo 端到端:run_expert→check_job→get_result 全链路 PASS
- ✅ 权限门 5 场景:echo 正常起 / x-search 缺权限 BLOCKED / doctor 查询 / doctor apply env / **doctor apply consent 被拒**

---

## 2. 设计红线(必须遵守)

违反这些 = 走回旧 task 老路。详见 AGENTS.md。

1. **不加过程脚手架**(四阶段/dispatcher/checker/白名单/状态机)——这是相对旧 task 的核心区别
2. **专家 = 标准 skill + verify**,不发明概念
3. **UGK_ONLY_SKILL 是地基**,别破坏 resources_discover 的 env 分支
4. **异步句柄不能改同步**(MCP 60s 超时)
5. **consent 安全边界**:chrome_cdp 只能 CLI doctor 写,MCP doctor 拒绝
6. **专家包是隔离进程**,别引入跨专家共享状态

---

## 3. 已知陷阱(我踩过的坑,别重踩)

### ① 浅克隆导致 push 失败
fork 时用了 `--depth 1`,历史对象缺失。已用 `git filter-branch` 修复。**接手者 clone 用完整克隆,别再用 `--depth 1`。**

### ② 专家实例需要初始 prompt 激活
spawn 时只给 `--mode json -p` 不够。**必须传 prompt** 告诉专家读 SKILL.md + 环境变量契约。见 `gateway/runner.mjs` 的 prompt 构造(~150 行)。改 spawn 逻辑别砍这 prompt。

### ③ workspace trust 门
专家实例 headless 会撞 ugk 的 workspace trust 门。**必须注入 `UGK_SKIP_WORKSPACE_TRUST=1`**。见 `runner.mjs` childEnv。

### ④ chrome_cdp 授权漏洞(已修)
曾经 runner 无条件注入 `UGK_TASK_ALLOW_CHROME_CDP=1`。**现状**:授权由 `requirements.mjs getEffectiveEnv(pkg)` 算,**只在 config.json consent=true 时才注入**。回归测试见 `gateway-requirements.test.ts`。

### ⑤ 冗余扩展已清理
cron/plan-mode/task/ui-brand/doctor扩展 等已删(见 git log "删除冗余扩展")。`extensions/index.ts` 只留必要扩展。**别加回来。**

### ⑥ x-search 真实运行需 Chrome 登录态
echo 本地随便跑(零依赖)。x-search 需 Chrome 登录 X + CDP + DEEPSEEK_API_KEY + 用户已 doctor 同意 chrome_cdp。**CI 跑不了 x-search**,只能跑 echo + 单测。

---

## 4. 怎么验证(改完代码必做)

```bash
npm test                                    # 全量单测(245 pass 基线)
node --test tests/gateway-*.test.ts         # 只跑网关相关
node gateway/doctor.mjs                     # CLI 权限检查
```

**端到端 echo(手动,起网关 + MCP 调用)**:
```
run_expert({expert:"echo", input:{message:"hi"}})  → jobId
轮询 check_job(jobId) 直到 status != "running"
get_result(jobId) → 期望 status:"pass"
```
> 注:端到端已手动验证 PASS,但没固化成 e2e 脚本入库。**把它脚本化是高价值贡献。**

---

## 5. 下一步候选(按优先级)

1. **echo 端到端脚本化入库** — 写成 tests/e2e.test.ts,CI 能跑。当前最大验证债务。
2. **TUI 教导通道** — 交互式教专家改 skill。设计已留位(DESIGN.md),未实现。
3. **冗余清理续** — `skills/` 下还有 task-creator/task-install-guide/ugk-environment-doctor/cron-guide 等旧 skill,网关用不到,可删。
4. **并行多专家** — mapWithConcurrencyLimit 原语可复用,当前单任务模式。
5. **更多专家包** — video-downloader / mimo-tts 等。

---

## 6. 怎么接手(给接手 agent 的话)

1. 先读 README + DESIGN + AGENTS.md + 本文档
2. `npm test` 确认基线 245 pass。不是就先查为什么掉了,别动新功能
3. 在 `feat/expert-gateway` 或新 `feat/<xxx>` 分支工作。`main` 是发布分支
4. 改完必做:npm test 全绿 + 端到端 echo PASS + 权限场景不破
5. 守红线(§2)。文档数字以实际命令输出为准,改了行为就更新本文档

---

## 附:关键命令速查

```bash
npm test                                    # 全量单测(245 pass)
node --test tests/gateway-*.test.ts         # 只跑网关
node gateway/server.mjs                     # 起网关(MCP stdio)
node gateway/doctor.mjs [expert-name]       # CLI 权限检查/配置
git log --oneline -10                       # 看最近做了什么
```

专家包位置:`~/.pi/agent/experts/<name>/`(可用 `UGK_AGENT_DIR` 覆盖)。样本在 `examples/experts/`。
