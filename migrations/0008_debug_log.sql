-- DEV-ONLY structured logging for the CLI publish auth chain. The publish flow
-- touches Workers-specific runtime behavior (crypto this-binding, D1, R2) that
-- Node mock tests can't reproduce; this table lets real-device failures leave a
-- trail. Drop this migration + the debugLog() call sites in marketplace.js once
-- the flow is proven stable in production.
CREATE TABLE IF NOT EXISTS debug_log (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	ts TEXT NOT NULL,
	fn TEXT NOT NULL,
	step TEXT NOT NULL,
	detail TEXT
);

CREATE INDEX IF NOT EXISTS idx_debug_log_ts ON debug_log(ts);
