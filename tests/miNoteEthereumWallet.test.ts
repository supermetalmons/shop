import assert from 'node:assert/strict';
import test, { afterEach, beforeEach } from 'node:test';
import { setupFrontendDom } from './helpers/frontendDom.ts';
import type { EIP1193Provider, EIP6963ProviderDetail, EthereumProviderListener } from '../src/wallet/injectedEthereumProviders.ts';

let { dom } = setupFrontendDom();
const { act, cleanup, renderHook, waitFor } = await import('@testing-library/react');
const { createElement, Profiler } = await import('react');
const { useMiNoteEthereumWallet } = await import('../src/hooks/useMiNoteEthereumWallet.ts');
const { getInjectedWalletIconSrc, listInjectedEthereumProviders } = await import('../src/wallet/injectedEthereumProviders.ts');
dom.window.close();

const ADDRESS = '0x000533f50ddd7f2fc4EfD06137b0c1A12CfB7Bb9';
const OTHER_ADDRESS = '0x1111111111111111111111111111111111111111';
const STORAGE_KEY = 'mons.shop.mi-note.ethereum-wallet';

beforeEach(() => { ({ dom } = setupFrontendDom()); });
afterEach(() => {
  cleanup();
  dom.window.close();
});

function makeWallet(uuid = 'first', rdns = 'com.example.wallet') {
  const listeners = new Map<string, Set<EthereumProviderListener>>();
  const requests: Array<{ method: string; resolve: (value: unknown) => void; reject: (error: unknown) => void }> = [];
  const provider: EIP1193Provider = {
    request: ({ method }) => new Promise((resolve, reject) => { requests.push({ method, resolve, reject }); }),
    on(event, listener) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(listener);
    },
    removeListener(event, listener) { listeners.get(event)?.delete(listener); },
  };
  const wallet: EIP6963ProviderDetail = { info: { uuid, rdns, name: `${uuid} wallet`, icon: 'data:image/png;base64,AA==' }, provider };
  return {
    wallet,
    requests,
    listeners,
    announce() { window.dispatchEvent(new dom.window.CustomEvent('eip6963:announceProvider', { detail: wallet })); },
    install() { window.addEventListener('eip6963:requestProvider', this.announce); },
    emit(event: string, value?: unknown) { for (const listener of [...listeners.get(event) ?? []]) listener(value); },
    listenerCount() { return [...listeners.values()].reduce((sum, group) => sum + group.size, 0); },
  };
}

type MockWallet = ReturnType<typeof makeWallet>;

function setLegacy(wallet: MockWallet) {
  Object.defineProperty(window, 'ethereum', { configurable: true, value: wallet.wallet.provider });
}

async function waitForRequests(wallet: MockWallet, count = 1) {
  await waitFor(() => assert.equal(wallet.requests.length, count));
}

async function settle(wallet: MockWallet, index = 0, accounts: unknown = [ADDRESS]) {
  await act(async () => { wallet.requests[index].resolve(accounts); });
}

function renderWallet(active = true, reactStrictMode = false) {
  type Snapshot = { active: boolean; ready: boolean; status: string; address: string | null };
  const commits: Snapshot[] = [];
  let snapshot: Snapshot;
  const view = renderHook(({ active }) => {
    const wallet = useMiNoteEthereumWallet(active);
    snapshot = { active, ready: wallet.ready, status: wallet.status, address: wallet.address };
    return wallet;
  }, {
    initialProps: { active },
    reactStrictMode,
    wrapper: ({ children }) => createElement(Profiler, { id: 'wallet', onRender: () => commits.push(snapshot) }, children),
  });
  return { ...view, commits };
}

test('a fresh activation resolves readiness without requesting accounts when no wallet is remembered', () => {
  const wallet = makeWallet();
  wallet.install();
  const { result, commits, rerender } = renderWallet();
  assert.equal(commits[0].ready, false);
  assert.equal(result.current.ready, true);
  assert.equal(result.current.status, 'disconnected');
  rerender({ active: false });
  const activationStart = commits.length;
  rerender({ active: true });
  assert.equal(commits[activationStart].ready, false);
  assert.equal(result.current.ready, true);
  assert.equal(wallet.requests.length, 0);
});

