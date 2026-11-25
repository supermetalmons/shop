import assert from 'node:assert/strict';
import test, { after, afterEach, beforeEach, mock, type TestContext } from 'node:test';
import { createElement } from 'react';
import { encodeTarotClaim, resolveTarotConfig, tarotReceiptTokenId, type TarotConfirmRequest, type TarotConfirmResponse, type TarotPrepareResponse, type TarotRequest, type TarotStatus } from '../shared/ethereum/tarot.ts';
import type { EthereumWallet } from '../src/ethereum/useEthereum111k.ts';
import type { EthereumProviderListener } from '../src/wallet/injectedEthereumProviders.ts';
import { setupFrontendDom } from './helpers/frontendDom.ts';

let { dom, setMediaQueryMatches } = setupFrontendDom();
const { act, cleanup, fireEvent, render, waitFor, within } = await import('@testing-library/react');
const { WalletModalContext } = await import('@solana/wallet-adapter-react-ui');
const { NfcPage } = await import('../src/components/NfcPage.tsx');
const { resolveNfcLink } = await import('../src/ethereum/tarotLink.ts');
const { tarotApi, TarotApiError } = await import('../src/ethereum/tarotApi.ts');
const { useAppRoute } = await import('../src/hooks/useAppRoute.ts');
const { useTarotClaim } = await import('../src/ethereum/useTarotClaim.ts');
const { renderHook } = await import('@testing-library/react');
const code = '00000000-0000-4000-8000-000000000001';
const owner = '0x1111111111111111111111111111111111111111';
const contract = '0x2222222222222222222222222222222222222222';
const transactionHash = `0x${'a'.repeat(64)}`;
const receiptBlockHash = `0x${'d'.repeat(64)}`;
const config = resolveTarotConfig({ contractAddress: contract, enabled: true, deploymentBlock: 1 });
const request: TarotRequest = { code, tokenId: 1, testnet: true };
const search = (tokenId = 1) => `?code=${code}&tokenId=${tokenId}&testnet=true`;
const status = (tokenId = 1, claimed = false): TarotStatus => ({
  config, tokenId, receiptTokenId: tarotReceiptTokenId(tokenId), claimed, observedBlock: 5,
  observedTimestamp: Math.floor(Date.now() / 1000), blockHash: `0x${'b'.repeat(64)}`,
});
function prepared(tokenId = 1): TarotPrepareResponse {
  const deadline = Math.floor(Date.now() / 1000) + 600;
  const signature = `0x${'c'.repeat(130)}`;
  return { tokenId, receiptTokenId: tarotReceiptTokenId(tokenId), wallet: owner, deadline, expiresAtMs: deadline * 1000, signature,
    transaction: { to: contract, chainId: config.chainId, value: '0x0', data: encodeTarotClaim(tokenId, deadline, signature) } };
}
function confirmed(tokenId = 1, blockNumber = 6): TarotConfirmResponse {
  return { status: 'confirmed', transactionHash, confirmations: 3, tokenId, receiptTokenId: tarotReceiptTokenId(tokenId),
    blockNumber, blockHash: receiptBlockHash };
}
function wallet(connected = false): EthereumWallet {
  return {
    address: connected ? owner : null, status: connected ? 'connected' : 'disconnected', ready: true, wallets: [], error: null,
    provider: connected ? { request: mock.fn(async ({ method }) => {
      if (method === 'eth_accounts') return [owner];
      if (method === 'eth_chainId') return '0xaa36a7';
      if (method === 'eth_sendTransaction') return transactionHash;
      assert.fail(`Unexpected wallet method ${method}`);
    }) } : null,
    connect: mock.fn(), chooseWallet: mock.fn(), changeAccount: mock.fn(), checkAccount: mock.fn(), selectWallet: mock.fn(),
    cancel: mock.fn(), disconnect: mock.fn(),
  };
}
function page(linkSearch: string, value = wallet(), presentation: { headerWalletOpen?: boolean; walletModalVisible?: boolean } = {}) {
  return createElement(WalletModalContext.Provider, { value: { visible: presentation.walletModalVisible ?? false, setVisible: () => {} } },
    createElement(NfcPage, { link: resolveNfcLink(linkSearch), wallet: value,
      headerWalletOpen: presentation.headerWalletOpen,
      header: createElement('header', null, createElement('button', null, 'Shop header')) }));
}
function RoutedCard({ value }: { value: EthereumWallet }) {
  const { nfcLink } = useAppRoute();
  assert.ok(nfcLink);
  return createElement(WalletModalContext.Provider, { value: { visible: false, setVisible: () => {} } },
    createElement(NfcPage, { link: nfcLink, wallet: value }));
}
function snapshotTab() {
  return { local: Object.entries(window.localStorage), session: Object.entries(window.sessionStorage), state: window.history.state };
}
function openTab(href: string, { local = [], session = [], state = null }: Partial<ReturnType<typeof snapshotTab>> = {}) {
  dom.window.close();
  ({ dom, setMediaQueryMatches } = setupFrontendDom());
  for (const [key, value] of local) window.localStorage.setItem(key, value);
  for (const [key, value] of session) window.sessionStorage.setItem(key, value);
  window.history.replaceState(state, '', href);
  setMediaQueryMatches('(prefers-reduced-motion: reduce)', true);
}
function cardLayers(root: ParentNode) {
  return Array.from(root.querySelectorAll<HTMLImageElement>('img[src*="/tarot/layers/"]'));
}
function assertArtworkPage(view: ReturnType<typeof render>) {
  const main = view.getByRole('main', { name: 'Tarot card' });
  const card = within(main);
  assert.equal(main.classList.contains('nfc-claim-page--artwork'), true);
  assert.equal(card.getAllByRole('img').length, 1);
  assert.equal(cardLayers(main).length, 0);
  assert.equal(card.queryByRole('button'), null);
  assert.equal(card.queryByRole('heading'), null);
  assert.equal(card.queryByRole('alert'), null);
  assert.ok(view.getByRole('banner'));
  assert.ok(view.getByRole('button', { name: 'Shop header' }));
  assert.equal(card.queryByRole('img', { name: 'NFC Card Receipt' }), null);
  return card;
}
function mockService(claimed = false) {
  const statusMock = mock.method(tarotApi, 'status', async (input: TarotRequest) => status(input.tokenId, claimed));
  const prepareMock = mock.method(tarotApi, 'prepare', async (input: TarotRequest) => prepared(input.tokenId));
  const confirm = mock.method(tarotApi, 'confirm', async (input: TarotConfirmRequest) => confirmed(input.tokenId));
  return { status: statusMock, prepare: prepareMock, confirm };
}

function pendingClaimFixture(t: TestContext, method = 'eth_sendTransaction') {
  const now = 2_000_000_000;
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: now * 1000 });
  const value = wallet(true);
  const provider = value.provider!;
  const originalRequest = provider.request;
  const waits: PromiseWithResolvers<unknown>[] = [];
  const listeners = new Map<string, Set<EthereumProviderListener>>();
  provider.on = (event, listener) => {
    if (!listeners.has(event)) listeners.set(event, new Set());
    listeners.get(event)!.add(listener);
  };
  provider.removeListener = (event, listener) => listeners.get(event)?.delete(listener);
  mock.method(provider, 'request', async (input: Parameters<typeof originalRequest>[0]) => {
    if (input.method !== method) return originalRequest(input);
    const wait = Promise.withResolvers<unknown>();
    waits.push(wait);
    return wait.promise;
  });
  let snapshot = { ...status(), observedBlock: 100, observedTimestamp: now - 24 };
  mock.method(tarotApi, 'status', async () => snapshot);
  const prepare = mock.method(tarotApi, 'prepare', async () => prepared());
  const confirm = mock.method(tarotApi, 'confirm', async (input: TarotConfirmRequest): Promise<TarotConfirmResponse> => ({
    status: 'pending', tokenId: 1, receiptTokenId: tarotReceiptTokenId(1), transactionHash: input.transactionHash,
    confirmations: 0, blockNumber: null, blockHash: null,
  }));
  const mount = (input = value) => renderHook(({ wallet: current }) => useTarotClaim(request, current), { initialProps: { wallet: input } });
  const focus = () => act(async () => window.dispatchEvent(new dom.window.Event('focus')));
  return {
    now, value, waits, prepare, confirm, mount, focus,
    key: `mons.shop.tarot.pending:${config.chainId}:${contract}:1`,
    emit(event: string, ...args: unknown[]) { for (const listener of listeners.get(event) ?? []) listener(...args); },
    setSnapshot(next: Partial<TarotStatus>) { snapshot = { ...snapshot, ...next }; },
    async begin() {
      const view = mount();
      await act(async () => undefined);
      assert.ok(view.result.current.status);
      await act(async () => view.result.current.claim());
      assert.equal(waits.length, 1);
      return view;
    },
    async expire() {
      t.mock.timers.setTime((now + 720) * 1000);
      snapshot = { ...snapshot, observedBlock: 160, observedTimestamp: now + 696, blockHash: `0x${'e'.repeat(64)}` };
      await focus();
    },
  };
}
beforeEach(() => { dom.window.close(); ({ dom, setMediaQueryMatches } = setupFrontendDom()); });
afterEach(() => { cleanup(); mock.restoreAll(); window.sessionStorage.clear(); window.localStorage.clear(); });
after(() => dom.window.close());

test('Tarot routing separates public artwork IDs from valid testnet claim credentials', () => {
  assert.equal(resolveNfcLink('?code=basel').kind, 'placeholder');
  for (const tokenId of [1, 777]) {
    const link = resolveNfcLink(search(tokenId));
    assert.equal(link.kind, 'tarot');
    if (link.kind === 'tarot') assert.deepEqual(link.request, { ...request, tokenId });
  }
  for (const query of ['', '?code=basel&testnet=true',
    ...['0', '778', '1.5', '01', '-1', '1e2', 'NaN'].map(id => `?code=${code}&tokenId=${id}&testnet=true`),
    `${search()}&tokenId=1`]) {
    assert.equal(resolveNfcLink(query).kind, 'invalid', query);
  }
  for (const query of ['?tokenId=1', '?tokenId=777', '?code=basel&tokenId=1',
    `?code=${code}&tokenId=1`, `?code=${code}&tokenId=1&testnet=false`, `?code=${code}&tokenId=1&testnet=TRUE`,
    `?code=guess&tokenId=1&testnet=true`, `${search()}&code=${code}`, `${search()}&testnet=true`]) {
    assert.equal(resolveNfcLink(query).kind, 'artwork', query);
  }
});

test('NFC identity changes with token ID and testnet, while unrelated parameters preserve it', () => {
  window.history.replaceState(null, '', `/nfc${search()}`);
  const view = renderHook(useAppRoute);
  const first = view.result.current;
  act(() => { window.history.replaceState(null, '', `/nfc${search(777)}`); window.dispatchEvent(new dom.window.PopStateEvent('popstate')); });
  assert.notEqual(view.result.current, first);
  const second = view.result.current;
  act(() => { window.history.replaceState(null, '', `/nfc${search(777)}&from=wallet`); window.dispatchEvent(new dom.window.PopStateEvent('popstate')); });
  assert.equal(view.result.current, second);
  const newCode = crypto.randomUUID();
  act(() => {
    window.history.replaceState(null, '', `/nfc${search(777).replace(code, newCode.toUpperCase())}`);
    window.dispatchEvent(new dom.window.PopStateEvent('popstate'));
  });
  const rescanned = view.result.current.nfcLink;
  assert.ok(rescanned?.kind === 'tarot');
  assert.deepEqual(rescanned.request, { code: newCode, tokenId: 777, testnet: true });
  act(() => window.dispatchEvent(new dom.window.PageTransitionEvent('pageshow', { persisted: true })));
  assert.equal(view.result.current.nfcLink, rescanned);
  act(() => {
    window.history.replaceState(null, '', '/nfc?tokenId=1&testnet=true');
    window.dispatchEvent(new dom.window.PopStateEvent('popstate'));
  });
  const original = view.result.current.nfcLink;
  assert.ok(original?.kind === 'tarot');
  assert.deepEqual(original.request, request);
  act(() => { window.history.replaceState(null, '', `/nfc${search(777).replace('true', 'false')}`); window.dispatchEvent(new dom.window.PopStateEvent('popstate')); });
  assert.equal(view.result.current.nfcLink?.kind, 'artwork');
});

test('a scanned card can be claimed after reloading its shareable URL, while a recipient sees only artwork', async () => {
  const service = mockService();
  const value = wallet(true);
  window.history.replaceState({ retained: true }, '', `/nfc/${search()}&from=tag&from=card#receipt`);
  const historyLength = window.history.length;
  const scanned = render(createElement(RoutedCard, { value }), { reactStrictMode: true });
  const shareUrl = window.location.href;
  assert.equal(shareUrl, 'https://mons.shop/nfc/?tokenId=1&testnet=true&from=tag&from=card#receipt');
  assert.equal(window.history.length, historyLength);
  assert.deepEqual(window.history.state, { retained: true });
  await scanned.findByRole('button', { name: 'Claim' });
  scanned.unmount();

  openTab(shareUrl, snapshotTab());
  const reloaded = render(createElement(RoutedCard, { value }));
  const claim = await reloaded.findByRole('button', { name: 'Claim' });
  await act(async () => fireEvent.click(claim));
  assert.equal(service.prepare.mock.callCount(), 1);
  assert.deepEqual(service.prepare.mock.calls[0].arguments[0], { ...request, wallet: owner });
  reloaded.unmount();

  openTab(shareUrl);
  const previousRequests = service.status.mock.callCount();
  const recipient = render(createElement(RoutedCard, { value }));
  const artwork = within(recipient.getByRole('main', { name: 'Tarot card' }));
  assert.equal(artwork.getByRole('img').getAttribute('src'), 'https://wip.lil.org/tarot/heros/1.webp');
  assert.equal(artwork.queryByRole('button', { name: 'Claim' }), null);
  assert.equal(service.status.mock.callCount(), previousRequests);
});

test('browser history restores only an unambiguous matching card and ignores malformed scans', () => {
  window.history.replaceState(null, '', `/nfc${search()}`);
  const view = renderHook(useAppRoute);
  const visit = (query: string) => {
    act(() => {
      window.history.replaceState(null, '', `/nfc${query}`);
      window.dispatchEvent(new dom.window.PopStateEvent('popstate'));
    });
    return view.result.current.nfcLink;
  };
  for (const query of ['?tokenId=2&testnet=true', '?tokenId=1', '?tokenId=1&testnet=false',
    '?tokenId=1&testnet=true&testnet=true', '?tokenId=1&testnet=true&code=',
    '?tokenId=1&testnet=true&code=wrong', `${search()}&%63ode=${code}`]) {
    assert.equal(visit(query)?.kind, 'artwork');
    assert.equal(new URLSearchParams(window.location.search).has('code'), false);
    act(() => window.dispatchEvent(new dom.window.PageTransitionEvent('pageshow', { persisted: true })));
    assert.equal(view.result.current.nfcLink?.kind, 'artwork');
  }
  assert.equal(visit(`${search()}&tokenId=2`)?.kind, 'invalid');
  assert.equal(new URLSearchParams(window.location.search).has('code'), false);
  const link = visit('?tokenId=1&testnet=true');
  assert.ok(link?.kind === 'tarot');
  assert.deepEqual(link.request, request);
  assert.equal(visit('?code=basel')?.kind, 'placeholder');
  assert.equal(window.location.search, '?code=basel');
});

