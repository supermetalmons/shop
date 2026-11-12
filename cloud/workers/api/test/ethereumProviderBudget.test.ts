import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { EthereumProviderBudgetController, EthereumProviderBudgetStore, ProviderBudgetClient, ProviderBudgetUnavailable, PROVIDER_BUDGETS,
  type ProviderBudgetGrant, type ProviderBudgetNamespace, type ProviderBudgetRequest, type ProviderBudgetSql,
  type ProviderLane, type ProviderName, type ProviderPublicBudgetRequest } from '../src/ethereumProviderBudget.ts';

function fixture(t: TestContext) {
  const database = new DatabaseSync(':memory:');
  t.after(() => database.close());
  const sql: ProviderBudgetSql = { exec<T extends Record<string, string | number | null>>(query: string, ...bindings: Array<string | number | null>) {
    const statement = database.prepare(query);
    const values = statement.columns().length ? statement.all(...bindings) : (statement.run(...bindings), []);
    return { toArray: () => values as T[] };
  } };
  const atomic = <T>(operation: () => T) => {
    database.exec('BEGIN IMMEDIATE');
    try { const result = operation(); database.exec('COMMIT'); return result; }
    catch (error) { database.exec('ROLLBACK'); throw error; }
  };
  return { store: new EthereumProviderBudgetStore(sql, atomic), database,
    reopen: () => new EthereumProviderBudgetStore(sql, atomic) };
}

const request = (provider: ProviderName, lane: ProviderLane, minimum = 1, wanted = minimum): ProviderBudgetRequest => ({ provider, lane, minimum, wanted });
const grant = (amount: number, issuedAtMs = Date.now(), provider: ProviderName = 'alchemy'): ProviderBudgetGrant =>
  ({ granted: amount, issuedAtMs, expiresAtMs: issuedAtMs + PROVIDER_BUDGETS[provider].leaseMs, retryAfterMs: amount ? 0 : 25 });

function clientFixture(handler: (request: ProviderBudgetRequest) => Promise<ProviderBudgetGrant>) {
  let calls = 0;
  const reports: unknown[] = [];
  const namespace: ProviderBudgetNamespace = { getByName: () => ({
    grant: async value => { calls++; return handler(value); },
    reportThrottle: async value => { reports.push(value); },
  }) };
  return { client: new ProviderBudgetClient(namespace), calls: () => calls, reports };
}

for (const provider of ['alchemy', 'quicknode'] as const) {
  test(`${provider} reserves protect reveal and background from public traffic`, t => {
    const { store } = fixture(t), config = PROVIDER_BUDGETS[provider];
    const now = 1000;
    assert.equal(store.grant(request(provider, 'public', 1, config.maxGrant), now).granted, config.bursts.shared);
    const denied = store.grant(request(provider, 'public'), now);
    assert.equal(denied.granted, 0);
    assert.equal(denied.retryAfterMs, Math.ceil(1000 / config.rates.shared));
    assert.equal(store.grant(request(provider, 'reveal', 1, config.bursts.reveal), now).granted, config.bursts.reveal);
    assert.equal(store.grant(request(provider, 'background', 1, config.bursts.background), now).granted, config.bursts.background);
  });

  test(`${provider} grants obey the aggregate token envelope through restart and clock rollback`, t => {
    const f = fixture(t), config = PROVIDER_BUDGETS[provider];
    let store = f.store;
    let total = 0;
    const initial = 1000;
    const rate = Object.values(config.rates).reduce((sum, value) => sum + value, 0);
    const burst = Object.values(config.bursts).reduce((sum, value) => sum + value, 0);
    for (let elapsed = 0; elapsed <= 2000; elapsed += 5) {
      if (elapsed % 100 === 0) store = f.reopen();
      for (const lane of ['public', 'reveal', 'background'] as const) {
        total += store.grant(request(provider, lane, 1, config.maxGrant), initial + elapsed).granted;
      }
      total += store.grant(request(provider, 'public'), initial + Math.max(0, elapsed - 10)).granted;
      assert.ok(total <= burst + elapsed * rate / 1000, `${total} exceeds envelope at ${elapsed}ms`);
    }
  });
}

for (const [provider, windowMs, ceiling, minimumDispatches] of [
  ['alchemy', 10_000, 77_375, 75_000],
  ['quicknode', 1_000, 49, 45],
] as const) test(`${provider} delayed grants stay within the fixed ${windowMs}ms dispatch ceiling`, t => {
  const { store } = fixture(t);
  const config = PROVIDER_BUDGETS[provider];
  const windowStart = config.leaseMs;
  const windowEnd = windowStart + windowMs;
  let dispatched = 0;
  for (let issuedAt = 1; issuedAt < windowEnd; issuedAt += provider === 'alchemy' ? 5 : 1) {
    for (const lane of ['public', 'reveal', 'background'] as const) {
      const value = store.grant(request(provider, lane, 1, config.maxGrant), issuedAt);
      const dispatchAt = Math.max(windowStart, issuedAt);
      assert.ok(dispatchAt < value.expiresAtMs);
      dispatched += value.granted;
    }
  }
  assert.ok(dispatched >= minimumDispatches, `Only ${dispatched} units exercised the dispatch window`);
  assert.ok(dispatched <= ceiling, `${dispatched} units exceed the fixed ${ceiling}-unit dispatch ceiling`);
});

