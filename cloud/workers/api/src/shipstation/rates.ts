import { z } from 'zod';
import {
  isActiveShipStationLabel,
  storedFulfillmentShipStationLabel,
} from '../../../../../shared/shipstationLabels.js';
import {
  buildShipStationPackages,
  getShipStationShipmentById,
  getShipStationShipmentRates,
  parseShipStationShipFrom,
  requestShipStationShipmentRates,
  shipStationPackageContentDescription,
  shipStationPackageDetails,
  shipStationPackageProducts,
  shipStationProductsTotalWeightOunces,
  ShipStationRatesProviderError,
  updateShipStationShipment,
  type ShipStationCustoms,
  type ShipStationPackageProduct,
  type ShipStationRateResponse,
} from '../../../../../shared/shipstationRates.js';
import {
  normalizeShipStationPackage,
  parseShipStationPackage,
  SHIPSTATION_PACKAGE_RANGE_MESSAGE,
  type ShipStationPackageInput,
} from '../../../../../shared/shipstationPackage.js';
import type { GetFulfillmentShipStationRatesResponse } from '../../../../../shared/contracts.js';
import {
  isRecord,
  ProfileReadError,
} from '../dataAccess.js';
import {
  commerceFieldValue,
  type CommerceUpdateValue,
} from '../commerceRepository.js';
import {
  loadDeliveryOrderDocument,
  mutateDeliveryOrder,
  type CommerceWriteCommon,
} from '../profileWriteCommerce.js';
import {
  commercePackage,
  commerceRateQuotes,
  optionalString,
} from '../profileWriteRates.js';
import {
  shipStationState,
  type ShipStationRateMutationExpectation,
  requireRateMutationState,
  shipStationRatesSchema,
  supportedDropId,
  requireFulfillmentAccess,
  ShipStationProfileError,
  rejectIrlShipStationOrder,
  requireShipStationShipmentId,
  rateMutationExpectation,
  SHIPSTATION_CLAIM_TTL_MS,
  requireShipStationCustomsDeclaration,
  requireShipStationPackageWeight,
  profileErrorForShipStation,
} from './common.js';
import {
  type ProfileWriteEnv,
  defineProfileWriteOperation,
} from '../profileWriteOperation.js';
import { reconcileFulfillmentShipStationLabel } from './labels.js';

const FULFILLMENT_SHIPSTATION_RATES_PATH = '/fulfillment/shipstation-rates';
const SHIPSTATION_RATES_OPERATION_TIMEOUT_MS = 55_000;
const MAX_SHIPSTATION_RATES_REQUEST_BYTES = 2048;
const SHIPSTATION_RATE_REQUEST_TTL_MS = 10 * 60_000;

type PendingShipStationRateRequest = {
  requestId: string;
  createdAt?: string;
};

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') return JSON.stringify(Number.isFinite(value) ? value : null);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (!isRecord(value)) return 'null';
  return `{${Object.keys(value)
    .filter((key) => value[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(',')}}`;
}

export async function shipStationRateInputHash(value: unknown): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(canonicalJson(value)),
  ));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function storedPendingShipStationRateRequest(
  value: unknown,
  shipmentId: string,
  parcel: ShipStationPackageInput,
  inputHash: string,
  nowMs: number,
): PendingShipStationRateRequest | undefined {
  if (!isRecord(value)) return undefined;
  const requestId = optionalString(value.requestId);
  const storedShipmentId = optionalString(value.shipmentId);
  const storedPackage = parseShipStationPackage(value.package);
  const requestedAt = typeof value.requestedAt === 'number' ? value.requestedAt : 0;
  if (
    !requestId ||
    storedShipmentId !== shipmentId ||
    !storedPackage ||
    !requestedAt ||
    optionalString(value.inputHash) !== inputHash ||
    nowMs - requestedAt >= SHIPSTATION_RATE_REQUEST_TTL_MS ||
    storedPackage.length !== parcel.length ||
    storedPackage.width !== parcel.width ||
    storedPackage.height !== parcel.height ||
    storedPackage.weight !== parcel.weight
  ) return undefined;
  const createdAt = optionalString(value.createdAt);
  return { requestId, ...(createdAt ? { createdAt } : {}) };
}

