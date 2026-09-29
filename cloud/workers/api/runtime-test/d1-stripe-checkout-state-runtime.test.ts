import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { createTestHarness } from 'wrangler';
import { CommerceWriteConflict, D1CommerceRepository, commerceFieldValue, commerceKeys } from '../src/commerceRepository.ts';
import { stripeCheckoutStateFromDocument } from '../../../../shared/stripeCheckoutState.ts';
import { stripeCheckoutStateWriteStatement } from '../src/stripeCheckoutStateStore.ts';

function lease(db: D1Database): D1PreparedStatement {
  return db.prepare(`INSERT INTO commerce_authority_control_lease (singleton, lease_token, acquired_at_ms, expires_at_ms)
    VALUES (1, '00000000-0000-4000-8000-000000000026', CAST(strftime('%s', 'now') AS INTEGER) * 1000,
      CAST(strftime('%s', 'now') AS INTEGER) * 1000 + 60000)`);
}

function drained(db: D1Database): D1PreparedStatement {
  return db.prepare(`UPDATE commerce_authority_control SET paused_at_ms = CAST(strftime('%s', 'now') AS INTEGER) * 1000,
    updated_at_ms = CAST(strftime('%s', 'now') AS INTEGER) * 1000 WHERE singleton = 1`);
}

function resume(db: D1Database): D1PreparedStatement[] {
  return [db.prepare(`UPDATE commerce_authority_control SET authority_state = 'd1', revision = revision + 1,
    paused_at_ms = NULL, updated_at_ms = CAST(strftime('%s', 'now') AS INTEGER) * 1000 WHERE singleton = 1`),
  db.prepare('DELETE FROM commerce_authority_control_lease WHERE singleton = 1')];
}

