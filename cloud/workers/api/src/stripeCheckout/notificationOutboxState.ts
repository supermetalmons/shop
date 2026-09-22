import { NOTIFICATION_PUBLICATION_RETRY_WINDOW_MS } from '../notificationOutboxPublication.js';
import { STRIPE_CHECKOUT_STATUS } from './contract.js';
import type { StripeCheckoutTerminalState } from './readModel.js';

export type StripeTerminalNotificationOutcome = 'fulfilled' | 'manual_review';
type StripeTerminalNotificationKind = 'buyer_order_received' | 'shipper_ready_to_ship' | 'stripe_checkout_manual_review';

export function stripeTerminalNotificationOutcome(
  checkout: StripeCheckoutTerminalState | null,
): StripeTerminalNotificationOutcome | null {
  if (checkout?.status === STRIPE_CHECKOUT_STATUS.FULFILLED) return 'fulfilled';
  if (
    checkout?.status === STRIPE_CHECKOUT_STATUS.FULFILLMENT_FAILED &&
    checkout.manualRefundReviewRequired === true
  ) return 'manual_review';
  return null;
}

function createStripeTerminalNotificationIntent(args: {
  parentPath: string;
  dropId: string;
  sessionId: string;
  outcome: StripeTerminalNotificationOutcome;
  deliveryId?: number;
  nowMs: number;
}): import('../../../../../shared/notificationOutbox.js').NotificationOutboxCreate {
  if (args.outcome === 'fulfilled' && (!Number.isSafeInteger(args.deliveryId) || Number(args.deliveryId) < 1)) {
    throw new Error('stripe_terminal_notification_delivery_id_invalid');
  }
  const kinds: StripeTerminalNotificationKind[] = args.outcome === 'fulfilled'
    ? ['buyer_order_received', 'shipper_ready_to_ship'] : ['stripe_checkout_manual_review'];
  return {
    parentPath: args.parentPath, family: 'stripe_terminal', dropId: args.dropId,
    generation: crypto.randomUUID(), outcome: args.outcome,
    retryUntilMs: args.nowMs + NOTIFICATION_PUBLICATION_RETRY_WINDOW_MS,
    entries: kinds.map((kind) => ({
      kind, jobId: crypto.randomUUID(), state: 'pending',
      idempotencyKey: kind === 'stripe_checkout_manual_review'
        ? `${args.dropId}:${args.sessionId}:stripe_manual_review`
        : `${args.dropId}:${args.deliveryId}:${kind === 'buyer_order_received' ? 'order_received' : 'ready_to_ship'}`,
    })),
  };
}

export async function enqueueStripeTerminalNotifications(args: {
  transaction: import('../commerceRepository.js').CommerceUnitOfWork;
  key: import('../commerceRepository.js').CommerceDocumentKey<'stripe_checkout'>;
  before: StripeCheckoutTerminalState | null;
  outcome: StripeTerminalNotificationOutcome;
  deliveryId?: number;
  nowMs: number;
  initializeMissing?: boolean;
}): Promise<void> {
  const current = await args.transaction.getNotificationOutbox(args.key.path, 'stripe_terminal');
  if (current?.outcome === args.outcome ||
    (!current && !args.initializeMissing && stripeTerminalNotificationOutcome(args.before) === args.outcome)) return;
  const intent = createStripeTerminalNotificationIntent({
    parentPath: args.key.path, dropId: args.key.dropId!, sessionId: args.key.documentId,
    outcome: args.outcome, deliveryId: args.deliveryId, nowMs: args.nowMs,
  });
  if (current) await args.transaction.replaceNotificationOutbox(intent);
  else await args.transaction.enqueueNotificationOutbox(intent);
}
