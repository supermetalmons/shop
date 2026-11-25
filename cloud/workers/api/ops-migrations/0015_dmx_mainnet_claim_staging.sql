CREATE TABLE dmx_mainnet_claim_batches (
  batch_id TEXT PRIMARY KEY NOT NULL CHECK (
    length(batch_id) = 36
    AND batch_id GLOB '????????-????-4???-[89ab]???-????????????'
    AND batch_id NOT GLOB '*[^0-9a-f-]*'
    AND length(replace(batch_id, '-', '')) = 32
  ),
  chain_id INTEGER NOT NULL CHECK (chain_id = 1),
  collection_key TEXT NOT NULL UNIQUE CHECK (collection_key = 'dmx-mainnet-v1'),
  status TEXT NOT NULL CHECK (status IN ('preparing', 'staged', 'bound')),
  contract_address TEXT CHECK (
    contract_address IS NULL OR (
      length(contract_address) = 42
      AND substr(contract_address, 1, 2) = '0x'
      AND substr(contract_address, 3) NOT GLOB '*[^0-9a-f]*'
      AND contract_address <> '0x0000000000000000000000000000000000000000'
    )
  ),
  credential_count INTEGER NOT NULL CHECK (credential_count = 777),
  credential_set_sha256 TEXT NOT NULL CHECK (length(credential_set_sha256) = 64 AND credential_set_sha256 NOT GLOB '*[^0-9a-f]*'),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  verified_at_ms INTEGER CHECK (verified_at_ms IS NULL OR verified_at_ms >= created_at_ms),
  bound_at_ms INTEGER CHECK (bound_at_ms IS NULL OR (verified_at_ms IS NOT NULL AND bound_at_ms >= verified_at_ms)),
  CHECK (
    (status = 'preparing' AND verified_at_ms IS NULL AND contract_address IS NULL AND bound_at_ms IS NULL)
    OR (status = 'staged' AND verified_at_ms IS NOT NULL AND contract_address IS NULL AND bound_at_ms IS NULL)
    OR (status = 'bound' AND verified_at_ms IS NOT NULL AND contract_address IS NOT NULL AND bound_at_ms IS NOT NULL)
  )
) STRICT;

CREATE TABLE dmx_mainnet_claim_codes (
  batch_id TEXT NOT NULL REFERENCES dmx_mainnet_claim_batches(batch_id),
  token_id INTEGER NOT NULL CHECK (token_id BETWEEN 1 AND 777),
  code_hash TEXT NOT NULL CHECK (length(code_hash) = 64 AND code_hash NOT GLOB '*[^0-9a-f]*'),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  revoked_at_ms INTEGER CHECK (revoked_at_ms IS NULL OR revoked_at_ms >= created_at_ms),
  PRIMARY KEY (batch_id, token_id),
  UNIQUE (batch_id, code_hash)
) STRICT;