for (const outcome of ['accepted', 'rejected', 'accepted with session storage blocked'] as const) test(`same-card rescan across reloads: ${outcome}`, async t => {
  const accepted = outcome !== 'rejected';
  const replacement = crypto.randomUUID();
  const validating = Promise.withResolvers<TarotStatus>();
  const service = mock.method(tarotApi, 'status', async ({ code: supplied }: TarotRequest) =>
    supplied === replacement ? validating.promise : status());
  const value = wallet();
  window.history.replaceState(null, '', `/nfc${search()}`);
  const scanned = render(createElement(RoutedCard, { value }));
  await scanned.findByRole('button', { name: 'Claim' });
  const cleanHref = window.location.href;
  const blocked = outcome === 'accepted with session storage blocked'
    ? t.mock.getter(window, 'sessionStorage', () => { throw new DOMException('Storage unavailable', 'SecurityError'); })
    : null;
  act(() => {
    window.history.pushState(null, '', `${cleanHref}&code=${replacement}`);
    window.dispatchEvent(new dom.window.PopStateEvent('popstate'));
  });
  blocked?.mock.restore();
  assert.equal(window.location.href, cleanHref);
  assert.equal(service.mock.calls.at(-1)?.arguments[0].code, replacement);
  assert.equal(JSON.stringify(window.history.state).includes(replacement), false);
  const rescanningTab = snapshotTab();
  scanned.unmount();

  openTab(cleanHref, { local: rescanningTab.local });
  const separate = render(createElement(RoutedCard, { value }));
  assert.equal(service.mock.calls.at(-1)?.arguments[0].code, code);
  await separate.findByRole('button', { name: 'Claim' });
  separate.unmount();

  openTab(cleanHref, rescanningTab);
  const reloaded = render(createElement(RoutedCard, { value }));
  assert.equal(service.mock.calls.at(-1)?.arguments[0].code, replacement);
  await act(async () => {
    if (accepted) validating.resolve(status());
    else validating.reject(new TarotApiError('Invalid Tarot claim link', 401, null, true));
  });
  await act(async () => { window.dispatchEvent(new dom.window.PageTransitionEvent('pageshow', { persisted: true })); });
  if (accepted) await reloaded.findByRole('button', { name: 'Claim' });
  else {
    assert.equal(service.mock.calls.at(-1)?.arguments[0].code, replacement);
    assert.ok(reloaded.getByRole('main', { name: 'Tarot card' }));
    assert.equal(reloaded.queryByRole('button', { name: 'Claim' }), null);
  }
  reloaded.unmount();

  openTab(cleanHref, snapshotTab());
  const reopened = render(createElement(RoutedCard, { value }));
  assert.equal(service.mock.calls.at(-1)?.arguments[0].code, accepted ? replacement : code);
  await reopened.findByRole('button', { name: 'Claim' });
});

test('interrupted rescans do not accumulate local credentials and each history entry can resume', t => {
  const primary = 'mons.shop.tarot.claim:sepolia:1';
  window.localStorage.setItem(primary, code);
  const blocked = t.mock.getter(window, 'sessionStorage', () => { throw new DOMException('Blocked', 'SecurityError'); });
  const entries = Array.from({ length: 3 }, () => {
    const replacement = crypto.randomUUID();
    window.history.pushState(null, '', `/nfc${search().replace(code, replacement)}`);
    const view = renderHook(useAppRoute);
    view.unmount();
    return { replacement, state: window.history.state };
  });
  blocked.mock.restore();
  const local = Object.entries(window.localStorage);
  assert.equal(local.length, 2);
  const href = window.location.href;
  for (const { replacement, state } of entries) {
    assert.equal(JSON.stringify([state, local]).includes(replacement), false);
    openTab(href, { local, state });
    const view = renderHook(useAppRoute);
    const link = view.result.current.nfcLink;
    assert.ok(link?.kind === 'tarot');
    assert.equal(link.request.code, replacement);
    view.unmount();
  }
});

function blockLocalWrites(t: TestContext) {
  const local = window.localStorage;
  const prototype: Storage = Object.getPrototypeOf(local);
  const setItem = prototype.setItem;
  t.mock.method(prototype, 'setItem', function (this: Storage, key: string, value: string) {
    if (this === local) throw new DOMException('Local storage full', 'QuotaExceededError');
    setItem.call(this, key, value);
  });
}

test('a first scan survives reload in the same tab when local storage is full', t => {
  blockLocalWrites(t);
  window.history.replaceState(null, '', `/nfc${search()}`);
  const scan = renderHook(useAppRoute);
  assert.equal(scan.result.current.nfcLink?.kind, 'tarot');
  assert.equal(window.location.search, '?tokenId=1&testnet=true');
  scan.unmount();

  openTab(window.location.href, snapshotTab());
  const restored = renderHook(useAppRoute).result.current.nfcLink;
  assert.ok(restored?.kind === 'tarot');
  assert.deepEqual(restored.request, request);
  act(() => {
    window.history.replaceState(null, '', `/nfc${search()}`);
    window.dispatchEvent(new dom.window.PopStateEvent('popstate'));
  });
  assert.equal(window.localStorage.getItem('mons.shop.tarot.claim:sepolia:1'), code);
});

test('reopening the clean URL in the same tab uses the verified replacement when local writes failed', async t => {
  window.localStorage.setItem('mons.shop.tarot.claim:sepolia:1', code);
  blockLocalWrites(t);
  const replacement = crypto.randomUUID();
  window.history.replaceState(null, '', `/nfc${search().replace(code, replacement)}`);
  mockService();
  const scan = render(createElement(RoutedCard, { value: wallet() }));
  await scan.findByRole('button', { name: 'Claim' });
  scan.unmount();
  openTab(window.location.href, { ...snapshotTab(), state: null });
  const view = renderHook(useAppRoute);
  const restored = view.result.current.nfcLink;
  assert.ok(restored?.kind === 'tarot');
  assert.equal(restored.request.code, replacement);
  window.localStorage.removeItem('mons.shop.tarot.claim:sepolia:1');
  act(() => window.dispatchEvent(new dom.window.PageTransitionEvent('pageshow', { persisted: true })));
  const retained = view.result.current.nfcLink;
  assert.ok(retained?.kind === 'tarot');
  assert.equal(retained.request.code, replacement);
  const newer = crypto.randomUUID();
  window.localStorage.setItem('mons.shop.tarot.claim:sepolia:1', newer);
  act(() => window.dispatchEvent(new dom.window.PageTransitionEvent('pageshow', { persisted: true })));
  const updated = view.result.current.nfcLink;
  assert.ok(updated?.kind === 'tarot');
  assert.equal(updated.request.code, newer);
});

for (const accepted of [true, false]) test(`a conflicting rescan revalidates before ${accepted ? 'promotion' : 'rejection'}`, async () => {
  const primary = 'mons.shop.tarot.claim:sepolia:1';
  window.localStorage.setItem(primary, code);
  const candidate = crypto.randomUUID();
  const newer = crypto.randomUUID();
  const first = Promise.withResolvers<TarotStatus>();
  const second = Promise.withResolvers<TarotStatus>();
  const service = mock.method(tarotApi, 'status', (_request: TarotRequest) => first.promise);
  window.history.replaceState(null, '', `/nfc${search().replace(code, candidate)}`);
  render(createElement(RoutedCard, { value: wallet() }));
  assert.equal(service.mock.calls[0].arguments[0].code, candidate);
  window.localStorage.setItem(primary, newer);
  service.mock.mockImplementation(() => second.promise);
  await act(async () => first.resolve(status()));
  assert.equal(window.localStorage.getItem(primary), newer);
  await act(async () => { window.dispatchEvent(new dom.window.Event('focus')); });
  assert.equal(service.mock.callCount(), 2);
  assert.equal(service.mock.calls[1].arguments[0].code, candidate);
  await act(async () => {
    if (accepted) second.resolve(status());
    else second.reject(new TarotApiError('Revoked', 401, null, true));
  });
  assert.equal(window.localStorage.getItem(primary), accepted ? candidate : newer);
});

test('repeated concurrent credential changes retry after the bounded validation attempt', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 2_000_000_000_000 });
  const primary = 'mons.shop.tarot.claim:sepolia:1';
  window.localStorage.setItem(primary, crypto.randomUUID());
  window.history.replaceState(null, '', `/nfc${search()}`);
  const route = renderHook(useAppRoute).result.current.nfcLink;
  assert.ok(route?.kind === 'tarot');
  let calls = 0;
  mock.method(tarotApi, 'status', async () => {
    if (++calls <= 2) window.localStorage.setItem(primary, crypto.randomUUID());
    return status();
  });
  const claim = renderHook(() => useTarotClaim(route.request, wallet()));
  await act(async () => undefined);
  assert.equal(calls, 2);
  assert.equal(claim.result.current.status, null);
  assert.notEqual(window.localStorage.getItem(primary), code);
  await act(async () => t.mock.timers.tick(2_000));
  assert.equal(calls, 3);
  assert.ok(claim.result.current.status);
  assert.equal(window.localStorage.getItem(primary), code);
});

for (const changed of [false, true]) test(`a revalidated scan ${changed ? 'preserves a newer code' : 'restores the original code'} for reload`, async () => {
  let allowed = true;
  mock.method(tarotApi, 'status', async () => {
    if (!allowed) throw new TarotApiError('Revoked', 401, null, true);
    return status();
  });
  window.history.replaceState(null, '', `/nfc${search()}`);
  const scan = render(createElement(RoutedCard, { value: wallet() }));
  await scan.findByRole('button', { name: 'Claim' });
  allowed = false;
  await act(async () => { window.dispatchEvent(new dom.window.Event('focus')); });
  assert.equal(scan.queryByRole('button', { name: 'Claim' }), null);
  const newer = crypto.randomUUID();
  if (changed) window.localStorage.setItem('mons.shop.tarot.claim:sepolia:1', newer);
  allowed = true;
  await act(async () => { window.dispatchEvent(new dom.window.Event('focus')); });
  await scan.findByRole('button', { name: 'Claim' });
  scan.unmount();
  openTab(window.location.href, snapshotTab());
  const restored = renderHook(useAppRoute).result.current.nfcLink;
  assert.ok(restored?.kind === 'tarot');
  assert.equal(restored.request.code, changed ? newer : code);
});

for (const [response, apiCode, replaced] of [
  [401, 'unauthenticated', false], [401, 'unauthenticated', true], [401, undefined, false],
  [403, 'permission-denied', false], [503, 'unavailable', false],
] as const) {
  const cleared = response === 401 && apiCode === 'unauthenticated' && !replaced;
  test(`status ${response} ${cleared ? 'clears the rejected' : 'preserves the'} ${replaced ? 'newer' : 'saved'} scan on reload`, async () => {
    const validation = Promise.withResolvers<Response>();
    mock.method(globalThis, 'fetch', () => validation.promise);
    window.history.replaceState(null, '', `/nfc${search()}`);
    const scan = render(createElement(RoutedCard, { value: wallet() }));
    const replacement = crypto.randomUUID();
    if (replaced) window.localStorage.setItem('mons.shop.tarot.claim:sepolia:1', replacement);
    await act(async () => validation.resolve(Response.json({ error: { code: apiCode } }, { status: response })));
    scan.unmount();
    openTab(window.location.href, snapshotTab());
    const restored = renderHook(useAppRoute).result.current.nfcLink;
    if (cleared) assert.equal(restored?.kind, 'artwork');
    else {
      assert.ok(restored?.kind === 'tarot');
      assert.equal(restored.request.code, replaced ? replacement : code);
    }
  });
}

test('blocked storage still scrubs the code and retains the scan in the current window', t => {
  const storage = Object.getPrototypeOf(window.localStorage);
  const blocked = () => { throw new DOMException('Storage unavailable', 'SecurityError'); };
  t.mock.method(storage, 'getItem', blocked);
  t.mock.method(storage, 'setItem', blocked);
  window.history.replaceState(null, '', `/nfc${search()}`);
  const view = renderHook(useAppRoute, { reactStrictMode: true });
  assert.equal(window.location.search, '?tokenId=1&testnet=true');
  act(() => window.dispatchEvent(new dom.window.PageTransitionEvent('pageshow', { persisted: true })));
  const link = view.result.current.nfcLink;
  assert.ok(link?.kind === 'tarot');
  assert.deepEqual(link.request, request);
  view.unmount();

  dom.window.close();
  ({ dom, setMediaQueryMatches } = setupFrontendDom());
  window.history.replaceState(null, '', '/nfc?tokenId=1&testnet=true');
  assert.equal(renderHook(useAppRoute).result.current.nfcLink?.kind, 'artwork');
});

test('Basel preserves the placeholder video and a supplied card ID switches to public artwork', () => {
  const service = mock.method(tarotApi, 'status');
  const open = mock.method(window, 'open', () => null);
  const value = wallet();
  const view = render(page('?code=basel', value));
  fireEvent.click(view.getByRole('button', { name: 'Claim' }));
  assert.deepEqual(open.mock.calls[0].arguments, ['https://www.youtube.com/watch?v=dQw4w9WgXcQ', '_blank', 'noopener,noreferrer']);
  assert.equal(service.mock.callCount(), 0);
  view.rerender(page('?code=basel&tokenId=1&testnet=true', value));
  assert.equal(assertArtworkPage(view).getByRole('img').getAttribute('src'), 'https://wip.lil.org/tarot/heros/1.webp');
  assert.equal(service.mock.callCount(), 0);
});

test('the header and large artwork appear before validation and remain mounted when already claimed', async () => {
  let finish!: (value: TarotStatus) => void;
  mock.method(tarotApi, 'status', () => new Promise<TarotStatus>(resolve => { finish = resolve; }));
  const view = render(page(search(777)));
  const header = view.getByRole('banner');
  assert.ok(within(header).getByRole('button', { name: 'Shop header' }));
  const artwork = assertArtworkPage(view).getByRole('img');
  assert.equal(artwork.getAttribute('src'), 'https://wip.lil.org/tarot/heros/777.webp');
  await act(async () => finish(status(777, true)));
  assert.equal(view.getByRole('banner'), header);
  assert.equal(assertArtworkPage(view).getByRole('img'), artwork);
});

