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
  const { result, unmount } = renderHook(() => useAsyncSubmit({
    formatError: (error) => error instanceof Error ? error.message : 'Unable to submit',
  }));
  await act(async () => {
    await result.current.run(() => { throw new Error('Wallet unavailable'); });
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

  const { run } = result.current;
  unmount();
  await run(async () => assert.fail('Unmounted form must not start another request'));
});
