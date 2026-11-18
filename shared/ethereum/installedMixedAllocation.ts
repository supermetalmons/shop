import frozenDefinition from '../../releases/111k-catalog-v10/definition.json';
import releases from './mixedAllocationReleases.json';
import { MIXED_MAINNET_BATCH_ID, MIXED_ALLOCATION_DEFINITION_SHA256 } from './mixedAllocation20261117.ts';
import { getRevealCatalog } from './revealCatalogRegistry.ts';
import { mixedAllocationCounts, mixedAllocationHash, validateMixedAllocationDefinition, type MixedAllocationDefinition } from './revealMixedAllocation.ts';

export function getInstalledMixedAllocation(batchId = MIXED_MAINNET_BATCH_ID) {
  let definition: MixedAllocationDefinition;
  if (batchId === MIXED_MAINNET_BATCH_ID) {
    const legacy: unknown = frozenDefinition;
    validateMixedAllocationDefinition(legacy);
    if (mixedAllocationHash(legacy) !== MIXED_ALLOCATION_DEFINITION_SHA256) throw new Error('Unsupported mixed allocation definition.');
    definition = legacy;
  } else {
    const matches: MixedAllocationDefinition[] = [];
    for (const entry of releases as unknown[]) {
      validateMixedAllocationDefinition(entry);
      if (entry.version !== 2 || entry.batchId === MIXED_MAINNET_BATCH_ID) throw new Error('Invalid installed mixed allocation.');
      if (entry.batchId === batchId) matches.push(entry);
    }
    if (matches.length !== 1) throw new Error('Unknown or conflicting installed mixed allocation.');
    definition = matches[0];
  }
  const targetCatalog = getRevealCatalog(definition.target.catalogVersion, definition.target.manifestSha256);
  if (!targetCatalog) throw new Error('Mixed allocation target catalog is unavailable.');
  return { definition, targetCatalog };
}

export function emptyPoolRelease(batchId: string, batchSha256: string, deploymentId: string) {
  const { definition, targetCatalog } = getInstalledMixedAllocation(batchId);
  if (definition.version !== 2 || definition.deploymentId !== deploymentId || definition.chainId !== 1 ||
    mixedAllocationHash(definition) !== batchSha256 || mixedAllocationCounts(definition).readyCount !== 0) {
    throw new Error('Empty-pool rebuild requires a reviewed mainnet future-only release for this deployment.');
  }
  return {     batchId, batchSha256, predecessor: { descriptor: definition.predecessor },
    target: { manifest: targetCatalog, descriptor: definition.target }, scope: definition   };
}
