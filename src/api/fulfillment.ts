import type {
  AddFulfillmentOrderToShipStationRequest,
  AddFulfillmentOrderToShipStationResponse,
  FulfillmentManualReviewCheckout,
  FulfillmentOrder,
  FulfillmentOrdersCursor,
  FulfillmentShipStationAddressCorrectionDetails,
  FulfillmentStatus,
  GetFulfillmentShipStationLabelRequest,
  GetFulfillmentShipStationLabelResponse,
  GetFulfillmentShipStationRatesRequest,
  GetFulfillmentShipStationRatesResponse,
  PurchaseFulfillmentShipStationLabelRequest,
  PurchaseFulfillmentShipStationLabelResponse,
  ShipStationAddressPatch,
  ShipStationEditableAddressField,
  ShipStationPackageInput,
  UpdateFulfillmentAddressRequest,
  UpdateFulfillmentAddressResponse,
  VoidFulfillmentShipStationLabelRequest,
  VoidFulfillmentShipStationLabelResponse,
} from '../types';
import { SHIPSTATION_EDITABLE_ADDRESS_FIELDS } from '../types';
import { parseShipStationPackage } from '../../shared/shipstationPackage.ts';
import {
  callProfileApi as defaultCallProfileApi,
  ProfileApiError,
  type AuthenticatedApiCall,
} from './transport';
import { hasExactKeys, hasExactRequiredAndOptionalKeys, isRecord } from './validation';

export function parseFulfillmentShipStationAddressCorrectionDetails(
  value: unknown,
): FulfillmentShipStationAddressCorrectionDetails | null {
  if (!isRecord(value) || !hasExactKeys(value, ['kind', 'fields'])) return null;
  if (value.kind !== 'shipstation-address-correction' || !Array.isArray(value.fields) || !value.fields.length) {
    return null;
  }
  const supported = new Set<string>(SHIPSTATION_EDITABLE_ADDRESS_FIELDS);
  if (!value.fields.every((field) => typeof field === 'string' && supported.has(field))) return null;
  const fields = value.fields as ShipStationEditableAddressField[];
  if (new Set(fields).size !== fields.length) return null;
  const canonical = SHIPSTATION_EDITABLE_ADDRESS_FIELDS.filter((field) => fields.includes(field));
  if (canonical.some((field, index) => fields[index] !== field)) return null;
  return { kind: 'shipstation-address-correction', fields: [...fields] };
}

export function fulfillmentShipStationAddressCorrectionDetails(
  error: unknown,
): FulfillmentShipStationAddressCorrectionDetails | null {
  if (!(error instanceof ProfileApiError) || error.code !== 'failed-precondition') return null;
  return parseFulfillmentShipStationAddressCorrectionDetails(error.details);
}
export function parseFulfillmentStatusUpdate(value: unknown): {
  buyerOrderShippedEmailState?: 'pending' | 'queued';
  deliveryId: number;
  fulfillmentStatus: FulfillmentStatus | '';
  fulfillmentTrackingCode?: string;
} | null {
  if (!isRecord(value)) return null;
  if (!hasExactRequiredAndOptionalKeys(
    value,
    ['deliveryId', 'fulfillmentStatus'],
    ['buyerOrderShippedEmailState', 'fulfillmentTrackingCode'],
  )) return null;
  if (!Number.isSafeInteger(value.deliveryId) || Number(value.deliveryId) <= 0) return null;
  if (value.fulfillmentStatus !== '' && value.fulfillmentStatus !== 'Preparing' && value.fulfillmentStatus !== 'Shipped') return null;
  if (
    value.fulfillmentTrackingCode !== undefined &&
    (
      typeof value.fulfillmentTrackingCode !== 'string' ||
      !value.fulfillmentTrackingCode ||
      value.fulfillmentTrackingCode.trim() !== value.fulfillmentTrackingCode
    )
  ) return null;
  if (
    value.buyerOrderShippedEmailState !== undefined &&
    value.buyerOrderShippedEmailState !== 'pending' &&
    value.buyerOrderShippedEmailState !== 'queued'
  ) return null;
  return {
    ...(value.buyerOrderShippedEmailState === 'pending' || value.buyerOrderShippedEmailState === 'queued'
      ? { buyerOrderShippedEmailState: value.buyerOrderShippedEmailState }
      : {}),
    deliveryId: Number(value.deliveryId),
    fulfillmentStatus: value.fulfillmentStatus,
    ...(typeof value.fulfillmentTrackingCode === 'string'
      ? { fulfillmentTrackingCode: value.fulfillmentTrackingCode }
      : {}),
  };
}

