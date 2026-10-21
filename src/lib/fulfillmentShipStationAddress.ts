import type { FulfillmentOrderAddress, ShipStationAddressPatch, ShipStationEditableAddressField } from '../types';
import { SHIPSTATION_EDITABLE_ADDRESS_FIELDS } from '../types';
import { parseShipStationShipTo } from '../../shared/shipstationRates.js';
import { countryRequiresPostalCode, countryRequiresState, normalizeCountryCode } from '../../shared/countryNormalization.ts';

export type FulfillmentShipStationAddressDraft = Record<ShipStationEditableAddressField, string>;

export type FulfillmentShipStationAddressCorrectionSession = {
  baseline: FulfillmentShipStationAddressDraft | null;
  draft: FulfillmentShipStationAddressDraft;
  requestedFields: ShipStationEditableAddressField[];
  visibleFields: ShipStationEditableAddressField[];
  lastAttemptedPatch: ShipStationAddressPatch;
};

export function fulfillmentShipStationAddressFieldRequired(
  field: ShipStationEditableAddressField,
  countryCode: string,
): boolean {
  if (field === 'address_line2' || field === 'address_line3') return false;
  if (field === 'state_province') return countryRequiresState(countryCode);
  if (field === 'postal_code') return countryRequiresPostalCode(countryCode);
  return true;
}

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
  const parsed = parseShipStationShipTo(address.full, address.countryCode, address.country);
  if (!parsed.shipTo) return null;
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
  parsedBaseline: FulfillmentShipStationAddressDraft | null,
  fields: readonly ShipStationEditableAddressField[],
  attemptedPatch: ShipStationAddressPatch,
  countryCode?: string,
): FulfillmentShipStationAddressCorrectionSession {
  const originalBaseline = current ? current.baseline : parsedBaseline;
  const baseline = parsedBaseline ? {
    ...parsedBaseline,
    country_code: originalBaseline?.country_code ?? parsedBaseline.country_code,
  } : originalBaseline;
  const next: FulfillmentShipStationAddressCorrectionSession = {
    baseline,
    draft: parsedBaseline
      ? { ...parsedBaseline, ...attemptedPatch }
      : current?.draft ?? {
        ...emptyAddressDraft(),
        country_code: fields.includes('country_code') ? '' : normalizeCountryCode(countryCode),
      },
    requestedFields: canonicalAddressFields([...(current?.requestedFields ?? []), ...fields]),
    visibleFields: [...fields],
    lastAttemptedPatch: { ...attemptedPatch },
  };
  if (parsedBaseline) next.lastAttemptedPatch = fulfillmentShipStationAddressPatch(next);
  return next;
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
  targetBaseline?: FulfillmentShipStationAddressDraft | null,
): ShipStationAddressPatch {
  const patch: ShipStationAddressPatch = {};
  const fields = session.baseline ? SHIPSTATION_EDITABLE_ADDRESS_FIELDS : session.requestedFields;
  for (const field of fields) {
    const value = normalizedAddressValue(field, session.draft[field]);
    const requestedValueChanged = field !== 'country_code' && targetBaseline &&
      session.requestedFields.includes(field) && value !== targetBaseline[field];
    if (!session.baseline || value !== session.baseline[field] || requestedValueChanged) patch[field] = value;
  }
  return patch;
}

function visibleAddressFieldsValid(session: FulfillmentShipStationAddressCorrectionSession): boolean {
  return session.visibleFields.every((field) => {
    const value = session.draft[field].trim();
    if (value.length > 50) return false;
    if (fulfillmentShipStationAddressFieldRequired(field, session.draft.country_code) && !value) return false;
    return field !== 'country_code' || (value.length === 2 && Boolean(normalizeCountryCode(value)));
  });
}

function addressPatchKey(patch: ShipStationAddressPatch): string {
  return JSON.stringify(SHIPSTATION_EDITABLE_ADDRESS_FIELDS.flatMap((field) =>
    Object.hasOwn(patch, field) ? [[field, patch[field]]] : []
  ));
}

export function fulfillmentShipStationAddressCanRetry(
  session: FulfillmentShipStationAddressCorrectionSession,
  targetBaseline?: FulfillmentShipStationAddressDraft | null,
): boolean {
  const patch = fulfillmentShipStationAddressPatch(session, targetBaseline);
  return session.visibleFields.length > 0 &&
    visibleAddressFieldsValid(session) &&
    Object.keys(patch).length > 0 &&
    addressPatchKey(patch) !== addressPatchKey(session.lastAttemptedPatch);
}
