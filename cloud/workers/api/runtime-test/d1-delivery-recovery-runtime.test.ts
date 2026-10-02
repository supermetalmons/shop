import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { createTestHarness } from 'wrangler';
import { CommerceWriteConflict, D1CommerceRepository, commerceKeys } from '../src/commerceRepository.ts';
import { deliveryRecoveryWriteStatement } from '../src/deliveryRecoveryPersistence.ts';
import { deliveryRecoveryPageQuery, deliveryRecoveryStateQuery } from '../src/commerceQueries.ts';
import { createDeliveryRecoveryRecord, updateDeliveryRecoveryRecord } from '../../../../shared/deliveryRecoveryState.ts';

const SQL_NOW = "CAST(strftime('%s', 'now') AS INTEGER) * 1000";
const LEASE = '00000000-0000-4000-8000-000000000030';

function lease(db: D1Database): D1PreparedStatement {
  return db.prepare(`INSERT INTO commerce_authority_control_lease (singleton, lease_token, acquired_at_ms, expires_at_ms)
    VALUES (1, '${LEASE}', ${SQL_NOW}, ${SQL_NOW} + 60000)`);
}

function drained(db: D1Database): D1PreparedStatement {
  return db.prepare(`UPDATE commerce_authority_control SET paused_at_ms = ${SQL_NOW}, updated_at_ms = ${SQL_NOW} WHERE singleton = 1`);
}

function pause(db: D1Database): D1PreparedStatement[] {
  return [lease(db), db.prepare(`UPDATE commerce_authority_control SET authority_state = 'paused', revision = revision + 1,
    paused_at_ms = NULL, updated_at_ms = ${SQL_NOW} WHERE singleton = 1`), drained(db)];
}

function resume(db: D1Database): D1PreparedStatement[] {
  return [db.prepare(`UPDATE commerce_authority_control SET authority_state = 'd1', revision = revision + 1,
    paused_at_ms = NULL, updated_at_ms = ${SQL_NOW} WHERE singleton = 1`),
  db.prepare('DELETE FROM commerce_authority_control_lease WHERE singleton = 1')];
}

