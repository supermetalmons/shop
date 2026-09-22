import { buildStripeCheckoutManualReviewEmailContent } from '../notificationEmails.js';
import { normalizeNotificationEmailRecipient } from '../notifications.js';
import {
  createNotificationEmailJobV1,
  isNotificationEmailJobId,
  type NotificationEmailJobContext,
  type NotificationEmailJobV1,
} from '../../../../../shared/notificationEmailJob.js';
import { createStripeReadyToShipNotificationJobs } from '../stripeReadyNotifications.js';
import { STRIPE_CHECKOUT_STATUS } from './contract.js';
import { STRIPE_OFFCHAIN_DELIVERY_ORDER_SOURCE } from '../../../../../shared/fulfillmentSources.js';
import type { StripeCheckoutNotificationView, StripeCheckoutTerminalState } from './readModel.js';

const STRIPE_CHECKOUT_MANUAL_REVIEW_EMAIL = 'development@support.mons.shop';

type CheckoutDocument = {
  path: string;
  data: StripeCheckoutNotificationView;
};

export type StripeCheckoutTerminalNotificationDependencies = {
  loadCheckout: () => Promise<CheckoutDocument | null>;
  loadDeliveryOrder: (dropId: string, deliveryId: number) => Promise<Record<string, unknown> | null>;
  getDropName: (dropId: string) => string;
  createJobId?: () => string;
};

export type StripeCheckoutTerminalNotificationResult = {
  outcome: 'fulfilled' | 'manual_review' | 'not_terminal' | 'invalid';
  jobs: NotificationEmailJobV1[];
  reason?: string;
};

export function shouldPublishStripeCheckoutTerminalNotificationsWrite(args: {
  before: StripeCheckoutTerminalState | null;
  after: StripeCheckoutTerminalState;
}): boolean {
  if (!args.before) return false;
  if (args.after.status === STRIPE_CHECKOUT_STATUS.FULFILLED) {
    return args.before.status !== STRIPE_CHECKOUT_STATUS.FULFILLED;
  }
  return (
    args.after.status === STRIPE_CHECKOUT_STATUS.FULFILLMENT_FAILED &&
    args.after.manualRefundReviewRequired === true &&
    (
      args.before.status !== STRIPE_CHECKOUT_STATUS.FULFILLMENT_FAILED ||
      args.before.manualRefundReviewRequired !== true
    )
  );
}

function invalid(reason: string): StripeCheckoutTerminalNotificationResult {
  return { outcome: 'invalid', jobs: [], reason };
}

export async function prepareStripeCheckoutTerminalNotifications(args: {
  dropId: string;
  sessionId: string;
  jobIds?: Partial<Record<'buyer_order_received' | 'shipper_ready_to_ship' | 'stripe_checkout_manual_review', string>>;
  dependencies: StripeCheckoutTerminalNotificationDependencies;
}): Promise<StripeCheckoutTerminalNotificationResult> {
  const { dropId, sessionId, dependencies } = args;
  const checkoutDocument = await dependencies.loadCheckout();
  if (!checkoutDocument) return invalid('missing_checkout');
  const checkout = checkoutDocument.data;

  if (checkout.status === STRIPE_CHECKOUT_STATUS.FULFILLED) {
    const deliveryId = checkout.deliveryId;
    if (!deliveryId) return invalid('invalid_delivery_id');
    const order = await dependencies.loadDeliveryOrder(dropId, deliveryId);
    if (!order) return invalid('missing_delivery_order');
    if (order.source !== STRIPE_OFFCHAIN_DELIVERY_ORDER_SOURCE || order.status !== 'ready_to_ship') {
      return invalid('invalid_delivery_order');
    }
    let jobs: NotificationEmailJobV1[];
    try {
      jobs = await createStripeReadyToShipNotificationJobs({
        order,
        dropId,
        deliveryId,
        ...(args.jobIds ? { jobIds: args.jobIds } : {}),
        ...(dependencies.createJobId ? { createJobId: dependencies.createJobId } : {}),
      });
    } catch {
      return invalid('invalid_delivery_order');
    }
    return { outcome: 'fulfilled', jobs };
  }

  if (
    checkout.status !== STRIPE_CHECKOUT_STATUS.FULFILLMENT_FAILED ||
    checkout.manualRefundReviewRequired !== true
  ) {
    return { outcome: 'not_terminal', jobs: [] };
  }

  const recipient = normalizeNotificationEmailRecipient(STRIPE_CHECKOUT_MANUAL_REVIEW_EMAIL);
  if (!recipient) return invalid('invalid_manual_review_recipient');
  const idempotencyKey = `${dropId}:${sessionId}:stripe_manual_review`;
  const context: NotificationEmailJobContext = { dropId, sessionId };
  let job: NotificationEmailJobV1;
  try {
    const jobId = args.jobIds?.stripe_checkout_manual_review;
    if (jobId !== undefined && !isNotificationEmailJobId(jobId)) {
      return invalid('invalid_manual_review_notification');
    }
    const identity = checkout.identity;
    if (!identity) return invalid('invalid_manual_review_notification');
    const email = buildStripeCheckoutManualReviewEmailContent({
      idempotencyKey,
      recipients: [recipient],
      dropId,
      dropName: dependencies.getDropName(dropId),
      sessionId,
      checkoutPath: checkoutDocument.path,
      livemode: checkout.livemode,
      variantKey: checkout.variantKey,
      owner: identity.owner,
      ...('authSubject' in identity ? { authSubject: identity.authSubject } : {}),
      manualRefundReviewReason: checkout.manualRefundReviewReason,
      lastFulfillmentError: checkout.lastFulfillmentError,
      createdAt: checkout.createdAtMs,
      fulfillmentRequestedAt: checkout.fulfillmentRequestedAtMs,
      processingStartedAt: checkout.processingStartedAtMs,
      failedAt: checkout.failedAtMs,
    });
    job = createNotificationEmailJobV1({
      ...(jobId !== undefined ? { jobId } : {}),
      kind: 'stripe_checkout_manual_review',
      idempotencyKey,
      recipients: [recipient],
      subject: email.subject,
      text: email.text,
      html: email.html,
      context,
    }, dependencies.createJobId);
  } catch {
    return invalid('invalid_manual_review_notification');
  }
  return { outcome: 'manual_review', jobs: [job] };
}