test('remembered wallet readiness stays unresolved through the initial commit, discovery, and passive account read', async () => {
  const wallet = makeWallet();
  wallet.install();
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ type: 'announced', rdns: wallet.wallet.info.rdns }));
  const { result, commits } = renderWallet();
  assert.deepEqual(commits[0], { active: true, ready: false, status: 'disconnected', address: null });
  assert.equal(wallet.requests.length, 0);
  assert.ok(commits.every(({ ready }) => !ready));
  await waitForRequests(wallet);
  assert.equal(wallet.requests[0].method, 'eth_accounts');
  assert.equal(result.current.ready, false);
  assert.ok(commits.every(({ ready }) => !ready));
  await settle(wallet);
  assert.equal(result.current.ready, true);
  assert.ok(commits.filter(({ ready }) => ready).every(({ status, address }) => status === 'connected' && address === ADDRESS.toLowerCase()));
});

test('returning after an earlier resolved activation is unresolved from its first commit while a saved wallet restores', async () => {
  const wallet = makeWallet();
  wallet.install();
  const { result, commits, rerender } = renderWallet();
  assert.equal(result.current.ready, true);
  rerender({ active: false });
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ type: 'announced', rdns: wallet.wallet.info.rdns }));
  const activationStart = commits.length;
  rerender({ active: true });
  assert.equal(commits[activationStart].ready, false);
  await waitForRequests(wallet);
  assert.ok(commits.slice(activationStart).every(({ ready }) => !ready));
  await settle(wallet);
  assert.equal(result.current.ready, true);
  assert.equal(result.current.address, ADDRESS.toLowerCase());
});

test('inactive Mi Notes never discover providers or request accounts', () => {
  const wallet = makeWallet();
  wallet.install();
  let discoveries = 0;
  window.addEventListener('eip6963:requestProvider', () => { discoveries += 1; });
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ type: 'announced', rdns: wallet.wallet.info.rdns }));
  const { result } = renderHook(() => useMiNoteEthereumWallet(false));
  act(() => result.current.connect());
  assert.equal(result.current.status, 'disconnected');
  assert.equal(discoveries, 0);
  assert.equal(wallet.requests.length, 0);
});

test('no installed provider shows an actionable error and allows discovery on retry', async () => {
  const { result } = renderHook(() => useMiNoteEthereumWallet(true));
  act(() => result.current.connect());
  await waitFor(() => assert.match(result.current.error ?? '', /No Ethereum wallet found/));
  const wallet = makeWallet();
  wallet.install();
  act(() => result.current.connect());
  assert.equal(result.current.error, null);
  await waitForRequests(wallet);
  await settle(wallet);
  assert.equal(result.current.status, 'connected');
});

test('one announced wallet connects explicitly, normalizes its account, remembers rdns, and ignores double clicks', async () => {
  const wallet = makeWallet();
  wallet.install();
  const { result } = renderHook(() => useMiNoteEthereumWallet(true));
  assert.equal(wallet.requests.length, 0);
  act(() => {
    result.current.connect();
    result.current.connect();
  });
  await waitForRequests(wallet);
  assert.equal(wallet.requests[0].method, 'eth_requestAccounts');
  act(() => result.current.connect());
  assert.equal(wallet.requests.length, 1);
  await settle(wallet);
  assert.equal(result.current.address, ADDRESS.toLowerCase());
  assert.equal(result.current.status, 'connected');
  assert.deepEqual(JSON.parse(window.localStorage.getItem(STORAGE_KEY)!), { type: 'announced', rdns: 'com.example.wallet' });
});

test('wallets sharing an rdns remain separate choices and only the selected wallet is requested', async () => {
  const first = makeWallet('first');
  const second = makeWallet('second');
  first.install();
  second.install();
  const { result } = renderHook(() => useMiNoteEthereumWallet(true));
  act(() => result.current.connect());
  await waitFor(() => assert.equal(result.current.status, 'choosing'));
  assert.deepEqual(result.current.wallets.map((wallet) => wallet.info.uuid), ['first', 'second']);
  assert.equal(first.requests.length + second.requests.length, 0);
  act(() => {
    const selected = result.current.wallets[1];
    result.current.selectWallet(selected);
    result.current.selectWallet(selected);
  });
  assert.equal(first.requests.length, 0);
  assert.equal(second.requests.length, 1);
  await settle(second);
  assert.equal(result.current.status, 'connected');
});

