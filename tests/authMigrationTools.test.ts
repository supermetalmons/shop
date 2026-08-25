import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseAnonymousAuthControlArgs,
  runAnonymousAuthControl,
} from '../scripts/ops/anonymousAuthControl.ts';
import {
  buildOwnershipPlan,
  buildDeliveryOrderOwnershipQuery,
  decodeDeliveryOrderOwnershipPage,
  parseWalletBinding,
  parseOwnershipMigrationArgs,
} from '../scripts/ops/migrateFirebaseWalletOwnership.ts';

const enabledControl = {
  firebaseFallbackEnabled: true,
  revision: 1,
  createdAtMs: 0,
  updatedAtMs: 0,
  firebaseDisabledAtMs: null,
};

const disabledControl = {
  firebaseFallbackEnabled: false,
  revision: 2,
  createdAtMs: 0,
  updatedAtMs: 1000,
  firebaseDisabledAtMs: 1000,
};

const cleanAudit = {
  scannedOrders: 10,
  mappedUpdates: 0,
  unmappedFirebaseOrders: 1,
};

test('anonymous auth control requires an explicit irreversible write and clean ownership audit', async () => {
  assert.deepEqual(parseAnonymousAuthControlArgs(['status']), { command: 'status', write: false });
  assert.deepEqual(parseAnonymousAuthControlArgs(['disable-firebase', '--write']), {
    command: 'disable-firebase',
    write: true,
  });
  assert.throws(() => parseAnonymousAuthControlArgs(['disable-firebase']), /requires --write/);
  assert.match(await runAnonymousAuthControl({ command: 'status', write: false }, {
    read: () => enabledControl,
    disable: () => disabledControl,
    audit: async () => cleanAudit,
  }), /fallback enabled/);
  let auditCalls = 0;
  assert.match(await runAnonymousAuthControl({ command: 'disable-firebase', write: true }, {
    read: () => enabledControl,
    disable: () => disabledControl,
    audit: async () => {
      auditCalls += 1;
      return cleanAudit;
    },
  }), /fallback disabled/);
  assert.equal(auditCalls, 2);
  await assert.rejects(runAnonymousAuthControl({ command: 'disable-firebase', write: true }, {
    read: () => enabledControl,
    disable: () => enabledControl,
    audit: async () => cleanAudit,
  }), /was not disabled/);
  let disabled = false;
  await assert.rejects(runAnonymousAuthControl({ command: 'disable-firebase', write: true }, {
    read: () => enabledControl,
    disable: () => {
      disabled = true;
      return disabledControl;
    },
    audit: async () => ({ ...cleanAudit, mappedUpdates: 1 }),
  }), /still need migration/);
  assert.equal(disabled, false);
  let postAuditCalls = 0;
  await assert.rejects(runAnonymousAuthControl({ command: 'disable-firebase', write: true }, {
    read: () => enabledControl,
    disable: () => {
      disabled = true;
      return disabledControl;
    },
    audit: async () => {
      postAuditCalls += 1;
      return { ...cleanAudit, mappedUpdates: postAuditCalls === 1 ? 0 : 1 };
    },
  }), /fallback is disabled.*need migration/);
  assert.equal(disabled, true);
  let alreadyDisabledAuditCalls = 0;
  assert.match(await runAnonymousAuthControl({ command: 'disable-firebase', write: true }, {
    read: () => disabledControl,
    disable: () => assert.fail('already-disabled control must not be written'),
    audit: async () => {
      alreadyDisabledAuditCalls += 1;
      return cleanAudit;
    },
  }), /Post-disable ownership audit clean/);
  assert.equal(alreadyDisabledAuditCalls, 1);
  let failedPostAuditCalls = 0;
  await assert.rejects(runAnonymousAuthControl({ command: 'disable-firebase', write: true }, {
    read: () => enabledControl,
    disable: () => disabledControl,
    audit: async () => {
      failedPostAuditCalls += 1;
      if (failedPostAuditCalls === 1) return cleanAudit;
      throw new Error('Firestore unavailable');
    },
  }), /fallback is disabled.*ownership audit failed.*Firestore unavailable/);
  await assert.rejects(runAnonymousAuthControl({ command: 'disable-firebase', write: true }, {
    read: () => enabledControl,
    disable: () => { throw new Error('Wrangler connection lost'); },
    audit: async () => cleanAudit,
  }), /disable outcome is unknown.*status before retrying/);
});

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
