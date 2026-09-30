import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { createTestHarness } from 'wrangler';
import {
  CommerceWriteConflict,
  D1CommerceRepository,
  commerceKeys,
  type CommerceDocumentKey,
} from '../src/commerceRepository.ts';
import { packStatusOutboxInsertStatement } from '../src/packStatusOutboxRepository.ts';
import { packStatusOutboxDueQuery } from '../src/commerceQueries.ts';
import type { PackStatusOutboxRecord } from '../../../../shared/packStatusOutbox.ts';

function lease(db: D1Database): D1PreparedStatement {
  return db.prepare(`INSERT INTO commerce_authority_control_lease (singleton, lease_token, acquired_at_ms, expires_at_ms)
    VALUES (1, '00000000-0000-4000-8000-000000000029', CAST(strftime('%s', 'now') AS INTEGER) * 1000,
      CAST(strftime('%s', 'now') AS INTEGER) * 1000 + 60000)`);
}

function drained(db: D1Database): D1PreparedStatement {
  return db.prepare(`UPDATE commerce_authority_control SET paused_at_ms = CAST(strftime('%s', 'now') AS INTEGER) * 1000,
    updated_at_ms = CAST(strftime('%s', 'now') AS INTEGER) * 1000 WHERE singleton = 1`);
}

function pause(db: D1Database): D1PreparedStatement[] {
  return [lease(db), db.prepare(`UPDATE commerce_authority_control SET authority_state = 'paused', revision = revision + 1,
    paused_at_ms = NULL, updated_at_ms = CAST(strftime('%s', 'now') AS INTEGER) * 1000 WHERE singleton = 1`), drained(db)];
}

function resume(db: D1Database): D1PreparedStatement[] {
  return [db.prepare(`UPDATE commerce_authority_control SET authority_state = 'd1', revision = revision + 1,
    paused_at_ms = NULL, updated_at_ms = CAST(strftime('%s', 'now') AS INTEGER) * 1000 WHERE singleton = 1`),
  db.prepare('DELETE FROM commerce_authority_control_lease WHERE singleton = 1')];
}

function insertParent(db: D1Database, key: CommerceDocumentKey, data: Record<string, unknown>): D1PreparedStatement {
  return db.prepare(`INSERT INTO commerce_documents (document_path, document_kind, drop_id, document_id, document_json,
    version, create_time, update_time) VALUES (?, ?, ?, ?, ?, 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`)
    .bind(key.path, key.kind, key.dropId, key.documentId, JSON.stringify(data));
}

function outbox(key: CommerceDocumentKey, changes: Partial<PackStatusOutboxRecord> = {}): PackStatusOutboxRecord {
  return {
    parentPath: key.path, dropId: key.dropId!, generation: crypto.randomUUID(), state: 'pending', revision: 1,
    failureCount: 0, nextAttemptAtMs: 10, completedAtMs: null, failedAtMs: null, lastErrorCode: null,
    createdAtMs: 0, updatedAtMs: 0, ...changes,
  };
}

