---
name: task-install-guide
description: Use when the user wants to install, update, or remove a UGK task from chat, pastes or mentions `ugk task install NAME`, `ugk task update NAME`, `ugk task remove NAME`, or asks in Chinese to install/update/delete a task.
---

# Task Install / Update / Remove Guide

When the user asks to install, update, or remove a UGK task, use the existing CLI commands. Do not manually download manifests, unzip files, rm directories, or recreate install validation.

## Install

1. Extract the task name from the user request, for example `video-downloader` from `ugk task install video-downloader`.
2. Run `ugk task install <name>` with the shell tool.
3. If `ugk` is not available and you are inside the UGK repo, run `node bin/ugk.js task install <name>`.
4. Report the installer result in the user's language.

## Update (已装的 task 升级到 marketplace 最新版)

When the user says "更新/升级 task" or the installed version is stale, **do NOT** tell them to manually remove-then-reinstall — use the update command:

```
ugk task update <name>
```

`update` is non-interactive and overwrites the installed copy atomically. It also works when the task is not yet installed (acts as install).

## Remove

```
ugk task remove <name>          # 交互确认 [y/N]
ugk task remove <name> -y       # 跳过确认直接删(--yes 同义)
```

Removes the taskbook from the user tasks directory. Deleting a task only removes the task package — it is always reinstallable. Default asks for confirmation; add `-y`/`--yes` to skip (e.g. in automation).

## Common rules

- If no task name is present, ask for the task name.
- If a command fails, report the exact failure and do not retry by hand-editing task files.
- If `ugk` is not available and you are inside the UGK repo, prefix with `node bin/ugk.js` (e.g. `node bin/ugk.js task update <name>`).
