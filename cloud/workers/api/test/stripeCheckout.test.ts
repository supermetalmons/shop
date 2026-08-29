import assert from 'node:assert/strict';
import test from 'node:test';
import { createCommerceD1 } from './commerceD1Harness.ts';
import bs58 from 'bs58';
import { Keypair } from '@solana/web3.js';
import {
  STRIPE_CHECKOUT_BINDER_SHIPPING_COUNTRIES,
  StripeCheckoutSessionError,
  type StripeCheckoutOnchainConfig,
  type StripeCheckoutSessionDrop,
} from '../../../../shared/stripeCheckoutSession.ts';
import {
  STRIPE_CHECKOUT_OPERATION_HEADER,
  STRIPE_CHECKOUT_RETRY_HEADER,
  STRIPE_CHECKOUT_RETRY_SAME_OPERATION,
} from '../../../../shared/contracts.ts';
import {
  handleStripeCheckoutSession,
  requireFulfillmentPrerequisites,
  stripeKeys,
} from '../src/stripeCheckout.ts';
import { createStripeCheckoutStore } from '../src/stripeCheckout/store.ts';

const DROP: StripeCheckoutSessionDrop = {
  dropId: 'card_nft_binder_devnet',
  solanaCluster: 'devnet',
  dropFamily: 'card_nft_binder',
  collectionName: 'Card NFT Binder',
  salesMode: 'stripe_receipt_only',
  stripeCheckoutEnabled: true,
  stripeProductTaxCode: 'txcd_99999999',
  itemsPerBox: 0,
  namePrefix: 'binder',
  boxMinterProgramId: Keypair.generate().publicKey.toBase58(),
  boxMinterConfigPda: Keypair.generate().publicKey.toBase58(),
  collectionMint: Keypair.generate().publicKey.toBase58(),
  receiptsMerkleTree: Keypair.generate().publicKey.toBase58(),
};

const ONCHAIN_CONFIG: StripeCheckoutOnchainConfig = {
  admin: Keypair.generate().publicKey.toBase58(),
  coreCollection: DROP.collectionMint,
  maxSupply: 100,
  maxPerTx: 5,
  itemsPerBox: 0,
  minted: 1,
  started: true,
  mintVariantKind: 0,
  mintVariantStartIds: [0, 0, 0],
  mintVariantEndIds: [0, 0, 0],
  mintVariantNextIds: [0, 0, 0],
};

const STAFF_WALLET = 'A87Upx1f1whNV5P8xQCK2YUTwE3uMYigjoKJAF3jiNpz';
const OPERATION_ID = '11111111-1111-4111-8111-111111111111';

function env(overrides: Partial<Record<
  | 'ADDRESS_DECRYPTION_SECRET'
  | 'COSIGNER_SECRET'
  | 'HELIUS_API_KEY'
  | 'STRIPE_RESTRICTED_KEY'
  | 'STRIPE_RESTRICTED_KEY_LIVE'
  | 'STRIPE_SECRET_KEY'
  | 'STRIPE_SECRET_KEY_LIVE',
  string
>> = {}) {
  return {
    COMMERCE_DB: createCommerceD1(),
    HELIUS_API_KEY: 'helius-test-key',
    COSIGNER_SECRET: '',
    ADDRESS_DECRYPTION_SECRET: '',
    STRIPE_SECRET_KEY: 'sk_test_primary',
    STRIPE_RESTRICTED_KEY: 'rk_test_fallback',
    STRIPE_SECRET_KEY_LIVE: 'sk_live_primary',
    STRIPE_RESTRICTED_KEY_LIVE: 'rk_live_fallback',
    ...overrides,
  };
}

function request(body: unknown, headers: HeadersInit = {}, signal?: AbortSignal): Request {
  return new Request('https://api.mons.shop/checkout/session', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: 'https://mons.shop',
      [STRIPE_CHECKOUT_OPERATION_HEADER]: OPERATION_ID,
      ...headers,
    },
    body: JSON.stringify(body),
    signal,
  });
}

