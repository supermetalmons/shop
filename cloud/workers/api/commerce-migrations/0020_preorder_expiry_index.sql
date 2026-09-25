CREATE INDEX commerce_preorder_prepared_expiry
ON commerce_preorder_orders (expires_at_ms)
WHERE status = 'prepared';
