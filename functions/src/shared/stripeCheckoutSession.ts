import type { MintSelectionConfig, SolanaCluster } from './deploymentCore.js';
import type { DropFamily, DropSalesMode } from './deploymentCore.js';
import {
  BOX_MINTER_MINT_VARIANT_KIND_NONE,
  BOX_MINTER_MINT_VARIANT_KIND_SIZE,
} from './boxMinterProtocol.js';
import { isDirectDeliveryItemsPerBox } from './shipping.js';
import {
  STRIPE_TEST_UNIT_AMOUNT_CENTS_DEFAULT,
  STRIPE_UNIT_AMOUNT_CENTS_MAX,
  STRIPE_UNIT_AMOUNT_CENTS_MIN,
  assertStripeCheckoutQuantityForKind,
  classifyStripeCheckoutKind,
  resolveStripeCheckoutUnitAmountCents,
  type StripeCheckoutKind,
  type StripeCheckoutMode,
} from './stripeCheckoutCore.js';

export const STRIPE_OFFCHAIN_FULFILLMENT_MODE = 'admin_variant_receipt';
export const STRIPE_OFFCHAIN_CURRENCY = 'usd';
export const STRIPE_OFFCHAIN_CHECKOUT_QUANTITY = 1;
export const STRIPE_OFFCHAIN_CHECKOUT_MAX_QUANTITY = 15;
export const STRIPE_CHECKOUT_SHIPPING_COUNTRY = 'US';
export const STRIPE_CHECKOUT_OWNER_KIND_FIREBASE = 'firebase';

const STRIPE_CHECKOUT_DEFAULT_SHIPPING_COUNTRIES = [STRIPE_CHECKOUT_SHIPPING_COUNTRY] as const;
export const STRIPE_CHECKOUT_BINDER_SHIPPING_COUNTRIES = [
  'AE', 'AM', 'AR', 'AT', 'AU', 'BE', 'BG', 'BR', 'CA', 'CH', 'CL', 'CN', 'CO', 'CR', 'CY', 'CZ',
  'DE', 'DK', 'DO', 'EE', 'EG', 'ES', 'FI', 'FR', 'GB', 'GR', 'HK', 'HR', 'HU', 'ID', 'IE', 'IL',
  'IN', 'IS', 'IT', 'JP', 'KE', 'KR', 'LT', 'LU', 'LV', 'MA', 'MX', 'MY', 'NG', 'NL', 'NO', 'NZ',
  'PE', 'PH', 'PK', 'PL', 'PT', 'RO', 'SA', 'SE', 'SG', 'SI', 'SK', 'TH', 'TR', 'TW', 'UA', 'US',
  'VN', 'ZA',
] as const;
export type StripeCheckoutAllowedCountry =
  | typeof STRIPE_CHECKOUT_DEFAULT_SHIPPING_COUNTRIES[number]
  | typeof STRIPE_CHECKOUT_BINDER_SHIPPING_COUNTRIES[number];

export const STRIPE_CHECKOUT_STATUS = {
  CREATED: 'created',
  FULFILLED: 'fulfilled',
  PROCESSING: 'processing',
  FULFILLMENT_PENDING: 'fulfillment_pending',
  FULFILLMENT_FAILED: 'fulfillment_failed',
} as const;

const DEFAULT_STRIPE_RETURN_URL = 'https://mons.shop';
const STRIPE_PRODUCT_TAX_CODE_RE = /^txcd_\d{8}$/;

export type StripeCheckoutSessionErrorCode =
  | 'invalid-argument'
  | 'failed-precondition'
  | 'deadline-exceeded'
  | 'unavailable'
  | 'internal';

export class StripeCheckoutSessionError extends Error {
  constructor(
    readonly code: StripeCheckoutSessionErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'StripeCheckoutSessionError';
  }
}

export type StripeCheckoutSessionDrop = {
  dropId: string;
  solanaCluster: SolanaCluster;
  dropFamily: DropFamily;
  collectionName: string;
  displayName?: string;
  salesMode?: DropSalesMode;
  mintSelection?: MintSelectionConfig;
  stripeCheckoutEnabled?: boolean;
  stripeLiveUnitAmountCents?: number;
  stripeProductTaxCode?: string;
  itemsPerBox: number;
  namePrefix: string;
  boxMinterProgramId: string;
  boxMinterConfigPda?: string;
  collectionMint: string;
  receiptsMerkleTree: string;
};