function dependencies(overrides: Record<string, unknown> = {}) {
  return {
    verifyIdentity: async () => ({ kind: 'anonymous' as const, authSubject: 'auth-uid' }),
    providerFetch: async () => {
      throw new Error('unexpected provider fetch');
    },
    getDrop: (dropId: string) => dropId === DROP.dropId ? DROP : undefined,
    loadOnchainConfig: async () => ONCHAIN_CONFIG,
    requireFulfillmentPrerequisites: () => undefined,
    createProviderSession: async () => ({
      id: 'cs_test_123',
      url: 'https://checkout.stripe.com/c/pay/test',
      livemode: false,
    }),
    persistCheckout: async () => undefined,
    nowMs: () => 1_700_000_000_000,
    ...overrides,
  };
}

test('checkout handler authenticates, creates one session, and persists the exact document', async () => {
  const writes: Array<{ path: string; document: Record<string, unknown> }> = [];
  let providerRequest: unknown;
  const result = await handleStripeCheckoutSession(request({
    dropId: DROP.dropId,
    quantity: 1,
    returnUrl: 'https://mons.shop/drop',
  }), env(), dependencies({
    createProviderSession: async (input: unknown) => {
      providerRequest = input;
      return { id: 'cs_test_123', url: 'https://checkout.stripe.com/c/pay/test', livemode: false };
    },
    persistCheckout: async (path: string, document: Record<string, unknown>) => {
      writes.push({ path, document });
    },
  }));
  assert.equal(result.response.status, 200);
  assert.deepEqual(await result.response.json(), {
    id: 'cs_test_123',
    url: 'https://checkout.stripe.com/c/pay/test',
    livemode: false,
  });
  assert.equal(result.authOutcome, 'accepted');
  assert.equal(result.dropId, DROP.dropId);
  assert.equal(result.mode, 'test');
  assert.deepEqual(providerRequest, {
    mode: 'payment',
    automaticTax: true,
    billingAddressCollection: 'auto',
    successUrl: 'https://mons.shop/drop?stripe_checkout=success&session_id={CHECKOUT_SESSION_ID}',
    cancelUrl: 'https://mons.shop/drop?stripe_checkout=cancel',
    clientReferenceId: `${OPERATION_ID}:anonymous:auth-uid:card_nft_binder_devnet`,
    idempotencyKey: `mons-checkout:${OPERATION_ID}:anonymous:anonymous:auth-uid`,
    operationId: OPERATION_ID,
    quantity: 1,
    currency: 'usd',
    unitAmountCents: 100,
    productName: 'test Card NFT Binder',
    productTaxCode: 'txcd_99999999',
    metadata: {
      dropId: DROP.dropId,
      identitySchema: 'owner-v1',
      ownerKind: 'anonymous',
      owner: 'anonymous:auth-uid',
      authSubject: 'auth-uid',
      fulfillmentMode: 'admin_variant_receipt',
      placeholder: 'stripe_direct_delivery',
      quantity: '1',
    },
    allowedCountries: STRIPE_CHECKOUT_BINDER_SHIPPING_COUNTRIES,
  });
  assert.equal(writes[0]?.path, `drops/${DROP.dropId}/stripeCheckouts/cs_test_123`);
  assert.equal(writes[0]?.document.status, 'created');
  assert.equal(writes[0]?.document.owner, 'anonymous:auth-uid');
  assert.equal(writes[0]?.document.ownerKind, 'anonymous');
  assert.equal(writes[0]?.document.authSubject, 'auth-uid');
  assert.equal(Object.hasOwn(writes[0]?.document || {}, 'uid'), false);
});

