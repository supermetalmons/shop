import assert from 'node:assert/strict';
import bs58 from 'bs58';
import { Keypair } from '@solana/web3.js';
import type { CommerceRepositoryContext } from '../src/commerceTransactions.ts';
import { D1CommerceRepository, commerceKeys, type CommerceDocumentData } from '../src/commerceRepository.ts';
import {
  READY_TO_SHIP_NOTIFICATION_PUBLISH_ATTEMPT_COUNT_FIELD,
  READY_TO_SHIP_NOTIFICATION_RETRY_UNTIL_MS_FIELD,
} from '../src/readyToShipNotifications.ts';
import { createCommerceD1Harness } from './commerceD1Harness.ts';

export const OWNER = Keypair.generate().publicKey.toBase58();
export const SIGNATURE = bs58.encode(new Uint8Array(64).fill(7));
export const SECOND_SIGNATURE = bs58.encode(new Uint8Array(64).fill(8));
export const READY_NOTIFICATION_NOW_MS = 1_700_000_000_000;
export const READY_NOTIFICATION_RETRY_UNTIL_MS = 8_000_000_000_000;
export function notificationQueue(overrides: Partial<Queue> = {}): Queue {
  const metrics = { backlogCount: 0, backlogBytes: 0 };
  return {
    metrics: async () => metrics,
    send: async () => ({ metadata: { metrics } }),
    sendBatch: async () => ({ metadata: { metrics } }),
    ...overrides,
  };
}

export function readyNotificationOrderFields(deliveryId: number, includeShipper = false): CommerceDocumentData {
  return {
    dropId: 'card_nft_2',
    deliveryId,
    owner: OWNER,
    status: 'ready_to_ship',
    processedAt: 1_700_000_000_000,
    addressSnapshot: { email: 'buyer@example.com' },
    items: [{ kind: 'box', refId: deliveryId }],
    buyerOrderReceivedEmailState: 'pending',
    buyerOrderReceivedEmailJobId: `00000000-0000-4000-8000-${String(deliveryId).padStart(12, '0')}`,
    buyerOrderReceivedEmailIdempotencyKey: `card_nft_2:${deliveryId}:order_received`,
    [READY_TO_SHIP_NOTIFICATION_RETRY_UNTIL_MS_FIELD]: READY_NOTIFICATION_RETRY_UNTIL_MS,
    [READY_TO_SHIP_NOTIFICATION_PUBLISH_ATTEMPT_COUNT_FIELD]: 0,
    ...(includeShipper ? {
      shipperReadyToShipEmailState: 'pending',
      shipperReadyToShipEmailJobId: `00000000-0000-4000-9000-${String(deliveryId).padStart(12, '0')}`,
      shipperReadyToShipEmailIdempotencyKey: `card_nft_2:${deliveryId}:ready_to_ship`,
    } : {}),
  };
}

export async function nativeDeliveryContext(
  fields: CommerceDocumentData,
  options: Parameters<typeof createCommerceD1Harness>[0] = {},
) {
  const harness = createCommerceD1Harness(options);
  const repository = new D1CommerceRepository(harness.db);
  await repository.run(READY_NOTIFICATION_NOW_MS, async (unit) => {
    await unit.create(commerceKeys.deliveryOrder('card_nft_2', '7'), fields);
  });
  return {
    harness,
    context: {
      repository,
      nowMs: READY_NOTIFICATION_NOW_MS,
      providerFetch: async () => assert.fail('commerce persistence must not use provider fetch'),
      signal: new AbortController().signal,
      dataDb: undefined as D1Database | undefined,
    },
  };
}

export function deliveryCleanupContext(context: CommerceRepositoryContext) {
  return { repository: context.repository, nowMs: Date.now(), signal: AbortSignal.timeout(5_000) };
}
