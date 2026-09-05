import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { createTestHarness } from 'wrangler';
import {
  CommerceRepositoryError,
  CommerceWriteConflict,
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

test('document-path migration backfills a populated Commerce D1 in the real runtime', async (context) => {
  const migrationDirectory = mkdtempSync(join(tmpdir(), 'mons-commerce-d1-migrations-'));
  context.after(() => rmSync(migrationDirectory, { force: true, recursive: true }));
  const migrationNames = [
    '0001_current_schema.sql',
    '0002_authority_control_lease.sql',
    '0003_wipe_readiness_guard.sql',
    '0004_ready_notification_owner_indexes.sql',
    '0005_delivery_owner_query_revisions.sql',
  ];
  for (const migrationName of migrationNames) {
    copyFileSync(
      resolve('cloud/workers/api/commerce-migrations', migrationName),
      join(migrationDirectory, migrationName),
    );
  }

  const productionConfig = JSON.parse(readFileSync('cloud/workers/api/wrangler.jsonc', 'utf8'));
  const runtimeConfig = {
    ...productionConfig,
    main: resolve('cloud/workers/api/src/index.ts'),
    routes: undefined,
    d1_databases: productionConfig.d1_databases.map((database: Record<string, unknown>) => ({
      ...database,
      migrations_dir: database.binding === 'COMMERCE_DB'
        ? migrationDirectory
        : resolve('cloud/workers/api', String(database.migrations_dir)),
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
    const key = commerceKeys.claimCode('BACKFILL');
    await env.COMMERCE_DB.batch([
      insertDocument(env.COMMERCE_DB, key, { status: 'unused' }),
      env.COMMERCE_DB.prepare(`UPDATE commerce_authority_control
        SET documents_revision = documents_revision + 1, updated_at_ms = updated_at_ms + 1
        WHERE singleton = 1`),
    ]);
    await env.COMMERCE_DB.batch([
      env.COMMERCE_DB.prepare(`INSERT INTO commerce_authority_control_lease (
        singleton, lease_token, acquired_at_ms, expires_at_ms
      ) VALUES (
        1, '00000000-0000-4000-8000-000000000406',
        CAST(strftime('%s', 'now') AS INTEGER) * 1000,
        CAST(strftime('%s', 'now') AS INTEGER) * 1000 + 60000
      )`),
      env.COMMERCE_DB.prepare(`UPDATE commerce_authority_control
        SET authority_state = 'paused', revision = revision + 1, paused_at_ms = NULL,
          updated_at_ms = CAST(strftime('%s', 'now') AS INTEGER) * 1000
        WHERE singleton = 1 AND authority_state = 'd1'`),
      env.COMMERCE_DB.prepare(`UPDATE commerce_authority_control
        SET paused_at_ms = CAST(strftime('%s', 'now') AS INTEGER) * 1000,
          updated_at_ms = CAST(strftime('%s', 'now') AS INTEGER) * 1000
        WHERE singleton = 1 AND authority_state = 'paused' AND paused_at_ms IS NULL`),
      env.COMMERCE_DB.prepare(`DELETE FROM commerce_authority_control_lease
        WHERE singleton = 1 AND lease_token = '00000000-0000-4000-8000-000000000406'`),
    ]);

    copyFileSync(
      resolve('cloud/workers/api/commerce-migrations/0006_document_path_revisions.sql'),
      join(migrationDirectory, '0006_document_path_revisions.sql'),
    );
    await worker.applyD1Migrations('COMMERCE_DB');

    const pathRevisions = await env.COMMERCE_DB.prepare(`SELECT document_path, revision
      FROM commerce_document_path_revisions ORDER BY document_path`)
      .all<{ document_path: string; revision: number }>();
    assert.deepEqual(pathRevisions.results, [{ document_path: key.path, revision: 1 }]);
    const authority = await env.COMMERCE_DB.prepare(`SELECT
      authority_state, revision, documents_revision, paused_at_ms
      FROM commerce_authority_control WHERE singleton = 1`).first<Record<string, unknown>>();
    assert.equal(authority?.authority_state, 'paused');
    assert.equal(authority?.revision, 2);
    assert.equal(authority?.documents_revision, 1);
    assert.equal(Number.isSafeInteger(authority?.paused_at_ms), true);
    assert.deepEqual(
      (await env.COMMERCE_DB.prepare('SELECT name FROM d1_migrations ORDER BY id').all<{ name: string }>())
        .results.map((row) => row.name),
      [...migrationNames, '0006_document_path_revisions.sql'],
    );
  } finally {
    await server.close();
  }
});

test('commerce repository reads and transaction guards run through the real D1 runtime', async () => {
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
      '0006_document_path_revisions.sql',
      '0007_stripe_terminal_notifications.sql',
      '0008_admin_irl_redeem_workflow_operation.sql',
      '0009_ready_notification_due_index.sql',
      '0010_dude_inventory.sql',
    ]);
    assert.deepEqual(
      await env.COMMERCE_DB.prepare(`SELECT authority_state, revision, documents_revision, paused_at_ms
        FROM commerce_authority_control WHERE singleton = 1`).first(),
      {
        authority_state: 'paused',
        revision: 2,
        documents_revision: 0,
        paused_at_ms: null,
      },
    );
    await env.COMMERCE_DB.prepare(`INSERT INTO commerce_authority_control_lease (
      singleton, lease_token, acquired_at_ms, expires_at_ms
    ) VALUES (
      1, '00000000-0000-4000-8000-000000000206',
      CAST(strftime('%s', 'now') AS INTEGER) * 1000,
      CAST(strftime('%s', 'now') AS INTEGER) * 1000 + 60000
    )`).run();
    await assert.rejects(env.COMMERCE_DB.prepare(`UPDATE commerce_authority_control
      SET authority_state = 'd1', revision = revision + 1, paused_at_ms = NULL,
        updated_at_ms = CAST(strftime('%s', 'now') AS INTEGER) * 1000
      WHERE singleton = 1 AND authority_state = 'paused'`).run());
    await env.COMMERCE_DB.batch([
      env.COMMERCE_DB.prepare(`UPDATE commerce_authority_control
        SET paused_at_ms = CAST(strftime('%s', 'now') AS INTEGER) * 1000,
          updated_at_ms = CAST(strftime('%s', 'now') AS INTEGER) * 1000
        WHERE singleton = 1 AND authority_state = 'paused' AND paused_at_ms IS NULL`),
      env.COMMERCE_DB.prepare(`UPDATE commerce_authority_control
        SET authority_state = 'd1', revision = revision + 1, paused_at_ms = NULL,
          updated_at_ms = CAST(strftime('%s', 'now') AS INTEGER) * 1000
        WHERE singleton = 1 AND authority_state = 'paused'`),
      env.COMMERCE_DB.prepare(`DELETE FROM commerce_authority_control_lease
        WHERE singleton = 1 AND lease_token = '00000000-0000-4000-8000-000000000206'`),
    ]);

    const claimKey = commerceKeys.claimCode('RUNTIME');
    const deliveryKey = commerceKeys.deliveryOrder('runtime', '1');
    const validOwnerA = '11111111111111111111111111111111';
    const validOwnerB = 'So11111111111111111111111111111111111111112';
    const checkoutKey = commerceKeys.stripeCheckout('runtime', 'cs_runtime');
    const workflowKey = commerceKeys.adminIrlRedeemRequest('runtime', 'workflow');
    const workflowOperationId = `airf-v1-${'a'.repeat(64)}`;
    const duplicateWorkflowOperationId = `airf-v1-${'b'.repeat(64)}`;
    const missingWorkflowOperationId = `airf-v1-${'c'.repeat(64)}`;
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
      ...[10, 11].map((expiry) => insertDocument(
        env.COMMERCE_DB,
        commerceKeys.deliveryOrder('runtime', `notification-${expiry}`),
        {
          buyerOrderReceivedEmailState: 'pending',
          shipperReadyToShipEmailState: 'pending',
          status: 'ready_to_ship',
          readyToShipNotificationPublishClaimId: 'claim',
          readyToShipNotificationPublishClaimExpiresAtMs: expiry,
        },
      )),
      insertDocument(env.COMMERCE_DB, checkoutKey, {
        fulfillmentProcessor: 'cloudflare_queue_v1',
        lastStripeWebhookEventId: 'evt_runtime',
        status: 'fulfillment_pending',
        updatedAt: 10,
      }),
      insertDocument(env.COMMERCE_DB, commerceKeys.stripeCheckout('runtime', 'cs_terminal'), {
        status: 'fulfilled',
        stripeTerminalNotificationState: 'pending',
        stripeTerminalNotificationNextAttemptAtMs: 10,
      }),
      insertDocument(env.COMMERCE_DB, workflowKey, {
        status: 'processing',
        workflowFinalizeV1: { version: 1, operationId: workflowOperationId },
      }),
      ...['workflow-duplicate-one', 'workflow-duplicate-two'].map((requestId) => insertDocument(
        env.COMMERCE_DB,
        commerceKeys.adminIrlRedeemRequest('runtime', requestId),
        {
          status: 'processing',
          workflowFinalizeV1: { version: 1, operationId: duplicateWorkflowOperationId },
        },
      )),
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
      (await repository.queryDueReadyNotifications({ dueAtMs: 0, limit: 8 }))
        .map((record) => record.key.documentId),
      ['1'],
    );
    assert.deepEqual(
      (await repository.queryDueReadyNotifications({ dueAtMs: 10, limit: 8 }))
        .map((record) => record.key.documentId),
      ['1', 'notification-10'],
    );
    assert.deepEqual(
      (await repository.queryStaleStripeFulfillments(10)).map((record) => record.key.documentId),
      ['cs_runtime'],
    );
    assert.deepEqual(
      (await repository.queryDueStripeTerminalNotifications(10)).map((record) => record.key.documentId),
      ['cs_terminal'],
    );
    assert.deepEqual(await repository.queryDueStripeTerminalNotifications(9), []);

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

    const firstUnrelatedUnit = await repository.begin(Date.parse('2026-01-01T00:00:02.000Z'));
    const secondUnrelatedUnit = await repository.begin(Date.parse('2026-01-01T00:00:03.000Z'));
    await firstUnrelatedUnit.get(claimKey);
    await secondUnrelatedUnit.get(checkoutKey);
    await firstUnrelatedUnit.update(claimKey, { runtimeWriter: 'first' });
    await secondUnrelatedUnit.update(checkoutKey, { runtimeWriter: 'second' });
    await firstUnrelatedUnit.commit();
    await secondUnrelatedUnit.commit();
    assert.equal((await repository.get(claimKey))?.data.runtimeWriter, 'first');
    assert.equal((await repository.get(checkoutKey))?.data.runtimeWriter, 'second');

    const samePathKey = commerceKeys.claimCode('RUNTIME-CONFLICT');
    await repository.run(Date.parse('2026-01-01T00:00:04.000Z'), async (unit) => {
      await unit.create(samePathKey, { status: 'unused' });
    });
    const firstSamePathUnit = await repository.begin(Date.parse('2026-01-01T00:00:05.000Z'));
    const secondSamePathUnit = await repository.begin(Date.parse('2026-01-01T00:00:06.000Z'));
    await firstSamePathUnit.get(samePathKey);
    await secondSamePathUnit.get(samePathKey);
    await firstSamePathUnit.update(samePathKey, { status: 'used-by-first' });
    await secondSamePathUnit.update(samePathKey, { status: 'used-by-second' });
    await firstSamePathUnit.commit();
    await assert.rejects(
      secondSamePathUnit.commit(),
      (error: unknown) => error instanceof CommerceWriteConflict && error.code === 'aborted',
    );
    assert.equal((await repository.get(samePathKey))?.data.status, 'used-by-first');

    const unrelatedReadOnlyUnit = await repository.begin(Date.parse('2026-01-01T00:00:07.000Z'));
    await unrelatedReadOnlyUnit.get(claimKey);
    await repository.run(Date.parse('2026-01-01T00:00:08.000Z'), async (unit) => {
      await unit.update(checkoutKey, { runtimeReadOnlyProbe: 'unrelated' });
    });
    await unrelatedReadOnlyUnit.commit();

    const staleReadOnlyUnit = await repository.begin(Date.parse('2026-01-01T00:00:09.000Z'));
    await staleReadOnlyUnit.get(claimKey);
    await repository.run(Date.parse('2026-01-01T00:00:10.000Z'), async (unit) => {
      await unit.update(claimKey, { runtimeReadOnlyProbe: 'same-path' });
    });
    await assert.rejects(
      staleReadOnlyUnit.commit(),
      (error: unknown) => error instanceof CommerceWriteConflict && error.code === 'aborted',
    );

    const abaKey = commerceKeys.claimCode('RUNTIME-ABSENT-ABA');
    const staleAbsentUnit = await repository.begin(Date.parse('2026-01-01T00:00:11.000Z'));
    assert.equal(await staleAbsentUnit.get(abaKey), null);
    await repository.run(Date.parse('2026-01-01T00:00:12.000Z'), async (unit) => {
      await unit.create(abaKey, { value: 'temporary' });
    });
    await repository.run(Date.parse('2026-01-01T00:00:13.000Z'), async (unit) => {
      await unit.delete(abaKey, { mustExist: true });
    });
    await staleAbsentUnit.create(abaKey, { value: 'stale' });
    await assert.rejects(
      staleAbsentUnit.commit(),
      (error: unknown) => error instanceof CommerceWriteConflict && error.code === 'aborted',
    );
    assert.equal(await repository.get(abaKey), null);
    assert.equal(
      await env.COMMERCE_DB.prepare(`SELECT revision
        FROM commerce_document_path_revisions WHERE document_path = ?`)
        .bind(abaKey.path)
        .first<number>('revision'),
      await env.COMMERCE_DB.prepare(`SELECT documents_revision
        FROM commerce_authority_control WHERE singleton = 1`)
        .first<number>('documents_revision'),
    );

    const bulkAbsentKey = commerceKeys.claimCode('RUNTIME-BULK-ABSENT-ABA');
    const bulkAbsentUnit = await repository.begin(Date.parse('2026-01-01T00:00:14.000Z'));
    assert.deepEqual(await bulkAbsentUnit.getMany([bulkAbsentKey, bulkAbsentKey]), [null, null]);
    await repository.run(Date.parse('2026-01-01T00:00:15.000Z'), async (unit) => {
      await unit.create(bulkAbsentKey, { value: 'temporary' });
    });
    await repository.run(Date.parse('2026-01-01T00:00:16.000Z'), async (unit) => {
      await unit.delete(bulkAbsentKey, { mustExist: true });
    });
    await bulkAbsentUnit.create(bulkAbsentKey, { value: 'stale' });
    await assert.rejects(
      bulkAbsentUnit.commit(),
      (error: unknown) => error instanceof CommerceWriteConflict && error.code === 'aborted',
    );
    assert.equal(await repository.get(bulkAbsentKey), null);

    const bulkExistingKey = commerceKeys.claimCode('RUNTIME-BULK-EXISTING-ABA');
    await repository.run(Date.parse('2026-01-01T00:00:17.000Z'), async (unit) => {
      await unit.create(bulkExistingKey, { value: 'original' });
    });
    const bulkExistingUnit = await repository.begin(Date.parse('2026-01-01T00:00:18.000Z'));
    assert.deepEqual(
      (await bulkExistingUnit.getMany([bulkExistingKey])).map((record) => record?.data),
      [{ value: 'original' }],
    );
    await repository.run(Date.parse('2026-01-01T00:00:19.000Z'), async (unit) => {
      await unit.delete(bulkExistingKey, { mustExist: true });
    });
    await repository.run(Date.parse('2026-01-01T00:00:20.000Z'), async (unit) => {
      await unit.create(bulkExistingKey, { value: 'replacement' });
    });
    await assert.rejects(
      bulkExistingUnit.commit(),
      (error: unknown) => error instanceof CommerceWriteConflict && error.code === 'aborted',
    );
    assert.deepEqual((await repository.get(bulkExistingKey))?.data, { value: 'replacement' });

    const bulkUnrelatedUnit = await repository.begin(Date.parse('2026-01-01T00:00:21.000Z'));
    await bulkUnrelatedUnit.getMany([bulkExistingKey, bulkAbsentKey]);
    await repository.run(Date.parse('2026-01-01T00:00:22.000Z'), async (unit) => {
      await unit.update(checkoutKey, { bulkReadProbe: 'unrelated' });
    });
    await bulkUnrelatedUnit.update(bulkExistingKey, { value: 'bulk-update' });
    await bulkUnrelatedUnit.commit();
    assert.deepEqual((await repository.get(bulkExistingKey))?.data, { value: 'bulk-update' });

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
            readyToShipNotificationPublishClaimId: 'future-claim',
            readyToShipNotificationPublishClaimExpiresAtMs: 1_000,
          },
        )),
        env.COMMERCE_DB.prepare(`UPDATE commerce_authority_control
          SET documents_revision = documents_revision + 1,
            updated_at_ms = updated_at_ms + 1
          WHERE singleton = 1`),
      ]);
    }
    let observedBatchResults: D1Result<Record<string, unknown>>[] | undefined;
    const observedBatchSizes: number[] = [];
    const observedPreparedSql: string[] = [];
    const latestObservedBatchResults = (): D1Result<Record<string, unknown>>[] | undefined =>
      observedBatchResults;
    const observedDb = {
      prepare: (sql: string) => {
        observedPreparedSql.push(sql);
        return env.COMMERCE_DB.prepare(sql);
      },
      async batch<T>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
        observedBatchSizes.push(statements.length);
        const results = await env.COMMERCE_DB.batch<T>(statements);
        observedBatchResults = results as D1Result<Record<string, unknown>>[];
        return results;
      },
    } as D1Database;
    const observedRepository = new D1CommerceRepository(observedDb);
    const bulkUnit = await observedRepository.begin(Date.parse('2026-01-01T00:00:23.000Z'));
    const cachedKey = commerceKeys.deliveryOrder('runtime', 'paused-127');
    const cachedMissingKey = commerceKeys.deliveryOrder('runtime', 'bulk-cached-missing');
    await bulkUnit.getMany([cachedKey, cachedMissingKey]);
    observedBatchSizes.length = 0;
    observedPreparedSql.length = 0;
    const bulkMissingKey = commerceKeys.deliveryOrder('runtime', 'bulk-missing');
    const bulkKeys = Array.from({ length: 101 }, (_, index) => index === 37
      ? bulkMissingKey
      : commerceKeys.deliveryOrder('runtime', `paused-${index}`));
    const requestedKeys = [
      cachedKey,
      ...bulkKeys.toReversed(),
      bulkMissingKey,
      bulkKeys[20],
      cachedMissingKey,
      cachedKey,
    ];
    const bulkRecords = await bulkUnit.getMany(requestedKeys);
    const missingPaths = new Set([cachedMissingKey.path, bulkMissingKey.path]);
    assert.deepEqual(
      bulkRecords.map((record) => record?.key.path ?? null),
      requestedKeys.map((key) => missingPaths.has(key.path) ? null : key.path),
    );
    assert.deepEqual(observedBatchSizes, [2, 2, 2]);
    assert.equal(observedPreparedSql.length, 6);
    for (const sql of observedPreparedSql) {
      assert.match(sql, /\bSELECT\b/i);
      assert.match(sql, /\bdocument_path\s+IN\s*\(/i);
    }
    assert.equal(observedPreparedSql.filter((sql) => /FROM commerce_document_path_revisions\b/i.test(sql)).length, 3);
    assert.equal(observedPreparedSql.filter((sql) => /FROM commerce_documents\b/i.test(sql)).length, 3);
    assert.deepEqual(observedPreparedSql.map((sql) => sql.match(/\?/g)?.length ?? 0), [50, 50, 50, 50, 1, 1]);
    observedBatchSizes.length = 0;
    observedPreparedSql.length = 0;
    assert.deepEqual(await bulkUnit.getMany(requestedKeys), bulkRecords);
    assert.deepEqual(await bulkUnit.getMany([]), []);
    assert.deepEqual(observedBatchSizes, []);
    assert.equal(observedPreparedSql.length, 0);
    await bulkUnit.commit();

    observedPreparedSql.length = 0;
    assert.equal(
      (await observedRepository.getAdminIrlRedeemRequestForWorkflowStatus(workflowOperationId))?.key.path,
      workflowKey.path,
    );
    const workflowLookupSql = observedPreparedSql.find((sql) => sql.includes('$.workflowFinalizeV1.operationId'));
    assert.ok(workflowLookupSql);
    const workflowPlan = await env.COMMERCE_DB.prepare(`EXPLAIN QUERY PLAN ${workflowLookupSql}`)
      .bind(workflowOperationId)
      .all<{ detail: string }>();
    const workflowPlanDetails = workflowPlan.results.map((row) => row.detail).join('\n');
    assert.match(
      workflowPlanDetails,
      /SEARCH commerce_documents USING INDEX commerce_admin_irl_redeem_workflow_operation\b/,
    );
    assert.doesNotMatch(workflowPlanDetails, /SCAN commerce_documents|USE TEMP B-TREE/i);
    assert.equal(await observedRepository.getAdminIrlRedeemRequestForWorkflowStatus(missingWorkflowOperationId), null);
    await assert.rejects(
      observedRepository.getAdminIrlRedeemRequestForWorkflowStatus(duplicateWorkflowOperationId),
      (error: unknown) => error instanceof CommerceRepositoryError && error.code === 'internal',
    );

    observedPreparedSql.length = 0;
    assert.deepEqual(
      (await observedRepository.queryDueReadyNotifications({ dueAtMs: 10, limit: 8 }))
        .map((record) => record.key.documentId),
      ['1', 'notification-10'],
    );
    const dueReadyRowsRead = Number(latestObservedBatchResults()?.[1]?.meta.rows_read);
    assert.equal(Number.isSafeInteger(dueReadyRowsRead), true);
    assert.equal(dueReadyRowsRead <= 10, true);
    const readyDueSql = observedPreparedSql.find((sql) => sql.includes('INDEXED BY commerce_ready_notifications_due'));
    assert.ok(readyDueSql);
    const readyDuePlan = await env.COMMERCE_DB.prepare(`EXPLAIN QUERY PLAN ${readyDueSql}`)
      .bind(10, 8)
      .all<{ detail: string }>();
    const readyDuePlanDetails = readyDuePlan.results.map((row) => row.detail).join('\n');
    assert.match(readyDuePlanDetails, /SEARCH commerce_documents USING INDEX commerce_ready_notifications_due\b/);
    assert.doesNotMatch(readyDuePlanDetails, /SCAN commerce_documents|USE TEMP B-TREE/i);

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

    observedBatchResults = undefined;
    await assert.rejects(
      observedRepository.queryDueStripeTerminalNotifications(10),
      (error: unknown) => error instanceof CommerceRepositoryError && error.code === 'unavailable',
    );
    const pausedTerminalNotificationRowsRead = Number(latestObservedBatchResults()?.[1]?.meta.rows_read);
    assert.equal(Number.isSafeInteger(pausedTerminalNotificationRowsRead), true);
    assert.equal(pausedTerminalNotificationRowsRead <= 4, true);

    observedBatchResults = undefined;
    await assert.rejects(
      observedRepository.queryDueReadyNotifications({ dueAtMs: 10, limit: 8 }),
      (error: unknown) => error instanceof CommerceRepositoryError && error.code === 'unavailable',
    );
    const pausedReadyNotificationRowsRead = Number(latestObservedBatchResults()?.[1]?.meta.rows_read);
    assert.equal(Number.isSafeInteger(pausedReadyNotificationRowsRead), true);
    assert.equal(pausedReadyNotificationRowsRead <= 4, true);

    assert.equal(
      (await observedRepository.getAdminIrlRedeemRequestForWorkflowStatus(workflowOperationId))?.key.path,
      workflowKey.path,
    );
    assert.equal(await observedRepository.getAdminIrlRedeemRequestForWorkflowStatus(missingWorkflowOperationId), null);
    await assert.rejects(
      observedRepository.getAdminIrlRedeemRequestForWorkflowStatus(duplicateWorkflowOperationId),
      (error: unknown) => error instanceof CommerceRepositoryError && error.code === 'internal',
    );
  } finally {
    await server.close();
  }
});
