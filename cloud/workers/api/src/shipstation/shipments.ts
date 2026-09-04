import { z } from 'zod';
import {
  buildShipStationPackages,
  createShipStationShipment,
  getShipStationShipmentByExternalId,
  parseShipStationShipFrom,
  parseShipStationShipTo,
  shipStationExternalId,
  shipStationPackageDetails,
  ShipStationRatesProviderError,
  type ShipStationAddress,
} from '../../../../../shared/shipstationRates.js';
import {
  defaultShipStationPackage,
  normalizeShipStationPackage,
  SHIPSTATION_PACKAGE_RANGE_MESSAGE,
  type ShipStationPackageInput,
} from '../../../../../shared/shipstationPackage.js';
import type {
  AddFulfillmentOrderToShipStationResponse,
  ShipStationAddressPatch,
} from '../../../../../shared/contracts.js';
import { isSignalCancellationError } from '../boundedRequest.js';
import {
  isRecord,
  ProfileReadError,
} from '../dataAccess.js';
import {
  commerceFieldValue,
  type CommerceUpdateValue,
} from '../commerceRepository.js';
import {
  mutateDeliveryOrder,
  type CommerceWriteCommon,
} from '../profileWriteCommerce.js';
import {
  commercePackage,
  optionalString,
} from '../profileWriteRates.js';
import {
  shipStationRatesSchema,
  rejectIrlShipStationOrder,
  shipStationState,
  SHIPSTATION_CLAIM_TTL_MS,
  supportedDropId,
  requireFulfillmentAccess,
  ShipStationProfileError,
  profileErrorForShipStation,
  decryptFulfillmentAddress,
  fulfillmentShipmentUnitCount,
  requireShipStationCustomsDeclaration,
  requireShipStationPackageWeight,
  clientCancellationReason,
} from './common.js';
import {
  type ProfileWriteOperationContext,
  type ProfileWriteEnv,
  defineProfileWriteOperation,
} from '../profileWriteOperation.js';

const FULFILLMENT_SHIPSTATION_SHIPMENT_PATH = '/fulfillment/shipstation-shipment';
const SHIPSTATION_SHIPMENT_OPERATION_TIMEOUT_MS = 55_000;
const MAX_SHIPSTATION_SHIPMENT_REQUEST_BYTES = 2048;
const shipStationAddressPatchSchema = z.object({
  name: z.string().trim().min(1).max(50).optional(),
  address_line1: z.string().trim().min(1).max(50).optional(),
  address_line2: z.string().trim().max(50).optional(),
  address_line3: z.string().trim().max(50).optional(),
  city_locality: z.string().trim().min(1).max(50).optional(),
  state_province: z.string().trim().min(1).max(50).optional(),
  postal_code: z.string().trim().min(1).max(50).optional(),
  country_code: z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/).optional(),
}).strict().refine((value) => Object.keys(value).length > 0);

const shipStationShipmentSchema = shipStationRatesSchema.extend({
  addressPatch: shipStationAddressPatchSchema.optional(),
}).strict();

type ShipStationShipmentClaim =
  | { alreadyAdded: true; shipmentId: string; addedAt?: number }
  | { alreadyAdded: false; claimId: string; order: Record<string, unknown> };

async function claimFulfillmentShipStationShipment(args: {
  claimId: string;
  common: CommerceWriteCommon;
  deliveryId: number;
  dropId: string;
  onWriteAttempt: () => void;
  wallet: string;
}): Promise<ShipStationShipmentClaim> {
  return mutateDeliveryOrder<ShipStationShipmentClaim>({
    common: args.common,
    deliveryId: args.deliveryId,
    dropId: args.dropId,
    build: ({ fields: order }) => {
      rejectIrlShipStationOrder(order);
      const shipstation = shipStationState(order);
      const shipmentId = optionalString(shipstation.shipmentId);
      if (shipmentId) {
        const addedAt = typeof shipstation.createdAt === 'number' ? shipstation.createdAt : undefined;
        return { value: { alreadyAdded: true, shipmentId, ...(addedAt ? { addedAt } : {}) } };
      }
      const claimedAt = typeof shipstation.claimedAt === 'number' ? shipstation.claimedAt : 0;
      if (claimedAt && args.common.nowMs - claimedAt < SHIPSTATION_CLAIM_TTL_MS) {
        throw new ProfileReadError(
          'aborted',
          409,
          'This order is already being added to ShipStation. Try again in a moment.',
        );
      }
      args.onWriteAttempt();
      return {
        value: { alreadyAdded: false, claimId: args.claimId, order },
        updates: {
          dropId: args.dropId,
          'shipstation.claimId': args.claimId,
          'shipstation.claimedBy': args.wallet,
          'shipstation.claimFenceId': commerceFieldValue.delete(),
          'shipstation.claimedAt': commerceFieldValue.serverTimestamp(),
        },
      };
    },
  });
}

