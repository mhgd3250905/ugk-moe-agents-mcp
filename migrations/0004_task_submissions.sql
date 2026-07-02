CREATE TABLE IF NOT EXISTS task_submissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  source_type TEXT NOT NULL,
  source_url TEXT,
  artifact_key TEXT,
  artifact_name TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  reviewer_user_id INTEGER,
  review_note TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_task_submissions_user ON task_submissions(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_task_submissions_status ON task_submissions(status, updated_at);

CREATE TABLE IF NOT EXISTS task_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_name TEXT NOT NULL,
  version TEXT NOT NULL,
  submission_id INTEGER,
  artifact_key TEXT,
  source_url TEXT,
  published_by_user_id INTEGER,
  created_at TEXT NOT NULL,
  UNIQUE(task_name, version)
);
