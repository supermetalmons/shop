import assert from 'node:assert/strict';
import test from 'node:test';
import { CommerceWriteConflict, type CommerceDocumentData } from '../src/commerceRepository.ts';
import { ProfileReadError } from '../src/dataAccess.ts';
import { handleProfileWriteRequest } from '../src/profileWrites.ts';
import { shipStationRateInputHash } from '../src/shipstation/rates.ts';
import {
  FULFILLMENT_SHIPSTATION_RATES_PATH, NOW_MS, OTHER, OWNER, SHIP_FROM, SHIP_TO, SHIPSTATION_RATE,
  d1Dependencies, encryptedAddress, orderFixture, request,
} from './profileWriteTestSupport.ts';

function assertClaimReleased(station: CommerceDocumentData) {
  for (const key of ['ratesClaimId', 'ratesClaimedAt', 'ratesClaimedBy', 'ratesClaimFenceId']) {
    assert.equal(Object.hasOwn(station, key), false, key);
  }
}

test('ShipStation rates route refreshes a single package without replacing its ShipStation address', async t => {
  const shipStationCalls: Array<{ method: string; path: string; body?: Record<string, unknown> }> = [];
  const manuallyCorrectedShipTo = {
    ...SHIP_TO,
    name: 'Manually Corrected Recipient',
    address_line1: '200 Corrected Ave',
    address_line2: 'Suite 4',
    instructions: 'Side door',
  };
  const order = orderFixture(t, {
    addressSnapshot: {
      encrypted: 'stale-commerce-address',
      email: 'owner@example.com',
      phone: '+905551234567',
      countryCode: 'TR',
    },
    shipstation: {
      shipmentId: 'shipment-1',
      package: { length: 12, width: 9, height: 2, weight: 4 },
      packageCount: 1,
      rateQuotes: [{ rateId: 'old-rate', shipmentId: 'shipment-1', totalAmount: { amount: 9, currency: 'usd' } }],
      rateRequest: { requestId: 'old-request' },
      ratesClaimFenceId: 'old-fence',
    },
  });
  const writes: CommerceDocumentData[] = [];
  order.afterWrite = () => { writes.push(order.station()); };
  const providerFetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.hostname, 'api.shipstation.com');
    const method = init?.method || 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
    shipStationCalls.push({ method, path: `${url.pathname}${url.search}`, ...(body ? { body } : {}) });
    if (url.pathname === '/v2/labels') return Response.json({ labels: [] });
    if (url.pathname === '/v2/shipments/shipment-1' && method === 'GET') {
      return Response.json({
        shipment_id: 'shipment-1',
        ship_to: {
          ...manuallyCorrectedShipTo,
          address_validation_status: 'verified',
        },
        packages: [{
          weight: { value: 4, unit: 'ounce' },
          dimensions: { length: 12, width: 9, height: 2, unit: 'inch' },
        }],
      });
    }
    if (url.pathname === '/v2/shipments/shipment-1' && method === 'PUT') {
      return Response.json({
        shipment_id: 'shipment-1',
        ship_to: manuallyCorrectedShipTo,
        packages: [{
          weight: { value: 8, unit: 'ounce' },
          dimensions: { length: 10, width: 8, height: 3, unit: 'inch' },
        }],
      });
    }
    if (url.pathname === '/v2/carriers') {
      return Response.json({ carriers: [{ carrier_id: 'carrier-1', carrier_code: 'stamps_com', send_rates: true }] });
    }
    if (url.pathname === '/v2/rates') {
      return Response.json({
        shipment_id: 'shipment-1',
        rate_request_id: 'request-1',
        status: 'completed',
        rates: [{
          ...SHIPSTATION_RATE,
          insurance_amount: { currency: 'usd', amount: 1 },
          other_amount: { currency: 'usd', amount: 0.5 },
        }],
        invalid_rates: [],
        errors: [],
      });
    }
    return Response.json({ error: 'unexpected ShipStation request' }, { status: 500 });
  };
  const result = await handleProfileWriteRequest(
    request(FULFILLMENT_SHIPSTATION_RATES_PATH, {
      dropId: 'card_nft_2',
      deliveryId: 7,
      package: { length: 10, width: 8, height: 3, weight: 8 },
    }),
    order.env,
    FULFILLMENT_SHIPSTATION_RATES_PATH,
    {},
    d1Dependencies(providerFetch),
  );
  assert.equal(result.response.status, 200);
  const payload = await result.response.json() as {
    package: Record<string, number>;
    packageCount: number;
    rates: Array<{ rateId: string; totalAmount: { currency: string; amount: number } }>;
  };
  assert.deepEqual(payload.package, { length: 10, width: 8, height: 3, weight: 8 });
  assert.equal(payload.packageCount, 1);
  assert.equal(payload.rates[0].rateId, 'rate-1');
  assert.deepEqual(payload.rates[0].totalAmount, { currency: 'usd', amount: 11.5 });
  const shipmentUpdate = shipStationCalls.find((call) => call.method === 'PUT');
  assert.deepEqual(shipmentUpdate?.body, {
    ship_to: manuallyCorrectedShipTo,
    ship_from: SHIP_FROM,
    packages: [{
      content_description: 'Printed collectible art card',
      weight: { value: 8, unit: 'ounce' },
      dimensions: { length: 10, width: 8, height: 3, unit: 'inch' },
      products: [{
        description: 'Printed collectible art card',
        quantity: 1,
        value: { amount: 14.67, currency: 'usd' },
        weight: { value: 0.2, unit: 'ounce' },
        harmonized_tariff_code: '4911.99',
        country_of_origin: 'US',
        sku: 'card-nft-2',
      }],
    }],
    customs: {
      contents: 'merchandise',
      non_delivery: 'return_to_sender',
      terms_of_trade_code: 'dap',
    },
  });
  assert.equal(writes.length, 3);
  assert.equal(typeof writes[0].ratesClaimId, 'string');
  assert.equal(writes[0].ratesClaimedAt, NOW_MS);
  assert.equal(writes[0].ratesClaimedBy, OWNER);
  assert.equal(writes[0].rateQuotes, undefined);
  assert.equal(writes[0].ratesClaimFenceId, undefined);
  const final = order.station();
  assert.deepEqual(final.rateQuotes, [{ rateId: 'rate-1', shipmentId: 'shipment-1', totalAmount: { amount: 11.5, currency: 'usd' } }]);
  assert.equal(final.ratesUpdatedBy, OWNER);
  assert.equal(final.rateRequest, undefined);
  assertClaimReleased(final);
});

