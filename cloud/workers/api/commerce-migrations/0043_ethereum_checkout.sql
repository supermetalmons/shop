CREATE TABLE ethereum_delivery_checkouts (
  checkout_id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL UNIQUE,
  origin TEXT NOT NULL,
  drop_id TEXT NOT NULL,
  chain_id INTEGER NOT NULL,
  contract_address TEXT NOT NULL,
  token_ids_json TEXT NOT NULL CHECK (json_valid(token_ids_json)),
  items_json TEXT NOT NULL CHECK (json_valid(items_json)),
  callback_url TEXT NOT NULL,
  callback_state TEXT,
  created_block INTEGER NOT NULL,
  created_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL
) STRICT;
CREATE INDEX ethereum_delivery_checkouts_expiry ON ethereum_delivery_checkouts(chain_id, contract_address, expires_at_ms, checkout_id);

ALTER TABLE ethereum_delivery_quotes ADD COLUMN checkout_id TEXT REFERENCES ethereum_delivery_checkouts(checkout_id);
CREATE UNIQUE INDEX ethereum_delivery_quotes_checkout ON ethereum_delivery_quotes(checkout_id) WHERE checkout_id IS NOT NULL;

CREATE TABLE ethereum_delivery_checkout_attempts (
  attempt_id TEXT PRIMARY KEY,
  checkout_id TEXT NOT NULL REFERENCES ethereum_delivery_checkouts(checkout_id),
  order_id INTEGER NOT NULL REFERENCES ethereum_delivery_quotes(order_id),
  wallet TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('started', 'submitted', 'rejected', 'reverted', 'failed', 'superseded', 'expired')),
  transaction_hash TEXT,
  quote_deadline INTEGER NOT NULL,
  expected_nonce TEXT,
  transaction_nonce TEXT,
  transaction_sender TEXT,
  block_number INTEGER,
  block_hash TEXT,
  verified_at_block INTEGER,
  checked_at_ms INTEGER NOT NULL DEFAULT 0,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  CHECK (status IN ('superseded', 'expired') OR (status IN ('started', 'rejected') AND transaction_hash IS NULL) OR
    (status IN ('submitted', 'reverted', 'failed') AND transaction_hash IS NOT NULL))
) STRICT;
CREATE UNIQUE INDEX ethereum_delivery_checkout_attempts_active ON ethereum_delivery_checkout_attempts(checkout_id)
  WHERE status IN ('started', 'submitted');
CREATE INDEX ethereum_delivery_checkout_attempts_history ON ethereum_delivery_checkout_attempts(checkout_id, created_at_ms DESC);
CREATE INDEX ethereum_delivery_checkout_attempts_reconcile ON ethereum_delivery_checkout_attempts(status, checked_at_ms)
  WHERE status IN ('started', 'submitted', 'reverted', 'failed');

CREATE TRIGGER ethereum_delivery_checkouts_control_insert
BEFORE INSERT ON ethereum_delivery_checkouts
WHEN NOT EXISTS (SELECT 1 FROM ethereum_111k_control AS control WHERE control.singleton = 1
  AND control.paused = 0 AND control.reset_guard_id IS NULL AND control.chain_id = NEW.chain_id
  AND control.contract_address = NEW.contract_address)
BEGIN
  SELECT RAISE(ABORT, 'ethereum 111k is paused or scope is unavailable');
END;

CREATE TRIGGER ethereum_delivery_checkouts_immutable
BEFORE UPDATE ON ethereum_delivery_checkouts
BEGIN
  SELECT RAISE(ABORT, 'ethereum checkout details are immutable');
END;

CREATE TRIGGER ethereum_delivery_checkouts_control_delete
BEFORE DELETE ON ethereum_delivery_checkouts
WHEN NOT EXISTS (SELECT 1 FROM ethereum_111k_control AS control WHERE control.singleton = 1
  AND ((control.paused = 0 AND control.reset_guard_id IS NULL) OR (control.paused = 1 AND EXISTS
    (SELECT 1 FROM commerce_commit_guards AS guard WHERE guard.guard_id = control.reset_guard_id)))
  AND control.chain_id = OLD.chain_id AND control.contract_address = OLD.contract_address)
