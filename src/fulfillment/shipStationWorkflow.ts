import type {
  FulfillmentOrder,
  FulfillmentShipStationInvalidRate,
  FulfillmentShipStationRate,
  GetFulfillmentShipStationRatesResponse,
  ShipStationEditableAddressField,
  ShipStationPackageInput,
} from '../types';
import type { FulfillmentShipStationAddressCorrectionSession } from '../lib/fulfillmentShipStationAddress';
import { normalizeOptionalFulfillmentTrackingCode } from '../../shared/fulfillmentTracking.ts';
import { defaultShipStationPackage } from '../../shared/shipstationPackage.js';
import { buildShipStationCustomsDeclaration } from '../../shared/shipstationCustoms.js';

export type ShipStationPackageDraft = { length: string; width: string; height: string; weight: string };

export const SHIPSTATION_PACKAGE_FIELDS: { key: keyof ShipStationPackageDraft; label: string; ariaLabel: string }[] = [
  { key: 'length', label: 'L in', ariaLabel: 'Package length in inches' },
  { key: 'width', label: 'W in', ariaLabel: 'Package width in inches' },
  { key: 'height', label: 'H in', ariaLabel: 'Package height in inches' },
  { key: 'weight', label: 'oz', ariaLabel: 'Package weight in ounces' },
];

export function defaultShipStationPackageDraft(order: FulfillmentOrder): ShipStationPackageDraft {
  const parcel = defaultShipStationPackage(order.boxes.length + order.looseDudes.length);
  const countryCode = String(order.address.countryCode || '').trim().toUpperCase();
  if (!countryCode || countryCode === 'US') return shipStationPackageDraft(parcel);
  const declaration = buildShipStationCustomsDeclaration(order.dropId, order.boxes.length, order.looseDudes.length);
  return shipStationPackageDraft(
    declaration && parcel.weight < declaration.minimumPackageWeightOunces
      ? { ...parcel, weight: declaration.minimumPackageWeightOunces }
      : parcel,
  );
}

export function shipStationPackageDraft(parcel: ShipStationPackageInput): ShipStationPackageDraft {
  return {
    length: String(parcel.length),
    width: String(parcel.width),
    height: String(parcel.height),
    weight: String(parcel.weight),
  };
}

export function parseShipStationPackageDraft(draft: ShipStationPackageDraft): ShipStationPackageInput {
  const measurement = (value: string) => Number(value.trim().replace(',', '.'));
  return {
    length: measurement(draft.length),
    width: measurement(draft.width),
    height: measurement(draft.height),
    weight: measurement(draft.weight),
  };
}

export function isActiveShipStationLabel(label: FulfillmentOrder['shipstationLabel']): boolean {
  return label?.status === 'completed' || label?.status === 'processing';
}

export function shipStationTrackingCodeUpdateForOrder(
  order: FulfillmentOrder,
  nextLabel: FulfillmentOrder['shipstationLabel'],
): string | null | undefined {
  if (!nextLabel) return undefined;
  if (isActiveShipStationLabel(nextLabel) && nextLabel.trackingNumber) return nextLabel.trackingNumber;
  const currentTrackingCode = normalizeOptionalFulfillmentTrackingCode(order.fulfillmentTrackingCode);
  if (
    currentTrackingCode &&
    order.shipstationLabel?.trackingNumber === currentTrackingCode &&
    (order.shipstationLabel.labelId !== nextLabel.labelId || !isActiveShipStationLabel(nextLabel))
  ) {
    return null;
  }
  return undefined;
}

export function shipStationLabelOrderUpdate(
  order: FulfillmentOrder,
  nextLabel: FulfillmentOrder['shipstationLabel'],
) {
  const trackingCodeUpdate = shipStationTrackingCodeUpdateForOrder(order, nextLabel);
  return {
    shipstationLabel: nextLabel,
    ...(trackingCodeUpdate === null
      ? { fulfillmentTrackingCode: undefined }
      : trackingCodeUpdate
        ? { fulfillmentTrackingCode: trackingCodeUpdate }
        : {}),
  };
}

