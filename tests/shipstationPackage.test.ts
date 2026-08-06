import test from 'node:test';
import assert from 'node:assert/strict';
import {
  defaultShipStationPackage,
  normalizeShipStationPackage,
} from '../functions/src/shared/shipstationPackage.ts';
import {
  adoptOrPurchaseShipStationLabel,
  buildShipStationPackages,
  createShipStationLabelFromRate,
  isActiveShipStationLabel,
  shipStationErrorMessage,
  shipStationLabelResult,
  shipStationMoneyMatches,
  shipStationPackageDetails,
  shipStationPackageInputFromShipmentPackage,
  shipStationRateSummaries,
  shipStationTrackingCodeUpdate,
  shouldClearShipStationPurchaseState,
  shouldTransitionShipStationPurchaseState,
  updateShipStationShipment,
} from '../functions/src/shipstation.ts';

test('the default parcel scales its weight with the unit count and keeps a floor of one unit', () => {
  assert.deepEqual(defaultShipStationPackage(1), { length: 12, width: 9, height: 2, weight: 4 });
  assert.deepEqual(defaultShipStationPackage(3), { length: 12, width: 9, height: 2, weight: 12 });
  assert.deepEqual(defaultShipStationPackage(0), defaultShipStationPackage(1));
  assert.deepEqual(defaultShipStationPackage(Number.NaN), defaultShipStationPackage(1));
});

test('edited measurements are rounded to two decimals', () => {
  assert.deepEqual(normalizeShipStationPackage({ length: 12.345, width: 9, height: 2, weight: 4.006 }), {
    length: 12.35,
    width: 9,
    height: 2,
    weight: 4.01,
  });
});

test('measurements outside the accepted range are rejected rather than silently clamped', () => {
  const valid = { length: 12, width: 9, height: 2, weight: 4 };
  assert.equal(normalizeShipStationPackage({ ...valid, length: 0 }), null);
  assert.equal(normalizeShipStationPackage({ ...valid, width: -1 }), null);
  assert.equal(normalizeShipStationPackage({ ...valid, height: 500 }), null);
  assert.equal(normalizeShipStationPackage({ ...valid, weight: 0 }), null);
  assert.equal(normalizeShipStationPackage({ ...valid, weight: 5000 }), null);
  assert.equal(normalizeShipStationPackage({ ...valid, length: '' }), null);
  assert.equal(normalizeShipStationPackage({ length: 12, width: 9, height: 2 }), null);
  assert.equal(normalizeShipStationPackage(null), null);
});

test('an override replaces the derived parcel, and its absence falls back to the defaults', () => {
  assert.deepEqual(buildShipStationPackages(2), [
    { weight: { value: 8, unit: 'ounce' }, dimensions: { length: 12, width: 9, height: 2, unit: 'inch' } },
  ]);
  assert.deepEqual(buildShipStationPackages(2, { length: 6, width: 4, height: 1.5, weight: 10 }), [
    { weight: { value: 10, unit: 'ounce' }, dimensions: { length: 6, width: 4, height: 1.5, unit: 'inch' } },
  ]);
});

test('ShipStation package measurements are converted to the integration units', () => {
  assert.deepEqual(
    shipStationPackageInputFromShipmentPackage({
      weight: { value: 2, unit: 'pound' },
      dimensions: { length: 25.4, width: 12.7, height: 5.08, unit: 'centimeter' },
    }),
    { length: 10, width: 5, height: 2, weight: 32 },
  );
  assert.deepEqual(shipStationPackageDetails({ packages: [{ weight: {}, dimensions: {} }] }), { packageCount: 1 });
  assert.deepEqual(shipStationPackageDetails({ packages: [{}, {}] }), { packageCount: 2 });
});

test('valid ShipStation rates include every charge and are sorted by total', () => {
  const response = shipStationRateSummaries([
    {
      shipment_id: 'se-shipment',
      status: 'completed',
      rates: [
        {
          rate_id: 'se-expensive',
          carrier_id: 'se-ups',
          carrier_code: 'ups',
          carrier_friendly_name: 'UPS',
          service_code: 'ups_ground',
          service_type: 'UPS Ground',
          validation_status: 'valid',
          shipping_amount: { currency: 'usd', amount: 12 },
          insurance_amount: { currency: 'usd', amount: 1 },
          confirmation_amount: { currency: 'usd', amount: 0.5 },
          other_amount: { currency: 'usd', amount: 0.25 },
          warning_messages: [],
          error_messages: [],
        },
        {
          rate_id: 'se-cheap',
          carrier_id: 'se-usps',
          carrier_code: 'stamps_com',
          carrier_friendly_name: 'USPS',
          service_code: 'usps_ground_advantage',
          service_type: 'Ground Advantage',
          validation_status: 'has_warnings',
          shipping_amount: { currency: 'usd', amount: 7 },
          insurance_amount: { currency: 'usd', amount: 1 },
          confirmation_amount: { currency: 'usd', amount: 0.5 },
          other_amount: { currency: 'usd', amount: 0.25 },
          tax_amount: { currency: 'usd', amount: 0.25 },
          delivery_days: null,
          delivery_date: '2026-08-10T00:00:00Z',
          warning_messages: ['Residential surcharge may apply'],
          error_messages: [],
        },
      ],
    },
  ]);

  assert.equal(response.shipmentId, 'se-shipment');
  assert.deepEqual(response.rates.map((rate) => rate.rateId), ['se-cheap', 'se-expensive']);
  assert.deepEqual(response.rates[0].totalAmount, { currency: 'usd', amount: 9 });
  assert.equal(response.rates[0].estimatedDeliveryDays, undefined);
  assert.equal(response.rates[0].estimatedDeliveryDate, '2026-08-10T00:00:00Z');
  assert.deepEqual(response.rates[0].warningMessages, ['Residential surcharge may apply']);
});

