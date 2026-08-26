ALTER TABLE wallet_sessions RENAME TO wallet_sessions_legacy;

CREATE TABLE wallet_sessions (
  firebase_uid TEXT UNIQUE CHECK (
    firebase_uid IS NULL OR length(firebase_uid) BETWEEN 1 AND 128
  ),
  auth_subject TEXT UNIQUE CHECK (
    auth_subject IS NULL OR length(auth_subject) BETWEEN 1 AND 128
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
  CHECK (firebase_uid IS NOT NULL OR auth_subject IS NOT NULL),
  CHECK (
    firebase_uid IS NULL OR
    auth_subject IS NULL OR
    firebase_uid = auth_subject
  ),
  CHECK (
    (reconcile_lease_id IS NULL AND reconcile_lease_expires_at_ms IS NULL) OR
    (reconcile_lease_id IS NOT NULL AND reconcile_lease_expires_at_ms IS NOT NULL)
  )
) STRICT;

INSERT INTO wallet_sessions (
  firebase_uid,
  auth_subject,
  wallet,
  expires_at_ms,
  updated_at_ms,
  wallet_revision,
  reconcile_lease_id,
  reconcile_lease_expires_at_ms
)
SELECT
  firebase_uid,
  firebase_uid,
  wallet,
  expires_at_ms,
  updated_at_ms,
  wallet_revision,
  reconcile_lease_id,
  reconcile_lease_expires_at_ms
FROM wallet_sessions_legacy;

DROP TABLE wallet_sessions_legacy;

CREATE TRIGGER wallet_sessions_sync_auth_subject_insert
AFTER INSERT ON wallet_sessions
WHEN NEW.auth_subject IS NULL
BEGIN
  UPDATE wallet_sessions
  SET auth_subject = NEW.firebase_uid
  WHERE rowid = NEW.rowid;
END;

CREATE TRIGGER wallet_sessions_sync_firebase_uid_insert
AFTER INSERT ON wallet_sessions
WHEN NEW.firebase_uid IS NULL
BEGIN
  UPDATE wallet_sessions
  SET firebase_uid = NEW.auth_subject
  WHERE rowid = NEW.rowid;
END;

CREATE TRIGGER wallet_sessions_sync_auth_subject_update
AFTER UPDATE OF auth_subject ON wallet_sessions
WHEN NEW.auth_subject IS NULL
BEGIN
  UPDATE wallet_sessions
  SET auth_subject = NEW.firebase_uid
  WHERE rowid = NEW.rowid;
END;

CREATE TRIGGER wallet_sessions_sync_firebase_uid_update
AFTER UPDATE OF firebase_uid ON wallet_sessions
WHEN NEW.firebase_uid IS NULL
BEGIN
  UPDATE wallet_sessions
  SET firebase_uid = NEW.auth_subject
  WHERE rowid = NEW.rowid;
END;