test('ShipStation rates route preserves manual declarations, repairs zeroed packages, and keeps domestic parcels', async t => {
  const run = async (scenario: {
    shipTo: Record<string, unknown>;
    sourcePackage: Record<string, unknown>;
    storedPackage: Record<string, number>;
    customs?: Record<string, unknown>;
    items?: CommerceDocumentData[];
  }) => {
    const order = orderFixture(t, {
      items: scenario.items ?? [{ kind: 'dude', refId: 1 }],
      shipstation: {
        shipmentId: 'shipment-1',
        package: scenario.storedPackage,
        packageCount: 1,
      },
    });
    let shipmentUpdate: Record<string, unknown> | undefined;
    const providerFetch: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      assert.equal(url.hostname, 'api.shipstation.com');
      const method = init?.method || 'GET';
      if (url.pathname === '/v2/labels') return Response.json({ labels: [] });
      if (url.pathname === '/v2/shipments/shipment-1' && method === 'GET') {
        return Response.json({
          shipment_id: 'shipment-1',
          ship_to: scenario.shipTo,
          packages: [scenario.sourcePackage],
          ...(scenario.customs ? { customs: scenario.customs } : {}),
        });
      }
      if (url.pathname === '/v2/shipments/shipment-1' && method === 'PUT') {
        shipmentUpdate = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return Response.json({
          shipment_id: 'shipment-1',
          ship_to: shipmentUpdate.ship_to,
          packages: shipmentUpdate.packages,
        });
      }
      if (url.pathname === '/v2/carriers') {
        return Response.json({ carriers: [{ carrier_id: 'carrier-1', carrier_code: 'stamps_com', send_rates: true }] });
      }
      if (url.pathname === '/v2/rates') {
        return Response.json({
          shipment_id: 'shipment-1',
          rate_request_id: 'request-1',
          status: 'completed',
          rates: [SHIPSTATION_RATE],
          invalid_rates: [],
          errors: [],
        });
      }
      return Response.json({ error: 'unexpected ShipStation request' }, { status: 500 });
    };
    const result = await handleProfileWriteRequest(
      request(FULFILLMENT_SHIPSTATION_RATES_PATH, { dropId: 'card_nft_2', deliveryId: 7 }),
      order.env,
      FULFILLMENT_SHIPSTATION_RATES_PATH,
      {},
      d1Dependencies(providerFetch),
    );
    assert.equal(result.response.status, 200);
    return shipmentUpdate;
  };

  const manualProduct = {
    description: 'Manual cotton art card case',
    quantity: 2,
    value: { amount: 91.25, currency: 'eur' },
    weight: { value: 2, unit: 'ounce' },
    harmonized_tariff_code: '4202.92',
    country_of_origin: 'PT',
    unit_of_measure: 'each',
    sku: 'manual-case',
    sku_description: 'Manual case correction',
    mid_code: 'PTMANUAL123',
    product_url: 'https://mons.shop/manual-case',
    vat_rate: 0.2,
  };
  const manualCustoms = {
    contents: 'gift',
    non_delivery: 'treat_as_abandoned',
    terms_of_trade_code: 'ddp',
    declaration: 'Manual declaration',
    pending_documents: true,
  };
  const manualUpdate = await run({
    shipTo: { ...SHIP_TO, address_line1: '200 Manually Corrected Ave' },
    sourcePackage: {
      package_id: 'se-3',
      package_code: 'package',
      shipment_package_id: 'se-read-only',
      package_name: 'Read only',
      tracking_number: 'private-tracking',
      weight: { value: 20, unit: 'ounce' },
      dimensions: { length: 14, width: 10, height: 4, unit: 'inch' },
      insured_value: { amount: 50, currency: 'usd' },
      label_messages: { reference1: 'Manual reference', reference2: null, reference3: null },
      external_package_id: 'parcel-7',
      content_description: 'Manual corrected contents',
      products: [manualProduct],
    },
    storedPackage: { length: 12, width: 9, height: 2, weight: 12 },
    customs: manualCustoms,
  });
  assert.deepEqual(manualUpdate, {
    ship_to: { ...SHIP_TO, address_line1: '200 Manually Corrected Ave' },
    ship_from: SHIP_FROM,
    packages: [{
      package_id: 'se-3',
      package_code: 'package',
      insured_value: { amount: 50, currency: 'usd' },
      label_messages: { reference1: 'Manual reference', reference2: null, reference3: null },
      external_package_id: 'parcel-7',
      content_description: 'Manual corrected contents',
      products: [manualProduct],
      weight: { value: 20, unit: 'ounce' },
      dimensions: { length: 14, width: 10, height: 4, unit: 'inch' },
    }],
    customs: manualCustoms,
  });

  const repairedUpdate = await run({
    shipTo: SHIP_TO,
    sourcePackage: {
      package_code: 'package',
      shipment_package_id: 'se-read-only',
      weight: { value: 0, unit: 'ounce' },
      dimensions: { length: 0, width: 0, height: 0, unit: 'inch' },
    },
    storedPackage: { length: 12, width: 9, height: 2, weight: 12 },
    items: [{ kind: 'box', refId: 1 }, { kind: 'dude', refId: 2 }],
  });
  assert.deepEqual(repairedUpdate, {
    ship_to: SHIP_TO,
    ship_from: SHIP_FROM,
    packages: [{
      package_code: 'package',
      content_description: 'Printed collectible art card',
      products: [{
        description: 'Printed collectible art card',
        quantity: 4,
        value: { amount: 14.67, currency: 'usd' },
        weight: { value: 0.2, unit: 'ounce' },
        harmonized_tariff_code: '4911.99',
        country_of_origin: 'US',
        sku: 'card-nft-2',
      }],
      weight: { value: 12, unit: 'ounce' },
      dimensions: { length: 12, width: 9, height: 2, unit: 'inch' },
    }],
    customs: {
      contents: 'merchandise',
      non_delivery: 'return_to_sender',
      terms_of_trade_code: 'dap',
    },
  });

  const domesticShipTo = {
    ...SHIP_TO,
    city_locality: 'New York',
    state_province: 'NY',
    postal_code: '10001',
    country_code: 'US',
  };
  const domesticUpdate = await run({
    shipTo: domesticShipTo,
    sourcePackage: {
      package_code: 'package',
      weight: { value: 15, unit: 'ounce' },
      dimensions: { length: 13, width: 8, height: 3, unit: 'inch' },
    },
    storedPackage: { length: 12, width: 9, height: 2, weight: 12 },
  });
  assert.deepEqual(domesticUpdate, {
    ship_to: domesticShipTo,
    ship_from: SHIP_FROM,
    packages: [{
      package_code: 'package',
      weight: { value: 15, unit: 'ounce' },
      dimensions: { length: 13, width: 8, height: 3, unit: 'inch' },
    }],
  });
});

