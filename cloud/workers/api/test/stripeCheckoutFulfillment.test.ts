import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import bs58 from 'bs58';
import { Keypair, PublicKey, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import type { DecodedBoxMinterConfigData } from '../../../../shared/boxMinterConfigCodec.ts';
import { MPL_CORE_PROGRAM_ADDRESS } from '../../../../shared/solanaProgramAddresses.ts';
import { StripeCheckoutFulfillmentError } from '../src/stripeCheckout/errors.ts';
import { isRetryableStripeCheckoutFulfillmentError } from '../src/stripeCheckout/service.ts';
import type { ProfileProviderFetch } from '../src/boundedResponse.ts';
import { D1CommerceRepository, commerceKeys } from '../src/commerceRepository.ts';
import { isCommerceServerTimestamp } from '../src/commerceRepositoryTypes.ts';
import { createCommerceD1Harness, seedCommerceDocument } from './commerceD1Harness.ts';
import {
  flowDependencies,
  fulfillmentRuntime,
  isMplCoreCollectionAccount,
  lazyAddressEncryptor,
  packStatusEventQuantity,
  validateOnchainConfig,
  workerFulfillmentCompletionFields,
} from '../src/stripeCheckoutFulfillment.ts';

const stripeCheckoutFulfillmentTestHooks = {
  flowDependencies,
  fulfillmentRuntime,
  isMplCoreCollectionAccount,
  lazyAddressEncryptor,
  packStatusEventQuantity,
  validateOnchainConfig,
  workerFulfillmentCompletionFields,
};

function commerceFixture(context: TestContext) {
  const harness = createCommerceD1Harness();
  context.after(() => harness.database.close());
  return {
    harness,
    commerce: { repository: new D1CommerceRepository(harness.db), nowMs: Date.now },
  };
}

function matchingConfig(): {
  decoded: DecodedBoxMinterConfigData;
  runtime: ReturnType<typeof stripeCheckoutFulfillmentTestHooks.fulfillmentRuntime>;
} {
  const runtime = stripeCheckoutFulfillmentTestHooks.fulfillmentRuntime('card_nft_binder_devnet');
  const treasury = new PublicKey(runtime.config.treasury);
  return {
    runtime,
    decoded: {
      admin: PublicKey.unique().toBytes(),
      treasury: treasury.toBytes(),
      coreCollection: runtime.collectionMint.toBytes(),
      priceLamports: 0n,
      discountPriceLamports: 0n,
      discountMerkleRoot: new Uint8Array(32),
      discountMintsPerWallet: runtime.config.discountMintsPerWallet,
      maxSupply: runtime.config.maxSupply,
      maxPerTx: runtime.config.maxPerTx,
      itemsPerBox: runtime.itemsPerBox,
      started: true,
      minted: 0,
      namePrefix: runtime.config.namePrefix,
      figureNamePrefix: runtime.config.figureNamePrefix,
      symbol: runtime.config.symbol,
      uriBase: runtime.config.metadataBase,
      bump: 1,
      mintVariantKind: 0,
      mintVariantStartIds: [0, 0, 0],
      mintVariantEndIds: [0, 0, 0],
      mintVariantNextIds: [0, 0, 0],
      paymentRouting: {
        schema: 'legacy',
        mintProceeds: [{ address: treasury.toBytes(), percentage: 100 }],
        deliveryPaymentReceiver: treasury.toBytes(),
      },
    },
  };
}

test('Stripe fulfillment validates deployment invariants against on-chain config', () => {
  const { decoded, runtime } = matchingConfig();
  const result = stripeCheckoutFulfillmentTestHooks.validateOnchainConfig(runtime, decoded);
  assert.equal(result.coreCollection.toBase58(), runtime.collectionMint.toBase58());
  assert.throws(
    () => stripeCheckoutFulfillmentTestHooks.validateOnchainConfig(runtime, {
      ...decoded,
      maxSupply: decoded.maxSupply + 1,
    }),
    (error: unknown) => error instanceof StripeCheckoutFulfillmentError && error.code === 'failed-precondition',
  );
});

test('Stripe fulfillment accepts only MPL Core collection accounts', () => {
  const data = new Uint8Array(49);
  data[0] = 5;
  const collection = { data, owner: new PublicKey(MPL_CORE_PROGRAM_ADDRESS) };
  assert.equal(stripeCheckoutFulfillmentTestHooks.isMplCoreCollectionAccount(collection), true);
  assert.equal(stripeCheckoutFulfillmentTestHooks.isMplCoreCollectionAccount({
    ...collection,
    data: new Uint8Array(48),
  }), false);
  assert.equal(stripeCheckoutFulfillmentTestHooks.isMplCoreCollectionAccount({
    ...collection,
    data: new Uint8Array(49),
  }), false);
  assert.equal(stripeCheckoutFulfillmentTestHooks.isMplCoreCollectionAccount({
    ...collection,
    owner: PublicKey.unique(),
  }), false);
});

test('Stripe fulfillment pack-status events use card-equivalent quantity', () => {
  const runtime = stripeCheckoutFulfillmentTestHooks.fulfillmentRuntime('card_nft_2');
  assert.equal(runtime.itemsPerBox, 3);
  assert.equal(stripeCheckoutFulfillmentTestHooks.packStatusEventQuantity(runtime, 2), 6);
});

test('Stripe fulfillment resolves late checkout ownership through Ops D1', async (context) => {
  const wallet = PublicKey.unique().toBase58();
  const opsDb = {
    prepare() {
      return {
        bind() {
          return this;
        },
        async first() {
          return {
            auth_subject: 'anonymous-subject',
            wallet,
            updated_at_ms: 1,
            revision: 1,
            reconcile_lease_id: null,
            reconcile_lease_expires_at_ms: null,
          };
        },
      };
    },
  } as unknown as D1Database;
  const dependencies = stripeCheckoutFulfillmentTestHooks.flowDependencies(
    { ADDRESS_DECRYPTION_SECRET: '', OPS_DB: opsDb } as any,
    commerceFixture(context).commerce,
    new AbortController().signal,
  );
  assert.equal(await dependencies.resolveWalletOwner?.('anonymous-subject'), wallet);
});

test('Stripe fulfillment writes pack-status events to required D1 without reading commerce', async (context) => {
  let query = '';
  let bindings: unknown[] = [];
  let runs = 0;
  const dataDb = {
    prepare(value: string) {
      query = value;
      return {
        bind(...values: unknown[]) {
          bindings = values;
          return this;
        },
        async run() {
          runs += 1;
          return { success: true, results: [], meta: { changes: 1 } };
        },
      };
    },
  } as unknown as D1Database;
  const { commerce } = commerceFixture(context);
  context.mock.method(commerce.repository, 'get', () => assert.fail('pack-status projection must not read commerce'));
  const dependencies = stripeCheckoutFulfillmentTestHooks.flowDependencies(
    { ADDRESS_DECRYPTION_SECRET: '', DATA_DB: dataDb } as any,
    commerce,
    new AbortController().signal,
  );
  assert.ok(dependencies.countPackStatus);
  await dependencies.countPackStatus({
    dropRuntime: stripeCheckoutFulfillmentTestHooks.fulfillmentRuntime('card_nft_2'),
    orderHashHex: '12'.repeat(32),
    quantity: 2,
    deliveryId: 123,
    checkoutSessionId: 'cs_live_d1',
  });
  assert.match(query, /INSERT INTO pack_status_events/);
  assert.equal(runs, 1);
  assert.equal(bindings[0], 'card_nft_2');
  assert.equal(bindings[1], 'redeemedIrlStripe');
  assert.equal(bindings[2], '12'.repeat(32));
  assert.equal(bindings[3], 6);
  assert.equal(bindings[5], 0);
  assert.equal(bindings[6], 2);
  assert.equal(bindings[8], 123);
  assert.equal(bindings[9], 'cs_live_d1');
  assert.equal(bindings[12], 1);

  const missing = stripeCheckoutFulfillmentTestHooks.flowDependencies(
    { ADDRESS_DECRYPTION_SECRET: '' } as any,
    commerce,
    new AbortController().signal,
  );
  const missingCountPackStatus = missing.countPackStatus;
  assert.ok(missingCountPackStatus);
  await assert.rejects(
    missingCountPackStatus({
      dropRuntime: stripeCheckoutFulfillmentTestHooks.fulfillmentRuntime('card_nft_2'),
      orderHashHex: '34'.repeat(32),
      quantity: 1,
      deliveryId: 124,
      checkoutSessionId: 'cs_live_missing_d1',
    }),
    /pack_status_data_db_not_configured/,
  );
});

test('Stripe pack-status repair skips unsupported drops and rejects inconsistent orders', async (context) => {
  const { harness, commerce } = commerceFixture(context);
  const reads = context.mock.method(commerce.repository, 'get', commerce.repository.get.bind(commerce.repository));
  const checkoutKey = commerceKeys.stripeCheckout('card_nft_2', 'cs_test_repair');
  seedCommerceDocument(harness, {
    key: checkoutKey,
    data: {
      dropId: 'card_nft_2',
      sessionId: 'cs_test_repair',
      deliveryId: 123,
      livemode: true,
    },
  });
  seedCommerceDocument(harness, {
    key: commerceKeys.deliveryOrder('card_nft_2', '123'),
    data: {
      dropId: 'card_nft_2',
      deliveryId: 123,
      source: 'stripe_offchain',
      stripeCheckoutSessionId: 'wrong-session',
      offchainOrderHash: '00'.repeat(32),
      metadataIds: [1, 'invalid'],
    },
  });
  const dependencies = stripeCheckoutFulfillmentTestHooks.flowDependencies(
    { ADDRESS_DECRYPTION_SECRET: '' } as any,
    commerce,
    new AbortController().signal,
  );
  const repairPackStatus = dependencies.repairPackStatus;
  assert.ok(repairPackStatus);
  await repairPackStatus({
    dropRuntime: stripeCheckoutFulfillmentTestHooks.fulfillmentRuntime('card_nft_binder_devnet'),
    checkoutKey: commerceKeys.stripeCheckout('card_nft_binder_devnet', 'cs_test_skip'),
    sessionId: 'cs_test_skip',
  });
  assert.equal(reads.mock.callCount(), 0);
  await assert.rejects(
    repairPackStatus({
      dropRuntime: stripeCheckoutFulfillmentTestHooks.fulfillmentRuntime('card_nft_2'),
      checkoutKey,
      sessionId: 'cs_test_repair',
    }),
    /stripe_pack_status_repair_order_invalid/,
  );
});

test('Stripe fulfillment defers address encryption setup until the address is persisted', () => {
  const encryptAddress = stripeCheckoutFulfillmentTestHooks.lazyAddressEncryptor('');
  assert.throws(
    () => encryptAddress('Buyer Name\n1 Main St\nNew York, NY 10001\nUS'),
    (error: unknown) => error instanceof StripeCheckoutFulfillmentError && error.code === 'unavailable',
  );
});

test('Stripe fulfillment provides Worker completion fields for the atomic fulfilled write', () => {
  const fields = stripeCheckoutFulfillmentTestHooks.workerFulfillmentCompletionFields();
  assert.equal(fields.fulfillmentCompletedBy, 'cloudflare_queue_v1');
  assert.ok(isCommerceServerTimestamp(fields.fulfillmentCompletedAt));
});

type RpcRequest = { id: string; method: string; params: unknown[] };

function rpcResult(request: RpcRequest, result: unknown): Response {
  return Response.json({ jsonrpc: '2.0', id: request.id, result });
}

function rpcFixture(
  context: TestContext,
  providerFetch: ProfileProviderFetch,
  signal = new AbortController().signal,
) {
  const dependencies = flowDependencies(
    { HELIUS_API_KEY: 'test-api-key', ADDRESS_DECRYPTION_SECRET: '' } as Env,
    commerceFixture(context).commerce,
    signal,
    providerFetch,
  );
  const runtime = fulfillmentRuntime('card_nft_binder_devnet');
  const signer = Keypair.generate();
  const transaction = new VersionedTransaction(new TransactionMessage({
    payerKey: signer.publicKey,
    recentBlockhash: PublicKey.unique().toBase58(),
    instructions: [],
  }).compileToV0Message());
  transaction.sign([signer]);
  return {
    dependencies,
    runtime,
    transaction,
    signature: bs58.encode(transaction.signatures[0]),
  };
}

function assertSubmittedCancellation(
  error: unknown,
  reason: unknown,
  signature: string,
): boolean {
  assert.ok(error instanceof StripeCheckoutFulfillmentError);
  assert.equal(error.code, reason instanceof Error && reason.name === 'TimeoutError' ? 'deadline-exceeded' : 'aborted');
  assert.equal(error.cause, reason);
  assert.deepEqual(error.details, {
    signature,
    lastError: reason instanceof Error ? reason.message : String(reason),
    maybeSubmitted: true,
  });
  assert.equal(isRetryableStripeCheckoutFulfillmentError(error), true);
  return true;
}

test('Stripe RPC and transaction submission preserve cancellation before starting provider work', async (context) => {
  for (const reason of [new Error('already cancelled'), { kind: 'already-cancelled' }]) {
    const controller = new AbortController();
    controller.abort(reason);
    const { dependencies, runtime, transaction } = rpcFixture(context, async () => {
      assert.fail('cancelled requests must not fetch');
    }, controller.signal);
    await assert.rejects(dependencies.runRpc(runtime, async () => {
      assert.fail('cancelled requests must not start an operation');
    }, 20, 'cancelled'), (error) => error === reason);
    await assert.rejects(
      dependencies.sendAndConfirmSignedTx(runtime, transaction, 'deliver'),
      (error) => error === reason,
    );
  }
});

test('Stripe RPC timeout aborts the actual request and remains retryable', async (context) => {
  let requestSignal: AbortSignal | null | undefined;
  let calls = 0;
  const { dependencies, runtime } = rpcFixture(context, async (_input, init) => {
    calls += 1;
    requestSignal = init?.signal;
    return new Promise<Response>(() => undefined);
  });
  await assert.rejects(
    dependencies.runRpc(runtime, (rpc) => rpc.getSlot(), 10, 'getSlot:test'),
    (error) => {
      assert.ok(error instanceof StripeCheckoutFulfillmentError);
      assert.equal(error.code, 'deadline-exceeded');
      assert.equal(error.message, 'getSlot:test timed out after 10ms');
      assert.equal(isRetryableStripeCheckoutFulfillmentError(error), true);
      return true;
    },
  );
  assert.equal(requestSignal?.aborted, true);
  assert.equal(calls, 1);
});

test('Stripe RPC deadline covers streamed responses and work after SDK resolution', async (context) => {
  let cancelled = false;
  const streamed = rpcFixture(context, async () => new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"jsonrpc":"2.0"'));
    },
    cancel() { cancelled = true; },
  })));
  await assert.rejects(
    streamed.dependencies.runRpc(streamed.runtime, (rpc) => rpc.getSlot(), 10, 'streamed'),
    (error) => error instanceof StripeCheckoutFulfillmentError && error.code === 'deadline-exceeded',
  );
  assert.equal(cancelled, true);
  let readCompleted = false;
  const resolved = rpcFixture(context, async (_input, init) => rpcResult(JSON.parse(String(init?.body)), 5));
  await assert.rejects(
    resolved.dependencies.runRpc(resolved.runtime, async (rpc) => {
      assert.equal(await rpc.getSlot(), 5);
      readCompleted = true;
      return new Promise<never>(() => undefined);
    }, 10, 'operation'),
    (error) => error instanceof StripeCheckoutFulfillmentError && error.code === 'deadline-exceeded',
  );
  assert.equal(readCompleted, true);
});

