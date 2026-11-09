import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { type ProfileProviderFetch } from '../src/boundedResponse.ts';
import { type CommerceDocumentData } from '../src/commerceRepository.ts';
import { handleProfileWriteRequest } from '../src/profileWrites.ts';
import {
  FULFILLMENT_SHIPSTATION_LABEL_PATH, FULFILLMENT_SHIPSTATION_LABEL_VOID_PATH, LABEL_VOID_BODY,
  NOW_MS, OWNER, d1Dependencies, orderFixture, request,
} from './profileWriteTestSupport.ts';

const storedLabel = {
  labelId: 'label-1', shipmentId: 'shipment-1', status: 'completed', purchasedAt: NOW_MS - 1000,
};
const providerLabel = { label_id: 'label-1', shipment_id: 'shipment-1', status: 'completed' };
const lookupBody = { dropId: 'card_nft_2', deliveryId: 7 };

function labelOrder(t: TestContext, station: CommerceDocumentData, fields: CommerceDocumentData = {}) {
  return orderFixture(t, { ...fields, shipstation: { shipmentId: 'shipment-1', ...station } });
}

type Order = ReturnType<typeof labelOrder>;

function lookup(order: Order, fetch: ProfileProviderFetch, env = order.env, overrides: Parameters<typeof d1Dependencies>[1] = {}) {
  return handleProfileWriteRequest(request(FULFILLMENT_SHIPSTATION_LABEL_PATH, lookupBody),
    env, FULFILLMENT_SHIPSTATION_LABEL_PATH, {}, d1Dependencies(fetch, overrides));
}

function voidLabel(order: Order, fetch: ProfileProviderFetch, env = order.env, signal?: AbortSignal) {
  const req = request(FULFILLMENT_SHIPSTATION_LABEL_VOID_PATH, LABEL_VOID_BODY);
  return handleProfileWriteRequest(signal ? new Request(req, { signal }) : req,
    env, FULFILLMENT_SHIPSTATION_LABEL_VOID_PATH, {}, d1Dependencies(fetch));
}

test('ShipStation label route refreshes and conditionally persists an active stored label', async t => {
  const claim = { ratesClaimId: 'active-claim', ratesClaimedBy: OWNER, ratesClaimedAt: NOW_MS };
  const order = labelOrder(t, {
    ...claim, label: { ...storedLabel, status: 'processing', trackingNumber: 'old-tracking' },
    labelPurchase: { status: 'purchasing' }, rateQuotes: [{ rateId: 'rate-1' }],
  }, { fulfillmentTrackingCode: 'old-tracking' });
  let reads = 0;
  order.afterRead = () => {
    if (++reads === 1) return order.patch({ operatorNote: 'keep the concurrent update' });
  };
  const result = await lookup(order, async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.origin, 'https://api.shipstation.com');
    assert.equal(url.pathname, '/v2/labels/label-1');
    assert.equal(url.searchParams.get('label_download_type'), 'url');
    assert.equal(new Headers(init?.headers).get('api-key'), 'shipstation-api-key');
    return Response.json({ label: {
      ...providerLabel, tracking_number: 'new-tracking', created_at: '2026-08-18T11:59:00.000Z',
      shipment_cost: { currency: 'usd', amount: 10 }, insurance_cost: { currency: 'usd', amount: 1 },
      label_download: { pdf: 'https://labels.example/label-1.pdf' },
    } });
  });
  assert.equal(result.response.status, 200);
  const payload = await result.response.json() as {
    deliveryId: number; shipmentId: string; label: CommerceDocumentData; labelDownloadUrl: string;
  };
  assert.equal(payload.deliveryId, 7);
  assert.equal(payload.shipmentId, 'shipment-1');
  assert.equal(payload.label.status, 'completed');
  assert.equal(payload.label.trackingNumber, 'new-tracking');
  assert.deepEqual(payload.label.totalCost, { currency: 'usd', amount: 11 });
  assert.equal(payload.labelDownloadUrl, 'https://labels.example/label-1.pdf');
  assert.deepEqual(order.station(), { ...claim, shipmentId: 'shipment-1', label: { ...payload.label, recordedBy: OWNER } });
  assert.equal(order.read().fulfillmentTrackingCode, 'new-tracking');
  assert.equal(reads, 2);
  assert.equal(order.read().operatorNote, 'keep the concurrent update');
});

