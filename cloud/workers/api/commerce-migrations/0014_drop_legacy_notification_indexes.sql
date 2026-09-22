CREATE TABLE commerce_legacy_notification_index_migration_guard (
  allowed INTEGER NOT NULL
    CONSTRAINT notification_outbox_activation_required CHECK (allowed = 1)
) STRICT;

INSERT INTO commerce_legacy_notification_index_migration_guard (allowed)
SELECT EXISTS (
  SELECT 1
  FROM commerce_authority_control AS authority
  CROSS JOIN commerce_notification_outbox_control AS outbox
  WHERE authority.singleton = 1 AND outbox.singleton = 1 AND (
    outbox.storage_mode = 'table' OR (
      authority.authority_state = 'paused' AND
      authority.revision = 2 AND
      authority.documents_revision = 0 AND
      authority.paused_at_ms IS NULL AND
      authority.dude_inventory_mode = 'legacy' AND
      outbox.storage_mode = 'legacy' AND
      outbox.preparation_state = 'idle' AND
      outbox.source_documents_revision IS NULL AND
      outbox.prepared_at_ms IS NULL AND
      NOT EXISTS (SELECT 1 FROM commerce_documents) AND
      NOT EXISTS (SELECT 1 FROM commerce_notification_outbox) AND
      NOT EXISTS (SELECT 1 FROM commerce_document_path_revisions) AND
      NOT EXISTS (SELECT 1 FROM commerce_delivery_owner_revisions) AND
      NOT EXISTS (SELECT 1 FROM commerce_inventory_drops) AND
      NOT EXISTS (SELECT 1 FROM commerce_authority_control_lease) AND
      NOT EXISTS (SELECT 1 FROM commerce_commit_guards) AND
      NOT EXISTS (SELECT 1 FROM commerce_wipe_guards)
    )
  )
);

DROP INDEX commerce_delivery_orders_buyer_notifications_pending;
DROP INDEX commerce_delivery_orders_shipper_notifications_pending;
DROP INDEX commerce_delivery_orders_buyer_notifications_pending_owner_path;
DROP INDEX commerce_delivery_orders_shipper_notifications_pending_owner_path;
DROP INDEX commerce_ready_notifications_due;
DROP INDEX commerce_stripe_terminal_notifications_due;

DROP TABLE commerce_legacy_notification_index_migration_guard;

PRAGMA optimize;
