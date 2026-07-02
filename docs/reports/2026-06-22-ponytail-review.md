# Ponytail Review 记录

日期: 2026-06-22

范围: 已跟踪代码、README、包清单、测试命名。未跟踪个人素材只做状态噪声处理,不删除内容。

## 已直接修改

- `README.md`: 删除不存在的 `greet` 工具示例,去掉过期的 `v1.1.0` 能力标题。
- `README.md`: 把 npm 包内不存在的本地 `docs/judge.md` 引用改成仓库链接。
- `tests/mcp-*.test.ts`: 假本地工具名 `greet` 改为 `local_tool`,避免继续暗示存在 greet 工具。
- `tests/shared-driver-session.test.ts`: `.flow` fixture 路径改为 `.judge`,避免已删除模块继续污染当前语义。
- `tests/ugk-session-view-patch.test.ts`: `flow-driver` / `/flow detach` / `Flow sessions` 改为通用 driver 命名。
- `package.json`: 超长 `npm test` 文件清单改为 Node test runner glob。
- `.npmignore`: npm 包不再包含 `tests/`,并删除被 `docs/` 覆盖的重复规则。
- `.gitignore`: 忽略本地私人物料和生成物: `nul`, `website/`, `wangnuanwei-*.md`,本地实验 skills。

## 发现但未改

- `bin/flow-cleanup.js` 仍保留。它是一次性迁移清理逻辑,不是当前运行时 Flow 依赖;等确认老用户都已迁移后再删。
- `docs/design/`、`docs/handoff/`、`docs/reports/` 中大量 Flow 历史文档保留。`docs/judge.md` 已声明历史文档不作当前事实,直接删除会丢设计背景。
- `skills/docx/` 带大量 Office schema。体积大但属于 `docx` skill 的离线校验资产,不是无用代码。

## Ponytail findings

`README.md:L89`: delete: nonexistent `greet` verification. Replace with a plain directory-summary prompt.

`README.md:L149`: delete: stale `v1.1.0` capability label. Unversioned heading.

`README.md:L283`: shrink: package README links to excluded local docs. Repository URL.

`tests/mcp-commands.test.ts:L203`: delete: fake `greet` tool name after greet removal. `local_tool`.

`tests/shared-driver-session.test.ts:L17`: delete: `.flow` fixture path after Flow removal. `.judge` path.

`tests/ugk-session-view-patch.test.ts:L84`: delete: Flow-specific names in generic session-view tests. Generic driver names.

`.npmignore:L4`: shrink: tests shipped in npm tarball. `tests/`, 1 line.

`package.json:L17`: stdlib: 49-file explicit test list. Node test glob, 1 line.

`.gitignore:L15`: shrink: noisy local artifacts already known private. Ignore them instead of reporting every status.

net: -48 config lines possible; package/docs/test noise reduced.
