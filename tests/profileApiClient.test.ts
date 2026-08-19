import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import test from 'node:test';
import { profileApiTestHooks } from '../src/lib/api.ts';

const OWNER = 'kPG2L5zuxqNkvWvJNptbkqnPhk4nGjnGp7jwDFZPQgx';

test('profile API client sends bearer JSON without caching and refreshes once after 401', async () => {
  const refreshes: boolean[] = [];
  const authorizations: string[] = [];
  const signals: AbortSignal[] = [];
  let calls = 0;
  const payload = await profileApiTestHooks.requestProfileApi(
    '/profile/shipments',
    { ownerWallet: OWNER },
    {
      fetch: async (input, init) => {
        calls += 1;
        assert.equal(String(input), 'https://api.mons.shop/profile/shipments');
        assert.equal(init?.method, 'POST');
        assert.equal(init?.cache, 'no-store');
        const signal = init?.signal;
        assert.ok(signal);
        signals.push(signal);
        assert.deepEqual(JSON.parse(String(init?.body)), { ownerWallet: OWNER });
        const headers = new Headers(init?.headers);
        assert.equal(headers.get('content-type'), 'application/json');
        authorizations.push(headers.get('authorization') || '');
        return calls === 1
          ? Response.json({ ok: false, error: { code: 'unauthenticated', message: 'Expired.' } }, { status: 401 })
          : Response.json({ responseMode: 'shipments', wallet: OWNER, orders: [] });
      },
      getToken: async (forceRefresh) => {
        refreshes.push(forceRefresh);
        return forceRefresh ? 'fresh-token' : 'cached-token';
      },
      origin: () => 'https://api.mons.shop',
      timeoutMs: 1000,
    },
  );
  assert.deepEqual(payload, { responseMode: 'shipments', wallet: OWNER, orders: [] });
  assert.deepEqual(refreshes, [false, true]);
  assert.deepEqual(authorizations, ['Bearer cached-token', 'Bearer fresh-token']);
  assert.equal(signals[0], signals[1]);
});

test('profile API client applies its deadline to token retrieval and returns a stable error', async () => {
  let fetchCalled = false;
  await assert.rejects(
    profileApiTestHooks.requestProfileApi('/fulfillment/shipstation-rates', {}, {
      fetch: async () => {
        fetchCalled = true;
        return Response.json({});
      },
      getToken: async () => new Promise<string>(() => undefined),
      origin: () => 'https://api.mons.shop',
      timeoutMs: 10,
    }),
    (error) => {
      const value = error as { code?: unknown; message?: unknown };
      return value.code === 'deadline-exceeded' && value.message === 'Profile API request timed out.';
    },
  );
  assert.equal(fetchCalled, false);
});

test('profile API client preserves stable error codes and rejects malformed JSON', async () => {
  await assert.rejects(
    profileApiTestHooks.requestProfileApi(
      '/admin/profile',
      { ownerWallet: OWNER },
      {
        fetch: async () => Response.json({
          ok: false,
          error: { code: 'permission-denied', message: 'Admin access denied.', details: { reason: 'wallet' } },
        }, { status: 403 }),
        getToken: async () => 'token',
        origin: () => 'https://api.mons.shop',
        timeoutMs: 1000,
      },
    ),
    (error) => {
      const value = error as { code?: unknown; message?: unknown; details?: unknown };
      return value.code === 'permission-denied' &&
        value.message === 'Admin access denied.' &&
        JSON.stringify(value.details) === JSON.stringify({ reason: 'wallet' });
    },
  );

  await assert.rejects(
    profileApiTestHooks.requestProfileApi(
      '/profile/anonymous-stripe-delivery-history',
      {},
      {
        fetch: async () => new Response('not-json', { status: 200 }),
        getToken: async () => 'token',
        origin: () => 'https://api.mons.shop',
        timeoutMs: 1000,
      },
    ),
    (error) => (error as { code?: unknown }).code === 'unavailable',
  );
});

test('profile API client summary validator accepts only exact shipment summaries', () => {
  const order = {
    dropId: 'card_nft_2',
    deliveryId: 7,
    status: 'ready_to_ship',
    items: [{ kind: 'box', refId: 3 }],
  };
  assert.deepEqual(profileApiTestHooks.profileOrders([order]), [order]);
  assert.equal(profileApiTestHooks.profileOrders([{ ...order, deliveryId: 0 }]), null);
  assert.equal(profileApiTestHooks.profileOrders({}), null);
});

