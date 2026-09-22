import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CommerceWriteConflict,
  D1CommerceRepository,
  commerceKeys,
} from '../src/commerceRepository.ts';
import {
  createPreparedDeliveryOrder,
  deletePreparedDeliveryOrder,
  type PreparedDeliveryCommerceContext,
  type PreparedDeliveryInput,
} from '../src/deliveryPreparationStore.ts';
import type { NotificationOutboxMutation } from '../../../../shared/notificationOutbox.ts';
import type { DeliveryPackStatusProjectionUpdates } from '../src/deliveryPackStatusOutbox.ts';
import { createCommerceD1Harness } from './commerceD1Harness.ts';

const key = commerceKeys.deliveryOrder('card_nft_2', '7');
const input: PreparedDeliveryInput = {
  path: key.path,
  dropId: 'card_nft_2',
  owner: 'owner',
  addressId: 'address',
  address: { decoded: { encrypted: 'cipher', futureAddressField: 'preserved' } },
  addressCountry: 'US',
  items: [{ assetId: 'asset', kind: 'box', refId: 7 }],
  deliveryId: 7,
  deliveryPda: 'delivery-pda',
  deliveryLamports: 200_000_000,
  nextPreparedProbeAtMs: 30_000,
  prepareAttemptId: 'original-attempt',
};

test('typed prepared creation preserves address metadata and native timestamps', async (t) => {
  const harness = createCommerceD1Harness();
  t.after(() => harness.database.close());
  const repository = new D1CommerceRepository(harness.db);
  await createPreparedDeliveryOrder({ repository, nowMs: 1_000, signal: new AbortController().signal }, input);
  assert.deepEqual((await repository.get(key))?.data, {
    dropId: 'card_nft_2', status: 'prepared', owner: 'owner', addressId: 'address',
    addressSnapshot: { encrypted: 'cipher', futureAddressField: 'preserved', id: 'address', countryCode: 'US' },
    itemIds: ['asset'], items: [{ assetId: 'asset', kind: 'box', refId: 7 }],
    deliveryId: 7, deliveryPda: 'delivery-pda', deliveryLamports: 200_000_000,
    prepareAttemptId: 'original-attempt', receiptRecovery: { preparedProbeCount: 0, nextPreparedProbeAt: 30_000 },
    createdAt: 1_000,
  });
});

test('prepared delivery cleanup cannot delete a newer revision', async (t) => {
  const harness = createCommerceD1Harness();
  t.after(() => harness.database.close());
  const repository = new D1CommerceRepository(harness.db);
  const context = { repository, nowMs: 1_000, signal: new AbortController().signal };
  const preparedRevision = await createPreparedDeliveryOrder(context, input);
  await repository.run(2_000, (transaction) => transaction.update(key, { status: 'processing' }));
  const newer = await repository.get(key);

  await assert.rejects(deletePreparedDeliveryOrder(context, key.path, preparedRevision), CommerceWriteConflict);
  assert.deepEqual(await repository.get(key), newer);

  assert.ok(newer);
  await deletePreparedDeliveryOrder(context, key.path, newer.updateTime);
  assert.equal(await repository.get(key), null);
});

test('prepared delivery reconciliation accepts its own operation and rejects a competing attempt', async (t) => {
  const harness = createCommerceD1Harness();
  t.after(() => harness.database.close());
  const repository = new D1CommerceRepository(harness.db);
  const context = { repository, nowMs: 1_000, signal: new AbortController().signal };
  const revision = await createPreparedDeliveryOrder(context, input);

  assert.equal(await createPreparedDeliveryOrder(context, input), revision);
  await assert.rejects(createPreparedDeliveryOrder(context, {
    ...input,
    prepareAttemptId: 'competing-attempt',
  }), CommerceWriteConflict);
  assert.equal((await repository.get(key))?.data.prepareAttemptId, input.prepareAttemptId);
});

function checkWriteContracts(context: PreparedDeliveryCommerceContext): void {
  // @ts-expect-error Preparation accepts domain inputs, not arbitrary document fields.
  void createPreparedDeliveryOrder(context, { ...input, status: 'ready_to_ship' });
  // @ts-expect-error Only the supported delivery item kinds may be persisted.
  void createPreparedDeliveryOrder(context, { ...input, items: [{ assetId: 'asset', kind: 'checkout', refId: 7 }] });
  // @ts-expect-error Notification states are a closed domain union.
  const invalidNotification: NotificationOutboxMutation = { state: 'done' };
  // @ts-expect-error Projection payloads cannot mutate unrelated commerce fields.
  const invalidProjection: DeliveryPackStatusProjectionUpdates = { owner: 'another-wallet' };
  void invalidNotification;
  void invalidProjection;
}

void checkWriteContracts;
