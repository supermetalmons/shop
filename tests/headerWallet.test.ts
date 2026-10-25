import assert from 'node:assert/strict';
import test, { after, afterEach, mock } from 'node:test';
import { createElement, useRef, useState, type PropsWithChildren } from 'react';
import { Connection, PublicKey } from '@solana/web3.js';
import { setupFrontendDom } from './helpers/frontendDom.ts';

const { dom } = setupFrontendDom();
const { act, cleanup, fireEvent, render, renderHook, waitFor } = await import('@testing-library/react');
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
const { useHeaderWallet } = await import('../src/shop/account/useHeaderWallet.ts');
const { ShopWalletControl } = await import('../src/shop/ui/ShopWalletControl.tsx');
const { useMainnetSolBalance } = await import('../src/shop/account/useMainnetSolBalance.ts');
const { saveStaffWalletSession } = await import('../src/lib/staffWalletSession.ts');
const clients: InstanceType<typeof QueryClient>[] = [];
const walletA = new PublicKey(new Uint8Array(32).fill(1));
const walletB = new PublicKey(new Uint8Array(32).fill(2));

afterEach(() => {
  cleanup();
  mock.restoreAll();
  clients.splice(0).forEach(client => client.clear());
  window.localStorage.clear();
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
});
after(() => dom.window.close());

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function queryWrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  const wrapper = ({ children }: PropsWithChildren) => createElement(QueryClientProvider, { client }, children);
  return { client, wrapper };
}

function headerRig({ session = walletA.toBase58(), connected = true }: { session?: string | null; connected?: boolean } = {}) {
  mock.method(Connection.prototype, 'getAccountInfo', async () => null);
  const calls: string[] = [];
  const messages: string[] = [];
  const disconnectingChanges: boolean[] = [];
  const runtime = {
    signOut: async () => undefined,
    disconnect: async () => undefined,
    signIn: async (_request?: { signal?: AbortSignal }) => true,
    refreshProfileState: async () => true,
  };
  const signInSignals: Array<AbortSignal | undefined> = [];
  const initial = {
    mutationPending: false, suspended: false, scopeKey: '/', resolving: false, disabled: false,
    error: null as string | null, connecting: false, disconnecting: false,
    walletModalVisible: false, signInPending: false,
  };
  const view = renderHook((props: typeof initial) => {
    const [account, setAccount] = useState(session);
    const [connectedKey, setConnectedKey] = useState<PublicKey | null>(connected ? new PublicKey(session ?? walletA) : null);
    const controller = useRef(new AbortController());
    const [signal, setSignal] = useState(controller.current.signal);
    const rotateIntent = () => {
      const previous = controller.current;
      controller.current = new AbortController();
      setSignal(controller.current.signal);
      previous.abort();
    };
    const model = useHeaderWallet({
      ...props,
      auth: {
        authenticated: Boolean(account),
        sessionWallet: account,
        sessionResolution: props.disabled ? 'disabled' : props.resolving ? 'resolving' : 'settled',
        error: props.error,
        refreshProfileState: async () => { calls.push('refresh'); return runtime.refreshProfileState(); },
        intentCancellationSignal: signal,
        signOut: async () => {
          calls.push('sign-out');
          rotateIntent();
          setAccount(null);
          await runtime.signOut();
        },
      },
      wallet: {
        connected: Boolean(connectedKey),
        publicKey: connectedKey,
        connecting: props.connecting,
        disconnecting: props.disconnecting,
        wallet: null,
        disconnect: async () => {
          calls.push('disconnect');
          await runtime.disconnect();
          setConnectedKey(null);
        },
      },
      signIn: async (request) => {
        calls.push('sign-in');
        signInSignals.push(request?.signal);
        return runtime.signIn(request);
      },
      onBeforeOpen: () => calls.push('before-open'),
      onBeforeDisconnect: () => calls.push('before-disconnect'),
      onDisconnectingChange: pending => disconnectingChanges.push(pending),
      showToast: message => messages.push(message),
    });
    return {
      model,
      account,
      connectedKey,
      restoreSession: (address: string) => setAccount(address),
      connectWallet: (key: PublicKey) => setConnectedKey(key),
      invalidateIntent: rotateIntent,
      replaceSession: (address: string) => { rotateIntent(); setAccount(address); },
      replaceWallet: (key: PublicKey) => { rotateIntent(); setConnectedKey(key); setAccount(key.toBase58()); },
    };
  }, { initialProps: initial, ...queryWrapper() });
  return { ...view, initial, runtime, calls, messages, disconnectingChanges, signInSignals };
}

