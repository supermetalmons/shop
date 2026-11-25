CREATE TABLE dmx_mainnet_bound_claim_codes (
  batch_id TEXT NOT NULL REFERENCES dmx_mainnet_claim_batches(batch_id),
  chain_id INTEGER NOT NULL CHECK (chain_id = 1),
  contract_address TEXT NOT NULL CHECK (length(contract_address) = 42 AND substr(contract_address, 1, 2) = '0x' AND substr(contract_address, 3) NOT GLOB '*[^0-9a-f]*' AND contract_address <> '0x0000000000000000000000000000000000000000'),
  token_id INTEGER NOT NULL CHECK (token_id BETWEEN 1 AND 777),
  code_hash TEXT NOT NULL CHECK (length(code_hash) = 64 AND code_hash NOT GLOB '*[^0-9a-f]*'),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  revoked_at_ms INTEGER CHECK (revoked_at_ms IS NULL OR revoked_at_ms >= created_at_ms),
  PRIMARY KEY (batch_id, token_id),
  UNIQUE (chain_id, contract_address, token_id),
  UNIQUE (chain_id, contract_address, code_hash)
) STRICT;
