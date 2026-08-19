import test from 'node:test';
import assert from 'node:assert/strict';
import {
  defaultShipStationPackage,
  normalizeShipStationPackage,
  parseShipStationPackage,
} from '../functions/src/shared/shipstationPackage.ts';
import {
  adoptOrPurchaseShipStationLabel,
  createShipStationLabelFromRate,
  isActiveShipStationLabel,
  shipStationErrorMessage,
  shipStationLabelResult,
  shipStationTrackingCodeUpdate,
  shouldClearShipStationPurchaseState,
  shouldTransitionShipStationPurchaseState,
  voidShipStationLabel,
} from '../functions/src/shared/shipstationLabels.ts';
import {
  buildShipStationPackages,
  getShipStationShipmentRates,
  requestShipStationShipmentRates,
  shipStationMoneyMatches,
  shipStationPackageDetails,
  shipStationPackageInputFromShipmentPackage,
  shipStationProductsTotalWeightOunces,
  shipStationRateSummaries,
  updateShipStationShipment,
} from '../functions/src/shared/shipstationRates.ts';

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

test('canonical package measurements remain strict without applying editor limits', () => {
  assert.deepEqual(
    parseShipStationPackage({ length: 12.345, width: 9, height: 2, weight: 1616 }),
    { length: 12.345, width: 9, height: 2, weight: 1616 },
  );
  assert.deepEqual(
    parseShipStationPackage({ length: 0.004, width: 9, height: 2, weight: 4 }),
    { length: 0.004, width: 9, height: 2, weight: 4 },
  );
  for (const value of ['12', true, Number.NaN, Number.POSITIVE_INFINITY, 0, -1]) {
    assert.equal(parseShipStationPackage({ length: value, width: 9, height: 2, weight: 4 }), null);
  }
});

test('an override replaces the derived parcel, and its absence falls back to the defaults', () => {
  assert.deepEqual(buildShipStationPackages(2), [
    { weight: { value: 8, unit: 'ounce' }, dimensions: { length: 12, width: 9, height: 2, unit: 'inch' } },
  ]);
  assert.deepEqual(buildShipStationPackages(2, { length: 6, width: 4, height: 1.5, weight: 10 }), [
    { weight: { value: 10, unit: 'ounce' }, dimensions: { length: 6, width: 4, height: 1.5, unit: 'inch' } },
  ]);
});

test('package updates preserve writable settings and exclude provider response fields', () => {
  const products = [{
    description: 'Manual shirt correction',
    quantity: 2,
    value: { amount: 120, currency: 'usd' },
    weight: { value: 0.5, unit: 'pound' as const },
    harmonized_tariff_code: '6109.10',
    country_of_origin: 'PT',
    sku: 'manual-shirt',
  }];
  assert.deepEqual(buildShipStationPackages(1, { length: 10, width: 8, height: 3, weight: 20 }, {
    sourcePackage: {
      package_id: 'se-3',
      package_code: 'package',
      shipment_package_id: 'se-read-only',
      package_name: 'Read-only package name',
      tracking_number: 'private-tracking-number',
      sequence: 1,
      insured_value: { amount: 50, currency: 'usd' },
      label_messages: { reference1: 'Order 7', reference2: null, reference3: 'Manual' },
      external_package_id: 'parcel-7',
      content_description: 'Manual content',
      products,
    },
  }), [{
    package_id: 'se-3',
    package_code: 'package',
    insured_value: { amount: 50, currency: 'usd' },
    label_messages: { reference1: 'Order 7', reference2: null, reference3: 'Manual' },
    external_package_id: 'parcel-7',
    content_description: 'Manual content',
    products,
    weight: { value: 20, unit: 'ounce' },
    dimensions: { length: 10, width: 8, height: 3, unit: 'inch' },
  }]);
  assert.equal(shipStationProductsTotalWeightOunces(products), 16);
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
          carrier_nickname: 'Warehouse USPS',
          service_code: 'usps_ground_advantage',
          service_type: 'Ground Advantage',
          rate_type: 'shipment',
          zone: 4,
          carrier_delivery_days: '2 business days',
          ship_date: '2026-08-06T00:00:00Z',
          negotiated_rate: true,
          trackable: true,
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
  assert.equal(response.rates[0].carrierNickname, 'Warehouse USPS');
  assert.equal(response.rates[0].rateType, 'shipment');
  assert.equal(response.rates[0].zone, 4);
  assert.equal(response.rates[0].carrierDeliveryDays, '2 business days');
  assert.equal(response.rates[0].shipDate, '2026-08-06T00:00:00Z');
  assert.equal(response.rates[0].negotiatedRate, true);
  assert.equal(response.rates[0].trackable, true);
  assert.equal('estimatedDeliveryDays' in response.rates[0], false);
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
      { ...base, rate_id: 'missing-status' },
      { ...base, rate_id: 'unexpected-status', validation_status: 'pending' },
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
  assert.deepEqual(response.invalidRates.map((rate) => rate.errorMessages), [
    ['ShipStation validation status is “invalid”.'],
    ['ShipStation validation status is “unknown”.'],
    ['ShipStation validation status is “missing”.'],
    ['ShipStation validation status is “pending”.'],
    ['The carrier rejected the address.'],
    ['The other charges amount is missing or invalid.'],
    ['The rate charges use different currencies.'],
  ]);
  assert.deepEqual(response.invalidRates.map((rate) => Boolean(rate.responseIssue)), [
    false,
    false,
    true,
    true,
    false,
    true,
    true,
  ]);
});

