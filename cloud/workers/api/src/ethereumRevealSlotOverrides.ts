import { replaceRevealEnrichmentTrigger } from './ethereumRevealSchema/enrichment.js';
import type { RevealSql } from './ethereumRevealStore.js';

export type RevealSlotOverrideTable = 'owner_hatching_slot_overrides' | 'reveal_effective_slot_overrides';

export function revealSlotOverrideTable(sql: RevealSql): RevealSlotOverrideTable | null {
  return sql.exec<{ name: RevealSlotOverrideTable }>(`SELECT name FROM sqlite_schema
    WHERE name IN ('reveal_effective_slot_overrides','owner_hatching_slot_overrides') ORDER BY name DESC LIMIT 1`).toArray()[0]?.name ?? null;
}

export function initializeDuplicateReplacementReads(sql: RevealSql): void {
  sql.exec(`CREATE VIEW IF NOT EXISTS reveal_effective_slot_overrides AS
    SELECT origin_category,origin_asset_id,category,asset_id FROM owner_hatching_slot_overrides
    UNION ALL SELECT r.origin_category,r.origin_asset_id,'egg' AS category,r.egg_id AS asset_id FROM reveal_duplicate_replacements r
    WHERE NOT EXISTS(SELECT 1 FROM owner_hatching_slot_overrides o
      WHERE o.origin_category=r.origin_category AND o.origin_asset_id=r.origin_asset_id)`);
  replaceRevealEnrichmentTrigger(sql, 'reveal_effective_slot_overrides');
}
