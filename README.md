# ugk

**ugk** — 一个开箱即用的终端编码 agent。一条命令安装,打 `ugk` 即用。

> 基于 [pi](https://github.com/earendil-works/pi) 构建,但用户无需关心 pi——`npm i -g ugk-agent` 装完就拥有全部能力(子代理、定时任务、plan 模式、MCP tools 接入等)。

---

## 🚀 安装

### 方式一:一键安装(推荐,适合新手)

```cmd
npx ugk-install
```

交互式安装器会自动完成:检测 Node/npm → 安装 ugk → 引导你配置 DeepSeek API key(验证有效性后自动写入)。装完直接能跑 `ugk`。

> 需要先有 Node.js 18+(安装器会检测,缺失会引导你去 [nodejs.org](https://nodejs.org) 装 LTS)。

### 方式二:手动两步

#### 第 1 步:安装

```cmd
npm i -g ugk-agent
```

> 需要先有 Node.js 18+。没有的话去 [nodejs.org](https://nodejs.org) 装 LTS 版。
> ugk 内置 pi 作为依赖,**不用单独装 pi、不用 clone 本仓库、不用 pi install**。
> pi 是 UGK 的内部运行时依赖,版本由 UGK 发行版固定管理;用户不要单独运行 `pi update`。

#### 第 2 步:配置 API key

ugk 默认用 DeepSeek。去 [platform.deepseek.com](https://platform.deepseek.com) 申请 key:

```cmd
:: 永久生效(推荐,新开窗口才生效)
setx DEEPSEEK_API_KEY sk-你的key
```

**装完。** 任意目录打 `ugk` 就进对话。

```cmd
ugk
```

> 也可以用其他模型(OpenAI/Claude 等),见 [pi 官方文档](https://github.com/earendil-works/pi)。

---

## ⚙️ Windows 用户:修复 bash 工具(重要,不做会报错)

ugk 在 Windows 上默认找 bash,但**只查 `C:\Program Files\Git`** 两个标准路径。
若你的 Git for Windows 装在别处(如 `D:\Git`),会退到 PATH 上的 WSL `bash.exe`,
导致 `bash` 工具报错:`WSL ERROR: execvpe /bin/bash failed 2`

**解法**:找到你的 Git Bash 路径(通常 `<Git安装目录>\bin\bash.exe`),
写进 `%USERPROFILE%\.pi\agent\settings.json`:

```json
{
  "shellPath": "D:\\Git\\bin\\bash.exe"
}
```

> 用 Git Bash 优于 PowerShell:agent 更熟悉 Linux 命令语法,出错率更低。

---

## 🤖 subagent 预设 agent(随包自动加载)

subagent 工具和 5 个预设 agent(`scout`/`planner`/`reviewer`/`checker`/`worker`)**都随包自动加载,开箱即用,无需手动复制。**

进 ugk 后输入 `@scout 列出当前目录`,能调起 scout 就说明可用了。可用 `/subagent` 查看所有 subagent,并给单个 subagent 设置模型。

**自定义/覆盖预设 agent**:把改后的 `.md` 放到 `~/.pi/agent/agents/`,同名会覆盖随包默认(`user` 优先级高于随包 `install`)。

详见 `skills/subagent-guide/SKILL.md`。

---

## ✅ 验证安装

进 ugk 后依次试这些,全部正常说明装好了:

| 输入 | 期望 |
| --- | --- |
| `/ugk` | 弹出状态(列全部能力) |
| `帮我看看当前目录结构` | agent 正常读取并总结项目 |
| `@scout 列出项目目录` | 调 `subagent` 委派 scout(随包预装,直接可用) |
| `/subagent` | 列出所有 subagent,选择后设置该 subagent 的模型 |
| `/plan` | 切换只读探索模式 |
| `/mcp status` | 查看已配置/已连接的 MCP server |
| `rm -rf /tmp/test` | 触发权限门(弹确认) |

---

## 🎬 开始使用

```cmd
:: 任意目录,直接进对话
ugk

:: 一次性非交互模式(脚本/cron 用)
ugk --print "总结当前目录结构"

:: 指定模型
ugk --model deepseek-reasoner
```

进对话后,直接用自然语言或 `/命令` 即可。例:
- `帮我看看这个项目的结构` — agent 自己探索
- `@scout 找一下认证代码` — 委派给 scout 子代理
- `/subagent` — 查看 subagent 并设置单个 subagent 的模型
- `/implement 加个 Redis 缓存` — scout→planner→worker 全链路
- `/plan` — 先只读规划再执行
- `/mcp status` — 查看外部 MCP tools 连接状态

---

## 🔄 更新 UGK

UGK 会在进入 TUI 前检查 GitHub `main` 是否有新版本。发现更新时会像 Codex CLI 一样先停在启动入口,只显示 UGK 自己的选择:

```text
✨ Update available! 1.0.0 (aaaaaaa) -> bbbbbbb

Release notes: https://github.com/mhgd3250905/ugk-tui/commits/main

› 1. Update now (runs `git pull --rebase origin main && npm install`)
  2. Skip
  3. Skip until next version

  Press enter to continue
```

选择 `1` 或直接回车会执行更新,成功后提示重启并退出,不会继续加载旧 TUI。开发仓库内运行时执行 `git pull --rebase origin main && npm install`;正式 npm 安装场景执行 `npm install -g ugk-agent`。`2` 只跳过当前启动,`3` 会跳过当前远端版本直到下个版本出现。

也可以在会话中手动输入:

```text
/update
```

`--print`、`--version`、非交互终端和 `UGK_SKIP_UPDATE_CHECK=1` 会跳过启动前更新检查。UGK 不暴露 pi 更新。pi 是内部 runtime,版本只随 UGK 发布策略变化。

---

## 包含的能力

### 自定义工具

| 工具 | 作用 |
| --- | --- |
| `subagent` | 子代理委派(single/parallel/chain 三模式) |
| `cron` | 定时任务管理(status/list/add/remove/history) |
| `chrome_cdp` | 受保护的本地登录态 Chrome 控制(status/launch/tabs/navigate/evaluate/screenshot) |
| `mcp` | 外部 MCP stdio server 的 tools 接入,注册为 `server__tool` |
| `run_task` | subtask 工具:复用已机器验收的 taskbook,返回 PASS/FAIL + 产物路径(single/parallel,确定性区别于 subagent 的灵活探索) |

### ugk 品牌 UI

ugk 默认通过 `extensions/ui-brand.ts` 加载一层独立的品牌 UI,只使用 pi 官方 extension API:

- `ctx.ui.setHeader()` 替换启动顶部说明为 `ugk` 品牌区
- `ctx.ui.setFooter()` 替换底部状态栏,保留 cwd/branch/token/model/轮次信息;模型名随当前 session 模型动态刷新,并以绿色 chip 高亮
- `ctx.ui.setTitle()` 把终端标题改成 `ugk - <session> - <cwd>`
- 新会话启动时清理当前终端视口和 scrollback,用字符特效启动页填满当前终端高度
- 对话开始后自动回到紧凑 header,不长期占用消息区域
- header/footer 组件在 `session_start` 时抽取普通 session 数据,render 阶段不持有或读取 `ExtensionContext`,避免 session replacement/reload 后 stale ctx 崩溃
- 不替换消息渲染、不替换 editor、不改 pi 内部运行逻辑

临时关闭:

```bash
UGK_UI=0 ugk
UGK_CLEAR_STARTUP=0 ugk
```

运行中切换:

```text
/ugk-ui off
/ugk-ui on
/ugk-ui status
```

随包还提供 `themes/` 主题资源。默认主题是 `ugk-geek`(低刺激荧光绿):首次启动 `ugk` 时会在 `~/.pi/agent/settings.json` 缺少 `theme` 字段时自动补上 `"theme": "ugk-geek"`;如果用户已经显式设置过其他主题,ugk 不会覆盖。
此外还内置 16 个社区主题(改编自 [hasit/pi-community-themes](https://github.com/hasit/pi-community-themes),MIT 协议,见 `themes/NOTICE.md`):`atom-one-dark`、`atom-one-light`、`catppuccin-{frappe,latte,macchiato,mocha}`、`dracula`、`gruvbox-{dark,light}-{hard,medium,soft}`、`nord`、`solarized-{dark,light}`。可在 pi `/settings` 里手动选择,或作为独立主题资源接入。

### slash 命令

| 命令 | 作用 |
| --- | --- |
| `/ugk` | 看 agent 状态 |
| `/welcome` | 欢迎模板 |
| `/subagent` | 列出 subagent 并设置单个 subagent 模型 |
| `/update` | 检查并更新 UGK |
| `/cdp` | 管理本地 Chrome CDP 访问模式、端口、启动和标签页 |
| `/mcp` | 管理 MCP server 状态、权限模式、reload、enable/disable |
| `/ugk-ui` | 开关 ugk 品牌 UI |
| `/ui-language` | 用菜单切换 UGK 菜单/UI 语言 |
| `/ugk-autopilot` | 工具确认总开关菜单,也支持 `on|off|status` |
| `/language` | 语言偏好菜单,也支持 `<语言>|status|clear` |
| `/plan` | 切换 plan-mode 只读探索模式(或 Ctrl+Alt+P) |
| `/todos` | 查看 plan-mode 计划进度 |
| `/task` | 固定任务委托(taskbook 创造/复用/编排) |
| `/implement` | scout→planner→worker 全链路实现 |
| `/scout-and-plan` | scout→planner(只到方案) |
| `/implement-and-review` | worker→reviewer→worker |

### plan-mode 只读探索模式

`/plan` 进入只读模式:工具限制为 read/bash/grep/find/ls,bash 命令过白名单(只放行只读命令,拦 rm/git commit/npm install,并阻止 `curl | sh`、`curl -o`、curl 上传/变更请求等非只读形态)。agent 产出 `Plan:` 编号计划后,可选择执行(恢复全部工具)/继续规划/精炼。执行阶段用 `[DONE:n]` 跟踪进度,状态栏显示 `📋 N/M`。

### Chrome CDP 本地浏览器控制

`chrome_cdp` 用于需要本地登录态 Chrome 的场景:SSO、cookies、CAPTCHA、私有工作区、本地应用截图或 DOM 检查。它不是普通联网检索或文档查询的默认路径。

```text
/cdp status
/cdp ask      # 默认:每次浏览器操作前确认
/cdp on       # 当前会话允许浏览器操作
/cdp off      # 禁用浏览器操作
/cdp port 9222
/cdp launch
/cdp tabs
```

默认模式是 `ask`。非 status 操作需要提供原因并说明普通访问是否已经尝试或不适用。详见 `skills/chrome-cdp-guide/SKILL.md` 和 `extensions/chrome-cdp/README.md`。

### autopilot 与语言偏好

`/ugk-autopilot` 无参会打开中文菜单,可选 `查看状态` / `开启` / `关闭` / `退出`。也可以直接用:

```text
/ugk-autopilot status
/ugk-autopilot on
/ugk-autopilot off
```

autopilot 只自动放行可逆的工具级确认(CDP/MCP/run_task 受保护工具等);危险命令、花钱、不可逆外部副作用仍然归用户确认。状态只在当前 ugk 会话内生效。

`/language` 无参会打开中文菜单,可选 `查看状态` / `设置回答语言` / `清除` / `退出`。也可以直接用:

```text
/language English
/language 日本語
/language status
/language clear
```

语言偏好写入 `~/.pi/agent/settings.json`,跨会话保留;清除后回到 AGENTS.md 的默认中文优先。`/language` 只控制 AI 回复语言偏好,不控制 UGK 菜单/UI 语言。

UGK 菜单/UI 语言单独用 `/ui-language`,不和 `/language` 混用。无参会打开菜单:

```text
/ui-language
```

菜单流程是 `查看状态 / 设置界面语言 / 清除 / 退出`;选择 `设置界面语言` 后,再用上下键选择目标语言。

也保留直输参数给脚本或熟练用户:

```text
/ui-language zh-CN
/ui-language English
/ui-language 日本語
/ui-language status
/ui-language clear
```

`/ui-language` 写入 `~/.pi/agent/settings.json` 的 `uiLanguage` 字段,默认是简体中文。当前支持:简体中文、English、日本語、한국어、Français、Deutsch、Español、Português、Русский。UGK 自有菜单、状态面板、header/footer、CDP/MCP/环境引导/plan 常用提示会随它切换;未补字典的动态长句会退回 English。

### 环境配置引导

旧的 `/doctor` 表格已改为引导式入口。遇到本机环境问题时,直接对 agent 说:

```text
帮我检查环境
bash 不可用怎么办
Chrome CDP 连不上
MCP 配置失败
Node/npm 找不到
怎么切 API / model
```

内置 `ugk-environment-doctor` skill 会一次只处理一个失败模块:Shell/Git Bash、Chrome/CDP、MCP、Node/npm/npx、Windows PATH/权限。API 和模型切换只作为使用说明,不是必要环境体检项;如果 API 还没配置到能进入 agent 对话,请先按安装/登录说明处理。

### MCP tools 接入

UGK 可以作为 MCP client 连接外部 stdio MCP server,把 server 暴露的 tools 注册成 `server__tool`。一期只支持 stdio + tools;resources、prompts、sampling、HTTP transport 暂不启用。

配置文件按四档合并:

- install: UGK 安装目录 `mcp.json`(全局安装目录下的 `ugk-agent/mcp.json`;npm link 开发时即仓库根目录 `mcp.json`),由 UGK 包/项目维护者背书
- user: `~/.config/ugk/mcp.json`(Windows 为 `%APPDATA%\ugk\mcp.json`)
- project: 当前项目 `.mcp.json`
- local: 当前项目 `.mcp.local.json`(已进 `.gitignore`,用于本机 token/path)

示例:

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "."]
    },
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": {
        "GITHUB_PERSONAL_ACCESS_TOKEN": "${GITHUB_TOKEN}"
      }
    }
  }
}
```

install/user scope 视为 UGK 级可信配置,默认直接连接;project/local scope 第一次 spawn 前默认弹确认;非交互模式只允许 install/user scope,project/local 会 fail-closed。工具调用权限复用 `ask/on/off`:

```text
/mcp status
/mcp ask
/mcp on
/mcp off
/mcp reload
/mcp enable filesystem
/mcp disable filesystem
```

`/mcp reload` 会断开并重连 server。pi 当前没有 unregisterTool,所以消失 server 的旧工具会从 active tools 下线;如果 stale 工具被调用,会返回 server disconnected,不会自动重连。MCP 排障由 `ugk-environment-doctor` skill 引导;实际配置细节见 `skills/mcp-guide/SKILL.md`。

### cron 定时服务(独立常驻进程)

```bash
npm run cron:start   # 启动常驻服务(127.0.0.1:17741)
```

到点自动起 `ugk --print` 子进程跑 agent 任务,结果存 `~/.pi/agent/cron-output/`。在 ugk 对话里用 `cron` 工具增删改查任务。详见 `skills/cron-guide/SKILL.md`。

### @mention 手动触发

输入 `@<agent名> <任务>` 自动改写为 subagent 委派:

```
@scout 找一下认证逻辑在哪
@reviewer 审一下这次改动
@worker 重构 utils.ts
```

### skills

| skill | 作用 |
| --- | --- |
| `ugk-guide` | 占位示例 |
| `subagent-guide` | 子代理委派指南(含随包预设 agent 自动加载) |
| `cron-guide` | 定时任务指南 |
| `chrome-cdp-guide` | 本地登录态 Chrome/CDP 使用边界与安全流程 |
| `mcp-guide` | MCP server 配置、权限、命令和排障指南 |
| `bash-guide` | bash 工具/Git Bash 配置与排障 |
| `skill-guide` | skill 加载机制与 user-skills 安装 |
| `skill-creator` | 创建、改进和评测 agent skill(来自 Anthropic skills, Apache-2.0) |
| `task-creator` | 固定 task(taskbook)的创建流程与机制全景 |
| `ugk-environment-doctor` | 引导式环境配置与排障(Shell/CDP/MCP/Node/API) |

### 权限门

危险 bash(`rm -rf` / `sudo` / `chmod 777`)弹确认;非交互模式直接拦截。

---

## 目录结构

```
ugk-core/
├── package.json              # npm 包 manifest(name=ugk-agent, bin=ugk)
├── bin/
│   └── ugk.js                # CLI 入口(薄壳:调 pi main + -e 注入扩展)
├── AGENTS.md                 # 人设 + 项目上下文(给 agent 看)
├── extensions/
│   ├── index.ts              # 主入口:工具/命令注册 + @mention + 权限门 + resources_discover
│   ├── deepseek-status.ts    # /ugk 状态里识别 DEEPSEEK_API_KEY 和 pi /login auth
│   ├── device-env.ts         # getUgkBin(子进程命令自适应)
│   ├── cron.ts + cron-contract.ts  # cron 工具 + 共享类型
│   ├── subagent.ts + subagent-runtime/rendering/agents.ts  # 子代理委派
│   ├── plan-mode.ts + plan-mode-utils/state.ts  # plan 模式
│   ├── chrome-cdp/          # 本地登录态 Chrome CDP 控制
│   ├── mcp/                 # MCP stdio client、registry、tools、permissions、/mcp
│   └── ui-*.ts               # UI 美化(品牌层含 header/footer/title+spinner、状态条)
├── cron/
│   └── service.ts            # 常驻定时服务(node-cron + HTTP,npm run cron:start)
├── agents/                   # 预设 subagent 定义(随包自动加载;同名 user 副本覆盖)
│   ├── scout.md planner.md reviewer.md checker.md worker.md
├── skills/                   # 随包加载(resources_discover 自动发现)
├── themes/                   # ugk-geek(默认)+ 16 个社区主题(atom/catppuccin/dracula/gruvbox/nord/solarized),见 NOTICE.md
├── prompts/                  # /implement /scout-and-plan 等(随包加载)
└── tests/                    # Node test runner 逻辑覆盖
```

---

## ❓ 常见问题

**Q: `ugk` 命令找不到?**
A: 重开一个 cmd/PowerShell 窗口(让 PATH 刷新)。还不行就检查 `npm ls -g ugk-agent` 是否装成功。

**Q: bash 工具报 `WSL ERROR: execvpe /bin/bash failed`?**
A: 见上面「Windows 用户:修复 bash 工具」,配 `shellPath`。

**Q: `@scout` 没反应 / 报 "Unknown agent"?**
A: 预设 agent 随包自动加载,正常不应出现。若出现,确认 ugk 是最新版(老版本需手动复制);或检查 `~/.pi/agent/agents/` 是否放了空的/损坏的 `.md` 占用了 `scout` 这个名字。


**Q: cron 工具报"服务未启动"?**
A: cron 是独立常驻服务,在本仓库目录跑 `npm install && npm run cron:start`(需要先 clone 本仓库)。

**Q: `npm i -g` 报 `EACCES`(权限错误)?**
A: 这是 npm 全局安装最常见的坑。推荐配一个用户级的 npm 全局目录,免 sudo/免管理员:
- **Windows(PowerShell)**:`npm config set prefix "$env:APPDATA\npm"`,然后重开终端重跑安装。
- **macOS/Linux**:`mkdir -p ~/.npm-global && npm config set prefix '~/.npm-global'`,把 `~/.npm-global/bin` 加进 PATH,重开终端重跑。
- 详见 [npm 官方文档](https://docs.npmjs.com/resolving-eacces-permissions-errors-when-installing-packages-globally)。
- 或者直接用一键安装器 `npx ugk-install`,它检测到权限错误会给出同样的修复指引。

**Q: 怎么换模型(不用 DeepSeek)?**
A: 设对应的环境变量(如 `OPENAI_API_KEY`),启动时加 `--provider openai --model gpt-4o`。详见 pi 官方文档。

**Q: `/ugk` 显示 DeepSeek 未配置,但我已经 `/login` 了?**
A: `/ugk` 会同时检查 `DEEPSEEK_API_KEY` 和 `~/.pi/agent/auth.json` 里的 deepseek 登录记录。若刚 login 后仍显示未配置,先重启 ugk;若手动编辑过 `settings.json`,注意不要用带 BOM 的 UTF-8 写入,否则 pi 可能解析失败。

**Q: `/skill` 里有很多不是 ugk 自带的 skill?**
A: `ugk` 首次启动会默认在 `~/.pi/agent/settings.json` 写入:

```json
{
  "clearStartupScreen": true,
  "skills": ["!skills/**"]
}
```

`clearStartupScreen` 会让新会话启动页清理当前终端视口并占满终端高度。`skills` 会隐藏 `~/.agents/skills` 下的用户全局 skills,避免系统里装过的个人 skill 干扰 ugk。ugk 通过扩展注入的 `subagent-guide` / `cron-guide` / `chrome-cdp-guide` / `ugk-guide` / `skill-creator` 仍会加载。

已有用户如果之前手动配置过 `clearStartupScreen` 或 `skills`,ugk 不会覆盖;需要启用默认行为时可手动补上对应字段。

**Q: `.mcp.json` 配了 server,为什么非交互模式不连接?**
A: project/local scope 会执行项目内命令,非交互模式没有 UI 可确认,所以 UGK fail-closed。把可信 server 放到 install scope(UGK 安装目录 `mcp.json`)或 user scope(`~/.config/ugk/mcp.json` / `%APPDATA%\ugk\mcp.json`),或在交互 TUI 中确认后使用。

**Q: `/mcp reload` 后旧工具还在模型上下文里怎么办?**
A: UGK 会把消失 server 的工具从 active tools 下线,但 pi 目前没有真正的 unregisterTool API。若 stale 工具被调用,它会返回 server disconnected,不会自动重连。重新出现的 server 可通过 `/mcp reload` 和 `/mcp enable <server>` 恢复 active。

**Q: 我之前用 pi install 装过老版本,要怎么升级?**
A: 直接 `npm i -g ugk-agent`,然后用 `ugk` 代替 `pi` 即可。老的 ~/.pi/agent/ 配置和 auth 仍然有效(ugk 复用同一目录)。

**Q: 启动时看到 pi 更新提示怎么办?**
A: 正常使用 `ugk` 不应该看到 pi 更新提示。UGK 会在启动入口禁用 pi 自身的版本检查和安装遥测,并固定内部 pi runtime 版本。以后底层 runtime 是否升级,只由 UGK 新版本决定;用户只需要更新 UGK,不要单独执行 `pi update`。
