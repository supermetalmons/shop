import type {
  FulfillmentOrder,
  FulfillmentOrderAddress,
  FulfillmentOrderBox,
  FulfillmentOrderCardClaim,
  FulfillmentShipStationLabel,
  ShipStationMoney,
  StripeCheckoutManualReviewAddress,
  StripeCheckoutManualReviewSummary,
} from './contracts.js';
import { normalizeFulfillmentStatus } from './fulfillmentStatus.js';
import { ADMIN_IRL_REDEEM_DELIVERY_ORDER_SOURCE } from './fulfillmentSources.js';
import { normalizeOptionalFulfillmentTrackingCode } from './fulfillmentTracking.js';
import { normalizeShipStationPackage } from './shipstationPackage.js';
import { normalizeStripeReceiptClaimCode } from './stripeReceiptClaims.js';

const ADMIN_IRL_REDEEM_LABEL = 'Redeemed for IRL';

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function optionalMillis(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function positiveInteger(value: unknown): number | null {
  const parsed = Math.floor(Number(value));
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function storedMoney(value: unknown): ShipStationMoney | undefined {
  const raw = record(value);
  if (!raw) return undefined;
  const currency = optionalString(raw.currency)?.toLowerCase() || '';
  const amount = Number(raw.amount);
  return /^[a-z]{3}$/.test(currency) && Number.isFinite(amount) && amount >= 0
    ? { currency, amount }
    : undefined;
}

function storedLabel(value: unknown): FulfillmentShipStationLabel | undefined {
  const raw = record(value);
  if (!raw) return undefined;
  const labelId = optionalString(raw.labelId);
  const shipmentId = optionalString(raw.shipmentId);
  const status = raw.status;
  if (
    !labelId ||
    !shipmentId ||
    (status !== 'processing' && status !== 'completed' && status !== 'error' && status !== 'voided')
  ) return undefined;
  const shipmentCost = storedMoney(raw.shipmentCost);
  const insuranceCost = storedMoney(raw.insuranceCost);
  const totalCost = storedMoney(raw.totalCost);
  const purchasedAt = optionalMillis(raw.purchasedAt);
  return {
    labelId,
    shipmentId,
    status,
    ...(optionalString(raw.rateId) ? { rateId: optionalString(raw.rateId) } : {}),
    ...(optionalString(raw.trackingNumber) ? { trackingNumber: optionalString(raw.trackingNumber) } : {}),
    ...(optionalString(raw.carrierId) ? { carrierId: optionalString(raw.carrierId) } : {}),
    ...(optionalString(raw.carrierCode) ? { carrierCode: optionalString(raw.carrierCode) } : {}),
    ...(optionalString(raw.carrierName) ? { carrierName: optionalString(raw.carrierName) } : {}),
    ...(optionalString(raw.serviceCode) ? { serviceCode: optionalString(raw.serviceCode) } : {}),
    ...(optionalString(raw.serviceName) ? { serviceName: optionalString(raw.serviceName) } : {}),
    ...(shipmentCost ? { shipmentCost } : {}),
    ...(insuranceCost ? { insuranceCost } : {}),
    ...(totalCost ? { totalCost } : {}),
    ...(purchasedAt !== undefined ? { purchasedAt } : {}),
    ...(optionalString(raw.purchasedBy) ? { purchasedBy: optionalString(raw.purchasedBy) } : {}),
  };
}

type ReceiptClaimSummary = { code?: string; status?: string };

function receiptClaimSummary(value: unknown): ReceiptClaimSummary {
  const raw = record(value);
  if (!raw) return {};
  const code = normalizeStripeReceiptClaimCode(raw.code);
  const status = optionalString(raw.status);
  return { ...(code ? { code } : {}), ...(status ? { status } : {}) };
}

function collectReceiptClaims(order: Record<string, unknown>): Map<number, ReceiptClaimSummary> {
  const result = new Map<number, ReceiptClaimSummary>();
  const add = (boxIdValue: unknown, claimValue: unknown) => {
    const boxId = positiveInteger(boxIdValue);
    if (boxId === null || result.has(boxId)) return;
    result.set(boxId, receiptClaimSummary(claimValue));
  };
  const byBoxId = record(order.stripeReceiptClaimsByBoxId);
  if (byBoxId) {
    for (const [key, value] of Object.entries(byBoxId)) {
      add(record(value)?.boxId ?? key.replace(/^box_/, ''), value);
    }
  }
  if (Array.isArray(order.stripeReceiptClaims)) {
    for (const value of order.stripeReceiptClaims) add(record(value)?.boxId, value);
  }
  if (order.stripeReceiptClaim) add(record(order.stripeReceiptClaim)?.boxId, order.stripeReceiptClaim);
  return result;
}

export function fulfillmentOrderFromRecord(
  documentId: string,
  value: unknown,
  options: {
    canViewSensitiveAddress: boolean;
    decryptAddress: (payload: string) => string | null;
    dropId: string;
  },
): FulfillmentOrder | null {
  const order = record(value);
  if (!order) return null;
  const deliveryId = positiveInteger(order.deliveryId ?? documentId);
  if (deliveryId === null) return null;
  const source = optionalString(order.source);
  const isAdminIrlRedeem = source === ADMIN_IRL_REDEEM_DELIVERY_ORDER_SOURCE;
  const addressSnapshot = record(order.addressSnapshot) || {};
  const encrypted = optionalString(addressSnapshot.encrypted);
  const shipstation = record(order.shipstation) || {};
  const shipstationPackage = normalizeShipStationPackage(shipstation.package) || undefined;
  const rawPackageCount = Math.floor(Number(shipstation.packageCount));
  const shipstationPackageCount = Number.isFinite(rawPackageCount) && rawPackageCount >= 0
    ? rawPackageCount
    : shipstationPackage ? 1 : undefined;

  let full: string | null = null;
  let email = optionalString(addressSnapshot.email);
  let phone = optionalString(addressSnapshot.phone);
  let encryptedPayload = encrypted;
  if (isAdminIrlRedeem) {
    full = ADMIN_IRL_REDEEM_LABEL;
    email = undefined;
    phone = undefined;
    encryptedPayload = undefined;
  } else if (options.canViewSensitiveAddress) {
    full = encrypted ? options.decryptAddress(encrypted) : null;
  } else {
    full = encrypted ? '***' : null;
    email = undefined;
    phone = undefined;
    encryptedPayload = undefined;
  }

  const address: FulfillmentOrderAddress = {
    label: isAdminIrlRedeem ? ADMIN_IRL_REDEEM_LABEL : optionalString(addressSnapshot.label),
    email,
    phone,
    country: isAdminIrlRedeem ? ADMIN_IRL_REDEEM_LABEL : optionalString(addressSnapshot.country),
    countryCode: optionalString(addressSnapshot.countryCode),
    hint: optionalString(addressSnapshot.hint),
    encrypted: encryptedPayload,
    full,
  };

  const items = Array.isArray(order.items) ? order.items : [];
  const boxItems = items.flatMap((value) => {
    const item = record(value);
    const boxId = item?.kind === 'box' ? positiveInteger(item.refId) : null;
    return boxId === null ? [] : [{ boxId, assetId: optionalString(item?.assetId) }];
  });
  const looseItems = items.flatMap((value) => {
    const item = record(value);
    const figureId = item?.kind === 'dude' ? positiveInteger(item.refId) : null;
    return figureId === null ? [] : [{ figureId, assetId: optionalString(item?.assetId) }];
  });
  const claimsByBox = new Map<number, { code?: string; dudeIds: number[]; boxAssetId?: string }>();
  if (Array.isArray(order.irlClaims)) {
    for (const value of order.irlClaims) {
      const claim = record(value);
      const boxId = positiveInteger(claim?.boxId);
      if (boxId === null) continue;
      claimsByBox.set(boxId, {
        code: optionalString(claim?.code),
        dudeIds: (Array.isArray(claim?.dudeIds) ? claim.dudeIds : []).flatMap((id) => {
          const parsed = positiveInteger(id);
          return parsed === null ? [] : [parsed];
        }),
        boxAssetId: optionalString(claim?.boxAssetId),
      });
    }
  }
  const receiptClaims = collectReceiptClaims(order);
  const boxes: FulfillmentOrderBox[] = boxItems.map((item) => {
    const claim = claimsByBox.get(item.boxId);
    const receipt = receiptClaims.get(item.boxId);
    return {
      boxId: item.boxId,
      assetId: item.assetId || claim?.boxAssetId,
      claimCode: claim?.code,
      ...(receipt?.code ? { receiptClaimCode: receipt.code } : {}),
      ...(receipt?.status ? { receiptClaimStatus: receipt.status } : {}),
      dudeIds: claim?.dudeIds || [],
    };
  }).sort((left, right) => left.boxId - right.boxId);

  const cardClaims: FulfillmentOrderCardClaim[] = [];
  const directClaim = record(order.stripeReceiptClaim);
  const adminIrlRedeem = record(order.adminIrlRedeem);
  if (isAdminIrlRedeem && adminIrlRedeem?.targetKind === 'card_receipt' && directClaim?.receiptKind === 'figure') {
    const figureId = positiveInteger(directClaim.figureId);
    const receiptAssetId = optionalString(directClaim.receiptAssetId);
    const item = figureId === null ? undefined : looseItems.find((candidate) =>
      candidate.figureId === figureId && (!receiptAssetId || !candidate.assetId || candidate.assetId === receiptAssetId));
    if (item && receiptAssetId) {
      const summary = receiptClaimSummary(directClaim);
      cardClaims.push({
        figureId: item.figureId,
        assetId: receiptAssetId,
        ...(summary.code ? { receiptClaimCode: summary.code } : {}),
        ...(summary.status ? { receiptClaimStatus: summary.status } : {}),
      });
    }
  }

  const shipstationLabel = storedLabel(shipstation.label);
  return {
    dropId: options.dropId,
    deliveryId,
    owner: optionalString(order.owner) || '',
    source,
    status: optionalString(order.status) || 'unknown',
    createdAt: optionalMillis(order.createdAt),
    processedAt: optionalMillis(order.processedAt),
    fulfillmentStatus: normalizeFulfillmentStatus(order.fulfillmentStatus),
    fulfillmentTrackingCode: normalizeOptionalFulfillmentTrackingCode(order.fulfillmentTrackingCode),
    fulfillmentUpdatedAt: optionalMillis(order.fulfillmentUpdatedAt),
    fulfillmentInternalStatus: optionalString(order.fulfillmentInternalStatus),
    shipstationShipmentId: optionalString(shipstation.shipmentId),
    shipstationAddedAt: optionalMillis(shipstation.createdAt),
    ...(shipstationPackage ? { shipstationPackage } : {}),
    ...(shipstationPackageCount !== undefined ? { shipstationPackageCount } : {}),
    ...(shipstationLabel ? { shipstationLabel } : {}),
    ...(shipstation.labelPurchase && ['unknown', 'purchasing'].includes(String(record(shipstation.labelPurchase)?.status))
      ? { shipstationPurchaseUnknown: true }
      : {}),
    address,
    boxes,
    looseDudes: looseItems.map((item) => item.figureId).sort((left, right) => left - right),
    cardClaims,
  };
}

function stripeAddress(session: unknown): { formatted: string; country?: string; countryCode?: string; email?: string } | null {
  const raw = record(session);
  const collected = record(raw?.collected_information) || record(raw?.collectedInformation) || {};
  const shipping = record(collected.shipping_details) || record(collected.shippingDetails) ||
    record(raw?.shipping_details) || record(raw?.shippingDetails) || {};
  const customer = record(raw?.customer_details) || record(raw?.customerDetails) || {};
  const address = record(shipping.address);
  if (!address) return null;
  const name = optionalString(shipping.name) || optionalString(customer.name) ||
    optionalString(collected.individual_name) || optionalString(collected.business_name);
  const line1 = optionalString(address.line1);
  const line2 = optionalString(address.line2);
  const city = optionalString(address.city);
  const state = optionalString(address.state);
  const postalCode = optionalString(address.postal_code) || optionalString(address.postalCode);
  const countryCode = optionalString(address.country)?.toUpperCase();
  const cityLine = [city, [state, postalCode].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  const formatted = [name, line1, line2, cityLine, countryCode].filter(Boolean).join('\n');
  if (!formatted) return null;
  const email = optionalString(customer.email) || optionalString(raw?.customer_email);
  return { formatted, country: countryCode, countryCode, email };
}

function manualReviewAddress(session: unknown, canViewSensitiveAddress: boolean): StripeCheckoutManualReviewAddress {
  const parsed = stripeAddress(session);
  if (!parsed) return { full: null };
  if (!canViewSensitiveAddress) {
    return {
      full: '***',
      ...(parsed.country ? { country: parsed.country } : {}),
      ...(parsed.countryCode ? { countryCode: parsed.countryCode } : {}),
    };
  }
  return {
    full: parsed.formatted,
    ...(parsed.email ? { email: parsed.email } : {}),
    ...(parsed.country ? { country: parsed.country } : {}),
    ...(parsed.countryCode ? { countryCode: parsed.countryCode } : {}),
  };
}

function firstErrorLine(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const line = value.split(/\r?\n/).map((part) => part.trim()).find(Boolean)?.replace(/\s+/g, ' ');
  if (!line) return undefined;
  return line.length <= 220 ? line : `${line.slice(0, 219).trimEnd()}…`;
}

export function isManualReviewCheckout(value: unknown): boolean {
  const checkout = record(value);
  return checkout?.manualRefundReviewRequired === true && checkout.status === 'fulfillment_failed';
}

export function manualReviewCheckoutFromRecord(args: {
  canViewSensitiveAddress: boolean;
  checkout: unknown;
  dropId: string;
  session: unknown;
  sessionId: string;
}): StripeCheckoutManualReviewSummary | null {
  const checkout = record(args.checkout);
  if (!checkout || !isManualReviewCheckout(checkout)) return null;
  const session = record(args.session) || {};
  const stored = record(checkout.stripeSessionSummary) || {};
  const metadata = record(stored.metadata) || record(session.metadata) || {};
  const quantity = positiveInteger(checkout.quantity ?? metadata.quantity);
  const amountRaw = Number(session.amount_total ?? stored.amount_total);
  const amountTotal = Number.isSafeInteger(amountRaw) && amountRaw >= 0 ? amountRaw : undefined;
  const currency = optionalString(session.currency ?? stored.currency)?.toLowerCase();
  const lastError = record(checkout.lastFulfillmentError);
  const details = record(lastError?.details);
  const errorMessage = [lastError?.message, details?.lastError, lastError?.lastError, checkout.manualRefundReviewReason]
    .map(firstErrorLine)
    .find(Boolean);
  const firebaseUid = optionalString(checkout.firebaseUid) || optionalString(checkout.uid);
  return {
    dropId: args.dropId,
    sessionId: args.sessionId,
    owner: optionalString(checkout.owner) || '',
    ...(firebaseUid ? { firebaseUid } : {}),
    ...(quantity !== null ? { quantity } : {}),
    ...(amountTotal !== undefined ? { amountTotal } : {}),
    ...(currency && /^[a-z]{3}$/.test(currency) ? { currency } : {}),
    ...(optionalMillis(checkout.createdAt) !== undefined ? { createdAt: optionalMillis(checkout.createdAt) } : {}),
    ...(optionalMillis(checkout.failedAt) !== undefined ? { failedAt: optionalMillis(checkout.failedAt) } : {}),
    ...(optionalString(checkout.manualRefundReviewReason)
      ? { manualRefundReviewReason: optionalString(checkout.manualRefundReviewReason) }
      : {}),
    ...(errorMessage ? { errorMessage } : {}),
    address: manualReviewAddress(args.session, args.canViewSensitiveAddress),
  };
}
