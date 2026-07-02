# Node / npm / npx

UGK is a Node-based package, and many MCP servers use `node`, `npm`, or `npx`.

## Check

```text
node --version
npm --version
npx --version
```

On Windows, also check whether these commands resolve from the same terminal that runs UGK.

## Guided Fix

If the user provides a Node installation path, verify it first:

```text
<node-dir>\node.exe --version
<node-dir>\npm.cmd --version
<node-dir>\npx.cmd --version
```

Do not ask for manual PATH changes until the binaries have been verified.

If `node` is missing:

```text
Install Node.js LTS, then reopen the terminal.
```

If `npm` or `npx` is missing:

```text
Repair or reinstall Node.js LTS. npm/npx should ship with Node.
```

If commands work in one terminal but not UGK:

```text
Reopen UGK from a terminal where node/npm/npx work, or fix Windows PATH.
```

Do not automatically rewrite the user's system PATH. If PATH must change, give the exact verified directory to add and ask the user to reopen UGK after changing it.

## Verification

All three version commands should print a version and exit successfully.