test('an early click stays enabled and transitions from loading into a restored account', async () => {
  const rig = headerRig({ session: null, connected: false });
  rig.rerender({ ...rig.initial, disabled: true });
  assert.equal(rig.result.current.model.buttonDisabled, false);
  await act(async () => { await rig.result.current.model.activate(); });
  assert.equal(rig.result.current.model.open, true);
  assert.equal(rig.result.current.model.status, 'loading');
  assert.equal(rig.result.current.model.address, undefined);
  assert.deepEqual(rig.calls, ['before-open']);
  rig.rerender({ ...rig.initial, resolving: true });
  act(() => rig.result.current.restoreSession(walletA.toBase58()));
  rig.rerender(rig.initial);
  assert.equal(rig.result.current.model.open, true);
  assert.equal(rig.result.current.model.status, 'account');
  assert.equal(rig.result.current.model.address, walletA.toBase58());
  assert.equal(rig.calls.includes('sign-in'), false);
});

test('an early signed-out click automatically starts one sign-in after restoration settles', async () => {
  const rig = headerRig({ session: null, connected: false });
  const signing = deferred<boolean>();
  rig.runtime.signIn = () => signing.promise;
  rig.rerender({ ...rig.initial, resolving: true });
  await act(async () => { await rig.result.current.model.activate(); });
  assert.equal(rig.calls.includes('sign-in'), false);
  rig.rerender(rig.initial);
  await waitFor(() => assert.equal(rig.calls.filter(value => value === 'sign-in').length, 1));
  assert.equal(rig.result.current.model.open, true);
  assert.equal(rig.result.current.model.buttonDisabled, false);
  assert.ok(['connecting', 'signing-in'].includes(rig.result.current.model.status));
  assert.ok(rig.signInSignals[0]);
  rig.rerender({ ...rig.initial });
  assert.deepEqual(rig.calls, ['before-open', 'sign-in']);
  act(() => {
    rig.result.current.connectWallet(walletA);
    rig.result.current.restoreSession(walletA.toBase58());
  });
  await act(async () => { signing.resolve(true); });
  assert.equal(rig.result.current.model.open, true);
  assert.equal(rig.result.current.model.status, 'account');
  assert.equal(rig.result.current.model.buttonDisabled, false);
});

test('a late adapter connection to the restored account keeps its popup open', async () => {
  const rig = headerRig({ session: null, connected: false });
  rig.rerender({ ...rig.initial, resolving: true });
  await act(async () => { await rig.result.current.model.activate(); });
  act(() => rig.result.current.restoreSession(walletA.toBase58()));
  rig.rerender(rig.initial);
  assert.equal(rig.result.current.model.open, true);
  assert.equal(rig.result.current.model.status, 'account');
  act(() => rig.result.current.connectWallet(walletA));
  assert.equal(rig.result.current.model.open, true);
  assert.equal(rig.result.current.model.address, walletA.toBase58());
  assert.equal(rig.calls.includes('sign-in'), false);
});

test('an owned wallet picker hides the popup and successful sign-in returns to its account', async () => {
  const rig = headerRig({ session: null, connected: false });
  const signing = deferred<boolean>();
  rig.runtime.signIn = () => signing.promise;
  await act(async () => { await rig.result.current.model.activate(); });
  rig.rerender({ ...rig.initial, walletModalVisible: true });
  assert.equal(rig.result.current.model.open, false);
  assert.equal(rig.result.current.model.buttonDisabled, true);
  assert.equal(rig.signInSignals[0]?.aborted, false);
  rig.rerender({ ...rig.initial, connecting: true });
  assert.equal(rig.result.current.model.open, true);
  assert.equal(rig.result.current.model.status, 'connecting');
  act(() => rig.result.current.connectWallet(walletA));
  rig.rerender(rig.initial);
  assert.equal(rig.result.current.model.status, 'signing-in');
  act(() => rig.result.current.restoreSession(walletA.toBase58()));
  await act(async () => { signing.resolve(true); });
  assert.equal(rig.result.current.model.open, true);
  assert.equal(rig.result.current.model.status, 'account');
  assert.equal(rig.calls.filter(value => value === 'sign-in').length, 1);
});

