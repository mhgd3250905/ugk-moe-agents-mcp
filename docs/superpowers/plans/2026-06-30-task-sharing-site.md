# Task Sharing Site Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build phase 1 of the official taskbook sharing site: users can download official taskbook zips or run `ugk task install <name>`.

**Architecture:** Keep it static and official-only. The website lives under `docs/task-share/`; the CLI install command runs before the TUI starts, reads the official manifest, downloads the five taskbook files, validates them, and writes to user task scope.

**Tech Stack:** Node ESM, built-in `fetch`, `node:fs/promises`, static HTML/CSS/JS, existing `node --test`.

---

## File Structure

- Create `bin/task-install.js`: small installer for `ugk task install <name>`.
- Modify `bin/ugk.js`: intercept `task install` before update checks, trust checks, and TUI startup.
- Create `tests/task-install.test.ts`: installer unit tests with mocked fetch and temp task root.
- Create `docs/task-share/index.html`: static official taskbook catalog.
- Create `docs/task-share/manifest.json`: official source of installable taskbooks.
- Create `docs/task-share/taskbooks/grapheme-count/*`: first harmless official taskbook.
- Create `docs/task-share/downloads/grapheme-count.zip`: browser download artifact.
- Create `tests/task-share-site.test.ts`: verifies manifest, HTML links, taskbook files, and zip presence.

## Git Save Points

1. Commit plan: `docs/superpowers/plans/2026-06-30-task-sharing-site.md`.
2. Commit installer: tests + `bin/task-install.js` + `bin/ugk.js`.
3. Commit site artifacts: `docs/task-share/**` + site tests.
4. Commit verification notes only if final verification reveals doc-only corrections.

## Task 1: Plan Commit

**Files:**
- Create: `docs/superpowers/plans/2026-06-30-task-sharing-site.md`

- [ ] **Step 1: Save this plan**

Use `apply_patch` to add this file.

- [ ] **Step 2: Verify plan has no placeholders**

Run:

```powershell
$terms = @([char]84+[char]66+[char]68, [char]84+[char]79+[char]68+[char]79, "待定", "以后再说", "暂定")
$hits = Select-String -Path docs/superpowers/plans/2026-06-30-task-sharing-site.md -Pattern $terms
if ($hits) { $hits; exit 1 }
```

Expected: exit code `1`, no matches.

- [ ] **Step 3: Commit plan**

Run:

```bash
git add -- docs/superpowers/plans/2026-06-30-task-sharing-site.md
git commit -m "Plan the first official task sharing slice"
```

Expected: one-file plan commit.

## Task 2: Installer Test First

**Files:**
- Create: `tests/task-install.test.ts`
- Create after red: `bin/task-install.js`
- Modify after red: `bin/ugk.js`

- [ ] **Step 1: Write failing installer tests**

Create `tests/task-install.test.ts` with tests for:

- installs a manifest-listed taskbook into a temp user task root
- refuses to overwrite an existing taskbook
- rejects a manifest/taskbook name mismatch

The test imports `runTaskInstall` from `../bin/task-install.js` and passes a fake `fetch`.

- [ ] **Step 2: Run red test**

Run:

```bash
node --test tests/task-install.test.ts
```

Expected: FAIL because `bin/task-install.js` does not exist yet.

- [ ] **Step 3: Implement minimal installer**

Create `bin/task-install.js`:

- `OFFICIAL_MANIFEST_URL`
- `runTaskInstall(name, deps)`
- `runTaskInstallCli(argv, deps)`
- `isTaskInstallCommand(argv)`

Use only standard library. Validate name with `/^[A-Za-z0-9_-]+$/`. Required files are exactly:

```js
["taskbook.json", "spec.json", "skill.md", "verify.mjs", "contract.json"]
```

Default target root:

```js
process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent")
```

Write to `<agentDir>/tasks/<name>/`. If that directory already exists, throw.

- [ ] **Step 4: Wire CLI intercept**

Modify `bin/ugk.js` so:

```bash
ugk task install grapheme-count
```

runs installer and exits before starting pi.

- [ ] **Step 5: Run green installer tests**

Run:

```bash
node --test tests/task-install.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit installer**

Run:

```bash
git add -- bin/task-install.js bin/ugk.js tests/task-install.test.ts
git commit -m "Add official task install command"
```

Expected: installer commit only.

## Task 3: Static Site and Official Taskbook Test First

**Files:**
- Create: `tests/task-share-site.test.ts`
- Create after red: `docs/task-share/index.html`
- Create after red: `docs/task-share/manifest.json`
- Create after red: `docs/task-share/taskbooks/grapheme-count/taskbook.json`
- Create after red: `docs/task-share/taskbooks/grapheme-count/spec.json`
- Create after red: `docs/task-share/taskbooks/grapheme-count/skill.md`
- Create after red: `docs/task-share/taskbooks/grapheme-count/verify.mjs`
- Create after red: `docs/task-share/taskbooks/grapheme-count/contract.json`
- Create after red: `docs/task-share/downloads/grapheme-count.zip`

- [ ] **Step 1: Write failing site tests**

Create `tests/task-share-site.test.ts` that:

- reads `docs/task-share/manifest.json`
- asserts each task has five files in `docs/task-share/taskbooks/<name>/`
- parses JSON files
- asserts `taskbook.json.name` matches manifest name
- asserts `docs/task-share/index.html` contains `ugk task install <name>`
- asserts `docs/task-share/downloads/<name>.zip` exists and has non-zero size

- [ ] **Step 2: Run red site test**

Run:

```bash
node --test tests/task-share-site.test.ts
```

Expected: FAIL because `docs/task-share/manifest.json` does not exist yet.

- [ ] **Step 3: Add first official taskbook**

Create `grapheme-count`, a safe text taskbook:

- input: `text`
- output artifact: `result.json`
- worker goal: count Unicode grapheme clusters using `Intl.Segmenter`
- verify: checks `result.json` exists, includes `input`, numeric `graphemes`, and matches `Intl.Segmenter`

- [ ] **Step 4: Add manifest and static page**

Add `manifest.json` pointing at raw GitHub URLs for the five files. Add `index.html` with accessible cards, download link, and copyable command.

- [ ] **Step 5: Create zip**

Run a local zip command to create `docs/task-share/downloads/grapheme-count.zip` from the five taskbook files.

- [ ] **Step 6: Run green site test**

Run:

```bash
node --test tests/task-share-site.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit site artifacts**

Run:

```bash
git add -- docs/task-share tests/task-share-site.test.ts
git commit -m "Add official task sharing page"
```

Expected: site commit only.

## Task 4: Full Verification and Delivery

**Files:**
- Read: `docs/superpowers/specs/2026-06-30-task-sharing-site-design.md`
- Read: `docs/superpowers/plans/2026-06-30-task-sharing-site.md`

- [ ] **Step 1: Run focused tests**

Run:

```bash
node --test tests/task-install.test.ts tests/task-share-site.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run full tests**

Run:

```bash
npm test
```

Expected: all tests pass.

- [ ] **Step 3: Manual CLI smoke**

Run with a temp agent dir and fake official source if needed by test helper, or run the direct exported installer test path. Do not install into the real user task root during smoke.

- [ ] **Step 4: Requirement audit**

Check:

- zip download exists
- copy command exists on page
- `ugk task install <name>` installs without entering TUI
- official-only install path
- no new dependencies
- no backend
- existing taskbook is not overwritten

- [ ] **Step 5: Final status**

Report changed files, commits, verification output, and remaining risks.