const MAX_ENCRYPTED_FULFILLMENT_ADDRESS_LENGTH = 12 * 1024;

export function parseUpdateFulfillmentAddress(value: unknown): UpdateFulfillmentAddressResponse | null {
  if (!isRecord(value) || !hasExactKeys(value, ['deliveryId', 'address'])) return null;
  if (!Number.isSafeInteger(value.deliveryId) || Number(value.deliveryId) <= 0 || !isRecord(value.address)) return null;
  const address = value.address;
  const required = ['full', 'encrypted', 'hint'] as const;
  const optional = ['label', 'email', 'phone', 'country', 'countryCode'] as const;
  const allowed = new Set<string>([...required, ...optional]);
  if (!required.every((key) => Object.hasOwn(address, key))) return null;
  if (!Object.keys(address).every((key) => allowed.has(key))) return null;
  if (
    typeof address.full !== 'string' || !address.full || address.full.length > 2048 ||
    typeof address.encrypted !== 'string' || !address.encrypted ||
    address.encrypted.length > MAX_ENCRYPTED_FULFILLMENT_ADDRESS_LENGTH ||
    typeof address.hint !== 'string' || address.hint.length > 256 ||
    optional.some((key) => address[key] !== undefined && typeof address[key] !== 'string')
  ) return null;
  return {
    deliveryId: Number(value.deliveryId),
    address: {
      full: address.full,
      encrypted: address.encrypted,
      hint: address.hint,
      ...(typeof address.label === 'string' ? { label: address.label } : {}),
      ...(typeof address.email === 'string' ? { email: address.email } : {}),
      ...(typeof address.phone === 'string' ? { phone: address.phone } : {}),
      ...(typeof address.country === 'string' ? { country: address.country } : {}),
      ...(typeof address.countryCode === 'string' ? { countryCode: address.countryCode } : {}),
    },
  };
}

function parseShipStationMoney(value: unknown): { currency: string; amount: number } | null {
  if (!isRecord(value) || !hasExactKeys(value, ['currency', 'amount'])) return null;
  if (
    typeof value.currency !== 'string' || !/^[a-z]{3}$/.test(value.currency) ||
    typeof value.amount !== 'number' || !Number.isFinite(value.amount) || value.amount < 0
  ) return null;
  return { currency: value.currency, amount: value.amount };
}

function parseShipStationPackageResponse(value: unknown): ShipStationPackageInput | null {
  if (!isRecord(value) || !hasExactKeys(value, ['length', 'width', 'height', 'weight'])) return null;
  return parseShipStationPackage(value);
}

