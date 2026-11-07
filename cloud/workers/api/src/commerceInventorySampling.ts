import type { DropInventoryManifest } from '../../../../shared/dropInventoryManifest.js';
import { executeCommerceD1Batch } from './commerceD1Batch.js';
import { CommerceRepositoryError } from './commerceRepositoryTypes.js';
import { isObject, reportCommerceReadFailure, unavailableCommerce, unavailableCommerceData } from './commerceRepositorySupport.js';

export type CommerceInventoryConfig = Readonly<{
  dropFamily: string;
  dropId: string;
  itemsPerBox: number;
  maxDudeId: number;
  inventoryManifest?: DropInventoryManifest;
}>;

// Safe-integer IDs at this limit fit within D1's 2 MB row limit.
const MAX_INVENTORY_SNAPSHOT_IDS = 100_000;

function singleRow(result: D1Result<Record<string, unknown>>): Record<string, unknown> {
  if (result.results.length !== 1 || !isObject(result.results[0])) throw unavailableCommerceData();
  return result.results[0];
}

function parsePool(row: Record<string, unknown>, maxDudeId: number): number[] {
  if (row.invalid_count !== 0 || typeof row.available_ids_json !== 'string' ||
    typeof row.available_count !== 'number' || !Number.isSafeInteger(row.available_count) ||
    row.available_count < 0 || row.available_count > MAX_INVENTORY_SNAPSHOT_IDS) throw unavailableCommerceData();
  let pool: unknown;
  try { pool = JSON.parse(row.available_ids_json); } catch { throw unavailableCommerceData(); }
  if (!Array.isArray(pool) || pool.length !== row.available_count ||
    !pool.every((id): id is number => typeof id === 'number' && Number.isSafeInteger(id) && id >= 1 && id <= maxDudeId)) {
    throw unavailableCommerceData();
  }
  return pool;
}

function parseManifestPool(
  available: Record<string, unknown>[],
  assignments: Record<string, unknown>[],
  manifest: DropInventoryManifest,
  maxDudeId: number,
  generation: string,
): number[] {
  if (available.length > MAX_INVENTORY_SNAPSHOT_IDS || assignments.length > manifest.cardIds.length) throw unavailableCommerceData();
  const positions = new Map(manifest.cardIds.map((id, position) => [id, position]));
  let previousPosition = -1;
  const pool = available.map((row) => {
    if (!isObject(row)) throw unavailableCommerceData();
    const id = row.dude_id;
    const position = row.pool_position;
    if (typeof id !== 'number' || !Number.isSafeInteger(id) || id < 1 || id > maxDudeId ||
      typeof position !== 'number' || !Number.isSafeInteger(position) || position <= previousPosition ||
      positions.get(id) !== position) throw unavailableCommerceData();
    previousPosition = position;
    return id;
  });
  const accounted = new Set(pool);
  for (const row of assignments) {
    if (!isObject(row)) throw unavailableCommerceData();
    const id = row.dude_id;
    if (typeof id !== 'number' || !Number.isSafeInteger(id) || !positions.has(id) ||
      row.document_id !== String(id) || row.inventory_generation !== generation || accounted.has(id)) {
      throw unavailableCommerceData();
    }
    accounted.add(id);
  }
  if (accounted.size !== manifest.cardIds.length) throw unavailableCommerceData();
  return pool;
}

export async function loadCommerceInventorySnapshot(
  db: D1Database,
  config: CommerceInventoryConfig,
  signal?: AbortSignal,
): Promise<{ generation: string; pool: number[] }> {
  signal?.throwIfAborted();
  const manifest = config.inventoryManifest;
  const expectedJson = manifest ? JSON.stringify(manifest.cardIds) : null;
  const results = await executeCommerceD1Batch(db, () => [
    db.prepare('SELECT authority_state, dude_inventory_mode FROM commerce_authority_control WHERE singleton = 1'),
    db.prepare(`SELECT generation, ready, drop_family, items_per_box, max_dude_id
      FROM commerce_inventory_drops WHERE drop_id = ?`).bind(config.dropId),
    manifest
      ? db.prepare(`SELECT dude_id, pool_position FROM commerce_available_dudes
          WHERE drop_id = ? ORDER BY pool_position LIMIT ${MAX_INVENTORY_SNAPSHOT_IDS + 1}`).bind(config.dropId)
      : db.prepare(`SELECT json_group_array(dude_id) AS available_ids_json, COUNT(*) AS available_count,
      COALESCE(SUM(typeof(dude_id) <> 'integer' OR dude_id < 1 OR dude_id > ?
        OR typeof(pool_position) <> 'integer' OR pool_position < 0 OR pool_position > 9007199254740991), 0) AS invalid_count
      FROM (SELECT dude_id, pool_position FROM commerce_available_dudes
        WHERE drop_id = ? ORDER BY pool_position LIMIT ${MAX_INVENTORY_SNAPSHOT_IDS + 1})`)
      .bind(config.maxDudeId, config.dropId),
    ...(manifest ? [
      db.prepare(`SELECT generation, manifest_sha256, eligible_card_ids_json = ? AS manifest_matches, completed_at_ms
        FROM commerce_inventory_initializations WHERE drop_id = ?`).bind(expectedJson, config.dropId),
      db.prepare(`SELECT document_id, json_extract(document_json, '$.dudeId') AS dude_id,
        json_extract(document_json, '$.inventoryGeneration') AS inventory_generation
        FROM commerce_documents WHERE drop_id = ? AND document_kind = 'dude_assignment' LIMIT ?`)
        .bind(config.dropId, manifest.cardIds.length + 1),
    ] : []),
  ], {
    invalidResult: unavailableCommerceData,
    requireMeta: true,
    mapBatchError: (error) => { reportCommerceReadFailure(error); return unavailableCommerce(error); },
  });
  signal?.throwIfAborted();
  const authority = singleRow(results[0]);
  if (authority.authority_state !== 'd1' || authority.dude_inventory_mode !== 'rows') throw unavailableCommerce();
  if (results[1].results.length > 1) throw unavailableCommerceData();
  const inventory = results[1].results[0];
  if (!inventory || inventory.ready !== 1 || inventory.drop_family !== config.dropFamily ||
    inventory.items_per_box !== config.itemsPerBox || inventory.max_dude_id !== config.maxDudeId ||
    typeof inventory.generation !== 'string' || inventory.generation.length !== 36) {
    throw new CommerceRepositoryError('unavailable', 'Figure inventory is not initialized for this drop.');
  }
  if (manifest) {
    const authorization = singleRow(results[3]);
    if (authorization.generation !== inventory.generation || authorization.manifest_sha256 !== manifest.sha256 ||
      authorization.manifest_matches !== 1 || !Number.isSafeInteger(authorization.completed_at_ms) || Number(authorization.completed_at_ms) <= 0) {
      throw unavailableCommerceData();
    }
    return { generation: inventory.generation, pool: parseManifestPool(
      results[2].results, results[4].results, manifest, config.maxDudeId, inventory.generation,
    ) };
  }
  return { generation: inventory.generation, pool: parsePool(singleRow(results[2]), config.maxDudeId) };
}
