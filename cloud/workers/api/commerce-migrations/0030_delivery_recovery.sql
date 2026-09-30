CREATE TABLE commerce_delivery_recovery_control (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  storage_mode TEXT NOT NULL DEFAULT 'legacy' CHECK (storage_mode IN ('legacy', 'table')),
  preparation_state TEXT NOT NULL DEFAULT 'idle' CHECK (preparation_state IN ('idle', 'preparing', 'ready')),
  source_documents_revision INTEGER CHECK (source_documents_revision IS NULL OR source_documents_revision BETWEEN 0 AND 9007199254740991),
  prepared_at_ms INTEGER CHECK (prepared_at_ms IS NULL OR prepared_at_ms BETWEEN 0 AND 9007199254740991),
  CHECK (storage_mode <> 'table' OR preparation_state = 'ready'),
  CHECK (preparation_state <> 'ready' OR (source_documents_revision IS NOT NULL AND prepared_at_ms IS NOT NULL))
) STRICT;

INSERT INTO commerce_delivery_recovery_control (singleton) VALUES (1);

CREATE TABLE commerce_delivery_recovery (
  parent_path TEXT PRIMARY KEY REFERENCES commerce_documents(document_path) ON DELETE CASCADE,
  generation TEXT NOT NULL CHECK (length(generation) = 36),
  revision INTEGER NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740991),
  lease_id TEXT CHECK (lease_id IS NULL OR length(lease_id) = 36),
  receipt_recovery_json TEXT CHECK (receipt_recovery_json IS NULL OR json_valid(receipt_recovery_json)),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms BETWEEN 0 AND 9007199254740991),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms BETWEEN created_at_ms AND 9007199254740991),
  prepared_delay_ms INTEGER CHECK (prepared_delay_ms IS NULL OR prepared_delay_ms IN (30000, 120000, 600000)),
  prepared_explicit_at_ms REAL CHECK (prepared_explicit_at_ms IS NULL OR (prepared_explicit_at_ms > 0 AND prepared_explicit_at_ms <= 1.7976931348623157e308)),
  processing_retry_at_ms REAL CHECK (processing_retry_at_ms IS NULL OR (processing_retry_at_ms >= 30000 AND processing_retry_at_ms <= 1.7976931348623157e308)),
  lease_expires_at_ms REAL CHECK (lease_expires_at_ms IS NULL OR lease_expires_at_ms BETWEEN -1.7976931348623157e308 AND 1.7976931348623157e308)
) STRICT;

ALTER TABLE commerce_commit_guards
ADD COLUMN delivery_recovery_expectations_json TEXT NOT NULL DEFAULT '[]'
  CHECK (json_valid(delivery_recovery_expectations_json) AND json_type(delivery_recovery_expectations_json) = 'array');

ALTER TABLE commerce_commit_guards
ADD COLUMN delivery_recovery_paths_json TEXT NOT NULL DEFAULT '[]'
  CHECK (json_valid(delivery_recovery_paths_json) AND json_type(delivery_recovery_paths_json) = 'array');

ALTER TABLE commerce_wipe_guards
ADD COLUMN delivery_recovery_expectations_json TEXT NOT NULL DEFAULT '[]'
  CHECK (json_valid(delivery_recovery_expectations_json) AND json_type(delivery_recovery_expectations_json) = 'array');

CREATE TRIGGER commerce_delivery_recovery_control_insert_guard
BEFORE INSERT ON commerce_delivery_recovery_control
BEGIN
  SELECT RAISE(ABORT, 'delivery recovery control cannot be inserted');
END;

CREATE TRIGGER commerce_delivery_recovery_control_delete_guard
BEFORE DELETE ON commerce_delivery_recovery_control
BEGIN
  SELECT RAISE(ABORT, 'delivery recovery control cannot be deleted');
END;