test('an external wallet picker after successful sign-in closes the account popup', async () => {
  const rig = headerRig({ session: null });
  const signing = deferred<boolean>();
  rig.runtime.signIn = () => signing.promise;
  await act(async () => { await rig.result.current.model.activate(); });
  act(() => rig.result.current.restoreSession(walletA.toBase58()));
  await act(async () => { signing.resolve(true); });
  assert.equal(rig.result.current.model.open, true);
  assert.equal(rig.result.current.model.status, 'account');
  rig.rerender({ ...rig.initial, walletModalVisible: true });
  assert.equal(rig.result.current.model.open, false);
  rig.rerender(rig.initial);
  assert.equal(rig.result.current.model.open, false);
  assert.equal(rig.calls.filter(value => value === 'sign-in').length, 1);
});

for (const outcome of ['picker cancelled', 'signature rejected'] as const) {
  test(`${outcome} closes the popup without restarting sign-in`, async () => {
    const rig = headerRig({ session: null, connected: outcome === 'signature rejected' });
    const signing = deferred<boolean>();
    rig.runtime.signIn = () => signing.promise;
    await act(async () => { await rig.result.current.model.activate(); });
    if (outcome === 'picker cancelled') rig.rerender({ ...rig.initial, walletModalVisible: true });
    await act(async () => { signing.resolve(false); });
    rig.rerender(rig.initial);
    assert.equal(rig.result.current.model.open, false);
    assert.equal(rig.result.current.model.buttonDisabled, false);
    assert.equal(rig.calls.filter(value => value === 'sign-in').length, 1);
    assert.deepEqual(rig.messages, []);
  });
}

for (const reason of ['close', 'toggle', 'route', 'overlay', 'pagehide', 'identity', 'unmount'] as const) {
  test(`${reason} cancels an early click before readiness without a later sign-in`, async () => {
    const rig = headerRig({ session: null, connected: false });
    rig.rerender({ ...rig.initial, resolving: true });
    await act(async () => { await rig.result.current.model.activate(); });
    if (reason === 'close') act(() => rig.result.current.model.close());
    else if (reason === 'toggle') await act(async () => { await rig.result.current.model.activate(); });
    else if (reason === 'route') rig.rerender({ ...rig.initial, resolving: true, scopeKey: '/other' });
    else if (reason === 'overlay') rig.rerender({ ...rig.initial, resolving: true, suspended: true });
    else if (reason === 'pagehide') act(() => window.dispatchEvent(new dom.window.Event('pagehide')));
    else if (reason === 'identity') act(() => rig.result.current.invalidateIntent());
    else rig.unmount();
    if (reason !== 'unmount') {
      rig.rerender({ ...rig.initial, scopeKey: reason === 'route' ? '/other' : '/' });
      assert.equal(rig.result.current.model.open, false);
    }
    assert.equal(rig.calls.includes('sign-in'), false);
  });
}

test('rapid toggles during initial loading close the popup without starting sign-in', async () => {
  const rig = headerRig({ session: null, connected: false });
  rig.rerender({ ...rig.initial, resolving: true });
  await act(async () => {
    await rig.result.current.model.activate();
    await rig.result.current.model.activate();
  });
  rig.rerender(rig.initial);
  assert.equal(rig.result.current.model.open, false);
  assert.equal(rig.calls.includes('sign-in'), false);
});

test('closing an in-flight sign-in aborts its request and ignores a late success', async () => {
  const rig = headerRig({ session: null, connected: false });
  const signing = deferred<boolean>();
  rig.runtime.signIn = () => signing.promise;
  await act(async () => { await rig.result.current.model.activate(); });
  assert.equal(rig.signInSignals[0]?.aborted, false);
  act(() => rig.result.current.model.close());
  assert.equal(rig.signInSignals[0]?.aborted, true);
  await act(async () => {
    rig.result.current.connectWallet(walletA);
    rig.result.current.restoreSession(walletA.toBase58());
    signing.resolve(true);
  });
  assert.equal(rig.result.current.model.open, false);
  assert.equal(rig.calls.filter(value => value === 'sign-in').length, 1);
});

test('account replacement aborts an in-flight sign-in and does not reopen its popup', async () => {
  const rig = headerRig({ session: null });
  const signing = deferred<boolean>();
  rig.runtime.signIn = () => signing.promise;
  await act(async () => { await rig.result.current.model.activate(); });
  act(() => rig.result.current.replaceWallet(walletB));
  assert.equal(rig.signInSignals[0]?.aborted, true);
  await act(async () => { signing.resolve(true); });
  assert.equal(rig.result.current.model.open, false);
  assert.equal(rig.result.current.account, walletB.toBase58());
});

