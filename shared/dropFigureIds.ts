export function resolveDropMaxFigureId(drop: {
  maxSupply: number;
  itemsPerBox: number;
  operationsConfig?: { maxSupply: number };
}): number {
  const maxFigureId = (drop.operationsConfig?.maxSupply ?? drop.maxSupply) * drop.itemsPerBox;
  if (drop.operationsConfig && (!Number.isSafeInteger(maxFigureId) || maxFigureId < 1 ||
    maxFigureId < drop.maxSupply * drop.itemsPerBox || maxFigureId > 0xffff)) {
    throw new Error('Invalid operations figure ID range.');
  }
  return maxFigureId;
}
