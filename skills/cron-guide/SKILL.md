---
name: cron-guide
description: 定时任务(cron)指南。常驻 cron 服务 + ugk 内 cron 工具增删改查。到点自动起 ugk 子进程跑 agent 任务,结果写文件。涵盖服务启动、crontab 表达式、任务管理、开机自启、安全说明。当用户提到定时、cron、定时任务、每天/每小时跑、周期执行、计划任务、到点自动运行或 cron 服务时使用本 skill。
---

# 定时任务(cron)指南

## 架构

```
ugk 实例(任意)  ──HTTP──→  cron 服务(常驻)  ──到点──→  ugk --print "任务"
   cron 工具                node-cron+存储          子进程跑完,结果存文件
```

- **cron 服务是独立常驻进程**,ugk 开不开都行(服务开着就跑)
- 所有 ugk 实例通过 `cron` 工具(走 HTTP)操作同一个服务
- 到点触发时,服务**自动起一个 ugk 子进程**执行任务,跑完退出

---

## 第一步:检查 cron 服务状态

**重要**:任何 cron 操作前,或用户提到定时任务时,agent 应**先用 `cron` 工具 `action=status` 检查服务是否在线**。

- **在线**:返回 `✅ cron 服务在线`,任务数、端口等信息 → 可正常 add/list/remove/history
- **离线**:返回 `❌ cron 服务未启动` → **告诉用户服务没起,让用户自行启动**(`npm run cron:start`)。**不要在 skill 里自动启动服务**——服务是用户的常驻进程,启动方式应由用户决定(手动 / 后台 / 开机自启),agent 不越界。

服务在线时 status 返回示例:
```
✅ cron 服务在线
任务: N 个(已调度 N)
端口: 17741
地址: http://127.0.0.1:17741
```

---

## 用 cron 工具管理任务(在 ugk 对话里)

### 查服务状态
```
用 cron 工具,action=status
```

### 新增定时任务
```
用 cron 工具,action=add,schedule="0 9 * * *",prompt="用 scout 检查 git 未提交的改动,生成简报"
```

### 列出所有任务
```
用 cron 工具,action=list
```

### 删除任务
```
用 cron 工具,action=remove,id="job_xxx"(先 list 拿 id)
```

### 查执行历史
```
用 cron 工具,action=history           # 全部
用 cron 工具,action=history,id="job_xxx"  # 某任务的最近 20 次
```

---

## crontab 表达式速查

标准 5 段:`分 时 日 月 周`

| 表达式 | 含义 |
|---|---|
| `* * * * *` | 每分钟(测试用) |
| `*/5 * * * *` | 每 5 分钟 |
| `0 * * * *` | 每小时整点 |
| `0 9 * * *` | 每天 9:00 |
| `0 9 * * 1-5` | 周一到周五 9:00 |
| `0 0,12 * * *` | 每天 0:00 和 12:00 |
| `30 8 1 * *` | 每月 1 号 8:30 |

- `*` 任意,`*/N` 每 N,`a,b` 列举,`a-b` 范围
- 时区按**服务器本地时区**
- 校验:`cron validate <表达式>`,或服务会自动校验(无效则拒绝)

---

## 结果在哪看

每次任务执行:
- **输出文件**:`~/.pi/agent/cron-output/<任务名>-<时间>.txt`(完整 stdout+stderr)
- **历史记录**:`~/.pi/agent/cron-runs.json`(退出码、时间、stderr 摘要)
- 在 ugk 里查:`cron` 工具 action=history

---

## 配置

| 项 | 默认 | 环境变量 |
|---|---|---|
| 服务端口 | 17741 | `UGK_CRON_PORT` |
| 服务地址(工具侧) | http://127.0.0.1:17741 | `UGK_CRON_URL` |

---

## 安全说明(重要)

1. **任务 prompt 有完整工具权限**:到点起的 `ugk --print` 子进程和正常 ugk 一样能用所有工具(read/bash/edit 等)。
2. **权限门仍生效**:危险 bash(`rm -rf`/`sudo`/`chmod 777`)在非交互模式被**直接拦截**(fail-safe)。
3. **服务只监听 127.0.0.1**:不对外暴露,只有本机能访问。
4. **prompt 即代码**:任务描述会被当 agent 指令执行,添加来源不明的任务前审阅 prompt 内容。
5. **成本注意**:每次触发都消耗 token(API 调用)。高频任务(如每分钟)会产生持续费用,慎用。

---

## 工作原则(给 agent 的提示)

1. **先确认服务在线**:任何 cron 操作前,先 `action=status`,服务没起就引导用户 `npm run cron:start`。
2. **schedule 要标准**:5 段 crontab,服务会校验;无效表达式 add 会返回 400。
3. **prompt 要自包含**:到点执行的是全新 ugk 进程,没有当前对话上下文。prompt 要写清要做什么(像给一个新 agent 的任务)。
4. **建议复用 subagent**:复杂任务可在 prompt 里指示"用 subagent 工具委派 scout/worker",享受隔离 context。
5. **测试用 `* * * * *`**:新增后用每分钟表达式快速验证,确认能触发再改成正式的低频 schedule。