test('an unrelated wallet picker cancels a queued early click', async () => {
  const rig = headerRig({ session: null, connected: false });
  rig.rerender({ ...rig.initial, resolving: true });
  await act(async () => { await rig.result.current.model.activate(); });
  rig.rerender({ ...rig.initial, resolving: true, walletModalVisible: true });
  assert.equal(rig.result.current.model.open, false);
  rig.rerender(rig.initial);
  assert.equal(rig.result.current.model.open, false);
  assert.equal(rig.calls.includes('sign-in'), false);
});

test('restoration failures remain visible and retry into the existing popup', async () => {
  const rig = headerRig({ session: null, connected: false });
  const refreshing = deferred<boolean>();
  rig.runtime.refreshProfileState = () => refreshing.promise;
  rig.rerender({ ...rig.initial, resolving: true, error: 'Network unavailable' });
  await act(async () => { await rig.result.current.model.activate(); });
  assert.equal(rig.result.current.model.open, true);
  assert.equal(rig.result.current.model.buttonDisabled, false);
  assert.equal(rig.result.current.model.status, 'error');
  assert.equal(rig.result.current.model.loadingError, 'Network unavailable');
  act(() => {
    rig.result.current.model.retryLoading();
    rig.result.current.model.retryLoading();
  });
  assert.equal(rig.result.current.model.status, 'loading');
  assert.equal(rig.calls.filter(value => value === 'refresh').length, 1);
  await act(async () => {
    rig.result.current.restoreSession(walletA.toBase58());
    rig.rerender(rig.initial);
    refreshing.resolve(true);
  });
  assert.equal(rig.result.current.model.status, 'account');
  assert.equal(rig.result.current.model.open, true);
  assert.equal(rig.calls.includes('sign-in'), false);
});

test('dismissal during a restoration retry prevents a late popup or queued sign-in', async () => {
  const rig = headerRig({ session: null, connected: false });
  const refreshing = deferred<boolean>();
  rig.runtime.refreshProfileState = () => refreshing.promise;
  rig.rerender({ ...rig.initial, resolving: true, error: 'Offline' });
  await act(async () => { await rig.result.current.model.activate(); });
  act(() => rig.result.current.model.retryLoading());
  act(() => rig.result.current.model.close());
  await act(async () => { rig.rerender(rig.initial); refreshing.resolve(true); });
  assert.equal(rig.result.current.model.open, false);
  assert.equal(rig.calls.includes('sign-in'), false);
});

test('a reopened popup accepts Retry while a dismissed retry is still pending', async () => {
  const rig = headerRig({ session: null, connected: false });
  const first = deferred<boolean>();
  const second = deferred<boolean>();
  let refreshes = 0;
  rig.runtime.refreshProfileState = () => ++refreshes === 1 ? first.promise : second.promise;
  rig.rerender({ ...rig.initial, resolving: true, error: 'Offline' });
  await act(async () => { await rig.result.current.model.activate(); });
  act(() => rig.result.current.model.retryLoading());
  assert.equal(rig.result.current.model.status, 'loading');
  act(() => rig.result.current.model.close());
  await act(async () => { await rig.result.current.model.activate(); });
  assert.equal(rig.result.current.model.status, 'error');
  act(() => rig.result.current.model.retryLoading());
  assert.equal(refreshes, 2);
  assert.equal(rig.result.current.model.status, 'loading');
  await act(async () => { first.reject(new Error('Dismissed request failed')); });
  assert.equal(rig.result.current.model.open, true);
  assert.equal(rig.result.current.model.status, 'loading');
  assert.equal(rig.result.current.model.loadingError, 'Offline');
  act(() => rig.result.current.restoreSession(walletA.toBase58()));
  rig.rerender(rig.initial);
  await act(async () => { second.resolve(true); });
  assert.equal(rig.result.current.model.open, true);
  assert.equal(rig.result.current.model.status, 'account');
  assert.equal(rig.calls.includes('sign-in'), false);
});