CREATE TRIGGER commerce_delivery_recovery_control_update_guard
BEFORE UPDATE ON commerce_delivery_recovery_control
BEGIN
  SELECT (CASE WHEN NOT EXISTS (SELECT 1 FROM commerce_authority_control AS authority
    JOIN commerce_authority_control_lease AS lease ON lease.singleton = authority.singleton
    WHERE authority.singleton = 1 AND authority.authority_state = 'paused' AND authority.paused_at_ms IS NOT NULL
      AND lease.expires_at_ms > CAST(strftime('%s', 'now') AS INTEGER) * 1000)
    THEN RAISE(ABORT, 'delivery recovery maintenance is not ready') END);
  SELECT (CASE WHEN NEW.singleton <> OLD.singleton OR OLD.storage_mode = 'table'
    THEN RAISE(ABORT, 'delivery recovery activation is irreversible') END);
  SELECT (CASE WHEN NEW.source_documents_revision IS NOT (SELECT documents_revision FROM commerce_authority_control WHERE singleton = 1)
    THEN RAISE(ABORT, 'delivery recovery source changed') END);
  SELECT (CASE WHEN NEW.storage_mode = 'legacy' AND NOT (
    NEW.preparation_state = 'preparing' OR (OLD.preparation_state = 'preparing' AND NEW.preparation_state = 'ready'
      AND NEW.source_documents_revision IS OLD.source_documents_revision)
  ) THEN RAISE(ABORT, 'invalid delivery recovery preparation transition') END);
  SELECT (CASE WHEN NEW.storage_mode = 'table' AND (
    OLD.preparation_state <> 'ready' OR NEW.preparation_state <> 'ready'
    OR NEW.source_documents_revision IS NOT OLD.source_documents_revision OR NEW.prepared_at_ms IS NOT OLD.prepared_at_ms
    OR EXISTS (SELECT 1 FROM commerce_documents AS document
      LEFT JOIN commerce_delivery_recovery AS recovery ON recovery.parent_path = document.document_path
      WHERE document.document_kind = 'delivery_order' AND (
        recovery.parent_path IS NULL OR recovery.revision <> 1 OR recovery.lease_id IS NOT NULL
        OR EXISTS (
          SELECT fullkey, CASE WHEN type IN ('integer', 'real') THEN 'number' ELSE type END, atom
          FROM json_tree(document.document_json -> '$.receiptRecovery')
          EXCEPT
          SELECT fullkey, CASE WHEN type IN ('integer', 'real') THEN 'number' ELSE type END, atom
          FROM json_tree(recovery.receipt_recovery_json)
        ) OR EXISTS (
          SELECT fullkey, CASE WHEN type IN ('integer', 'real') THEN 'number' ELSE type END, atom
          FROM json_tree(recovery.receipt_recovery_json)
          EXCEPT
          SELECT fullkey, CASE WHEN type IN ('integer', 'real') THEN 'number' ELSE type END, atom
          FROM json_tree(document.document_json -> '$.receiptRecovery')
        )
      ))
    OR EXISTS (SELECT 1 FROM commerce_delivery_recovery AS recovery
      LEFT JOIN commerce_documents AS document ON document.document_path = recovery.parent_path
      WHERE document.document_kind IS NOT 'delivery_order')
  ) THEN RAISE(ABORT, 'delivery recovery preparation is incomplete') END);
END;

CREATE TRIGGER commerce_delivery_recovery_resume_guard
BEFORE UPDATE OF authority_state ON commerce_authority_control
WHEN NEW.authority_state = 'd1' AND EXISTS (SELECT 1 FROM commerce_delivery_recovery_control
  WHERE storage_mode = 'legacy' AND preparation_state <> 'idle')
BEGIN
  SELECT RAISE(ABORT, 'delivery recovery cutover is incomplete');
END;

CREATE TRIGGER commerce_commit_guard_delivery_recovery_validate
BEFORE INSERT ON commerce_commit_guards
WHEN json_array_length(NEW.delivery_recovery_expectations_json) > 0 OR json_array_length(NEW.delivery_recovery_paths_json) > 0
BEGIN
  SELECT (CASE WHEN NOT EXISTS (SELECT 1 FROM commerce_delivery_recovery_control WHERE singleton = 1 AND storage_mode = 'table')
    THEN RAISE(ABORT, 'delivery recovery is unavailable') END);
  SELECT (CASE WHEN EXISTS (SELECT 1 FROM json_each(NEW.delivery_recovery_paths_json) WHERE type <> 'text')
    THEN RAISE(ABORT, 'invalid delivery recovery commit paths') END);
  SELECT (CASE WHEN EXISTS (SELECT 1 FROM json_each(NEW.delivery_recovery_expectations_json)
    WHERE type <> 'object' OR json_type(value, '$.parentPath') IS NOT 'text'
      OR json_type(value, '$.revision') IS NOT 'integer'
      OR NOT ((json_extract(value, '$.revision') = -1 AND json_type(value, '$.generation') IS 'null')
        OR (json_extract(value, '$.revision') BETWEEN 1 AND 9007199254740991
          AND json_type(value, '$.generation') IS 'text' AND length(json_extract(value, '$.generation')) = 36)))
    OR (SELECT COUNT(*) FROM json_each(NEW.delivery_recovery_expectations_json)) <>
      (SELECT COUNT(DISTINCT json_extract(value, '$.parentPath')) FROM json_each(NEW.delivery_recovery_expectations_json))
    THEN RAISE(ABORT, 'invalid delivery recovery expectations') END);
  SELECT (CASE WHEN EXISTS (SELECT 1 FROM json_each(NEW.delivery_recovery_expectations_json) AS expectation
    LEFT JOIN commerce_delivery_recovery AS recovery ON recovery.parent_path = json_extract(expectation.value, '$.parentPath')
    WHERE COALESCE(recovery.revision, -1) <> json_extract(expectation.value, '$.revision')
      OR recovery.generation IS NOT json_extract(expectation.value, '$.generation'))
    THEN RAISE(ABORT, 'commerce transaction conflict: delivery recovery changed') END);