test('profile state client sends an exact authenticated request and validates independent sections', async () => {
  const payload = await profileApiTestHooks.requestProfileApi(
    '/profile/state',
    {},
    {
      fetch: async (input, init) => {
        assert.equal(String(input), 'https://api.mons.shop/profile/state');
        assert.equal(init?.method, 'POST');
        assert.deepEqual(JSON.parse(String(init?.body)), {});
        return Response.json({
          responseMode: 'profile-state',
          sessionWallet: OWNER,
          profile: { status: 'ready', value: { wallet: OWNER, email: 'owner@example.com' } },
          shipments: { status: 'error', error: { code: 'unavailable', message: 'Shipments unavailable.' } },
        });
      },
      getToken: async () => 'token',
      origin: () => 'https://api.mons.shop',
      timeoutMs: 1000,
    },
  );
  assert.deepEqual(profileApiTestHooks.parseProfileState(payload), payload);
});

test('profile API retries one 401 with a fresh token and then fails terminally', async () => {
  const refreshes: boolean[] = [];
  let calls = 0;
  await assert.rejects(
    profileApiTestHooks.requestProfileApi('/profile/state', {}, {
      fetch: async () => {
        calls += 1;
        return Response.json({
          ok: false,
          error: { code: 'unauthenticated', message: 'Authentication is required.' },
        }, { status: 401 });
      },
      getToken: async (forceRefresh) => {
        refreshes.push(forceRefresh);
        return forceRefresh ? 'fresh-token' : 'cached-token';
      },
      origin: () => 'https://api.mons.shop',
      timeoutMs: 1000,
    }),
    (error) => (error as { code?: unknown }).code === 'unauthenticated',
  );
  assert.equal(calls, 2);
  assert.deepEqual(refreshes, [false, true]);
});

test('admin and fulfillment reads use authenticated Cloudflare routes without callable fallbacks', () => {
  const source = readFileSync(new URL('../src/lib/api.ts', import.meta.url), 'utf8');
  for (const [exportName, pathname] of [
    ['listDeliveryOrderOwners', '/admin/delivery-order-owners'],
    ['listFulfillmentOrders', '/fulfillment/orders'],
    ['listFulfillmentManualReviewCheckouts', '/fulfillment/manual-review-checkouts'],
  ] as const) {
    const start = source.indexOf(`export async function ${exportName}`);
    const end = source.indexOf('\nexport ', start + 1);
    assert.notEqual(start, -1);
    const implementation = source.slice(start, end === -1 ? source.length : end);
    assert.match(implementation, new RegExp(pathname.replaceAll('/', '\\/')));
    assert.doesNotMatch(implementation, /callFunction|httpsCallable/);
  }
});

test('migrated fulfillment actions use authenticated Cloudflare routes without callable fallbacks', () => {
  const source = readFileSync(new URL('../src/lib/api.ts', import.meta.url), 'utf8');
  for (const [exportName, pathname] of [
    ['saveEncryptedAddress', '/profile/addresses'],
    ['updateFulfillmentAddress', '/fulfillment/order-address'],
    ['updateFulfillmentStatus', '/fulfillment/order-status'],
    ['getFulfillmentShipStationLabel', '/fulfillment/shipstation-label'],
    ['purchaseFulfillmentShipStationLabel', '/fulfillment/shipstation-label-purchase'],
    ['getFulfillmentShipStationRates', '/fulfillment/shipstation-rates'],
    ['addFulfillmentOrderToShipStation', '/fulfillment/shipstation-shipment'],
  ] as const) {
    const start = source.indexOf(`export async function ${exportName}`);
    const end = source.indexOf('\nexport ', start + 1);
    assert.notEqual(start, -1);
    const implementation = source.slice(start, end === -1 ? source.length : end);
    assert.match(implementation, new RegExp(pathname.replaceAll('/', '\\/')));
    assert.doesNotMatch(implementation, /callFunction|httpsCallable/);
  }
  assert.equal(profileApiTestHooks.profileApiTimeoutMs('/fulfillment/shipstation-label'), 50_000);
  assert.equal(profileApiTestHooks.profileApiTimeoutMs('/fulfillment/shipstation-label-purchase'), 65_000);
  assert.equal(profileApiTestHooks.profileApiTimeoutMs('/fulfillment/shipstation-rates'), 65_000);
  assert.equal(profileApiTestHooks.profileApiTimeoutMs('/fulfillment/shipstation-shipment'), 65_000);
  assert.equal(profileApiTestHooks.profileApiTimeoutMs('/fulfillment/order-address'), 20_000);
});

