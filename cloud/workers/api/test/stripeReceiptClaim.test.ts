import assert from 'node:assert/strict';
import test from 'node:test';
import { createCommerceD1, createCommerceD1Harness, seedCommerceDocument } from './commerceD1Harness.ts';
import { Keypair } from '@solana/web3.js';
import { RequestIdentityError } from '../src/requestIdentity.ts';
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
      'Content-Type': 'application/json',
      Origin: 'https://mons.shop',
      ...init.headers,
    },
    body: JSON.stringify(body),
    ...init,
  });
}

function env(overrides: Partial<Record<'COSIGNER_SECRET' | 'HELIUS_API_KEY', string>> = {}) {
  return {
    COMMERCE_DB: createCommerceD1(),
    COSIGNER_SECRET: 'cosigner',
    HELIUS_API_KEY: 'helius',
    ...overrides,
  };
}

function dependencies(overrides: Record<string, unknown> = {}) {
  return {
    verifyIdentity: async () => ({ kind: 'anonymous' as const, authSubject: 'firebase-uid' }),
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

function storedValue(value: unknown): Record<string, unknown> {
  if (value === null) return { nullValue: null };
  if (typeof value === 'string') return { stringValue: value };
  if (typeof value === 'boolean') return { booleanValue: value };
  if (typeof value === 'number') return { integerValue: String(value) };
  if (Array.isArray(value)) return { arrayValue: { values: value.map(storedValue) } };
  return {
    mapValue: {
      fields: Object.fromEntries(Object.entries(value as Record<string, unknown>).map(
        ([key, entry]) => [key, storedValue(entry)],
      )),
    },
  };
}

function conflictDatabase(db: D1Database, conflicts: number): D1Database {
  return {
    ...db,
    batch: async (statements) => {
      if (conflicts > 0) {
        conflicts -= 1;
        throw new Error('transaction conflict');
      }
      return db.batch(statements);
    },
  } as D1Database;
}

function commerceContext(
  documents: Record<string, Record<string, unknown>>,
  _calls: Array<{ url: string; init?: RequestInit }> = [],
  options: { commitConflicts?: number } = {},
) {
  const harness = createCommerceD1Harness();
  for (const [path, fields] of Object.entries(documents)) {
    seedCommerceDocument(harness, {
      name: `projects/mons-shop/databases/(default)/documents/${path}`,
      fields: Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, storedValue(value)])),
      updateTime: '2026-08-22T00:00:00.000Z',
    });
  }
  return {
    commerceDb: options.commitConflicts
      ? conflictDatabase(harness.db, options.commitConflicts)
      : harness.db,
    nowMs: 1_700_000_000_000,
    providerFetch: async () => assert.fail('commerce persistence must not use provider fetch'),
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
      verifyIdentity: async () => {
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
    dependencies({ verifyIdentity: async () => { throw new RequestIdentityError('invalid-token'); } }),
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
  const context = commerceContext(unclaimedDocuments());
  const result = await stripeReceiptClaimTestHooks.startClaim(
    context,
    CODE,
    RECIPIENT,
    'stripe_receipt:attempt',
    1_700_000_000_000,
  );
  assert.equal(result.status, 'started');
  assert.equal(result.dropId, DROP_ID);
  assert.equal(result.deliveryId, DELIVERY_ID);
  const claim = await deliveryReceiptRuntime.readDocument(context, `claimCodes/${CODE}`);
  const order = await deliveryReceiptRuntime.readDocument(context, `drops/${DROP_ID}/deliveryOrders/${DELIVERY_ID}`);
  assert.equal(claim?.fields.status, 'processing');
  assert.equal(claim?.fields.processingAttemptId, 'stripe_receipt:attempt');
  assert.equal(claim?.fields.processingLeaseExpiresAt, 1_700_000_090_000);
  assert.equal(order?.fields.dropId, DROP_ID);
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
  const result = await stripeReceiptClaimTestHooks.startClaim(
    commerceContext(claimed),
    CODE,
    RECIPIENT,
    'attempt',
    1_700_000_000_000,
  );
  assert.equal(result.status, 'already_claimed');

  await assert.rejects(() => stripeReceiptClaimTestHooks.startClaim(
    commerceContext(claimed),
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
    commerceContext(active),
    CODE,
    RECIPIENT,
    'attempt',
    1_700_000_000_000,
  ), /already being processed/);
});

