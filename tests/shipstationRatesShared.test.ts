import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  getShipStationShipmentById,
  getShipStationShipmentRates,
  parseShipStationShipFrom,
  requestShipStationShipmentRates,
  shipStationPackageInputFromShipmentPackage,
  ShipStationRatesProviderError,
  updateShipStationShipment,
} from '../functions/src/shared/shipstationRates.ts';

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
      return Response.json({ shipment_id: 'shipment-1', packages: [] });
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
