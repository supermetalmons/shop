CREATE TABLE dmx_retired_sepolia_deployments (
  chain_id INTEGER NOT NULL CHECK (chain_id = 11155111),
  contract_address TEXT NOT NULL CHECK (
    length(contract_address) = 42
    AND substr(contract_address, 1, 2) = '0x'
    AND substr(contract_address, 3) NOT GLOB '*[^0-9a-f]*'
    AND contract_address <> '0x0000000000000000000000000000000000000000'
  ),
  replacement_contract_address TEXT NOT NULL CHECK (
    length(replacement_contract_address) = 42
    AND substr(replacement_contract_address, 1, 2) = '0x'
    AND substr(replacement_contract_address, 3) NOT GLOB '*[^0-9a-f]*'
    AND replacement_contract_address <> '0x0000000000000000000000000000000000000000'
    AND replacement_contract_address <> contract_address
  ),
  retired_at_ms INTEGER NOT NULL CHECK (retired_at_ms BETWEEN 1 AND 9007199254740991),
  PRIMARY KEY (chain_id, contract_address)
) STRICT;

CREATE TRIGGER dmx_retired_sepolia_deployments_insert_guard
BEFORE INSERT ON dmx_retired_sepolia_deployments
WHEN EXISTS (
  SELECT 1 FROM dmx_retired_sepolia_deployments
  WHERE chain_id = NEW.chain_id AND contract_address = NEW.contract_address
)
BEGIN
  SELECT RAISE(ABORT, 'DMX Sepolia retirement is immutable');
END;

CREATE TRIGGER dmx_retired_sepolia_deployments_update_guard
BEFORE UPDATE ON dmx_retired_sepolia_deployments
BEGIN
  SELECT RAISE(ABORT, 'DMX Sepolia retirement is immutable');
END;

CREATE TRIGGER dmx_retired_sepolia_deployments_delete_guard
BEFORE DELETE ON dmx_retired_sepolia_deployments
BEGIN
  SELECT RAISE(ABORT, 'DMX Sepolia retirement is immutable');
END;

CREATE TRIGGER tarot_claim_codes_retired_insert_guard
BEFORE INSERT ON tarot_claim_codes
WHEN EXISTS (
  SELECT 1 FROM dmx_retired_sepolia_deployments
  WHERE chain_id = NEW.chain_id AND contract_address = NEW.contract_address
)
BEGIN
  SELECT RAISE(ABORT, 'Retired DMX Sepolia credentials cannot be written');
END;

CREATE TRIGGER tarot_claim_codes_retired_update_guard
BEFORE UPDATE ON tarot_claim_codes
WHEN EXISTS (
  SELECT 1 FROM dmx_retired_sepolia_deployments
  WHERE (chain_id = OLD.chain_id AND contract_address = OLD.contract_address)
    OR (chain_id = NEW.chain_id AND contract_address = NEW.contract_address)
)
BEGIN
  SELECT RAISE(ABORT, 'Retired DMX Sepolia credentials cannot be written');
END;
