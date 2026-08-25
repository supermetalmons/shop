UPDATE wallet_session_storage_control
SET
  storage_source = 'paused',
  revision = revision + 1,
  updated_at_ms = MAX(updated_at_ms, CAST(strftime('%s', 'now') AS INTEGER) * 1000)
WHERE singleton = 1 AND storage_source = 'firestore';

UPDATE wallet_session_storage_control
SET
  storage_source = 'd1',
  revision = revision + 1,
  updated_at_ms = MAX(updated_at_ms, CAST(strftime('%s', 'now') AS INTEGER) * 1000)
WHERE singleton = 1 AND storage_source = 'paused';

CREATE TRIGGER wallet_session_storage_d1_immutable_guard
BEFORE UPDATE ON wallet_session_storage_control
WHEN OLD.storage_source = 'd1'
BEGIN
  SELECT RAISE(ABORT, 'wallet-session storage control is immutable after D1 cutover');
END;