test('ShipStation rates route rejects a parcel lighter than its declared products', async t => {
  const order = orderFixture(t, {
    shipstation: {
      shipmentId: 'shipment-1',
      package: { length: 12, width: 9, height: 2, weight: 4 },
      packageCount: 1,
    },
  });
  let updateCalls = 0;
  const providerFetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.hostname, 'api.shipstation.com');
    const method = init?.method || 'GET';
    if (url.pathname === '/v2/labels') return Response.json({ labels: [] });
    if (url.pathname === '/v2/shipments/shipment-1' && method === 'GET') {
      return Response.json({
        shipment_id: 'shipment-1',
        ship_to: SHIP_TO,
        customs: {
          contents: 'merchandise',
          non_delivery: 'return_to_sender',
          terms_of_trade_code: 'dap',
        },
        packages: [{
          content_description: 'Manual cotton T-shirt',
          weight: { value: 4, unit: 'ounce' },
          dimensions: { length: 12, width: 9, height: 2, unit: 'inch' },
          products: [{
            description: 'Manual cotton T-shirt',
            quantity: 1,
            value: { amount: 144, currency: 'usd' },
            weight: { value: 10, unit: 'ounce' },
            harmonized_tariff_code: '6109.10',
            country_of_origin: 'US',
            sku: 'manual-shirt',
          }],
        }],
      });
    }
    if (url.pathname === '/v2/shipments/shipment-1' && method === 'PUT') updateCalls += 1;
    return Response.json({ error: 'unexpected ShipStation request' }, { status: 500 });
  };
  const result = await handleProfileWriteRequest(
    request(FULFILLMENT_SHIPSTATION_RATES_PATH, { dropId: 'card_nft_2', deliveryId: 7 }),
    order.env,
    FULFILLMENT_SHIPSTATION_RATES_PATH,
    {},
    d1Dependencies(providerFetch),
  );
  assert.equal(result.response.status, 409);
  assert.deepEqual(await result.response.json(), {
    ok: false,
    error: {
      code: 'failed-precondition',
      message: 'Package weight must be at least 10 oz for the customs items in this shipment.',
    },
  });
  assert.equal(updateCalls, 0);
});

