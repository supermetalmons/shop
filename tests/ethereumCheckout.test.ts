import assert from 'node:assert/strict';
import test, { afterEach, beforeEach, type TestContext } from 'node:test';
import { createElement } from 'react';
import { setupFrontendDom } from './helpers/frontendDom.ts';
import { resolveEthereum111kConfig } from '../shared/ethereum/config.ts';
import { checkoutReturnUrl, type EthereumCheckoutStatusResponse, type EthereumCheckoutSubmissionRequest } from '../shared/ethereum/checkout.ts';
import { encodeCall } from '../shared/ethereum/abi.ts';
import { ethereumReceiptIdsHash } from '../shared/ethereum/crypto.ts';
import { ETHEREUM_FUNCTIONS, ethereumAssetId } from '../shared/ethereum/protocol.ts';
import type { EthereumWallet } from '../src/ethereum/useEthereum111k.ts';

let { dom } = setupFrontendDom();
const { act, cleanup, fireEvent, render, renderHook, waitFor } = await import('@testing-library/react');
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
const { checkoutApi, CheckoutApiError } = await import('../src/checkout/api.ts');
const { useEthereumCheckout } = await import('../src/checkout/useEthereumCheckout.ts');
const { CheckoutPageContent } = await import('../src/checkout/CheckoutPageContent.tsx');
const { checkoutEntryRequestId, clearCheckoutEntryRequest } = await import('../src/checkout/entry.ts');
const { ethereumApi } = await import('../src/ethereum/api.ts');
const { ethereumInventoryScope, saveEthereumSession } = await import('../src/ethereum/state.ts');
const { checkoutReservesItems, observeCheckoutReservation, rememberCheckoutReservation } = await import('../src/ethereum/checkoutReservations.ts');
dom.window.close();

const checkoutId = '11111111-1111-4111-8111-111111111111';
const owner = '0x1111111111111111111111111111111111111111';
const otherOwner = '0x2222222222222222222222222222222222222222';
const config = resolveEthereum111kConfig({ contractAddress: '0x3333333333333333333333333333333333333333' });
const transactionHash = `0x${'ab'.repeat(32)}`;
const image = 'data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%2F%3E';
const clients: InstanceType<typeof QueryClient>[] = [];
const checkoutQueryKey = (id: string) => ['ethereumCheckout', id] as const;
let server: EthereumCheckoutStatusResponse;
let submissions: EthereumCheckoutSubmissionRequest[];
let sends: string[];

function snapshot(overrides: Partial<EthereumCheckoutStatusResponse> = {}): EthereumCheckoutStatusResponse {
  const value: EthereumCheckoutStatusResponse = {
    checkoutId, dropId: '111k_devnet', chainId: config.chainId, contractAddress: config.contractAddress!, config,
    tokenIds: ['111112'], items: [{ id: ethereumAssetId(config.chainId, config.contractAddress!, '111112'), chainId: config.chainId,
      contractAddress: config.contractAddress!, owner, tokenId: '111112', kind: 'crate', displayId: 1, name: 'Crate #1', image }],
    unavailableTokenIds: [], wallet: null, status: 'ready', orderId: null, transactionHash: null, confirmations: 0,
    requiredConfirmations: config.confirmationBlocks, quoteExpiresAtMs: null, attempt: null,
    ...overrides,
  };
  value.returnUrl = checkoutReturnUrl({ callbackUrl: 'https://vvv.so/callback', checkoutId,
    result: value.status === 'success' || value.status === 'failed' ? value.status :
      ['submitting', 'pending'].includes(value.status) ? 'pending' : 'canceled', chainId: config.chainId, transactionHash: value.transactionHash });
  return value;
}

function wallet(address: string | null = owner, send: () => Promise<string> = async () => transactionHash): EthereumWallet {
  return { address, status: address ? 'connected' : 'disconnected', ready: true, wallets: [], error: null,
    provider: address ? { request: async ({ method }) => {
      if (method === 'eth_sendTransaction') { sends.push('send'); return send(); }
      if (method === 'eth_chainId') return '0xaa36a7';
      return [address];
    } } : null,
    connect() {}, chooseWallet() {}, changeAccount() {}, checkAccount() {}, selectWallet() {}, cancel() {}, disconnect() {},
  };
}

function client() {
  const result = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  clients.push(result);
  return result;
}

function authenticate(address = owner) {
  saveEthereumSession(ethereumInventoryScope(config, address)!, { token: 'checkout-session', address, chainId: config.chainId,
    dropId: '111k_devnet', expiresAtMs: Date.now() + 60_000 });
}

