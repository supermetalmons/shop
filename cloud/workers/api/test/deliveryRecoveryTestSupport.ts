import assert from 'node:assert/strict';
import type { CommerceDocumentKey } from '../src/commerceRepository.ts';
import type { CommerceRepositoryContext } from '../src/commerceTransactions.ts';
import { deliveryOrderKey, readDeliveryRecovery } from '../src/deliveryOrderStore.ts';
import { acquireDeliveryRecoveryLease, type DeliveryRecoveryLease } from '../src/deliveryRecoveryStore.ts';
import { OWNER } from './deliveryStoreTestSupport.ts';

export async function readRecoveryDocument(context: CommerceRepositoryContext, key: CommerceDocumentKey) {
  const snapshot = await readDeliveryRecovery(context, deliveryOrderKey(key.path));
  return snapshot?.order ?? null;
}

export async function claimRecoveryLease(
  context: CommerceRepositoryContext,
  path = 'drops/card_nft_2/deliveryOrders/7',
): Promise<DeliveryRecoveryLease> {
  const acquired = await acquireDeliveryRecoveryLease(context, deliveryOrderKey(path), OWNER, context.nowMs, true);
  if (!acquired.acquired) assert.fail(acquired.result.message);
  return acquired.lease;
}
