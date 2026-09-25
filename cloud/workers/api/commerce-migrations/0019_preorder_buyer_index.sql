CREATE INDEX commerce_preorder_succeeded_buyer
ON commerce_preorder_orders (buyer, created_at_ms DESC)
WHERE status = 'succeeded';