test('invalid, errored, incomplete, and mixed-currency ShipStation rates are omitted', () => {
  const base = {
    carrier_id: 'se-carrier',
    carrier_code: 'ups',
    carrier_friendly_name: 'UPS',
    service_code: 'ups_ground',
    service_type: 'UPS Ground',
    shipping_amount: { currency: 'usd', amount: 10 },
    insurance_amount: { currency: 'usd', amount: 0 },
    confirmation_amount: { currency: 'usd', amount: 0 },
    other_amount: { currency: 'usd', amount: 0 },
    warning_messages: [],
    error_messages: [],
  };
  const response = shipStationRateSummaries({
    shipment_id: 'se-shipment',
    status: 'completed',
    rates: [
      { ...base, rate_id: 'invalid', validation_status: 'invalid' },
      { ...base, rate_id: 'unknown', validation_status: 'unknown' },
      { ...base, rate_id: 'errored', validation_status: 'valid', error_messages: ['bad address'] },
      { ...base, rate_id: 'incomplete', validation_status: 'valid', other_amount: undefined },
      {
        ...base,
        rate_id: 'mixed-currency',
        validation_status: 'valid',
        insurance_amount: { currency: 'eur', amount: 1 },
      },
    ],
  });
  assert.deepEqual(response.rates, []);
});

test('ShipStation labels expose sanitized purchase details and an HTTPS PDF URL', () => {
  const result = shipStationLabelResult({
    label_id: 'se-label',
    shipment_id: 'se-shipment',
    status: 'completed',
    rate_id: 'se-rate',
    tracking_number: 'TRACK123',
    carrier_id: 'se-carrier',
    carrier_code: 'ups',
    service_code: 'ups_ground',
    shipment_cost: { currency: 'usd', amount: 12.34 },
    insurance_cost: { currency: 'usd', amount: 0.66 },
    created_at: '2026-08-06T12:00:00Z',
    label_download: { pdf: 'https://api.shipstation.com/label.pdf' },
  });
  assert.equal(result?.label.status, 'completed');
  assert.deepEqual(result?.label.totalCost, { currency: 'usd', amount: 13 });
  assert.equal(result?.label.trackingNumber, 'TRACK123');
  assert.equal(result?.downloadUrl, 'https://api.shipstation.com/label.pdf');
  assert.equal(shipStationLabelResult({ label_id: 'se-label' }), null);
  assert.equal(
    shipStationLabelResult({
      label_id: 'se-voided',
      shipment_id: 'se-shipment',
      status: 'completed',
      voided: true,
    })?.label.status,
    'voided',
  );
});

test('rate amount comparison is currency-aware and cent-precise', () => {
  assert.equal(
    shipStationMoneyMatches({ currency: 'USD', amount: 12.34 }, { currency: 'usd', amount: 12.34 }),
    true,
  );
  assert.equal(
    shipStationMoneyMatches({ currency: 'usd', amount: 12.34 }, { currency: 'usd', amount: 12.35 }),
    false,
  );
  assert.equal(
    shipStationMoneyMatches({ currency: 'eur', amount: 12.34 }, { currency: 'usd', amount: 12.34 }),
    false,
  );
});

test('only active or confirmed labels clear an in-flight purchase claim', () => {
  assert.equal(isActiveShipStationLabel({ status: 'processing' }), true);
  assert.equal(isActiveShipStationLabel({ status: 'completed' }), true);
  assert.equal(isActiveShipStationLabel({ status: 'error' }), false);
  assert.equal(isActiveShipStationLabel({ status: 'voided' }), false);
  assert.equal(shouldClearShipStationPurchaseState({ status: 'voided' }), false);
  assert.equal(shouldClearShipStationPurchaseState({ status: 'error' }, true), true);
});

