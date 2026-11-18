DROP TRIGGER ethereum_reveal_catalog_update_guard;

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
    AND NEW.effective_catalog_sha256 IS OLD.effective_catalog_sha256) AND NEW.catalog_revision <> OLD.catalog_revision
    AND NOT (OLD.catalog_update_id IS NOT NULL AND OLD.catalog_update_id IS NEW.catalog_update_id
      AND OLD.state = 'active' AND NEW.state = 'active' AND NEW.effective_catalog_version IS NOT NULL
      AND NEW.catalog_revision = OLD.catalog_revision + 1 AND NEW.revision = OLD.revision + 1))
BEGIN
  SELECT RAISE(ABORT, 'invalid reveal catalog amendment transition');
END;