function orderShipStationPackage(order: Record<string, unknown>): ShipStationPackageInput | undefined {
  return parseShipStationPackage(shipStationState(order).package) ?? undefined;
}

function orderShipStationPackageCount(order: Record<string, unknown>): number {
  const packageCount = Math.floor(Number(shipStationState(order).packageCount) || 0);
  return Math.max(0, packageCount);
}

async function persistUnsupportedShipStationPackageCount(args: {
  common: CommerceWriteCommon;
  deliveryId: number;
  dropId: string;
  expected: ShipStationRateMutationExpectation;
  packageCount: number;
}): Promise<void> {
  await mutateDeliveryOrder<void>({
    common: args.common,
    deliveryId: args.deliveryId,
    dropId: args.dropId,
    build: ({ fields: order }) => {
      requireRateMutationState(order, args.expected);
      return {
        value: undefined,
        updates: {
          'shipstation.packageCount': args.packageCount,
          'shipstation.package': commerceFieldValue.delete(),
          'shipstation.rateQuotes': commerceFieldValue.delete(),
          'shipstation.rateRequest': commerceFieldValue.delete(),
          'shipstation.ratesClaimId': commerceFieldValue.delete(),
          'shipstation.ratesClaimedAt': commerceFieldValue.delete(),
          'shipstation.ratesClaimedBy': commerceFieldValue.delete(),
        },
      };
    },
  });
}

