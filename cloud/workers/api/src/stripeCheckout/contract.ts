import { createHash } from 'crypto';
import { PublicKey } from '@solana/web3.js';
import { normalizeCountryCode } from '../../../../../shared/countryNormalization.js';
import {
  buildStripeReceiptClaimsByBoxId,
  requireStripeReceiptClaimCode,
  stripeReceiptClaimBoxMapKey,
  STRIPE_RECEIPT_CLAIM_CODE_NAMESPACE,
} from '../../../../../shared/stripeReceiptClaims.js';
import {
  STRIPE_OFFCHAIN_DELIVERY_ORDER_SOURCE,
} from '../../../../../shared/fulfillmentSources.js';
import {
  STRIPE_CHECKOUT_STATUS,
  STRIPE_OFFCHAIN_CHECKOUT_MAX_QUANTITY,
  STRIPE_OFFCHAIN_CURRENCY,
  normalizeStripeCheckoutQuantity,
  stripeCheckoutShippingCountriesForDropFamily,
} from '../../../../../shared/stripeCheckoutSession.js';
import {
  isStripeOffchainFulfillmentSession,
} from '../../../../../shared/stripeWebhook.js';
export {
  generateStripeReceiptClaimCode,
  generateUniqueStripeReceiptClaimCodes,
  normalizeStripeReceiptClaimCode,
  requireStripeReceiptClaimCode,
  STRIPE_RECEIPT_CLAIM_CODE_NAMESPACE,
} from '../../../../../shared/stripeReceiptClaims.js';
export {
  ADMIN_IRL_REDEEM_DELIVERY_ORDER_SOURCE,
  STRIPE_OFFCHAIN_DELIVERY_ORDER_SOURCE,
  isReceiptClaimDeliveryOrderSource,
} from '../../../../../shared/fulfillmentSources.js';
export {
  STRIPE_CHECKOUT_BINDER_SHIPPING_COUNTRIES,
  STRIPE_CHECKOUT_OWNER_KIND_FIREBASE,
  STRIPE_CHECKOUT_SHIPPING_COUNTRY,
  STRIPE_CHECKOUT_STATUS,
  STRIPE_OFFCHAIN_CHECKOUT_MAX_QUANTITY,
  STRIPE_OFFCHAIN_CHECKOUT_QUANTITY,
  STRIPE_OFFCHAIN_CURRENCY,
  STRIPE_OFFCHAIN_FULFILLMENT_MODE,
  buildStripeCheckoutDocument,
  buildStripeCheckoutSessionMetadata,
  normalizeStripeCheckoutQuantity,
  resolveMintSelectionVariantIndex,
  stripeCheckoutOwnerId,
} from '../../../../../shared/stripeCheckoutSession.js';
export {
  isStripeOffchainFulfillmentSession,
  validateStripeCheckoutDocumentData,
  type StripeCheckoutDocumentData,
} from '../../../../../shared/stripeWebhook.js';
const ADMIN_ORDER_SEED = 'admin_order';
export const IX_ADMIN_DELIVER_VARIANT_ORDER = Buffer.from('bf80de4f9c1a0722', 'hex');
export const ACCOUNT_ADMIN_DELIVERY_ORDER = Buffer.from('cde7b3967ff802f4', 'hex');
const ADMIN_DELIVERY_ORDER_RECORD_SIZE = 8 + 32 + 1 + 1 + 4 + 32 + 8 + 1;

export type DecodedAdminDeliveryOrderRecord = {
  orderHash: Buffer;
  variantIndex: number;
  quantity: number;
  firstMetadataId: number;
  receiptOwner: PublicKey;
  createdSlot: bigint;
  bump: number;
};

export type StripeFulfillmentAddress = {
  formatted: string;
  country?: string;
  countryCode?: string;
  email?: string;
};

type StripeCheckoutLineItemLike = {
  quantity?: unknown;
  currency?: unknown;
  amount_subtotal?: unknown;
  amount_total?: unknown;
  price?: {
    currency?: unknown;
    unit_amount?: unknown;
  } | null;
};

