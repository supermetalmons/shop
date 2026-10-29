CREATE TABLE ethereum_metadata_publication_leases (
  metadata_base_uri TEXT PRIMARY KEY NOT NULL,
  lease_id TEXT NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
) STRICT;

CREATE TABLE ethereum_reveal_deployments (
  deployment_id TEXT PRIMARY KEY NOT NULL,
  drop_id TEXT NOT NULL,
  chain_id INTEGER NOT NULL CHECK (chain_id IN (1, 11155111, 31337)),
  contract_address TEXT NOT NULL,
  metadata_base_uri TEXT NOT NULL UNIQUE,
  deployment_block INTEGER NOT NULL CHECK (deployment_block >= 0),
  catalog_version TEXT NOT NULL,
  template_json TEXT NOT NULL CHECK (json_valid(template_json)),
  template_sha256 TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('provisioning', 'ready', 'active', 'paused')),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  activated_at_ms INTEGER,
  provisioned_at_ms INTEGER,
  last_error TEXT,
  UNIQUE (chain_id, contract_address)
) STRICT;

CREATE INDEX ethereum_reveal_deployments_state ON ethereum_reveal_deployments(state, deployment_id);

CREATE TRIGGER ethereum_reveal_deployment_no_delete
BEFORE DELETE ON ethereum_reveal_deployments
BEGIN
  SELECT RAISE(ABORT, 'reveal deployment ownership is permanent');
END;

CREATE TRIGGER ethereum_reveal_deployment_immutable
BEFORE UPDATE ON ethereum_reveal_deployments
WHEN NEW.deployment_id IS NOT OLD.deployment_id OR NEW.drop_id IS NOT OLD.drop_id
  OR NEW.chain_id IS NOT OLD.chain_id OR NEW.contract_address IS NOT OLD.contract_address
  OR NEW.metadata_base_uri IS NOT OLD.metadata_base_uri OR NEW.deployment_block IS NOT OLD.deployment_block
  OR NEW.catalog_version IS NOT OLD.catalog_version OR NEW.template_json IS NOT OLD.template_json
  OR NEW.template_sha256 IS NOT OLD.template_sha256 OR NEW.created_at_ms IS NOT OLD.created_at_ms
BEGIN
  SELECT RAISE(ABORT, 'reveal deployment identity is immutable');
END;

CREATE TRIGGER ethereum_reveal_deployment_publication_guard
BEFORE INSERT ON ethereum_reveal_deployments
WHEN EXISTS (SELECT 1 FROM ethereum_metadata_publication_leases
  WHERE metadata_base_uri = NEW.metadata_base_uri
    AND expires_at_ms + 65000 > CAST(unixepoch('subsec') * 1000 AS INTEGER))
BEGIN
  SELECT RAISE(ABORT, 'metadata publication is still active');
END;

CREATE TRIGGER ethereum_metadata_publication_insert_guard
BEFORE INSERT ON ethereum_metadata_publication_leases
WHEN EXISTS (SELECT 1 FROM ethereum_reveal_deployments WHERE metadata_base_uri = NEW.metadata_base_uri)
BEGIN
  SELECT RAISE(ABORT, 'metadata prefix is owned by reveal publisher');
END;

CREATE TRIGGER ethereum_metadata_publication_update_guard
BEFORE UPDATE ON ethereum_metadata_publication_leases
WHEN EXISTS (SELECT 1 FROM ethereum_reveal_deployments WHERE metadata_base_uri = NEW.metadata_base_uri)
BEGIN
  SELECT RAISE(ABORT, 'metadata prefix is owned by reveal publisher');
END;
