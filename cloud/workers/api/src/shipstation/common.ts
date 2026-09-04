import { z } from 'zod';
import nacl from 'tweetnacl';
import { normalizeDropId } from '../../../../../shared/deploymentCore.js';
import { DEPLOYMENT_DROPS } from '../../../../../shared/deploymentRegistry.js';
import {
  FULFILLMENT_ADMIN_WALLET_ADDRESSES,
  SHIPPER_FULFILLMENT_ACCESS,
  walletHasFulfillmentDropAccess,
} from '../../../../../shared/fulfillmentAccess.js';
import { ADMIN_IRL_REDEEM_DELIVERY_ORDER_SOURCE } from '../../../../../shared/fulfillmentSources.js';
import {
  ADDRESS_CIPHER_SECRET_KEY_LENGTH,
  addressCipherHint,
  decryptAddressCipherText,
  encryptAddressCipherText,
  parseAddressCipherPayload,
  serializeAddressCipherPayload,
} from '../../../../../shared/addressCipher.js';
import {
  storedFulfillmentShipStationLabel,
  ShipStationLabelProviderError,
} from '../../../../../shared/shipstationLabels.js';
import {
  buildShipStationCustomsDeclaration,
  type ShipStationCustomsDeclaration,
} from '../../../../../shared/shipstationCustoms.js';
import {
  ShipStationAddressCorrectionProviderError,
  ShipStationRatesProviderError,
} from '../../../../../shared/shipstationRates.js';
import { type ShipStationPackageInput } from '../../../../../shared/shipstationPackage.js';
import type { FulfillmentShipStationAddressCorrectionDetails } from '../../../../../shared/contracts.js';
import { isSignalCancellationError } from '../boundedRequest.js';
import {
  isRecord,
  ProfileReadError,
} from '../dataAccess.js';
import { optionalString } from '../profileWriteRates.js';
import { type ProfileWriteOperationContext } from '../profileWriteOperation.js';

export const SHIPSTATION_CLAIM_TTL_MS = 120_000;
const ADMIN_WALLETS = new Set(FULFILLMENT_ADMIN_WALLET_ADDRESSES);
const SHIPPER_DROP_IDS_BY_WALLET = new Map(
  SHIPPER_FULFILLMENT_ACCESS.map(({ wallet, dropIds }) => [wallet, new Set(dropIds)]),
);

export const shipStationRatesSchema = z.object({
  dropId: z.string().min(1).max(64),
  deliveryId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  package: z.object({
    length: z.number(),
    width: z.number(),
    height: z.number(),
    weight: z.number(),
  }).strict().optional(),
}).strict();

export class ShipStationProfileError extends ProfileReadError {
  constructor(
    code: ConstructorParameters<typeof ProfileReadError>[0],
    status: number,
    message: string,
    readonly details?: unknown,
  ) {
    super(code, status, message);
  }
}

export function clientCancellationReason(
  error: unknown,
  common: ProfileWriteOperationContext,
): unknown | undefined {
  return isSignalCancellationError(common.requestSignal, error)
    ? common.requestSignal.reason
    : undefined;
}

export function supportedDropId(value: string): string {
  const dropId = normalizeDropId(value);
  if (!Object.hasOwn(DEPLOYMENT_DROPS, dropId)) {
    throw new ProfileReadError('invalid-argument', 400, `Unsupported dropId: ${dropId}`);
  }
  return dropId;
}