export type StripeCheckoutLineItemsLike = {
  data?: StripeCheckoutLineItemLike[];
  has_more?: boolean;
};

export type StripeOffchainDeliveryOrderDocumentInput = {
  dropId: string;
  deliveryId: number;
  owner: string;
  ownerKind?: string;
  firebaseUid?: string;
  receiptOwner: string;
  metadataId?: number;
  metadataIds?: number[];
  variantKey?: string;
  orderHashHex: string;
  stripeSession: {
    id?: string | null;
    payment_intent?: unknown;
    customer?: unknown;
  };
  receiptTx: string | null;
  addressSnapshot: Record<string, unknown>;
  stripeReceiptClaim?: {
    code: string;
    boxId?: number;
    status?: string;
  };
  stripeReceiptClaims?: Array<{
    code: string;
    boxId: number;
    status?: string;
  }>;
};

export type StripeAddressEncryptionResult = {
  encrypted: string;
  hint: string;
};

function normalizedString(value: unknown): string {
  return String(value || '').trim();
}

function normalizedCurrency(value: unknown): string {
  return normalizedString(value).toLowerCase();
}

function integerOrNull(value: unknown): number | null {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || !Number.isInteger(numeric)) return null;
  return numeric;
}

function nonNegativeIntegerOrNull(value: unknown): number | null {
  const numeric = integerOrNull(value);
  return numeric != null && numeric >= 0 ? numeric : null;
}

function positiveIntegerOrNull(value: unknown): number | null {
  const numeric = integerOrNull(value);
  return numeric != null && numeric > 0 ? numeric : null;
}

function integerInRangeOrNull(value: unknown, min: number, max: number): number | null {
  const numeric = integerOrNull(value);
  return numeric != null && numeric >= min && numeric <= max ? numeric : null;
}

function lineItemUnitAmountCents(
  item: StripeCheckoutLineItemLike,
  quantity: number,
  sessionAmountSubtotal: unknown,
  sessionAmountTotal: unknown,
): number | null {
  const directUnit = nonNegativeIntegerOrNull(item.price?.unit_amount);
  if (directUnit != null) return directUnit;

  const itemSubtotal = nonNegativeIntegerOrNull(item.amount_subtotal);
  if (itemSubtotal != null && quantity > 0 && itemSubtotal % quantity === 0) return itemSubtotal / quantity;

  const sessionSubtotal = nonNegativeIntegerOrNull(sessionAmountSubtotal);
  if (sessionSubtotal != null && quantity > 0 && sessionSubtotal % quantity === 0) return sessionSubtotal / quantity;

  const itemTotal = nonNegativeIntegerOrNull(item.amount_total);
  if (itemTotal != null && quantity > 0 && itemTotal % quantity === 0) return itemTotal / quantity;

  const sessionTotal = nonNegativeIntegerOrNull(sessionAmountTotal);
  if (sessionTotal != null && quantity > 0 && sessionTotal % quantity === 0) return sessionTotal / quantity;

  return null;
}

export function shouldProcessStripeCheckoutFulfillmentWrite(args: {
  beforeStatus?: unknown;
  afterStatus?: unknown;
}): boolean {
  const beforeStatus = normalizedString(args.beforeStatus);
  return (
    normalizedString(args.afterStatus) === STRIPE_CHECKOUT_STATUS.FULFILLMENT_PENDING &&
    (beforeStatus === STRIPE_CHECKOUT_STATUS.CREATED || beforeStatus === STRIPE_CHECKOUT_STATUS.FULFILLMENT_FAILED)
  );
}

