CREATE INDEX commerce_ready_notifications_due
  ON commerce_documents (
    CASE WHEN
      json_type(document_json, '$.readyToShipNotificationPublishClaimId') = 'text' AND
      json_extract(document_json, '$.readyToShipNotificationPublishClaimId') <> '' AND
      json_type(document_json, '$.readyToShipNotificationPublishClaimExpiresAtMs') IN ('integer', 'real') AND
      json_extract(document_json, '$.readyToShipNotificationPublishClaimExpiresAtMs') BETWEEN 0 AND 9007199254740991 AND
      json_extract(document_json, '$.readyToShipNotificationPublishClaimExpiresAtMs') = CAST(json_extract(document_json, '$.readyToShipNotificationPublishClaimExpiresAtMs') AS INTEGER)
    THEN CAST(json_extract(document_json, '$.readyToShipNotificationPublishClaimExpiresAtMs') AS INTEGER) ELSE 0 END,
    document_path
  )
  WHERE document_kind = 'delivery_order' AND status = 'ready_to_ship' AND
    (buyer_notification_state = 'pending' OR shipper_notification_state = 'pending');

ANALYZE commerce_ready_notifications_due;