test('checkout accepts legacy requests and generates a collision-safe operation id', async () => {
  let operationId = '';
  const result = await handleStripeCheckoutSession(new Request('https://api.mons.shop/checkout/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://mons.shop' },
    body: JSON.stringify({ dropId: DROP.dropId }),
  }), env(), dependencies({
    createProviderSession: async (providerRequest: { operationId: string }) => {
      operationId = providerRequest.operationId;
      return { id: 'cs_test_123', url: 'https://checkout.stripe.com/c/pay/test', livemode: false };
    },
  }));

  assert.equal(result.response.status, 200);
  assert.match(operationId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test('staff checkout persists the wallet as the direct order owner', async () => {
  let checkout: Record<string, unknown> | undefined;
  const result = await handleStripeCheckoutSession(
    request({ dropId: DROP.dropId }),
    env(),
    dependencies({
      persistCheckout: async (_path: string, document: Record<string, unknown>) => {
        checkout = document;
      },
      verifyIdentity: async () => ({ kind: 'staff-wallet' as const, wallet: STAFF_WALLET }),
    }),
  );
  assert.equal(result.response.status, 200);
  assert.equal(checkout?.owner, STAFF_WALLET);
  assert.equal(checkout?.ownerKind, 'wallet');
  assert.equal(Object.hasOwn(checkout || {}, 'uid'), false);
  assert.equal(Object.hasOwn(checkout || {}, 'authSubject'), false);
  assert.equal(Object.hasOwn(checkout || {}, 'authSubject'), false);
});

test('linked anonymous checkout persists the wallet as the direct order owner', async () => {
  let checkout: Record<string, unknown> | undefined;
  const result = await handleStripeCheckoutSession(
    request({ dropId: DROP.dropId }),
    { ...env(), OPS_DB: {} as D1Database },
    dependencies({
      persistCheckout: async (_path: string, document: Record<string, unknown>) => {
        checkout = document;
      },
      resolveAuthWalletBinding: async () => ({ wallet: STAFF_WALLET, source: 'binding' as const }),
    }),
  );
  assert.equal(result.response.status, 200);
  assert.equal(checkout?.owner, STAFF_WALLET);
  assert.equal(checkout?.ownerKind, 'wallet');
  assert.equal(Object.hasOwn(checkout || {}, 'uid'), false);
  assert.equal(Object.hasOwn(checkout || {}, 'authSubject'), false);
  assert.equal(Object.hasOwn(checkout || {}, 'authSubject'), false);
});

test('checkout handler rejects methods, malformed bodies, extra keys, and oversized JSON before providers', async () => {
  const wrongMethod = await handleStripeCheckoutSession(
    new Request('https://api.mons.shop/checkout/session'),
    env(),
    dependencies(),
  );
  assert.equal(wrongMethod.response.status, 405);
  assert.equal(wrongMethod.response.headers.get('allow'), 'POST, OPTIONS');

  for (const invalid of [
    new Request('https://api.mons.shop/checkout/session', { method: 'POST', body: '{}' }),
    request({ dropId: DROP.dropId, extra: true }),
    request({ dropId: DROP.dropId, operationId: 'not-a-uuid' }),
    request({ dropId: DROP.dropId }, { [STRIPE_CHECKOUT_OPERATION_HEADER]: 'not-a-uuid' }),
    request({ dropId: DROP.dropId, quantity: 0 }),
    request({ dropId: DROP.dropId, returnUrl: 'https://evil.example/drop' }),
    request({ dropId: DROP.dropId, returnUrl: `https://mons.shop/${'x'.repeat(4096)}` }),
  ]) {
    const result = await handleStripeCheckoutSession(invalid, env(), dependencies());
    assert.equal(result.response.status, 400);
    assert.equal(result.authOutcome, 'rejected');
  }
});

test('checkout handler maps authentication and provider failures to stable envelopes', async () => {
  const unauthenticated = await handleStripeCheckoutSession(request({ dropId: DROP.dropId }), env(), dependencies({
    verifyIdentity: async () => {
      const { RequestIdentityError } = await import('../src/requestIdentity.ts');
      throw new RequestIdentityError('invalid-token');
    },
  }));
  assert.equal(unauthenticated.response.status, 401);
  assert.deepEqual(await unauthenticated.response.json(), {
    ok: false,
    error: { code: 'unauthenticated', message: 'Authentication is required.' },
  });

  const providerFailure = await handleStripeCheckoutSession(request({ dropId: DROP.dropId }), env(), dependencies({
    createProviderSession: async () => {
      throw new StripeCheckoutSessionError('unavailable', 'Stripe checkout is temporarily unavailable.');
    },
  }));
  assert.equal(providerFailure.response.status, 502);
  assert.deepEqual(await providerFailure.response.json(), {
    ok: false,
    error: { code: 'unavailable', message: 'Stripe checkout is temporarily unavailable.' },
  });
  assert.equal(providerFailure.response.headers.get(STRIPE_CHECKOUT_RETRY_HEADER), null);
});

test('checkout prerequisites validate cosigner identity and address decryption material', () => {
  const cosigner = Keypair.generate();
  const validEnv = env({
    COSIGNER_SECRET: bs58.encode(cosigner.secretKey),
    ADDRESS_DECRYPTION_SECRET: Buffer.alloc(32, 7).toString('base64'),
  });
  assert.doesNotThrow(() => requireFulfillmentPrerequisites(validEnv, {
    ...ONCHAIN_CONFIG,
    admin: cosigner.publicKey.toBase58(),
  }));
  assert.throws(
    () => requireFulfillmentPrerequisites(validEnv, ONCHAIN_CONFIG),
    /does not match on-chain admin/,
  );
  assert.throws(
    () => requireFulfillmentPrerequisites({ ...validEnv, ADDRESS_DECRYPTION_SECRET: '' }, {
      ...ONCHAIN_CONFIG,
      admin: cosigner.publicKey.toBase58(),
    }),
    /ADDRESS_DECRYPTION_SECRET/,
  );
});

test('checkout Stripe key selection preserves secret-first credential fallback by mode', () => {
  assert.deepEqual(stripeKeys(env(), 'test'), ['sk_test_primary', 'rk_test_fallback']);
  assert.deepEqual(stripeKeys(env(), 'live'), ['sk_live_primary', 'rk_live_fallback']);
  assert.deepEqual(stripeKeys(env({ STRIPE_SECRET_KEY: 'sk_live_wrong' }), 'test'), ['rk_test_fallback']);
});

test('checkout Stripe provider uses the injected fetch with a stable idempotency key and combined signal', async () => {
  const client = new AbortController();
  let providerCalls = 0;
  let stripeSignal: AbortSignal | null | undefined;
  let idempotencyKey = '';
  const result = await handleStripeCheckoutSession(
    request({ dropId: DROP.dropId }, {}, client.signal),
    env(),
    dependencies({
      createProviderSession: undefined,
      providerFetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        providerCalls += 1;
        assert.equal(new URL(String(input)).hostname, 'api.stripe.com');
        stripeSignal = init?.signal;
        idempotencyKey = new Headers(init?.headers).get('idempotency-key') || '';
        await new Promise((resolve) => setTimeout(resolve, 5));
        return Response.json({
          id: 'cs_test_123',
          object: 'checkout.session',
          url: 'https://checkout.stripe.com/c/pay/test',
          livemode: false,
        });
      },
    }),
  );
  assert.equal(result.response.status, 200);
  assert.equal(
    idempotencyKey,
    `mons-checkout:${OPERATION_ID}:anonymous:anonymous:auth-uid`,
  );
  assert.notEqual(stripeSignal, client.signal);
  assert.equal(stripeSignal?.aborted, false);
  assert.equal(providerCalls, 1);
  assert.equal(result.metrics.upstreamCalls, 1);
  assert.ok(result.metrics.providerDurationMs >= 1);
});