test('valid unclaimed links display one decorative layer per category with their card and receipt', async () => {
  mockService();
  const view = render(page(search(777)));
  await view.findByRole('button', { name: 'Claim' });
  assert.equal(view.getAllByRole('img').length, 2);
  const hero = view.getByRole('img', { name: 'Mutating Card' });
  assert.equal(hero.getAttribute('src'), 'https://wip.lil.org/tarot/heros/777.webp');
  assert.equal(view.getByRole('img', { name: 'NFC Card Receipt' }).getAttribute('src'), 'https://wip.lil.org/tarot/receipts/777.webp');
  const layers = cardLayers(view.container);
  assert.equal(layers.length, 3);
  for (const [index, ids] of [[1, 6, 7, 10], [3, 4, 5], [2, 8, 9]].entries()) {
    const urls = ids.map(id => `https://wip.lil.org/tarot/layers/${id}.webp`);
    assert.ok(urls.includes(layers[index].src));
  }
  for (const layer of layers) assert.equal(layer.alt, '');
  for (const image of view.container.querySelectorAll('main img')) assert.equal(image.getAttribute('referrerpolicy'), 'no-referrer');
  assert.equal(view.queryByRole('textbox'), null);
  const layerStack = layers[0].parentElement!;
  const decodes = [hero, ...layers].map(image => {
    const { promise, resolve } = Promise.withResolvers<void>();
    const decode = mock.fn(() => promise);
    Object.defineProperty(image, 'decode', { value: decode });
    return { image, decode, resolve };
  });
  await act(async () => {
    for (const { image } of decodes) fireEvent.load(image);
  });
  for (const { decode, resolve } of decodes) {
    assert.equal(decode.mock.callCount(), 1);
    assert.equal(layerStack.dataset.ready, 'false');
    await act(async () => resolve());
  }
  assert.equal(layerStack.dataset.ready, 'true');
});

test('the live claim card follows reduced-motion changes while keeping its hero and Claim control', async () => {
  const preference = '(prefers-reduced-motion: reduce)';
  setMediaQueryMatches(preference, true);
  mockService();
  const view = render(page(search()));
  const hero = assertArtworkPage(view).getByRole('img');
  const claim = await view.findByRole('button', { name: 'Claim' });
  assert.equal(cardLayers(view.container).length, 0);
  await act(async () => setMediaQueryMatches(preference, false));
  assert.equal(cardLayers(view.container).length, 3);
  await act(async () => setMediaQueryMatches(preference, true));
  assert.equal(cardLayers(view.container).length, 0);
  assert.equal(view.getByRole('img', { name: 'Mutating Card' }), hero);
  assert.equal(view.getByRole('button', { name: 'Claim' }), claim);
  assert.equal((claim as HTMLButtonElement).disabled, false);
});

test('public artwork links render immediately without validation, receipt loading or wallet actions', () => {
  const service = mock.method(tarotApi, 'status');
  const prepare = mock.method(tarotApi, 'prepare');
  const value = wallet();
  const connect = mock.method(value, 'connect');
  for (const query of ['?tokenId=1', '?tokenId=777&code=wrong', '?tokenId=1&code=&testnet=true',
    '?tokenId=777&code=wrong&testnet=true', `?tokenId=1&code=${code}&testnet=false`, `?tokenId=777&code=${code}`]) {
    const view = render(page(query, value));
    const tokenId = new URLSearchParams(query).get('tokenId');
    const image = assertArtworkPage(view).getByRole('img');
    assert.equal(image.getAttribute('src'), `https://wip.lil.org/tarot/heros/${tokenId}.webp`);
    assert.equal(image.getAttribute('referrerpolicy'), 'no-referrer');
    assert.equal(view.container.querySelector('img[src*="/tarot/receipts/"]'), null);
    assert.equal(view.queryByRole('alert'), null);
    view.unmount();
  }
  assert.equal(service.mock.callCount(), 0);
  assert.equal(prepare.mock.callCount(), 0);
  assert.equal(connect.mock.callCount(), 0);
});

test('claim layers wait until the same hero finishes moving into the claim layout', async () => {
  const validation = Promise.withResolvers<TarotStatus>();
  const motion = Promise.withResolvers<void>();
  const animate = mock.fn(() => ({ finished: motion.promise, cancel() {} }));
  Object.defineProperties(HTMLImageElement.prototype, {
    complete: { configurable: true, get: () => true },
    naturalWidth: { configurable: true, get: () => 881 },
  });
  const service = mock.method(tarotApi, 'status', () => validation.promise);
  const value = wallet();
  const connect = mock.method(value, 'connect');
  const view = render(page(search(), value));
  const image = assertArtworkPage(view).getByRole('img');
  Object.defineProperty(image, 'animate', { value: animate });
  mock.method(image, 'getBoundingClientRect', () => new dom.window.DOMRect(0, 0, 220, 350));
  const header = view.getByRole('banner');
  assert.equal(view.container.querySelector('img[src*="/tarot/receipts/"]'), null);
  await act(async () => validation.resolve(status()));
  await waitFor(() => assert.equal(animate.mock.callCount(), 1));
  const main = view.getByRole('main', { name: 'NFC claim' });
  assert.equal(cardLayers(main).length, 0);
  await act(async () => motion.resolve());
  assert.equal(cardLayers(main).length, 3);
  assert.equal(within(main).getByRole('img', { name: 'Mutating Card' }), image);
  assert.equal(view.getByRole('banner'), header);
  assert.ok(within(main).getByRole('heading', { name: 'You got 2 NFTs:' }));
  assert.ok(within(main).getByRole('img', { name: 'NFC Card Receipt' }));
  assert.equal((within(main).getByRole('button', { name: 'Claim' }) as HTMLButtonElement).disabled, false);
  await act(async () => window.dispatchEvent(new dom.window.Event('focus')));
  assert.equal(view.getByRole('img', { name: 'Mutating Card' }), image);
  assert.equal(view.getByRole('banner'), header);
  assert.equal(service.mock.callCount(), 2);
  assert.equal(connect.mock.callCount(), 0);
});

for (const blocker of ['headerWalletOpen', 'walletModalVisible'] as const) {
  test(`eligible validation waits for ${blocker} to close without replacing artwork or header`, async () => {
    const validation = Promise.withResolvers<TarotStatus>();
    const service = mock.method(tarotApi, 'status', () => validation.promise);
    const value = wallet();
    const connect = mock.method(value, 'connect');
    const view = render(page(search(), value, { [blocker]: true }));
    const image = assertArtworkPage(view).getByRole('img');
    const header = view.getByRole('banner');
    const control = view.getByRole('button', { name: 'Shop header' });
    control.focus();
    assert.equal(service.mock.callCount(), 1);
    await act(async () => validation.resolve(status()));
    assert.equal(assertArtworkPage(view).getByRole('img'), image);
    assert.equal(view.getByRole('banner'), header);
    assert.equal(document.activeElement, control);
    await act(async () => view.rerender(page(search(), value, { [blocker]: false })));
    assert.equal(view.getByRole('img', { name: 'Mutating Card' }), image);
    assert.equal(view.getByRole('banner'), header);
    assert.equal(document.activeElement, control);
    assert.equal((view.getByRole('button', { name: 'Claim' }) as HTMLButtonElement).disabled, false);
    assert.equal(service.mock.callCount(), 1);
    assert.equal(connect.mock.callCount(), 0);
  });
}

test('disabled unclaimed cards remain in the silent large artwork view', async () => {
  mock.method(tarotApi, 'status', async () => ({ ...status(), config: { ...config, enabled: false } }));
  const value = wallet();
  const connect = mock.method(value, 'connect');
  const view = render(page(search(), value));
  const image = assertArtworkPage(view).getByRole('img');
  await act(async () => undefined);
  assert.equal(assertArtworkPage(view).getByRole('img'), image);
  assert.equal(view.queryByRole('alert'), null);
  assert.equal(connect.mock.callCount(), 0);
});

test('changing credentials for the same card resets validation without accepting a stale result', async () => {
  const first = Promise.withResolvers<TarotStatus>();
  let firstSignal: AbortSignal | undefined;
  const service = mock.method(tarotApi, 'status', async (input: TarotRequest, signal?: AbortSignal) => {
    if (input.code === code) { firstSignal = signal; return first.promise; }
    throw new TarotApiError('This Tarot claim link is invalid.', 401);
  });
  const value = wallet();
  const view = render(page('?tokenId=1', value));
  const artworkSrc = 'https://wip.lil.org/tarot/heros/1.webp';
  assert.equal(assertArtworkPage(view).getByRole('img').getAttribute('src'), artworkSrc);
  assert.equal(service.mock.callCount(), 0);
  view.rerender(page(search(), value));
  assert.equal(assertArtworkPage(view).getByRole('img').getAttribute('src'), artworkSrc);
  assert.equal(service.mock.callCount(), 1);
  await act(async () => view.rerender(page(search().replace(code, '00000000-0000-4000-8000-000000000002'), value)));
  assert.equal(firstSignal?.aborted, true);
  await act(async () => first.resolve(status()));
  assert.equal(assertArtworkPage(view).getByRole('img').getAttribute('src'), artworkSrc);
  assert.equal(view.queryByRole('alert'), null);
  view.rerender(page(`?tokenId=1&code=${code}&testnet=false`, value));
  assert.equal(assertArtworkPage(view).getByRole('img').getAttribute('src'), artworkSrc);
  assert.equal(service.mock.callCount(), 2);
});

test('credential revocation restores the same hero and revalidation reuses the layer selection until reload', async () => {
  const random = mock.method(Math, 'random', () => 0);
  let denied = false;
  mock.method(tarotApi, 'status', async () => {
    if (denied) throw new TarotApiError('This Tarot claim link is invalid.', 403);
    return status();
  });
  const view = render(page(search()));
  const image = assertArtworkPage(view).getByRole('img');
  await view.findByRole('button', { name: 'Claim' });
  const selection = cardLayers(view.container).map(layer => layer.src);
  assert.equal(selection.length, 3);
  random.mock.mockImplementation(() => 0.99);
  denied = true;
  await act(async () => window.dispatchEvent(new dom.window.Event('focus')));
  assert.equal(assertArtworkPage(view).getByRole('img'), image);
  assert.equal(view.queryByRole('alert'), null);
  denied = false;
  await act(async () => window.dispatchEvent(new dom.window.Event('focus')));
  assert.deepEqual(cardLayers(view.container).map(layer => layer.src), selection);
  view.unmount();
  const reloaded = render(page(search()));
  await reloaded.findByRole('button', { name: 'Claim' });
  const nextSelection = cardLayers(reloaded.container).map(layer => layer.src);
  assert.equal(nextSelection.length, 3);
  assert.notDeepEqual(nextSelection, selection);
});

test('background validation and wallet restoration errors are not user-initiated claim feedback', async () => {
  const value = { ...wallet(), error: 'An old wallet connection failed.' };
  mock.method(tarotApi, 'status', async () => { throw new TarotApiError('This Tarot claim link is invalid.', 401); });
  const view = renderHook(() => useTarotClaim(request, value));
  await act(async () => undefined);
  assert.equal(view.result.current.error, 'This Tarot claim link is invalid.');
  assert.equal(view.result.current.claimError, null);
});

test('a rejected manual claim remains visible independently of later background reads', async () => {
  mockService();
  const value = wallet(true);
  const original = value.provider!.request;
  mock.method(value.provider!, 'request', async (input: Parameters<typeof original>[0]) => {
    if (input.method === 'eth_sendTransaction') throw Object.assign(new Error('Rejected'), { code: 4001 });
    return original(input);
  });
  const view = renderHook(() => useTarotClaim(request, value));
  await act(async () => undefined);
  await act(async () => view.result.current.claim());
  assert.equal(view.result.current.claimError, 'Request cancelled in your wallet.');
  await act(async () => window.dispatchEvent(new dom.window.Event('focus')));
  assert.equal(view.result.current.claimError, 'Request cancelled in your wallet.');
});

for (const denied of [401, 403]) {
  test(`manual preparation ${denied} stays silent after successful background revalidation`, async () => {
    const service = mockService();
    service.prepare.mock.mockImplementation(async () => { throw new TarotApiError('This Tarot claim link is invalid.', denied); });
    const value = wallet(true);
    const provider = mock.method(value.provider!, 'request');
    const view = render(page(search(), value));
    const initialClaim = await view.findByRole('button', { name: 'Claim' });
    await act(async () => fireEvent.click(initialClaim));
    assertArtworkPage(view);
    assert.equal(view.queryByRole('alert'), null);
    await act(async () => window.dispatchEvent(new dom.window.Event('focus')));
    const claim = await view.findByRole('button', { name: 'Claim' });
    assert.equal((claim as HTMLButtonElement).disabled, false);
    assert.equal(view.queryByRole('alert'), null);
    assert.equal(provider.mock.calls.some(call => call.arguments[0].method === 'eth_sendTransaction'), false);
  });

  test(`confirmation ${denied} stays silent after revalidation and retains pending recovery`, async t => {
    const f = pendingClaimFixture(t);
    window.sessionStorage.setItem(f.key, JSON.stringify({ wallet: owner, transactionHash, deadline: f.now + 600 }));
    f.confirm.mock.mockImplementation(async () => { throw new TarotApiError('This Tarot claim link is invalid.', denied); });
    const view = f.mount(wallet());
    await act(async () => undefined);
    assert.equal(view.result.current.status, null);
    assert.equal(view.result.current.claimError, null);
    assert.ok(window.sessionStorage.getItem(f.key));
    f.confirm.mock.mockImplementation(async () => ({ ...confirmed(), status: 'pending' as const, confirmations: 0, blockNumber: null, blockHash: null }));
    await f.focus();
    assert.ok(view.result.current.status);
    assert.equal(view.result.current.pending, true);
    assert.equal(view.result.current.claimError, null);
    assert.ok(window.sessionStorage.getItem(f.key));
  });
}

test('a deployment change cancels an active manual connection without showing a message', async () => {
  let activeConfig = config;
  mock.method(tarotApi, 'status', async () => ({ ...status(), config: activeConfig }));
  const prepare = mock.method(tarotApi, 'prepare', async () => prepared());
  const value = wallet();
  const connect = mock.method(value, 'connect', () => { value.status = 'connecting'; });
  const cancel = mock.method(value, 'cancel', () => { value.status = 'disconnected'; });
  const view = render(page(search(), value));
  fireEvent.click(await view.findByRole('button', { name: 'Claim' }));
  await view.findByRole('button', { name: 'Connecting…' });
  activeConfig = { ...config, contractAddress: `0x${'3'.repeat(40)}` };
  await act(async () => window.dispatchEvent(new dom.window.Event('focus')));
  assert.equal((await view.findByRole('button', { name: 'Claim' }) as HTMLButtonElement).disabled, false);
  assert.equal(view.queryByRole('alert'), null);
  assert.equal(connect.mock.callCount(), 1);
  assert.equal(cancel.mock.callCount(), 1);
  assert.equal(prepare.mock.callCount(), 0);
  await act(async () => window.dispatchEvent(new dom.window.Event('focus')));
  assert.equal(view.queryByRole('alert'), null);
});