export async function pauseForRatePoll(signal: AbortSignal, delayMs: number): Promise<void> {
  if (signal.aborted) throw signal.reason;
  await new Promise<void>((resolve, reject) => {
    const finish = () => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    };
    const timeout = setTimeout(finish, delayMs);
    const onAbort = () => {
      clearTimeout(timeout);
      signal.removeEventListener('abort', onAbort);
      reject(signal.reason);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

async function persistPendingShipStationRateRequest(args: {
  common: CommerceWriteCommon;
  deliveryId: number;
  dropId: string;
  expected: ShipStationRateMutationExpectation;
  inputHash: string;
  package: ShipStationPackageInput;
  request: PendingShipStationRateRequest;
  shipmentId: string;
}): Promise<void> {
  await mutateDeliveryOrder<void>({
    common: args.common,
    deliveryId: args.deliveryId,
    dropId: args.dropId,
    build: ({ fields: order }) => {
      requireRateMutationState(order, args.expected);
      if (isActiveShipStationLabel(storedFulfillmentShipStationLabel(shipStationState(order).label))) {
        throw new ProfileReadError('failed-precondition', 409, 'This shipment already has a label.');
      }
      return {
        value: undefined,
        updates: {
          'shipstation.rateRequest.requestId': args.request.requestId,
          'shipstation.rateRequest.createdAt': args.request.createdAt || commerceFieldValue.delete(),
          'shipstation.rateRequest.shipmentId': args.shipmentId,
          'shipstation.rateRequest.inputHash': args.inputHash,
          'shipstation.rateRequest.package': commercePackage(args.package),
          'shipstation.rateRequest.requestedAt': commerceFieldValue.serverTimestamp(),
        },
      };
    },
  });
}

async function getCompletedShipStationRates(args: {
  apiKey: string;
  common: CommerceWriteCommon;
  deliveryId: number;
  dropId: string;
  expected: ShipStationRateMutationExpectation;
  inputHash: string;
  package: ShipStationPackageInput;
  pendingRequest?: PendingShipStationRateRequest;
  shipmentId: string;
}): Promise<Pick<GetFulfillmentShipStationRatesResponse, 'invalidRates' | 'rates'>> {
  const options = { fetch: args.common.providerFetch, signal: args.common.signal };
  let response: ShipStationRateResponse = args.pendingRequest
    ? await getShipStationShipmentRates(args.apiKey, args.shipmentId, args.pendingRequest, options)
    : await requestShipStationShipmentRates(args.apiKey, args.shipmentId, options);
  let expectedRequest = args.pendingRequest;
  if (!expectedRequest && response.status === 'working') {
    if (!response.rateRequestId) {
      throw new ShipStationRatesProviderError('internal', 'ShipStation did not identify the pending rate request.');
    }
    expectedRequest = {
      requestId: response.rateRequestId,
      ...(response.createdAt ? { createdAt: response.createdAt } : {}),
    };
    await persistPendingShipStationRateRequest({
      common: args.common,
      deliveryId: args.deliveryId,
      dropId: args.dropId,
      expected: args.expected,
      inputHash: args.inputHash,
      package: args.package,
      request: expectedRequest,
      shipmentId: args.shipmentId,
    });
  }
  for (const delayMs of [400, 800, 1200]) {
    if (response.status !== 'working') break;
    if (!expectedRequest) {
      throw new ShipStationRatesProviderError('internal', 'ShipStation did not identify the pending rate request.');
    }
    await args.common.pauseForRatePoll(args.common.signal, delayMs);
    response = await getShipStationShipmentRates(args.apiKey, args.shipmentId, expectedRequest, options);
  }
  if (response.status === 'working') {
    throw new ShipStationRatesProviderError('unavailable', 'ShipStation is still calculating rates. Try again in a moment.');
  }
  return {
    rates: response.rates.filter((rate) => rate.shipmentId === args.shipmentId),
    invalidRates: response.invalidRates,
  };
}

async function releaseShipStationRatesClaim(args: {
  claimId: string;
  common: CommerceWriteCommon;
  deliveryId: number;
  dropId: string;
  shipmentId: string;
  wallet: string;
}): Promise<void> {
  return mutateDeliveryOrder<void>({
    common: args.common,
    deliveryId: args.deliveryId,
    dropId: args.dropId,
    build: ({ fields: order }) => {
      const shipstation = shipStationState(order);
      if (optionalString(shipstation.shipmentId) !== args.shipmentId) return { value: undefined };
      const currentClaimId = optionalString(shipstation.ratesClaimId);
      if (currentClaimId && (
        currentClaimId !== args.claimId || optionalString(shipstation.ratesClaimedBy) !== args.wallet
      )) {
        return { value: undefined };
      }
      if (!currentClaimId && optionalString(shipstation.ratesClaimFenceId) === args.claimId) {
        return { value: undefined };
      }
      const updates: Record<string, CommerceUpdateValue> = currentClaimId
        ? {
            'shipstation.ratesClaimId': commerceFieldValue.delete(),
            'shipstation.ratesClaimedAt': commerceFieldValue.delete(),
            'shipstation.ratesClaimedBy': commerceFieldValue.delete(),
            'shipstation.ratesClaimFenceId': commerceFieldValue.delete(),
          }
        : { 'shipstation.ratesClaimFenceId': args.claimId };
      return {
        value: undefined,
        updates,
      };
    },
  });
}

async function safelyReleaseShipStationRatesClaim(args: {
  claimId: string;
  common: CommerceWriteCommon;
  deliveryId: number;
  dropId: string;
  shipmentId: string;
  wallet: string;
}): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new DOMException('Claim cleanup timed out', 'TimeoutError')),
    3_000,
  );
  try {
    await releaseShipStationRatesClaim({
      ...args,
      common: { ...args.common, signal: controller.signal },
    });
  } catch (error) {
    console.error(JSON.stringify({
      event: 'fulfillment_shipstation_rates_claim_release_failed',
      dropId: args.dropId,
      deliveryId: args.deliveryId,
      error: error instanceof Error ? error.message : String(error),
    }));
  } finally {
    clearTimeout(timeout);
  }
}

