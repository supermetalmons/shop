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
  type CommerceDocumentKey,
} from '../commerceRepository.js';
import { runCommerceTransaction, type CommerceTransactionTarget } from '../commerceTransactions.js';
import {
  getStripeCheckout,
  stripeCheckoutWriteData,
  updateStripeCheckout,
  updateStripeCheckoutWebhook,
  type StripeCheckoutWebhookUpdate,
  type StripeReconciliationFailure,
} from './commerce.js';

type StripeCheckoutIdentity = { dropId: string; sessionId: string };
type WithoutTimestamps<T> = T extends unknown ? Omit<T, 'createdAt' | 'updatedAt'> & {
  createdAt?: never;
  updatedAt?: never;
} : never;

export type StripeCheckoutCreate = WithoutTimestamps<StripeCheckoutCreatedDocument>;

export function stripeCheckoutCreateInput(document: StripeCheckoutCreatedDocument): StripeCheckoutCreate {
  const { createdAt: _createdAt, updatedAt: _updatedAt, ...fields } = document;
  return fields;
}

export function stripeCheckoutKeyFromPath(path: string): CommerceDocumentKey<'stripe_checkout'> {
  const key = commerceKeyFromPath(path);
  if (!key || key.kind !== 'stripe_checkout') {
    throw new CommerceRepositoryError('invalid-argument', 'Invalid Stripe checkout document path.');
  }
  return { ...key, kind: key.kind };
}

export function createStripeCheckoutDocument(
  commerce: CommerceTransactionTarget,
  key: CommerceDocumentKey<'stripe_checkout'>,
  document: StripeCheckoutCreate,
): Promise<void> {
  return runCommerceTransaction(commerce, async (transaction) => {
    const existing = await getStripeCheckout(transaction, key);
    if (existing) {
      if (
        existing.identity.operationId === document.operationId &&
        existing.identity.sessionId === document.sessionId &&
        existing.identity.dropId === document.dropId
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
): StripeCheckoutWebhookUpdate {
  const updates: StripeCheckoutWebhookUpdate = {
    ...transition.fields,
    stripeWebhookEventIds: commerceFieldValue.arrayUnion(action.eventId),
  };
  for (const field of transition.deleteFields) updates[field] = commerceFieldValue.delete();
  for (const field of transition.serverTimestampFields) updates[field] = commerceFieldValue.serverTimestamp();
  return updates;
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
    await updateStripeCheckoutWebhook(transaction, key, webhookWriteData(action, transition));
    return { outcome: transition.outcome, ...(transition.deliveryId ? { deliveryId: transition.deliveryId } : {}) };
  });
}

export function markStripeCheckoutReenqueued(
  commerce: CommerceTransactionTarget,
  identity: StripeCheckoutIdentity,
): Promise<void> {
  return runCommerceTransaction(commerce, (transaction) => updateStripeCheckout(
    transaction,
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
  failure: StripeReconciliationFailure,
): Promise<void> {
  return runCommerceTransaction(commerce, (transaction) => updateStripeCheckout(
    transaction,
    commerceKeys.stripeCheckout(identity.dropId, identity.sessionId),
    {
      lastFulfillmentReconciliationError: failure,
      lastFulfillmentReconciliationErrorAt: commerceFieldValue.serverTimestamp(),
      updatedAt: commerceFieldValue.serverTimestamp(),
    },
  ), { shouldRetry: (error) => error.code === 'aborted' });
}