test('native D1 delivery recovery cutover preserves state, fences old writers and commits independent CAS atomically', async (context) => {
  const directory = mkdtempSync(join(tmpdir(), 'mons-delivery-recovery-migrations-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const source = resolve('cloud/workers/api/commerce-migrations');
  for (const name of readdirSync(source).filter((name) => name.endsWith('.sql') && name < '0030_')) {
    copyFileSync(join(source, name), join(directory, name));
  }
  const production = JSON.parse(readFileSync('cloud/workers/api/wrangler.jsonc', 'utf8'));
  const runtime = {
    ...production, main: resolve('cloud/workers/api/src/index.ts'), routes: undefined,
    d1_databases: production.d1_databases.map((database: Record<string, unknown>) => ({
      ...database, remote: false,
      migrations_dir: database.binding === 'COMMERCE_DB' ? directory : resolve('cloud/workers/api', String(database.migrations_dir)),
    })),
  };
  delete runtime.$schema;
  delete runtime.secrets;
  const server = createTestHarness({ root: resolve('.'), workers: [{ config: runtime }] });
  try {
    await server.listen();
    const worker = server.getWorker<Env>('mons-shop-api');
    await worker.applyD1Migrations('COMMERCE_DB');
    const { COMMERCE_DB: db } = await worker.getEnv();
    await db.batch([lease(db), drained(db),
      db.prepare("UPDATE commerce_notification_outbox_control SET preparation_state = 'preparing' WHERE singleton = 1"),
      db.prepare("UPDATE commerce_notification_outbox_control SET preparation_state = 'ready', source_documents_revision = 0, prepared_at_ms = 0 WHERE singleton = 1"),
      db.prepare("UPDATE commerce_notification_outbox_control SET storage_mode = 'table' WHERE singleton = 1"),
      ...['commerce_stripe_checkout_state_control', 'commerce_pack_status_outbox_control'].flatMap((table) => [
        db.prepare(`UPDATE ${table} SET preparation_state = 'preparing', source_documents_revision = 0 WHERE singleton = 1`),
        db.prepare(`UPDATE ${table} SET preparation_state = 'ready', prepared_at_ms = 0 WHERE singleton = 1`),
        db.prepare(`UPDATE ${table} SET storage_mode = 'table' WHERE singleton = 1`),
      ]),
      ...resume(db),
    ]);
    const key = commerceKeys.deliveryOrder('runtime', 'legacy');
    const legacy = { preparedProbeCount: '2.9', leaseExpiresAt: 2_000.5, nextPreparedProbeAt: 90_000.5,
      pendingSubmission: { signature: 'pending', unknown: true }, unknown: [true, null] };
    await db.batch([
      db.prepare(`INSERT INTO commerce_documents (document_path, document_kind, drop_id, document_id,
        document_json, version, create_time, update_time)
        VALUES (?, 'delivery_order', 'runtime', 'legacy', ?, 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`)
        .bind(key.path, JSON.stringify({ owner: 'owner', status: 'prepared', createdAt: 1_000, receiptRecovery: legacy })),
      db.prepare('UPDATE commerce_authority_control SET documents_revision = documents_revision + 1 WHERE singleton = 1'),
    ]);
    copyFileSync(join(source, '0030_delivery_recovery.sql'), join(directory, '0030_delivery_recovery.sql'));
    await worker.applyD1Migrations('COMMERCE_DB');
    assert.deepEqual(await db.prepare('SELECT storage_mode, preparation_state FROM commerce_delivery_recovery_control').first(),
      { storage_mode: 'legacy', preparation_state: 'idle' });
    const repository = new D1CommerceRepository(db);
    await assert.rejects(repository.getRecoverySnapshot(key), { code: 'unavailable' });
    await db.batch([
      db.prepare("UPDATE commerce_documents SET document_json = json_set(document_json, '$.legacyMetadata', 1), version = version + 1 WHERE document_path = ?").bind(key.path),
      db.prepare('UPDATE commerce_authority_control SET documents_revision = documents_revision + 1 WHERE singleton = 1'),
    ]);
    await db.batch([...pause(db), db.prepare(`UPDATE commerce_delivery_recovery_control SET preparation_state = 'preparing',
      source_documents_revision = (SELECT documents_revision FROM commerce_authority_control WHERE singleton = 1)`)]);
    await assert.rejects(db.batch(resume(db)), /delivery recovery cutover is incomplete/);
    await db.prepare("UPDATE commerce_delivery_recovery_control SET preparation_state = 'ready', prepared_at_ms = 0").run();
    await assert.rejects(db.prepare("UPDATE commerce_delivery_recovery_control SET storage_mode = 'table'").run(), /preparation is incomplete/);
    await db.prepare("UPDATE commerce_delivery_recovery_control SET preparation_state = 'preparing'").run();
    const imported = createDeliveryRecoveryRecord({ parentPath: key.path, receiptRecoveryJson: JSON.stringify(legacy),
      generation: crypto.randomUUID(), nowMs: 1_000 });
    await deliveryRecoveryWriteStatement(db, imported, true).run();
    await db.batch([
      db.prepare("UPDATE commerce_delivery_recovery_control SET preparation_state = 'ready', prepared_at_ms = 0"),
      db.prepare("UPDATE commerce_delivery_recovery_control SET storage_mode = 'table'"),
      db.prepare('DELETE FROM commerce_authority_control_lease WHERE singleton = 1'),
    ]);
    for (const name of readdirSync(source).filter((name) => name.endsWith('.sql') && name >= '0031_' && name < '0033_')) {
      copyFileSync(join(source, name), join(directory, name));
    }
    await worker.applyD1Migrations('COMMERCE_DB');
    const cleanupName = '0033_delivery_recovery_metadata_cleanup.sql';
    const cleanup = readFileSync(join(source, cleanupName), 'utf8');
    const beforeCleanup = await db.prepare('SELECT * FROM commerce_documents WHERE document_path = ?').bind(key.path).first<Record<string, unknown>>();
    const guardsBeforeCleanup = (await db.prepare("SELECT name, sql FROM sqlite_schema WHERE type = 'trigger' ORDER BY name").all()).results;
    const revisionsBeforeCleanup = (await db.prepare('SELECT * FROM commerce_document_path_revisions ORDER BY document_path').all()).results;
    const authorityBeforeCleanup = await db.prepare('SELECT * FROM commerce_authority_control').first();
    writeFileSync(join(directory, cleanupName), `${cleanup}\nINSERT INTO commerce_preorder_cards (card_id) VALUES (0);`);
    await assert.rejects(worker.applyD1Migrations('COMMERCE_DB'), /CHECK constraint failed/);
    assert.deepEqual(await db.prepare('SELECT * FROM commerce_documents WHERE document_path = ?').bind(key.path).first(), beforeCleanup);
    assert.deepEqual((await db.prepare("SELECT name, sql FROM sqlite_schema WHERE type = 'trigger' ORDER BY name").all()).results, guardsBeforeCleanup);
    assert.equal(await db.prepare('SELECT name FROM d1_migrations WHERE name = ?').bind(cleanupName).first(), null);
    writeFileSync(join(directory, cleanupName), cleanup);
    await worker.applyD1Migrations('COMMERCE_DB');
    const cleaned = await db.prepare('SELECT * FROM commerce_documents WHERE document_path = ?').bind(key.path).first<Record<string, unknown>>();
    const originalMetadata = JSON.parse(String(beforeCleanup!.document_json));
    delete originalMetadata.receiptRecovery;
    assert.deepEqual(JSON.parse(String(cleaned!.document_json)), originalMetadata);
    assert.deepEqual({ ...cleaned, document_json: null }, { ...beforeCleanup, document_json: null });
    assert.deepEqual((await db.prepare('SELECT * FROM commerce_document_path_revisions ORDER BY document_path').all()).results, revisionsBeforeCleanup);
    assert.deepEqual(await db.prepare('SELECT * FROM commerce_authority_control').first(), authorityBeforeCleanup);
    await db.batch([lease(db), ...resume(db)]);
    const snapshot = await repository.getRecoverySnapshot(key);
    assert.ok(snapshot);
    assert.deepEqual(snapshot.state, imported);
    assert.deepEqual(snapshot.order.data.receiptRecovery, legacy);
    assert.equal((await repository.get(key))?.data.receiptRecovery, undefined);
    await assert.rejects(db.prepare('UPDATE commerce_documents SET version = version + 1 WHERE document_path = ?').bind(key.path).run(), /guarded write/);
    await assert.rejects(db.prepare('DELETE FROM commerce_documents WHERE document_path = ?').bind(key.path).run(), /guarded deletion/);
    const before = await db.prepare('SELECT document_json, version, update_time FROM commerce_documents WHERE document_path = ?').bind(key.path).first();
    const authorityBefore = await db.prepare('SELECT documents_revision FROM commerce_authority_control').first();
    const first = await repository.begin(2_000);
    const second = await repository.begin(2_000);
    const firstSnapshot = await first.getRecoverySnapshot(key);
    const secondSnapshot = await second.getRecoverySnapshot(key);
    assert.ok(firstSnapshot && secondSnapshot);
    first.stageRecovery(updateDeliveryRecoveryRecord(firstSnapshot.state, { leaseId: LEASE }, 2_000));
    second.stageRecovery(updateDeliveryRecoveryRecord(secondSnapshot.state, { receiptRecoveryJson: '{}' }, 2_000));
    await first.commit();
    await assert.rejects(second.commit(), CommerceWriteConflict);
    assert.deepEqual(await db.prepare('SELECT document_json, version, update_time FROM commerce_documents WHERE document_path = ?').bind(key.path).first(), before);
    assert.deepEqual(await db.prepare('SELECT documents_revision FROM commerce_authority_control').first(), authorityBefore);
    const current = await repository.getRecoverySnapshot(key);
    assert.ok(current);
    assert.equal(current.state.revision, 2);
    assert.equal(current.state.leaseId, LEASE);

    const rollbackState = updateDeliveryRecoveryRecord(current.state, { receiptRecoveryJson: '{}' }, 3_000);
    await assert.rejects(db.batch([
      db.prepare(`INSERT INTO commerce_commit_guards (guard_id, expectations_json, created_at_ms,
        delivery_recovery_expectations_json, delivery_recovery_paths_json) VALUES ('rollback', ?, 3000, ?, ?)`)
        .bind(JSON.stringify([{ path: key.path, version: current.order.version }]), JSON.stringify([{
          parentPath: key.path, generation: current.state.generation, revision: current.state.revision,
        }]), JSON.stringify([key.path])),
      db.prepare("UPDATE commerce_documents SET document_json = json_set(document_json, '$.status', 'processing'), version = version + 1 WHERE document_path = ?").bind(key.path),
      deliveryRecoveryWriteStatement(db, rollbackState, false),
      db.prepare("SELECT json('invalid json')"),
    ]), /malformed JSON/);
    assert.deepEqual(await repository.getRecoverySnapshot(key), current);
    assert.equal((await db.prepare('SELECT COUNT(*) AS count FROM commerce_commit_guards').first<{ count: number }>())!.count, 0);

    await db.prepare('ANALYZE').run();
    const pageQuery = deliveryRecoveryPageQuery({ owner: 'owner', phase: 'prepared', limit: 9 });
    const plan = (await db.prepare(`EXPLAIN QUERY PLAN ${pageQuery.sql}`).bind(...pageQuery.bindings)
      .all<{ detail: string }>()).results.map((row) => row.detail).join('\n');
    assert.match(plan, /SEARCH document USING INDEX commerce_documents_delivery_owner_status/);
    assert.doesNotMatch(plan, /USE TEMP B-TREE/);
    const summary = deliveryRecoveryStateQuery('owner', 3_000, 3_000);
    const summaryRow = await db.prepare(summary.sql).bind(...summary.bindings).first();
    assert.deepEqual(summaryRow, { remaining_processing: 0, next_check_at: 90_000.5, invalid_count: 0 });

    const temporary = commerceKeys.deliveryOrder('runtime', 'temporary');
    await repository.run(4_000, (unit) => unit.create(temporary, { status: 'prepared', receiptRecovery: null }));
    assert.equal((await repository.getRecoverySnapshot(temporary))?.state.receiptRecoveryJson, 'null');
    await repository.run(5_000, (unit) => unit.delete(temporary, { mustExist: true }));
    assert.equal(await repository.get(temporary), null);
    assert.equal(await db.prepare('SELECT parent_path FROM commerce_delivery_recovery WHERE parent_path = ?').bind(temporary.path).first(), null);
    assert.deepEqual((await db.prepare('PRAGMA foreign_key_check').all()).results, []);
    await db.batch(pause(db));
    await assert.rejects(repository.getRecoverySnapshot(key), { code: 'unavailable' });
    await assert.rejects(db.prepare('DELETE FROM commerce_documents WHERE document_path = ?').bind(key.path).run(), /guarded deletion/);
  } finally {
    await server.close();
  }
});