export type StripeCheckoutOnchainConfig = {
  admin: string;
  coreCollection: string;
  maxSupply: number;
  maxPerTx: number;
  itemsPerBox: number;
  minted: number;
  started: boolean;
  mintVariantKind: number;
  mintVariantStartIds: readonly number[];
  mintVariantEndIds: readonly number[];
  mintVariantNextIds: readonly number[];
};

export type StripeCheckoutDocumentInput = {
  dropId: string;
  sessionId: string;
  uid: string;
  variantKey?: string;
  unitAmountCents: number;
  quantity?: number;
  livemode?: boolean;
  createdAt: unknown;
  updatedAt: unknown;
};

type StripeCheckoutSessionRequestData = {
  dropId: string;
  variantKey?: string;
  quantity?: number;
  returnUrl?: string;
};

export type StripeCheckoutProviderRequest = {
  mode: 'payment';
  automaticTax: true;
  billingAddressCollection: 'auto';
  successUrl: string;
  cancelUrl: string;
  clientReferenceId: string;
  quantity: number;
  currency: typeof STRIPE_OFFCHAIN_CURRENCY;
  unitAmountCents: number;
  productName: string;
  productTaxCode: string;
  metadata: Record<string, string>;
  allowedCountries: readonly StripeCheckoutAllowedCountry[];
};

export type StripeCheckoutProviderResponse = {
  id: string;
  url: string;
  livemode: boolean;
};

export type StripeCheckoutSessionCoreResult = {
  session: StripeCheckoutProviderResponse;
  dropId: string;
  mode: StripeCheckoutMode;
};

export type StripeCheckoutSessionCoreDependencies = {
  getDrop: (dropId: string) => StripeCheckoutSessionDrop | undefined;
  loadOnchainConfig: (drop: StripeCheckoutSessionDrop) => Promise<StripeCheckoutOnchainConfig>;
  requireFulfillmentPrerequisites: (config: StripeCheckoutOnchainConfig) => void;
  createProviderSession: (
    request: StripeCheckoutProviderRequest,
    mode: StripeCheckoutMode,
  ) => Promise<StripeCheckoutProviderResponse>;
  persistCheckout: (path: string, document: Record<string, unknown>) => Promise<void>;
  nowMs?: () => number;
  testUnitAmountCents?: number;
};

function normalizedString(value: unknown): string {
  return String(value || '').trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function parseOptionalString(value: unknown, label: string, maxLength: number): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new StripeCheckoutSessionError('invalid-argument', `${label} must be a string.`);
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength) {
    throw new StripeCheckoutSessionError('invalid-argument', `${label} is invalid.`);
  }
  return normalized;
}

function parseStripeCheckoutSessionRequest(value: unknown): StripeCheckoutSessionRequestData {
  if (!isRecord(value)) throw new StripeCheckoutSessionError('invalid-argument', 'Invalid checkout request.');
  const allowedKeys = new Set(['dropId', 'variantKey', 'quantity', 'returnUrl']);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) {
    throw new StripeCheckoutSessionError('invalid-argument', 'Invalid checkout request.');
  }
  const dropId = parseOptionalString(value.dropId, 'dropId', 64);
  if (!dropId) throw new StripeCheckoutSessionError('invalid-argument', 'dropId is required.');
  const variantKey = parseOptionalString(value.variantKey, 'variantKey', 64);
  const returnUrl = parseOptionalString(value.returnUrl, 'returnUrl', 2048);
  let quantity: number | undefined;
  if (value.quantity !== undefined) {
    quantity = normalizeStripeCheckoutQuantity(value.quantity);
  }
  return { dropId, ...(variantKey ? { variantKey } : {}), ...(quantity ? { quantity } : {}), ...(returnUrl ? { returnUrl } : {}) };
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
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error('Invalid returnUrl');
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error('returnUrl must be an http(s) URL');
  let expectedOrigin = '';
  if (requestOrigin) {
    expectedOrigin = normalizedHttpOrigin(requestOrigin);
    if (!expectedOrigin) throw new Error('Invalid request origin');
  }
  const allowedOrigin = isDefaultStripeCheckoutReturnOrigin(parsed, allowLocalhost) ||
    (args.allowedOrigins || []).some((origin) => normalizedHttpOrigin(origin) === parsed.origin);
  if (expectedOrigin && parsed.origin !== expectedOrigin) throw new Error('returnUrl origin mismatch');
  if (!allowedOrigin) throw new Error(expectedOrigin ? 'returnUrl origin is not allowed' : 'returnUrl origin mismatch');
  parsed.searchParams.set('stripe_checkout', args.status);
  parsed.searchParams.delete('session_id');
  if (args.status === 'success') parsed.searchParams.set('session_id', '{CHECKOUT_SESSION_ID}');
  return parsed.toString().replace('%7BCHECKOUT_SESSION_ID%7D', '{CHECKOUT_SESSION_ID}');
}

