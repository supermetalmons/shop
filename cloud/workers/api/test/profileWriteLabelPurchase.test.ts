import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import type { CommerceDocumentData } from '../src/commerceRepository.ts';
import { ProfileReadError } from '../src/dataAccess.ts';
import { handleProfileWriteRequest } from '../src/profileWrites.ts';
import {
  FULFILLMENT_SHIPSTATION_LABEL_PURCHASE_PATH, LABEL_PURCHASE_BODY, NOW_MS, OWNER, SHIPSTATION_RATE,
  d1Dependencies, orderFixture, request,
} from './profileWriteTestSupport.ts';

function purchaseOrder(t: TestContext) {
  return orderFixture(t, {
    shipstation: {
      shipmentId: 'shipment-1',
      rateQuotes: [{ rateId: 'rate-1', shipmentId: 'shipment-1', totalAmount: LABEL_PURCHASE_BODY.expectedTotal }],
    },
  });
}

function purchaseState(order: ReturnType<typeof purchaseOrder>) {
  return order.station().labelPurchase as { status: string; requestId: string; lastError?: string } | undefined;
}

function assertPurchaseCommits(commits: CommerceDocumentData[], quotedRates: CommerceDocumentData[string], labelId: string) {
  assert.equal(commits.length, 2);
  const [claimed, purchased] = commits;
  assert.partialDeepStrictEqual(claimed.labelPurchase, {
    status: 'purchasing', requestId: LABEL_PURCHASE_BODY.requestId, claimedBy: OWNER, claimedAt: NOW_MS,
  });
  assert.deepEqual(claimed.rateQuotes, quotedRates);
  assert.equal(claimed.label, undefined);
  assert.partialDeepStrictEqual(purchased.label, { labelId, status: 'completed' });
  assert.equal(purchased.labelPurchase, undefined);
  assert.equal(purchased.rateQuotes, undefined);
}

test('ShipStation label purchase route claims, validates, purchases, and atomically persists a label', async t => {
  const order = purchaseOrder(t);
  const quotedRates = order.station().rateQuotes;
  const commits: CommerceDocumentData[] = [];
  order.afterWrite = () => { commits.push(order.station()); };
  let labelListCalls = 0;
  let purchaseCalls = 0;
  const providerFetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.hostname, 'api.shipstation.com');
    assert.equal(new Headers(init?.headers).get('api-key'), 'shipstation-api-key');
    assert.equal(init?.redirect, 'manual');
    if (url.pathname === '/v2/labels') {
      labelListCalls += 1;
      return Response.json({ labels: [] });
    }
    if (url.pathname === '/v2/rates/rate-1') return Response.json(SHIPSTATION_RATE);
    if (url.pathname === '/v2/labels/rates/rate-1') {
      purchaseCalls += 1;
      assert.equal(purchaseState(order)?.requestId, LABEL_PURCHASE_BODY.requestId);
      assert.equal(purchaseState(order)?.status, 'purchasing');
      assert.equal(init?.method, 'POST');
      assert.deepEqual(JSON.parse(String(init?.body)), {
        label_format: 'pdf',
        label_layout: '4x6',
        label_download_type: 'url',
      });
      return Response.json({
        label_id: 'label-1',
        shipment_id: 'shipment-1',
        status: 'completed',
        tracking_number: 'tracking-1',
        shipment_cost: { currency: 'usd', amount: 10 },
        created_at: '2026-08-18T12:00:00.000Z',
        label_download: { pdf: 'https://labels.example/label-1.pdf' },
      });
    }
    return Response.json({ error: 'unexpected ShipStation request' }, { status: 500 });
  };
  const result = await handleProfileWriteRequest(
    request(FULFILLMENT_SHIPSTATION_LABEL_PURCHASE_PATH, LABEL_PURCHASE_BODY),
    order.env,
    FULFILLMENT_SHIPSTATION_LABEL_PURCHASE_PATH,
    {},
    d1Dependencies(providerFetch),
  );
  assert.equal(result.response.status, 200);
  assert.deepEqual(await result.response.json(), {
    deliveryId: 7,
    shipmentId: 'shipment-1',
    label: {
      labelId: 'label-1',
      shipmentId: 'shipment-1',
      status: 'completed',
      rateId: 'rate-1',
      trackingNumber: 'tracking-1',
      carrierId: 'carrier-1',
      carrierCode: 'stamps_com',
      carrierName: 'USPS',
      serviceCode: 'usps_priority_mail',
      serviceName: 'USPS Priority Mail',
      shipmentCost: { currency: 'usd', amount: 10 },
      totalCost: { currency: 'usd', amount: 10 },
      purchasedAt: NOW_MS,
      purchasedBy: OWNER,
    },
    labelDownloadUrl: 'https://labels.example/label-1.pdf',
    alreadyPurchased: false,
  });
  assert.equal(labelListCalls, 2);
  assert.equal(purchaseCalls, 1);
  assertPurchaseCommits(commits, quotedRates, 'label-1');
});