test('ShipStation label route adopts a discovered label and resolves an uncertain purchase', async t => {
  const adoptedOrder = labelOrder(t, {});
  const adopted = await lookup(adoptedOrder, async input => {
    assert.equal(new URL(String(input)).pathname, '/v2/labels');
    return Response.json({ labels: [{ ...providerLabel, label_id: 'adopted-label', tracking_number: 'adopted-tracking' }] });
  });
  assert.equal(adopted.response.status, 200);
  const adoptedLabel = (await adopted.response.json() as { label: CommerceDocumentData }).label;
  assert.equal(adoptedLabel.labelId, 'adopted-label');
  assert.deepEqual(adoptedOrder.station().label, { ...adoptedLabel, recordedBy: OWNER });
  assert.equal(adoptedOrder.read().fulfillmentTrackingCode, 'adopted-tracking');

  const order = labelOrder(t, { labelPurchase: { status: 'purchasing', requestId: 'request-1' } });
  const unknown = await lookup(order, async () => Response.json({ labels: [] }));
  assert.equal(unknown.response.status, 200);
  assert.deepEqual(await unknown.response.json(), { deliveryId: 7, shipmentId: 'shipment-1', purchaseUnknown: true });
  assert.deepEqual(order.station().labelPurchase, { status: 'unknown', requestId: 'request-1', checkedBy: OWNER, checkedAt: NOW_MS });
});

test('ShipStation label adoption replaces stale metadata from the previous label', async t => {
  const order = labelOrder(t, {
    label: { ...storedLabel, labelId: 'old-label', status: 'voided', trackingNumber: 'stale-tracking',
      rateId: 'stale-rate', totalCost: { currency: 'usd', amount: 99 }, purchasedBy: OWNER },
  }, { fulfillmentTrackingCode: 'stale-tracking' });
  const result = await lookup(order, async input => {
    const url = new URL(String(input));
    if (url.pathname === '/v2/labels/old-label') {
      return Response.json({ label: { ...providerLabel, label_id: 'old-label', status: 'voided' } });
    }
    assert.equal(url.pathname, '/v2/labels');
    return Response.json({ labels: [{ ...providerLabel, label_id: 'adopted-label', status: 'processing' }] });
  });
  assert.equal(result.response.status, 200);
  const expected = { labelId: 'adopted-label', shipmentId: 'shipment-1', status: 'processing', purchasedAt: NOW_MS };
  assert.deepEqual((await result.response.json() as { label: unknown }).label, expected);
  assert.deepEqual(order.station().label, { ...expected, recordedBy: OWNER });
  assert.equal(order.read().fulfillmentTrackingCode, undefined);
});

test('ShipStation label route keeps a voided label terminal across stale provider reads', async t => {
  const order = labelOrder(t, { label: { ...storedLabel, status: 'voided', trackingNumber: 'tracking-1' } });
  order.beforeWrite = () => assert.fail('The terminal label must not be changed');
  const result = await lookup(order, async input => {
    const label = { ...providerLabel, tracking_number: 'tracking-1' };
    return Response.json(new URL(String(input)).pathname === '/v2/labels/label-1' ? { label } : { labels: [label] });
  });
  assert.equal(result.response.status, 200);
  assert.equal((await result.response.json() as { label: { status: string } }).label.status, 'voided');
});

test('ShipStation label route does not overwrite a label created during adoption', async t => {
  const order = labelOrder(t, {});
  const replacement = { ...storedLabel, labelId: 'newer-label' };
  const writeAfterReplacement = t.mock.fn(() => {});
  const result = await lookup(order, async () => {
    await order.patch({ shipstation: { shipmentId: 'shipment-1', label: replacement } });
    order.beforeWrite = writeAfterReplacement;
    return Response.json({ labels: [{ ...providerLabel, label_id: 'adopted-label' }] });
  });
  assert.equal(result.response.status, 409);
  assert.equal((await result.response.json() as { error: { code: string } }).error.code, 'aborted');
  assert.deepEqual(order.station().label, replacement);
  assert.equal(writeAfterReplacement.mock.callCount(), 0);
});

test('ShipStation label route rejects a label from another shipment before persisting it', async t => {
  const order = labelOrder(t, { label: { ...storedLabel, status: 'processing' } });
  order.beforeWrite = () => assert.fail('Mismatched shipment must not update the order');
  const result = await lookup(order, async () => Response.json({ label: { ...providerLabel, shipment_id: 'shipment-2' } }));
  assert.equal(result.response.status, 409);
  assert.equal((await result.response.json() as { error: { code: string } }).error.code, 'aborted');
});