test('reserve borrowing starts after 500ms and denied donor demand stops borrowing', t => {
  const { store } = fixture(t);
  store.grant(request('alchemy', 'public', 250), 1000);
  assert.equal(store.grant(request('alchemy', 'public', 250), 1499).granted, 250);
  assert.equal(store.grant(request('alchemy', 'public'), 1499).granted, 0);
  assert.equal(store.grant(request('alchemy', 'public', 250), 1500).granted, 250);
  assert.equal(store.grant(request('alchemy', 'reveal', 150), 1500).granted, 0);
  assert.equal(store.grant(request('alchemy', 'public', 1, 250), 1500).granted,
    Math.floor(PROVIDER_BUDGETS.alchemy.rates.shared / 1000));
});

test('grants consume the lane reserve before shared credit', t => {
  const { store, database } = fixture(t);
  assert.equal(store.grant(request('alchemy', 'reveal', 100), 1000).granted, 100);
  assert.deepEqual(database.prepare('SELECT pool,credits FROM provider_budget_pools ORDER BY pool').all().map(row => ({ ...row })), [
    { pool: 'background', credits: 100000 }, { pool: 'reveal', credits: 50000 }, { pool: 'shared', credits: 250000 },
  ]);
});

test('QuickNode fractional refill never rounds into an extra call early', t => {
  const { store } = fixture(t);
  const firstCreditAt = 1000 + Math.ceil(1000 / PROVIDER_BUDGETS.quicknode.rates.shared);
  store.grant(request('quicknode', 'public', 3), 1000);
  assert.equal(store.grant(request('quicknode', 'public'), firstCreditAt - 1).granted, 0);
  assert.equal(store.grant(request('quicknode', 'public'), firstCreditAt - 1).retryAfterMs, 1);
  assert.equal(store.grant(request('quicknode', 'public'), firstCreditAt).granted, 1);
  assert.equal(store.grant(request('quicknode', 'public'), firstCreditAt).granted, 0);
});

test('throttling persists across restart, never shortens, and gives the next eligible retry', t => {
  const { store, reopen } = fixture(t);
  store.reportThrottle('alchemy', 5000, 1000);
  reopen().reportThrottle('alchemy', 10, 2000);
  const denied = reopen().grant(request('alchemy', 'reveal', 26), 2500);
  assert.equal(denied.granted, 0);
  assert.equal(denied.retryAfterMs, 3500);
  assert.equal(reopen().grant(request('alchemy', 'reveal', 26), 6000).granted, 26);
});

test('duplicate grant IDs return the original lease without minting credit or extending expiry', t => {
  const { store, reopen, database } = fixture(t);
  const input = { ...request('alchemy', 'public', 250), requestId: 'lost-response' };
  const first = store.grant(input, 1000);
  assert.deepEqual(reopen().grant(input, 1100), first);
  assert.throws(() => store.grant({ ...input, lane: 'reveal' }, 1100), /identity mismatch/);
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM provider_budget_grants').get()!.count, 1);
});

test('invalid or cross-provider grants cannot change budget state', t => {
  const { store } = fixture(t);
  for (const minimum of [0, -1, 1.1, NaN, Infinity, 251]) assert.throws(() => store.grant(request('alchemy', 'public', minimum), 1000));
  store.grant(request('alchemy', 'public', 250), 1000);
  assert.throws(() => store.grant(request('quicknode', 'public'), 1000), /identity mismatch/);
  assert.equal(store.grant(request('alchemy', 'public'), 1000).granted, 0);
});

test('client coalesces simultaneous refills and never overspends the returned lease', async () => {
  const held = Promise.withResolvers<ProviderBudgetGrant>();
  const f = clientFixture(() => held.promise);
  const operations = Array.from({ length: 20 }, () => f.client.take('alchemy', 'reveal', 26, new AbortController().signal));
  assert.equal(f.calls(), 1);
  held.resolve(grant(250));
  const results = await Promise.allSettled(operations);
  assert.equal(results.filter(value => value.status === 'fulfilled').length, 9);
  assert.ok(results.filter(value => value.status === 'rejected').every(value => value.reason instanceof ProviderBudgetUnavailable));
  assert.equal(f.calls(), 1);
});

test('client discards late grants instead of retrying forever', async t => {
  let now = 1000;
  t.mock.method(Date, 'now', () => now);
  const held = Promise.withResolvers<ProviderBudgetGrant>();
  const f = clientFixture(() => held.promise);
  const pending = f.client.take('alchemy', 'reveal', 26, new AbortController().signal);
  now += PROVIDER_BUDGETS.alchemy.leaseMs;
  held.resolve(grant(250, 1000));
  await assert.rejects(pending, ProviderBudgetUnavailable);
  assert.equal(f.calls(), 1);
});

for (const provider of ['alchemy', 'quicknode'] as const) {
  test(`${provider} accepts fresh permits issued after a slow broker request`, async t => {
    let wall = 1000, monotonic = 1000;
    t.mock.method(Date, 'now', () => wall);
    t.mock.method(performance, 'now', () => monotonic);
    const lifetime = PROVIDER_BUDGETS[provider].leaseMs;
    const f = clientFixture(async () => {
      wall += lifetime + 25;
      monotonic += lifetime + 25;
      const value = grant(2, wall, provider);
      wall += 10;
      monotonic += 10;
      return value;
    });
    await f.client.take(provider, 'reveal', 1, new AbortController().signal);
    assert.equal(f.client.available(provider, 'reveal'), 1);
    wall += lifetime - 11;
    monotonic += lifetime - 11;
    assert.equal(f.client.available(provider, 'reveal'), 1);
    wall++;
    monotonic++;
    assert.equal(f.client.available(provider, 'reveal'), 0);
    assert.equal(f.calls(), 1);
  });
}