test('ShipStation rates route resumes and polls pending requests with exact delays', async t => {
  const run = async (mode: 'fresh' | 'resumed' | 'changed' | 'working') => {
    const packageWeight = mode === 'resumed' ? 1616 : 4;
    const product = {
      description: 'Printed collectible art card',
      quantity: 1,
      value: { amount: 14.67, currency: 'usd' },
      weight: { value: 0.2, unit: 'ounce' },
      harmonized_tariff_code: '4911.99',
      country_of_origin: 'US',
      sku: 'card-nft-2',
    };
    const inputHash = await shipStationRateInputHash({
      ship_to: SHIP_TO,
      ship_from: SHIP_FROM,
      packages: [{
        content_description: 'Printed collectible art card',
        products: [product],
        weight: { value: packageWeight, unit: 'ounce' },
        dimensions: { length: 12, width: 9, height: 2, unit: 'inch' },
      }],
      customs: {
        contents: 'merchandise',
        non_delivery: 'return_to_sender',
        terms_of_trade_code: 'dap',
      },
    });
    const order = orderFixture(t, {
      addressSnapshot: {
        encrypted: encryptedAddress('Ivan\n100 Main St\nIstanbul, 34000\nTurkey'),
        countryCode: 'TR',
      },
      shipstation: {
        shipmentId: 'shipment-1',
        package: { length: 12, width: 9, height: 2, weight: packageWeight },
        packageCount: 1,
        ...(mode === 'resumed' || mode === 'changed' ? {
          rateRequest: {
            requestId: 'request-1',
            createdAt: '2026-08-19T00:00:00Z',
            requestedAt: NOW_MS - 1_000,
            shipmentId: 'shipment-1',
            inputHash: mode === 'changed' ? '0'.repeat(64) : inputHash,
            package: { length: 12, width: 9, height: 2, weight: packageWeight },
          },
        } : {}),
      },
    });
    const writes: CommerceDocumentData[] = [];
    order.afterWrite = () => { writes.push(order.station()); };
    let pollCalls = 0;
    const delays: number[] = [];
    const shipStationCalls: string[] = [];
    const providerFetch: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      assert.equal(url.hostname, 'api.shipstation.com');
      const method = init?.method || 'GET';
      shipStationCalls.push(`${method} ${url.pathname}`);
      if (url.pathname === '/v2/labels') return Response.json({ labels: [] });
      if (url.pathname === '/v2/shipments/shipment-1' && method === 'GET') {
        return Response.json({
          shipment_id: 'shipment-1',
          ship_to: SHIP_TO,
          customs: {
            contents: 'merchandise',
            non_delivery: 'return_to_sender',
            terms_of_trade_code: 'dap',
          },
          packages: [{
            content_description: 'Printed collectible art card',
            weight: { value: packageWeight, unit: 'ounce' },
            dimensions: { length: 12, width: 9, height: 2, unit: 'inch' },
            products: [product],
          }],
        });
      }
      if (url.pathname === '/v2/shipments/shipment-1' && method === 'PUT') {
        return Response.json({
          shipment_id: 'shipment-1',
          packages: [{
            weight: { value: packageWeight, unit: 'ounce' },
            dimensions: { length: 12, width: 9, height: 2, unit: 'inch' },
          }],
        });
      }
      if (url.pathname === '/v2/carriers') {
        return Response.json({ carriers: [{ carrier_id: 'carrier-1', carrier_code: 'stamps_com' }] });
      }
      if (url.pathname === '/v2/rates' && method === 'POST') {
        return Response.json({
          shipment_id: 'shipment-1',
          rate_request_id: 'request-1',
          created_at: '2026-08-19T00:00:00Z',
          status: 'working',
          rates: [],
        });
      }
      if (url.pathname === '/v2/shipments/shipment-1/rates') {
        pollCalls += 1;
        const completed = mode === 'resumed' || mode === 'changed' || (mode === 'fresh' && pollCalls === 3);
        return Response.json([{
          shipment_id: 'shipment-1',
          rate_request_id: 'request-1',
          created_at: '2026-08-19T00:00:00Z',
          status: completed ? 'completed' : 'working',
          rates: completed ? [SHIPSTATION_RATE] : [],
        }]);
      }
      return Response.json({ error: 'unexpected ShipStation request' }, { status: 500 });
    };
    const result = await handleProfileWriteRequest(
      request(FULFILLMENT_SHIPSTATION_RATES_PATH, { dropId: 'card_nft_2', deliveryId: 7 }),
      order.env,
      FULFILLMENT_SHIPSTATION_RATES_PATH,
      {},
      d1Dependencies(providerFetch, {
        pauseForRatePoll: async (_signal, delayMs) => { delays.push(delayMs); },
      }),
    );
    return { writes, delays, result, shipStationCalls };
  };

  const fresh = await run('fresh');
  assert.equal(fresh.result.response.status, 200);
  assert.deepEqual(fresh.delays, [400, 800, 1200]);
  assert.equal(fresh.writes.length, 4);
  assert.equal((fresh.writes[2].rateRequest as CommerceDocumentData).requestId, 'request-1');
  assert.equal(fresh.writes[3].rateRequest, undefined);

  const resumed = await run('resumed');
  assert.equal(resumed.result.response.status, 200);
  assert.deepEqual(resumed.delays, []);
  assert.equal(resumed.shipStationCalls.some((call) => call === 'GET /v2/carriers'), false);
  assert.equal(resumed.shipStationCalls.some((call) => call === 'POST /v2/rates'), false);

  const changed = await run('changed');
  assert.equal(changed.result.response.status, 200);
  assert.equal(changed.shipStationCalls.some((call) => call === 'GET /v2/carriers'), true);
  assert.equal(changed.shipStationCalls.some((call) => call === 'POST /v2/rates'), true);

  const working = await run('working');
  assert.equal(working.result.response.status, 502);
  assert.equal((await working.result.response.json() as { error: { code: string } }).error.code, 'unavailable');
  assert.deepEqual(working.delays, [400, 800, 1200]);
  const pending = working.writes.at(-1)!;
  assert.equal((pending.rateRequest as CommerceDocumentData).requestId, 'request-1');
  assertClaimReleased(pending);
});