test('restored availability removes only the obsolete connection availability error', async () => {
  let enabled = true;
  mock.method(tarotApi, 'status', async () => ({ ...status(), config: { ...config, enabled } }));
  const prepare = mock.method(tarotApi, 'prepare', async () => prepared());
  const value = wallet();
  const connect = mock.method(value, 'connect', () => { value.status = 'connecting'; });
  const cancel = mock.method(value, 'cancel', () => { value.status = 'disconnected'; });
  const view = renderHook(() => useTarotClaim(request, value));
  await act(async () => undefined);
  await act(async () => view.result.current.claim());
  assert.equal(view.result.current.connecting, true);
  enabled = false;
  await act(async () => window.dispatchEvent(new dom.window.Event('focus')));
  assert.equal(view.result.current.claimError, 'Tarot claims are unavailable.');
  assert.equal(view.result.current.pending, false);
  assert.equal(cancel.mock.callCount(), 1);
  enabled = true;
  await act(async () => window.dispatchEvent(new dom.window.Event('focus')));
  assert.equal(view.result.current.status?.config.enabled, true);
  assert.equal(view.result.current.claimError, null);
  assert.equal(view.result.current.error, null);
  assert.equal(connect.mock.callCount(), 1);
  assert.equal(prepare.mock.callCount(), 0);
});

test('availability recovery preserves an unrelated manual connection error', async () => {
  let enabled = true;
  mock.method(tarotApi, 'status', async () => ({ ...status(), config: { ...config, enabled } }));
  const value = wallet();
  mock.method(value, 'connect', () => { throw new Error('Unable to connect this wallet.'); });
  const view = renderHook(() => useTarotClaim(request, value));
  await act(async () => undefined);
  await act(async () => view.result.current.claim());
  assert.equal(view.result.current.claimError, 'Unable to connect this wallet.');
  for (const available of [false, true]) {
    enabled = available;
    await act(async () => window.dispatchEvent(new dom.window.Event('focus')));
    assert.equal(view.result.current.claimError, 'Unable to connect this wallet.');
  }
});

test('a deployment change clears feedback from an inactive earlier manual attempt', async () => {
  let activeConfig = config;
  mock.method(tarotApi, 'status', async () => ({ ...status(), config: activeConfig }));
  const value = wallet();
  mock.method(value, 'connect', () => { throw new Error('Unable to connect this wallet.'); });
  const view = renderHook(() => useTarotClaim(request, value));
  await act(async () => undefined);
  await act(async () => view.result.current.claim());
  assert.equal(view.result.current.claimError, 'Unable to connect this wallet.');
  assert.equal(view.result.current.connecting, false);
  activeConfig = { ...config, contractAddress: `0x${'3'.repeat(40)}` };
  await act(async () => window.dispatchEvent(new dom.window.Event('focus')));
  assert.equal(view.result.current.claimError, null);
});

test('manual connection failures leave Claim retryable without showing a message', async () => {
  mockService();
  const value = wallet();
  mock.method(value, 'connect', () => { value.status = 'connecting'; });
  const view = render(page(search(), value));
  fireEvent.click(await view.findByRole('button', { name: 'Claim' }));
  await act(async () => view.rerender(page(search(), { ...value, status: 'disconnected', error: 'Wallet connection was cancelled.' })));
  assert.equal((await view.findByRole('button', { name: 'Claim' }) as HTMLButtonElement).disabled, false);
  assert.equal(view.queryByRole('alert'), null);
  assert.equal(view.getAllByRole('img').length, 2);
});

test('manual preparation failures stay silent through background reads and allow Claim to be retried', async () => {
  const { prepare } = mockService();
  const second = Promise.withResolvers<TarotPrepareResponse>();
  let attempts = 0;
  prepare.mock.mockImplementation(async () => {
    if (++attempts === 1) throw new TarotApiError('Couldn’t prepare this claim.', 503);
    return second.promise;
  });
  const view = render(page(search(), wallet(true)));
  const claim = await view.findByRole('button', { name: 'Claim' });
  await act(async () => fireEvent.click(claim));
  assert.equal((view.getByRole('button', { name: 'Claim' }) as HTMLButtonElement).disabled, false);
  assert.equal(prepare.mock.callCount(), 1);
  assert.equal(view.queryByRole('alert'), null);
  await act(async () => window.dispatchEvent(new dom.window.Event('focus')));
  assert.equal(view.queryByRole('alert'), null);
  await act(async () => fireEvent.click(view.getByRole('button', { name: 'Claim' })));
  assert.equal(view.queryByRole('alert'), null);
  assert.equal(prepare.mock.callCount(), 2);
  await act(async () => second.resolve(prepared()));
  await waitFor(() => assertArtworkPage(view));
});

test('automatic read failures after eligibility do not create claim-error UI', async () => {
  let fail = false;
  mock.method(tarotApi, 'status', async () => {
    if (fail) throw new TarotApiError('Automatic availability read failed.', 503);
    return status();
  });
  const view = render(page(search()));
  await view.findByRole('button', { name: 'Claim' });
  const image = view.getByRole('img', { name: 'Mutating Card' });
  fail = true;
  await act(async () => window.dispatchEvent(new dom.window.Event('focus')));
  assert.equal(view.queryByRole('alert'), null);
  assert.equal(view.getByRole('img', { name: 'Mutating Card' }), image);
});

test('one Claim click connects Ethereum, continues once, and replaces confirmed claim UI with artwork', async () => {
  mockService();
  const disconnected = wallet();
  const connect = mock.method(disconnected, 'connect', () => { disconnected.status = 'connecting'; });
  const view = render(page(search(), disconnected));
  const claim = await view.findByRole('button', { name: 'Claim' });
  const [layer] = cardLayers(view.container);
  assert.ok(layer);
  await act(async () => fireEvent.error(layer));
  assert.equal((claim as HTMLButtonElement).disabled, false);
  fireEvent.click(claim);
  fireEvent.click(claim);
  assert.equal(connect.mock.callCount(), 1);
  const connected = wallet(true);
  const provider = mock.method(connected.provider!, 'request');
  await act(async () => view.rerender(page(search(), connected)));
  await waitFor(() => assertArtworkPage(view));
  assert.equal(provider.mock.calls.filter(call => call.arguments[0].method === 'eth_sendTransaction').length, 1);
  assert.equal(provider.mock.calls.some(call => /sign/i.test(call.arguments[0].method)), false);
  assert.equal(view.getAllByRole('img').length, 1);
  assert.equal(window.sessionStorage.length, 0);
});

test('wallet rejection preserves a retryable claim and cannot mint or hide the receipt', async () => {
  mockService();
  const connected = wallet(true);
  const original = connected.provider!.request;
  let fail = true;
  mock.method(connected.provider!, 'request', async (input: Parameters<typeof original>[0]) => {
    if (input.method === 'eth_sendTransaction' && fail) throw Object.assign(new Error('Rejected'), { code: 4001 });
    return original(input);
  });
  const view = render(page(search(), connected));
  const claim = await view.findByRole('button', { name: 'Claim' });
  await act(async () => fireEvent.click(claim));
  assert.equal((view.getByRole('button', { name: 'Claim' }) as HTMLButtonElement).disabled, false);
  assert.equal(view.queryByRole('alert'), null);
  assert.equal(view.getAllByRole('img').length, 2);
  fail = false;
  await act(async () => fireEvent.click(view.getByRole('button', { name: 'Claim' })));
  assertArtworkPage(view);
});

test('a refreshed claimed status hides the entire claim UI without connecting a wallet', async () => {
  let claimed = false;
  mock.method(tarotApi, 'status', async () => status(1, claimed));
  const value = wallet();
  const connect = mock.method(value, 'connect');
  const view = render(page(search(), value));
  await view.findByRole('button', { name: 'Claim' });
  claimed = true;
  await act(async () => window.dispatchEvent(new dom.window.Event('focus')));
  assertArtworkPage(view);
  assert.equal(connect.mock.callCount(), 0);
});

test('reload recovers a submitted receipt without storing a secret or requiring a connected wallet', async () => {
  const { confirm } = mockService();
  window.sessionStorage.setItem(`mons.shop.tarot.pending:${config.chainId}:${contract}:1`, JSON.stringify({ wallet: owner, transactionHash }));
  assert.equal(JSON.stringify(window.sessionStorage).includes(code), false);
  const view = render(page(search()));
  await waitFor(() => {
    assert.equal(confirm.mock.callCount(), 1);
    assert.equal(window.sessionStorage.length, 0);
    assertArtworkPage(view);
  });
  assert.equal(confirm.mock.calls[0].arguments[0].transactionHash, transactionHash);
  assert.equal(window.sessionStorage.length, 0);
  assertArtworkPage(view);
});

test('a dropped or cancelled transaction becomes claimable only after confirmed onchain expiry', async () => {
  const deadline = Math.floor(Date.now() / 1000) + 600;
  let observedTimestamp = deadline;
  mock.method(tarotApi, 'status', async () => ({ ...status(), observedTimestamp }));
  mock.method(tarotApi, 'confirm', async () => ({ status: 'pending' as const, transactionHash, confirmations: 0, tokenId: 1,
    receiptTokenId: tarotReceiptTokenId(1), blockNumber: null, blockHash: null }));
  const key = `mons.shop.tarot.pending:${config.chainId}:${contract}:1`;
  window.sessionStorage.setItem(key, JSON.stringify({ wallet: owner, transactionHash, deadline }));
  const view = render(page(search()));
  const claiming = await view.findByRole('button', { name: 'Claiming…' });
  assert.equal((claiming as HTMLButtonElement).disabled, true);
  assert.ok(window.sessionStorage.getItem(key));
  observedTimestamp = deadline + 1;
  await act(async () => window.dispatchEvent(new dom.window.Event('focus')));
  await waitFor(() => assert.equal((view.getByRole('button', { name: 'Claim' }) as HTMLButtonElement).disabled, false));
  assert.equal(window.sessionStorage.getItem(key), null);
  assert.equal(view.getAllByRole('img').length, 2);
});

test('a delayed status read cannot reopen the claim after transaction confirmation', async () => {
  let delayStatus = false;
  let finishStatus!: (value: TarotStatus) => void;
  let finishConfirmation!: (value: TarotConfirmResponse) => void;
  mock.method(tarotApi, 'status', () => delayStatus
    ? new Promise<TarotStatus>(resolve => { finishStatus = resolve; }) : Promise.resolve(status()));
  mock.method(tarotApi, 'prepare', async () => prepared());
  const confirm = mock.method(tarotApi, 'confirm', () => new Promise<TarotConfirmResponse>(resolve => { finishConfirmation = resolve; }));
  const view = render(page(search(), wallet(true)));
  const claim = await view.findByRole('button', { name: 'Claim' });
  await act(async () => fireEvent.click(claim));
  assert.equal(confirm.mock.callCount(), 1);
  delayStatus = true;
  act(() => window.dispatchEvent(new dom.window.Event('focus')));
  await act(async () => finishConfirmation(confirmed()));
  assertArtworkPage(view);
  await act(async () => finishStatus(status()));
  assertArtworkPage(view);
});

test('new post-confirmation requests cannot move behind the receipt block or contradict its hash', async () => {
  let snapshot = { ...status(), observedBlock: 100 };
  mock.method(tarotApi, 'status', async () => snapshot);
  mock.method(tarotApi, 'confirm', async () => confirmed(1, 105));
  window.sessionStorage.setItem(`mons.shop.tarot.pending:${config.chainId}:${contract}:1`,
    JSON.stringify({ wallet: owner, transactionHash, deadline: Math.floor(Date.now() / 1000) + 600 }));
  const value = wallet();
  const view = renderHook(() => useTarotClaim(request, value));
  await waitFor(() => assert.equal(view.result.current.status?.claimed, true));
  for (const observedBlock of [99, 103, 105]) {
    snapshot = { ...status(), observedBlock, blockHash: receiptBlockHash };
    await act(async () => window.dispatchEvent(new dom.window.Event('focus')));
    assert.equal(view.result.current.status?.claimed, true);
    assert.equal(view.result.current.pending, false);
    assert.equal(view.result.current.loading, false);
    assert.equal(view.result.current.error, null);
  }
  snapshot = { ...status(1, true), observedBlock: 105, blockHash: receiptBlockHash };
  await act(async () => window.dispatchEvent(new dom.window.Event('focus')));
  assert.equal(view.result.current.status?.observedBlock, 105);
});

for (const observedBlock of [105, 107]) {
  test(`a fresh canonical reorg snapshot at block ${observedBlock} can undo a confirmed claim`, async () => {
    let snapshot = { ...status(), observedBlock: 100 };
    mock.method(tarotApi, 'status', async () => snapshot);
    mock.method(tarotApi, 'confirm', async () => confirmed(1, 105));
    window.sessionStorage.setItem(`mons.shop.tarot.pending:${config.chainId}:${contract}:1`,
      JSON.stringify({ wallet: owner, transactionHash, deadline: Math.floor(Date.now() / 1000) + 600 }));
    const value = wallet();
    const view = renderHook(() => useTarotClaim(request, value));
    await waitFor(() => assert.equal(view.result.current.status?.claimed, true));
    snapshot = { ...status(), observedBlock, blockHash: `0x${'e'.repeat(64)}` };
    await act(async () => window.dispatchEvent(new dom.window.Event('focus')));
    assert.equal(view.result.current.status?.claimed, false);
    assert.equal(view.result.current.status?.observedBlock, observedBlock);
    snapshot = { ...status(1, true), observedBlock: observedBlock - 1 };
    await act(async () => window.dispatchEvent(new dom.window.Event('focus')));
    assert.equal(view.result.current.status?.claimed, false);
    assert.equal(view.result.current.status?.observedBlock, observedBlock);
  });
}

test('direct claim validation rejects older availability without preparing or clearing its existing error', async () => {
  let response: TarotStatus | Error = { ...status(), observedBlock: 100 };
  const service = mock.method(tarotApi, 'status', async () => { if (response instanceof Error) throw response; return response; });
  const prepare = mock.method(tarotApi, 'prepare', async () => prepared());
  const value = wallet(true);
  const provider = mock.method(value.provider!, 'request');
  const view = renderHook(() => useTarotClaim(request, value));
  await waitFor(() => assert.equal(view.result.current.status?.observedBlock, 100));
  response = new TarotApiError('Temporary read failure', 503);
  await act(async () => window.dispatchEvent(new dom.window.Event('focus')));
  assert.equal(view.result.current.error, 'Temporary read failure');
  response = { ...status(), observedBlock: 99 };
  await act(async () => view.result.current.claim());
  await waitFor(() => assert.equal(view.result.current.pending, false));
  assert.equal(view.result.current.status?.observedBlock, 100);
  assert.equal(view.result.current.loading, false);
  assert.equal(view.result.current.error, 'Temporary read failure');
  assert.equal(service.mock.callCount(), 3);
  assert.equal(prepare.mock.callCount(), 0);
  assert.equal(provider.mock.calls.some(call => call.arguments[0].method === 'eth_sendTransaction'), false);
});

