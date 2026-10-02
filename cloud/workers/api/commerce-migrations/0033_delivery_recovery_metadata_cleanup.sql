CREATE TABLE commerce_delivery_recovery_cleanup_migration_guard (
  allowed INTEGER NOT NULL
    CONSTRAINT delivery_recovery_cleanup_requires_maintenance CHECK (allowed = 1)
) STRICT;

INSERT INTO commerce_delivery_recovery_cleanup_migration_guard (allowed)
SELECT EXISTS (
  SELECT 1
  FROM commerce_authority_control AS authority
  CROSS JOIN commerce_delivery_recovery_control AS recovery
  WHERE authority.singleton = 1 AND recovery.singleton = 1
    AND NOT EXISTS (SELECT 1 FROM commerce_authority_control_lease)
    AND NOT EXISTS (SELECT 1 FROM commerce_commit_guards)
    AND NOT EXISTS (SELECT 1 FROM commerce_wipe_guards)
    AND (
      (
        authority.authority_state = 'paused' AND authority.paused_at_ms IS NOT NULL
        AND recovery.storage_mode = 'table' AND recovery.preparation_state = 'ready'
        AND NOT EXISTS (
          SELECT 1 FROM commerce_documents AS document
          LEFT JOIN commerce_delivery_recovery AS state ON state.parent_path = document.document_path
          WHERE document.document_kind = 'delivery_order' AND state.parent_path IS NULL
        )
        AND NOT EXISTS (
          SELECT 1 FROM commerce_delivery_recovery AS state
          LEFT JOIN commerce_documents AS document ON document.document_path = state.parent_path
          WHERE document.document_kind IS NOT 'delivery_order'
        )
      ) OR (
        authority.authority_state = 'paused' AND authority.revision = 2
        AND authority.documents_revision = 0 AND authority.paused_at_ms IS NULL
        AND authority.dude_inventory_mode = 'legacy'
        AND recovery.storage_mode = 'legacy' AND recovery.preparation_state = 'idle'
        AND recovery.source_documents_revision IS NULL AND recovery.prepared_at_ms IS NULL
        AND EXISTS (SELECT 1 FROM commerce_notification_outbox_control WHERE singleton = 1
          AND storage_mode = 'legacy' AND preparation_state = 'idle'
          AND source_documents_revision IS NULL AND prepared_at_ms IS NULL)
        AND EXISTS (SELECT 1 FROM commerce_stripe_checkout_state_control WHERE singleton = 1
          AND storage_mode = 'legacy' AND preparation_state = 'idle'
          AND source_documents_revision IS NULL AND prepared_at_ms IS NULL)
        AND EXISTS (SELECT 1 FROM commerce_pack_status_outbox_control WHERE singleton = 1
          AND storage_mode = 'legacy' AND preparation_state = 'idle'
          AND source_documents_revision IS NULL AND prepared_at_ms IS NULL)
        AND NOT EXISTS (SELECT 1 FROM commerce_documents)
        AND NOT EXISTS (SELECT 1 FROM commerce_delivery_recovery)
        AND NOT EXISTS (SELECT 1 FROM commerce_document_path_revisions)
        AND NOT EXISTS (SELECT 1 FROM commerce_delivery_owner_revisions)
        AND NOT EXISTS (SELECT 1 FROM commerce_inventory_drops)
        AND NOT EXISTS (SELECT 1 FROM commerce_available_dudes)
        AND NOT EXISTS (SELECT 1 FROM commerce_notification_outbox)
        AND NOT EXISTS (SELECT 1 FROM commerce_notification_outbox_pending_owners)
        AND NOT EXISTS (SELECT 1 FROM commerce_notification_outbox_stripe_due)
        AND NOT EXISTS (SELECT 1 FROM commerce_stripe_checkout_state)
        AND NOT EXISTS (SELECT 1 FROM commerce_pack_status_outbox)
        AND NOT EXISTS (SELECT 1 FROM commerce_preorder_orders)
        AND NOT EXISTS (SELECT 1 FROM commerce_preorder_claims)
        AND NOT EXISTS (SELECT 1 FROM stripe_order_disputes)
      )
    )
);

DROP TRIGGER commerce_documents_update_authority_guard;
DROP TRIGGER commerce_documents_version_update_guard;
DROP TRIGGER commerce_document_path_revision_update;
DROP TRIGGER commerce_delivery_recovery_parent_update_guard;
DROP TRIGGER commerce_delivery_recovery_parent_insert_guard;

UPDATE commerce_documents
SET document_json = json_remove(document_json, '$.receiptRecovery')
WHERE document_kind = 'delivery_order' AND json_type(document_json, '$.receiptRecovery') IS NOT NULL;

CREATE TRIGGER commerce_documents_update_authority_guard
BEFORE UPDATE ON commerce_documents
WHEN (SELECT authority_state FROM commerce_authority_control WHERE singleton = 1) <> 'd1'
BEGIN
  SELECT RAISE(ABORT, 'commerce authority is not d1');
END;

CREATE TRIGGER commerce_documents_version_update_guard
AFTER UPDATE ON commerce_documents
WHEN NEW.version <= OLD.version
BEGIN
  SELECT RAISE(ABORT, 'commerce transaction conflict: commerce document version must increase');
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

CREATE TRIGGER commerce_delivery_recovery_parent_insert_guard
BEFORE INSERT ON commerce_documents
WHEN NEW.document_kind = 'delivery_order'
BEGIN
  SELECT (CASE WHEN json_type(NEW.document_json, '$.receiptRecovery') IS NOT NULL
    THEN RAISE(ABORT, 'legacy delivery recovery writes are disabled') END);
  SELECT (CASE WHEN (SELECT storage_mode FROM commerce_delivery_recovery_control WHERE singleton = 1) = 'table'
    AND NOT EXISTS (SELECT 1 FROM commerce_commit_guards AS guard, json_each(guard.delivery_recovery_paths_json) AS path
      WHERE path.value = NEW.document_path)
    THEN RAISE(ABORT, 'delivery recovery parent requires a guarded write') END);
END;

CREATE TRIGGER commerce_delivery_recovery_parent_update_guard
BEFORE UPDATE ON commerce_documents
WHEN OLD.document_kind = 'delivery_order' OR NEW.document_kind = 'delivery_order'
BEGIN
  SELECT (CASE WHEN json_type(NEW.document_json, '$.receiptRecovery') IS NOT NULL
    THEN RAISE(ABORT, 'legacy delivery recovery writes are disabled') END);
  SELECT (CASE WHEN (SELECT storage_mode FROM commerce_delivery_recovery_control WHERE singleton = 1) = 'table'
    AND (NEW.document_path IS NOT OLD.document_path OR NEW.document_kind IS NOT OLD.document_kind)
    THEN RAISE(ABORT, 'delivery recovery parent identity is immutable') END);
  SELECT (CASE WHEN (SELECT storage_mode FROM commerce_delivery_recovery_control WHERE singleton = 1) = 'table'
    AND NOT EXISTS (SELECT 1 FROM commerce_commit_guards AS guard, json_each(guard.delivery_recovery_paths_json) AS path
      WHERE path.value = NEW.document_path)
    THEN RAISE(ABORT, 'delivery recovery parent requires a guarded write') END);
END;

INSERT INTO commerce_delivery_recovery_cleanup_migration_guard (allowed)
SELECT NOT EXISTS (
  SELECT 1 FROM commerce_documents
  WHERE document_kind = 'delivery_order' AND json_type(document_json, '$.receiptRecovery') IS NOT NULL
);

DROP TABLE commerce_delivery_recovery_cleanup_migration_guard;