test('a pending transaction delays sign-in while keeping the loading popup accessible', async () => {
  const rig = headerRig({ session: null, connected: false });
  const signing = deferred<boolean>();
  rig.runtime.signIn = () => signing.promise;
  rig.rerender({ ...rig.initial, mutationPending: true });
  await act(async () => { await rig.result.current.model.activate(); });
  assert.equal(rig.result.current.model.open, true);
  assert.equal(rig.result.current.model.buttonDisabled, false);
  assert.equal(rig.calls.includes('sign-in'), false);
  rig.rerender(rig.initial);
  await waitFor(() => assert.equal(rig.calls.filter(value => value === 'sign-in').length, 1));
  await act(async () => { signing.resolve(false); });
});

test('an external sign-in can load the opened wallet without starting another sign-in', async () => {
  const rig = headerRig({ session: null });
  rig.rerender({ ...rig.initial, signInPending: true });
  await act(async () => { await rig.result.current.model.activate(); });
  assert.equal(rig.result.current.model.buttonDisabled, false);
  assert.equal(rig.result.current.model.status, 'signing-in');
  assert.equal(rig.calls.includes('sign-in'), false);
  act(() => rig.result.current.restoreSession(walletA.toBase58()));
  rig.rerender(rig.initial);
  assert.equal(rig.result.current.model.open, true);
  assert.equal(rig.result.current.model.status, 'account');
  assert.equal(rig.calls.includes('sign-in'), false);
});

test('a cancelled external sign-in closes the popup without starting a replacement sign-in', async () => {
  const rig = headerRig({ session: null });
  rig.rerender({ ...rig.initial, signInPending: true });
  await act(async () => { await rig.result.current.model.activate(); });
  assert.equal(rig.result.current.model.open, true);
  assert.equal(rig.result.current.model.status, 'signing-in');
  rig.rerender(rig.initial);
  assert.equal(rig.result.current.model.open, false);
  assert.equal(rig.calls.includes('sign-in'), false);
});

test('a restored session without a connected adapter opens its account and signs out', async () => {
  const rig = headerRig({ connected: false });
  await act(async () => { await rig.result.current.model.activate(); });
  assert.equal(rig.result.current.model.open, true);
  assert.equal(rig.result.current.model.address, walletA.toBase58());
  await act(async () => { await rig.result.current.model.disconnect(); });
  assert.deepEqual(rig.calls, ['before-open', 'before-disconnect', 'sign-out']);
  assert.equal(rig.result.current.account, null);
  assert.equal(rig.result.current.model.open, false);
});

test('disconnect is single-flight, retains popup during revocation, and disconnects after sign-out', async () => {
  const rig = headerRig();
  const logout = deferred();
  rig.runtime.signOut = () => logout.promise;
  await act(async () => { await rig.result.current.model.activate(); });
  let first!: Promise<void>;
  let second!: Promise<void>;
  act(() => {
    first = rig.result.current.model.disconnect();
    second = rig.result.current.model.disconnect();
  });
  assert.equal(first, second);
  assert.equal(rig.result.current.model.open, true);
  assert.equal(rig.result.current.model.address, walletA.toBase58());
  assert.equal(rig.result.current.model.disconnecting, true);
  assert.equal(rig.result.current.model.buttonDisabled, false);
  assert.equal(rig.calls.includes('disconnect'), false);
  await act(async () => { logout.resolve(); await first; });
  assert.deepEqual(rig.calls, ['before-open', 'before-disconnect', 'sign-out', 'disconnect']);
  assert.equal(rig.result.current.model.open, false);
  assert.equal(rig.result.current.connectedKey, null);
});

test('the wallet popup can close and reopen while disconnect is still pending', async () => {
  const rig = headerRig();
  const logout = deferred();
  rig.runtime.signOut = () => logout.promise;
  await act(async () => { await rig.result.current.model.activate(); });
  let completion!: Promise<void>;
  act(() => { completion = rig.result.current.model.disconnect(); });
  await act(async () => { await rig.result.current.model.activate(); });
  assert.equal(rig.result.current.model.open, false);
  await act(async () => { await rig.result.current.model.activate(); });
  assert.equal(rig.result.current.model.open, true);
  assert.equal(rig.result.current.model.status, 'account');
  assert.equal(rig.result.current.model.address, walletA.toBase58());
  assert.equal(rig.result.current.model.disconnecting, true);
  assert.equal(rig.calls.filter(value => value === 'sign-out').length, 1);
  assert.equal(rig.calls.includes('sign-in'), false);
  await act(async () => { logout.resolve(); await completion; });
  assert.equal(rig.result.current.model.open, false);
});

