import assert from 'node:assert/strict';
import test, { after, afterEach } from 'node:test';
import { setupFrontendDom } from './helpers/frontendDom.ts';
import { encodeDeliveryRecoveryCursor } from '../shared/deliveryRecoveryPagination.ts';
import type { RecoverDeliveryOrdersArgs, RecoverDeliveryOrdersResult } from '../shared/contracts.ts';

const { dom } = setupFrontendDom();
const { act, cleanup, renderHook, waitFor } = await import('@testing-library/react');
const { useDeliveryRecovery } = await import('../src/shop/account/useDeliveryRecovery.ts');
const OWNER = '11111111111111111111111111111111';
const OTHER_OWNER = 'So11111111111111111111111111111111111111112';

afterEach(cleanup);
after(() => dom.window.close());

function result(nextCursor: string | null, attempted = 0): RecoverDeliveryOrdersResult {
  return { attempted, recovered: 0, remainingProcessing: 0, walletRecovery: { remainingProcessing: 0, nextCheckAt: null }, results: [], nextCursor };
}

function cursor(path: number, dropId: string | null = null, owner = OWNER): string {
  return encodeDeliveryRecoveryCursor({
    version: 1, owner, dropId, force: false, phase: 'processing', path: `drops/${dropId ?? 'card_nft_2'}/deliveryOrders/${path}`,
  });
}

function harness() {
  let wallet: string = OWNER;
  const schedules: Array<number | null> = [];
  let inventoryRefreshes = 0;
  let profileRefreshes = 0;
  const options = {
    auth: {
      hasAuthenticatedWalletSession: (owner: string) => wallet === owner,
      beginDeliveryRecoveryScheduleUpdate: () => (next: number | null) => { schedules.push(next); },
      reconcileProfile: async () => assert.fail('unexpected profile reconciliation'),
      refreshProfileState: async () => { profileRefreshes += 1; },
    },
    authenticatedWallet: OWNER,
    hasAuthenticatedAccount: true,
    isViewerMode: false,
    currentOwnerDeliveryRecoveryNextCheckAt: null,
    refetchInventory: async () => { inventoryRefreshes += 1; },
  } as unknown as Parameters<typeof useDeliveryRecovery>[0];
  return {
    options, schedules, setWallet: (owner: string) => { wallet = owner; },
    get inventoryRefreshes() { return inventoryRefreshes; },
    get profileRefreshes() { return profileRefreshes; },
  };
}

test('delivery recovery drains two pages and resumes the same filter on the next scheduled run', async () => {
  const h = harness();
  const requests: Array<RecoverDeliveryOrdersArgs | undefined> = [];
  const responses = [result(cursor(1, 'card_nft_2'), 1), result(cursor(2, 'card_nft_2')), result(null)];
  const recover = async (request?: RecoverDeliveryOrdersArgs) => {
    requests.push(request);
    return responses[requests.length - 1];
  };
  const hook = renderHook((options) => useDeliveryRecovery(options, recover), { initialProps: h.options });
  const before = Date.now();
  await act(() => hook.result.current({ dropId: 'card_nft_2' }));
  assert.deepEqual(requests, [
    { dropId: 'card_nft_2', cursor: null },
    { dropId: 'card_nft_2', cursor: cursor(1, 'card_nft_2') },
  ]);
  assert.ok(h.schedules[0]! >= before + 30_000);
  assert.ok(h.schedules[0]! <= Date.now() + 30_000);
  assert.equal(h.inventoryRefreshes, 1);
  hook.rerender({ ...h.options, currentOwnerDeliveryRecoveryNextCheckAt: Date.now() - 1 });
  await waitFor(() => assert.equal(requests.length, 3));
  assert.deepEqual(requests[2], { dropId: 'card_nft_2', cursor: cursor(2, 'card_nft_2') });
  assert.equal(h.schedules.at(-1), null);
  assert.equal(h.profileRefreshes, 2);
});

test('delivery recovery drops a stale wallet response before continuing or updating state', async () => {
  const h = harness();
  const requests: Array<RecoverDeliveryOrdersArgs | undefined> = [];
  let resolve!: (value: RecoverDeliveryOrdersResult) => void;
  const pending = new Promise<RecoverDeliveryOrdersResult>((done) => { resolve = done; });
  const recover = async (request?: RecoverDeliveryOrdersArgs) => {
    requests.push(request);
    return requests.length === 1 ? pending : result(null);
  };
  const hook = renderHook((options) => useDeliveryRecovery(options, recover), { initialProps: h.options });
  let running!: Promise<void>;
  act(() => { running = hook.result.current(); });
  assert.equal(requests.length, 1);
  h.setWallet(OTHER_OWNER);
  hook.rerender({ ...h.options, authenticatedWallet: OTHER_OWNER });
  await act(async () => { resolve(result(cursor(1), 1)); await running; });
  assert.equal(requests.length, 1);
  assert.deepEqual(h.schedules, []);
  assert.equal(h.inventoryRefreshes, 0);
  assert.equal(h.profileRefreshes, 0);
  await act(() => hook.result.current());
  assert.deepEqual(requests[1], { cursor: null });
});

test('delivery recovery resets pagination when filters change and keeps targeted requests unchanged', async () => {
  const h = harness();
  const requests: Array<RecoverDeliveryOrdersArgs | undefined> = [];
  const recover = async (request?: RecoverDeliveryOrdersArgs) => {
    requests.push(request);
    return request?.dropId === 'card_nft_2' && request.deliveryId === undefined
      ? result(cursor(requests.length, 'card_nft_2')) : result(null);
  };
  const hook = renderHook(() => useDeliveryRecovery(h.options, recover));
  await act(() => hook.result.current({ dropId: 'card_nft_2' }));
  await act(() => hook.result.current({ dropId: 'poncho' }));
  assert.deepEqual(requests[2], { dropId: 'poncho', cursor: null });
  await act(() => hook.result.current({ dropId: 'card_nft_2', deliveryId: 17, force: true }));
  assert.deepEqual(requests[3], { dropId: 'card_nft_2', deliveryId: 17, force: true });
});
