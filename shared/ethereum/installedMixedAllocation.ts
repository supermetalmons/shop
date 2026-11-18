import frozenDefinition from '../../releases/111k-catalog-v10/definition.json';
import { MIXED_ALLOCATION_DEFINITION_SHA256 } from './mixedAllocation20261117.ts';
import { getRevealCatalog } from './revealCatalogRegistry.ts';
import { mixedAllocationHash, validateMixedAllocationDefinition } from './revealMixedAllocation.ts';

export function getInstalledMixedAllocation() {
  const definition: unknown = frozenDefinition;
  validateMixedAllocationDefinition(definition);
  if (mixedAllocationHash(definition) !== MIXED_ALLOCATION_DEFINITION_SHA256) throw new Error('Unsupported mixed allocation definition.');
  const targetCatalog = getRevealCatalog(definition.target.catalogVersion, definition.target.manifestSha256);
  if (!targetCatalog) throw new Error('Mixed allocation target catalog is unavailable.');
  return { definition, targetCatalog };
}