function shipStationShipmentFailureMessage(error: unknown): string {
  if (error instanceof ShipStationRatesProviderError || error instanceof ProfileReadError) {
    return error.message.slice(0, 500);
  }
  return 'Failed to add the order to ShipStation';
}

async function transitionFulfillmentShipStationShipmentClaim(args: {
  claimId: string;
  common: CommerceWriteCommon;
  deliveryId: number;
  dropId: string;
  errorMessage: string;
  retain: boolean;
  wallet: string;
}): Promise<void> {
  await mutateDeliveryOrder<void>({
    common: args.common,
    deliveryId: args.deliveryId,
    dropId: args.dropId,
    build: ({ fields: order }) => {
      const shipstation = shipStationState(order);
      const currentClaimId = optionalString(shipstation.claimId);
      const currentClaimedBy = optionalString(shipstation.claimedBy);
      if (currentClaimId !== args.claimId || currentClaimedBy !== args.wallet) return { value: undefined };
      const updates: Record<string, CommerceUpdateValue> = args.retain
        ? {
            'shipstation.claimId': args.claimId,
            'shipstation.claimedBy': args.wallet,
            'shipstation.claimFenceId': commerceFieldValue.delete(),
            'shipstation.lastError': args.errorMessage,
            'shipstation.claimedAt': commerceFieldValue.serverTimestamp(),
          }
        : {
            'shipstation.claimId': commerceFieldValue.delete(),
            'shipstation.claimedAt': commerceFieldValue.delete(),
            'shipstation.claimedBy': commerceFieldValue.delete(),
            'shipstation.claimFenceId': args.claimId,
            'shipstation.lastError': args.errorMessage,
          };
      return {
        value: undefined,
        updates: { ...updates, 'shipstation.lastErrorAt': commerceFieldValue.serverTimestamp() },
      };
    },
  });
}

async function safelyTransitionFulfillmentShipStationShipmentClaim(args: {
  claimId: string;
  common: CommerceWriteCommon;
  deliveryId: number;
  dropId: string;
  errorMessage: string;
  retain: boolean;
  wallet: string;
}): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new DOMException('Claim cleanup timed out', 'TimeoutError')),
    3_000,
  );
  try {
    await transitionFulfillmentShipStationShipmentClaim({
      ...args,
      common: { ...args.common, signal: controller.signal },
    });
  } catch (error) {
    console.error(JSON.stringify({
      event: 'fulfillment_shipstation_shipment_claim_transition_failed',
      dropId: args.dropId,
      deliveryId: args.deliveryId,
      retain: args.retain,
      error: error instanceof Error ? error.message : String(error),
    }));
  } finally {
    clearTimeout(timeout);
  }
}

async function persistFulfillmentShipStationShipment(args: {
  claimId: string;
  common: CommerceWriteCommon;
  deliveryId: number;
  dropId: string;
  externalShipmentId: string;
  packageCount: number;
  shipmentId: string;
  storedPackage?: ShipStationPackageInput;
  wallet: string;
}): Promise<void> {
  await mutateDeliveryOrder<void>({
    common: args.common,
    deliveryId: args.deliveryId,
    dropId: args.dropId,
    build: ({ fields: order }) => {
      const shipstation = shipStationState(order);
      if (
        optionalString(shipstation.claimId) !== args.claimId ||
        optionalString(shipstation.claimedBy) !== args.wallet
      ) {
        throw new ProfileReadError('aborted', 409, 'The ShipStation shipment claim changed. Try again.');
      }
      const currentShipmentId = optionalString(shipstation.shipmentId);
      if (currentShipmentId && currentShipmentId !== args.shipmentId) {
        throw new ProfileReadError('aborted', 409, 'The ShipStation shipment changed. Refresh the order and try again.');
      }
      return {
        value: undefined,
        updates: {
          dropId: args.dropId,
          'shipstation.shipmentId': args.shipmentId,
          'shipstation.externalShipmentId': args.externalShipmentId,
          'shipstation.shipmentNumber': String(args.deliveryId),
          'shipstation.createdBy': args.wallet,
          ...(args.storedPackage ? { 'shipstation.package': commercePackage(args.storedPackage) } : {}),
          'shipstation.packageCount': args.packageCount,
          'shipstation.claimId': commerceFieldValue.delete(),
          'shipstation.claimedAt': commerceFieldValue.delete(),
          'shipstation.claimedBy': commerceFieldValue.delete(),
          'shipstation.claimFenceId': commerceFieldValue.delete(),
          'shipstation.lastError': commerceFieldValue.delete(),
          'shipstation.lastErrorAt': commerceFieldValue.delete(),
          'shipstation.createdAt': commerceFieldValue.serverTimestamp(),
        },
      };
    },
  });
}

