import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { EthereumApiError } from '../src/ethereumError.ts';
import { TarotClaimRelayer, type TarotClaimChain, type TarotClaimInput, type TarotSignedAttempt, type TarotSignedClaim } from '../src/tarotClaimRelayer.ts';
import { TarotClaimRelayerStore, type TarotClaimSql } from '../src/tarotClaimRelayerStore.ts';
import { TarotClaimRejected } from '../src/tarotClaimRejection.ts';

const CONTRACT = `0x${'11'.repeat(20)}`;
const RECIPIENT = `0x${'22'.repeat(20)}`;
const PAYER = `0x${'33'.repeat(20)}`;
const OTHER = `0x${'44'.repeat(20)}`;
const codeHash = '55'.repeat(32);
const requestId = (id: number) => `11111111-1111-4111-8111-${id.toString().padStart(12, '0')}`;
const input = (id = 1, tokenId = id): TarotClaimInput => ({ chainId: 1, contractAddress: CONTRACT, tokenId,
  requestId: requestId(id), recipient: RECIPIENT, codeHash });

function fixture(t: TestContext) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  const sql: TarotClaimSql = { exec<T extends Record<string, string | number | null>>(query: string, ...bindings: Array<string | number | null>) {
    const statement = db.prepare(query);
    const values = statement.columns().length ? statement.all(...bindings) : (statement.run(...bindings), []);
    return { toArray: () => values as T[] };
  } };
  const atomic = <T>(action: () => T): T => {
    db.exec('BEGIN IMMEDIATE');
    try { const result = action(); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  };
  const store = new TarotClaimRelayerStore(sql, atomic);
  let now = 2_000_000_000_000;
  const events: unknown[] = [];
  const alarms: Array<number | null> = [];
  const sent: TarotSignedAttempt[] = [];
  const prepared: Array<{ input: TarotClaimInput; nonce: string; outstanding: string }> = [];
  const receipts = new Map<string, 'pending' | 'confirmed' | 'failed'>();
  let payer = PAYER;
  let nextNetworkNonce = '0';
  let validationFailure: Error | null = null;
  let prepareFailure: Error | null = null;
  let broadcastFailure: Error | null = null;
  let onPrepare: (() => Promise<void>) | null = null;
  let onBroadcast: ((value: TarotSignedAttempt) => void) | null = null;
  const signed = (value: TarotClaimInput, nonce: string): TarotSignedClaim => ({
    rawTransaction: `0x02${value.tokenId.toString(16).padStart(4, '0')}${Number(nonce).toString(16).padStart(4, '0')}`,
    transactionHash: `0x${(value.tokenId * 1000 + Number(nonce)).toString(16).padStart(64, '0')}`,
    nonce, authorizationDeadline: now / 1000 + 600, maximumFeeWei: '1000', relayerAddress: payer,
  });
  const chain: TarotClaimChain = {
    relayerAddress: () => payer,
    nonce: async () => ({ latest: nextNetworkNonce, pending: nextNetworkNonce }),
    validate: async () => { if (validationFailure) throw validationFailure; },
    prepare: async (value, nonce, outstanding) => {
      prepared.push({ input: value, nonce, outstanding });
      await onPrepare?.();
      if (prepareFailure) throw prepareFailure;
      return signed(value, nonce);
    },
    inspect: async value => receipts.get(value.signed.transactionHash) ?? 'pending',
    broadcast: async value => {
      assert.deepEqual(store.get(value.id).signed, value.signed);
      assert.equal(store.get(value.id).lastBroadcastAtMs, now);
      sent.push(value);
      onBroadcast?.(value);
      if (broadcastFailure) throw broadcastFailure;
    },
  };
  const reopen = () => new TarotClaimRelayer(new TarotClaimRelayerStore(sql, atomic), chain,
    async at => { alarms.push(at); }, () => now, event => events.push(event));
  return { store, chain, db, events, alarms, sent, prepared, receipts, signed, reopen, relayer: reopen(),
    advance: (ms: number) => { now += ms; }, now: () => now,
    setPayer: (value: string) => { payer = value; }, setNonce: (value: string) => { nextNetworkNonce = value; },
    failValidation: (value: Error | null) => { validationFailure = value; },
    failPrepare: (value: Error | null) => { prepareFailure = value; },
    failBroadcast: (value: Error | null) => { broadcastFailure = value; },
    beforePrepare: (value: (() => Promise<void>) | null) => { onPrepare = value; },
    beforeBroadcast: (value: ((attempt: TarotSignedAttempt) => void) | null) => { onBroadcast = value; },
  };
}