test('invalid ShipStation rate explanations are preserved for operators', () => {
  const response = shipStationRateSummaries({
    shipment_id: 'se-shipment',
    status: 'completed',
    rates: [],
    invalid_rates: [
      {
        carrier_id: 'se-ups',
        carrier_code: 'ups',
        carrier_friendly_name: 'UPS',
        service_code: 'ups_ground',
        service_type: 'UPS Ground',
        error_messages: ['Destination postal code is not supported'],
      },
      {
        carrier_code: 'stamps_com',
        error_messages: [],
      },
    ],
  });

  assert.deepEqual(response.invalidRates, [
    {
      carrierId: 'se-ups',
      carrierCode: 'ups',
      carrierName: 'UPS',
      serviceCode: 'ups_ground',
      serviceName: 'UPS Ground',
      errorMessages: ['The carrier rejected the postal code.'],
    },
    {
      carrierId: '',
      carrierCode: 'stamps_com',
      carrierName: 'stamps_com',
      serviceCode: '',
      serviceName: 'Service',
      errorMessages: ['ShipStation marked this service as unavailable.'],
    },
  ]);
});

test('top-level ShipStation rating errors are preserved for operators', () => {
  const response = shipStationRateSummaries({
    shipment_id: 'se-shipment',
    status: 'completed',
    rates: [],
    invalid_rates: [],
    errors: [{
      error_code: 'invalid_address',
      error_type: 'validation',
      field_name: 'shipment.ship_to.postal_code',
      error_source: 'carrier',
      carrier_id: 'se-ups-account',
      carrier_code: 'ups',
      carrier_name: 'UPS account',
      message: '12 Private Street is invalid',
    }, {
      error_code: 'unspecified',
      error_type: 'business_rules',
      error_source: 'carrier',
      carrier_id: 'se-ups-account',
      carrier_code: 'ups',
      carrier_name: 'UPS account',
      message: 'Private carrier detail',
    }],
  });

  assert.deepEqual(response.invalidRates, [
    {
      carrierId: 'se-ups-account',
      carrierCode: 'ups',
      carrierName: 'UPS account',
      serviceCode: '',
      serviceName: 'Rating',
      errorMessages: [
        'The carrier rejected the postal code. · type: validation · source: carrier',
        'unspecified · type: business_rules · source: carrier',
      ],
    },
  ]);
});

