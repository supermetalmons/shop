ALTER TABLE commerce_documents ADD COLUMN manual_review_sort_at_ms REAL
GENERATED ALWAYS AS (
  COALESCE(
    NULLIF(CASE WHEN json_type(document_json, '$.failedAt') IN ('integer', 'real')
      AND json_extract(document_json, '$.failedAt') BETWEEN -1.7976931348623157e308 AND 1.7976931348623157e308
      THEN json_extract(document_json, '$.failedAt') END, 0),
    NULLIF(CASE WHEN json_type(document_json, '$.createdAt') IN ('integer', 'real')
      AND json_extract(document_json, '$.createdAt') BETWEEN -1.7976931348623157e308 AND 1.7976931348623157e308
      THEN json_extract(document_json, '$.createdAt') END, 0),
    0
  )
) VIRTUAL;

ALTER TABLE commerce_documents ADD COLUMN manual_review_session_id TEXT
GENERATED ALWAYS AS (
  COALESCE(NULLIF(CASE WHEN json_type(document_json, '$.sessionId') = 'text'
    THEN trim(json_extract(document_json, '$.sessionId'),
      char(9, 10, 11, 12, 13, 32, 160, 5760, 8192, 8193, 8194, 8195, 8196, 8197,
        8198, 8199, 8200, 8201, 8202, 8232, 8233, 8239, 8287, 12288, 65279))
    END, ''), document_id)
) VIRTUAL;

CREATE INDEX commerce_stripe_checkouts_manual_review_cursor
  ON commerce_documents (
    drop_id,
    manual_review_sort_at_ms DESC,
    manual_review_session_id COLLATE BINARY DESC,
    document_path COLLATE BINARY DESC
  )
  WHERE document_kind = 'stripe_checkout'
    AND status = 'fulfillment_failed'
    AND manual_refund_review_required = 1
    AND json_type(document_json, '$.manualRefundReviewRequired') = 'true';

PRAGMA optimize;