test('concurrent claims lock one recipient and persist one signed transaction before broadcasting', async t => {
  const f = fixture(t);
  const first = input();
  const results = await Promise.all([
    f.relayer.claim(first), f.relayer.claim({ ...input(2, 1), recipient: OTHER }), f.relayer.claim(first),
  ]);
  assert.equal(f.prepared.length, 1);
  assert.equal(f.sent.length, 1);
  for (const result of results) {
    assert.equal(result.recipient, RECIPIENT);
    assert.equal(result.requestId, first.requestId);
    assert.equal(result.state, 'pending');
    assert.ok(result.transactionHash);
  }
  await assert.rejects(f.relayer.claim({ ...first, recipient: OTHER }), /different recipient/);
});

test('durable preflight rejection survives restart and cannot reserve or broadcast a nonce', async t => {
  const f = fixture(t);
  const failure = { code: 'unavailable' as const, message: 'ENS resolution is unavailable.' };
  assert.deepEqual(f.store.reject({ ...input(), failure }, f.now()), { rejection: failure });
  assert.deepEqual(f.store.reject({ ...input(), failure: { code: 'invalid-argument', message: 'Changed failure.' } }, f.now()),
    { rejection: failure });
  const rejected = (error: unknown) => error instanceof TarotClaimRejected && error.rejection.message === failure.message;
  await assert.rejects(f.relayer.claim(input()), rejected);
  await assert.rejects(f.reopen().claim(input()), rejected);
  assert.equal(f.store.account(), null);
  assert.equal(f.store.status(input()), null);
  assert.equal(f.prepared.length, 0);
  assert.equal(f.sent.length, 0);
  assert.equal(f.store.outstandingFeeWei(), '0');
  assert.equal((await f.relayer.claim(input(2, 1))).state, 'pending');
  assert.deepEqual(f.prepared.map(value => value.nonce), ['0']);
  await assert.rejects(f.relayer.claim(input()), rejected);
});

test('durable rejection enforces its network, deployment, token, and credential identity', t => {
  const f = fixture(t);
  const failure = { code: 'invalid-argument' as const, message: 'Invalid recipient.', details: { field: 'recipient' } };
  f.store.reject({ ...input(), failure }, f.now());
  for (const changed of [
    { ...input(), chainId: 11155111 as const }, { ...input(), contractAddress: OTHER },
    { ...input(), tokenId: 2 }, { ...input(), codeHash: '66'.repeat(32) },
  ]) {
    assert.throws(() => f.store.admit(changed, f.now()), /different credentials or a different card/);
    assert.throws(() => f.store.reject({ ...changed, failure }, f.now()), /different credentials or a different card/);
  }
  assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM claim_rejections').get()?.count, 1);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM claim_attempts').get()?.count, 0);
});

test('admitted claims win over rejection while a rejected request remains immutable', t => {
  const f = fixture(t);
  const failure = { code: 'unavailable' as const, message: 'ENS resolution is unavailable.' };
  const accepted = f.store.admit(input(), f.now());
  assert.deepEqual(f.store.reject({ ...input(), failure }, f.now()), accepted);
  assert.deepEqual(f.store.reject({ ...input(2, 1), failure }, f.now()), accepted);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM claim_rejections').get()?.count, 0);
  f.store.settle(accepted.id, 'failed', 'No transaction was signed.', f.now());
  assert.equal('rejection' in f.store.reject({ ...input(), failure }, f.now()), false);
  assert.deepEqual(f.store.reject({ ...input(2, 1), failure }, f.now()), { rejection: failure });
  f.store.admit(input(3, 1), f.now());
  assert.deepEqual(f.store.reject({ ...input(2, 1), failure }, f.now()), { rejection: failure });
});