END;

CREATE TRIGGER commerce_commit_guard_delivery_recovery_finish
BEFORE DELETE ON commerce_commit_guards
WHEN json_array_length(OLD.delivery_recovery_paths_json) > 0
BEGIN
  SELECT (CASE WHEN EXISTS (SELECT 1 FROM json_each(OLD.delivery_recovery_paths_json) AS path
    JOIN commerce_documents AS document ON document.document_path = path.value
    LEFT JOIN commerce_delivery_recovery AS recovery ON recovery.parent_path = document.document_path
    WHERE document.document_kind <> 'delivery_order' OR recovery.parent_path IS NULL)
    THEN RAISE(ABORT, 'commerce transaction conflict: delivery recovery commit is incomplete') END);
END;

CREATE TRIGGER commerce_wipe_guard_delivery_recovery_validate
BEFORE INSERT ON commerce_wipe_guards
WHEN json_array_length(NEW.delivery_recovery_expectations_json) > 0
BEGIN
  SELECT (CASE WHEN EXISTS (SELECT 1 FROM json_each(NEW.delivery_recovery_expectations_json)
    WHERE type <> 'object' OR json_type(value, '$.parentPath') IS NOT 'text'
      OR json_type(value, '$.revision') IS NOT 'integer' OR json_extract(value, '$.revision') NOT BETWEEN 1 AND 9007199254740991
      OR json_type(value, '$.generation') IS NOT 'text' OR length(json_extract(value, '$.generation')) <> 36)
    OR (SELECT COUNT(*) FROM json_each(NEW.delivery_recovery_expectations_json)) <>
      (SELECT COUNT(DISTINCT json_extract(value, '$.parentPath')) FROM json_each(NEW.delivery_recovery_expectations_json))
    THEN RAISE(ABORT, 'invalid delivery recovery wipe expectations') END);
  SELECT (CASE WHEN EXISTS (SELECT 1 FROM json_each(NEW.delivery_recovery_expectations_json) AS expectation
    LEFT JOIN commerce_delivery_recovery AS recovery ON recovery.parent_path = json_extract(expectation.value, '$.parentPath')
    WHERE COALESCE(recovery.revision, -1) <> json_extract(expectation.value, '$.revision')
      OR recovery.generation IS NOT json_extract(expectation.value, '$.generation'))
    THEN RAISE(ABORT, 'commerce wipe conflict: delivery recovery changed') END);
END;

CREATE TRIGGER commerce_delivery_recovery_insert_guard
BEFORE INSERT ON commerce_delivery_recovery
BEGIN
  SELECT (CASE WHEN NOT ((EXISTS (SELECT 1 FROM commerce_authority_control AS authority
    JOIN commerce_delivery_recovery_control AS control ON control.singleton = authority.singleton
    WHERE authority.singleton = 1 AND authority.authority_state = 'd1' AND control.storage_mode = 'table')
    AND EXISTS (SELECT 1 FROM commerce_commit_guards AS guard, json_each(guard.delivery_recovery_paths_json) AS path,
      json_each(guard.delivery_recovery_expectations_json) AS expectation
      WHERE path.value = NEW.parent_path AND json_extract(expectation.value, '$.parentPath') = NEW.parent_path
        AND json_extract(expectation.value, '$.revision') = -1 AND json_type(expectation.value, '$.generation') = 'null')
    AND NEW.revision = 1 AND NEW.lease_id IS NULL)
    OR EXISTS (SELECT 1 FROM commerce_authority_control AS authority
      JOIN commerce_authority_control_lease AS lease ON lease.singleton = authority.singleton
      JOIN commerce_delivery_recovery_control AS control ON control.singleton = authority.singleton
      WHERE authority.singleton = 1 AND authority.authority_state = 'paused' AND authority.paused_at_ms IS NOT NULL
        AND lease.expires_at_ms > CAST(strftime('%s', 'now') AS INTEGER) * 1000
        AND control.storage_mode = 'legacy' AND control.preparation_state = 'preparing'
        AND control.source_documents_revision = authority.documents_revision
        AND NEW.revision = 1 AND NEW.lease_id IS NULL))
    THEN RAISE(ABORT, 'delivery recovery is unavailable') END);
  SELECT (CASE WHEN NOT EXISTS (SELECT 1 FROM commerce_documents WHERE document_path = NEW.parent_path AND document_kind = 'delivery_order')
    THEN RAISE(ABORT, 'delivery recovery parent mismatch') END);
