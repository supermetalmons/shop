DROP TRIGGER commerce_authority_transition_guard;

CREATE TRIGGER commerce_authority_transition_guard
BEFORE UPDATE OF authority_state ON commerce_authority_control
WHEN NOT (
  NEW.authority_state = OLD.authority_state OR
  (OLD.authority_state = 'firestore' AND NEW.authority_state = 'paused') OR
  (OLD.authority_state = 'd1' AND NEW.authority_state = 'paused') OR
  (OLD.authority_state = 'paused' AND NEW.authority_state = 'd1') OR
  (
    OLD.authority_state = 'paused' AND
    NEW.authority_state = 'firestore' AND
    OLD.import_manifest_sha256 IS NULL
  )
)
BEGIN
  SELECT RAISE(ABORT, 'invalid commerce authority transition');
END;

CREATE TABLE commerce_wipe_guards (
  guard_id TEXT PRIMARY KEY,
  expectations_json TEXT NOT NULL CHECK (json_valid(expectations_json)),
  expected_documents_revision INTEGER NOT NULL CHECK (expected_documents_revision >= 0),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0)
) STRICT;

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