test('checkout retries reuse one effective-owner key while owner changes use distinct keys', async () => {
  const retryOperationId = '22222222-2222-4222-8222-222222222222';
  const otherOperationId = '33333333-3333-4333-8333-333333333333';
  const keys: string[] = [];
  let nextSession = 0;
  const providerFetch: typeof fetch = async (_input, init) => {
    keys.push(new Headers(init?.headers).get('idempotency-key') || '');
    nextSession += 1;
    return Response.json({
      id: `cs_test_operation_${nextSession}`,
      object: 'checkout.session',
      url: `https://checkout.stripe.com/c/pay/${nextSession}`,
      livemode: false,
    });
  };
  const run = (operationId: string) => handleStripeCheckoutSession(
    request({ dropId: DROP.dropId }, { [STRIPE_CHECKOUT_OPERATION_HEADER]: operationId }),
    env(),
    dependencies({ createProviderSession: undefined, providerFetch }),
  );

  await run(retryOperationId);
  await run(retryOperationId);
  await Promise.all([run(retryOperationId), run(otherOperationId)]);
  await handleStripeCheckoutSession(
    request({ dropId: DROP.dropId }, { [STRIPE_CHECKOUT_OPERATION_HEADER]: retryOperationId }),
    { ...env(), OPS_DB: {} as D1Database },
    dependencies({
      createProviderSession: undefined,
      providerFetch,
      resolveAuthWalletBinding: async () => ({ wallet: STAFF_WALLET, source: 'binding' as const }),
    }),
  );
  await handleStripeCheckoutSession(
    request({ dropId: DROP.dropId }, { [STRIPE_CHECKOUT_OPERATION_HEADER]: retryOperationId }),
    env(),
    dependencies({
      createProviderSession: undefined,
      providerFetch,
      verifyIdentity: async () => ({ kind: 'staff-wallet' as const, wallet: STAFF_WALLET }),
    }),
  );

  assert.deepEqual(keys, [
    `mons-checkout:${retryOperationId}:anonymous:anonymous:auth-uid`,
    `mons-checkout:${retryOperationId}:anonymous:anonymous:auth-uid`,
    `mons-checkout:${retryOperationId}:anonymous:anonymous:auth-uid`,
    `mons-checkout:${otherOperationId}:anonymous:anonymous:auth-uid`,
    `mons-checkout:${retryOperationId}:wallet:${STAFF_WALLET}`,
    `mons-checkout:${retryOperationId}:wallet:${STAFF_WALLET}`,
  ]);
});