test('ShipStation rates route maps rate limits, timeouts, and oversized responses', async t => {
  const run = async (mode: 'rate-limit' | 'timeout' | 'empty' | 'oversized') => {
    const order = orderFixture(t, {
      addressSnapshot: {
        encrypted: encryptedAddress('Ivan\n100 Main St\nIstanbul, 34000\nTurkey'),
        countryCode: 'TR',
      },
      shipstation: {
        shipmentId: 'shipment-1',
        package: { length: 12, width: 9, height: 2, weight: 4 },
        packageCount: 1,
      },
    });
    const providerFetch: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      assert.equal(url.hostname, 'api.shipstation.com');
      const method = init?.method || 'GET';
      if (url.pathname === '/v2/labels') return Response.json({ labels: [] });
      if (url.pathname === '/v2/shipments/shipment-1') {
        return Response.json({
          shipment_id: 'shipment-1',
          ship_to: SHIP_TO,
          packages: [{
            weight: { value: 4, unit: 'ounce' },
            dimensions: { length: 12, width: 9, height: 2, unit: 'inch' },
          }],
        });
      }
      if (url.pathname === '/v2/carriers') {
        if (mode === 'rate-limit') return Response.json({ errors: [] }, { status: 429 });
        if (mode === 'empty' || mode === 'oversized') {
          return Response.json({ carriers: [] }, mode === 'oversized' ? { headers: { 'Content-Length': String(513 * 1024) } } : undefined);
        }
        return new Promise<Response>((_resolve, reject) => {
          const abort = () => reject(init?.signal?.reason);
          init?.signal?.addEventListener('abort', abort, { once: true });
        });
      }
      return Response.json({ error: `unexpected ${method} ${url.pathname}` }, { status: 500 });
    };
    return handleProfileWriteRequest(
      request(FULFILLMENT_SHIPSTATION_RATES_PATH, { dropId: 'card_nft_2', deliveryId: 7 }),
      order.env,
      FULFILLMENT_SHIPSTATION_RATES_PATH,
      {},
      d1Dependencies(providerFetch, { ...(mode === 'timeout' ? { timeoutMs: 50 } : {}) }),
    );
  };

  for (const [mode, status, code] of [
    ['rate-limit', 429, 'resource-exhausted'],
    ['timeout', 504, 'deadline-exceeded'],
    ['empty', 409, 'failed-precondition'],
    ['oversized', 502, 'unavailable'],
  ] as const) {
    const result = await run(mode);
    assert.equal(result.response.status, status, mode);
    assert.equal((await result.response.json() as { error: { code: string } }).error.code, code, mode);
  }
});

test('ShipStation rates route rejects a fresh foreign claim before reading a multi-package shipment', async t => {
  let shipmentReads = 0;
  const order = orderFixture(t, {
    shipstation: {
      shipmentId: 'shipment-1',
      ratesClaimId: 'foreign-claim',
      ratesClaimedAt: NOW_MS - 1_000,
      ratesClaimedBy: OTHER,
    },
  });
  const initial = order.read();
  const write = t.mock.fn(() => {});
  order.beforeWrite = write;
  const providerFetch: typeof fetch = async (input) => {
    const url = new URL(String(input));
    assert.equal(url.hostname, 'api.shipstation.com');
    if (url.pathname === '/v2/labels') return Response.json({ labels: [] });
    if (url.pathname === '/v2/shipments/shipment-1') {
      shipmentReads += 1;
      return Response.json({ shipment_id: 'shipment-1', packages: [{}, {}] });
    }
    return Response.json({ error: 'unexpected ShipStation request' }, { status: 500 });
  };
  const result = await handleProfileWriteRequest(
    request(FULFILLMENT_SHIPSTATION_RATES_PATH, { dropId: 'card_nft_2', deliveryId: 7 }),
    order.env,
    FULFILLMENT_SHIPSTATION_RATES_PATH,
    {},
    d1Dependencies(providerFetch),
  );
  assert.equal(result.response.status, 409);
  assert.equal(shipmentReads, 0);
  assert.equal(write.mock.callCount(), 0);
  assert.deepEqual(order.read(), initial);
});