for (const [provider, deliveryMs] of [['alchemy', 270], ['quicknode', 120]] as const) {
  test(`${provider} makes progress after ${deliveryMs}ms of post-issuance delivery and still expires at one second`, async t => {
    const { store } = fixture(t);
    let now = 1000, dispatched = 0, granted = 0;
    t.mock.method(Date, 'now', () => now);
    t.mock.method(performance, 'now', () => now);
    for (let index = 0; index < 5; index++) {
      let delivered!: ProviderBudgetGrant;
      const f = clientFixture(async input => {
        delivered = store.grant(input, now);
        granted += delivered.granted;
        now += deliveryMs;
        return delivered;
      });
      await f.client.take(provider, 'reveal', 1, new AbortController().signal);
      dispatched++;
      assert.equal(f.calls(), 1);
      assert.equal(delivered.expiresAtMs, delivered.issuedAtMs + 1000);
      if (index === 0) {
        now = delivered.expiresAtMs - 1;
        assert.ok(delivered.granted > 1);
        assert.equal(f.client.available(provider, 'reveal'), delivered.granted - 1);
        now++;
        assert.equal(f.client.available(provider, 'reveal'), 0);
      }
    }
    assert.equal(dispatched, 5);
    assert.ok(granted >= dispatched);
  });

  test(`${provider} preserves the original expiry across delayed coordinator and verifier subleases`, async t => {
    const { store } = fixture(t);
    let now = 1000;
    t.mock.method(Date, 'now', () => now);
    t.mock.method(performance, 'now', () => now);
    const source = clientFixture(async input => {
      const value = store.grant(input, now);
      now += deliveryMs;
      return value;
    });
    const child = clientFixture(async () => { throw new Error('Unexpected verifier broker call'); });
    const grandchild = clientFixture(async () => { throw new Error('Unexpected sublease broker call'); });
    const signal = new AbortController().signal;
    const permit = await source.client.grant(provider, 'reveal', 1, 4, signal);
    assert.equal(permit.expiresAtMs, 2000);
    now += deliveryMs;
    child.client.seed(provider, 'reveal', permit);
    await child.client.take(provider, 'reveal', 1, signal);
    now = 1900;
    const sublease = await child.client.grant(provider, 'reveal', 1, 1, signal);
    assert.equal(sublease.expiresAtMs, permit.expiresAtMs);
    now += 50;
    grandchild.client.seed(provider, 'reveal', sublease);
    now = 1999;
    assert.equal(grandchild.client.available(provider, 'reveal'), 1);
    now = 2000;
    assert.equal(grandchild.client.available(provider, 'reveal'), 0);
    assert.equal(child.client.available(provider, 'reveal'), 0);
    assert.throws(() => new ProviderBudgetClient(undefined).seed(provider, 'reveal', sublease), ProviderBudgetUnavailable);
    assert.equal(source.calls(), 1);
    assert.equal(child.calls(), 0);
    assert.equal(grandchild.calls(), 0);
  });
}

test('wall-clock rollback during a quota request does not extend its remaining lifetime', async t => {
  let wall = 1000, monotonic = 1000;
  t.mock.method(Date, 'now', () => wall);
  t.mock.method(performance, 'now', () => monotonic);
  const f = clientFixture(async () => {
    const value = grant(250, wall);
    wall -= 500;
    monotonic += 100;
    return value;
  });
  await f.client.take('alchemy', 'reveal', 26, new AbortController().signal);
  monotonic += PROVIDER_BUDGETS.alchemy.leaseMs - 101;
  assert.equal(f.client.available('alchemy', 'reveal'), 224);
  monotonic++;
  assert.equal(f.client.available('alchemy', 'reveal'), 0);
});

test('fractional monotonic clocks preserve integer expiries on subsequent subleases', async t => {
  let wall = 1000, monotonic = 1000;
  t.mock.method(Date, 'now', () => wall);
  t.mock.method(performance, 'now', () => monotonic);
  const f = clientFixture(async () => {
    wall = 1020;
    monotonic = 1020.5;
    return grant(250, 1010);
  });
  await f.client.take('alchemy', 'reveal', 26, new AbortController().signal);
  wall = 1021;
  monotonic = 1020.75;
  const permit = await f.client.grant('alchemy', 'reveal', 55, 55, new AbortController().signal);
  assert.ok(Number.isSafeInteger(permit.expiresAtMs));
  assert.ok(permit.expiresAtMs <= 1010 + PROVIDER_BUDGETS.alchemy.leaseMs);
  const child = new ProviderBudgetClient(undefined);
  child.seed('alchemy', 'reveal', permit);
  assert.equal(child.available('alchemy', 'reveal'), 55);
});

test('monotonic expiry prevents backward wall-clock changes extending a lease', async t => {
  let wall = 1000, monotonic = 1000;
  t.mock.method(Date, 'now', () => wall);
  t.mock.method(performance, 'now', () => monotonic);
  const f = clientFixture(async () => grant(250));
  await f.client.take('alchemy', 'public', 26, new AbortController().signal);
  wall -= 500;
  monotonic += PROVIDER_BUDGETS.alchemy.leaseMs;
  await f.client.take('alchemy', 'public', 26, new AbortController().signal);
  assert.equal(f.calls(), 2);
});

test('aborting one waiter does not cancel or duplicate another waiter grant', async () => {
  const held = Promise.withResolvers<ProviderBudgetGrant>();
  const f = clientFixture(() => held.promise);
  const controller = new AbortController();
  const cancelled = f.client.take('alchemy', 'public', 26, controller.signal);
  const active = f.client.take('alchemy', 'public', 26, new AbortController().signal);
  controller.abort();
  await assert.rejects(cancelled, { name: 'AbortError' });
  held.resolve(grant(250));
  await active;
  assert.equal(f.calls(), 1);
});

