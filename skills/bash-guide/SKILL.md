---
name: bash-guide
description: Use when an agent needs bash on Windows in UGK, sees bash/PATH failures, works with Driver/subagent sessions, or is tempted to probe many Git Bash paths manually.
---

# Bash Guide

UGK treats bash as a shared runtime setting, not a per-task guessing game.

## Source of truth

- Primary setting: `<agentDir>/settings.json` field `shellPath`.
- Default `agentDir`: `PI_CODING_AGENT_DIR`, otherwise `~/.pi/agent`.
- On Windows, use the `ugk-environment-doctor` skill to guide bash repair and write a verified absolute Git Bash path back to `settings.json.shellPath`.
- Main agent, Judge Driver sessions, and subagent child processes use the same `agentDir`, so a persisted `shellPath` is shared after restart or delegation.

## What to do

1. If bash fails on Windows, ask for environment help or load `ugk-environment-doctor` first.
2. If `settings.json.shellPath` points to a bash that prints `ok` for `-lc "echo ok"`, trust that path.
3. If a common Git Bash location works, persist that path for future Driver/subagent sessions.
4. Use normal bash commands only after the shared shell has been established.

## What not to do

- 不要在任务里反复 `which bash`, `where bash`, `ls /d/Git`, or probe many hard-coded Git install paths.
- Do not make every Driver or subagent rediscover bash independently.
- Do not ask the user to manually run commands when UGK tools can check or persist the shell path.

## Manual repair

If automatic detection cannot find Git Bash, set `shellPath` in `<agentDir>/settings.json`:

```json
{
  "shellPath": "D:\\Git\\bin\\bash.exe"
}
```

Keep the rest of the existing settings file unchanged.
