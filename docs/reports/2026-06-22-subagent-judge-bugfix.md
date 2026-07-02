# Subagent / Judge bugfix 记录

日期: 2026-06-22

## 问题

1. 异地安装的新项目里,Sub agents 可能提示 API key 不通。
2. Judge 模式下的 Judge/Driver agent 也需要确认是否有同类模型解析问题。
3. `/judge run` 时主 Agent 上下文占用增长过快。

## 根因

- Subagent 子进程使用 `ugk/pi --mode json -p --no-session`,agent frontmatter 里的裸模型名 `deepseek-v4-pro` 会交给 CLI 解析。当前模型表里同一个裸 id 同时存在于 `deepseek`、`opencode`、`opencode-go`,新环境默认 provider/auth 不完整时容易落到无 key provider。
- Judge/Driver agent frontmatter 也使用裸 `deepseek-v4-pro`,存在同类风险。
- Judge aligning 的隐藏 `judge-align-context` 是 custom message。历史 session 中旧的 align context 会进入后续 LLM context,`/judge run` 虽然跳过 aligning,但仍可能携带这些历史隐藏 prompt。

## 改动

- Subagent 启动前把 `deepseek-v4-pro` / `deepseek-v4-flash` 规范化为 `deepseek/deepseek-v4-*`。
- Subagent 子进程显式继承 `PI_CODING_AGENT_DIR`,保证读取同一份 `auth.json` / `settings.json`。
- `agents/driver.md` 与 `agents/judge.md` 改成 provider-qualified 模型名。
- Judge context hook 过滤历史 `judge-align-context`:aligning 只保留最新一条,非 aligning 阶段全部移除。

## 验证

- `npm test`
- `git diff --check`