export function validateStripeCheckoutContract(args: {
  session: {
    mode?: unknown;
    payment_status?: unknown;
    livemode?: unknown;
    automatic_tax?: {
      enabled?: unknown;
      status?: unknown;
    } | null;
    amount_subtotal?: unknown;
    amount_total?: unknown;
    currency?: unknown;
    metadata?: Record<string, unknown> | null;
  };
  lineItems: StripeCheckoutLineItemsLike;
  expectedUnitAmountCents: number;
  expectedQuantity?: number;
  expectedCurrency?: string;
  expectedLivemode: boolean;
}): { ignored: true } | { quantity: number; currency: string; unitAmountCents: number } {
  const { session, lineItems } = args;
  if (!isStripeOffchainFulfillmentSession(session)) return { ignored: true };
  const expectedLivemode = args.expectedLivemode === true;
  const expectedQuantity = normalizeStripeCheckoutQuantity(args.expectedQuantity);

  if (session.mode !== 'payment') throw new Error('Stripe checkout session mode must be payment');
  if (session.payment_status !== 'paid') throw new Error('Stripe checkout session must be paid');
  if (session.livemode !== expectedLivemode) {
    throw new Error(`Stripe checkout session must be ${expectedLivemode ? 'live' : 'test'} mode`);
  }
  if (session.automatic_tax?.enabled !== true) {
    throw new Error('Stripe checkout automatic tax must be enabled');
  }
  const automaticTaxStatus = normalizedString(session.automatic_tax?.status);
  if (automaticTaxStatus && automaticTaxStatus !== 'complete') {
    throw new Error('Stripe checkout automatic tax must be complete');
  }

  if (lineItems.has_more) throw new Error('Stripe checkout has too many line items');
  const data = Array.isArray(lineItems.data) ? lineItems.data : [];
  if (data.length !== 1) throw new Error('Stripe checkout must have exactly one line item');

  const item = data[0];
  const quantity = integerInRangeOrNull(item.quantity, 1, STRIPE_OFFCHAIN_CHECKOUT_MAX_QUANTITY) || 0;
  const metadataQuantity = positiveIntegerOrNull(session.metadata?.quantity);
  if (metadataQuantity != null && metadataQuantity !== quantity) {
    throw new Error('Stripe checkout quantity metadata does not match line item quantity');
  }
  if (quantity !== expectedQuantity) throw new Error('Stripe checkout quantity does not match expected quantity');

  const expectedCurrency = normalizedCurrency(args.expectedCurrency || STRIPE_OFFCHAIN_CURRENCY);
  const itemCurrency = normalizedCurrency(item.currency || item.price?.currency);
  const sessionCurrency = normalizedCurrency(session.currency);
  const currency = itemCurrency || sessionCurrency;
  if (currency !== expectedCurrency || (sessionCurrency && sessionCurrency !== expectedCurrency)) {
    throw new Error(`Stripe checkout currency must be ${expectedCurrency}`);
  }

  const expectedUnitAmountCents = nonNegativeIntegerOrNull(args.expectedUnitAmountCents);
  if (expectedUnitAmountCents == null) throw new Error('Expected Stripe unit amount is invalid');

  const unitAmountCents = lineItemUnitAmountCents(item, quantity, session.amount_subtotal, session.amount_total);
  if (unitAmountCents !== expectedUnitAmountCents) {
    throw new Error('Stripe checkout unit amount does not match expected amount');
  }

  const expectedSubtotalCents = expectedUnitAmountCents * quantity;
  const sessionAmountSubtotal = nonNegativeIntegerOrNull(session.amount_subtotal);
  if (sessionAmountSubtotal != null && sessionAmountSubtotal !== expectedSubtotalCents) {
    throw new Error('Stripe checkout subtotal amount does not match expected amount');
  }

  const sessionAmountTotal = nonNegativeIntegerOrNull(session.amount_total);
  if (sessionAmountTotal != null && sessionAmountTotal < expectedSubtotalCents) {
    throw new Error('Stripe checkout total amount is less than expected subtotal');
  }

  return { quantity, currency: expectedCurrency, unitAmountCents };
}

export function validateStripeTestCheckoutContract(
  args: Omit<Parameters<typeof validateStripeCheckoutContract>[0], 'expectedLivemode'>,
): { ignored: true } | { quantity: number; currency: string; unitAmountCents: number } {
  return validateStripeCheckoutContract({ ...args, expectedLivemode: false });
}