async function getFulfillmentShipStationRates(
  body: z.infer<typeof shipStationRatesSchema>,
  wallet: string,
  common: CommerceWriteCommon,
  env: ProfileWriteEnv,
): Promise<GetFulfillmentShipStationRatesResponse> {
  const dropId = supportedDropId(body.dropId);
  requireFulfillmentAccess(wallet, dropId);
  const packageOverride = body.package ? normalizeShipStationPackage(body.package) : null;
  if (body.package && !packageOverride) {
    throw new ProfileReadError('invalid-argument', 400, SHIPSTATION_PACKAGE_RANGE_MESSAGE);
  }
  const apiKey = typeof env.SHIPSTATION_API_KEY === 'string' ? env.SHIPSTATION_API_KEY.trim() : '';
  if (!apiKey) throw new ShipStationProfileError('failed-precondition', 409, 'ShipStation API key is not configured');
  const shipFromSecret = typeof env.SHIPSTATION_SHIP_FROM === 'string' ? env.SHIPSTATION_SHIP_FROM.trim() : '';
  const claimId = crypto.randomUUID();
  let shipmentId = '';
  let claimWriteAttempted = false;
  try {
    const shipFrom = parseShipStationShipFrom(shipFromSecret);
    const initial = await loadDeliveryOrderDocument(common, dropId, body.deliveryId);
    let order = initial.fields;
    rejectIrlShipStationOrder(order);
    shipmentId = requireShipStationShipmentId(order);
    const reconciled = await reconcileFulfillmentShipStationLabel({
      apiKey,
      common,
      deliveryId: body.deliveryId,
      dropId,
      order,
      refreshInactiveStoredLabel: false,
      shipmentId,
      wallet,
    });
    if (reconciled.active) {
      return {
        deliveryId: body.deliveryId,
        shipmentId,
        ...(orderShipStationPackage(order) ? { package: orderShipStationPackage(order) } : {}),
        packageCount: orderShipStationPackageCount(order),
        rates: [],
        invalidRates: [],
        label: reconciled.active,
        ...(reconciled.downloadUrl ? { labelDownloadUrl: reconciled.downloadUrl } : {}),
      };
    }
    order = (await loadDeliveryOrderDocument(common, dropId, body.deliveryId)).fields;
    if (requireShipStationShipmentId(order) !== shipmentId) {
      throw new ProfileReadError('aborted', 409, 'The ShipStation shipment changed. Refresh the order and try again.');
    }
    const purchase = shipStationState(order).labelPurchase;
    const purchaseStatus = isRecord(purchase) ? optionalString(purchase.status) : undefined;
    if (purchaseStatus === 'purchasing' || purchaseStatus === 'unknown') {
      return {
        deliveryId: body.deliveryId,
        shipmentId,
        ...(orderShipStationPackage(order) ? { package: orderShipStationPackage(order) } : {}),
        packageCount: orderShipStationPackageCount(order),
        rates: [],
        invalidRates: [],
        purchaseUnknown: true,
      };
    }
    const initialExpectation = rateMutationExpectation(order, shipmentId);
    const claimedOrder = await mutateDeliveryOrder<Record<string, unknown>>({
      common,
      deliveryId: body.deliveryId,
      dropId,
      build: ({ fields: currentOrder }) => {
        const currentShipstation = requireRateMutationState(currentOrder, initialExpectation);
        const currentPurchase = isRecord(currentShipstation.labelPurchase) ? currentShipstation.labelPurchase : {};
        const currentPurchaseStatus = optionalString(currentPurchase.status);
        if (currentPurchaseStatus === 'purchasing' || currentPurchaseStatus === 'unknown') {
          throw new ProfileReadError('aborted', 409, 'A label purchase may already be in progress. Check purchase status first.');
        }
        if (isActiveShipStationLabel(storedFulfillmentShipStationLabel(currentShipstation.label))) {
          throw new ProfileReadError('failed-precondition', 409, 'This shipment already has a label.');
        }
        const claimedAt = typeof currentShipstation.ratesClaimedAt === 'number'
          ? currentShipstation.ratesClaimedAt
          : 0;
        if (claimedAt && common.nowMs - claimedAt < SHIPSTATION_CLAIM_TTL_MS) {
          throw new ProfileReadError('aborted', 409, 'Rates are already being refreshed for this shipment. Try again in a moment.');
        }
        claimWriteAttempted = true;
        return {
          value: currentOrder,
          updates: {
            'shipstation.rateQuotes': commerceFieldValue.delete(),
            'shipstation.ratesClaimId': claimId,
            'shipstation.ratesClaimedBy': wallet,
            'shipstation.ratesClaimFenceId': commerceFieldValue.delete(),
            'shipstation.ratesClaimedAt': commerceFieldValue.serverTimestamp(),
          },
        };
      },
    });
    const claimedExpectation = rateMutationExpectation(claimedOrder, shipmentId, { claimId, wallet });
    const shipment = await getShipStationShipmentById(apiKey, shipmentId, {
      fetch: common.providerFetch,
      signal: common.signal,
    });
    const currentPackageDetails = shipStationPackageDetails(shipment);
    if (currentPackageDetails.packageCount !== 1) {
      await persistUnsupportedShipStationPackageCount({
        common,
        deliveryId: body.deliveryId,
        dropId,
        expected: claimedExpectation,
        packageCount: currentPackageDetails.packageCount,
      });
      return {
        deliveryId: body.deliveryId,
        shipmentId,
        packageCount: currentPackageDetails.packageCount,
        rates: [],
        invalidRates: [],
      };
    }
    const storedOrderPackage = orderShipStationPackage(claimedOrder);
    const resolvedPackage = packageOverride ?? currentPackageDetails.package ?? storedOrderPackage;
    if (!resolvedPackage) {
      throw new ProfileReadError(
        'failed-precondition',
        409,
        'ShipStation package measurements are unavailable for this shipment.',
      );
    }
    const sourcePackage = shipment.packages[0];
    const international = shipFrom.country_code !== shipment.ship_to.country_code;
    let customs: ShipStationCustoms | undefined;
    let products: ShipStationPackageProduct[] | undefined;
    let contentDescription: string | undefined;
    let repairedShipment = Boolean(!packageOverride && !currentPackageDetails.package && storedOrderPackage);
    if (international) {
      const currentProducts = shipStationPackageProducts(sourcePackage);
      const currentContentDescription = shipStationPackageContentDescription(sourcePackage);
      const declaration = !shipment.customs || !currentProducts || !currentContentDescription
        ? requireShipStationCustomsDeclaration(dropId, claimedOrder)
        : undefined;
      customs = shipment.customs ?? {
        contents: 'merchandise',
        non_delivery: 'return_to_sender',
        terms_of_trade_code: 'dap',
      };
      products = currentProducts ?? [declaration!.product];
      contentDescription = currentContentDescription ?? declaration!.contentDescription;
      repairedShipment ||= !shipment.customs || !currentProducts || !currentContentDescription;
      requireShipStationPackageWeight(resolvedPackage, shipStationProductsTotalWeightOunces(products));
    }
    const rateInput = {
      ship_to: shipment.ship_to,
      ship_from: shipFrom,
      packages: buildShipStationPackages(1, resolvedPackage, {
        sourcePackage,
        ...(products ? { products } : {}),
        ...(contentDescription ? { contentDescription } : {}),
      }),
      ...(customs ? { customs } : {}),
    };
    const inputHash = await shipStationRateInputHash(rateInput);
    const updatedShipment = await updateShipStationShipment(
      apiKey,
      shipmentId,
      rateInput,
      { fetch: common.providerFetch, signal: common.signal },
    );
    const updatedPackageDetails = shipStationPackageDetails(updatedShipment);
    if (updatedPackageDetails.packageCount !== 1) {
      await persistUnsupportedShipStationPackageCount({
        common,
        deliveryId: body.deliveryId,
        dropId,
        expected: claimedExpectation,
        packageCount: updatedPackageDetails.packageCount,
      });
      return {
        deliveryId: body.deliveryId,
        shipmentId,
        packageCount: updatedPackageDetails.packageCount,
        rates: [],
        invalidRates: [],
      };
    }
    const storedPackage = packageOverride ?? updatedPackageDetails.package ?? resolvedPackage;
    await mutateDeliveryOrder<void>({
      common,
      deliveryId: body.deliveryId,
      dropId,
      build: ({ fields: currentOrder }) => {
        requireRateMutationState(currentOrder, claimedExpectation);
        return {
          value: undefined,
          updates: {
            'shipstation.package': commercePackage(storedPackage),
            'shipstation.packageCount': 1,
          },
        };
      },
    });
    const adoptedAfterUpdate = await reconcileFulfillmentShipStationLabel({
      apiKey,
      common,
      deliveryId: body.deliveryId,
      dropId,
      expectedRateMutation: claimedExpectation,
      order: claimedOrder,
      refreshInactiveStoredLabel: false,
      shipmentId,
      wallet,
    });
    if (adoptedAfterUpdate.active) {
      return {
        deliveryId: body.deliveryId,
        shipmentId,
        package: storedPackage,
        packageCount: 1,
        rates: [],
        invalidRates: [],
        label: adoptedAfterUpdate.active,
        ...(adoptedAfterUpdate.downloadUrl ? { labelDownloadUrl: adoptedAfterUpdate.downloadUrl } : {}),
      };
    }
    const pendingRateRequest = repairedShipment
      ? undefined
      : storedPendingShipStationRateRequest(
          shipStationState(claimedOrder).rateRequest,
          shipmentId,
          storedPackage,
          inputHash,
          common.nowMs,
        );
    const rateResponse = await getCompletedShipStationRates({
      apiKey,
      common,
      deliveryId: body.deliveryId,
      dropId,
      expected: claimedExpectation,
      inputHash,
      package: storedPackage,
      ...(pendingRateRequest ? { pendingRequest: pendingRateRequest } : {}),
      shipmentId,
    });
    await mutateDeliveryOrder<void>({
      common,
      deliveryId: body.deliveryId,
      dropId,
      build: ({ fields: currentOrder }) => {
        requireRateMutationState(currentOrder, claimedExpectation);
        if (isActiveShipStationLabel(storedFulfillmentShipStationLabel(shipStationState(currentOrder).label))) {
          throw new ProfileReadError('failed-precondition', 409, 'This shipment already has a label.');
        }
        return {
          value: undefined,
          updates: {
            'shipstation.package': commercePackage(storedPackage),
            'shipstation.packageCount': 1,
            'shipstation.rateQuotes': commerceRateQuotes(rateResponse.rates),
            'shipstation.rateRequest': commerceFieldValue.delete(),
            'shipstation.ratesUpdatedBy': wallet,
            'shipstation.ratesClaimId': commerceFieldValue.delete(),
            'shipstation.ratesClaimedAt': commerceFieldValue.delete(),
            'shipstation.ratesClaimedBy': commerceFieldValue.delete(),
            'shipstation.ratesUpdatedAt': commerceFieldValue.serverTimestamp(),
          },
        };
      },
    });
    return {
      deliveryId: body.deliveryId,
      shipmentId,
      package: storedPackage,
      packageCount: 1,
      rates: rateResponse.rates,
      invalidRates: rateResponse.invalidRates,
    };
  } catch (error) {
    if (claimWriteAttempted && shipmentId) {
      await safelyReleaseShipStationRatesClaim({
        claimId,
        common,
        deliveryId: body.deliveryId,
        dropId,
        shipmentId,
        wallet,
      });
    }
    if (error instanceof ShipStationRatesProviderError) throw profileErrorForShipStation(error);
    throw error;
  }
}

export const shipStationRateOperations = [
  defineProfileWriteOperation({
    path: FULFILLMENT_SHIPSTATION_RATES_PATH,
    schema: shipStationRatesSchema,
    maxBytes: MAX_SHIPSTATION_RATES_REQUEST_BYTES,
    timeoutMs: SHIPSTATION_RATES_OPERATION_TIMEOUT_MS,
    handler: (body, { wallet, common, env }) => getFulfillmentShipStationRates(body, wallet, common, env),
  }),
];
