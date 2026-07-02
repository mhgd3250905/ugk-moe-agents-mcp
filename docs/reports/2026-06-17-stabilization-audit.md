# UGK Stabilization Audit

Date: 2026-06-17

Branch: `codex/audit-stabilization`

Baseline: `origin/main` at `7bf8d970669e134bb434354761fc90763e5d99e2`

## Purpose

UGK has reached its first stable stage. This audit reviews and improves the project across eight dimensions:

1. Architecture design rationality
2. Module decoupling rationality
3. Boundary design rationality
4. Code simplicity and readability
5. Redundant code removal
6. Messy code cleanup
7. Complete and standardized documentation
8. Comprehensive logging and operator-facing status

## Ground Rules

- Work happens only on `codex/audit-stabilization`.
- Each audit slice must be small enough to review independently.
- Every code change needs a concrete reason in this file.
- Every slice gets a verification command before commit.
- Prefer existing pi extension APIs and UGK module patterns over new abstractions.
- Do not rewrite adjacent code without evidence that it blocks the audit goal.

## Final Audit Conclusion

The stable-stage audit completed across all eight requested dimensions. The branch keeps the existing UGK architecture, fixes concrete boundary and observability defects, removes proven redundancy, and updates the project-facing documentation to match the current v1.0.0 behavior.

| Requested dimension | Result | Evidence |
| --- | --- | --- |
| Architecture design rationality | Sound overall; keep the thin CLI + pi extension composition model. | Architecture map below; no pi internals were replaced. |
| Module decoupling rationality | Improved where a real shallow seam existed. | Slice 5 extracts cron agent binary detection into `cron/agent-bin.ts`. |
| Boundary design rationality | Improved high-risk user input and read-only boundaries. | Slices 2, 3, and 5 cover CDP port input, plan-mode bash filtering, and cron ESM execution. |
| Code simplicity and readability | Improved by removing a runtime-only inline expression and keeping changes local. | Slice 5 replaces inline `require` probing with a named helper. |
| Redundant code removal | Removed or de-duplicated only when proven by tests/search. | Slices 7 and 8 cover ADB candidate duplication and unused `formatAgentList()`. |
| Messy code cleanup | Cleanup stayed behavior-preserving and narrowly scoped. | All changes are small commits with focused tests or scans. |
| Documentation completeness | Updated stale stable-stage docs. | Slice 4 aligns README and AGENTS with Chrome CDP, UI, plan-mode hardening, and current test wording. |
| Logging/status completeness | Improved operator-facing failure visibility. | Slice 6 shows persisted cron stderr snippets in history output. |

## Current Architecture Map

UGK is an npm package that wraps pi rather than replacing pi internals.

- `bin/ugk.js` is the CLI entry. It sets the pi runtime marker, applies startup defaults, and injects `extensions/index.ts`.
- `extensions/index.ts` is the composition root. It registers tools, slash commands, input transforms, UI hooks, safety gates, and package resources.
- `extensions/subagent.ts` delegates isolated work to child `ugk` or `pi` processes.
- `extensions/plan-mode.ts` gates tools and tracks plan execution state.
- `extensions/cron.ts` is a client for the separate local cron service in `cron/service.ts`.
- `extensions/chrome-cdp/*` owns guarded local Chrome CDP control.
- `extensions/ui-*` owns UGK terminal presentation through pi UI hooks.
- `skills/`, `prompts/`, `themes/`, and `agents/` are package resources discovered or installed through existing UGK/pi seams.

## Audit Log

