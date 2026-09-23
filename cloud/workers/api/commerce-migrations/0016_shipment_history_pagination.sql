ALTER TABLE commerce_documents ADD COLUMN shipment_sort_at_ms REAL
GENERATED ALWAYS AS (
  COALESCE(
    CASE WHEN json_type(document_json, '$.processedAt') IN ('integer', 'real')
      AND json_extract(document_json, '$.processedAt') BETWEEN -1.7976931348623157e308 AND 1.7976931348623157e308
      THEN json_extract(document_json, '$.processedAt') END,
    CASE WHEN json_type(document_json, '$.processingAt') IN ('integer', 'real')
      AND json_extract(document_json, '$.processingAt') BETWEEN -1.7976931348623157e308 AND 1.7976931348623157e308
      THEN json_extract(document_json, '$.processingAt') END,
    CASE WHEN json_type(document_json, '$.createdAt') IN ('integer', 'real')
      AND json_extract(document_json, '$.createdAt') BETWEEN -1.7976931348623157e308 AND 1.7976931348623157e308
      THEN json_extract(document_json, '$.createdAt') END,
    0
  )
) VIRTUAL;

CREATE INDEX commerce_delivery_orders_shipment_cursor
  ON commerce_documents (owner, shipment_sort_at_ms DESC, document_path DESC)
  WHERE document_kind = 'delivery_order'
    AND status IN ('processing', 'ready_to_ship')
    AND source IS NOT 'admin_irl_redeem';

CREATE INDEX commerce_delivery_orders_shipment_session
  ON commerce_documents (owner, json_extract(document_json, '$.stripeCheckoutSessionId'))
  WHERE document_kind = 'delivery_order'
    AND status IN ('processing', 'ready_to_ship')
    AND source IS NOT 'admin_irl_redeem';

PRAGMA optimize;