test('checkout treats changed parameters under one operation key as definitive', async () => {
  const operationId = '55555555-5555-4555-8555-555555555555';
  const keys: string[] = [];
  let calls = 0;
  const providerFetch: typeof fetch = async (_input, init) => {
    keys.push(new Headers(init?.headers).get('idempotency-key') || '');
    calls += 1;
    if (calls === 1) {
      return Response.json({
        id: 'cs_test_parameter_1',
        object: 'checkout.session',
        url: 'https://checkout.stripe.com/c/pay/parameter-1',
        livemode: false,
      });
    }
    return Response.json({
      error: {
        type: 'idempotency_error',
        message: 'Parameters differ from the original request.',
      },
    }, { status: 400 });
  };
  const run = (returnUrl: string) => handleStripeCheckoutSession(
    request({ dropId: DROP.dropId, returnUrl }, { [STRIPE_CHECKOUT_OPERATION_HEADER]: operationId }),
    env(),
    dependencies({ createProviderSession: undefined, providerFetch }),
  );

  assert.equal((await run('https://mons.shop/drop/one')).response.status, 200);
  const changed = await run('https://mons.shop/drop/two');
  assert.equal(changed.response.status, 502);
  assert.equal(changed.response.headers.get(STRIPE_CHECKOUT_RETRY_HEADER), null);
  assert.deepEqual(keys, [
    `mons-checkout:${operationId}:anonymous:anonymous:auth-uid`,
    `mons-checkout:${operationId}:anonymous:anonymous:auth-uid`,
  ]);
});

test('checkout retry does not overwrite a session that already advanced', async () => {
  const checkoutEnv = env();
  const operationId = '44444444-4444-4444-8444-444444444444';
  const run = () => handleStripeCheckoutSession(
    request({ dropId: DROP.dropId }, { [STRIPE_CHECKOUT_OPERATION_HEADER]: operationId }),
    checkoutEnv,
    dependencies({ persistCheckout: undefined }),
  );

  assert.equal((await run()).response.status, 200);
  const reference = createStripeCheckoutStore({ commerceDb: checkoutEnv.COMMERCE_DB })
    .doc(`drops/${DROP.dropId}/stripeCheckouts/cs_test_123`);
  await reference.update({ status: 'fulfillment_pending' });
  assert.equal((await run()).response.status, 200);
  assert.equal((await reference.get()).get('status'), 'fulfillment_pending');
});

