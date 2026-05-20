import { createHash } from 'crypto';
import { PublicKey } from '@solana/web3.js';
import type { MintSelectionConfig } from '../config/deployment.js';
import { normalizeCountryCode } from '../normalizers.js';

export const ADMIN_ORDER_SEED = 'admin_order';
export const IX_ADMIN_DELIVER_VARIANT_ORDER = Buffer.from('bf80de4f9c1a0722', 'hex');
export const ACCOUNT_ADMIN_DELIVERY_ORDER = Buffer.from('cde7b3967ff802f4', 'hex');
export const ADMIN_DELIVERY_ORDER_RECORD_SIZE = 8 + 32 + 1 + 1 + 4 + 32 + 8 + 1;
export const STRIPE_OFFCHAIN_FULFILLMENT_MODE = 'admin_variant_receipt';
export const STRIPE_OFFCHAIN_CURRENCY = 'usd';
export const STRIPE_OFFCHAIN_CHECKOUT_QUANTITY = 1;
export const STRIPE_CHECKOUT_SHIPPING_COUNTRY = 'US';
export const STRIPE_CHECKOUT_OWNER_KIND_FIREBASE = 'firebase';
export const DEFAULT_STRIPE_RETURN_URL = 'https://mons.shop';

export const STRIPE_CHECKOUT_STATUS = {
  CREATED: 'created',
  FULFILLED: 'fulfilled',
  PROCESSING: 'processing',
  FULFILLMENT_PENDING: 'fulfillment_pending',
  FULFILLMENT_FAILED: 'fulfillment_failed',
} as const;

export type OffchainMintSelectionConfig = MintSelectionConfig;

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

export type StripeCheckoutLineItemLike = {
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
  metadataId: number;
  variantKey: string;
  orderHashHex: string;
  stripeSession: {
    id?: string | null;
    payment_intent?: unknown;
    customer?: unknown;
  };
  receiptTx: string | null;
  addressSnapshot: Record<string, unknown>;
};

export type StripeCheckoutDocumentInput = {
  dropId: string;
  sessionId: string;
  uid: string;
  variantKey: string;
  unitAmountCents: number;
  livemode?: boolean;
  createdAt: unknown;
  updatedAt: unknown;
};

export type StripeAddressEncryptionResult = {
  encrypted: string;
  hint: string;
};

export type StripeCheckoutDocumentData = {
  uid: string;
  variantKey: string;
  unitAmountCents: number;
  livemode: boolean;
  status: string;
  deliveryId?: number;
};

function normalizedString(value: unknown): string {
  return String(value || '').trim();
}

function normalizedHttpOrigin(value: unknown): string {
  const candidate = normalizedString(value);
  if (!candidate) return '';
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return '';
    return parsed.origin;
  } catch {
    return '';
  }
}

function isStripeCheckoutLocalOrigin(parsed: URL): boolean {
  const hostname = parsed.hostname.toLowerCase();
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '::1';
}

function isDefaultStripeCheckoutReturnOrigin(parsed: URL, allowLocalhost: boolean): boolean {
  if (allowLocalhost && isStripeCheckoutLocalOrigin(parsed)) return true;
  const hostname = parsed.hostname.toLowerCase();
  return parsed.protocol === 'https:' && (hostname === 'mons.shop' || hostname.endsWith('.mons.shop'));
}

function isAllowedStripeCheckoutReturnOrigin(
  parsed: URL,
  allowedOrigins: readonly unknown[],
  allowLocalhost: boolean,
): boolean {
  if (isDefaultStripeCheckoutReturnOrigin(parsed, allowLocalhost)) return true;
  return allowedOrigins.some((origin) => normalizedHttpOrigin(origin) === parsed.origin);
}