test('failed session revocation still disconnects the adapter and retry only retries revocation', async () => {
  const rig = headerRig();
  rig.runtime.signOut = async () => { throw new Error('offline'); };
  await act(async () => { await rig.result.current.model.disconnect(); });
  assert.deepEqual(rig.calls, ['before-disconnect', 'sign-out', 'disconnect']);
  assert.equal(rig.result.current.model.open, true);
  assert.match(rig.result.current.model.disconnectError || '', /session could not be signed out/);
  rig.runtime.signOut = async () => undefined;
  await act(async () => { await rig.result.current.model.disconnect(); });
  assert.deepEqual(rig.calls, ['before-disconnect', 'sign-out', 'disconnect', 'before-disconnect', 'sign-out']);
  assert.equal(rig.result.current.model.disconnectError, null);
  assert.equal(rig.result.current.model.open, false);
});

test('a mutation that starts during logout defers adapter disconnect until an explicit retry', async () => {
  const rig = headerRig();
  const logout = deferred();
  rig.runtime.signOut = () => logout.promise;
  let completion!: Promise<void>;
  act(() => { completion = rig.result.current.model.disconnect(); });
  assert.deepEqual(rig.disconnectingChanges, [true]);
  rig.rerender({ ...rig.initial, mutationPending: true });
  await act(async () => { logout.resolve(); await completion; });
  assert.equal(rig.calls.includes('disconnect'), false);
  assert.equal(rig.result.current.model.open, true);
  assert.match(rig.result.current.model.disconnectError || '', /transaction is still running/);
  assert.deepEqual(rig.disconnectingChanges, [true, false]);
  rig.rerender(rig.initial);
  await act(async () => { await rig.result.current.model.disconnect(); });
  assert.equal(rig.calls.filter(value => value === 'sign-out').length, 1);
  assert.equal(rig.calls.filter(value => value === 'disconnect').length, 1);
  assert.equal(rig.result.current.model.open, false);
  assert.deepEqual(rig.disconnectingChanges, [true, false, true, false]);
});

test('failed adapter disconnect retains a retry without signing out again', async () => {
  const rig = headerRig();
  rig.runtime.disconnect = async () => { throw new Error('adapter failed'); };
  await act(async () => { await rig.result.current.model.disconnect(); });
  assert.equal(rig.result.current.model.open, true);
  assert.match(rig.result.current.model.disconnectError || '', /wallet could not be disconnected/);
  rig.runtime.disconnect = async () => undefined;
  await act(async () => { await rig.result.current.model.disconnect(); });
  assert.deepEqual(rig.calls, ['before-disconnect', 'sign-out', 'disconnect', 'before-disconnect', 'disconnect']);
  assert.equal(rig.result.current.model.open, false);
});

for (const outcome of ['session failure', 'adapter failure', 'mutation conflict'] as const) {
  test(`dismissed wallet popup preserves outside focus after ${outcome}`, async () => {
    mock.method(Connection.prototype, 'getAccountInfo', async () => null);
    const pending = deferred();
    const intentCancellationSignal = new AbortController().signal;
    function Harness({ mutationPending = false }: { mutationPending?: boolean }) {
      const [account, setAccount] = useState<string | null>(walletA.toBase58());
      const [connected, setConnected] = useState(true);
      const model = useHeaderWallet({
        mutationPending,
        auth: {
          authenticated: Boolean(account), sessionWallet: account, sessionResolution: 'settled',
          error: null, refreshProfileState: async () => true,
          intentCancellationSignal,
          signOut: async () => {
            setAccount(null);
            if (outcome !== 'adapter failure') await pending.promise;
          },
        },
        wallet: {
          connected, publicKey: connected ? walletA : null, wallet: null, connecting: false, disconnecting: false,
          disconnect: async () => {
            if (outcome === 'adapter failure') await pending.promise;
            setConnected(false);
          },
        },
        signIn: async () => false,
        showToast: () => {},
      });
      return createElement('div', null,
        createElement(ShopWalletControl, { interactive: true, model }),
        createElement('input', { 'aria-label': 'Other field' }),
      );
    }
    const view = render(createElement(Harness), queryWrapper());
    const trigger = view.getByRole('button', { name: 'Wallet' }) as HTMLButtonElement;
    await act(async () => { fireEvent.click(trigger); });
    const disconnect = view.getByRole('button', { name: 'Disconnect' });
    disconnect.focus();
    fireEvent.click(disconnect);
    assert.equal(trigger.disabled, false);
    const other = view.getByRole('textbox', { name: 'Other field' });
    fireEvent.pointerDown(other);
    other.focus();
    assert.equal(view.queryByRole('dialog'), null);
    if (outcome === 'mutation conflict') view.rerender(createElement(Harness, { mutationPending: true }));
    await act(async () => {
      if (outcome === 'mutation conflict') pending.resolve();
      else pending.reject(new Error(outcome));
    });
    await waitFor(() => assert.equal(trigger.disabled, false));
    assert.equal(view.queryByRole('dialog'), null);
    assert.equal(document.activeElement, other);
    fireEvent.click(trigger);
    assert.ok(view.getByRole('button', { name: 'Retry disconnect' }));
    assert.match(view.getByRole('alert').textContent || '', outcome === 'session failure'
      ? /session could not be signed out/
      : outcome === 'adapter failure' ? /wallet could not be disconnected/ : /transaction is still running/);
    assert.equal(document.activeElement, view.getByRole('dialog', { name: 'Wallet' }));
  });
}

