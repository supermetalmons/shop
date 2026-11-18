import assert from 'node:assert/strict';
import test from 'node:test';
import { parseCatalogUpdateRequest } from '../src/ethereumRevealCatalogUpdate.ts';

test('historic catalog requests accept only bounded read-only operations', () => {
  const identity = { deploymentId: 'old-release', batchId: 'catalog-' + '0'.repeat(32), expectedRevision: 1 };
  for (const action of ['inspect', 'verify']) assert.deepEqual(parseCatalogUpdateRequest({ ...identity, action }), { ...identity, action });
  for (const input of [{ action: 'begin', batch: {} }, { action: 'advance' }, { action: 'cancel' },
    { action: 'inspect', eggCutoff: 1 }, { action: 'verify', verificationAfterEggId: 111112 }, { action: 'inspect', expectedRevision: 0 }]) {
    assert.throws(() => parseCatalogUpdateRequest({ ...identity, ...input }));
  }
});
