CREATE TABLE IF NOT EXISTS task_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_name TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL,
  UNIQUE(task_name, user_id)
);

CREATE INDEX IF NOT EXISTS idx_task_reports_status ON task_reports(status, created_at);
