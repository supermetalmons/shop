import test from 'node:test';
import assert from 'node:assert/strict';
import type { PackStatusD1Database, PackStatusD1Statement } from '../src/d1PackStatus.ts';
import { applyPackStatusProjection } from '../src/packStatusProjection.ts';

function dataDb(run: () => Promise<number>): PackStatusD1Database {
  const result = <T>(changes: number): D1Result<T> => ({
    success: true,
    meta: {
      duration: 0,
      size_after: 0,
      rows_read: 0,
      rows_written: 1,
      last_row_id: 0,
      changed_db: true,
      changes,
    },
    results: [],
  });
  const statement = (): PackStatusD1Statement => ({
    bind() {
      return this;
    },
    first: async <T>() => null as T | null,
    run: async <T>() => {
      const changes = await run();
      return result<T>(changes);
    },
  });
  return {
    prepare: () => statement(),
  };
}

const event = {
  dropId: 'card_nft_2',
  type: 'onlineReveal' as const,
  eventKey: 'box-1',
  quantity: 3,
  increments: { unsealedOnline: 1 },
  boxAssetId: 'box-1',
  signature: 'signature-1',
  createdAtMs: 100,
};

test('pack-status projection writes its event to required D1', async () => {
  let calls = 0;
  await applyPackStatusProjection({
    dataDb: dataDb(async () => {
      calls += 1;
      return 1;
    }),
    event,
  });
  assert.equal(calls, 1);
});

test('pack-status projection treats a duplicate D1 event as success', async () => {
  let calls = 0;
  await applyPackStatusProjection({
    dataDb: dataDb(async () => {
      calls += 1;
      return 0;
    }),
    event,
  });
  assert.equal(calls, 1);
});

test('pack-status projection fails when DATA_DB is missing', async () => {
  const logs: Record<string, unknown>[] = [];
  await assert.rejects(
    applyPackStatusProjection({
      event,
      log: (entry) => logs.push(entry),
    }),
    /pack_status_data_db_not_configured/,
  );
  assert.equal(logs.length, 1);
  assert.equal(logs[0]?.store, 'd1');
});

test('pack-status projection logs and surfaces a D1 failure', async () => {
  const logs: Record<string, unknown>[] = [];
  await assert.rejects(
    applyPackStatusProjection({
      dataDb: dataDb(async () => {
        throw new Error('d1 unavailable');
      }),
      event,
      log: (entry) => logs.push(entry),
    }),
    /pack_status_d1_write_failed/,
  );
  assert.equal(logs.length, 1);
  assert.equal(logs[0]?.store, 'd1');
  assert.equal(logs[0]?.eventKey, 'box-1');
});
