# 自研 Skill 触发边界调查报告

> 日期：2026-06-24  
> 范围：`skills/` 下 UGK 自研或项目内维护的 skill。`docx`、`skill-creator` 属于外部引入能力，仅作为格式/规范参照，不纳入本轮整改对象。  
> 目的：排查 skill 触发边界不清、工具优先级不明确、危险副作用未约束等问题，给同事审核后执行整改。

## 结论摘要

本轮发现 10 个需要整改的边界问题，其中 2 个是高优先级：

- `xiaoyuzhou-dl` 当前会覆盖同名下载文件，属于数据丢失风险。
- `wang-nuanwei-style` 触发描述过宽，并强制通读 15 篇原文，容易误触发且浪费上下文。

另有 8 个中低优先级问题，主要是 description 泛化、工具优先级没有写入触发层、外部服务/API/计费边界不够明确，或排障文档缺少已踩坑的 cwd/scope 说明。

`chrome-cdp-guide` 已在当前 HEAD 中完成关键整改：description 已明确 “MUST use for almost every CDP-related request”，并要求优先 `chrome_cdp` 工具、禁止在工具可用时用 `bash/curl/node` 手写 CDP。它可作为本轮整改的样板，不需要再次改。

## 调查依据

按 `skill-creator` 规范，skill 的 `description` 是主要触发机制，必须把“什么时候使用”和“什么时候不使用”的边界写清楚；正文只有 skill 已触发后才会加载，不能依赖正文来修正误触发。脚本类 skill 还必须约束副作用，尤其是覆盖文件、外部 API 调用、长期服务启动等行为。

本次读取了以下材料：

- `C:\Users\29485\AppData\Local\Temp\ugk-handoff-2026-06-24-v2.md`
- `C:\Users\29485\.codex\skills\.system\skill-creator\SKILL.md`
- `skills/*/SKILL.md`
- `skills/xiaoyuzhou-dl/scripts/xiaoyuzhou_dl.py`

## 详细发现

### P0：`xiaoyuzhou-dl` 会静默覆盖文件

证据：

- `skills/xiaoyuzhou-dl/SKILL.md:3`：description 明确写“覆盖同名文件”。
- `skills/xiaoyuzhou-dl/SKILL.md:39`：工作原理写“如文件已存在直接覆盖，不询问”。
- `skills/xiaoyuzhou-dl/scripts/xiaoyuzhou_dl.py:184`：脚本仅打印“文件已存在，将覆盖”，后续直接写入同一路径。

风险：

- 用户重复下载同一期或标题相同的节目时会覆盖已有音频。
- agent 默认执行脚本时，用户不一定有机会在覆盖前阻止。

建议整改：

- 脚本新增 `unique_output_path(path)`：若目标存在，自动生成 `name_1.ext`、`name_2.ext`。
- SKILL.md 改为“默认不覆盖已有文件；同名自动加后缀”。
- 手测一个临时目录中已存在 `episode.m4a` 的情况，断言输出为 `episode_1.m4a`。

### P0：`wang-nuanwei-style` 触发范围过宽且上下文成本过高

证据：

- `skills/wang-nuanwei-style/SKILL.md:3`：触发词包含“写篇文章”“写点东西”“公众号文章”“写个故事”“帮我改文章”“加点画面感”等泛写作请求。
- `skills/wang-nuanwei-style/SKILL.md:10`：要求每次“通读全部原文”15 篇。
- `skills/wang-nuanwei-style/15_00到16_00.txt` 位于 skill 根目录，疑似散落草稿，不符合资源分层。

风险：

- 普通写作、编辑、公众号文案都可能误触发该风格 skill。
- 每次加载 15 篇原文不符合 progressive disclosure，污染上下文。
- 原文直接作为常规上下文材料，容易诱导过度模仿。

建议整改：

- description 收窄到用户明确要求“王暖胃/暖胃风格/白描留白/反高潮/淡淡但有后劲”时触发。
- 新增 `skills/wang-nuanwei-style/references/style-summary.md`，通读 15 篇后提炼风格要点和 3-5 个自造短例句。
- SKILL.md 改为先读 `references/style-summary.md`；只有用户要求高度校准时，再按需读取少量代表原文。
- 根目录 `15_00到16_00.txt` 本轮先不删除，但报告为“非 canonical source”，后续可单独清理。

