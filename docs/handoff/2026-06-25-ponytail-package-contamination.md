# ponytail skill 污染排查（pi packages 注册）

> 日期：2026-06-25
> 关联提交：无（仅改 user scope 配置 + 删 git clone 缓存，不进仓库）

## 现象

ugk 的 system prompt 里出现 `ponytail` 全家桶（ponytail / ponytail-audit / ponytail-debt / ponytail-gain / ponytail-help / ponytail-review），用户从未主动安装。

## 根因

**不是 ugk-core 代码引入的**。元凶是 pi 的 package 安装机制：

- `~/.pi/agent/settings.json` 的 `packages` 数组里有一行 `git:github.com/DietrichGebert/ponytail`。
- 该 package 在 2026-06-21 01:12 被某个操作（pi 的 package 命令或 UI）安装，clone 到 `~/.pi/agent/git/github.com/DietrichGebert/ponytail/`。
- ponytail 的 `package.json` 声明 `"pi": { "skills": ["./skills"] }`，自带 6 个 skill。
- pi 的 package 加载机制（`resource-loader.js` 的 `extendResources`）把 package 内 skills/ 并入 skill 列表 → 进 system prompt。
- **packages 通道独立于 settings 的 `skills` 字段**：ugk 的全局 `"skills": ["!skills/**"]` 排除规则管不到 packages。

## 修复

1. 从 `~/.pi/agent/settings.json` 的 `packages` 数组删除 `git:github.com/DietrichGebert/ponytail` 那行。
2. 删除 clone 缓存 `~/.pi/agent/git/github.com/DietrichGebert/`（3.4M）。

两步都是 user scope 操作，不进仓库，不影响 ugk 代码。

## 关键事实（供排查同类问题）

| pi skill 来源 | 路径 | 控制方式 |
|---|---|---|
| 系统自带 | `<packageRoot>/skills/` | 跟包走，ugk 通过 `-e` 扩展的 resources_discover 加载 |
| pi 自动扫描 | `~/.pi/agent/skills`、`<cwd>/.pi/skills`、`~/.agents/skills`、祖先 `.agents/skills` | 全局 settings `"skills": ["!skills/**"]` 一条 glob 全挡住（rel 都是 `skills/...`）|
| packages 注册 | settings 的 `packages` 数组 → clone 到 `~/.pi/agent/git/` 或 `npm/` | 独立通道，**不受 `!skills/**` 影响**，需删 package 注册 |

## 教训

- "为什么有这个 skill"要查 `settings.json` 的 `packages` 字段，不只看 skills 目录。
- ugk 的 `!skills/**` 规则只能挡住 pi 自带的 skill 目录扫描，挡不住 packages。
