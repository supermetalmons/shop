import assert from 'node:assert/strict';
import test from 'node:test';
import { Keypair } from '@solana/web3.js';
import { FirebaseIdTokenError } from '../src/firebaseIdToken.ts';
import { FIRESTORE_DOCUMENT_NAME_PREFIX } from '../src/firestoreRest.ts';
import { deliveryReceiptRuntime } from '../src/deliveryReceipts.ts';
import {
  STRIPE_RECEIPT_CLAIM_PATH,
  StripeReceiptClaimError,
  handleStripeReceiptClaim,
  stripeReceiptClaimTestHooks,
} from '../src/stripeReceiptClaim.ts';

const CODE = 'ABCDEF-1234567890';
const DROP_ID = 'card_nft_2';
const DELIVERY_ID = 7;
const BOX_ID = 16;
const RECIPIENT = Keypair.generate().publicKey.toBase58();
const OTHER_RECIPIENT = Keypair.generate().publicKey.toBase58();
const RECEIPT_ASSET_ID = Keypair.generate().publicKey.toBase58();
const SIGNATURE = Keypair.generate().publicKey.toBase58().repeat(2).slice(0, 88);

function request(body: unknown = { code: CODE, recipient: RECIPIENT }, init: RequestInit = {}): Request {
  return new Request(`https://api.mons.shop${STRIPE_RECEIPT_CLAIM_PATH}`, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer firebase-token',
      'Content-Type': 'application/json',
      Origin: 'https://mons.shop',
      ...init.headers,
    },
    body: JSON.stringify(body),
    ...init,
  });
}

function env(overrides: Partial<Record<'COSIGNER_SECRET' | 'FIRESTORE_WRITER_SERVICE_ACCOUNT_JSON' | 'HELIUS_API_KEY', string>> = {}) {
  return {
    COSIGNER_SECRET: 'cosigner',
    FIRESTORE_WRITER_SERVICE_ACCOUNT_JSON: '{"credential":"test"}',
    HELIUS_API_KEY: 'helius',
    ...overrides,
  };
}

function dependencies(overrides: Record<string, unknown> = {}) {
  return {
    verifyIdToken: async () => ({ kind: 'firebase' as const, uid: 'firebase-uid' }),
    providerFetch: async () => { throw new Error('unexpected provider fetch'); },
    nowMs: () => 1_700_000_000_000,
    timeoutMs: 1_000,
    claim: async () => ({
      response: {
        processed: true as const,
        dropId: DROP_ID,
        deliveryId: DELIVERY_ID,
        receiptsTransferred: 1,
        receiptTxs: [SIGNATURE],
        receiptKind: 'box' as const,
      },
      outcome: 'claimed_box' as const,
    }),
    ...overrides,
  };
}

function firestoreContext(
  documents: Record<string, Record<string, unknown>>,
  calls: Array<{ url: string; init?: RequestInit }> = [],
  options: { commitConflicts?: number } = {},
) {
  let commitConflicts = options.commitConflicts || 0;
  return {
    accessTokenProvider: {
      get: async () => 'firestore-token',
      invalidate: () => undefined,
    },
    nowMs: 1_700_000_000_000,
    providerFetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.endsWith(':beginTransaction')) return Response.json({ transaction: 'transaction' });
      if (url.endsWith(':commit')) {
        if (commitConflicts > 0) {
          commitConflicts -= 1;
          return Response.json({ error: { status: 'ABORTED' } }, { status: 409 });
        }
        return Response.json({});
      }
      if (url.endsWith(':rollback')) return Response.json({});
      if (url.includes('/documents/') && init?.method === 'GET') {
        const path = decodeURIComponent(new URL(url).pathname.split('/documents/')[1]);
        const fields = documents[path];
        if (!fields) return Response.json({ error: { status: 'NOT_FOUND' } }, { status: 404 });
        return Response.json({
          name: `${FIRESTORE_DOCUMENT_NAME_PREFIX}${path}`,
          fields: Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, deliveryReceiptRuntime.firestoreValue(value)])),
          updateTime: '2026-08-22T00:00:00.000Z',
        });
      }
      throw new Error(`Unexpected Firestore request: ${url}`);
    },
    serviceAccountJson: '{}',
    signal: new AbortController().signal,
  };
}

