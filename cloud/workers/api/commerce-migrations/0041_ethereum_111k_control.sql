CREATE TABLE ethereum_111k_control (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  paused INTEGER NOT NULL CHECK (paused IN (0, 1)),
  revision INTEGER NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740991),
  paused_at_ms INTEGER CHECK (paused_at_ms IS NULL OR paused_at_ms BETWEEN 0 AND 9007199254740991),
  chain_id INTEGER CHECK (chain_id IS NULL OR chain_id BETWEEN 1 AND 9007199254740991),
  contract_address TEXT CHECK (contract_address IS NULL OR (
    length(contract_address) = 42 AND substr(contract_address, 1, 2) = '0x'
    AND substr(contract_address, 3) NOT GLOB '*[^0-9a-f]*' AND contract_address <> '0x0000000000000000000000000000000000000000')),
  reset_guard_id TEXT CHECK (reset_guard_id IS NULL OR length(reset_guard_id) BETWEEN 1 AND 128),
  last_reset_id TEXT CHECK (last_reset_id IS NULL OR length(last_reset_id) BETWEEN 1 AND 128),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms BETWEEN 0 AND 9007199254740991),
  CHECK ((chain_id IS NULL) = (contract_address IS NULL)),
  CHECK ((paused = 1) = (paused_at_ms IS NOT NULL)),
  CHECK (paused = 1 OR (chain_id IS NOT NULL AND reset_guard_id IS NULL))
) STRICT;

INSERT INTO ethereum_111k_control
  (singleton, paused, revision, paused_at_ms, chain_id, contract_address, reset_guard_id, last_reset_id, updated_at_ms)
VALUES (1, 1, 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000,
  NULL, NULL, NULL, NULL, CAST(strftime('%s', 'now') AS INTEGER) * 1000);

CREATE TRIGGER ethereum_111k_control_insert_guard
BEFORE INSERT ON ethereum_111k_control
BEGIN
  SELECT RAISE(ABORT, 'ethereum 111k control cannot be inserted');
END;

CREATE TRIGGER ethereum_111k_control_delete_guard
BEFORE DELETE ON ethereum_111k_control
BEGIN
  SELECT RAISE(ABORT, 'ethereum 111k control cannot be deleted');
END;

CREATE TRIGGER ethereum_delivery_quotes_control_insert
BEFORE INSERT ON ethereum_delivery_quotes
WHEN NOT EXISTS (SELECT 1 FROM ethereum_111k_control AS control WHERE control.singleton = 1 AND control.paused = 0 AND control.reset_guard_id IS NULL AND control.chain_id = NEW.chain_id AND control.contract_address = NEW.contract_address)
BEGIN
  SELECT RAISE(ABORT, 'ethereum 111k is paused or scope is unavailable');
END;

CREATE TRIGGER ethereum_delivery_quotes_control_update
BEFORE UPDATE ON ethereum_delivery_quotes
WHEN NOT EXISTS (SELECT 1 FROM ethereum_111k_control AS control WHERE control.singleton = 1 AND control.paused = 0 AND control.reset_guard_id IS NULL AND control.chain_id = OLD.chain_id AND control.contract_address = OLD.contract_address) OR NOT EXISTS (SELECT 1 FROM ethereum_111k_control AS control WHERE control.singleton = 1 AND control.paused = 0 AND control.reset_guard_id IS NULL AND control.chain_id = NEW.chain_id AND control.contract_address = NEW.contract_address)
BEGIN
  SELECT RAISE(ABORT, 'ethereum 111k is paused or scope is unavailable');
END;

CREATE TRIGGER ethereum_delivery_quotes_control_delete
BEFORE DELETE ON ethereum_delivery_quotes
WHEN NOT EXISTS (SELECT 1 FROM ethereum_111k_control AS control WHERE control.singleton = 1 AND ((control.paused = 0 AND control.reset_guard_id IS NULL) OR (control.paused = 1 AND EXISTS (SELECT 1 FROM commerce_commit_guards AS guard WHERE guard.guard_id = control.reset_guard_id))) AND control.chain_id = OLD.chain_id AND control.contract_address = OLD.contract_address)
BEGIN
  SELECT RAISE(ABORT, 'ethereum 111k is paused or scope is unavailable');
END;

CREATE TRIGGER ethereum_crate_claims_control_insert
BEFORE INSERT ON ethereum_crate_claims
WHEN NOT EXISTS (SELECT 1 FROM ethereum_111k_control AS control WHERE control.singleton = 1 AND control.paused = 0 AND control.reset_guard_id IS NULL AND control.chain_id = NEW.chain_id AND control.contract_address = NEW.contract_address)
BEGIN
  SELECT RAISE(ABORT, 'ethereum 111k is paused or scope is unavailable');
END;

CREATE TRIGGER ethereum_crate_claims_control_update
BEFORE UPDATE ON ethereum_crate_claims
WHEN NOT EXISTS (SELECT 1 FROM ethereum_111k_control AS control WHERE control.singleton = 1 AND control.paused = 0 AND control.reset_guard_id IS NULL AND control.chain_id = OLD.chain_id AND control.contract_address = OLD.contract_address) OR NOT EXISTS (SELECT 1 FROM ethereum_111k_control AS control WHERE control.singleton = 1 AND control.paused = 0 AND control.reset_guard_id IS NULL AND control.chain_id = NEW.chain_id AND control.contract_address = NEW.contract_address)
BEGIN
  SELECT RAISE(ABORT, 'ethereum 111k is paused or scope is unavailable');
