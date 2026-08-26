import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildOwnershipPlan,
  buildDeliveryOrderOwnershipQuery,
  decodeDeliveryOrderOwnershipPage,
  parseWalletBinding,
  parseOwnershipMigrationArgs,
} from '../scripts/ops/migrateFirebaseWalletOwnership.ts';

test('wallet ownership migration is guarded and separates mapped from unmapped Firebase orders', () => {
  assert.deepEqual(parseOwnershipMigrationArgs(['status']), { command: 'status', write: false });
  assert.deepEqual(parseOwnershipMigrationArgs(['apply', '--write']), { command: 'apply', write: true });
  assert.throws(() => parseOwnershipMigrationArgs(['apply']), /requires --write/);
  const plan = buildOwnershipPlan([
    { firebaseUid: 'uid-a', wallet: 'wallet-a' },
    { firebaseUid: 'uid-b', wallet: 'wallet-a' },
  ], [
    {
      path: 'drops/drop/deliveryOrders/1',
      id: '1',
      data: { owner: 'firebase:uid-a', untouched: true },
      updateTime: '2026-08-25T12:00:00.000Z',
    },
    {
      path: 'drops/drop/deliveryOrders/2',
      id: '2',
      data: { owner: 'firebase:unmapped' },
      updateTime: '2026-08-25T12:00:00.000Z',
    },
    {
      path: 'drops/drop/deliveryOrders/3',
      id: '3',
      data: { owner: 'wallet-a' },
      updateTime: '2026-08-25T12:00:00.000Z',
    },
  ]);
  assert.equal(plan.scannedOrders, 3);
  assert.equal(plan.mappedUpdates.length, 1);
  assert.equal(plan.mappedUpdates[0].firebaseUid, 'uid-a');
  assert.equal(plan.mappedUpdates[0].wallet, 'wallet-a');
  assert.equal(plan.unmappedFirebaseOrders, 1);
  assert.deepEqual(parseWalletBinding({
    firebase_uid: 'uid-a',
    wallet: '11111111111111111111111111111111',
  }), {
    firebaseUid: 'uid-a',
    wallet: '11111111111111111111111111111111',
  });
  assert.throws(
    () => parseWalletBinding({ firebase_uid: 'uid-a', wallet: 'A'.repeat(32) }),
    /invalid wallet binding/,
  );
});

test('wallet ownership audit is bounded, cursor-paginated, and fail-closed', () => {
  const firstQuery = buildDeliveryOrderOwnershipQuery(null) as any;
  assert.equal(firstQuery.structuredQuery.limit, 250);
  assert.deepEqual(firstQuery.structuredQuery.orderBy, [{
    field: { fieldPath: '__name__' },
    direction: 'ASCENDING',
  }]);
  const cursorQuery = buildDeliveryOrderOwnershipQuery('drops/drop/deliveryOrders/250') as any;
  assert.deepEqual(cursorQuery.structuredQuery.startAt, {
    values: [{
      referenceValue: 'projects/mons-shop/databases/(default)/documents/drops/drop/deliveryOrders/250',
    }],
    before: false,
  });
  assert.deepEqual(decodeDeliveryOrderOwnershipPage([{
    document: {
      name: 'projects/mons-shop/databases/(default)/documents/drops/drop/deliveryOrders/1',
      fields: { owner: { stringValue: 'firebase:uid-a' } },
      updateTime: '2026-08-25T12:00:00.000Z',
    },
    readTime: '2026-08-25T12:00:01.000Z',
  }, {
    readTime: '2026-08-25T12:00:01.000Z',
  }]).map((document) => document.path), ['drops/drop/deliveryOrders/1']);
  assert.throws(
    () => decodeDeliveryOrderOwnershipPage([{ document: { fields: {} } }]),
    /invalid delivery-order document/,
  );
  assert.throws(
    () => decodeDeliveryOrderOwnershipPage([{
      document: {
        name: 'projects/mons-shop/databases/(default)/documents/drops/drop/deliveryOrders/1',
        fields: { owner: { mapValue: { fields: {} } } },
      },
    }]),
    /invalid delivery-order owner/,
  );
});
