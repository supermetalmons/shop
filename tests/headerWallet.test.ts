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
    signIn: async () => undefined,
  };
  const initial = { mutationPending: false, suspended: false, scopeKey: '/', resolving: false };
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
        sessionResolution: props.resolving ? 'resolving' : 'settled',
        loading: false,
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
        connecting: false,
        disconnecting: false,
        wallet: null,
        disconnect: async () => {
          calls.push('disconnect');
          await runtime.disconnect();
          setConnectedKey(null);
        },
      },
      signIn: async () => { calls.push('sign-in'); await runtime.signIn(); },
      onBeforeOpen: () => calls.push('before-open'),
      onBeforeDisconnect: () => calls.push('before-disconnect'),
      onDisconnectingChange: pending => disconnectingChanges.push(pending),
      showToast: message => messages.push(message),
    });
    return {
      model,
      account,
      connectedKey,
      replaceSession: (address: string) => { rotateIntent(); setAccount(address); },
      replaceWallet: (key: PublicKey) => { rotateIntent(); setConnectedKey(key); setAccount(key.toBase58()); },
    };
  }, { initialProps: initial, ...queryWrapper() });
  return { ...view, initial, runtime, calls, messages, disconnectingChanges };
}

test('wallet stays disabled while resolving, then signed-out activation joins one sign-in', async () => {
  const rig = headerRig({ session: null, connected: false });
  rig.rerender({ ...rig.initial, resolving: true });
  assert.equal(rig.result.current.model.buttonDisabled, true);
  await act(async () => { await rig.result.current.model.activate(); });
  assert.deepEqual(rig.calls, []);
  rig.rerender(rig.initial);
  const signing = deferred();
  rig.runtime.signIn = () => signing.promise;
  let completion!: Promise<void>;
  act(() => { completion = rig.result.current.model.activate(); });
  await act(async () => { await rig.result.current.model.activate(); });
  assert.equal(rig.result.current.model.buttonDisabled, true);
  assert.deepEqual(rig.calls, ['before-open', 'sign-in']);
  await act(async () => { signing.resolve(); await completion; });
  assert.equal(rig.result.current.model.buttonDisabled, false);
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
  assert.equal(rig.result.current.model.buttonDisabled, true);
  assert.equal(rig.calls.includes('disconnect'), false);
  await act(async () => { logout.resolve(); await first; });
  assert.deepEqual(rig.calls, ['before-open', 'before-disconnect', 'sign-out', 'disconnect']);
  assert.equal(rig.result.current.model.open, false);
  assert.equal(rig.result.current.connectedKey, null);
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
          authenticated: Boolean(account), sessionWallet: account, sessionResolution: 'settled', loading: false,
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
        signIn: async () => {},
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
    assert.equal(trigger.disabled, true);
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
