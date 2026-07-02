# Task Marketplace Expansion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the full first-release UGK task marketplace: Binance-styled catalog/detail/account pages, official task seed import, installer-safe multi-file manifests, Cloudflare Pages Functions, GitHub login, D1-backed authorship, downloads, likes, favorites, and live stats.

**Architecture:** Generate static assets from local taskbook directories, serve them from Cloudflare Pages, and use Pages Functions + D1 for accounts and interactions. Do not ship fake identity; missing OAuth configuration must fail explicitly.

**Tech Stack:** Static HTML/CSS/JS, Node ESM stdlib, Cloudflare Pages Functions, Cloudflare D1, GitHub OAuth, existing `node --test`.

---

## Files

- Modify: `bin/task-install.js`
- Modify: `tests/task-install.test.ts`
- Modify: `tests/task-share-site.test.ts`
- Create: `tests/task-marketplace-functions.test.ts`
- Create: `scripts/build-task-share.mjs`
- Replace generated: `docs/task-share/index.html`
- Replace generated: `docs/task-share/manifest.json`
- Create generated: `docs/task-share/account/index.html`
- Create generated: `docs/task-share/tasks/<name>/index.html`
- Create generated: `docs/task-share/taskbooks/<name>/**`
- Create generated: `docs/task-share/downloads/<name>.zip`
- Create: `functions/_lib/marketplace.js`
- Create: `functions/api/**`
- Create: `migrations/0001_task_marketplace.sql`
- Create generated: `migrations/0002_seed_official_tasks.sql`
- Create: `wrangler.toml`

## Task 1: Lock Multi-file Manifest Behavior

- [x] Add installer coverage for manifest-listed `scripts/helper.mjs`.
- [x] Reject unsafe manifest paths: absolute paths, `..`, empty parts, and backslashes.
- [x] Update `bin/task-install.js` to download every listed file.
- [x] Verify `node --test tests/task-install.test.ts` passes.

## Task 2: Generate Marketplace Artifacts

- [x] Add site tests for 11+ tasks, detail routes, account route, exact zip entries, GitHub/account API hooks, and Cloudflare manifest URLs.
- [x] Create `scripts/build-task-share.mjs` to import `C:\Users\shengk\Downloads\tasks`.
- [x] Copy all task files, including nested `scripts/`.
- [x] Generate manifest, catalog page, detail pages, account page, and zips using Node stdlib.
- [x] Generate `migrations/0002_seed_official_tasks.sql` from the same task metadata.
- [x] Verify `node --test tests/task-share-site.test.ts` passes.

## Task 3: Design UI To Match `DESIGN-binance.md`

- [x] Catalog page uses dark canvas, yellow primary CTAs, compact stat strip, search control, dense task cards, and light footer.
- [x] Detail pages show install command, download zip, author, stats, runtime inputs, tags, file count, script count, and trust notice.
- [x] Account page shows signed-in identity and favorite tasks.
- [x] Live buttons are visible for login, download, like, favorite, stats refresh, and copy command.
- [x] Verify static HTML has no external runtime dependencies.

## Task 4: Implement Backend

- [x] Add D1 schema for users, tasks, likes, favorites, and download events.
- [x] Add GitHub OAuth start/callback routes with state validation and signed HTTP-only session cookie.
- [x] Add `/api/session` and `/api/logout`.
- [x] Add `/api/account/favorites`.
- [x] Add `/api/tasks/<name>/stats`.
- [x] Add `/api/tasks/<name>/download`.
- [x] Add `/api/tasks/<name>/like` with login-required toggle.
- [x] Add `/api/tasks/<name>/favorite` with login-required toggle.
- [x] Unit-test OAuth, sessions, anonymous rejection, toggles, live stats, and downloads.

## Task 5: Cloudflare Activation

- [ ] Create D1 database `ugk-task-share-db`.
- [ ] Replace `wrangler.toml` `database_id`.
- [ ] Apply D1 migrations remotely.
- [ ] Configure Pages secrets: `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `SESSION_SECRET`, and optional `SITE_URL`.
- [ ] Deploy `docs/task-share` and Functions to Cloudflare Pages.
- [ ] HTTP-check static routes and API routes.

## Task 6: Verification, Deployment, Git

- [x] Run `node scripts/build-task-share.mjs`.
- [x] Run `node --test tests/task-install.test.ts tests/task-share-site.test.ts tests/task-marketplace-functions.test.ts`.
- [x] Run `npm test`.
- [x] Smoke install one seeded task with temp install dir.
- [x] Run local Pages dev against local D1 by letting Wrangler read `wrangler.toml`; do not pass `--d1`, which creates an empty local binding.
- [ ] Deploy after Cloudflare credentials are available.
- [ ] Commit with Lore trailers.