test('FIFO signing assigns unique durable nonces while already sent claims confirm independently', async t => {
  const f = fixture(t);
  await Promise.all([f.relayer.claim(input(1)), f.relayer.claim(input(2)), f.relayer.claim(input(3))]);
  await f.relayer.tick();
  assert.deepEqual(f.prepared.map(value => value.nonce), ['0', '1', '2']);
  assert.deepEqual(f.prepared.map(value => value.outstanding), ['0', '1000', '2000']);
  assert.equal(f.sent.length, 3);
  f.receipts.set(f.sent[1].signed.transactionHash, 'confirmed');
  f.advance(15_000);
  await f.relayer.tick();
  assert.equal(f.relayer.status(input(2))?.state, 'confirmed');
  assert.equal(f.relayer.status(input(1))?.state, 'pending');
  assert.equal(f.store.account()?.nextNonce, '3');
});

test('failed preparation leaves no nonce reservation and request replay never signs a second attempt', async t => {
  const f = fixture(t);
  f.failPrepare(new EthereumApiError('unavailable', 'Claim fee exceeds the configured cap.'));
  const failed = await f.relayer.claim(input());
  assert.equal(failed.state, 'failed');
  assert.match(failed.error!, /fee exceeds/);
  assert.equal(failed.transactionHash, null);
  assert.equal(f.store.account()?.nextNonce, null);
  f.failPrepare(null);
  assert.deepEqual(await f.relayer.claim(input()), failed);
  assert.equal(f.prepared.length, 1);
  const retry = await f.relayer.claim(input(2, 1));
  assert.equal(retry.state, 'pending');
  assert.equal(f.prepared[1].nonce, '0');
  assert.equal(f.relayer.status({ ...input(), requestId: input().requestId })?.state, 'failed');
  assert.equal(f.relayer.status({ chainId: 1, contractAddress: CONTRACT, tokenId: 1 })?.requestId, input(2).requestId);
});

test('restart after signed-payload commit replays saved bytes without signing or allocating another nonce', async t => {
  const f = fixture(t);
  f.store.pinAccount(1, PAYER);
  const admitted = f.store.admit(input(), f.now());
  f.store.persistSigned(admitted.id, f.signed(input(), '0'), f.now());
  const restarted = f.reopen();
  assert.equal(restarted.status(input())?.state, 'pending');
  await restarted.tick();
  assert.equal(f.prepared.length, 0);
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].signed.nonce, '0');
  assert.equal(f.store.account()?.nextNonce, '1');
});

test('lost broadcast response retains pending hash and prevents later nonce assignment until replay is accepted', async t => {
  const f = fixture(t);
  f.failBroadcast(new Error('RPC response lost'));
  const pending = await f.relayer.claim(input());
  assert.equal(pending.state, 'pending');
  assert.ok(pending.transactionHash);
  const waiting = await f.relayer.claim(input(2));
  assert.equal(waiting.state, 'submitting');
  assert.equal(f.prepared.length, 1);
  f.failBroadcast(null);
  f.advance(30_000);
  await f.reopen().tick();
  assert.equal(f.sent[0].signed.rawTransaction, f.sent[1].signed.rawTransaction);
  assert.deepEqual(f.prepared.map(value => value.nonce), ['0', '1']);
  assert.equal(f.store.get(1).broadcastAccepted, true);
  assert.equal(f.store.get(2).broadcastAccepted, true);
});

