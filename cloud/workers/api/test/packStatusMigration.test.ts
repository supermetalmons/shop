import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseArgs,
  runMigrationCommand,
  snapshotSql,
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
  events: source.events.map((event) => ({
    dropId: event.dropId,
    type: event.type,
    eventKey: event.eventKey,
  })),
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
  assert.match(sql, /INSERT OR IGNORE INTO pack_status_events/);
  assert.match(sql, /box-''one/);
  assert.match(sql, /\n      0, 150\n/);
});

test('pack-status snapshot verification rejects summary and event drift', () => {
  assert.doesNotThrow(() => verifySnapshots(source, target));
  assert.throws(() => verifySnapshots(source, {
    ...target,
    summaries: [{ ...target.summaries[0], unsealedOnline: 3 }],
  }), /summaries/);
  assert.throws(() => verifySnapshots(source, { ...target, events: [] }), /event identities/);
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
      smoke: async () => { throw new Error('smoke failed'); },
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
    smoke: async () => { smokes += 1; },
  };
  await runMigrationCommand('cutover', dependencies);
  await runMigrationCommand('rollback', dependencies);
  assert.deepEqual(sources, ['d1', 'firestore']);
  assert.equal(smokes, 2);
});