test('client reports global throttle and invalidates every local lane plus in-flight grants', async () => {
  const held = Promise.withResolvers<ProviderBudgetGrant>();
  const f = clientFixture(() => held.promise);
  const pending = f.client.take('alchemy', 'reveal', 26, new AbortController().signal);
  await f.client.reportThrottle('alchemy', 5000);
  held.resolve(grant(250));
  await assert.rejects(pending, ProviderBudgetUnavailable);
  await assert.rejects(f.client.take('alchemy', 'background', 1, new AbortController().signal), error =>
    error instanceof ProviderBudgetUnavailable && error.retryAfterMs > 4000);
  assert.deepEqual(f.reports, [{ provider: 'alchemy', retryAfterMs: 5000 }]);
});

test('budget failures are sanitized and no-namespace bypass remains explicit', async () => {
  const f = clientFixture(async () => { throw new Error('private provider detail'); });
  await assert.rejects(f.client.take('alchemy', 'public', 26, new AbortController().signal), error =>
    error instanceof ProviderBudgetUnavailable && !error.message.includes('private'));
  await new ProviderBudgetClient(undefined).take('alchemy', 'public', 26, new AbortController().signal);
});

test('subleases are deducted once, preserve expiry, and seed verifiers without another broker hop', async t => {
  let now = 1000, monotonic = 1000;
  t.mock.method(Date, 'now', () => now);
  t.mock.method(performance, 'now', () => monotonic);
  const source = clientFixture(async () => grant(250));
  const child = clientFixture(async () => { throw new Error('Unexpected broker call'); });
  const permit = await source.client.grant('alchemy', 'reveal', 55, 128, new AbortController().signal);
  assert.equal(permit.granted, 128);
  assert.equal(source.client.available('alchemy', 'reveal'), 122);
  now += 25; monotonic += 25;
  child.client.seed('alchemy', 'reveal', permit);
  await child.client.take('alchemy', 'reveal', 55, new AbortController().signal);
  assert.equal(child.client.available('alchemy', 'reveal'), 73);
  assert.equal(child.calls(), 0);
  assert.throws(() => child.client.seed('alchemy', 'reveal', permit), ProviderBudgetUnavailable);
  now = permit.expiresAtMs; monotonic = permit.expiresAtMs;
  assert.equal(child.client.available('alchemy', 'reveal'), 0);
  assert.throws(() => child.client.seed('alchemy', 'reveal', permit), ProviderBudgetUnavailable);
});

test('an older denied refill preserves a newly seeded permit and its expiry', async t => {
  let now = 1000;
  t.mock.method(Date, 'now', () => now);
  t.mock.method(performance, 'now', () => now);
  const held = Promise.withResolvers<ProviderBudgetGrant>();
  const f = clientFixture(() => held.promise);
  const pending = f.client.take('alchemy', 'reveal', 26, new AbortController().signal);
  now = 1050;
  f.client.seed('alchemy', 'reveal', { ...grant(55), grantId: 'fresh-permit' });
  held.resolve({ ...grant(0, 1000), retryAfterMs: 200 });
  await pending;
  assert.equal(f.client.available('alchemy', 'reveal'), 29);
  now = 1050 + PROVIDER_BUDGETS.alchemy.leaseMs - 1;
  assert.equal(f.client.available('alchemy', 'reveal'), 29);
  now++;
  assert.equal(f.client.available('alchemy', 'reveal'), 0);
  assert.equal(f.calls(), 1);
});

for (const issuedAt of [1000, 1100]) {
  test(`a refill issued at ${issuedAt} merges only unspent seeded credits with the earliest expiry`, async t => {
    let now = 1000;
    t.mock.method(Date, 'now', () => now);
    t.mock.method(performance, 'now', () => now);
    const held = Promise.withResolvers<ProviderBudgetGrant>();
    const f = clientFixture(() => held.promise);
    const pending = f.client.take('alchemy', 'reveal', 26, new AbortController().signal);
    now = 1050;
    f.client.seed('alchemy', 'reveal', { ...grant(55), grantId: 'fresh-permit' });
    await f.client.take('alchemy', 'reveal', 5, new AbortController().signal);
    now = 1100;
    held.resolve(grant(64, issuedAt));
    await pending;
    assert.equal(f.client.available('alchemy', 'reveal'), 88);
    now = Math.min(issuedAt, 1050) + PROVIDER_BUDGETS.alchemy.leaseMs - 1;
    const permit = await f.client.grant('alchemy', 'reveal', 88, 88, new AbortController().signal);
    assert.equal(permit.expiresAtMs, now + 1);
    assert.equal(f.client.available('alchemy', 'reveal'), 0);
    assert.equal(f.calls(), 1);
  });
}

test('an expired refill cannot erase or augment a fresh seeded permit', async t => {
  let now = 1000;
  t.mock.method(Date, 'now', () => now);
  t.mock.method(performance, 'now', () => now);
  const held = Promise.withResolvers<ProviderBudgetGrant>();
  const f = clientFixture(() => held.promise);
  const pending = f.client.take('alchemy', 'reveal', 26, new AbortController().signal);
  now = 1000 + PROVIDER_BUDGETS.alchemy.leaseMs + 50;
  f.client.seed('alchemy', 'reveal', { ...grant(55), grantId: 'fresh-permit' });
  held.resolve(grant(64, 1000));
  await pending;
  assert.equal(f.client.available('alchemy', 'reveal'), 29);
  now += PROVIDER_BUDGETS.alchemy.leaseMs;
  assert.equal(f.client.available('alchemy', 'reveal'), 0);
  assert.equal(f.calls(), 1);
});

