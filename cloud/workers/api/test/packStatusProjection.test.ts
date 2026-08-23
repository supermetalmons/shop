import test from 'node:test';
import assert from 'node:assert/strict';
import type { PackStatusD1Database, PackStatusD1Statement } from '../src/d1PackStatus.ts';
import { applyPackStatusDualWrite } from '../src/packStatusProjection.ts';

function dataDb(run: () => Promise<D1Result>): PackStatusD1Database {
  const result = <T>(): D1Result<T> => ({
    success: true,
    meta: {
      duration: 0,
      size_after: 0,
      rows_read: 0,
      rows_written: 1,
      last_row_id: 0,
      changed_db: true,
      changes: 1,
    },
    results: [],
  });
  const statement = (): PackStatusD1Statement => ({
    bind() {
      return this;
    },
    first: async <T>() => null as T | null,
    run: async <T>() => {
      await run();
      return result<T>();
    },
  });
  return {
    prepare: () => statement(),
  };
}

function writeResult(): D1Result {
  return {
    success: true,
    meta: {
      duration: 0,
      size_after: 0,
      rows_read: 0,
      rows_written: 1,
      last_row_id: 0,
      changed_db: true,
      changes: 1,
    },
    results: [],
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

test('pack-status dual write applies the same event independently to both stores', async () => {
  const calls: string[] = [];
  await applyPackStatusDualWrite({
    dataDb: dataDb(async () => {
      calls.push('d1');
      return writeResult();
    }),
    event,
    firestore: async () => {
      calls.push('firestore');
    },
  });
  assert.deepEqual(calls.sort(), ['d1', 'firestore']);
});

test('pack-status dual write records one store failure after allowing the sibling to finish', async () => {
  const calls: string[] = [];
  const logs: Record<string, unknown>[] = [];
  await assert.rejects(
    applyPackStatusDualWrite({
      dataDb: dataDb(async () => {
        calls.push('d1');
        return writeResult();
      }),
      event,
      firestore: async () => {
        calls.push('firestore');
        throw new Error('firestore unavailable');
      },
      log: (entry) => logs.push(entry),
    }),
    AggregateError,
  );
  assert.deepEqual(calls.sort(), ['d1', 'firestore']);
  assert.equal(logs.length, 1);
  assert.equal(logs[0]?.store, 'firestore');
  assert.equal(logs[0]?.eventKey, 'box-1');
});