test('Stripe receipt claim start rejects missing and inconsistent records and resumes an expired lease', async () => {
  await assert.rejects(() => stripeReceiptClaimTestHooks.startClaim(
    commerceContext({}),
    CODE,
    RECIPIENT,
    'attempt',
    1_700_000_000_000,
  ), /Invalid receipt claim code/);

  const inconsistent = unclaimedDocuments();
  inconsistent[`claimCodes/${CODE}`] = { ...inconsistent[`claimCodes/${CODE}`], code: 'ZZZZZZ-1234567890' };
  await assert.rejects(() => stripeReceiptClaimTestHooks.startClaim(
    commerceContext(inconsistent),
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
    commerceContext(expired),
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
    commerceContext(directDocuments()),
    CODE,
    OTHER_RECIPIENT,
    'attempt',
    1_700_000_100_000,
  ), /locked to the receiver/);

  const restarted = await stripeReceiptClaimTestHooks.startClaim(
    commerceContext(directDocuments('not_landed')),
    CODE,
    OTHER_RECIPIENT,
    'attempt',
    1_700_000_100_000,
  );
  assert.equal(restarted.status, 'started');
  assert.deepEqual(restarted.receiptTxs, []);
});

test('Stripe receipt claim retries D1 conflicts and updates plural and singular claims', async () => {
  const documents = unclaimedDocuments();
  const orderPath = `drops/${DROP_ID}/deliveryOrders/${DELIVERY_ID}`;
  documents[orderPath] = {
    ...documents[orderPath],
    stripeReceiptClaimsByBoxId: {
      box_16: { namespace: 'stripe_receipt_v1', code: CODE, boxId: BOX_ID, status: 'unclaimed' },
    },
  };
  const context = commerceContext(documents, [], { commitConflicts: 1 });
  const result = await stripeReceiptClaimTestHooks.startClaim(
    context,
    CODE,
    RECIPIENT,
    'attempt',
    1_700_000_000_000,
  );
  assert.equal(result.status, 'started');
  const order = await deliveryReceiptRuntime.readDocument(context, orderPath);
  assert.equal(
    ((order?.fields.stripeReceiptClaimsByBoxId as Record<string, any>)?.box_16 as Record<string, unknown>)?.status,
    'processing',
  );
  assert.equal((order?.fields.stripeReceiptClaim as Record<string, unknown>)?.status, 'processing');
});

test('Stripe receipt claim cleanup and candidate persistence are attempt-owned', async () => {
  const documents = unclaimedDocuments();
  documents[`claimCodes/${CODE}`] = {
    ...documents[`claimCodes/${CODE}`],
    status: 'processing',
    recipient: RECIPIENT,
    processingAttemptId: 'other-attempt',
  };
  const staleContext = commerceContext(documents);
  await stripeReceiptClaimTestHooks.clearProcessing(
    staleContext,
    startedClaim(),
    CODE,
    new Error('failed'),
  );
  assert.equal((await deliveryReceiptRuntime.readDocument(staleContext, `claimCodes/${CODE}`))?.fields.status, 'processing');

  documents[`claimCodes/${CODE}`] = {
    ...documents[`claimCodes/${CODE}`],
    processingAttemptId: 'attempt',
  };
  const ownerContext = commerceContext(documents);
  await stripeReceiptClaimTestHooks.clearProcessing(
    ownerContext,
    startedClaim(),
    CODE,
    new Error('failed'),
  );
  const cleaned = await deliveryReceiptRuntime.readDocument(ownerContext, `claimCodes/${CODE}`);
  assert.equal(cleaned?.fields.status, 'unclaimed');
  assert.equal(cleaned?.fields.processingAttemptId, undefined);

  documents[`claimCodes/${CODE}`] = {
    ...directDocuments()[`claimCodes/${CODE}`],
    status: 'processing',
    processingAttemptId: 'attempt',
    receiptTxs: [],
    receiptTxSubmissions: [],
  };
  const candidateContext = commerceContext(documents);
  await stripeReceiptClaimTestHooks.rememberSubmittedTransaction(
    candidateContext,
    CODE,
    'attempt',
    SIGNATURE,
    { lastValidBlockHeight: 200, submittedAtMs: 1_700_000_000_000, status: 'submitted' },
  );
  const candidate = await deliveryReceiptRuntime.readDocument(candidateContext, `claimCodes/${CODE}`);
  assert.equal(Array.isArray(candidate?.fields.receiptTxSubmissions), true);
  assert.equal(Number.isSafeInteger(candidate?.fields.processingLeaseExpiresAt), true);
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
    commerceContext(documents),
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
  const context = commerceContext(documents);
  const receiptTxs = await stripeReceiptClaimTestHooks.finalizeClaim(
    context,
    started,
    CODE,
    RECIPIENT,
    SIGNATURE,
    'box',
    1,
  );
  assert.deepEqual(receiptTxs, [SIGNATURE]);
  const finalized = await deliveryReceiptRuntime.readDocument(context, `claimCodes/${CODE}`);
  assert.equal(finalized?.fields.status, 'claimed');
  assert.equal(finalized?.fields.processingAttemptId, undefined);

  documents[`claimCodes/${CODE}`] = { ...documents[`claimCodes/${CODE}`], processingAttemptId: 'different' };
  await assert.rejects(() => stripeReceiptClaimTestHooks.finalizeClaim(
    commerceContext(documents),
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