test('a successful refill never renews seeded credits that expired while it was pending', async t => {
  let now = 1000;
  t.mock.method(Date, 'now', () => now);
  t.mock.method(performance, 'now', () => now);
  const held = Promise.withResolvers<ProviderBudgetGrant>();
  const f = clientFixture(() => held.promise);
  const pending = f.client.take('alchemy', 'reveal', 26, new AbortController().signal);
  f.client.seed('alchemy', 'reveal', { ...grant(55), grantId: 'old-permit' });
  now += PROVIDER_BUDGETS.alchemy.leaseMs;
  held.resolve(grant(64));
  await pending;
  assert.equal(f.client.available('alchemy', 'reveal'), 38);
  now += PROVIDER_BUDGETS.alchemy.leaseMs;
  assert.equal(f.client.available('alchemy', 'reveal'), 0);
  assert.equal(f.calls(), 1);
});

for (const failure of ['rejected', 'timed-out', 'invalid'] as const) {
  test(`${failure} refill preserves fresh credits without accepting a late response`, async t => {
    let now = 1000;
    t.mock.method(Date, 'now', () => now);
    t.mock.method(performance, 'now', () => now);
    const timeout = new AbortController();
    if (failure === 'timed-out') t.mock.method(AbortSignal, 'timeout', () => timeout.signal);
    const held = Promise.withResolvers<ProviderBudgetGrant>();
    const f = clientFixture(() => held.promise);
    const pending = f.client.take('alchemy', 'reveal', 26, new AbortController().signal);
    now = 1050;
    f.client.seed('alchemy', 'reveal', { ...grant(55), grantId: 'fresh-permit' });
    if (failure === 'rejected') held.reject(new Error('Broker unavailable'));
    else if (failure === 'timed-out') timeout.abort();
    else held.resolve({ ...grant(64), expiresAtMs: now });
    await pending;
    assert.equal(f.client.available('alchemy', 'reveal'), 29);
    held.resolve(grant(64));
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(f.client.available('alchemy', 'reveal'), 29);
    now = 1050 + PROVIDER_BUDGETS.alchemy.leaseMs;
    assert.equal(f.client.available('alchemy', 'reveal'), 0);
    assert.equal(f.calls(), 1);
  });
}

test('waiters evaluate their own minimum against seeded credits after a shared refill failure', async t => {
  t.mock.method(Date, 'now', () => 1000);
  t.mock.method(performance, 'now', () => 1000);
  const held = Promise.withResolvers<ProviderBudgetGrant>();
  const f = clientFixture(() => held.promise);
  const large = f.client.take('alchemy', 'reveal', 26, new AbortController().signal);
  const small = f.client.take('alchemy', 'reveal', 5, new AbortController().signal);
  f.client.seed('alchemy', 'reveal', { ...grant(10), grantId: 'small-permit' });
  held.reject(new Error('Broker unavailable'));
  await assert.rejects(large, ProviderBudgetUnavailable);
  await small;
  assert.equal(f.client.available('alchemy', 'reveal'), 5);
  assert.equal(f.calls(), 1);
});

test('a verifier refill quantum does not overreserve a full Alchemy lease', async () => {
  const requests: ProviderBudgetRequest[] = [];
  const client = new ProviderBudgetClient({ getByName: () => ({
    grant: async value => { requests.push(value); return grant(value.wanted); }, reportThrottle: async () => {},
  }) }, 64);
  await client.take('alchemy', 'reveal', 26, new AbortController().signal);
  assert.equal(requests[0].wanted, 64);
  assert.equal(client.available('alchemy', 'reveal'), 38);
});

test('a stale replayed broker grant cannot be renewed from the local request time', async t => {
  t.mock.method(Date, 'now', () => 5000);
  const f = clientFixture(async () => grant(250, 1000));
  await assert.rejects(f.client.take('alchemy', 'reveal', 26, new AbortController().signal), ProviderBudgetUnavailable);
});

test('concurrent retries reuse a denied grant deadline instead of stampeding the broker', async t => {
  let now = 1000, monotonic = 1000;
  t.mock.method(Date, 'now', () => now);
  t.mock.method(performance, 'now', () => monotonic);
  const f = clientFixture(async () => grant(0));
  await assert.rejects(f.client.take('alchemy', 'reveal', 55, new AbortController().signal), ProviderBudgetUnavailable);
  await Promise.all(Array.from({ length: 100 }, () => assert.rejects(
    f.client.take('alchemy', 'reveal', 55, new AbortController().signal), ProviderBudgetUnavailable)));
  assert.equal(f.calls(), 1);
  now += 25; monotonic += 25;
  await assert.rejects(f.client.take('alchemy', 'reveal', 55, new AbortController().signal), ProviderBudgetUnavailable);
  assert.equal(f.calls(), 2);
});

test('a consumed grant retains the broker next-credit hint without delaying available credits', async t => {
  let now = 1000, monotonic = 1000;
  t.mock.method(Date, 'now', () => now);
  t.mock.method(performance, 'now', () => monotonic);
  const f = clientFixture(async () => ({ ...grant(250), retryAfterMs: 25 }));
  await f.client.take('alchemy', 'reveal', 200, new AbortController().signal);
  await f.client.take('alchemy', 'reveal', 50, new AbortController().signal);
  await assert.rejects(f.client.take('alchemy', 'reveal', 200, new AbortController().signal), ProviderBudgetUnavailable);
  assert.equal(f.calls(), 1);
  now += 25; monotonic += 25;
  await f.client.take('alchemy', 'reveal', 200, new AbortController().signal);
  assert.equal(f.calls(), 2);
});

