import { randomInt, randomUUID } from 'node:crypto';
import { computeRevealCatalogDescriptor, type RevealAssetCatalog } from '../../shared/ethereum/revealAssetCatalog.ts';
import { revealCatalogAdditions, revealCatalogUpdateHash, validateRevealCatalogUpdateBatch,
  type RevealCatalogUpdateBatch, type RevealCatalogUpdateBody } from '../../shared/ethereum/revealCatalogUpdate.ts';

export function buildRevealCatalogUpdateBatch(predecessor: RevealAssetCatalog, target: RevealAssetCatalog,
  choose: (maximum: number) => number = randomInt, explicit?: { eggIds: number[]; eggCutoff: number }): RevealCatalogUpdateBatch {
  const additions = revealCatalogAdditions(predecessor, target);
  for (let index = additions.length - 1; index > 0; index--) {
    const selected = choose(index + 1);
    if (!Number.isSafeInteger(selected) || selected < 0 || selected > index) throw new Error('Invalid catalog shuffle result.');
    [additions[index], additions[selected]] = [additions[selected], additions[index]];
  }
  const eggIds = explicit ? [...explicit.eggIds].sort((a, b) => a - b) : additions.map((_, index) => target.categories.eggs.count + index + 1);
  if (eggIds.length !== additions.length) throw new Error('Explicit cutoff eggs must match the ordinary artwork additions.');
  const body: RevealCatalogUpdateBody = { ...(explicit ? { version: 2 as const, eggCutoff: explicit.eggCutoff } : { version: 1 as const }), nonce: randomUUID(),
    predecessor: { manifest: predecessor, descriptor: computeRevealCatalogDescriptor(predecessor) },
    target: { manifest: target, descriptor: computeRevealCatalogDescriptor(target) },
    mappings: additions.map((addition, index) => ({ eggId: eggIds[index], ...addition })) };
  const batchSha256 = revealCatalogUpdateHash(body);
  const batch = { ...body, batchId: `catalog-${batchSha256.slice(0, 32)}`, batchSha256 };
  validateRevealCatalogUpdateBatch(batch);
  return batch;
}