function parseFulfillmentShipStationLabel(value: unknown): NonNullable<GetFulfillmentShipStationLabelResponse['label']> | null {
  if (!isRecord(value)) return null;
  const required = ['labelId', 'shipmentId', 'status'] as const;
  const optionalStrings = [
    'rateId',
    'trackingNumber',
    'carrierId',
    'carrierCode',
    'carrierName',
    'serviceCode',
    'serviceName',
    'purchasedBy',
  ] as const;
  const optional = [...optionalStrings, 'shipmentCost', 'insuranceCost', 'totalCost', 'purchasedAt'] as const;
  const allowed = new Set<string>([...required, ...optional]);
  if (!required.every((key) => Object.hasOwn(value, key))) return null;
  if (!Object.keys(value).every((key) => allowed.has(key))) return null;
  if (
    typeof value.labelId !== 'string' || !value.labelId ||
    typeof value.shipmentId !== 'string' || !value.shipmentId ||
    (value.status !== 'processing' && value.status !== 'completed' && value.status !== 'error' && value.status !== 'voided') ||
    optionalStrings.some((key) => value[key] !== undefined && (typeof value[key] !== 'string' || !value[key])) ||
    (value.purchasedAt !== undefined && (typeof value.purchasedAt !== 'number' || !Number.isFinite(value.purchasedAt)))
  ) return null;
  const shipmentCost = value.shipmentCost === undefined ? undefined : parseShipStationMoney(value.shipmentCost);
  const insuranceCost = value.insuranceCost === undefined ? undefined : parseShipStationMoney(value.insuranceCost);
  const totalCost = value.totalCost === undefined ? undefined : parseShipStationMoney(value.totalCost);
  if (
    (value.shipmentCost !== undefined && !shipmentCost) ||
    (value.insuranceCost !== undefined && !insuranceCost) ||
    (value.totalCost !== undefined && !totalCost)
  ) return null;
  return {
    labelId: value.labelId,
    shipmentId: value.shipmentId,
    status: value.status,
    ...(typeof value.rateId === 'string' ? { rateId: value.rateId } : {}),
    ...(typeof value.trackingNumber === 'string' ? { trackingNumber: value.trackingNumber } : {}),
    ...(typeof value.carrierId === 'string' ? { carrierId: value.carrierId } : {}),
    ...(typeof value.carrierCode === 'string' ? { carrierCode: value.carrierCode } : {}),
    ...(typeof value.carrierName === 'string' ? { carrierName: value.carrierName } : {}),
    ...(typeof value.serviceCode === 'string' ? { serviceCode: value.serviceCode } : {}),
    ...(typeof value.serviceName === 'string' ? { serviceName: value.serviceName } : {}),
    ...(shipmentCost ? { shipmentCost } : {}),
    ...(insuranceCost ? { insuranceCost } : {}),
    ...(totalCost ? { totalCost } : {}),
    ...(typeof value.purchasedAt === 'number' ? { purchasedAt: value.purchasedAt } : {}),
    ...(typeof value.purchasedBy === 'string' ? { purchasedBy: value.purchasedBy } : {}),
  };
}

export function parseAddFulfillmentOrderToShipStation(
  value: unknown,
): AddFulfillmentOrderToShipStationResponse | null {
  if (!isRecord(value)) return null;
  const required = ['deliveryId', 'shipmentId', 'alreadyAdded'] as const;
  const allowed = new Set<string>([...required, 'shipstationAddedAt']);
  if (!required.every((key) => Object.hasOwn(value, key))) return null;
  if (!Object.keys(value).every((key) => allowed.has(key))) return null;
  if (
    !Number.isSafeInteger(value.deliveryId) || Number(value.deliveryId) <= 0 ||
    typeof value.shipmentId !== 'string' || !value.shipmentId ||
    typeof value.alreadyAdded !== 'boolean' ||
    (value.shipstationAddedAt !== undefined && (
      typeof value.shipstationAddedAt !== 'number' ||
      !Number.isFinite(value.shipstationAddedAt) ||
      value.shipstationAddedAt <= 0
    ))
  ) return null;
  return {
    deliveryId: Number(value.deliveryId),
    shipmentId: value.shipmentId,
    alreadyAdded: value.alreadyAdded,
    ...(typeof value.shipstationAddedAt === 'number'
      ? { shipstationAddedAt: value.shipstationAddedAt }
      : {}),
  };
}