export function normalizeStripeCheckoutReturnUrl(args: {
  requestOrigin?: unknown;
  rawReturnUrl?: unknown;
  status: 'success' | 'cancel';
  allowedOrigins?: readonly unknown[];
  allowLocalhost?: boolean;
}): string {
  const requestOrigin = normalizedString(args.requestOrigin);
  const rawReturnUrl = normalizedString(args.rawReturnUrl);
  const candidate = rawReturnUrl || requestOrigin || DEFAULT_STRIPE_RETURN_URL;
  const allowLocalhost = args.allowLocalhost !== false;
  const allowedOrigins = args.allowedOrigins || [];

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error('Invalid returnUrl');
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('returnUrl must be an http(s) URL');
  }

  let expectedOrigin = '';
  if (requestOrigin) {
    try {
      const parsedOrigin = new URL(requestOrigin);
      if (parsedOrigin.protocol !== 'https:' && parsedOrigin.protocol !== 'http:') {
        throw new Error('Invalid request origin');
      }
      expectedOrigin = parsedOrigin.origin;
    } catch (err) {
      if (err instanceof Error && err.message === 'Invalid request origin') throw err;
      throw new Error('Invalid request origin');
    }
  }

  const allowedOrigin = isAllowedStripeCheckoutReturnOrigin(parsed, allowedOrigins, allowLocalhost);
  if (expectedOrigin && parsed.origin !== expectedOrigin) throw new Error('returnUrl origin mismatch');
  if (!allowedOrigin) throw new Error(expectedOrigin ? 'returnUrl origin is not allowed' : 'returnUrl origin mismatch');

  parsed.searchParams.set('stripe_checkout', args.status);
  parsed.searchParams.delete('session_id');
  if (args.status === 'success') {
    parsed.searchParams.set('session_id', '{CHECKOUT_SESSION_ID}');
  }
  return parsed.toString().replace('%7BCHECKOUT_SESSION_ID%7D', '{CHECKOUT_SESSION_ID}');
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

