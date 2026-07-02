# Chrome CDP Extension Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a guarded Chrome CDP extension that lets UGK's agent request access to a local logged-in Chrome session only when ordinary network access is insufficient.

**Architecture:** The extension is built into the UGK package under `extensions/chrome-cdp/`. It registers one AI-callable tool (`chrome_cdp`), one user command (`/cdp`), and one guidance skill (`chrome-cdp-guide`). Runtime state stays in memory for the active session; login state stays in Chrome's dedicated profile.

**Tech Stack:** TypeScript extensions loaded by pi/jiti, TypeBox schemas via `@earendil-works/pi-ai`, Node `fetch`, Node `WebSocket`, Node test runner.

---

## Files

- Create: `extensions/chrome-cdp/config.ts`
- Create: `extensions/chrome-cdp/client.ts`
- Create: `extensions/chrome-cdp/formatter.ts`
- Create: `extensions/chrome-cdp/index.ts`
- Create: `extensions/chrome-cdp/README.md`
- Create: `skills/chrome-cdp-guide/SKILL.md`
- Create: `tests/chrome-cdp-config.test.ts`
- Create: `tests/chrome-cdp-client.test.ts`
- Create: `tests/chrome-cdp-extension.test.ts`
- Modify: `extensions/index.ts`
- Modify: `package.json`

## Task 1: Config And Policy

- [ ] Write failing tests in `tests/chrome-cdp-config.test.ts` for default `ask` mode, port priority, `/cdp port` runtime override, `off` mode blocking, and `normalAccessAttempted=false` gating.
- [ ] Run `node --test tests/chrome-cdp-config.test.ts` and confirm it fails because `extensions/chrome-cdp/config.ts` does not exist.
- [ ] Implement `extensions/chrome-cdp/config.ts` with `createChromeCdpState`, `resolveChromeCdpPort`, `setChromeCdpMode`, `setChromeCdpPort`, and `checkChromeCdpPolicy`.
- [ ] Re-run `node --test tests/chrome-cdp-config.test.ts` and confirm it passes.

## Task 2: CDP Client And Formatters

- [ ] Write failing tests in `tests/chrome-cdp-client.test.ts` using mocked `fetch` and `WebSocket` dependencies.
- [ ] Test `status` offline/online, `tabs` parsing, `navigate`, `evaluate`, and `screenshot` file writes.
- [ ] Implement `extensions/chrome-cdp/client.ts` with local-only `127.0.0.1` CDP HTTP and WebSocket calls.
- [ ] Implement `extensions/chrome-cdp/formatter.ts` for status, tabs, and action result messages.
- [ ] Re-run `node --test tests/chrome-cdp-client.test.ts` and confirm it passes.

## Task 3: Pi Extension Registration

- [ ] Write failing tests in `tests/chrome-cdp-extension.test.ts` that verify `chrome_cdp` tool and `/cdp` command registration.
- [ ] Test command behavior for `/cdp status`, `/cdp ask`, `/cdp on`, `/cdp off`, and `/cdp port 9223`.
- [ ] Test tool behavior for `off` mode, `ask` mode confirmation, and explicit local Chrome usage.
- [ ] Implement `extensions/chrome-cdp/index.ts`.
- [ ] Wire it into `extensions/index.ts`.
- [ ] Re-run `node --test tests/chrome-cdp-extension.test.ts` and confirm it passes.

## Task 4: Skill And Docs

- [ ] Create `skills/chrome-cdp-guide/SKILL.md` with narrow trigger rules and anti-abuse guidance.
- [ ] Create `extensions/chrome-cdp/README.md` with `/cdp launch`, `/cdp status`, and Chrome profile notes.
- [ ] Update `/ugk` status text to include `/cdp` and `chrome_cdp`.

## Task 5: Verification And Commit

- [ ] Add the new test files to `package.json` `test` script.
- [ ] Run `npm test`.
- [ ] Run a syntax/import smoke check with `node --test tests/chrome-cdp-config.test.ts tests/chrome-cdp-client.test.ts tests/chrome-cdp-extension.test.ts`.
- [ ] Commit implementation with `feat: add guarded chrome cdp extension`.