test('migrated write response validators accept only exact public contracts', () => {
  const shipment = {
    deliveryId: 7,
    shipmentId: 'shipment-1',
    alreadyAdded: false,
    shipstationAddedAt: 1_755_000_000_000,
  };
  assert.deepEqual(profileApiTestHooks.parseAddFulfillmentOrderToShipStation(shipment), shipment);
  assert.equal(profileApiTestHooks.parseAddFulfillmentOrderToShipStation({ ...shipment, private: true }), null);
  assert.equal(profileApiTestHooks.parseAddFulfillmentOrderToShipStation({ ...shipment, alreadyAdded: 'false' }), null);

  const address = {
    id: 'AbCdEfGhIjKlMnOpQrSt',
    country: 'United States',
    countryCode: 'US',
    hint: '100…01',
    encrypted: 'cipher-text',
    email: 'owner@example.com',
  };
  assert.deepEqual(profileApiTestHooks.parseProfileAddress(address), address);
  assert.equal(profileApiTestHooks.parseProfileAddress({ ...address, private: true }), null);
  assert.equal(profileApiTestHooks.parseProfileAddress({ ...address, id: 'not-auto-id' }), null);

  const status = {
    deliveryId: 7,
    fulfillmentStatus: 'Shipped',
    fulfillmentTrackingCode: 'https://tracking.example/7',
  } as const;
  assert.deepEqual(profileApiTestHooks.parseFulfillmentStatusUpdate(status), status);
  assert.deepEqual(profileApiTestHooks.parseFulfillmentStatusUpdate({
    deliveryId: 7,
    fulfillmentStatus: '',
  }), { deliveryId: 7, fulfillmentStatus: '' });
  assert.equal(profileApiTestHooks.parseFulfillmentStatusUpdate({ ...status, fulfillmentStatus: 'Delivered' }), null);
  assert.equal(profileApiTestHooks.parseFulfillmentStatusUpdate({ ...status, internal: true }), null);

  const fulfillmentAddress = {
    deliveryId: 7,
    address: {
      full: 'Ivan\n100 Main St\nIstanbul, 34000\nTurkey',
      encrypted: 'cipher-text',
      hint: 'I...ey',
      label: 'Home',
      countryCode: 'TR',
    },
  };
  assert.deepEqual(profileApiTestHooks.parseUpdateFulfillmentAddress(fulfillmentAddress), fulfillmentAddress);
  const expandedCipherAddress = {
    ...fulfillmentAddress,
    address: { ...fulfillmentAddress.address, encrypted: 'x'.repeat(12 * 1024) },
  };
  assert.deepEqual(profileApiTestHooks.parseUpdateFulfillmentAddress(expandedCipherAddress), expandedCipherAddress);
  assert.equal(profileApiTestHooks.parseUpdateFulfillmentAddress({
    ...expandedCipherAddress,
    address: { ...expandedCipherAddress.address, encrypted: `${expandedCipherAddress.address.encrypted}x` },
  }), null);
  assert.equal(profileApiTestHooks.parseUpdateFulfillmentAddress({
    ...fulfillmentAddress,
    address: { ...fulfillmentAddress.address, private: true },
  }), null);

  const shipStationLabel = {
    deliveryId: 7,
    shipmentId: 'shipment-1',
    label: {
      labelId: 'label-1',
      shipmentId: 'shipment-1',
      status: 'completed',
      trackingNumber: 'tracking-1',
      totalCost: { currency: 'usd', amount: 12.5 },
      purchasedAt: 1_776_513_600_000,
    },
    labelDownloadUrl: 'https://labels.example/label-1.pdf',
  };
  assert.deepEqual(profileApiTestHooks.parseGetFulfillmentShipStationLabel(shipStationLabel), shipStationLabel);
  assert.deepEqual(profileApiTestHooks.parseGetFulfillmentShipStationLabel({
    deliveryId: 7,
    shipmentId: 'shipment-1',
    purchaseUnknown: true,
  }), {
    deliveryId: 7,
    shipmentId: 'shipment-1',
    purchaseUnknown: true,
  });
  assert.equal(profileApiTestHooks.parseGetFulfillmentShipStationLabel({
    ...shipStationLabel,
    labelDownloadUrl: 'http://labels.example/label-1.pdf',
  }), null);
  assert.equal(profileApiTestHooks.parseGetFulfillmentShipStationLabel({
    ...shipStationLabel,
    private: true,
  }), null);
  assert.equal(profileApiTestHooks.parseGetFulfillmentShipStationLabel({
    ...shipStationLabel,
    label: { ...shipStationLabel.label, shipmentId: 'shipment-2' },
  }), null);

  const shipStationLabelPurchase = { ...shipStationLabel, alreadyPurchased: false };
  assert.deepEqual(
    profileApiTestHooks.parsePurchaseFulfillmentShipStationLabel(shipStationLabelPurchase),
    shipStationLabelPurchase,
  );
  assert.equal(profileApiTestHooks.parsePurchaseFulfillmentShipStationLabel({
    ...shipStationLabelPurchase,
    private: true,
  }), null);
  assert.equal(profileApiTestHooks.parsePurchaseFulfillmentShipStationLabel({
    ...shipStationLabelPurchase,
    label: { ...shipStationLabelPurchase.label, shipmentId: 'shipment-2' },
  }), null);
  assert.equal(profileApiTestHooks.parsePurchaseFulfillmentShipStationLabel({
    ...shipStationLabelPurchase,
    alreadyPurchased: 'false',
  }), null);

  const shipStationRates = {
    deliveryId: 7,
    shipmentId: 'shipment-1',
    package: { length: 10, width: 8, height: 3, weight: 8 },
    packageCount: 1,
    rates: [{
      rateId: 'rate-1',
      shipmentId: 'shipment-1',
      carrierId: 'carrier-1',
      carrierCode: 'ups',
      carrierName: 'UPS',
      serviceCode: 'ups_ground',
      serviceName: 'UPS Ground',
      shippingAmount: { currency: 'usd', amount: 10 },
      insuranceAmount: { currency: 'usd', amount: 1 },
      confirmationAmount: { currency: 'usd', amount: 0 },
      otherAmount: { currency: 'usd', amount: 0.5 },
      totalAmount: { currency: 'usd', amount: 11.5 },
      guaranteedService: false,
      warningMessages: [],
    }],
    invalidRates: [],
  };
  assert.deepEqual(profileApiTestHooks.parseGetFulfillmentShipStationRates(shipStationRates), shipStationRates);
  const providerPackage = { ...shipStationRates.package, weight: 1616 };
  assert.deepEqual(profileApiTestHooks.parseGetFulfillmentShipStationRates({
    ...shipStationRates,
    package: providerPackage,
  }), { ...shipStationRates, package: providerPackage });
  assert.equal(profileApiTestHooks.parseGetFulfillmentShipStationRates({
    ...shipStationRates,
    rates: [{ ...shipStationRates.rates[0], shipmentId: 'shipment-2' }],
  }), null);
  assert.equal(profileApiTestHooks.parseGetFulfillmentShipStationRates({
    ...shipStationRates,
    package: { ...shipStationRates.package, private: true },
  }), null);
  for (const field of ['length', 'width', 'height', 'weight'] as const) {
    for (const malformedValue of [
      '10',
      true,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      0,
      -1,
    ]) {
      assert.equal(profileApiTestHooks.parseGetFulfillmentShipStationRates({
        ...shipStationRates,
        package: { ...shipStationRates.package, [field]: malformedValue },
      }), null, `package ${field} must reject ${String(malformedValue)}`);
    }
  }
  assert.equal(profileApiTestHooks.parseGetFulfillmentShipStationRates({
    ...shipStationRates,
    rates: [{
      ...shipStationRates.rates[0],
      insuranceAmount: { currency: 'eur', amount: 1 },
    }],
  }), null);
  assert.equal(profileApiTestHooks.parseGetFulfillmentShipStationRates({
    ...shipStationRates,
    private: true,
  }), null);
});

