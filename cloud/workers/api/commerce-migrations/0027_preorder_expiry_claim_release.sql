CREATE TRIGGER commerce_preorder_expiry_claim_release
AFTER UPDATE OF status ON commerce_preorder_orders
WHEN OLD.status = 'prepared' AND NEW.status = 'expired' AND NEW.signature IS NULL
BEGIN
  DELETE FROM commerce_preorder_claims WHERE order_id = NEW.order_id;
END;