function directDocuments(submissionStatus: 'submitted' | 'not_landed' = 'submitted') {
  const documents = unclaimedDocuments();
  documents[`claimCodes/${CODE}`] = {
    ...documents[`claimCodes/${CODE}`],
    receiptKind: 'figure',
    receiptAssetId: RECEIPT_ASSET_ID,
    figureId: BOX_ID,
    recipient: RECIPIENT,
    receiptTxs: [SIGNATURE],
    receiptTxSubmissions: [{
      signature: SIGNATURE,
      lastValidBlockHeight: 200,
      submittedAtMs: 1_700_000_000_000,
      status: submissionStatus,
    }],
  };
  documents[`drops/${DROP_ID}/deliveryOrders/${DELIVERY_ID}`] = {
    ...documents[`drops/${DROP_ID}/deliveryOrders/${DELIVERY_ID}`],
    stripeReceiptClaim: {
      namespace: 'stripe_receipt_v1',
      code: CODE,
      boxId: BOX_ID,
      status: 'unclaimed',
      receiptKind: 'figure',
      receiptAssetId: RECEIPT_ASSET_ID,
      figureId: BOX_ID,
    },
  };
  return documents;
}

type StartedClaim = Parameters<typeof stripeReceiptClaimTestHooks.finalizeClaim>[1];

function startedClaim(overrides: Partial<StartedClaim> = {}): StartedClaim {
  return {
    status: 'started',
    dropId: DROP_ID,
    deliveryId: DELIVERY_ID,
    boxId: BOX_ID,
    attemptId: 'attempt',
    orderPath: `drops/${DROP_ID}/deliveryOrders/${DELIVERY_ID}`,
    orderIrlClaims: [],
    resumingPreviousProcessingClaim: false,
    hasPreviousClaimFailure: false,
    updatePluralOrderClaim: false,
    updateSingularOrderClaim: true,
    receiptTxs: [],
    receiptTxSubmissions: [],
    ...overrides,
  };
}

function unclaimedDocuments(): Record<string, Record<string, unknown>> {
  return {
    [`claimCodes/${CODE}`]: {
      namespace: 'stripe_receipt_v1',
      code: CODE,
      dropId: DROP_ID,
      deliveryId: DELIVERY_ID,
      boxId: BOX_ID,
      status: 'unclaimed',
    },
    [`drops/${DROP_ID}/deliveryOrders/${DELIVERY_ID}`]: {
      dropId: DROP_ID,
      deliveryId: DELIVERY_ID,
      source: 'stripe_offchain',
      stripeReceiptClaim: {
        namespace: 'stripe_receipt_v1',
        code: CODE,
        boxId: BOX_ID,
        status: 'unclaimed',
      },
      irlClaims: [],
    },
  };
}

test('Stripe receipt claim route preserves the authenticated request and exact response contract', async () => {
  let observedBody: unknown;
  let observedUid = '';
  const result = await handleStripeReceiptClaim(
    request(),
    env(),
    () => undefined,
    dependencies({
      verifyIdToken: async () => {
        observedUid = 'firebase-uid';
        return { uid: observedUid };
      },
      claim: async (body: unknown) => {
        observedBody = body;
        return dependencies().claim();
      },
    }),
  );
  assert.equal(observedUid, 'firebase-uid');
  assert.deepEqual(observedBody, { code: CODE, recipient: RECIPIENT });
  assert.equal(result.response.status, 200);
  assert.equal(result.authOutcome, 'accepted');
  assert.equal(result.dropId, DROP_ID);
  assert.equal(result.deliveryId, DELIVERY_ID);
  assert.equal(result.outcome, 'claimed_box');
  assert.deepEqual(await result.response.json(), {
    processed: true,
    dropId: DROP_ID,
    deliveryId: DELIVERY_ID,
    receiptsTransferred: 1,
    receiptTxs: [SIGNATURE],
    receiptKind: 'box',
  });
});