test('ShipStation address correction details and request serialization use strict public contracts', () => {
  const details = {
    kind: 'shipstation-address-correction',
    fields: ['name', 'state_province', 'country_code'],
  };
  assert.deepEqual(profileApiTestHooks.parseFulfillmentShipStationAddressCorrectionDetails(details), details);
  for (const malformed of [
    { ...details, private: '100 Main St' },
    { ...details, kind: 'address-correction' },
    { ...details, fields: [] },
    { ...details, fields: ['state_province', 'name'] },
    { ...details, fields: ['name', 'name'] },
    { ...details, fields: ['company_name'] },
    { ...details, fields: 'state_province' },
  ]) {
    assert.equal(profileApiTestHooks.parseFulfillmentShipStationAddressCorrectionDetails(malformed), null);
  }

  const parcel = { length: 10, width: 8, height: 3, weight: 8 };
  const addressPatch = { address_line2: '', state_province: 'PA', country_code: 'US' };
  assert.deepEqual(profileApiTestHooks.addFulfillmentOrderToShipStationRequestPayload(
    7,
    'card_nft_2',
    parcel,
    addressPatch,
  ), {
    deliveryId: 7,
    dropId: 'card_nft_2',
    package: parcel,
    addressPatch,
  });
  assert.deepEqual(profileApiTestHooks.addFulfillmentOrderToShipStationRequestPayload(7, 'card_nft_2'), {
    deliveryId: 7,
    dropId: 'card_nft_2',
  });
});

