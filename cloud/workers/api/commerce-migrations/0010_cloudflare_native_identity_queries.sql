SELECT CASE WHEN (
  SELECT authority_state FROM commerce_authority_control WHERE singleton = 1
) <> 'paused' THEN json('commerce must be paused for native identity migration') ELSE NULL END;

SELECT CASE WHEN EXISTS (
  SELECT 1
  FROM commerce_documents
  WHERE
    json_type(document_json, '$.uid') IS NOT NULL AND
    NOT (
      document_kind = 'stripe_checkout' AND
      json_type(document_json, '$.uid') = 'text' AND
      length(json_extract(document_json, '$.uid')) > 0 AND
      (
        (
          json_extract(document_json, '$.ownerKind') = 'anonymous' AND
          json_extract(document_json, '$.authSubject') = json_extract(document_json, '$.uid') AND
          json_extract(document_json, '$.owner') =
            'anonymous:' || json_extract(document_json, '$.uid')
        ) OR
        (
          json_extract(document_json, '$.ownerKind') = 'wallet' AND
          json_type(document_json, '$.authSubject') IS NULL AND
          json_extract(document_json, '$.owner') = json_extract(document_json, '$.uid')
        )
      )
    )
) THEN json('invalid legacy checkout identity') ELSE NULL END;

DROP TRIGGER commerce_documents_update_authority_guard;

UPDATE commerce_documents
SET document_json = json_remove(document_json, '$.uid')
WHERE json_type(document_json, '$.uid') IS NOT NULL;

CREATE TRIGGER commerce_documents_update_authority_guard
BEFORE UPDATE ON commerce_documents
WHEN (SELECT authority_state FROM commerce_authority_control WHERE singleton = 1) <> 'd1'
BEGIN
  SELECT RAISE(ABORT, 'commerce authority is not d1');
END;

CREATE TRIGGER commerce_documents_identity_insert_guard
BEFORE INSERT ON commerce_documents
WHEN json_type(NEW.document_json, '$.uid') IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'commerce document contains legacy identity data');
END;

CREATE TRIGGER commerce_documents_identity_update_guard
BEFORE UPDATE OF document_json ON commerce_documents
WHEN json_type(NEW.document_json, '$.uid') IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'commerce document contains legacy identity data');
END;

DROP INDEX commerce_documents_checkout_reconciliation;
DROP INDEX commerce_documents_ready_notifications;

CREATE INDEX commerce_documents_delivery_owner_path
  ON commerce_documents (document_kind, owner, document_path);

CREATE INDEX commerce_delivery_orders_buyer_notifications_pending
  ON commerce_documents (document_path)
  WHERE
    document_kind = 'delivery_order' AND
    status = 'ready_to_ship' AND
    buyer_notification_state = 'pending';

CREATE INDEX commerce_delivery_orders_shipper_notifications_pending
  ON commerce_documents (document_path)
  WHERE
    document_kind = 'delivery_order' AND
    status = 'ready_to_ship' AND
    shipper_notification_state = 'pending';

CREATE INDEX commerce_stripe_checkouts_reconciliation_due
  ON commerce_documents (
    CAST(json_extract(document_json, '$.updatedAt') AS INTEGER),
    document_path
  )
  WHERE
    document_kind = 'stripe_checkout' AND
    fulfillment_processor = 'cloudflare_queue_v1' AND
    status IN ('fulfillment_pending', 'processing');

PRAGMA optimize;