### P1：`ugk-guide` 仍像占位示例

证据：

- `skills/ugk-guide/SKILL.md:3`：description 写“need project conventions, how-to, or context”，触发边界较泛。
- 正文写“这是 ugk-pi-agent 包内置的示例 skill”，与当前项目已经进入 v2.0.0 的事实不匹配。

风险：

- agent 需要项目事实时可能读到过时或过浅的指南。
- 和 `AGENTS.md`、`docs/judge.md`、`docs/design/*` 的权威层级不清。

建议整改：

- 保留该 skill，但改为“UGK 项目上下文入口”。
- 明确 `AGENTS.md` 是最高优先级事实源；按任务导向导航到 `docs/judge.md`、`docs/design/task-extension-spec.md`、`docs/design/subtask-extension-spec.md` 等。
- 删除“示例 skill”表述。

### P1：`jianying-tts-concat` 对可选 FunASR 的降级边界不清

证据：

- `skills/jianying-tts-concat/SKILL.md:24` 写 FunASR 为可选。
- `skills/jianying-tts-concat/SKILL.md:76` 又直接指定 `funasr-transcriber__start-transcription` 和 `funasr-transcriber__get-job-result`。

风险：

- 工具未安装时，agent 可能停在缺工具状态，或尝试自行安装/替代。
- “可选校验”和“必须转写”在执行流程中冲突。

建议整改：

- 步骤 2 改为“仅当 FunASR MCP 工具可用时执行”。
- 工具不可用时跳过转写校验，并在交付中说明“已按文件时间排序，未做转写校验”。
- 不要求 agent 安装 FunASR，也不把转写失败视为拼接失败。

### P1：`mimo-tts` 外部 API、密钥和计费边界不足

证据：

- `skills/mimo-tts/SKILL.md:3`：泛触发“文本转语音”等关键词。
- `skills/mimo-tts/SKILL.md:22-33`：说明从 `MIMO_API_KEY` 读取，但没有明确缺失时的处理。
- `skills/mimo-tts/SKILL.md:59`：计费只写“限时免费”，缺少调用前提示。

风险：

- 用户只是泛泛说“文本转语音”时可能触发 MiMo，而不是本地/其他 TTS。
- 外部 API 调用可能消耗额度；缺 key 时 agent 可能让用户直接粘贴密钥。

建议整改：

- description 加上“需要用户明确指定 MiMo/小米 TTS 或使用 MiMo 平台能力”。
- 正文增加调用前边界：检查 `MIMO_API_KEY` 环境变量；缺失时让用户在环境变量中设置，不要求用户在对话里粘贴 key。
- 明确调用外部 Xiaomi MiMo API，可能产生费用或消耗配额；不得回显完整 key。

### P1：`adb-guide` 与 `scrcpy-guide` 在投屏场景抢触发

证据：

- `skills/adb-guide/SKILL.md:3`：description 包含“投屏调试”和“任何 Android 设备操作”。
- `skills/scrcpy-guide/SKILL.md:3`：description 也覆盖投屏、手机画面、镜像屏幕、录屏手机等场景。

风险：

- 用户说“投屏/手机画面”时可能触发 adb，而不是专门的 scrcpy 工具链。
- adb 截屏、录屏、输入控制和实时投屏的目标不同，混在一起会让 agent 走错工具。

建议整改：

- `adb-guide` description 去掉“投屏调试”和“任何 Android 设备操作”这种兜底词。
- `adb-guide` 正文加边界：实时投屏、手机画面镜像、scrcpy 录屏优先 `scrcpy-guide` / `scrcpy` 工具；adb 只处理连接、安装、日志、文件、命令、诊断等。

### P1：`scrcpy-guide` 的工具优先级没有写进 description

证据：

- `skills/scrcpy-guide/SKILL.md:13` 正文要求优先用 `scrcpy` 工具。
- `skills/scrcpy-guide/SKILL.md:3` description 没写“工具优先”，只写投屏指南。

风险：

- description 触发后，agent 仍可能先用 bash 手敲 scrcpy，而不是使用已封装的 `scrcpy` extension tool。
- 这与 CDP 已修复问题同类：工具优先级只写在正文里不够硬。

建议整改：

