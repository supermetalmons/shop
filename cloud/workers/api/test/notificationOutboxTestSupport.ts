import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import type { NotificationEmailJobV1 } from '../../../../shared/notificationEmailJob.ts';
import type { NotificationOutboxFamily, NotificationOutboxMutation, NotificationOutboxCreate } from '../../../../shared/notificationOutbox.ts';
import { commerceKeys, D1CommerceRepository, type CommerceDocumentData } from '../src/commerceRepository.ts';
import { createReadyToShipNotificationIntent } from '../src/readyToShipNotifications.ts';
import { publishReadyToShipNotifications } from '../src/readyToShipNotificationOutbox.ts';
import { publishPendingStripeCheckoutTerminalNotifications } from '../src/stripeCheckout/notificationOutbox.ts';
import { createCommerceD1Harness, seedCommerceDocument } from './commerceD1Harness.ts';

export const OUTBOX_NOW = 1_800_000_000_000;
export const OUTBOX_LEASE = 10 * 60_000;
export const OUTBOX_WINDOW = 6 * 60 * 60_000;
export const OUTBOX_DROP = 'card_nft_2';

export async function notificationFixture(context: TestContext, family: Exclude<NotificationOutboxFamily, 'shipped'>, options: {
  outcome?: 'fulfilled' | 'manual_review';
  dropId?: string;
  create?: boolean;
  buyerOnly?: boolean;
} = {}) {
  const dropId = options.dropId ?? OUTBOX_DROP;
  const harness = createCommerceD1Harness();
  context.after(() => harness.database.close());
  context.mock.method(console, 'log', () => undefined);
  context.mock.method(console, 'error', () => undefined);
  const repository = new D1CommerceRepository(harness.db);
  const orderKey = commerceKeys.deliveryOrder(dropId, '7');
  const parentKey = family === 'ready' ? orderKey : commerceKeys.stripeCheckout(dropId, 'cs_notification');
  const outcome = options.outcome ?? 'fulfilled';
  const order: CommerceDocumentData = {
    dropId: dropId, deliveryId: 7, owner: 'owner-wallet', status: 'ready_to_ship',
    source: family === 'ready' ? 'wallet' : 'stripe_offchain',
    addressSnapshot: { email: 'buyer@example.com' }, items: [{ kind: 'box', refId: 7 }],
  };
  seedCommerceDocument(harness, { key: orderKey, data: order });
  if (family === 'stripe_terminal') seedCommerceDocument(harness, { key: parentKey, data: {
    deliveryId: 7, status: outcome === 'fulfilled' ? 'fulfilled' : 'fulfillment_failed',
    manualRefundReviewRequired: outcome === 'manual_review', manualRefundReviewReason: 'fulfillment_failed_after_payment',
    owner: 'anonymous:anon:terminal', ownerKind: 'anonymous', authSubject: 'anon:terminal',
  } });
  let now = OUTBOX_NOW;
  const intent = family === 'ready'
    ? createReadyToShipNotificationIntent({ before: {}, after: order, dropId: dropId,
      deliveryId: 7, parentPath: parentKey.path, nowMs: now })!
    : createStripeTerminalNotificationIntent({ parentPath: parentKey.path, dropId: dropId,
      sessionId: parentKey.documentId, outcome, deliveryId: 7, nowMs: now });
  if (options.buyerOnly) intent.entries = intent.entries.filter((entry) => entry.kind === 'buyer_order_received');
  if (options.create !== false) await repository.run(now, (unit) => unit.enqueueNotificationOutbox(intent));
  const sent: NotificationEmailJobV1[][] = [];
  const queue = { sendBatch: async (messages: Iterable<MessageSendRequest<NotificationEmailJobV1>>) => {
    sent.push(Array.from(messages, (message) => structuredClone(message.body)));
    return { metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } };
  } };
  const read = async () => {
    const record = await repository.notificationOutbox.get(parentKey.path, family);
    assert.ok(record);
    return record;
  };
  const mutate = async (changes: NotificationOutboxMutation) => {
    const updated = await repository.notificationOutbox.compareAndSet({ expected: await read(), changes, nowMs: now });
    assert.ok(updated);
    return updated;
  };
  const nowMs = () => now;
  const publish = async (overrides: {
    signal?: AbortSignal;
    queue?: typeof queue;
    initializeMissing?: boolean;
    getDropName?: (dropId: string) => string;
  } = {}) => {
    const signal = overrides.signal ?? new AbortController().signal;
    if (family === 'ready') {
      const document = await repository.get(parentKey);
      assert.ok(document);
      return publishReadyToShipNotifications({ context: { repository, nowMs: now, signal },
        document, dropId: dropId, deliveryId: 7, nowMs, queue: overrides.queue ?? queue });
    }
    return publishPendingStripeCheckoutTerminalNotifications({
      commerce: { repository, nowMs, signal }, dropId: dropId, sessionId: parentKey.documentId,
      signal, nowMs, queue: overrides.queue ?? queue, initializeMissing: overrides.initializeMissing,
      getDropName: overrides.getDropName ?? (() => 'Card NFT 2'),
    });
  };
  return { harness, repository, orderKey, parentKey, intent, sent, queue, read, mutate, publish, nowMs,
    setTime: (value: number) => { now = value; },
    updateOrder: (values: CommerceDocumentData) => repository.run(now, (unit) => unit.update(orderKey, values)),
  };
}

export function createStripeTerminalNotificationIntent(args: {
  parentPath: string; dropId: string; sessionId: string; outcome: 'fulfilled' | 'manual_review'; deliveryId?: number; nowMs: number;
}): NotificationOutboxCreate {
  return {
    parentPath: args.parentPath, family: 'stripe_terminal', dropId: args.dropId, outcome: args.outcome,
    generation: crypto.randomUUID(), retryUntilMs: args.nowMs + OUTBOX_WINDOW,
    entries: args.outcome === 'manual_review'
      ? [{ kind: 'stripe_checkout_manual_review', jobId: crypto.randomUUID(),
        idempotencyKey: `${args.dropId}:${args.sessionId}:stripe_manual_review`, state: 'pending' }]
      : [
        { kind: 'buyer_order_received', jobId: crypto.randomUUID(), idempotencyKey: `${args.dropId}:${args.deliveryId}:order_received`, state: 'pending' },
        { kind: 'shipper_ready_to_ship', jobId: crypto.randomUUID(), idempotencyKey: `${args.dropId}:${args.deliveryId}:ready_to_ship`, state: 'pending' },
      ],
  };
}
