import { commerceFieldValue, commerceKeys, type CommerceUnitOfWork } from '../src/commerceRepository.js';
import { updateStripeCheckoutWebhook, type StripeCheckoutRecord } from '../src/stripeCheckout/commerce.js';
import {
  createStripeCheckoutDocument,
  type StripeCheckoutCreate,
} from '../src/stripeCheckout/sessionStore.js';

function checkoutTypeContracts(
  commerce: Parameters<typeof createStripeCheckoutDocument>[0],
  transaction: CommerceUnitOfWork,
  create: StripeCheckoutCreate,
  checkout: StripeCheckoutRecord,
): void {
  const key = commerceKeys.stripeCheckout('drop', 'cs_session');
  void createStripeCheckoutDocument(commerce, key, create);
  void updateStripeCheckoutWebhook(transaction, key, {
    lastStripeWebhookEventId: 'evt_paid',
    stripeWebhookEventIds: commerceFieldValue.arrayUnion('evt_paid'),
    updatedAt: commerceFieldValue.serverTimestamp(),
    processingAttemptId: commerceFieldValue.delete(),
  });

  // @ts-expect-error Checkout creation cannot use a delivery-order key.
  void createStripeCheckoutDocument(commerce, commerceKeys.deliveryOrder('drop', '1'), create);
  // @ts-expect-error Creation timestamps belong to the transaction.
  void createStripeCheckoutDocument(commerce, key, { ...create, createdAt: 'today' });
  // @ts-expect-error Creation timestamps cannot be supplied even as native transforms.
  void createStripeCheckoutDocument(commerce, key, { ...create, updatedAt: commerceFieldValue.serverTimestamp() });
  // @ts-expect-error A new checkout cannot start fulfilled.
  void createStripeCheckoutDocument(commerce, key, { ...create, status: 'fulfilled' });
  // @ts-expect-error Webhook changes cannot target a delivery order.
  void updateStripeCheckoutWebhook(transaction, commerceKeys.deliveryOrder('drop', '1'), { lastStripeWebhookEventId: 'evt', stripeWebhookEventIds: commerceFieldValue.arrayUnion('evt') });
  // @ts-expect-error Webhook patches reject unknown checkout field names.
  void updateStripeCheckoutWebhook(transaction, key, { lastStripeWebhookEventId: 'evt', stripeWebhookEventIds: commerceFieldValue.arrayUnion('evt'), fulfilmentRequestedAt: 1 });
  // @ts-expect-error Webhook timestamp fields require native server timestamps.
  void updateStripeCheckoutWebhook(transaction, key, { lastStripeWebhookEventId: 'evt', stripeWebhookEventIds: commerceFieldValue.arrayUnion('evt'), updatedAt: 1 });
  // @ts-expect-error Webhook reset fields accept only native delete transforms.
  void updateStripeCheckoutWebhook(transaction, key, { lastStripeWebhookEventId: 'evt', stripeWebhookEventIds: commerceFieldValue.arrayUnion('evt'), processingAttemptId: 'another-attempt' });
  // @ts-expect-error Notification views do not expose arbitrary persisted fields.
  void checkout.notification.historicalField;
}

void checkoutTypeContracts;
