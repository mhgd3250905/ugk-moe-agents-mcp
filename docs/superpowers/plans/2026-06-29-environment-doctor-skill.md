# Environment Doctor Skill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `/doctor` as a health-check table with a guided environment troubleshooting skill for beginner UGK users.

**Architecture:** Keep `/doctor` as a compatibility shim that points users to the bundled skill. Put troubleshooting knowledge in `skills/ugk-environment-doctor/` so the agent can guide users conversationally. Reuse existing `bash-guide`, `chrome-cdp-guide`, and `mcp-guide` instead of duplicating all details.

**Tech Stack:** TypeScript extension commands, bundled Markdown skills, Node test runner.

---

## Requirements

- `/doctor` should no longer run all local health checks or present DeepSeek API as a required runtime module.
- A new bundled skill should trigger on `doctor`, environment setup failures, Bash/Git Bash, Chrome CDP, MCP, Node/npm/npx, PATH, Windows permission/config issues, and API/model switching questions.
- The skill should guide one failing area at a time with beginner-friendly steps.
- API/model content is explanatory only, not a required health check.
- Existing MCP read-only doctor helper may remain available for internal tests, but root `/doctor` should not depend on it.
- README and bundled-skill tests should advertise the skill-based flow.

## File Map

- Create `skills/ugk-environment-doctor/SKILL.md`: top-level trigger rules and workflow.
- Create `skills/ugk-environment-doctor/references/windows-shell.md`: Git Bash and `settings.json.shellPath` repair flow.
- Create `skills/ugk-environment-doctor/references/chrome-cdp.md`: Chrome/CDP launch, status, and port repair flow.
- Create `skills/ugk-environment-doctor/references/mcp.md`: MCP status interpretation and safe repair flow.
- Create `skills/ugk-environment-doctor/references/node-npm.md`: Node/npm/npx checks and repair flow.
- Create `skills/ugk-environment-doctor/references/api-models.md`: login, API, and model switching explanation.
- Create `skills/ugk-environment-doctor/scripts/set_shell_path.mjs`: verifies a user-provided Bash path and writes `settings.json.shellPath` without asking beginners to edit JSON.
- Modify `extensions/doctor/index.ts`: make `/doctor` a migration notice.
- Modify `extensions/index.ts`: stop importing/running core doctor checks from root registration.
- Modify `extensions/ui-brand-utils.ts`: describe `/doctor` as guided environment help.
- Modify `extensions/shared/ui-language.ts`: keep translated UI quick-tip text aligned.
- Modify `README.md`: replace table-health-check wording with skill-based guidance.
- Modify `tests/bundled-skills.test.ts`: verify the new skill bundle and references.
- Modify `tests/doctor-extension.test.ts`: verify `/doctor` shows a migration notice and ignores injected checks.
- Modify `tests/integration/mcp-extension.test.ts`: root extension should still register `/doctor`, but it should point to the skill instead of reporting MCP.

## Verification Plan

Focused tests:

```bash
node --test tests/bundled-skills.test.ts tests/doctor-extension.test.ts
```

Expected: new skill bundle assertions pass; `/doctor` migration notice tests pass.

Integration test:

```bash
node --test tests/integration/mcp-extension.test.ts
```

Expected: MCP registry behavior still passes; root extension `/doctor` is present and points to environment skill.

Full test suite:

```bash
npm test
npm run test:integration
```

Expected: all root and integration tests pass. If unrelated dirty files exist, do not stage them.

Manual content checks:

```bash
rg -n "DeepSeek|API" skills/ugk-environment-doctor
rg -n "/doctor|environment" README.md extensions
```

Expected: API/model appears only as usage guidance in the skill, not as a required health check.

## Tasks

### Task 1: Plan And Failing Tests

**Files:**
- Create: `docs/superpowers/plans/2026-06-29-environment-doctor-skill.md`
- Modify: `tests/bundled-skills.test.ts`
- Modify: `tests/doctor-extension.test.ts`
- Modify: `tests/integration/mcp-extension.test.ts`

- [ ] Add bundled skill test that expects `skills/ugk-environment-doctor/SKILL.md` and all reference files.
- [ ] Change `/doctor` extension tests to expect a migration notice, not a health table.
- [ ] Change root MCP integration test to expect the migration notice instead of MCP check output.
- [ ] Run focused tests and confirm they fail because implementation is missing.

### Task 2: Add The Environment Doctor Skill

**Files:**
- Create: `skills/ugk-environment-doctor/SKILL.md`
- Create: `skills/ugk-environment-doctor/references/windows-shell.md`
- Create: `skills/ugk-environment-doctor/references/chrome-cdp.md`
- Create: `skills/ugk-environment-doctor/references/mcp.md`
- Create: `skills/ugk-environment-doctor/references/node-npm.md`
- Create: `skills/ugk-environment-doctor/references/api-models.md`

- [ ] Write `SKILL.md` under 100 lines with exact trigger language.
- [ ] Add reference docs with copy-pasteable beginner steps.
- [ ] Add the shell-path helper script so the agent can configure Bash after the user provides a path.
- [ ] Reuse `/cdp`, `/mcp`, `/login`, `/ui-language`, and `settings.json.shellPath` terminology from existing guides.
- [ ] Run bundled skill tests and confirm skill bundle assertions pass.

### Task 3: Turn `/doctor` Into A Migration Notice

**Files:**
- Modify: `extensions/doctor/index.ts`
- Modify: `extensions/index.ts`
- Modify: `extensions/ui-brand-utils.ts`
- Modify: `extensions/shared/ui-language.ts`

- [ ] Make `registerDoctor` ignore old checks and notify users to ask for environment help.
- [ ] Remove root dependency on `createCoreDoctorChecks()` and `createMcpDoctorCheck()`.
- [ ] Keep `/doctor` registered for old muscle memory.
- [ ] Update UI quick action text from "check local tools" to "environment help".
- [ ] Run doctor and integration tests.

### Task 4: Docs And Final Verification

**Files:**
- Modify: `README.md`

- [ ] Replace old `/doctor` health-check language with the guided skill flow.
- [ ] Mention that API/model switching is guidance, not a required health check.
- [ ] Run focused tests, integration tests, and full test scripts.
- [ ] Review `git diff --stat` and ensure no unrelated dirty files are staged.
