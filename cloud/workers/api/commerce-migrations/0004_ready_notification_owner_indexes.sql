CREATE INDEX commerce_delivery_orders_buyer_notifications_pending_owner_path
  ON commerce_documents (owner, document_path)
  WHERE
    document_kind = 'delivery_order' AND
    status = 'ready_to_ship' AND
    buyer_notification_state = 'pending';

CREATE INDEX commerce_delivery_orders_shipper_notifications_pending_owner_path
  ON commerce_documents (owner, document_path)
  WHERE
    document_kind = 'delivery_order' AND
    status = 'ready_to_ship' AND
    shipper_notification_state = 'pending';

PRAGMA optimize;
