import assert from 'node:assert/strict';
import test, { after, afterEach } from 'node:test';
import { PublicKey, TransactionMessage, VersionedTransaction, type Connection } from '@solana/web3.js';
import { setupFrontendDom } from './helpers/frontendDom.ts';
import { getFrontendDrop } from '../src/config/deployment.ts';
import * as boxMinter from '../src/lib/boxMinter.ts';

const { dom } = setupFrontendDom();
const { act, cleanup, renderHook, waitFor } = await import('@testing-library/react');
const { useShopPurchaseActionsWithRuntime: useShopPurchaseActions } = await import('../src/shop/purchase/useShopPurchaseActionsWithRuntime.ts');
const { useEffectiveMintStats } = await import('../src/shop/purchase/useShopPurchaseState.ts');
const { discountUsedKey } = await import('../src/shop/persistedState.ts');
type Options = Parameters<typeof useShopPurchaseActions>[0];
type Runtime = NonNullable<Parameters<typeof useShopPurchaseActions>[1]>;

afterEach(() => {
  cleanup();
  dom.window.localStorage.clear();
});
after(() => dom.window.close());

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function harness() {
  const drop = { ...getFrontendDrop('card_nft_2')!, forceSoldOut: false, stripeCheckoutEnabled: true };
  assert.ok(drop.dropId);
  const publicKey = new PublicKey(new Uint8Array(32).fill(1));
  const asset = new PublicKey(new Uint8Array(32).fill(2));
  const transaction = new VersionedTransaction(new TransactionMessage({
    payerKey: publicKey,
    recentBlockhash: publicKey.toBase58(),
    instructions: [],
  }).compileToV0Message());
  const events: string[] = [];
  const options: Options = {
    routeDrop: drop,
    routeConnection: {} as Connection,
    connectedWallet: publicKey.toBase58(),
    publicKey,
    walletBusy: false,
    authSubject: null,
    effectiveMintStats: { minted: 5, total: 100, remaining: 95, maxPerTx: 5 },
    activeDiscountAllowance: 2,
    activeDiscountScope: 'test-discount',
    activeDiscountVersion: 'test-version',
    shouldFetchMintStats: true,
    refetchStats: async () => { events.push('stats'); },
    refetchInventory: async () => { events.push('inventory'); },
    refreshInventoryAfterMint: async () => { events.push('inventory-after-mint'); },
    addLocalMintedBoxes: (quantity, dropId, ids) => {
      events.push('local-boxes');
      assert.equal(quantity, 2);
      assert.equal(dropId, drop.dropId);
      assert.deepEqual(ids, [asset.toBase58()]);
    },
    blockViewerModeAction: () => false,
    requireRouteDrop: () => drop,
    setVisible: () => { events.push('wallet-modal'); },
    showToast: (message) => { events.push(`toast:${message}`); },
    isUserRejectedError: () => false,
    rememberCheckoutStarted: () => { events.push('remember-checkout'); },
    sendAndConfirmMintViaConnection: async (tx, connection) => {
      assert.equal(tx, transaction);
      assert.equal(connection, options.routeConnection);
      events.push('confirm');
      return false;
    },
  };
  const runtime: Runtime = {
    ...boxMinter,
    getDiscountProof: async () => null,
    createStripeCheckoutSession: async () => { throw new Error('Unexpected checkout'); },
    isDiscountListed: async () => false,
    fetchBoxMinterConfig: async () => ({ discountMintsPerWallet: 2 } as boxMinter.BoxMinterConfigAccount),
    buildMintBoxesTxWithAccounts: async () => {
      events.push('build');
      return { tx: transaction, boxAccounts: [asset] };
    },
    registerRecentExpectedInventoryAssets: (owner, cluster, ids) => {
      events.push('expected-assets');
      assert.equal(owner, publicKey.toBase58());
      assert.equal(cluster, drop.solanaCluster);
      assert.deepEqual(ids, [asset.toBase58()]);
    },
    redirect: () => { events.push('redirect'); },
  };
  return { options, runtime, events, drop };
}

function discountHarness() {
  const h = harness();
  h.options.activeDiscountScope = 'monsDiscountUsed:regression';
  h.options.activeDiscountVersion = 'regression:v1';
  h.options.addLocalMintedBoxes = (quantity) => {
    assert.equal(quantity, 1);
    h.events.push('local-boxes');
  };
  h.runtime.isDiscountListed = async () => true;
  h.runtime.fetchDiscountMintRecordUsedCount = async () => 0;
  h.runtime.getDiscountProof = async () => [new Uint8Array(32)];
  h.runtime.buildMintDiscountedBoxTxWithAccounts = (connection, config, payer, quantity, proof, drop) => {
    assert.equal(proof.length, 1);
    return h.runtime.buildMintBoxesTxWithAccounts(connection, config, payer, quantity, drop);
  };
  return h;
}