test('customs rate failures use safe operator messages without provider details', () => {
  const messages = [
    'Invalid harmonized tariff code 4911.99 for 12 Private Street',
    'Non-delivery option rejected for recipient Ivan',
    'Invalid customs contents type at 12 Private Street',
    'Country of origin PT rejected for private order',
    'Declared value 123.45 rejected for private order',
    'Product description contains private recipient details',
  ];
  const response = shipStationRateSummaries({
    shipment_id: 'se-shipment',
    status: 'completed',
    rates: [],
    invalid_rates: messages.map((message, index) => ({
      carrier_id: `se-carrier-${index}`,
      carrier_friendly_name: `Carrier ${index}`,
      error_messages: [message],
    })),
    errors: [{
      error_code: 'field_value_required',
      error_type: 'validation',
      field_name: 'shipment.packages[0].products[0].harmonized_tariff_code',
      error_source: 'carrier',
      carrier_id: 'se-field-carrier',
      carrier_name: 'Field carrier',
      message: '12 Private Street',
    }, {
      error_code: 'field_value_required',
      field_name: 'shipment.customs.contents',
      carrier_id: 'se-contents-field',
      carrier_name: 'Contents field carrier',
      message: '12 Private Street',
    }, {
      error_code: 'field_value_required',
      field_name: 'shipment.packages[0].products[0].country_of_origin',
      carrier_id: 'se-origin-field',
      carrier_name: 'Origin field carrier',
      message: '12 Private Street',
    }, {
      error_code: 'field_value_required',
      field_name: 'customs (12 Private Street)',
      carrier_id: 'se-malformed-field',
      carrier_name: 'Malformed field carrier',
      message: '12 Private Street',
    }],
  });
  assert.deepEqual(response.invalidRates.flatMap((rate) => rate.errorMessages), [
    'The carrier rejected the customs HS code. · type: validation · source: carrier',
    'The carrier rejected the customs contents type.',
    'The carrier rejected the customs country of origin.',
    'field_value_required',
    'The carrier rejected the customs HS code.',
    'The carrier rejected the customs non-delivery option.',
    'The carrier rejected the customs contents type.',
    'The carrier rejected the customs country of origin.',
    'The carrier rejected the customs declared value.',
    'The carrier rejected the customs declaration.',
  ]);
  assert.doesNotMatch(JSON.stringify(response.invalidRates), /Private Street|recipient Ivan|123\.45/);
});

test('top-level rating errors keep distinct carrier accounts without carrier ids', () => {
  const response = shipStationRateSummaries({
    shipment_id: 'se-shipment',
    status: 'completed',
    rates: [],
    errors: [
      {
        error_code: 'invalid_field_value',
        carrier_code: 'ups',
        carrier_name: 'UPS warehouse',
      },
      {
        error_code: 'invalid_field_value',
        carrier_code: 'ups',
        carrier_name: 'UPS studio',
      },
      {
        error_code: 'invalid_field_value',
        carrier_code: 'fedex',
        carrier_name: 'FedEx',
      },
      {
        error_code: 'invalid_field_value',
        carrier_code: 'dhl_express',
      },
    ],
  });

  assert.deepEqual(response.invalidRates.map((rate) => rate.carrierName), [
    'UPS warehouse',
    'UPS studio',
    'FedEx',
    'dhl_express',
  ]);
});

test('unattributed top-level errors remain visible alongside valid rates', () => {
  const response = shipStationRateSummaries({
    shipment_id: 'se-shipment',
    status: 'completed',
    rates: [{
      rate_id: 'se-rate',
      carrier_id: 'se-ups',
      carrier_code: 'ups',
      carrier_friendly_name: 'UPS',
      service_code: 'ups_ground',
      service_type: 'UPS Ground',
      validation_status: 'valid',
      shipping_amount: { currency: 'usd', amount: 10 },
      insurance_amount: { currency: 'usd', amount: 0 },
      confirmation_amount: { currency: 'usd', amount: 0 },
      other_amount: { currency: 'usd', amount: 0 },
      warning_messages: [],
      error_messages: [],
    }],
    errors: [{
      error_code: 'rating_partial_failure',
      error_type: 'system',
      error_source: 'shipstation',
    }],
  });

  assert.equal(response.rates.length, 1);
  assert.deepEqual(response.invalidRates, [{
    carrierId: '',
    carrierCode: '',
    carrierName: 'ShipStation',
    serviceCode: '',
    serviceName: 'Rating',
    errorMessages: ['rating_partial_failure · type: system · source: shipstation'],
    responseIssue: true,
  }]);
});

test('an empty ShipStation rate response reports that no details were provided', () => {
  const response = shipStationRateSummaries({
    shipment_id: 'se-shipment',
    status: 'completed',
    rates: [],
    invalid_rates: [],
    errors: null,
  });

  assert.deepEqual(response.invalidRates[0].errorMessages, [
    'ShipStation returned no rate entries or rejection details (status: completed).',
  ]);
});