test('a same-wallet replacement session invalidates a retained failed disconnect', async () => {
  const rig = headerRig();
  rig.runtime.disconnect = async () => { throw new Error('adapter failed'); };
  await act(async () => { await rig.result.current.model.disconnect(); });
  assert.ok(rig.result.current.model.disconnectError);
  act(() => rig.result.current.replaceSession(walletA.toBase58()));
  assert.equal(rig.result.current.model.disconnectError, null);
  assert.equal(rig.result.current.model.open, false);
  rig.runtime.disconnect = async () => undefined;
  await act(async () => { await rig.result.current.model.activate(); await rig.result.current.model.disconnect(); });
  assert.equal(rig.calls.filter(value => value === 'sign-out').length, 2);
  assert.equal(rig.result.current.account, null);
});

test('a replacement session during remote logout prevents disconnecting its wallet', async () => {
  const rig = headerRig();
  const logout = deferred();
  rig.runtime.signOut = () => logout.promise;
  let completion!: Promise<void>;
  act(() => { completion = rig.result.current.model.disconnect(); });
  act(() => rig.result.current.replaceSession(walletA.toBase58()));
  await act(async () => { logout.resolve(); await completion; });
  assert.equal(rig.calls.includes('disconnect'), false);
  assert.equal(rig.result.current.account, walletA.toBase58());
  assert.equal(rig.result.current.model.disconnectError, null);
});

test('a different wallet and unmount each prevent a delayed adapter disconnect', async () => {
  for (const change of ['wallet', 'unmount']) {
    const rig = headerRig();
    const logout = deferred();
    rig.runtime.signOut = () => logout.promise;
    let completion!: Promise<void>;
    act(() => { completion = rig.result.current.model.disconnect(); });
    if (change === 'wallet') act(() => rig.result.current.replaceWallet(walletB));
    else rig.unmount();
    await act(async () => { logout.resolve(); await completion; });
    assert.equal(rig.calls.includes('disconnect'), false);
    if (change === 'wallet') assert.equal(rig.result.current.connectedKey, walletB);
    rig.unmount();
  }
});

test('a replacement staff token invalidates failed and in-flight disconnects without an intent-signal change', async () => {
  const address = 'A87Upx1f1whNV5P8xQCK2YUTwE3uMYigjoKJAF3jiNpz';
  const staffSession = (suffix: string) => ({
    wallet: address,
    token: `mons_staff_v1.${suffix}23e4567-e89b-42d3-a456-426614174000.${'A'.repeat(43)}`,
    refreshedAt: Date.now(), expiresAt: Date.now() + 60_000,
  });
  for (const phase of ['failed', 'pending']) {
    await saveStaffWalletSession(staffSession('1'));
    const rig = headerRig({ session: address });
    const logout = deferred();
    rig.runtime.signOut = phase === 'failed' ? async () => { throw new Error('offline'); } : () => logout.promise;
    let completion!: Promise<void>;
    if (phase === 'failed') await act(async () => { await rig.result.current.model.disconnect(); });
    else act(() => { completion = rig.result.current.model.disconnect(); });
    const callsBeforeReplacement = rig.calls.length;
    await act(async () => { await saveStaffWalletSession(staffSession('2')); });
    assert.equal(rig.result.current.model.disconnectError, null);
    assert.equal(rig.result.current.model.open, false);
    if (phase === 'pending') await act(async () => { logout.resolve(); await completion; });
    else await act(async () => { await rig.result.current.model.disconnect(); });
    assert.equal(rig.calls.length, callsBeforeReplacement);
    rig.unmount();
  }
});

