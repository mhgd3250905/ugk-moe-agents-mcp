# UGK Doctor Design

## Purpose

Add a `/doctor` command that checks whether the core UGK TUI runtime is ready for normal use.

The first version is intentionally narrow. It checks only:

- Bash execution
- DeepSeek API availability
- Chrome availability and Chrome CDP reachability

Android-related checks stay outside `/doctor`. `adb`, `scrcpy`, and Android device status remain owned by `/check-env`, `adb-guide`, and `scrcpy-guide`.

## Non-Goals

- Do not install software.
- Do not write configuration.
- Do not change `/cdp` mode or port.
- Do not launch Chrome automatically.
- Do not check Android, `adb`, `scrcpy`, or connected devices.
- Do not replace extension-specific commands or guides.

`/doctor` is a read-only health check. It reports status and points the user to the right command or guide.

## User Experience

The user runs:

```text
/doctor
```

Expected output shape:

```text
UGK Doctor

[pass] Shell   bash available
[pass] API     DeepSeek configured via DEEPSEEK_API_KEY
[warn] Chrome  Chrome found, but CDP not reachable on 127.0.0.1:9222

Next steps:
  /cdp launch
  /cdp status
```

If everything passes:

```text
UGK Doctor

[pass] Shell   bash available
[pass] API     DeepSeek configured via DEEPSEEK_API_KEY
[pass] Chrome  Chrome CDP reachable on 127.0.0.1:9222

All core checks passed.
```

## Checks

### `shell.bash`

Verifies that `bash` can execute a minimal command.

Suggested probe:

```bash
bash -lc "echo ok"
```

Pass criteria:

- Process exits successfully.
- Output contains `ok`.

Failure guidance:

- Tell the user that UGK could not execute `bash`.
- Suggest checking `PATH` or installing a shell compatible with `bash`.

### `api.deepseek`

Reuses the existing DeepSeek status logic in `extensions/deepseek-status.ts`.

Pass criteria:

- `DEEPSEEK_API_KEY` is present, or
- pi auth contains DeepSeek credentials.

Failure guidance:

- Suggest setting `DEEPSEEK_API_KEY`.
- Suggest running `/login`.

### `chrome.binary`

Verifies that UGK can find a Chrome executable using the same platform-aware lookup path as the Chrome CDP launcher.

Pass criteria:

- On macOS, `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome` exists.
- On Windows, one of the known Chrome install paths exists, or `chrome.exe` can be used from `PATH`.
- On Linux, `google-chrome` can be resolved from `PATH`.

Failure guidance:

- Tell the user Chrome was not found.
- Suggest installing Chrome or checking the environment path.

### `chrome.cdp`

Reuses the existing Chrome CDP status logic.

Pass criteria:

- `http://127.0.0.1:<port>/json/list` is reachable.
- At least the CDP endpoint responds successfully.

Warn criteria:

- Chrome binary exists but CDP is not reachable.

Failure guidance:

- Suggest `/cdp launch`.
- Suggest `/cdp status`.
- Show the port being checked.

## Architecture

Add a small doctor module under:

```text
extensions/doctor/
```

Suggested files:

```text
extensions/doctor/types.ts
extensions/doctor/registry.ts
extensions/doctor/checks.ts
extensions/doctor/formatter.ts
extensions/doctor/index.ts
```

`/doctor` should be registered from `extensions/index.ts`, like the existing `/check-env`, `/cdp`, and `/ugk` commands.

The first implementation can keep the checks in `extensions/doctor/checks.ts`. A registry abstraction is acceptable if it stays small, but the first version does not need extension-owned configuration or fix registration.

Suggested types:

```ts
export type DoctorStatus = "pass" | "warn" | "fail" | "skip";

export interface DoctorCheck {
	id: string;
	title: string;
	category: "shell" | "api" | "chrome";
	run(): Promise<DoctorResult>;
}

export interface DoctorResult {
	status: DoctorStatus;
	summary: string;
	details?: string[];
	nextSteps?: string[];
}
```

## Data Flow

1. User runs `/doctor`.
2. Command handler runs the core doctor checks with short timeouts.
3. Results are formatted into a compact TUI notification.
4. Any failing or warning checks contribute `nextSteps`.
5. `/doctor` exits without changing runtime state.

## Timeout And Error Handling

Every external probe must have a timeout.

Recommended timeout defaults:

- `bash`: 3 seconds
- Chrome binary path checks: no command execution where possible; if resolving from `PATH`, 3 seconds
- Chrome CDP HTTP status: reuse existing CDP client behavior, with a bounded request timeout if needed

Unexpected exceptions should be converted into `fail` or `warn` results. `/doctor` should never throw through the command handler.

## Relationship To Existing Commands

`/doctor` does not replace these commands:

- `/check-env`: Android, `adb`, `scrcpy`, and device checks
- `/cdp`: Chrome CDP configuration, launch, mode, port, and tab listing
- `/ugk`: general UGK status summary
- `/login`: API auth setup

`/doctor` may point users to these commands as next steps.

## Testing

Add focused unit tests:

- `tests/doctor-checks.test.ts`
- `tests/doctor-formatter.test.ts`
- `tests/doctor-extension.test.ts`

Test coverage should verify:

- Bash pass and failure formatting.
- DeepSeek configured through env.
- DeepSeek configured through auth file.
- DeepSeek missing.
- Chrome binary found and missing.
- Chrome CDP reachable and unreachable.
- `/doctor` registers as a command.
- `/doctor` reports failures without throwing.
- Android checks are not included.

Run:

```bash
node --test tests/doctor-checks.test.ts tests/doctor-formatter.test.ts tests/doctor-extension.test.ts
npm test
```

## Rollout

Implement in one small feature branch or worktree.

Recommended commit slices:

1. Add doctor result types, formatter, and tests.
2. Add core checks for bash, DeepSeek, Chrome binary, and Chrome CDP.
3. Register `/doctor` and update `/ugk` command listing.
4. Run full verification and update docs if needed.

## Open Decisions

No open product decisions remain for the first version.

The approved first-version scope is:

- Include `bash`, `api`, and `chrome`.
- Exclude Android.
- Keep `/doctor` read-only.
- Leave extension configuration and repair flows inside extension-specific commands and guides.
