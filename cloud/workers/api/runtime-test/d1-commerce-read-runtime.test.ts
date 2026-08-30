import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { createTestHarness } from 'wrangler';
import {
  CommerceRepositoryError,
  D1CommerceRepository,
  commerceKeys,
  type CommerceDocumentData,
  type CommerceDocumentKey,
} from '../src/commerceRepository.ts';

function insertDocument(
  db: D1Database,
  key: CommerceDocumentKey,
  data: CommerceDocumentData,
): D1PreparedStatement {
  return db.prepare(`INSERT INTO commerce_documents (
    document_path, document_kind, drop_id, document_id, document_json,
    version, create_time, update_time, processed_at_seconds, processed_at_nanos
  ) VALUES (?, ?, ?, ?, ?, 1, ?, ?, NULL, NULL)`).bind(
    key.path,
    key.kind,
    key.dropId,
    key.documentId,
    JSON.stringify(data),
    '2026-01-01T00:00:00.000Z',
    '2026-01-01T00:00:00.000Z',
  );
}

test('commerce repository batched reads return rows through the real D1 runtime', async () => {
  const productionConfig = JSON.parse(readFileSync('cloud/workers/api/wrangler.jsonc', 'utf8'));
  const runtimeConfig = {
    ...productionConfig,
    main: resolve('cloud/workers/api/src/index.ts'),
    routes: undefined,
    d1_databases: productionConfig.d1_databases.map((database: Record<string, unknown>) => ({
      ...database,
      migrations_dir: resolve('cloud/workers/api', String(database.migrations_dir)),
    })),
  };
  delete runtimeConfig.$schema;
  delete runtimeConfig.secrets;
  const server = createTestHarness({
    root: resolve('.'),
    workers: [{ config: runtimeConfig }],
  });
  try {
    await server.listen();
    const worker = server.getWorker<Env>('mons-shop-api');
    await worker.applyD1Migrations('COMMERCE_DB');
    const env = await worker.getEnv();
    const migrations = await env.COMMERCE_DB.prepare(
      'SELECT name FROM d1_migrations ORDER BY name',
    ).all<{ name: string }>();
    assert.deepEqual(migrations.results.map((row) => row.name), [
      '0001_current_schema.sql',
      '0002_authority_control_lease.sql',
      '0003_wipe_readiness_guard.sql',
      '0004_ready_notification_owner_indexes.sql',
      '0005_delivery_owner_query_revisions.sql',
    ]);

    const claimKey = commerceKeys.claimCode('RUNTIME');
    const deliveryKey = commerceKeys.deliveryOrder('runtime', '1');
    const validOwnerA = '11111111111111111111111111111111';
    const validOwnerB = 'So11111111111111111111111111111111111111112';
    const checkoutKey = commerceKeys.stripeCheckout('runtime', 'cs_runtime');
    await env.COMMERCE_DB.batch([
      insertDocument(env.COMMERCE_DB, claimKey, { status: 'unused' }),
      insertDocument(env.COMMERCE_DB, deliveryKey, {
        buyerOrderReceivedEmailState: 'pending',
        owner: 'runtime-owner',
        packStatusProjectionNextAttemptAtMs: 10,
        packStatusProjectionState: 'pending',
        shipperReadyToShipEmailState: 'queued',
        status: 'ready_to_ship',
      }),
      insertDocument(env.COMMERCE_DB, commerceKeys.deliveryOrder('runtime', 'owner-a'), {
        owner: validOwnerA,
      }),
      insertDocument(env.COMMERCE_DB, commerceKeys.deliveryOrder('runtime', 'owner-b'), {
        owner: validOwnerB,
      }),
      insertDocument(env.COMMERCE_DB, commerceKeys.deliveryOrder('runtime', 'owner-duplicate'), {
        owner: validOwnerA,
      }),
      insertDocument(env.COMMERCE_DB, commerceKeys.deliveryOrder('runtime', 'owner-invalid-base58'), {
        owner: '0'.repeat(32),
      }),
      insertDocument(env.COMMERCE_DB, commerceKeys.deliveryOrder('runtime', 'owner-invalid-character'), {
        owner: `${'1'.repeat(31)}-`,
      }),
      insertDocument(env.COMMERCE_DB, commerceKeys.deliveryOrder('runtime', 'owner-invalid-bytes'), {
        owner: '2'.repeat(32),
      }),
      insertDocument(env.COMMERCE_DB, checkoutKey, {
        fulfillmentProcessor: 'cloudflare_queue_v1',
        lastStripeWebhookEventId: 'evt_runtime',
        status: 'fulfillment_pending',
        updatedAt: 10,
      }),
      env.COMMERCE_DB.prepare(`UPDATE commerce_authority_control
        SET documents_revision = documents_revision + 1,
          updated_at_ms = updated_at_ms + 1
        WHERE singleton = 1`),
    ]);
    const repository = new D1CommerceRepository(env.COMMERCE_DB);
    assert.deepEqual((await repository.get(claimKey))?.data, { status: 'unused' });
    assert.equal(await repository.get(commerceKeys.claimCode('MISSING')), null);
    assert.deepEqual(
      (await repository.query({ kind: 'claim_code' })).map((record) => record.key.documentId),
      ['RUNTIME'],
    );
    assert.deepEqual(await repository.query({ kind: 'box_assignment' }), []);
    assert.deepEqual(await repository.query({ kind: 'claim_code', limit: 0 }), []);
    assert.deepEqual(await repository.queryDeliveryOrderOwners({ limit: 10 }), [
      validOwnerA,
      '2'.repeat(32),
      validOwnerB,
    ]);
    assert.deepEqual(await repository.queryDeliveryOrderOwners({
      startAfterOwner: validOwnerA,
      limit: 10,
    }), [
      '2'.repeat(32),
      validOwnerB,
    ]);
    assert.deepEqual(
      (await repository.queryPendingReadyNotifications({
        limit: 5,
        owner: 'runtime-owner',
      })).map((record) => record.key.documentId),
      ['1'],
    );
    assert.deepEqual(
      (await repository.queryDuePackStatusProjections({
        dropId: 'runtime',
        dueAtMs: 10,
        limit: 5,
      })).map((record) => record.key.documentId),
      ['1'],
    );
    assert.deepEqual(
      (await repository.queryStaleStripeFulfillments(10)).map((record) => record.key.documentId),
      ['cs_runtime'],
    );

    const ownerUnit = await repository.begin(Date.parse('2026-01-01T00:00:01.000Z'));
    assert.deepEqual(
      (await ownerUnit.queryDeliveryOrdersByOwner({ owner: 'runtime-owner', limit: 5 }))
        .map((record) => record.key.documentId),
      ['1'],
    );
    await ownerUnit.update(deliveryKey, { owner: 'runtime-wallet' });
    await ownerUnit.commit();
    assert.equal((await repository.get(deliveryKey))?.data.owner, 'runtime-wallet');
    const ownerRevisions = await env.COMMERCE_DB.prepare(`SELECT owner, revision
      FROM commerce_delivery_owner_revisions WHERE owner IN (?, ?) ORDER BY owner`)
      .bind('runtime-owner', 'runtime-wallet')
      .all<{ owner: string; revision: number }>();
    assert.deepEqual(ownerRevisions.results, [
      { owner: 'runtime-owner', revision: 2 },
      { owner: 'runtime-wallet', revision: 2 },
    ]);
    assert.equal(await env.COMMERCE_DB.prepare(`SELECT documents_revision
      FROM commerce_authority_control WHERE singleton = 1`).first<number>('documents_revision'), 2);

    for (let offset = 0; offset < 128; offset += 32) {
      await env.COMMERCE_DB.batch([
        ...Array.from({ length: 32 }, (_, index) => insertDocument(
          env.COMMERCE_DB,
          commerceKeys.deliveryOrder('runtime', `paused-${offset + index}`),
          {
            buyerOrderReceivedEmailState: 'pending',
            owner: 'paused-owner',
            shipperReadyToShipEmailState: 'queued',
            status: 'ready_to_ship',
          },
        )),
        env.COMMERCE_DB.prepare(`UPDATE commerce_authority_control
          SET documents_revision = documents_revision + 1,
            updated_at_ms = updated_at_ms + 1
          WHERE singleton = 1`),
      ]);
    }
    let observedBatchResults: D1Result<Record<string, unknown>>[] | undefined;
    const latestObservedBatchResults = (): D1Result<Record<string, unknown>>[] | undefined =>
      observedBatchResults;
    const observedDb = {
      prepare: (sql: string) => env.COMMERCE_DB.prepare(sql),
      async batch<T>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
        const results = await env.COMMERCE_DB.batch<T>(statements);
        observedBatchResults = results as D1Result<Record<string, unknown>>[];
        return results;
      },
    } as D1Database;
    const observedRepository = new D1CommerceRepository(observedDb);
    assert.deepEqual(await observedRepository.queryDeliveryRecoveryOrders('paused-owner'), []);
    const emptyRecoveryRowsRead = Number(latestObservedBatchResults()?.[1]?.meta.rows_read);
    assert.equal(Number.isSafeInteger(emptyRecoveryRowsRead), true);
    assert.equal(emptyRecoveryRowsRead >= 0, true);
    assert.equal(emptyRecoveryRowsRead <= 4, true);

    await env.COMMERCE_DB.batch([
      insertDocument(env.COMMERCE_DB, commerceKeys.deliveryOrder('runtime', 'recovery-processing'), {
        owner: 'paused-owner',
        status: 'processing',
      }),
      insertDocument(env.COMMERCE_DB, commerceKeys.deliveryOrder('runtime', 'recovery-prepared'), {
        owner: 'paused-owner',
        status: 'prepared',
      }),
      env.COMMERCE_DB.prepare(`UPDATE commerce_authority_control
        SET documents_revision = documents_revision + 1,
          updated_at_ms = updated_at_ms + 1
        WHERE singleton = 1`),
    ]);
    observedBatchResults = undefined;
    assert.deepEqual(
      (await observedRepository.queryDeliveryRecoveryOrders('paused-owner'))
        .map((record) => record.key.documentId)
        .sort(),
      ['recovery-prepared', 'recovery-processing'],
    );
    const matchingRecoveryRowsRead = Number(latestObservedBatchResults()?.[1]?.meta.rows_read);
    assert.equal(Number.isSafeInteger(matchingRecoveryRowsRead), true);
    assert.equal(matchingRecoveryRowsRead >= 2, true);
    assert.equal(matchingRecoveryRowsRead <= 8, true);

    assert.deepEqual(await observedRepository.queryPendingReadyNotifications({
      limit: 5,
      owner: 'missing-owner',
    }), []);
    const missingOwnerRowsRead = Number(latestObservedBatchResults()?.[1]?.meta.rows_read);
    assert.equal(Number.isSafeInteger(missingOwnerRowsRead), true);
    assert.equal(missingOwnerRowsRead <= 4, true);

    await env.COMMERCE_DB.batch([
      env.COMMERCE_DB.prepare(`INSERT INTO commerce_authority_control_lease (
        singleton, lease_token, acquired_at_ms, expires_at_ms
      ) VALUES (
        1,
        '123e4567-e89b-42d3-a456-426614174000',
        CAST(strftime('%s', 'now') AS INTEGER) * 1000,
        CAST(strftime('%s', 'now') AS INTEGER) * 1000 + 60000
      )`),
      env.COMMERCE_DB.prepare(`UPDATE commerce_authority_control SET
        authority_state = 'paused',
        revision = revision + 1,
        paused_at_ms = NULL,
        updated_at_ms = CAST(strftime('%s', 'now') AS INTEGER) * 1000
      WHERE singleton = 1`),
      env.COMMERCE_DB.prepare('DELETE FROM commerce_authority_control_lease WHERE singleton = 1'),
    ]);
    observedBatchResults = undefined;
    await assert.rejects(
      observedRepository.queryPendingReadyNotifications({
        limit: 5,
        owner: 'paused-owner',
      }),
      (error: unknown) => error instanceof CommerceRepositoryError && error.code === 'unavailable',
    );
    const pausedRowsRead = Number(latestObservedBatchResults()?.[1]?.meta.rows_read);
    assert.equal(Number.isSafeInteger(pausedRowsRead), true);
    assert.equal(pausedRowsRead <= 4, true);

    observedBatchResults = undefined;
    await assert.rejects(
      observedRepository.queryDeliveryRecoveryOrders('paused-owner'),
      (error: unknown) => error instanceof CommerceRepositoryError && error.code === 'unavailable',
    );
    const pausedRecoveryRowsRead = Number(latestObservedBatchResults()?.[1]?.meta.rows_read);
    assert.equal(Number.isSafeInteger(pausedRecoveryRowsRead), true);
    assert.equal(pausedRecoveryRowsRead >= 0, true);
    assert.equal(pausedRecoveryRowsRead <= 4, true);
  } finally {
    await server.close();
  }
});