test('picker discovers late announcements, deduplicates UUIDs, and cancels without a wallet request', async () => {
  const first = makeWallet('first');
  const second = makeWallet('second', 'org.second');
  first.install();
  second.install();
  const { result } = renderHook(() => useMiNoteEthereumWallet(true));
  act(() => result.current.connect());
  await waitFor(() => assert.equal(result.current.status, 'choosing'));
  const late = makeWallet('late', 'org.late');
  act(() => {
    first.announce();
    late.announce();
  });
  assert.equal(result.current.wallets.length, 3);
  act(() => result.current.cancel());
  assert.equal(result.current.status, 'disconnected');
  assert.equal(result.current.wallets.length, 0);
  assert.equal(first.requests.length + second.requests.length + late.requests.length, 0);
});

test('legacy fallback requests accounts only when no announced wallet is found', async () => {
  const legacy = makeWallet();
  setLegacy(legacy);
  const { result, unmount } = renderHook(() => useMiNoteEthereumWallet(true));
  act(() => result.current.connect());
  await waitForRequests(legacy);
  await settle(legacy);
  assert.deepEqual(JSON.parse(window.localStorage.getItem(STORAGE_KEY)!), { type: 'legacy' });
  act(() => result.current.disconnect());
  unmount();
  const announced = makeWallet('announced');
  announced.install();
  const next = renderHook(() => useMiNoteEthereumWallet(true));
  act(() => next.result.current.connect());
  await waitForRequests(announced);
  assert.equal(legacy.requests.length, 1);
});

test('cancel during discovery never opens a wallet prompt', async () => {
  const wallet = makeWallet();
  wallet.install();
  const { result } = renderHook(() => useMiNoteEthereumWallet(true));
  act(() => {
    result.current.connect();
    result.current.cancel();
  });
  await act(async () => { await listInjectedEthereumProviders(); });
  assert.equal(wallet.requests.length, 0);
  assert.equal(result.current.status, 'disconnected');
});

test('cancel and tab switching detach pending sessions and ignore stale account responses', async () => {
  const wallet = makeWallet();
  wallet.install();
  const { result, rerender } = renderHook(({ active }) => useMiNoteEthereumWallet(active), { initialProps: { active: true } });
  act(() => result.current.connect());
  await waitForRequests(wallet);
  assert.equal(wallet.listenerCount(), 3);
  act(() => result.current.cancel());
  assert.equal(wallet.listenerCount(), 0);
  await settle(wallet);
  assert.equal(result.current.address, null);
  assert.equal(window.localStorage.getItem(STORAGE_KEY), null);
  act(() => result.current.connect());
  await waitForRequests(wallet, 2);
  rerender({ active: false });
  assert.equal(wallet.listenerCount(), 0);
  await settle(wallet, 1);
  assert.equal(result.current.address, null);
  assert.equal(result.current.status, 'disconnected');
});

test('switching tabs retains an established wallet and continues to reflect its account changes', async () => {
  const wallet = makeWallet();
  wallet.install();
  const { result, rerender, commits } = renderWallet();
  act(() => result.current.connect());
  await waitForRequests(wallet);
  await settle(wallet);
  rerender({ active: false });
  assert.equal(result.current.address, ADDRESS.toLowerCase());
  assert.equal(wallet.listenerCount(), 3);
  act(() => wallet.emit('accountsChanged', [OTHER_ADDRESS]));
  assert.equal(result.current.address, OTHER_ADDRESS);
  const activationStart = commits.length;
  rerender({ active: true });
  assert.ok(commits.slice(activationStart).every(({ ready, address }) => ready && address === OTHER_ADDRESS));
  assert.equal(wallet.requests.length, 1);
});

