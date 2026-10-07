import assert from 'node:assert/strict';
import test from 'node:test';
import { updateDeliveryRecoveryRecord } from '../../../../shared/deliveryRecoveryState.ts';
import { D1CommerceRepository, commerceKeys, type CommerceUnitOfWork } from '../src/commerceRepository.ts';
import { createCommerceD1Harness } from './commerceD1Harness.ts';

test('a mixed delivery, recovery and outbox commit rolls back every staged write on a final statement failure', async (context) => {
  const failure = new Error('injected final commit failure');
  let failCommit = false;
  const harness = createCommerceD1Harness({ observeStatement: ({ sql }) => {
    if (failCommit && sql.startsWith('DELETE FROM commerce_commit_guards')) throw failure;
  } });
  context.after(() => harness.database.close());
  const repository = new D1CommerceRepository(harness.db);
  const key = commerceKeys.deliveryOrder('card_nft_2', '7');
  await repository.run(1_000, (unit) => unit.create(key, {
    owner: 'wallet', dropId: key.dropId, deliveryId: 7, status: 'processing',
    items: [{ kind: 'box', refId: 1 }], receiptRecovery: { preparedProbeCount: 0 },
  }));
  const tables = harness.database.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name LIKE 'commerce_%' ORDER BY name")
    .all().map((row) => String(row.name));
  const snapshot = () => Object.fromEntries(tables.map((table) => [table, harness.database.prepare(`SELECT * FROM ${table}`).all()]));
  const before = snapshot();
  const notificationGeneration = crypto.randomUUID();
  const stage = async (unit: CommerceUnitOfWork) => {
    const recovery = await unit.getRecoverySnapshot({ ...key, kind: 'delivery_order' });
    assert.ok(recovery);
    unit.stageRecovery(updateDeliveryRecoveryRecord(recovery.state, {
      receiptRecoveryJson: '{"preparedProbeCount":1}',
    }, 2_000));
    await unit.update(key, { status: 'ready_to_ship', fulfillmentStatus: 'Shipped' });
    await unit.enqueueNotificationOutbox({
      parentPath: key.path, family: 'shipped', dropId: key.dropId!, generation: notificationGeneration,
      entries: [{ kind: 'buyer_order_shipped', jobId: crypto.randomUUID(),
        idempotencyKey: 'card_nft_2:7:order_shipped', state: 'pending' }],
      retryUntilMs: 10_000,
    });
    unit.enqueuePackStatusProjection({ parentPath: key.path, dropId: key.dropId! });
  };

  failCommit = true;
  await assert.rejects(repository.run(2_000, stage), (error) => error === failure);
  assert.deepEqual(snapshot(), before);

  failCommit = false;
  await repository.run(2_000, stage);
  const result = await repository.getRecoverySnapshot({ ...key, kind: 'delivery_order' });
  assert.equal(result?.order.data.status, 'ready_to_ship');
  assert.equal(result?.state.revision, 2);
  assert.equal(result?.state.receiptRecoveryJson, '{"preparedProbeCount":1}');
  assert.equal((await repository.notificationOutbox.get(key.path, 'shipped'))?.generation, notificationGeneration);
  assert.equal((await repository.packStatusOutbox.get(key.path))?.state, 'pending');
  assert.deepEqual(harness.database.prepare('SELECT * FROM commerce_commit_guards').all(), []);
});
