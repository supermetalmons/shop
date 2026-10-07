import assert from 'node:assert/strict';
import test, { after, afterEach } from 'node:test';
import { useEffect } from 'react';
import { PublicKey, type Connection } from '@solana/web3.js';
import { setupFrontendDom } from './helpers/frontendDom.ts';
import { getFrontendDrop } from '../src/config/deployment.ts';
import { discountUsedKey, discountUsedScope, discountUsedVersion } from '../src/shop/persistedState.ts';

const { dom } = setupFrontendDom();
const { act, cleanup, renderHook, waitFor } = await import('@testing-library/react');
const { useMintDiscount } = await import('../src/shop/purchase/useMintDiscount.ts');
type Options = Parameters<typeof useMintDiscount>[0];
type Runtime = Parameters<typeof useMintDiscount>[1];

afterEach(() => {
  cleanup();
  dom.window.localStorage.clear();
});
after(() => dom.window.close());

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function harness() {
  const drop = getFrontendDrop('card_nft_2')!;
  const publicKey = new PublicKey(new Uint8Array(32).fill(1));
  const options: Options = {
    routeDrop: drop,
    routeConnection: {} as Connection,
    connectedWallet: publicKey.toBase58(),
    publicKey,
    walletBusy: false,
    mintedOut: false,
    activeDiscountAllowance: 3,
    activeDiscountScope: discountUsedScope(drop),
    activeDiscountVersion: discountUsedVersion(drop),
  };
  const calls: string[] = [];
  const runtime: Runtime = {
    isDiscountListed: async () => { calls.push('listed'); return true; },
    fetchDiscountMintRecordUsedCount: async () => { calls.push('used'); return 1; },
  };
  const cacheKey = discountUsedKey(options.activeDiscountVersion, options.connectedWallet);
  return { options, runtime, calls, cacheKey };
}

test('cached allowance waits for eligibility, then uses the on-chain count', async () => {
  const { options, runtime, calls, cacheKey } = harness();
  const listed = deferred<boolean>();
  runtime.isDiscountListed = () => listed.promise;
  dom.window.localStorage.setItem(cacheKey, '2');
  const { result, rerender } = renderHook((props: Options) => useMintDiscount(props, runtime), { initialProps: options });
  assert.equal(result.current.discountRemainingCount, 1);
  assert.equal(result.current.discountChecking, true);
  assert.equal(result.current.discountEligible, false);
  assert.equal(result.current.discountAvailable, false);
  await act(async () => { listed.resolve(true); });
  assert.equal(result.current.discountRemainingCount, 2);
  assert.equal(result.current.discountChecking, false);
  assert.equal(result.current.discountAvailable, true);
  assert.equal(dom.window.localStorage.getItem(cacheKey), '1');
  rerender({ ...options, walletBusy: true });
  assert.equal(result.current.discountAvailable, false);
  assert.equal(result.current.discountEligible, true);
  assert.deepEqual(calls, ['used']);
});

test('unlisted and exhausted wallets have no available discount', async () => {
  for (const listed of [false, true]) {
    const { options, runtime, cacheKey } = harness();
    let usedCalls = 0;
    runtime.isDiscountListed = async () => listed;
    runtime.fetchDiscountMintRecordUsedCount = async () => { usedCalls += 1; return 3; };
    dom.window.localStorage.setItem(cacheKey, '1');
    const { result, unmount } = renderHook(() => useMintDiscount(options, runtime));
    await waitFor(() => assert.equal(result.current.discountChecking, false));
    assert.equal(result.current.discountRemainingCount, 0);
    assert.equal(result.current.discountEligible, false);
    assert.equal(result.current.discountAvailable, false);
    assert.equal(usedCalls, listed ? 1 : 0);
    assert.equal(dom.window.localStorage.getItem(cacheKey), listed ? '3' : null);
    unmount();
  }
});

test('failed eligibility checks disable discounts without erasing the stored count', async (t) => {
  const warning = t.mock.method(console, 'warn', () => {});
  for (const stage of ['listed', 'used']) {
    const { options, runtime, cacheKey } = harness();
    const fail = async () => { throw new Error('Unavailable'); };
    if (stage === 'listed') runtime.isDiscountListed = fail;
    else runtime.fetchDiscountMintRecordUsedCount = fail;
    dom.window.localStorage.setItem(cacheKey, '1');
    const { result, unmount } = renderHook(() => useMintDiscount(options, runtime));
    await waitFor(() => assert.equal(result.current.discountChecking, false));
    assert.equal(result.current.discountRemainingCount, 0);
    assert.equal(result.current.discountAvailable, false);
    assert.equal(dom.window.localStorage.getItem(cacheKey), '1');
    unmount();
  }
  assert.equal(warning.mock.callCount(), 2);
});