test('rejected requests release listeners and permit a successful retry', async () => {
  const wallet = makeWallet();
  wallet.install();
  const { result } = renderHook(() => useMiNoteEthereumWallet(true));
  act(() => result.current.connect());
  await waitForRequests(wallet);
  await act(async () => { wallet.requests[0].reject({ code: 4001 }); });
  assert.match(result.current.error!, /cancelled/);
  assert.equal(wallet.listenerCount(), 0);
  act(() => result.current.connect());
  assert.equal(result.current.error, null);
  await waitForRequests(wallet, 2);
  await settle(wallet, 1);
  assert.equal(result.current.status, 'connected');
});

test('invalid account responses never connect or save a wallet', async () => {
  const wallet = makeWallet();
  wallet.install();
  const { result } = renderHook(() => useMiNoteEthereumWallet(true));
  act(() => result.current.connect());
  await waitForRequests(wallet);
  await settle(wallet, 0, ['invalid', ADDRESS]);
  assert.equal(result.current.address, null);
  assert.match(result.current.error!, /No Ethereum account/);
  assert.equal(window.localStorage.getItem(STORAGE_KEY), null);
});

test('remembered wallet restores only on entering Your and derives its account from eth_accounts', async () => {
  const wallet = makeWallet('new-session-uuid');
  wallet.install();
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ type: 'announced', rdns: wallet.wallet.info.rdns, address: OTHER_ADDRESS }));
  const { result, rerender, commits } = renderWallet(false);
  assert.equal(wallet.requests.length, 0);
  const activationStart = commits.length;
  rerender({ active: true });
  assert.equal(commits[activationStart].ready, false);
  assert.equal(result.current.status, 'restoring');
  await waitForRequests(wallet);
  assert.ok(commits.slice(activationStart).every(({ ready }) => !ready));
  assert.equal(wallet.requests[0].method, 'eth_accounts');
  await settle(wallet);
  assert.equal(result.current.ready, true);
  assert.equal(result.current.address, ADDRESS.toLowerCase());
});

for (const scenario of ['missing', 'ambiguous', 'legacy-with-announcement'] as const) {
  test(`${scenario} remembered wallet does not restore or request permission`, async () => {
    const first = makeWallet();
    const second = makeWallet('second');
    first.install();
    if (scenario === 'ambiguous') second.install();
    setLegacy(second);
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(scenario === 'legacy-with-announcement'
      ? { type: 'legacy' }
      : { type: 'announced', rdns: scenario === 'missing' ? 'org.missing' : first.wallet.info.rdns }));
    const { result } = renderHook(() => useMiNoteEthereumWallet(true));
    assert.equal(result.current.ready, false);
    await waitFor(() => assert.equal(result.current.status, 'disconnected'));
    assert.equal(result.current.ready, true);
    assert.equal(first.requests.length + second.requests.length, 0);
    assert.equal(result.current.error, null);
  });
}

test('legacy remembered wallet restores quietly, and disconnect removes the remembered choice', async () => {
  const wallet = makeWallet();
  setLegacy(wallet);
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ type: 'legacy' }));
  const { result } = renderHook(() => useMiNoteEthereumWallet(true));
  await waitForRequests(wallet);
  assert.equal(wallet.requests[0].method, 'eth_accounts');
  await settle(wallet);
  act(() => result.current.disconnect());
  assert.equal(result.current.address, null);
  assert.equal(wallet.listenerCount(), 0);
  assert.equal(window.localStorage.getItem(STORAGE_KEY), null);
});

for (const scenario of ['unavailable', 'rejected'] as const) {
  test(`${scenario} accounts during restoration return to Connect without an error or permission request`, async () => {
    const wallet = makeWallet();
    wallet.install();
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ type: 'announced', rdns: wallet.wallet.info.rdns }));
    const { result } = renderHook(() => useMiNoteEthereumWallet(true));
    await waitForRequests(wallet);
    assert.equal(result.current.ready, false);
    await act(async () => {
      if (scenario === 'unavailable') wallet.requests[0].resolve([]);
      else wallet.requests[0].reject(new Error('locked'));
    });
    assert.equal(result.current.status, 'disconnected');
    assert.equal(result.current.ready, true);
    assert.equal(result.current.error, null);
    assert.deepEqual(wallet.requests.map(({ method }) => method), ['eth_accounts']);
    assert.equal(wallet.listenerCount(), 0);
  });
}

