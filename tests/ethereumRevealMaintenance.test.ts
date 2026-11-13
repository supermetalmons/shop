import assert from 'node:assert/strict';
import test from 'node:test';
import { withEthereumRevealMaintenance } from '../scripts/shared/ethereumRevealMaintenance.ts';
import type { EthereumRevealPurgeResult } from '../shared/ethereum/revealMaintenance.ts';

test('private maintenance transport uses named binding and always disposes', async () => {
  let disposed = false;
  await assert.rejects(withEthereumRevealMaintenance(async transport => {
    await transport.purgeRetired({ deploymentId: 'v15', expectedRevision: 4 });
  }, async options => {
    assert.equal(options.persist, false);
    assert.equal(options.remoteBindings, true);
    assert(options.configPath?.endsWith('ethereum-reveal-maintenance.wrangler.jsonc'));
    return { env: { REVEAL_MAINTENANCE: { async purgeRetired() { throw new Error('rejected'); },
      async inspectRetired() { throw new Error('unused'); } } }, async dispose() { disposed = true; } };
  }), /rejected/);
  assert.equal(disposed, true);
});

test('maintenance transport normalizes non-enumerable RPC property proxies before journaling', async () => {
  const expected: EthereumRevealPurgeResult = { deploymentId: 'retired-fixture', chainId: 11155111,
    contractAddress: `0x${'ab'.repeat(20)}`, metadataBaseUri: 'https://cdn.mons.shop/111k-sepolia/retired-fixture/',
    revision: 4, purged: true, storageEmpty: true, alarmCleared: true };
  const proxied = new Proxy(expected, { ownKeys: () => [] });
  assert.deepEqual(Object.keys(proxied), []);
  await withEthereumRevealMaintenance(async transport => {
    const request = { deploymentId: expected.deploymentId, expectedRevision: expected.revision };
    assert.deepEqual(JSON.parse(JSON.stringify(await transport.purgeRetired(request))), expected);
    const { purged: _, ...inspection } = expected;
    assert.deepEqual(JSON.parse(JSON.stringify(await transport.inspectRetired(request))), inspection);
  }, async () => ({ env: { REVEAL_MAINTENANCE: {
    purgeRetired: async () => proxied, inspectRetired: async () => proxied,
  } }, dispose: async () => {} }));
});
