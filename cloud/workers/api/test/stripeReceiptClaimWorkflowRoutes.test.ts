import assert from 'node:assert/strict';
import test from 'node:test';
import { STRIPE_CHECKOUT_RETRY_HEADER } from '../../../../shared/contracts.ts';
import { STRIPE_RECEIPT_CLAIM_REQUEST_HEADER } from '../../../../shared/stripeReceiptClaimWorkflow.ts';
import { RequestIdentityError } from '../src/requestIdentity.ts';
import { commerceKeys, D1CommerceRepository } from '../src/commerceRepository.ts';
import { runtimeForDrop } from '../src/stripeReceiptClaim.ts';
import {
  handleStripeReceiptClaimWorkflowLegacy,
  handleStripeReceiptClaimWorkflowStart,
  handleStripeReceiptClaimWorkflowStatus,
} from '../src/stripeReceiptClaimWorkflowRoutes.ts';
import { reserveReceiptClaimWorkflow } from '../src/stripeReceiptClaimWorkflowStore.ts';
import { ReceiptClaimWorkflowRecoveryPending } from '../src/stripeReceiptClaimWorkflowDispatch.ts';
import { createCommerceD1Harness, seedCommerceDocument } from './commerceD1Harness.ts';
import { RECEIPT_OPERATION_ID, RECEIPT_REQUEST_ID, RECEIPT_RECIPIENT, RECEIPT_RESULT, receiptWorkflowSnapshot } from './stripeReceiptClaimWorkflowFixtures.ts';

function request(body: unknown, options: { requestId?: string; signal?: AbortSignal } = {}) {
  return new Request('https://api.mons.shop/receipts/stripe/claim/start', {
    method: 'POST', headers: { 'Content-Type': 'application/json',
      ...(options.requestId ? { [STRIPE_RECEIPT_CLAIM_REQUEST_HEADER]: options.requestId } : {}) },
    body: JSON.stringify(body), signal: options.signal,
  });
}

const body = { code: 'ABCDEF-1234567890', recipient: RECEIPT_RECIPIENT };
const env = { COMMERCE_DB: {}, STRIPE_RECEIPT_CLAIM_ADMISSION_ENABLED: 'false' } as Env;

function harness() {
  const snapshot = receiptWorkflowSnapshot();
  const reservations: Array<Parameters<typeof reserveReceiptClaimWorkflow>[4]> = [];
  let ensured = 0;
  const dependencies = {
    verifyIdentity: async () => ({ kind: 'anonymous' as const, authSubject: 'anon' }),
    reserve: async (...args: Parameters<typeof reserveReceiptClaimWorkflow>) => {
      reservations.push(args[4]); return { status: 'pending' as const, snapshot: structuredClone(snapshot) };
    },
    load: async () => structuredClone(snapshot),
    ensure: async (_env: Env, value: typeof snapshot, _signal: AbortSignal, requestId?: string) => {
      ensured += 1; assert.equal(requestId, reservations.at(-1)?.requestId); return value;
    },
  };
  return { snapshot, dependencies, reservations, ensured: () => ensured };
}

test('start returns durable operation immediately and passes admission and replay identity to reservation', async () => {
  const fixture = harness();
  const result = await handleStripeReceiptClaimWorkflowStart(request(body, { requestId: RECEIPT_REQUEST_ID }),
    { ...env, HELIUS_API_KEY: ' test-key ' }, {}, fixture.dependencies);
  assert.equal(result.response.status, 202);
  assert.deepEqual(await result.response.json(), { accepted: true, operationId: RECEIPT_OPERATION_ID, status: 'pending', retryAfterMs: 2000 });
  const provider = fixture.reservations[0]?.provider;
  assert.deepEqual(fixture.reservations, [{ allowNew: false, requestId: RECEIPT_REQUEST_ID, provider }]);
  assert.equal(provider?.apiKey, 'test-key');
  assert.equal(provider?.providerFetch, fetch);
  assert.ok(provider?.signal instanceof AbortSignal);
  assert.equal(fixture.ensured(), 1);
});

test('start requires an invocation id while status requires the complete code and recipient proof', async () => {
  const fixture = harness();
  const invalid = await handleStripeReceiptClaimWorkflowStart(request(body), env, {}, fixture.dependencies);
  assert.equal(invalid.response.status, 400);
  const forbidden = await handleStripeReceiptClaimWorkflowStatus(request({ ...body, code: 'ZZZZZZ-1234567890', operationId: RECEIPT_OPERATION_ID }), env, {}, fixture.dependencies);
  assert.equal(forbidden.response.status, 404);
  const missing = await handleStripeReceiptClaimWorkflowStatus(request({ operationId: RECEIPT_OPERATION_ID }), env, {}, fixture.dependencies);
  assert.equal(missing.response.status, 400);
  assert.equal(fixture.ensured(), 0);
});

