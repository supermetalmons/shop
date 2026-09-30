import assert from 'node:assert/strict';
import test from 'node:test';
import {
  acquireDeliveryRecoveryLease,
  acquireVerifiedReceiptIssuanceLease,
  cancelDeliveryRecoveryAttempt,
  deliveryRecoveryEligibility,
  finalizeDeliveryRecoveryAttempt,
  handlePreparedRecoveryFailure,
  patchDeliveryRecoveryRecord,
  recordPreparedDeliveryRecoveryMiss,
} from '../src/deliveryRecoveryStore.ts';
import { deliveryOrderKey, readDeliveryRecovery } from '../src/deliveryOrderStore.ts';
import { CommerceWriteConflict, commerceKeys, type CommerceDocumentData } from '../src/commerceRepository.ts';
import { DeliveryReceiptError } from '../src/deliveryReceiptErrors.ts';
import { type CommerceD1CallObservation } from './commerceD1Harness.ts';
import { OWNER, nativeDeliveryContext } from './deliveryStoreTestSupport.ts';
import { claimRecoveryLease } from './deliveryRecoveryTestSupport.ts';
import { createDeliveryRecoveryRecord, updateDeliveryRecoveryRecord } from '../../../../shared/deliveryRecoveryState.ts';

const key = deliveryOrderKey('drops/card_nft_2/deliveryOrders/7');

test('recovery mutation contracts require delivery keys and an owned lease token', () => {
  type RecoveryKey = Parameters<typeof acquireDeliveryRecoveryLease>[1];
  type Lease = Parameters<typeof cancelDeliveryRecoveryAttempt>[2];
  type Finalization = Parameters<typeof finalizeDeliveryRecoveryAttempt>[3];
  const boundaries: [
    ReturnType<typeof commerceKeys.stripeCheckout> extends RecoveryKey ? false : true,
    string extends RecoveryKey ? false : true,
    string extends Lease['leaseExpiresAtMs'] ? false : true,
    'lastErrorCode' extends keyof Finalization ? false : true,
    number extends Finalization['errorCode'] ? false : true,
    undefined extends Parameters<typeof finalizeDeliveryRecoveryAttempt>[2] ? false : true,
  ] = [true, true, true, true, true, true];
  assert.deepEqual(boundaries, [true, true, true, true, true, true]);
});

test('recovery leases preserve sparse and legacy raw fields when cancellation restores the order', async (context) => {
  const fixtures: CommerceDocumentData[] = [
    {}, { attemptCount: '2.9', lastAttemptAt: null },
    { attemptCount: { legacy: true }, lastAttemptAt: '90000' }, { attemptCount: 0, lastAttemptAt: 0 },
  ];
  for (const original of fixtures) {
    const recovery = { ...original, custom: { keep: true } };
    const native = await nativeDeliveryContext({ deliveryId: 7, status: 'processing', receiptRecovery: recovery, custom: ['keep'] });
    context.after(() => native.harness.database.close());
    const before = await readDeliveryRecovery(native.context, key);
    assert.ok(before);
    const result = await acquireDeliveryRecoveryLease(native.context, key, OWNER, 100_000, false);
    assert.equal(result.acquired, true);
    if (!result.acquired) assert.fail('legacy recovery fields must remain recoverable');
    assert.equal(result.lease.attemptCount, original.attemptCount === '2.9' ? 3 : 1);
    assert.deepEqual(result.lease.previousAttemptCount, original.attemptCount);
    assert.deepEqual(result.lease.previousLastAttemptAt, original.lastAttemptAt);
    await cancelDeliveryRecoveryAttempt(native.context, key, result.lease);
    const stored = await readDeliveryRecovery(native.context, key);
    assert.deepEqual(stored?.order.data.receiptRecovery, recovery);
    assert.deepEqual(stored?.order.data.custom, ['keep']);
    assert.equal(stored?.order.version, before.order.version);
    assert.equal(stored?.order.updateTime, before.order.updateTime);
    assert.equal(stored?.state.leaseId, null);
  }
});

test('recovery eligibility tolerates malformed and unknown legacy states without broad schema validation', () => {
  for (const receiptRecovery of [null, [], 'legacy', { lastAttemptAt: '99000' }]) {
    assert.deepEqual(deliveryRecoveryEligibility({ status: 'processing', receiptRecovery }, 100_000, false), { eligible: true });
  }
  for (const status of [undefined, 4, 'future-status']) {
    const order: CommerceDocumentData = status === undefined ? {} : { status };
    assert.deepEqual(deliveryRecoveryEligibility(order, 100_000, true), {
      eligible: false, outcome: 'skipped_status',
      message: `order status \`${typeof status === 'string' ? status : 'unknown'}\` is not recoverable`,
    });
  }
});

