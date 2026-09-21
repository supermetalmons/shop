import {
  StripeCheckoutSessionError,
  type StripeCheckoutCreatedDocument,
} from '../../../../../shared/stripeCheckoutSession.js';
import {
  stripeWebhookTransition,
  type StripeWebhookAction,
  type StripeWebhookTransition,
} from '../../../../../shared/stripeWebhook.js';
import {
  CommerceRepositoryError,
  commerceFieldValue,
  commerceKeyFromPath,
  commerceKeys,
  type CommerceDocumentWriteData,
} from '../commerceRepository.js';
import { runCommerceTransaction, type CommerceTransactionTarget } from '../commerceTransactions.js';
import { stripeCheckoutWriteData } from './commerce.js';

type StripeCheckoutIdentity = { dropId: string; sessionId: string };
type ReconciliationFailure = { name: string; message?: string };

export function createStripeCheckoutDocument(
  commerce: CommerceTransactionTarget,
  path: string,
  document: StripeCheckoutCreatedDocument,
): Promise<void> {
  const key = commerceKeyFromPath(path);
  if (!key || key.kind !== 'stripe_checkout') {
    throw new CommerceRepositoryError('invalid-argument', 'Invalid Stripe checkout document path.');
  }
  return runCommerceTransaction(commerce, async (transaction) => {
    const existing = await transaction.get(key);
    if (existing) {
      if (
        existing.data.operationId === document.operationId &&
        existing.data.sessionId === document.sessionId &&
        existing.data.dropId === document.dropId
      ) return;
      throw new StripeCheckoutSessionError('failed-precondition', 'Stripe checkout operation conflicts with an existing session.');
    }
    await transaction.create(key, stripeCheckoutWriteData({
      ...document,
      createdAt: commerceFieldValue.serverTimestamp(),
      updatedAt: commerceFieldValue.serverTimestamp(),
    }));
  }, { shouldRetry: (error) => error.code === 'aborted' });
}

function webhookWriteData(
  action: Extract<StripeWebhookAction, { kind: 'enqueue' }>,
  transition: StripeWebhookTransition,
): CommerceDocumentWriteData {
  return {
    ...transition.fields,
    ...Object.fromEntries(transition.deleteFields.map((field) => [field, commerceFieldValue.delete()])),
    stripeWebhookEventIds: commerceFieldValue.arrayUnion(action.eventId),
    ...Object.fromEntries(transition.serverTimestampFields.map((field) => [field, commerceFieldValue.serverTimestamp()])),
  } as CommerceDocumentWriteData;
}

export function applyStripeCheckoutWebhook(
  action: Extract<StripeWebhookAction, { kind: 'enqueue' }>,
  commerce: CommerceTransactionTarget,
): Promise<Pick<StripeWebhookTransition, 'outcome' | 'deliveryId'>> {
  const key = commerceKeys.stripeCheckout(action.dropId, action.sessionId);
  return runCommerceTransaction(commerce, async (transaction) => {
    const document = await transaction.get(key);
    if (!document) throw new Error('Stripe checkout session was not created by this app');
    const transition = stripeWebhookTransition(document.data, action);
    await transaction.update(key, webhookWriteData(action, transition));
    return { outcome: transition.outcome, ...(transition.deliveryId ? { deliveryId: transition.deliveryId } : {}) };
  });
}

export function markStripeCheckoutReenqueued(
  commerce: CommerceTransactionTarget,
  identity: StripeCheckoutIdentity,
): Promise<void> {
  return runCommerceTransaction(commerce, (transaction) => transaction.update(
    commerceKeys.stripeCheckout(identity.dropId, identity.sessionId),
    {
      fulfillmentQueueReenqueuedAt: commerceFieldValue.serverTimestamp(),
      updatedAt: commerceFieldValue.serverTimestamp(),
    },
  ), { shouldRetry: (error) => error.code === 'aborted' });
}

export function recordStripeCheckoutReconciliationFailure(
  commerce: CommerceTransactionTarget,
  identity: StripeCheckoutIdentity,
  failure: ReconciliationFailure,
): Promise<void> {
  return runCommerceTransaction(commerce, (transaction) => transaction.update(
    commerceKeys.stripeCheckout(identity.dropId, identity.sessionId),
    stripeCheckoutWriteData({
      lastFulfillmentReconciliationError: failure,
      lastFulfillmentReconciliationErrorAt: commerceFieldValue.serverTimestamp(),
      updatedAt: commerceFieldValue.serverTimestamp(),
    }),
  ), { shouldRetry: (error) => error.code === 'aborted' });
}
