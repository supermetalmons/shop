import assert from 'node:assert/strict';
import test, { after, afterEach } from 'node:test';
import { createElement, StrictMode, useEffect, useRef, useState, type PropsWithChildren } from 'react';
import { setupFrontendDom } from './helpers/frontendDom.ts';

const { dom } = setupFrontendDom();
const { act, cleanup, renderHook, waitFor } = await import('@testing-library/react');
const { useShopActionContinuation } = await import('../src/shop/account/useShopActionContinuation.ts');

afterEach(cleanup);
after(() => dom.window.close());

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function options(overrides: Partial<Parameters<typeof useShopActionContinuation>[0]> = {}): Parameters<typeof useShopActionContinuation>[0] {
  return {
    connectedWallet: 'wallet-a',
    scopeKey: '/shop',
    ensureSignedIn: async () => true,
    ensureWalletConnected: async () => 'wallet-a',
    showToast: () => {},
    ...overrides,
  };
}

test('the first action waits silently for sign-in and runs once through current callbacks', async () => {
  const gate = deferred<boolean>();
  const messages: string[] = [];
  const calls: string[] = [];
  let gateCalls = 0;
  const initial = options({
    ensureSignedIn: () => { gateCalls += 1; return gate.promise; },
    showToast: (message) => messages.push(message),
  });
  const { result, rerender } = renderHook(({ value }) => {
    const latestValue = useRef(value);
    latestValue.current = value;
    const continuation = useShopActionContinuation(initial);
    return { ...continuation, execute: () => { calls.push(latestValue.current); return latestValue.current; } };
  }, { initialProps: { value: 'old' } });
  let first!: Promise<string>;
  let second!: Promise<string>;
  act(() => {
    first = result.current.run({ key: 'purchase', requirement: 'sign-in', execute: result.current.execute, cancelled: 'cancelled' });
    second = result.current.run({ key: 'claim', requirement: 'sign-in', execute: () => 'wrong', cancelled: 'cancelled' });
  });
  assert.equal(await second, 'cancelled');
  assert.deepEqual(result.current.pendingAction, { key: 'purchase', phase: 'authenticating' });
  assert.equal(gateCalls, 1);
  assert.deepEqual(calls, []);
  rerender({ value: 'current' });
  await act(async () => { gate.resolve(true); });
  await waitFor(() => assert.equal(result.current.pendingAction, null));
  assert.equal(await first, 'current');
  assert.deepEqual(calls, ['current']);
  assert.deepEqual(messages, []);
});

test('first connection survives selection reset effects and prepares before checking readiness', async () => {
  const gate = deferred<boolean>();
  const events: string[] = [];
  const initial = options({ connectedWallet: undefined, ensureSignedIn: () => gate.promise });
  const { result, rerender } = renderHook((props: typeof initial) => {
    const [selection, setSelection] = useState<string[]>(['captured-item']);
    const current = useRef({ selection, connectedWallet: props.connectedWallet });
    current.current = { selection, connectedWallet: props.connectedWallet };
    const continuation = useShopActionContinuation(props);
    useEffect(() => {
      events.push(`reset:${props.connectedWallet ?? 'none'}`);
      setSelection([]);
    }, [props.connectedWallet]);
    return {
      ...continuation,
      request: {
        key: 'shipment', requirement: 'sign-in' as const, expectedWallet: 'wallet-a', cancelled: 'cancelled',
        prepare: () => { events.push('prepare'); setSelection(['captured-item']); },
        ready: () => current.current.selection[0] === 'captured-item',
        execute: () => { events.push('execute'); return `${current.current.connectedWallet}:${current.current.selection[0]}`; },
      },
    };
  }, { initialProps: initial });
  let completion!: Promise<string>;
  act(() => { completion = result.current.run(result.current.request); });
  rerender({ ...initial, connectedWallet: 'wallet-a' });
  await act(async () => { gate.resolve(true); });
  await waitFor(() => assert.equal(result.current.pendingAction, null));
  assert.equal(await completion, 'wallet-a:captured-item');
  assert.deepEqual(events, ['reset:none', 'reset:wallet-a', 'prepare', 'execute']);
});

test('wallet-only completion waits for the connected wallet to commit and skips sign-in', async () => {
  const gate = deferred<string | null>();
  const requests: unknown[] = [];
  let executions = 0;
  const initial = options({
    connectedWallet: undefined,
    ensureSignedIn: async () => { throw new Error('Unexpected sign-in'); },
    ensureWalletConnected: (request) => { requests.push(request); return gate.promise; },
  });
  const { result, rerender } = renderHook(useShopActionContinuation, { initialProps: initial });
  let completion!: Promise<string>;
  act(() => {
    completion = result.current.run({ key: 'transfer', requirement: 'wallet', expectedWallet: 'wallet-a', execute: () => { executions += 1; return 'done'; }, cancelled: 'cancelled' });
  });
  await act(async () => { gate.resolve('wallet-a'); });
  assert.equal(executions, 0);
  assert.equal(result.current.pendingAction?.phase, 'authenticating');
  assert.equal((requests[0] as { expectedWallet: string }).expectedWallet, 'wallet-a');
  rerender({ ...initial, connectedWallet: 'wallet-a' });
  await waitFor(() => assert.equal(result.current.pendingAction, null));
  assert.equal(await completion, 'done');
  assert.equal(executions, 1);
});

