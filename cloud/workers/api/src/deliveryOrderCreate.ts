import type { StripeCheckoutIdentity } from '../../../../shared/checkoutIdentity.js';
import type {
  ADMIN_IRL_REDEEM_DELIVERY_ORDER_SOURCE,
  STRIPE_OFFCHAIN_DELIVERY_ORDER_SOURCE,
} from '../../../../shared/fulfillmentSources.js';
import type { CommerceDocumentData, commerceFieldValue } from './commerceRepositoryTypes.js';
import type { DeliveryPackStatusProjectionUpdates } from './deliveryPackStatusProjectionTypes.js';

type ServerTimestamp = ReturnType<typeof commerceFieldValue.serverTimestamp>;
type ReadyOrderTimestamps = { createdAt: ServerTimestamp; processedAt: ServerTimestamp };

type DeliveryItem = { assetId: string; kind: 'box' | 'dude'; refId: number };
type ReceiptClaim = { namespace: string; code: string; boxId: number; status: string };

export type PreparedDeliveryOrderCreate = {
  dropId: string;
  status: 'prepared';
  owner: string;
  addressId: string;
  addressSnapshot: CommerceDocumentData & { id: string };
  itemIds: string[];
  items: DeliveryItem[];
  deliveryId: number;
  deliveryPda: string;
  lookupTable?: string;
  deliveryLamports: number;
  prepareAttemptId: string;
  receiptRecovery: { preparedProbeCount: number; nextPreparedProbeAt: number };
  createdAt: ServerTimestamp;
};

export type StripeDeliveryOrderFields<Address extends Record<string, unknown> = CommerceDocumentData> = StripeCheckoutIdentity & {
  authSubject?: string;
  dropId: string;
  source: typeof STRIPE_OFFCHAIN_DELIVERY_ORDER_SOURCE;
  status: 'ready_to_ship';
  receiptOwner: string;
  addressSnapshot: Address;
  itemIds: string[];
  items: Array<{ kind: 'box'; refId: number; variantKey?: string }>;
  deliveryId: number;
  quantity: number;
  metadataIds: number[];
  metadataId?: number;
  offchainOrderHash: string;
  stripeCheckoutSessionId?: string | null;
  stripePaymentIntentId?: string;
  stripeCustomerId?: string;
  receiptsMinted: number;
  receiptTxs: string[];
  stripeReceiptClaimsByBoxId?: Record<string, ReceiptClaim>;
  stripeReceiptClaim?: ReceiptClaim;
};

export type StripeDeliveryOrderCreate = StripeDeliveryOrderFields & ReadyOrderTimestamps;

type AdminDeliveryOrderFields = {
  dropId: string;
  source: typeof ADMIN_IRL_REDEEM_DELIVERY_ORDER_SOURCE;
  status: 'ready_to_ship';
  owner: string;
  receiptOwner: string;
  addressSnapshot: { label: string; country: string };
  itemIds: string[];
  originalItemIds: string[];
  deliveryId: number;
  quantity: number;
  receiptTxs: string[];
};

export type AdminPackDeliveryOrderFields = AdminDeliveryOrderFields & {
  items: Array<DeliveryItem & { kind: 'box'; originalAssetId: string }>;
  metadataIds: number[];
  metadataId?: number;
  receiptsMinted: number;
  stripeReceiptClaimsByBoxId: Record<string, ReceiptClaim>;
  irlClaims: Array<{ boxId: number; boxAssetId: string; dudeIds: number[] }>;
  adminIrlRedeem: { requestId: string; transferSignature: string; originalItemIds: string[] };
};

export type AdminCardDeliveryOrderFields = AdminDeliveryOrderFields & {
  items: Array<DeliveryItem & { kind: 'dude' }>;
  stripeReceiptClaim: ReceiptClaim & { receiptKind: 'figure'; figureId: number; receiptAssetId: string };
  adminIrlRedeem: {
    targetKind: 'card_receipt';
    requestId: string;
    transferSignature: string;
    originalItemIds: string[];
  };
};

export type AdminPackDeliveryOrderCreate = AdminPackDeliveryOrderFields & ReadyOrderTimestamps & DeliveryPackStatusProjectionUpdates;
export type AdminCardDeliveryOrderCreate = AdminCardDeliveryOrderFields & ReadyOrderTimestamps;

export type DeliveryOrderCreate = PreparedDeliveryOrderCreate | StripeDeliveryOrderCreate |
  AdminPackDeliveryOrderCreate | AdminCardDeliveryOrderCreate;
