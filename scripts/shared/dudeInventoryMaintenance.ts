import { DEPLOYMENT_DROPS } from '../../shared/deploymentRegistry.ts';
import { resolveDropMaxFigureId } from '../../shared/dropFigureIds.ts';
import { resolveDropInventoryManifest, type DropInventoryManifest } from '../../shared/dropInventoryManifest.ts';
import { COMMERCE_D1_NOW_MS_SQL, sqlString, type CommerceAuthorityQuery, type CommerceD1Document } from './commerceD1Maintenance.ts';
import { parseMiNoteDropManifest, type MiNoteDropManifest } from './miNoteDropManifest.ts';

export type InventoryDropConfig = {
  dropId: string;
  dropFamily: string;
  itemsPerBox: number;
  maxDudeId: number;
  inventoryManifest?: DropInventoryManifest;
};

export function inventoryDropConfigs(): InventoryDropConfig[] {
  return Object.entries(DEPLOYMENT_DROPS).flatMap(([dropId, drop]) => {
    if (drop.itemsPerBox === 0) return [];
    const maxDudeId = resolveDropMaxFigureId(drop);
    const inventoryManifest = resolveDropInventoryManifest(drop);
    if (!Number.isSafeInteger(drop.itemsPerBox) || drop.itemsPerBox < 1 ||
      !Number.isSafeInteger(maxDudeId) || maxDudeId < drop.itemsPerBox || maxDudeId > 0xffff) {
      throw new Error(`Invalid figure inventory configuration for ${dropId}.`);
    }
    return [{ dropId, dropFamily: drop.dropFamily, itemsPerBox: drop.itemsPerBox, maxDudeId,
      ...(inventoryManifest ? { inventoryManifest } : {}) }];
  }).sort((left, right) => left.dropId.localeCompare(right.dropId));
}

