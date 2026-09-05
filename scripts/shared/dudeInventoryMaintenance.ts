import { DEPLOYMENT_DROPS } from '../../shared/deploymentRegistry.ts';
import { sanitizeDudeAssignmentPool } from './dudeAssignmentPool.ts';
import type { CommerceD1Document } from './commerceD1Maintenance.ts';

export type InventoryDropConfig = {
  dropId: string;
  dropFamily: string;
  itemsPerBox: number;
  maxDudeId: number;
};

export type InventoryBackfillPlan = InventoryDropConfig & {
  available: Array<{ dudeId: number; poolPosition: number }>;
  assignedCount: number;
  orphanAssignments: number;
  usedDefaultPool: boolean;
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

export function planInventoryBackfill(
  config: InventoryDropConfig,
  documents: readonly CommerceD1Document[],
): InventoryBackfillPlan {
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
  const poolDocument = rows.find((document) => document.kind === 'dude_pool');
  const pool = sanitizeDudeAssignmentPool(poolDocument?.data.available, config.maxDudeId);
  return {
    ...config,
    available: pool.pool.flatMap((dudeId, poolPosition) =>
      assignments.has(dudeId) ? [] : [{ dudeId, poolPosition }]),
    assignedCount: assignments.size,
    orphanAssignments,
    usedDefaultPool: pool.usedDefaultPool,
  };
}