test('confirmed mint resets controls and registers expected assets before a slow refresh finishes', async () => {
  const { options, runtime, events } = harness();
  const refresh = deferred<void>();
  options.refreshInventoryAfterMint = () => {
    events.push('inventory-after-mint');
    return refresh.promise;
  };
  const { result } = renderHook(() => useShopPurchaseActions(options, runtime));
  let mint!: Promise<void>;
  act(() => { mint = result.current.handleMint(2); });
  await waitFor(() => assert.equal(result.current.successfulMintToken, 1));
  assert.equal(result.current.minting, true);
  assert.deepEqual(events, ['build', 'confirm', 'expected-assets', 'local-boxes', 'stats', 'inventory-after-mint']);
  await act(async () => { await result.current.handleMint(2); });
  assert.equal(events.filter((event) => event === 'build').length, 1);
  await act(async () => {
    refresh.resolve();
    await mint;
  });
  assert.equal(result.current.minting, false);
  assert.equal(result.current.successfulMintToken, 1);
});

test('Stripe retry retains the operation after credential resolution and stores the size purchase before redirect', async () => {
  const { options, runtime, events, drop } = harness();
  const sizedDrop = {
    ...drop,
    itemsPerBox: 0,
    mintSelection: { kind: 'size' as const, options: [{ key: 'L', label: 'L', startId: 1, endId: 10 }] },
  };
  options.routeDrop = sizedDrop;
  options.requireRouteDrop = () => sizedDrop;
  options.effectiveMintStats = { minted: 5, total: 100, remaining: 95, mintSelectionAvailability: { L: 10 } };
  const requests: Array<{ id: string; quantity?: number }> = [];
  const markers: Parameters<Options['rememberCheckoutStarted']>[0][] = [];
  runtime.createStripeCheckoutSession = async (request, operationId, onCredential) => {
    requests.push({ id: operationId, quantity: request.quantity });
    onCredential?.('anonymous-subject');
    if (requests.length === 1) throw new TypeError('fetch failed');
    return { id: 'cs_test_retry', url: 'https://checkout.stripe.com/test', livemode: false, authSubject: 'anonymous-subject' };
  };
  options.rememberCheckoutStarted = (marker) => { markers.push(marker); events.push('remember-checkout'); };
  const { result, rerender } = renderHook((props: Options) => useShopPurchaseActions(props, runtime), { initialProps: options });
  await act(async () => { await result.current.handleStripePayment(3, 'L'); });
  assert.equal(result.current.stripePaymentLoading, false);
  assert.equal(markers.length, 0);
  rerender({ ...options, authSubject: 'anonymous-subject' });
  await act(async () => { await result.current.handleStripePayment(3, 'L'); });
  assert.equal(requests.length, 2);
  assert.equal(requests[0].id, requests[1].id);
  assert.deepEqual(requests.map((request) => request.quantity), [1, 1]);
  assert.deepEqual(markers.map(({ createdAt, ...marker }) => {
    assert.equal(typeof createdAt, 'number');
    return marker;
  }), [{
    sessionId: 'cs_test_retry', dropId: drop.dropId, authSubject: 'anonymous-subject',
    quantity: 1, remainingBeforeCheckout: 95, variantKey: 'L', variantRemainingBeforeCheckout: 10,
  }]);
  assert.deepEqual(events.slice(-2), ['remember-checkout', 'redirect']);
});

test('viewer mode stops both payment paths before any wallet or network work', async () => {
  const { options, runtime, events } = harness();
  options.blockViewerModeAction = () => true;
  const { result } = renderHook(() => useShopPurchaseActions(options, runtime));
  await act(async () => {
    await result.current.handleMint(2);
    await result.current.handleStripePayment(2);
  });
  assert.deepEqual(events, []);
  assert.equal(result.current.successfulMintToken, 0);
});

test('a confirmed discount mint cannot apply its allowance to a different wallet', async () => {
  const { options, runtime, events } = discountHarness();
  const nextKey = new PublicKey(new Uint8Array(32).fill(3));
  const confirmation = deferred<boolean>();
  let confirming = false;
  runtime.isDiscountListed = async (_drop, wallet) => wallet === options.connectedWallet;
  options.sendAndConfirmMintViaConnection = () => { confirming = true; return confirmation.promise; };
  const { result, rerender } = renderHook((props: Options) => useShopPurchaseActions(props, runtime), { initialProps: options });
  await waitFor(() => assert.equal(result.current.discountAvailable, true));
  let mint!: Promise<void>;
  act(() => { mint = result.current.handleDiscountMint(1); });
  await waitFor(() => assert.equal(confirming, true));
  rerender({ ...options, connectedWallet: nextKey.toBase58(), publicKey: nextKey });
  await waitFor(() => assert.equal(result.current.discountChecking, false));
  await act(async () => { confirmation.resolve(false); await mint; });
  assert.equal(result.current.discountRemainingCount, 0);
  assert.equal(result.current.discountEligible, false);
  assert.equal(result.current.discountAvailable, false);
  assert.equal(result.current.successfulMintToken, 1);
  assert.equal(result.current.discountMinting, false);
  assert.ok(events.includes('expected-assets'));
  assert.ok(events.includes('inventory-after-mint'));
  assert.equal(dom.window.localStorage.getItem(discountUsedKey(options.activeDiscountVersion, options.connectedWallet)), null);
});