export function buildStripeOffchainAddressSnapshot(args: {
  session: unknown;
  encryptAddress: (plaintext: string) => StripeAddressEncryptionResult | null;
  normalizeCountryCode?: (country?: string) => string;
  dropFamily?: unknown;
}): Record<string, unknown> {
  const parsed = stripeFulfillmentAddressFromSession(args.session);
  if (!parsed) throw new Error('Stripe checkout session is missing a shipping address');

  const normalize = args.normalizeCountryCode || normalizeCountryCode;
  const countryCode = normalize(parsed.countryCode || parsed.country);
  if (!countryCode) throw new Error('Stripe checkout shipping address country is invalid');
  const allowedCountries = new Set<string>(
    stripeCheckoutShippingCountriesForDropFamily(args.dropFamily),
  );
  if (!allowedCountries.has(countryCode)) {
    throw new Error(
      args.dropFamily === 'card_nft_binder'
        ? 'Stripe checkout shipping address country is not supported'
        : 'Stripe checkout shipping address must be in the US',
    );
  }

  const encrypted = args.encryptAddress(parsed.formatted);
  if (!encrypted) throw new Error('Stripe checkout shipping address could not be encrypted');

  return {
    ...(parsed.email ? { email: parsed.email } : {}),
    country: parsed.country || countryCode,
    countryCode,
    encrypted: encrypted.encrypted,
    hint: encrypted.hint,
  };
}

export function stripeCheckoutSessionOrderHash(sessionId: string, livemode: boolean): Buffer {
  const id = String(sessionId || '').trim();
  if (!id) throw new Error('Missing Stripe Checkout Session id');
  return createHash('sha256').update(`stripe:${Boolean(livemode)}:${id}`).digest();
}

export function deriveAdminOrderPda(
  programId: PublicKey,
  configPda: PublicKey,
  orderHash: Uint8Array,
): [PublicKey, number] {
  const hash = Buffer.from(orderHash || []);
  if (hash.length !== 32) throw new Error('orderHash must be 32 bytes');
  return PublicKey.findProgramAddressSync([Buffer.from(ADMIN_ORDER_SEED), configPda.toBuffer(), hash], programId);
}

export function encodeAdminDeliverVariantOrderArgs(args: {
  orderHash: Uint8Array;
  variantIndex: number;
  quantity: number;
}): Buffer {
  const orderHash = Buffer.from(args.orderHash || []);
  const variantIndex = Number(args.variantIndex);
  const quantity = Number(args.quantity);
  if (orderHash.length !== 32) throw new Error('orderHash must be 32 bytes');
  if (!Number.isInteger(variantIndex) || variantIndex < 0 || variantIndex > 255) {
    throw new Error('variantIndex must be a u8');
  }
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 255) {
    throw new Error('quantity must be a u8');
  }
  return Buffer.concat([
    IX_ADMIN_DELIVER_VARIANT_ORDER,
    orderHash,
    Buffer.from([variantIndex & 0xff, quantity & 0xff]),
  ]);
}

export function decodeAdminDeliveryOrderRecord(data: Buffer | Uint8Array): DecodedAdminDeliveryOrderRecord {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data || []);
  if (buf.length < ADMIN_DELIVERY_ORDER_RECORD_SIZE) {
    throw new Error('Admin delivery order record data is truncated');
  }
  if (!buf.subarray(0, 8).equals(ACCOUNT_ADMIN_DELIVERY_ORDER)) {
    throw new Error('Invalid admin delivery order record discriminator');
  }

  let offset = 8;
  const orderHash = Buffer.from(buf.subarray(offset, offset + 32));
  offset += 32;
  const variantIndex = buf.readUInt8(offset);
  offset += 1;
  const quantity = buf.readUInt8(offset);
  offset += 1;
  const firstMetadataId = buf.readUInt32LE(offset);
  offset += 4;
  const receiptOwner = new PublicKey(buf.subarray(offset, offset + 32));
  offset += 32;
  const createdSlot = buf.readBigUInt64LE(offset);
  offset += 8;
  const bump = buf.readUInt8(offset);

  return { orderHash, variantIndex, quantity, firstMetadataId, receiptOwner, createdSlot, bump };
}

