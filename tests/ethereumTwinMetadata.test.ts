import assert from 'node:assert/strict';
import test from 'node:test';
import { runTwinMetadata } from '../scripts/ops/ethereumTwinMetadata.ts';
import { mixedAllocationHash } from '../shared/ethereum/revealMixedAllocation.ts';
import type { TwinMetadataCohortRow, TwinMetadataMaintenanceResult } from '../shared/ethereum/twinMetadataMaintenance.ts';

const rows: TwinMetadataCohortRow[] = ['2', '10', '11'].map((tokenId, i) => ({
  tokenId, paintingId: 30 + i, role: i ? 'evil twin' : 'good twin', beforeSha256: 'a'.repeat(64), etag: 'b'.repeat(32),
}));
const cohort = { deploymentId: 'mainnet-v1', operationId: 'mainnet-revealed-twins-20261119', expectedRevision: 15,
  cohortSha256: mixedAllocationHash(rows.map(r => [r.tokenId, r.paintingId, r.role, r.beforeSha256, r.etag])), rows };
const result = (phase: TwinMetadataMaintenanceResult['phase'], published: number): TwinMetadataMaintenanceResult => ({
  operationId: cohort.operationId, cohortSha256: cohort.cohortSha256, phase, total: 3, groups: 1, good: 1, evil: 2,
  published, registryRevision: 15, catalogRevision: 3, checked: 0, next: null,
});

test('resuming twin publication preserves the cohort and verifies every page without writes', async () => {
  const calls: string[] = [];
  const applied = await runTwinMetadata('apply', cohort, async request => {
    calls.push(request.action);
    assert.equal(request.rows, undefined);
    return request.action === 'inspect' ? result('publishing', 1) : result('complete', 3);
  });
  assert.equal(applied.published, 3);
  assert.deepEqual(calls, ['inspect', 'advance']);
  const offsets: number[] = [];
  const verified = await runTwinMetadata('verify', cohort, async request => {
    assert.equal(request.action, 'verify');
    offsets.push(request.after!);
    return { ...result('complete', 3), checked: request.after === 0 ? 2 : 1, next: request.after === 0 ? 2 : null };
  });
  assert.deepEqual(offsets, [0, 2]);
  assert.equal(verified.checked, 3);
});

test('twin inspection rejects a changed manifest and verification rejects short or repeated pages', async () => {
  await assert.rejects(runTwinMetadata('inspect', { ...cohort, cohortSha256: '0'.repeat(64) }, async () => {
    assert.fail('A changed manifest must not issue an RPC request');
  }), /digest|hash|checksum/i);
  for (const next of [null, 0]) {
    await assert.rejects(runTwinMetadata('verify', cohort, async () => ({ ...result('complete', 3), checked: 1, next })), /page/);
  }
});