test('Stripe RPC provider failures keep their retryable domain classification', async (context) => {
  const { dependencies, runtime } = rpcFixture(context, async () => new Response('unavailable', { status: 503 }));
  await assert.rejects(dependencies.runRpc(runtime, (rpc) => rpc.getSlot(), 100, 'getSlot:test'), (error) => {
    assert.ok(error instanceof StripeCheckoutFulfillmentError);
    assert.equal(error.code, 'unavailable');
    assert.equal(isRetryableStripeCheckoutFulfillmentError(error), true);
    return true;
  });
});

test('Stripe send cancellation retains the signature and stops before confirmation', async (context) => {
  for (const reason of [new Error('stop sending'), { kind: 'stop-sending' }]) {
    const controller = new AbortController();
    const started = Promise.withResolvers<void>();
    const methods: string[] = [];
    let requestSignal: AbortSignal | null | undefined;
    const { dependencies, runtime, transaction, signature } = rpcFixture(context, async (_input, init) => {
      const request: RpcRequest = JSON.parse(String(init?.body));
      methods.push(request.method);
      assert.equal(request.method, 'sendTransaction');
      assert.equal((request.params[1] as { maxRetries: number }).maxRetries, 2);
      requestSignal = init?.signal;
      started.resolve();
      return new Promise<Response>(() => undefined);
    }, controller.signal);
    const sending = dependencies.sendAndConfirmSignedTx(runtime, transaction, 'deliver');
    await started.promise;
    controller.abort(reason);
    await assert.rejects(sending, (error) => assertSubmittedCancellation(error, reason, signature));
    assert.equal(requestSignal?.aborted, true);
    assert.deepEqual(methods, ['sendTransaction']);
  }
});

