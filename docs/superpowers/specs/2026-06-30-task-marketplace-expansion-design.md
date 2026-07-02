# Task Marketplace Expansion Design

Date: 2026-06-30

## Goal

Build the full first release of the UGK task marketplace on Cloudflare Pages:

- Follow `DESIGN-binance.md`: dark financial-platform canvas, Binance yellow primary actions, compact dense data layout, small radii, number-heavy stat cells, and a light footer.
- Provide a catalog page, real task detail routes, and an account page.
- Seed the site with the taskbooks from `C:\Users\shengk\Downloads\tasks`.
- Keep `ugk task install <name>` working from the official Cloudflare Pages origin.
- Ship GitHub login, signed user sessions, author display, downloads, likes, favorites, and live stats through Pages Functions and D1.

This document describes the full implementation scope, not a static-only minimum slice.

## Architecture

Cloudflare Pages serves static marketplace assets from `docs/task-share/`.
Cloudflare Pages Functions under `functions/` provide the account and interaction API.
Cloudflare D1 stores users, official task rows, download events, likes, favorites, and aggregate counts.

```text
docs/task-share/
  index.html
  account/index.html
  manifest.json
  tasks/<name>/index.html
  taskbooks/<name>/**
  downloads/<name>.zip

functions/
  api/auth/github.js
  api/auth/callback.js
  api/session.js
  api/logout.js
  api/account/favorites.js
  api/tasks/[name]/stats.js
  api/tasks/[name]/download.js
  api/tasks/[name]/like.js
  api/tasks/[name]/favorite.js

migrations/
  0001_task_marketplace.sql
  0002_seed_official_tasks.sql
```

## Seed Tasks

Initial tasks come from `C:\Users\shengk\Downloads\tasks`:

- `bili-up-homepage-spider`
- `bilibili-downloader`
- `linkedin-search`
- `subtitle-fluent-translator`
- `subtitle-to-speech`
- `video-downloader`
- `video-zh-composer`
- `video-zh-dubber`
- `whisper-audio-to-text`
- `x-search`
- `x-video-downloader`

Seed author: `UGK Official`.

## Functional Requirements

| Feature | Implementation | Acceptance |
| --- | --- | --- |
| Catalog | `/` renders all official tasks with search, stats, install command, zip download, like, favorite, and detail link | Every manifest task appears in the catalog |
| Detail pages | `/tasks/<name>/` renders install command, author, runtime inputs, acceptance checks, tags, file count, script count, and stats | Every manifest task has a detail route |
| Installer source | `manifest.json` maps every safe relative task file to `https://ugk-task-share.pages.dev/taskbooks/<name>/<path>` | Installer downloads core files and task-owned scripts |
| Zip download | `/downloads/<name>.zip` contains exactly the manifest-listed files | Zip entries match `Object.keys(task.files)` |
| GitHub login | `/api/auth/github` starts OAuth; `/api/auth/callback` verifies state, exchanges code, upserts user, and sets a signed HTTP-only session | Bad state is rejected; valid callback creates session |
| Account | `/account/` shows signed-in identity and saved tasks through `/api/account/favorites` | Anonymous users are prompted to sign in; signed-in users get favorites |
| Author/uploader | Official tasks show `UGK Official`; D1 stores `author_name` for future user-submitted tasks | Catalog and detail pages show author |
| Download stats | Download link posts to `/api/tasks/<name>/download`; anonymous and signed-in downloads are counted | Count increments per event |
| Likes | `/api/tasks/<name>/like` requires login and toggles one like per user/task | Anonymous gets 401; signed-in toggle updates count |
| Favorites | `/api/tasks/<name>/favorite` requires login and toggles one favorite per user/task | Anonymous gets 401; signed-in toggle updates count |
| Live stats | `/api/tasks/<name>/stats` returns D1 counts and signed-in user flags | Page load refreshes static seed counts from D1 |

## Data Model

```sql
CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  github_id TEXT NOT NULL UNIQUE,
  login TEXT NOT NULL,
  avatar_url TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE tasks (
  name TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  author_user_id INTEGER,
  author_name TEXT NOT NULL,
  download_count INTEGER NOT NULL DEFAULT 0,
  like_count INTEGER NOT NULL DEFAULT 0,
  favorite_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE task_likes (
  task_name TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (task_name, user_id)
);

CREATE TABLE task_favorites (
  task_name TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (task_name, user_id)
);

CREATE TABLE download_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_name TEXT NOT NULL,
  user_id INTEGER,
  created_at TEXT NOT NULL
);
```

## Required Cloudflare Configuration

- D1 binding: `DB`
- Secret: `GITHUB_CLIENT_ID`
- Secret: `GITHUB_CLIENT_SECRET`
- Secret: `SESSION_SECRET`
- Optional env: `SITE_URL=https://ugk-task-share.pages.dev`

Without GitHub OAuth credentials, `/api/auth/github` returns a configuration error instead of pretending login works.

## Validation

- `node scripts/build-task-share.mjs`
- `node --test tests/task-install.test.ts`
- `node --test tests/task-share-site.test.ts`
- `node --test tests/task-marketplace-functions.test.ts`
- `npm test`
- Smoke install one seeded task with temp `PI_CODING_AGENT_DIR`
- Local Pages runtime:
  - `npx wrangler d1 migrations apply ugk-task-share-db --local`
  - `npx wrangler pages dev docs/task-share --port 8791 --binding GITHUB_CLIENT_ID=local-client --binding GITHUB_CLIENT_SECRET=local-secret --binding SESSION_SECRET=local-session-secret --binding SITE_URL=http://127.0.0.1:8791`
  - Do not pass `--d1` for this repo; letting Pages dev read `wrangler.toml` reuses the migrated local D1 database.
- After Cloudflare credentials are configured: apply D1 migrations, deploy Pages, then HTTP-check `/`, `/manifest.json`, `/tasks/video-downloader/`, `/downloads/video-downloader.zip`, `/api/session`, `/api/tasks/video-downloader/stats`, and anonymous 401 on `/api/tasks/video-downloader/like`.

## Risks

- Seed taskbooks include executable `verify.mjs` and task-owned scripts. Official source control remains the trust boundary.
- Production GitHub login requires a real GitHub OAuth app and Cloudflare secrets.
- D1 deployment requires replacing the placeholder database id in `wrangler.toml` with the created database id.