test('prepare can wait for fetched inventory, then runs successfully only once', async () => {
  let available = false;
  let selected = false;
  let preparationAttempts = 0;
  let successfulPreparations = 0;
  const initial = options();
  const { result, rerender } = renderHook(useShopActionContinuation, { initialProps: initial });
  let completion!: Promise<string>;
  act(() => {
    completion = result.current.run({
      key: 'shipment', requirement: 'sign-in', cancelled: 'cancelled',
      prepare: () => { preparationAttempts += 1; if (!available) return false; successfulPreparations += 1; return true; },
      ready: () => selected,
      execute: () => 'done',
    });
  });
  await waitFor(() => assert.ok(preparationAttempts > 0));
  available = true;
  rerender({ ...initial });
  await waitFor(() => assert.equal(successfulPreparations, 1));
  assert.equal(result.current.pendingAction?.phase, 'authenticating');
  selected = true;
  rerender({ ...initial });
  await waitFor(() => assert.equal(result.current.pendingAction, null));
  assert.equal(await completion, 'done');
  assert.equal(successfulPreparations, 1);
});

test('scope change cancels immediately and late gate success cannot revive the action', async () => {
  const gate = deferred<boolean>();
  let signal: AbortSignal | undefined;
  let executions = 0;
  const initial = options({ ensureSignedIn: (request) => { signal = request?.signal; return gate.promise; } });
  const { result, rerender } = renderHook(useShopActionContinuation, { initialProps: initial });
  let completion!: Promise<string>;
  act(() => { completion = result.current.run({ key: 'purchase', requirement: 'sign-in', execute: () => { executions += 1; return 'done'; }, cancelled: 'cancelled' }); });
  rerender({ ...initial, scopeKey: '/other' });
  assert.equal(await completion, 'cancelled');
  assert.equal(signal?.aborted, true);
  assert.equal(result.current.pendingAction, null);
  await act(async () => { gate.resolve(true); });
  assert.equal(executions, 0);
});

test('first chosen wallet is pinned and switching away and back cannot revive intent', async () => {
  const gate = deferred<boolean>();
  let executions = 0;
  const initial = options({ connectedWallet: undefined, ensureSignedIn: () => gate.promise });
  const { result, rerender } = renderHook(useShopActionContinuation, { initialProps: initial });
  let completion!: Promise<string>;
  act(() => { completion = result.current.run({ key: 'claim', requirement: 'sign-in', execute: () => { executions += 1; return 'done'; }, cancelled: 'cancelled' }); });
  rerender({ ...initial, connectedWallet: 'wallet-a' });
  rerender({ ...initial, connectedWallet: 'wallet-b' });
  rerender({ ...initial, connectedWallet: 'wallet-a' });
  assert.equal(await completion, 'cancelled');
  await act(async () => { gate.resolve(true); });
  assert.equal(executions, 0);
});

test('a mismatching connected owner never prepares or executes the captured assets', async () => {
  const { result } = renderHook(() => useShopActionContinuation(options()));
  let completion!: Promise<string>;
  act(() => {
    completion = result.current.run({
      key: 'shipment', requirement: 'sign-in', expectedWallet: 'wallet-b', cancelled: 'cancelled',
      prepare: () => { throw new Error('Unexpected preparation'); },
      execute: () => { throw new Error('Unexpected execution'); },
    });
  });
  await waitFor(() => assert.equal(result.current.pendingAction, null));
  assert.equal(await completion, 'cancelled');
});

test('closing the initiating surface cancels even while an auth gate never settles', async () => {
  let open = true;
  const initial = options({ ensureSignedIn: () => new Promise(() => {}) });
  const { result, rerender } = renderHook(useShopActionContinuation, { initialProps: initial });
  let completion!: Promise<string>;
  act(() => { completion = result.current.run({ key: 'claim', requirement: 'sign-in', isCurrent: () => open, execute: () => 'done', cancelled: 'cancelled' }); });
  open = false;
  rerender({ ...initial });
  await waitFor(() => assert.equal(result.current.pendingAction, null));
  assert.equal(await completion, 'cancelled');
});

test('unmount cancels a stalled gate and StrictMode setup leaves a usable runner', async () => {
  const gate = deferred<boolean>();
  const wrapper = ({ children }: PropsWithChildren) => createElement(StrictMode, null, children);
  const { result, unmount } = renderHook(() => useShopActionContinuation(options({ ensureSignedIn: () => gate.promise })), { wrapper });
  let completion!: Promise<string>;
  act(() => { completion = result.current.run({ key: 'claim', requirement: 'sign-in', execute: () => 'done', cancelled: 'cancelled' }); });
  assert.equal(result.current.pendingAction?.key, 'claim');
  unmount();
  assert.equal(await completion, 'cancelled');
  await act(async () => { gate.resolve(true); });
});

