import type { FulfillmentOrderAddress, ShipStationAddressPatch, ShipStationEditableAddressField } from '../types';
import { SHIPSTATION_EDITABLE_ADDRESS_FIELDS } from '../types';
import { parseShipStationShipTo } from '../../functions/src/shared/shipstationRates.js';

export type FulfillmentShipStationAddressDraft = Record<ShipStationEditableAddressField, string>;

export type FulfillmentShipStationAddressCorrectionSession = {
  baseline: FulfillmentShipStationAddressDraft | null;
  draft: FulfillmentShipStationAddressDraft;
  requestedFields: ShipStationEditableAddressField[];
  visibleFields: ShipStationEditableAddressField[];
  lastAttemptedPatch: ShipStationAddressPatch;
};

const OPTIONAL_ADDRESS_FIELDS = new Set<ShipStationEditableAddressField>(['address_line2', 'address_line3']);

function emptyAddressDraft(): FulfillmentShipStationAddressDraft {
  return {
    name: '',
    address_line1: '',
    address_line2: '',
    address_line3: '',
    city_locality: '',
    state_province: '',
    postal_code: '',
    country_code: '',
  };
}

function normalizedAddressValue(field: ShipStationEditableAddressField, value: string): string {
  const normalized = value.trim();
  return field === 'country_code' ? normalized.toUpperCase() : normalized;
}

function canonicalAddressFields(fields: readonly ShipStationEditableAddressField[]): ShipStationEditableAddressField[] {
  const selected = new Set(fields);
  return SHIPSTATION_EDITABLE_ADDRESS_FIELDS.filter((field) => selected.has(field));
}

export function fulfillmentShipStationAddressDraft(
  address: FulfillmentOrderAddress,
): FulfillmentShipStationAddressDraft | null {
  const parsed = parseShipStationShipTo(address.full, address.countryCode);
  if (!parsed.ok || !parsed.shipTo) return null;
  return {
    name: parsed.shipTo.name,
    address_line1: parsed.shipTo.address_line1,
    address_line2: parsed.shipTo.address_line2 ?? '',
    address_line3: parsed.shipTo.address_line3 ?? '',
    city_locality: parsed.shipTo.city_locality,
    state_province: parsed.shipTo.state_province,
    postal_code: parsed.shipTo.postal_code,
    country_code: parsed.shipTo.country_code,
  };
}

export function fulfillmentShipStationAddressCorrectionFailure(
  current: FulfillmentShipStationAddressCorrectionSession | null,
  baseline: FulfillmentShipStationAddressDraft | null,
  fields: readonly ShipStationEditableAddressField[],
  attemptedPatch: ShipStationAddressPatch,
): FulfillmentShipStationAddressCorrectionSession {
  return {
    baseline: current ? current.baseline : baseline,
    draft: current?.draft ?? (baseline ? { ...baseline } : emptyAddressDraft()),
    requestedFields: canonicalAddressFields([...(current?.requestedFields ?? []), ...fields]),
    visibleFields: [...fields],
    lastAttemptedPatch: { ...attemptedPatch },
  };
}

export function fulfillmentShipStationAddressOtherFailure(
  current: FulfillmentShipStationAddressCorrectionSession | null,
  attemptedPatch: ShipStationAddressPatch,
): FulfillmentShipStationAddressCorrectionSession | null {
  return current ? {
    ...current,
    visibleFields: [],
    lastAttemptedPatch: { ...attemptedPatch },
  } : null;
}

export function fulfillmentShipStationAddressPatch(
  session: FulfillmentShipStationAddressCorrectionSession,
): ShipStationAddressPatch {
  const patch: ShipStationAddressPatch = {};
  const fields = session.baseline ? SHIPSTATION_EDITABLE_ADDRESS_FIELDS : session.requestedFields;
  for (const field of fields) {
    const value = normalizedAddressValue(field, session.draft[field]);
    if (!session.baseline || value !== session.baseline[field]) patch[field] = value;
  }
  return patch;
}

function visibleAddressFieldsValid(session: FulfillmentShipStationAddressCorrectionSession): boolean {
  return session.visibleFields.every((field) => {
    const value = session.draft[field].trim();
    if (value.length > 50) return false;
    if (!OPTIONAL_ADDRESS_FIELDS.has(field) && !value) return false;
    return field !== 'country_code' || /^[A-Za-z]{2}$/.test(value);
  });
}

function addressPatchKey(patch: ShipStationAddressPatch): string {
  return JSON.stringify(SHIPSTATION_EDITABLE_ADDRESS_FIELDS.flatMap((field) =>
    Object.hasOwn(patch, field) ? [[field, patch[field]]] : []
  ));
}

export function fulfillmentShipStationAddressCanRetry(
  session: FulfillmentShipStationAddressCorrectionSession,
): boolean {
  const patch = fulfillmentShipStationAddressPatch(session);
  return session.visibleFields.length > 0 &&
    visibleAddressFieldsValid(session) &&
    Object.keys(patch).length > 0 &&
    addressPatchKey(patch) !== addressPatchKey(session.lastAttemptedPatch);
}
