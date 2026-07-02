---
name: mcp-guide
description: Use when the user wants to configure or manage MCP servers in UGK, pastes mcpServers JSON, asks to add/remove/verify an MCP server, troubleshoot /mcp status, or understand MCP tool permissions and naming.
---

# MCP Guide

Use this skill when the user asks about UGK MCP configuration, pastes an MCP config JSON block, `/mcp` commands, MCP tool names, MCP permissions, or stale MCP tools after reload.

## Scope

UGK is an MCP client for stdio tools. It does not expose an MCP server. It does not enable MCP resources, prompts, sampling, or HTTP transport in this release.

## Config Files

UGK loads four config scopes and merges them in this order:

1. install: `<ugk package root>/mcp.json`
   - Global npm installs usually place this under the package directory, such as `~/.npm-global/lib/node_modules/ugk-agent/mcp.json`; `npm link` uses the linked repo root.
   - Intended for UGK-shipped or project-maintainer-backed default MCP servers.
2. user: `~/.config/ugk/mcp.json`
   - Windows: `%APPDATA%\ugk\mcp.json`
3. project: `<workspace>/.mcp.json`
4. local: `<workspace>/.mcp.local.json`

Higher scope fully replaces a same-name server from a lower scope. `.mcp.local.json` is ignored by git and should hold local-only tokens or paths.

Config shape:

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "."]
    }
  }
}
```

Environment variables can be interpolated with `${VAR}`. Missing variables fail that server clearly; UGK does not replace them with empty strings.

## Configure From Pasted JSON

When the user provides a JSON block such as `{ "mcpServers": { ... } }`, configure it for them instead of only explaining.

Default target scope:

- Use `install` (`<ugk package root>/mcp.json`) when the user wants a UGK/system-level MCP, runs UGK through `npm link`, or expects the server to be available from every working directory.
- Use `user` (`~/.config/ugk/mcp.json`, Windows `%APPDATA%\ugk\mcp.json`) only when the user explicitly wants a personal override outside the UGK installation directory.
- Use `local` (`<workspace>/.mcp.local.json`) for workspace-specific servers, project-local paths, private tokens tied to the current project, or when the user explicitly wants the config scoped to the current workspace.
- Use `project` (`<workspace>/.mcp.json`) only when the user explicitly wants the config committed/shared.

Workflow:

1. Save the pasted JSON to a temporary file.
2. Run the bundled merge script:

   ```bash
   python skills/mcp-guide/scripts/configure_mcp.py --scope install --cwd . --input /path/to/input.json
   ```

3. Report the written config path and server names.
4. Validate with `/mcp reload` or by running a non-interactive connection smoke if appropriate.
5. If validation spawns a project/local server, explain the command and get confirmation in interactive contexts.

The script accepts either full config shape:

```json
{ "mcpServers": { "server-name": { "command": "python", "args": ["server.py"] } } }
```

or a raw server map:

```json
{ "server-name": { "command": "python", "args": ["server.py"] } }
```

Do not print secret env values back to the user. Mention only variable names such as `${GITHUB_TOKEN}`.

## Permissions

There are two gates:

1. Spawn policy before starting a server:
   - install scope: allowed; trusted like user scope because it is controlled by the UGK install/package maintainer
   - user scope: allowed
   - project/local scope: ask in interactive UI
   - project/local without UI: blocked fail-closed
2. Per-tool policy inside each MCP tool:
   - `/mcp off`: block tool calls
   - `/mcp on`: allow tool calls
   - `/mcp ask`: ask before tool calls unless the server was allowed for this session

Never advise users to place untrusted project commands in user scope just to bypass confirmation.

## Commands

```text
/mcp status
/mcp ask
/mcp on
/mcp off
/mcp reload
/mcp enable <server>
/mcp disable <server>
```

`/mcp status` shows connected servers, tool counts, permission mode, failed servers, warnings, and stale servers.

`/mcp reload` disconnects all MCP servers, reloads config, reconnects allowed servers, and updates active tools.

## Tool Names

MCP tools are registered as:

```text
server__tool
```

Server and tool names are normalized to provider-safe lowercase names. Characters outside `[a-z0-9-]` become `-`. Server names are capped at 32 characters; tool names at 64 characters. Duplicate normalized server names get suffixes like `-2`.

## Stale Tools

pi currently has no `unregisterTool` API. When a server disappears after `/mcp reload`, UGK removes that server's tools from active tools. If a stale MCP tool is still called, it returns a disconnected error and does not reconnect automatically.

Use:

```text
/mcp reload
/mcp enable <server>
```

after restoring the server config.

## Doctor

`/doctor` now points users to guided environment troubleshooting. For MCP, use this skill plus `/mcp status`:

- validate config
- report configured servers by scope
- read the current registry status
- avoid spawning untrusted project/local servers without approval

## Troubleshooting

- Server not connected in `ugk --print`: project/local scope is blocked without UI. Move trusted config to user scope or use interactive TUI.
- Server missing entirely from `/mcp status`: project/local config is loaded from the current workspace cwd. Confirm the UGK session cwd is the directory containing `.mcp.json` or `.mcp.local.json`; use user scope for servers that should work across projects.
- Env error in `/mcp status`: define the missing environment variable or move local values into `.mcp.local.json`.
- Tool name is unexpected: check provider-safe normalization and duplicate suffix warnings.
- Tool call blocked: check `/mcp status`, then choose `/mcp ask`, `/mcp on`, or approve the session prompt.