test('temporary sponsorship pause preserves the saved transaction and resumes replay before expiry', async t => {
  const f = fixture(t);
  f.failBroadcast(new Error('Provider temporarily offline'));
  const pending = await f.relayer.claim(input());
  const signed = f.store.get(1).signed;
  f.failBroadcast(new EthereumApiError('unavailable', 'Backend claiming is temporarily unavailable.'));
  f.advance(30_000);
  await f.reopen().tick();
  assert.deepEqual(f.relayer.status(input()), pending);
  assert.equal(f.store.get(1).broadcastAccepted, false);
  assert.equal((await f.relayer.claim(input(2))).state, 'submitting');
  assert.equal(f.prepared.length, 1);
  assert.equal(f.events.length, 0);

  f.failBroadcast(null);
  f.advance(30_000);
  await f.reopen().tick();
  assert.ok(f.now() < signed!.authorizationDeadline * 1000);
  assert.deepEqual(f.sent.filter(attempt => attempt.id === 1).map(attempt => attempt.signed), [signed, signed, signed]);
  assert.deepEqual(f.relayer.status(input()), pending);
  assert.equal(f.store.get(1).broadcastAccepted, true);
  assert.equal(f.store.get(2).broadcastAccepted, true);
  assert.deepEqual(f.prepared.map(value => value.nonce), ['0', '1']);
});

test('authorization expiry preserves unresolved nonce and hash, blocks new signing, and continues observation', async t => {
  const f = fixture(t);
  const pending = await f.relayer.claim(input());
  f.advance(600_000);
  const waiting = await f.relayer.claim(input(2));
  const recovery = f.relayer.status(input());
  assert.equal(recovery?.state, 'recovery-required');
  assert.equal(recovery?.transactionHash, pending.transactionHash);
  assert.equal(waiting.state, 'failed');
  assert.match(waiting.error!, /temporarily unavailable/);
  assert.equal(f.prepared.length, 1);
  assert.equal(f.sent.length, 1);
  assert.equal(f.events.length, 1);
  f.receipts.set(pending.transactionHash!, 'confirmed');
  f.advance(15_000);
  await f.reopen().tick();
  assert.equal(f.relayer.status(input())?.state, 'confirmed');
  assert.equal(f.prepared.length, 1);
  await f.relayer.claim(input(3, 2));
  assert.equal(f.prepared.length, 2);
  assert.equal(f.prepared[1].nonce, '1');
});

for (const [code, message] of [
  ['unauthenticated', 'This claim link has been revoked.'],
  ['failed-precondition', 'This claim authorization is no longer valid.'],
] as const) {
  test(`permanent broadcast rejection (${code}) keeps the hash visible without replay or nonce reuse`, async t => {
    const f = fixture(t);
    const pending = await f.relayer.claim(input());
    f.failBroadcast(new EthereumApiError(code, message));
    f.advance(30_000);
    await f.reopen().tick();
    const recovery = f.relayer.status(input());
    assert.equal(recovery?.state, 'recovery-required');
    assert.equal(recovery?.transactionHash, pending.transactionHash);
    f.failBroadcast(null);
    f.advance(30_000);
    await f.relayer.tick();
    assert.equal(f.sent.length, 2);
    assert.equal(f.store.account()?.nextNonce, '1');
  });
}

test('confirmed failures allow explicit retry at a fresh nonce while old request IDs stay failed', async t => {
  const f = fixture(t);
  const pending = await f.relayer.claim(input());
  f.receipts.set(pending.transactionHash!, 'failed');
  f.advance(15_000);
  await f.relayer.tick();
  assert.equal((await f.relayer.claim(input())).state, 'failed');
  assert.equal(f.prepared.length, 1);
  const retried = await f.relayer.claim(input(2, 1));
  assert.equal(retried.state, 'pending');
  assert.equal(f.prepared[1].nonce, '1');
  assert.equal(f.relayer.status({ ...input(), requestId: input().requestId })?.state, 'failed');
});

test('relayer key rotation cannot allocate new nonces with pending transactions but cannot hide their status', async t => {
  const f = fixture(t);
  const pending = await f.relayer.claim(input());
  f.setPayer(OTHER);
  const blocked = await f.relayer.claim(input(2));
  assert.equal(blocked.state, 'failed');
  assert.match(blocked.error!, /unresolved transactions/);
  assert.equal(f.reopen().status(input())?.transactionHash, pending.transactionHash);
  f.receipts.set(pending.transactionHash!, 'confirmed');
  f.advance(15_000);
  await f.reopen().tick();
  const next = await f.relayer.claim(input(3, 2));
  assert.equal(next.state, 'pending');
  assert.equal(f.store.account()?.address, OTHER);
  assert.equal(f.prepared[1].nonce, '0');
});

