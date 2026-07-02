-- P0 C1+C2: bind OAuth state to the CLI challenge server-side so the challenge
-- no longer rides a JS-readable cookie (C2) and state<->challenge linkage is
-- enforced at callback (C1). githubLogin stores (state, challenge) here when a
-- cli_challenge query param is present; githubCallback reverse-looks-up the
-- challenge by the state it already trusts via the HttpOnly oauth_state cookie.
ALTER TABLE cli_auth_pending ADD COLUMN state TEXT;
CREATE INDEX IF NOT EXISTS idx_cli_auth_pending_state ON cli_auth_pending(state);