test('ShipStation label route rejects a shipment change before transitioning purchase state', async t => {
  const purchase = { status: 'purchasing', requestId: 'request-1' };
  const order = labelOrder(t, { labelPurchase: purchase });
  const writeAfterReplacement = t.mock.fn(() => {});
  const result = await lookup(order, async () => {
    await order.patch({ shipstation: { shipmentId: 'shipment-2', labelPurchase: purchase } });
    order.beforeWrite = writeAfterReplacement;
    return Response.json({ labels: [] });
  });
  assert.equal(result.response.status, 409);
  assert.equal((await result.response.json() as { error: { code: string } }).error.code, 'aborted');
  assert.deepEqual(order.station(), { shipmentId: 'shipment-2', labelPurchase: purchase });
  assert.equal(writeAfterReplacement.mock.callCount(), 0);
});

test('ShipStation label route fails closed for missing configuration and oversized provider responses', async t => {
  const order = labelOrder(t, {});
  const missing = await lookup(order, async () => assert.fail('Missing key must prevent provider calls'),
    { ...order.env, SHIPSTATION_API_KEY: '' });
  assert.equal(missing.response.status, 409);
  assert.equal((await missing.response.json() as { error: { code: string } }).error.code, 'failed-precondition');
  assert.equal(missing.authOutcome, 'provider-failure');

  const rateLimited = await lookup(order, async () => Response.json({}, { status: 429 }));
  assert.equal(rateLimited.response.status, 429);
  assert.equal(rateLimited.authOutcome, 'provider-failure');
  const emptyLabels = { labels: [] };
  assert.equal((await lookup(order, async () => Response.json(emptyLabels))).response.status, 200);
  for (const response of [
    Response.json(emptyLabels, { headers: { 'Content-Length': String(300 * 1024) } }),
    Response.json({}),
    Response.json({ labels: [{}] }),
  ]) {
    const failed = await lookup(order, async () => response);
    assert.equal(failed.response.status, 502);
    assert.equal((await failed.response.json() as { error: { code: string } }).error.code, 'unavailable');
    assert.equal(failed.authOutcome, 'provider-failure');
  }
  const timedOut = await lookup(order, async (_input, init) => new Promise<Response>((_resolve, reject) => {
    const signal = init?.signal;
    const abort = () => reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  }), order.env, { timeoutMs: 25 });
  assert.equal(timedOut.response.status, 504);
  assert.equal((await timedOut.response.json() as { error: { code: string } }).error.code, 'deadline-exceeded');
});

test('ShipStation label void route persists the exact label and conditionally removes its tracking code', async t => {
  const label = { ...storedLabel, trackingNumber: 'tracking-1' };
  for (const fulfillmentTrackingCode of ['tracking-1', 'manual-tracking']) {
    const order = labelOrder(t, { label, rateQuotes: [{ rateId: 'rate-1' }] }, { fulfillmentTrackingCode, fulfillmentStatus: 'Shipped' });
    const commits: CommerceDocumentData[] = [];
    order.afterWrite = () => { commits.push(order.read()); };
    let putCalls = 0;
    const result = await voidLabel(order, async (input, init) => {
      putCalls += 1;
      assert.equal(String(input), 'https://api.shipstation.com/v2/labels/label-1/void');
      assert.equal(init?.method, 'PUT');
      assert.equal(init?.body, undefined);
      assert.equal(new Headers(init?.headers).get('api-key'), 'shipstation-api-key');
      return Response.json({ approved: true, message: 'Refund requested' });
    });
    assert.equal(putCalls, 1);
    assert.equal(result.response.status, 200);
    assert.deepEqual(await result.response.json(), { deliveryId: 7, shipmentId: 'shipment-1', label: { ...label, status: 'voided' } });
    assert.equal(commits.length, 1);
    const [voidedOrder] = commits;
    assert.deepEqual(voidedOrder.shipstation, { shipmentId: 'shipment-1', label: { ...label, status: 'voided', recordedBy: OWNER } });
    assert.equal(voidedOrder.fulfillmentStatus, 'Shipped');
    assert.equal(voidedOrder.fulfillmentTrackingCode, fulfillmentTrackingCode === label.trackingNumber ? undefined : fulfillmentTrackingCode);
  }
});

