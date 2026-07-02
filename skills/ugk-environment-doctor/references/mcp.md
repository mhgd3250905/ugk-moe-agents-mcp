# MCP

MCP is optional. It expands tools, but core chat can work without it.

## Check

Use:

```text
/mcp status
```

Look for:

- configured servers
- connected servers
- failed servers
- stale tools
- missing environment variables

## Guided Fix

No config:

```text
MCP is not configured. This is OK unless you expected extra tools.
```

If the user pastes MCP JSON, the agent must write it with the bundled merge script instead of asking the user to paste JSON into a config file manually:

```text
python skills/mcp-guide/scripts/configure_mcp.py --scope install --cwd . --input <temp-json-file>
/mcp reload
/mcp status
```

Use `install` by default for UGK-wide MCP, `local` for current-workspace private paths/tokens, `user` only when the user asks for a personal override, and `project` only when the user wants committed/shared config.

Command not found:

```text
Install the command used by that server or fix the server command path.
```

Environment variable missing:

```text
Define the named variable. Do not paste secret values back into chat.
```

If the user gives the missing variable name and says it is already set in their terminal, verify from the same UGK process when tools allow. If the actual secret value is needed, ask them to set it locally; never ask them to paste secrets into chat.

Project/local server blocked:

```text
Use interactive UGK and approve it, or move trusted config to user/install scope.
```

After changing config:

```text
/mcp reload
/mcp status
```

## Safety

Do not automatically move untrusted project MCP servers into user scope just to bypass prompts.