function prepare() {
  const deadline = Math.floor(Date.now() / 1000) + 600;
  const receiptIdsHash = ethereumReceiptIdsHash(['2000001']);
  const signature = `0x${'ab'.repeat(65)}`;
  return { orderId: 42, expiresAtMs: deadline * 1000, signature,
    quote: { orderId: 42, wallet: owner, fee: config.deliveryFeeWei, deadline, receiptIdsHash },
    transaction: { to: config.contractAddress!, chainId: config.chainId, value: `0x${BigInt(config.deliveryFeeWei).toString(16)}`,
      data: encodeCall(ETHEREUM_FUNCTIONS.redeemForDelivery, ['uint256[]', '(uint256,address,uint256,uint256,bytes32)', 'bytes'],
        [['111112'], [42, owner, config.deliveryFeeWei, deadline, receiptIdsHash], signature]) },
  };
}

beforeEach(context => {
  const t = context as TestContext;
  ({ dom } = setupFrontendDom());
  window.history.replaceState(null, '', `/checkout/${checkoutId}`);
  Object.defineProperty(navigator, 'locks', { configurable: true, value: { request: async (_name: string, _options: unknown, run: (lock: object) => unknown) => run({}) } });
  server = snapshot(); submissions = []; sends = [];
  t.mock.method(checkoutApi, 'status', async () => server);
  t.mock.method(checkoutApi, 'refresh', async () => server);
  t.mock.method(ethereumApi, 'saveAddress', async body => ({ address: { ...body, id: 'aaaaaaaaaaaaaaaaaaaa' } }));
  t.mock.method(checkoutApi, 'prepare', async () => {
    const prepared = prepare();
    server = snapshot({ status: 'prepared', wallet: owner, orderId: 42, quoteExpiresAtMs: prepared.expiresAtMs });
    return prepared;
  });
  t.mock.method(checkoutApi, 'submission', async body => {
    submissions.push(body);
    if (body.action === 'start') {
      assert.equal(body.quoteDeadline, Math.floor(server.quoteExpiresAtMs! / 1000));
      server = snapshot({ ...server, status: 'submitting', attempt: { attemptId: body.attemptId, status: 'started', transactionHash: null } });
    } else if (body.action === 'report' || body.action === 'recover') {
      server = snapshot({ ...server, status: 'pending', transactionHash: body.transactionHash,
        attempt: { attemptId: body.attemptId, status: 'submitted', transactionHash: body.transactionHash } });
    } else {
      server = snapshot({ ...server, status: 'prepared', attempt: { attemptId: body.attemptId, status: 'rejected', transactionHash: null } });
    }
    return { checkout: server, canSend: body.action === 'start' };
  });
});
afterEach(() => { cleanup(); clients.splice(0).forEach(query => query.clear()); dom.window.close(); });

const address = { formatted: 'A Person\n123 Road\nIstanbul\nTürkiye', country: 'Türkiye', countryCode: 'TR', email: 'a@example.com' };

test('disconnected checkout previews selected items and never falls back to SOL shipping copy', async () => {
  const query = client();
  const view = render(createElement(QueryClientProvider, { client: query }, createElement(CheckoutPageContent, { checkoutId, search: '', wallet: wallet(null) })));
  await waitFor(() => assert.ok(view.getByRole('img', { name: 'Crate #1' })));
  assert.ok(view.getByRole('button', { name: 'Connect wallet' }));
  assert.equal((view.getByRole('button', { name: /Redeem for .* ETH/ }) as HTMLButtonElement).disabled, true);
  assert.match(view.container.textContent!, /No physical items will be shipped/);
  assert.doesNotMatch(view.container.textContent!, /SOL|Free US shipping/);
  assert.equal(submissions.length, 0);
});

for (const host of ['vvv.so', 'www.vvv.so']) {
  test(`checkout labels and preserves the return destination on ${host}`, async () => {
    server.returnUrl = checkoutReturnUrl({ callbackUrl: `https://${host}/111k-sepolia-test/floor`, checkoutId,
      result: 'canceled', state: 'caller-42', chainId: config.chainId });
    const view = render(createElement(QueryClientProvider, { client: client() },
      createElement(CheckoutPageContent, { checkoutId, search: '', wallet: wallet(null) })));
    const link = await view.findByRole('link', { name: 'Return to VVV' });
    assert.equal((link as HTMLAnchorElement).href, server.returnUrl);
  });
}