test('ShipStation label purchase route adopts an existing provider label without charging', async t => {
  const order = orderFixture(t, { shipstation: { shipmentId: 'shipment-1' } });
  let purchaseCalls = 0;
  const providerFetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.hostname, 'api.shipstation.com');
    if (url.pathname === '/v2/labels') {
      return Response.json({
        labels: [{
          label_id: 'existing-label',
          shipment_id: 'shipment-1',
          status: 'completed',
          tracking_number: 'existing-tracking',
          label_download: { pdf: 'https://labels.example/existing.pdf' },
        }],
      });
    }
    if (init?.method === 'POST') purchaseCalls += 1;
    return Response.json({ error: 'unexpected ShipStation request' }, { status: 500 });
  };
  const result = await handleProfileWriteRequest(
    request(FULFILLMENT_SHIPSTATION_LABEL_PURCHASE_PATH, LABEL_PURCHASE_BODY),
    order.env,
    FULFILLMENT_SHIPSTATION_LABEL_PURCHASE_PATH,
    {},
    d1Dependencies(providerFetch),
  );
  assert.equal(result.response.status, 200);
  const payload = await result.response.json() as {
    alreadyPurchased: boolean;
    label: { labelId: string };
    labelDownloadUrl: string;
  };
  assert.equal(payload.alreadyPurchased, true);
  assert.equal(payload.label.labelId, 'existing-label');
  assert.equal(payload.labelDownloadUrl, 'https://labels.example/existing.pdf');
  assert.equal(purchaseCalls, 0);
  assert.equal((order.station().label as { labelId: string }).labelId, 'existing-label');
});

test('ShipStation label purchase route records definite failures and unresolved ambiguous purchases safely', async t => {
  for (const mode of [
    'definite',
    'ambiguous',
    'missing-status',
    'unsupported-status',
    'missing-status-voided',
    'unsupported-status-voided',
  ] as const) {
    const order = purchaseOrder(t);
    let labelListCalls = 0;
    const providerFetch: typeof fetch = async (input) => {
      const url = new URL(String(input));
      assert.equal(url.hostname, 'api.shipstation.com');
      if (url.pathname === '/v2/labels') {
        labelListCalls += 1;
        return Response.json({ labels: [] });
      }
      if (url.pathname === '/v2/rates/rate-1') {
        return mode === 'definite'
          ? Response.json({ errors: [{ error_code: 'invalid_rate', message: 'Private 100 Main St' }] }, { status: 400 })
          : Response.json(SHIPSTATION_RATE);
      }
      if (url.pathname === '/v2/labels/rates/rate-1') {
        if (mode === 'ambiguous') throw new TypeError('Private 100 Main St');
        return Response.json({
          label_id: 'label-1',
          shipment_id: 'shipment-1',
          ...(mode.startsWith('unsupported-status') ? { status: 'queued' } : {}),
          ...(mode.endsWith('-voided') ? { voided: true } : {}),
        });
      }
      return Response.json({ error: 'unexpected ShipStation request' }, { status: 500 });
    };
    const result = await handleProfileWriteRequest(
      request(FULFILLMENT_SHIPSTATION_LABEL_PURCHASE_PATH, LABEL_PURCHASE_BODY),
      order.env,
      FULFILLMENT_SHIPSTATION_LABEL_PURCHASE_PATH,
      {},
      d1Dependencies(providerFetch),
    );
    assert.equal(result.response.status, 409, mode);
    const payload = await result.response.json() as { error: { code: string; message: string } };
    assert.equal(payload.error.code, mode === 'definite' ? 'failed-precondition' : 'aborted');
    assert.doesNotMatch(JSON.stringify(payload), /100 Main St|Private/);
    if (mode !== 'definite') {
      assert.match(payload.error.message, /Check purchase status or open ShipStation/);
      assert.equal(labelListCalls, 3);
    }
    const state = purchaseState(order);
    assert.equal(state?.status, mode === 'definite' ? 'failed' : 'unknown');
    assert.doesNotMatch(state?.lastError ?? '', /100 Main St|Private/);
  }
});

