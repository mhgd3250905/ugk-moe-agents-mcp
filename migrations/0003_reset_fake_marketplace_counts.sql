-- Remove earlier seeded display counters. Counts must reflect real events only.

DELETE FROM download_events;
DELETE FROM task_likes;
DELETE FROM task_favorites;

UPDATE tasks
SET download_count = 0,
	like_count = 0,
	favorite_count = 0;