test('switching from a wrong wallet preserves the address draft and exact selected items', async () => {
  const query = client();
  const tree = (currentWallet: EthereumWallet) => createElement(QueryClientProvider, { client: query },
    createElement(CheckoutPageContent, { checkoutId, search: '', wallet: currentWallet }));
  const view = render(tree(wallet(otherOwner)));
  await waitFor(() => assert.ok(view.getByText(/This wallet holds 0 of 1/)));
  fireEvent.change(view.getByLabelText('Full name'), { target: { value: 'A Person' } });
  assert.equal((view.getByRole('button', { name: /Redeem for .* ETH/ }) as HTMLButtonElement).disabled, true);
  view.rerender(tree(wallet(owner)));
  await waitFor(() => assert.equal((view.getByRole('button', { name: /Redeem for .* ETH/ }) as HTMLButtonElement).disabled, false));
  assert.equal((view.getByLabelText('Full name') as HTMLInputElement).value, 'A Person');
  assert.ok(view.getByRole('img', { name: 'Crate #1' }));
  assert.equal(submissions.length, 0);
});

test('checkout records its submission before the wallet send and ignores duplicate submit clicks', async () => {
  authenticate();
  let finish!: (hash: string) => void;
  const sent = new Promise<string>(resolve => { finish = resolve; });
  const query = client();
  const currentWallet = wallet(owner, () => {
    assert.equal(submissions.at(-1)?.action, 'start');
    assert.equal(checkoutReservesItems(server.items), true);
    return sent;
  });
  const view = renderHook(() => useEthereumCheckout({ checkoutId, search: '' }, currentWallet), {
    wrapper: ({ children }) => createElement(QueryClientProvider, { client: query }, children),
  });
  await waitFor(() => assert.equal(view.result.current.checkout?.status, 'ready'));
  let submission!: Promise<void>;
  await act(async () => { submission = view.result.current.submit(address); void view.result.current.submit(address); });
  await waitFor(() => assert.equal(sends.length, 1));
  assert.equal(submissions.filter(value => value.action === 'start').length, 1);
  assert.equal(view.result.current.checkout?.status, 'submitting');
  await act(async () => { finish(transactionHash); await submission; });
  assert.equal(view.result.current.checkout?.status, 'pending');
  assert.equal(view.result.current.checkout?.transactionHash, transactionHash);
  assert.deepEqual(submissions.map(value => value.action), ['start', 'report']);
});

for (const failure of ['initial', 'final network check'] as const) test(`a reservation failure at ${failure} prevents wallet submission and permits retry after storage recovers`, async t => {
  authenticate();
  const prefix = 'mons.shop.ethereum-checkout-reservation:';
  const prototype = Object.getPrototypeOf(window.localStorage);
  const set = prototype.setItem;
  let failing = failure === 'initial';
  t.mock.method(prototype, 'setItem', function (this: Storage, key: string, value: string) {
    if (failing && key.startsWith(prefix)) throw new Error('Storage full');
    set.call(this, key, value);
  });
  const currentWallet = wallet();
  const request = currentWallet.provider!.request;
  let finalNetworkReads = 0;
  t.mock.method(currentWallet.provider!, 'request', async args => {
    if (failure === 'final network check' && args.method === 'eth_chainId' && server.status === 'submitting' && ++finalNetworkReads === 2) {
      for (const key of Object.keys(window.localStorage)) if (key.startsWith(prefix)) window.localStorage.removeItem(key);
      failing = true;
    }
    return request(args);
  });
  const query = client();
  const view = renderHook(() => useEthereumCheckout({ checkoutId, search: '' }, currentWallet), {
    wrapper: ({ children }) => createElement(QueryClientProvider, { client: query }, children),
  });
  await waitFor(() => assert.ok(view.result.current.checkout));
  await act(async () => { await view.result.current.submit(address); });
  assert.equal(sends.length, 0);
  assert.deepEqual(submissions.map(value => value.action), ['start', 'reject']);
  assert.match(view.result.current.error!, /Browser storage is unavailable/);
  assert.equal(view.result.current.uncertain, false);
  assert.equal(view.result.current.checkout?.status, 'prepared');
  failing = false;
  await act(async () => { await view.result.current.submit(); });
  assert.equal(sends.length, 1);
  assert.equal(view.result.current.checkout?.status, 'pending');
  assert.deepEqual(submissions.map(value => value.action), ['start', 'reject', 'start', 'report']);
  assert.ok(Object.keys(window.localStorage).some(key => key.startsWith(prefix)));
});