test('ShipStation purchase failures retain safe provider diagnostics after a successful retry', async t => {
  for (const stage of ['label lookup', 'rate lookup', 'label purchase'] as const) {
    const order = purchaseOrder(t);
    let reject = true;
    const logs: string[] = [];
    const providerFetch: typeof fetch = async (input) => {
      const url = new URL(String(input));
      assert.equal(url.hostname, 'api.shipstation.com');
      const currentStage = url.pathname === '/v2/labels' ? 'label lookup'
        : url.pathname === '/v2/rates/rate-1' ? 'rate lookup' : 'label purchase';
      if (reject && currentStage === stage) {
        return Response.json({
          request_id: 'provider-request-123',
          errors: [{
            error_code: 'unspecified',
            error_type: 'validation',
            error_source: 'carrier',
            field_name: 'ship_to.phone',
            message: 'Invalid phone for Private 100 Main St Bearer secret-token shipstation-api-key',
            field_value: 'private-phone',
          }],
        }, { status: 400 });
      }
      if (currentStage === 'label lookup') return Response.json({ labels: [] });
      if (currentStage === 'rate lookup') return Response.json(SHIPSTATION_RATE);
      assert.equal(url.pathname, '/v2/labels/rates/rate-1');
      return Response.json({ label_id: 'label-1', shipment_id: 'shipment-1', status: 'completed' });
    };
    const run = (requestId: string) => handleProfileWriteRequest(
      request(FULFILLMENT_SHIPSTATION_LABEL_PURCHASE_PATH, { ...LABEL_PURCHASE_BODY, requestId }),
      order.env,
      FULFILLMENT_SHIPSTATION_LABEL_PURCHASE_PATH,
      {},
      d1Dependencies(providerFetch),
    );
    const originalConsoleError = console.error;
    console.error = (...values: unknown[]) => logs.push(values.map(String).join(' '));
    try {
      const failed = await run(LABEL_PURCHASE_BODY.requestId);
      assert.equal(failed.response.status, 409, stage);
      const payload = await failed.response.json() as { error: { message: string } };
      assert.match(payload.error.message, /phone/i);
      assert.ok(payload.error.message.includes(stage));
      assert.match(payload.error.message, /HTTP 400/);
      assert.match(payload.error.message, /provider-request-123/);
      assert.doesNotMatch(JSON.stringify(payload), /Private|100 Main|secret-token|shipstation-api-key|private-phone/);
      assert.equal(logs.length, 1);
      const diagnostic = JSON.parse(logs[0]);
      assert.equal(diagnostic.event, 'fulfillment_shipstation_label_purchase_failed');
      assert.equal(diagnostic.deliveryId, 7);
      assert.equal(diagnostic.dropId, 'card_nft_2');
      assert.equal(diagnostic.shipmentId, 'shipment-1');
      assert.equal(diagnostic.rateId, 'rate-1');
      assert.equal(diagnostic.purchaseRequestId, LABEL_PURCHASE_BODY.requestId);
      assert.equal(diagnostic.purchaseAttempted, stage === 'label purchase');
      assert.equal(diagnostic.provider.requestId, 'provider-request-123');
      assert.equal(diagnostic.provider.status, 400);
      assert.equal(diagnostic.provider.operation, stage === 'rate lookup' ? 'selected rate lookup' : stage);
      assert.equal(diagnostic.provider.errors[0].source, 'carrier');
      reject = false;
      const success = await run('6ba7b811-9dad-11d1-80b4-00c04fd430c8');
      assert.equal(success.response.status, 200, stage);
      const shipstation = order.station();
      assert.equal(shipstation.labelPurchase, undefined);
      assert.equal((shipstation.label as { labelId: string }).labelId, 'label-1');
      assert.equal(logs.length, 1);
      assert.doesNotMatch(logs[0], /Private|100 Main|Bearer|secret-token|shipstation-api-key|private-phone/);
    } finally {
      console.error = originalConsoleError;
    }
  }
});