test('Stripe receipt claim route enforces authentication, method, exact input, and secrets', async () => {
  const unauthenticated = await handleStripeReceiptClaim(
    request(),
    env(),
    () => undefined,
    dependencies({ verifyIdToken: async () => { throw new FirebaseIdTokenError('invalid-token'); } }),
  );
  assert.equal(unauthenticated.response.status, 401);
  assert.deepEqual(await unauthenticated.response.json(), {
    ok: false,
    error: { code: 'unauthenticated', message: 'Authentication is required.' },
  });

  const method = await handleStripeReceiptClaim(
    new Request(`https://api.mons.shop${STRIPE_RECEIPT_CLAIM_PATH}`),
    env(),
    () => undefined,
    dependencies(),
  );
  assert.equal(method.response.status, 405);
  assert.equal(method.response.headers.get('allow'), 'POST, OPTIONS');

  const extra = await handleStripeReceiptClaim(
    request({ code: CODE, recipient: RECIPIENT, extra: true }),
    env(),
    () => undefined,
    dependencies(),
  );
  assert.equal(extra.response.status, 400);

  const missingSecret = await handleStripeReceiptClaim(
    request(),
    env({ COSIGNER_SECRET: '' }),
    () => undefined,
    dependencies(),
  );
  assert.equal(missingSecret.response.status, 502);
  assert.equal(missingSecret.outcome, 'unavailable');
});

test('Stripe receipt claim handler returns its deadline and tracks unfinished cleanup', async () => {
  const deferred: Promise<unknown>[] = [];
  let aborted = false;
  const result = await handleStripeReceiptClaim(
    request(),
    env(),
    (promise) => deferred.push(promise),
    dependencies({
      timeoutMs: 1,
      claim: async (
        _body: unknown,
        _env: unknown,
        firestore: { signal: AbortSignal },
        _provider: unknown,
        onContext: (context: { dropId: string; deliveryId: number }) => void,
      ) => {
        onContext({ dropId: DROP_ID, deliveryId: DELIVERY_ID });
        await new Promise<void>((resolve) => {
          const onAbort = () => { aborted = true; resolve(); };
          firestore.signal.addEventListener('abort', onAbort, { once: true });
          if (firestore.signal.aborted) onAbort();
        });
        throw new StripeReceiptClaimError('deadline-exceeded', 'Timed out.');
      },
    }),
  );
  assert.equal(result.response.status, 504);
  assert.equal(result.outcome, 'deadline-exceeded');
  assert.equal(result.dropId, DROP_ID);
  assert.equal(result.deliveryId, DELIVERY_ID);
  assert.equal(aborted, true);
  assert.equal(deferred.length, 1);
  await Promise.all(deferred);
});

test('Stripe receipt claim start writes compatible claim and order leases', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const result = await stripeReceiptClaimTestHooks.startClaim(
    firestoreContext(unclaimedDocuments(), calls),
    CODE,
    RECIPIENT,
    'stripe_receipt:attempt',
    1_700_000_000_000,
  );
  assert.equal(result.status, 'started');
  assert.equal(result.dropId, DROP_ID);
  assert.equal(result.deliveryId, DELIVERY_ID);
  const commit = calls.find((call) => call.url.endsWith(':commit'));
  assert.ok(commit);
  const payload = JSON.parse(String(commit.init?.body)) as {
    transaction: string;
    writes: Array<{
      update: { fields: Record<string, { stringValue?: string; timestampValue?: string }> };
      updateMask: { fieldPaths: string[] };
    }>;
  };
  assert.equal(payload.transaction, 'transaction');
  assert.equal(payload.writes.length, 2);
  assert.equal(payload.writes[0].update.fields.status.stringValue, 'processing');
  assert.equal(payload.writes[0].update.fields.processingAttemptId.stringValue, 'stripe_receipt:attempt');
  assert.ok(payload.writes[0].update.fields.processingLeaseExpiresAt.timestampValue);
  assert.equal(payload.writes[1].update.fields.dropId.stringValue, DROP_ID);
});