export function normalizeStripeCheckoutQuantity(value: unknown): number {
  if (value === undefined || value === null || value === '') return STRIPE_OFFCHAIN_CHECKOUT_QUANTITY;
  const quantity = Number(value);
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > STRIPE_OFFCHAIN_CHECKOUT_MAX_QUANTITY) {
    throw new StripeCheckoutSessionError(
      'invalid-argument',
      `Stripe checkout quantity must be an integer from 1 to ${STRIPE_OFFCHAIN_CHECKOUT_MAX_QUANTITY}`,
    );
  }
  return quantity;
}

export function stripeCheckoutShippingCountriesForDropFamily(dropFamily: unknown): readonly StripeCheckoutAllowedCountry[] {
  return dropFamily === 'card_nft_binder'
    ? STRIPE_CHECKOUT_BINDER_SHIPPING_COUNTRIES
    : STRIPE_CHECKOUT_DEFAULT_SHIPPING_COUNTRIES;
}

export function stripeCheckoutOwnerId(uid: string): string {
  const normalizedUid = normalizedString(uid);
  if (!normalizedUid) throw new Error('App-created Stripe checkout is missing uid');
  return `${STRIPE_CHECKOUT_OWNER_KIND_FIREBASE}:${normalizedUid}`;
}

export function resolveMintSelectionVariantIndex(selection: MintSelectionConfig | undefined, variantKey: string): number {
  const key = normalizedString(variantKey);
  if (!key) throw new Error('Missing variantKey');
  if (selection?.kind !== 'size' || !Array.isArray(selection.options)) throw new Error('Drop does not use size variant minting');
  const index = selection.options.findIndex((option) => option?.key === key);
  if (index < 0) throw new Error('Invalid variantKey');
  return index;
}

function stripeCheckoutKindForDrop(drop: Pick<StripeCheckoutSessionDrop, 'itemsPerBox' | 'salesMode' | 'mintSelection'>): StripeCheckoutKind {
  const checkoutKind = classifyStripeCheckoutKind(drop);
  if (checkoutKind) return checkoutKind;
  throw new StripeCheckoutSessionError(
    'failed-precondition',
    'Stripe checkout is only enabled for direct-delivery size drops, receipt-only drops, or standard pack drops.',
  );
}

function normalizeStripeCheckoutVariantKey(
  drop: Pick<StripeCheckoutSessionDrop, 'mintSelection'>,
  rawVariantKey: string | undefined,
  checkoutKind: StripeCheckoutKind,
): string | undefined {
  const raw = normalizedString(rawVariantKey);
  if (checkoutKind !== 'size_variant') {
    if (raw) throw new StripeCheckoutSessionError('invalid-argument', 'variantKey is only supported for size Stripe checkout.');
    return undefined;
  }
  let index: number;
  try {
    index = resolveMintSelectionVariantIndex(drop.mintSelection, raw);
  } catch {
    throw new StripeCheckoutSessionError('invalid-argument', raw ? 'Invalid variantKey' : 'variantKey is required for Stripe checkout.');
  }
  return drop.mintSelection?.options[index]?.key;
}

export function stripeCheckoutProductTaxCodeForDrop(drop: Pick<StripeCheckoutSessionDrop, 'stripeCheckoutEnabled' | 'stripeProductTaxCode'>): string {
  if (drop.stripeCheckoutEnabled !== true) {
    throw new StripeCheckoutSessionError('failed-precondition', 'Stripe checkout is not enabled for this drop.');
  }
  const taxCode = normalizedString(drop.stripeProductTaxCode);
  if (!taxCode) throw new StripeCheckoutSessionError('failed-precondition', 'Stripe product tax code is not configured for this drop.');
  if (!STRIPE_PRODUCT_TAX_CODE_RE.test(taxCode)) {
    throw new StripeCheckoutSessionError('failed-precondition', 'Stripe product tax code is invalid for this drop.');
  }
  return taxCode;
}

