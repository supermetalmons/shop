ALTER TABLE commerce_preorder_orders ADD COLUMN confirmed_slot INTEGER
  CHECK (confirmed_slot IS NULL OR (
    confirmed_slot BETWEEN 0 AND 9007199254740991 AND status IN ('submitted', 'succeeded', 'failed', 'expired')
  ));

DROP INDEX commerce_preorder_active_buyer;

CREATE UNIQUE INDEX commerce_preorder_active_buyer
  ON commerce_preorder_orders (cluster, collection, buyer)
  WHERE status = 'prepared' OR (status = 'submitted' AND confirmed_slot IS NULL);

CREATE INDEX commerce_preorder_confirmed_recovery
  ON commerce_preorder_orders (preorder_id, buyer, created_at_ms, order_id)
  WHERE status = 'submitted' AND confirmed_slot IS NOT NULL;

CREATE INDEX commerce_preorder_inventory_buyer
  ON commerce_preorder_orders (buyer, created_at_ms DESC)
  WHERE status = 'succeeded' OR (status = 'submitted' AND confirmed_slot IS NOT NULL);

CREATE TRIGGER commerce_preorder_confirmation_guard BEFORE UPDATE ON commerce_preorder_orders
BEGIN
  SELECT (CASE WHEN NEW.confirmed_slot IS NOT OLD.confirmed_slot AND NOT (
    OLD.status = 'submitted' AND NEW.status IN ('submitted', 'succeeded') AND
    NEW.confirmed_slot IS NOT NULL AND (OLD.confirmed_slot IS NULL OR
      (NEW.status = 'succeeded' AND NEW.confirmed_slot >= OLD.confirmed_slot))
  ) THEN RAISE(ABORT, 'preorder confirmation is permanent') END);
END;
