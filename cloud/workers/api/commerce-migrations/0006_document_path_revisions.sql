CREATE TABLE commerce_document_path_revision_migration_guard (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1)
) STRICT;

CREATE TRIGGER commerce_document_path_revision_migration_guard_validate
BEFORE INSERT ON commerce_document_path_revision_migration_guard
BEGIN
  SELECT (CASE WHEN (
    SELECT COUNT(*) FROM commerce_authority_control WHERE singleton = 1
  ) <> 1 THEN RAISE(ABORT, 'commerce authority control is invalid') END);

  SELECT (CASE WHEN NOT EXISTS (
    SELECT 1 FROM commerce_authority_control
    WHERE singleton = 1 AND (
      (authority_state = 'paused' AND paused_at_ms IS NOT NULL) OR
      (
        authority_state = 'd1' AND
        revision = 1 AND
        documents_revision = 0 AND
        paused_at_ms IS NULL AND
        updated_at_ms = 0 AND
        NOT EXISTS (SELECT 1 FROM commerce_documents)
      )
    )
  )
  THEN RAISE(ABORT, 'commerce must be paused and drained before document-path migration') END);

  SELECT (CASE WHEN
    EXISTS (SELECT 1 FROM commerce_authority_control_lease) OR
    EXISTS (SELECT 1 FROM commerce_wipe_guards)
  THEN RAISE(ABORT, 'commerce maintenance is already in progress') END);
END;

INSERT INTO commerce_document_path_revision_migration_guard (singleton) VALUES (1);

INSERT INTO commerce_authority_control_lease (
  singleton,
  lease_token,
  acquired_at_ms,
  expires_at_ms
)
SELECT
  1,
  '00000000-0000-4000-8000-000000000006',
  CAST(strftime('%s', 'now') AS INTEGER) * 1000,
  CAST(strftime('%s', 'now') AS INTEGER) * 1000 + 60000
FROM commerce_authority_control
WHERE
  singleton = 1 AND
  authority_state = 'd1' AND
  revision = 1 AND
  documents_revision = 0 AND
  paused_at_ms IS NULL AND
  updated_at_ms = 0 AND
  NOT EXISTS (SELECT 1 FROM commerce_documents);

UPDATE commerce_authority_control
SET
  authority_state = 'paused',
  revision = revision + 1,
  paused_at_ms = NULL,
  updated_at_ms = CAST(strftime('%s', 'now') AS INTEGER) * 1000
WHERE
  singleton = 1 AND
  authority_state = 'd1' AND
  revision = 1 AND
  documents_revision = 0 AND
  paused_at_ms IS NULL AND
  updated_at_ms = 0 AND
  EXISTS (
    SELECT 1 FROM commerce_authority_control_lease
    WHERE singleton = 1 AND lease_token = '00000000-0000-4000-8000-000000000006'
  );

DELETE FROM commerce_authority_control_lease
WHERE singleton = 1 AND lease_token = '00000000-0000-4000-8000-000000000006';

DROP TRIGGER commerce_authority_update_guard;

CREATE TRIGGER commerce_authority_update_guard
BEFORE UPDATE ON commerce_authority_control
WHEN
  NEW.authority_state <> OLD.authority_state OR
  NEW.paused_at_ms IS NOT OLD.paused_at_ms OR
  (NEW.paused_at_ms IS NOT NULL AND NEW.revision <> OLD.revision)