function normalizeStripeMetadataId(value: unknown): number {
  const metadataId = integerInRangeOrNull(value, 1, 0xffff_ffff);
  if (metadataId == null) throw new Error('Stripe off-chain order metadata id is invalid');
  return metadataId;
}

function normalizeStripeMetadataIds(args: Pick<StripeOffchainDeliveryOrderDocumentInput, 'metadataId' | 'metadataIds'>): number[] {
  const rawIds = Array.isArray(args.metadataIds) && args.metadataIds.length ? args.metadataIds : [args.metadataId];
  const metadataIds = rawIds.map((metadataId) => normalizeStripeMetadataId(metadataId));
  if (!metadataIds.length) throw new Error('Stripe off-chain order is missing metadata ids');
  if (metadataIds.length > STRIPE_OFFCHAIN_CHECKOUT_MAX_QUANTITY) {
    throw new Error(`Stripe off-chain order has too many metadata ids`);
  }
  if (new Set(metadataIds).size !== metadataIds.length) {
    throw new Error('Stripe off-chain order has duplicate metadata ids');
  }
  return metadataIds;
}

type RawStripeReceiptClaim = { code: string; boxId?: number; status?: string };

function rawStripeReceiptClaims(
  args: Pick<StripeOffchainDeliveryOrderDocumentInput, 'stripeReceiptClaim' | 'stripeReceiptClaims'>,
  metadataIds: number[],
): RawStripeReceiptClaim[] {
  if (Array.isArray(args.stripeReceiptClaims) && args.stripeReceiptClaims.length) {
    return args.stripeReceiptClaims;
  }
  if (!args.stripeReceiptClaim) return [];
  return [
    {
      ...args.stripeReceiptClaim,
      boxId: args.stripeReceiptClaim.boxId ?? metadataIds[0],
    },
  ];
}

function normalizeStripeReceiptClaims(
  args: Pick<StripeOffchainDeliveryOrderDocumentInput, 'metadataId' | 'metadataIds' | 'stripeReceiptClaim' | 'stripeReceiptClaims'>,
  metadataIds: number[],
): Array<{ namespace: string; code: string; boxId: number; status: string }> {
  const rawClaims = rawStripeReceiptClaims(args, metadataIds);
  const claims = rawClaims.map((claim) => ({
    namespace: STRIPE_RECEIPT_CLAIM_CODE_NAMESPACE,
    code: requireStripeReceiptClaimCode(claim.code),
    boxId: normalizeStripeMetadataId(claim.boxId),
    status: normalizedString(claim.status) || 'unclaimed',
  }));
  if (!claims.length) return [];
  const metadataIdSet = new Set(metadataIds);
  claims.forEach((claim) => {
    if (!metadataIdSet.has(claim.boxId)) {
      throw new Error('Stripe receipt claim box id does not match order metadata ids');
    }
  });
  if (new Set(claims.map((claim) => claim.boxId)).size !== claims.length) {
    throw new Error('Stripe receipt claims contain duplicate box ids');
  }
  if (new Set(claims.map((claim) => claim.code)).size !== claims.length) {
    throw new Error('Stripe receipt claims contain duplicate codes');
  }
  return claims;
}