test('Stripe receipt claim start is idempotent and preserves recipient locks', async () => {
  const claimed = unclaimedDocuments();
  claimed[`claimCodes/${CODE}`] = {
    ...claimed[`claimCodes/${CODE}`],
    status: 'claimed',
    recipient: RECIPIENT,
    receiptTxs: [SIGNATURE],
    receiptKind: 'box',
    receiptsTransferred: 1,
  };
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const result = await stripeReceiptClaimTestHooks.startClaim(
    firestoreContext(claimed, calls),
    CODE,
    RECIPIENT,
    'attempt',
    1_700_000_000_000,
  );
  assert.equal(result.status, 'already_claimed');
  assert.equal(calls.some((call) => call.url.endsWith(':commit')), false);
  assert.equal(calls.some((call) => call.url.endsWith(':rollback')), true);

  await assert.rejects(() => stripeReceiptClaimTestHooks.startClaim(
    firestoreContext(claimed),
    CODE,
    Keypair.generate().publicKey.toBase58(),
    'attempt',
    1_700_000_000_000,
  ), /already been used/);

  const active = unclaimedDocuments();
  active[`claimCodes/${CODE}`] = {
    ...active[`claimCodes/${CODE}`],
    status: 'processing',
    recipient: RECIPIENT,
    processingLeaseExpiresAt: 1_700_000_100_000,
  };
  await assert.rejects(() => stripeReceiptClaimTestHooks.startClaim(
    firestoreContext(active),
    CODE,
    RECIPIENT,
    'attempt',
    1_700_000_000_000,
  ), /already being processed/);
});

test('Stripe receipt claim start rejects missing and inconsistent records and resumes an expired lease', async () => {
  await assert.rejects(() => stripeReceiptClaimTestHooks.startClaim(
    firestoreContext({}),
    CODE,
    RECIPIENT,
    'attempt',
    1_700_000_000_000,
  ), /Invalid receipt claim code/);

  const inconsistent = unclaimedDocuments();
  inconsistent[`claimCodes/${CODE}`] = { ...inconsistent[`claimCodes/${CODE}`], code: 'ZZZZZZ-1234567890' };
  await assert.rejects(() => stripeReceiptClaimTestHooks.startClaim(
    firestoreContext(inconsistent),
    CODE,
    RECIPIENT,
    'attempt',
    1_700_000_000_000,
  ), /inconsistent/);

  const expired = unclaimedDocuments();
  expired[`claimCodes/${CODE}`] = {
    ...expired[`claimCodes/${CODE}`],
    status: 'processing',
    recipient: RECIPIENT,
    processingAttemptId: 'expired-attempt',
    processingLeaseExpiresAt: 1_699_999_999_999,
  };
  const resumed = await stripeReceiptClaimTestHooks.startClaim(
    firestoreContext(expired),
    CODE,
    RECIPIENT,
    'attempt',
    1_700_000_000_000,
  );
  assert.equal(resumed.status, 'started');
  assert.equal(resumed.resumingPreviousProcessingClaim, true);
});

test('Stripe receipt claim direct recipient lock clears only after proven non-landing', async () => {
  await assert.rejects(() => stripeReceiptClaimTestHooks.startClaim(
    firestoreContext(directDocuments()),
    CODE,
    OTHER_RECIPIENT,
    'attempt',
    1_700_000_100_000,
  ), /locked to the receiver/);

  const restarted = await stripeReceiptClaimTestHooks.startClaim(
    firestoreContext(directDocuments('not_landed')),
    CODE,
    OTHER_RECIPIENT,
    'attempt',
    1_700_000_100_000,
  );
  assert.equal(restarted.status, 'started');
  assert.deepEqual(restarted.receiptTxs, []);
});