END;

CREATE TRIGGER commerce_delivery_recovery_update_guard
BEFORE UPDATE ON commerce_delivery_recovery
BEGIN
  SELECT (CASE WHEN NEW.parent_path IS NOT OLD.parent_path OR NOT EXISTS (SELECT 1 FROM commerce_documents
    WHERE document_path = NEW.parent_path AND document_kind = 'delivery_order')
    THEN RAISE(ABORT, 'delivery recovery parent mismatch') END);
  SELECT (CASE WHEN NOT ((EXISTS (SELECT 1 FROM commerce_authority_control AS authority
    JOIN commerce_delivery_recovery_control AS control ON control.singleton = authority.singleton
    WHERE authority.singleton = 1 AND authority.authority_state = 'd1' AND control.storage_mode = 'table')
    AND EXISTS (SELECT 1 FROM commerce_commit_guards AS guard, json_each(guard.delivery_recovery_expectations_json) AS expectation
      WHERE json_extract(expectation.value, '$.parentPath') = OLD.parent_path
        AND json_extract(expectation.value, '$.generation') = OLD.generation
        AND json_extract(expectation.value, '$.revision') = OLD.revision))
    OR EXISTS (SELECT 1 FROM commerce_authority_control AS authority
      JOIN commerce_authority_control_lease AS lease ON lease.singleton = authority.singleton
      JOIN commerce_delivery_recovery_control AS control ON control.singleton = authority.singleton
      WHERE authority.singleton = 1 AND authority.authority_state = 'paused' AND authority.paused_at_ms IS NOT NULL
        AND lease.expires_at_ms > CAST(strftime('%s', 'now') AS INTEGER) * 1000
        AND control.storage_mode = 'legacy' AND control.preparation_state = 'preparing'
        AND control.source_documents_revision = authority.documents_revision
        AND NEW.revision = 1 AND NEW.lease_id IS NULL))
    THEN RAISE(ABORT, 'delivery recovery is unavailable') END);
  SELECT (CASE WHEN (SELECT storage_mode FROM commerce_delivery_recovery_control WHERE singleton = 1) = 'table' AND (
    NEW.generation IS NOT OLD.generation OR NEW.created_at_ms <> OLD.created_at_ms
    OR NEW.revision <> OLD.revision + 1 OR NEW.updated_at_ms < OLD.updated_at_ms)
    THEN RAISE(ABORT, 'commerce transaction conflict: delivery recovery revision') END);
END;

CREATE TRIGGER commerce_delivery_recovery_delete_guard
BEFORE DELETE ON commerce_delivery_recovery
WHEN EXISTS (SELECT 1 FROM commerce_documents WHERE document_path = OLD.parent_path) AND NOT EXISTS (
  SELECT 1 FROM commerce_authority_control AS authority
    JOIN commerce_authority_control_lease AS lease ON lease.singleton = authority.singleton
    JOIN commerce_delivery_recovery_control AS control ON control.singleton = authority.singleton
  WHERE authority.singleton = 1 AND authority.authority_state = 'paused' AND authority.paused_at_ms IS NOT NULL
    AND lease.expires_at_ms > CAST(strftime('%s', 'now') AS INTEGER) * 1000
    AND control.storage_mode = 'legacy' AND control.preparation_state = 'preparing'
    AND control.source_documents_revision = authority.documents_revision)
BEGIN
  SELECT RAISE(ABORT, 'delivery recovery requires parent deletion');
END;

CREATE TRIGGER commerce_delivery_recovery_parent_insert_guard
BEFORE INSERT ON commerce_documents
WHEN NEW.document_kind = 'delivery_order' AND (SELECT storage_mode FROM commerce_delivery_recovery_control WHERE singleton = 1) = 'table'
BEGIN
  SELECT (CASE WHEN NOT EXISTS (SELECT 1 FROM commerce_commit_guards AS guard, json_each(guard.delivery_recovery_paths_json) AS path
    WHERE path.value = NEW.document_path)
    THEN RAISE(ABORT, 'delivery recovery parent requires a guarded write') END);
  SELECT (CASE WHEN NOT EXISTS (SELECT 1 FROM commerce_documents WHERE document_path = NEW.document_path)
    AND json_type(NEW.document_json, '$.receiptRecovery') IS NOT NULL
    THEN RAISE(ABORT, 'legacy delivery recovery writes are disabled') END);
