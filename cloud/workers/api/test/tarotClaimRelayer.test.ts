import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { EthereumApiError } from '../src/ethereumError.ts';
import { TarotClaimRelayer, type TarotClaimChain, type TarotClaimInput, type TarotClaimInspection, type TarotSignedAttempt, type TarotSignedClaim } from '../src/tarotClaimRelayer.ts';
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
const scope = ({ chainId, contractAddress, tokenId }: TarotClaimInput) => ({ chainId, contractAddress, tokenId });
const observation = (status: TarotClaimInspection['status'], finalized = status !== 'pending',
  blockNumber = 100, blockHash = `0x${'bb'.repeat(32)}`): TarotClaimInspection => ({ status, finalized,
  blockNumber: status === 'pending' ? null : blockNumber, blockHash: status === 'pending' ? null : blockHash });

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
  const receipts = new Map<string, TarotClaimInspection['status'] | TarotClaimInspection>();
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
    inspect: async value => {
      const receipt = receipts.get(value.signed.transactionHash) ?? 'pending';
      return typeof receipt === 'string' ? observation(receipt) : receipt;
    },
    broadcast: async value => {
      assert.deepEqual(store.get(value.id).signed, value.signed);
      assert.equal(store.get(value.id).lastBroadcastAtMs, now);
      sent.push(value);
      onBroadcast?.(value);
      nextNetworkNonce = String(BigInt(value.signed.nonce) + 1n > BigInt(nextNetworkNonce)
        ? BigInt(value.signed.nonce) + 1n : BigInt(nextNetworkNonce));
      if (broadcastFailure) throw broadcastFailure;
    },
  };
  const reopen = () => new TarotClaimRelayer(new TarotClaimRelayerStore(sql, atomic), chain,
    async at => { alarms.push(at); }, () => now, event => events.push(event));
  return { store, chain, db, events, alarms, sent, prepared, receipts, signed, reopen, relayer: reopen(),
    advance: (ms: number) => { now += ms; }, now: () => now,
    setPayer: (value: string) => { payer = value; nextNetworkNonce = '0'; }, setNonce: (value: string) => { nextNetworkNonce = value; },
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

test('finalized sponsored failures prevent another paid attempt while old request IDs stay failed', async t => {
  const f = fixture(t);
  const pending = await f.relayer.claim(input());
  f.receipts.set(pending.transactionHash!, 'failed');
  f.advance(15_000);
  await f.relayer.tick();
  assert.equal((await f.relayer.claim(input())).state, 'failed');
  assert.equal(f.prepared.length, 1);
  for (const retry of [input(2, 1), { ...input(3, 1), recipient: OTHER }, { ...input(4, 1), codeHash: '66'.repeat(32) }]) {
    await assert.rejects(f.relayer.claim(retry), error => error instanceof TarotClaimRejected && /wallet/.test(error.message));
    await assert.rejects(f.reopen().claim(retry), error => error instanceof TarotClaimRejected && /wallet/.test(error.message));
  }
  assert.equal(f.prepared.length, 1);
  assert.equal(f.store.account()?.nextNonce, '1');
  assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM claim_rejections').get()?.count, 3);
  assert.equal(f.relayer.status(input())?.finalized, true);
  assert.match(f.relayer.status(input())!.error!, /wallet/);
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
  f.chain.inspect = async attempt => { inspected.push(attempt.tokenId); f.advance(21_000); return observation('pending'); };
  f.advance(15_000);
  for (let index = 0; index < 3; index++) await f.relayer.tick();
  assert.deepEqual(inspected.toSorted(), [1, 2, 3]);
});

test('slow receipt checks leave a separate bounded window for signing queued claims', async t => {
  const f = fixture(t);
  await f.relayer.claim(input(1));
  f.store.admit(input(2), f.now());
  f.store.admit(input(3), f.now());
  f.chain.inspect = async () => { f.advance(21_000); return observation('pending'); };
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
  f.chain.inspect = async attempt => { inspected.push(attempt.tokenId); f.advance(21_000); return observation('pending'); };
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

for (const state of ['confirmed', 'failed'] as const) {
  test(`a provisional ${state} receipt stays watched and an orphan replays its original transaction`, async t => {
    const f = fixture(t);
    const pending = await f.relayer.claim(input());
    const original = f.store.get(1).signed;
    f.receipts.set(pending.transactionHash!, observation(state, false));
    f.advance(15_000);
    await f.relayer.tick();
    const included = f.relayer.status(input())!;
    assert.equal(included.state, state === 'failed' ? 'pending' : 'confirmed');
    assert.equal(included.finalized, false);
    assert.ok(included.revision! > pending.revision!);
    assert.equal(f.store.unresolved().length, 1);
    assert.equal(f.store.outstandingFeeWei(), '1000');
    assert.equal((await f.relayer.claim({ ...input(2, 1), recipient: OTHER })).requestId, input().requestId);
    assert.equal(f.prepared.length, 1);

    f.receipts.set(pending.transactionHash!, observation('pending'));
    f.setNonce('0');
    f.advance(15_000);
    await f.reopen().tick();
    const orphaned = f.relayer.status(input())!;
    assert.equal(orphaned.state, 'pending');
    assert.equal(orphaned.transactionHash, pending.transactionHash);
    assert.ok(orphaned.revision! > included.revision!);
    assert.equal(f.store.get(1).receiptBlockHash, null);
    assert.deepEqual(f.store.get(1).signed, original);
    assert.equal(f.prepared.length, 1);
    assert.deepEqual(f.sent.map(value => value.signed), [original, original]);
    assert.equal(f.store.account()?.nextNonce, '1');
  });

  test(`an expired orphaned ${state} receipt enters recovery without replay or a new nonce`, async t => {
    const f = fixture(t);
    const pending = await f.relayer.claim(input());
    f.receipts.set(pending.transactionHash!, observation(state, false));
    f.advance(15_000);
    await f.relayer.tick();
    f.advance(600_000);
    f.receipts.set(pending.transactionHash!, observation('pending'));
    f.setNonce('0');
    await f.reopen().tick();
    assert.equal(f.relayer.status(input())?.state, 'recovery-required');
    assert.equal(f.relayer.status(input())?.transactionHash, pending.transactionHash);
    assert.equal((await f.relayer.claim(input(2))).state, 'failed');
    assert.equal(f.sent.length, 1);
    assert.equal(f.prepared.length, 1);
    assert.equal(f.store.account()?.nextNonce, '1');
  });
}

test('included receipts survive authorization expiry and unavailable finality without rebroadcasting', async t => {
  const f = fixture(t);
  const pending = await f.relayer.claim(input());
  f.receipts.set(pending.transactionHash!, observation('confirmed', false));
  f.advance(15_000);
  await f.relayer.tick();
  const included = f.relayer.status(input())!;
  f.advance(600_000);
  f.chain.inspect = async () => { throw new Error('Finality is temporarily unavailable.'); };
  await f.reopen().tick();
  assert.deepEqual(f.relayer.status(input()), included);
  assert.equal(f.sent.length, 1);
  const next = await f.relayer.claim(input(2));
  assert.equal(next.state, 'pending');
  assert.equal(f.prepared[1].nonce, '1');
  assert.equal(f.prepared[1].outstanding, '1000');
  f.setPayer(OTHER);
  assert.equal((await f.relayer.claim(input(3))).state, 'failed');
  assert.equal(f.store.account()?.address, PAYER);
  assert.equal(f.relayer.status(input())?.finalized, false);
});

test('receipt movement advances revision and finalized receipts leave reconciliation', async t => {
  const f = fixture(t);
  const pending = await f.relayer.claim(input());
  f.receipts.set(pending.transactionHash!, observation('confirmed', false));
  f.advance(15_000);
  await f.relayer.tick();
  const included = f.relayer.status(input())!;
  const moved = observation('confirmed', false, 101, `0x${'cc'.repeat(32)}`);
  f.receipts.set(pending.transactionHash!, moved);
  f.advance(15_000);
  await f.relayer.tick();
  const relocated = f.relayer.status(input())!;
  assert.ok(relocated.revision! > included.revision!);
  assert.equal(f.store.get(1).receiptBlockNumber, 101);
  assert.equal(f.store.get(1).receiptBlockHash, moved.blockHash);
  assert.equal(f.sent.length, 1);
  f.receipts.set(pending.transactionHash!, { ...moved, finalized: true });
  f.advance(15_000);
  await f.relayer.tick();
  assert.equal(f.relayer.status(input())?.finalized, true);
  assert.ok(f.relayer.status(input())!.revision! > relocated.revision!);
  assert.equal(f.store.unresolved().length, 0);
  assert.equal(f.store.outstandingFeeWei(), '0');
  assert.equal(f.store.account()?.nextNonce, '1');
  f.chain.inspect = async () => { assert.fail('Finalized receipts must not be polled.'); };
  await f.reopen().tick();
});

test('a lower pending network nonce holds queued signing even when receipt polling has not reached its predecessor', async t => {
  const f = fixture(t);
  await f.relayer.claim(input(1));
  await f.relayer.claim(input(2));
  f.setNonce('0');
  f.advance(15_000);
  const inspected: number[] = [];
  f.chain.inspect = async attempt => {
    inspected.push(attempt.id);
    f.advance(21_000);
    return observation('confirmed', false);
  };
  const queued = await f.relayer.claim(input(3));
  assert.deepEqual(inspected, [2]);
  assert.equal(queued.state, 'submitting');
  assert.equal(queued.transactionHash, null);
  assert.deepEqual(f.prepared.map(value => value.nonce), ['0', '1']);
  assert.equal(f.store.account()?.nextNonce, '2');
});

test('a nonce rollback during preparation prevents committing the higher signed nonce', async t => {
  const f = fixture(t);
  await f.relayer.claim(input(1));
  f.beforePrepare(async () => { f.setNonce('0'); });
  const queued = await f.relayer.claim(input(2));
  assert.equal(queued.state, 'submitting');
  assert.equal(queued.transactionHash, null);
  assert.equal(f.store.get(2).signed, null);
  assert.equal(f.store.account()?.nextNonce, '1');
  assert.equal(f.sent.length, 1);
  assert.deepEqual(f.prepared.map(value => value.nonce), ['0', '1']);
});

test('a finalized paid failure cannot be bypassed through an older unsigned failed attempt or a different request', async t => {
  const f = fixture(t);
  f.failPrepare(new Error('No transaction signed.'));
  await f.relayer.claim(input(1));
  f.failPrepare(null);
  const paid = await f.relayer.claim(input(2, 1));
  f.receipts.set(paid.transactionHash!, observation('failed'));
  f.advance(15_000);
  await f.relayer.tick();
  assert.equal((await f.relayer.claim(input(1))).transactionHash, null);
  await assert.rejects(f.relayer.claim(input(3, 1)), error => error instanceof TarotClaimRejected && /wallet/.test(error.message));
  assert.equal(f.prepared.length, 2);
  assert.equal(f.sent.length, 1);
  assert.equal(f.store.sponsorshipExhausted({ ...input(), chainId: 11155111 }), false);
  assert.equal(f.store.sponsorshipExhausted({ ...input(), contractAddress: OTHER }), false);
  assert.equal(f.store.sponsorshipExhausted(input(4, 2)), false);
});

test('legacy signed terminal rows migrate as unfinalized and an orphan can coexist with a newer unsigned retry', async t => {
  const f = fixture(t);
  const paid = await f.relayer.claim(input(1));
  f.store.settle(1, 'failed', 'Legacy failed receipt.', f.now());
  f.db.prepare(`INSERT INTO claim_attempts(chain_id,contract_address,token_id,request_id,recipient,code_hash,state,created_at_ms,updated_at_ms)
    VALUES(?,?,?,?,?,?,'submitting',?,?)`).run(1, CONTRACT, 1, requestId(2), OTHER, codeHash, f.now(), f.now());
  const confirmed = await f.relayer.claim(input(3, 2));
  f.store.settle(1, 'failed', 'Legacy failed receipt.', f.now());
  f.store.settle(3, 'confirmed', null, f.now());
  for (const column of ['receipt_block_number', 'receipt_block_hash', 'finalized', 'revision']) {
    f.db.exec(`ALTER TABLE claim_attempts DROP COLUMN ${column}`);
  }
  f.db.exec(`CREATE UNIQUE INDEX claim_active_token ON claim_attempts(chain_id,contract_address,token_id) WHERE state<>'failed'`);
  const restarted = f.reopen();
  assert.equal(f.store.get(1).finalized, false);
  assert.equal(f.store.get(3).finalized, false);
  assert.equal(f.store.get(1).revision, 0);
  assert.equal(f.store.get(3).receiptBlockHash, null);
  assert.equal(f.store.unresolved().length, 3);
  assert.equal(restarted.status(scope(input(1)))?.requestId, input(1).requestId);
  assert.equal(restarted.status(scope(input(1)))?.state, 'pending');
  assert.equal(restarted.status({ ...input(2, 1), requestId: requestId(2) })?.state, 'submitting');
  f.receipts.set(paid.transactionHash!, observation('pending'));
  f.receipts.set(confirmed.transactionHash!, observation('confirmed', false));
  f.advance(15_000);
  await restarted.tick();
  assert.equal(f.store.get(1).state, 'pending');
  assert.equal(f.store.get(2).state, 'submitting');
  assert.equal(f.store.get(3).state, 'confirmed');
  assert.equal(f.prepared.length, 2);
  assert.equal(f.db.prepare("SELECT 1 FROM sqlite_schema WHERE name='claim_active_token'").get(), undefined);
  f.receipts.set(paid.transactionHash!, observation('failed'));
  f.advance(15_000);
  await restarted.tick();
  assert.equal(f.store.get(2).state, 'failed');
  assert.equal(f.store.get(2).signed, null);
  assert.match(f.store.get(2).error!, /wallet/);
  assert.equal(f.prepared.length, 2);
  assert.equal(f.store.account()?.nextNonce, '2');
  const selected = restarted.status(scope(input(1)))!;
  assert.equal(selected.requestId, input(1).requestId);
  assert.equal(selected.state, 'failed');
  assert.equal(selected.finalized, true);
  assert.equal(selected.transactionHash, paid.transactionHash);
  assert.equal(restarted.status({ ...input(2, 1), requestId: requestId(2) })?.transactionHash, null);
});

test('scope status cannot hide an unresolved signed claim behind a newer unsigned failure', async t => {
  const f = fixture(t);
  const paid = await f.relayer.claim(input(1));
  f.db.prepare(`INSERT INTO claim_attempts(chain_id,contract_address,token_id,request_id,recipient,code_hash,state,error,created_at_ms,updated_at_ms)
    VALUES(?,?,?,?,?,?,'failed','Legacy unsigned failure.',?,?)`).run(1, CONTRACT, 1, requestId(2), OTHER, codeHash, f.now(), f.now());
  const restarted = f.reopen();
  assert.equal(restarted.status(scope(input(1)))?.requestId, input(1).requestId);
  assert.equal(restarted.status(scope(input(1)))?.state, 'pending');
  const historical = restarted.status({ ...input(2, 1), requestId: requestId(2) });
  assert.equal(historical?.state, 'failed');
  assert.equal(historical?.transactionHash, null);
  f.receipts.set(paid.transactionHash!, observation('failed', false));
  f.advance(15_000);
  await restarted.tick();
  assert.equal(restarted.status(scope(input(1)))?.state, 'pending');
  assert.equal(restarted.status(scope(input(1)))?.requestId, input(1).requestId);
  f.receipts.set(paid.transactionHash!, observation('failed'));
  f.advance(15_000);
  await restarted.tick();
  const limited = restarted.status(scope(input(1)))!;
  assert.equal(limited.state, 'failed');
  assert.equal(limited.finalized, true);
  assert.equal(limited.transactionHash, paid.transactionHash);
  assert.match(limited.error!, /wallet/);
  assert.deepEqual(restarted.status({ ...input(2, 1), requestId: requestId(2) }), historical);
});
