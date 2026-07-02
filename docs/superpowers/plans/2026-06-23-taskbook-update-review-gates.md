# Taskbook Update Review Gates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `/task edit` update an existing taskbook incrementally, and require explicit skill/verify design confirmation before writing taskbook files.

**Architecture:** Reuse the existing reviewing/save flow. `/task edit <name>` loads the existing taskbook into reviewing with old `spec/skill/verify/contract` in the review context instead of entering planning/executing. `TASK_REVIEW_PROMPT` becomes stricter: questionnaire must confirm the reusable skill path and verify design before the agent outputs skill/verify/contract JSON.

**Follow-up:** `/task run` worker is a child `--no-session` process, so protected tools that ask for confirmation (`chrome_cdp`, MCP registered tools) need a parent-side one-run authorization before spawning the worker. The authorization is task-local env only and must not couple `/task` to plan mode.

**Tech Stack:** TypeScript ESM, Node test runner, existing `/task` extension state and taskbook store.

---

### Task 1: Edit Enters Incremental Update Review

**Files:**
- Modify: `extensions/task/task-state.ts`
- Modify: `extensions/task/task.ts`
- Test: `tests/task-extension.test.ts`

- [ ] **Step 1: Write the failing test**

Replace the old `/task edit loads an existing taskbook into planning` expectation with a test that asserts edit enters `reviewing`, preserves existing taskbook name/scope, and injects old taskbook assets into the prompt.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests\task-extension.test.ts --test-name-pattern "edit loads"`
Expected: FAIL because current code still enters `planning`.

- [ ] **Step 3: Write minimal implementation**

Add `taskbookScope?: "user" | "project"` to `TaskState`. In edit handler, set state to `enterReviewing(...)` with a summary containing existing `skill.md`, `verify.mjs`, and `contract.json`; set `taskbookName` and `taskbookScope`; do not start execution.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests\task-extension.test.ts --test-name-pattern "edit loads"`
Expected: PASS.

### Task 2: Save Updates Existing Scope

**Files:**
- Modify: `extensions/task/task.ts`
- Test: `tests/task-extension.test.ts`

- [ ] **Step 1: Write the failing test**

Add a test that edits a project taskbook, completes review JSON, runs `/task save`, and verifies the project taskbook is overwritten while preserving `runs[]`.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests\task-extension.test.ts --test-name-pattern "edit save"`
Expected: FAIL because save currently defaults to user scope when no `--project` is passed.

- [ ] **Step 3: Write minimal implementation**

In `saveCurrentTask`, choose scope as explicit token scope when provided, otherwise `state.taskbookScope`, otherwise current default.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests\task-extension.test.ts --test-name-pattern "edit save"`
Expected: PASS.

### Task 3: Skill And Verify Design Gates In Review Prompt

**Files:**
- Modify: `extensions/task/task-prompts.ts`
- Test: `tests/task-extension.test.ts`

- [ ] **Step 1: Write the failing test**

Assert `TASK_REVIEW_PROMPT` requires a questionnaire before writing `skill.md` and `verify.mjs`, and names the required design dimensions: source/method, required steps, noise to omit, output path and format, artifacts, assertions, failure cases, runtime input, and tolerated variability.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests\task-extension.test.ts --test-name-pattern "review prompt"`
Expected: FAIL because prompt is currently too vague.

- [ ] **Step 3: Write minimal implementation**

Update `TASK_REVIEW_PROMPT` only. Do not add new runtime parser/enforcement unless tests prove it is necessary.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests\task-extension.test.ts --test-name-pattern "review prompt"`
Expected: PASS.

### Task 4: Verification

**Files:**
- Modify: `docs/design/task-extension-spec.md`
- Optional update: existing task testing report if test count changes.

- [ ] **Step 1: Update task spec**

Document that edit is an update flow, repair is failure-driven update, and review requires skill/verify design questionnaire before file output.

- [ ] **Step 2: Run targeted tests**

Run: `node --test tests\task-extension.test.ts tests\task-state.test.ts`
Expected: PASS.

- [ ] **Step 3: Run full tests**

Run: `npm test`
Expected: PASS.

- [ ] **Step 4: Check diff hygiene**

Run: `git diff --check`
Expected: no output.

### Follow-up Task: Protected Tool Preauthorization For Worker

**Files:**
- Modify: `extensions/task/task.ts`
- Modify: `extensions/task/task-worker.ts`
- Modify: `extensions/subagent.ts`
- Modify: `extensions/chrome-cdp/config.ts`
- Modify: `extensions/mcp/permissions.ts`
- Modify: `extensions/mcp/index.ts`
- Test: `tests/task-extension.test.ts`
- Test: `tests/task-worker.test.ts`
- Test: `tests/chrome-cdp-config.test.ts`
- Test: `tests/mcp-permissions.test.ts`

- [x] Add focused failing tests for one-run env propagation and denied authorization.
- [x] Pass task-local env into the worker child process.
- [x] Let `chrome_cdp` and MCP tools skip only the confirmation step when the matching task env is present.
- [x] Document `contract.requiredTools` and the `/task run` authorization flow.
