CREATE TABLE commerce_preorder_asset_lookup (
  order_id TEXT NOT NULL REFERENCES commerce_preorder_orders(order_id),
  asset_ordinal INTEGER NOT NULL CHECK (asset_ordinal BETWEEN 0 AND 2),
  asset_address TEXT NOT NULL,
  PRIMARY KEY (order_id, asset_ordinal)
) STRICT;

CREATE INDEX commerce_preorder_asset_lookup_address
  ON commerce_preorder_asset_lookup (asset_address, order_id);

CREATE TRIGGER commerce_preorder_asset_lookup_insert_guard
BEFORE INSERT ON commerce_preorder_asset_lookup
BEGIN
  SELECT (CASE WHEN NOT EXISTS (
    SELECT 1 FROM commerce_preorder_orders AS preorder
    WHERE preorder.order_id = NEW.order_id
      AND json_type(preorder.assets_json, '$[' || NEW.asset_ordinal || '].address') = 'text'
      AND json_extract(preorder.assets_json, '$[' || NEW.asset_ordinal || '].address') = NEW.asset_address
  ) THEN RAISE(ABORT, 'invalid preorder asset lookup') END);
END;

CREATE TRIGGER commerce_preorder_asset_lookup_update_guard
BEFORE UPDATE ON commerce_preorder_asset_lookup
BEGIN
  SELECT RAISE(ABORT, 'preorder asset lookup is immutable');
END;

CREATE TRIGGER commerce_preorder_asset_lookup_delete_guard
BEFORE DELETE ON commerce_preorder_asset_lookup
BEGIN
  SELECT RAISE(ABORT, 'preorder asset lookup is permanent');
END;

CREATE TRIGGER commerce_preorder_order_asset_lookup
AFTER INSERT ON commerce_preorder_orders
BEGIN
  INSERT INTO commerce_preorder_asset_lookup (order_id, asset_ordinal, asset_address)
    SELECT NEW.order_id, asset.key, json_extract(NEW.assets_json, '$[' || asset.key || '].address')
    FROM json_each(NEW.assets_json) AS asset
    WHERE json_type(NEW.assets_json, '$[' || asset.key || '].address') = 'text';
END;

INSERT INTO commerce_preorder_asset_lookup (order_id, asset_ordinal, asset_address)
  SELECT preorder.order_id, asset.key, json_extract(preorder.assets_json, '$[' || asset.key || '].address')
  FROM commerce_preorder_orders AS preorder, json_each(preorder.assets_json) AS asset
  WHERE json_type(preorder.assets_json, '$[' || asset.key || '].address') = 'text';
