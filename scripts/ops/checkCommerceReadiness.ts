import { pathToFileURL } from 'node:url';
import {
  queryRemoteCommerceD1, queryRemoteCommerceD1Batch, safeInteger,
} from '../shared/commerceD1Maintenance.ts';
import { sequentialD1QueryBatch } from '../shared/commerceD1Audit.ts';
import { checkCurrentCommerceSchema } from '../shared/currentCommerceSchema.ts';
import { COMMERCE_STORAGE_CONTROLS, readCommerceStorageState } from '../shared/commerceStateControl.ts';
import { inventoryDropConfigs, requireInventoryConfig } from '../shared/dudeInventoryMaintenance.ts';
import type { D1MaintenanceQueryBatch } from '../shared/d1MaintenanceRunner.ts';

export async function checkCommerceReadiness(
  query: typeof queryRemoteCommerceD1 = queryRemoteCommerceD1,
  options: { queryBatch?: D1MaintenanceQueryBatch } = {},
) {
  const queryBatch = options.queryBatch ?? (query === queryRemoteCommerceD1
    ? queryRemoteCommerceD1Batch : sequentialD1QueryBatch(query));
  checkCurrentCommerceSchema(query, queryBatch);
  const authorityRows = query(`SELECT singleton, authority_state, revision, documents_revision, dude_inventory_mode
    FROM commerce_authority_control`);
  const authority = authorityRows[0];
  if (authorityRows.length !== 1 || authority.singleton !== 1 ||
    !['paused', 'd1'].includes(String(authority.authority_state)) || authority.dude_inventory_mode !== 'rows') {
    throw new Error('Commerce requires a valid authority and initialized figure inventory (rows mode).');
  }
  safeInteger(authority.revision, 'Commerce authority revision');
  safeInteger(authority.documents_revision, 'Commerce document revision');
  const controls: Record<string, string> = {};
  for (const table of COMMERCE_STORAGE_CONTROLS) {
    const state = await readCommerceStorageState(query, table);
    if (state.mode !== 'table' || state.preparation !== 'ready') {
      throw new Error(`${table} requires ready table storage.`);
    }
    controls[table] = state.mode;
  }
  const configs = inventoryDropConfigs();
  const inventory = query(`SELECT inventory.*, initialization.generation AS initialization_generation,
      initialization.manifest_sha256, initialization.eligible_card_ids_json, initialization.completed_at_ms
    FROM commerce_inventory_drops AS inventory
    LEFT JOIN commerce_inventory_initializations AS initialization ON initialization.drop_id = inventory.drop_id
    ORDER BY inventory.drop_id`);
  if (inventory.length !== configs.length) throw new Error('Commerce inventory headers differ from the configured drops.');
  for (const config of configs) {
    const row = inventory.find(value => value.drop_id === config.dropId);
    requireInventoryConfig(row, config);
    if (row.ready !== 1) throw new Error(`Commerce inventory initialization is incomplete for ${config.dropId}.`);
    safeInteger(row.initialized_at_ms, 'Commerce inventory initialization timestamp');
    if (config.inventoryManifest) {
      if (row.initialization_generation !== row.generation || row.manifest_sha256 !== config.inventoryManifest.sha256 ||
        row.eligible_card_ids_json !== JSON.stringify(config.inventoryManifest.cardIds) || row.completed_at_ms == null) {
        throw new Error(`Commerce inventory manifest header is invalid for ${config.dropId}.`);
      }
      safeInteger(row.completed_at_ms, 'Commerce inventory completion timestamp');
    } else if (row.manifest_sha256 != null) {
      throw new Error(`Commerce has an unconfigured inventory manifest for ${config.dropId}.`);
    }
  }
  return {
    scope: 'deployment-readiness', schema: 'current', authorityState: authority.authority_state,
    authorityRevision: authority.revision, inventoryMode: authority.dude_inventory_mode,
    inventoryDrops: inventory.length, controls,
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  if (process.argv.length !== 2) throw new Error('Usage: npm run check:commerce-ready');
  console.log(JSON.stringify(await checkCommerceReadiness(), null, 2));
}