BEGIN
  SELECT (CASE WHEN NOT EXISTS (
    SELECT 1
    FROM commerce_authority_control_lease
    WHERE singleton = 1
      AND expires_at_ms > CAST(strftime('%s', 'now') AS INTEGER) * 1000
  ) THEN RAISE(ABORT, 'commerce authority coordination lease is required') END);

  SELECT (CASE WHEN
    NEW.updated_at_ms <> CAST(strftime('%s', 'now') AS INTEGER) * 1000 OR
    NOT (
      (
        OLD.authority_state = 'd1' AND
        NEW.authority_state = 'paused' AND
        NEW.paused_at_ms IS NULL AND
        NEW.documents_revision = OLD.documents_revision
      ) OR
      (
        OLD.authority_state = 'paused' AND
        OLD.paused_at_ms IS NOT NULL AND
        NEW.authority_state = 'd1' AND
        NEW.paused_at_ms IS NULL AND
        NEW.documents_revision = OLD.documents_revision AND
        NOT EXISTS (SELECT 1 FROM commerce_wipe_guards)
      ) OR
      (
        OLD.authority_state = 'paused' AND
        NEW.authority_state = 'paused' AND
        NEW.revision = OLD.revision AND
        NEW.documents_revision = OLD.documents_revision AND
        OLD.paused_at_ms IS NULL AND
        NEW.paused_at_ms = CAST(strftime('%s', 'now') AS INTEGER) * 1000
      ) OR
      (
        OLD.authority_state = 'paused' AND
        NEW.authority_state = 'paused' AND
        NEW.revision = OLD.revision AND
        NEW.documents_revision = OLD.documents_revision AND
        OLD.paused_at_ms IS NOT NULL AND
        NEW.paused_at_ms IS NULL
      )
    )
  THEN RAISE(ABORT, 'invalid commerce authority readiness mutation') END);
END;

DROP TRIGGER commerce_document_path_revision_migration_guard_validate;
DROP TABLE commerce_document_path_revision_migration_guard;

CREATE TABLE commerce_document_path_revisions (
  document_path TEXT PRIMARY KEY,
  revision INTEGER NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740991)
) STRICT;

INSERT INTO commerce_document_path_revisions (document_path, revision)
SELECT document.document_path, authority.documents_revision
FROM commerce_documents AS document
CROSS JOIN commerce_authority_control AS authority
WHERE authority.singleton = 1;

CREATE TRIGGER commerce_document_path_revision_insert_guard
BEFORE INSERT ON commerce_document_path_revisions
WHEN EXISTS (
  SELECT 1 FROM commerce_document_path_revisions
  WHERE document_path = NEW.document_path AND revision > NEW.revision
)
BEGIN
  SELECT RAISE(ABORT, 'commerce document-path revisions cannot move backward');
END;

CREATE TRIGGER commerce_document_path_revision_delete_guard
BEFORE DELETE ON commerce_document_path_revisions
BEGIN
  SELECT RAISE(ABORT, 'commerce document-path revision tombstones cannot be deleted');
END;

CREATE TRIGGER commerce_document_path_revision_update_guard
BEFORE UPDATE ON commerce_document_path_revisions
WHEN NEW.document_path IS NOT OLD.document_path OR NEW.revision <= OLD.revision
BEGIN
  SELECT RAISE(ABORT, 'commerce document-path revisions must increase in place');
END;

CREATE TRIGGER commerce_document_path_revision_insert
AFTER INSERT ON commerce_documents
BEGIN
  INSERT INTO commerce_document_path_revisions (document_path, revision)
  VALUES (
    NEW.document_path,
    (SELECT documents_revision + 1 FROM commerce_authority_control WHERE singleton = 1)
  )
  ON CONFLICT(document_path) DO UPDATE SET revision = excluded.revision
  WHERE commerce_document_path_revisions.revision < excluded.revision;
END;

CREATE TRIGGER commerce_document_path_revision_delete
AFTER DELETE ON commerce_documents
BEGIN
  INSERT INTO commerce_document_path_revisions (document_path, revision)
  VALUES (
    OLD.document_path,
    (SELECT documents_revision + 1 FROM commerce_authority_control WHERE singleton = 1)
  )
  ON CONFLICT(document_path) DO UPDATE SET revision = excluded.revision
  WHERE commerce_document_path_revisions.revision < excluded.revision;
END;

CREATE TRIGGER commerce_document_path_revision_update
AFTER UPDATE ON commerce_documents
BEGIN
  INSERT INTO commerce_document_path_revisions (document_path, revision)
  VALUES (
    NEW.document_path,
    (SELECT documents_revision + 1 FROM commerce_authority_control WHERE singleton = 1)
  )
  ON CONFLICT(document_path) DO UPDATE SET revision = excluded.revision
  WHERE commerce_document_path_revisions.revision < excluded.revision;