test('cancel during execution retains the lock until the transaction settles', async () => {
  const transaction = deferred<string>();
  const { result } = renderHook(() => useShopActionContinuation(options()));
  let completion!: Promise<string>;
  act(() => { completion = result.current.run({ key: 'purchase', requirement: 'sign-in', execute: () => transaction.promise, cancelled: 'cancelled' }); });
  await waitFor(() => assert.equal(result.current.pendingAction?.phase, 'running'));
  act(() => { result.current.cancel(); });
  assert.equal(await completion, 'cancelled');
  const duplicate = await result.current.run({ key: 'purchase', requirement: 'sign-in', execute: () => 'duplicate', cancelled: 'cancelled' });
  assert.equal(duplicate, 'cancelled');
  assert.equal(result.current.pendingAction?.phase, 'running');
  await act(async () => { transaction.reject(new Error('Late transaction failure')); });
  assert.equal(result.current.pendingAction, null);
  let next!: Promise<string>;
  act(() => { next = result.current.run({ key: 'claim', requirement: 'sign-in', execute: () => 'done', cancelled: 'cancelled' }); });
  await waitFor(() => assert.equal(result.current.pendingAction, null));
  assert.equal(await next, 'done');
});

test('preparation failure is actionable and clears pending state without executing', async () => {
  const messages: string[] = [];
  const { result } = renderHook(() => useShopActionContinuation(options({ showToast: (message) => messages.push(message) })));
  let completion!: Promise<string>;
  act(() => {
    completion = result.current.run({ key: 'shipment', requirement: 'sign-in', prepare: () => { throw new Error('These items are no longer available.'); }, execute: () => 'wrong', cancelled: 'cancelled' });
  });
  await waitFor(() => assert.equal(result.current.pendingAction, null));
  assert.equal(await completion, 'cancelled');
  assert.deepEqual(messages, ['These items are no longer available.']);
});

test('readiness timeout releases the intent with one actionable message', async () => {
  const messages: string[] = [];
  const { result } = renderHook(() => useShopActionContinuation(options({ showToast: (message) => messages.push(message) })));
  let completion!: Promise<string>;
  act(() => {
    completion = result.current.run({ key: 'purchase', requirement: 'sign-in', ready: () => false, readinessTimeoutMs: 5, readinessError: 'Couldn’t load your preorder. Try again.', execute: () => 'wrong', cancelled: 'cancelled' });
  });
  await waitFor(() => assert.equal(result.current.pendingAction, null));
  assert.equal(await completion, 'cancelled');
  assert.deepEqual(messages, ['Couldn’t load your preorder. Try again.']);
});

test('execution errors still reach the initiating action handler', async () => {
  const { result } = renderHook(() => useShopActionContinuation(options()));
  let assertion!: Promise<void>;
  act(() => {
    assertion = assert.rejects(result.current.run({ key: 'claim', requirement: 'sign-in', execute: async () => { throw new Error('Claim unavailable'); }, cancelled: 'cancelled' }), /Claim unavailable/);
  });
  await waitFor(() => assert.equal(result.current.pendingAction, null));
  await assertion;
});

test('session replacement aborts readiness after authentication and a new session can start again', async () => {
  const session = new AbortController();
  const nextSession = new AbortController();
  let readinessChecks = 0;
  const initial = options({ cancellationSignal: session.signal });
  const { result, rerender } = renderHook(useShopActionContinuation, { initialProps: initial });
  let completion!: Promise<string>;
  act(() => {
    completion = result.current.run({
      key: 'shipment', requirement: 'sign-in', cancelled: 'cancelled',
      ready: () => { readinessChecks += 1; return false; },
      execute: () => 'wrong',
    });
  });
  await waitFor(() => assert.ok(readinessChecks > 0));
  act(() => { session.abort(); });
  assert.equal(await completion, 'cancelled');
  assert.equal(result.current.pendingAction, null);
  const cancelled = await result.current.run({ key: 'claim', requirement: 'sign-in', cancelled: 'cancelled', execute: () => 'wrong' });
  assert.equal(cancelled, 'cancelled');
  rerender({ ...initial, cancellationSignal: nextSession.signal });
  let next!: Promise<string>;
  act(() => { next = result.current.run({ key: 'claim', requirement: 'sign-in', cancelled: 'cancelled', execute: () => 'done' }); });
  await waitFor(() => assert.equal(result.current.pendingAction, null));
  assert.equal(await next, 'done');
});

test('pagehide cancels readiness even after the authentication gate has finished', async () => {
  let readinessChecks = 0;
  const { result } = renderHook(() => useShopActionContinuation(options()));
  let completion!: Promise<string>;
  act(() => {
    completion = result.current.run({
      key: 'preorder', requirement: 'sign-in', cancelled: 'cancelled',
      ready: () => { readinessChecks += 1; return false; },
      execute: () => 'wrong',
    });
  });
  await waitFor(() => assert.ok(readinessChecks > 0));
  act(() => { window.dispatchEvent(new dom.window.Event('pagehide')); });
  assert.equal(await completion, 'cancelled');
  assert.equal(result.current.pendingAction, null);
});
