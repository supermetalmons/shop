import { readFile } from 'node:fs/promises';
import { readArtworkSource } from '../../scripts/ethereum-metadata/ownerHatchingCatalog.ts';
import relics from '../../releases/111k-relic-images-2026-11-11/preflight.json';
import supplement from '../../releases/111k-catalog-v10/predecessor-owner-supplement.json';
import { MIXED_ALLOCATION_GROUPS } from '../../shared/ethereum/mixedAllocation20261117.ts';

export async function mixedAllocationFixtureSource(): Promise<string> {
  const source = readArtworkSource(await readFile(new URL('../../releases/111k-catalog-v9/source.json', import.meta.url), 'utf8'));
  for (const batch of supplement.batches) {
    for (const asset of batch.artworks) source[`animated/${asset.assetId}.png`] = [asset.width, asset.height, asset.collectionBlock];
  }
  for (const relic of relics.checks.filter(row => row.kind === 'canonical')) source[`relics/${relic.id}.png`] = [relic.width!, relic.height!];
  for (let id = 30_991; id <= 68_980; id++) source[`paintings/alt/${id}.webp`] = source[`paintings/${id}.png`];
  for (const group of MIXED_ALLOCATION_GROUPS) {
    const directory = group.category === 'painting' ? 'paintings' : 'animated';
    for (let id = group.firstId; id <= group.lastId; id++) source[`${directory}/${id}.png`] = [640 + id % 2, 480, group.collectionBlock];
  }
  return JSON.stringify(source);
}