export function buildStripeOffchainDeliveryOrderDocument(args: StripeOffchainDeliveryOrderDocumentInput): Record<string, unknown> {
  const metadataIds = normalizeStripeMetadataIds(args);
  const stripeReceiptClaims = normalizeStripeReceiptClaims(args, metadataIds);
  const stripeReceiptClaimsByBoxId = buildStripeReceiptClaimsByBoxId(stripeReceiptClaims);
  const legacyStripeReceiptClaim = stripeReceiptClaims.length === 1 ? stripeReceiptClaims[0] : undefined;
  const variantKey = normalizedString(args.variantKey);

  return {
    dropId: args.dropId,
    source: STRIPE_OFFCHAIN_DELIVERY_ORDER_SOURCE,
    status: 'ready_to_ship',
    owner: args.owner,
    ...(args.ownerKind ? { ownerKind: args.ownerKind } : {}),
    ...(args.firebaseUid ? { firebaseUid: args.firebaseUid } : {}),
    receiptOwner: args.receiptOwner,
    addressSnapshot: args.addressSnapshot,
    itemIds: [],
    items: metadataIds.map((metadataId) => ({
      kind: 'box',
      refId: metadataId,
      ...(variantKey ? { variantKey } : {}),
    })),
    deliveryId: args.deliveryId,
    quantity: metadataIds.length,
    metadataIds,
    ...(metadataIds.length === 1 ? { metadataId: metadataIds[0] } : {}),
    offchainOrderHash: args.orderHashHex,
    stripeCheckoutSessionId: args.stripeSession.id,
    ...(typeof args.stripeSession.payment_intent === 'string'
      ? { stripePaymentIntentId: args.stripeSession.payment_intent }
      : {}),
    ...(typeof args.stripeSession.customer === 'string' ? { stripeCustomerId: args.stripeSession.customer } : {}),
    receiptsMinted: metadataIds.length,
    receiptTxs: args.receiptTx ? [args.receiptTx] : [],
    ...(stripeReceiptClaims.length ? { stripeReceiptClaimsByBoxId } : {}),
    ...(legacyStripeReceiptClaim ? { stripeReceiptClaim: legacyStripeReceiptClaim } : {}),
  };
}

export function buildStripeOffchainOrderMarkerDocument(args: StripeOffchainDeliveryOrderDocumentInput): Record<string, unknown> {
  const metadataIds = normalizeStripeMetadataIds(args);
  const stripeReceiptClaims = normalizeStripeReceiptClaims(args, metadataIds);
  const stripeReceiptClaimCodesByBoxId = Object.fromEntries(
    stripeReceiptClaims.map((claim) => [stripeReceiptClaimBoxMapKey(claim.boxId), claim.code]),
  );
  const legacyStripeReceiptClaim = stripeReceiptClaims.length === 1 ? stripeReceiptClaims[0] : undefined;
  const variantKey = normalizedString(args.variantKey);

  return {
    dropId: args.dropId,
    deliveryId: args.deliveryId,
    owner: args.owner,
    ...(args.ownerKind ? { ownerKind: args.ownerKind } : {}),
    ...(args.firebaseUid ? { firebaseUid: args.firebaseUid } : {}),
    receiptOwner: args.receiptOwner,
    quantity: metadataIds.length,
    firstMetadataId: metadataIds[0],
    metadataIds,
    ...(metadataIds.length === 1 ? { metadataId: metadataIds[0] } : {}),
    ...(variantKey ? { variantKey } : {}),
    offchainOrderHash: args.orderHashHex,
    stripeCheckoutSessionId: args.stripeSession.id,
    receiptTx: args.receiptTx,
    ...(stripeReceiptClaims.length ? { stripeReceiptClaimCodesByBoxId } : {}),
    ...(legacyStripeReceiptClaim ? { stripeReceiptClaimCode: legacyStripeReceiptClaim.code } : {}),
  };
}

export function stripeFulfillmentAddressFromSession(session: any): StripeFulfillmentAddress | null {
  const collected = session?.collected_information || session?.collectedInformation || {};
  const shipping = collected?.shipping_details || collected?.shippingDetails || session?.shipping_details || session?.shippingDetails || {};
  const customer = session?.customer_details || session?.customerDetails || {};
  const address = shipping?.address || null;
  if (!address || typeof address !== 'object') return null;

  const name = normalizedString(shipping?.name || customer?.name || collected?.individual_name || collected?.business_name);
  const line1 = normalizedString(address.line1);
  const line2 = normalizedString(address.line2);
  const city = normalizedString(address.city);
  const state = normalizedString(address.state);
  const postalCode = normalizedString(address.postal_code || address.postalCode);
  const countryCode = normalizedString(address.country).toUpperCase();
  const cityLine = [city, [state, postalCode].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  const formatted = [name, line1, line2, cityLine, countryCode].filter(Boolean).join('\n');
  if (!formatted) return null;

  const email = normalizedString(customer?.email || session?.customer_email);
  return {
    formatted,
    country: countryCode || undefined,
    countryCode: countryCode || undefined,
    email: email || undefined,
  };
}