test('the signing pump survives overlapping awaited work without reserving duplicate nonces', async t => {
  const f = fixture(t);
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  f.beforePrepare(async () => { entered(); await blocked; });
  const one = f.relayer.claim(input());
  await started;
  const two = f.relayer.claim(input(2));
  assert.equal(f.store.account()?.nextNonce, null);
  release();
  await Promise.all([one, two]);
  f.beforePrepare(null);
  await f.relayer.tick();
  assert.deepEqual(f.prepared.map(value => value.nonce), ['0', '1']);
});

test('malformed scopes are rejected and status is isolated by network and contract', async t => {
  const f = fixture(t);
  await assert.rejects(f.relayer.claim({ ...input(), recipient: `0x${'0'.repeat(40)}` }), /Invalid sponsored/);
  await f.relayer.claim(input());
  assert.equal(f.relayer.status({ ...input(), contractAddress: OTHER }), null);
  assert.equal(f.relayer.status({ ...input(), chainId: 11155111 }), null);
  assert.equal(f.relayer.status({ ...input(), requestId: requestId(999) }), null);
});

test('unknown external pending nonce fails before signing instead of skipping an untracked transaction', async t => {
  const f = fixture(t);
  f.chain.nonce = async () => ({ latest: '0', pending: '1' });
  const result = await f.relayer.claim(input());
  assert.equal(result.state, 'failed');
  assert.match(result.error!, /account needs attention/);
  assert.equal(f.prepared.length, 0);
  assert.equal(f.store.account()?.nextNonce, null);
});

test('missing relayer key creates a replayable definitive failure without reserving any nonce', async t => {
  const f = fixture(t);
  f.chain.relayerAddress = () => { throw new EthereumApiError('unavailable', 'Backend claiming is temporarily unavailable.'); };
  const failed = await f.relayer.claim(input());
  assert.equal(failed.state, 'failed');
  assert.equal(failed.transactionHash, null);
  assert.equal(f.store.account(), null);
  assert.deepEqual(await f.reopen().claim(input()), failed);
  assert.equal(f.prepared.length, 0);
});

test('alarm failure cannot leave a new durable intent without recovery scheduled', async t => {
  const f = fixture(t);
  const relayer = new TarotClaimRelayer(f.store, f.chain, async () => { throw new Error('Alarm unavailable'); }, f.now);
  await assert.rejects(relayer.claim(input()), /Alarm unavailable/);
  assert.equal(f.store.status(input()), null);
  assert.equal(f.prepared.length, 0);
});

test('slow receipt checks rotate across pending attempts instead of starving later claims', async t => {
  const f = fixture(t);
  await Promise.all([f.relayer.claim(input(1)), f.relayer.claim(input(2)), f.relayer.claim(input(3))]);
  await f.relayer.tick();
  const inspected: number[] = [];
  f.chain.inspect = async attempt => { inspected.push(attempt.tokenId); f.advance(21_000); return 'pending'; };
  f.advance(15_000);
  for (let index = 0; index < 3; index++) await f.relayer.tick();
  assert.deepEqual(inspected.toSorted(), [1, 2, 3]);
});

test('slow receipt checks leave a separate bounded window for signing queued claims', async t => {
  const f = fixture(t);
  await f.relayer.claim(input(1));
  f.store.admit(input(2), f.now());
  f.store.admit(input(3), f.now());
  f.chain.inspect = async () => { f.advance(21_000); return 'pending'; };
  f.beforePrepare(async () => { f.advance(21_000); });
  f.advance(15_000);
  await f.relayer.tick();
  assert.equal(f.relayer.status(input(1))?.state, 'pending');
  assert.equal(f.relayer.status(input(2))?.state, 'pending');
  assert.equal(f.store.get(2).broadcastAccepted, true);
  assert.equal(f.relayer.status(input(3))?.state, 'submitting');
  assert.deepEqual(f.prepared.map(value => value.nonce), ['0', '1']);

  f.advance(15_000);
  await f.relayer.tick();
  assert.equal(f.relayer.status(input(3))?.state, 'pending');
  assert.equal(f.store.get(3).broadcastAccepted, true);
  assert.deepEqual(f.prepared.map(value => value.nonce), ['0', '1', '2']);
});

