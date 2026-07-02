# skill 来源收口：user-skills 目录 + skill-guide

> 日期：2026-06-25
> 关联提交：`2569ff2`

## 背景

用户诉求：ugk 的 skill 来源要可控，只有"系统自带 + 用户手动安装"，外部目录（`~/.agents/skills`、`~/.pi/agent/skills` 等）一律不加载。且用户安装/创建的 skill 要跟着 ugk 包走（git clone 到哪，就在哪），不是跟着 cwd 走。

## 现状（改动前）

skill 有 4 个来源，pi 的 `addAutoDiscoveredResources`（package-manager.js:1850）扫描：
- `~/.pi/agent/skills`（user）
- `<cwd>/.pi/skills`（project）
- `~/.agents/skills` + 祖先 `.agents/skills`（跨工具）
- settings `packages` 声明的包

ugk 的系统自带 skill 走另一条路：`-e extensions/index.ts` → `resources_discover` 事件 → `additionalSkillPaths`，独立于上面四个扫描入口。

ugk 的全局 `~/.pi/agent/settings.json` 已写 `"skills": ["!skills/**"]`，这把 pi 自带的 4 个扫描入口全挡住了（它们 SKILL.md 的 rel 都是 `skills/...`）。但 packages 通道不受控（见 ponytail 文档）。

## 修复

### 1. 新增 user-skills 通道（extensions/index.ts）

`resources_discover` 合并扫描 `skills/` + `user-skills/` 两个目录，都用同一个 `scanSkillPaths`：

```ts
skillPaths: [
    ...scanSkillPaths(path.join(packageRoot, "skills")),
    ...scanSkillPaths(path.join(packageRoot, "user-skills")),
],
```

- `skills/` = 系统自带，跟包走，更新覆盖
- `user-skills/` = 用户手动安装/创建，同样跟包走
- 两者用同一加载机制，来源统一

### 2. 导出 scanSkillPaths（extensions/index.ts）

从私有改为 export，供 tests/skill-paths.test.ts 单测。

### 3. 新建 skills/skill-guide/SKILL.md

UGK 专属的 skill 管理 skill，规范：
- 两个来源说明
- 唯一安装位置 `<ugk>/user-skills/<skill-name>/`
- **打平安装规则**：来源是多 skill 包仓库时，只取每个 skill 包本体（SKILL.md + scripts/assets），平铺到 `user-skills/`，丢弃仓库的 README/.git/tests/包裹目录
- 禁止位置（`~/.agents/skills/`、`/tmp/` 等）
- 不碰 anthropic 的 skill-creator（保持可同步更新）

### 4. AGENTS.md 更新

skills 段落从列清单改为说明两个来源 + user-skills 约定。

## 为什么 user-skills 跟着包走，不跟 cwd

- 系统自带 skill 本来就在 packageRoot（ugk 安装目录），跟包走。
- user-skills 放 packageRoot 下，与系统 skill 同源同机制。用户 git clone ugk 到新机器，user-skills 一起带走。
- 不碰 settings.json、不碰 pi 的 skill 目录扫描，加载机制完全统一。

## 设计约束（踩坑记录）

第一版误做成 `<cwd>/.pi/user-skills/`（跟 cwd 走），写了 `bin/ugk-project-skills.js` 往项目级 settings.json 注入 plain path。后纠正：
- 用户要的是"跟 ugk 包走"不是"跟 cwd 赚"。
- 用 resources_discover 合并扫描更简单，零 settings 介入。
- cwd 方案的代码全部撤销，残留的 `<cwd>/.pi/settings.json` 手动清理。

## 测试

`tests/skill-paths.test.ts` 4 个：scanSkillPaths 对两类目录都能扫到、跳过无 SKILL.md 的子目录、容错缺失目录、user-skills 打平布局。501→505 全绿。