test('Stripe receipt claim retries Firestore conflicts and updates plural and singular claims', async () => {
  const documents = unclaimedDocuments();
  const orderPath = `drops/${DROP_ID}/deliveryOrders/${DELIVERY_ID}`;
  documents[orderPath] = {
    ...documents[orderPath],
    stripeReceiptClaimsByBoxId: {
      box_16: { namespace: 'stripe_receipt_v1', code: CODE, boxId: BOX_ID, status: 'unclaimed' },
    },
  };
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const result = await stripeReceiptClaimTestHooks.startClaim(
    firestoreContext(documents, calls, { commitConflicts: 1 }),
    CODE,
    RECIPIENT,
    'attempt',
    1_700_000_000_000,
  );
  assert.equal(result.status, 'started');
  assert.equal(calls.filter((call) => call.url.endsWith(':commit')).length, 2);
  const successfulCommit = calls.filter((call) => call.url.endsWith(':commit')).at(-1);
  const payload = JSON.parse(String(successfulCommit?.init?.body)) as {
    writes: Array<{ updateMask: { fieldPaths: string[] } }>;
  };
  const orderMask = payload.writes[1].updateMask.fieldPaths;
  assert.equal(orderMask.includes('stripeReceiptClaimsByBoxId.box_16.status'), true);
  assert.equal(orderMask.includes('stripeReceiptClaim.status'), true);
});

test('Stripe receipt claim cleanup and candidate persistence are attempt-owned', async () => {
  const documents = unclaimedDocuments();
  documents[`claimCodes/${CODE}`] = {
    ...documents[`claimCodes/${CODE}`],
    status: 'processing',
    recipient: RECIPIENT,
    processingAttemptId: 'other-attempt',
  };
  const staleCalls: Array<{ url: string; init?: RequestInit }> = [];
  await stripeReceiptClaimTestHooks.clearProcessing(
    firestoreContext(documents, staleCalls),
    startedClaim(),
    CODE,
    new Error('failed'),
  );
  assert.equal(staleCalls.some((call) => call.url.endsWith(':commit')), false);

  documents[`claimCodes/${CODE}`] = {
    ...documents[`claimCodes/${CODE}`],
    processingAttemptId: 'attempt',
  };
  const ownerCalls: Array<{ url: string; init?: RequestInit }> = [];
  await stripeReceiptClaimTestHooks.clearProcessing(
    firestoreContext(documents, ownerCalls),
    startedClaim(),
    CODE,
    new Error('failed'),
  );
  const cleanupCommit = ownerCalls.find((call) => call.url.endsWith(':commit'));
  const cleanupPayload = JSON.parse(String(cleanupCommit?.init?.body)) as {
    writes: Array<{ updateMask: { fieldPaths: string[] } }>;
  };
  assert.equal(cleanupPayload.writes[0].updateMask.fieldPaths.includes('processingAttemptId'), true);

  documents[`claimCodes/${CODE}`] = {
    ...directDocuments()[`claimCodes/${CODE}`],
    status: 'processing',
    processingAttemptId: 'attempt',
    receiptTxs: [],
    receiptTxSubmissions: [],
  };
  const candidateCalls: Array<{ url: string; init?: RequestInit }> = [];
  await stripeReceiptClaimTestHooks.rememberSubmittedTransaction(
    firestoreContext(documents, candidateCalls),
    CODE,
    'attempt',
    SIGNATURE,
    { lastValidBlockHeight: 200, submittedAtMs: 1_700_000_000_000, status: 'submitted' },
  );
  const candidateCommit = candidateCalls.find((call) => call.url.endsWith(':commit'));
  const candidatePayload = JSON.parse(String(candidateCommit?.init?.body)) as {
    writes: Array<{ update: { fields: Record<string, unknown> }; updateMask: { fieldPaths: string[] } }>;
  };
  assert.equal(candidatePayload.writes[0].updateMask.fieldPaths.includes('receiptTxSubmissions'), true);
  assert.equal(candidatePayload.writes[0].updateMask.fieldPaths.includes('processingLeaseExpiresAt'), true);
});

