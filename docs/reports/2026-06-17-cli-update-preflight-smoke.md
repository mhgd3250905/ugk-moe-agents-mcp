# CLI Update Preflight Smoke Test

This marker commit exists to exercise the UGK startup update preflight.

Expected manual flow:

1. Start UGK from a local commit before this marker.
2. Confirm the Codex-style update prompt appears before the TUI starts.
3. Choose `Update now`.
4. Confirm UGK runs the update command, asks for restart, and exits.

