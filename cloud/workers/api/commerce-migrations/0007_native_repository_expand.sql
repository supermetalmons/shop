ALTER TABLE commerce_documents
  ADD COLUMN processed_at_seconds INTEGER
  CHECK (processed_at_seconds IS NULL OR processed_at_seconds >= 0);

ALTER TABLE commerce_documents
  ADD COLUMN processed_at_nanos INTEGER
  CHECK (processed_at_nanos IS NULL OR processed_at_nanos BETWEEN 0 AND 999999999);

UPDATE commerce_documents
SET
  processed_at_seconds = CASE
    WHEN json_type(fields_json, '$.processedAt.timestampValue') = 'text'
      THEN CAST(strftime('%s', substr(json_extract(fields_json, '$.processedAt.timestampValue'), 1, 19) || 'Z') AS INTEGER)
    ELSE NULL
  END,
  processed_at_nanos = CASE
    WHEN json_type(fields_json, '$.processedAt.timestampValue') <> 'text' THEN NULL
    WHEN substr(json_extract(fields_json, '$.processedAt.timestampValue'), 20, 1) <> '.' THEN 0
    ELSE CAST(substr(
      substr(
        json_extract(fields_json, '$.processedAt.timestampValue'),
        21,
        instr(json_extract(fields_json, '$.processedAt.timestampValue'), 'Z') - 21
      ) || '000000000',
      1,
      9
    ) AS INTEGER)
  END;

CREATE INDEX commerce_documents_drop_processed_cursor
  ON commerce_documents (
    document_kind,
    drop_id,
    status,
    processed_at_seconds DESC,
    processed_at_nanos DESC,
    document_path DESC
  );

CREATE INDEX commerce_documents_owner_processed_cursor
  ON commerce_documents (
    document_kind,
    owner,
    status,
    processed_at_seconds DESC,
    processed_at_nanos DESC,
    document_path DESC
  );

CREATE TABLE commerce_native_precondition_guards (
  guard_id TEXT PRIMARY KEY,
  create_paths_json TEXT NOT NULL CHECK (json_valid(create_paths_json)),
  existing_paths_json TEXT NOT NULL CHECK (json_valid(existing_paths_json)),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0)
) STRICT;

CREATE TRIGGER commerce_native_precondition_guard_validate
BEFORE INSERT ON commerce_native_precondition_guards
BEGIN
  SELECT CASE WHEN (
    SELECT authority_state FROM commerce_authority_control WHERE singleton = 1
  ) <> 'd1' THEN RAISE(ABORT, 'commerce authority is not d1') END;

  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM json_each(NEW.create_paths_json) AS expected
    JOIN commerce_documents AS document ON document.document_path = expected.value
  ) THEN RAISE(ABORT, 'commerce document already exists') END;

  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM json_each(NEW.existing_paths_json) AS expected
    LEFT JOIN commerce_documents AS document ON document.document_path = expected.value
    WHERE document.document_path IS NULL
  ) THEN RAISE(ABORT, 'commerce document failed precondition') END;
END;
