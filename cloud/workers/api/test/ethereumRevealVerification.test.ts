import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { EthereumProviderBudgetStore, PROVIDER_BUDGETS, ProviderBudgetClient, ProviderBudgetUnavailable,
  type ProviderBudgetGrant, type ProviderBudgetSql } from '../src/ethereumProviderBudget.ts';
import { RevealProviderBudget, retryRevealProviderBudget, type RevealProviderPermit } from '../src/ethereumRevealVerification.ts';
import { EthereumRevealThrottleError } from '../src/ethereumRevealChain.ts';
import { createEthereumProviderAttempt } from '../src/ethereumProvider.ts';

test('local budget shortages retry within the current inspection without the failure cooldown', async () => {
  let calls = 0;
  const result = await retryRevealProviderBudget(async () => {
    if (++calls < 3) throw new ProviderBudgetUnavailable(2);
    return 'ready';
  }, AbortSignal.timeout(1000));
  assert.equal(result, 'ready');
  assert.equal(calls, 3);
});

test('local budget waits end with their distinct outcome at the original deadline', async () => {
  const controller = new AbortController();
  let calls = 0;
  const waiting = retryRevealProviderBudget(async () => {
    calls++;
    throw new ProviderBudgetUnavailable(1000);
  }, controller.signal);
  setTimeout(() => controller.abort(), 5);
  await assert.rejects(waiting, error => error instanceof ProviderBudgetUnavailable && error.retryAfterMs === 1000);
  assert.equal(calls, 1);
});

test('upstream throttles and malformed evidence leave the local-budget retry loop immediately', async () => {
  for (const failure of [new EthereumRevealThrottleError(1000), new Error('invalid evidence')]) {
    let calls = 0;
    await assert.rejects(retryRevealProviderBudget(async () => {
      calls++;
      throw failure;
    }, AbortSignal.timeout(1000)), error => error === failure);
    assert.equal(calls, 1);
  }
});

for (const [provider, minimum, wanted, costs, phaseCost] of [
  ['alchemy', 55, 55, [5, 20, 10, 20], 30],
  ['quicknode', 1, 4, [1, 1, 1, 1], 1],
] as const) test(`${provider} coalesces its initial permit and spends available four-call credit locally`, async () => {
  const requests: Array<{ provider: string; minimum: number; wanted: number }> = [];
  const scope = { chainId: 1, contractAddress: `0x${'11'.repeat(20)}`, deploymentBlock: 1 };
  const now = Date.now(), deadline = now + 5000;
  const work = { kind: 'receipt' as const, claim: { hash: `0x${'22'.repeat(32)}`, claimId: crypto.randomUUID(),
    startedAtMs: now, leaseUntilMs: deadline, active: true } };
  const budget = new RevealProviderBudget({
    async requestReceiptPermit(_scope, _work, _deadline, request) {
      requests.push(request);
      const issuedAtMs = Date.now();
      return { valid: true, permit: { provider: request.provider, lane: 'reveal',
        grant: { granted: request.wanted, issuedAtMs, expiresAtMs: issuedAtMs + PROVIDER_BUDGETS[provider].leaseMs,
          retryAfterMs: 0, grantId: crypto.randomUUID() } } };
    },
    async cancelReceiptPermit() { assert.fail('Completed grants need no cancellation.'); },
    async reportReceiptThrottle() {},
  }, scope, work, deadline);
  const signal = AbortSignal.timeout(5000);
  await Promise.all([budget.take(provider, 'reveal', costs[0], signal), budget.take(provider, 'reveal', costs[1], signal)]);
  await budget.ensure(provider, phaseCost, signal);
  await Promise.all([budget.take(provider, 'reveal', costs[2], signal), budget.take(provider, 'reveal', costs[3], signal)]);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].minimum, minimum);
  assert.equal(requests[0].wanted, wanted);
  assert.equal(budget.available(provider, 'reveal'), 0);
  await budget.dispose();
});

