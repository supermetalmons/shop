import assert from 'node:assert/strict';
import bs58 from 'bs58';
import { Keypair } from '@solana/web3.js';
import type { CommerceRepositoryContext } from '../src/commerceTransactions.ts';
import { D1CommerceRepository, commerceKeys, type CommerceDocumentData } from '../src/commerceRepository.ts';
import { LEGACY_NOTIFICATION_FIELDS } from '../../../../shared/notificationOutbox.ts';
import { seedNotificationOutbox, type CommerceD1Harness, createCommerceD1Harness } from './commerceD1Harness.ts';

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
    readyToShipNotificationRetryUntilMs: READY_NOTIFICATION_RETRY_UNTIL_MS,
    readyToShipNotificationPublishAttemptCount: 0,
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
    await unit.create(commerceKeys.deliveryOrder('card_nft_2', '7'), withoutNotificationFields(fields));
  });
  seedReadyNotificationOutbox(harness, 7, fields);
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

export function withoutNotificationFields(fields: CommerceDocumentData): CommerceDocumentData {
  return Object.fromEntries(Object.entries(fields).filter(([key]) => !LEGACY_NOTIFICATION_FIELDS.some((field) => field === key)));
}

export function seedReadyNotificationOutbox(harness: CommerceD1Harness, deliveryId: number, fields: CommerceDocumentData): void {
  const pending = (['buyer_order_received', 'shipper_ready_to_ship'] as const).flatMap((kind) => {
    const prefix = kind === 'buyer_order_received' ? 'buyerOrderReceivedEmail' : 'shipperReadyToShipEmail';
    if (fields[`${prefix}State`] !== 'pending') return [];
    return [{ kind, jobId: String(fields[`${prefix}JobId`]), idempotencyKey: String(fields[`${prefix}IdempotencyKey`]) }];
  });
  if (!pending.length) return;
  seedNotificationOutbox(harness, {
    parentPath: commerceKeys.deliveryOrder('card_nft_2', String(deliveryId)).path, family: 'ready',
    dropId: 'card_nft_2', generation: crypto.randomUUID(), outcome: null, state: 'pending',
    entries: pending.map(({ kind, jobId, idempotencyKey }) => ({ kind, jobId, idempotencyKey, state: 'pending' })),
    revision: 1, attemptCount: 0, nextAttemptAtMs: READY_NOTIFICATION_NOW_MS,
    claimId: null, claimExpiresAtMs: null, retryUntilMs: READY_NOTIFICATION_RETRY_UNTIL_MS,
    createdAtMs: READY_NOTIFICATION_NOW_MS, updatedAtMs: READY_NOTIFICATION_NOW_MS, lastErrorCode: null,
  });
}