test('a stalled refill expires without poisoning future grants or accepting its late response', async t => {
  const timeout = new AbortController(), late = Promise.withResolvers<ProviderBudgetGrant>();
  const mock = t.mock.method(AbortSignal, 'timeout', () => timeout.signal);
  let calls = 0;
  const f = clientFixture(async () => ++calls === 1 ? late.promise : grant(250));
  const stalled = f.client.take('alchemy', 'reveal', 26, new AbortController().signal);
  timeout.abort();
  await assert.rejects(stalled, ProviderBudgetUnavailable);
  mock.mock.restore();
  await f.client.take('alchemy', 'reveal', 26, new AbortController().signal);
  assert.equal(f.client.available('alchemy', 'reveal'), 224);
  late.resolve(grant(250));
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(f.client.available('alchemy', 'reveal'), 224);
  assert.equal(calls, 2);
});

test('denied retries are paced FIFO and aborted waiters leave no blocked slot', async () => {
  const f = clientFixture(async () => ({ ...grant(0), retryAfterMs: 2 }));
  const errors: ProviderBudgetUnavailable[] = [];
  for (let index = 0; index < 3; index++) {
    try { await f.client.take('alchemy', 'reveal', 55, new AbortController().signal); }
    catch (error) { assert.ok(error instanceof ProviderBudgetUnavailable); errors.push(error); }
  }
  const order: number[] = [];
  const cancelled = new AbortController();
  const first = errors[0].wait(AbortSignal.timeout(1000)).then(() => { order.push(1); });
  const middle = errors[1].wait(cancelled.signal);
  const last = errors[2].wait(AbortSignal.timeout(1000)).then(() => { order.push(3); });
  cancelled.abort();
  await assert.rejects(middle, { name: 'AbortError' });
  await Promise.all([first, last]);
  assert.deepEqual(order, [1, 3]);
});

test('deserialized retry errors retain bounded numeric-delay fallback', async () => {
  const error = new ProviderBudgetUnavailable(JSON.parse('{"retryAfterMs":1}').retryAfterMs);
  await error.wait(AbortSignal.timeout(1000));
});

function publicQueue(t: TestContext) {
  const f = fixture(t);
  let now = 1000;
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const controller = new EthereumProviderBudgetController(f.store, () => now);
  const input = (requestId: string, minimum = 1, deadlineMs = 2000): ProviderPublicBudgetRequest =>
    ({ provider: 'alchemy', minimum, deadlineMs, requestId });
  const advance = async (milliseconds: number) => {
    now += milliseconds;
    t.mock.timers.tick(milliseconds);
    await Promise.resolve();
  };
  return { ...f, controller, input, advance, now: () => now };
}

test('public FIFO cannot be jumped by smaller fast grants and preserves reserved lanes', async t => {
  const f = publicQueue(t);
  const originalRequest = { ...request('alchemy', 'public', 250), requestId: 'original' };
  const original = f.controller.grant(originalRequest);
  const order: string[] = [];
  const large = f.controller.acquirePublic(f.input('large', 100)).then(value => { order.push('large'); return value; });
  const small = f.controller.acquirePublic(f.input('small')).then(value => { order.push('small'); return value; });
  const bypass = { ...request('alchemy', 'public'), requestId: 'bypass' };
  await f.advance(1);
  assert.equal(f.controller.grant(bypass).granted, 0);
  assert.deepEqual(f.controller.grant(originalRequest), original);
  assert.deepEqual(order, []);
  assert.equal(f.controller.grant(request('alchemy', 'reveal', 150)).granted, 150);
  assert.equal(f.controller.grant(request('alchemy', 'background', 100)).granted, 100);
  await f.advance(22);
  const results = await Promise.all([large, small]);
  assert.deepEqual(order, ['large', 'small']);
  assert.deepEqual(results.map(value => value.granted), [100, 1]);
  assert.ok(results.every(value => value.issuedAtMs === 1023 && value.expiresAtMs === 2023));
  await f.advance(100);
  assert.equal(f.controller.grant(bypass).granted, 0);
});

test('public queue coalesces duplicates and keeps temporary denial out of the replay ledger', async t => {
  const f = publicQueue(t);
  f.controller.grant(request('alchemy', 'public', 250));
  const input = f.input('queued', 100);
  const first = f.controller.acquirePublic(input);
  assert.equal(f.controller.acquirePublic(input), first);
  assert.throws(() => f.controller.acquirePublic({ ...input, deadlineMs: 2100 }), /identity mismatch/);
  assert.throws(() => f.controller.acquirePublic({ ...input, minimum: 101 }), /identity mismatch/);
  assert.equal(f.database.prepare('SELECT COUNT(*) AS count FROM provider_budget_grants').get()!.count, 0);
  await f.advance(23);
  const issued = await first;
  assert.equal(issued.granted, 100);
  const restarted = new EthereumProviderBudgetController(f.reopen(), f.now);
  assert.deepEqual(await restarted.acquirePublic(input), issued);
  restarted.cancelPublic(input);
  assert.deepEqual(await restarted.acquirePublic(input), issued);
  assert.equal(f.database.prepare('SELECT COUNT(*) AS count FROM provider_budget_grants').get()!.count, 1);
});

test('public queue rejects its 65th waiter without polling for each enqueue', async t => {
  const f = publicQueue(t);
  f.controller.reportThrottle('alchemy', 5000);
  const probes = t.mock.method(f.store, 'tryGrant');
  const inputs = Array.from({ length: 64 }, (_, index) => f.input(`queued-${index}`));
  const pending = inputs.map(input => f.controller.acquirePublic(input));
  assert.equal(probes.mock.callCount(), 1);
  assert.equal(f.controller.acquirePublic(inputs[0]), pending[0]);
  const rejected = await f.controller.acquirePublic(f.input('full'));
  assert.equal(rejected.granted, 0);
  assert.ok(rejected.retryAfterMs >= 1000);
  assert.equal(probes.mock.callCount(), 1);
  await f.advance(1000);
  assert.ok((await Promise.all(pending)).every(value => value.granted === 0 && value.retryAfterMs >= 1000));
  assert.deepEqual(await new EthereumProviderBudgetController(f.reopen(), f.now).acquirePublic(f.input('full')), rejected);
});