for (const provider of ['alchemy', 'quicknode'] as const) test(`${provider} dispatches after two delayed permit hops without renewing the original expiry`, async t => {
  const issuedAtMs = 1000;
  let now = issuedAtMs;
  t.mock.method(Date, 'now', () => now);
  t.mock.method(performance, 'now', () => now);
  const database = new DatabaseSync(':memory:');
  t.after(() => database.close());
  const sql: ProviderBudgetSql = { exec<T extends Record<string, string | number | null>>(query: string, ...bindings: Array<string | number | null>) {
    const statement = database.prepare(query);
    const values = statement.columns().length ? statement.all(...bindings) : (statement.run(...bindings), []);
    return { toArray: () => values as T[] };
  } };
  const store = new EthereumProviderBudgetStore(sql, operation => {
    database.exec('BEGIN IMMEDIATE');
    try { const result = operation(); database.exec('COMMIT'); return result; }
    catch (error) { database.exec('ROLLBACK'); throw error; }
  });
  const grants: ProviderBudgetGrant[] = [];
  const client = new ProviderBudgetClient({ getByName: () => ({
    async grant(request) {
      const grant = store.grant(request, now);
      grants.push(grant);
      await Promise.resolve();
      now += 300;
      return grant;
    },
    async reportThrottle() { assert.fail('Successful reads must not report throttling.'); },
  }) });
  const scope = { chainId: 1, contractAddress: `0x${'11'.repeat(20)}`, deploymentBlock: 1 };
  const deadline = issuedAtMs + 5000;
  const work = { kind: 'receipt' as const, claim: { hash: `0x${'22'.repeat(32)}`, claimId: crypto.randomUUID(),
    startedAtMs: issuedAtMs, leaseUntilMs: deadline, active: true } };
  const signal = new AbortController().signal;
  const permits: RevealProviderPermit[] = [];
  const budget = new RevealProviderBudget({
    async requestReceiptPermit(_scope, _work, _deadline, request) {
      const grant = await client.grant(request.provider, 'reveal', request.minimum, request.wanted, signal);
      const permit: RevealProviderPermit = { provider: request.provider, lane: 'reveal', grant };
      permits.push(permit);
      assert.equal(grant.issuedAtMs, issuedAtMs + 300);
      assert.equal(grant.expiresAtMs, issuedAtMs + 1000);
      await Promise.resolve();
      now += 300;
      return { valid: true, permit };
    },
    async cancelReceiptPermit() { assert.fail('Completed permits need no cancellation.'); },
    async reportReceiptThrottle() { assert.fail('Successful reads must not report throttling.'); },
  }, scope, work, deadline);
  const dispatched: Array<{ method: string; at: number }> = [];
  const attempt = createEthereumProviderAttempt({ ALCHEMY_MI_NOTE_API_KEY: 'test-only',
    QUICKNODE_ETHEREUM_MAINNET_RPC_URL: 'https://delayed-permit.quiknode.pro/test-only/' }, 1, provider, signal, {
    lane: 'reveal', budgetClient: budget, fetch: async (_input, init) => {
      const { id, method } = JSON.parse(String(init?.body));
      dispatched.push({ method, at: now });
      return Response.json({ jsonrpc: '2.0', id, result: null });
    },
  });
  await Promise.all([attempt.rpc('eth_chainId', []), attempt.rpc('eth_getTransactionReceipt', [work.claim.hash])]);
  await budget.ensure(provider, provider === 'alchemy' ? 30 : 1, signal);
  await Promise.all([attempt.rpc('eth_blockNumber', []), attempt.rpc('eth_getBlockByNumber', ['0x1', false])]);
  assert.deepEqual(dispatched, ['eth_chainId', 'eth_getTransactionReceipt', 'eth_blockNumber', 'eth_getBlockByNumber']
    .map(method => ({ method, at: issuedAtMs + 600 })));
  assert.equal(grants.length, 1);
  assert.equal(grants[0].issuedAtMs, issuedAtMs);
  assert.equal(grants[0].expiresAtMs, issuedAtMs + 1000);
  assert.equal(permits.length, 1);
  assert.equal(budget.available(provider, 'reveal'), 0);
  await attempt.drain();
  await budget.dispose();

  let replays = 0;
  const replayed = new RevealProviderBudget({
    async requestReceiptPermit() {
      return ++replays <= 2 ? { valid: true, permit: permits[0] } : { valid: false };
    },
    async cancelReceiptPermit() { assert.fail('Completed permits need no cancellation.'); },
    async reportReceiptThrottle() {},
  }, scope, work, deadline);
  replayed.seed(permits[0]);
  replayed.seed(permits[0]);
  assert.equal(replayed.available(provider, 'reveal'), permits[0].grant.granted);
  now = issuedAtMs + 999;
  assert.equal(replayed.available(provider, 'reveal'), permits[0].grant.granted);
  now = issuedAtMs + 1000;
  assert.equal(replayed.available(provider, 'reveal'), 0);
  await assert.rejects(replayed.take(provider, 'reveal', 1, signal), /authorization expired/);
  assert.equal(replays, 3);
  assert.equal(replayed.available(provider, 'reveal'), 0);
  await replayed.dispose();
});