test('status is read-only and remains available while new admissions are disabled', async () => {
  const fixture = harness();
  const pending = await handleStripeReceiptClaimWorkflowStatus(request({ ...body, operationId: RECEIPT_OPERATION_ID }), env, {}, fixture.dependencies);
  assert.equal(pending.response.status, 202);
  fixture.snapshot.operation.phase = 'complete'; fixture.snapshot.operation.result = RECEIPT_RESULT;
  const complete = await handleStripeReceiptClaimWorkflowStatus(request({ ...body, operationId: RECEIPT_OPERATION_ID }), env, {}, fixture.dependencies);
  assert.equal(complete.response.status, 200);
  assert.deepEqual(await complete.response.json(), RECEIPT_RESULT);
  assert.equal(fixture.ensured(), 0);
  assert.deepEqual(fixture.reservations, []);
});

test('terminal retryable failures stop polling, infrastructure failures retry the same operation', async () => {
  const fixture = harness();
  fixture.snapshot.operation.phase = 'manual_review';
  fixture.snapshot.operation.error = { code: 'unavailable', message: 'Retry with the same receiver.', retryable: true };
  const terminal = await handleStripeReceiptClaimWorkflowStatus(request({ ...body, operationId: RECEIPT_OPERATION_ID }), env, {}, fixture.dependencies);
  assert.equal(terminal.response.status, 503);
  assert.equal(terminal.response.headers.get(STRIPE_CHECKOUT_RETRY_HEADER), null);
  const transient = await handleStripeReceiptClaimWorkflowStatus(request({ ...body, operationId: RECEIPT_OPERATION_ID }), env, {}, {
    ...fixture.dependencies, load: async () => { throw new Error('D1 temporarily offline'); },
  });
  assert.equal(transient.response.headers.get(STRIPE_CHECKOUT_RETRY_HEADER), 'same-operation');
});

test('status requires authentication before it reads an operation', async () => {
  const fixture = harness();
  let loads = 0;
  const response = await handleStripeReceiptClaimWorkflowStatus(request({ ...body, operationId: RECEIPT_OPERATION_ID }), env, {}, {
    ...fixture.dependencies,
    verifyIdentity: async () => { throw new RequestIdentityError('invalid-token'); },
    load: async () => { loads += 1; return fixture.snapshot; },
  });
  assert.equal(response.response.status, 401);
  assert.equal(loads, 0);
});

test('legacy adapter waits for the same operation and preserves the successful response shape', async () => {
  const fixture = harness();
  const result = await handleStripeReceiptClaimWorkflowLegacy(request(body), env, {}, {
    ...fixture.dependencies, sleep: async () => {
      fixture.snapshot.operation.phase = 'complete'; fixture.snapshot.operation.result = RECEIPT_RESULT;
    },
  });
  assert.equal(result.response.status, 200);
  assert.deepEqual(await result.response.json(), RECEIPT_RESULT);
  assert.equal(fixture.ensured(), 1);
  assert.match(fixture.reservations[0]?.requestId || '', /^[0-9a-f-]{36}$/);
});

test('disconnect after reservation leaves accepted work owned by the Workflow', async () => {
  const fixture = harness();
  const controller = new AbortController();
  await assert.rejects(handleStripeReceiptClaimWorkflowStart(request(body, {
    requestId: RECEIPT_REQUEST_ID, signal: controller.signal,
  }), env, {}, {
    ...fixture.dependencies, ensure: async () => { controller.abort(new Error('disconnected')); throw controller.signal.reason; },
  }), /disconnected/);
  assert.equal(fixture.reservations.length, 1);
  assert.equal(fixture.snapshot.operation.phase, 'pending');
});

test('short status deadlines return even when D1 ignores the AbortSignal', async () => {
  const fixture = harness();
  const response = await handleStripeReceiptClaimWorkflowStatus(request({ ...body, operationId: RECEIPT_OPERATION_ID }), env, {}, {
    ...fixture.dependencies, httpTimeoutMs: 5, load: () => new Promise(() => undefined),
  });
  assert.equal(response.response.status, 504);
  assert.equal(response.response.headers.get(STRIPE_CHECKOUT_RETRY_HEADER), 'same-operation');
});