test('prepared recovery probes reject state-only changes without changing the parent', async (context) => {
  const native = await nativeDeliveryContext({ deliveryId: 7, status: 'prepared', receiptRecovery: { preparedProbeCount: 0 } });
  context.after(() => native.harness.database.close());
  const before = await readDeliveryRecovery(native.context, key);
  assert.ok(before);
  await native.context.repository.run(native.context.nowMs, async (unit) => {
    const current = await unit.getRecoverySnapshot(key);
    assert.ok(current);
    unit.stageRecovery(patchDeliveryRecoveryRecord(current.state, { preparedProbeCount: 2 }, native.context.nowMs));
  });
  await assert.rejects(recordPreparedDeliveryRecoveryMiss(native.context, before, 100_000), CommerceWriteConflict);
  const stored = await readDeliveryRecovery(native.context, key);
  assert.deepEqual(stored?.order.data.receiptRecovery, { preparedProbeCount: 2 });
  assert.equal(stored?.order.version, before.order.version);
  assert.equal(stored?.order.updateTime, before.order.updateTime);
});

test('recovery cancellation reads one snapshot and preserves a pending submission atomically', async (context) => {
  const calls: CommerceD1CallObservation[] = [];
  const native = await nativeDeliveryContext({ deliveryId: 7, status: 'processing' }, { observeCall: (call) => calls.push(call) });
  context.after(() => native.harness.database.close());
  const lease = await claimRecoveryLease(native.context);
  await native.context.repository.run(native.context.nowMs, async (unit) => {
    const snapshot = await unit.getRecoverySnapshot(key);
    assert.ok(snapshot);
    unit.stageRecovery(patchDeliveryRecoveryRecord(snapshot.state, { pendingSubmission: { malformed: true } }, native.context.nowMs));
  });
  const before = await readDeliveryRecovery(native.context, key);
  calls.length = 0;
  await cancelDeliveryRecoveryAttempt(native.context, key, lease);
  const reads = calls.flatMap((call) => call.method === 'batch' ? call.statements : [call])
    .filter(({ sql }) => sql.includes('document_json') && /\b(?:FROM|JOIN) commerce_documents\b/.test(sql));
  assert.equal(reads.length, 1);
  await finalizeDeliveryRecoveryAttempt(native.context, key, lease, { errorCode: 'unavailable' });
  assert.deepEqual(await readDeliveryRecovery(native.context, key), before);
});

test('owned finalization cannot clear a replacement lease and state-only completion preserves parent version', async (context) => {
  const native = await nativeDeliveryContext({ deliveryId: 7, owner: OWNER, status: 'processing' });
  context.after(() => native.harness.database.close());
  const first = await claimRecoveryLease(native.context);
  const next = await acquireDeliveryRecoveryLease(native.context, key, OWNER, first.leaseExpiresAtMs + 1, true);
  assert.ok(next.acquired);
  const before = await readDeliveryRecovery(native.context, key);
  assert.ok(before);
  await cancelDeliveryRecoveryAttempt(native.context, key, first);
  await finalizeDeliveryRecoveryAttempt(native.context, key, first, { errorCode: 'internal', message: 'stale' });
  assert.deepEqual(await readDeliveryRecovery(native.context, key), before);
  await finalizeDeliveryRecoveryAttempt(native.context, key, next.lease, {});
  const completed = await readDeliveryRecovery(native.context, key);
  assert.equal(completed?.state.leaseId, null);
  assert.equal(completed?.order.version, before.order.version);
  assert.equal(completed?.order.updateTime, before.order.updateTime);
});

test('concurrent recovery acquisition has one winner', async (context) => {
  const native = await nativeDeliveryContext({ deliveryId: 7, owner: OWNER, status: 'processing' });
  context.after(() => native.harness.database.close());
  const results = await Promise.all(Array.from({ length: 2 }, () =>
    acquireDeliveryRecoveryLease(native.context, key, OWNER, native.context.nowMs, true)));
  assert.equal(results.filter((result) => result.acquired).length, 1);
  assert.deepEqual(results.filter((result) => !result.acquired).map((result) => result.result.outcome), ['lease_active']);
});

