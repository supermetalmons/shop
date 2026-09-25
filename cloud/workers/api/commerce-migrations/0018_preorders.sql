CREATE TABLE commerce_preorder_orders (
  order_id TEXT PRIMARY KEY,
  preorder_id TEXT NOT NULL,
  cluster TEXT NOT NULL CHECK (cluster IN ('devnet', 'mainnet-beta')),
  collection TEXT NOT NULL,
  buyer TEXT NOT NULL,
  request_id TEXT NOT NULL,
  card_ids_json TEXT NOT NULL CHECK (json_valid(card_ids_json) AND json_array_length(card_ids_json) BETWEEN 1 AND 3),
  assets_json TEXT NOT NULL CHECK (json_valid(assets_json) AND json_array_length(assets_json) = json_array_length(card_ids_json)),
  status TEXT NOT NULL CHECK (status IN ('prepared', 'submitted', 'succeeded', 'failed', 'expired', 'cancelled')),
  prepared_transaction TEXT NOT NULL,
  signed_transaction TEXT,
  signature TEXT,
  blockhash TEXT NOT NULL,
  blockhash_context_slot INTEGER NOT NULL CHECK (blockhash_context_slot >= 0),
  last_valid_block_height INTEGER NOT NULL CHECK (last_valid_block_height >= 0),
  expires_at_ms INTEGER NOT NULL,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  next_check_at_ms INTEGER NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  UNIQUE (preorder_id, buyer, request_id),
  CHECK (expires_at_ms > created_at_ms),
  CHECK ((signed_transaction IS NULL) = (signature IS NULL)),
  CHECK (status NOT IN ('submitted', 'succeeded', 'failed') OR signature IS NOT NULL),
  CHECK (status NOT IN ('prepared', 'cancelled') OR signature IS NULL)
) STRICT;

CREATE UNIQUE INDEX commerce_preorder_active_buyer
  ON commerce_preorder_orders (cluster, collection, buyer)
  WHERE status IN ('prepared', 'submitted');

CREATE INDEX commerce_preorder_reconciliation
  ON commerce_preorder_orders (next_check_at_ms, order_id)
  WHERE status IN ('prepared', 'submitted');

CREATE TABLE commerce_preorder_claims (
  cluster TEXT NOT NULL,
  collection TEXT NOT NULL,
  card_id INTEGER NOT NULL CHECK (card_id BETWEEN 1 AND 1395),
  order_id TEXT NOT NULL REFERENCES commerce_preorder_orders(order_id),
  PRIMARY KEY (cluster, collection, card_id)
) STRICT;

CREATE INDEX commerce_preorder_claim_order ON commerce_preorder_claims (order_id);

CREATE TRIGGER commerce_preorder_order_insert_guard BEFORE INSERT ON commerce_preorder_orders
BEGIN
  SELECT (CASE WHEN COALESCE((SELECT authority_state FROM commerce_authority_control WHERE singleton = 1), '') <> 'd1'
    THEN RAISE(ABORT, 'commerce authority is not d1') END);
  SELECT (CASE WHEN NEW.status <> 'prepared' OR NEW.signature IS NOT NULL
    THEN RAISE(ABORT, 'invalid preorder initial state') END);
END;

CREATE TRIGGER commerce_preorder_order_update_guard BEFORE UPDATE ON commerce_preorder_orders
BEGIN
  SELECT (CASE WHEN COALESCE((SELECT authority_state FROM commerce_authority_control WHERE singleton = 1), '') <> 'd1'
    THEN RAISE(ABORT, 'commerce authority is not d1') END);
  SELECT (CASE WHEN NEW.order_id IS NOT OLD.order_id OR NEW.preorder_id IS NOT OLD.preorder_id OR
    NEW.cluster IS NOT OLD.cluster OR NEW.collection IS NOT OLD.collection OR NEW.buyer IS NOT OLD.buyer OR
    NEW.request_id IS NOT OLD.request_id OR NEW.card_ids_json IS NOT OLD.card_ids_json OR NEW.assets_json IS NOT OLD.assets_json OR
    NEW.prepared_transaction IS NOT OLD.prepared_transaction OR NEW.blockhash IS NOT OLD.blockhash OR
    NEW.blockhash_context_slot IS NOT OLD.blockhash_context_slot OR NEW.last_valid_block_height IS NOT OLD.last_valid_block_height OR
    NEW.expires_at_ms IS NOT OLD.expires_at_ms OR NEW.created_at_ms IS NOT OLD.created_at_ms OR NEW.revision <> OLD.revision + 1
    THEN RAISE(ABORT, 'preorder identity is immutable') END);
  SELECT (CASE WHEN NOT (
    (OLD.status = 'prepared' AND NEW.status IN ('submitted', 'expired', 'cancelled')) OR
    (OLD.status = 'submitted' AND NEW.status IN ('submitted', 'succeeded', 'failed', 'expired'))
  ) THEN RAISE(ABORT, 'invalid preorder transition') END);
  SELECT (CASE WHEN OLD.signature IS NOT NULL AND
    (NEW.signature IS NOT OLD.signature OR NEW.signed_transaction IS NOT OLD.signed_transaction)
    THEN RAISE(ABORT, 'preorder submission is immutable') END);
END;

CREATE TRIGGER commerce_preorder_order_delete_guard BEFORE DELETE ON commerce_preorder_orders
BEGIN
  SELECT RAISE(ABORT, 'preorder history is permanent');
END;

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