test('blocked local storage never prevents explicit connection or disconnect', async () => {
  const wallet = makeWallet();
  wallet.install();
  Object.defineProperty(window, 'localStorage', { configurable: true, get() { throw new Error('Storage blocked'); } });
  const { result } = renderHook(() => useMiNoteEthereumWallet(true));
  act(() => result.current.connect());
  await waitForRequests(wallet);
  await settle(wallet);
  assert.equal(result.current.status, 'connected');
  act(() => result.current.disconnect());
  assert.equal(result.current.status, 'disconnected');
});

test('malformed saved choices and blocked storage writes do not prevent connection', async () => {
  const wallet = makeWallet();
  wallet.install();
  window.localStorage.setItem(STORAGE_KEY, '{');
  const storagePrototype = Object.getPrototypeOf(window.localStorage);
  const originalSetItem = storagePrototype.setItem;
  storagePrototype.setItem = () => { throw new Error('Storage full'); };
  try {
    const { result } = renderHook(() => useMiNoteEthereumWallet(true));
    assert.equal(result.current.status, 'disconnected');
    act(() => result.current.connect());
    await waitForRequests(wallet);
    await settle(wallet);
    assert.equal(result.current.address, ADDRESS.toLowerCase());
  } finally {
    storagePrototype.setItem = originalSetItem;
  }
});

test('leaving Your during restoration discards that account read even after a fresh restoration starts', async () => {
  const wallet = makeWallet();
  wallet.install();
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ type: 'announced', rdns: wallet.wallet.info.rdns }));
  const { result, rerender, commits } = renderWallet();
  await waitForRequests(wallet);
  rerender({ active: false });
  assert.equal(wallet.listenerCount(), 0);
  const activationStart = commits.length;
  rerender({ active: true });
  assert.equal(commits[activationStart].ready, false);
  await waitForRequests(wallet, 2);
  assert.ok(commits.slice(activationStart).every(({ ready }) => !ready));
  await settle(wallet, 1, [OTHER_ADDRESS]);
  await settle(wallet);
  assert.equal(result.current.ready, true);
  assert.equal(result.current.address, OTHER_ADDRESS);
  assert.equal(wallet.listenerCount(), 3);
});

test('account events supersede initial account reads, including clearing an account before a stale success', async () => {
  const wallet = makeWallet();
  wallet.install();
  const { result } = renderHook(() => useMiNoteEthereumWallet(true));
  act(() => result.current.connect());
  await waitForRequests(wallet);
  act(() => wallet.emit('accountsChanged', [OTHER_ADDRESS]));
  await settle(wallet);
  assert.equal(result.current.address, OTHER_ADDRESS);
  act(() => result.current.disconnect());
  act(() => result.current.connect());
  await waitForRequests(wallet, 2);
  act(() => wallet.emit('accountsChanged', []));
  await settle(wallet, 1);
  assert.equal(result.current.address, null);
  assert.equal(wallet.listenerCount(), 0);
  assert.equal(window.localStorage.getItem(STORAGE_KEY), null);
});

test('chain changes during a permission request preserve the pending approval, then re-read accounts once connected', async () => {
  const wallet = makeWallet();
  wallet.install();
  const { result } = renderHook(() => useMiNoteEthereumWallet(true));
  act(() => result.current.connect());
  await waitForRequests(wallet);
  act(() => wallet.emit('chainChanged', '0x1'));
  assert.deepEqual(wallet.requests.map(({ method }) => method), ['eth_requestAccounts']);
  assert.equal(result.current.status, 'connecting');
  await settle(wallet);
  assert.equal(result.current.address, ADDRESS.toLowerCase());
  assert.equal(result.current.status, 'connected');
  act(() => wallet.emit('chainChanged', '0xa'));
  assert.equal(wallet.requests[1].method, 'eth_accounts');
  await settle(wallet, 1, [OTHER_ADDRESS]);
  assert.equal(result.current.address, OTHER_ADDRESS);
});

