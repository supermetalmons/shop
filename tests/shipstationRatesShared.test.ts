import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  createShipStationShipment,
  getShipStationShipmentByExternalId,
  getShipStationShipmentById,
  getShipStationShipmentRates,
  parseShipStationShipFrom,
  requestShipStationShipmentRates,
  shipStationCustomsValue,
  shipStationExternalId,
  shipStationPackageInputFromShipmentPackage,
  shipStationPackageProducts,
  ShipStationRatesProviderError,
  updateShipStationShipment,
} from '../functions/src/shared/shipstationRates.ts';

const SHIP_TO = {
  name: 'Manually Corrected Recipient',
  company_name: 'Corrected Company',
  email: 'corrected@example.com',
  address_line1: '200 Corrected Ave',
  address_line2: 'Suite 4',
  city_locality: 'Istanbul',
  state_province: 'IST',
  postal_code: '34000',
  country_code: 'TR',
  address_residential_indicator: 'yes' as const,
  instructions: 'Side door',
  geolocation: [{ type: 'what3words', value: 'cats.with.thumbs' }],
};

test('shared ShipStation rates client is runtime-neutral and validates the origin secret', () => {
  const source = readFileSync(new URL('../functions/src/shared/shipstationRates.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /firebase-functions|HttpsError/);
  assert.deepEqual(parseShipStationShipFrom(JSON.stringify({
    name: 'mons.shop',
    address_line1: '1061 10th Street',
    city_locality: 'West Pittsburg',
    postal_code: '16160',
    country_code: 'us',
  })), {
    name: 'mons.shop',
    address_line1: '1061 10th Street',
    city_locality: 'West Pittsburg',
    state_province: '',
    postal_code: '16160',
    country_code: 'US',
    address_residential_indicator: 'no',
  });
  assert.throws(
    () => parseShipStationShipFrom('{}'),
    (error) => error instanceof ShipStationRatesProviderError && error.code === 'failed-precondition',
  );
});

test('shared ShipStation rates client rejects malformed and inconsistent success responses', async () => {
  const carriers = Response.json({ carriers: [{ carrier_id: 'active', send_rates: true }] });
  for (const rateResponse of [
    new Response('not-json', { status: 200 }),
    Response.json({ shipment_id: 'shipment-2', rate_request_id: 'request-1', status: 'completed', rates: [] }),
    Response.json({ shipment_id: 'shipment-1', rate_request_id: 'request-1', status: 'mystery', rates: [] }),
    Response.json({ shipment_id: 'shipment-1', status: 'working', rates: [] }),
    Response.json({ shipment_id: 'shipment-1', status: 'completed', rates: [] }),
    Response.json({ shipment_id: 'shipment-1', rate_request_id: 'request-1', status: 'completed', rates: {} }),
    Response.json({ shipment_id: 'shipment-1', rate_request_id: 'request-1', status: 'completed', invalid_rates: {} }),
    Response.json({ shipment_id: 'shipment-1', rate_request_id: 'request-1', status: 'completed', errors: {} }),
  ]) {
    let calls = 0;
    await assert.rejects(
      requestShipStationShipmentRates('api-key', 'shipment-1', {
        fetch: async () => {
          calls += 1;
          return calls === 1 ? carriers.clone() : rateResponse.clone();
        },
      }),
      (error) => error instanceof ShipStationRatesProviderError && error.code === 'unavailable',
    );
  }
});

test('shared ShipStation shipment client rejects incomplete and mismatched success responses', async () => {
  for (const payload of [
    { shipment_id: 'shipment-2', packages: [] },
    { shipment_id: 'shipment-1' },
    { packages: [] },
  ]) {
    await assert.rejects(
      getShipStationShipmentById('api-key', 'shipment-1', { fetch: async () => Response.json(payload) }),
      (error) => error instanceof ShipStationRatesProviderError && error.code === 'unavailable',
    );
    let calls = 0;
    await assert.rejects(
      updateShipStationShipment('api-key', 'shipment-1', {}, {
        fetch: async () => {
          calls += 1;
          return Response.json(payload);
        },
      }),
      (error) => error instanceof ShipStationRatesProviderError && error.code === 'unavailable',
    );
    assert.equal(calls, 1);
  }
  await assert.rejects(
    getShipStationShipmentById('api-key', 'shipment-1', {
      fetch: async () => Response.json({ shipment_id: 'shipment-1', packages: [] }),
    }),
    (error) => error instanceof ShipStationRatesProviderError && error.code === 'unavailable',
  );
});

test('shared ShipStation shipment client retains sanitized destinations from wrapped and unwrapped responses', async () => {
  const customs = {
    contents: 'gift',
    contents_explanation: 'Manually corrected contents',
    non_delivery: 'treat_as_abandoned',
    terms_of_trade_code: 'ddp',
    declaration: 'Manual declaration',
    invoice_additional_details: {
      freight_charge: { amount: 2, currency: 'usd' },
      insurance_charge: { amount: 1, currency: 'usd' },
      other_charge: { amount: 0.5, currency: 'usd' },
      other_charge_description: 'Manual handling',
      discount: { amount: 0.25, currency: 'usd' },
    },
    importer_of_record: SHIP_TO,
    pending_documents: true,
  } as const;
  for (const wrapped of [false, true]) {
    const raw = {
      shipment_id: 'shipment-1',
      ship_to: {
        ...SHIP_TO,
        name: ` ${SHIP_TO.name} `,
        address_validation_status: 'verified',
      },
      customs,
      packages: [],
    };
    const shipment = await getShipStationShipmentById('api-key', 'shipment-1', {
      fetch: async () => Response.json(wrapped ? { shipment: raw } : raw),
    });
    assert.deepEqual(shipment.ship_to, SHIP_TO);
    assert.deepEqual(shipment.customs, customs);
  }
});

test('shared ShipStation customs and products preserve complete corrections and reject malformed declarations', () => {
  const products = [{
    description: 'Manually corrected cotton shirt',
    quantity: 2,
    value: { amount: 123.45, currency: 'eur' },
    weight: { value: 11, unit: 'ounce' },
    harmonized_tariff_code: '6109.10',
    country_of_origin: 'PT',
    unit_of_measure: 'each',
    sku: 'manual-shirt',
    sku_description: 'Manual SKU description',
    mid_code: 'PTMANUAL123',
    product_url: 'https://mons.shop/manual-shirt',
    vat_rate: 0.2,
  }];
  assert.deepEqual(shipStationPackageProducts({ products }), products);
  for (const malformed of [
    [],
    [{ ...products[0], quantity: 0 }],
    [{ ...products[0], harmonized_tariff_code: '' }],
    [{ ...products[0], country_of_origin: 'Portugal' }],
    [{ ...products[0], sku: '' }],
    [{ ...products[0], value: { amount: 0, currency: 'eur' } }],
  ]) {
    assert.equal(shipStationPackageProducts({ products: malformed }), null);
  }
  assert.equal(shipStationCustomsValue({ contents: 'merchandise' }), null);
  assert.equal(shipStationCustomsValue({ contents: 'other', non_delivery: 'return_to_sender' }), null);
  assert.equal(shipStationCustomsValue({
    contents: 'merchandise',
    non_delivery: 'return_to_sender',
    terms_of_trade_code: 'invalid',
  }), null);
  assert.deepEqual(shipStationCustomsValue({
    contents: 'MERCHANDISE',
    non_delivery: 'RETURN_TO_SENDER',
    terms_of_trade_code: 'DAP',
    buyer_shipping_amount_paid: { amount: 12.34, currency: 'usd' },
    duties_paid: { amount: 3.21, currency: 'usd' },
  }), {
    contents: 'merchandise',
    non_delivery: 'return_to_sender',
    terms_of_trade_code: 'dap',
  });
});

test('shared ShipStation shipment creation and external-id adoption are bounded and runtime-neutral', async () => {
  assert.equal(shipStationExternalId('card_nft_2', 7), 'mons-card_nft_2-7');
  const requests: Array<{ method: string; path: string; body?: unknown }> = [];
  const input = {
    external_shipment_id: 'mons-card_nft_2-7',
    shipment_number: '7',
    ship_to: {
      name: 'Ivan',
      address_line1: '100 Main St',
      city_locality: 'Istanbul',
      state_province: '',
      postal_code: '34000',
      country_code: 'TR',
      address_residential_indicator: 'yes' as const,
    },
    ship_from: {
      name: 'mons.shop',
      address_line1: '1061 10th Street',
      city_locality: 'West Pittsburg',
      state_province: 'PA',
      postal_code: '16160',
      country_code: 'US',
      address_residential_indicator: 'no' as const,
    },
    packages: [{
      weight: { value: 4, unit: 'ounce' as const },
      dimensions: { length: 12, width: 9, height: 2, unit: 'inch' as const },
    }],
  };
  const created = await createShipStationShipment('api-key', input, {
    fetch: async (request, init) => {
      const url = new URL(String(request));
      requests.push({
        method: init?.method || 'GET',
        path: url.pathname,
        ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
      });
      return Response.json({ shipments: [{
        shipment_id: 'shipment-1',
        external_shipment_id: input.external_shipment_id,
        shipment_number: input.shipment_number,
        packages: input.packages,
      }] });
    },
  });
  assert.equal(created.shipment_id, 'shipment-1');
  assert.deepEqual(requests, [{
    method: 'POST',
    path: '/v2/shipments',
    body: {
      shipments: [{ ...input, create_sales_order: true, shipment_status: 'pending' }],
    },
  }]);

  const adopted = await getShipStationShipmentByExternalId('api-key', input.external_shipment_id, {
    fetch: async () => Response.json({ shipment: {
      shipment_id: 'shipment-1',
      external_shipment_id: input.external_shipment_id,
      shipment_status: 'pending',
    } }),
  });
  assert.equal(adopted?.shipment_id, 'shipment-1');
  assert.equal(await getShipStationShipmentByExternalId('api-key', input.external_shipment_id, {
    fetch: async () => Response.json({}, { status: 404 }),
  }), null);
  assert.equal(await getShipStationShipmentByExternalId('api-key', input.external_shipment_id, {
    fetch: async () => Response.json({ shipment_id: 'shipment-1', shipment_status: 'cancelled' }),
  }), null);
});

test('shared ShipStation shipment creation sanitizes provider failures and rejects malformed success', async () => {
  const input = {
    external_shipment_id: 'mons-card_nft_2-7',
    shipment_number: '7',
    ship_to: {
      name: 'Ivan',
      address_line1: '100 Main St',
      city_locality: 'Istanbul',
      state_province: '',
      postal_code: '34000',
      country_code: 'TR',
      address_residential_indicator: 'yes' as const,
    },
    ship_from: {
      name: 'mons.shop',
      address_line1: '1061 10th Street',
      city_locality: 'West Pittsburg',
      state_province: 'PA',
      postal_code: '16160',
      country_code: 'US',
      address_residential_indicator: 'no' as const,
    },
    packages: [{
      weight: { value: 4, unit: 'ounce' as const },
      dimensions: { length: 12, width: 9, height: 2, unit: 'inch' as const },
    }],
  };
  await assert.rejects(
    createShipStationShipment('api-key', input, {
      fetch: async () => Response.json({
        has_errors: true,
        shipments: [{ errors: [{ error_code: 'invalid_address', message: '100 Main St' }] }],
      }),
    }),
    (error) => error instanceof ShipStationRatesProviderError &&
      error.code === 'failed-precondition' &&
      error.message.includes('invalid_address') &&
      !error.message.includes('100 Main St'),
  );
  await assert.rejects(
    createShipStationShipment('api-key', input, {
      fetch: async () => Response.json({
        has_errors: true,
        shipments: [{ errors: [{ error_code: 'invalid address at 100 Main St' }] }],
      }),
    }),
    (error) => error instanceof ShipStationRatesProviderError &&
      error.code === 'failed-precondition' &&
      !error.message.includes('100 Main St'),
  );
  await assert.rejects(
    createShipStationShipment('api-key', input, { fetch: async () => Response.json({ shipments: [{}] }) }),
    (error) => error instanceof ShipStationRatesProviderError && error.code === 'unavailable',
  );
  for (const identity of [
    { external_shipment_id: 'mons-card_nft_2-8', shipment_number: '7' },
    { external_shipment_id: 'mons-card_nft_2-7', shipment_number: '8' },
  ]) {
    await assert.rejects(
      createShipStationShipment('api-key', input, {
        fetch: async () => Response.json({ shipments: [{ shipment_id: 'shipment-1', ...identity }] }),
      }),
      (error) => error instanceof ShipStationRatesProviderError && error.code === 'unavailable',
    );
  }
  await assert.rejects(
    getShipStationShipmentByExternalId('api-key', input.external_shipment_id, {
      fetch: async () => Response.json({
        shipment_id: 'shipment-1',
        external_shipment_id: 'mons-card_nft_2-8',
      }),
    }),
    (error) => error instanceof ShipStationRatesProviderError && error.code === 'unavailable',
  );
  await assert.rejects(
    createShipStationShipment('api-key', input, { fetch: async () => Response.json({}, { status: 408 }) }),
    (error) => error instanceof ShipStationRatesProviderError && error.code === 'deadline-exceeded',
  );
  await assert.rejects(
    getShipStationShipmentByExternalId('api-key', input.external_shipment_id, {
      fetch: async () => new Response('{}', { headers: { 'Content-Length': String(513 * 1024) } }),
    }),
    (error) => error instanceof ShipStationRatesProviderError && error.code === 'unavailable',
  );
});

test('shared ShipStation shipment errors include only safe field names', async () => {
  await assert.rejects(
    updateShipStationShipment('api-key', 'shipment-1', {}, {
      fetch: async () => Response.json({
        errors: [
          {
            error_code: 'field_value_required',
            field_name: 'ship_to',
            message: 'Recipient at 100 Private Street is missing',
          },
          {
            error_code: 'invalid_field_value',
            field_name: 'packages[0].weight.value',
            message: 'Private package data',
          },
          {
            error_code: 'field_value_required',
            field_name: 'ship_to (100 Private Street)',
            message: 'Private address data',
          },
        ],
      }, { status: 400 }),
    }),
    (error) => error instanceof ShipStationRatesProviderError &&
      error.code === 'failed-precondition' &&
      error.message.includes('field_value_required (ship_to)') &&
      error.message.includes('invalid_field_value (packages[0].weight.value)') &&
      !error.message.includes('Private'),
  );
});

test('shared ShipStation parsing never coerces provider numbers', async () => {
  assert.equal(shipStationPackageInputFromShipmentPackage({
    weight: { value: '4', unit: 'ounce' },
    dimensions: { length: 12, width: 9, height: 2, unit: 'inch' },
  }), null);
  assert.equal(shipStationPackageInputFromShipmentPackage({
    weight: { value: 4, unit: 'ounce' },
    dimensions: { length: true, width: 9, height: 2, unit: 'inch' },
  }), null);
  let calls = 0;
  const response = await requestShipStationShipmentRates('api-key', 'shipment-1', {
    fetch: async () => {
      calls += 1;
      if (calls === 1) return Response.json({ carriers: [{ carrier_id: 'carrier-1' }] });
      return Response.json({
        shipment_id: 'shipment-1',
        rate_request_id: 'request-1',
        status: 'completed',
        rates: [{
          rate_id: 'rate-1',
          shipment_id: 'shipment-1',
          validation_status: 'valid',
          shipping_amount: { currency: 'usd', amount: '10' },
          insurance_amount: { currency: 'usd', amount: 0 },
          confirmation_amount: { currency: 'usd', amount: 0 },
          other_amount: { currency: 'usd', amount: 0 },
        }],
      });
    },
  });
  assert.equal(response.rates.length, 0);
  assert.equal(response.invalidRates.length, 1);
  assert.equal(response.invalidRates[0].responseIssue, true);
});

test('shared ShipStation package parsing preserves provider measurements beyond UI limits', () => {
  assert.deepEqual(shipStationPackageInputFromShipmentPackage({
    weight: { value: 101, unit: 'pound' },
    dimensions: { length: 12, width: 9, height: 2, unit: 'inch' },
  }), { length: 12, width: 9, height: 2, weight: 1616 });
});

test('shared ShipStation rate requests preserve rate-limit, timeout, and size errors', async () => {
  await assert.rejects(
    requestShipStationShipmentRates('api-key', 'shipment-1', {
      fetch: async () => Response.json({}, { status: 408 }),
    }),
    (error) => error instanceof ShipStationRatesProviderError && error.code === 'failed-precondition',
  );
  await assert.rejects(
    requestShipStationShipmentRates('api-key', 'shipment-1', {
      fetch: async () => Response.json({ errors: [] }, { status: 429 }),
    }),
    (error) => error instanceof ShipStationRatesProviderError && error.code === 'resource-exhausted',
  );
  await assert.rejects(
    requestShipStationShipmentRates('api-key', 'shipment-1', {
      timeoutMs: 5,
      fetch: async (_input, init) => new Promise<Response>((_resolve, reject) => {
        const abort = () => reject(init?.signal?.reason);
        init?.signal?.addEventListener('abort', abort, { once: true });
      }),
    }),
    (error) => error instanceof ShipStationRatesProviderError && error.code === 'deadline-exceeded',
  );
  await assert.rejects(
    requestShipStationShipmentRates('api-key', 'shipment-1', {
      fetch: async () => new Response('{}', { headers: { 'Content-Length': String(513 * 1024) } }),
    }),
    (error) => error instanceof ShipStationRatesProviderError && error.code === 'unavailable',
  );
});

test('shared ShipStation polling treats a missing pending request as still working', async () => {
  const response = await getShipStationShipmentRates(
    'api-key',
    'shipment-1',
    { requestId: 'request-new', createdAt: '2026-08-19T00:00:00Z' },
    {
      fetch: async () => Response.json([{
        shipment_id: 'shipment-1',
        rate_request_id: 'request-old',
        status: 'completed',
        rates: [],
      }]),
    },
  );
  assert.deepEqual(response, {
    shipmentId: 'shipment-1',
    status: 'working',
    rates: [],
    invalidRates: [],
    rateRequestId: 'request-new',
    createdAt: '2026-08-19T00:00:00Z',
  });
});

test('shared ShipStation polling ignores malformed history before the requested response', async () => {
  const response = await getShipStationShipmentRates(
    'api-key',
    'shipment-1',
    { requestId: 'request-new' },
    {
      fetch: async () => Response.json([
        null,
        { shipment_id: 'shipment-old', status: 'mystery', rates: {} },
        { rate_response: [] },
        {
          shipment_id: 'shipment-1',
          rate_request_id: 'request-new',
          status: 'completed',
          rates: [],
        },
      ]),
    },
  );
  assert.equal(response.rateRequestId, 'request-new');
  assert.equal(response.status, 'completed');
});

test('shared ShipStation rates client injects fetch and bounds provider responses', async () => {
  let requestedUrl = '';
  const shipment = await getShipStationShipmentById('api-key', 'shipment-1', {
    fetch: async (input, init) => {
      requestedUrl = String(input);
      assert.equal(new Headers(init?.headers).get('API-Key'), 'api-key');
      assert.equal(init?.redirect, 'manual');
      return Response.json({ shipment_id: 'shipment-1', ship_to: SHIP_TO, packages: [] });
    },
  });
  assert.equal(requestedUrl, 'https://api.shipstation.com/v2/shipments/shipment-1');
  assert.equal(shipment.shipment_id, 'shipment-1');
  await assert.rejects(
    getShipStationShipmentById('api-key', 'shipment-1', {
      fetch: async () => new Response('{}', { headers: { 'Content-Length': String(513 * 1024) } }),
    }),
    (error) => error instanceof ShipStationRatesProviderError && error.code === 'unavailable',
  );
});

test('shared ShipStation rate shopping sends only connected rate-capable carriers', async () => {
  const requests: Array<{ path: string; body?: unknown }> = [];
  const response = await requestShipStationShipmentRates('api-key', 'shipment-1', {
    fetch: async (input, init) => {
      const url = new URL(String(input));
      requests.push({
        path: `${url.pathname}${url.search}`,
        ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
      });
      if (url.pathname === '/v2/carriers') {
        return Response.json({
          carriers: [
            { carrier_id: 'active', send_rates: true },
            { carrier_id: 'disabled', disabled_by_billing_plan: true },
          ],
        });
      }
      return Response.json({
        shipment_id: 'shipment-1',
        rate_request_id: 'request-1',
        status: 'completed',
        rates: [{
          rate_id: 'rate-1',
          carrier_id: 'active',
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
      });
    },
  });
  assert.equal(response.rates[0].rateId, 'rate-1');
  assert.deepEqual(requests, [
    { path: '/v2/carriers?page_size=50&include_extended_details=false' },
    {
      path: '/v2/rates',
      body: { shipment_id: 'shipment-1', rate_options: { carrier_ids: ['active'] } },
    },
  ]);
});