test('real D1 expands pack-status outboxes and preserves atomic enqueue, CAS, indexes, and parent cascades', async (context) => {
  const directory = mkdtempSync(join(tmpdir(), 'mons-pack-status-outbox-migrations-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const source = resolve('cloud/workers/api/commerce-migrations');
  for (const name of readdirSync(source).filter((name) => name.endsWith('.sql') && name < '0029_')) {
    copyFileSync(join(source, name), join(directory, name));
  }
  const production = JSON.parse(readFileSync('cloud/workers/api/wrangler.jsonc', 'utf8'));
  const runtime = { ...production, main: resolve('cloud/workers/api/src/index.ts'), routes: undefined,
    d1_databases: production.d1_databases.map((database: Record<string, unknown>) => ({ ...database, remote: false,
      migrations_dir: database.binding === 'COMMERCE_DB' ? directory : resolve('cloud/workers/api', String(database.migrations_dir)) })) };
  delete runtime.$schema;
  delete runtime.secrets;
  const server = createTestHarness({ root: resolve('.'), workers: [{ config: runtime }] });
  try {
    await server.listen();
    const worker = server.getWorker<Env>('mons-shop-api');
    await worker.applyD1Migrations('COMMERCE_DB');
    const { COMMERCE_DB: db } = await worker.getEnv();
    assert.equal((await db.prepare('SELECT name FROM d1_migrations ORDER BY id DESC LIMIT 1').first<{ name: string }>())!.name,
      '0028_preorder_card_range_1413.sql');
    await db.batch([lease(db), drained(db),
      db.prepare("UPDATE commerce_notification_outbox_control SET preparation_state = 'preparing' WHERE singleton = 1"),
      db.prepare("UPDATE commerce_notification_outbox_control SET preparation_state = 'ready', source_documents_revision = 0, prepared_at_ms = 0 WHERE singleton = 1"),
      db.prepare("UPDATE commerce_notification_outbox_control SET storage_mode = 'table' WHERE singleton = 1"),
      db.prepare("UPDATE commerce_stripe_checkout_state_control SET preparation_state = 'preparing', source_documents_revision = 0 WHERE singleton = 1"),
      db.prepare("UPDATE commerce_stripe_checkout_state_control SET preparation_state = 'ready', prepared_at_ms = 0 WHERE singleton = 1"),
      db.prepare("UPDATE commerce_stripe_checkout_state_control SET storage_mode = 'table' WHERE singleton = 1"),
      ...resume(db),
    ]);
    const key = commerceKeys.deliveryOrder('runtime', 'legacy');
    await db.batch([
      insertParent(db, key, { owner: 'original-owner', status: 'ready_to_ship', packStatusProjectionState: 'pending',
        packStatusProjectionNextAttemptAtMs: 10 }),
      db.prepare('UPDATE commerce_authority_control SET documents_revision = documents_revision + 1 WHERE singleton = 1'),
    ]);
    const repository = new D1CommerceRepository(db);
    await assert.rejects(repository.packStatusOutbox.get(key.path), { code: 'unavailable' });
    copyFileSync(join(source, '0029_pack_status_outbox.sql'), join(directory, '0029_pack_status_outbox.sql'));
    await worker.applyD1Migrations('COMMERCE_DB');
    assert.deepEqual(await db.prepare(`SELECT storage_mode, preparation_state FROM commerce_pack_status_outbox_control`).first(),
      { storage_mode: 'legacy', preparation_state: 'idle' });
    await db.batch([
      db.prepare("UPDATE commerce_documents SET document_json = json_set(document_json, '$.packStatusProjectionNextAttemptAtMs', 20), version = version + 1 WHERE document_path = ?").bind(key.path),
      db.prepare('UPDATE commerce_authority_control SET documents_revision = documents_revision + 1 WHERE singleton = 1'),
    ]);
    await assert.rejects(repository.packStatusOutbox.get(key.path), { code: 'unavailable' });

    const rollbackKey = commerceKeys.deliveryOrder('runtime', 'rollback');
    const beforeRollback = await db.prepare('SELECT documents_revision FROM commerce_authority_control').first();
    await assert.rejects(repository.run(100, async (unit) => {
      await unit.create(rollbackKey, { status: 'ready_to_ship' });
      unit.enqueuePackStatusProjection({ parentPath: rollbackKey.path, dropId: 'runtime' });
    }), { code: 'unavailable' });
    assert.equal(await repository.get(rollbackKey), null);
    assert.equal(await db.prepare('SELECT parent_path FROM commerce_pack_status_outbox WHERE parent_path = ?').bind(rollbackKey.path).first(), null);
    assert.deepEqual(await db.prepare('SELECT documents_revision FROM commerce_authority_control').first(), beforeRollback);
    assert.equal((await db.prepare('SELECT COUNT(*) AS count FROM commerce_commit_guards').first<{ count: number }>())!.count, 0);

    await db.batch([...pause(db), db.prepare(`UPDATE commerce_pack_status_outbox_control SET preparation_state = 'preparing',
      source_documents_revision = (SELECT documents_revision FROM commerce_authority_control WHERE singleton = 1)`)]);
    await assert.rejects(db.batch(resume(db)), /pack-status outbox cutover is incomplete/);
    await db.prepare("UPDATE commerce_pack_status_outbox_control SET preparation_state = 'ready', prepared_at_ms = 0").run();
    await assert.rejects(db.prepare("UPDATE commerce_pack_status_outbox_control SET storage_mode = 'table'").run(),
      /pack-status outbox preparation is incomplete/);
    await db.prepare("UPDATE commerce_pack_status_outbox_control SET preparation_state = 'preparing'").run();
    const imported = outbox(key, { nextAttemptAtMs: 20 });
    await packStatusOutboxInsertStatement(db, imported).run();
    await db.prepare("UPDATE commerce_pack_status_outbox_control SET preparation_state = 'ready', prepared_at_ms = 0").run();
    await db.prepare("UPDATE commerce_pack_status_outbox_control SET storage_mode = 'table'").run();
    await db.batch(resume(db));
    assert.deepEqual(await repository.packStatusOutbox.get(key.path), imported);
    await assert.rejects(db.prepare("UPDATE commerce_documents SET document_json = json_set(document_json, '$.packStatusProjectionFailureCount', 1), version = version + 1 WHERE document_path = ?")
      .bind(key.path).run(), /legacy pack-status projection writes are disabled/);

    const parentBeforeRetry = await db.prepare('SELECT document_json, version, update_time FROM commerce_documents WHERE document_path = ?').bind(key.path).first();
    const revisionBeforeRetry = await db.prepare('SELECT documents_revision FROM commerce_authority_control').first();
    const retry = { state: 'pending' as const, failureCount: 1, nextAttemptAtMs: 200, completedAtMs: null,
      failedAtMs: null, lastErrorCode: 'provider-unavailable' };
    const retried = await repository.packStatusOutbox.compareAndSet({ expected: imported, changes: retry, nowMs: 100 });
    assert.ok(retried);
    assert.equal(retried.revision, 2);
    assert.equal(await repository.packStatusOutbox.compareAndSet({ expected: imported, changes: retry, nowMs: 101 }), null);
    assert.deepEqual(await db.prepare('SELECT document_json, version, update_time FROM commerce_documents WHERE document_path = ?').bind(key.path).first(), parentBeforeRetry);
    assert.deepEqual(await db.prepare('SELECT documents_revision FROM commerce_authority_control').first(), revisionBeforeRetry);
    for (const changes of ["failure_count = -1", "state = 'completed'", "generation = '00000000-0000-4000-8000-000000000030'"]) {
      await assert.rejects(db.prepare(`UPDATE commerce_pack_status_outbox SET revision = revision + 1, ${changes} WHERE parent_path = ?`)
        .bind(key.path).run(), /constraint|revision conflict/i);
      assert.deepEqual(await repository.packStatusOutbox.get(key.path), retried);
    }
    const complete = { state: 'completed' as const, failureCount: 1, nextAttemptAtMs: null, completedAtMs: 300,
      failedAtMs: null, lastErrorCode: null };
    const completed = await repository.packStatusOutbox.compareAndSet({ expected: retried, changes: complete, nowMs: 300 });
    assert.ok(completed);
    assert.equal(completed.revision, 3);
    assert.equal(await repository.packStatusOutbox.compareAndSet({ expected: retried, changes: retry, nowMs: 301 }), null);
    await repository.run(400, async (unit) => {
      await unit.update(key, { owner: 'updated-owner' });
      unit.enqueuePackStatusProjection({ parentPath: key.path, dropId: 'runtime' });
    });
    assert.deepEqual(await repository.packStatusOutbox.get(key.path), completed);

    await repository.run(500, async (unit) => {
      await unit.create(rollbackKey, { status: 'ready_to_ship' });
      unit.enqueuePackStatusProjection({ parentPath: rollbackKey.path, dropId: 'runtime' });
      unit.enqueuePackStatusProjection({ parentPath: rollbackKey.path, dropId: 'runtime' });
    });
    assert.equal((await repository.get(rollbackKey))!.data.status, 'ready_to_ship');
    assert.equal((await repository.packStatusOutbox.get(rollbackKey.path))!.revision, 1);
    const conflictKey = commerceKeys.deliveryOrder('runtime', 'conflict');
    await repository.run(600, (unit) => unit.create(conflictKey, { status: 'prepared' }));
    const stale = await repository.begin(700);
    await stale.update(conflictKey, { status: 'ready_to_ship' });
    stale.enqueuePackStatusProjection({ parentPath: conflictKey.path, dropId: 'runtime' });
    await repository.run(800, (unit) => unit.update(conflictKey, { owner: 'winner' }));
    await assert.rejects(stale.commit(), CommerceWriteConflict);
    assert.equal((await repository.get(conflictKey))!.data.status, 'prepared');
    assert.equal(await repository.packStatusOutbox.get(conflictKey.path), null);
    await assert.rejects(packStatusOutboxInsertStatement(db, outbox(commerceKeys.deliveryOrder('runtime', 'missing'))).run(),
      /parent mismatch/);

    const dueKeys = ['a', 'b', 'earlier', 'future'].map((id) => commerceKeys.deliveryOrder('due', id));
    const dueTimes = [2, 2, 1, 6];
    const fixtures = dueKeys.map((entry, index) => ({ key: entry, row: outbox(entry, { nextAttemptAtMs: dueTimes[index] }) }));
    const otherKey = commerceKeys.deliveryOrder('other', 'earlier');
    fixtures.push({ key: otherKey, row: outbox(otherKey, { nextAttemptAtMs: 0 }) });
    for (let index = 0; index < 40; index += 1) {
      const entry = commerceKeys.deliveryOrder('due', `completed-${index}`);
      fixtures.push({ key: entry, row: outbox(entry, { state: 'completed', nextAttemptAtMs: null, completedAtMs: 0 }) });
    }
    await db.batch([
      ...fixtures.flatMap((entry) => [insertParent(db, entry.key, { status: 'ready_to_ship' }), packStatusOutboxInsertStatement(db, entry.row)]),
      db.prepare('UPDATE commerce_authority_control SET documents_revision = documents_revision + 1 WHERE singleton = 1'),
    ]);
    const query = packStatusOutboxDueQuery({ dropId: 'due', dueAtMs: 2, limit: 2 });
    for (const analyzed of [false, true]) {
      if (analyzed) await db.prepare('ANALYZE commerce_pack_status_outbox').run();
      assert.deepEqual((await repository.packStatusOutbox.queryDue({ dropId: 'due', dueAtMs: 2, limit: 2 }))
        .map((entry) => entry.parentPath), [dueKeys[2].path, dueKeys[0].path]);
      const rows = await db.prepare(query.sql).bind(...query.bindings).all();
      assert.ok(Number.isSafeInteger(rows.meta.rows_read) && rows.meta.rows_read <= 12,
        `Pack-status due query read ${rows.meta.rows_read} rows (analyzed: ${analyzed})`);
      const plan = (await db.prepare(`EXPLAIN QUERY PLAN ${query.sql}`).bind(...query.bindings)
        .all<{ detail: string }>()).results.map((row) => row.detail).join('\n');
      assert.match(plan, /SEARCH commerce_pack_status_outbox USING INDEX commerce_pack_status_outbox_due/);
      assert.doesNotMatch(plan, /SCAN|USE TEMP B-TREE/);
    }
    await assert.rejects(db.prepare('DELETE FROM commerce_documents WHERE document_path = ?').bind(key.path).run(),
      /pack-status outbox deletion requires maintenance/);
    assert.deepEqual(await repository.packStatusOutbox.get(key.path), completed);
    await db.batch(pause(db));
    await assert.rejects(repository.packStatusOutbox.get(key.path), { code: 'unavailable' });
    await assert.rejects(repository.packStatusOutbox.compareAndSet({ expected: completed, changes: complete, nowMs: 900 }),
      { code: 'unavailable' });
    await db.prepare('DELETE FROM commerce_documents WHERE document_path = ?').bind(key.path).run();
    assert.equal(await db.prepare('SELECT parent_path FROM commerce_pack_status_outbox WHERE parent_path = ?').bind(key.path).first(), null);
    assert.equal((await db.prepare('SELECT COUNT(*) AS count FROM commerce_pack_status_outbox WHERE drop_id = ?').bind('other')
      .first<{ count: number }>())!.count, 1);
    const foreignKeys = await db.prepare('PRAGMA foreign_key_list(commerce_pack_status_outbox)').all<{ table: string; from: string; to: string; on_delete: string }>();
    assert.ok(foreignKeys.results.some((foreignKey) => foreignKey.table === 'commerce_documents' &&
      foreignKey.from === 'parent_path' && foreignKey.to === 'document_path' && foreignKey.on_delete === 'CASCADE'));
    assert.deepEqual((await db.prepare('PRAGMA foreign_key_check').all()).results, []);
    assert.equal((await db.prepare('SELECT COUNT(*) AS count FROM commerce_commit_guards').first<{ count: number }>())!.count, 0);
  } finally {
    await server.close();
  }
});
