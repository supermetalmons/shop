CREATE TABLE commerce_preorder_claims_new (
  cluster TEXT NOT NULL,
  collection TEXT NOT NULL,
  card_id INTEGER NOT NULL CHECK (card_id BETWEEN 1 AND 1398),
  order_id TEXT NOT NULL REFERENCES commerce_preorder_orders(order_id),
  PRIMARY KEY (cluster, collection, card_id)
) STRICT;

INSERT INTO commerce_preorder_claims_new (cluster, collection, card_id, order_id)
SELECT cluster, collection, card_id, order_id FROM commerce_preorder_claims;

DROP TABLE commerce_preorder_claims;

ALTER TABLE commerce_preorder_claims_new RENAME TO commerce_preorder_claims;

CREATE INDEX commerce_preorder_claim_order ON commerce_preorder_claims (order_id);

CREATE TRIGGER commerce_preorder_claim_insert_guard BEFORE INSERT ON commerce_preorder_claims
BEGIN
  SELECT (CASE WHEN COALESCE((SELECT authority_state FROM commerce_authority_control WHERE singleton = 1), '') <> 'd1'
    THEN RAISE(ABORT, 'commerce authority is not d1') END);
  SELECT (CASE WHEN NOT EXISTS (
    SELECT 1 FROM commerce_preorder_orders AS orders, json_each(orders.card_ids_json) AS ids
    WHERE orders.order_id = NEW.order_id AND orders.status = 'prepared' AND
      orders.cluster = NEW.cluster AND orders.collection = NEW.collection AND ids.value = NEW.card_id
  ) THEN RAISE(ABORT, 'invalid preorder claim') END);
END;

CREATE TRIGGER commerce_preorder_claim_update_guard BEFORE UPDATE ON commerce_preorder_claims
BEGIN
  SELECT RAISE(ABORT, 'preorder claim is immutable');
END;

CREATE TRIGGER commerce_preorder_claim_delete_guard BEFORE DELETE ON commerce_preorder_claims
BEGIN
  SELECT (CASE WHEN COALESCE((SELECT authority_state FROM commerce_authority_control WHERE singleton = 1), '') <> 'd1'
    THEN RAISE(ABORT, 'commerce authority is not d1') END);
  SELECT (CASE WHEN NOT EXISTS (
    SELECT 1 FROM commerce_preorder_orders WHERE order_id = OLD.order_id AND status IN ('failed', 'expired', 'cancelled')
  ) THEN RAISE(ABORT, 'active or sold preorder claim is permanent') END);
END;
