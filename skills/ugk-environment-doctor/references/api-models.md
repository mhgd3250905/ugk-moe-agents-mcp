# API And Model Switching

API and model switching are guidance, not required health checks.

If the user can chat with the agent, the core API path is already working enough for this skill to help.

## Common Questions

Model name in the footer:

```text
The footer shows the selected model. It does not prove a specific provider API is configured.
```

Login:

```text
Use /login when the underlying pi agent supports provider login.
```

Environment variable:

```text
Provider APIs can also use environment variables such as DEEPSEEK_API_KEY.
```

Switching models:

```text
Use the model selector or the supported pi/UGK model configuration path for the installed version.
```

If the user asks you to switch API/model and the session is already running, inspect the available local commands/config first. Apply supported UGK-side config yourself when a safe command or config helper exists; otherwise give the exact built-in action such as `/login` or the model selector.

Cannot enter the agent at all:

```text
This skill cannot run before chat works. Follow README install/login instructions first.
```
