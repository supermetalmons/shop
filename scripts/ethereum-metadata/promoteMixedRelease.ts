import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { MIXED_ALLOCATION_DEFINITION_SHA256, MIXED_OWNER_PREDECESSOR_SHA256 } from '../../shared/ethereum/mixedAllocation20261117.ts';
import { mixedAllocationHash } from '../../shared/ethereum/revealMixedAllocation.ts';
import { writeDurableFile } from '../shared/durableFile.ts';
import { readOptionalFile } from '../shared/recoverableFileSet.ts';
import { withRevealAssetImportLock } from './assetImport.ts';
import { importRevealCollectionBlocks } from './collectionBlocks.ts';
import { sha256 } from './catalog.ts';

const root = fileURLToPath(new URL('../../', import.meta.url));
const releaseDir = join(root, 'releases/111k-catalog-v10');
const pretty = (value: unknown) => JSON.stringify(value, null, 2) + '\n';

async function freeze(name: string, source: string) {
  const filePath = join(releaseDir, name);
  const prior = await readOptionalFile(filePath);
  if (prior) {
    if (!prior.equals(Buffer.from(source))) throw new Error('Frozen mixed release changed: ' + name);
    return;
  }
  writeDurableFile({ filePath, source, mode: 'create', verificationMessage: 'Mixed release freeze verification failed: ' + name });
}

const { values } = parseArgs({ options: { source: { type: 'string' }, write: { type: 'boolean' } } });
if (!values.source || !values.write) throw new Error('Usage: ethereum:promote-mixed --source /path/to/111k.json --write');
const original = await readFile(resolve(values.source), 'utf8');
const sourcePath = join(releaseDir, 'source.json');
const release = await withRevealAssetImportLock(root, async importAssets => {
  const { buildMixedAllocation } = await import('./mixedAllocation.ts');
  const release = await buildMixedAllocation(original, 'e8ae1557e2aa5b4c98b525c1b8211e6aa4122468b421dbcaab078f9f33f9bc60');
  const { definition } = release;
  if (mixedAllocationHash(definition) !== MIXED_ALLOCATION_DEFINITION_SHA256) throw new Error('Mixed release differs from the reviewed definition.');
  const current = JSON.parse(await readFile(join(root, 'shared/ethereum/revealCatalog.json'), 'utf8'));
  if (![definition.predecessor, definition.target].some(d => current.catalogVersion === d.catalogVersion && current.manifestSha256 === d.manifestSha256)) {
    throw new Error('Current catalog is outside the frozen mixed release.');
  }
  const ownerPath = join(root, 'shared/ethereum/ownerHatchingCatalog.json');
  const ownerHash = mixedAllocationHash(JSON.parse(await readFile(ownerPath, 'utf8')));
  if (ownerHash !== MIXED_OWNER_PREDECESSOR_SHA256 && ownerHash !== definition.ownerSupplementSha256) {
    throw new Error('Owner supplement predecessor changed.');
  }
  await freeze('original-input.json', original);
  await freeze('source.json', release.normalizedSource);
  await freeze('definition.json', pretty(definition));
  await freeze('manifest.json', pretty(release.targetCatalog));
  await freeze('owner-supplement.json', pretty(release.ownerSupplement));
  await freeze('collection-blocks.json', pretty(release.collectionBlocks));
  const { predecessor } = release;
  const result = await importAssets({ sourcePath, catalogVersion: definition.target.catalogVersion, availableEggs: predecessor.importSettings.availableEggs });
  if (result.descriptor.manifestSha256 !== definition.target.manifestSha256) throw new Error('Installed catalog differs from reviewed release.');
  if (ownerHash !== definition.ownerSupplementSha256) {
    writeDurableFile({ filePath: ownerPath, source: pretty(release.ownerSupplement), mode: 'replace', verificationMessage: 'Failed to install mixed owner supplement.' });
  }
  return release;
});
const { definition } = release;
await importRevealCollectionBlocks({ sourcePath });
const installedBlocks = JSON.parse(await readFile(join(root, 'scripts/ethereum-metadata/reveal-assets/111k_devnet/collection-blocks.json'), 'utf8'));
if (mixedAllocationHash(installedBlocks) !== definition.collectionBlocksSha256 || sha256(release.normalizedSource) !== release.targetCatalog.source.sha256) {
  throw new Error('Installed asset support differs from the reviewed release.');
}
console.log(JSON.stringify({ catalog: definition.target, sourceSha256: definition.sourceSha256, definitionSha256: MIXED_ALLOCATION_DEFINITION_SHA256,
  ownerCount: release.summary.ownerCount, futureCount: release.summary.futureCount }));