test('ShipStation label purchase stays unknown after a successful charge and repeated Commerce conflicts', async t => {
  const order = purchaseOrder(t);
  const committedStatuses: (string | undefined)[] = [];
  order.afterWrite = () => { committedStatuses.push(purchaseState(order)?.status); };
  let purchaseCalls = 0;
  let persistenceConflicts = 0;
  const providerFetch: typeof fetch = async (input) => {
    const url = new URL(String(input));
    assert.equal(url.hostname, 'api.shipstation.com');
    if (url.pathname === '/v2/labels') {
      if (purchaseCalls) order.beforeWrite = undefined;
      return Response.json({ labels: [] });
    }
    if (url.pathname === '/v2/rates/rate-1') return Response.json(SHIPSTATION_RATE);
    if (url.pathname === '/v2/labels/rates/rate-1') {
      purchaseCalls += 1;
      order.beforeWrite = () => order.patch({ competingWrite: ++persistenceConflicts });
      return Response.json({
        label_id: 'charged-label',
        shipment_id: 'shipment-1',
        status: 'completed',
      });
    }
    return Response.json({ error: 'unexpected ShipStation request' }, { status: 500 });
  };
  const result = await handleProfileWriteRequest(
    request(FULFILLMENT_SHIPSTATION_LABEL_PURCHASE_PATH, LABEL_PURCHASE_BODY),
    order.env,
    FULFILLMENT_SHIPSTATION_LABEL_PURCHASE_PATH,
    {},
    d1Dependencies(providerFetch, { timeoutMs: 2_000 }),
  );
  assert.equal(result.response.status, 409);
  const payload = await result.response.json() as { error: { code: string; message: string } };
  assert.equal(payload.error.code, 'aborted');
  assert.match(payload.error.message, /Check purchase status or open ShipStation/);
  assert.equal(purchaseCalls, 1);
  assert.ok(persistenceConflicts > 1);
  assert.deepEqual(committedStatuses, ['purchasing', 'unknown']);
});

test('ShipStation label purchase timeout uses a fresh cleanup signal and stores unknown', async t => {
  const order = purchaseOrder(t);
  let chargedPostStarted = false;
  let chargedPostAborted = false;
  const deferred: Promise<unknown>[] = [];
  const providerFetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.hostname, 'api.shipstation.com');
    if (url.pathname === '/v2/labels') return Response.json({ labels: [] });
    if (url.pathname === '/v2/rates/rate-1') return Response.json(SHIPSTATION_RATE);
    if (url.pathname === '/v2/labels/rates/rate-1') {
      chargedPostStarted = true;
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        const abort = () => {
          chargedPostAborted = true;
          reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
        };
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort();
      });
    }
    return Response.json({ error: 'unexpected ShipStation request' }, { status: 500 });
  };
  const result = await handleProfileWriteRequest(
    request(FULFILLMENT_SHIPSTATION_LABEL_PURCHASE_PATH, LABEL_PURCHASE_BODY),
    order.env,
    FULFILLMENT_SHIPSTATION_LABEL_PURCHASE_PATH,
    {},
    d1Dependencies(providerFetch, {
      defer: (promise) => { deferred.push(promise); },
      timeoutMs: 75,
    }),
  );
  assert.equal(chargedPostStarted, true);
  assert.equal(chargedPostAborted, true);
  assert.equal(result.response.status, 504);
  assert.equal(
    (await result.response.json() as { error: { code: string } }).error.code,
    'deadline-exceeded',
  );
  assert.equal(deferred.length, 1);
  await assert.rejects(
    deferred[0],
    (error: unknown) => error instanceof ProfileReadError && error.code === 'aborted',
  );
  assert.equal(purchaseState(order)?.status, 'unknown');
});

