import { buildStripeCheckoutManualReviewEmailContent } from '../notificationEmails.js';
import { normalizeNotificationEmailRecipient } from '../notifications.js';
import {
  createNotificationEmailJobV1,
  isNotificationEmailJobId,
  type NotificationEmailJobContext,
  type NotificationEmailJobV1,
} from '../../../../../shared/notificationEmailJob.js';
import { toMillisMaybe } from '../time.js';
import { createStripeReadyToShipNotificationJobs } from '../stripeReadyNotifications.js';
import { STRIPE_CHECKOUT_STATUS } from './contract.js';
import { normalizeStripeCheckoutIdentity } from '../../../../../shared/checkoutIdentity.js';
import { STRIPE_OFFCHAIN_DELIVERY_ORDER_SOURCE } from '../../../../../shared/fulfillmentSources.js';

const STRIPE_CHECKOUT_MANUAL_REVIEW_EMAIL = 'development@support.mons.shop';

type CheckoutDocument = {
  path: string;
  data: Record<string, unknown>;
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
  before: Record<string, unknown> | null;
  after: Record<string, unknown>;
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

function optionalTrimmedString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function positiveDeliveryId(value: unknown): number | undefined {
  const deliveryId = Number(value);
  return Number.isSafeInteger(deliveryId) && deliveryId > 0 ? deliveryId : undefined;
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
    const deliveryId = positiveDeliveryId(checkout.deliveryId);
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
    const identity = normalizeStripeCheckoutIdentity(checkout);
    const email = buildStripeCheckoutManualReviewEmailContent({
      idempotencyKey,
      recipients: [recipient],
      dropId,
      dropName: dependencies.getDropName(dropId),
      sessionId,
      checkoutPath: checkoutDocument.path,
      livemode: checkout.livemode === true,
      variantKey: optionalTrimmedString(checkout.variantKey),
      owner: identity.owner,
      ...('authSubject' in identity ? { authSubject: identity.authSubject } : {}),
      manualRefundReviewReason: optionalTrimmedString(checkout.manualRefundReviewReason),
      lastFulfillmentError: checkout.lastFulfillmentError,
      createdAt: toMillisMaybe(checkout.createdAt),
      fulfillmentRequestedAt: toMillisMaybe(checkout.fulfillmentRequestedAt),
      processingStartedAt: toMillisMaybe(checkout.processingStartedAt),
      failedAt: toMillisMaybe(checkout.failedAt),
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