test('a stale status preserves pending recovery and polling continues until a fresh snapshot arrives', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 2_000_000_000_000 });
  let calls = 0;
  let caughtUp = false;
  const service = mock.method(tarotApi, 'status', async () => ({ ...status(), observedBlock: ++calls === 1 || caughtUp ? 100 : 99 }));
  const confirm = mock.method(tarotApi, 'confirm', async () => ({ ...confirmed(), status: 'pending' as const,
    confirmations: 0, blockNumber: null, blockHash: null }));
  const key = `mons.shop.tarot.pending:${config.chainId}:${contract}:1`;
  window.sessionStorage.setItem(key, JSON.stringify({ wallet: owner, transactionHash, deadline: 2_000_000_600 }));
  const value = wallet();
  const view = renderHook(() => useTarotClaim(request, value));
  await act(async () => undefined);
  assert.equal(service.mock.callCount(), 2);
  assert.equal(confirm.mock.callCount(), 0);
  assert.equal(view.result.current.status?.observedBlock, 100);
  assert.equal(view.result.current.pending, true);
  assert.equal(view.result.current.loading, false);
  assert.ok(window.sessionStorage.getItem(key));
  caughtUp = true;
  await act(async () => t.mock.timers.tick(4_000));
  assert.equal(confirm.mock.callCount(), 1);
  assert.equal(view.result.current.pending, true);
});

for (const observedBlock of [105, 110]) {
  test(`an in-flight confirmation cannot replace a newer reorg observation at block ${observedBlock}`, async () => {
    let snapshot = { ...status(), observedBlock: 100 };
    let finish!: (value: TarotConfirmResponse) => void;
    mock.method(tarotApi, 'status', async () => snapshot);
    const confirm = mock.method(tarotApi, 'confirm', () => new Promise<TarotConfirmResponse>(resolve => { finish = resolve; }));
    window.sessionStorage.setItem(`mons.shop.tarot.pending:${config.chainId}:${contract}:1`,
      JSON.stringify({ wallet: owner, transactionHash, deadline: Math.floor(Date.now() / 1000) + 600 }));
    const value = wallet();
    const view = renderHook(() => useTarotClaim(request, value));
    await waitFor(() => assert.equal(confirm.mock.callCount(), 1));
    snapshot = { ...status(), observedBlock, blockHash: `0x${'e'.repeat(64)}` };
    await act(async () => window.dispatchEvent(new dom.window.Event('focus')));
    await act(async () => finish(confirmed(1, 105)));
    assert.equal(view.result.current.status?.claimed, false);
    assert.equal(view.result.current.status?.blockHash, snapshot.blockHash);
    assert.equal(view.result.current.status?.observedBlock, observedBlock);
    assert.equal(view.result.current.pending, true);
  });
}

test('link identity and deployment changes reset chain observations', async () => {
  let snapshot = { ...status(1, true), observedBlock: 100 };
  mock.method(tarotApi, 'status', async (input: TarotRequest) => ({ ...snapshot, tokenId: input.tokenId, receiptTokenId: tarotReceiptTokenId(input.tokenId) }));
  const value = wallet();
  const view = renderHook(({ input }) => useTarotClaim(input, value), { initialProps: { input: request } });
  await waitFor(() => assert.equal(view.result.current.status?.claimed, true));
  snapshot = { ...status(), observedBlock: 5 };
  await act(async () => view.rerender({ input: { ...request, code: '00000000-0000-4000-8000-000000000002' } }));
  assert.equal(view.result.current.status?.claimed, false);
  assert.equal(view.result.current.status?.observedBlock, 5);
  snapshot = { ...status(1, true), observedBlock: 100 };
  await act(async () => window.dispatchEvent(new dom.window.Event('focus')));
  snapshot = { ...status(), observedBlock: 2, config: { ...config, contractAddress: `0x${'3'.repeat(40)}` } };
  await act(async () => window.dispatchEvent(new dom.window.Event('focus')));
  assert.equal(view.result.current.status?.claimed, false);
  assert.equal(view.result.current.status?.observedBlock, 2);
  assert.equal(view.result.current.status?.config.contractAddress, snapshot.config.contractAddress);
});

test('rejecting a network switch does not prepare or submit a claim', async () => {
  const { prepare } = mockService();
  const connected = wallet(true);
  mock.method(connected.provider!, 'request', async ({ method }: { method: string }) => {
    if (method === 'eth_accounts') return [owner];
    if (method === 'eth_chainId') return '0x1';
    if (method === 'wallet_switchEthereumChain') throw Object.assign(new Error('Cancelled'), { code: 4001 });
    assert.fail(`Unexpected wallet method ${method}`);
  });
  const view = render(page(search(), connected));
  const claim = await view.findByRole('button', { name: 'Claim' });
  await act(async () => fireEvent.click(claim));
  assert.equal((view.getByRole('button', { name: 'Claim' }) as HTMLButtonElement).disabled, false);
  assert.equal(view.queryByRole('alert'), null);
  assert.equal(prepare.mock.callCount(), 0);
  assert.equal((view.getByRole('button', { name: 'Claim' }) as HTMLButtonElement).disabled, false);
});

for (const failure of [new TarotApiError('Invalid link.', 401), new TarotApiError('Forbidden.', 403),
  new TarotApiError('Too many attempts.', 429), new TarotApiError('Temporarily unavailable.', 503), new TypeError('Network unavailable')]) {
  test(`initial ${failure instanceof TarotApiError ? failure.status : 'network'} validation failures silently preserve the large artwork`, async () => {
    const service = mock.method(tarotApi, 'status', async () => { throw failure; });
    const value = wallet();
    const connect = mock.method(value, 'connect');
    const view = render(page(search(), value));
    const image = assertArtworkPage(view).getByRole('img');
    await act(async () => undefined);
    assert.equal(assertArtworkPage(view).getByRole('img'), image);
    assert.equal(service.mock.callCount(), 1);
    assert.equal(view.queryByRole('alert'), null);
    assert.equal(connect.mock.callCount(), 0);
  });
}

test('route changes discard stale validation results', async () => {
  let finish!: (value: TarotStatus) => void;
  mock.method(tarotApi, 'status', async (input: TarotRequest) => input.tokenId === 1
    ? new Promise<TarotStatus>(resolve => { finish = resolve; }) : status(777, true));
  const view = render(page(search()));
  view.rerender(page(search(777)));
  await waitFor(() => assert.ok(view.queryByRole('main', { name: 'Tarot card' })));
  await act(async () => finish(status(1, false)));
  assert.equal(assertArtworkPage(view).getByRole('img').getAttribute('src'), 'https://wip.lil.org/tarot/heros/777.webp');
});

test('API sends credentials only in a private POST and rejects another card or a mainnet response', async () => {
  let response: unknown = status();
  const fetch = mock.method(globalThis, 'fetch', async () => Response.json(response));
  await tarotApi.status(request);
  const [url, init] = fetch.mock.calls[0].arguments as unknown as [string, RequestInit];
  assert.equal(url, '/api/ethereum/tarot/status');
  assert.equal(init.method, 'POST');
  assert.equal(init.cache, 'no-store');
  assert.equal(init.referrerPolicy, 'no-referrer');
  assert.equal(init.credentials, 'omit');
  assert.deepEqual(JSON.parse(String(init.body)), request);
  response = status(2);
  await assert.rejects(tarotApi.status(request), /verify/);
  response = { ...status(), config: { ...config, chainId: 1 } };
  await assert.rejects(tarotApi.status(request), /verify/);
});

test('prepared transactions must mint this exact pair on Sepolia for zero ETH', async () => {
  let response = prepared();
  mock.method(globalThis, 'fetch', async () => Response.json(response));
  await tarotApi.prepare({ ...request, wallet: owner }, config);
  for (const transaction of [
    { ...response.transaction, chainId: 1 }, { ...response.transaction, value: '0x1' },
    { ...response.transaction, to: owner }, { ...response.transaction, data: '0x' },
  ]) {
    response = { ...prepared(), transaction };
    await assert.rejects(tarotApi.prepare({ ...request, wallet: owner }, config), /verify/);
  }
});

test('confirmation responses require paired canonical receipt proof for terminal results', async () => {
  let response: unknown = confirmed();
  mock.method(globalThis, 'fetch', async () => Response.json(response));
  const input = { ...request, wallet: owner, transactionHash };
  for (const result of [confirmed(), { ...confirmed(), status: 'failed' },
    { ...confirmed(), status: 'pending', confirmations: 1 },
    { ...confirmed(), status: 'pending', confirmations: 0, blockNumber: null, blockHash: null }]) {
    response = result;
    assert.deepEqual(await tarotApi.confirm(input), result);
  }
  for (const result of [
    { ...confirmed(), blockNumber: null, blockHash: null }, { ...confirmed(), blockNumber: undefined },
    { ...confirmed(), blockHash: undefined }, { ...confirmed(), blockNumber: -1 }, { ...confirmed(), blockNumber: 1.5 },
    { ...confirmed(), blockNumber: 0 }, { ...confirmed(), blockHash: 'wrong' }, { ...confirmed(), confirmations: 2 },
    { ...confirmed(), status: 'failed', blockHash: null }, { ...confirmed(), status: 'pending', blockNumber: null },
  ]) {
    response = result;
    await assert.rejects(tarotApi.confirm(input), /verify/);
  }
});

test('initial rate limits retry automatically at Retry-After without wallet interaction and stop after success', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 2_000_000_000_000 });
  let attempts = 0;
  const fetch = mock.method(globalThis, 'fetch', async () => ++attempts === 1
    ? Response.json({ error: { message: 'Rate limited' } }, { status: 429, headers: { 'Retry-After': '60' } })
    : Response.json(status()));
  const value = wallet();
  const connect = mock.method(value, 'connect');
  const prepare = mock.method(tarotApi, 'prepare');
  const view = renderHook(() => useTarotClaim(request, value));
  await act(async () => undefined);
  assert.equal(Boolean(view.result.current.status), false);
  assert.match(view.result.current.error ?? '', /Too many attempts/);
  await act(async () => { t.mock.timers.tick(59_999); window.dispatchEvent(new dom.window.Event('focus')); });
  assert.equal(fetch.mock.callCount(), 1);
  await act(async () => { t.mock.timers.tick(1); window.dispatchEvent(new dom.window.Event('focus')); });
  assert.equal(fetch.mock.callCount(), 2);
  assert.equal(view.result.current.status?.claimed, false);
  assert.equal(view.result.current.error, null);
  await act(async () => t.mock.timers.tick(120_000));
  assert.equal(fetch.mock.callCount(), 2);
  assert.equal(connect.mock.callCount(), 0);
  assert.equal(prepare.mock.callCount(), 0);
});

for (const [label, error] of [
  ['unavailable', new TarotApiError('Temporarily unavailable', 503)],
  ['network failure', new TypeError('Failed to fetch')],
  ['request timeout', new DOMException('Request timed out', 'TimeoutError')],
] as const) {
  test(`initial ${label} retries with increasing backoff and recovers without focus`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 2_000_000_000_000 });
    let attempts = 0;
    const service = mock.method(tarotApi, 'status', async () => {
      if (++attempts <= 2) throw error;
      return status(1, true);
    });
    const view = renderHook(() => useTarotClaim(request, wallet()));
    await act(async () => undefined);
    assert.equal(service.mock.callCount(), 1);
    for (const [index, delay] of [2_000, 4_000].entries()) {
      await act(async () => t.mock.timers.tick(delay - 1));
      assert.equal(service.mock.callCount(), index + 1);
      await act(async () => t.mock.timers.tick(1));
      assert.equal(service.mock.callCount(), index + 2);
    }
    assert.equal(view.result.current.status?.claimed, true);
    await act(async () => t.mock.timers.tick(120_000));
    assert.equal(service.mock.callCount(), 3);
  });
}

for (const code of [400, 401, 403, 404]) {
  test(`initial permanent ${code} responses do not retry on timers or focus`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 2_000_000_000_000 });
    const service = mock.method(tarotApi, 'status', async () => { throw new TarotApiError('Invalid link', code); });
    const view = renderHook(() => useTarotClaim(request, wallet()));
    await act(async () => undefined);
    await act(async () => {
      t.mock.timers.tick(180_000);
      window.dispatchEvent(new dom.window.Event('focus'));
      window.dispatchEvent(new dom.window.Event('pageshow'));
      document.dispatchEvent(new dom.window.Event('visibilitychange'));
    });
    assert.equal(service.mock.callCount(), 1);
    assert.equal(view.result.current.status, null);
    assert.equal(view.result.current.error, 'Invalid link');
  });
}

test('initial retry budget stops automatic retries but allows later focus recovery after the cooldown', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 2_000_000_000_000 });
  let recovered = false;
  const service = mock.method(tarotApi, 'status', async () => {
    if (!recovered) throw new TarotApiError('Unavailable', 503);
    return status();
  });
  const view = renderHook(() => useTarotClaim(request, wallet()));
  await act(async () => undefined);
  for (const [index, delay] of [2_000, 4_000, 8_000, 16_000, 30_000].entries()) {
    await act(async () => { t.mock.timers.tick(delay - 1); window.dispatchEvent(new dom.window.Event('focus')); });
    assert.equal(service.mock.callCount(), index + 1);
    await act(async () => t.mock.timers.tick(1));
    assert.equal(service.mock.callCount(), index + 2);
  }
  await act(async () => { t.mock.timers.tick(29_999); window.dispatchEvent(new dom.window.Event('focus')); });
  assert.equal(service.mock.callCount(), 6);
  await act(async () => { t.mock.timers.tick(1); window.dispatchEvent(new dom.window.Event('focus')); });
  assert.equal(service.mock.callCount(), 7);
  await act(async () => t.mock.timers.tick(180_000));
  assert.equal(service.mock.callCount(), 7);
  recovered = true;
  await act(async () => window.dispatchEvent(new dom.window.Event('focus')));
  assert.equal(service.mock.callCount(), 8);
  assert.ok(view.result.current.status);
});