test('Stripe receipt claim execution returns a claimed record without provider or Solana work', async () => {
  const documents = unclaimedDocuments();
  documents[`claimCodes/${CODE}`] = {
    ...documents[`claimCodes/${CODE}`],
    status: 'claimed',
    recipient: RECIPIENT,
    receiptTxs: [SIGNATURE],
    receiptKind: 'box',
    receiptsTransferred: 1,
  };
  let providerCalled = false;
  const result = await stripeReceiptClaimTestHooks.claimStripeReceipt(
    { code: CODE, recipient: RECIPIENT },
    env(),
    firestoreContext(documents),
    {
      apiKey: 'helius',
      providerFetch: async () => {
        providerCalled = true;
        throw new Error('unexpected provider request');
      },
      signal: new AbortController().signal,
    },
  );
  assert.equal(providerCalled, false);
  assert.equal(result.outcome, 'already_claimed');
  assert.deepEqual(result.response, {
    processed: true,
    dropId: DROP_ID,
    deliveryId: DELIVERY_ID,
    receiptsTransferred: 1,
    receiptTxs: [SIGNATURE],
    receiptKind: 'box',
  });
});

test('Stripe receipt claim finalization only accepts the owning attempt', async () => {
  const documents = unclaimedDocuments();
  documents[`claimCodes/${CODE}`] = {
    ...documents[`claimCodes/${CODE}`],
    status: 'processing',
    recipient: RECIPIENT,
    processingAttemptId: 'attempt',
  };
  const started = startedClaim();
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const receiptTxs = await stripeReceiptClaimTestHooks.finalizeClaim(
    firestoreContext(documents, calls),
    started,
    CODE,
    RECIPIENT,
    SIGNATURE,
    'box',
    1,
  );
  assert.deepEqual(receiptTxs, [SIGNATURE]);
  const commit = calls.find((call) => call.url.endsWith(':commit'));
  const payload = JSON.parse(String(commit?.init?.body)) as {
    writes: Array<{ update: { fields: Record<string, { stringValue?: string }> }; updateMask: { fieldPaths: string[] } }>;
  };
  assert.equal(payload.writes[0].update.fields.status.stringValue, 'claimed');
  assert.equal(payload.writes[0].updateMask.fieldPaths.includes('processingAttemptId'), true);

  documents[`claimCodes/${CODE}`] = { ...documents[`claimCodes/${CODE}`], processingAttemptId: 'different' };
  await assert.rejects(() => stripeReceiptClaimTestHooks.finalizeClaim(
    firestoreContext(documents),
    started,
    CODE,
    RECIPIENT,
    SIGNATURE,
    'box',
    1,
  ), /lease changed/);
});

test('Stripe receipt claim selects legacy, openable, and direct flows', () => {
  assert.equal(stripeReceiptClaimTestHooks.claimFlowFor(undefined, 0), 'legacy_pack');
  assert.equal(stripeReceiptClaimTestHooks.claimFlowFor(undefined, 1), 'openable_pack');
  assert.equal(stripeReceiptClaimTestHooks.claimFlowFor({ receiptAssetId: RECEIPT_ASSET_ID, figureId: BOX_ID }, 0), 'direct_figure');
});

test('Stripe receipt claim response and order target validators reject inconsistent data', () => {
  assert.deepEqual(stripeReceiptClaimTestHooks.responseForClaim({
    dropId: DROP_ID,
    deliveryId: DELIVERY_ID,
    receiptTxs: [SIGNATURE, SIGNATURE],
    receiptKind: 'figure',
    figureIds: [1, 2, 3],
  }), {
    processed: true,
    dropId: DROP_ID,
    deliveryId: DELIVERY_ID,
    receiptsTransferred: 3,
    receiptTxs: [SIGNATURE, SIGNATURE],
    receiptKind: 'figure',
    figureIds: [1, 2, 3],
  });
  assert.throws(() => stripeReceiptClaimTestHooks.orderTarget({
    stripeReceiptClaimsByBoxId: {
      box_16: { code: 'ZZZZZZ-1234567890', boxId: BOX_ID },
    },
  }, CODE, BOX_ID), /mismatch/);
});