test('running mutations block disconnect while popup remains accessible, overlays close it', async () => {
  const rig = headerRig();
  rig.rerender({ ...rig.initial, mutationPending: true });
  await act(async () => { await rig.result.current.model.activate(); });
  assert.equal(rig.result.current.model.open, true);
  assert.equal(rig.result.current.model.disconnectDisabled, true);
  await act(async () => { await rig.result.current.model.disconnect(); });
  assert.equal(rig.calls.includes('sign-out'), false);
  rig.rerender({ ...rig.initial, suspended: true });
  assert.equal(rig.result.current.model.open, false);
  assert.equal(rig.result.current.model.buttonDisabled, true);
  rig.rerender(rig.initial);
  assert.equal(rig.result.current.model.open, false);
});

test('balance uses a mainnet account slice, stays lazy, and refreshes on reopening', async () => {
  const requests: Array<{ endpoint: string; wallet: string; config: unknown }> = [];
  mock.method(Connection.prototype, 'getAccountInfo', async function (key: PublicKey, config: unknown) {
    requests.push({ endpoint: this.rpcEndpoint, wallet: key.toBase58(), config });
    return { lamports: 1_234_500_000 };
  });
  const { result, rerender } = renderHook(({ open }) => useMainnetSolBalance(walletA.toBase58(), open), {
    initialProps: { open: false }, ...queryWrapper(),
  });
  assert.equal(requests.length, 0);
  rerender({ open: true });
  await waitFor(() => assert.equal(result.current.lamports, 1_234_500_000));
  assert.match(requests[0].endpoint, /\/rpc\/mainnet-beta$/);
  assert.equal(requests[0].wallet, walletA.toBase58());
  assert.deepEqual(requests[0].config, { commitment: 'confirmed', dataSlice: { offset: 0, length: 0 } });
  rerender({ open: false });
  rerender({ open: true });
  await waitFor(() => assert.equal(requests.length, 2));
});

test('balance distinguishes initial loading, missing account zero, and failure with retry', async () => {
  const response = deferred<null>();
  const method = mock.method(Connection.prototype, 'getAccountInfo', () => response.promise);
  const { result } = renderHook(() => useMainnetSolBalance(walletA.toBase58(), true), queryWrapper());
  assert.equal(result.current.loading, true);
  assert.equal(result.current.lamports, undefined);
  await act(async () => { response.reject(new Error('RPC unavailable')); });
  await waitFor(() => assert.equal(result.current.error, true));
  assert.equal(result.current.lamports, undefined);
  method.mock.mockImplementation(async () => null);
  act(() => result.current.retry());
  await waitFor(() => assert.equal(result.current.lamports, 0));
  assert.equal(result.current.error, false);
});

test('balance ignores late responses from the previous account and removes its cache', async () => {
  const first = deferred<{ lamports: number }>();
  mock.method(Connection.prototype, 'getAccountInfo', async (key: PublicKey) => key.equals(walletA) ? first.promise : { lamports: 99 });
  const { client, wrapper } = queryWrapper();
  const { result, rerender } = renderHook(({ address }) => useMainnetSolBalance(address, true), {
    initialProps: { address: walletA.toBase58() }, wrapper,
  });
  rerender({ address: walletB.toBase58() });
  await waitFor(() => assert.equal(result.current.lamports, 99));
  await act(async () => { first.resolve({ lamports: 1234 }); });
  assert.equal(result.current.lamports, 99);
  assert.equal(client.getQueryCache().findAll().some(query => query.queryKey.includes(walletA.toBase58())), false);
});

test('balance waits while the page is hidden and resumes when visible', async () => {
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
  let requests = 0;
  mock.method(Connection.prototype, 'getAccountInfo', async () => { requests += 1; return null; });
  const { result } = renderHook(() => useMainnetSolBalance(walletA.toBase58(), true), queryWrapper());
  assert.equal(requests, 0);
  act(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    document.dispatchEvent(new dom.window.Event('visibilitychange'));
  });
  await waitFor(() => assert.equal(result.current.lamports, 0));
  assert.equal(requests, 1);
});
