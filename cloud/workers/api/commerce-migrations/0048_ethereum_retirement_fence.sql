CREATE TABLE ethereum_111k_retirements (
  operation_id TEXT PRIMARY KEY NOT NULL CHECK (length(operation_id) BETWEEN 1 AND 256),
  deployment_id TEXT NOT NULL,
  expected_revision INTEGER NOT NULL CHECK (expected_revision BETWEEN 1 AND 9007199254740991),
  replacement_deployment_id TEXT NOT NULL,
  expected_replacement_revision INTEGER NOT NULL CHECK (expected_replacement_revision BETWEEN 1 AND 9007199254740991),
  chain_id INTEGER NOT NULL CHECK (chain_id = 11155111),
  contract_address TEXT NOT NULL CHECK (length(contract_address) = 42 AND substr(contract_address,1,2) = '0x'
    AND substr(contract_address,3) NOT GLOB '*[^0-9a-f]*' AND contract_address <> '0x0000000000000000000000000000000000000000'),
  replacement_contract_address TEXT NOT NULL CHECK (length(replacement_contract_address) = 42 AND substr(replacement_contract_address,1,2) = '0x'
    AND substr(replacement_contract_address,3) NOT GLOB '*[^0-9a-f]*' AND replacement_contract_address <> '0x0000000000000000000000000000000000000000'),
  state TEXT NOT NULL CHECK (state IN ('pending','retired','cancelled')),
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  UNIQUE (chain_id,contract_address,expected_revision),
  CHECK (contract_address <> replacement_contract_address AND deployment_id <> replacement_deployment_id)
) STRICT;

CREATE UNIQUE INDEX ethereum_111k_retirement_pending
ON ethereum_111k_retirements((1)) WHERE state='pending';

CREATE INDEX ethereum_111k_retirement_scope
ON ethereum_111k_retirements(chain_id,contract_address,state);

CREATE TRIGGER ethereum_111k_retirement_insert_guard
BEFORE INSERT ON ethereum_111k_retirements
WHEN (NEW.state='pending' AND NOT EXISTS (
  SELECT 1 FROM ethereum_111k_control WHERE singleton=1 AND paused=0 AND reset_guard_id IS NULL
    AND chain_id=NEW.chain_id AND contract_address=NEW.replacement_contract_address
)) OR (NEW.state='retired' AND EXISTS (
  SELECT 1 FROM ethereum_111k_control WHERE singleton=1 AND chain_id=NEW.chain_id AND contract_address=NEW.contract_address
))
BEGIN
  SELECT RAISE(ABORT, 'ethereum retirement replacement commerce scope changed');
END;

CREATE TRIGGER ethereum_111k_retirement_immutable
BEFORE UPDATE ON ethereum_111k_retirements
WHEN NEW.operation_id IS NOT OLD.operation_id OR NEW.deployment_id IS NOT OLD.deployment_id
  OR NEW.expected_revision IS NOT OLD.expected_revision OR NEW.replacement_deployment_id IS NOT OLD.replacement_deployment_id
  OR NEW.expected_replacement_revision IS NOT OLD.expected_replacement_revision OR NEW.chain_id IS NOT OLD.chain_id
  OR NEW.contract_address IS NOT OLD.contract_address OR NEW.replacement_contract_address IS NOT OLD.replacement_contract_address
  OR NEW.created_at_ms IS NOT OLD.created_at_ms
  OR (OLD.state <> 'pending' AND NEW.state <> OLD.state)
BEGIN
  SELECT RAISE(ABORT, 'ethereum retirement operation is immutable');
END;

CREATE TRIGGER ethereum_111k_retirement_no_delete
BEFORE DELETE ON ethereum_111k_retirements
BEGIN
  SELECT RAISE(ABORT, 'ethereum retirement operation history is permanent');
END;

CREATE TRIGGER ethereum_111k_control_retirement_guard
BEFORE UPDATE ON ethereum_111k_control
WHEN EXISTS (SELECT 1 FROM ethereum_111k_retirements WHERE state='pending')
  OR EXISTS (SELECT 1 FROM ethereum_111k_retirements
    WHERE state='retired' AND chain_id=NEW.chain_id AND contract_address=NEW.contract_address)
BEGIN
  SELECT RAISE(ABORT, 'ethereum retirement blocks this commerce control transition');
END;