test('an ambiguous send error stays pending and cannot send again', async () => {
  authenticate();
  const query = client();
  const currentWallet = wallet(owner, async () => { throw new Error('Provider disconnected'); });
  const view = renderHook(() => useEthereumCheckout({ checkoutId, search: '' }, currentWallet), {
    wrapper: ({ children }) => createElement(QueryClientProvider, { client: query }, children),
  });
  await waitFor(() => assert.ok(view.result.current.checkout));
  await act(async () => { await view.result.current.submit(address); });
  assert.equal(view.result.current.checkout?.status, 'submitting');
  assert.match(view.result.current.error!, /may have been sent/);
  await act(async () => { query.setQueryData(checkoutQueryKey(checkoutId), snapshot({ status: 'prepared',
    attempt: { attemptId: '22222222-2222-4222-8222-222222222222', status: 'rejected', transactionHash: null } })); });
  assert.equal(view.result.current.checkout?.status, 'submitting');
  await act(async () => { await view.result.current.submit(address); });
  assert.equal(sends.length, 1);
  assert.deepEqual(submissions.map(value => value.action), ['start']);
});

test('a later rejection in another tab releases an older acknowledgement after a lost rejection response', async t => {
  authenticate();
  const submission = checkoutApi.submission;
  let readUnavailable = false;
  const read = async () => {
    if (readUnavailable) throw new Error('Temporary refresh outage');
    return server;
  };
  t.mock.method(checkoutApi, 'status', read);
  t.mock.method(checkoutApi, 'refresh', read);
  t.mock.method(checkoutApi, 'submission', async (body, session) => {
    const response = await submission(body, session);
    if (body.action === 'reject' && submissions.filter(row => row.action === 'reject').length === 1) {
      readUnavailable = true;
      throw new Error('Rejection committed, but its response was lost');
    }
    return response;
  });
  const rejectedWallet = () => wallet(owner, async () => { throw Object.assign(new Error('Rejected'), { code: 4001 }); });
  const query = client();
  const currentWallet = rejectedWallet();
  const view = renderHook(() => useEthereumCheckout({ checkoutId, search: '' }, currentWallet), {
    wrapper: ({ children }) => createElement(QueryClientProvider, { client: query }, children),
  });
  await waitFor(() => assert.ok(view.result.current.checkout));
  await act(async () => { await view.result.current.submit(address); });
  const firstAttempt = server.attempt!.attemptId;
  assert.equal(server.attempt?.status, 'rejected');
  assert.equal(view.result.current.checkout?.status, 'submitting');

  readUnavailable = false;
  const otherQuery = client();
  const otherWallet = rejectedWallet();
  const otherView = renderHook(() => useEthereumCheckout({ checkoutId, search: '' }, otherWallet), {
    wrapper: ({ children }) => createElement(QueryClientProvider, { client: otherQuery }, children),
  });
  await waitFor(() => assert.equal(otherView.result.current.checkout?.status, 'prepared'));
  await act(async () => { await otherView.result.current.submit(); });
  assert.equal(server.attempt?.status, 'rejected');
  assert.notEqual(server.attempt?.attemptId, firstAttempt);

  await act(async () => { await view.result.current.refresh(); });
  assert.equal(view.result.current.uncertain, false);
  assert.equal(view.result.current.checkout?.status, 'prepared');
  assert.equal(checkoutReservesItems(server.items), false);
  await act(async () => { await view.result.current.submit(); });
  assert.equal(submissions.filter(row => row.action === 'start').length, 3);
});

test('a rejection report that never commits keeps the server submission blocked', async t => {
  authenticate();
  const submission = checkoutApi.submission;
  t.mock.method(checkoutApi, 'submission', (body, session) => {
    if (body.action === 'reject') throw new Error('Rejection report was not delivered');
    return submission(body, session);
  });
  const query = client();
  const currentWallet = wallet(owner, async () => { throw Object.assign(new Error('Rejected'), { code: 4001 }); });
  const view = renderHook(() => useEthereumCheckout({ checkoutId, search: '' }, currentWallet), {
    wrapper: ({ children }) => createElement(QueryClientProvider, { client: query }, children),
  });
  await waitFor(() => assert.ok(view.result.current.checkout));
  await act(async () => { await view.result.current.submit(address); });
  await act(async () => { await view.result.current.refresh(); });
  assert.equal(server.attempt?.status, 'started');
  assert.equal(view.result.current.checkout?.status, 'submitting');
  assert.equal(checkoutReservesItems(server.items), true);
  await act(async () => { await view.result.current.submit(); });
  assert.equal(sends.length, 1);
  assert.deepEqual(submissions.map(value => value.action), ['start']);
});

