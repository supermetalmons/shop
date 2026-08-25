UPDATE reveal_submission_storage_control
SET
  storage_source = 'd1',
  revision = revision + 1,
  updated_at_ms = MAX(updated_at_ms, CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  cutover_at_ms = MAX(updated_at_ms, CAST(strftime('%s', 'now') AS INTEGER) * 1000)
WHERE singleton = 1 AND storage_source = 'firestore' AND paused = 1;

UPDATE reveal_submission_storage_control
SET
  paused = 0,
  revision = revision + 1,
  updated_at_ms = MAX(updated_at_ms, CAST(strftime('%s', 'now') AS INTEGER) * 1000)
WHERE
  singleton = 1 AND
  storage_source = 'd1' AND
  paused = 1 AND
  cutover_at_ms = updated_at_ms;

CREATE TRIGGER reveal_submission_storage_d1_immutable_guard
BEFORE UPDATE OF storage_source ON reveal_submission_storage_control
WHEN OLD.storage_source <> 'd1' OR NEW.storage_source <> 'd1'
BEGIN
  SELECT RAISE(ABORT, 'reveal-submission storage source is permanently d1');
END;