export function isStripeOffchainFulfillmentSession(session: { metadata?: Record<string, unknown> | null } | null | undefined): boolean {
  return normalizedString(session?.metadata?.fulfillmentMode) === STRIPE_OFFCHAIN_FULFILLMENT_MODE;
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

export function stripeCheckoutOwnerId(uid: string): string {
  const normalizedUid = normalizedString(uid);
  if (!normalizedUid) throw new Error('App-created Stripe checkout is missing uid');
  return `${STRIPE_CHECKOUT_OWNER_KIND_FIREBASE}:${normalizedUid}`;
}

export function validateStripeCheckoutDocumentData(params: {
  dropId: string;
  variantKey: string;
  sessionId: string;
  expectedLivemode?: boolean;
  checkout: any;
}): StripeCheckoutDocumentData {
  const checkout = params.checkout || {};
  const expectedLivemode = params.expectedLivemode === true;
  const requireString = (value: unknown, expected: string, label: string): void => {
    if (normalizedString(value) !== expected) {
      throw new Error(`App-created Stripe checkout has invalid ${label}`);
    }
  };

  requireString(checkout.sessionId, params.sessionId, 'session id');
  requireString(checkout.fulfillmentMode, STRIPE_OFFCHAIN_FULFILLMENT_MODE, 'fulfillment mode');
  requireString(checkout.dropId, params.dropId, 'drop id');
  requireString(checkout.variantKey, params.variantKey, 'variant key');
  requireString(checkout.currency, STRIPE_OFFCHAIN_CURRENCY, 'currency');

  if (integerOrNull(checkout.quantity) !== STRIPE_OFFCHAIN_CHECKOUT_QUANTITY) {
    throw new Error('App-created Stripe checkout has invalid quantity');
  }
  if (checkout.livemode !== expectedLivemode) {
    throw new Error('App-created Stripe checkout has invalid mode');
  }

  const unitAmountCents = integerInRangeOrNull(checkout.unitAmountCents, 50, 99_999_999);
  if (unitAmountCents == null) {
    throw new Error('App-created Stripe checkout has invalid unit amount');
  }

  const uid = normalizedString(checkout.uid);
  if (!uid) throw new Error('App-created Stripe checkout is missing uid');
  const deliveryId = positiveIntegerOrNull(checkout.deliveryId);
  return {
    uid,
    variantKey: params.variantKey,
    unitAmountCents,
    livemode: expectedLivemode,
    status: normalizedString(checkout.status),
    ...(deliveryId != null ? { deliveryId } : {}),
  };
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
  expectedCurrency?: string;
  expectedLivemode: boolean;
}): { ignored: true } | { quantity: number; currency: string; unitAmountCents: number } {
  const { session, lineItems } = args;
  if (!isStripeOffchainFulfillmentSession(session)) return { ignored: true };
  const expectedLivemode = args.expectedLivemode === true;

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
  const quantity = positiveIntegerOrNull(item.quantity) || 0;
  const metadataQuantity = positiveIntegerOrNull(session.metadata?.quantity);
  if (metadataQuantity != null && metadataQuantity !== quantity) {
    throw new Error('Stripe checkout quantity metadata does not match line item quantity');
  }
  if (quantity !== STRIPE_OFFCHAIN_CHECKOUT_QUANTITY) throw new Error('Stripe checkout must have quantity 1');

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
}): Record<string, unknown> {
  const parsed = stripeFulfillmentAddressFromSession(args.session);
  if (!parsed) throw new Error('Stripe checkout session is missing a shipping address');

  const normalize = args.normalizeCountryCode || normalizeCountryCode;
  const countryCode = normalize(parsed.countryCode || parsed.country);
  if (!countryCode) throw new Error('Stripe checkout shipping address country is invalid');
  if (countryCode !== STRIPE_CHECKOUT_SHIPPING_COUNTRY) {
    throw new Error('Stripe checkout shipping address must be in the US');
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

export function resolveMintSelectionVariantIndex(
  selection: OffchainMintSelectionConfig | undefined,
  variantKey: string,
): number {
  const key = String(variantKey || '').trim();
  if (!key) throw new Error('Missing variantKey');
  if (selection?.kind !== 'size' || !Array.isArray(selection.options)) {
    throw new Error('Drop does not use size variant minting');
  }
  const index = selection.options.findIndex((option) => option?.key === key);
  if (index < 0) throw new Error('Invalid variantKey');
  return index;
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

export function buildStripeOffchainDeliveryOrderDocument(args: StripeOffchainDeliveryOrderDocumentInput): Record<string, unknown> {
  return {
    dropId: args.dropId,
    source: 'stripe_offchain',
    status: 'ready_to_ship',
    owner: args.owner,
    ...(args.ownerKind ? { ownerKind: args.ownerKind } : {}),
    ...(args.firebaseUid ? { firebaseUid: args.firebaseUid } : {}),
    receiptOwner: args.receiptOwner,
    addressSnapshot: args.addressSnapshot,
    itemIds: [],
    items: [{ kind: 'box', refId: args.metadataId, variantKey: args.variantKey }],
    deliveryId: args.deliveryId,
    offchainOrderHash: args.orderHashHex,
    stripeCheckoutSessionId: args.stripeSession.id,
    ...(typeof args.stripeSession.payment_intent === 'string'
      ? { stripePaymentIntentId: args.stripeSession.payment_intent }
      : {}),
    ...(typeof args.stripeSession.customer === 'string' ? { stripeCustomerId: args.stripeSession.customer } : {}),
    receiptsMinted: STRIPE_OFFCHAIN_CHECKOUT_QUANTITY,
    receiptTxs: args.receiptTx ? [args.receiptTx] : [],
  };
}

export function buildStripeOffchainOrderMarkerDocument(args: StripeOffchainDeliveryOrderDocumentInput): Record<string, unknown> {
  return {
    dropId: args.dropId,
    deliveryId: args.deliveryId,
    owner: args.owner,
    ...(args.ownerKind ? { ownerKind: args.ownerKind } : {}),
    ...(args.firebaseUid ? { firebaseUid: args.firebaseUid } : {}),
    receiptOwner: args.receiptOwner,
    metadataId: args.metadataId,
    variantKey: args.variantKey,
    offchainOrderHash: args.orderHashHex,
    stripeCheckoutSessionId: args.stripeSession.id,
    receiptTx: args.receiptTx,
  };
}

export function buildStripeCheckoutSessionMetadata(args: {
  dropId: string;
  uid: string;
  variantKey: string;
}): Record<string, string> {
  return {
    dropId: args.dropId,
    uid: args.uid,
    fulfillmentMode: STRIPE_OFFCHAIN_FULFILLMENT_MODE,
    placeholder: 'stripe_direct_delivery',
    quantity: String(STRIPE_OFFCHAIN_CHECKOUT_QUANTITY),
    variantKey: args.variantKey,
  };
}

export function buildStripeCheckoutDocument(args: StripeCheckoutDocumentInput): Record<string, unknown> {
  return {
    sessionId: args.sessionId,
    dropId: args.dropId,
    uid: args.uid,
    owner: stripeCheckoutOwnerId(args.uid),
    ownerKind: STRIPE_CHECKOUT_OWNER_KIND_FIREBASE,
    firebaseUid: args.uid,
    variantKey: args.variantKey,
    quantity: STRIPE_OFFCHAIN_CHECKOUT_QUANTITY,
    currency: STRIPE_OFFCHAIN_CURRENCY,
    unitAmountCents: args.unitAmountCents,
    fulfillmentMode: STRIPE_OFFCHAIN_FULFILLMENT_MODE,
    livemode: args.livemode === true,
    status: STRIPE_CHECKOUT_STATUS.CREATED,
    createdAt: args.createdAt,
    updatedAt: args.updatedAt,
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