test('an acknowledged submission cannot regress to ready when an older status read finishes', async () => {
  authenticate();
  let finish!: (hash: string) => void;
  const sent = new Promise<string>(resolve => { finish = resolve; });
  const query = client();
  const currentWallet = wallet(owner, () => sent);
  const view = renderHook(() => useEthereumCheckout({ checkoutId, search: '' }, currentWallet), {
    wrapper: ({ children }) => createElement(QueryClientProvider, { client: query }, children),
  });
  await waitFor(() => assert.ok(view.result.current.checkout));
  let submission!: Promise<void>;
  await act(async () => { submission = view.result.current.submit(address); });
  await waitFor(() => assert.equal(sends.length, 1));
  await act(async () => { query.setQueryData(checkoutQueryKey(checkoutId), snapshot()); });
  assert.equal(view.result.current.checkout?.status, 'submitting');
  assert.match(view.result.current.checkout!.returnUrl!, /result=pending/);
  await act(async () => { finish(transactionHash); await submission; });
  assert.equal(view.result.current.checkout?.status, 'pending');
});

test('an existing server submission never opens another wallet transaction', async t => {
  authenticate();
  const query = client();
  const currentWallet = wallet();
  t.mock.method(checkoutApi, 'submission', async body => {
    submissions.push(body);
    server = snapshot({ status: 'submitting', wallet: owner, orderId: 42,
      attempt: { attemptId: body.attemptId, status: 'started', transactionHash: null } });
    return { checkout: server, canSend: false };
  });
  const view = renderHook(() => useEthereumCheckout({ checkoutId, search: '' }, currentWallet), {
    wrapper: ({ children }) => createElement(QueryClientProvider, { client: query }, children),
  });
  await waitFor(() => assert.ok(view.result.current.checkout));
  await act(async () => { await view.result.current.submit(address); });
  assert.equal(sends.length, 0);
  assert.equal(view.result.current.checkout?.status, 'submitting');
});

test('an uncertain submission marker keeps a pending return link and does not claim cancellation', async t => {
  authenticate();
  t.mock.method(checkoutApi, 'submission', async () => { throw new Error('The connection timed out.'); });
  const query = client();
  const view = render(createElement(QueryClientProvider, { client: query }, createElement(CheckoutPageContent, { checkoutId, search: '', wallet: wallet() })));
  await waitFor(() => assert.ok(view.getByLabelText('Full name')));
  for (const [label, value] of [['Email', 'a@example.com'], ['Full name', 'A Person'], ['Address line 1', '123 Road'],
    ['City', 'New York'], ['State / Region', 'NY'], ['Postal code', '10001']]) {
    fireEvent.change(view.getByLabelText(label), { target: { value } });
  }
  fireEvent.submit(view.getByRole('button', { name: /Redeem for .* ETH/ }).closest('form')!);
  await waitFor(() => assert.match((view.getByRole('link', { name: 'Return to VVV' }) as HTMLAnchorElement).href, /result=pending/));
  assert.equal(sends.length, 0);
  await waitFor(() => assert.ok(view.getByRole('button', { name: 'Continue with saved address' })));
  assert.equal((view.getByRole('button', { name: 'Continue with saved address' }) as HTMLButtonElement).disabled, true);
});

for (const stage of ['prepare', 'submission'] as const) test(`a ${stage} token conflict offers the existing checkout and never opens the wallet or stays uncertain`, async t => {
  authenticate();
  const previous = '22222222-2222-4222-8222-222222222222';
  t.mock.method(checkoutApi, stage, async () => {
    throw new CheckoutApiError(409, 'These items already have a checkout in progress.', previous, 'failed-precondition');
  });
  const query = client();
  const view = render(createElement(QueryClientProvider, { client: query }, createElement(CheckoutPageContent, { checkoutId, search: '', wallet: wallet() })));
  await waitFor(() => assert.ok(view.getByLabelText('Full name')));
  for (const [label, value] of [['Email', 'a@example.com'], ['Full name', 'A Person'], ['Address line 1', '123 Road'],
    ['City', 'New York'], ['State / Region', 'NY'], ['Postal code', '10001']]) {
    fireEvent.change(view.getByLabelText(label), { target: { value } });
  }
  fireEvent.submit(view.getByRole('button', { name: /Redeem for .* ETH/ }).closest('form')!);
  await waitFor(() => assert.equal((view.getByRole('link', { name: 'Resume pending checkout' }) as HTMLAnchorElement).pathname, `/checkout/${previous}`));
  await waitFor(() => assert.equal((view.getByRole('button', {
    name: stage === 'prepare' ? /Redeem for .* ETH/ : 'Continue with saved address',
  }) as HTMLButtonElement).disabled, false));
  assert.match((view.getByRole('link', { name: 'Return to VVV' }) as HTMLAnchorElement).href, /result=canceled/);
  assert.equal(view.queryByText(/Checking whether your transaction was started/), null);
  assert.equal(submissions.length, 0);
  assert.equal(sends.length, 0);
});