test('ShipStation label void route is idempotent and rejects stale or ineligible labels before calling ShipStation', async t => {
  async function guardedVoid(order: Order, env = order.env) {
    const providerFetch = t.mock.fn(async () => Response.json({ approved: true }));
    const write = t.mock.fn(() => {});
    order.beforeWrite = write;
    const { response } = await voidLabel(order, providerFetch, env);
    assert.equal(providerFetch.mock.callCount(), 0, 'Unexpected ShipStation request');
    assert.equal(write.mock.callCount(), 0, 'Unexpected order write');
    return response;
  }
  const voided = { ...storedLabel, status: 'voided' };
  const order = labelOrder(t, { label: voided });
  const idempotent = await guardedVoid(order);
  assert.equal(idempotent.status, 200);
  assert.equal((await idempotent.json() as { label: { status: string } }).label.status, 'voided');
  for (const [label, code] of [
    [{ ...storedLabel, status: 'processing' }, 'failed-precondition'],
    [{ ...storedLabel, status: 'error' }, 'failed-precondition'],
    [{ ...voided, labelId: 'replacement-label' }, 'aborted'],
  ] as const) {
    const response = await guardedVoid(labelOrder(t, { label }));
    assert.equal(response.status, 409);
    assert.equal((await response.json() as { error: { code: string } }).error.code, code);
  }
  const irl = labelOrder(t, { label: voided }, { source: 'admin_irl_redeem' });
  assert.equal((await guardedVoid(irl)).status, 409);
  assert.equal((await guardedVoid(order, { ...order.env, SHIPSTATION_API_KEY: '' })).status, 409);
});

test('ShipStation label void route maps definite rejection without leaking provider messages', async t => {
  const order = labelOrder(t, { label: storedLabel });
  order.beforeWrite = () => assert.fail('Rejected void must not modify the order');
  const result = await voidLabel(order, async () => Response.json({
    approved: false, message: 'Private 100 Main St secret-token', reason_code: 'label_already_used',
  }));
  assert.equal(result.response.status, 409);
  const payload = await result.response.json() as { error: { message: string } };
  assert.match(payload.error.message, /already been used/);
  assert.doesNotMatch(payload.error.message, /Private|100 Main|secret-token/);
});

test('ShipStation label void route reconciles an ambiguous provider result with a fresh signal', async t => {
  const order = labelOrder(t, { label: { ...storedLabel, trackingNumber: 'tracking-1' } }, { fulfillmentTrackingCode: 'tracking-1' });
  let mutationSignal: AbortSignal | null | undefined;
  const calls: string[] = [];
  const result = await voidLabel(order, async (input, init) => {
    const path = new URL(String(input)).pathname;
    calls.push(path);
    if (path.endsWith('/void')) {
      mutationSignal = init?.signal;
      return Response.json({}, { status: 408 });
    }
    assert.notEqual(init?.signal, mutationSignal);
    assert.equal(init?.signal?.aborted, false);
    return Response.json({ label: { ...providerLabel, status: 'voided' } });
  });
  assert.equal(result.response.status, 200);
  assert.equal((await result.response.json() as { label: { status: string } }).label.status, 'voided');
  assert.deepEqual(calls, ['/v2/labels/label-1/void', '/v2/labels/label-1']);
  assert.equal(order.read().fulfillmentTrackingCode, undefined);
  assert.equal((order.station().label as CommerceDocumentData).status, 'voided');
});

test('ShipStation label void disconnect reconciles the provider mutation before rethrowing cancellation', async t => {
  const order = labelOrder(t, { label: storedLabel });
  const client = new AbortController();
  const reason = new DOMException('Client disconnected', 'AbortError');
  let commits = 0;
  order.afterWrite = () => { commits++; };
  await assert.rejects(voidLabel(order, async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith('/void')) {
      client.abort(reason);
      throw init?.signal?.reason ?? reason;
    }
    assert.equal(path, '/v2/labels/label-1');
    assert.equal(init?.signal?.aborted, false);
    return Response.json({ label: { ...providerLabel, status: 'voided' } });
  }, order.env, client.signal), error => error === reason);
  assert.equal(commits, 1);
  assert.equal((order.station().label as CommerceDocumentData).status, 'voided');
});

test('ShipStation label void route does not overwrite a replacement label after provider approval', async t => {
  const order = labelOrder(t, { label: storedLabel });
  const replacement = { ...storedLabel, labelId: 'replacement-label' };
  const writeAfterReplacement = t.mock.fn(() => {});
  const logs: string[] = [];
  t.mock.method(console, 'error', (...values: unknown[]) => logs.push(values.map(String).join(' ')));
  let orderReads = 0;
  order.afterRead = () => { orderReads++; };
  const result = await voidLabel(order, async input => {
    assert.equal(new URL(String(input)).pathname, '/v2/labels/label-1/void');
    await order.patch({ shipstation: { shipmentId: 'shipment-1', label: replacement } });
    order.beforeWrite = writeAfterReplacement;
    return Response.json({ approved: true, message: 'Refund requested' });
  });
  assert.equal(result.response.status, 409);
  assert.match((await result.response.json() as { error: { message: string } }).error.message, /did not confirm/);
  assert.ok(orderReads >= 3);
  assert.equal(writeAfterReplacement.mock.callCount(), 0);
  assert.deepEqual(order.station().label, replacement);
  assert.match(logs.join('\n'), /fulfillment_shipstation_label_void_reconcile_failed/);
});