test('real D1 expands checkout storage without disrupting legacy writes, then activates atomic typed state', async (context) => {
  const directory = mkdtempSync(join(tmpdir(), 'mons-checkout-state-migrations-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const source = resolve('cloud/workers/api/commerce-migrations');
  for (const name of readdirSync(source).filter((name) => name.endsWith('.sql') && name < '0026_')) {
    copyFileSync(join(source, name), join(directory, name));
  }
  const production = JSON.parse(readFileSync('cloud/workers/api/wrangler.jsonc', 'utf8'));
  const runtime = { ...production, main: resolve('cloud/workers/api/src/index.ts'), routes: undefined,
    d1_databases: production.d1_databases.map((database: Record<string, unknown>) => ({ ...database,
      migrations_dir: database.binding === 'COMMERCE_DB' ? directory : resolve('cloud/workers/api', String(database.migrations_dir)) })) };
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
      ...resume(db),
    ]);
    const key = commerceKeys.stripeCheckout('drop', 'cs_legacy');
    const legacy = { status: 'processing', processingAttemptId: 'legacy-attempt', nextFulfillmentRetryAt: 300,
      updatedAt: 100, retained: { provider: true } };
    await db.batch([
      db.prepare(`INSERT INTO commerce_documents (document_path, document_kind, drop_id, document_id, document_json,
        version, create_time, update_time) VALUES (?, 'stripe_checkout', 'drop', 'cs_legacy', ?, 1,
        '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`).bind(key.path, JSON.stringify(legacy)),
      db.prepare('UPDATE commerce_authority_control SET documents_revision = documents_revision + 1 WHERE singleton = 1'),
    ]);
    copyFileSync(join(source, '0026_stripe_checkout_state.sql'), join(directory, '0026_stripe_checkout_state.sql'));
    await worker.applyD1Migrations('COMMERCE_DB');
    await db.batch([
      db.prepare("UPDATE commerce_documents SET document_json = json_set(document_json, '$.updatedAt', 200), version = version + 1 WHERE document_path = ?").bind(key.path),
      db.prepare('UPDATE commerce_authority_control SET documents_revision = documents_revision + 1 WHERE singleton = 1'),
    ]);
    const repository = new D1CommerceRepository(db);
    await assert.rejects(repository.get(key), { code: 'unavailable' });
    const sourceJson = (await db.prepare('SELECT document_json FROM commerce_documents WHERE document_path = ?').bind(key.path).first<{ document_json: string }>())!.document_json;
    await db.batch([lease(db),
      db.prepare(`UPDATE commerce_authority_control SET authority_state = 'paused', revision = revision + 1,
        paused_at_ms = NULL, updated_at_ms = CAST(strftime('%s', 'now') AS INTEGER) * 1000 WHERE singleton = 1`),
      drained(db),
      db.prepare(`UPDATE commerce_stripe_checkout_state_control SET preparation_state = 'preparing',
        source_documents_revision = (SELECT documents_revision FROM commerce_authority_control WHERE singleton = 1) WHERE singleton = 1`),
    ]);
    const imported = stripeCheckoutStateFromDocument(key.path, JSON.parse(sourceJson), 2);
    await stripeCheckoutStateWriteStatement(db, imported).run();
    await assert.rejects(db.batch(resume(db)), /cutover is incomplete/);
    await db.prepare("UPDATE commerce_stripe_checkout_state_control SET preparation_state = 'ready', prepared_at_ms = 0 WHERE singleton = 1").run();
    await db.prepare("UPDATE commerce_stripe_checkout_state_control SET storage_mode = 'table' WHERE singleton = 1").run();
    await db.batch(resume(db));
    const first = await repository.begin(Date.now());
    const stale = await repository.begin(Date.now());
    await first.get(key);
    await stale.get(key);
    await first.update(key, { status: 'processing', processingAttemptId: 'winner', updatedAt: commerceFieldValue.serverTimestamp() });
    await stale.update(key, { processingAttemptId: 'loser' });
    await first.commit();
    await assert.rejects(stale.commit(), CommerceWriteConflict);
    await repository.run(Date.now(), async (unit) => {
      await unit.get(key);
      await unit.update(key, { status: 'fulfilled', processingAttemptId: commerceFieldValue.delete(),
        nextFulfillmentRetryAt: commerceFieldValue.delete(), updatedAt: commerceFieldValue.serverTimestamp() });
      await unit.enqueueNotificationOutbox({ parentPath: key.path, family: 'stripe_terminal', dropId: 'drop',
        generation: crypto.randomUUID(), outcome: 'fulfilled', retryUntilMs: Date.now() + 60000,
        entries: [{ kind: 'buyer_order_received', jobId: crypto.randomUUID(), idempotencyKey: 'drop:1:order_received', state: 'pending' }] });
    });
    const record = (await repository.get(key))!;
    assert.equal(record.version, 4);
    assert.equal(record.data.status, 'fulfilled');
    assert.equal(Object.hasOwn(record.data, 'processingAttemptId'), false);
    assert.equal(Object.hasOwn(record.data, 'nextFulfillmentRetryAt'), false);
    assert.equal((await db.prepare('SELECT document_json FROM commerce_documents WHERE document_path = ?').bind(key.path).first<{ document_json: string }>())!.document_json, sourceJson);
    assert.equal((await db.prepare('SELECT COUNT(*) AS count FROM commerce_notification_outbox_stripe_due').first<{ count: number }>())!.count, 1);
    const guardId = crypto.randomUUID();
    await assert.rejects(db.batch([
      db.prepare(`INSERT INTO commerce_commit_guards (guard_id, expectations_json, created_at_ms, stripe_checkout_paths_json)
        VALUES (?, '[]', 0, ?)`).bind(guardId, JSON.stringify([key.path])),
      db.prepare('UPDATE commerce_documents SET version = version + 1 WHERE document_path = ?').bind(key.path),
      db.prepare('DELETE FROM commerce_commit_guards WHERE guard_id = ?').bind(guardId),
    ]), /stripe checkout state commit is incomplete/);
    assert.equal((await repository.get(key))!.version, 4);
    await assert.rejects(db.prepare("UPDATE commerce_documents SET document_json = json_set(document_json, '$.status', 'processing'), version = version + 1 WHERE document_path = ?").bind(key.path).run(), /stripe checkout state is unavailable/);
    assert.equal((await db.prepare('SELECT COUNT(*) AS count FROM commerce_commit_guards').first<{ count: number }>())!.count, 0);
    const projectionKey = commerceKeys.stripeCheckout('drop', 'cs_projection');
    await repository.run(Date.now(), (unit) => unit.create(projectionKey, {
      status: 'created', processedAt: commerceFieldValue.timestamp(1, 1),
    }));
    await repository.run(Date.now(), (unit) => unit.update(projectionKey, {
      processedAt: commerceFieldValue.timestamp(1, 2),
    }));
    assert.deepEqual((await repository.get(projectionKey))!.processedAt, { seconds: 1, nanos: 2 });
    await repository.run(Date.now(), (unit) => unit.delete(projectionKey));
    await db.batch([lease(db),
      db.prepare(`UPDATE commerce_authority_control SET authority_state = 'paused', revision = revision + 1,
        paused_at_ms = NULL, updated_at_ms = CAST(strftime('%s', 'now') AS INTEGER) * 1000 WHERE singleton = 1`),
      drained(db), db.prepare('DELETE FROM commerce_documents WHERE document_path = ?').bind(key.path),
    ]);
    assert.equal((await db.prepare('SELECT COUNT(*) AS count FROM commerce_stripe_checkout_state').first<{ count: number }>())!.count, 0);
    assert.equal((await db.prepare('SELECT COUNT(*) AS count FROM commerce_notification_outbox').first<{ count: number }>())!.count, 0);
    assert.deepEqual((await db.prepare('PRAGMA foreign_key_check').all()).results, []);
  } finally {
    await server.close();
  }
});
