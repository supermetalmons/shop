import { commerceFieldValue, commerceKeys, type CommerceUnitOfWork } from '../src/commerceRepository.js';
import { createDeliveryOrder, updateDeliveryOrder } from '../src/deliveryOrderStore.js';
import type {
  AdminCardDeliveryOrderCreate,
  AdminPackDeliveryOrderCreate,
  PreparedDeliveryOrderCreate,
  StripeDeliveryOrderCreate,
} from '../src/deliveryOrderCreate.js';
import type { DeliveryOwnerMergeUpdate, DeliveryReceiptClaimUpdates, DeliveryReceiptClaimValues } from '../src/deliveryOrderUpdates.js';

function deliveryContracts(
  transaction: CommerceUnitOfWork,
  prepared: PreparedDeliveryOrderCreate,
  stripe: StripeDeliveryOrderCreate,
  pack: AdminPackDeliveryOrderCreate,
  card: AdminCardDeliveryOrderCreate,
): void {
  const key = commerceKeys.deliveryOrder('drop', '1');
  void createDeliveryOrder(transaction, key, prepared);
  void createDeliveryOrder(transaction, key, stripe);
  void createDeliveryOrder(transaction, key, {
    ...stripe, ownerKind: 'wallet', owner: 'wallet', authSubject: 'retained-subject',
  } satisfies StripeDeliveryOrderCreate);
  void createDeliveryOrder(transaction, key, pack);
  void createDeliveryOrder(transaction, key, card);
  // @ts-expect-error Delivery creation requires a delivery key.
  void createDeliveryOrder(transaction, commerceKeys.stripeCheckout('drop', 'session'), stripe);
  // @ts-expect-error Prepared orders require preparation fields.
  void createDeliveryOrder(transaction, key, { dropId: 'drop', status: 'prepared', owner: 'wallet' });
  // @ts-expect-error Creation field names are closed.
  void createDeliveryOrder(transaction, key, { ...prepared, deliveryLamport: 1 });
  // @ts-expect-error Prepared item kinds cannot be another commerce entity.
  void ({ ...prepared, items: [{ kind: 'stripe_checkout', refId: 1, assetId: 'asset' }] } satisfies PreparedDeliveryOrderCreate);
  // @ts-expect-error Creation timestamps use native transforms.
  void ({ ...stripe, processedAt: 'today' } satisfies StripeDeliveryOrderCreate);
  // @ts-expect-error Stripe orders cannot use the prepared lifecycle state.
  void ({ ...stripe, status: 'prepared' } satisfies StripeDeliveryOrderCreate);
  // @ts-expect-error Admin pack orders cannot contain direct-card items.
  void ({ ...pack, items: [{ kind: 'dude', refId: 1, assetId: 'asset' }] } satisfies AdminPackDeliveryOrderCreate);
  // @ts-expect-error Admin card claims must target figures.
  void ({ ...card, stripeReceiptClaim: { ...card.stripeReceiptClaim, receiptKind: 'box' } } satisfies AdminCardDeliveryOrderCreate);
  // @ts-expect-error Owner merge timestamps cannot be raw strings.
  void ({ mergedAuthSubject: 'anon', owner: 'wallet', ownerKind: 'wallet', ownerMergedAt: 'today', previousOwner: 'anon' } satisfies DeliveryOwnerMergeUpdate);
  // @ts-expect-error Singular claim states are closed.
  void ({ 'stripeReceiptClaim.status': 'complete' } satisfies DeliveryReceiptClaimUpdates);
  // @ts-expect-error Claim mutation values cannot replace the target identity.
  void ({ boxId: 2 } satisfies DeliveryReceiptClaimValues);
  // @ts-expect-error Plural claim field names are closed.
  void ({ 'stripeReceiptClaimsByBoxId.box_1.processingStartAt': 1 } satisfies DeliveryReceiptClaimUpdates);
  // @ts-expect-error Plural claim timestamps use native transforms.
  void ({ 'stripeReceiptClaimsByBoxId.box_1.claimedAt': 'today' } satisfies DeliveryReceiptClaimUpdates);
  // @ts-expect-error Plural claim keys use numeric box ids.
  void ({ 'stripeReceiptClaimsByBoxId.box_unknown.code': 'code' } satisfies DeliveryReceiptClaimUpdates);
  // @ts-expect-error Claims cannot update arbitrary fields on an order.
  void updateDeliveryOrder(transaction, key, { arbitraryClaimField: 'value' });
  void updateDeliveryOrder(transaction, key, {
    'stripeReceiptClaim.recipient': commerceFieldValue.delete(),
    'stripeReceiptClaimsByBoxId.box_1.status': 'claimed',
    'stripeReceiptClaimsByBoxId.box_1.claimedAt': commerceFieldValue.serverTimestamp(),
    'stripeReceiptClaimsByBoxId.box_1.receiptTxs': ['signature'],
  });
}

void deliveryContracts;