test('ShipStation rates route rejects same-id label state changes', async t => {
  const previousLabel = { labelId: 'label-1', shipmentId: 'shipment-1', status: 'error', trackingNumber: 'old-tracking' };
  const updatedLabel = { ...previousLabel, status: 'voided', trackingNumber: 'new-tracking' };
  const order = orderFixture(t, { shipstation: { shipmentId: 'shipment-1', label: previousLabel } });
  order.afterWrite = () => {
    order.afterWrite = undefined;
    assert.equal(typeof order.station().ratesClaimId, 'string');
    return order.patch({ shipstation: { ...order.station(), label: updatedLabel } });
  };
  const providerFetch: typeof fetch = async (input) => {
    const url = new URL(String(input));
    assert.equal(url.hostname, 'api.shipstation.com');
    if (url.pathname === '/v2/labels') return Response.json({ labels: [] });
    if (url.pathname === '/v2/shipments/shipment-1') {
      return Response.json({
        shipment_id: 'shipment-1',
        ship_to: SHIP_TO,
        packages: [{
          weight: { value: 4, unit: 'ounce' },
          dimensions: { length: 12, width: 9, height: 2, unit: 'inch' },
        }],
      });
    }
    return Response.json({ error: 'unexpected ShipStation request' }, { status: 500 });
  };
  const result = await handleProfileWriteRequest(
    request(FULFILLMENT_SHIPSTATION_RATES_PATH, { dropId: 'card_nft_2', deliveryId: 7 }),
    order.env,
    FULFILLMENT_SHIPSTATION_RATES_PATH,
    {},
    d1Dependencies(providerFetch),
  );
  assert.equal(result.response.status, 409);
  assert.equal((await result.response.json() as { error: { code: string } }).error.code, 'aborted');
  assert.deepEqual(order.station().label, updatedLabel);
  assertClaimReleased(order.station());
});

test('ShipStation rates route stops when an updated shipment becomes multi-package', async t => {
  const order = orderFixture(t, { shipstation: { shipmentId: 'shipment-1', packageCount: 1,
    package: { length: 12, width: 9, height: 2, weight: 4 }, rateQuotes: [{ rateId: 'stale' }],
    rateRequest: { requestId: 'pending' } } });
  const shipStationPaths: string[] = [];
  const providerFetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.hostname, 'api.shipstation.com');
    const method = init?.method || 'GET';
    shipStationPaths.push(`${method} ${url.pathname}`);
    if (url.pathname === '/v2/labels') return Response.json({ labels: [] });
    if (url.pathname === '/v2/shipments/shipment-1' && method === 'GET') {
      return Response.json({
        shipment_id: 'shipment-1',
        ship_to: SHIP_TO,
        packages: [{
          weight: { value: 4, unit: 'ounce' },
          dimensions: { length: 12, width: 9, height: 2, unit: 'inch' },
        }],
      });
    }
    if (url.pathname === '/v2/shipments/shipment-1' && method === 'PUT') {
      return Response.json({ shipment_id: 'shipment-1', packages: [{}, {}] });
    }
    return Response.json({ error: 'unexpected ShipStation request' }, { status: 500 });
  };
  const result = await handleProfileWriteRequest(
    request(FULFILLMENT_SHIPSTATION_RATES_PATH, { dropId: 'card_nft_2', deliveryId: 7 }),
    order.env,
    FULFILLMENT_SHIPSTATION_RATES_PATH,
    {},
    d1Dependencies(providerFetch),
  );
  assert.equal(result.response.status, 200);
  assert.deepEqual(await result.response.json(), {
    deliveryId: 7,
    shipmentId: 'shipment-1',
    packageCount: 2,
    rates: [],
    invalidRates: [],
  });
  assert.deepEqual(order.station(), { shipmentId: 'shipment-1', packageCount: 2 });
  assert.equal(shipStationPaths.some((path) => path.includes('/v2/rates') || path.includes('/v2/carriers')), false);
});

test('ShipStation rates route rejects concurrent label, purchase, and claim changes', async t => {
  for (const race of ['label', 'purchase', 'claim'] as const) {
    const order = orderFixture(t, { shipstation: { shipmentId: 'shipment-1' } });
    const writeAfterReplacement = t.mock.fn(() => {});
    const replacement: CommerceDocumentData = race === 'label'
      ? { label: { labelId: 'label-new', shipmentId: 'shipment-1', status: 'completed', purchasedAt: NOW_MS } }
      : race === 'purchase'
        ? { labelPurchase: { status: 'purchasing', requestId: 'purchase-new' } }
        : { ratesClaimId: 'claim-new', ratesClaimedAt: NOW_MS, ratesClaimedBy: OTHER };
    order.afterWrite = async () => {
      order.afterWrite = undefined;
      assert.equal(typeof order.station().ratesClaimId, 'string');
      await order.patch({ shipstation: { ...order.station(), ...replacement } });
      order.beforeWrite = writeAfterReplacement;
    };
    const shipStationPaths: string[] = [];
    const providerFetch: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      assert.equal(url.hostname, 'api.shipstation.com');
      const method = init?.method || 'GET';
      shipStationPaths.push(`${method} ${url.pathname}`);
      if (url.pathname === '/v2/labels') return Response.json({ labels: [] });
      if (url.pathname === '/v2/shipments/shipment-1') {
        return Response.json({
          shipment_id: 'shipment-1',
          ship_to: SHIP_TO,
          packages: [{
            weight: { value: 4, unit: 'ounce' },
            dimensions: { length: 12, width: 9, height: 2, unit: 'inch' },
          }],
        });
      }
      return Response.json({ error: 'unexpected ShipStation request' }, { status: 500 });
    };
    const result = await handleProfileWriteRequest(
      request(FULFILLMENT_SHIPSTATION_RATES_PATH, { dropId: 'card_nft_2', deliveryId: 7 }),
      order.env,
      FULFILLMENT_SHIPSTATION_RATES_PATH,
      {},
      d1Dependencies(providerFetch),
    );
    assert.equal(result.response.status, 409, race);
    assert.equal((await result.response.json() as { error: { code: string } }).error.code, 'aborted', race);
    assert.equal(writeAfterReplacement.mock.callCount(), race === 'claim' ? 0 : 1, race);
    for (const [key, value] of Object.entries(replacement)) assert.deepEqual(order.station()[key], value, race);
    if (race !== 'claim') assertClaimReleased(order.station());
    assert.equal(shipStationPaths.some((path) => path.includes('/v2/rates') || path.includes('/v2/carriers')), false);
  }
});