test('chain changes during quiet restoration re-read accounts and supersede the initial passive response', async () => {
  const wallet = makeWallet();
  wallet.install();
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ type: 'announced', rdns: wallet.wallet.info.rdns }));
  const { result } = renderHook(() => useMiNoteEthereumWallet(true));
  await waitForRequests(wallet);
  act(() => wallet.emit('chainChanged', '0xa'));
  assert.deepEqual(wallet.requests.map(({ method }) => method), ['eth_accounts', 'eth_accounts']);
  await settle(wallet, 1, [OTHER_ADDRESS]);
  await settle(wallet);
  assert.equal(result.current.address, OTHER_ADDRESS);
  assert.equal(result.current.status, 'connected');
});

test('chain changes re-read accounts and ignore reads superseded by newer account events or chain changes', async () => {
  const wallet = makeWallet();
  wallet.install();
  const { result } = renderHook(() => useMiNoteEthereumWallet(true));
  act(() => result.current.connect());
  await waitForRequests(wallet);
  await settle(wallet);
  act(() => wallet.emit('chainChanged', '0xa'));
  assert.equal(wallet.requests[1].method, 'eth_accounts');
  act(() => wallet.emit('accountsChanged', [OTHER_ADDRESS]));
  await settle(wallet, 1);
  assert.equal(result.current.address, OTHER_ADDRESS);
  act(() => {
    wallet.emit('chainChanged', '0x1');
    wallet.emit('chainChanged', '0x89');
  });
  await settle(wallet, 3);
  await settle(wallet, 2, [OTHER_ADDRESS]);
  assert.equal(result.current.address, ADDRESS.toLowerCase());
  act(() => wallet.emit('disconnect', { code: 4900 }));
  assert.equal(result.current.status, 'disconnected');
  assert.equal(wallet.listenerCount(), 0);
});

test('unmount detaches a pending wallet and never remembers its later response', async () => {
  const wallet = makeWallet();
  wallet.install();
  const { result, unmount } = renderHook(() => useMiNoteEthereumWallet(true));
  act(() => result.current.connect());
  await waitForRequests(wallet);
  const connect = result.current.connect;
  unmount();
  assert.equal(wallet.listenerCount(), 0);
  await settle(wallet);
  connect();
  assert.equal(wallet.requests.length, 1);
  assert.equal(window.localStorage.getItem(STORAGE_KEY), null);
});

test('StrictMode restoration requests one current account read and retains only one set of listeners', async () => {
  const wallet = makeWallet();
  wallet.install();
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ type: 'announced', rdns: wallet.wallet.info.rdns }));
  const { result, unmount, commits } = renderWallet(true, true);
  assert.equal(commits[0].ready, false);
  await waitForRequests(wallet);
  assert.ok(commits.every(({ ready }) => !ready));
  await settle(wallet);
  assert.equal(result.current.ready, true);
  assert.equal(result.current.status, 'connected');
  assert.equal(wallet.requests.length, 1);
  assert.equal(wallet.listenerCount(), 3);
  unmount();
  assert.equal(wallet.listenerCount(), 0);
});

test('discovery rejects malformed announcements and remote wallet icons', async () => {
  const wallet = makeWallet();
  window.addEventListener('eip6963:requestProvider', () => {
    for (const detail of [null, {}, { info: wallet.wallet.info, provider: {} }, { provider: wallet.wallet.provider, info: { name: 'No UUID' } }]) {
      window.dispatchEvent(new dom.window.CustomEvent('eip6963:announceProvider', { detail }));
    }
    wallet.announce();
    wallet.announce();
  });
  assert.deepEqual(await listInjectedEthereumProviders(), [wallet.wallet]);
  assert.equal(getInjectedWalletIconSrc('https://example.com/icon.svg'), null);
  assert.equal(getInjectedWalletIconSrc('javascript:alert(1)'), null);
  assert.equal(getInjectedWalletIconSrc(wallet.wallet.info.icon), wallet.wallet.info.icon);
});

test('repeated discovery allows newly installed wallets time to announce alongside cached providers', async () => {
  const first = makeWallet();
  first.install();
  assert.equal((await listInjectedEthereumProviders()).length, 1);
  const second = makeWallet('late', 'org.late');
  window.addEventListener('eip6963:requestProvider', () => { window.setTimeout(second.announce, 30); });
  assert.deepEqual((await listInjectedEthereumProviders()).map((wallet) => wallet.info.uuid), ['first', 'late']);
});
