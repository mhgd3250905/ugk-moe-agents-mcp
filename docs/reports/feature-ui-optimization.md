# feature/ui-optimization 分支修改报告

日期：2026-06-16

## 结论

`feature/ui-optimization` 分支完成了 UGK 启动页和交互界面的品牌化 UI 优化。改动集中在扩展层、主题资源、CLI 启动默认配置和测试覆盖，不改动 pi 的底层 agent loop、消息存储、模型调用或工具执行流程。

## 分支目标

- 让 `ugk` 启动后不再像普通终端续接会话，而是有更明确的产品启动页。
- 建立 UGK 自己的极客、像素风视觉识别。
- 保持已有消息显示、会话恢复、工具调用和底层运行逻辑不变。
- 默认折叠启动资源清单，减少 `[Context] / [Skills] / [Prompts] / [Extensions] / [Themes]` 对首屏的干扰。

## 核心改动

### 1. UGK 品牌 header/footer

- 新增 `extensions/ui-brand.ts`。
- 新增 `extensions/ui-brand-utils.ts`。
- 通过 extension UI hook 设置自定义 header、footer 和 terminal title。
- header 展示方块字符 `UGK` LOGO 和字符面板：

```text
██  ██  █████  ██  ██
██  ██ ██      ██ ██
██  ██ ██  ███ ████
██  ██ ██   ██ ██ ██
 ████   █████  ██  ██

┌─ ugk v1.0.0 ─────────────────────────────────────────────────┐
│ workspace   feature-ui-optimization                          │
│ agent       terminal coding agent                            │
│ stack       plan · subagents · cron · adb                    │
├─ quick actions ──────────────────────────────────────────────┤
│ /plan  /implement  /check-env  @agent                        │
│ model       deepseek-v4-pro                                  │
└──────────────────────────────────────────────────────────────┘
```

- footer 展示当前 cwd、git branch、token 用量、模型和状态。
- 新增 `/ugk-ui on|off|status` 命令。
- 新增 `--ugk-ui-off` 启动参数。

### 2. UGK 极客像素风主题

- 新增 `themes/ugk-geek.json`。
- 主色从蓝紫调整为不刺眼的荧光绿。
- 主题资源通过 `resources_discover` 自动注册。

### 3. 默认折叠启动资源清单

- 新增 `bin/ugk-startup-settings.js`。
- `bin/ugk.js` 启动前会确保默认写入 `quietStartup: true`。
- 如果用户已经显式设置过 `quietStartup`，不会覆盖用户选择。
- 需要查看完整启动资源时，可以运行：

```bash
ugk --verbose
```

### 4. npm CLI 入口权限保存

- `bin/ugk.js` 保存为可执行文件，便于作为 npm `bin` 入口直接运行。

## 测试覆盖

新增和更新的测试：

- `tests/ui-brand-utils.test.ts`
- `tests/ui-brand-extension.test.ts`
- `tests/ugk-theme.test.ts`
- `tests/ugk-startup-settings.test.ts`

覆盖内容：

- UGK header 不再展示 `pi v...`。
- 方块字符 LOGO 正常生成。
- header 信息面板闭合、等宽，`model` 不掉出边框。
- footer 保留工作目录、branch、usage 和模型状态。
- `ugk-geek` 主题结构完整。
- `quietStartup` 默认写入、显式配置保留、已有 settings 不丢失。

## 验证命令

```bash
npm test
```

最近一次验证结果：

```text
29 pass
0 fail
```

CLI 入口冒烟验证：

```bash
PI_CODING_AGENT_DIR="$(mktemp -d)" node bin/ugk.js --version
```

验证结果：

- 输出版本：`0.79.4`
- 临时 `settings.json` 写入 `"quietStartup": true`

## 影响范围

主要影响：

- `ugk` 交互启动页视觉。
- `ugk` footer/status 信息展示。
- 启动资源清单默认显示策略。
- UGK 自定义主题资源发现。

不影响：

- pi 底层模型请求。
- 会话保存和恢复。
- 消息渲染主体。
- 工具调用执行链路。
- skills/prompts/extensions/themes 的实际加载。

## 使用方式

启动 UGK：

```bash
ugk
```

临时查看完整启动资源：

```bash
ugk --verbose
```

关闭 UGK 品牌 UI：

```bash
ugk --ugk-ui-off
```

运行中切换：

```text
/ugk-ui on
/ugk-ui off
/ugk-ui status
```

## 注意事项

- `quietStartup` 只影响新启动的 `ugk` 进程，不会把当前已经渲染出来的资源清单折叠回去。
- 如果用户手动设置 `"quietStartup": false`，UGK 不会覆盖该显式选择。
- 当前分支只做 UI/启动体验优化，没有引入底层行为变更。