export function stripeCheckoutUnitAmountCentsForDrop(
  drop: Pick<StripeCheckoutSessionDrop, 'solanaCluster' | 'stripeLiveUnitAmountCents'>,
  testConfiguredUnitAmountCents?: unknown,
): number {
  const mode = drop.solanaCluster === 'devnet' ? 'test' : drop.solanaCluster === 'mainnet-beta' ? 'live' : null;
  if (!mode) throw new StripeCheckoutSessionError('failed-precondition', 'Stripe checkout is only enabled for devnet and mainnet drops.');
  if (mode === 'live' && drop.stripeLiveUnitAmountCents == null) {
    throw new StripeCheckoutSessionError('failed-precondition', 'Stripe live unit amount is not configured for this drop.');
  }
  const value = resolveStripeCheckoutUnitAmountCents({
    mode,
    testConfiguredUnitAmountCents,
    testFallbackUnitAmountCents: STRIPE_TEST_UNIT_AMOUNT_CENTS_DEFAULT,
    liveConfiguredUnitAmountCents: drop.stripeLiveUnitAmountCents,
  });
  if (value == null || value < STRIPE_UNIT_AMOUNT_CENTS_MIN || value > STRIPE_UNIT_AMOUNT_CENTS_MAX) {
    throw new StripeCheckoutSessionError(
      'failed-precondition',
      `Stripe unit amount must be an integer from ${STRIPE_UNIT_AMOUNT_CENTS_MIN} to ${STRIPE_UNIT_AMOUNT_CENTS_MAX}.`,
    );
  }
  return value;
}

function itemNameWithCollectionCasing(itemName: string, collectionSuffix: string): string {
  if (!collectionSuffix || collectionSuffix[0] !== collectionSuffix[0].toUpperCase()) return itemName;
  return `${itemName.slice(0, 1).toUpperCase()}${itemName.slice(1)}`;
}

export function stripeCheckoutProductName(
  drop: Pick<StripeCheckoutSessionDrop, 'dropId' | 'displayName' | 'collectionName' | 'namePrefix'>,
  variantKey: string | undefined,
  mode: StripeCheckoutMode,
): string {
  const collectionName = normalizedString(drop.displayName || drop.collectionName || drop.dropId);
  const itemName = normalizedString(drop.namePrefix || 'item');
  let baseName = collectionName;
  if (itemName) {
    const normalizedCollection = collectionName.toLowerCase();
    const normalizedItemName = itemName.toLowerCase();
    const suffixes = [`${normalizedItemName}s`, ...(normalizedItemName.endsWith('y') ? [`${normalizedItemName.slice(0, -1)}ies`] : [])];
    const suffix = suffixes.find((candidate) => normalizedCollection.endsWith(candidate));
    if (suffix) {
      const collectionSuffix = collectionName.slice(collectionName.length - suffix.length);
      baseName = `${collectionName.slice(0, collectionName.length - suffix.length)}${itemNameWithCollectionCasing(itemName, collectionSuffix)}`.trim();
    } else if (!normalizedCollection.endsWith(normalizedItemName)) {
      baseName = `${collectionName} ${itemName}`;
    }
  }
  return `${mode === 'test' ? 'test ' : ''}${baseName}${variantKey ? ` ${variantKey}` : ''}`.slice(0, 200);
}

