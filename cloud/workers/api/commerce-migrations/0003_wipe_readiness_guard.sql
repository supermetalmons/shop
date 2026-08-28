ALTER TABLE commerce_wipe_guards
ADD COLUMN expected_authority_revision INTEGER
  CHECK (expected_authority_revision IS NULL OR expected_authority_revision >= 1);

UPDATE commerce_authority_control
SET paused_at_ms = NULL,
  updated_at_ms = CAST(strftime('%s', 'now') AS INTEGER) * 1000
WHERE singleton = 1 AND paused_at_ms IS NOT NULL;

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

DROP TRIGGER commerce_wipe_guard_validate;

CREATE TRIGGER commerce_wipe_guard_validate
BEFORE INSERT ON commerce_wipe_guards
BEGIN
  SELECT (CASE WHEN (
    SELECT authority_state FROM commerce_authority_control WHERE singleton = 1
  ) <> 'paused' THEN RAISE(ABORT, 'commerce authority is not paused') END);

  SELECT (CASE WHEN (
    SELECT paused_at_ms FROM commerce_authority_control WHERE singleton = 1
  ) IS NULL OR (
    SELECT CAST(strftime('%s', 'now') AS INTEGER) * 1000 - paused_at_ms
    FROM commerce_authority_control WHERE singleton = 1
  ) < 66000 THEN RAISE(ABORT, 'commerce maintenance is not ready') END);

  SELECT (CASE WHEN NEW.expected_authority_revision IS NULL OR
    NEW.expected_authority_revision <> (
      SELECT revision FROM commerce_authority_control WHERE singleton = 1
    ) THEN RAISE(ABORT, 'commerce wipe conflict') END);

  SELECT (CASE WHEN NEW.expected_documents_revision <> (
    SELECT documents_revision FROM commerce_authority_control WHERE singleton = 1
  ) THEN RAISE(ABORT, 'commerce wipe conflict') END);

  SELECT (CASE WHEN EXISTS (
    SELECT 1
    FROM json_each(NEW.expectations_json) AS expectation
    LEFT JOIN commerce_documents AS document
      ON document.document_path = json_extract(expectation.value, '$.path')
    WHERE COALESCE(document.version, -1) <> CAST(json_extract(expectation.value, '$.version') AS INTEGER)
  ) THEN RAISE(ABORT, 'commerce wipe conflict') END);
END;
