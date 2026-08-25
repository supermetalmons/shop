CREATE TABLE wallet_sessions (
  firebase_uid TEXT NOT NULL PRIMARY KEY CHECK (
    length(firebase_uid) BETWEEN 1 AND 128
  ),
  wallet TEXT NOT NULL CHECK (
    length(wallet) BETWEEN 32 AND 64 AND
    wallet NOT GLOB '*[^A-Za-z0-9]*' AND
    wallet NOT GLOB '*[0OIl]*'
  ),
  expires_at_ms INTEGER NOT NULL CHECK (
    expires_at_ms BETWEEN 0 AND 253402300799999
  ),
  updated_at_ms INTEGER NOT NULL CHECK (
    updated_at_ms BETWEEN 0 AND 253402300799999
  ),
  wallet_revision INTEGER NOT NULL CHECK (
    wallet_revision BETWEEN 1 AND 9007199254740991
  ),
  reconcile_lease_id TEXT CHECK (
    reconcile_lease_id IS NULL OR length(reconcile_lease_id) = 36
  ),
  reconcile_lease_expires_at_ms INTEGER CHECK (
    reconcile_lease_expires_at_ms IS NULL OR
    reconcile_lease_expires_at_ms BETWEEN 0 AND 253402300799999
  ),
  CHECK (
    (reconcile_lease_id IS NULL AND reconcile_lease_expires_at_ms IS NULL) OR
    (reconcile_lease_id IS NOT NULL AND reconcile_lease_expires_at_ms IS NOT NULL)
  )
) STRICT;

CREATE TABLE wallet_session_storage_control (
  singleton INTEGER NOT NULL PRIMARY KEY CHECK (singleton = 1),
  storage_source TEXT NOT NULL CHECK (
    storage_source IN ('firestore', 'paused', 'd1')
  ),
  revision INTEGER NOT NULL CHECK (
    revision BETWEEN 1 AND 9007199254740991
  ),
  updated_at_ms INTEGER NOT NULL CHECK (
    updated_at_ms BETWEEN 0 AND 253402300799999
  )
) STRICT;

INSERT INTO wallet_session_storage_control (
  singleton,
  storage_source,
  revision,
  updated_at_ms
)
VALUES (1, 'firestore', 1, 0);

CREATE TRIGGER wallet_session_storage_transition_guard
BEFORE UPDATE OF storage_source ON wallet_session_storage_control
WHEN NOT (
  (OLD.storage_source = 'firestore' AND NEW.storage_source IN ('firestore', 'paused')) OR
  (OLD.storage_source = 'paused' AND NEW.storage_source IN ('firestore', 'paused', 'd1')) OR
  (OLD.storage_source = 'd1' AND NEW.storage_source = 'd1')
)
BEGIN
  SELECT RAISE(ABORT, 'invalid wallet-session storage transition');
END;

CREATE TRIGGER wallet_session_storage_update_guard
BEFORE UPDATE ON wallet_session_storage_control
WHEN
  NEW.singleton <> 1 OR
  NEW.revision <> OLD.revision + 1 OR
  NEW.updated_at_ms < OLD.updated_at_ms
BEGIN
  SELECT RAISE(ABORT, 'invalid wallet-session storage update');
END;

CREATE TRIGGER wallet_session_storage_delete_guard
BEFORE DELETE ON wallet_session_storage_control
BEGIN
  SELECT RAISE(ABORT, 'wallet-session storage control is immutable');
END;

CREATE TRIGGER wallet_session_storage_insert_guard
BEFORE INSERT ON wallet_session_storage_control
BEGIN
  SELECT RAISE(ABORT, 'wallet-session storage control is immutable');
END;