test('purchase state only transitions for the same in-flight request without an active label', () => {
  const purchase = { status: 'purchasing', requestId: 'request-1' };
  assert.equal(shouldTransitionShipStationPurchaseState(purchase, 'request-1', false), true);
  assert.equal(shouldTransitionShipStationPurchaseState(purchase, 'request-2', false), false);
  assert.equal(shouldTransitionShipStationPurchaseState(purchase, 'request-1', true), false);
  assert.equal(shouldTransitionShipStationPurchaseState({ status: 'completed', requestId: 'request-1' }, 'request-1', false), false);
  assert.equal(shouldTransitionShipStationPurchaseState({ status: 'failed', requestId: 'request-1' }, 'request-1', false), false);
  assert.equal(shouldTransitionShipStationPurchaseState({ status: 'unknown', requestId: 'request-1' }, 'request-1', false), false);
  assert.equal(shouldTransitionShipStationPurchaseState({ status: 'purchasing' }, undefined, false), true);
});

test('an existing ShipStation label is adopted without invoking the purchase request', async () => {
  const existing = {
    label: {
      labelId: 'se-existing-label',
      shipmentId: 'se-shipment',
      status: 'completed' as const,
    },
  };
  let purchaseCalls = 0;
  const resolution = await adoptOrPurchaseShipStationLabel(
    async () => existing,
    async () => {
      purchaseCalls += 1;
      return {
        label: {
          labelId: 'se-new-label',
          shipmentId: 'se-shipment',
          status: 'completed',
        },
      };
    },
  );
  assert.equal(resolution.alreadyPurchased, true);
  assert.equal(resolution.result.label.labelId, 'se-existing-label');
  assert.equal(purchaseCalls, 0);
});

test('tracking follows active labels and is removed when its source label becomes inactive', () => {
  const currentLabel = { labelId: 'se-old', trackingNumber: 'OLD123' };
  assert.equal(
    shipStationTrackingCodeUpdate('OLD123', currentLabel, {
      labelId: 'se-new',
      status: 'completed',
      trackingNumber: 'NEW456',
    }),
    'NEW456',
  );
  assert.equal(
    shipStationTrackingCodeUpdate('OLD123', currentLabel, {
      labelId: 'se-old',
      status: 'voided',
      trackingNumber: 'OLD123',
    }),
    null,
  );
  assert.equal(
    shipStationTrackingCodeUpdate('MANUAL', currentLabel, {
      labelId: 'se-old',
      status: 'voided',
      trackingNumber: 'OLD123',
    }),
    undefined,
  );
});

test('ShipStation failures do not return upstream messages containing address data', () => {
  const funding = shipStationErrorMessage(
    { errors: [{ error_code: 'insufficient_funds', message: 'Balance failed for 12 Private Street' }] },
    'Request failed',
  );
  assert.equal(funding, 'Insufficient ShipStation funds. Add funds or enable auto-funding in ShipStation.');
  assert.equal(funding.includes('Private Street'), false);
  assert.equal(
    shipStationErrorMessage(
      { errors: [{ error_code: 'validation_error', message: 'Invalid 12 Private Street' }] },
      'Request failed',
    ),
    'validation_error',
  );
  assert.equal(shipStationErrorMessage({ message: 'Invalid 12 Private Street' }, 'Request failed'), 'Request failed');
});

test('shipment package updates use the ShipStation update endpoint', async () => {
  const originalFetch = globalThis.fetch;
  let requestUrl = '';
  let requestInit: RequestInit | undefined;
  globalThis.fetch = (async (input, init) => {
    requestUrl = String(input);
    requestInit = init;
    return new Response(JSON.stringify({ shipment_id: 'se-shipment', packages: [] }), { status: 200 });
  }) as typeof fetch;
  try {
    await updateShipStationShipment('api-key', 'se-shipment', {
      packages: buildShipStationPackages(1, { length: 10, width: 8, height: 2, weight: 6 }),
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(requestUrl, 'https://api.shipstation.com/v2/shipments/se-shipment');
  assert.equal(requestInit?.method, 'PUT');
  assert.deepEqual(JSON.parse(String(requestInit?.body)), {
    packages: [
      {
        weight: { value: 6, unit: 'ounce' },
        dimensions: { length: 10, width: 8, height: 2, unit: 'inch' },
      },
    ],
  });
});

test('label purchase requests a 4x6 PDF URL without downloading it', async () => {
  const originalFetch = globalThis.fetch;
  let requestUrl = '';
  let requestInit: RequestInit | undefined;
  globalThis.fetch = (async (input, init) => {
    requestUrl = String(input);
    requestInit = init;
    return new Response(JSON.stringify({
      label_id: 'se-label',
      shipment_id: 'se-shipment',
      status: 'processing',
      shipment_cost: { currency: 'usd', amount: 8 },
      insurance_cost: { currency: 'usd', amount: 0 },
    }), { status: 200 });
  }) as typeof fetch;
  try {
    const result = await createShipStationLabelFromRate('api-key', 'se-rate');
    assert.equal(result.label.status, 'processing');
    assert.equal(result.downloadUrl, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(requestUrl, 'https://api.shipstation.com/v2/labels/rates/se-rate');
  assert.equal(requestInit?.method, 'POST');
  assert.deepEqual(JSON.parse(String(requestInit?.body)), {
    label_format: 'pdf',
    label_layout: '4x6',
    label_download_type: 'url',
  });
});