| Slice | Commit | Area | Files | Reason | Verification |
| --- | --- | --- | --- | --- | --- |
| 1 | `docs: add stabilization audit ledger` | Planning and traceability | `docs/superpowers/plans/2026-06-17-stabilization-audit.md`, this file | Establish a durable audit ledger before making optimization changes. | `npm test` passed: 60 tests |
| 2 | `fix: handle invalid cdp port commands` | Boundary design and operator status | `extensions/chrome-cdp/index.ts`, `tests/chrome-cdp-extension.test.ts`, this file | `/cdp port nope` escaped as an exception from the command handler. Stable command boundaries should report invalid input as an actionable warning and preserve the previous port. | `node --test tests/chrome-cdp-extension.test.ts` passed: 6 tests; `npm test` passed: 61 tests |
| 3 | `fix: tighten plan mode readonly command checks` | Boundary design and cleanup | `extensions/plan-mode-utils.ts`, `tests/plan-mode-utils.test.ts`, `package.json`, this file | Plan mode claimed read-only semantics but allowed `curl URL \| sh` and `curl -o file` because the whitelist only checked the command prefix. Progress tracking also counted unmatched `[DONE:n]` markers as updates. | `node --test tests/plan-mode-utils.test.ts` passed: 3 tests; `npm test` passed: 64 tests |
| 4 | `docs: align stable capability documentation` | Documentation and operator status | `README.md`, `AGENTS.md`, this file | Stable-stage docs were stale: AGENTS still said v0.6.0, README omitted `chrome_cdp`, `/cdp`, `/ugk-ui`, `chrome-cdp-guide`, and used an obsolete fixed test count. | `rg "v0\\.6\\.0\|25 个" README.md AGENTS.md` returned no matches; `npm test` passed: 64 tests |
| 5 | `fix: remove cron service inline require` | Module decoupling and runtime boundary | `cron/agent-bin.ts`, `cron/service.ts`, `tests/cron-agent-bin.test.ts`, `package.json`, this file | `cron/service.ts` runs in the package's ESM context but detected `ugk` with an inline `require("child_process")` inside job execution. That could fail only when a scheduled job fires, making the boundary hard to diagnose. | `node --test tests/cron-agent-bin.test.ts` passed: 2 tests; `npm test` passed: 66 tests |
| 6 | `feat: show cron stderr snippets in history` | Logging and operator status | `extensions/cron-contract.ts`, `tests/cron-contract.test.ts`, this file | The cron service persisted `stderrSnippet` for failed runs, but `history` did not show it. Users had to open the full output file for even a short failure reason. | `node --test tests/cron-contract.test.ts` passed: 3 tests; `npm test` passed: 67 tests |
| 7 | `refactor: dedupe adb path candidates` | Redundant code and status accuracy | `extensions/device-env.ts`, `tests/device-env.test.ts`, this file | `getAdbPaths()` included `ADB_PATH` and the same literal path, causing duplicate probing and making later path-order changes harder to reason about. | `node --test tests/device-env.test.ts` passed: 4 tests; `npm test` passed: 68 tests |
| 8 | `refactor: remove unused agent list formatter` | Redundant code cleanup | `extensions/subagent-agents.ts`, this file | `formatAgentList()` had no repository references (`rg "formatAgentList"` returned no matches after deletion) and was not documented as a public interface. Keeping it added dead API surface to subagent discovery. | `rg "formatAgentList"` returned no matches; `npm test` passed: 68 tests |

## Findings

### Architecture Design

Initial read: the core architecture is sound. UGK uses `bin/ugk.js` as a thin package entry and keeps product behavior in pi extension modules. This is the correct direction because it preserves upstream pi behavior and concentrates customization in extension seams.

Review result:

- `extensions/index.ts` is still acceptable as the composition root. It contains registration glue plus small status/resource discovery handlers; no broad extraction was made because the deeper capability modules already own the risky behavior.
- User-facing docs were stale and were aligned in slice 4. `/ugk` already includes the current Chrome CDP and UI command set.
- Chrome CDP launch behavior already has platform-focused launcher tests; this branch added boundary handling for invalid `/cdp port` input.

### Module Decoupling

Initial read: most complex capabilities have a registration file plus pure helpers and tests. This is good for locality.

Review result:

- `subagent.ts` is large, but its external interface is cohesive: one tool with single/parallel/chain execution. No extraction was made without a failing test or clearer seam.
- Plan-mode state and utility behavior are testable without pi; slice 3 added utility coverage for command safety and progress counting.
- Cron formatting remains shared in `extensions/cron-contract.ts`; slice 6 extended that contract instead of duplicating history formatting in the tool.

### Boundary Design

Initial read: the risky boundaries are process spawning, bash permission gates, local HTTP cron calls, CDP browser control, and file writes.

Review result:

- CDP command input boundary was tightened in slice 2.
- Plan-mode bash command boundary was tightened in slice 3.
- Cron scheduled execution boundary was tightened in slice 5.
- Existing CDP client tests cover screenshot file writes and online/offline status formatting; no additional path restriction was added because screenshot output path is an explicit tool parameter.

Fixed in slice 2:

- `/cdp port <value>` now catches invalid values at the command boundary, reports `Invalid CDP port: <value>. Use /cdp port <1-65535>.`, and keeps the previous resolved port.

Fixed in slice 3:

