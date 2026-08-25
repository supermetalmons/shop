UPDATE profile_storage_control
SET
  read_source = 'd1',
  updated_at_ms = MAX(
    updated_at_ms,
    CAST(strftime('%s', 'now') AS INTEGER) * 1000
  )
WHERE singleton = 1;

DROP TRIGGER profile_storage_d1_irreversible;

CREATE TRIGGER profile_storage_source_immutable
BEFORE UPDATE OF read_source ON profile_storage_control
WHEN NEW.read_source <> 'd1'
BEGIN
  SELECT RAISE(ABORT, 'profile storage is permanently d1');
END;

CREATE TRIGGER profile_storage_delete_guard
BEFORE DELETE ON profile_storage_control
BEGIN
  SELECT RAISE(ABORT, 'profile storage control is immutable');
END;

CREATE TRIGGER profile_storage_insert_guard
BEFORE INSERT ON profile_storage_control
BEGIN
  SELECT RAISE(ABORT, 'profile storage control is immutable');
END;