test('checkout client cancellation aborts the injected Stripe fetch', async () => {
  const client = new AbortController();
  const abortReason = new DOMException('Client disconnected', 'AbortError');
  let started!: () => void;
  const providerStarted = new Promise<void>((resolve) => { started = resolve; });
  let stripeSignal: AbortSignal | null | undefined;
  const pending = handleStripeCheckoutSession(
    request({ dropId: DROP.dropId }, {}, client.signal),
    env(),
    dependencies({
      createProviderSession: undefined,
      providerFetch: async (_input: RequestInfo | URL, init?: RequestInit) => {
        stripeSignal = init?.signal;
        started();
        return new Promise<Response>((_resolve, reject) => {
          const abort = () => reject(init?.signal?.reason);
          init?.signal?.addEventListener('abort', abort, { once: true });
          if (init?.signal?.aborted) abort();
        });
      },
    }),
  );
  await providerStarted;
  client.abort(abortReason);
  await assert.rejects(pending, (error) => error === abortReason);
  assert.equal(stripeSignal?.aborted, true);
  assert.equal(stripeSignal?.reason, abortReason);
});

test('checkout provider races preserve abort-first and provider-first outcomes', async () => {
  const abortFirst = new AbortController();
  const abortReason = new Error('client disconnected first');
  await assert.rejects(
    handleStripeCheckoutSession(
      request({ dropId: DROP.dropId }, {}, abortFirst.signal),
      env(),
      dependencies({
        createProviderSession: undefined,
        providerFetch: async () => {
          abortFirst.abort(abortReason);
          throw new Error('Stripe failed after cancellation');
        },
      }),
    ),
    (error: unknown) => error === abortReason,
  );

  const client = new AbortController();
  const providerFailure = new Error('Stripe failed first');
  let rejectStripe!: (error: unknown) => void;
  let markStripeStarted!: () => void;
  const stripeStarted = new Promise<void>((resolve) => { markStripeStarted = resolve; });
  const pendingResult = handleStripeCheckoutSession(
    request({ dropId: DROP.dropId }, {}, client.signal),
    env(),
    dependencies({
      createProviderSession: undefined,
      providerFetch: () => new Promise((_resolve, reject) => {
        rejectStripe = reject;
        markStripeStarted();
      }),
    }),
  );
  await stripeStarted;
  rejectStripe(providerFailure);
  queueMicrotask(() => client.abort(new Error('late client disconnect')));
  const result = await pendingResult;

  assert.equal(result.response.status, 502);
  assert.equal(result.authOutcome, 'provider-failure');
  assert.equal(
    result.response.headers.get(STRIPE_CHECKOUT_RETRY_HEADER),
    STRIPE_CHECKOUT_RETRY_SAME_OPERATION,
  );

  const onchainAbortFirst = new AbortController();
  const onchainAbortReason = new Error('client disconnected before on-chain failure');
  await assert.rejects(
    handleStripeCheckoutSession(
      request({ dropId: DROP.dropId }, {}, onchainAbortFirst.signal),
      env(),
      dependencies({
        loadOnchainConfig: undefined,
        providerFetch: async () => {
          onchainAbortFirst.abort(onchainAbortReason);
          throw new Error('RPC failed after cancellation');
        },
      }),
    ),
    (error: unknown) => error === onchainAbortReason,
  );

  const onchainClient = new AbortController();
  const onchainFailure = new Error('RPC failed first');
  let rejectOnchain!: (error: unknown) => void;
  let markOnchainStarted!: () => void;
  const onchainStarted = new Promise<void>((resolve) => { markOnchainStarted = resolve; });
  const pendingOnchain = handleStripeCheckoutSession(
    request({ dropId: DROP.dropId }, {}, onchainClient.signal),
    env(),
    dependencies({
      loadOnchainConfig: undefined,
      providerFetch: () => new Promise((_resolve, reject) => {
        rejectOnchain = reject;
        markOnchainStarted();
      }),
    }),
  );
  await onchainStarted;
  rejectOnchain(onchainFailure);
  queueMicrotask(() => onchainClient.abort(new Error('late client disconnect')));
  const onchainResult = await pendingOnchain;
  assert.equal(onchainResult.response.status, 502);
  assert.equal(onchainResult.authOutcome, 'provider-failure');
  assert.equal(onchainResult.response.headers.get(STRIPE_CHECKOUT_RETRY_HEADER), null);
});

