const claimId = "json_extract(document_json, '$.readyToShipNotificationPublishClaimId')";
const claimExpiresAtMs = "json_extract(document_json, '$.readyToShipNotificationPublishClaimExpiresAtMs')";

export const READY_NOTIFICATION_DUE_SQL = Object.freeze({
  indexName: 'commerce_ready_notifications_due',
  dueAtExpression: `CASE WHEN
    json_type(document_json, '$.readyToShipNotificationPublishClaimId') = 'text' AND
    ${claimId} <> '' AND
    json_type(document_json, '$.readyToShipNotificationPublishClaimExpiresAtMs') IN ('integer', 'real') AND
    ${claimExpiresAtMs} BETWEEN 0 AND 9007199254740991 AND
    ${claimExpiresAtMs} = CAST(${claimExpiresAtMs} AS INTEGER)
  THEN CAST(${claimExpiresAtMs} AS INTEGER) ELSE 0 END`,
  pendingPredicate: `document_kind = 'delivery_order' AND status = 'ready_to_ship' AND
    (buyer_notification_state = 'pending' OR shipper_notification_state = 'pending')`,
});