function assertStripeCheckoutAvailable(args: {
  drop: StripeCheckoutSessionDrop;
  config: StripeCheckoutOnchainConfig;
  checkoutKind: StripeCheckoutKind;
  variantKey?: string;
  quantity: number;
}): void {
  const { drop, config, checkoutKind, variantKey, quantity } = args;
  if (!config.started) throw new StripeCheckoutSessionError('failed-precondition', 'Mint has not started.');
  if (config.minted + quantity > config.maxSupply) throw new StripeCheckoutSessionError('failed-precondition', 'Mint is sold out.');
  if (quantity > config.maxPerTx) {
    throw new StripeCheckoutSessionError('failed-precondition', `Stripe checkout quantity cannot exceed ${config.maxPerTx}.`);
  }
  const salesMode = drop.salesMode === 'stripe_receipt_only' ? 'stripe_receipt_only' : 'standard';
  if (checkoutKind === 'receipt_only') {
    if (salesMode !== 'stripe_receipt_only' || !isDirectDeliveryItemsPerBox(config.itemsPerBox) || config.mintVariantKind !== BOX_MINTER_MINT_VARIANT_KIND_NONE) {
      throw new StripeCheckoutSessionError('failed-precondition', 'Stripe receipt checkout requires a non-variant receipt-only drop.');
    }
    return;
  }
  if (checkoutKind === 'standard_pack') {
    if (salesMode === 'stripe_receipt_only' || isDirectDeliveryItemsPerBox(config.itemsPerBox) || config.mintVariantKind !== BOX_MINTER_MINT_VARIANT_KIND_NONE) {
      throw new StripeCheckoutSessionError('failed-precondition', 'Stripe pack checkout requires a non-variant pack drop.');
    }
    return;
  }
  if (!isDirectDeliveryItemsPerBox(config.itemsPerBox) || config.mintVariantKind !== BOX_MINTER_MINT_VARIANT_KIND_SIZE) {
    throw new StripeCheckoutSessionError('failed-precondition', 'Stripe checkout requires on-chain size variant minting.');
  }
  let variantIndex: number;
  try {
    variantIndex = resolveMintSelectionVariantIndex(drop.mintSelection, variantKey || '');
  } catch (error) {
    throw new StripeCheckoutSessionError('invalid-argument', error instanceof Error ? error.message : 'Invalid variantKey');
  }
  const option = drop.mintSelection?.options[variantIndex];
  const startId = config.mintVariantStartIds[variantIndex];
  const endId = config.mintVariantEndIds[variantIndex];
  const nextId = config.mintVariantNextIds[variantIndex];
  if (!option || option.startId !== startId || option.endId !== endId) {
    throw new StripeCheckoutSessionError('failed-precondition', 'Drop mint selection is out of sync with on-chain variant ranges.');
  }
  if (nextId === undefined || startId === undefined || endId === undefined || nextId < startId) {
    throw new StripeCheckoutSessionError('failed-precondition', 'On-chain size variant state is invalid.');
  }
  if (nextId > endId || nextId + quantity - 1 > endId) {
    throw new StripeCheckoutSessionError('failed-precondition', 'Selected size is sold out.');
  }
}

export function buildStripeCheckoutSessionMetadata(args: {
  dropId: string;
  uid: string;
  variantKey?: string;
  quantity?: number;
}): Record<string, string> {
  const quantity = normalizeStripeCheckoutQuantity(args.quantity);
  const variantKey = normalizedString(args.variantKey);
  return {
    dropId: args.dropId,
    uid: args.uid,
    fulfillmentMode: STRIPE_OFFCHAIN_FULFILLMENT_MODE,
    placeholder: 'stripe_direct_delivery',
    quantity: String(quantity),
    ...(variantKey ? { variantKey } : {}),
  };
}

export function buildStripeCheckoutDocument(args: StripeCheckoutDocumentInput): Record<string, unknown> {
  const quantity = normalizeStripeCheckoutQuantity(args.quantity);
  const variantKey = normalizedString(args.variantKey);
  return {
    sessionId: args.sessionId,
    dropId: args.dropId,
    uid: args.uid,
    owner: stripeCheckoutOwnerId(args.uid),
    ownerKind: STRIPE_CHECKOUT_OWNER_KIND_FIREBASE,
    firebaseUid: args.uid,
    ...(variantKey ? { variantKey } : {}),
    quantity,
    currency: STRIPE_OFFCHAIN_CURRENCY,
    unitAmountCents: args.unitAmountCents,
    fulfillmentMode: STRIPE_OFFCHAIN_FULFILLMENT_MODE,
    livemode: args.livemode === true,
    status: STRIPE_CHECKOUT_STATUS.CREATED,
    createdAt: args.createdAt,
    updatedAt: args.updatedAt,
  };
}

