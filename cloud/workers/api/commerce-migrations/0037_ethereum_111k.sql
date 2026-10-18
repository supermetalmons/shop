CREATE TABLE ethereum_delivery_quotes (
  chain_id INTEGER NOT NULL,
  contract_address TEXT NOT NULL,
  order_id INTEGER NOT NULL CHECK (order_id BETWEEN 1 AND 2147483647),
  request_id TEXT NOT NULL,
  wallet TEXT NOT NULL,
  address_id TEXT NOT NULL,
  address_json TEXT NOT NULL CHECK (json_valid(address_json)),
  token_ids_json TEXT NOT NULL CHECK (json_valid(token_ids_json)),
  items_json TEXT NOT NULL CHECK (json_valid(items_json)),
  fee_wei TEXT NOT NULL,
  deadline INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('prepared', 'pending', 'confirmed')),
  transaction_hash TEXT,
  block_number INTEGER,
  block_hash TEXT,
  published_at_ms INTEGER,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (chain_id, contract_address, order_id),
  UNIQUE (order_id),
  UNIQUE (chain_id, contract_address, wallet, request_id)
) STRICT;
CREATE INDEX ethereum_delivery_quotes_pending ON ethereum_delivery_quotes(status, updated_at_ms);
CREATE INDEX ethereum_delivery_quotes_wallet ON ethereum_delivery_quotes(wallet, created_at_ms);

CREATE TABLE ethereum_crate_claims (
  chain_id INTEGER NOT NULL,
  contract_address TEXT NOT NULL,
  receipt_id TEXT NOT NULL,
  crate_id INTEGER NOT NULL CHECK (crate_id BETWEEN 1 AND 5555),
  order_id INTEGER NOT NULL,
  code_hash TEXT NOT NULL,
  code TEXT NOT NULL,
  claim_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('available', 'pending', 'claimed')),
  transaction_hash TEXT,
  block_number INTEGER,
  block_hash TEXT,
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (chain_id, contract_address, receipt_id),
  UNIQUE (chain_id, contract_address, claim_id)
) STRICT;
CREATE INDEX ethereum_crate_claims_code ON ethereum_crate_claims(code_hash);
CREATE INDEX ethereum_crate_claims_pending ON ethereum_crate_claims(status, updated_at_ms);

CREATE TABLE ethereum_reconciliation_cursor (
  chain_id INTEGER NOT NULL,
  contract_address TEXT NOT NULL,
  next_block INTEGER NOT NULL,
  PRIMARY KEY (chain_id, contract_address)
) STRICT;
