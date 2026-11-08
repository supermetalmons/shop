ALTER TABLE ethereum_reveal_deployments ADD COLUMN retired_at_ms INTEGER
  CHECK (retired_at_ms IS NULL OR retired_at_ms BETWEEN 1 AND 9007199254740991);
ALTER TABLE ethereum_reveal_deployments ADD COLUMN replacement_deployment_id TEXT
  REFERENCES ethereum_reveal_deployments(deployment_id);

CREATE TRIGGER ethereum_reveal_retirement_insert_guard
BEFORE INSERT ON ethereum_reveal_deployments
WHEN NEW.retired_at_ms IS NOT NULL OR NEW.replacement_deployment_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'reveal retirement requires an existing deployment');
END;

CREATE TRIGGER ethereum_reveal_retirement_update_guard
BEFORE UPDATE ON ethereum_reveal_deployments
WHEN (NEW.retired_at_ms IS NULL) <> (NEW.replacement_deployment_id IS NULL)
  OR (OLD.retired_at_ms IS NOT NULL AND (
    NEW.retired_at_ms IS NOT OLD.retired_at_ms
    OR NEW.replacement_deployment_id IS NOT OLD.replacement_deployment_id
    OR NEW.state <> 'paused' OR NEW.revision IS NOT OLD.revision))
  OR (OLD.retired_at_ms IS NULL AND NEW.retired_at_ms IS NOT NULL AND (
    OLD.state <> 'paused' OR NEW.state <> 'paused' OR NEW.revision <> OLD.revision + 1
    OR NEW.chain_id <> 11155111 OR NEW.drop_id <> '111k_devnet'
    OR NEW.replacement_deployment_id = NEW.deployment_id
    OR NOT EXISTS (SELECT 1 FROM ethereum_reveal_deployments AS replacement
      WHERE replacement.deployment_id = NEW.replacement_deployment_id
        AND replacement.chain_id = NEW.chain_id AND replacement.drop_id = NEW.drop_id
        AND replacement.state = 'active' AND replacement.retired_at_ms IS NULL
        AND replacement.provisioned_at_ms IS NOT NULL)))
BEGIN
  SELECT RAISE(ABORT, 'reveal retirement is irreversible and requires an active replacement');
END;

CREATE INDEX ethereum_reveal_deployments_live_catalog
ON ethereum_reveal_deployments(catalog_version, updated_at_ms) WHERE retired_at_ms IS NULL;