export function downloadShipStationLabel(url: string): void {
  if (typeof window === 'undefined' || !/^https:\/\//i.test(url)) return;
  window.open(url, '_blank', 'noopener,noreferrer');
}

type ShipStationOperation = 'idle' | 'adding' | 'rates' | 'purchasing' | 'label' | 'voiding';
type ShipStationReview = 'none' | 'purchase' | 'void';

type ShipStationWorkflowState = {
  operation: ShipStationOperation;
  review: ShipStationReview;
  error: string | null;
  packageEdits: Record<string, ShipStationPackageDraft>;
  addressCorrection: FulfillmentShipStationAddressCorrectionSession | null;
  rates: FulfillmentShipStationRate[];
  invalidRates: FulfillmentShipStationInvalidRate[];
  ratesExpanded: boolean;
  selectedRateId: string | null;
  ratesRequested: boolean;
  purchaseRequestId: string | null;
  labelDownloadUrl: string | null;
  purchaseUnknown: boolean;
};

export function createShipStationWorkflowState(): ShipStationWorkflowState {
  return {
    operation: 'idle',
    review: 'none',
    error: null,
    packageEdits: {},
    addressCorrection: null,
    rates: [],
    invalidRates: [],
    ratesExpanded: false,
    selectedRateId: null,
    ratesRequested: false,
    purchaseRequestId: null,
    labelDownloadUrl: null,
    purchaseUnknown: false,
  };
}

type ShipStationWorkflowEvent =
  | { type: 'reset' }
  | { type: 'started'; operation: Exclude<ShipStationOperation, 'idle'> }
  | { type: 'finished' }
  | { type: 'failed'; message: string }
  | { type: 'package-edited'; key: string; draft: ShipStationPackageDraft; field: keyof ShipStationPackageDraft; value: string }
  | { type: 'address-edited'; field: ShipStationEditableAddressField; value: string }
  | { type: 'add-completed'; key: string; warning: string | null }
  | { type: 'add-failed'; message: string; correction: FulfillmentShipStationAddressCorrectionSession | null }
  | { type: 'rates-received'; key: string; response: GetFulfillmentShipStationRatesResponse }
  | { type: 'rates-toggled' }
  | { type: 'rate-selected'; rateId: string }
  | { type: 'purchase-reviewed'; requestId: string }
  | { type: 'purchase-cancelled' }
  | { type: 'purchase-started'; requestId: string }
  | { type: 'purchase-completed'; labelDownloadUrl: string | null }
  | { type: 'purchase-failed'; message: string; reason: 'unknown' | 'expired' | 'other' }
  | { type: 'void-reviewed' }
  | { type: 'void-cancelled' }
  | { type: 'void-completed' }
  | { type: 'label-received'; purchaseUnknown: boolean; labelDownloadUrl: string | null };

function withoutPackageEdit(edits: ShipStationWorkflowState['packageEdits'], key: string) {
  if (!Object.hasOwn(edits, key)) return edits;
  const next = { ...edits };
  delete next[key];
  return next;
}

export function shipStationWorkflowReducer(
  state: ShipStationWorkflowState,
  event: ShipStationWorkflowEvent,
): ShipStationWorkflowState {
  switch (event.type) {
    case 'reset':
      return { ...createShipStationWorkflowState(), packageEdits: state.packageEdits };
    case 'started':
      return {
        ...state, operation: event.operation, error: null,
        ...(event.operation === 'rates' ? {
          ratesRequested: true, ratesExpanded: false, review: 'none' as const,
          purchaseRequestId: null, invalidRates: [],
        } : {}),
      };
    case 'finished':
      return { ...state, operation: 'idle' };
    case 'failed':
      return { ...state, error: event.message };
    case 'package-edited':
      return {
        ...state,
        packageEdits: {
          ...state.packageEdits,
          [event.key]: { ...(state.packageEdits[event.key] ?? event.draft), [event.field]: event.value },
        },
        rates: [], invalidRates: [], ratesExpanded: false, selectedRateId: null,
        review: 'none', purchaseRequestId: null, error: null,
      };
    case 'address-edited':
      return state.addressCorrection ? {
        ...state,
        addressCorrection: {
          ...state.addressCorrection,
          draft: {
            ...state.addressCorrection.draft,
            [event.field]: event.field === 'country_code' ? event.value.toUpperCase() : event.value,
          },
        },
      } : state;
    case 'add-completed':
      return {
        ...state, addressCorrection: null, error: event.warning,
        packageEdits: withoutPackageEdit(state.packageEdits, event.key),
      };
    case 'add-failed':
      return { ...state, error: event.message, addressCorrection: event.correction };
    case 'rates-received': {
      const response = event.response;
      const noRates = !response.label && !response.purchaseUnknown && response.packageCount === 1 &&
        !response.rates.length && !response.invalidRates?.length;
      return {
        ...state,
        packageEdits: response.package ? withoutPackageEdit(state.packageEdits, event.key) : state.packageEdits,
        rates: response.rates, invalidRates: response.invalidRates ?? [],
        selectedRateId: response.rates[0]?.rateId ?? null,
        labelDownloadUrl: response.labelDownloadUrl || null,
        purchaseUnknown: Boolean(response.purchaseUnknown),
        error: noRates ? 'ShipStation returned no valid rates for this shipment.' : null,
      };
    }
    case 'rates-toggled':
      return { ...state, ratesExpanded: !state.ratesExpanded };
    case 'rate-selected':
      return { ...state, selectedRateId: event.rateId, purchaseRequestId: null, error: null };
    case 'purchase-reviewed':
      return { ...state, review: 'purchase', purchaseRequestId: event.requestId, error: null };
    case 'purchase-cancelled':
      return { ...state, review: 'none', purchaseRequestId: null, error: null };
    case 'purchase-started':
      return { ...state, operation: 'purchasing', purchaseRequestId: event.requestId, error: null };
    case 'purchase-completed':
      return {
        ...state, rates: [], ratesExpanded: false, selectedRateId: null, review: 'none',
        purchaseUnknown: false, labelDownloadUrl: event.labelDownloadUrl,
      };
    case 'purchase-failed':
      return {
        ...state, error: event.message,
        ...(event.reason === 'unknown' ? { purchaseUnknown: true } : { purchaseRequestId: null }),
        ...(event.reason === 'expired' ? {
          rates: [], ratesExpanded: false, selectedRateId: null, review: 'none' as const, ratesRequested: true,
        } : {}),
      };
    case 'void-reviewed':
      return { ...state, review: 'void', error: null };
    case 'void-cancelled':
      return { ...state, review: 'none', error: null };
    case 'void-completed':
      return {
        ...state, rates: [], invalidRates: [], ratesExpanded: false, selectedRateId: null,
        ratesRequested: false, review: 'none', purchaseRequestId: null, purchaseUnknown: false,
        labelDownloadUrl: null,
      };
    case 'label-received':
      return { ...state, purchaseUnknown: event.purchaseUnknown, labelDownloadUrl: event.labelDownloadUrl };
  }
}