export async function createStripeCheckoutSessionCore(
  input: {
    uid: string;
    requestOrigin?: string;
    allowedOrigins?: readonly string[];
    body: unknown;
  },
  dependencies: StripeCheckoutSessionCoreDependencies,
): Promise<StripeCheckoutSessionCoreResult> {
  const request = parseStripeCheckoutSessionRequest(input.body);
  let successUrl: string;
  let cancelUrl: string;
  try {
    successUrl = normalizeStripeCheckoutReturnUrl({
      requestOrigin: input.requestOrigin,
      rawReturnUrl: request.returnUrl,
      status: 'success',
      allowedOrigins: input.allowedOrigins,
    });
    cancelUrl = normalizeStripeCheckoutReturnUrl({
      requestOrigin: input.requestOrigin,
      rawReturnUrl: request.returnUrl,
      status: 'cancel',
      allowedOrigins: input.allowedOrigins,
    });
  } catch (error) {
    throw new StripeCheckoutSessionError('invalid-argument', error instanceof Error ? error.message : 'Invalid returnUrl');
  }
  const drop = dependencies.getDrop(request.dropId);
  if (!drop) throw new StripeCheckoutSessionError('invalid-argument', `Unsupported dropId: ${request.dropId}`);
  const mode = drop.solanaCluster === 'devnet' ? 'test' : drop.solanaCluster === 'mainnet-beta' ? 'live' : null;
  if (!mode) throw new StripeCheckoutSessionError('failed-precondition', 'Stripe checkout is only enabled for devnet and mainnet drops.');
  const checkoutKind = stripeCheckoutKindForDrop(drop);
  if (!normalizedString(drop.receiptsMerkleTree)) {
    throw new StripeCheckoutSessionError('failed-precondition', 'Stripe checkout requires a configured receipt cNFT tree.');
  }
  const variantKey = normalizeStripeCheckoutVariantKey(drop, request.variantKey, checkoutKind);
  const quantity = normalizeStripeCheckoutQuantity(request.quantity);
  try {
    assertStripeCheckoutQuantityForKind(checkoutKind, quantity);
  } catch (error) {
    throw new StripeCheckoutSessionError('invalid-argument', error instanceof Error ? error.message : 'Invalid checkout quantity.');
  }
  const productTaxCode = stripeCheckoutProductTaxCodeForDrop(drop);
  const unitAmountCents = stripeCheckoutUnitAmountCentsForDrop(drop, dependencies.testUnitAmountCents);
  const config = await dependencies.loadOnchainConfig(drop);
  assertStripeCheckoutAvailable({ drop, config, checkoutKind, variantKey, quantity });
  if (config.coreCollection !== drop.collectionMint) {
    throw new StripeCheckoutSessionError('failed-precondition', 'COLLECTION_MINT does not match on-chain config', {
      configured: drop.collectionMint,
      onchain: config.coreCollection,
      dropId: drop.dropId,
    });
  }
  dependencies.requireFulfillmentPrerequisites(config);
  const nowMs = dependencies.nowMs?.() ?? Date.now();
  const providerRequest: StripeCheckoutProviderRequest = {
    mode: 'payment',
    automaticTax: true,
    billingAddressCollection: 'auto',
    successUrl,
    cancelUrl,
    clientReferenceId: `${input.uid}:${drop.dropId}:${nowMs}`.slice(0, 200),
    quantity,
    currency: STRIPE_OFFCHAIN_CURRENCY,
    unitAmountCents,
    productName: stripeCheckoutProductName(drop, variantKey, mode),
    productTaxCode,
    metadata: buildStripeCheckoutSessionMetadata({ dropId: drop.dropId, uid: input.uid, variantKey, quantity }),
    allowedCountries: stripeCheckoutShippingCountriesForDropFamily(drop.dropFamily),
  };
  const session = await dependencies.createProviderSession(providerRequest, mode);
  let checkoutUrl: URL;
  try {
    checkoutUrl = new URL(session.url);
  } catch {
    throw new StripeCheckoutSessionError('unavailable', 'Stripe response did not include a checkout URL');
  }
  if (!normalizedString(session.id) || checkoutUrl.protocol !== 'https:' || typeof session.livemode !== 'boolean') {
    throw new StripeCheckoutSessionError('unavailable', 'Stripe response did not include a checkout URL');
  }
  if (session.livemode !== (mode === 'live')) {
    throw new StripeCheckoutSessionError('failed-precondition', 'Stripe response mode does not match the configured drop mode');
  }
  const serverTimestamp = { serverTimestamp: true };
  const document = buildStripeCheckoutDocument({
    dropId: drop.dropId,
    sessionId: session.id,
    uid: input.uid,
    ...(variantKey ? { variantKey } : {}),
    unitAmountCents,
    quantity,
    livemode: session.livemode,
    createdAt: serverTimestamp,
    updatedAt: serverTimestamp,
  });
  await dependencies.persistCheckout(`drops/${drop.dropId}/stripeCheckouts/${session.id}`, document);
  return { session, dropId: drop.dropId, mode };
}
