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
