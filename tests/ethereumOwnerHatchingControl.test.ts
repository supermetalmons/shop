import assert from 'node:assert/strict';
import test from 'node:test';
import { ownerHatchingControlMain, parseOwnerHatchingControlArgs } from '../scripts/ops/ethereumOwnerHatchingControl.ts';
import type { OwnerHatchingMaintenanceRequest, OwnerHatchingMaintenanceResult } from '../shared/ethereum/ownerHatchingMaintenance.ts';
import type { EthereumRevealDeployment } from '../shared/ethereum/revealDeployment.ts';

const identity = ['--deployment-id', 'mainnet-v1', '--batch-id', 'drowee-first', '--expected-revision', '9'];
function status(change: Partial<OwnerHatchingMaintenanceResult> = {}): OwnerHatchingMaintenanceResult {
  return { deploymentId: 'mainnet-v1', batchId: 'drowee-first', phase: 'scanning', readyCount: 350, grailCount: 175,
    candidates: 0, scanned: 0, total: 400, staged: 0, activationChecked: 0, activationSelected: 0,
    published: 0, hatched: 0, retrying: 0, conflicts: 0,
    pendingEnrichment: 0, failedEnrichment: 0,
    retryAfterMs: 250, verificationCursor: null, observationUntilMs: null, complete: false, ...change };
}
const deployment: EthereumRevealDeployment = {
  deploymentId: 'mainnet-v1', dropId: '111k', chainId: 1, contractAddress: `0x${'11'.repeat(20)}`,
  metadataBaseUri: 'https://cdn.mons.shop/111k/', deploymentBlock: 1, catalogVersion: '111k-v8', templateJson: '{}',
  templateSha256: 'a'.repeat(64), state: 'active', revision: 9, createdAtMs: 0, updatedAtMs: 0,
  activatedAtMs: 0, provisionedAtMs: 0, lastError: null, effectiveCatalogVersion: '111k-v9',
  effectiveCatalogSha256: 'a7cf99fd2f9850a069ff9e69dfacdfb87249eeb0c4a8d5fcee1967da950974f1',
};

test('owner batch creation and activation are retired', () => {
  for (const action of ['apply', 'begin', 'refresh-scan', 'refresh-activation', 'activate']) {
    assert.throws(() => parseOwnerHatchingControlArgs([action, ...identity, '--write']));
  }
});

test('status returns only aggregate fields and never triggers registry or mutation calls', async () => {
  const calls: OwnerHatchingMaintenanceRequest[] = [];
  const expected = status({ pendingEnrichment: 2, failedEnrichment: 1, verificationCursor: 'pending' });
  const progress: OwnerHatchingMaintenanceResult[] = [];
  const result = await ownerHatchingControlMain(['inspect', ...identity], {
    registry: async () => { throw new Error('Registry should not be queried for status.'); },
    onProgress: value => progress.push(value),
    transport: async request => { calls.push(request); return { ...expected, verificationCursor: '98231', assignments: [{ tokenId: 'secret' }] }; },
  });
  assert.deepEqual(calls.map(call => call.action), ['status']);
  assert.deepEqual(progress, [expected]);
  assert.deepEqual(result, expected);
  assert.ok(!JSON.stringify(result).includes('secret'));
});

test('status requires numeric enrichment counts from maintenance transport', async () => {
  for (const field of ['pendingEnrichment', 'failedEnrichment'] as const) {
    for (const value of [undefined, -1, 0.5, '0']) {
      await assert.rejects(ownerHatchingControlMain(['status', ...identity], {
        transport: async () => ({ ...status(), [field]: value }) as OwnerHatchingMaintenanceResult,
      }), new RegExp(`invalid ${field}`));
    }
  }
});

test('verification preserves the frozen revision after registry and catalog changes', async () => {
  const calls: OwnerHatchingMaintenanceRequest[] = [];
  const result = await ownerHatchingControlMain(['verify', ...identity, '--write'], {
    registry: async () => ({ ...deployment, revision: 11, catalogRevision: 2, effectiveCatalogVersion: '111k-v10' }),
    transport: async request => {
      calls.push(request);
      return status({ phase: 'complete', complete: true, published: 350 });
    },
  });
  assert.deepEqual(calls, [{ action: 'verify', deploymentId: 'mainnet-v1', batchId: 'drowee-first', expectedRevision: 9 }]);
  assert.equal(typeof result === 'object' && result.complete, true);
});

test('explicit verification rejects published base metadata with pending or failed traits', async () => {
  for (const complete of [false, true]) {
    for (const failedEnrichment of [0, 1]) {
      await assert.rejects(ownerHatchingControlMain(['verify', ...identity, '--write'], {
        registry: async () => deployment,
        transport: async () => status({ phase: complete ? 'complete' : 'publishing', complete, published: 350,
          verificationCursor: '175', pendingEnrichment: 1, failedEnrichment }),
        sleep: async () => { throw new Error('Pending traits must not advance the verification cursor.'); },
      }), failedEnrichment ? /failed trait enrichments/ : /enrichment is incomplete/);
    }
  }
});