test('ShipStation label purchase disconnect releases its claim after a cleanup conflict', async t => {
  const order = purchaseOrder(t);
  const client = new AbortController();
  const abortReason = new DOMException('Client disconnected', 'AbortError');
  let cleanupCommitAttempts = 0;
  const providerFetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.hostname, 'api.shipstation.com');
    if (url.pathname === '/v2/labels') return Response.json({ labels: [] });
    if (url.pathname === '/v2/rates/rate-1') {
      order.beforeWrite = () => {
        if (++cleanupCommitAttempts === 1) return order.patch({ competingWrite: true });
      };
      client.abort(abortReason);
      throw init?.signal?.reason ?? abortReason;
    }
    return Response.json({ error: 'unexpected ShipStation request' }, { status: 500 });
  };
  const disconnectedRequest = new Request(
    `https://api.mons.shop${FULFILLMENT_SHIPSTATION_LABEL_PURCHASE_PATH}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://mons.shop' },
      body: JSON.stringify(LABEL_PURCHASE_BODY),
      signal: client.signal,
    },
  );
  await assert.rejects(
    handleProfileWriteRequest(
      disconnectedRequest,
      order.env,
      FULFILLMENT_SHIPSTATION_LABEL_PURCHASE_PATH,
      {},
      d1Dependencies(providerFetch, { timeoutMs: 2_000 }),
    ),
    (error) => error === abortReason,
  );
  assert.equal(cleanupCommitAttempts, 2);
  assert.equal(purchaseState(order)?.status, 'failed');
});

test('ShipStation label purchase disconnect reconciles an ambiguous charge before rethrowing cancellation', async t => {
  const order = purchaseOrder(t);
  const client = new AbortController();
  const reason = new DOMException('Client disconnected', 'AbortError');
  let cleanupUsedFreshSignal = false;
  const providerFetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.hostname, 'api.shipstation.com');
    if (url.pathname === '/v2/labels') {
      cleanupUsedFreshSignal ||= client.signal.aborted && init?.signal?.aborted === false;
      return Response.json({ labels: [] });
    }
    if (url.pathname === '/v2/rates/rate-1') return Response.json(SHIPSTATION_RATE);
    if (url.pathname === '/v2/labels/rates/rate-1') {
      client.abort(reason);
      throw init?.signal?.reason ?? reason;
    }
    return Response.json({ error: 'unexpected ShipStation request' }, { status: 500 });
  };
  const disconnectedRequest = new Request(
    `https://api.mons.shop${FULFILLMENT_SHIPSTATION_LABEL_PURCHASE_PATH}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://mons.shop' },
      body: JSON.stringify(LABEL_PURCHASE_BODY),
      signal: client.signal,
    },
  );

  await assert.rejects(
    handleProfileWriteRequest(
      disconnectedRequest,
      order.env,
      FULFILLMENT_SHIPSTATION_LABEL_PURCHASE_PATH,
      {},
      d1Dependencies(providerFetch, { timeoutMs: 2_000 }),
    ),
    (error) => error === reason,
  );
  assert.equal(cleanupUsedFreshSignal, true);
  assert.equal(purchaseState(order)?.status, 'unknown');
});

test('ShipStation label purchase cleanup failure keeps the claim blocked and logs only safe metadata', async t => {
  const order = purchaseOrder(t);
  const logs: string[] = [];
  const providerFetch: typeof fetch = async (input) => {
    const url = new URL(String(input));
    assert.equal(url.hostname, 'api.shipstation.com');
    if (url.pathname === '/v2/labels') return Response.json({ labels: [] });
    if (url.pathname === '/v2/rates/rate-1') return Response.json(SHIPSTATION_RATE);
    if (url.pathname === '/v2/labels/rates/rate-1') {
      order.afterRead = () => { throw new Error('Private 100 Main St Bearer secret-token'); };
      throw new TypeError('Private 100 Main St Bearer secret-token shipstation-api-key');
    }
    return Response.json({ error: 'unexpected ShipStation request' }, { status: 500 });
  };
  const originalConsoleError = console.error;
  console.error = (...values: unknown[]) => logs.push(values.map(String).join(' '));
  try {
    const result = await handleProfileWriteRequest(
      request(FULFILLMENT_SHIPSTATION_LABEL_PURCHASE_PATH, LABEL_PURCHASE_BODY),
      order.env,
      FULFILLMENT_SHIPSTATION_LABEL_PURCHASE_PATH,
      {},
      d1Dependencies(providerFetch, { timeoutMs: 2_000 }),
    );
    assert.equal(result.response.status, 409);
    const payload = await result.response.json() as { error: { code: string; message: string } };
    assert.equal(payload.error.code, 'aborted');
    assert.match(payload.error.message, /Check purchase status or open ShipStation/);
  } finally {
    console.error = originalConsoleError;
  }
  order.afterRead = undefined;
  assert.equal(purchaseState(order)?.status, 'purchasing');
  assert.match(logs.join('\n'), /fulfillment_shipstation_label_purchase_cleanup_failed/);
  assert.doesNotMatch(logs.join('\n'), /Private|100 Main|Bearer|secret-token|shipstation-api-key/);
});