test('initial retry deadlines survive hidden and suspended periods without duplicate focus requests', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 2_000_000_000_000 });
  let visibility = 'visible';
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
  t.after(() => Reflect.deleteProperty(document, 'visibilityState'));
  let attempts = 0;
  const service = mock.method(tarotApi, 'status', async () => {
    if (++attempts <= 2) throw new TarotApiError('Unavailable', 503);
    return status();
  });
  const value = wallet();
  const view = renderHook(({ suspended }) => useTarotClaim(request, value, suspended), { initialProps: { suspended: false } });
  await act(async () => undefined);
  visibility = 'hidden';
  act(() => document.dispatchEvent(new dom.window.Event('visibilitychange')));
  await act(async () => t.mock.timers.tick(10_000));
  assert.equal(service.mock.callCount(), 1);
  visibility = 'visible';
  await act(async () => {
    document.dispatchEvent(new dom.window.Event('visibilitychange'));
    window.dispatchEvent(new dom.window.Event('focus'));
    t.mock.timers.tick(0);
  });
  assert.equal(service.mock.callCount(), 2);
  view.rerender({ suspended: true });
  await act(async () => { t.mock.timers.tick(10_000); window.dispatchEvent(new dom.window.Event('focus')); });
  assert.equal(service.mock.callCount(), 2);
  view.rerender({ suspended: false });
  await act(async () => t.mock.timers.tick(0));
  assert.equal(service.mock.callCount(), 3);
  assert.equal(view.result.current.status?.claimed, false);
});

test('a page mounted while suspended waits to start validation until it becomes active', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 2_000_000_000_000 });
  const service = mock.method(tarotApi, 'status', async () => status());
  const value = wallet();
  const view = renderHook(({ suspended }) => useTarotClaim(request, value, suspended), { initialProps: { suspended: true } });
  await act(async () => { t.mock.timers.tick(120_000); window.dispatchEvent(new dom.window.Event('focus')); });
  assert.equal(service.mock.callCount(), 0);
  await act(async () => view.rerender({ suspended: false }));
  assert.equal(service.mock.callCount(), 1);
  assert.ok(view.result.current.status);
});

test('unmount and credential changes cancel scheduled initial retries', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 2_000_000_000_000 });
  const service = mock.method(tarotApi, 'status', async (input: TarotRequest) => {
    if (input.tokenId === 1) throw new TarotApiError('Unavailable', 503);
    return status(input.tokenId, true);
  });
  const value = wallet();
  const first = renderHook(() => useTarotClaim(request, value));
  await act(async () => undefined);
  first.unmount();
  await act(async () => t.mock.timers.tick(120_000));
  assert.equal(service.mock.callCount(), 1);
  const second = renderHook(({ input }) => useTarotClaim(input, value), { initialProps: { input: request } });
  await act(async () => undefined);
  await act(async () => second.rerender({ input: { ...request, tokenId: 777 } }));
  assert.equal(second.result.current.status?.tokenId, 777);
  await act(async () => t.mock.timers.tick(120_000));
  assert.equal(service.mock.callCount(), 3);
});

test('aborting an in-flight initial retry on unmount never schedules another request', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 2_000_000_000_000 });
  let attempts = 0;
  let retrySignal: AbortSignal | undefined;
  const service = mock.method(tarotApi, 'status', async (_input: TarotRequest, signal?: AbortSignal) => {
    if (++attempts === 1) throw new TypeError('Network unavailable');
    retrySignal = signal;
    return await new Promise<TarotStatus>((_resolve, reject) => signal?.addEventListener('abort', () => reject(signal.reason), { once: true }));
  });
  const view = renderHook(() => useTarotClaim(request, wallet()));
  await act(async () => undefined);
  await act(async () => t.mock.timers.tick(2_000));
  assert.equal(service.mock.callCount(), 2);
  await act(async () => view.unmount());
  assert.equal(retrySignal?.aborted, true);
  await act(async () => t.mock.timers.tick(120_000));
  assert.equal(service.mock.callCount(), 2);
});

test('a response body timeout remains retryable instead of becoming an invalid-response error', async () => {
  const timeout = new DOMException('Response timed out', 'TimeoutError');
  const response = Response.json(status());
  mock.method(response, 'json', async () => { throw timeout; });
  mock.method(globalThis, 'fetch', async () => response);
  await assert.rejects(tarotApi.status(request), error => error === timeout);
});

test('an interrupted rate-limit body preserves the HTTP Retry-After deadline', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 2_000_000_000_000 });
  const response = new Response(new ReadableStream({
    start(controller) { controller.error(new DOMException('Response timed out', 'TimeoutError')); },
  }), { status: 429, headers: { 'Retry-After': '90' } });
  mock.method(globalThis, 'fetch', async () => response);
  await assert.rejects(tarotApi.status(request), error => error instanceof TarotApiError &&
    error.status === 429 && error.retryAt === Date.now() + 90_000);
});

for (const [label, error] of [
  ['network error', new TypeError('Response interrupted')],
  ['timeout', new DOMException('Response timed out', 'TimeoutError')],
] as const) {
  test(`an interrupted Response stream ${label} recovers through the actual API client`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 2_000_000_000_000 });
    let attempts = 0;
    const fetch = mock.method(globalThis, 'fetch', async () => ++attempts === 1
      ? new Response(new ReadableStream({ start(controller) { controller.error(error); } }), { headers: { 'Content-Type': 'application/json' } })
      : Response.json(status()));
    const view = renderHook(() => useTarotClaim(request, wallet()));
    await act(async () => undefined);
    assert.equal(fetch.mock.callCount(), 1);
    assert.ok(view.result.current.error);
    await act(async () => t.mock.timers.tick(2_000));
    assert.equal(fetch.mock.callCount(), 2);
    assert.ok(view.result.current.status);
    assert.equal(view.result.current.error, null);
  });
}

test('malformed successful JSON stops validation retries instead of accepting an invalid status', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 2_000_000_000_000 });
  const fetch = mock.method(globalThis, 'fetch', async () => new Response('{', { headers: { 'Content-Type': 'application/json' } }));
  const view = renderHook(() => useTarotClaim(request, wallet()));
  await act(async () => undefined);
  await act(async () => { t.mock.timers.tick(180_000); window.dispatchEvent(new dom.window.Event('focus')); });
  assert.equal(fetch.mock.callCount(), 1);
  assert.equal(view.result.current.status, null);
  assert.ok(view.result.current.error);
});

for (const disconnect of [false, true]) {
  test(`an unresolved wallet submission remains guarded until canonical expiry (disconnect=${disconnect})`, async t => {
    const f = pendingClaimFixture(t);
    const view = await f.begin();
    const intent = JSON.parse(window.sessionStorage.getItem(f.key)!);
    assert.equal(intent.transactionHash, null);
    assert.equal(intent.wallet, owner);
    assert.equal(intent.deadline, f.now + 600);
    assert.ok(intent.id);
    assert.equal(JSON.stringify(intent).includes(code), false);
    assert.equal(view.result.current.submitted, false);
    if (disconnect) {
      await act(async () => { f.emit('disconnect', { code: 4900 }); view.rerender({ wallet: wallet() }); });
      assert.equal(view.result.current.submitted, true);
    }
    assert.equal(view.result.current.pending, true);
    await act(async () => view.result.current.claim());
    assert.equal(f.waits.length, 1);
    assert.equal(f.confirm.mock.callCount(), 0);
    await f.expire();
    assert.equal(view.result.current.pending, false);
    assert.equal(window.sessionStorage.getItem(f.key), null);
    await act(async () => f.waits[0].resolve(transactionHash));
    assert.equal(view.result.current.pending, false);
    assert.equal(window.sessionStorage.getItem(f.key), null);
  });
}

test('disconnect aborts a hung network check before any claim intent is created', async t => {
  const f = pendingClaimFixture(t, 'eth_chainId');
  const view = await f.begin();
  assert.equal(window.sessionStorage.getItem(f.key), null);
  assert.equal(f.prepare.mock.callCount(), 0);
  await act(async () => { f.emit('disconnect', { code: 4900 }); view.rerender({ wallet: wallet() }); });
  assert.equal(view.result.current.pending, false);
  await act(async () => f.waits[0].resolve('0xaa36a7'));
  assert.equal(f.prepare.mock.callCount(), 0);
  assert.equal(window.sessionStorage.getItem(f.key), null);
});

test('account changes release the wallet wait without discarding an uncertain submission', async t => {
  const f = pendingClaimFixture(t);
  const view = await f.begin();
  await act(async () => {
    const address = `0x${'3'.repeat(40)}`;
    f.emit('accountsChanged', [address]);
    view.rerender({ wallet: { ...f.value, address } });
  });
  assert.equal(view.result.current.submitted, true);
  assert.equal(view.result.current.pending, true);
  assert.equal(JSON.parse(window.sessionStorage.getItem(f.key)!).wallet, owner);
  await act(async () => view.result.current.claim());
  assert.equal(f.waits.length, 1);
  await f.expire();
  assert.equal(view.result.current.pending, false);
  await act(async () => f.waits[0].reject(Object.assign(new Error('Cancelled'), { code: 4001 })));
});

for (const outcome of ['reverted transaction', 'wallet rejection']) {
  test(`a remount reconciles a late ${outcome} from the original intent`, async t => {
    const f = pendingClaimFixture(t);
    const first = await f.begin();
    const original = JSON.parse(window.sessionStorage.getItem(f.key)!);
    await act(async () => first.unmount());
    const second = f.mount(wallet());
    await act(async () => undefined);
    assert.equal(second.result.current.pending, true);
    assert.equal(f.confirm.mock.callCount(), 0);
    if (outcome === 'reverted transaction') {
      await act(async () => f.waits[0].resolve(transactionHash));
      const updated = JSON.parse(window.sessionStorage.getItem(f.key)!);
      assert.equal(updated.id, original.id);
      assert.equal(updated.deadline, original.deadline);
      assert.equal(updated.transactionHash, transactionHash);
      f.confirm.mock.mockImplementation(async () => ({ ...confirmed(1, 99), status: 'failed' as const }));
    } else await act(async () => f.waits[0].reject(Object.assign(new Error('Rejected'), { code: 4001 })));
    await f.focus();
    assert.equal(second.result.current.pending, false);
    assert.equal(window.sessionStorage.getItem(f.key), null);
  });
}

test('an expired intent’s late hash cannot overwrite a newer wallet attempt', async t => {
  const f = pendingClaimFixture(t);
  const view = await f.begin();
  const first = JSON.parse(window.sessionStorage.getItem(f.key)!);
  await f.expire();
  assert.equal(view.result.current.pending, false);
  await act(async () => view.result.current.claim());
  assert.equal(f.waits.length, 2);
  const second = JSON.parse(window.sessionStorage.getItem(f.key)!);
  assert.notEqual(second.id, first.id);
  await act(async () => f.waits[0].resolve(transactionHash));
  assert.deepEqual(JSON.parse(window.sessionStorage.getItem(f.key)!), second);
  const secondHash = `0x${'f'.repeat(64)}`;
  await act(async () => f.waits[1].resolve(secondHash));
  assert.equal(JSON.parse(window.sessionStorage.getItem(f.key)!).id, second.id);
  assert.equal(JSON.parse(window.sessionStorage.getItem(f.key)!).transactionHash, secondHash);
});

test('a late hash after unmount cannot revive an intent expired by the replacement page', async t => {
  const f = pendingClaimFixture(t);
  const first = await f.begin();
  await act(async () => first.unmount());
  const second = f.mount(wallet());
  await act(async () => undefined);
  assert.equal(second.result.current.pending, true);
  await f.expire();
  assert.equal(second.result.current.pending, false);
  await act(async () => f.waits[0].resolve(transactionHash));
  assert.equal(window.sessionStorage.getItem(f.key), null);
  await f.focus();
  assert.equal(second.result.current.pending, false);
});

test('uncertain wallet errors retain the intent while definite rejection clears it', async t => {
  const f = pendingClaimFixture(t);
  const view = await f.begin();
  await act(async () => f.waits[0].reject(new TypeError('Wallet connection interrupted')));
  assert.equal(view.result.current.pending, true);
  assert.ok(window.sessionStorage.getItem(f.key));
  await f.expire();
  await act(async () => view.result.current.claim());
  assert.equal(f.waits.length, 2);
  await act(async () => f.waits[1].reject(Object.assign(new Error('Rejected'), { code: 4001 })));
  assert.equal(view.result.current.pending, false);
  assert.equal(window.sessionStorage.getItem(f.key), null);
  assert.equal(view.result.current.error, 'Request cancelled in your wallet.');
});

test('storage quota failure keeps an unknown intent in memory and tracks its eventual hash', async t => {
  const f = pendingClaimFixture(t);
  mock.method(dom.window.Storage.prototype, 'setItem', () => { throw new DOMException('Quota exceeded', 'QuotaExceededError'); });
  const view = await f.begin();
  assert.equal(window.sessionStorage.getItem(f.key), null);
  await f.focus();
  assert.equal(view.result.current.pending, true);
  await act(async () => view.result.current.claim());
  assert.equal(f.waits.length, 1);
  f.confirm.mock.mockImplementation(async () => confirmed(1, 105));
  await act(async () => f.waits[0].resolve(transactionHash));
  assert.equal(view.result.current.status?.claimed, true);
  assert.equal(view.result.current.pending, false);
});

for (const failure of ['writes', 'reads after persistence', 'reads and writes']) {
  test(`same-Window remount preserves an unresolved intent when ${failure} fail`, async t => {
    const f = pendingClaimFixture(t);
    if (failure !== 'reads after persistence') {
      mock.method(dom.window.Storage.prototype, 'setItem', () => { throw new DOMException('Quota exceeded', 'QuotaExceededError'); });
    }
    const first = await f.begin();
    if (failure !== 'writes') {
      mock.method(dom.window.Storage.prototype, 'getItem', () => { throw new DOMException('Storage unavailable', 'SecurityError'); });
    }
    await act(async () => first.unmount());
    const second = f.mount();
    await act(async () => undefined);
    assert.equal(second.result.current.pending, true);
    await act(async () => second.result.current.claim());
    assert.equal(f.waits.length, 1);
    await f.expire();
    assert.equal(second.result.current.pending, false);
    await act(async () => f.waits[0].resolve(transactionHash));
    await f.focus();
    assert.equal(second.result.current.pending, false);
  });
}

for (const failure of ['writes', 'reads']) {
  for (const outcome of ['hash', 'rejection']) {
    test(`a remount receives a late ${outcome} while storage ${failure} fail`, async t => {
      const f = pendingClaimFixture(t);
      if (failure === 'writes') {
        mock.method(dom.window.Storage.prototype, 'setItem', () => { throw new DOMException('Quota exceeded', 'QuotaExceededError'); });
      }
      const first = await f.begin();
      if (failure === 'reads') {
        mock.method(dom.window.Storage.prototype, 'getItem', () => { throw new DOMException('Storage unavailable', 'SecurityError'); });
      }
      await act(async () => first.unmount());
      const second = f.mount(wallet());
      await act(async () => undefined);
      assert.equal(second.result.current.pending, true);
      if (outcome === 'hash') {
        f.confirm.mock.mockImplementation(async () => confirmed(1, 105));
        await act(async () => f.waits[0].resolve(transactionHash));
      } else await act(async () => f.waits[0].reject(Object.assign(new Error('Rejected'), { code: 4001 })));
      await f.focus();
      assert.equal(second.result.current.pending, false);
      assert.equal(second.result.current.status?.claimed, outcome === 'hash');
      assert.equal(f.waits.length, 1);
    });
  }
}