test('a confirmed discount mint cannot overwrite a newer discount version in storage', async () => {
  const { options, runtime } = discountHarness();
  const confirmation = deferred<boolean>();
  let confirming = false;
  options.sendAndConfirmMintViaConnection = () => { confirming = true; return confirmation.promise; };
  const { result, rerender } = renderHook((props: Options) => useShopPurchaseActions(props, runtime), { initialProps: options });
  await waitFor(() => assert.equal(result.current.discountAvailable, true));
  let mint!: Promise<void>;
  act(() => { mint = result.current.handleDiscountMint(1); });
  await waitFor(() => assert.equal(confirming, true));
  runtime.fetchDiscountMintRecordUsedCount = async () => 1;
  const nextVersion = 'regression:v2';
  const nextCacheKey = discountUsedKey(nextVersion, options.connectedWallet);
  rerender({ ...options, activeDiscountVersion: nextVersion });
  await waitFor(() => assert.equal(result.current.discountChecking, false));
  assert.equal(dom.window.localStorage.getItem(nextCacheKey), '1');
  await act(async () => { confirmation.resolve(false); await mint; });
  assert.equal(result.current.discountRemainingCount, 1);
  assert.equal(result.current.successfulMintToken, 1);
  assert.equal(dom.window.localStorage.getItem(nextCacheKey), '1');
  assert.equal(dom.window.localStorage.getItem(discountUsedKey(options.activeDiscountVersion, options.connectedWallet)), null);
});

for (const contextChange of ['wallet', 'route'] as const) {
  test(`a discount mint refreshes allowance after switching ${contextChange} away and back before confirmation`, async () => {
    const { options, runtime, events } = discountHarness();
    const nextKey = new PublicKey(new Uint8Array(32).fill(3));
    const confirmation = deferred<boolean>();
    let confirming = false;
    let usedCount = 0;
    let usedReads = 0;
    runtime.fetchDiscountMintRecordUsedCount = async () => { usedReads += 1; return usedCount; };
    options.sendAndConfirmMintViaConnection = () => { confirming = true; return confirmation.promise; };
    options.refetchStats = async () => {
      events.push('stats');
      rerender({ ...options, effectiveMintStats: { minted: 6, total: 100, remaining: 94, maxPerTx: 5 } });
    };
    const { result, rerender } = renderHook((props: Options) => useShopPurchaseActions(props, runtime), { initialProps: options });
    await waitFor(() => assert.equal(result.current.discountAvailable, true));
    let mint!: Promise<void>;
    act(() => { mint = result.current.handleDiscountMint(1); });
    await waitFor(() => assert.equal(confirming, true));
    rerender(contextChange === 'wallet'
      ? { ...options, connectedWallet: nextKey.toBase58(), publicKey: nextKey }
      : {
        ...options, routeDrop: null, routeConnection: null, effectiveMintStats: undefined,
        activeDiscountAllowance: 0, activeDiscountScope: 'monsDiscountUsed:none', activeDiscountVersion: 'none',
      });
    await waitFor(() => assert.equal(result.current.discountChecking, false));
    rerender(options);
    await waitFor(() => assert.equal(result.current.discountAvailable, true));
    assert.equal(result.current.discountRemainingCount, 2);
    const readsBeforeConfirmation = usedReads;
    usedCount = 1;
    await act(async () => { confirmation.resolve(false); await mint; });
    await waitFor(() => assert.equal(result.current.discountRemainingCount, 1));
    assert.equal(result.current.discountChecking, false);
    assert.equal(result.current.discountAvailable, true);
    assert.equal(result.current.discountMinting, false);
    assert.equal(result.current.successfulMintToken, 1);
    assert.ok(usedReads > readsBeforeConfirmation);
    assert.ok(events.includes('stats'));
    assert.ok(events.includes('inventory-after-mint'));
    assert.equal(dom.window.localStorage.getItem(discountUsedKey(options.activeDiscountVersion, options.connectedWallet)), '1');
  });
}

test('effective supply retains forced sold-out and route-scoped Stripe adjustments', () => {
  const { drop } = harness();
  const initial: Parameters<typeof useEffectiveMintStats>[0] = {
    routeDrop: drop,
    mintStats: { minted: 5, total: 100, remaining: 95 },
    stripeCheckoutOptimisticMintProgress: { dropId: drop.dropId, quantity: 2, remainingBeforeCheckout: 95 },
  };
  const { result, rerender } = renderHook(useEffectiveMintStats, { initialProps: initial });
  assert.equal(result.current?.remaining, 93);
  rerender({ ...initial, routeDrop: { ...drop, forceSoldOut: true } });
  assert.equal(result.current?.remaining, 0);
  rerender({ ...initial, stripeCheckoutOptimisticMintProgress: { ...initial.stripeCheckoutOptimisticMintProgress!, dropId: 'another-drop' } });
  assert.equal(result.current?.remaining, 95);
});
