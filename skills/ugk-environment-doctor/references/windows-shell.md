# Windows Shell / Git Bash

UGK needs a bash-compatible shell for some child-agent and script workflows.

## Check

1. Confirm the OS is Windows.
2. Read `<agentDir>/settings.json`.
   - Default `agentDir`: `PI_CODING_AGENT_DIR`, otherwise `~/.pi/agent`.
   - Key: `shellPath`.
3. If `shellPath` exists, verify the file exists.
4. Run:

```text
"<bash.exe>" -lc "echo ok"
```

## Common Paths

```text
C:\Program Files\Git\bin\bash.exe
C:\Program Files\Git\usr\bin\bash.exe
C:\Program Files (x86)\Git\bin\bash.exe
C:\Program Files (x86)\Git\usr\bin\bash.exe
```

These are the official Git for Windows default install locations. If Git is installed elsewhere, ask the user for their `bash.exe` path and write it with `set_shell_path.mjs` — do not guess other drive letters.

## Guided Fix

If Git Bash is found, or if the user provides a `bash.exe` path, do not ask the user to edit JSON.

The agent must use the bundled helper script instead of asking the user to edit JSON:

```text
node skills/ugk-environment-doctor/scripts/set_shell_path.mjs "<bash.exe>"
```

If UGK is running from a different install root, resolve the script from the bundled skill directory first.

The helper script will:

1. Verify the path exists.
2. Run:

```text
"<bash.exe>" -lc "echo ok"
```

3. If it prints `ok`, write the absolute path to `<agentDir>/settings.json`.
4. Preserve all existing settings keys.
5. Print the written settings path.

After the script succeeds, tell the user exactly what was written and ask them to restart UGK if the current session cannot reload settings.

Example final settings shape:

```json
{
  "shellPath": "C:\\Program Files\\Git\\bin\\bash.exe"
}
```

If Git Bash is not found, tell the user to install Git for Windows, then rerun the check.

Never tell a beginner user to manually edit `settings.json` after they already provided a valid path.

## Verification

The fix is valid only when:

```text
"<bash.exe>" -lc "echo ok"
```

prints `ok`.