END;

CREATE TRIGGER commerce_document_path_revision_path_departure
AFTER UPDATE OF document_path ON commerce_documents
WHEN OLD.document_path IS NOT NEW.document_path
BEGIN
  INSERT INTO commerce_document_path_revisions (document_path, revision)
  VALUES (
    OLD.document_path,
    (SELECT documents_revision + 1 FROM commerce_authority_control WHERE singleton = 1)
  )
  ON CONFLICT(document_path) DO UPDATE SET revision = excluded.revision
  WHERE commerce_document_path_revisions.revision < excluded.revision;
END;

DROP TRIGGER commerce_commit_guard_validate;

CREATE TRIGGER commerce_commit_guard_validate
BEFORE INSERT ON commerce_commit_guards
BEGIN
  SELECT (CASE WHEN (
    SELECT authority_state FROM commerce_authority_control WHERE singleton = 1
  ) <> 'd1' THEN RAISE(ABORT, 'commerce authority is not d1') END);

  SELECT (CASE WHEN NEW.expected_documents_revision IS NOT NULL AND NEW.expected_documents_revision <> (
    SELECT documents_revision FROM commerce_authority_control WHERE singleton = 1
  ) THEN RAISE(ABORT, 'commerce transaction conflict') END);

  SELECT (CASE WHEN
    EXISTS (
      SELECT 1
      FROM json_each(NEW.delivery_owner_expectations_json) AS expectation
      LEFT JOIN commerce_delivery_owner_revisions AS owner_revision
        ON owner_revision.owner = json_extract(expectation.value, '$.owner')
      WHERE
        json_type(expectation.value) IS NOT 'object' OR
        (SELECT COUNT(*) FROM json_each(expectation.value)) <> 2 OR
        json_type(expectation.value, '$.owner') IS NOT 'text' OR
        length(json_extract(expectation.value, '$.owner')) < 1 OR
        json_type(expectation.value, '$.revision') IS NOT 'integer' OR
        CAST(json_extract(expectation.value, '$.revision') AS INTEGER)
          NOT BETWEEN 0 AND 9007199254740991 OR
        COALESCE(owner_revision.revision, 0) <>
          CAST(json_extract(expectation.value, '$.revision') AS INTEGER)
    ) OR
    (
      SELECT COUNT(*)
      FROM json_each(NEW.delivery_owner_expectations_json)
    ) <> (
      SELECT COUNT(DISTINCT json_extract(expectation.value, '$.owner'))
      FROM json_each(NEW.delivery_owner_expectations_json) AS expectation
    )
  THEN RAISE(ABORT, 'commerce transaction conflict') END);

  SELECT (CASE WHEN EXISTS (
    SELECT 1
    FROM json_each(NEW.expectations_json) AS expectation
    LEFT JOIN commerce_documents AS document
      ON document.document_path = json_extract(expectation.value, '$.path')
    LEFT JOIN commerce_document_path_revisions AS path_revision
      ON path_revision.document_path = json_extract(expectation.value, '$.path')
    WHERE
      COALESCE(document.version, -1) <>
        CAST(json_extract(expectation.value, '$.version') AS INTEGER) OR
      (
        json_type(expectation.value, '$.pathRevision') IS NULL AND
        CAST(json_extract(expectation.value, '$.version') AS INTEGER) = -1 AND
        path_revision.revision IS NOT NULL
      ) OR
      (
        json_type(expectation.value, '$.pathRevision') IS NOT NULL AND
        (
          json_type(expectation.value, '$.pathRevision') IS NOT 'integer' OR
          CAST(json_extract(expectation.value, '$.pathRevision') AS INTEGER)
            NOT BETWEEN 0 AND 9007199254740991 OR
          COALESCE(path_revision.revision, 0) <>
            CAST(json_extract(expectation.value, '$.pathRevision') AS INTEGER)
        )
      )
  ) THEN RAISE(ABORT, 'commerce transaction conflict') END);
END;

PRAGMA optimize;