test('switching wallets during address saving discards stale work before preparing or submitting', async t => {
  authenticate();
  let finish!: () => void;
  const saved = new Promise<void>(resolve => { finish = resolve; });
  let saving = false;
  t.mock.method(ethereumApi, 'saveAddress', async body => { saving = true; await saved; return { address: { ...body, id: 'aaaaaaaaaaaaaaaaaaaa' } }; });
  const prepared = t.mock.method(checkoutApi, 'prepare', async () => prepare());
  const query = client();
  const view = renderHook(({ currentWallet }) => useEthereumCheckout({ checkoutId, search: '' }, currentWallet), {
    initialProps: { currentWallet: wallet() },
    wrapper: ({ children }) => createElement(QueryClientProvider, { client: query }, children),
  });
  await waitFor(() => assert.ok(view.result.current.checkout));
  let submission!: Promise<void>;
  await act(async () => { submission = view.result.current.submit(address); });
  await waitFor(() => assert.equal(saving, true));
  view.rerender({ currentWallet: wallet(otherOwner) });
  await act(async () => { finish(); await submission; });
  assert.equal(prepared.mock.callCount(), 0);
  assert.equal(submissions.length, 0);
  assert.equal(sends.length, 0);
});

test('explicit wallet rejection releases its marker and resumes the saved address without saving again', async t => {
  authenticate();
  let attempts = 0;
  const saveAddress = t.mock.method(ethereumApi, 'saveAddress', async body => ({ address: { ...body, id: 'aaaaaaaaaaaaaaaaaaaa' } }));
  const currentWallet = wallet(owner, async () => {
    if (++attempts === 1) throw Object.assign(new Error('Rejected'), { code: 4001 });
    return transactionHash;
  });
  const query = client();
  const view = renderHook(() => useEthereumCheckout({ checkoutId, search: '' }, currentWallet), {
    wrapper: ({ children }) => createElement(QueryClientProvider, { client: query }, children),
  });
  await waitFor(() => assert.ok(view.result.current.checkout));
  await act(async () => { await view.result.current.submit(address); });
  assert.equal(view.result.current.checkout?.status, 'prepared');
  assert.match(view.result.current.error!, /cancelled/);
  await act(async () => { await view.result.current.submit(); });
  assert.equal(saveAddress.mock.callCount(), 1);
  assert.deepEqual(submissions.map(value => value.action), ['start', 'reject', 'start', 'report']);
});

test('a fresh rejected retry clears older reservations retained during storage failure', async t => {
  authenticate();
  const prefix = 'mons.shop.ethereum-checkout-reservation:';
  const prototype = Object.getPrototypeOf(window.localStorage);
  const set = prototype.setItem;
  let failing = false;
  t.mock.method(prototype, 'setItem', function (this: Storage, key: string, value: string) {
    if (failing && key.startsWith(prefix)) throw new Error('Storage full');
    set.call(this, key, value);
  });
  const submission = checkoutApi.submission;
  let firstAttempt: string | null = null;
  t.mock.method(checkoutApi, 'submission', async (body, session) => {
    if (body.action === 'reject' && firstAttempt === null) {
      firstAttempt = body.attemptId;
      failing = true;
      observeCheckoutReservation(checkoutId)(server);
    }
    return submission(body, session);
  });
  const read = async () => {
    if (server.attempt?.attemptId === firstAttempt && server.attempt?.status === 'rejected') throw new Error('Temporary refresh outage');
    return server;
  };
  t.mock.method(checkoutApi, 'status', read);
  t.mock.method(checkoutApi, 'refresh', read);
  const currentWallet = wallet(owner, async () => { throw Object.assign(new Error('Rejected'), { code: 4001 }); });
  const query = client();
  const view = renderHook(() => useEthereumCheckout({ checkoutId, search: '' }, currentWallet), {
    wrapper: ({ children }) => createElement(QueryClientProvider, { client: query }, children),
  });
  await waitFor(() => assert.ok(view.result.current.checkout));
  await act(async () => { await view.result.current.submit(address); });
  assert.ok(firstAttempt);
  assert.equal(view.result.current.checkout?.status, 'prepared');
  assert.equal(view.result.current.uncertain, false);
  assert.equal(checkoutReservesItems(server.items), true);
  await act(async () => { await view.result.current.submit(); });
  assert.equal(sends.length, 1);
  assert.deepEqual(submissions.map(value => value.action), ['start', 'reject', 'start', 'reject']);
  assert.equal(server.attempt?.status, 'rejected');
  assert.notEqual(server.attempt?.attemptId, firstAttempt);
  failing = false;
  await act(async () => {
    await view.result.current.refresh();
    await query.refetchQueries({ queryKey: ['ethereumCheckoutReservation', checkoutId] });
  });
  assert.equal(checkoutReservesItems(server.items), false);
  assert.equal(Object.keys(window.localStorage).some(key => key.startsWith(prefix)), false);
});

