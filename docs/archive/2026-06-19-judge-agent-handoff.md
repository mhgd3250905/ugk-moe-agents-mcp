# Judge Agent 历史交接索引

日期: 2026-06-19

这份文件原本是 Judge Agent 第一轮实现前的交接入口。当前实现已经完成并在 2026-06-20 合并到 `main`,原文中多处内容已经过时,因此本文降级为历史索引。

当前权威入口:

- `docs/judge.md`
- `AGENTS.md` 的 "Judge 实时监督模式"
- `extensions/judge/`
- `tests/judge-*.test.ts`

## 原交接中已经过时的点

- "状态:待实现" 已过时。Judge 已实现三阶段流程、Driver 委派、实时纠偏、最终交付和 `/judge` 菜单。
- "Judge 和 Driver 必须不同模型" 已过时。当前要求是独立 agent 定义和隔离 session;模型源暂同,pi 0.79.4 不消费 agent frontmatter 的 per-agent model 作为运行时切换依据。
- "完工后删除 Flow 上层" 已过时。当前版本保留 Flow;Judge 与 Flow 并行存在,只复用 shared driver session 底座。
- "过程终端可选菜单" 已过时。当前委派 Driver 后会自动尝试打开 live-log 终端;`/judge check-bash-window` 可手动检查。
- "Windows conhost launcher.cmd / Windows Terminal 方案" 已过时。当前 Windows 走 Git Bash + `cmd start "" ... --noprofile --norc -lc tail -f`,不写 launcher 文件,不做 `WT_SESSION` / `wt.exe` 特殊适配。
- "sliceNewTranscript" 已过时。当前 Judge 决策用 `DriverSession.ask()` 收集当前响应,不再靠 transcript diff。

## 迁移后的阅读顺序

1. 读 `docs/judge.md` 了解当前行为和边界。
2. 读 `extensions/judge/judge.ts` 看 extension 生命周期。
3. 读 `extensions/judge/judge-driver.ts` 看 wakeup、runningTools、stale wakeup 防护和 live.log。
4. 读 `extensions/shared/driver-session.ts` 看 `ask()` 和 Driver session 底座。
5. 跑 `npm test` 或至少跑 `tests/judge-*.test.ts`。

保留本文的目的只是解释历史脉络,不要把它当作当前实现规范。