test('Stripe confirmation cancellation stops in-flight work and preserves known transaction failures', async (context) => {
  for (const phase of ['poll', 'failed-lookup', 'final-lookup'] as const) {
    const controller = new AbortController();
    const reason = new DOMException('queue deadline reached', 'TimeoutError');
    const started = Promise.withResolvers<void>();
    const methods: string[] = [];
    let requestSignal: AbortSignal | null | undefined;
    const fixture = rpcFixture(context, async (_input, init) => {
      const request: RpcRequest = JSON.parse(String(init?.body));
      methods.push(request.method);
      if (request.method === 'sendTransaction') return rpcResult(request, fixture.signature);
      if (phase === 'failed-lookup' && request.method === 'getSignatureStatuses') {
        return rpcResult(request, {
          context: { slot: 1 },
          value: [{ slot: 1, confirmations: 1, confirmationStatus: 'confirmed', err: { InstructionError: [0, { Custom: 1 }] } }],
        });
      }
      assert.equal(request.method, phase === 'poll' ? 'getSignatureStatuses' : 'getTransaction');
      requestSignal = init?.signal;
      started.resolve();
      return new Promise<Response>(() => undefined);
    }, controller.signal);
    const sending = fixture.dependencies.sendAndConfirmSignedTx(fixture.runtime, fixture.transaction, 'deliver', {
      confirmTimeoutMs: phase === 'final-lookup' ? 0 : 25_000,
    });
    await started.promise;
    controller.abort(reason);
    await assert.rejects(sending, (error) => {
      if (phase !== 'failed-lookup') return assertSubmittedCancellation(error, reason, fixture.signature);
      assert.ok(error instanceof StripeCheckoutFulfillmentError);
      assert.equal(error.code, 'failed-precondition');
      assert.equal(error.cause, undefined);
      assert.deepEqual(error.details, {
        signature: fixture.signature,
        lastError: '[object Object]',
        lastLogs: [],
      });
      assert.equal(isRetryableStripeCheckoutFulfillmentError(error), false);
      return true;
    });
    assert.equal(requestSignal?.aborted, true);
    assert.deepEqual(methods, phase === 'failed-lookup'
      ? ['sendTransaction', 'getSignatureStatuses', 'getTransaction']
      : ['sendTransaction', phase === 'poll' ? 'getSignatureStatuses' : 'getTransaction']);
  }
});

