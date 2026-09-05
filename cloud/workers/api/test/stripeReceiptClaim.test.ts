import assert from 'node:assert/strict';
import test from 'node:test';
import { createCommerceD1, createCommerceD1Harness, seedCommerceDocument } from './commerceD1Harness.ts';
import {
  createDeferredWorkCollector,
  failOnDeferredWork,
  isDeferredWorkRegistrationError,
} from './deferredWork.ts';
import bs58 from 'bs58';
import { Connection, Keypair, PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import {
  BOX_MINTER_CONFIG_ACCOUNT_SIZE_DROP_SEED,
  BOX_MINTER_CONFIG_DISCRIMINATOR,
} from '../../../../shared/boxMinterConfigCodec.ts';
import { MPL_CORE_PROGRAM_ADDRESS, MPL_NOOP_PROGRAM_ADDRESS } from '../../../../shared/solanaProgramAddresses.ts';
import { RequestIdentityError } from '../src/requestIdentity.ts';
import { readCommerceRecord, requireCommerceKey } from '../src/commerceTransactions.ts';
import { DeliveryReceiptError, runtimeForDrop, sendAndConfirmSignedTransaction } from '../src/deliveryReceiptOnchain.ts';
import {
  commerceKeyFromPath,
  D1CommerceRepository,
  type CommerceDocumentData,
} from '../src/commerceRepository.ts';
import {
  STRIPE_RECEIPT_CLAIM_PATH,
  buildWithOptionalLookupTable,
  claimFlowFor,
  claimStripeReceipt,
  handleStripeReceiptClaim,
  readRequestBody,
  responseForClaim,
} from '../src/stripeReceiptClaim.ts';
import { StripeReceiptClaimError } from '../src/stripeReceiptClaimErrors.ts';
import {
  clearProcessing,
  finalizeClaim,
  normalizeSubmissions,
  rememberSubmittedTransaction,
  startClaim,
} from '../src/stripeReceiptClaimStore.ts';

const stripeReceiptClaimTestHooks = {
  buildWithOptionalLookupTable,
  claimFlowFor,
  claimStripeReceipt,
  clearProcessing,
  finalizeClaim,
  normalizeSubmissions,
  readRequestBody,
  rememberSubmittedTransaction,
  responseForClaim,
  startClaim,
};

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
    verifyIdentity: async () => ({ kind: 'anonymous' as const, authSubject: 'auth-uid' }),
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

function conflictDatabase(db: D1Database, conflicts: number): D1Database {
  return {
    ...db,
    batch: async (statements) => {
      if (statements.length >= 4 && conflicts > 0) {
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
  options: {
    commitConflicts?: number;
    harness?: Parameters<typeof createCommerceD1Harness>[0];
  } = {},
) {
  const harness = createCommerceD1Harness(options.harness);
  for (const [path, fields] of Object.entries(documents)) {
    const key = commerceKeyFromPath(path);
    if (!key) throw new Error(`Invalid commerce fixture path: ${path}`);
    seedCommerceDocument(harness, {
      key,
      data: fields as CommerceDocumentData,
      updateTime: '2026-08-22T00:00:00.000Z',
    });
  }
  return {
    repository: new D1CommerceRepository(options.commitConflicts
      ? conflictDatabase(harness.db, options.commitConflicts)
      : harness.db),
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
    failOnDeferredWork,
    dependencies({
      verifyIdentity: async () => {
        observedUid = 'auth-uid';
        return { uid: observedUid };
      },
      claim: async (body: unknown) => {
        observedBody = body;
        return dependencies().claim();
      },
    }),
  );
  assert.equal(observedUid, 'auth-uid');
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
    failOnDeferredWork,
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
    failOnDeferredWork,
    dependencies({
      timeoutMs: Number.NaN,
      nowMs: () => assert.fail('Rejected methods must not read the clock'),
      verifyIdentity: async () => assert.fail('Rejected methods must not authenticate'),
    }),
  );
  assert.equal(method.response.status, 405);
  assert.equal(method.response.headers.get('allow'), 'POST, OPTIONS');
  assert.deepEqual(method.metrics, { upstreamCalls: 0, providerDurationMs: 0 });

  const extra = await handleStripeReceiptClaim(
    request({ code: CODE, recipient: RECIPIENT, extra: true }),
    env(),
    failOnDeferredWork,
    dependencies(),
  );
  assert.equal(extra.response.status, 400);

  const missingSecret = await handleStripeReceiptClaim(
    request(),
    env({ COSIGNER_SECRET: '' }),
    failOnDeferredWork,
    dependencies(),
  );
  assert.equal(missingSecret.response.status, 502);
  assert.equal(missingSecret.outcome, 'unavailable');
});

test('Stripe receipt claims reject malformed JSON before authenticating', async () => {
  let authenticationCalls = 0;
  const result = await handleStripeReceiptClaim(
    request(undefined, { body: '{' }),
    env(),
    failOnDeferredWork,
    dependencies({
      nowMs: () => assert.fail('Malformed input must not read the authentication clock'),
      verifyIdentity: async () => {
        authenticationCalls += 1;
        throw new RequestIdentityError('invalid-token');
      },
    }),
  );
  assert.equal(authenticationCalls, 0);
  assert.equal(result.response.status, 400);
  assert.equal(result.authOutcome, 'provider-failure');
  assert.equal(result.outcome, 'invalid-argument');
  assert.equal(result.response.headers.get('Timing-Allow-Origin'), '*');
  assert.deepEqual(await result.response.json(), {
    ok: false,
    error: { code: 'invalid-argument', message: 'Invalid receipt claim request.' },
  });
});

test('Stripe receipt claims preserve authentication provider timeout responses', async () => {
  const result = await handleStripeReceiptClaim(
    request(),
    env(),
    failOnDeferredWork,
    dependencies({ verifyIdentity: async () => { throw new RequestIdentityError('provider-timeout'); } }),
  );
  assert.equal(result.response.status, 504);
  assert.equal(result.authOutcome, 'provider-failure');
  assert.equal(result.outcome, 'deadline-exceeded');
  assert.equal(result.response.headers.get('Timing-Allow-Origin'), '*');
  assert.deepEqual(await result.response.json(), {
    ok: false,
    error: { code: 'deadline-exceeded', message: 'Authentication is temporarily unavailable.' },
  });
});

test('Stripe receipt claim handler returns its deadline and tracks unfinished cleanup', async () => {
  const deferred = createDeferredWorkCollector();
  let aborted = false;
  const result = await handleStripeReceiptClaim(
    request(),
    env(),
    deferred.defer,
    dependencies({
      timeoutMs: 1,
      claim: async (
        _body: unknown,
        _env: unknown,
        commerce: { signal: AbortSignal },
        _provider: unknown,
        onContext: (context: { dropId: string; deliveryId: number }) => void,
      ) => {
        onContext({ dropId: DROP_ID, deliveryId: DELIVERY_ID });
        await new Promise<void>((resolve) => {
          const onAbort = () => { aborted = true; resolve(); };
          commerce.signal.addEventListener('abort', onAbort, { once: true });
          if (commerce.signal.aborted) onAbort();
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
  assert.equal(deferred.promises.length, 1);
  await deferred.drain();
});

test('Stripe receipt claim rethrows wrapped client cancellation after cleanup without internal logging', async (context) => {
  const controller = new AbortController();
  const reason = new Error('client disconnected during receipt claim');
  const logged: unknown[] = [];
  context.mock.method(console, 'error', (entry: unknown) => { logged.push(entry); });
  let markStarted!: () => void;
  let finishCleanup!: () => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const pending = handleStripeReceiptClaim(
    request(undefined, { signal: controller.signal }),
    env(),
    failOnDeferredWork,
    dependencies({
      claim: () => new Promise((_resolve, reject) => {
        finishCleanup = () => reject(new StripeReceiptClaimError(
          'internal',
          'wrapped cancellation',
          undefined,
          reason,
        ));
        markStarted();
      }),
    }),
  );

  await started;
  controller.abort(reason);
  finishCleanup();

  await assert.rejects(pending, (error: unknown) => error === reason);
  assert.equal(logged.some((entry) => (
    typeof entry === 'object' && entry !== null &&
    (entry as Record<string, unknown>).event === 'stripe_receipt_claim_unhandled_error'
  )), false);
});

test('Stripe receipt claim propagates deferred-work registration failures', async () => {
  const cause = new Error('waitUntil registration failed');
  await assert.rejects(
    handleStripeReceiptClaim(
      request(),
      env(),
      () => { throw cause; },
      dependencies({
        timeoutMs: 1,
        claim: async () => new Promise(() => undefined),
      }),
    ),
    (error) => isDeferredWorkRegistrationError(error, cause),
  );
});

test('abort after Solana submission preserves the deterministic signature and recipient lock', async () => {
  const payer = Keypair.generate();
  const transaction = new VersionedTransaction(new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: Keypair.generate().publicKey.toBase58(),
    instructions: [],
  }).compileToV0Message());
  transaction.sign([payer]);
  const signature = bs58.encode(transaction.signatures[0]);
  const controller = new AbortController();
  const reason = new Error('client disconnected after send');
  let sendStarted = false;

  await assert.rejects(
    sendAndConfirmSignedTransaction({
      sendTransaction: async () => {
        sendStarted = true;
        controller.abort(reason);
        return signature;
      },
    } as unknown as Parameters<typeof sendAndConfirmSignedTransaction>[0], transaction, controller.signal, 'claimStripeReceipt:directFigure'),
    (error: unknown) => {
      assert.ok(error instanceof DeliveryReceiptError);
      assert.equal(error.code, 'aborted');
      assert.equal(error.cause, reason);
      const details = error.details as Record<string, unknown>;
      assert.equal(details.signature, signature);
      assert.equal(details.maybeSubmitted, true);
      return true;
    },
  );
  assert.equal(sendStarted, true);

  const documents = directDocuments();
  documents[`claimCodes/${CODE}`] = {
    ...documents[`claimCodes/${CODE}`],
    status: 'processing',
    processingAttemptId: 'attempt',
    processingLeaseExpiresAt: 0,
    receiptTxs: [],
    receiptTxSubmissions: [],
  };
  const context = commerceContext(documents);
  await stripeReceiptClaimTestHooks.rememberSubmittedTransaction(
    context,
    CODE,
    'attempt',
    signature,
    { lastValidBlockHeight: 200, submittedAtMs: 1_700_000_000_000, status: 'submitted' },
  );
  await assert.rejects(() => stripeReceiptClaimTestHooks.startClaim(
    context,
    CODE,
    OTHER_RECIPIENT,
    'next-attempt',
    Date.now() + 10 * 60_000,
  ), /locked to the receiver/);
  const stored = await readCommerceRecord(context, requireCommerceKey(`claimCodes/${CODE}`));
  assert.equal((stored?.data.receiptTxSubmissions as Array<{ status: string }>)[0].status, 'submitted');
});

test('Stripe receipt recovery distinguishes rejected transfers from unresolved evidence', async (testContext) => {
  const signer = Keypair.generate();
  const runtime = runtimeForDrop(DROP_ID);
  const integer = (value: number, bytes: 4 | 8) => {
    const buffer = Buffer.alloc(bytes);
    if (bytes === 4) buffer.writeUInt32LE(value);
    else buffer.writeBigUInt64LE(BigInt(value));
    return buffer;
  };
  const string = (value: string) => Buffer.concat([integer(Buffer.byteLength(value), 4), Buffer.from(value)]);
  const payload = Buffer.concat([
    Buffer.from(BOX_MINTER_CONFIG_DISCRIMINATOR),
    signer.publicKey.toBuffer(),
    new PublicKey(runtime.config.treasury).toBuffer(),
    runtime.collectionMint.toBuffer(),
    integer(1, 8),
    integer(1, 8),
    Buffer.alloc(32),
    integer(runtime.maxSupply, 4),
    Buffer.from([runtime.config.maxPerTx, runtime.itemsPerBox]),
    integer(0, 4),
    string(runtime.config.namePrefix),
    string(runtime.config.symbol),
    string(runtime.config.metadataBase),
    Buffer.from([1, 1, runtime.config.discountMintsPerWallet]),
    string(runtime.config.figureNamePrefix),
    Buffer.alloc(37),
  ]);
  const configData = Buffer.concat([payload, Buffer.alloc(BOX_MINTER_CONFIG_ACCOUNT_SIZE_DROP_SEED - payload.length)]);
  const collectionData = Buffer.alloc(49);
  collectionData[0] = 5;
  const noop = new PublicKey(MPL_NOOP_PROGRAM_ADDRESS);
  const invalidTransaction = new VersionedTransaction(new TransactionMessage({
    payerKey: signer.publicKey,
    recentBlockhash: Keypair.generate().publicKey.toBase58(),
    instructions: [new TransactionInstruction({ programId: noop, keys: [], data: Buffer.alloc(0) })],
  }).compileToV0Message());
  const invalidProof: NonNullable<Awaited<ReturnType<Connection['getTransaction']>>> = {
    slot: 1,
    blockTime: null,
    transaction: { message: invalidTransaction.message, signatures: [SIGNATURE] },
    meta: {
      err: null,
      fee: 0,
      preBalances: [],
      postBalances: [],
      loadedAddresses: { writable: [], readonly: [] },
      innerInstructions: [{
        index: 0,
        instructions: [{
          programIdIndex: invalidTransaction.message.staticAccountKeys.findIndex((key) => key.equals(noop)),
          accounts: [],
          data: '0',
        }],
      }],
    },
  };

  for (const outcome of ['instruction-mismatch', 'missing', 'rpc-error'] as const) {
    await testContext.test(outcome, async (context) => {
      context.mock.method(console, 'warn', () => undefined);
      context.mock.method(Connection.prototype, 'getMultipleAccountsInfo', async () => [
        { data: collectionData, owner: new PublicKey(MPL_CORE_PROGRAM_ADDRESS), executable: false, lamports: 1, rentEpoch: 0 },
        { data: configData, owner: runtime.boxMinterProgramId, executable: false, lamports: 1, rentEpoch: 0 },
      ]);
      context.mock.method(Connection.prototype, 'getTransaction', async (signature: string, options: unknown) => {
        assert.equal(signature, SIGNATURE);
        assert.deepEqual(options, { maxSupportedTransactionVersion: 0 });
        if (outcome === 'rpc-error') throw new Error('RPC temporarily unavailable');
        return outcome === 'missing' ? null : invalidProof;
      });
      let signatureChecks = 0;
      context.mock.method(Connection.prototype, 'getSignatureStatuses', async () => {
        signatureChecks += 1;
        return { context: { slot: 1 }, value: [null] };
      });
      const commerce = commerceContext(directDocuments());
      let assetChecks = 0;
      await assert.rejects(() => claimStripeReceipt(
        { code: CODE, recipient: RECIPIENT },
        env({ COSIGNER_SECRET: bs58.encode(signer.secretKey) }),
        commerce,
        {
          apiKey: 'helius',
          signal: commerce.signal,
          providerFetch: async (_input, init) => {
            const request = JSON.parse(String(init?.body)) as { id: string; method: string };
            if (request.method === 'getBlockHeight') {
              return Response.json({ jsonrpc: '2.0', id: request.id, result: 100 });
            }
            assert.equal(request.method, 'getAsset');
            assetChecks += 1;
            return Response.json({ jsonrpc: '2.0', id: request.id, result: { id: RECEIPT_ASSET_ID, burnt: true } });
          },
        },
      ), {
        code: 'unavailable',
        message: 'Card receipt ownership is still resolving for the original receiver; retry shortly.',
        details: { keepReceiptClaimProcessing: true },
      });
      const stored = await readCommerceRecord(commerce, requireCommerceKey(`claimCodes/${CODE}`));
      assert.equal(stored?.data.status, 'processing');
      assert.equal(stored?.data.recipient, RECIPIENT);
      const submissions = stored?.data.receiptTxSubmissions as Array<{ signature: string; status: string }>;
      assert.equal(submissions[0].signature, SIGNATURE);
      assert.equal(submissions[0].status, outcome === 'instruction-mismatch' ? 'not_landed' : 'submitted');
      assert.equal(signatureChecks, outcome === 'instruction-mismatch' ? 0 : 1);
      assert.equal(assetChecks, outcome === 'instruction-mismatch' ? 2 : 1);
    });
  }
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
  const claim = await readCommerceRecord(context, requireCommerceKey(`claimCodes/${CODE}`));
  const order = await readCommerceRecord(context, requireCommerceKey(`drops/${DROP_ID}/deliveryOrders/${DELIVERY_ID}`));
  assert.equal(claim?.data.status, 'processing');
  assert.equal(claim?.data.processingAttemptId, 'stripe_receipt:attempt');
  assert.equal(claim?.data.processingLeaseExpiresAt, 1_700_000_090_000);
  assert.equal(order?.data.dropId, DROP_ID);
});

test('Stripe receipt claim start reconciles a processing lease whose acknowledgement is lost', async () => {
  let loseAcknowledgement = true;
  const context = commerceContext(unclaimedDocuments(), [], {
    harness: {
      observeBatchAfterCommit: ({ statements }) => {
        if (
          loseAcknowledgement &&
          statements.some(({ sql }) => sql.includes('INSERT INTO commerce_commit_guards'))
        ) {
          loseAcknowledgement = false;
          throw new TypeError('claim processing lease acknowledgement lost');
        }
      },
    },
  });

  const result = await stripeReceiptClaimTestHooks.startClaim(
    context,
    CODE,
    RECIPIENT,
    'stripe_receipt:lost-ack',
    1_700_000_000_000,
  );

  assert.equal(result.status, 'started');
  assert.equal(result.attemptId, 'stripe_receipt:lost-ack');
  assert.equal(result.resumingPreviousProcessingClaim, false);
  assert.equal(loseAcknowledgement, false);
  const claim = await readCommerceRecord(context, requireCommerceKey(`claimCodes/${CODE}`));
  const order = await readCommerceRecord(
    context,
    requireCommerceKey(`drops/${DROP_ID}/deliveryOrders/${DELIVERY_ID}`),
  );
  assert.equal(claim?.data.processingAttemptId, 'stripe_receipt:lost-ack');
  assert.equal((order?.data.stripeReceiptClaim as Record<string, unknown>)?.status, 'processing');
});

test('Stripe receipt claim cancellation reconciles a lost start acknowledgement and clears the exact lease', async () => {
  const controller = new AbortController();
  const reason = new Error('client cancelled after claim lease commit');
  let loseAcknowledgement = true;
  let sendCalls = 0;
  const context = commerceContext(unclaimedDocuments(), [], {
    harness: {
      observeBatchAfterCommit: ({ statements }) => {
        if (
          loseAcknowledgement &&
          statements.some(({ sql }) => sql.includes('INSERT INTO commerce_commit_guards'))
        ) {
          loseAcknowledgement = false;
          controller.abort(reason);
          throw new Error('claim lease acknowledgement lost during cancellation', { cause: reason });
        }
      },
    },
  });
  context.signal = controller.signal;

  await assert.rejects(
    stripeReceiptClaimTestHooks.claimStripeReceipt(
      { code: CODE, recipient: RECIPIENT },
      env(),
      context,
      {
        apiKey: 'helius',
        signal: controller.signal,
        providerFetch: async (_input, init) => {
          const body = typeof init?.body === 'string' ? JSON.parse(init.body) as { method?: string } : {};
          if (body.method === 'sendTransaction') sendCalls += 1;
          throw reason;
        },
      },
    ),
    (error) => error === reason,
  );

  assert.equal(loseAcknowledgement, false);
  assert.equal(sendCalls, 0);
  const safeContext = { ...context, signal: new AbortController().signal };
  const claim = await readCommerceRecord(safeContext, requireCommerceKey(`claimCodes/${CODE}`));
  const order = await readCommerceRecord(
    safeContext,
    requireCommerceKey(`drops/${DROP_ID}/deliveryOrders/${DELIVERY_ID}`),
  );
  assert.equal(claim?.data.status, 'unclaimed');
  assert.equal(claim?.data.processingAttemptId, undefined);
  assert.equal(claim?.data.processingLeaseExpiresAt, undefined);
  assert.equal((order?.data.stripeReceiptClaim as Record<string, unknown>)?.status, 'unclaimed');
  assert.equal((order?.data.stripeReceiptClaim as Record<string, unknown>)?.recipient, undefined);
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
  const order = await readCommerceRecord(context, requireCommerceKey(orderPath));
  assert.equal(
    ((order?.data.stripeReceiptClaimsByBoxId as Record<string, any>)?.box_16 as Record<string, unknown>)?.status,
    'processing',
  );
  assert.equal((order?.data.stripeReceiptClaim as Record<string, unknown>)?.status, 'processing');
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
  assert.equal((await readCommerceRecord(staleContext, requireCommerceKey(`claimCodes/${CODE}`)))?.data.status, 'processing');

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
  const cleaned = await readCommerceRecord(ownerContext, requireCommerceKey(`claimCodes/${CODE}`));
  assert.equal(cleaned?.data.status, 'unclaimed');
  assert.equal(cleaned?.data.processingAttemptId, undefined);

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
  const candidate = await readCommerceRecord(candidateContext, requireCommerceKey(`claimCodes/${CODE}`));
  assert.equal(Array.isArray(candidate?.data.receiptTxSubmissions), true);
  assert.equal(Number.isSafeInteger(candidate?.data.processingLeaseExpiresAt), true);
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
  const finalized = await readCommerceRecord(context, requireCommerceKey(`claimCodes/${CODE}`));
  assert.equal(finalized?.data.status, 'claimed');
  assert.equal(finalized?.data.processingAttemptId, undefined);

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

test('Stripe receipt finalization keeps claim and order timestamps aligned and rejects missing orders atomically', async () => {
  const documents = unclaimedDocuments();
  const claimKey = requireCommerceKey(`claimCodes/${CODE}`);
  const orderKey = requireCommerceKey(`drops/${DROP_ID}/deliveryOrders/${DELIVERY_ID}`);
  documents[claimKey.path] = {
    ...documents[claimKey.path],
    status: 'processing',
    recipient: RECIPIENT,
    processingAttemptId: 'attempt',
  };
  const context = commerceContext(documents);
  await context.repository.run(1_900_000_000_000, async (transaction) => {
    await transaction.update(orderKey, { updatedAt: 1_900_000_000_000 });
  });
  const previousOrder = await context.repository.get(orderKey);

  await finalizeClaim(context, startedClaim(), CODE, RECIPIENT, SIGNATURE, 'box', 1);

  const claim = await context.repository.get(claimKey);
  const order = await context.repository.get(orderKey);
  assert.ok(claim && order && previousOrder);
  assert.equal(claim.updateTime, order.updateTime);
  assert.ok(order.updateTime > previousOrder.updateTime);
  assert.equal(claim.data.claimedAt, (order.data.stripeReceiptClaim as Record<string, unknown>).claimedAt);

  delete documents[orderKey.path];
  const missingOrderContext = commerceContext(documents);
  await assert.rejects(
    finalizeClaim(missingOrderContext, startedClaim(), CODE, RECIPIENT, SIGNATURE, 'box', 1),
    { name: 'CommerceWriteConflict', code: 'failed-precondition' },
  );
  const unchanged = await missingOrderContext.repository.get(claimKey);
  assert.equal(unchanged?.data.status, 'processing');
  assert.equal(unchanged?.data.processingAttemptId, 'attempt');
  assert.equal(unchanged?.data.receiptTxs, undefined);
});

test('Stripe receipt claim selects legacy, openable, and direct flows', () => {
  assert.equal(stripeReceiptClaimTestHooks.claimFlowFor(undefined, 0), 'legacy_pack');
  assert.equal(stripeReceiptClaimTestHooks.claimFlowFor(undefined, 1), 'openable_pack');
  assert.equal(stripeReceiptClaimTestHooks.claimFlowFor({ receiptAssetId: RECEIPT_ASSET_ID, figureId: BOX_ID }, 0), 'direct_figure');
});

test('Stripe receipt claim response and order validation reject inconsistent data', async () => {
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
  const documents = unclaimedDocuments();
  const orderPath = `drops/${DROP_ID}/deliveryOrders/${DELIVERY_ID}`;
  documents[orderPath] = {
    ...documents[orderPath],
    stripeReceiptClaimsByBoxId: {
      box_16: { code: 'ZZZZZZ-1234567890', boxId: BOX_ID },
    },
  };
  await assert.rejects(() => startClaim(
    commerceContext(documents),
    CODE,
    RECIPIENT,
    'attempt',
    1_700_000_000_000,
  ), /mismatch/);
});
