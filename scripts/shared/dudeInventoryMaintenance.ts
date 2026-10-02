import { DEPLOYMENT_DROPS } from '../../shared/deploymentRegistry.ts';
import { COMMERCE_D1_NOW_MS_SQL, sqlString, type CommerceAuthorityQuery, type CommerceD1Document } from './commerceD1Maintenance.ts';

export type InventoryDropConfig = {
  dropId: string;
  dropFamily: string;
  itemsPerBox: number;
  maxDudeId: number;
};

export function inventoryDropConfigs(): InventoryDropConfig[] {
  return Object.entries(DEPLOYMENT_DROPS).flatMap(([dropId, drop]) => {
    if (drop.itemsPerBox === 0) return [];
    const maxDudeId = drop.itemsPerBox * drop.maxSupply;
    if (!Number.isSafeInteger(drop.itemsPerBox) || drop.itemsPerBox < 1 ||
      !Number.isSafeInteger(maxDudeId) || maxDudeId < drop.itemsPerBox || maxDudeId > 0xffff) {
      throw new Error(`Invalid figure inventory configuration for ${dropId}.`);
    }
    return [{ dropId, dropFamily: drop.dropFamily, itemsPerBox: drop.itemsPerBox, maxDudeId }];
  }).sort((left, right) => left.dropId.localeCompare(right.dropId));
}

export function validateInventoryOwnership(
  config: InventoryDropConfig,
  documents: readonly CommerceD1Document[],
) {
  const rows = documents.filter((document) => document.dropId === config.dropId);
  const assignments = new Map<number, string>();
  const boxes = new Map<string, number[]>();
  const invalid = (detail: string): never => {
    throw new Error(`Inventory ownership conflict for ${config.dropId}: ${detail}`);
  };
  for (const document of rows) {
    if (document.kind === 'dude_assignment') {
      const id = Number(document.documentId);
      const box = document.data.boxAssetId;
      if (!Number.isSafeInteger(id) || id < 1 || id > config.maxDudeId ||
        String(id) !== document.documentId || Number(document.data.dudeId) !== id ||
        typeof box !== 'string' || !box.trim() || assignments.has(id)) {
        invalid(`invalid figure marker ${document.path}.`);
      }
      assignments.set(id, box as string);
    }
    if (document.kind === 'box_assignment') {
      const ids = Array.isArray(document.data.dudeIds)
        ? document.data.dudeIds.map((id) => Math.floor(Number(id)))
        : [];
      if (ids.length !== config.itemsPerBox || new Set(ids).size !== ids.length ||
        ids.some((id) => !Number.isSafeInteger(id) || id < 1 || id > config.maxDudeId)) {
        invalid(`invalid box assignment ${document.path}.`);
      }
      boxes.set(document.documentId, ids);
    }
  }
  for (const [box, ids] of boxes) {
    for (const id of ids) {
      if (assignments.get(id) !== box) invalid(`box ${box} and figure ${id} disagree.`);
    }
  }
  let orphanAssignments = 0;
  for (const [id, box] of assignments) {
    if (!boxes.has(box)) orphanAssignments += 1;
    else if (!boxes.get(box)!.includes(id)) invalid(`figure ${id} is absent from box ${box}.`);
  }
  return { assignedCount: assignments.size, orphanAssignments, assignedIds: new Set(assignments.keys()) };
}

export async function readInventoryDrop(query: CommerceAuthorityQuery, dropId: string) {
  const rows = await query(`SELECT * FROM commerce_inventory_drops WHERE drop_id = ${sqlString(dropId)}`);
  if (rows.length > 1) throw new Error(`Duplicate inventory metadata for ${dropId}.`);
  return rows[0];
}

export async function readAvailableInventory(query: CommerceAuthorityQuery, dropId: string) {
  return (await query(`SELECT dude_id, pool_position FROM commerce_available_dudes
    WHERE drop_id = ${sqlString(dropId)} ORDER BY pool_position`)).map((row) => ({
    dudeId: Number(row.dude_id), poolPosition: Number(row.pool_position),
  }));
}