BEGIN
  SELECT RAISE(ABORT, 'ethereum 111k is paused or scope is unavailable');
END;

CREATE TRIGGER ethereum_delivery_quotes_checkout_insert
BEFORE INSERT ON ethereum_delivery_quotes
WHEN NEW.checkout_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM ethereum_delivery_checkouts AS checkout
  WHERE checkout.checkout_id = NEW.checkout_id AND checkout.chain_id = NEW.chain_id
    AND checkout.contract_address = NEW.contract_address AND checkout.token_ids_json = NEW.token_ids_json)
BEGIN
  SELECT RAISE(ABORT, 'ethereum checkout identity does not match');
END;

CREATE TRIGGER ethereum_delivery_quotes_checkout_immutable
BEFORE UPDATE OF checkout_id ON ethereum_delivery_quotes
WHEN NEW.checkout_id IS NOT OLD.checkout_id
BEGIN
  SELECT RAISE(ABORT, 'ethereum checkout quote binding is immutable');
END;

CREATE TRIGGER ethereum_delivery_checkout_attempts_control_insert
BEFORE INSERT ON ethereum_delivery_checkout_attempts
WHEN NOT EXISTS (SELECT 1 FROM ethereum_delivery_quotes AS quote JOIN ethereum_111k_control AS control
  ON control.singleton = 1 AND control.chain_id = quote.chain_id AND control.contract_address = quote.contract_address
  WHERE control.paused = 0 AND control.reset_guard_id IS NULL AND quote.order_id = NEW.order_id
    AND quote.checkout_id = NEW.checkout_id AND quote.wallet = NEW.wallet)
BEGIN
  SELECT RAISE(ABORT, 'ethereum 111k is paused or scope is unavailable');
END;

CREATE TRIGGER ethereum_delivery_checkout_attempts_control_update
BEFORE UPDATE ON ethereum_delivery_checkout_attempts
WHEN NOT EXISTS (SELECT 1 FROM ethereum_delivery_quotes AS quote JOIN ethereum_111k_control AS control
  ON control.singleton = 1 AND control.chain_id = quote.chain_id AND control.contract_address = quote.contract_address
  WHERE control.paused = 0 AND control.reset_guard_id IS NULL AND quote.order_id = OLD.order_id
    AND quote.checkout_id = OLD.checkout_id AND quote.wallet = OLD.wallet)
  OR NEW.attempt_id != OLD.attempt_id OR NEW.checkout_id != OLD.checkout_id OR NEW.order_id != OLD.order_id
  OR NEW.wallet != OLD.wallet OR NEW.quote_deadline != OLD.quote_deadline OR NEW.expected_nonce IS NOT OLD.expected_nonce
BEGIN
  SELECT RAISE(ABORT, 'ethereum 111k is paused or scope is unavailable');
END;

CREATE TRIGGER ethereum_delivery_checkout_attempts_control_delete
BEFORE DELETE ON ethereum_delivery_checkout_attempts
WHEN NOT EXISTS (SELECT 1 FROM ethereum_delivery_quotes AS quote JOIN ethereum_111k_control AS control
  ON control.singleton = 1 AND control.chain_id = quote.chain_id AND control.contract_address = quote.contract_address
  WHERE quote.order_id = OLD.order_id AND ((control.paused = 0 AND control.reset_guard_id IS NULL)
    OR (control.paused = 1 AND EXISTS (SELECT 1 FROM commerce_commit_guards AS guard WHERE guard.guard_id = control.reset_guard_id))))
BEGIN
  SELECT RAISE(ABORT, 'ethereum 111k is paused or scope is unavailable');
END;

PRAGMA optimize;
