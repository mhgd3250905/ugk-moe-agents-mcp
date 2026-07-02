# ugk-install — ugk 一键交互式安装器

> 独立 npm 包。用户跑 `npx ugk-install` 即可完成 ugk 的安装 + DeepSeek API key 配置。

## 用户命令

```bash
npx ugk-install
```

安装器会交互式引导:检测 Node/npm → 安装 ugk → 询问并验证 DeepSeek API key → 写入配置。

## 它做了什么

1. **检测环境**:Node ≥18、npm 是否就绪。缺失会给出清晰的安装指引(nodejs.org)。
2. **安装 ugk**:`npm install -g ugk-agent`。权限错误(EACCES)会给出修复方案(npm prefix),不强制 sudo。
3. **配置 key**:交互式询问 DeepSeek API key,用 `/models` 接口验证有效性。
4. **写入 auth.json**:key 写到 `~/.pi/agent/auth.json`(标准 pi 凭据结构 `{type:"api_key",key}`),BOM-safe、权限 0600、保留已有 provider。

## 为什么 key 写 auth.json 而不是环境变量

- **调用优先级最高**:pi 的 `AuthStorage.getApiKey` 先读 auth.json 再读 `DEEPSEEK_API_KEY` env(见 pi auth-storage.js)。
- **跨进程即时生效**:不用重开终端、不依赖 `setx` 的新进程语义、不污染 `.bashrc`/`.zshrc`/注册表。
- **是 pi `/login` 同款**:结构和路径完全一致,后续 `/login` 覆盖也兼容。

## 前置要求

- Node.js 18+(安装器会检测,缺失会引导安装)

## 维护者:发布

这是一个独立 npm 包(与 ugk-agent 分开):

```bash
cd install
npm publish
```

发布后用户即可用 `npx ugk-install`。
