CREATE TABLE commerce_pack_status_outbox_control (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  storage_mode TEXT NOT NULL DEFAULT 'legacy' CHECK (storage_mode IN ('legacy', 'table')),
  preparation_state TEXT NOT NULL DEFAULT 'idle' CHECK (preparation_state IN ('idle', 'preparing', 'ready')),
  source_documents_revision INTEGER CHECK (source_documents_revision IS NULL OR source_documents_revision BETWEEN 0 AND 9007199254740991),
  prepared_at_ms INTEGER CHECK (prepared_at_ms IS NULL OR prepared_at_ms BETWEEN 0 AND 9007199254740991),
  CHECK (storage_mode <> 'table' OR preparation_state = 'ready'),
  CHECK (preparation_state <> 'ready' OR (source_documents_revision IS NOT NULL AND prepared_at_ms IS NOT NULL))
) STRICT;

INSERT INTO commerce_pack_status_outbox_control (singleton) VALUES (1);

CREATE TABLE commerce_pack_status_outbox (
  parent_path TEXT PRIMARY KEY REFERENCES commerce_documents(document_path) ON DELETE CASCADE,
  drop_id TEXT NOT NULL CHECK (length(drop_id) BETWEEN 1 AND 64),
  generation TEXT NOT NULL CHECK (length(generation) = 36),
  state TEXT NOT NULL CHECK (state IN ('pending', 'completed', 'failed', 'cancelled')),
  revision INTEGER NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740991),
  failure_count INTEGER NOT NULL CHECK (failure_count BETWEEN 0 AND 9007199254740991),
  next_attempt_at_ms INTEGER CHECK (next_attempt_at_ms IS NULL OR next_attempt_at_ms BETWEEN 0 AND 9007199254740991),
  completed_at_ms INTEGER CHECK (completed_at_ms IS NULL OR completed_at_ms BETWEEN 0 AND 9007199254740991),
  failed_at_ms INTEGER CHECK (failed_at_ms IS NULL OR failed_at_ms BETWEEN 0 AND 9007199254740991),
  last_error_code TEXT CHECK (last_error_code IS NULL OR length(last_error_code) BETWEEN 1 AND 256),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms BETWEEN 0 AND 9007199254740991),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms BETWEEN created_at_ms AND 9007199254740991),
  CHECK ((state = 'pending') = (next_attempt_at_ms IS NOT NULL)),
  CHECK (state = 'completed' OR completed_at_ms IS NULL),
  CHECK (state = 'failed' OR failed_at_ms IS NULL)
) STRICT;

CREATE INDEX commerce_pack_status_outbox_due
ON commerce_pack_status_outbox (drop_id, next_attempt_at_ms, parent_path) WHERE state = 'pending';

CREATE INDEX commerce_pack_status_outbox_drop ON commerce_pack_status_outbox (drop_id, parent_path);

CREATE TRIGGER commerce_pack_status_control_insert_guard
BEFORE INSERT ON commerce_pack_status_outbox_control
BEGIN
  SELECT RAISE(ABORT, 'pack-status outbox control cannot be inserted');
END;

CREATE TRIGGER commerce_pack_status_control_delete_guard
BEFORE DELETE ON commerce_pack_status_outbox_control
BEGIN
  SELECT RAISE(ABORT, 'pack-status outbox control cannot be deleted');
END;

CREATE TRIGGER commerce_pack_status_control_update_guard
BEFORE UPDATE ON commerce_pack_status_outbox_control
BEGIN
  SELECT (CASE WHEN NOT EXISTS (SELECT 1 FROM commerce_authority_control AS authority
    JOIN commerce_authority_control_lease AS lease ON lease.singleton = authority.singleton
    WHERE authority.singleton = 1 AND authority.authority_state = 'paused' AND authority.paused_at_ms IS NOT NULL
      AND lease.expires_at_ms > CAST(strftime('%s', 'now') AS INTEGER) * 1000) THEN RAISE(ABORT, 'pack-status outbox maintenance is not ready') END);
  SELECT (CASE WHEN NEW.singleton <> OLD.singleton OR OLD.storage_mode = 'table'
    THEN RAISE(ABORT, 'pack-status outbox activation is irreversible') END);
  SELECT (CASE WHEN NEW.source_documents_revision IS NOT (SELECT documents_revision FROM commerce_authority_control WHERE singleton = 1)
    THEN RAISE(ABORT, 'pack-status outbox source changed') END);
  SELECT (CASE WHEN NEW.storage_mode = 'legacy' AND NOT (
    NEW.preparation_state = 'preparing' OR (OLD.preparation_state = 'preparing' AND NEW.preparation_state = 'ready'
      AND NEW.source_documents_revision IS OLD.source_documents_revision)
  ) THEN RAISE(ABORT, 'invalid pack-status outbox preparation transition') END);
  SELECT (CASE WHEN NEW.storage_mode = 'table' AND (
    OLD.preparation_state <> 'ready' OR NEW.preparation_state <> 'ready'
    OR NEW.source_documents_revision IS NOT OLD.source_documents_revision OR NEW.prepared_at_ms IS NOT OLD.prepared_at_ms
    OR EXISTS (SELECT 1 FROM commerce_documents AS document
      LEFT JOIN commerce_pack_status_outbox AS outbox ON outbox.parent_path = document.document_path
      WHERE document.document_kind = 'delivery_order' AND json_type(document.document_json, '$.packStatusProjectionState') IS NOT NULL
        AND (outbox.parent_path IS NULL OR outbox.drop_id IS NOT document.drop_id
          OR outbox.state IS NOT json_extract(document.document_json, '$.packStatusProjectionState')
          OR outbox.failure_count IS NOT COALESCE(json_extract(document.document_json, '$.packStatusProjectionFailureCount'), 0)
          OR outbox.next_attempt_at_ms IS NOT CASE WHEN outbox.state = 'pending'
            THEN COALESCE(json_extract(document.document_json, '$.packStatusProjectionNextAttemptAtMs'), 0) ELSE NULL END
          OR outbox.completed_at_ms IS NOT json_extract(document.document_json, '$.packStatusProjectionCompletedAt')
          OR outbox.failed_at_ms IS NOT json_extract(document.document_json, '$.packStatusProjectionFailedAt')
          OR outbox.last_error_code IS NOT json_extract(document.document_json, '$.packStatusProjectionLastErrorCode')))
    OR EXISTS (SELECT 1 FROM commerce_pack_status_outbox AS outbox
      LEFT JOIN commerce_documents AS document ON document.document_path = outbox.parent_path
      WHERE document.document_kind IS NOT 'delivery_order'
        OR json_type(document.document_json, '$.packStatusProjectionState') IS NULL)
  ) THEN RAISE(ABORT, 'pack-status outbox preparation is incomplete') END);
