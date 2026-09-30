import assert from 'node:assert/strict';
import test from 'node:test';
import { Keypair } from '@solana/web3.js';
import { runLeasedReceiptRecoveryAttempt } from '../src/deliveryRecoveryAttempt.ts';
import { DeliveryReceiptError } from '../src/deliveryReceiptErrors.ts';
import { deliveryOrderKey, readDeliveryRecovery } from '../src/deliveryOrderStore.ts';
import { persistPendingReceiptSubmission } from '../src/deliveryReceiptStore.ts';
import { registerDeferredWork } from '../src/deferredWork.ts';
import { ReadyToShipNotificationEnqueueError } from '../src/readyToShipNotificationOutbox.ts';
import { claimRecoveryLease } from './deliveryRecoveryTestSupport.ts';
import { nativeDeliveryContext, OWNER, SIGNATURE, deliveryCleanupContext } from './deliveryStoreTestSupport.ts';

const key = deliveryOrderKey('drops/card_nft_2/deliveryOrders/7');
const origins = [{ kind: 'issue' }, { kind: 'recovery', statusBefore: 'processing' }] as const;

test('receipt attempt success finalizes only its owned state without rewriting the order', async (t) => {
  for (const origin of origins) {
    const native = await nativeDeliveryContext({ deliveryId: 7, owner: OWNER, status: 'processing' });
    t.after(() => native.harness.database.close());
    const lease = await claimRecoveryLease(native.context);
    const before = await readDeliveryRecovery(native.context, key);
    const result = { processed: true };
    assert.equal(await runLeasedReceiptRecoveryAttempt({
      context: native.context, key, lease, origin, operation: async () => result,
    }), result);
    const after = await readDeliveryRecovery(native.context, key);
    assert.equal(after?.state.leaseId, null);
    assert.equal(after?.order.version, before?.order.version);
    assert.equal(after?.order.updateTime, before?.order.updateTime);
  }
});

test('receipt attempts restore sparse history on cancellation and preserve unrelated abort-race errors', async (t) => {
  for (const origin of origins) {
    for (const domainWins of [false, true]) {
      const native = await nativeDeliveryContext({ deliveryId: 7, owner: OWNER, status: 'processing', receiptRecovery: { attemptCount: '2.9', lastAttemptAt: null } });
      t.after(() => native.harness.database.close());
      const lease = await claimRecoveryLease(native.context);
      const controller = new AbortController();
      native.context.signal = controller.signal;
      const reason = new Error('request cancelled');
      const error = domainWins ? new DeliveryReceiptError('unavailable', 'Provider failed first.') : reason;
      await assert.rejects(runLeasedReceiptRecoveryAttempt({
        context: native.context, key, lease, origin,
        operation: async () => { controller.abort(reason); throw error; },
      }), (thrown: unknown) => thrown === error);
      const after = await readDeliveryRecovery(native.context, key);
      assert.equal(after?.state.leaseId, null);
      const recovery = after?.order.data.receiptRecovery as Record<string, unknown>;
      assert.equal(recovery.attemptCount, domainWins ? 3 : '2.9');
      assert.equal(recovery.lastAttemptAt, domainWins ? lease.lastAttemptAtMs : null);
      assert.equal(recovery.lastErrorCode, domainWins ? 'unavailable' : undefined);
    }
  }
});

test('receipt attempt cancellation retains an ambiguous submission and its extended lease', async (t) => {
  const native = await nativeDeliveryContext({ deliveryId: 7, owner: OWNER, status: 'processing' });
  t.after(() => native.harness.database.close());
  const lease = await claimRecoveryLease(native.context);
  const pending = { signature: SIGNATURE, blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 123, assetIds: [Keypair.generate().publicKey.toBase58()] };
  const controller = new AbortController();
  native.context.signal = controller.signal;
  const reason = new Error('disconnected after broadcast');
  await assert.rejects(runLeasedReceiptRecoveryAttempt({
    context: native.context, key, lease, origin: origins[0],
    operation: async () => {
      await persistPendingReceiptSubmission(native.context, key, pending, lease, () => deliveryCleanupContext(native.context));
      controller.abort(reason);
      throw reason;
    },
  }), (error: unknown) => error === reason);
  const after = await readDeliveryRecovery(native.context, key);
  assert.equal(after?.state.leaseId, lease.leaseId);
  assert.ok(after!.state.leaseExpiresAtMs! > lease.leaseExpiresAtMs);
  assert.deepEqual((after?.order.data.receiptRecovery as Record<string, unknown>).pendingSubmission, pending);
});

test('receipt attempt origins preserve deferred-registration failure cleanup differences', async (t) => {
  for (const origin of origins) {
    const native = await nativeDeliveryContext({ deliveryId: 7, owner: OWNER, status: 'processing' });
    t.after(() => native.harness.database.close());
    const lease = await claimRecoveryLease(native.context);
    const cause = new Error('defer rejected');
    let failure: unknown;
    try { registerDeferredWork(() => { throw cause; }, Promise.resolve()); } catch (error) { failure = error; }
    await assert.rejects(runLeasedReceiptRecoveryAttempt({
      context: native.context, key, lease, origin, operation: async () => { throw failure; },
    }), (error: unknown) => error === failure);
    const after = await readDeliveryRecovery(native.context, key);
    assert.equal(after?.state.leaseId, origin.kind === 'issue' ? null : lease.leaseId);
  }
});

test('prepared retry scheduling observes the lease before finalization and notification failures propagate', async (t) => {
  for (const prepared of [true, false]) {
    const native = await nativeDeliveryContext({ deliveryId: 7, owner: OWNER, status: prepared ? 'prepared' : 'processing' });
    t.after(() => native.harness.database.close());
    native.context.nowMs = Date.now();
    const lease = await claimRecoveryLease(native.context);
    const error = prepared ? new DeliveryReceiptError('unavailable', 'provider retry') : new ReadyToShipNotificationEnqueueError();
    await assert.rejects(runLeasedReceiptRecoveryAttempt({
      context: native.context, key, lease, origin: { kind: 'recovery', statusBefore: prepared ? 'prepared' : 'processing' },
      operation: async () => { throw error; },
    }), (thrown: unknown) => thrown === error);
    const after = await readDeliveryRecovery(native.context, key);
    const recovery = after?.order.data.receiptRecovery as Record<string, unknown>;
    assert.equal(after?.state.leaseId, null);
    assert.equal(recovery.lastErrorCode, 'unavailable');
    if (prepared) assert.equal(recovery.nextPreparedProbeAt, lease.leaseExpiresAtMs);
  }
});

test('failed cleanup never masks the operation failure or releases its lease', async (t) => {
  const native = await nativeDeliveryContext({ deliveryId: 7, owner: OWNER, status: 'processing' });
  t.after(() => native.harness.database.close());
  const lease = await claimRecoveryLease(native.context);
  const failure = new Error('original operation failed');
  const unavailable = t.mock.method(native.context.repository, 'run', async () => { throw new Error('cleanup read failed'); });
  await assert.rejects(runLeasedReceiptRecoveryAttempt({
    context: native.context, key, lease, origin: origins[0], operation: async () => { throw failure; },
  }), (error: unknown) => error === failure);
  unavailable.mock.restore();
  assert.equal((await readDeliveryRecovery(native.context, key))?.state.leaseId, lease.leaseId);
});