export function validateInventoryOwnership(
  config: InventoryDropConfig,
  documents: readonly CommerceD1Document[],
) {
  const rows = documents.filter((document) => document.dropId === config.dropId);
  const assignments = new Map<number, string>();
  const boxes = new Map<string, number[]>();
  const eligible = config.inventoryManifest ? new Set(config.inventoryManifest.cardIds) : undefined;
  const invalid = (detail: string): never => {
    throw new Error(`Inventory ownership conflict for ${config.dropId}: ${detail}`);
  };
  for (const document of rows) {
    if (document.kind === 'dude_assignment') {
      const id = Number(document.documentId);
      const box = document.data.boxAssetId;
      if (!Number.isSafeInteger(id) || id < 1 || id > config.maxDudeId || eligible && !eligible.has(id) ||
        String(id) !== document.documentId || Number(document.data.dudeId) !== id ||
        eligible && typeof document.data.dudeId !== 'number' ||
        typeof box !== 'string' || !box.trim() || assignments.has(id)) {
        invalid(`invalid figure marker ${document.path}.`);
      }
      assignments.set(id, box as string);
    }
    if (document.kind === 'box_assignment') {
      if (eligible && (!Array.isArray(document.data.dudeIds) ||
        document.data.dudeIds.some((id) => typeof id !== 'number' || !Number.isSafeInteger(id)))) {
        invalid(`invalid box assignment ${document.path}.`);
      }
      const ids = Array.isArray(document.data.dudeIds)
        ? document.data.dudeIds.map((id) => Math.floor(Number(id)))
        : [];
      if (ids.length !== config.itemsPerBox || new Set(ids).size !== ids.length ||
        ids.some((id) => !Number.isSafeInteger(id) || id < 1 || id > config.maxDudeId || eligible && !eligible.has(id))) {
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
  const ids = initialInventoryIds(config);
  if (rows.some((row) => !Number.isSafeInteger(row.dudeId) || row.dudeId < 1 || row.dudeId > config.maxDudeId ||
    ids[row.poolPosition] !== row.dudeId) || (complete && rows.length !== ids.length)) {
    throw new Error(`Initial inventory differs from the configured full range for ${config.dropId}.`);
  }
}

function initialInventoryIds(config: InventoryDropConfig): readonly number[] {
  return config.inventoryManifest?.cardIds ?? Array.from({ length: config.maxDudeId }, (_, index) => index + 1);
}

export function validateManifestInventory(
  config: InventoryDropConfig, available: readonly { dudeId: number; poolPosition: number }[], assigned: ReadonlySet<number>,
): void {
  if (!config.inventoryManifest) return;
  const expected = config.inventoryManifest.cardIds;
  const eligible = new Set(expected);
  const all = new Set(assigned);
  if ([...assigned].some((id) => !eligible.has(id)) || available.some((row) => {
    if (expected[row.poolPosition] !== row.dudeId || all.has(row.dudeId)) return true;
    all.add(row.dudeId);
    return false;
  }) || all.size !== expected.length) {
    throw new Error(`Available and assigned cards do not exactly match the inventory manifest for ${config.dropId}.`);
  }
}

export async function initializeNewInventoryDrop(args: {
  query: CommerceAuthorityQuery;
  config: InventoryDropConfig;
  manifest: MiNoteDropManifest;
  authorityRevision: number;
  leaseToken: string;
  generation: string;
}): Promise<void> {
  const { query, config, manifest } = args;
  parseMiNoteDropManifest(manifest);
  if (!config.inventoryManifest || config.inventoryManifest.sha256 !== manifest.sha256 ||
    JSON.stringify(config.inventoryManifest.cardIds) !== JSON.stringify(manifest.eligibleCardIds) ||
    config.dropFamily !== manifest.dropFamily || config.itemsPerBox !== manifest.itemsPerPack || config.maxDudeId !== manifest.maxFigureId) {
    throw new Error('New inventory configuration does not match the reviewed manifest.');
  }
  const verify = async () => {
    const record = (await query(`SELECT generation, manifest_sha256, eligible_card_ids_json, completed_at_ms
      FROM commerce_inventory_initializations WHERE drop_id = ${sqlString(config.dropId)}`))[0];
    const metadata = await readInventoryDrop(query, config.dropId);
    if (!record || record.manifest_sha256 !== manifest.sha256 || record.completed_at_ms === null ||
      record.eligible_card_ids_json !== JSON.stringify(manifest.eligibleCardIds) || metadata?.generation !== record.generation || metadata.ready !== 1) {
      throw new Error('Online inventory initialization did not complete with the expected manifest.');
    }
    requireInventoryConfig(metadata, config);
  };
  if (await readInventoryDrop(query, config.dropId)) {
    await verify();
    return;
  }
  try {
    const result = await query(`INSERT INTO commerce_inventory_initializations (
      drop_id, generation, lease_token, authority_revision, manifest_sha256, catalog_sha256,
      preorder_snapshot_sha256, source_preorder_id, source_cluster, source_collection,
      drop_family, items_per_box, pack_count, max_dude_id, excluded_card_ids_json, eligible_card_ids_json,
      created_at_ms, completed_at_ms
    ) VALUES (
      ${sqlString(config.dropId)}, ${sqlString(args.generation)}, ${sqlString(args.leaseToken)}, ${args.authorityRevision},
      ${sqlString(manifest.sha256)}, ${sqlString(manifest.catalogSha256)}, ${sqlString(manifest.preorderSnapshotSha256)},
      ${sqlString(manifest.sourcePreorder.preorderId)}, ${sqlString(manifest.sourcePreorder.cluster)}, ${sqlString(manifest.sourcePreorder.collection)},
      ${sqlString(config.dropFamily)}, ${config.itemsPerBox}, ${manifest.packCount}, ${config.maxDudeId},
      ${sqlString(JSON.stringify(manifest.excludedCardIds))}, ${sqlString(JSON.stringify(manifest.eligibleCardIds))},
      ${COMMERCE_D1_NOW_MS_SQL}, NULL
    ) RETURNING drop_id`);
    if (result.length !== 1 || result[0].drop_id !== config.dropId) throw new Error('New inventory initialization was not confirmed.');
  } catch (error) {
    const existing = await readInventoryDrop(query, config.dropId);
    if (!existing || existing.generation !== args.generation) throw error;
  }
  await verify();
}

export async function initializeInventoryDrop(args: {
  query: CommerceAuthorityQuery; config: InventoryDropConfig; guard: string;
  uuid: () => string; renew: () => Promise<void>;
}): Promise<void> {
  const { query, config, guard } = args;
  if (config.inventoryManifest) {
    throw new Error('Frozen-manifest inventory requires initialize-new with its verified preorder ledger; paused range initialization cannot reconstruct it.');
  }
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
  const initialIds = initialInventoryIds(config);
  for (let offset = 0; offset < initialIds.length; offset += 1000) {
    await args.renew();
    const ids = initialIds.slice(offset, offset + 1000);
    const insert = `INSERT INTO commerce_available_dudes (drop_id, dude_id, pool_position)
      SELECT ${sqlString(config.dropId)}, value, key + ${offset} FROM json_each(${sqlString(JSON.stringify(ids))})
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