test('failed removal tombstones survive remount and honor later real storage changes', async t => {
  const f = pendingClaimFixture(t);
  const first = await f.begin();
  const original = window.sessionStorage.getItem(f.key);
  const remove = dom.window.Storage.prototype.removeItem;
  mock.method(dom.window.Storage.prototype, 'removeItem', () => { throw new DOMException('Storage unavailable', 'SecurityError'); });
  await act(async () => f.waits[0].reject(Object.assign(new Error('Rejected'), { code: 4001 })));
  await act(async () => first.unmount());
  const second = f.mount(wallet());
  await act(async () => undefined);
  assert.equal(second.result.current.pending, false);
  assert.equal(window.sessionStorage.getItem(f.key), original);
  window.sessionStorage.setItem(f.key, JSON.stringify({ id: 'newer-intent', wallet: owner, transactionHash: null, deadline: f.now + 600 }));
  await f.focus();
  assert.equal(second.result.current.pending, true);
  remove.call(window.sessionStorage, f.key);
  await f.focus();
  assert.equal(second.result.current.pending, false);
});

test('a remounted expiry tombstone blocks the original late hash when stored removal fails', async t => {
  const f = pendingClaimFixture(t);
  const first = await f.begin();
  const original = window.sessionStorage.getItem(f.key);
  mock.method(dom.window.Storage.prototype, 'removeItem', () => { throw new DOMException('Storage unavailable', 'SecurityError'); });
  await act(async () => first.unmount());
  const second = f.mount(wallet());
  await act(async () => undefined);
  await f.expire();
  assert.equal(second.result.current.pending, false);
  await act(async () => f.waits[0].resolve(transactionHash));
  await f.focus();
  assert.equal(second.result.current.pending, false);
  assert.equal(window.sessionStorage.getItem(f.key), original);
});

test('fallback intents stay within their card, deployment and captured Window', async t => {
  const f = pendingClaimFixture(t);
  mock.method(dom.window.Storage.prototype, 'setItem', () => { throw new DOMException('Quota exceeded', 'QuotaExceededError'); });
  const first = await f.begin();
  await act(async () => first.unmount());
  let activeConfig = config;
  mock.method(tarotApi, 'status', async (input: TarotRequest) => ({ ...status(input.tokenId), config: activeConfig,
    observedBlock: 100, observedTimestamp: f.now - 24 }));
  const otherCard = renderHook(() => useTarotClaim({ ...request, tokenId: 2 }, f.value));
  await act(async () => undefined);
  assert.equal(otherCard.result.current.pending, false);
  otherCard.unmount();
  activeConfig = { ...config, contractAddress: `0x${'3'.repeat(40)}` };
  const otherDeployment = f.mount();
  await act(async () => undefined);
  assert.equal(otherDeployment.result.current.pending, false);
  otherDeployment.unmount();
  activeConfig = config;
  const restored = f.mount();
  await act(async () => undefined);
  assert.equal(restored.result.current.pending, true);
  restored.unmount();
  const previousDom = dom;
  t.after(() => previousDom.window.close());
  ({ dom } = setupFrontendDom());
  const otherWindow = f.mount();
  await act(async () => undefined);
  assert.equal(otherWindow.result.current.pending, false);
  await act(async () => f.waits[0].resolve(transactionHash));
  await f.focus();
  assert.equal(otherWindow.result.current.pending, false);
  assert.equal(window.sessionStorage.length, 0);
});

test('a late hash cannot revive a cleared local intent when removing its stored record fails', async t => {
  const f = pendingClaimFixture(t);
  const view = await f.begin();
  const original = window.sessionStorage.getItem(f.key);
  mock.method(dom.window.Storage.prototype, 'removeItem', () => { throw new DOMException('Storage unavailable', 'SecurityError'); });
  await f.expire();
  assert.equal(view.result.current.pending, false);
  assert.equal(window.sessionStorage.getItem(f.key), original);
  await act(async () => f.waits[0].resolve(transactionHash));
  assert.equal(view.result.current.pending, false);
  assert.equal(window.sessionStorage.getItem(f.key), original);
});

test('legacy hash recovery does not extend its in-memory expiry when migration storage fails', async t => {
  const f = pendingClaimFixture(t);
  window.sessionStorage.setItem(f.key, JSON.stringify({ wallet: owner, transactionHash }));
  mock.method(dom.window.Storage.prototype, 'setItem', () => { throw new DOMException('Quota exceeded', 'QuotaExceededError'); });
  const view = f.mount(wallet());
  await act(async () => undefined);
  assert.equal(view.result.current.pending, true);
  await f.expire();
  assert.equal(view.result.current.pending, false);
  assert.equal(window.sessionStorage.getItem(f.key), null);
});

test('legacy hash recovery persists its identity and deadline once across reloads', async t => {
  const f = pendingClaimFixture(t);
  window.sessionStorage.setItem(f.key, JSON.stringify({ wallet: owner, transactionHash }));
  const first = f.mount(wallet());
  await act(async () => undefined);
  const migrated = JSON.parse(window.sessionStorage.getItem(f.key)!);
  assert.ok(migrated.id);
  assert.equal(migrated.deadline, f.now + 600);
  await act(async () => first.unmount());
  t.mock.timers.setTime((f.now + 120) * 1000);
  f.setSnapshot({ observedBlock: 110, observedTimestamp: f.now + 96, blockHash: `0x${'e'.repeat(64)}` });
  const second = f.mount(wallet());
  await act(async () => undefined);
  assert.equal(second.result.current.pending, true);
  assert.deepEqual(JSON.parse(window.sessionStorage.getItem(f.key)!), migrated);
});

test('failed receipt reconciliation preserves a newer reorg observation and accepts a later fresh failure', async t => {
  const f = pendingClaimFixture(t);
  f.setSnapshot({ observedTimestamp: f.now - 60 });
  const delayed = Promise.withResolvers<TarotConfirmResponse>();
  f.confirm.mock.mockImplementation(() => delayed.promise);
  window.sessionStorage.setItem(f.key, JSON.stringify({ wallet: owner, transactionHash, deadline: f.now + 600 }));
  const view = f.mount(wallet());
  await act(async () => undefined);
  assert.equal(f.confirm.mock.callCount(), 1);
  t.mock.timers.setTime((f.now + 24) * 1000);
  const reorgHash = `0x${'e'.repeat(64)}`;
  f.setSnapshot({ observedBlock: 105, observedTimestamp: f.now, blockHash: reorgHash });
  await f.focus();
  await act(async () => delayed.resolve({ ...confirmed(1, 105), status: 'failed' }));
  assert.equal(view.result.current.pending, true);
  assert.ok(window.sessionStorage.getItem(f.key));
  f.confirm.mock.mockImplementation(async () => ({ ...confirmed(1, 103), status: 'failed' as const, confirmations: 5 }));
  await act(async () => t.mock.timers.tick(4_000));
  assert.equal(view.result.current.pending, false);
  assert.equal(window.sessionStorage.getItem(f.key), null);
  assert.equal(view.result.current.status?.claimed, false);
  assert.equal(view.result.current.status?.observedBlock, 105);
  assert.equal(view.result.current.status?.blockHash, reorgHash);
  assert.equal(view.result.current.claimError, 'The claim transaction failed. Please try again.');
  await f.focus();
  assert.equal(view.result.current.claimError, 'The claim transaction failed. Please try again.');
});

for (const failure of ['unavailable', 'rate-limit', 'network', 'invalid-response'] as const) {
  test(`pending confirmation recovers from ${failure} silently without clearing the claim`, async t => {
    const f = pendingClaimFixture(t);
    const message = failure === 'network' || failure === 'invalid-response'
      ? 'Couldn’t verify this Tarot claim. Please try again.' : 'Confirmation is temporarily unavailable.';
    const error = failure === 'invalid-response' ? new Error('Invalid confirmation response') : failure === 'network' ? new TypeError('Network unavailable') :
      new TarotApiError(message, failure === 'rate-limit' ? 429 : 503, failure === 'rate-limit' ? (f.now + 60) * 1000 : null);
    let reads = 0;
    f.confirm.mock.mockImplementation(async () => {
      if (++reads === 1) throw error;
      return { ...confirmed(), status: 'pending' as const, confirmations: 0, blockNumber: null, blockHash: null };
    });
    window.sessionStorage.setItem(f.key, JSON.stringify({ wallet: owner, transactionHash, deadline: f.now + 600 }));
    const view = render(page(search(), wallet()));
    await act(async () => undefined);
    assert.equal(reads, 1);
    assert.equal(view.queryByRole('alert'), null);
    assert.equal((view.getByRole('button', { name: 'Claiming…' }) as HTMLButtonElement).disabled, true);
    await act(async () => t.mock.timers.tick(failure === 'rate-limit' ? 60_000 : 4_000));
    assert.equal(reads, 2);
    assert.equal(view.queryByRole('alert'), null);
    assert.equal((view.getByRole('button', { name: 'Claiming…' }) as HTMLButtonElement).disabled, true);
    assert.equal(JSON.parse(window.sessionStorage.getItem(f.key)!).transactionHash, transactionHash);
  });
}

test('canonical expiry clears temporary confirmation feedback and stops receipt polling', async t => {
  const f = pendingClaimFixture(t);
  f.confirm.mock.mockImplementation(async () => { throw new TarotApiError('Confirmation unavailable.', 503); });
  window.sessionStorage.setItem(f.key, JSON.stringify({ wallet: owner, transactionHash, deadline: f.now + 600 }));
  const view = f.mount(wallet());
  await act(async () => undefined);
  assert.equal(view.result.current.pending, true);
  assert.equal(view.result.current.claimError, 'Confirmation unavailable.');
  assert.equal(f.confirm.mock.callCount(), 1);
  await f.expire();
  assert.equal(view.result.current.pending, false);
  assert.equal(window.sessionStorage.getItem(f.key), null);
  assert.equal(view.result.current.claimError, null);
  await act(async () => t.mock.timers.tick(120_000));
  assert.equal(f.confirm.mock.callCount(), 1);
});

test('canonical expiry preserves durable wallet feedback from an uncertain submission', async t => {
  const f = pendingClaimFixture(t);
  const view = await f.begin();
  await act(async () => { f.emit('disconnect'); view.rerender({ wallet: wallet() }); });
  const message = view.result.current.claimError;
  assert.match(message ?? '', /wallet changed/);
  await f.expire();
  assert.equal(view.result.current.pending, false);
  assert.equal(window.sessionStorage.getItem(f.key), null);
  assert.equal(view.result.current.claimError, message);
  await act(async () => f.waits[0].resolve(transactionHash));
  assert.equal(view.result.current.claimError, message);
  assert.equal(f.confirm.mock.callCount(), 0);
});

test('a pending confirmation begun before a newer chain observation cannot clear transient feedback', async t => {
  const f = pendingClaimFixture(t);
  const delayed = Promise.withResolvers<TarotConfirmResponse>();
  let reads = 0;
  const pending: TarotConfirmResponse = { ...confirmed(), status: 'pending', confirmations: 0, blockNumber: null, blockHash: null };
  f.confirm.mock.mockImplementation(async () => {
    if (++reads === 1) throw new TarotApiError('Confirmation unavailable.', 503);
    return reads === 2 ? delayed.promise : pending;
  });
  window.sessionStorage.setItem(f.key, JSON.stringify({ wallet: owner, transactionHash, deadline: f.now + 600 }));
  const view = f.mount(wallet());
  await act(async () => undefined);
  assert.equal(view.result.current.claimError, 'Confirmation unavailable.');
  await act(async () => t.mock.timers.tick(4_000));
  assert.equal(reads, 2);
  f.setSnapshot({ observedBlock: 105, blockHash: `0x${'e'.repeat(64)}`, observedTimestamp: f.now });
  await f.focus();
  await act(async () => delayed.resolve(pending));
  assert.equal(view.result.current.claimError, 'Confirmation unavailable.');
  assert.equal(view.result.current.pending, true);
  await act(async () => t.mock.timers.tick(4_000));
  assert.equal(reads, 3);
  assert.equal(view.result.current.claimError, null);
  assert.equal(view.result.current.pending, true);
});

test('a pending confirmation from before a new cooldown cannot clear transient feedback', async t => {
  const f = pendingClaimFixture(t);
  const delayed = Promise.withResolvers<TarotConfirmResponse>();
  let reads = 0;
  f.confirm.mock.mockImplementation(async () => {
    if (++reads === 1) throw new TarotApiError('Confirmation unavailable.', 503);
    return delayed.promise;
  });
  window.sessionStorage.setItem(f.key, JSON.stringify({ wallet: owner, transactionHash, deadline: f.now + 600 }));
  const view = f.mount(wallet());
  await act(async () => undefined);
  await act(async () => t.mock.timers.tick(4_000));
  assert.equal(reads, 2);
  mock.method(tarotApi, 'status', async () => { throw new TarotApiError('Rate limited.', 429, Date.now() + 60_000); });
  await f.focus();
  await act(async () => delayed.resolve({ ...confirmed(), status: 'pending', confirmations: 0, blockNumber: null, blockHash: null }));
  assert.equal(view.result.current.claimError, 'Confirmation unavailable.');
  assert.equal(view.result.current.coolingDown, true);
  assert.equal(view.result.current.pending, true);
});

test('a successful pending confirmation preserves a wallet error from an uncertain submission', async t => {
  const f = pendingClaimFixture(t);
  const view = await f.begin();
  await act(async () => {
    f.emit('disconnect');
    view.rerender({ wallet: wallet() });
  });
  const message = view.result.current.claimError;
  assert.match(message ?? '', /wallet changed/);
  await act(async () => f.waits[0].resolve(transactionHash));
  assert.ok(f.confirm.mock.callCount() > 0);
  assert.equal(view.result.current.pending, true);
  assert.equal(view.result.current.claimError, message);
});

