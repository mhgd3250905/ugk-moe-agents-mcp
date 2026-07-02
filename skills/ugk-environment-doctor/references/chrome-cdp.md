# Chrome CDP

Chrome CDP lets UGK control the user's local Chrome profile when browser state, cookies, or screenshots are needed.

## Check

1. Find Chrome.
2. Read the configured CDP port, usually `9222`.
3. Check:

```text
http://127.0.0.1:<port>/json/version
```

4. If reachable, check `/json` for open tabs.

## Guided Fix

If Chrome is missing:

```text
Install Google Chrome, then rerun the environment check.
```

If Chrome exists but CDP is offline:

```text
/cdp launch
/cdp status
```

If the user gives a CDP port, the agent should apply it with the existing command and verify it. Do not ask the user to edit settings manually.

```text
/cdp port <port>
/cdp status
```

If the configured port is wrong and the user has not supplied a port, use the default:

```text
/cdp port 9222
/cdp launch
```

If an old Chrome process blocks startup, ask the user to close the UGK-launched Chrome window, then run `/cdp launch` again.

If the user gives a Chrome path, verify the file exists and explain the current launch path behavior. Do not invent a persistent custom Chrome path unless UGK has one.

## Verification

`/cdp status` should report CDP reachable and show tab count.
