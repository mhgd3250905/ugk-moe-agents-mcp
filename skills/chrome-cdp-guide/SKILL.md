---
name: chrome-cdp-guide
description: "MUST use for almost every CDP-related request: user says CDP, chrome_cdp, /cdp, Chrome DevTools Protocol, local Chrome, browser control, logged-in browser, browser cookies, SSO, CAPTCHA, screenshots, DOM inspection, or private browser state. Prefer the chrome_cdp tool; do not control CDP through bash/curl/node scripts when chrome_cdp is available."
---

# Chrome CDP Guide

Use `chrome_cdp` only for local logged-in Chrome access. Do not use it as the default way to browse public websites.

If the request mentions CDP, load this skill before taking action. The skill decides whether CDP is appropriate; do not skip the skill and improvise with bash.

## Tool Rule

- Use the `chrome_cdp` tool for launch, status, tabs, navigation, evaluation, screenshots, and DOM inspection.
- Do not use `bash`, `curl`, `node`, or hand-written CDP HTTP/WebSocket scripts to control Chrome when `chrome_cdp` is available.
- If CDP is not connected, use `chrome_cdp` with `action=launch`; do not start Chrome through `bash`.
- Use `/cdp` commands only for user-facing configuration (`ask`, `on`, `off`, `port`, `launch`) or when instructing the user how to configure CDP.

## Use This Skill When

- The user mentions CDP, `chrome_cdp`, `/cdp`, DevTools Protocol, local Chrome, browser control, or an already logged-in browser.
- A page requires the user's existing Chrome login state, cookies, SSO, CAPTCHA completion, or private workspace state.
- Ordinary network access was attempted or reasoned through and cannot reach the target content.
- The user wants an actual Chrome screenshot or DOM inspection of a local/private page.

## Do Not Use This Skill For

- Public web search.
- Ordinary documentation lookup.
- Pages accessible through normal HTTP, `bash`, or browser-free methods.
- Static source-code inspection.
- Login automation or password entry.

## Required Flow

1. Prefer ordinary access first.
2. If ordinary access is insufficient, explain why CDP is needed.
3. Call `chrome_cdp` with:
   - `reason`: a clear explanation tied to logged-in/local Chrome state
   - `normalAccessAttempted`: `true` unless the user explicitly requested local Chrome/CDP
4. Start with `chrome_cdp` `action=status` if CDP availability is unknown.
5. In default `ask` mode, wait for user approval before browser operations.
6. Never ask the user to give passwords to the agent.

## Configuration Commands

```text
/cdp status
/cdp ask
/cdp on
/cdp off
/cdp port 9222
/cdp launch
/cdp tabs
```

These commands configure UGK's CDP access. They are not a replacement for the `chrome_cdp` tool during agent work.

## Chrome Launch

Prefer `/cdp launch`. If a manual fallback is needed, use a dedicated UGK Chrome profile:

```bash
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --remote-debugging-port=9222 \
  --user-data-dir="$HOME/.ugk/chrome-cdp-profile"
```

The user logs in inside that Chrome profile. UGK does not store credentials.
