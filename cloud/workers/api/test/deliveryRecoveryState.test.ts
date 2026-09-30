import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createDeliveryRecoveryRecord,
  deliveryRecoveryRow,
  parseDeliveryRecoveryRecord,
  parseDeliveryRecoveryRow,
  updateDeliveryRecoveryRecord,
} from '../../../../shared/deliveryRecoveryState.ts';
import {
  preparedDeliveryRecoveryNextCheckMs,
  processingDeliveryRecoveryNextCheckMs,
} from '../../../../shared/deliveryRecovery.ts';

const parentPath = 'drops/card_nft_2/deliveryOrders/7';
const generation = '00000000-0000-4000-8000-000000000001';
const leaseId = '00000000-0000-4000-8000-000000000002';

function deliveryRecoveryProjections(receiptRecoveryJson: string) {
  const { preparedDelayMs, preparedExplicitAtMs, processingRetryAtMs, leaseExpiresAtMs } =
    createDeliveryRecoveryRecord({ parentPath, receiptRecoveryJson, nowMs: 1_000, generation });
  return { preparedDelayMs, preparedExplicitAtMs, processingRetryAtMs, leaseExpiresAtMs };
}

test('delivery recovery records preserve absent, explicit null, and legacy JSON exactly', () => {
  for (const receiptRecoveryJson of [null, 'null', '[]', '"legacy"', '{ "custom": [1, null], "attemptCount": "2.9", "lastAttemptAt": null }']) {
    const record = createDeliveryRecoveryRecord({ parentPath, receiptRecoveryJson, nowMs: 1_000, generation });
    assert.equal(record.receiptRecoveryJson, receiptRecoveryJson);
    assert.equal(record.revision, 1);
    assert.equal(record.leaseId, null);
    assert.deepEqual(parseDeliveryRecoveryRow(deliveryRecoveryRow(record)), record);
    const updated = updateDeliveryRecoveryRecord(record, { leaseId }, 900);
    assert.equal(updated.receiptRecoveryJson, receiptRecoveryJson);
    assert.equal(updated.revision, 2);
    assert.equal(updated.createdAtMs, 1_000);
    assert.equal(updated.updatedAtMs, 1_000);
    assert.equal(updated.leaseId, leaseId);
  }
});

test('delivery recovery projections preserve existing probe coercion and timing semantics', () => {
  const probeCounts: unknown[] = [undefined, null, 0, -3, 0.5, 1, 2.9, 3, '2.9', true, [2.9], 'Infinity', { legacy: true }];
  for (const preparedProbeCount of probeCounts) {
    for (const nextPreparedProbeAt of [undefined, null, -1, 0, '99', 99.5]) {
      const receiptRecovery = { preparedProbeCount, nextPreparedProbeAt, leaseExpiresAt: 120_000.5, lastAttemptAt: 99_000.5 };
      const projections = deliveryRecoveryProjections(JSON.stringify(receiptRecovery));
      const expected = preparedDeliveryRecoveryNextCheckMs({ createdAt: 100, receiptRecovery }, 200);
      const projected = projections.preparedDelayMs === null ? null
        : projections.preparedExplicitAtMs ?? 100 + projections.preparedDelayMs;
      assert.equal(projected, expected, JSON.stringify(receiptRecovery));
      assert.equal(
        Math.max(110_000, projections.processingRetryAtMs ?? 110_000, projections.leaseExpiresAtMs ?? 0),
        processingDeliveryRecoveryNextCheckMs({ status: 'processing', receiptRecovery }, 110_000),
      );
    }
  }
  assert.deepEqual(deliveryRecoveryProjections('{"lastAttemptAt":"90000","leaseExpiresAt":-2.5}'), {
    preparedDelayMs: 30_000, preparedExplicitAtMs: null, processingRetryAtMs: null, leaseExpiresAtMs: -2.5,
  });
  assert.equal(deliveryRecoveryProjections('{"lastAttemptAt":1e999}').processingRetryAtMs, null);
});

test('delivery recovery updates recompute projections without discarding journal or unknown fields', () => {
  const raw = { custom: { preserved: true }, pendingSubmission: { signature: 'pending' }, preparedProbeCount: '1.9' };
  const record = createDeliveryRecoveryRecord({ parentPath, receiptRecoveryJson: JSON.stringify(raw), nowMs: 1_000, generation });
  const updated = updateDeliveryRecoveryRecord(record, {
    receiptRecoveryJson: JSON.stringify({ ...raw, lastAttemptAt: 2_000, leaseExpiresAt: 4_000 }), leaseId,
  }, 2_000);
  assert.equal(updated.preparedDelayMs, 120_000);
  assert.equal(updated.processingRetryAtMs, 32_000);
  assert.equal(updated.leaseExpiresAtMs, 4_000);
  assert.deepEqual(JSON.parse(updated.receiptRecoveryJson!), { ...raw, lastAttemptAt: 2_000, leaseExpiresAt: 4_000 });
  assert.equal(updateDeliveryRecoveryRecord(updated, { receiptRecoveryJson: null, leaseId: null }, 3_000).receiptRecoveryJson, null);
});

test('delivery recovery parsing rejects corrupt projections, identities and revision bounds', () => {
  const record = createDeliveryRecoveryRecord({ parentPath, receiptRecoveryJson: '{}', nowMs: 1_000, generation });
  for (const changes of [
    { parentPath: 'drops/drop/stripeCheckouts/session' }, { generation: 'bad' }, { leaseId: 'bad' },
    { revision: 0 }, { revision: Number.MAX_SAFE_INTEGER + 1 }, { createdAtMs: -1 }, { updatedAtMs: 999 },
    { receiptRecoveryJson: '{' }, { receiptRecoveryJson: undefined }, { preparedDelayMs: 0 },
    { processingRetryAtMs: 50_000 }, { leaseExpiresAtMs: Number.POSITIVE_INFINITY },
  ]) {
    assert.throws(() => parseDeliveryRecoveryRecord({ ...record, ...changes }));
  }
  assert.throws(() => updateDeliveryRecoveryRecord({ ...record, revision: Number.MAX_SAFE_INTEGER }, {}, 2_000));
  assert.throws(() => updateDeliveryRecoveryRecord(record, {}, Number.NaN));
});
