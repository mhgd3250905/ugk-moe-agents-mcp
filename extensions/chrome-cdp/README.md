# Chrome CDP Extension

Guarded local Chrome DevTools Protocol control for UGK.

## Purpose

This extension lets the agent request access to a local, logged-in Chrome session when normal network access cannot reach a page because it needs cookies, SSO, CAPTCHA, private workspace state, or browser login state.

It is not a replacement for normal web access or documentation lookup.

## Commands

```text
/cdp status
/cdp ask
/cdp on
/cdp off
/cdp port 9222
/cdp launch
/cdp tabs
```

Default mode is `ask`, so browser operations require user confirmation.

## Chrome Launch

Use a dedicated Chrome profile:

```bash
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --remote-debugging-port=9222 \
  --user-data-dir="$HOME/.ugk/chrome-cdp-profile"
```

Login state stays inside Chrome. UGK does not store passwords, cookies, or credentials.

## Tool

The AI-callable tool is:

```text
chrome_cdp
```

Supported actions:

```text
status
launch
tabs
navigate
evaluate
screenshot
```

`status` and `launch` do not require a reason or confirmation. Every other action should include a reason and whether ordinary access was attempted.

## Parallel Safety

When multiple task workers run in parallel and each uses `chrome_cdp`, the runtime gives every worker its own dedicated tab automatically (no need to pass `target`). Workers never collide on the same tab, so parallel downloads/scrapes produce correct, non-duplicated output.

Internals: `extensions/shared/worker-lifecycle.ts` + `extensions/chrome-cdp/tab-session.ts` manage per-worker tab open/close. See `docs/design/2026-06-26-cdp-per-worker-tab-isolation.md`.

This isolation covers the `chrome_cdp` tool path only. If a worker script bypasses the tool and talks to the CDP port directly (e.g. via `pychrome`/curl), it will not pick up the dedicated tab — taskbooks should require the `chrome_cdp` tool instead.

