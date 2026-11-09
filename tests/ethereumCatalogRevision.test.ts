import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveEthereum111kConfig } from '../shared/ethereum/config.ts';
import { assertEthereumCatalog, assertSameEthereumCatalog, ethereumCatalogKey, EthereumCatalogChangedError,
  retainEthereumCatalogConfig, retainEthereumMetadata, validEthereumCatalogScope, validEthereumMetadataRevision } from '../src/ethereum/catalogRevision.ts';

const config = resolveEthereum111kConfig({ contractAddress: `0x${'33'.repeat(20)}` });

test('catalog envelopes accept legacy revision zero and validate revision and deployment identities', () => {
  for (const scope of [{}, { catalogRevision: 0 }, { deploymentId: null }, { deploymentId: 'v17', catalogRevision: 2 }]) {
    assert.equal(validEthereumCatalogScope(scope), true);
  }
  for (const scope of [{ catalogRevision: -1 }, { catalogRevision: 0.5 }, { catalogRevision: '1' },
    { catalogRevision: null }, { deploymentId: '' }, { deploymentId: 'bad/path' }]) assert.equal(validEthereumCatalogScope(scope), false);
  assert.deepEqual(ethereumCatalogKey({}), []);
  assert.deepEqual(ethereumCatalogKey({ catalogRevision: 0 }), []);
  assert.deepEqual(ethereumCatalogKey({ deploymentId: 'v17', catalogRevision: 2 }), ['v17']);
  assert.deepEqual(ethereumCatalogKey({ deploymentId: 'v17', catalogRevision: 3 }), ['v17']);
  assertEthereumCatalog({}, { catalogRevision: 0, deploymentId: 'v17' });
  assert.throws(() => assertSameEthereumCatalog({}, { deploymentId: 'v17' }), EthereumCatalogChangedError);
  assert.throws(() => assertEthereumCatalog({ deploymentId: 'v17' }, {}), EthereumCatalogChangedError);
  assertEthereumCatalog({ catalogRevision: 1 }, {});
});

test('token metadata revisions prevent stale artwork without retaining old ownership', () => {
  for (const value of [undefined, 0, 1, 8]) assert.equal(validEthereumMetadataRevision(value), true);
  for (const value of [null, -1, 0.5, '2']) assert.equal(validEthereumMetadataRevision(value), false);
  const current = { metadataRevision: 3, name: 'Painting', image: 'painting.png', owner: 'old', revealStatus: 'revealed' as const };
  const stale = { metadataRevision: 0, name: 'Egg', image: 'egg.png', owner: 'new', revealStatus: 'revealed' as const };
  assert.deepEqual(retainEthereumMetadata(current, stale), { ...stale, ...current, owner: 'new', description: undefined,
    animation_url: undefined, aspectRatio: undefined, category: undefined, attributes: undefined });
  const newer = { ...current, metadataRevision: 4, name: 'Updated' };
  assert.equal(retainEthereumMetadata(current, newer), newer);
});

test('a delayed config response cannot lower an observed catalog revision or erase its identity', () => {
  const current = { ...config, deploymentId: 'v17', catalogRevision: 2 };
  assert.equal(retainEthereumCatalogConfig(current, { ...current, catalogRevision: 1 }), current);
  assert.equal(retainEthereumCatalogConfig(current, config), current);
  const newer = { ...current, catalogRevision: 3 };
  assert.equal(retainEthereumCatalogConfig(current, newer), newer);
  assert.throws(() => retainEthereumCatalogConfig(current, { ...current, deploymentId: 'other' }), EthereumCatalogChangedError);
  const replacement = { ...config, contractAddress: `0x${'44'.repeat(20)}` };
  assert.equal(retainEthereumCatalogConfig(current, replacement), replacement);
});
