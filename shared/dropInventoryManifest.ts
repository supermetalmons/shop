import { resolveDropMaxFigureId } from './dropFigureIds.ts';

export type DropInventoryManifest = Readonly<{
  sha256: string;
  cardIds: readonly number[];
}>;

type InventoryDrop = {
  maxSupply: number;
  itemsPerBox: number;
  operationsConfig?: { maxSupply: number };
  inventoryManifest?: DropInventoryManifest;
};

export function resolveDropInventoryManifest(drop: InventoryDrop): DropInventoryManifest | undefined {
  const manifest = drop.inventoryManifest;
  if (manifest === undefined) return undefined;
  const count = drop.maxSupply * drop.itemsPerBox;
  const maximum = resolveDropMaxFigureId(drop);
  if (!manifest || !/^[0-9a-f]{64}$/.test(manifest.sha256) || !Array.isArray(manifest.cardIds) ||
    !Number.isSafeInteger(count) || count < 1 || manifest.cardIds.length !== count ||
    manifest.cardIds.some((id, index) => !Number.isSafeInteger(id) || id < 1 || id > maximum ||
      index > 0 && id <= manifest.cardIds[index - 1])) {
    throw new Error('Invalid drop inventory manifest.');
  }
  return manifest;
}