test('profile state validator rejects mismatches, malformed summaries, and extra data', () => {
  const valid = {
    responseMode: 'profile-state',
    sessionWallet: OWNER,
    profile: { status: 'ready', value: { wallet: OWNER } },
    shipments: { status: 'ready', value: [] },
  };
  assert.deepEqual(profileApiTestHooks.parseProfileState(valid), valid);
  assert.deepEqual(profileApiTestHooks.parseProfileState({
    responseMode: 'profile-state',
    sessionWallet: null,
    profile: null,
    shipments: null,
  }), {
    responseMode: 'profile-state',
    sessionWallet: null,
    profile: null,
    shipments: null,
  });
  assert.equal(profileApiTestHooks.parseProfileState({
    ...valid,
    profile: { status: 'ready', value: { wallet: 'So11111111111111111111111111111111111111112' } },
  }), null);
  assert.equal(profileApiTestHooks.parseProfileState({
    ...valid,
    shipments: { status: 'ready', value: [{ dropId: 'drop', deliveryId: 0, status: 'processing', items: [] }] },
  }), null);
  assert.equal(profileApiTestHooks.parseProfileState({
    ...valid,
    shipments: {
      status: 'ready',
      value: [{ dropId: 'drop', deliveryId: 1, status: 'processing', items: [], claimCode: 'secret' }],
    },
  }), null);
  assert.equal(profileApiTestHooks.parseProfileState({
    ...valid,
    profile: { status: 'ready', value: { wallet: OWNER, email: ' owner@example.com ' } },
  }), null);
  assert.equal(profileApiTestHooks.parseProfileState({ ...valid, private: true }), null);
  assert.equal(profileApiTestHooks.parseProfileState({
    responseMode: 'profile-state',
    sessionWallet: null,
    profile: { status: 'ready', value: { wallet: OWNER } },
    shipments: null,
  }), null);
});

test('migrated profile reads are absent from Firebase exports and deployment selection', () => {
  const functionsSource = readFileSync(new URL('../functions/src/index.ts', import.meta.url), 'utf8');
  const packageJson = readFileSync(new URL('../package.json', import.meta.url), 'utf8');
  for (const name of ['getProfile', 'getAdminProfileView', 'getAnonymousStripeDeliveryHistory']) {
    assert.doesNotMatch(functionsSource, new RegExp(`export const ${name}\\b`));
    assert.doesNotMatch(packageJson, new RegExp(`functions:${name}(?:,|\\\")`));
  }
});

test('migrated profile writes are absent from Firebase exports and deployment selection', () => {
  const functionsSource = readFileSync(new URL('../functions/src/index.ts', import.meta.url), 'utf8');
  const packageJson = readFileSync(new URL('../package.json', import.meta.url), 'utf8');
  const scripts = (JSON.parse(packageJson) as { scripts: Record<string, string> }).scripts;
  for (const name of [
    'saveAddress',
    'updateFulfillmentStatus',
    'updateFulfillmentAddress',
    'addFulfillmentOrderToShipStation',
    'getFulfillmentShipStationLabel',
    'getFulfillmentShipStationRates',
    'purchaseFulfillmentShipStationLabel',
  ]) {
    assert.doesNotMatch(functionsSource, new RegExp(`export const ${name}\\b`));
    assert.doesNotMatch(packageJson, new RegExp(`functions:${name}(?:,|\\")`));
  }
  assert.match(
    scripts['decommission:firebase-fulfillment-callables'],
    /firebase functions:delete addFulfillmentOrderToShipStation --project mons-shop --force/,
  );
  assert.match(
    scripts['decommission:firebase-shipstation-label-purchase'],
    /firebase functions:delete purchaseFulfillmentShipStationLabel --project mons-shop --force/,
  );
});

test('browser source has no direct Firestore data access', () => {
  const sourceRoot = new URL('../src/', import.meta.url);
  const files = (directory: URL): URL[] => readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const child = new URL(entry.name + (entry.isDirectory() ? '/' : ''), directory);
    return entry.isDirectory() ? files(child) : statSync(child).isFile() && /\.[cm]?[jt]sx?$/.test(entry.name) ? [child] : [];
  });
  const source = files(sourceRoot).map((file) => readFileSync(file, 'utf8')).join('\n');
  assert.doesNotMatch(source, /from\s+['"]firebase\/firestore['"]/);
  assert.doesNotMatch(source, /\bgetFirestore\s*\(/);
});
