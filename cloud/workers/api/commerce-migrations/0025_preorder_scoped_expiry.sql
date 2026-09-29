DROP INDEX commerce_preorder_prepared_expiry;

CREATE INDEX commerce_preorder_prepared_expiry
ON commerce_preorder_orders (cluster, collection, expires_at_ms)
WHERE status = 'prepared';