test('an expired attempt blocks signing even when a slow receipt check leaves it unvisited', async t => {
  const f = fixture(t);
  await f.relayer.claim(input(1));
  f.advance(100_000);
  await f.relayer.claim(input(2));
  f.advance(500_000);
  f.store.admit(input(3), f.now());
  const inspected: number[] = [];
  f.chain.inspect = async attempt => { inspected.push(attempt.tokenId); f.advance(21_000); return 'pending'; };
  await f.relayer.tick();
  assert.deepEqual(inspected, [2]);
  assert.equal(f.relayer.status(input(1))?.state, 'pending');
  assert.equal(f.store.get(1).broadcastAccepted, true);
  assert.ok(f.store.get(1).signed!.authorizationDeadline * 1000 <= f.now());
  assert.equal(f.relayer.status(input(3))?.state, 'submitting');
  assert.deepEqual(f.prepared.map(value => value.nonce), ['0', '1']);
  assert.equal(f.store.account()?.nextNonce, '2');

  f.advance(15_000);
  await f.relayer.tick();
  assert.deepEqual(inspected, [2, 1]);
  assert.equal(f.relayer.status(input(1))?.state, 'recovery-required');
  assert.equal(f.relayer.status(input(3))?.state, 'failed');
  assert.deepEqual(f.prepared.map(value => value.nonce), ['0', '1']);
  assert.equal(f.store.account()?.nextNonce, '2');
});

for (const stage of ['validation', 'nonce lookup', 'preparation'] as const) {
  test(`an older authorization expiring during ${stage} prevents committing the queued nonce`, async t => {
    const f = fixture(t);
    const pending = await f.relayer.claim(input(1));
    f.advance(599_000);
    if (stage === 'validation') f.chain.validate = async () => { f.advance(2_000); };
    else if (stage === 'nonce lookup') f.chain.nonce = async () => { f.advance(2_000); return { latest: '0', pending: '1' }; };
    else f.beforePrepare(async () => { f.advance(2_000); });

    const waiting = await f.relayer.claim(input(2));
    assert.equal(waiting.state, 'submitting');
    assert.equal(waiting.transactionHash, null);
    assert.equal(f.store.get(2).signed, null);
    assert.equal(f.store.account()?.nextNonce, '1');
    assert.equal(f.prepared.length, stage === 'preparation' ? 2 : 1);
    assert.equal(f.sent.filter(attempt => attempt.tokenId === 2).length, 0);
    assert.ok(f.store.get(1).signed!.authorizationDeadline * 1000 <= f.now());

    f.advance(15_000);
    await f.relayer.tick();
    assert.equal(f.relayer.status(input(1))?.state, 'recovery-required');
    assert.equal(f.relayer.status(input(1))?.transactionHash, pending.transactionHash);
    assert.equal(f.relayer.status(input(2))?.state, 'failed');
    assert.equal(f.store.account()?.nextNonce, '1');
    assert.equal(f.sent.filter(attempt => attempt.tokenId === 2).length, 0);
  });
}

test('expiry during one queued broadcast stops later queue iterations from allocating more nonces', async t => {
  const f = fixture(t);
  await f.relayer.claim(input(1));
  f.advance(597_000);
  for (const tokenId of [2, 3, 4]) f.store.admit(input(tokenId), f.now());
  f.beforeBroadcast(attempt => { if (attempt.tokenId === 2) f.advance(4_000); });

  await f.relayer.tick();
  assert.equal(f.relayer.status(input(2))?.state, 'pending');
  for (const tokenId of [3, 4]) {
    assert.equal(f.relayer.status(input(tokenId))?.state, 'submitting');
    assert.equal(f.store.get(tokenId).signed, null);
  }
  assert.deepEqual(f.prepared.map(attempt => attempt.input.tokenId), [1, 2]);
  assert.equal(f.store.account()?.nextNonce, '2');
  assert.ok(f.sent.every(attempt => attempt.tokenId <= 2));
});