- description 补充：优先使用 `scrcpy` 工具的 `start/stop/status/version`，bash 仅作 fallback。
- 保持正文现有 ADB 复用说明。

### P2：`subagent-guide` “代码审查”触发过宽

证据：

- `skills/subagent-guide/SKILL.md:3`：description 把“代码审查”列为触发条件。

风险：

- 用户普通说“帮我 review 一下”时，可能误触发 subagent 委派指南；但普通 code review 不一定需要隔离 context 或 reviewer agent。

建议整改：

- description 改为“需要委派/隔离上下文/并行调查/指定 @reviewer 的代码审查”才触发。
- 正文加一句：普通 review 不必触发本 skill，除非用户明确要求委派、并行、隔离或 @mention。

### P2：`cron-guide` 泛词“自动化/后台执行”容易误触发

证据：

- `skills/cron-guide/SKILL.md:3`：description 包含“自动化”“后台执行”。

风险：

- 用户说“自动化处理这个任务”或“后台跑一下构建”时，可能误触发 cron；但这类场景不一定是周期任务。

建议整改：

- description 收窄到“定时、cron、周期、每天/每小时、计划任务、到点自动运行、cron 服务”。
- 去掉泛词“自动化/后台执行”，或限定为“周期性/到点后台执行”。

### P2：`mcp-guide` 缺少 cwd/scope 排障点

证据：

- `skills/mcp-guide/SKILL.md:145` Troubleshooting 中已有 headless、env、tool name、blocked 说明。
- 交接材料记录了实际踩坑：project/local scope 绑定当前 workspace cwd；cwd 不一致时 server 会消失。

风险：

- 用户把 `.mcp.json` 或 `.mcp.local.json` 放在一个目录，却从另一个 cwd 启动 UGK 时，`/mcp status` 里看不到 server，容易误判为 reload 或 server bug。

建议整改：

- Troubleshooting 增加：
  - project/local 配置只对当前 workspace cwd 生效。
  - 跨项目常用 server 应放 user scope。
  - 看不到 server 时先确认 UGK 会话 cwd 与 `.mcp.json` / `.mcp.local.json` 所在目录一致。

## 已整改样板：`chrome-cdp-guide`

证据：

- `skills/chrome-cdp-guide/SKILL.md:3`：description 已写 “MUST use for almost every CDP-related request”。
- 同一行明确 “Prefer the chrome_cdp tool; do not control CDP through bash/curl/node scripts when chrome_cdp is available.”

评价：

- 这是正确方向：把触发边界和工具优先级写在 description，而不是只写在正文。
- 后续 `scrcpy-guide`、`mimo-tts` 等也应照这个标准，把关键工具/外部调用边界前置到 description。

## 建议执行顺序

第一批，先处理数据安全和上下文污染：

1. `xiaoyuzhou-dl`：不覆盖同名文件，自动后缀。
2. `wang-nuanwei-style`：收窄触发 + 新增 `references/style-summary.md` + 取消强制通读全部原文。
3. `ugk-guide`：从示例改为项目上下文入口。

第二批，处理工具/外部服务边界：

4. `jianying-tts-concat`：FunASR 不可用时降级。
5. `mimo-tts`：API key、外部调用、计费边界。
6. `adb-guide`：让出投屏场景。
7. `scrcpy-guide`：description 写清 tool-first。

第三批，处理误触发和排障补充：

8. `subagent-guide`：收窄“代码审查”。
9. `cron-guide`：去掉泛“自动化/后台执行”。
10. `mcp-guide`：补 cwd/scope 排障。

## 验证计划

每改一个 skill 后执行：

```powershell
$env:PYTHONUTF8='1'
python skills\skill-creator\scripts\quick_validate.py skills\<skill-name>
```

脚本改动额外验证：

- `xiaoyuzhou-dl`：用临时目录构造同名文件，断言新路径为 `_1` 后缀且不覆盖原文件。

全量收尾：

```powershell
git diff --check
```

本轮这些目标 skill 当前不属于 `tests/bundled-skills.test.ts` 的覆盖对象；除非后续把它们加入打包测试，否则不需要因为本轮文档调整强行跑该测试。真实触发准确度仍需 TUI dogfood 验证，单元测试只能覆盖 YAML/frontmatter 基础格式。
