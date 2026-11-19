import definition from '../../releases/111k-mainnet-duplicate-correction-2026-11-19/definition.json';
import type { DuplicateCorrectionDefinition } from './duplicateCorrection.ts';
import { mixedAllocationHash } from './revealMixedAllocation.ts';

export const duplicateCorrectionDefinitionSha256 = '162459bc042c4454b1eacc5b3df19c1f6cbb74a83e45bad4eb5df2c6106d271b';
if (definition.version !== 1 || mixedAllocationHash(definition) !== duplicateCorrectionDefinitionSha256) {
  throw new Error('Mainnet duplicate correction definition changed.');
}
export const duplicateCorrectionDefinition: DuplicateCorrectionDefinition = { ...definition, version: 1 };