test('ShipStation label purchase route reconciles a label after an ambiguous charged request', async t => {
  const order = purchaseOrder(t);
  const quotedRates = order.station().rateQuotes;
  const commits: CommerceDocumentData[] = [];
  order.afterWrite = () => { commits.push(order.station()); };
  let labelListCalls = 0;
  let chargeAttempts = 0;
  const providerFetch: typeof fetch = async (input) => {
    const url = new URL(String(input));
    assert.equal(url.hostname, 'api.shipstation.com');
    if (url.pathname === '/v2/labels') {
      labelListCalls += 1;
      return Response.json({
        labels: labelListCalls === 3
          ? [{
              label_id: 'recovered-label',
              shipment_id: 'shipment-1',
              status: 'completed',
              tracking_number: 'recovered-tracking',
            }]
          : [],
      });
    }
    if (url.pathname === '/v2/rates/rate-1') return Response.json(SHIPSTATION_RATE);
    if (url.pathname === '/v2/labels/rates/rate-1') {
      chargeAttempts += 1;
      throw new TypeError('connection closed');
    }
    return Response.json({ error: 'unexpected ShipStation request' }, { status: 500 });
  };
  const result = await handleProfileWriteRequest(
    request(FULFILLMENT_SHIPSTATION_LABEL_PURCHASE_PATH, LABEL_PURCHASE_BODY),
    order.env,
    FULFILLMENT_SHIPSTATION_LABEL_PURCHASE_PATH,
    {},
    d1Dependencies(providerFetch),
  );
  assert.equal(result.response.status, 200);
  const payload = await result.response.json() as {
    alreadyPurchased: boolean;
    label: { labelId: string; trackingNumber: string };
  };
  assert.equal(payload.alreadyPurchased, false);
  assert.equal(payload.label.labelId, 'recovered-label');
  assert.equal(payload.label.trackingNumber, 'recovered-tracking');
  assert.equal(labelListCalls, 3);
  assert.equal(chargeAttempts, 1);
  assertPurchaseCommits(commits, quotedRates, 'recovered-label');
});

test('ShipStation label purchase route never charges after its Commerce claim is replaced', async t => {
  const order = purchaseOrder(t);
  const replacement = { status: 'purchasing', requestId: 'replacement-request', rateId: 'rate-2' };
  const writeAfterReplacement = t.mock.fn(() => {});
  let purchaseCalls = 0;
  const providerFetch: typeof fetch = async (input) => {
    const url = new URL(String(input));
    assert.equal(url.hostname, 'api.shipstation.com');
    if (url.pathname === '/v2/labels') return Response.json({ labels: [] });
    if (url.pathname === '/v2/rates/rate-1') {
      await order.patch({ shipstation: { ...order.station(), labelPurchase: replacement } });
      order.beforeWrite = writeAfterReplacement;
      return Response.json(SHIPSTATION_RATE);
    }
    if (url.pathname === '/v2/labels/rates/rate-1') purchaseCalls += 1;
    return Response.json({ error: 'unexpected ShipStation request' }, { status: 500 });
  };
  const result = await handleProfileWriteRequest(
    request(FULFILLMENT_SHIPSTATION_LABEL_PURCHASE_PATH, LABEL_PURCHASE_BODY),
    order.env,
    FULFILLMENT_SHIPSTATION_LABEL_PURCHASE_PATH,
    {},
    d1Dependencies(providerFetch),
  );
  assert.equal(result.response.status, 409);
  assert.equal((await result.response.json() as { error: { code: string } }).error.code, 'aborted');
  assert.equal(purchaseCalls, 0);
  assert.equal(writeAfterReplacement.mock.callCount(), 0);
  assert.deepEqual(order.station().labelPurchase, replacement);
});