test('a quote that expires during the final wallet network check is rejected before invoking the wallet send', async t => {
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  authenticate();
  const currentWallet = wallet();
  const request = currentWallet.provider!.request;
  t.mock.method(currentWallet.provider!, 'request', async args => {
    const started = submissions.find(value => value.action === 'start');
    if (args.method === 'eth_chainId' && started?.action === 'start') now = started.quoteDeadline * 1000;
    return request(args);
  });
  const query = client();
  const view = renderHook(() => useEthereumCheckout({ checkoutId, search: '' }, currentWallet), {
    wrapper: ({ children }) => createElement(QueryClientProvider, { client: query }, children),
  });
  await waitFor(() => assert.ok(view.result.current.checkout));
  await act(async () => { await view.result.current.submit(address); });
  assert.equal(sends.length, 0);
  assert.deepEqual(submissions.map(value => value.action), ['start', 'reject']);
  assert.equal(checkoutReservesItems(server.items), false);
  assert.equal(view.result.current.checkout?.status, 'prepared');
  assert.equal(view.result.current.uncertain, false);
});

test('a pending checkout can refresh to success without a connected wallet or another signature', async () => {
  server = snapshot({ status: 'pending', wallet: owner, transactionHash, orderId: 42 });
  assert.equal(checkoutReservesItems(server.items), false);
  const query = client();
  const view = render(createElement(QueryClientProvider, { client: query }, createElement(CheckoutPageContent, { checkoutId, search: '', wallet: wallet(null) })));
  await waitFor(() => assert.ok(view.getByText('Delivery pending')));
  await waitFor(() => assert.equal(checkoutReservesItems(server.items), true));
  assert.match((view.getByRole('link', { name: 'Return to VVV' }) as HTMLAnchorElement).href, /result=pending/);
  server = snapshot({ ...server, status: 'success', confirmations: 3 });
  fireEvent.click(view.getByRole('button', { name: 'Refresh status' }));
  await waitFor(() => assert.ok(view.getByText('Redemption confirmed')));
  await waitFor(() => assert.equal(checkoutReservesItems(server.items), false));
  assert.match((view.getByRole('link', { name: 'Return to VVV' }) as HTMLAnchorElement).href, /result=success/);
  assert.equal(submissions.length, 0);
});

test('a restored active checkout uses server refresh to advance status without wallet authentication', async t => {
  server = snapshot({ status: 'pending', wallet: owner, transactionHash, orderId: 42 });
  const refreshed = t.mock.method(checkoutApi, 'refresh', async () => snapshot({ ...server, status: 'success', confirmations: 3 }));
  const query = client();
  query.setQueryData(checkoutQueryKey(checkoutId), server);
  const currentWallet = wallet(null);
  const view = renderHook(() => useEthereumCheckout({ checkoutId, search: '' }, currentWallet), {
    wrapper: ({ children }) => createElement(QueryClientProvider, { client: query }, children),
  });
  await waitFor(() => assert.equal(view.result.current.checkout?.status, 'success'));
  assert.ok(refreshed.mock.callCount() > 0);
  assert.equal(submissions.length, 0);
});

