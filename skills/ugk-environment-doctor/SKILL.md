---
name: ugk-environment-doctor
description: Guides UGK environment setup and troubleshooting for Shell/Git Bash, Chrome CDP, MCP, Node/npm/npx, Windows PATH, permissions, and API/model usage explanations. Use when users mention doctor, environment setup and troubleshooting, setup failure, bash unavailable, Git Bash, Chrome CDP, MCP connection issues, Node/npm problems, PATH, permissions, settings.json, or API/model switching guidance.
---

# UGK Environment Doctor

Use this skill instead of a one-shot `/doctor` health table.

## Principle

Help beginners solve one failing area at a time. Do not dump a full diagnostic table unless the user explicitly asks for a checklist.

Explain:

1. What is failing.
2. Why UGK needs it.
3. The next concrete action.
4. How to verify after the action.

API and model switching are guidance, not required health checks. If the user cannot enter the agent at all, point them to install/login docs rather than pretending this skill can run.

Agent-owned fix rule:

- When the user provides a path, port, JSON config, environment variable name, or other concrete setting, verify it and apply the UGK-side config yourself.
- Do not ask beginners to manually edit JSON config files after they provided the needed value.
- Use bundled scripts and existing UGK commands first: `set_shell_path.mjs`, `/cdp port`, `/cdp launch`, `/cdp status`, `configure_mcp.py`, `/mcp reload`, `/mcp status`.
- Ask the user only for missing values, installation steps, secret values, admin/system PATH changes, or unsafe trust decisions.

## Triage

If the user says only `doctor` or `check environment`, start in this order:

1. Shell / Git Bash on Windows.
2. Chrome and Chrome CDP.
3. MCP configuration and connections.
4. Node / npm / npx.
5. API login and model switching explanation.

Stop at the first failing area and work it through before moving on.

If the user provides a `bash.exe` path, do not tell them to edit JSON. Run:

```text
node skills/ugk-environment-doctor/scripts/set_shell_path.mjs "<bash.exe>"
```

Then report the written settings path and verification result.

## References

- Windows Shell / Git Bash: [references/windows-shell.md](references/windows-shell.md)
- Chrome CDP: [references/chrome-cdp.md](references/chrome-cdp.md)
- MCP: [references/mcp.md](references/mcp.md)
- Node/npm/npx: [references/node-npm.md](references/node-npm.md)
- API and model switching: [references/api-models.md](references/api-models.md)

## Response Shape

Use short guided replies:

```text
Current issue: ...
Why it matters: ...
Do this next: ...
Then verify with: ...
```

Ask only one question when blocked. Prefer checking files/commands yourself when tools are available.
