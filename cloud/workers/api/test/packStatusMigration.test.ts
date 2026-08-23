import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PACK_STATUS_EVENT_TIMESTAMP_TOLERANCE_MS,
  parseArgs,
  runMigrationCommand,
  snapshotSql,
  assertTargetEventsCompatible,
  verifySnapshots,
  type D1Snapshot,
  type SourceSnapshot,
} from '../../../../scripts/migrate-pack-status-to-d1.ts';

const source: SourceSnapshot = {
  summaries: [{
    version: 1,
    dropId: 'card_nft_2',
    totalInitialSupply: 10,
    totalCards: 30,
    cardsPerPack: 3,
    unsealedOnline: 2,
    redeemedIrlNormal: 1,
    redeemedIrlStripe: 2,
    redeemedUnsealedCards: 1,
    rebuiltAtMs: 100,
    updatedAtMs: 200,
  }],
  events: [{
    dropId: 'card_nft_2',
    type: 'onlineReveal',
    eventKey: "box-'one",
    quantity: 3,
    increments: { unsealedOnline: 1 },
    boxAssetId: "box-'one",
    signature: 'signature-1',
    createdAtMs: 150,
  }],
};

const target: D1Snapshot = {
  summaries: source.summaries.map((summary) => ({ ...summary })),
  events: source.events.map((event) => ({ ...event, applyDelta: 0 })),
};

test('pack-status migration arguments are exact and bounded', () => {
  assert.deepEqual(parseArgs(['backfill']), { command: 'backfill' });
  assert.deepEqual(parseArgs(['verify', '--firestore-service-account-file', 'reader.json']), {
    command: 'verify',
    firestoreServiceAccountFile: 'reader.json',
  });
  assert.throws(() => parseArgs([]));
  assert.throws(() => parseArgs(['cutover', '--unknown']));
});

test('pack-status backfill SQL upserts summaries and imports idempotency events without deltas', () => {
  const sql = snapshotSql(source);
  assert.match(sql, /ON CONFLICT\(drop_id\) DO UPDATE SET/);
  assert.match(sql, /WHERE \(SELECT COUNT\(\*\) FROM pack_status_events\) = 1/);
  assert.match(sql, /INSERT OR IGNORE INTO pack_status_events/);
  assert.match(sql, /box-''one/);
  assert.match(sql, /\n      0, 150\n/);
});

test('pack-status snapshot verification rejects summary and event drift', () => {
  assert.doesNotThrow(() => verifySnapshots(source, target));
  assert.doesNotThrow(() => verifySnapshots(source, {
    ...target,
    summaries: [{ ...target.summaries[0], updatedAtMs: 999 }],
  }));
  assert.throws(() => verifySnapshots(source, {
    ...target,
    summaries: [{ ...target.summaries[0], unsealedOnline: 3 }],
  }), /summaries/);
  assert.throws(() => verifySnapshots(source, { ...target, events: [] }), /events/);
  assert.throws(() => verifySnapshots(source, {
    ...target,
    events: [{ ...target.events[0], quantity: 4 }],
  }), /event/);
  assert.throws(() => verifySnapshots(source, {
    ...target,
    events: [{ ...target.events[0], createdAtMs: 151 }],
  }), /timestamp or apply mode/);
  assert.doesNotThrow(() => verifySnapshots(source, {
    ...target,
    events: [{ ...target.events[0], applyDelta: 1, createdAtMs: 150 + PACK_STATUS_EVENT_TIMESTAMP_TOLERANCE_MS }],
  }));
  assert.throws(() => verifySnapshots(source, {
    ...target,
    events: [{ ...target.events[0], applyDelta: 1, createdAtMs: 151 + PACK_STATUS_EVENT_TIMESTAMP_TOLERANCE_MS }],
  }), /timestamp or apply mode/);
});

test('pack-status backfill rejects D1-only and conflicting events before mutation', () => {
  assert.throws(() => assertTargetEventsCompatible(source, {
    ...target,
    events: [...target.events, { ...target.events[0], eventKey: 'd1-only' }],
  }), /missing from Firestore/);
  assert.throws(() => assertTargetEventsCompatible(source, {
    ...target,
    events: [{ ...target.events[0], quantity: 4 }],
  }), /differs from Firestore/);
});

test('pack-status backfill retries an interrupted import and converges', async () => {
  let applyCount = 0;
  const logs: string[] = [];
  await runMigrationCommand('backfill', {
    apply: () => { applyCount += 1; },
    log: (message) => logs.push(message),
    readSource: async () => source,
    readTarget: () => applyCount >= 2 ? target : { summaries: [], events: [] },
    setReadSource: () => assert.fail('backfill must not cut over'),
    smoke: async () => assert.fail('backfill must not smoke production'),
  });
  assert.equal(applyCount, 2);
  assert.match(logs[0], /Backfilled 1 summaries and 1 events/);
});

test('pack-status cutover verifies first and automatically rolls back a failed smoke', async () => {
  const sources: string[] = [];
  await assert.rejects(
    runMigrationCommand('cutover', {
      apply: () => assert.fail('cutover must not backfill'),
      log: () => undefined,
      readSource: async () => source,
      readTarget: () => target,
      setReadSource: (value) => { sources.push(value); },
      smoke: async (_snapshot, expectedSource) => {
        assert.equal(expectedSource, 'd1');
        throw new Error('smoke failed');
      },
    }),
    /Firestore reads were restored/,
  );
  assert.deepEqual(sources, ['d1', 'firestore']);
});

test('pack-status cutover and rollback expose only their reviewed source transitions', async () => {
  const sources: string[] = [];
  let smokes = 0;
  const dependencies = {
    apply: () => assert.fail('source transitions must not backfill'),
    log: () => undefined,
    readSource: async () => source,
    readTarget: () => target,
    setReadSource: (value: 'firestore' | 'd1') => { sources.push(value); },
    smoke: async (_snapshot: SourceSnapshot, expectedSource: 'firestore' | 'd1') => {
      assert.equal(expectedSource, smokes === 0 ? 'd1' : 'firestore');
      smokes += 1;
    },
  };
  await runMigrationCommand('cutover', dependencies);
  await runMigrationCommand('rollback', dependencies);
  assert.deepEqual(sources, ['d1', 'firestore']);
  assert.equal(smokes, 2);
});
