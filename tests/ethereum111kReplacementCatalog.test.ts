import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { getRevealCatalog } from '../shared/ethereum/revealCatalogRegistry.ts';
import type { ReplacementRelease, ReplacementSnapshot } from '../scripts/shared/ethereum111kReplacementCleanup.ts';

const current = getRevealCatalog('111k-v5')!;
const registry = `const catalogs=${JSON.stringify([current, { ...current, catalogVersion: '111k-v4' }])};
  export function getRevealCatalog(version) { return catalogs.find(row=>row.catalogVersion===version); }`;
const hooks = registerHooks({ resolve(specifier, context, next) {
  return /revealCatalogRegistry\.(?:js|ts)$/.test(specifier)
    ? { shortCircuit: true, url: `data:text/javascript;base64,${Buffer.from(registry).toString('base64')}` }
    : next(specifier, context);
} });
const { validateReplacementSnapshot } = await (async () => {
  try { return await import('../scripts/shared/ethereum111kReplacementCleanup.ts'); }
  finally { hooks.deregister(); }
})();

test('replacement cleanup accepts a supported original catalog after the repository default advances', () => {
  const release: ReplacementRelease = { releaseDirectory: '/private/replacement', manifestSha256: 'a'.repeat(64), chainId: 11155111,
    deploymentId: 'replacement', contractAddress: `0x${'ab'.repeat(20)}`, previousContract: `0x${'cd'.repeat(20)}`,
    metadataBaseUri: 'https://cdn.mons.shop/111k-sepolia/replacement/', deploymentBlock: 100,
    deploymentTransactionHash: `0x${'1'.repeat(64)}`, artifactSha256: 'a'.repeat(64), standardInputSha256: 'b'.repeat(64) };
  const snapshot: ReplacementSnapshot = { oldDeployment: { deploymentId: 'old', chainId: 11155111,
    contractAddress: release.previousContract, metadataBaseUri: 'https://cdn.mons.shop/111k-sepolia/old/', deploymentBlock: 1,
    catalogVersion: '111k-v4', revision: 4, state: 'paused' },
    newDeployment: { deploymentId: release.deploymentId, chainId: release.chainId, contractAddress: release.contractAddress,
      metadataBaseUri: release.metadataBaseUri, deploymentBlock: release.deploymentBlock, catalogVersion: '111k-v4', revision: 6, state: 'active' },
    commerceRevision: 1 };
  validateReplacementSnapshot(release, snapshot);
  assert.equal(snapshot.newDeployment.catalogVersion, '111k-v4');
  assert.throws(() => validateReplacementSnapshot(release, { ...snapshot,
    newDeployment: { ...snapshot.newDeployment, catalogVersion: '111k-v999' } }), /controls do not match/);
});
