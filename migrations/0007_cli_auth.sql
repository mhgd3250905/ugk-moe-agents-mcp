-- CLI publish auth: market website brokers GitHub OAuth for the TUI.
-- Flow: TUI generates challenge -> POST /api/cli/auth/start (records challenge
-- here) -> user logs in on the site -> callback signs a cli_token -> TUI polls
-- /api/cli/auth/poll to retrieve it. challenge is short-lived (5 min);
-- cli_tokens are long-lived bearer credentials, revocable by DELETE.

CREATE TABLE IF NOT EXISTS cli_auth_pending (
	challenge TEXT PRIMARY KEY,
	created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS cli_tokens (
	token TEXT PRIMARY KEY,
	user_id INTEGER NOT NULL,
	challenge TEXT NOT NULL,
	created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cli_tokens_challenge ON cli_tokens(challenge);
CREATE INDEX IF NOT EXISTS idx_cli_tokens_user ON cli_tokens(user_id);