export function requireInventoryConfig(row: Record<string, unknown> | undefined, config: InventoryDropConfig): void {
  if (!row || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(row.generation)) ||
    row.drop_family !== config.dropFamily || row.items_per_box !== config.itemsPerBox || row.max_dude_id !== config.maxDudeId ||
    (row.ready !== 0 && row.ready !== 1)) {
    throw new Error(`Inventory for ${config.dropId} is missing, incomplete, or differs from the registry.`);
  }
}

export async function requireInitialInventory(query: CommerceAuthorityQuery, config: InventoryDropConfig, complete: boolean): Promise<void> {
  const rows = await readAvailableInventory(query, config.dropId);
  if (rows.some((row) => !Number.isSafeInteger(row.dudeId) || row.dudeId < 1 || row.dudeId > config.maxDudeId ||
    row.poolPosition !== row.dudeId - 1) || (complete && rows.length !== config.maxDudeId)) {
    throw new Error(`Initial inventory differs from the configured full range for ${config.dropId}.`);
  }
}

export async function initializeInventoryDrop(args: {
  query: CommerceAuthorityQuery; config: InventoryDropConfig; guard: string;
  uuid: () => string; renew: () => Promise<void>;
}): Promise<void> {
  const { query, config, guard } = args;
  let existing = await readInventoryDrop(query, config.dropId);
  if (existing) {
    requireInventoryConfig(existing, config);
    await requireInitialInventory(query, config, existing.ready === 1);
    if (existing.ready === 1) return;
  } else {
    await args.renew();
    const generation = args.uuid();
    try {
      const rows = await query(`INSERT INTO commerce_inventory_drops (
        drop_id, generation, ready, drop_family, items_per_box, max_dude_id, initialized_at_ms
      ) SELECT ${sqlString(config.dropId)}, ${sqlString(generation)}, 0, ${sqlString(config.dropFamily)},
        ${config.itemsPerBox}, ${config.maxDudeId}, ${COMMERCE_D1_NOW_MS_SQL}
      WHERE ${guard} RETURNING drop_id`);
      if (rows.length !== 1) throw new Error('Inventory initialization was not confirmed.');
    } catch (error) {
      existing = await readInventoryDrop(query, config.dropId);
      if (!existing || existing.generation !== generation) throw error;
    }
    existing = await readInventoryDrop(query, config.dropId);
    requireInventoryConfig(existing, config);
  }
  for (let offset = 0; offset < config.maxDudeId; offset += 1000) {
    await args.renew();
    const ids = Array.from({ length: Math.min(1000, config.maxDudeId - offset) }, (_, index) => offset + index + 1);
    const insert = `INSERT INTO commerce_available_dudes (drop_id, dude_id, pool_position)
      SELECT ${sqlString(config.dropId)}, value, value - 1 FROM json_each(${sqlString(JSON.stringify(ids))})
      WHERE ${guard} AND NOT EXISTS (SELECT 1 FROM commerce_available_dudes
        WHERE drop_id = ${sqlString(config.dropId)} AND dude_id = value) RETURNING dude_id`;
    try { await query(insert); } catch (error) {
      const available = new Set((await readAvailableInventory(query, config.dropId)).map((row) => row.dudeId));
      if (ids.some((id) => !available.has(id))) throw error;
    }
  }
  await requireInitialInventory(query, config, true);
  await args.renew();
  try {
    const rows = await query(`UPDATE commerce_inventory_drops SET ready = 1
      WHERE drop_id = ${sqlString(config.dropId)} AND generation = ${sqlString(String(existing!.generation))}
        AND ready = 0 AND ${guard} RETURNING drop_id`);
    if (rows.length !== 1) throw new Error('Inventory readiness was not confirmed.');
  } catch (error) {
    const observed = await readInventoryDrop(query, config.dropId);
    if (!observed || observed.generation !== existing!.generation || observed.ready !== 1) throw error;
  }
}