export function parseGetFulfillmentShipStationLabel(value: unknown): GetFulfillmentShipStationLabelResponse | null {
  if (!isRecord(value)) return null;
  const required = ['deliveryId', 'shipmentId'] as const;
  const optional = ['label', 'labelDownloadUrl', 'purchaseUnknown'] as const;
  const allowed = new Set<string>([...required, ...optional]);
  if (!required.every((key) => Object.hasOwn(value, key))) return null;
  if (!Object.keys(value).every((key) => allowed.has(key))) return null;
  if (
    !Number.isSafeInteger(value.deliveryId) || Number(value.deliveryId) <= 0 ||
    typeof value.shipmentId !== 'string' || !value.shipmentId ||
    (value.labelDownloadUrl !== undefined &&
      (typeof value.labelDownloadUrl !== 'string' || !/^https:\/\//i.test(value.labelDownloadUrl))) ||
    (value.purchaseUnknown !== undefined && typeof value.purchaseUnknown !== 'boolean')
  ) return null;
  const label = value.label === undefined ? undefined : parseFulfillmentShipStationLabel(value.label);
  if (value.label !== undefined && (!label || label.shipmentId !== value.shipmentId)) return null;
  return {
    deliveryId: Number(value.deliveryId),
    shipmentId: value.shipmentId,
    ...(label ? { label } : {}),
    ...(typeof value.labelDownloadUrl === 'string' ? { labelDownloadUrl: value.labelDownloadUrl } : {}),
    ...(typeof value.purchaseUnknown === 'boolean' ? { purchaseUnknown: value.purchaseUnknown } : {}),
  };
}

export function parsePurchaseFulfillmentShipStationLabel(
  value: unknown,
): PurchaseFulfillmentShipStationLabelResponse | null {
  if (!isRecord(value)) return null;
  const required = ['deliveryId', 'shipmentId', 'label', 'alreadyPurchased'] as const;
  const allowed = new Set<string>([...required, 'labelDownloadUrl']);
  if (!required.every((key) => Object.hasOwn(value, key))) return null;
  if (!Object.keys(value).every((key) => allowed.has(key))) return null;
  if (
    !Number.isSafeInteger(value.deliveryId) || Number(value.deliveryId) <= 0 ||
    typeof value.shipmentId !== 'string' || !value.shipmentId ||
    typeof value.alreadyPurchased !== 'boolean' ||
    (value.labelDownloadUrl !== undefined && (
      typeof value.labelDownloadUrl !== 'string' || !/^https:\/\//i.test(value.labelDownloadUrl)
    ))
  ) return null;
  const label = parseFulfillmentShipStationLabel(value.label);
  if (!label || label.shipmentId !== value.shipmentId) return null;
  return {
    deliveryId: Number(value.deliveryId),
    shipmentId: value.shipmentId,
    label,
    ...(typeof value.labelDownloadUrl === 'string' ? { labelDownloadUrl: value.labelDownloadUrl } : {}),
    alreadyPurchased: value.alreadyPurchased,
  };
}

export function parseVoidFulfillmentShipStationLabel(
  value: unknown,
): VoidFulfillmentShipStationLabelResponse | null {
  if (!isRecord(value)) return null;
  const required = ['deliveryId', 'shipmentId', 'label'] as const;
  if (!hasExactKeys(value, required)) return null;
  if (
    !Number.isSafeInteger(value.deliveryId) || Number(value.deliveryId) <= 0 ||
    typeof value.shipmentId !== 'string' || !value.shipmentId
  ) return null;
  const label = parseFulfillmentShipStationLabel(value.label);
  if (!label || label.shipmentId !== value.shipmentId || label.status !== 'voided') return null;
  return {
    deliveryId: Number(value.deliveryId),
    shipmentId: value.shipmentId,
    label: { ...label, status: 'voided' },
  };
}

function parseFulfillmentShipStationRate(
  value: unknown,
): GetFulfillmentShipStationRatesResponse['rates'][number] | null {
  if (!isRecord(value)) return null;
  const requiredStrings = [
    'rateId',
    'shipmentId',
    'carrierId',
    'carrierCode',
    'carrierName',
    'serviceCode',
    'serviceName',
  ] as const;
  const requiredMoney = [
    'shippingAmount',
    'insuranceAmount',
    'confirmationAmount',
    'otherAmount',
    'totalAmount',
  ] as const;
  const optionalStrings = [
    'carrierNickname',
    'packageType',
    'rateType',
    'carrierDeliveryDays',
    'shipDate',
    'estimatedDeliveryDate',
  ] as const;
  const optional = [
    ...optionalStrings,
    'zone',
    'negotiatedRate',
    'trackable',
    'taxAmount',
    'deliveryDays',
  ] as const;
  const allowed = new Set<string>([
    ...requiredStrings,
    ...requiredMoney,
    ...optional,
    'guaranteedService',
    'warningMessages',
  ]);
  if (!requiredStrings.every((key) => Object.hasOwn(value, key))) return null;
  if (!requiredMoney.every((key) => Object.hasOwn(value, key))) return null;
  if (!Object.hasOwn(value, 'guaranteedService') || !Object.hasOwn(value, 'warningMessages')) return null;
  if (!Object.keys(value).every((key) => allowed.has(key))) return null;
  if (
    requiredStrings.some((key) => typeof value[key] !== 'string') ||
    typeof value.rateId !== 'string' || !value.rateId ||
    typeof value.shipmentId !== 'string' || !value.shipmentId ||
    optionalStrings.some((key) => value[key] !== undefined && (typeof value[key] !== 'string' || !value[key])) ||
    typeof value.guaranteedService !== 'boolean' ||
    !Array.isArray(value.warningMessages) ||
    !value.warningMessages.every((message) => typeof message === 'string') ||
    (value.zone !== undefined && (!Number.isSafeInteger(value.zone) || Number(value.zone) < 0)) ||
    (value.deliveryDays !== undefined && (!Number.isSafeInteger(value.deliveryDays) || Number(value.deliveryDays) < 0)) ||
    (value.negotiatedRate !== undefined && typeof value.negotiatedRate !== 'boolean') ||
    (value.trackable !== undefined && typeof value.trackable !== 'boolean')
  ) return null;
  const shippingAmount = parseShipStationMoney(value.shippingAmount);
  const insuranceAmount = parseShipStationMoney(value.insuranceAmount);
  const confirmationAmount = parseShipStationMoney(value.confirmationAmount);
  const otherAmount = parseShipStationMoney(value.otherAmount);
  const totalAmount = parseShipStationMoney(value.totalAmount);
  const taxAmount = value.taxAmount === undefined ? undefined : parseShipStationMoney(value.taxAmount);
  if (!shippingAmount || !insuranceAmount || !confirmationAmount || !otherAmount || !totalAmount) return null;
  if (value.taxAmount !== undefined && !taxAmount) return null;
  const currencies = [shippingAmount, insuranceAmount, confirmationAmount, otherAmount, totalAmount, taxAmount]
    .filter((amount): amount is NonNullable<typeof amount> => Boolean(amount))
    .map((amount) => amount.currency);
  if (currencies.some((currency) => currency !== currencies[0])) return null;
  return {
    rateId: value.rateId,
    shipmentId: value.shipmentId,
    carrierId: value.carrierId as string,
    carrierCode: value.carrierCode as string,
    carrierName: value.carrierName as string,
    ...(typeof value.carrierNickname === 'string' ? { carrierNickname: value.carrierNickname } : {}),
    serviceCode: value.serviceCode as string,
    serviceName: value.serviceName as string,
    ...(typeof value.packageType === 'string' ? { packageType: value.packageType } : {}),
    ...(typeof value.rateType === 'string' ? { rateType: value.rateType } : {}),
    ...(typeof value.zone === 'number' ? { zone: value.zone } : {}),
    ...(typeof value.carrierDeliveryDays === 'string' ? { carrierDeliveryDays: value.carrierDeliveryDays } : {}),
    ...(typeof value.shipDate === 'string' ? { shipDate: value.shipDate } : {}),
    ...(typeof value.negotiatedRate === 'boolean' ? { negotiatedRate: value.negotiatedRate } : {}),
    ...(typeof value.trackable === 'boolean' ? { trackable: value.trackable } : {}),
    shippingAmount,
    insuranceAmount,
    confirmationAmount,
    otherAmount,
    ...(taxAmount ? { taxAmount } : {}),
    totalAmount,
    ...(typeof value.deliveryDays === 'number' ? { deliveryDays: value.deliveryDays } : {}),
    ...(typeof value.estimatedDeliveryDate === 'string'
      ? { estimatedDeliveryDate: value.estimatedDeliveryDate }
      : {}),
    guaranteedService: value.guaranteedService,
    warningMessages: value.warningMessages,
  };
}

function parseFulfillmentShipStationInvalidRate(
  value: unknown,
): GetFulfillmentShipStationRatesResponse['invalidRates'][number] | null {
  if (!isRecord(value)) return null;
  const required = ['carrierId', 'carrierCode', 'carrierName', 'serviceCode', 'serviceName', 'errorMessages'] as const;
  const allowed = new Set<string>([...required, 'responseIssue']);
  if (!required.every((key) => Object.hasOwn(value, key))) return null;
  if (!Object.keys(value).every((key) => allowed.has(key))) return null;
  if (
    typeof value.carrierId !== 'string' ||
    typeof value.carrierCode !== 'string' ||
    typeof value.carrierName !== 'string' || !value.carrierName ||
    typeof value.serviceCode !== 'string' ||
    typeof value.serviceName !== 'string' || !value.serviceName ||
    !Array.isArray(value.errorMessages) ||
    !value.errorMessages.length ||
    !value.errorMessages.every((message) => typeof message === 'string' && Boolean(message)) ||
    (value.responseIssue !== undefined && value.responseIssue !== true)
  ) return null;
  return {
    carrierId: value.carrierId,
    carrierCode: value.carrierCode,
    carrierName: value.carrierName,
    serviceCode: value.serviceCode,
    serviceName: value.serviceName,
    errorMessages: value.errorMessages,
    ...(value.responseIssue === true ? { responseIssue: true } : {}),
  };
}

export function parseGetFulfillmentShipStationRates(value: unknown): GetFulfillmentShipStationRatesResponse | null {
  if (!isRecord(value)) return null;
  const required = ['deliveryId', 'shipmentId', 'packageCount', 'rates', 'invalidRates'] as const;
  const optional = ['package', 'label', 'labelDownloadUrl', 'purchaseUnknown'] as const;
  const allowed = new Set<string>([...required, ...optional]);
  if (!required.every((key) => Object.hasOwn(value, key))) return null;
  if (!Object.keys(value).every((key) => allowed.has(key))) return null;
  if (
    !Number.isSafeInteger(value.deliveryId) || Number(value.deliveryId) <= 0 ||
    typeof value.shipmentId !== 'string' || !value.shipmentId ||
    !Number.isSafeInteger(value.packageCount) || Number(value.packageCount) < 0 ||
    !Array.isArray(value.rates) ||
    !Array.isArray(value.invalidRates) ||
    (value.labelDownloadUrl !== undefined &&
      (typeof value.labelDownloadUrl !== 'string' || !/^https:\/\//i.test(value.labelDownloadUrl))) ||
    (value.purchaseUnknown !== undefined && typeof value.purchaseUnknown !== 'boolean')
  ) return null;
  const packageInput = value.package === undefined ? undefined : parseShipStationPackageResponse(value.package);
  if (value.package !== undefined && !packageInput) return null;
  const rates = value.rates.map(parseFulfillmentShipStationRate);
  const invalidRates = value.invalidRates.map(parseFulfillmentShipStationInvalidRate);
  if (!rates.every((rate): rate is NonNullable<typeof rate> => rate !== null)) return null;
  if (!invalidRates.every((rate): rate is NonNullable<typeof rate> => rate !== null)) return null;
  if (rates.some((rate) => rate.shipmentId !== value.shipmentId)) return null;
  const label = value.label === undefined ? undefined : parseFulfillmentShipStationLabel(value.label);
  if (value.label !== undefined && (!label || label.shipmentId !== value.shipmentId)) return null;
  if (value.labelDownloadUrl !== undefined && !label) return null;
  return {
    deliveryId: Number(value.deliveryId),
    shipmentId: value.shipmentId,
    ...(packageInput ? { package: packageInput } : {}),
    packageCount: Number(value.packageCount),
    rates,
    invalidRates,
    ...(label ? { label } : {}),
    ...(typeof value.labelDownloadUrl === 'string' ? { labelDownloadUrl: value.labelDownloadUrl } : {}),
    ...(typeof value.purchaseUnknown === 'boolean' ? { purchaseUnknown: value.purchaseUnknown } : {}),
  };
}

export function addFulfillmentOrderToShipStationRequestPayload(
  deliveryId: number,
  dropId: string,
  packageInput?: ShipStationPackageInput,
  addressPatch?: ShipStationAddressPatch,
): AddFulfillmentOrderToShipStationRequest {
  return {
    deliveryId,
    dropId,
    ...(packageInput ? { package: packageInput } : {}),
    ...(addressPatch ? { addressPatch } : {}),
  };
}

export function createFulfillmentApiClient(
  callProfileApi: AuthenticatedApiCall = defaultCallProfileApi,
) {
  async function listFulfillmentOrders(args: {
    limit?: number;
    cursor?: FulfillmentOrdersCursor | null;
    dropId: string;
  }): Promise<{ orders: FulfillmentOrder[]; nextCursor?: FulfillmentOrdersCursor | null }> {
    const response = await callProfileApi('/fulfillment/orders', {
      limit: args.limit,
      cursor: args.cursor || undefined,
      dropId: args.dropId,
    });
    if (!isRecord(response) || !Array.isArray(response.orders)) throw new Error('Invalid fulfillment orders response');
    const orders = response.orders.filter((order): order is FulfillmentOrder =>
      isRecord(order) &&
      typeof order.dropId === 'string' &&
      Number.isSafeInteger(order.deliveryId) && Number(order.deliveryId) > 0 &&
      typeof order.owner === 'string' &&
      typeof order.status === 'string' &&
      (order.buyerOrderShippedEmailState === undefined ||
        order.buyerOrderShippedEmailState === 'pending' ||
        order.buyerOrderShippedEmailState === 'queued') &&
      isRecord(order.address) &&
      Array.isArray(order.boxes) &&
      Array.isArray(order.looseDudes));
    if (orders.length !== response.orders.length) throw new Error('Invalid fulfillment orders response');
    const cursor = response.nextCursor;
    if (cursor !== undefined && cursor !== null && (
      !isRecord(cursor) || !isRecord(cursor.processedAt) ||
      !Number.isSafeInteger(cursor.processedAt.seconds) ||
      !Number.isInteger(cursor.processedAt.nanos) ||
      typeof cursor.id !== 'string'
    )) throw new Error('Invalid fulfillment orders response');
    return {
      orders: orders.map((order) => ({
        ...order,
        dropId: order.dropId || args.dropId,
      })),
      nextCursor: cursor as FulfillmentOrdersCursor | null | undefined,
    };
  }

  async function listFulfillmentManualReviewCheckouts(args: {
    dropId: string;
  }): Promise<{ checkouts: FulfillmentManualReviewCheckout[] }> {
    const response = await callProfileApi('/fulfillment/manual-review-checkouts', { dropId: args.dropId });
    if (!isRecord(response) || !Array.isArray(response.checkouts)) {
      throw new Error('Invalid fulfillment manual-review response');
    }
    const checkouts = response.checkouts.filter((checkout): checkout is FulfillmentManualReviewCheckout =>
      isRecord(checkout) &&
      typeof checkout.dropId === 'string' &&
      typeof checkout.sessionId === 'string' &&
      typeof checkout.owner === 'string' &&
      isRecord(checkout.address));
    if (checkouts.length !== response.checkouts.length) throw new Error('Invalid fulfillment manual-review response');
    return {
      checkouts: checkouts.map((checkout) => ({
        ...checkout,
        dropId: checkout.dropId || args.dropId,
        address: checkout.address || {},
      })),
    };
  }

  async function updateFulfillmentStatus(
    deliveryId: number,
    status: FulfillmentStatus | '' | null,
    dropId: string,
    trackingCode?: string,
    options: { retryShippedEmail?: boolean } = {},
  ): Promise<{
    buyerOrderShippedEmailState?: 'pending' | 'queued';
    deliveryId: number;
    fulfillmentStatus: FulfillmentStatus | '';
    fulfillmentTrackingCode?: string;
  }> {
    const response = await callProfileApi('/fulfillment/order-status', {
      deliveryId,
      status,
      dropId,
      ...(options.retryShippedEmail === true ? { retryShippedEmail: true } : {}),
      ...(trackingCode != null ? { trackingCode } : {}),
    });
    const result = parseFulfillmentStatusUpdate(response);
    if (!result) throw new Error('Invalid fulfillment status response');
    return result;
  }

  async function updateFulfillmentAddress(
    deliveryId: number,
    full: string,
    dropId: string,
  ): Promise<UpdateFulfillmentAddressResponse> {
    const response = await callProfileApi<UpdateFulfillmentAddressRequest>(
      '/fulfillment/order-address',
      { deliveryId, full, dropId },
    );
    const result = parseUpdateFulfillmentAddress(response);
    if (!result) throw new Error('Invalid fulfillment address response');
    return result;
  }

  async function addFulfillmentOrderToShipStation(
    deliveryId: number,
    dropId: string,
    packageInput?: ShipStationPackageInput,
    addressPatch?: ShipStationAddressPatch,
  ): Promise<AddFulfillmentOrderToShipStationResponse> {
    const response = await callProfileApi<AddFulfillmentOrderToShipStationRequest>(
      '/fulfillment/shipstation-shipment',
      addFulfillmentOrderToShipStationRequestPayload(deliveryId, dropId, packageInput, addressPatch),
    );
    const result = parseAddFulfillmentOrderToShipStation(response);
    if (!result) throw new Error('Invalid fulfillment ShipStation shipment response');
    return result;
  }

  async function getFulfillmentShipStationRates(
    deliveryId: number,
    dropId: string,
    packageInput?: ShipStationPackageInput,
  ): Promise<GetFulfillmentShipStationRatesResponse> {
    const response = await callProfileApi<GetFulfillmentShipStationRatesRequest>(
      '/fulfillment/shipstation-rates',
      { deliveryId, dropId, ...(packageInput ? { package: packageInput } : {}) },
    );
    const result = parseGetFulfillmentShipStationRates(response);
    if (!result) throw new Error('Invalid fulfillment ShipStation rates response');
    return result;
  }

  async function purchaseFulfillmentShipStationLabel(
    args: PurchaseFulfillmentShipStationLabelRequest,
  ): Promise<PurchaseFulfillmentShipStationLabelResponse> {
    const response = await callProfileApi<PurchaseFulfillmentShipStationLabelRequest>(
      '/fulfillment/shipstation-label-purchase',
      args,
    );
    const result = parsePurchaseFulfillmentShipStationLabel(response);
    if (!result) throw new Error('Invalid fulfillment ShipStation label purchase response');
    return result;
  }

  async function getFulfillmentShipStationLabel(
    deliveryId: number,
    dropId: string,
  ): Promise<GetFulfillmentShipStationLabelResponse> {
    const response = await callProfileApi<GetFulfillmentShipStationLabelRequest>(
      '/fulfillment/shipstation-label',
      { deliveryId, dropId },
    );
    const result = parseGetFulfillmentShipStationLabel(response);
    if (!result) throw new Error('Invalid fulfillment ShipStation label response');
    return result;
  }

  async function voidFulfillmentShipStationLabel(
    args: VoidFulfillmentShipStationLabelRequest,
  ): Promise<VoidFulfillmentShipStationLabelResponse> {
    const response = await callProfileApi<VoidFulfillmentShipStationLabelRequest>(
      '/fulfillment/shipstation-label-void',
      args,
    );
    const result = parseVoidFulfillmentShipStationLabel(response);
    if (!result) throw new Error('Invalid fulfillment ShipStation label void response');
    return result;
  }


  return {
    addFulfillmentOrderToShipStation,
    getFulfillmentShipStationLabel,
    getFulfillmentShipStationRates,
    listFulfillmentManualReviewCheckouts,
    listFulfillmentOrders,
    purchaseFulfillmentShipStationLabel,
    updateFulfillmentAddress,
    updateFulfillmentStatus,
    voidFulfillmentShipStationLabel,
  };
}

const fulfillmentApiClient = createFulfillmentApiClient();

export const {
  addFulfillmentOrderToShipStation,
  getFulfillmentShipStationLabel,
  getFulfillmentShipStationRates,
  listFulfillmentManualReviewCheckouts,
  listFulfillmentOrders,
  purchaseFulfillmentShipStationLabel,
  updateFulfillmentAddress,
  updateFulfillmentStatus,
  voidFulfillmentShipStationLabel,
} = fulfillmentApiClient;