test('checkout marks post-provider persistence failures as uncertain', async () => {
  const result = await handleStripeCheckoutSession(
    request({ dropId: DROP.dropId }),
    env(),
    dependencies({
      persistCheckout: async () => {
        throw new Error('persistence unavailable');
      },
    }),
  );

  assert.equal(result.response.status, 502);
  assert.equal(
    result.response.headers.get(STRIPE_CHECKOUT_RETRY_HEADER),
    STRIPE_CHECKOUT_RETRY_SAME_OPERATION,
  );
  assert.deepEqual(await result.response.json(), {
    ok: false,
    error: { code: 'unavailable', message: 'Stripe checkout is temporarily unavailable.' },
  });
});

test('checkout deadlines retain and track an in-flight idempotent persistence write', async () => {
  let finishWrite!: () => void;
  const write = new Promise<void>((resolve) => { finishWrite = resolve; });
  const deferred: Promise<unknown>[] = [];
  const result = await handleStripeCheckoutSession(
    request({ dropId: DROP.dropId }),
    env(),
    dependencies({
      defer: (promise: Promise<unknown>) => deferred.push(promise),
      persistCheckout: () => write,
      timeoutMs: 25,
    }),
  );

  assert.equal(result.response.status, 504);
  assert.equal(
    result.response.headers.get(STRIPE_CHECKOUT_RETRY_HEADER),
    STRIPE_CHECKOUT_RETRY_SAME_OPERATION,
  );
  assert.equal(deferred.length, 1);
  finishWrite();
  await Promise.all(deferred);
});

test('checkout deadline bounds a non-cooperative wallet-binding read', async () => {
  let providerCalls = 0;
  const result = await handleStripeCheckoutSession(
    request({ dropId: DROP.dropId }),
    { ...env(), OPS_DB: {} as D1Database },
    dependencies({
      createProviderSession: async () => {
        providerCalls += 1;
        return { id: 'unexpected', url: 'https://checkout.stripe.com/c/pay/test', livemode: false };
      },
      resolveAuthWalletBinding: () => new Promise(() => undefined),
      timeoutMs: 5,
    }),
  );

  assert.equal(result.response.status, 504);
  assert.equal(providerCalls, 0);
});

test('checkout treats a fully received malformed Stripe success as definitive', async () => {
  const result = await handleStripeCheckoutSession(
    request({ dropId: DROP.dropId }),
    env(),
    dependencies({
      createProviderSession: undefined,
      providerFetch: async () => Response.json({
        id: 'cs_test_123',
        object: 'checkout.session',
        url: 'not-a-checkout-url',
        livemode: false,
      }),
    }),
  );

  assert.equal(result.response.status, 502);
  assert.equal(result.response.headers.get(STRIPE_CHECKOUT_RETRY_HEADER), null);
  assert.deepEqual(await result.response.json(), {
    ok: false,
    error: { code: 'unavailable', message: 'Stripe response did not include a checkout URL' },
  });
});