test('delivery recovery eligibility preserves backoff, prepared probes, and force behavior', () => {
  assert.deepEqual(deliveryRecoveryEligibility({ status: 'processing', receiptRecovery: { lastAttemptAt: 99_000 } }, 100_000, false), {
    eligible: false, outcome: 'not_eligible', message: 'processing order retry backoff is active',
  });
  assert.deepEqual(deliveryRecoveryEligibility({ status: 'prepared', createdAt: 100, receiptRecovery: { preparedProbeCount: 3 } }, 100_000, false), {
    eligible: false, outcome: 'not_eligible', message: 'prepared order recovery checks are exhausted',
  });
  assert.deepEqual(deliveryRecoveryEligibility({ status: 'prepared_abandoned' }, 100_000, true), { eligible: true });
});

test('prepared recovery failures preserve ownership and schedule before lease release', async (context) => {
  const native = await nativeDeliveryContext({ deliveryId: 7, owner: OWNER, status: 'prepared', receiptRecovery: { preparedProbeCount: 0 } });
  context.after(() => native.harness.database.close());
  const lease = await claimRecoveryLease(native.context);
  await handlePreparedRecoveryFailure(native.context, key, lease, 'missing_delivery', 'failed-precondition', native.context.nowMs + 1000);
  await handlePreparedRecoveryFailure(native.context, key, lease, 'failed', 'unavailable', native.context.nowMs + 2000);
  const recovered = await readDeliveryRecovery(native.context, key);
  const recovery = recovered?.order.data.receiptRecovery as Record<string, unknown>;
  assert.equal(recovery.preparedProbeCount, 1);
  assert.equal(recovery.lastPreparedProbeAt, native.context.nowMs + 1000);
  assert.equal(recovery.nextPreparedProbeAt, lease.leaseExpiresAtMs);
  await handlePreparedRecoveryFailure(native.context, key, lease, 'failed', 'failed-precondition', native.context.nowMs + 3000);
  const abandoned = await readDeliveryRecovery(native.context, key);
  assert.equal(abandoned?.order.data.status, 'prepared_abandoned');
  assert.equal((abandoned?.order.data.receiptRecovery as Record<string, unknown>).nextPreparedProbeAt, undefined);
});

test('verified legacy issuance acquires a mandatory lease without broadening recovery eligibility', async (context) => {
  for (const status of [undefined, 3, 'legacy-complete']) {
    const native = await nativeDeliveryContext({ deliveryId: 7, owner: OWNER, ...(status === undefined ? {} : { status }) });
    context.after(() => native.harness.database.close());
    const skipped = await acquireDeliveryRecoveryLease(native.context, key, OWNER, native.context.nowMs, true);
    assert.ok(!skipped.acquired);
    assert.equal(skipped.result.outcome, 'skipped_status');
    const verified = await readDeliveryRecovery(native.context, key);
    assert.ok(verified);
    const claimed = await acquireVerifiedReceiptIssuanceLease(native.context, verified, OWNER, native.context.nowMs);
    assert.equal(claimed.snapshot.state.leaseId, claimed.lease.leaseId);
    assert.equal(claimed.snapshot.state.revision, verified.state.revision + 1);
    await assert.rejects(acquireVerifiedReceiptIssuanceLease(native.context, verified, OWNER, native.context.nowMs),
      (error: unknown) => error instanceof DeliveryReceiptError && error.code === 'aborted');
    const active = await readDeliveryRecovery(native.context, key);
    assert.ok(active);
    await assert.rejects(acquireVerifiedReceiptIssuanceLease(native.context, active, OWNER, native.context.nowMs),
      (error: unknown) => error instanceof DeliveryReceiptError && error.code === 'aborted');
  }
});

test('verified issuance rejects changed parents and delete-recreate generations', async (context) => {
  for (const recreate of [false, true]) {
    const native = await nativeDeliveryContext({ deliveryId: 7, owner: OWNER, status: 'legacy' });
    context.after(() => native.harness.database.close());
    const verified = await readDeliveryRecovery(native.context, key);
    assert.ok(verified);
    if (recreate) {
      await native.context.repository.run(native.context.nowMs, async (unit) => { await unit.get(key); await unit.delete(key); });
      await native.context.repository.run(native.context.nowMs, (unit) => unit.create(key, { deliveryId: 7, owner: OWNER, status: 'legacy' }));
    } else {
      await native.context.repository.run(native.context.nowMs, async (unit) => { await unit.get(key); await unit.update(key, { itemIds: ['changed'] }); });
    }
    await assert.rejects(acquireVerifiedReceiptIssuanceLease(native.context, verified, OWNER, native.context.nowMs),
      (error: unknown) => error instanceof DeliveryReceiptError && error.code === 'aborted');
    assert.equal((await readDeliveryRecovery(native.context, key))?.state.leaseId, null);
  }
});

