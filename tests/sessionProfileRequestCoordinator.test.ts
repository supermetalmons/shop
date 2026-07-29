import assert from 'node:assert/strict';
import test from 'node:test';
import { createSessionProfileRequestCoordinator } from '../src/lib/sessionProfileRequestCoordinator.ts';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

test('session profile requests with the same merge capability share one request', async () => {
  const pending = deferred<string>();
  const calls: boolean[] = [];
  const load = createSessionProfileRequestCoordinator(async ({ mergeStripeDeliveryOrders }) => {
    calls.push(mergeStripeDeliveryOrders);
    return pending.promise;
  });

  const first = load();
  const second = load();
  await Promise.resolve();
  assert.deepEqual(calls, [false]);

  pending.resolve('profile');
  assert.deepEqual(await Promise.all([first, second]), ['profile', 'profile']);
});

test('ordinary session loading shares an in-flight Stripe merge request', async () => {
  const pending = deferred<string>();
  const calls: boolean[] = [];
  const load = createSessionProfileRequestCoordinator(async ({ mergeStripeDeliveryOrders }) => {
    calls.push(mergeStripeDeliveryOrders);
    return pending.promise;
  });

  const recovery = load({ mergeStripeDeliveryOrders: true });
  const ordinary = load();
  await Promise.resolve();
  assert.deepEqual(calls, [true]);

  pending.resolve('merged-profile');
  assert.deepEqual(await Promise.all([recovery, ordinary]), ['merged-profile', 'merged-profile']);
});

test('Stripe merge waits for an older ordinary request and cannot be overwritten by it', async () => {
  const ordinary = deferred<string>();
  const merged = deferred<string>();
  const calls: boolean[] = [];
  const load = createSessionProfileRequestCoordinator(async ({ mergeStripeDeliveryOrders }) => {
    calls.push(mergeStripeDeliveryOrders);
    return mergeStripeDeliveryOrders ? merged.promise : ordinary.promise;
  });

  const ordinaryResult = load();
  const mergedResult = load({ mergeStripeDeliveryOrders: true });
  await Promise.resolve();
  assert.deepEqual(calls, [false]);

  ordinary.resolve('ordinary-profile');
  assert.equal(await ordinaryResult, 'ordinary-profile');
  await Promise.resolve();
  assert.deepEqual(calls, [false, true]);

  merged.resolve('merged-profile');
  assert.equal(await mergedResult, 'merged-profile');
});

test('a failed ordinary request does not prevent a required Stripe merge attempt', async () => {
  const ordinary = deferred<string>();
  const calls: boolean[] = [];
  const load = createSessionProfileRequestCoordinator(async ({ mergeStripeDeliveryOrders }) => {
    calls.push(mergeStripeDeliveryOrders);
    if (mergeStripeDeliveryOrders) return 'merged-profile';
    return ordinary.promise;
  });

  const ordinaryResult = load();
  const mergedResult = load({ mergeStripeDeliveryOrders: true });
  await Promise.resolve();
  ordinary.reject(new Error('ordinary failed'));
  await assert.rejects(ordinaryResult, /ordinary failed/);
  assert.equal(await mergedResult, 'merged-profile');
  assert.deepEqual(calls, [false, true]);
});