function applyShipStationAddressPatch(
  address: ShipStationAddress,
  patch?: ShipStationAddressPatch,
): ShipStationAddress {
  if (!patch) return address;
  const next = { ...address };
  if (patch.name !== undefined) next.name = patch.name;
  if (patch.address_line1 !== undefined) next.address_line1 = patch.address_line1;
  if (patch.address_line2 !== undefined) {
    if (patch.address_line2) next.address_line2 = patch.address_line2;
    else delete next.address_line2;
  }
  if (patch.address_line3 !== undefined) {
    if (patch.address_line3) next.address_line3 = patch.address_line3;
    else delete next.address_line3;
  }
  if (patch.city_locality !== undefined) next.city_locality = patch.city_locality;
  if (patch.state_province !== undefined) next.state_province = patch.state_province;
  if (patch.postal_code !== undefined) next.postal_code = patch.postal_code;
  if (patch.country_code !== undefined) next.country_code = patch.country_code;
  return next;
}

async function addFulfillmentOrderToShipStation(
  body: z.infer<typeof shipStationShipmentSchema>,
  wallet: string,
  common: ProfileWriteOperationContext,
  env: ProfileWriteEnv,
): Promise<AddFulfillmentOrderToShipStationResponse> {
  const dropId = supportedDropId(body.dropId);
  requireFulfillmentAccess(wallet, dropId);
  const packageOverride = body.package ? normalizeShipStationPackage(body.package) : null;
  if (body.package && !packageOverride) {
    throw new ProfileReadError('invalid-argument', 400, SHIPSTATION_PACKAGE_RANGE_MESSAGE);
  }
  const apiKey = typeof env.SHIPSTATION_API_KEY === 'string' ? env.SHIPSTATION_API_KEY.trim() : '';
  if (!apiKey) throw new ShipStationProfileError('failed-precondition', 409, 'ShipStation API key is not configured');
  const shipFromSecret = typeof env.SHIPSTATION_SHIP_FROM === 'string' ? env.SHIPSTATION_SHIP_FROM.trim() : '';
  let shipFrom: ReturnType<typeof parseShipStationShipFrom>;
  try {
    shipFrom = parseShipStationShipFrom(shipFromSecret);
  } catch (error) {
    if (error instanceof ShipStationRatesProviderError) throw profileErrorForShipStation(error);
    throw error;
  }
  const addressSecret = typeof env.ADDRESS_DECRYPTION_SECRET === 'string' ? env.ADDRESS_DECRYPTION_SECRET : '';
  const claimId = crypto.randomUUID();
  let claimWriteAttempted = false;
  let postAttempted = false;
  let shipmentCreated = false;
  try {
    const claim = await claimFulfillmentShipStationShipment({
      claimId,
      common,
      deliveryId: body.deliveryId,
      dropId,
      onWriteAttempt: () => { claimWriteAttempted = true; },
      wallet,
    });
    if (claim.alreadyAdded) {
      return {
        deliveryId: body.deliveryId,
        shipmentId: claim.shipmentId,
        alreadyAdded: true,
        ...(claim.addedAt ? { shipstationAddedAt: claim.addedAt } : {}),
      };
    }
    const externalShipmentId = shipStationExternalId(dropId, body.deliveryId);
    const existing = await getShipStationShipmentByExternalId(apiKey, externalShipmentId, {
      fetch: common.providerFetch,
      signal: common.signal,
    });
    let shipment = existing;
    let appliedPackage = existing ? shipStationPackageDetails(existing).package : undefined;
    if (!shipment) {
      const addressSnapshot = isRecord(claim.order.addressSnapshot) ? claim.order.addressSnapshot : {};
      const encrypted = optionalString(addressSnapshot.encrypted) ?? '';
      const full = encrypted ? decryptFulfillmentAddress(encrypted, addressSecret) : null;
      const parsed = parseShipStationShipTo(
        full,
        typeof addressSnapshot.countryCode === 'string' ? addressSnapshot.countryCode : undefined,
      );
      if (!parsed.ok || !parsed.shipTo) {
        const reason = parsed.reason || 'Could not read the delivery address';
        throw new ProfileReadError('failed-precondition', 409, `${reason}. Edit the delivery address and try again.`);
      }
      const unitCount = fulfillmentShipmentUnitCount(claim.order);
      const email = optionalString(addressSnapshot.email);
      const phone = optionalString(addressSnapshot.phone);
      const shipTo = applyShipStationAddressPatch({
        ...parsed.shipTo,
        ...(email ? { email } : {}),
        ...(phone ? { phone } : {}),
      }, body.addressPatch);
      const international = shipFrom.country_code !== shipTo.country_code;
      const customsDeclaration = international
        ? requireShipStationCustomsDeclaration(dropId, claim.order)
        : undefined;
      const defaultPackage = defaultShipStationPackage(unitCount);
      appliedPackage = packageOverride ?? (
        customsDeclaration && defaultPackage.weight < customsDeclaration.minimumPackageWeightOunces
          ? { ...defaultPackage, weight: customsDeclaration.minimumPackageWeightOunces }
          : defaultPackage
      );
      if (customsDeclaration) {
        requireShipStationPackageWeight(appliedPackage, customsDeclaration.totalNetWeightOunces);
      }
      postAttempted = true;
      shipment = await createShipStationShipment(apiKey, {
        external_shipment_id: externalShipmentId,
        shipment_number: String(body.deliveryId),
        ship_to: shipTo,
        ship_from: shipFrom,
        packages: buildShipStationPackages(unitCount, appliedPackage, customsDeclaration ? {
          contentDescription: customsDeclaration.contentDescription,
          products: [customsDeclaration.product],
        } : {}),
        ...(customsDeclaration ? {
          customs: {
            contents: 'merchandise',
            non_delivery: 'return_to_sender',
            terms_of_trade_code: 'dap',
          },
        } : {}),
      }, {
        fetch: common.providerFetch,
        signal: common.signal,
      });
      shipmentCreated = true;
    }
    const shipmentId = optionalString(shipment.shipment_id);
    if (!shipmentId) throw new ShipStationRatesProviderError('internal', 'ShipStation did not return a shipment id');
    const packageDetails = shipStationPackageDetails(shipment);
    const storedPackage = appliedPackage ?? packageDetails.package;
    await persistFulfillmentShipStationShipment({
      claimId,
      common,
      deliveryId: body.deliveryId,
      dropId,
      externalShipmentId,
      packageCount: packageDetails.packageCount || 1,
      shipmentId,
      ...(storedPackage ? { storedPackage } : {}),
      wallet,
    });
    return {
      deliveryId: body.deliveryId,
      shipmentId,
      alreadyAdded: Boolean(existing),
      shipstationAddedAt: common.nowMs,
    };
  } catch (error) {
    const signalCancelled = isSignalCancellationError(common.signal, error);
    const clientCancellation = clientCancellationReason(error, common);
    const failureCode = error instanceof ShipStationRatesProviderError || error instanceof ProfileReadError
      ? error.code
      : 'internal';
    const mayHaveCreated = shipmentCreated || (postAttempted && (
      failureCode === 'deadline-exceeded' ||
      failureCode === 'unavailable' ||
      failureCode === 'internal'
    ));
    if (claimWriteAttempted) {
      await safelyTransitionFulfillmentShipStationShipmentClaim({
        claimId,
        common,
        deliveryId: body.deliveryId,
        dropId,
        errorMessage: shipStationShipmentFailureMessage(error),
        retain: mayHaveCreated,
        wallet,
      });
    }
    if (clientCancellation !== undefined) throw clientCancellation;
    if (signalCancelled && !mayHaveCreated) throw common.signal.reason;
    if (mayHaveCreated) {
      throw new ShipStationProfileError(
        'aborted',
        409,
        'ShipStation did not confirm the shipment. It may still have been created — check ShipStation, or try again in a couple of minutes.',
      );
    }
    if (error instanceof ShipStationRatesProviderError) throw profileErrorForShipStation(error);
    throw error;
  }
}

export const shipStationShipmentOperations = [
  defineProfileWriteOperation({
    path: FULFILLMENT_SHIPSTATION_SHIPMENT_PATH,
    schema: shipStationShipmentSchema,
    maxBytes: MAX_SHIPSTATION_SHIPMENT_REQUEST_BYTES,
    timeoutMs: SHIPSTATION_SHIPMENT_OPERATION_TIMEOUT_MS,
    handler: (body, { wallet, common, env }) => addFulfillmentOrderToShipStation(body, wallet, common, env),
  }),
];