END;

CREATE TRIGGER commerce_delivery_recovery_parent_update_guard
BEFORE UPDATE ON commerce_documents
WHEN (OLD.document_kind = 'delivery_order' OR NEW.document_kind = 'delivery_order')
  AND (SELECT storage_mode FROM commerce_delivery_recovery_control WHERE singleton = 1) = 'table'
BEGIN
  SELECT (CASE WHEN NEW.document_path IS NOT OLD.document_path OR NEW.document_kind IS NOT OLD.document_kind
    THEN RAISE(ABORT, 'delivery recovery parent identity is immutable') END);
  SELECT (CASE WHEN NOT EXISTS (SELECT 1 FROM commerce_commit_guards AS guard, json_each(guard.delivery_recovery_paths_json) AS path
    WHERE path.value = NEW.document_path)
    THEN RAISE(ABORT, 'delivery recovery parent requires a guarded write') END);
  SELECT (CASE WHEN EXISTS (
    SELECT fullkey, CASE WHEN type IN ('integer', 'real') THEN 'number' ELSE type END, atom
    FROM json_tree(NEW.document_json -> '$.receiptRecovery')
    EXCEPT
    SELECT fullkey, CASE WHEN type IN ('integer', 'real') THEN 'number' ELSE type END, atom
    FROM json_tree(OLD.document_json -> '$.receiptRecovery')
  ) OR EXISTS (
    SELECT fullkey, CASE WHEN type IN ('integer', 'real') THEN 'number' ELSE type END, atom
    FROM json_tree(OLD.document_json -> '$.receiptRecovery')
    EXCEPT
    SELECT fullkey, CASE WHEN type IN ('integer', 'real') THEN 'number' ELSE type END, atom
    FROM json_tree(NEW.document_json -> '$.receiptRecovery')
  ) THEN RAISE(ABORT, 'legacy delivery recovery writes are disabled') END);
END;

CREATE TRIGGER commerce_delivery_recovery_parent_delete_guard
BEFORE DELETE ON commerce_documents
WHEN OLD.document_kind = 'delivery_order' AND (SELECT storage_mode FROM commerce_delivery_recovery_control WHERE singleton = 1) = 'table'
BEGIN
  SELECT (CASE WHEN NOT (EXISTS (SELECT 1 FROM commerce_commit_guards AS guard,
    json_each(guard.delivery_recovery_paths_json) AS path,
    json_each(guard.delivery_recovery_expectations_json) AS expectation
    JOIN commerce_delivery_recovery AS recovery ON recovery.parent_path = OLD.document_path
    WHERE EXISTS (SELECT 1 FROM commerce_authority_control WHERE singleton = 1 AND authority_state = 'd1')
      AND path.value = OLD.document_path AND json_extract(expectation.value, '$.parentPath') = OLD.document_path
      AND json_extract(expectation.value, '$.generation') = recovery.generation
      AND json_extract(expectation.value, '$.revision') = recovery.revision)
    OR EXISTS (SELECT 1 FROM commerce_authority_control AS authority
      JOIN commerce_authority_control_lease AS lease ON lease.singleton = authority.singleton,
      commerce_wipe_guards AS guard, json_each(guard.expectations_json) AS expectation,
      json_each(guard.delivery_recovery_expectations_json) AS recovery_expectation
      JOIN commerce_delivery_recovery AS recovery ON recovery.parent_path = OLD.document_path
      WHERE authority.singleton = 1 AND authority.authority_state = 'paused' AND authority.paused_at_ms IS NOT NULL
        AND lease.expires_at_ms > CAST(strftime('%s', 'now') AS INTEGER) * 1000
        AND json_extract(expectation.value, '$.path') = OLD.document_path
        AND json_extract(expectation.value, '$.version') = OLD.version
        AND json_extract(recovery_expectation.value, '$.parentPath') = OLD.document_path
        AND json_extract(recovery_expectation.value, '$.generation') = recovery.generation
        AND json_extract(recovery_expectation.value, '$.revision') = recovery.revision))
    THEN RAISE(ABORT, 'delivery recovery parent requires a guarded deletion') END);
END;

PRAGMA optimize;