test('disabled discount contexts skip network checks', () => {
  const { options, runtime, calls } = harness();
  const disabled: Partial<Options>[] = [
    { routeDrop: null },
    { routeDrop: { ...options.routeDrop!, salesMode: 'stripe_receipt_only' } },
    { routeConnection: null },
    { connectedWallet: undefined },
    { publicKey: null },
    { mintedOut: true },
  ];
  for (const override of disabled) {
    const { result, unmount } = renderHook(() => useMintDiscount({ ...options, ...override }, runtime));
    assert.equal(result.current.discountRemainingCount, 0);
    assert.equal(result.current.discountEligible, false);
    assert.equal(result.current.discountChecking, false);
    assert.equal(result.current.discountAvailable, false);
    unmount();
  }
  assert.deepEqual(calls, []);
});

test('wallet changes discard pending results after either eligibility request', async () => {
  for (const stage of ['listed', 'used']) {
    const { options, runtime, cacheKey } = harness();
    const nextKey = new PublicKey(new Uint8Array(32).fill(2));
    const listed = deferred<boolean>();
    const used = deferred<number>();
    let usedCalls = 0;
    runtime.isDiscountListed = async (_drop, address) => {
      if (address !== options.connectedWallet) return false;
      return stage === 'listed' ? listed.promise : true;
    };
    runtime.fetchDiscountMintRecordUsedCount = async () => { usedCalls += 1; return used.promise; };
    const { result, rerender, unmount } = renderHook((props: Options) => useMintDiscount(props, runtime), { initialProps: options });
    if (stage === 'used') await waitFor(() => assert.equal(usedCalls, 1));
    rerender({ ...options, connectedWallet: nextKey.toBase58(), publicKey: nextKey });
    await waitFor(() => assert.equal(result.current.discountChecking, false));
    await act(async () => { listed.resolve(true); used.resolve(1); });
    assert.equal(result.current.discountEligible, false);
    assert.equal(result.current.discountRemainingCount, 0);
    assert.equal(dom.window.localStorage.getItem(cacheKey), null);
    assert.equal(usedCalls, stage === 'used' ? 1 : 0);
    unmount();
  }
});

test('captured updates stay invalid after switching away and back to a discount context', async () => {
  const { options, runtime, cacheKey } = harness();
  const nextKey = new PublicKey(new Uint8Array(32).fill(2));
  const changes: Partial<Options>[] = [
    { connectedWallet: nextKey.toBase58(), publicKey: nextKey },
    { routeDrop: { ...options.routeDrop!, dropId: 'another-drop' } },
    { routeConnection: {} as Connection },
    { activeDiscountScope: 'another-scope' },
    { activeDiscountVersion: `${options.activeDiscountVersion}:next` },
    { activeDiscountAllowance: 4 },
    { mintedOut: true },
  ];
  for (const change of changes) {
    const { result, rerender, unmount } = renderHook((props: Options) => useMintDiscount(props, runtime), { initialProps: options });
    await waitFor(() => assert.equal(result.current.discountChecking, false));
    const update = result.current.captureDiscountUpdate();
    rerender({ ...options, ...change });
    await waitFor(() => assert.equal(result.current.discountChecking, false));
    rerender(options);
    await waitFor(() => assert.equal(result.current.discountChecking, false));
    await act(async () => update(0, 3));
    assert.equal(result.current.discountRemainingCount, 2);
    assert.equal(result.current.discountAvailable, true);
    assert.equal(dom.window.localStorage.getItem(cacheKey), '1');
    unmount();
  }
});

test('obsolete workflow updates cannot remove the current version from storage', async () => {
  const { options, runtime, cacheKey } = harness();
  const { result, rerender } = renderHook((props: Options) => useMintDiscount(props, runtime), { initialProps: options });
  await waitFor(() => assert.equal(result.current.discountChecking, false));
  const update = result.current.captureDiscountUpdate();
  const nextVersion = `${options.activeDiscountVersion}:next`;
  const nextCacheKey = discountUsedKey(nextVersion, options.connectedWallet);
  rerender({ ...options, activeDiscountVersion: nextVersion });
  await waitFor(() => assert.equal(result.current.discountChecking, false));
  await act(async () => update(0, 3));
  assert.equal(result.current.discountRemainingCount, 2);
  assert.equal(dom.window.localStorage.getItem(nextCacheKey), '1');
  assert.equal(dom.window.localStorage.getItem(cacheKey), null);
});

