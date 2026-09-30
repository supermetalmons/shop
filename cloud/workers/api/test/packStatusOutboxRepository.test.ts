import assert from 'node:assert/strict';
import test from 'node:test';
import { D1CommerceRepository, commerceKeys } from '../src/commerceRepository.ts';
import { createCommerceD1Harness, seedCommerceDocument } from './commerceD1Harness.ts';
import { parsePackStatusOutboxRecord, type PackStatusOutboxMutation } from '../../../../shared/packStatusOutbox.ts';

const key = commerceKeys.deliveryOrder('card_nft_2', '7');
const completed: PackStatusOutboxMutation = {
  state: 'completed', failureCount: 0, nextAttemptAtMs: null,
  completedAtMs: 20, failedAtMs: null, lastErrorCode: null,
};

async function enqueue(repository: D1CommerceRepository, nowMs = 10): Promise<void> {
  await repository.run(nowMs, async (unit) => {
    await unit.update(key, { status: 'ready_to_ship' });
    unit.enqueuePackStatusProjection({ parentPath: key.path, dropId: 'card_nft_2' });
  });
}

function setup(options: Parameters<typeof createCommerceD1Harness>[0] = {}) {
  const harness = createCommerceD1Harness(options);
  seedCommerceDocument(harness, { key, data: { status: 'processing', owner: 'owner', deliveryId: 7,
    items: [{ kind: 'box', refId: 1 }] } });
  return { harness, repository: new D1CommerceRepository(harness.db) };
}

test('pack projection enqueue commits with the ready order and never resets an existing terminal record', async (t) => {
  const { harness, repository } = setup();
  t.after(() => harness.database.close());
  await enqueue(repository);
  const outbox = (await repository.packStatusOutbox.get(key.path))!;
  assert.equal((await repository.get(key))?.data.status, 'ready_to_ship');
  assert.equal(outbox.state, 'pending');
  assert.equal(outbox.nextAttemptAtMs, 10);
  const terminal = await repository.packStatusOutbox.compareAndSet({ expected: outbox, changes: completed, nowMs: 20 });
  await enqueue(repository, 30);
  assert.deepEqual(await repository.packStatusOutbox.get(key.path), terminal);
  assert.equal(Object.hasOwn((await repository.get(key))!.data, 'packStatusProjectionState'), false);
});

test('a rejected outbox insert rolls back the entire ready transition', async (t) => {
  const { harness, repository } = setup({ packStatusOutboxMode: 'legacy' });
  t.after(() => harness.database.close());
  const before = await repository.get(key);
  const revision = harness.database.prepare('SELECT documents_revision FROM commerce_authority_control').get();
  await assert.rejects(enqueue(repository), /unavailable/);
  assert.deepEqual(await repository.get(key), before);
  assert.deepEqual(harness.database.prepare('SELECT documents_revision FROM commerce_authority_control').get(), revision);
  assert.equal(harness.database.prepare('SELECT COUNT(*) AS count FROM commerce_pack_status_outbox').get()?.count, 0);
});

test('enqueue validates the final staged delivery state before committing', async (t) => {
  const { harness, repository } = setup();
  t.after(() => harness.database.close());
  await assert.rejects(repository.run(10, async (unit) => {
    await unit.update(key, { status: 'ready_to_ship' });
    unit.enqueuePackStatusProjection({ parentPath: key.path, dropId: 'card_nft_2' });
    await unit.update(key, { status: 'processing' });
  }), /staged ready delivery/);
  assert.equal((await repository.get(key))?.data.status, 'processing');
  assert.equal(await repository.packStatusOutbox.get(key.path), null);
});

test('retry and completion preserve every parent and commerce revision', async (t) => {
  const { harness, repository } = setup();
  t.after(() => harness.database.close());
  await enqueue(repository);
  const snapshot = () => [
    harness.database.prepare('SELECT * FROM commerce_documents WHERE document_path = ?').get(key.path),
    harness.database.prepare('SELECT * FROM commerce_authority_control').all(),
    harness.database.prepare('SELECT * FROM commerce_document_path_revisions').all(),
    harness.database.prepare('SELECT * FROM commerce_delivery_owner_revisions').all(),
  ];
  const before = snapshot();
  const original = (await repository.packStatusOutbox.get(key.path))!;
  const retry = await repository.packStatusOutbox.compareAndSet({ expected: original, nowMs: 20,
    changes: { state: 'pending', failureCount: 1, nextAttemptAtMs: 500,
      completedAtMs: null, failedAtMs: null, lastErrorCode: 'd1-write-failed' } });
  assert.ok(retry);
  assert.equal(await repository.packStatusOutbox.compareAndSet({ expected: original, changes: completed, nowMs: 21 }), null);
  const terminal = await repository.packStatusOutbox.compareAndSet({ expected: retry, changes: { ...completed, failureCount: 1 }, nowMs: 30 });
  assert.equal(terminal?.state, 'completed');
  assert.deepEqual(snapshot(), before);
});

test('generation and terminal CAS guards reject stale attempts', async (t) => {
  const { harness, repository } = setup();
  t.after(() => harness.database.close());
  await enqueue(repository);
  const expected = (await repository.packStatusOutbox.get(key.path))!;
  assert.equal(await repository.packStatusOutbox.compareAndSet({
    expected: { ...expected, generation: crypto.randomUUID() }, changes: completed, nowMs: 20,
  }), null);
  const terminal = (await repository.packStatusOutbox.compareAndSet({ expected, changes: completed, nowMs: 20 }))!;
  assert.equal(await repository.packStatusOutbox.compareAndSet({ expected: terminal, nowMs: 30,
    changes: { ...completed, state: 'pending', completedAtMs: null, nextAttemptAtMs: 30 } }), null);
  assert.deepEqual(await repository.packStatusOutbox.get(key.path), terminal);
});

test('active storage rejects legacy projection writes while unrelated delivery changes remain allowed', async (t) => {
  const { harness, repository } = setup();
  t.after(() => harness.database.close());
  await enqueue(repository);
  await assert.rejects(repository.run(20, (unit) => unit.update(key, { packStatusProjectionState: 'pending' })), /legacy pack-status/);
  await repository.run(30, (unit) => unit.update(key, { fulfillmentStatus: 'shipped' }));
  assert.equal((await repository.get(key))?.data.fulfillmentStatus, 'shipped');
});

test('record parser rejects malformed supplied counters, times, and state values', async (t) => {
  const { harness, repository } = setup();
  t.after(() => harness.database.close());
  await enqueue(repository);
  const record = (await repository.packStatusOutbox.get(key.path))!;
  for (const changes of [{ failureCount: -1 }, { failureCount: '0' }, { nextAttemptAtMs: undefined },
    { revision: 1.5 }, { state: { toString: () => 'pending' } },
    { state: { toString: () => 'completed' }, nextAttemptAtMs: null }, { failedAtMs: 1 }, { lastErrorCode: '' }]) {
    assert.throws(() => parsePackStatusOutboxRecord({ ...record, ...changes }), /Invalid pack-status/);
  }
});
