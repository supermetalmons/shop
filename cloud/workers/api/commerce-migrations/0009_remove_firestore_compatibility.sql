SELECT CASE WHEN
  (SELECT authority_state FROM commerce_authority_control WHERE singleton = 1) <> 'paused' AND NOT (
    (SELECT authority_state FROM commerce_authority_control WHERE singleton = 1) = 'firestore' AND
    NOT EXISTS (SELECT 1 FROM commerce_documents)
  )
THEN json('commerce must be paused for contract migration') ELSE NULL END;

DROP TRIGGER commerce_authority_transition_guard;
DROP TRIGGER commerce_authority_delete_guard;
DROP TRIGGER commerce_authority_d1_manifest_guard;
DROP TRIGGER commerce_authority_revision_guard;
DROP TRIGGER commerce_commit_guard_validate;
DROP TRIGGER commerce_wipe_guard_validate;
DROP TRIGGER commerce_documents_insert_authority_guard;
DROP TRIGGER commerce_documents_update_authority_guard;
DROP TRIGGER commerce_documents_delete_authority_guard;

ALTER TABLE commerce_documents DROP COLUMN fields_json;

DROP TABLE commerce_transaction_reads;
DROP TABLE commerce_transactions;

CREATE TABLE commerce_authority_control_next (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  authority_state TEXT NOT NULL CHECK (authority_state IN ('paused', 'd1')),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  documents_revision INTEGER NOT NULL CHECK (documents_revision >= 0),
  paused_at_ms INTEGER CHECK (paused_at_ms IS NULL OR paused_at_ms >= 0),
  cutover_at_ms INTEGER CHECK (cutover_at_ms IS NULL OR cutover_at_ms >= 0),
  import_manifest_sha256 TEXT CHECK (import_manifest_sha256 IS NULL OR length(import_manifest_sha256) = 64),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0)
) STRICT;

INSERT INTO commerce_authority_control_next (
  singleton,
  authority_state,
  revision,
  documents_revision,
  paused_at_ms,
  cutover_at_ms,
  import_manifest_sha256,
  updated_at_ms
)
SELECT
  singleton,
  CASE authority_state WHEN 'firestore' THEN 'paused' ELSE authority_state END,
  revision,
  documents_revision,
  paused_at_ms,
  cutover_at_ms,
  import_manifest_sha256,
  updated_at_ms
FROM commerce_authority_control;

DROP TABLE commerce_authority_control;
ALTER TABLE commerce_authority_control_next RENAME TO commerce_authority_control;

CREATE TRIGGER commerce_authority_transition_guard
BEFORE UPDATE OF authority_state ON commerce_authority_control
WHEN NOT (
  NEW.authority_state = OLD.authority_state OR
  (OLD.authority_state = 'd1' AND NEW.authority_state = 'paused') OR
  (OLD.authority_state = 'paused' AND NEW.authority_state = 'd1')
)
BEGIN
  SELECT RAISE(ABORT, 'invalid commerce authority transition');
END;

CREATE TRIGGER commerce_authority_delete_guard
BEFORE DELETE ON commerce_authority_control
BEGIN
  SELECT RAISE(ABORT, 'commerce authority control cannot be deleted');
END;

CREATE TRIGGER commerce_authority_d1_manifest_guard
BEFORE UPDATE OF authority_state ON commerce_authority_control
WHEN NEW.authority_state = 'd1' AND OLD.authority_state <> 'd1'
BEGIN
  SELECT CASE WHEN NEW.revision <> OLD.revision + 1
    THEN RAISE(ABORT, 'commerce authority revision conflict') END;
  SELECT CASE WHEN NEW.import_manifest_sha256 IS NULL OR NOT EXISTS (
    SELECT 1
    FROM commerce_import_manifests
    WHERE manifest_sha256 = NEW.import_manifest_sha256
  ) THEN RAISE(ABORT, 'commerce import is not verified') END;
END;

CREATE TRIGGER commerce_authority_revision_guard
BEFORE UPDATE OF authority_state ON commerce_authority_control
WHEN NEW.authority_state <> OLD.authority_state AND NEW.revision <> OLD.revision + 1
BEGIN
  SELECT RAISE(ABORT, 'commerce authority revision conflict');
END;

CREATE TRIGGER commerce_commit_guard_validate
BEFORE INSERT ON commerce_commit_guards
BEGIN
  SELECT CASE WHEN (
    SELECT authority_state FROM commerce_authority_control WHERE singleton = 1
  ) <> 'd1' THEN RAISE(ABORT, 'commerce authority is not d1') END;

  SELECT CASE WHEN NEW.expected_documents_revision IS NOT NULL AND NEW.expected_documents_revision <> (
    SELECT documents_revision FROM commerce_authority_control WHERE singleton = 1
  ) THEN RAISE(ABORT, 'commerce transaction conflict') END;

  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM json_each(NEW.expectations_json) AS expectation
    LEFT JOIN commerce_documents AS document
      ON document.document_path = json_extract(expectation.value, '$.path')
    WHERE COALESCE(document.version, -1) <> CAST(json_extract(expectation.value, '$.version') AS INTEGER)
  ) THEN RAISE(ABORT, 'commerce transaction conflict') END;
END;

CREATE TRIGGER commerce_wipe_guard_validate
BEFORE INSERT ON commerce_wipe_guards
BEGIN
  SELECT CASE WHEN (
    SELECT authority_state FROM commerce_authority_control WHERE singleton = 1
  ) <> 'paused' THEN RAISE(ABORT, 'commerce authority is not paused') END;

  SELECT CASE WHEN NEW.expected_documents_revision <> (
    SELECT documents_revision FROM commerce_authority_control WHERE singleton = 1
  ) THEN RAISE(ABORT, 'commerce wipe conflict') END;

  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM json_each(NEW.expectations_json) AS expectation
    LEFT JOIN commerce_documents AS document
      ON document.document_path = json_extract(expectation.value, '$.path')
    WHERE COALESCE(document.version, -1) <> CAST(json_extract(expectation.value, '$.version') AS INTEGER)
  ) THEN RAISE(ABORT, 'commerce wipe conflict') END;
END;

CREATE TRIGGER commerce_documents_insert_authority_guard
BEFORE INSERT ON commerce_documents
WHEN (SELECT authority_state FROM commerce_authority_control WHERE singleton = 1) <> 'd1'
BEGIN
  SELECT RAISE(ABORT, 'commerce authority is not d1');
END;

CREATE TRIGGER commerce_documents_update_authority_guard
BEFORE UPDATE ON commerce_documents
WHEN (SELECT authority_state FROM commerce_authority_control WHERE singleton = 1) <> 'd1'
BEGIN
  SELECT RAISE(ABORT, 'commerce authority is not d1');
END;

CREATE TRIGGER commerce_documents_delete_authority_guard
BEFORE DELETE ON commerce_documents
WHEN (SELECT authority_state FROM commerce_authority_control WHERE singleton = 1) NOT IN ('paused', 'd1')
BEGIN
  SELECT RAISE(ABORT, 'commerce authority is invalid');
END;