END;

CREATE TRIGGER ethereum_crate_claims_control_delete
BEFORE DELETE ON ethereum_crate_claims
WHEN NOT EXISTS (SELECT 1 FROM ethereum_111k_control AS control WHERE control.singleton = 1 AND ((control.paused = 0 AND control.reset_guard_id IS NULL) OR (control.paused = 1 AND EXISTS (SELECT 1 FROM commerce_commit_guards AS guard WHERE guard.guard_id = control.reset_guard_id))) AND control.chain_id = OLD.chain_id AND control.contract_address = OLD.contract_address)
BEGIN
  SELECT RAISE(ABORT, 'ethereum 111k is paused or scope is unavailable');
END;

CREATE TRIGGER ethereum_reconciliation_cursor_control_insert
BEFORE INSERT ON ethereum_reconciliation_cursor
WHEN NOT EXISTS (SELECT 1 FROM ethereum_111k_control AS control WHERE control.singleton = 1 AND control.paused = 0 AND control.reset_guard_id IS NULL AND control.chain_id = NEW.chain_id AND control.contract_address = NEW.contract_address)
BEGIN
  SELECT RAISE(ABORT, 'ethereum 111k is paused or scope is unavailable');
END;

CREATE TRIGGER ethereum_reconciliation_cursor_control_update
BEFORE UPDATE ON ethereum_reconciliation_cursor
WHEN NOT EXISTS (SELECT 1 FROM ethereum_111k_control AS control WHERE control.singleton = 1 AND control.paused = 0 AND control.reset_guard_id IS NULL AND control.chain_id = OLD.chain_id AND control.contract_address = OLD.contract_address) OR NOT EXISTS (SELECT 1 FROM ethereum_111k_control AS control WHERE control.singleton = 1 AND control.paused = 0 AND control.reset_guard_id IS NULL AND control.chain_id = NEW.chain_id AND control.contract_address = NEW.contract_address)
BEGIN
  SELECT RAISE(ABORT, 'ethereum 111k is paused or scope is unavailable');
END;

CREATE TRIGGER ethereum_reconciliation_cursor_control_delete
BEFORE DELETE ON ethereum_reconciliation_cursor
WHEN NOT EXISTS (SELECT 1 FROM ethereum_111k_control AS control WHERE control.singleton = 1 AND ((control.paused = 0 AND control.reset_guard_id IS NULL) OR (control.paused = 1 AND EXISTS (SELECT 1 FROM commerce_commit_guards AS guard WHERE guard.guard_id = control.reset_guard_id))) AND control.chain_id = OLD.chain_id AND control.contract_address = OLD.contract_address)
BEGIN
  SELECT RAISE(ABORT, 'ethereum 111k is paused or scope is unavailable');
END;

CREATE TRIGGER commerce_documents_ethereum_111k_insert
BEFORE INSERT ON commerce_documents
WHEN (NEW.drop_id = '111k_devnet' AND NOT EXISTS (SELECT 1 FROM ethereum_111k_control AS control WHERE control.singleton = 1 AND control.paused = 0 AND control.reset_guard_id IS NULL AND control.chain_id = json_extract(NEW.document_json, '$.chainId') AND control.contract_address = json_extract(NEW.document_json, '$.contractAddress') AND NEW.document_kind = 'delivery_order' AND NEW.source = 'ethereum'))
BEGIN
  SELECT RAISE(ABORT, 'ethereum 111k is paused or scope is unavailable');
END;

CREATE TRIGGER commerce_documents_ethereum_111k_update
BEFORE UPDATE ON commerce_documents
WHEN (OLD.drop_id = '111k_devnet' AND NOT EXISTS (SELECT 1 FROM ethereum_111k_control AS control WHERE control.singleton = 1 AND control.paused = 0 AND control.reset_guard_id IS NULL AND control.chain_id = json_extract(OLD.document_json, '$.chainId') AND control.contract_address = json_extract(OLD.document_json, '$.contractAddress') AND OLD.document_kind = 'delivery_order' AND OLD.source = 'ethereum')) OR (NEW.drop_id = '111k_devnet' AND NOT EXISTS (SELECT 1 FROM ethereum_111k_control AS control WHERE control.singleton = 1 AND control.paused = 0 AND control.reset_guard_id IS NULL AND control.chain_id = json_extract(NEW.document_json, '$.chainId') AND control.contract_address = json_extract(NEW.document_json, '$.contractAddress') AND NEW.document_kind = 'delivery_order' AND NEW.source = 'ethereum'))
BEGIN
  SELECT RAISE(ABORT, 'ethereum 111k is paused or scope is unavailable');
END;

CREATE TRIGGER commerce_documents_ethereum_111k_delete
BEFORE DELETE ON commerce_documents
WHEN (OLD.drop_id = '111k_devnet' AND NOT EXISTS (SELECT 1 FROM ethereum_111k_control AS control WHERE control.singleton = 1 AND ((control.paused = 0 AND control.reset_guard_id IS NULL) OR (control.paused = 1 AND EXISTS (SELECT 1 FROM commerce_commit_guards AS guard WHERE guard.guard_id = control.reset_guard_id))) AND control.chain_id = json_extract(OLD.document_json, '$.chainId') AND control.contract_address = json_extract(OLD.document_json, '$.contractAddress') AND OLD.document_kind = 'delivery_order' AND OLD.source = 'ethereum'))
BEGIN
  SELECT RAISE(ABORT, 'ethereum 111k is paused or scope is unavailable');
END;

PRAGMA optimize;