test('short start deadlines return when reservation acknowledgement stalls', async () => {
  const fixture = harness();
  const response = await handleStripeReceiptClaimWorkflowStart(request(body, { requestId: RECEIPT_REQUEST_ID }), env, {}, {
    ...fixture.dependencies, httpTimeoutMs: 5, reserve: () => new Promise(() => undefined),
  });
  assert.equal(response.response.status, 504);
  assert.equal(response.response.headers.get(STRIPE_CHECKOUT_RETRY_HEADER), 'same-operation');
});

for (const [mode, handle] of [
  ['start', handleStripeReceiptClaimWorkflowStart],
  ['legacy', handleStripeReceiptClaimWorkflowLegacy],
] as const) {
  for (const stalled of ['proof', 'assignment'] as const) {
    test(`${mode} returns completed legacy claims when optional ${stalled} enrichment stalls`, async (t) => {
      const fixture = createCommerceD1Harness();
      t.after(() => fixture.database.close());
      const claimKey = commerceKeys.claimCode(body.code);
      seedCommerceDocument(fixture, { key: claimKey, data: {
        namespace: 'stripe_receipt_v1', code: body.code, dropId: 'card_nft_2', deliveryId: 1,
        boxId: 16, status: 'claimed', recipient: RECEIPT_RECIPIENT, receiptTxs: ['signature'],
      } });
      seedCommerceDocument(fixture, { key: commerceKeys.deliveryOrder('card_nft_2', '1'), data: {
        dropId: 'card_nft_2', deliveryId: 1,
        irlClaims: [{ boxId: 16, boxAssetId: 'pack-asset', dudeIds: [46, 47, 48] }],
      } });
      const repository = new D1CommerceRepository(fixture.db);
      const stored = await repository.get(claimKey);
      const runtime = runtimeForDrop('card_nft_2');
      let stalledCalls = 0;
      let ensured = 0;
      let requestSignal: AbortSignal | undefined;
      const response = await handle(request(body, { requestId: RECEIPT_REQUEST_ID }), {
        ...env, COMMERCE_DB: fixture.db, HELIUS_API_KEY: 'test-key',
      }, {}, {
        httpTimeoutMs: 1050, legacyTimeoutMs: 1050,
        verifyIdentity: async () => ({ kind: 'anonymous' as const, authSubject: 'anon' }),
        ensure: async (_env, snapshot) => { ensured += 1; return snapshot; },
        reserve: async (context, code, recipient, nowMs, options) => {
          requestSignal = context.signal;
          if (stalled === 'assignment') {
            t.mock.method(context.repository, 'get', () => {
              stalledCalls += 1;
              return new Promise(() => undefined);
            });
          }
          return reserveReceiptClaimWorkflow(context, code, recipient, nowMs, {
            ...options,
            provider: { ...options!.provider!, providerFetch: async (_input, init) => {
              const rpc = JSON.parse(String(init?.body)) as { id: string; method: string };
              if (rpc.method === 'getAssetProof') {
                stalledCalls += 1;
                return new Promise(() => undefined);
              }
              assert.equal(rpc.method, 'searchAssets');
              return Response.json({ jsonrpc: '2.0', id: rpc.id, result: {
                total: 3, limit: 1000, page: 1, items: [46, 47, 48].map((id) => ({
                  id: `figure-${id}`, ownership: { owner: RECEIPT_RECIPIENT },
                  grouping: [{ group_key: 'collection', group_value: runtime.collectionMint.toBase58() }],
                  content: { json_uri: `${runtime.config.metadataBase}/rf${id}.json` },
                })),
              } });
            } },
          });
        },
      });
      assert.equal(response.response.status, 200);
      assert.deepEqual(await response.response.json(), RECEIPT_RESULT);
      assert.equal(response.response.headers.get(STRIPE_CHECKOUT_RETRY_HEADER), null);
      assert.ok(stalledCalls > 0);
      assert.equal(requestSignal?.aborted, false);
      assert.equal(ensured, 0);
      assert.deepEqual(await repository.get(claimKey), stored);
    });
  }
}

test('retired instance recovery asks the client to retry the same invocation', async () => {
  const fixture = harness();
  const response = await handleStripeReceiptClaimWorkflowStart(request(body, { requestId: RECEIPT_REQUEST_ID }), env, {}, {
    ...fixture.dependencies, ensure: async () => { throw new ReceiptClaimWorkflowRecoveryPending(); },
  });
  assert.equal(response.response.status, 503);
  assert.equal(response.response.headers.get(STRIPE_CHECKOUT_RETRY_HEADER), 'same-operation');
});