for (const failure of ['unavailable', 'rate-limit', 'network'] as const) {
  test(`a recovered ${failure} confirmation read preserves preceding durable wallet feedback`, async t => {
    const f = pendingClaimFixture(t);
    const view = await f.begin();
    await act(async () => {
      f.emit('disconnect');
      view.rerender({ wallet: wallet() });
    });
    const message = view.result.current.claimError;
    assert.match(message ?? '', /wallet changed/);
    let reads = 0;
    f.confirm.mock.mockImplementation(async () => {
      if (++reads === 1) throw failure === 'network' ? new TypeError('Network unavailable') :
        new TarotApiError('Confirmation unavailable.', failure === 'rate-limit' ? 429 : 503,
          failure === 'rate-limit' ? (f.now + 60) * 1000 : null);
      return { ...confirmed(), status: 'pending' as const, confirmations: 0, blockNumber: null, blockHash: null };
    });
    await act(async () => f.waits[0].resolve(transactionHash));
    assert.equal(reads, 1);
    assert.equal(view.result.current.claimError, message);
    await act(async () => t.mock.timers.tick(failure === 'rate-limit' ? 60_000 : 4_000));
    assert.equal(reads, 2);
    assert.equal(view.result.current.pending, true);
    assert.equal(view.result.current.claimError, message);
    assert.equal(JSON.parse(window.sessionStorage.getItem(f.key)!).transactionHash, transactionHash);
    f.confirm.mock.mockImplementation(async () => confirmed(1, 105));
    await act(async () => t.mock.timers.tick(4_000));
    assert.equal(view.result.current.status?.claimed, true);
    assert.equal(view.result.current.claimError, null);
  });
}

for (const denied of [401, 403]) {
  test(`a later ${denied} blocks Claim until successful revalidation`, async () => {
    let allowed = true;
    mock.method(tarotApi, 'status', async () => {
      if (!allowed) throw new TarotApiError('This Tarot claim link is invalid.', denied);
      return status();
    });
    const value = wallet();
    const connect = mock.method(value, 'connect');
    const view = renderHook(() => useTarotClaim(request, value));
    await act(async () => undefined);
    allowed = false;
    await act(async () => window.dispatchEvent(new dom.window.Event('focus')));
    assert.equal(view.result.current.status, null);
    await act(async () => view.result.current.claim());
    assert.equal(connect.mock.callCount(), 0);
    allowed = true;
    await act(async () => window.dispatchEvent(new dom.window.Event('focus')));
    assert.ok(view.result.current.status);
    assert.equal(view.result.current.error, null);
    await act(async () => view.result.current.claim());
    assert.equal(connect.mock.callCount(), 1);
  });
}

test('revocation cancels a queued connection without resuming it after revalidation', async () => {
  let allowed = true;
  mock.method(tarotApi, 'status', async () => {
    if (!allowed) throw new TarotApiError('This Tarot claim link is invalid.', 401);
    return status();
  });
  const prepare = mock.method(tarotApi, 'prepare', async () => prepared());
  const value = wallet();
  mock.method(value, 'connect', () => { value.status = 'connecting'; });
  const cancel = mock.method(value, 'cancel');
  const view = renderHook(({ current }) => useTarotClaim(request, current), { initialProps: { current: value } });
  await act(async () => undefined);
  await act(async () => view.result.current.claim());
  assert.equal(view.result.current.connecting, true);
  assert.equal(cancel.mock.callCount(), 0);
  allowed = false;
  await act(async () => window.dispatchEvent(new dom.window.Event('focus')));
  assert.equal(cancel.mock.callCount(), 1);
  await act(async () => view.rerender({ current: wallet(true) }));
  allowed = true;
  await act(async () => window.dispatchEvent(new dom.window.Event('focus')));
  assert.equal(view.result.current.pending, false);
  assert.equal(prepare.mock.callCount(), 0);
});

for (const stage of ['status', 'prepare']) {
  test(`revocation fences a delayed pre-submit ${stage} response`, async () => {
    let denied = false;
    let reads = 0;
    const statusWait = Promise.withResolvers<TarotStatus>();
    const prepareWait = Promise.withResolvers<TarotPrepareResponse>();
    mock.method(tarotApi, 'status', async () => {
      if (denied) throw new TarotApiError('This Tarot claim link is invalid.', 401);
      return ++reads === 2 && stage === 'status' ? statusWait.promise : status();
    });
    const prepare = mock.method(tarotApi, 'prepare', () => prepareWait.promise);
    const value = wallet(true);
    const provider = mock.method(value.provider!, 'request');
    const view = renderHook(() => useTarotClaim(request, value));
    await act(async () => undefined);
    await act(async () => view.result.current.claim());
    assert.equal(reads, 2);
    denied = true;
    await act(async () => window.dispatchEvent(new dom.window.Event('focus')));
    await act(async () => { statusWait.resolve(status()); prepareWait.resolve(prepared()); });
    assert.equal(view.result.current.status, null);
    assert.equal(view.result.current.error, 'This Tarot claim link is invalid.');
    assert.equal(prepare.mock.callCount(), stage === 'prepare' ? 1 : 0);
    assert.equal(provider.mock.calls.some(call => call.arguments[0].method === 'eth_sendTransaction'), false);
  });
}

for (const result of ['confirmed', 'failed'] as const) {
  test(`revocation fences an in-flight ${result} confirmation without deleting recovery`, async t => {
    const f = pendingClaimFixture(t);
    const confirmation = Promise.withResolvers<TarotConfirmResponse>();
    f.confirm.mock.mockImplementation(() => confirmation.promise);
    const recovery = JSON.stringify({ id: 'existing-intent', wallet: owner, transactionHash, deadline: f.now + 600 });
    window.sessionStorage.setItem(f.key, recovery);
    const view = f.mount(wallet());
    await act(async () => undefined);
    assert.equal(f.confirm.mock.callCount(), 1);
    mock.method(tarotApi, 'status', async () => { throw new TarotApiError('This Tarot claim link is invalid.', 403); });
    await act(async () => {
      window.dispatchEvent(new dom.window.Event('focus'));
      await Promise.resolve();
      confirmation.resolve({ ...confirmed(1, 105), status: result });
    });
    assert.equal(view.result.current.status, null);
    assert.equal(view.result.current.error, 'This Tarot claim link is invalid.');
    assert.equal(view.result.current.pending, true);
    assert.equal(window.sessionStorage.getItem(f.key), recovery);
  });
}

test('revocation retains an uncertain wallet submission and accepts its late hash only as recovery data', async t => {
  const f = pendingClaimFixture(t);
  const view = await f.begin();
  const original = JSON.parse(window.sessionStorage.getItem(f.key)!);
  mock.method(tarotApi, 'status', async () => { throw new TarotApiError('This Tarot claim link is invalid.', 401); });
  await f.focus();
  assert.equal(view.result.current.status, null);
  assert.equal(view.result.current.pending, true);
  await act(async () => f.waits[0].resolve(transactionHash));
  const recovered = JSON.parse(window.sessionStorage.getItem(f.key)!);
  assert.equal(recovered.id, original.id);
  assert.equal(recovered.transactionHash, transactionHash);
  assert.equal(view.result.current.status, null);
  assert.equal(view.result.current.error, 'This Tarot claim link is invalid.');
  assert.equal(f.confirm.mock.callCount(), 0);
});

test('a later credential denial preserves an already-claimed card and its header', async () => {
  let allowed = true;
  mock.method(tarotApi, 'status', async () => {
    if (!allowed) throw new TarotApiError('This Tarot claim link is invalid.', 401);
    return status(1, true);
  });
  const view = render(page(search()));
  await act(async () => undefined);
  allowed = false;
  await act(async () => window.dispatchEvent(new dom.window.Event('focus')));
  assertArtworkPage(view);
});

test('a later 429 disables Claim and reenables it at Retry-After without wallet interaction', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 2_000_000_000_000 });
  let reads = 0;
  const service = mock.method(tarotApi, 'status', async () => {
    if (++reads > 1) throw new TarotApiError('Too many attempts.', 429, Date.now() + 60_000);
    return status();
  });
  const value = wallet();
  const connect = mock.method(value, 'connect');
  const view = render(page(search(), value));
  await act(async () => undefined);
  await act(async () => window.dispatchEvent(new dom.window.Event('focus')));
  const button = view.getByRole('button', { name: 'Please wait…' }) as HTMLButtonElement;
  assert.equal(button.disabled, true);
  assert.equal(view.queryByRole('alert'), null);
  fireEvent.click(button);
  assert.equal(connect.mock.callCount(), 0);
  await act(async () => t.mock.timers.tick(59_999));
  assert.equal(button.disabled, true);
  await act(async () => t.mock.timers.tick(1));
  assert.equal(button.disabled, false);
  assert.equal(view.getByRole('button', { name: 'Claim' }), button);
  assert.equal(view.queryByRole('alert'), null);
  assert.equal(service.mock.callCount(), 2);
  assert.equal(connect.mock.callCount(), 0);
  fireEvent.click(button);
  assert.equal(connect.mock.callCount(), 1);
});

test('a status response begun before a prepare 429 cannot clear the signing cooldown', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 2_000_000_000_000 });
  let reads = 0;
  const oldStatus = Promise.withResolvers<TarotStatus>();
  const quote = Promise.withResolvers<TarotPrepareResponse>();
  const service = mock.method(tarotApi, 'status', async () => ++reads === 3 ? oldStatus.promise : status());
  const prepare = mock.method(tarotApi, 'prepare', () => quote.promise);
  const value = wallet(true);
  const view = renderHook(() => useTarotClaim(request, value));
  await act(async () => undefined);
  await act(async () => view.result.current.claim());
  act(() => window.dispatchEvent(new dom.window.Event('focus')));
  await act(async () => quote.reject(new TarotApiError('Too many attempts.', 429, Date.now() + 60_000)));
  await act(async () => oldStatus.resolve(status()));
  assert.equal(view.result.current.coolingDown, true);
  assert.equal(view.result.current.error, 'Too many attempts.');
  await act(async () => view.result.current.claim());
  assert.equal(prepare.mock.callCount(), 1);
  await act(async () => t.mock.timers.tick(60_000));
  assert.equal(view.result.current.coolingDown, false);
  assert.equal(service.mock.callCount(), 3);
});

for (const deniedStatus of [401, 403]) {
  test(`a late ${deniedStatus} still revokes claim access after a prepare cooldown`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 2_000_000_000_000 });
    let reads = 0;
    const validation = Promise.withResolvers<TarotStatus>();
    const quote = Promise.withResolvers<TarotPrepareResponse>();
    const service = mock.method(tarotApi, 'status', async () => ++reads === 3 ? validation.promise : status());
    const prepare = mock.method(tarotApi, 'prepare', () => quote.promise);
    const connected = wallet(true);
    const provider = mock.method(connected.provider!, 'request');
    const disconnected = wallet();
    const connect = mock.method(disconnected, 'connect');
    const view = renderHook(({ current }) => useTarotClaim(request, current), { initialProps: { current: connected } });
    await act(async () => undefined);
    await act(async () => view.result.current.claim());
    await act(async () => window.dispatchEvent(new dom.window.Event('focus')));
    assert.equal(service.mock.callCount(), 3);
    assert.equal(prepare.mock.callCount(), 1);
    await act(async () => quote.reject(new TarotApiError('Too many attempts.', 429, Date.now() + 60_000)));
    await act(async () => validation.reject(new TarotApiError('This Tarot claim link is invalid.', deniedStatus)));
    assert.equal(view.result.current.status, null);
    assert.equal(view.result.current.error, 'This Tarot claim link is invalid.');
    assert.equal(view.result.current.coolingDown, true);
    await act(async () => view.rerender({ current: disconnected }));
    await act(async () => t.mock.timers.tick(60_000));
    assert.equal(view.result.current.coolingDown, false);
    await act(async () => view.result.current.claim());
    assert.equal(connect.mock.callCount(), 0);
    assert.equal(service.mock.callCount(), 3);
    assert.equal(prepare.mock.callCount(), 1);
    assert.equal(provider.mock.calls.some(call => call.arguments[0].method === 'eth_sendTransaction'), false);
  });
}

test('pending confirmation polling resumes after concurrent 429 invalidates its previous response', async t => {
  const f = pendingClaimFixture(t);
  const oldConfirmation = Promise.withResolvers<TarotConfirmResponse>();
  f.confirm.mock.mockImplementation(() => oldConfirmation.promise);
  window.sessionStorage.setItem(f.key, JSON.stringify({ wallet: owner, transactionHash, deadline: f.now + 600 }));
  const view = f.mount(wallet());
  await act(async () => undefined);
  let limited = true;
  const service = mock.method(tarotApi, 'status', async () => {
    if (limited) throw new TarotApiError('Too many attempts.', 429, Date.now() + 60_000);
    return { ...status(), observedBlock: 100, observedTimestamp: f.now - 24 };
  });
  await f.focus();
  const pendingResult = { ...confirmed(), status: 'pending' as const, confirmations: 0, blockNumber: null, blockHash: null };
  await act(async () => oldConfirmation.resolve(pendingResult));
  assert.equal(view.result.current.pending, true);
  assert.equal(view.result.current.coolingDown, true);
  limited = false;
  f.confirm.mock.mockImplementation(async () => pendingResult);
  await act(async () => t.mock.timers.tick(60_000));
  assert.equal(service.mock.callCount(), 2);
  assert.equal(f.confirm.mock.callCount(), 2);
  assert.equal(view.result.current.pending, true);
});

test('later cooldowns respect hidden and suspended state and reset on a new link', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 2_000_000_000_000 });
  let visible = true;
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visible ? 'visible' : 'hidden' });
  let limited = false;
  const service = mock.method(tarotApi, 'status', async (input: TarotRequest) => {
    if (limited && input.tokenId === 1) throw new TarotApiError('Too many attempts.', 429, Date.now() + 60_000);
    return status(input.tokenId);
  });
  const value = wallet();
  const view = renderHook(({ input, suspended }) => useTarotClaim(input, value, suspended),
    { initialProps: { input: request, suspended: false } });
  await act(async () => undefined);
  limited = true;
  await act(async () => window.dispatchEvent(new dom.window.Event('focus')));
  visible = false;
  act(() => document.dispatchEvent(new dom.window.Event('visibilitychange')));
  view.rerender({ input: request, suspended: true });
  await act(async () => t.mock.timers.tick(70_000));
  assert.equal(service.mock.callCount(), 2);
  visible = true;
  view.rerender({ input: request, suspended: false });
  await act(async () => t.mock.timers.tick(0));
  assert.equal(view.result.current.coolingDown, false);
  assert.equal(service.mock.callCount(), 2);
  await act(async () => window.dispatchEvent(new dom.window.Event('focus')));
  assert.equal(view.result.current.coolingDown, true);
  await act(async () => view.rerender({ input: { ...request, tokenId: 777 }, suspended: false }));
  assert.equal(view.result.current.status?.tokenId, 777);
  assert.equal(view.result.current.coolingDown, false);
  const reads = service.mock.callCount();
  view.unmount();
  await act(async () => t.mock.timers.tick(120_000));
  assert.equal(service.mock.callCount(), reads);
});
