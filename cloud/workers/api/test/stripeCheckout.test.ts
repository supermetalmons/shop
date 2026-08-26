import assert from 'node:assert/strict';
import test from 'node:test';
import bs58 from 'bs58';
import { Keypair } from '@solana/web3.js';
import {
  STRIPE_CHECKOUT_BINDER_SHIPPING_COUNTRIES,
  StripeCheckoutSessionError,
  type StripeCheckoutOnchainConfig,
  type StripeCheckoutSessionDrop,
} from '../../../../shared/stripeCheckoutSession.ts';
import {
  handleStripeCheckoutSession,
  stripeCheckoutTestHooks,
} from '../src/stripeCheckout.ts';

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

function env(overrides: Partial<Record<
  | 'ADDRESS_DECRYPTION_SECRET'
  | 'COSIGNER_SECRET'
  | 'FIRESTORE_WRITER_SERVICE_ACCOUNT_JSON'
  | 'HELIUS_API_KEY'
  | 'STRIPE_RESTRICTED_KEY'
  | 'STRIPE_RESTRICTED_KEY_LIVE'
  | 'STRIPE_SECRET_KEY'
  | 'STRIPE_SECRET_KEY_LIVE',
  string
>> = {}) {
  return {
    HELIUS_API_KEY: 'helius-test-key',
    COSIGNER_SECRET: '',
    FIRESTORE_WRITER_SERVICE_ACCOUNT_JSON: '{}',
    ADDRESS_DECRYPTION_SECRET: '',
    STRIPE_SECRET_KEY: 'sk_test_primary',
    STRIPE_RESTRICTED_KEY: 'rk_test_fallback',
    STRIPE_SECRET_KEY_LIVE: 'sk_live_primary',
    STRIPE_RESTRICTED_KEY_LIVE: 'rk_live_fallback',
    ...overrides,
  };
}

function request(body: unknown, headers: HeadersInit = {}): Request {
  return new Request('https://api.mons.shop/checkout/session', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: 'https://mons.shop',
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

function dependencies(overrides: Record<string, unknown> = {}) {
  return {
    verifyIdentity: async () => ({ kind: 'anonymous' as const, authSubject: 'firebase-uid' }),
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
    clientReferenceId: 'firebase-uid:card_nft_binder_devnet:1700000000000',
    quantity: 1,
    currency: 'usd',
    unitAmountCents: 100,
    productName: 'test Card NFT Binder',
    productTaxCode: 'txcd_99999999',
    metadata: {
      dropId: DROP.dropId,
      uid: 'firebase-uid',
      fulfillmentMode: 'admin_variant_receipt',
      placeholder: 'stripe_direct_delivery',
      quantity: '1',
    },
    allowedCountries: STRIPE_CHECKOUT_BINDER_SHIPPING_COUNTRIES,
  });
  assert.equal(writes[0]?.path, `drops/${DROP.dropId}/stripeCheckouts/cs_test_123`);
  assert.equal(writes[0]?.document.status, 'created');
  assert.equal(writes[0]?.document.owner, 'firebase:firebase-uid');
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
  assert.equal(checkout?.uid, STAFF_WALLET);
  assert.equal(Object.hasOwn(checkout || {}, 'firebaseUid'), false);
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
      resolveWalletSession: async () => ({ wallet: STAFF_WALLET, source: 'session' as const }),
    }),
  );
  assert.equal(result.response.status, 200);
  assert.equal(checkout?.owner, STAFF_WALLET);
  assert.equal(checkout?.ownerKind, 'wallet');
  assert.equal(checkout?.uid, STAFF_WALLET);
  assert.equal(Object.hasOwn(checkout || {}, 'firebaseUid'), false);
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
});

test('checkout prerequisites validate cosigner identity and address decryption material', () => {
  const cosigner = Keypair.generate();
  const validEnv = env({
    COSIGNER_SECRET: bs58.encode(cosigner.secretKey),
    ADDRESS_DECRYPTION_SECRET: Buffer.alloc(32, 7).toString('base64'),
  });
  assert.doesNotThrow(() => stripeCheckoutTestHooks.requireFulfillmentPrerequisites(validEnv, {
    ...ONCHAIN_CONFIG,
    admin: cosigner.publicKey.toBase58(),
  }));
  assert.throws(
    () => stripeCheckoutTestHooks.requireFulfillmentPrerequisites(validEnv, ONCHAIN_CONFIG),
    /does not match on-chain admin/,
  );
  assert.throws(
    () => stripeCheckoutTestHooks.requireFulfillmentPrerequisites({ ...validEnv, ADDRESS_DECRYPTION_SECRET: '' }, {
      ...ONCHAIN_CONFIG,
      admin: cosigner.publicKey.toBase58(),
    }),
    /ADDRESS_DECRYPTION_SECRET/,
  );
});

test('checkout Stripe key selection preserves secret-first credential fallback by mode', () => {
  assert.deepEqual(stripeCheckoutTestHooks.stripeKeys(env(), 'test'), ['sk_test_primary', 'rk_test_fallback']);
  assert.deepEqual(stripeCheckoutTestHooks.stripeKeys(env(), 'live'), ['sk_live_primary', 'rk_live_fallback']);
  assert.deepEqual(stripeCheckoutTestHooks.stripeKeys(env({ STRIPE_SECRET_KEY: 'sk_live_wrong' }), 'test'), ['rk_test_fallback']);
});