test('accepted workflow updates finish checking and supersede older eligibility results', async (t) => {
  const warning = t.mock.method(console, 'warn', () => {});
  for (const fail of [false, true]) {
    const { options, runtime, cacheKey } = harness();
    const used = deferred<number>();
    let checkingUsed = false;
    runtime.fetchDiscountMintRecordUsedCount = () => { checkingUsed = true; return used.promise; };
    const { result, unmount } = renderHook(() => useMintDiscount(options, runtime));
    await waitFor(() => assert.equal(checkingUsed, true));
    assert.equal(result.current.discountChecking, true);
    act(() => result.current.captureDiscountUpdate()(1, 2));
    assert.equal(result.current.discountChecking, false);
    assert.equal(result.current.discountRemainingCount, 1);
    assert.equal(result.current.discountAvailable, true);
    await act(async () => {
      if (fail) used.reject(new Error('Old request failed'));
      else used.resolve(0);
    });
    assert.equal(result.current.discountChecking, false);
    assert.equal(result.current.discountRemainingCount, 1);
    assert.equal(dom.window.localStorage.getItem(cacheKey), '2');
    act(() => result.current.captureDiscountUpdate()(0));
    assert.equal(result.current.discountEligible, false);
    assert.equal(dom.window.localStorage.getItem(cacheKey), '2');
    unmount();
  }
  assert.equal(warning.mock.callCount(), 0);
});

test('a newer workflow update supersedes a stale completion refresh in the same turn', async () => {
  const { options, runtime } = harness();
  let usedCount = 1;
  runtime.fetchDiscountMintRecordUsedCount = async () => usedCount;
  const { result, rerender } = renderHook((props: Options) => useMintDiscount(props, runtime), { initialProps: options });
  await waitFor(() => assert.equal(result.current.discountChecking, false));
  const staleUpdate = result.current.captureDiscountUpdate();
  const nextVersion = `${options.activeDiscountVersion}:next`;
  rerender({ ...options, activeDiscountVersion: nextVersion });
  await waitFor(() => assert.equal(result.current.discountChecking, false));
  const currentUpdate = result.current.captureDiscountUpdate();
  usedCount = 0;
  await act(async () => {
    staleUpdate(0, 3);
    currentUpdate(1, 2);
  });
  assert.equal(result.current.discountRemainingCount, 1);
  assert.equal(result.current.discountAvailable, true);
  assert.equal(dom.window.localStorage.getItem(discountUsedKey(nextVersion, options.connectedWallet)), '2');
});

test('unmount rejects pending reads and captured workflow persistence', async () => {
  const { options, runtime, cacheKey } = harness();
  const used = deferred<number>();
  let checkingUsed = false;
  runtime.fetchDiscountMintRecordUsedCount = () => { checkingUsed = true; return used.promise; };
  const { result, unmount } = renderHook(() => useMintDiscount(options, runtime));
  await waitFor(() => assert.equal(checkingUsed, true));
  const update = result.current.captureDiscountUpdate();
  unmount();
  await act(async () => { update(1, 2); used.resolve(1); });
  assert.equal(dom.window.localStorage.getItem(cacheKey), null);
});

test('Strict Mode replay rejects updates captured before effect cleanup', async () => {
  const { options, runtime, cacheKey } = harness();
  const updates: Array<ReturnType<ReturnType<typeof useMintDiscount>['captureDiscountUpdate']>> = [];
  const { result } = renderHook(() => {
    const discount = useMintDiscount(options, runtime);
    useEffect(() => { updates.push(discount.captureDiscountUpdate()); }, [discount.captureDiscountUpdate]);
    return discount;
  }, { reactStrictMode: true });
  await waitFor(() => assert.equal(result.current.discountChecking, false));
  assert.equal(updates.length, 2);
  await act(async () => updates[0](0, 3));
  assert.equal(result.current.discountRemainingCount, 2);
  assert.equal(dom.window.localStorage.getItem(cacheKey), '1');
  act(() => updates[1](1, 2));
  assert.equal(result.current.discountRemainingCount, 1);
  assert.equal(dom.window.localStorage.getItem(cacheKey), '2');
});