test('rate shopping requests fresh rates from connected rate-capable carriers', async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    requests.push({ url, init });
    if (url.endsWith('/carriers?page_size=50&include_extended_details=false')) {
      return new Response(JSON.stringify({
        carriers: [
          { carrier_id: 'se-active', send_rates: true },
          { carrier_id: 'se-no-rates', send_rates: false },
          { carrier_id: 'se-disabled', send_rates: true, disabled_by_billing_plan: true },
          { carrier_id: 'se-pending', send_rates: true, connection_status: 'pending_approval' },
        ],
      }), { status: 200 });
    }
    return new Response(JSON.stringify({
      shipment_id: 'se-shipment',
      rate_response: {
        shipment_id: 'se-shipment',
        rate_request_id: 'se-request',
        created_at: '2026-08-06T12:00:00Z',
        status: 'completed',
        rates: [{
          rate_id: 'se-rate',
          carrier_id: 'se-active',
          carrier_code: 'ups',
          carrier_friendly_name: 'UPS',
          service_code: 'ups_ground',
          service_type: 'UPS Ground',
          validation_status: 'valid',
          shipping_amount: { currency: 'usd', amount: 10 },
          insurance_amount: { currency: 'usd', amount: 0 },
          confirmation_amount: { currency: 'usd', amount: 0 },
          other_amount: { currency: 'usd', amount: 0 },
          warning_messages: [],
          error_messages: [],
        }],
        invalid_rates: [],
        errors: [],
      },
    }), { status: 200 });
  }) as typeof fetch;
  try {
    const response = await requestShipStationShipmentRates('api-key', 'se-shipment');
    assert.deepEqual(response.rates.map((rate) => rate.rateId), ['se-rate']);
    assert.equal(response.rateRequestId, 'se-request');
    assert.equal(response.createdAt, '2026-08-06T12:00:00Z');
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(
    requests[0].url,
    'https://api.shipstation.com/v2/carriers?page_size=50&include_extended_details=false',
  );
  assert.equal(requests[1].url, 'https://api.shipstation.com/v2/rates');
  assert.equal(requests[1].init?.method, 'POST');
  assert.deepEqual(JSON.parse(String(requests[1].init?.body)), {
    shipment_id: 'se-shipment',
    rate_options: { carrier_ids: ['se-active'] },
  });
});

