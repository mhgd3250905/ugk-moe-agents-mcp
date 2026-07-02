# Chrome CDP Extension Design

## Goal

Build a UGK extension that lets the agent control a local, logged-in Chrome session through Chrome DevTools Protocol when ordinary network access cannot reach the target page because login state, cookies, SSO, CAPTCHA, or private workspace state is required.

The extension must not become the default path for ordinary public web access. It should be available to the agent, but guarded by explicit policy and user confirmation.

## Non-Goals

- Do not replace normal `bash`, HTTP, docs lookup, or public web access.
- Do not store, request, or autofill user passwords.
- Do not support remote CDP hosts in the first version.
- Do not automate login forms in the first version.
- Do not add broad click/type automation in the first version.

## Product Behavior

The default behavior is `ask`:

```text
/cdp off   # fully disable CDP tool execution
/cdp ask   # default: agent can request CDP, user must approve
/cdp on    # allow CDP for the current session without repeated approval
```

When the agent tries to use CDP in `ask` mode, the extension should ask for confirmation before executing the requested browser operation.

The confirmation should explain:

- which URL or browser target is involved
- why CDP is being requested
- that it controls the user's local logged-in Chrome session

The first implementation supports session-level approval only. Domain-level approval is outside the v1 scope.

## Use Cases

Use Chrome CDP when:

- the user explicitly asks to use local Chrome, CDP, DevTools Protocol, or an already logged-in browser
- a target page requires the user's existing browser login state
- normal network access fails due to SSO, private workspace state, cookies, CAPTCHA, or in-browser-only state
- the user wants the agent to inspect a local app through an actual Chrome session

Do not use Chrome CDP when:

- the page is public and accessible through normal HTTP or regular tools
- the task is a normal web search
- the task is documentation lookup
- the user only needs static source-code analysis
- the agent has not attempted or reasoned through a normal access path first

## Architecture

```text
extensions/chrome-cdp/
├── index.ts        # registers tool and /cdp command
├── config.ts       # mode, port, profile path, runtime state
├── client.ts       # CDP HTTP and WebSocket operations
├── formatter.ts    # human-readable output
└── README.md       # local usage notes

skills/chrome-cdp-guide/
└── SKILL.md        # tells the agent when and how to use chrome_cdp
```

The first version should be built into the UGK package, not published as a standalone pi package yet. Once stable, it can be extracted into an independent pi package with its own `package.json` and `pi.extensions` manifest.

## Tool Design

Register one tool:

```text
chrome_cdp
```

The tool description must be narrow:

```text
Use only when the user explicitly wants to control their local logged-in Chrome session,
or when normal network access cannot reach the target because it requires cookies, SSO,
CAPTCHA, private workspace state, or an existing browser login.

Do not use for public web search, ordinary documentation lookup, normal HTTP requests,
or pages accessible through bash/fetch/browser-free methods.
```

Parameters:

```text
action:
  - status
  - tabs
  - navigate
  - evaluate
  - screenshot

port?: number
target?: string
url?: string
expression?: string
path?: string
reason: string
normalAccessAttempted: boolean
```

`reason` is required so the user can see why CDP is being requested.

`normalAccessAttempted` is required to discourage direct CDP use for ordinary pages. If it is `false`, the tool should refuse unless the action is `status` or the user explicitly requested local Chrome/CDP.

## Command Design

Register one command:

```text
/cdp
```

Supported commands:

```text
/cdp status
/cdp ask
/cdp on
/cdp off
/cdp port 9222
/cdp launch
/cdp tabs
```

Behavior:

- `/cdp status` checks mode, port, and Chrome CDP reachability.
- `/cdp ask` sets guarded mode.
- `/cdp on` allows CDP in the current session.
- `/cdp off` blocks CDP execution.
- `/cdp port <number>` changes runtime port.
- `/cdp launch` starts Chrome with a dedicated UGK profile.
- `/cdp tabs` lists tabs using the configured port.

## Chrome Profile

The extension should prefer a dedicated Chrome profile:

```bash
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --remote-debugging-port=9222 \
  --user-data-dir="$HOME/.ugk/chrome-cdp-profile"
```

Login state is maintained by Chrome, not by UGK. UGK should not store cookies, passwords, or credentials.

## Port Configuration

Port priority:

1. explicit tool parameter `port`
2. runtime `/cdp port <number>`
3. environment variable `UGK_CDP_PORT`
4. default `9222`

The first version must connect only to `127.0.0.1`.

## Skill Design

Add `skills/chrome-cdp-guide/SKILL.md`.

The skill should instruct the agent:

1. Prefer ordinary access first.
2. Use CDP only for logged-in browser state, SSO, CAPTCHA, private pages, local Chrome inspection, or explicit user request.
3. Before calling `chrome_cdp`, state why ordinary access is insufficient.
4. Call `chrome_cdp` with `reason` and `normalAccessAttempted`.
5. In `ask` mode, wait for user approval.
6. Never ask the user to provide passwords to the agent.

## Security Boundaries

- CDP is local-only: `127.0.0.1`.
- No remote host parameter in v1.
- No credential storage.
- No automatic login form handling in v1.
- `evaluate` should run only for inspection/debugging tasks tied to the user's request.
- Tool should return concise outputs and avoid dumping secrets from page storage unless explicitly requested.

## Error Handling

If Chrome is not running with CDP:

```text
Chrome CDP is not reachable on 127.0.0.1:<port>.
Start Chrome with /cdp launch or:
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome --remote-debugging-port=9222 --user-data-dir="$HOME/.ugk/chrome-cdp-profile"
```

If mode is `off`:

```text
Chrome CDP is off. Ask the user to run /cdp ask or /cdp on.
```

If mode is `ask`:

Show a user confirmation dialog before execution.

If the target tab cannot be found:

Return the current tab list and ask the agent to pick a valid target or create/navigate one.

## Testing

Unit tests:

- config resolves port priority correctly
- mode defaults to `ask`
- `off` mode blocks tool execution
- `ask` mode requests confirmation before browser operations
- `normalAccessAttempted=false` blocks non-status actions unless explicit local Chrome use is provided
- formatter produces useful status and tabs output

Integration-style tests with mocked CDP HTTP:

- `status` handles online/offline
- `tabs` parses `/json/list`
- `navigate` sends `Page.navigate`
- `evaluate` sends `Runtime.evaluate`
- `screenshot` writes a file from `Page.captureScreenshot`

Manual verification:

```bash
/cdp launch
/cdp status
/cdp tabs
```

Then ask:

```text
Use my local logged-in Chrome to inspect http://localhost:3000 and screenshot the homepage.
```

## Implementation Sequence

1. Add tests for config and policy gating.
2. Implement `config.ts`.
3. Add mocked CDP client tests.
4. Implement `client.ts`.
5. Register `chrome_cdp` tool.
6. Register `/cdp` command.
7. Add `chrome-cdp-guide` skill.
8. Add docs and manual verification notes.