END;

CREATE TRIGGER commerce_pack_status_resume_guard
BEFORE UPDATE OF authority_state ON commerce_authority_control
WHEN NEW.authority_state = 'd1' AND EXISTS (SELECT 1 FROM commerce_pack_status_outbox_control
  WHERE storage_mode = 'legacy' AND preparation_state <> 'idle')
BEGIN
  SELECT RAISE(ABORT, 'pack-status outbox cutover is incomplete');
END;

CREATE TRIGGER commerce_pack_status_outbox_insert_guard
BEFORE INSERT ON commerce_pack_status_outbox
BEGIN
  SELECT (CASE WHEN NOT (EXISTS (SELECT 1 FROM commerce_authority_control AS authority
    JOIN commerce_pack_status_outbox_control AS control ON control.singleton = authority.singleton
    WHERE authority.singleton = 1 AND authority.authority_state = 'd1' AND control.storage_mode = 'table') OR (EXISTS (SELECT 1 FROM commerce_authority_control AS authority
    JOIN commerce_authority_control_lease AS lease ON lease.singleton = authority.singleton
    WHERE authority.singleton = 1 AND authority.authority_state = 'paused' AND authority.paused_at_ms IS NOT NULL
      AND lease.expires_at_ms > CAST(strftime('%s', 'now') AS INTEGER) * 1000) AND EXISTS (SELECT 1 FROM commerce_pack_status_outbox_control AS control
    JOIN commerce_authority_control AS authority ON authority.singleton = control.singleton
    WHERE control.storage_mode = 'legacy' AND control.preparation_state = 'preparing'
      AND control.source_documents_revision = authority.documents_revision)))
    THEN RAISE(ABORT, 'pack-status outbox is unavailable') END);
  SELECT (CASE WHEN NOT EXISTS (SELECT 1 FROM commerce_documents
    WHERE document_path = NEW.parent_path AND document_kind = 'delivery_order' AND drop_id = NEW.drop_id)
    THEN RAISE(ABORT, 'pack-status outbox parent mismatch') END);
END;

CREATE TRIGGER commerce_pack_status_outbox_update_guard
BEFORE UPDATE ON commerce_pack_status_outbox
BEGIN
  SELECT (CASE WHEN NOT (EXISTS (SELECT 1 FROM commerce_authority_control AS authority
    JOIN commerce_pack_status_outbox_control AS control ON control.singleton = authority.singleton
    WHERE authority.singleton = 1 AND authority.authority_state = 'd1' AND control.storage_mode = 'table') OR (EXISTS (SELECT 1 FROM commerce_authority_control AS authority
    JOIN commerce_authority_control_lease AS lease ON lease.singleton = authority.singleton
    WHERE authority.singleton = 1 AND authority.authority_state = 'paused' AND authority.paused_at_ms IS NOT NULL
      AND lease.expires_at_ms > CAST(strftime('%s', 'now') AS INTEGER) * 1000) AND EXISTS (SELECT 1 FROM commerce_pack_status_outbox_control AS control
    JOIN commerce_authority_control AS authority ON authority.singleton = control.singleton
    WHERE control.storage_mode = 'legacy' AND control.preparation_state = 'preparing'
      AND control.source_documents_revision = authority.documents_revision)))
    THEN RAISE(ABORT, 'pack-status outbox is unavailable') END);
  SELECT (CASE WHEN NEW.parent_path IS NOT OLD.parent_path OR NEW.drop_id IS NOT OLD.drop_id
    OR NOT EXISTS (SELECT 1 FROM commerce_documents WHERE document_path = NEW.parent_path
      AND document_kind = 'delivery_order' AND drop_id = NEW.drop_id)
    THEN RAISE(ABORT, 'pack-status outbox parent mismatch') END);
  SELECT (CASE WHEN (SELECT storage_mode FROM commerce_pack_status_outbox_control WHERE singleton = 1) = 'table' AND (
    NEW.generation IS NOT OLD.generation OR NEW.created_at_ms <> OLD.created_at_ms
    OR NEW.revision <> OLD.revision + 1 OR NEW.updated_at_ms < OLD.updated_at_ms OR OLD.state <> 'pending'
  ) THEN RAISE(ABORT, 'pack-status outbox revision conflict') END);