test('QuickNode inspection progresses through one-credit grants under public and background contention', async t => {
  let now = 1000;
  t.mock.method(Date, 'now', () => now);
  t.mock.method(performance, 'now', () => now);
  const database = new DatabaseSync(':memory:');
  t.after(() => database.close());
  const sql: ProviderBudgetSql = { exec<T extends Record<string, string | number | null>>(query: string, ...bindings: Array<string | number | null>) {
    const statement = database.prepare(query);
    const values = statement.columns().length ? statement.all(...bindings) : (statement.run(...bindings), []);
    return { toArray: () => values as T[] };
  } };
  const store = new EthereumProviderBudgetStore(sql, operation => {
    database.exec('BEGIN IMMEDIATE');
    try { const result = operation(); database.exec('COMMIT'); return result; }
    catch (error) { database.exec('ROLLBACK'); throw error; }
  });
  const demand = (lane: 'public' | 'background', minimum = 1) => store.grant({
    provider: 'quicknode', lane, minimum, wanted: minimum,
  }, now);
  demand('public', 3);
  demand('background');
  const advance = (until: number) => {
    while (now < until) {
      now++;
      if (now % 40 === 0) demand('public');
      if (now % 250 === 0) demand('background');
    }
  };
  const scope = { chainId: 1, contractAddress: `0x${'11'.repeat(20)}`, deploymentBlock: 1 };
  const deadline = now + 2000;
  const work = { kind: 'receipt' as const, claim: { hash: `0x${'22'.repeat(32)}`, claimId: crypto.randomUUID(),
    startedAtMs: now, leaseUntilMs: deadline, active: true } };
  const grants: number[] = [];
  const budget = new RevealProviderBudget({
    async requestReceiptPermit(_scope, _work, _deadline, request) {
      while (now < deadline) {
        const grant = store.grant({ provider: request.provider, lane: 'reveal', minimum: request.minimum, wanted: request.wanted }, now);
        if (grant.granted) {
          grants.push(grant.granted);
          return { valid: true, permit: { provider: request.provider, lane: 'reveal', grant } };
        }
        advance(Math.min(deadline, now + Math.max(1, grant.retryAfterMs)));
      }
      return { valid: false };
    },
    async cancelReceiptPermit() {},
    async reportReceiptThrottle() {},
  }, scope, work, deadline);
  const signal = new AbortController().signal;
  await Promise.all([budget.take('quicknode', 'reveal', 1, signal), budget.take('quicknode', 'reveal', 1, signal)]);
  await budget.ensure('quicknode', 1, signal);
  await Promise.all([budget.take('quicknode', 'reveal', 1, signal), budget.take('quicknode', 'reveal', 1, signal)]);
  assert.deepEqual(grants, [1, 1, 1, 1]);
  assert.equal(budget.available('quicknode', 'reveal'), 0);
  assert.ok(now < deadline);
  await budget.dispose();
});

test('cancelling the last local waiter cancels its one queued coordinator permit', async () => {
  let requests = 0, cancellations = 0;
  const scope = { chainId: 1, contractAddress: `0x${'11'.repeat(20)}`, deploymentBlock: 1 };
  const now = Date.now(), deadline = now + 5000;
  const work = { kind: 'receipt' as const, claim: { hash: `0x${'22'.repeat(32)}`, claimId: crypto.randomUUID(),
    startedAtMs: now, leaseUntilMs: deadline, active: true } };
  const budget = new RevealProviderBudget({
    async requestReceiptPermit() { requests++; return new Promise(() => {}); },
    async cancelReceiptPermit() { cancellations++; },
    async reportReceiptThrottle() {},
  }, scope, work, deadline);
  const cancellation = new AbortController();
  const first = budget.take('alchemy', 'reveal', 5, cancellation.signal);
  const second = budget.take('alchemy', 'reveal', 20, cancellation.signal);
  cancellation.abort();
  await Promise.all([assert.rejects(first), assert.rejects(second)]);
  await budget.dispose();
  assert.equal(requests, 1);
  assert.equal(cancellations, 1);
});