test('cached checkout failure does not clear a restored reservation before a fresh response', async t => {
  const attemptId = '22222222-2222-4222-8222-222222222222';
  const pending = snapshot({ status: 'pending', wallet: owner, transactionHash, orderId: 42,
    attempt: { attemptId, status: 'submitted', transactionHash } });
  let resolve!: (value: EthereumCheckoutStatusResponse) => void;
  const response = new Promise<EthereumCheckoutStatusResponse>(done => { resolve = done; });
  t.mock.method(checkoutApi, 'status', () => response);
  rememberCheckoutReservation(pending);
  const query = client();
  query.setQueryData(checkoutQueryKey(checkoutId), snapshot({ ...pending, status: 'failed' }));
  const currentWallet = wallet(null);
  const view = renderHook(() => useEthereumCheckout({ checkoutId, search: '' }, currentWallet), {
    wrapper: ({ children }) => createElement(QueryClientProvider, { client: query }, children),
  });
  assert.equal(checkoutReservesItems(pending.items), true);
  await act(async () => { resolve(pending); });
  await waitFor(() => assert.equal(view.result.current.checkout?.status, 'pending'));
  assert.equal(checkoutReservesItems(pending.items), true);
  server = snapshot({ ...pending, status: 'failed' });
  await act(async () => { await view.result.current.refresh(); });
  assert.equal(checkoutReservesItems(pending.items), false);
});

test('the checkout shows the actual wrong network and switching it retains entered shipping fields', async () => {
  let chainId = '0x1';
  const currentWallet = wallet();
  currentWallet.provider = { request: async ({ method }) => {
    if (method === 'eth_chainId') return chainId;
    if (method === 'wallet_switchEthereumChain') { chainId = '0xaa36a7'; return null; }
    return [owner];
  } };
  const query = client();
  const view = render(createElement(QueryClientProvider, { client: query }, createElement(CheckoutPageContent, { checkoutId, search: '', wallet: currentWallet })));
  await waitFor(() => assert.ok(view.getByText(/Chain 1/)));
  fireEvent.change(view.getByLabelText('Full name'), { target: { value: 'A Person' } });
  fireEvent.click(view.getByRole('button', { name: 'Switch network' }));
  await waitFor(() => assert.ok(!view.queryByRole('button', { name: 'Switch network' })));
  assert.equal((view.getByLabelText('Full name') as HTMLInputElement).value, 'A Person');
  assert.equal(submissions.length, 0);
});

test('unmounting during wallet approval still reports the returned hash to the durable checkout', async () => {
  authenticate();
  let finish!: (hash: string) => void;
  const sent = new Promise<string>(resolve => { finish = resolve; });
  const query = client();
  const currentWallet = wallet(owner, () => sent);
  const view = renderHook(() => useEthereumCheckout({ checkoutId, search: '' }, currentWallet), {
    wrapper: ({ children }) => createElement(QueryClientProvider, { client: query }, children),
  });
  await waitFor(() => assert.ok(view.result.current.checkout));
  let submission!: Promise<void>;
  await act(async () => { submission = view.result.current.submit(address); });
  await waitFor(() => assert.equal(sends.length, 1));
  view.unmount();
  finish(transactionHash);
  await submission;
  assert.equal(submissions.at(-1)?.action, 'report');
  assert.equal(query.getQueryData<EthereumCheckoutStatusResponse>(checkoutQueryKey(checkoutId))?.transactionHash, transactionHash);
});

test('checkout response validation rejects hostile return destinations and mismatched transaction results', async t => {
  const valid = snapshot();
  let response = valid;
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify(response), { status: 200 }));
  const create = () => checkoutApi.create({ requestId: checkoutId, dropId: '111k_devnet', tokenIds: ['111112'] });
  assert.equal((await create()).checkoutId, checkoutId);
  for (const invalid of [
    { ...valid, returnUrl: valid.returnUrl!.replace('vvv.so', 'evil.example') },
    { ...valid, returnUrl: `${valid.returnUrl}&extra=1` },
    { ...valid, returnUrl: valid.returnUrl!.replace('result=canceled', 'result=success') },
    { ...valid, tokenIds: ['111112', '111112'] },
    { ...valid, items: [{ ...valid.items[0], tokenId: '1' }] },
  ]) {
    response = invalid;
    await assert.rejects(create);
  }
});

test('entry retries reuse an opaque session request ID until canonical checkout navigation', () => {
  const entry = { dropId: '111k_devnet' as const, tokenIds: ['111112'], callbackUrl: 'https://vvv.so/callback' };
  const first = checkoutEntryRequestId(entry);
  assert.equal(checkoutEntryRequestId({ ...entry }), first);
  assert.ok([...Array(window.sessionStorage.length)].every((_, index) => !window.sessionStorage.key(index)?.includes('vvv.so')));
  clearCheckoutEntryRequest(entry);
  assert.notEqual(checkoutEntryRequestId(entry), first);
  clearCheckoutEntryRequest(entry);
});