- Plan mode now blocks command strings that pipe or chain into common interpreters such as `sh`, `bash`, `node`, and `python`.
- Plan mode now blocks `curl` write, upload, and mutating request flags while still allowing read-only pipelines such as `grep file | head`.
- Plan execution progress now reports only newly completed matching todo items instead of counting unmatched `[DONE:n]` markers.

Fixed in slice 5:

- Cron agent binary detection is now a small tested module (`cron/agent-bin.ts`) instead of inline `require` inside the ESM cron service.
- The cron service keeps the same runtime behavior: prefer `ugk`, fall back to `pi`.

### Code Simplicity And Readability

Review result:

- The inline cron binary detection was extracted because it improved locality and testability.
- Other large modules were left intact where extraction would create churn without reducing caller knowledge.

### Redundant Code

Review result:

- Duplicate ADB candidates were removed by general de-duplication.
- The unused `formatAgentList()` export was removed after repository-wide search showed no callers.

Fixed in slice 7:

- `getAdbPaths()` now de-duplicates candidate paths, removing the current duplicate `E:\platform-tools\adb.exe` entry and preventing future environment-variable duplicates.

Fixed in slice 8:

- Removed the unused `formatAgentList()` export from `extensions/subagent-agents.ts` after repository search proved there were no callers.

### Cleanup

Review result:

- Cleanup was split into small commits and did not include broad formatting changes.
- All changed behavior has focused tests or explicit search evidence.

### Documentation

Review result:

- README and AGENTS now describe the current v1.0.0 capability surface and stable-stage boundaries.
- Existing `skills/chrome-cdp-guide/SKILL.md` and `extensions/chrome-cdp/README.md` already cover the Chrome CDP operational flow; no duplicate copy was added there.

Fixed in slice 4:

- README and AGENTS now describe the current v1.0.0 capability set, including Chrome CDP, `/cdp`, `/ugk-ui`, plan-mode read-only hardening, and `chrome-cdp-guide`.
- README no longer hard-codes an obsolete test count in the directory map.

### Logging And Status

Review result:

- CDP invalid port handling now returns an actionable warning instead of an exception.
- Cron history now surfaces short stderr snippets while preserving the full output file path.
- No broad logging was added to avoid noisy internals or accidental secret exposure.

Fixed in slice 6:

- Cron history now shows the persisted stderr snippet for failed runs, keeping the full output file path while surfacing the immediate failure reason.

## Verification History

| Time | Command | Result |
| --- | --- | --- |
| 2026-06-17 baseline | `npm test` | Passed: 60 tests, 0 failures |
| 2026-06-17 slice 2 focused | `node --test tests/chrome-cdp-extension.test.ts` | Passed: 6 tests, 0 failures |
| 2026-06-17 slice 2 full | `npm test` | Passed: 61 tests, 0 failures |
| 2026-06-17 slice 3 focused | `node --test tests/plan-mode-utils.test.ts` | Passed: 3 tests, 0 failures |
| 2026-06-17 slice 3 full | `npm test` | Passed: 64 tests, 0 failures |
| 2026-06-17 slice 4 stale-doc scan | `rg "v0\\.6\\.0\|25 个" README.md AGENTS.md` | No matches |
| 2026-06-17 slice 4 full | `npm test` | Passed: 64 tests, 0 failures |
| 2026-06-17 slice 5 focused | `node --test tests/cron-agent-bin.test.ts` | Passed: 2 tests, 0 failures |
| 2026-06-17 slice 5 full | `npm test` | Passed: 66 tests, 0 failures |
| 2026-06-17 slice 6 focused | `node --test tests/cron-contract.test.ts` | Passed: 3 tests, 0 failures |
| 2026-06-17 slice 6 full | `npm test` | Passed: 67 tests, 0 failures |
| 2026-06-17 slice 7 focused | `node --test tests/device-env.test.ts` | Passed: 4 tests, 0 failures |
| 2026-06-17 slice 7 full | `npm test` | Passed: 68 tests, 0 failures |
| 2026-06-17 slice 8 dead-code scan | `rg "formatAgentList"` | No matches |
| 2026-06-17 slice 8 full | `npm test` | Passed: 68 tests, 0 failures |
| 2026-06-17 final branch scan | `git diff --stat origin/main...HEAD`; `git log --oneline origin/main..HEAD`; `rg "TODO|FIXME|v0\\.6\\.0|25 个|formatAgentList|require\\(" . -n` | Expected diff/log collected; stale-code scan only matched this report's evidence text |
| 2026-06-17 final full | `npm test` | Passed: 68 tests, 0 failures |