test('shipment rate polling selects only the expected rate request', async () => {
  const originalFetch = globalThis.fetch;
  let requestUrl = '';
  const rate = (rateId: string) => ({
    rate_id: rateId,
    carrier_id: 'se-carrier',
    carrier_code: 'ups',
    carrier_friendly_name: 'UPS',
    service_code: 'ups_ground',
    service_type: 'UPS Ground',
    validation_status: 'valid',
    shipping_amount: { currency: 'usd', amount: 10 },
    insurance_amount: { currency: 'usd', amount: 0 },
    confirmation_amount: { currency: 'usd', amount: 0 },
    other_amount: { currency: 'usd', amount: 0 },
    warning_messages: [],
    error_messages: [],
  });
  globalThis.fetch = (async (input) => {
    requestUrl = String(input);
    return new Response(JSON.stringify([
      {
        shipment_id: 'se-shipment',
        rate_request_id: 'se-old-request',
        created_at: '2026-08-06T11:00:00Z',
        status: 'completed',
        rates: [rate('se-old-rate')],
        invalid_rates: [],
        errors: [],
      },
      {
        shipment_id: 'se-shipment',
        rate_request_id: 'se-current-request',
        created_at: '2026-08-06T12:00:00Z',
        status: 'completed',
        rates: [rate('se-current-rate')],
        invalid_rates: [],
        errors: [],
      },
    ]), { status: 200 });
  }) as typeof fetch;
  try {
    const response = await getShipStationShipmentRates('api-key', 'se-shipment', {
      requestId: 'se-current-request',
      createdAt: '2026-08-06T12:00:00Z',
    });
    assert.deepEqual(response.rates.map((candidate) => candidate.rateId), ['se-current-rate']);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(
    requestUrl,
    'https://api.shipstation.com/v2/shipments/se-shipment/rates?created_at_start=2026-08-06T12%3A00%3A00Z',
  );
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
  assert.equal(shipStationLabelResult({
    label_id: 'se-label',
    shipment_id: 'se-shipment',
  }), null);
  assert.equal(shipStationLabelResult({
    label_id: 'se-label',
    shipment_id: 'se-shipment',
    status: 'queued',
  }), null);
  assert.equal(shipStationLabelResult({
    label_id: 'se-label',
    shipment_id: 'se-shipment',
    voided: true,
  }), null);
  assert.equal(shipStationLabelResult({
    label_id: 'se-label',
    shipment_id: 'se-shipment',
    status: 'queued',
    voided: true,
  }), null);
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
  assert.equal(
    shipStationErrorMessage({ errors: [{ error_code: 'invalid 12 Private Street' }] }, 'Request failed'),
    'Request failed',
  );
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

test('label purchase rejects oversized and malformed provider responses', async () => {
  await assert.rejects(
    () => createShipStationLabelFromRate('api-key', 'se-rate', {
      fetch: async () => new Response('x'.repeat(32)),
      maxResponseBytes: 16,
    }),
    /oversized response/,
  );
  await assert.rejects(
    () => createShipStationLabelFromRate('api-key', 'se-rate', {
      fetch: async () => new Response('not-json'),
    }),
    /returned an invalid label/,
  );
  for (const label of [
    { label_id: 'se-label', shipment_id: 'se-shipment' },
    { label_id: 'se-label', shipment_id: 'se-shipment', status: 'queued' },
    { label_id: 'se-label', shipment_id: 'se-shipment', voided: true },
    { label_id: 'se-label', shipment_id: 'se-shipment', status: 'queued', voided: true },
  ]) {
    await assert.rejects(
      () => createShipStationLabelFromRate('api-key', 'se-rate', {
        fetch: async () => Response.json(label),
      }),
      /returned an invalid label/,
    );
  }
});

test('label void sends the bounded ShipStation PUT request and accepts idempotent success', async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ url: String(input), init });
    return Response.json(requests.length === 1
      ? { approved: true, message: 'Refund requested' }
      : { approved: false, message: 'Already voided', reason_code: 'label_already_voided' });
  };
  assert.deepEqual(await voidShipStationLabel('api-key', 'se-label', { fetch }), { alreadyVoided: false });
  assert.deepEqual(await voidShipStationLabel('api-key', 'se-label', { fetch }), { alreadyVoided: true });
  assert.equal(requests[0].url, 'https://api.shipstation.com/v2/labels/se-label/void');
  assert.equal(requests[0].init?.method, 'PUT');
  assert.equal(requests[0].init?.body, undefined);
  assert.equal(new Headers(requests[0].init?.headers).get('api-key'), 'api-key');
});

test('label void maps provider reason codes without exposing provider messages', async () => {
  for (const [reasonCode, message] of [
    ['label_already_used', 'already been used'],
    ['label_not_found_within_void_period', 'allowed void period'],
    ['contact_carrier', 'Contact the carrier'],
    ['validation_failed', 'did not approve'],
  ] as const) {
    await assert.rejects(
      () => voidShipStationLabel('api-key', 'se-label', {
        fetch: async () => Response.json({
          approved: false,
          message: 'Private 100 Main St secret-token',
          reason_code: reasonCode,
        }),
      }),
      (error) => error instanceof Error && error.message.includes(message) && !error.message.includes('Private'),
    );
  }
});

test('label void rejects malformed, oversized, timed-out, and aborted provider responses', async () => {
  await assert.rejects(
    () => voidShipStationLabel('api-key', 'se-label', {
      fetch: async () => Response.json({ approved: 'yes' }),
    }),
    /invalid label void response/,
  );
  await assert.rejects(
    () => voidShipStationLabel('api-key', 'se-label', {
      fetch: async () => new Response('x'.repeat(32)),
      maxResponseBytes: 16,
    }),
    /oversized response/,
  );
  await assert.rejects(
    () => voidShipStationLabel('api-key', 'se-label', {
      fetch: async (_input, init) => new Promise<Response>((_resolve, reject) => {
        const abort = () => reject(init?.signal?.reason ?? new DOMException('Aborted', 'AbortError'));
        init?.signal?.addEventListener('abort', abort, { once: true });
        if (init?.signal?.aborted) abort();
      }),
      timeoutMs: 5,
    }),
    /request timed out/,
  );
  const controller = new AbortController();
  controller.abort(new DOMException('Stopped', 'AbortError'));
  await assert.rejects(
    () => voidShipStationLabel('api-key', 'se-label', {
      fetch: async (_input, init) => {
        throw init?.signal?.reason;
      },
      signal: controller.signal,
    }),
    /request timed out/,
  );
});
