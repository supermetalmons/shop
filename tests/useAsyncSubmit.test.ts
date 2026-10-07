import assert from 'node:assert/strict';
import test, { after, afterEach } from 'node:test';
import { useEffect } from 'react';
import { setupFrontendDom } from './helpers/frontendDom.ts';

const { dom } = setupFrontendDom();
const { act, cleanup, renderHook } = await import('@testing-library/react');
const { useAsyncSubmit } = await import('../src/hooks/useAsyncSubmit.ts');

afterEach(() => cleanup());
after(() => dom.window.close());

test('Strict Mode effect replay ignores an earlier submission without settling the active one', async () => {
  const submissions: Array<{ finish: (value: string) => void; completion: Promise<void> }> = [];
  const successes: string[] = [];
  const pendingChanges: boolean[] = [];
  const { result } = renderHook(() => {
    const submission = useAsyncSubmit({
      formatError: () => 'Unable to submit',
      onPendingChange: (pending) => pendingChanges.push(pending),
    });
    const { run } = submission;
    useEffect(() => {
      let finish!: (value: string) => void;
      const task = new Promise<string>((resolve) => { finish = resolve; });
      const completion = run(() => task, (value) => successes.push(value));
      submissions.push({ finish, completion });
    }, [run]);
    return submission;
  }, { reactStrictMode: true });

  assert.equal(submissions.length, 2);
  assert.equal(result.current.pending, true);
  assert.deepEqual(pendingChanges, [true, false, true]);
  await act(async () => {
    submissions[0].finish('old');
    await submissions[0].completion;
  });
  assert.deepEqual(successes, []);
  assert.equal(result.current.pending, true);
  assert.equal(result.current.isPending(), true);
  assert.deepEqual(pendingChanges, [true, false, true]);

  await act(async () => {
    submissions[1].finish('current');
    await submissions[1].completion;
  });
  assert.deepEqual(successes, ['current']);
  assert.equal(result.current.pending, false);
  assert.equal(result.current.isPending(), false);
  assert.deepEqual(pendingChanges, [true, false, true, false]);
});

test('synchronous submission errors release the guard, and retry clears the error', async () => {
  const errors: string[] = [];
  const { result, unmount } = renderHook(() => useAsyncSubmit({
    formatError: (error) => error instanceof Error ? error.message : 'Unable to submit',
    onError: (message) => errors.push(message),
  }));
  await act(async () => {
    const completion = result.current.run(() => { throw new Error('Wallet unavailable'); });
    assert.deepEqual(errors, ['Wallet unavailable']);
    await completion;
  });
  assert.equal(result.current.pending, false);
  assert.equal(result.current.isPending(), false);
  assert.equal(result.current.error, 'Wallet unavailable');

  let finish!: (value: string) => void;
  let completion!: Promise<void>;
  const successes: string[] = [];
  act(() => {
    completion = result.current.run(
      () => new Promise<string>((resolve) => { finish = resolve; }),
      (value) => successes.push(value),
    );
  });
  assert.equal(result.current.error, null);
  assert.equal(result.current.pending, true);
  await act(async () => {
    finish('confirmed');
    await completion;
  });
  assert.deepEqual(successes, ['confirmed']);
  assert.equal(result.current.pending, false);

  await act(async () => {
    await result.current.run(() => 'synchronous', (value) => successes.push(value));
  });
  assert.deepEqual(successes, ['confirmed', 'synchronous']);
  assert.deepEqual(errors, ['Wallet unavailable']);

  const { run } = result.current;
  unmount();
  await run(async () => assert.fail('Unmounted form must not start another request'));
});

test('submission errors use the latest callback and are suppressed after unmount', async () => {
  const errors: string[] = [];
  const { result, rerender, unmount } = renderHook(({ prefix }) => useAsyncSubmit({
    formatError: () => 'Unable to submit',
    onError: (message) => errors.push(`${prefix}: ${message}`),
  }), { initialProps: { prefix: 'old' } });
  let reject!: (reason: unknown) => void;
  let completion!: Promise<void>;
  const start = () => {
    completion = result.current.run(() => new Promise<void>((_resolve, fail) => { reject = fail; }));
  };
  act(start);
  rerender({ prefix: 'current' });
  await act(async () => {
    reject(new Error('Request failed'));
    await completion;
  });
  assert.deepEqual(errors, ['current: Unable to submit']);

  act(start);
  unmount();
  await act(async () => {
    reject(new Error('Late failure'));
    await completion;
  });
  assert.deepEqual(errors, ['current: Unable to submit']);
});

test('Strict Mode replay suppresses stale failures without notifying or unlocking the current submission', async () => {
  const submissions: Array<{ reject: (reason: unknown) => void; completion: Promise<void> }> = [];
  const errors: string[] = [];
  const { result } = renderHook(() => {
    const submission = useAsyncSubmit({
      formatError: (error) => error instanceof Error ? error.message : 'Unable to submit',
      onError: (message) => errors.push(message),
    });
    const { run } = submission;
    useEffect(() => {
      let reject!: (reason: unknown) => void;
      const completion = run(() => new Promise<void>((_resolve, fail) => { reject = fail; }));
      submissions.push({ reject, completion });
    }, [run]);
    return submission;
  }, { reactStrictMode: true });

  assert.equal(submissions.length, 2);
  await act(async () => {
    submissions[0].reject(new Error('Old failure'));
    await submissions[0].completion;
  });
  assert.deepEqual(errors, []);
  assert.equal(result.current.error, null);
  assert.equal(result.current.isPending(), true);
  await act(async () => {
    submissions[1].reject(new Error('Current failure'));
    await submissions[1].completion;
  });
  assert.deepEqual(errors, ['Current failure']);
  assert.equal(result.current.error, 'Current failure');
  assert.equal(result.current.isPending(), false);
});
