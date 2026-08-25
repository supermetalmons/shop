CREATE TABLE anonymous_auth_sessions (
  session_id TEXT NOT NULL PRIMARY KEY CHECK (
    length(session_id) = 36
  ),
  secret_hash TEXT NOT NULL UNIQUE CHECK (
    length(secret_hash) = 64 AND
    secret_hash = lower(secret_hash) AND
    secret_hash NOT GLOB '*[^0-9a-f]*'
  ),
  auth_subject TEXT NOT NULL UNIQUE CHECK (
    length(auth_subject) = 41 AND
    auth_subject GLOB 'anon:????????-????-4???-????-????????????'
  ),
  origin_hostname TEXT NOT NULL CHECK (
    length(origin_hostname) BETWEEN 1 AND 253 AND
    origin_hostname = lower(origin_hostname)
  ),
  created_at_ms INTEGER NOT NULL CHECK (
    created_at_ms BETWEEN 0 AND 253402300799999
  ),
  refreshed_at_ms INTEGER NOT NULL CHECK (
    refreshed_at_ms BETWEEN created_at_ms AND 253402300799999
  ),
  expires_at_ms INTEGER NOT NULL CHECK (
    expires_at_ms BETWEEN refreshed_at_ms AND 253402300799999
  )
) STRICT;

CREATE INDEX anonymous_auth_sessions_expires_at_ms
ON anonymous_auth_sessions (expires_at_ms);

CREATE INDEX anonymous_auth_sessions_auth_subject
ON anonymous_auth_sessions (auth_subject);

CREATE TABLE anonymous_auth_control (
  singleton INTEGER NOT NULL PRIMARY KEY CHECK (singleton = 1),
  firebase_fallback_enabled INTEGER NOT NULL CHECK (
    firebase_fallback_enabled IN (0, 1)
  ),
  revision INTEGER NOT NULL CHECK (
    revision BETWEEN 1 AND 9007199254740991
  ),
  created_at_ms INTEGER NOT NULL CHECK (
    created_at_ms BETWEEN 0 AND 253402300799999
  ),
  updated_at_ms INTEGER NOT NULL CHECK (
    updated_at_ms BETWEEN created_at_ms AND 253402300799999
  ),
  firebase_disabled_at_ms INTEGER CHECK (
    firebase_disabled_at_ms IS NULL OR
    firebase_disabled_at_ms BETWEEN created_at_ms AND updated_at_ms
  ),
  CHECK (
    (firebase_fallback_enabled = 1 AND firebase_disabled_at_ms IS NULL) OR
    (firebase_fallback_enabled = 0 AND firebase_disabled_at_ms IS NOT NULL)
  )
) STRICT;

INSERT INTO anonymous_auth_control (
  singleton,
  firebase_fallback_enabled,
  revision,
  created_at_ms,
  updated_at_ms,
  firebase_disabled_at_ms
)
VALUES (1, 1, 1, 0, 0, NULL);

CREATE TRIGGER anonymous_auth_control_update_guard
BEFORE UPDATE ON anonymous_auth_control
WHEN
  NEW.singleton <> 1 OR
  NEW.revision <> OLD.revision + 1 OR
  NEW.updated_at_ms < OLD.updated_at_ms OR
  (OLD.firebase_fallback_enabled = 0 AND NEW.firebase_fallback_enabled <> 0) OR
  (OLD.firebase_fallback_enabled = 1 AND NEW.firebase_fallback_enabled NOT IN (0, 1))
BEGIN
  SELECT RAISE(ABORT, 'invalid anonymous-auth control update');
END;

CREATE TRIGGER anonymous_auth_control_delete_guard
BEFORE DELETE ON anonymous_auth_control
BEGIN
  SELECT RAISE(ABORT, 'anonymous-auth control is immutable');
END;

CREATE TRIGGER anonymous_auth_control_insert_guard
BEFORE INSERT ON anonymous_auth_control
BEGIN
  SELECT RAISE(ABORT, 'anonymous-auth control is immutable');
END;