test('Stripe confirmation cancellation interrupts the poll delay without another RPC', async (context) => {
  const controller = new AbortController();
  const reason = new Error('stop polling');
  const polled = Promise.withResolvers<void>();
  const methods: string[] = [];
  const fixture = rpcFixture(context, async (_input, init) => {
    const request: RpcRequest = JSON.parse(String(init?.body));
    methods.push(request.method);
    if (request.method === 'sendTransaction') return rpcResult(request, fixture.signature);
    assert.equal(request.method, 'getSignatureStatuses');
    polled.resolve();
    return rpcResult(request, { context: { slot: 1 }, value: [null] });
  }, controller.signal);
  const sending = fixture.dependencies.sendAndConfirmSignedTx(fixture.runtime, fixture.transaction, 'deliver');
  await polled.promise;
  await new Promise<void>((resolve) => setImmediate(resolve));
  controller.abort(reason);
  await assert.rejects(sending, (error) => assertSubmittedCancellation(error, reason, fixture.signature));
  assert.deepEqual(methods, ['sendTransaction', 'getSignatureStatuses']);
});

test('Stripe timed-out submission still reconciles its derived signature successfully', async (context) => {
  const methods: string[] = [];
  let sendSignal: AbortSignal | null | undefined;
  const fixture = rpcFixture(context, async (_input, init) => {
    const request: RpcRequest = JSON.parse(String(init?.body));
    methods.push(request.method);
    if (request.method === 'sendTransaction') {
      sendSignal = init?.signal;
      return new Promise<Response>(() => undefined);
    }
    assert.equal(request.method, 'getSignatureStatuses');
    assert.deepEqual(request.params[0], [fixture.signature]);
    return rpcResult(request, {
      context: { slot: 1 },
      value: [{ slot: 1, confirmations: 1, confirmationStatus: 'confirmed', err: null }],
    });
  });
  assert.equal(await fixture.dependencies.sendAndConfirmSignedTx(fixture.runtime, fixture.transaction, 'deliver', {
    sendTimeoutMs: 10,
  }), fixture.signature);
  assert.equal(sendSignal?.aborted, true);
  assert.deepEqual(methods, ['sendTransaction', 'getSignatureStatuses']);
});

