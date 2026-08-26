CREATE TABLE ops_0016_migration_guard (
  valid INTEGER NOT NULL CHECK (valid = 1)
) STRICT;

INSERT INTO ops_0016_migration_guard (valid)
SELECT COUNT(*)
FROM reveal_submission_storage_control
WHERE singleton = 1 AND storage_source = 'd1' AND cutover_at_ms IS NOT NULL;

INSERT INTO ops_0016_migration_guard (valid)
SELECT COUNT(*)
FROM anonymous_auth_control
WHERE singleton = 1 AND firebase_fallback_enabled = 0 AND firebase_disabled_at_ms IS NOT NULL;

DROP TABLE profile_storage_control;
DROP TABLE wallet_session_storage_control;

ALTER TABLE reveal_submission_storage_control
RENAME TO reveal_submission_storage_control_legacy;

CREATE TABLE reveal_submission_storage_control (
  singleton INTEGER NOT NULL PRIMARY KEY CHECK (singleton = 1),
  paused INTEGER NOT NULL CHECK (paused IN (0, 1)),
  revision INTEGER NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740991),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms BETWEEN 0 AND 9007199254740991),
  updated_at_ms INTEGER NOT NULL CHECK (
    updated_at_ms BETWEEN created_at_ms AND 9007199254740991
  ),
  cutover_at_ms INTEGER NOT NULL CHECK (
    cutover_at_ms BETWEEN created_at_ms AND updated_at_ms
  )
) STRICT;

INSERT INTO reveal_submission_storage_control (
  singleton,
  paused,
  revision,
  created_at_ms,
  updated_at_ms,
  cutover_at_ms
)
SELECT
  singleton,
  paused,
  revision,
  created_at_ms,
  updated_at_ms,
  cutover_at_ms
FROM reveal_submission_storage_control_legacy
WHERE storage_source = 'd1';

DROP TABLE reveal_submission_storage_control_legacy;

CREATE TRIGGER reveal_submission_control_update_guard
BEFORE UPDATE ON reveal_submission_storage_control
WHEN
  NEW.singleton <> 1 OR
  NEW.revision <> OLD.revision + 1 OR
  NEW.created_at_ms <> OLD.created_at_ms OR
  NEW.updated_at_ms < OLD.updated_at_ms OR
  NEW.cutover_at_ms <> OLD.cutover_at_ms
BEGIN
  SELECT RAISE(ABORT, 'invalid reveal-submission control update');
END;

CREATE TRIGGER reveal_submission_control_delete_guard
BEFORE DELETE ON reveal_submission_storage_control
BEGIN
  SELECT RAISE(ABORT, 'reveal-submission control is immutable');
END;

CREATE TRIGGER reveal_submission_control_insert_guard
BEFORE INSERT ON reveal_submission_storage_control
BEGIN
  SELECT RAISE(ABORT, 'reveal-submission control is immutable');
END;

ALTER TABLE anonymous_auth_control
RENAME TO anonymous_auth_control_legacy;

CREATE TABLE auth_provider_retirement (
  singleton INTEGER NOT NULL PRIMARY KEY CHECK (singleton = 1),
  revision INTEGER NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740991),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms BETWEEN 0 AND 9007199254740991),
  updated_at_ms INTEGER NOT NULL CHECK (
    updated_at_ms BETWEEN created_at_ms AND 9007199254740991
  ),
  legacy_provider_disabled_at_ms INTEGER NOT NULL CHECK (
    legacy_provider_disabled_at_ms BETWEEN created_at_ms AND updated_at_ms
  )
) STRICT;

INSERT INTO auth_provider_retirement (
  singleton,
  revision,
  created_at_ms,
  updated_at_ms,
  legacy_provider_disabled_at_ms
)
SELECT
  singleton,
  revision,
  created_at_ms,
  updated_at_ms,
  firebase_disabled_at_ms
FROM anonymous_auth_control_legacy
WHERE firebase_fallback_enabled = 0 AND firebase_disabled_at_ms IS NOT NULL;

DROP TABLE anonymous_auth_control_legacy;

CREATE TRIGGER auth_provider_retirement_update_guard
BEFORE UPDATE ON auth_provider_retirement
BEGIN
  SELECT RAISE(ABORT, 'auth-provider retirement is immutable');
END;

CREATE TRIGGER auth_provider_retirement_delete_guard
BEFORE DELETE ON auth_provider_retirement
BEGIN
  SELECT RAISE(ABORT, 'auth-provider retirement is immutable');
END;

CREATE TRIGGER auth_provider_retirement_insert_guard
BEFORE INSERT ON auth_provider_retirement
BEGIN
  SELECT RAISE(ABORT, 'auth-provider retirement is immutable');
END;

DROP TABLE ops_0016_migration_guard;