END;

CREATE TRIGGER commerce_pack_status_outbox_delete_guard
BEFORE DELETE ON commerce_pack_status_outbox
WHEN NOT EXISTS (SELECT 1 FROM commerce_authority_control AS authority
    JOIN commerce_authority_control_lease AS lease ON lease.singleton = authority.singleton
    WHERE authority.singleton = 1 AND authority.authority_state = 'paused' AND authority.paused_at_ms IS NOT NULL
      AND lease.expires_at_ms > CAST(strftime('%s', 'now') AS INTEGER) * 1000)
BEGIN
  SELECT RAISE(ABORT, 'pack-status outbox deletion requires maintenance');
END;

CREATE TRIGGER commerce_pack_status_legacy_insert_fence
BEFORE INSERT ON commerce_documents
WHEN (SELECT storage_mode FROM commerce_pack_status_outbox_control WHERE singleton = 1) = 'table'
  AND NOT EXISTS (SELECT 1 FROM commerce_documents WHERE document_path = NEW.document_path)
  AND (json_type(NEW.document_json, '$.packStatusProjectionState') IS NOT NULL
    OR json_type(NEW.document_json, '$.packStatusProjectionNextAttemptAtMs') IS NOT NULL
    OR json_type(NEW.document_json, '$.packStatusProjectionFailureCount') IS NOT NULL
    OR json_type(NEW.document_json, '$.packStatusProjectionCompletedAt') IS NOT NULL
    OR json_type(NEW.document_json, '$.packStatusProjectionFailedAt') IS NOT NULL
    OR json_type(NEW.document_json, '$.packStatusProjectionLastErrorCode') IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT, 'legacy pack-status projection writes are disabled');
END;

CREATE TRIGGER commerce_pack_status_legacy_update_fence
BEFORE UPDATE OF document_json ON commerce_documents
WHEN (SELECT storage_mode FROM commerce_pack_status_outbox_control WHERE singleton = 1) = 'table'
  AND (json_type(NEW.document_json, '$.packStatusProjectionState') IS NOT json_type(OLD.document_json, '$.packStatusProjectionState')
    OR json_extract(NEW.document_json, '$.packStatusProjectionState') IS NOT json_extract(OLD.document_json, '$.packStatusProjectionState')
    OR json_type(NEW.document_json, '$.packStatusProjectionNextAttemptAtMs') IS NOT json_type(OLD.document_json, '$.packStatusProjectionNextAttemptAtMs')
    OR json_extract(NEW.document_json, '$.packStatusProjectionNextAttemptAtMs') IS NOT json_extract(OLD.document_json, '$.packStatusProjectionNextAttemptAtMs')
    OR json_type(NEW.document_json, '$.packStatusProjectionFailureCount') IS NOT json_type(OLD.document_json, '$.packStatusProjectionFailureCount')
    OR json_extract(NEW.document_json, '$.packStatusProjectionFailureCount') IS NOT json_extract(OLD.document_json, '$.packStatusProjectionFailureCount')
    OR json_type(NEW.document_json, '$.packStatusProjectionCompletedAt') IS NOT json_type(OLD.document_json, '$.packStatusProjectionCompletedAt')
    OR json_extract(NEW.document_json, '$.packStatusProjectionCompletedAt') IS NOT json_extract(OLD.document_json, '$.packStatusProjectionCompletedAt')
    OR json_type(NEW.document_json, '$.packStatusProjectionFailedAt') IS NOT json_type(OLD.document_json, '$.packStatusProjectionFailedAt')
    OR json_extract(NEW.document_json, '$.packStatusProjectionFailedAt') IS NOT json_extract(OLD.document_json, '$.packStatusProjectionFailedAt')
    OR json_type(NEW.document_json, '$.packStatusProjectionLastErrorCode') IS NOT json_type(OLD.document_json, '$.packStatusProjectionLastErrorCode')
    OR json_extract(NEW.document_json, '$.packStatusProjectionLastErrorCode') IS NOT json_extract(OLD.document_json, '$.packStatusProjectionLastErrorCode'))
BEGIN
  SELECT RAISE(ABORT, 'legacy pack-status projection writes are disabled');
END;

PRAGMA optimize;