test('public queue expires each deadline and clamps server admission to one second', async t => {
  const f = publicQueue(t);
  f.controller.reportThrottle('alchemy', 5000);
  const first = f.controller.acquirePublic(f.input('long', 1, 20_000));
  const early = f.controller.acquirePublic(f.input('early', 1, 1040));
  await f.advance(40);
  assert.equal((await early).granted, 0);
  await f.advance(960);
  const denied = await first;
  assert.equal(denied.granted, 0);
  assert.ok(denied.retryAfterMs >= 1000);
  assert.equal(denied.issuedAtMs, 2000);
  assert.deepEqual(await f.controller.acquirePublic(f.input('long', 1, 30_000)), denied);
});

test('public cancellation advances FIFO and is terminal before enqueue and after restart', async t => {
  const f = publicQueue(t);
  f.controller.grant(request('alchemy', 'public', 250));
  const firstInput = f.input('cancelled-head', 250);
  const first = f.controller.acquirePublic(firstInput);
  const second = f.controller.acquirePublic(f.input('next'));
  await f.advance(1);
  f.controller.cancelPublic(firstInput);
  assert.equal((await first).granted, 0);
  assert.equal((await second).granted, 1);
  const cancelled = f.input('cancel-before-enqueue', 20);
  f.controller.cancelPublic(cancelled);
  const restarted = new EthereumProviderBudgetController(f.reopen(), f.now);
  assert.equal((await restarted.acquirePublic(cancelled)).granted, 0);
  assert.equal((await restarted.acquirePublic(firstInput)).granted, 0);
});

function queuedClient(handler: (request: ProviderPublicBudgetRequest) => Promise<ProviderBudgetGrant>) {
  const requests: ProviderPublicBudgetRequest[] = [], cancellations: ProviderPublicBudgetRequest[] = [];
  const client = new ProviderBudgetClient({ getByName: () => ({
    async grant() { throw new Error('Unexpected ordinary broker grant'); },
    async reportThrottle() {},
    async acquirePublic(request) { requests.push(request); return handler(request); },
    async cancelPublic(request) { cancellations.push(request); },
  }) });
  return { client, requests, cancellations };
}

test('public client coalesces queued grants without debiting before take', async () => {
  const held = Promise.withResolvers<ProviderBudgetGrant>();
  const f = queuedClient(() => held.promise);
  const signal = new AbortController().signal;
  const deadline = Date.now() + 1000;
  const first = f.client.acquirePublic('alchemy', 26, deadline, signal);
  const second = f.client.acquirePublic('alchemy', 26, deadline, signal);
  assert.equal(f.requests.length, 1);
  held.resolve(grant(26));
  await Promise.all([first, second]);
  assert.equal(f.client.available('alchemy', 'public'), 26);
  await f.client.take('alchemy', 'public', 26, signal);
  assert.equal(f.client.available('alchemy', 'public'), 0);
  assert.deepEqual(f.cancellations, []);
});

for (const cancelled of [false, true]) test(`later public callers retain their cutoff after a shared timeout (cancelled=${cancelled})`, async t => {
  const f = fixture(t);
  let now = 1000;
  t.mock.method(Date, 'now', () => now);
  t.mock.method(performance, 'now', () => now);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const controller = new EthereumProviderBudgetController(f.store);
  controller.reportThrottle('quicknode', 1100);
  const requests: ProviderPublicBudgetRequest[] = [];
  const client = new ProviderBudgetClient({ getByName: () => ({
    async grant(request) { return controller.grant(request); },
    async reportThrottle(request) { controller.reportThrottle(request.provider, request.retryAfterMs); },
    async acquirePublic(request) { requests.push(request); return controller.acquirePublic(request); },
    async cancelPublic(request) { controller.cancelPublic(request); },
  }) });
  const first = assert.rejects(client.acquirePublic('quicknode', 1, 2000, new AbortController().signal), ProviderBudgetUnavailable);
  now = 1900;
  t.mock.timers.tick(900);
  const later = new AbortController();
  const second = client.acquirePublic('quicknode', 1, 2900, later.signal);
  assert.equal(requests.length, 1);
  now = 2000;
  t.mock.timers.tick(100);
  await first;
  for (let index = 0; index < 10; index++) await Promise.resolve();
  assert.deepEqual(requests.map(request => request.deadlineMs), [2000, 2900]);
  assert.notEqual(requests[0].requestId, requests[1].requestId);
  if (cancelled) {
    const reason = new Error('Newer caller cancelled');
    later.abort(reason);
    await assert.rejects(second, error => error === reason);
    assert.equal(client.available('quicknode', 'public'), 0);
  } else {
    now = 2100;
    t.mock.timers.tick(100);
    await second;
    assert.equal(client.available('quicknode', 'public'), 1);
  }
  assert.equal(requests.length, 2);
});