test('ShipStation rates route preserves purchase, package-count, and refresh-claim guards', async t => {
  let multiPackage = false;
  const order = orderFixture(t, { addressSnapshot: {}, shipstation: { shipmentId: 'shipment-1', labelPurchase: { status: 'unknown' } } });
  let writes = 0;
  order.afterWrite = () => { writes += 1; };
  const providerFetch: typeof fetch = async (input) => {
    const url = new URL(String(input));
    assert.equal(url.hostname, 'api.shipstation.com');
    if (url.pathname === '/v2/labels') return Response.json({ labels: [] });
    if (url.pathname === '/v2/shipments/shipment-1') {
      return Response.json({
        shipment_id: 'shipment-1',
        ship_to: SHIP_TO,
        packages: multiPackage
          ? [{ weight: {}, dimensions: {} }, { weight: {}, dimensions: {} }]
          : [{
              weight: { value: 4, unit: 'ounce' },
              dimensions: { length: 12, width: 9, height: 2, unit: 'inch' },
            }],
      });
    }
    return Response.json({ error: 'unexpected' }, { status: 500 });
  };
  const invoke = () => handleProfileWriteRequest(
    request(FULFILLMENT_SHIPSTATION_RATES_PATH, { dropId: 'card_nft_2', deliveryId: 7 }),
    order.env,
    FULFILLMENT_SHIPSTATION_RATES_PATH,
    {},
    d1Dependencies(providerFetch),
  );
  const purchase = await invoke();
  assert.equal(purchase.response.status, 200);
  assert.equal((await purchase.response.json() as { purchaseUnknown: boolean }).purchaseUnknown, true);
  assert.equal(writes, 0);
  multiPackage = true;
  await order.patch({ shipstation: { shipmentId: 'shipment-1' } });
  const multi = await invoke();
  assert.equal(multi.response.status, 200);
  assert.equal((await multi.response.json() as { packageCount: number }).packageCount, 2);
  assert.equal(writes, 2);
  await order.patch({ shipstation: { shipmentId: 'shipment-1', ratesClaimedAt: NOW_MS - 1_000, ratesClaimedBy: OTHER } });
  writes = 0;
  const claimed = await invoke();
  assert.equal(claimed.response.status, 409);
  assert.equal((await claimed.response.json() as { error: { code: string } }).error.code, 'aborted');
  assert.equal(writes, 0);
  const missingOrigin = await handleProfileWriteRequest(
    request(FULFILLMENT_SHIPSTATION_RATES_PATH, { dropId: 'card_nft_2', deliveryId: 7 }),
    { ...order.env, SHIPSTATION_SHIP_FROM: '' },
    FULFILLMENT_SHIPSTATION_RATES_PATH,
    {},
    d1Dependencies(providerFetch),
  );
  assert.equal(missingOrigin.response.status, 409);
  assert.equal((await missingOrigin.response.json() as { error: { code: string } }).error.code, 'failed-precondition');
  assert.equal(missingOrigin.authOutcome, 'provider-failure');
});

test('ShipStation rates route safely releases its own claim after an upstream failure', async t => {
  const order = orderFixture(t, { shipstation: { shipmentId: 'shipment-1' } });
  const statesAtShipmentPut: CommerceDocumentData[] = [];
  const providerFetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.hostname, 'api.shipstation.com');
    if (url.pathname === '/v2/labels') return Response.json({ labels: [] });
    if (url.pathname === '/v2/shipments/shipment-1' && (init?.method || 'GET') === 'GET') {
      return Response.json({
        shipment_id: 'shipment-1',
        ship_to: SHIP_TO,
        packages: [{
          weight: { value: 4, unit: 'ounce' },
          dimensions: { length: 12, width: 9, height: 2, unit: 'inch' },
        }],
      });
    }
    if (url.pathname === '/v2/shipments/shipment-1' && init?.method === 'PUT') {
      statesAtShipmentPut.push(order.station());
      return Response.json({ errors: [{ error_code: 'server_error' }] }, { status: 503 });
    }
    return Response.json({ error: 'unexpected ShipStation request' }, { status: 500 });
  };
  const result = await handleProfileWriteRequest(
    request(FULFILLMENT_SHIPSTATION_RATES_PATH, { dropId: 'card_nft_2', deliveryId: 7 }),
    order.env,
    FULFILLMENT_SHIPSTATION_RATES_PATH,
    {},
    d1Dependencies(providerFetch),
  );
  assert.equal(result.response.status, 502);
  assert.equal((await result.response.json() as { error: { code: string } }).error.code, 'unavailable');
  assert.equal(statesAtShipmentPut.length, 1);
  const [claimed] = statesAtShipmentPut;
  assert.ok(typeof claimed.ratesClaimId === 'string' && claimed.ratesClaimId.length > 0);
  assert.equal(claimed.ratesClaimedBy, OWNER);
  assert.equal(claimed.ratesClaimedAt, NOW_MS);
  assert.deepEqual(order.station(), { shipmentId: 'shipment-1' });
});