test('checkout treats an invalid Stripe success body as uncertain', async () => {
  const result = await handleStripeCheckoutSession(
    request({ dropId: DROP.dropId }),
    env(),
    dependencies({
      createProviderSession: undefined,
      providerFetch: async () => new Response('{"id":', {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    }),
  );

  assert.equal(result.response.status, 502);
  assert.equal(
    result.response.headers.get(STRIPE_CHECKOUT_RETRY_HEADER),
    STRIPE_CHECKOUT_RETRY_SAME_OPERATION,
  );
});

test('checkout treats a fully decoded Stripe error with status 200 as definitive', async () => {
  const result = await handleStripeCheckoutSession(
    request({ dropId: DROP.dropId }),
    env(),
    dependencies({
      createProviderSession: undefined,
      providerFetch: async () => Response.json({
        error: { type: 'api_error', message: 'Malformed success response.' },
      }),
    }),
  );

  assert.equal(result.response.status, 502);
  assert.equal(result.response.headers.get(STRIPE_CHECKOUT_RETRY_HEADER), null);
});

test('checkout treats an exhausted Stripe HTTP 500 as uncertain', async () => {
  let providerCalls = 0;
  const result = await handleStripeCheckoutSession(
    request({ dropId: DROP.dropId }),
    env(),
    dependencies({
      createProviderSession: undefined,
      providerFetch: async () => {
        providerCalls += 1;
        return Response.json({
          error: { type: 'api_error', message: 'Stripe failed to create the session.' },
        }, { status: 500 });
      },
    }),
  );

  assert.equal(providerCalls, 2);
  assert.equal(result.response.status, 502);
  assert.equal(
    result.response.headers.get(STRIPE_CHECKOUT_RETRY_HEADER),
    STRIPE_CHECKOUT_RETRY_SAME_OPERATION,
  );
});

test('checkout preserves a settled Stripe error response when cancellation interrupts its body', async () => {
  const client = new AbortController();
  const abortReason = new Error('client disconnected during Stripe error body');
  let responseStarted!: () => void;
  const providerResponded = new Promise<void>((resolve) => { responseStarted = resolve; });
  const pending = handleStripeCheckoutSession(
    request({ dropId: DROP.dropId }, {}, client.signal),
    env(),
    dependencies({
      createProviderSession: undefined,
      providerFetch: async (_input: RequestInfo | URL, init?: RequestInit) => {
        const response = new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            const abort = () => controller.error(init?.signal?.reason);
            init?.signal?.addEventListener('abort', abort, { once: true });
            if (init?.signal?.aborted) abort();
          },
        }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        });
        responseStarted();
        return response;
      },
    }),
  );

  await providerResponded;
  await new Promise((resolve) => setTimeout(resolve, 0));
  client.abort(abortReason);
  const result = await pending;

  assert.equal(result.response.status, 502);
  assert.equal(result.response.headers.get(STRIPE_CHECKOUT_RETRY_HEADER), null);
  assert.deepEqual(await result.response.json(), {
    ok: false,
    error: { code: 'unavailable', message: 'Stripe checkout is temporarily unavailable.' },
  });
});

test('checkout cancellation during an SDK retry preserves the client reason', async () => {
  const client = new AbortController();
  const abortReason = new Error('client disconnected during retry');
  let providerCalls = 0;
  const pending = handleStripeCheckoutSession(
    request({ dropId: DROP.dropId }, {}, client.signal),
    env(),
    dependencies({
      createProviderSession: undefined,
      providerFetch: async (_input: RequestInfo | URL, init?: RequestInit) => {
        providerCalls += 1;
        if (providerCalls === 1) throw new Error('transient first attempt failure');
        client.abort(abortReason);
        throw init?.signal?.reason;
      },
    }),
  );

  await assert.rejects(pending, (error) => error === abortReason);
  assert.equal(providerCalls, 2);
});

test('checkout cancellation during an SDK retry ignores a previous attempt status', async () => {
  const client = new AbortController();
  const abortReason = new Error('client disconnected during second Stripe attempt');
  let providerCalls = 0;
  let secondAttemptStarted!: () => void;
  const secondAttempt = new Promise<void>((resolve) => { secondAttemptStarted = resolve; });
  const pending = handleStripeCheckoutSession(
    request({ dropId: DROP.dropId }, {}, client.signal),
    env(),
    dependencies({
      createProviderSession: undefined,
      providerFetch: async (_input: RequestInfo | URL, init?: RequestInit) => {
        providerCalls += 1;
        if (providerCalls === 1) {
          return Response.json({
            error: { type: 'api_error', message: 'Retry this request.' },
          }, { status: 500 });
        }
        secondAttemptStarted();
        return new Promise<Response>((_resolve, reject) => {
          const abort = () => reject(init?.signal?.reason);
          init?.signal?.addEventListener('abort', abort, { once: true });
          if (init?.signal?.aborted) abort();
        });
      },
    }),
  );

  await secondAttempt;
  client.abort(abortReason);
  await assert.rejects(pending, (error) => error === abortReason);
  assert.equal(providerCalls, 2);
});