test('Stripe transaction preflight errors retain their logs and terminal classification', async (context) => {
  const methods: string[] = [];
  const fixture = rpcFixture(context, async (_input, init) => {
    const request: RpcRequest = JSON.parse(String(init?.body));
    methods.push(request.method);
    return Response.json({
      jsonrpc: '2.0',
      id: request.id,
      error: {
        code: -32002,
        message: 'Transaction simulation failed',
        data: { err: { InstructionError: [0, { Custom: 1 }] }, logs: ['Program failed with custom error 1'] },
      },
    });
  });
  await assert.rejects(
    fixture.dependencies.sendAndConfirmSignedTx(fixture.runtime, fixture.transaction, 'deliver'),
    (error) => {
      assert.ok(error instanceof StripeCheckoutFulfillmentError);
      assert.equal(error.code, 'failed-precondition');
      assert.equal(isRetryableStripeCheckoutFulfillmentError(error), false);
      const details = error.details as { signature: string; lastLogs: string[]; maybeSubmitted?: boolean };
      assert.equal(details.signature, fixture.signature);
      assert.deepEqual(details.lastLogs, ['Program failed with custom error 1']);
      assert.equal(details.maybeSubmitted, undefined);
      return true;
    },
  );
  assert.deepEqual(methods, ['sendTransaction']);
});
