CREATE TRIGGER reveal_submission_insert_pause_guard
BEFORE INSERT ON reveal_submissions
WHEN EXISTS (
  SELECT 1
  FROM reveal_submission_storage_control
  WHERE singleton = 1 AND paused = 1
)
BEGIN
  SELECT RAISE(ABORT, 'reveal submissions are paused');
END;

CREATE TRIGGER reveal_submission_update_pause_guard
BEFORE UPDATE ON reveal_submissions
WHEN EXISTS (
  SELECT 1
  FROM reveal_submission_storage_control
  WHERE singleton = 1 AND paused = 1
)
BEGIN
  SELECT RAISE(ABORT, 'reveal submissions are paused');
END;