const labelListOnly: typeof fetch = async (input) => {
  const url = new URL(String(input));
  assert.equal(url.hostname, 'api.shipstation.com');
  assert.equal(url.pathname, '/v2/labels');
  return Response.json({ labels: [] });
};

test('ShipStation rates route releases a claim whose successful commit response was lost', async t => {
  for (const failure of ['lost-reply', 'write-conflict'] as const) {
    const order = orderFixture(t, { shipstation: { shipmentId: 'shipment-1' } });
    let claimPersisted = false;
    order.afterWrite = () => {
      order.afterWrite = undefined;
      claimPersisted = typeof order.station().ratesClaimId === 'string';
      if (failure === 'write-conflict') throw new CommerceWriteConflict();
      throw new TypeError('connection closed after commit');
    };
    const result = await handleProfileWriteRequest(
      request(FULFILLMENT_SHIPSTATION_RATES_PATH, { dropId: 'card_nft_2', deliveryId: 7 }),
      order.env,
      FULFILLMENT_SHIPSTATION_RATES_PATH,
      {},
      d1Dependencies(labelListOnly, { timeoutMs: 2_000 }),
    );
    const expected = failure === 'write-conflict' ? { status: 409, code: 'aborted' } : { status: 500, code: 'internal' };
    assert.equal(result.response.status, expected.status, failure);
    assert.equal((await result.response.json() as { error: { code: string } }).error.code, expected.code, failure);
    assert.equal(claimPersisted, true);
    assert.deepEqual(order.station(), { shipmentId: 'shipment-1' });
  }
});

test('ShipStation rates route releases a claim that becomes visible during cleanup', async t => {
  const initial = { shipmentId: 'shipment-1' };
  const order = orderFixture(t, { shipstation: initial });
  let pending: CommerceDocumentData;
  let cleanupReads = 0;
  order.afterWrite = async () => {
    order.afterWrite = undefined;
    pending = order.station();
    assert.equal(typeof pending.ratesClaimId, 'string');
    await order.patch({ shipstation: initial });
    order.afterRead = () => {
      cleanupReads += 1;
      if (cleanupReads === 1) return order.patch({ shipstation: pending });
    };
    throw new ProfileReadError('unavailable', 502, 'The claim commit response was lost.');
  };
  const result = await handleProfileWriteRequest(
    request(FULFILLMENT_SHIPSTATION_RATES_PATH, { dropId: 'card_nft_2', deliveryId: 7 }),
    order.env,
    FULFILLMENT_SHIPSTATION_RATES_PATH,
    {},
    d1Dependencies(labelListOnly, { timeoutMs: 2_000 }),
  );
  assert.equal(result.response.status, 502);
  assert.equal(cleanupReads, 2);
  assert.deepEqual(order.station(), initial);
});

test('ShipStation rates route never releases a replacement claim', async t => {
  const order = orderFixture(t, { shipstation: { shipmentId: 'shipment-1' } });
  const replacement = { ratesClaimId: 'replacement-claim', ratesClaimedBy: OTHER, ratesClaimedAt: NOW_MS };
  const writeAfterReplacement = t.mock.fn(() => {});
  const providerFetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.hostname, 'api.shipstation.com');
    if (url.pathname === '/v2/labels') return Response.json({ labels: [] });
    if (url.pathname === '/v2/shipments/shipment-1' && (init?.method || 'GET') === 'GET') {
      return Response.json({
        shipment_id: 'shipment-1',
        ship_to: SHIP_TO,
        packages: [{
          weight: { value: 4, unit: 'ounce' },
          dimensions: { length: 12, width: 9, height: 2, unit: 'inch' },
        }],
      });
    }
    if (url.pathname === '/v2/shipments/shipment-1' && init?.method === 'PUT') {
      await order.patch({ shipstation: { ...order.station(), ...replacement } });
      order.beforeWrite = writeAfterReplacement;
      return Response.json({ errors: [{ error_code: 'server_error' }] }, { status: 503 });
    }
    return Response.json({ error: 'unexpected ShipStation request' }, { status: 500 });
  };
  const result = await handleProfileWriteRequest(
    request(FULFILLMENT_SHIPSTATION_RATES_PATH, { dropId: 'card_nft_2', deliveryId: 7 }),
    order.env,
    FULFILLMENT_SHIPSTATION_RATES_PATH,
    {},
    d1Dependencies(providerFetch),
  );
  assert.equal(result.response.status, 502);
  assert.equal(writeAfterReplacement.mock.callCount(), 0);
  assert.deepEqual(order.station(), { shipmentId: 'shipment-1', ...replacement });
});
