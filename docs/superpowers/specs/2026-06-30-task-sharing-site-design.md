# Task 分享网站第一阶段设计

日期: 2026-06-30

## 目标

做一个官方精选 taskbook 下载页。用户打开网页后能用两种最短路径拿到 task:

1. 点击下载 `.zip`。
2. 复制 `ugk task install <name>` 一键安装。

第一阶段只服务官方精选 taskbook,不做社区市场。

## 推荐方案

采用静态网站 + 官方 manifest + 原始文件安装。

- 网站是静态页,展示官方精选 taskbook 的名称、说明、适用场景、下载按钮和安装命令。
- 每个 taskbook 在仓库中保留一份原始五件套:
  - `taskbook.json`
  - `spec.json`
  - `skill.md`
  - `verify.mjs`
  - `contract.json`
- 网站下载按钮指向同名 `.zip`,给用户手动下载和备份。
- `ugk task install <name>` 不解压 zip,而是读取官方 manifest 后下载五件套,校验后写入 `~/.pi/agent/tasks/<name>/`。

这样用户用起来像市场,实现上仍是文件分发。

## 为什么不让 CLI 解 zip

Node 18 标准库不能解 zip。让 CLI 解 zip 要么新增依赖,要么调用系统 `unzip` / PowerShell `Expand-Archive`,都会增加平台差异。

第一阶段保留 zip 作为用户下载物,CLI 安装直接拉原始文件。这样最短、最稳,也复用现有 taskbook 读取校验逻辑。

## 用户体验

网站卡片展示:

- task 名称
- 一句话说明
- 输入示例
- 所需工具或环境,例如 Chrome CDP、MCP、外部命令
- `Download zip`
- `ugk task install <name>` 复制按钮

CLI 安装:

```bash
ugk task install bilibili-download
```

成功后提示:

```text
已安装 taskbook "bilibili-download"
下一步: /task run bilibili-download <你的输入>
```

同名 taskbook 已存在时默认拒绝覆盖,避免覆盖用户本地修改。

## 官方来源限制

`verify.mjs` 是可执行脚本,所以第一阶段只允许安装官方 manifest 中列出的 taskbook。

不支持:

- 任意 URL 安装
- 用户上传
- 自动审核
- 评分、评论、收藏
- 版本历史
- zip 解包安装

## 仓库结构

建议新增:

```text
docs/task-share/
  index.html
  manifest.json
  taskbooks/
    bilibili-download/
      taskbook.json
      spec.json
      skill.md
      verify.mjs
      contract.json
  downloads/
    bilibili-download.zip
```

`website/` 当前在 `.gitignore` 中,不适合放正式网站代码。用 `docs/task-share/` 更直接,也方便 GitHub Pages 或普通静态托管。

## CLI 改动

新增 shell 命令入口:

```bash
ugk task install <name>
```

`bin/ugk.js` 在启动 TUI 前识别 `task install` 子命令并直接执行安装。这样用户从网站复制命令后不需要先进入 ugk 对话。

第一阶段只做最小闭环:

1. 读取官方 `manifest.json`。
2. 找到 `<name>` 对应的五件套 URL。
3. 下载五件套到临时目录。
4. 校验文件集合、JSON 可解析、taskbook 名称合法、manifest 名称与 `taskbook.json` 一致。
5. 写入 user scope: `~/.pi/agent/tasks/<name>/`。
6. 如果本地已存在同名 taskbook,拒绝覆盖。

不新增数据库、不新增服务端、不新增 npm 依赖。

`/task install <name>` 先不做。用户如果已经在 TUI 里,可以退出后复制同一条 shell 命令安装;后续真有需要再把同一个安装函数接到 slash 命令。

## 验证

- 网站静态文件能本地打开。
- 每个卡片的 zip 链接存在。
- 每个安装命令中的 task 名在 manifest 中存在。
- `ugk task install <name>` 能在不进入 TUI 的情况下安装官方 taskbook。
- 已存在同名 taskbook 时安装失败且不覆盖。
- 安装后的 taskbook 能被 `/task list` 看见。
- `npm test` 通过。

## 剩余风险

- 官方 taskbook 的 `verify.mjs` 仍会在用户机器执行。第一阶段通过"只装官方 manifest"控制来源。
- zip 和原始五件套可能不同步。最短做法是在验证脚本里检查 zip 内文件名集合和 manifest 对应 task 一致。
- 没有版本系统。官方 task 更新时,第一阶段让用户重新下载安装;覆盖能力后续再加。
