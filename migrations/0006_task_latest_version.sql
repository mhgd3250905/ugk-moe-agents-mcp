-- Tracks the currently installable version per task.
-- Points into task_versions.version; CLI installs latest by default.
ALTER TABLE tasks ADD COLUMN latest_version TEXT;

-- Version is first-class data on a submission, not derived from a path prefix.
ALTER TABLE task_submissions ADD COLUMN version TEXT;

-- JSON array of file paths in the package. Stored at upload time so manifest
-- generation reads D1 only (R2 list is a Class A op + slow); CLI fetches files
-- individually via the manifest URLs.
ALTER TABLE task_submissions ADD COLUMN file_list TEXT NOT NULL DEFAULT '[]';
