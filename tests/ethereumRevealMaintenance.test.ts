import assert from 'node:assert/strict';
import test from 'node:test';
import { withEthereumRevealMaintenance } from '../scripts/shared/ethereumRevealMaintenance.ts';
import type { EthereumRevealAttributeBackfillPage, EthereumRevealPurgeResult } from '../shared/ethereum/revealMaintenance.ts';
import type { OwnerHatchingMaintenanceResult } from '../shared/ethereum/ownerHatchingMaintenance.ts';

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

test('owner hatching transport preserves enrichment counts while stripping private RPC fields', async () => {
  const expected: OwnerHatchingMaintenanceResult = { deploymentId: 'mainnet-fixture', batchId: 'owner-fixture',
    phase: 'complete', readyCount: 2, grailCount: 1, candidates: 10, scanned: 10, total: 10, staged: 1,
    activationChecked: 2, activationSelected: 2,
    published: 2, hatched: 1, retrying: 0, conflicts: 0, pendingEnrichment: 1, failedEnrichment: 1,
    retryAfterMs: 0, verificationCursor: null, observationUntilMs: 300_000, complete: true };
  const proxied = new Proxy({ ...expected, assignments: [{ tokenId: 'private' }] }, { ownKeys: () => [] });
  await withEthereumRevealMaintenance(async transport => {
    const result = await transport.ownerHatching!({ action: 'status', deploymentId: expected.deploymentId,
      batchId: expected.batchId, expectedRevision: 9 });
    assert.deepEqual(JSON.parse(JSON.stringify(result)), expected);
  }, async () => ({ env: { REVEAL_MAINTENANCE: {
    ownerHatching: async () => proxied,
    purgeRetired: async () => { throw new Error('Unused.'); },
    inspectRetired: async () => { throw new Error('Unused.'); },
  } }, dispose: async () => {} }));
});

test('attribute audit transport materializes bounded token and enrichment RPC fields', async () => {
  const expected: EthereumRevealAttributeBackfillPage = { nextCursor: null, eligible: 1, missing: 0, invalid: 0, conflict: 0,
    conflictRechecks: 0, enqueued: 0, requeued: 0, frozenThroughMs: 1000, tokens: [{ tokenId: '24482', category: 'painting', assetId: 41171,
      assignmentRevision: 1, metadataRevision: 3, metadataSha256: 'a'.repeat(64), frozenMetadataSha256: 'b'.repeat(64),
      nonAttributeSha256: 'c'.repeat(64), collectionBlock: 'little swag', enrichment: { status: 'published', assignmentRevision: 1,
        attempts: 2, lastError: null, targetSha256: 'a'.repeat(64), checksumValid: true } }] };
  const token = new Proxy({ ...expected.tokens![0], privateField: 'excluded',
    enrichment: new Proxy(expected.tokens![0].enrichment!, { ownKeys: () => [] }) }, { ownKeys: () => [] });
  const proxied = new Proxy({ ...expected, tokens: [token] }, { ownKeys: () => [] });
  await withEthereumRevealMaintenance(async transport => {
    const result = await transport.backfillAttributes!({ deploymentId: 'mainnet-v1', expectedRevision: 9,
      afterTokenId: null, write: false, audit: true, frozenThroughMs: 1000 });
    assert.deepEqual(JSON.parse(JSON.stringify(result)), expected);
  }, async () => ({ env: { REVEAL_MAINTENANCE: {
    backfillAttributes: async () => proxied,
    purgeRetired: async () => { throw new Error('Unused.'); },
    inspectRetired: async () => { throw new Error('Unused.'); },
  } }, dispose: async () => {} }));
});