function decodeBase64(value: string): Uint8Array | null {
  try {
    return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}

function encodeBase64(value: Uint8Array): string {
  let binary = '';
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function encryptFulfillmentAddress(full: string, secretValue: string): { encrypted: string; hint: string } {
  const secret = decodeBase64(secretValue.trim());
  if (!secret || secret.length !== ADDRESS_CIPHER_SECRET_KEY_LENGTH) {
    throw new ProfileReadError(
      'unavailable',
      503,
      'ADDRESS_DECRYPTION_SECRET is not configured for Stripe fulfillment',
    );
  }
  try {
    const recipientPublicKey = nacl.box.keyPair.fromSecretKey(secret).publicKey;
    const encrypted = serializeAddressCipherPayload(
      encryptAddressCipherText(full, recipientPublicKey),
      encodeBase64,
    );
    return { encrypted, hint: addressCipherHint(full) };
  } catch {
    throw new ProfileReadError('unavailable', 503, 'Stripe checkout shipping address could not be encrypted');
  }
}

export function decryptFulfillmentAddress(payload: string, secretValue: string): string | null {
  const secret = decodeBase64(secretValue.trim());
  if (!secret || secret.length !== ADDRESS_CIPHER_SECRET_KEY_LENGTH) {
    throw new ProfileReadError('unavailable', 503, 'Fulfillment address decryption is temporarily unavailable.');
  }
  const parts = parseAddressCipherPayload(payload, decodeBase64);
  return parts ? decryptAddressCipherText(parts, secret) : null;
}

export function requireFulfillmentAccess(wallet: string, dropId: string): void {
  if (!walletHasFulfillmentDropAccess(wallet, dropId, ADMIN_WALLETS, SHIPPER_DROP_IDS_BY_WALLET)) {
    throw new ProfileReadError('permission-denied', 403, 'Fulfillment access denied.');
  }
}

export function rejectIrlShipStationOrder(order: Record<string, unknown>): void {
  if (order.source === ADMIN_IRL_REDEEM_DELIVERY_ORDER_SOURCE) {
    throw new ProfileReadError('failed-precondition', 409, 'In-person redemption orders do not have a delivery address');
  }
}

export function shipStationState(order: Record<string, unknown>): Record<string, unknown> {
  return isRecord(order.shipstation) ? order.shipstation : {};
}

export function requireShipStationShipmentId(order: Record<string, unknown>): string {
  const shipmentId = optionalString(shipStationState(order).shipmentId);
  if (!shipmentId) {
    throw new ProfileReadError('failed-precondition', 409, 'Add this order to ShipStation before getting rates.');
  }
  return shipmentId;
}

export type ShipStationRateMutationExpectation = {
  claimId: string | null;
  claimedBy: string | null;
  labelIdentity: string;
  purchaseIdentity: string;
  shipmentId: string;
};

export function shipStationLabelIdentity(value: unknown): string {
  const label = storedFulfillmentShipStationLabel(value);
  return label ? JSON.stringify([
    label.labelId,
    label.shipmentId,
    label.status,
    label.rateId ?? null,
    label.trackingNumber ?? null,
    label.carrierId ?? null,
    label.carrierCode ?? null,
    label.carrierName ?? null,
    label.serviceCode ?? null,
    label.serviceName ?? null,
    label.shipmentCost?.currency ?? null,
    label.shipmentCost?.amount ?? null,
    label.insuranceCost?.currency ?? null,
    label.insuranceCost?.amount ?? null,
    label.totalCost?.currency ?? null,
    label.totalCost?.amount ?? null,
    label.purchasedAt ?? null,
    label.purchasedBy ?? null,
  ]) : '';
}

function shipStationPurchaseIdentity(shipstation: Record<string, unknown>): string {
  const purchase = isRecord(shipstation.labelPurchase) ? shipstation.labelPurchase : {};
  return `${optionalString(purchase.status) ?? ''}\n${optionalString(purchase.requestId) ?? ''}`;
}

export function rateMutationExpectation(
  order: Record<string, unknown>,
  shipmentId: string,
  claim?: { claimId: string; wallet: string },
): ShipStationRateMutationExpectation {
  const shipstation = shipStationState(order);
  return {
    shipmentId,
    labelIdentity: shipStationLabelIdentity(shipstation.label),
    purchaseIdentity: shipStationPurchaseIdentity(shipstation),
    claimId: claim?.claimId ?? optionalString(shipstation.ratesClaimId) ?? null,
    claimedBy: claim?.wallet ?? optionalString(shipstation.ratesClaimedBy) ?? null,
  };
}

export function requireRateMutationState(
  order: Record<string, unknown>,
  expected: ShipStationRateMutationExpectation,
): Record<string, unknown> {
  const shipstation = shipStationState(order);
  if (optionalString(shipstation.shipmentId) !== expected.shipmentId) {
    throw new ProfileReadError('aborted', 409, 'The ShipStation shipment changed. Refresh the order and try again.');
  }
  if (shipStationLabelIdentity(shipstation.label) !== expected.labelIdentity) {
    throw new ProfileReadError('aborted', 409, 'The ShipStation label changed. Check its status again.');
  }
  if (shipStationPurchaseIdentity(shipstation) !== expected.purchaseIdentity) {
    throw new ProfileReadError('aborted', 409, 'The ShipStation label purchase changed. Check its status again.');
  }
  if (
    (optionalString(shipstation.ratesClaimId) ?? null) !== expected.claimId ||
    (optionalString(shipstation.ratesClaimedBy) ?? null) !== expected.claimedBy
  ) {
    throw new ProfileReadError('aborted', 409, 'The ShipStation rate refresh claim changed. Try again.');
  }
  return shipstation;
}

function fulfillmentShipmentItemCounts(order: Record<string, unknown>): { boxCount: number; looseItemCount: number } {
  const items = Array.isArray(order.items) ? order.items : [];
  let boxCount = 0;
  let looseItemCount = 0;
  for (const item of items) {
    if (!isRecord(item) || (item.kind !== 'box' && item.kind !== 'dude')) continue;
    const refId = Math.floor(Number(item.refId));
    if (!Number.isFinite(refId) || refId <= 0) continue;
    if (item.kind === 'box') boxCount += 1;
    else looseItemCount += 1;
  }
  return { boxCount, looseItemCount };
}

export function fulfillmentShipmentUnitCount(order: Record<string, unknown>): number {
  const counts = fulfillmentShipmentItemCounts(order);
  return counts.boxCount + counts.looseItemCount;
}

export function requireShipStationCustomsDeclaration(
  dropId: string,
  order: Record<string, unknown>,
): ShipStationCustomsDeclaration {
  const counts = fulfillmentShipmentItemCounts(order);
  const declaration = buildShipStationCustomsDeclaration(dropId, counts.boxCount, counts.looseItemCount);
  if (!declaration) {
    throw new ProfileReadError(
      'failed-precondition',
      409,
      'International customs data is unavailable for this product.',
    );
  }
  return declaration;
}

export function requireShipStationPackageWeight(
  parcel: ShipStationPackageInput,
  requiredWeightOunces: number,
): void {
  if (!Number.isFinite(requiredWeightOunces) || parcel.weight + 0.005 >= requiredWeightOunces) return;
  throw new ProfileReadError(
    'failed-precondition',
    409,
    `Package weight must be at least ${requiredWeightOunces} oz for the customs items in this shipment.`,
  );
}

export function profileErrorForShipStation(
  error: ShipStationLabelProviderError | ShipStationRatesProviderError,
): ProfileReadError {
  const details: FulfillmentShipStationAddressCorrectionDetails | undefined =
    error instanceof ShipStationAddressCorrectionProviderError
      ? { kind: 'shipstation-address-correction', fields: error.fields }
      : undefined;
  if (error.code === 'deadline-exceeded') return new ShipStationProfileError(error.code, 504, error.message);
  if (error.code === 'resource-exhausted') return new ShipStationProfileError(error.code, 429, error.message);
  if (error.code === 'failed-precondition') return new ShipStationProfileError(error.code, 409, error.message, details);
  if (error.code === 'internal') return new ShipStationProfileError('unavailable', 502, error.message);
  return new ShipStationProfileError(error.code, 502, error.message);
}
