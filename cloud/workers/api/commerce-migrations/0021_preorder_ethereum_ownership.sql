ALTER TABLE commerce_preorder_orders ADD COLUMN ethereum_address TEXT
  CHECK (ethereum_address IS NULL OR (
    length(ethereum_address) = 42 AND substr(ethereum_address, 1, 2) = '0x' AND
    substr(ethereum_address, 3) NOT GLOB '*[^0-9a-f]*'
  ));

DROP TRIGGER commerce_preorder_order_insert_guard;
DROP TRIGGER commerce_preorder_order_update_guard;

CREATE TRIGGER commerce_preorder_order_insert_guard BEFORE INSERT ON commerce_preorder_orders
BEGIN
  SELECT (CASE WHEN COALESCE((SELECT authority_state FROM commerce_authority_control WHERE singleton = 1), '') <> 'd1'
    THEN RAISE(ABORT, 'commerce authority is not d1') END);
  SELECT (CASE WHEN NEW.status <> 'prepared' OR NEW.signature IS NOT NULL OR NEW.ethereum_address IS NULL
    THEN RAISE(ABORT, 'invalid preorder initial state') END);
END;

CREATE TRIGGER commerce_preorder_order_update_guard BEFORE UPDATE ON commerce_preorder_orders
BEGIN
  SELECT (CASE WHEN COALESCE((SELECT authority_state FROM commerce_authority_control WHERE singleton = 1), '') <> 'd1'
    THEN RAISE(ABORT, 'commerce authority is not d1') END);
  SELECT (CASE WHEN NEW.order_id IS NOT OLD.order_id OR NEW.preorder_id IS NOT OLD.preorder_id OR
    NEW.cluster IS NOT OLD.cluster OR NEW.collection IS NOT OLD.collection OR NEW.buyer IS NOT OLD.buyer OR
    NEW.ethereum_address IS NOT OLD.ethereum_address OR NEW.request_id IS NOT OLD.request_id OR NEW.card_ids_json IS NOT OLD.card_ids_json OR NEW.assets_json IS NOT OLD.assets_json OR
    NEW.prepared_transaction IS NOT OLD.prepared_transaction OR NEW.blockhash IS NOT OLD.blockhash OR
    NEW.blockhash_context_slot IS NOT OLD.blockhash_context_slot OR NEW.last_valid_block_height IS NOT OLD.last_valid_block_height OR
    NEW.expires_at_ms IS NOT OLD.expires_at_ms OR NEW.created_at_ms IS NOT OLD.created_at_ms OR NEW.revision <> OLD.revision + 1
    THEN RAISE(ABORT, 'preorder identity is immutable') END);
  SELECT (CASE WHEN NOT (
    (OLD.status = 'prepared' AND (NEW.status IN ('expired', 'cancelled') OR
      (NEW.status = 'submitted' AND NEW.ethereum_address IS NOT NULL))) OR
    (OLD.status = 'submitted' AND NEW.status IN ('submitted', 'succeeded', 'failed', 'expired'))
  ) THEN RAISE(ABORT, 'invalid preorder transition') END);
  SELECT (CASE WHEN OLD.signature IS NOT NULL AND
    (NEW.signature IS NOT OLD.signature OR NEW.signed_transaction IS NOT OLD.signed_transaction)
    THEN RAISE(ABORT, 'preorder submission is immutable') END);
END;
