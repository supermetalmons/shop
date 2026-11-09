ALTER TABLE ethereum_reveal_deployments ADD COLUMN effective_catalog_version TEXT;
ALTER TABLE ethereum_reveal_deployments ADD COLUMN effective_catalog_sha256 TEXT;
ALTER TABLE ethereum_reveal_deployments ADD COLUMN catalog_revision INTEGER NOT NULL DEFAULT 0 CHECK (catalog_revision >= 0);
ALTER TABLE ethereum_reveal_deployments ADD COLUMN catalog_update_id TEXT;
ALTER TABLE ethereum_reveal_deployments ADD COLUMN catalog_update_started_at_ms INTEGER;

CREATE TRIGGER ethereum_reveal_catalog_update_insert_guard
BEFORE INSERT ON ethereum_reveal_deployments
WHEN NEW.effective_catalog_version IS NOT NULL OR NEW.effective_catalog_sha256 IS NOT NULL
  OR NEW.catalog_revision <> 0
  OR NEW.catalog_update_id IS NOT NULL OR NEW.catalog_update_started_at_ms IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'new reveal deployments cannot contain catalog amendment state');
END;

CREATE TRIGGER ethereum_reveal_catalog_update_guard
BEFORE UPDATE ON ethereum_reveal_deployments
WHEN (NEW.effective_catalog_version IS NULL) <> (NEW.effective_catalog_sha256 IS NULL)
  OR (NEW.catalog_update_id IS NULL) <> (NEW.catalog_update_started_at_ms IS NULL)
  OR (NEW.catalog_update_id IS NOT NULL AND (NEW.retired_at_ms IS NOT NULL
    OR NEW.catalog_update_started_at_ms < 1))
  OR (NEW.effective_catalog_sha256 IS NOT NULL AND (length(NEW.effective_catalog_sha256) <> 64
    OR NEW.effective_catalog_sha256 GLOB '*[^a-f0-9]*'))
  OR (OLD.catalog_update_id IS NOT NULL AND NEW.catalog_update_id IS NOT NULL
    AND (NEW.catalog_update_id IS NOT OLD.catalog_update_id
      OR NEW.catalog_update_started_at_ms IS NOT OLD.catalog_update_started_at_ms))
  OR ((NEW.effective_catalog_version IS NOT OLD.effective_catalog_version
    OR NEW.effective_catalog_sha256 IS NOT OLD.effective_catalog_sha256)
    AND (OLD.catalog_update_id IS NULL OR NEW.catalog_revision <> OLD.catalog_revision + 1))
  OR ((NEW.effective_catalog_version IS OLD.effective_catalog_version
    AND NEW.effective_catalog_sha256 IS OLD.effective_catalog_sha256) AND NEW.catalog_revision <> OLD.catalog_revision)
BEGIN
  SELECT RAISE(ABORT, 'invalid reveal catalog amendment transition');
END;