test('lease mutations preserve untouched recovery JSON and cancellation restores exact prior number fragments', async (context) => {
  const custom = '{"integer":9007199254740993,"overflow":1e999,"nested":[-9007199254740993,{"text":"braces } ], comma, quote \\\" slash \\\\"}]}';
  const escapedProperty = '"escaped\\u004bey" : [9007199254740993,1e999,{"duplicate":1,"duplicate":2}]';
  for (const finalization of ['finalize', 'cancel'] as const) {
    for (const previous of [
      { attemptCount: '9007199254740993', lastAttemptAt: '1e999' },
      { attemptCount: '{"legacy":[9007199254740993,1e999]}', lastAttemptAt: '[-9007199254740993,{"overflow":1e999}]' },
      { attemptCount: '1e999', lastAttemptAt: '9007199254740993' },
    ]) {
      const native = await nativeDeliveryContext({ deliveryId: 7, owner: OWNER, status: 'processing' });
      context.after(() => native.harness.database.close());
      const raw = `{ "custom":${custom}, ${escapedProperty}, "attempt\\u0043ount":${previous.attemptCount}, "lastAttemptAt":${previous.lastAttemptAt} }`;
      await native.context.repository.run(native.context.nowMs, async (unit) => {
        const snapshot = await unit.getRecoverySnapshot(key);
        assert.ok(snapshot);
        unit.stageRecovery(updateDeliveryRecoveryRecord(snapshot.state, { receiptRecoveryJson: raw }, native.context.nowMs));
      });
      const lease = await claimRecoveryLease(native.context);
      assert.equal(lease.previousAttemptCountJson, previous.attemptCount);
      assert.equal(lease.previousLastAttemptAtJson, previous.lastAttemptAt);
      const acquired = await readDeliveryRecovery(native.context, key);
      assert.ok(acquired?.state.receiptRecoveryJson?.includes(`"custom":${custom}`));
      assert.ok(acquired?.state.receiptRecoveryJson?.includes(escapedProperty));
      if (finalization === 'cancel') await cancelDeliveryRecoveryAttempt(native.context, key, lease);
      else await finalizeDeliveryRecoveryAttempt(native.context, key, lease, { errorCode: 'unavailable', message: 'retry' });
      const final = await readDeliveryRecovery(native.context, key);
      assert.ok(final?.state.receiptRecoveryJson?.includes(`"custom":${custom}`));
      assert.ok(final?.state.receiptRecoveryJson?.includes(escapedProperty));
      if (finalization === 'cancel') {
        assert.ok(final?.state.receiptRecoveryJson?.includes(`"attemptCount":${previous.attemptCount}`));
        assert.ok(final?.state.receiptRecoveryJson?.includes(`"lastAttemptAt":${previous.lastAttemptAt}`));
      }
      assert.equal(final?.state.leaseId, null);
    }
  }
});

test('recovery JSON patches retain duplicate unknown properties and mutate scalar roots as objects', () => {
  const nowMs = 1000;
  const original = createDeliveryRecoveryRecord({
    parentPath: key.path, generation: crypto.randomUUID(), nowMs,
    receiptRecoveryJson: '{"custom":9007199254740993,"custom":1e999,"attemptCount":2,"attempt\\u0043ount":3}',
  });
  const updated = patchDeliveryRecoveryRecord(original, { attemptCount: 4 }, nowMs);
  assert.equal(updated.receiptRecoveryJson, '{"custom":9007199254740993,"custom":1e999,"attemptCount":4}');
  for (const receiptRecoveryJson of [null, 'null', '1e999', '9007199254740993', '"legacy"', '[1e999]']) {
    const record = createDeliveryRecoveryRecord({ parentPath: key.path, generation: crypto.randomUUID(), nowMs, receiptRecoveryJson });
    assert.equal(patchDeliveryRecoveryRecord(record, { attemptCount: 1 }, nowMs).receiptRecoveryJson, '{"attemptCount":1}');
  }
});