test('a server-side shared expiry lets a later public caller reacquire without extending the original request', async t => {
  let now = 1000;
  t.mock.method(Date, 'now', () => now);
  t.mock.method(performance, 'now', () => now);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const held = Promise.withResolvers<ProviderBudgetGrant>();
  let calls = 0;
  const f = queuedClient(async () => ++calls === 1 ? held.promise : grant(26));
  const first = assert.rejects(f.client.acquirePublic('alchemy', 26, 2000, new AbortController().signal), ProviderBudgetUnavailable);
  now = 1900;
  const second = f.client.acquirePublic('alchemy', 26, 2900, new AbortController().signal);
  now = 2000;
  held.resolve(grant(0));
  await Promise.all([first, second]);
  assert.deepEqual(f.requests.map(request => request.deadlineMs), [2000, 2900]);
  assert.equal(f.client.available('alchemy', 'public'), 26);
});

for (const failure of ['denied', 'invalid', 'transport'] as const) test(`later public callers do not poll after a shared ${failure} failure`, async t => {
  let now = 1000;
  t.mock.method(Date, 'now', () => now);
  t.mock.method(performance, 'now', () => now);
  const held = Promise.withResolvers<ProviderBudgetGrant>();
  const f = queuedClient(() => held.promise);
  const first = assert.rejects(f.client.acquirePublic('alchemy', 26, 2000, new AbortController().signal), ProviderBudgetUnavailable);
  now = 1900;
  const second = assert.rejects(f.client.acquirePublic('alchemy', 26, 2900, new AbortController().signal), ProviderBudgetUnavailable);
  const result = grant(failure === 'denied' ? 0 : 27);
  now = 2000;
  if (failure === 'transport') held.reject(new Error('Broker unavailable'));
  else held.resolve(result);
  await Promise.all([first, second]);
  assert.equal(f.requests.length, 1);
  assert.equal(f.client.available('alchemy', 'public'), 0);
});

test('canceling one public consumer leaves the shared queue acquisition alive', async () => {
  const held = Promise.withResolvers<ProviderBudgetGrant>();
  const f = queuedClient(() => held.promise);
  const cancelled = new AbortController(), reason = new Error('consumer left');
  const deadline = Date.now() + 1000;
  const first = f.client.acquirePublic('alchemy', 26, deadline, cancelled.signal);
  const second = f.client.acquirePublic('alchemy', 26, deadline, new AbortController().signal);
  cancelled.abort(reason);
  await assert.rejects(first, error => error === reason);
  assert.equal(f.cancellations.length, 0);
  held.resolve(grant(26));
  await second;
  assert.equal(f.client.available('alchemy', 'public'), 26);
});

test('the last public consumer cancels remotely once and ignores a late positive grant', async () => {
  const held = Promise.withResolvers<ProviderBudgetGrant>();
  const f = queuedClient(() => held.promise);
  const controller = new AbortController(), reason = new Error('last consumer left');
  const pending = f.client.acquirePublic('alchemy', 26, Date.now() + 1000, controller.signal);
  controller.abort(reason);
  await assert.rejects(pending, error => error === reason);
  assert.deepEqual(f.cancellations, f.requests);
  held.resolve(grant(26));
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(f.client.available('alchemy', 'public'), 0);
});

test('public admission times out without polling or accepting a late reply', async t => {
  let now = 1000;
  t.mock.method(Date, 'now', () => now);
  t.mock.method(performance, 'now', () => now);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const held = Promise.withResolvers<ProviderBudgetGrant>();
  const f = queuedClient(() => held.promise);
  const pending = f.client.acquirePublic('alchemy', 26, 20_000, new AbortController().signal);
  assert.equal(f.requests[0].deadlineMs, 2000);
  now = 2000;
  t.mock.timers.tick(1000);
  await assert.rejects(pending, error => error instanceof ProviderBudgetUnavailable && error.retryAfterMs >= 1000);
  assert.deepEqual(f.cancellations, f.requests);
  assert.equal(f.requests.length, 1);
  held.resolve(grant(26));
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(f.client.available('alchemy', 'public'), 0);
});

test('public admission preserves issuance expiry after delivery and rejects replayed expired grants', async t => {
  let now = 1000;
  t.mock.method(Date, 'now', () => now);
  t.mock.method(performance, 'now', () => now);
  const f = queuedClient(async () => { const value = grant(26); now += 300; return value; });
  await f.client.acquirePublic('alchemy', 26, 2000, new AbortController().signal);
  now = 1999;
  assert.equal(f.client.available('alchemy', 'public'), 26);
  now = 2000;
  assert.equal(f.client.available('alchemy', 'public'), 0);
  const expired = queuedClient(async () => grant(26, 1000));
  await assert.rejects(expired.client.acquirePublic('alchemy', 26, 3000, new AbortController().signal), ProviderBudgetUnavailable);
  assert.equal(expired.client.available('alchemy', 'public'), 0);
});

test('provider cooldown fences and cancels public acquisitions already in flight', async () => {
  const held = Promise.withResolvers<ProviderBudgetGrant>();
  const f = queuedClient(() => held.promise);
  const pending = f.client.acquirePublic('alchemy', 26, Date.now() + 1000, new AbortController().signal);
  await f.client.reportThrottle('alchemy', 5000);
  await assert.rejects(pending, ProviderBudgetUnavailable);
  assert.deepEqual(f.cancellations, f.requests);
  held.resolve(grant(26));
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(f.client.available('alchemy', 'public'), 0);
  await assert.rejects(f.client.acquirePublic('alchemy', 26, Date.now() + 1000, new AbortController().signal), ProviderBudgetUnavailable);
  assert.equal(f.requests.length, 1);
});

test('legacy grant-only namespaces fail public admission without independent retry polling', async () => {
  let calls = 0;
  const f = clientFixture(async () => { calls++; return grant(26); });
  await assert.rejects(f.client.acquirePublic('alchemy', 26, Date.now() + 1000, new AbortController().signal), ProviderBudgetUnavailable);
  assert.equal(calls, 0);
});
