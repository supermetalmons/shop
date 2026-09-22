import { LEGACY_NOTIFICATION_FIELDS, type NotificationOutboxFamily } from '../../../../shared/notificationOutbox.ts';
import { notificationOutboxWriteStatement } from '../src/notificationOutboxRepository.ts';
import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { createTestHarness } from 'wrangler';
import { STRIPE_OFFCHAIN_DELIVERY_ORDER_SOURCE } from '../../../../shared/fulfillmentSources.ts';
import {
  manualReviewCheckoutsQuery,
  stripeChargebackLinkedSessionsQuery,
  stripeChargebackMatchedDocumentsQuery,
} from '../src/commerceQueries.ts';
import { manualReviewDocumentCursor } from '../../../../shared/fulfillmentManualReviewPagination.ts';
import {
  CommerceRepositoryError,
  CommerceWriteConflict,
  D1CommerceRepository,
  commerceKeys,
  type CommerceDocumentData,
  type CommerceDocumentKey,
  type CommerceTimestamp,
} from '../src/commerceRepository.ts';
import { loadStripeChargebackSessionIds, recordStripeChargeback } from '../src/stripeChargebackStore.ts';

function insertDocument(
  db: D1Database,
  key: CommerceDocumentKey,
  data: CommerceDocumentData,
  processedAt: CommerceTimestamp | null = null,
): D1PreparedStatement {
  return db.prepare(`INSERT INTO commerce_documents (
    document_path, document_kind, drop_id, document_id, document_json,
    version, create_time, update_time, processed_at_seconds, processed_at_nanos
  ) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`).bind(
    key.path,
    key.kind,
    key.dropId,
    key.documentId,
    JSON.stringify(Object.fromEntries(Object.entries(data).filter(([name]) => !LEGACY_NOTIFICATION_FIELDS.includes(name as typeof LEGACY_NOTIFICATION_FIELDS[number])))),
    '2026-01-01T00:00:00.000Z',
    '2026-01-01T00:00:00.000Z',
    processedAt?.seconds ?? null,
    processedAt?.nanos ?? null,
  );
}

function insertOutbox(
  db: D1Database,
  key: CommerceDocumentKey,
  dueAtMs: number,
  family: NotificationOutboxFamily = 'ready',
  outcome: 'fulfilled' | 'manual_review' = 'fulfilled',
) {
  return notificationOutboxWriteStatement(db, {
    parentPath: key.path, dropId: key.dropId!, family, generation: crypto.randomUUID(), revision: 1,
    outcome: family === 'stripe_terminal' ? outcome : null, state: 'pending',
    entries: [{ kind: family === 'stripe_terminal' && outcome === 'manual_review' ? 'stripe_checkout_manual_review' : 'buyer_order_received',
      jobId: crypto.randomUUID(),
      idempotencyKey: `${key.dropId}:${key.documentId}:${outcome === 'manual_review' ? 'stripe_manual_review' : 'order_received'}`, state: 'pending' }],
    attemptCount: 0, nextAttemptAtMs: dueAtMs, claimId: null, claimExpiresAtMs: null,
    retryUntilMs: 21_600_000, createdAtMs: 0, updatedAtMs: 0, lastErrorCode: null,
  });
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
      '0011_stripe_order_disputes.sql',
      '0012_stripe_identity_lookup_indexes.sql',
      '0013_notification_outbox.sql',
      '0014_drop_legacy_notification_indexes.sql',
      '0015_manual_review_pagination.sql',
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
      env.COMMERCE_DB.prepare(`UPDATE commerce_notification_outbox_control SET preparation_state = 'preparing' WHERE singleton = 1`),
      env.COMMERCE_DB.prepare(`UPDATE commerce_notification_outbox_control SET preparation_state = 'ready',
        source_documents_revision = 0, prepared_at_ms = 0 WHERE singleton = 1`),
      env.COMMERCE_DB.prepare(`UPDATE commerce_notification_outbox_control SET storage_mode = 'table' WHERE singleton = 1`),
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
      ...['1', '2', '3'].map((id) => insertDocument(
        env.COMMERCE_DB,
        commerceKeys.deliveryOrder('named-reads', id),
        { owner: 'named-owner', status: 'ready_to_ship' },
        { seconds: 100, nanos: id === '1' ? 1 : 2 },
      )),
      insertDocument(env.COMMERCE_DB, commerceKeys.deliveryOrder('named-reads', 'null'), {
        owner: 'named-owner', status: 'ready_to_ship',
      }),
      insertDocument(env.COMMERCE_DB, commerceKeys.deliveryOrder('named-reads', 'processing'), {
        owner: 'named-owner', status: 'processing',
      }),
      insertDocument(env.COMMERCE_DB, commerceKeys.deliveryOrder('named-reads', 'prepared'), {
        owner: 'named-owner', status: 'prepared',
      }),
      insertDocument(env.COMMERCE_DB, commerceKeys.stripeCheckout('named-reads', 'manual'), {
        manualRefundReviewRequired: true, status: 'fulfillment_failed', failedAt: 100,
      }),
      insertDocument(env.COMMERCE_DB, commerceKeys.stripeCheckout('named-reads', 'manual-older'), {
        manualRefundReviewRequired: true, status: 'fulfillment_failed', createdAt: 1,
      }),
      insertDocument(env.COMMERCE_DB, commerceKeys.stripeCheckout('named-reads', 'not-manual'), {
        manualRefundReviewRequired: false,
      }),
      ...['a', 'b', 'c'].map((dropId) => insertDocument(
        env.COMMERCE_DB,
        commerceKeys.boxAssignment(dropId, 'legacy'),
        { irlClaimCode: 'RUNTIME-LEGACY' },
      )),
      env.COMMERCE_DB.prepare(`UPDATE commerce_authority_control
        SET documents_revision = documents_revision + 1,
          updated_at_ms = updated_at_ms + 1
        WHERE singleton = 1`),
    ]);
    await env.COMMERCE_DB.batch([
      insertOutbox(env.COMMERCE_DB, deliveryKey, 0),
      ...[10, 11].map((expiry) => insertOutbox(env.COMMERCE_DB, commerceKeys.deliveryOrder('runtime', `notification-${expiry}`), expiry)),
      insertOutbox(env.COMMERCE_DB, commerceKeys.stripeCheckout('runtime', 'cs_terminal'), 10, 'stripe_terminal'),
    ]);
    const commerceBeforeChargeback = (await env.COMMERCE_DB.prepare(`SELECT document_path,
      document_json, version, update_time FROM commerce_documents ORDER BY document_path`).all()).results;
    const authorityBeforeChargeback = await env.COMMERCE_DB.prepare(
      'SELECT * FROM commerce_authority_control WHERE singleton = 1',
    ).first();
    const chargeback = {
      livemode: true,
      sessionId: 'cs_live_runtime',
      disputeId: 'du_runtime',
      dropId: 'runtime',
      chargeId: 'ch_runtime',
      paymentIntentId: 'pi_runtime',
      disputeCreatedAt: 100,
      recordedAtMs: 200,
    };
    assert.equal(await recordStripeChargeback(env.COMMERCE_DB, chargeback, false), 'unwritten');
    assert.equal(await recordStripeChargeback(env.COMMERCE_DB, chargeback), 'inserted');
    assert.equal(await recordStripeChargeback(env.COMMERCE_DB, { ...chargeback, recordedAtMs: 300 }), 'existing');
    assert.deepEqual(await loadStripeChargebackSessionIds(env.COMMERCE_DB, 'runtime', ['cs_live_runtime']),
      new Set(['cs_live_runtime']));
    assert.deepEqual(await loadStripeChargebackSessionIds(env.COMMERCE_DB, 'other', ['cs_live_runtime']), new Set());
    assert.equal((await env.COMMERCE_DB.prepare('SELECT recorded_at_ms FROM stripe_order_disputes').first())?.recorded_at_ms, 200);
    assert.deepEqual((await env.COMMERCE_DB.prepare(`SELECT document_path,
      document_json, version, update_time FROM commerce_documents ORDER BY document_path`).all()).results, commerceBeforeChargeback);
    assert.deepEqual(await env.COMMERCE_DB.prepare('SELECT * FROM commerce_authority_control WHERE singleton = 1').first(),
      authorityBeforeChargeback);
    const repository = new D1CommerceRepository(env.COMMERCE_DB);
    assert.deepEqual((await repository.get(claimKey))?.data, { status: 'unused' });
    assert.equal(await repository.get(commerceKeys.claimCode('MISSING')), null);
    assert.deepEqual(
      (await repository.queryDeliveryHistory({ owners: ['named-owner'] })).map((record) => record.key.documentId),
      ['1', '2', '3', 'null', 'processing'],
    );
    assert.deepEqual(await repository.queryDeliveryHistory({ owners: ['missing'] }), []);
    assert.deepEqual(
      (await repository.queryFulfillmentOrders({ dropId: 'named-reads', limit: 2 }))
        .map((record) => record.key.documentId),
      ['3', '2'],
    );
    const remainingFulfillment = await repository.queryFulfillmentOrders({
      dropId: 'named-reads',
      limit: 10,
      startAfter: {
        processedAt: { seconds: 100, nanos: 2 },
        documentPath: 'drops/named-reads/deliveryOrders/3',
      },
    });
    assert.deepEqual(remainingFulfillment.map((record) => record.key.documentId), ['2', '1', 'null']);
    assert.deepEqual(remainingFulfillment.map((record) => record.processedAt), [
      { seconds: 100, nanos: 2 }, { seconds: 100, nanos: 1 }, null,
    ]);
    assert.deepEqual(
      (await repository.queryManualReviewCheckouts({ dropId: 'named-reads', limit: 26 })).map((record) => record.key.documentId),
      ['manual', 'manual-older'],
    );
    const manualReviewFirstPage = await repository.queryManualReviewCheckouts({ dropId: 'named-reads', limit: 1 });
    const manualReviewCursor = manualReviewDocumentCursor('named-reads', manualReviewFirstPage[0]);
    assert.deepEqual((await repository.queryManualReviewCheckouts({
      dropId: 'named-reads', limit: 1, startAfter: manualReviewCursor,
    })).map((record) => record.key.documentId), ['manual-older']);
    const manualReviewQuery = manualReviewCheckoutsQuery({
      dropId: 'named-reads', limit: 2, startAfter: manualReviewCursor,
    });
    const manualReviewPlan = await env.COMMERCE_DB.prepare(`EXPLAIN QUERY PLAN ${manualReviewQuery.sql}`)
      .bind(...manualReviewQuery.bindings).all<{ detail: string }>();
    assert.match(manualReviewPlan.results.map((row) => row.detail).join('\n'),
      /\(manual_review_sort_at_ms,manual_review_session_id,document_path\)<\(\?,\?,\?\)/);
    assert.ok(manualReviewPlan.results.every((row) => !row.detail.includes('USE TEMP B-TREE')));
    assert.deepEqual(await repository.queryManualReviewCheckouts({ dropId: 'missing', limit: 26 }), []);
    assert.deepEqual(
      (await repository.queryLegacyClaimAssignments({ code: 'RUNTIME-LEGACY' })).map((record) => record.key.path),
      ['drops/a/boxAssignments/legacy', 'drops/b/boxAssignments/legacy'],
    );
    assert.deepEqual(await repository.queryLegacyClaimAssignments({ code: 'MISSING' }), []);
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
    for (let offset = 0; offset < 128; offset += 32) {
      await env.COMMERCE_DB.batch(Array.from({ length: 32 }, (_, index) =>
        insertOutbox(env.COMMERCE_DB, commerceKeys.deliveryOrder('runtime', `paused-${offset + index}`), 1_000)));
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
    const missingOutboxPath = commerceKeys.deliveryOrder('runtime', 'outbox-bulk-missing').path;
    const outboxPaths = Array.from({ length: 101 }, (_, index) => index === 37
      ? missingOutboxPath
      : commerceKeys.deliveryOrder('runtime', `paused-${index}`).path);
    const requestedOutboxPaths = [...outboxPaths.toReversed(), missingOutboxPath, outboxPaths[20]];
    const outboxes = await observedRepository.notificationOutbox.getMany(requestedOutboxPaths, 'ready');
    assert.deepEqual(
      outboxes.map((record) => record.parentPath).sort(),
      outboxPaths.filter((path) => path !== missingOutboxPath).sort(),
    );
    assert.ok(outboxes.every((record) => record.family === 'ready'));
    assert.deepEqual(observedBatchSizes, [4]);
    assert.equal(observedPreparedSql.length, 4);
    assert.equal(observedPreparedSql.filter((sql) => /FROM commerce_authority_control WHERE singleton = 1/.test(sql)).length, 1);
    const outboxReadSql = observedPreparedSql.filter((sql) => /FROM commerce_notification_outbox WHERE family = \? AND parent_path IN/.test(sql));
    assert.deepEqual(outboxReadSql.map((sql) => sql.match(/\?/g)?.length ?? 0), [51, 51, 2]);

    observedBatchSizes.length = 0;
    observedPreparedSql.length = 0;
    assert.deepEqual(await observedRepository.notificationOutbox.getMany(requestedOutboxPaths, 'shipped'), []);
    assert.deepEqual(observedBatchSizes, [4]);

    observedBatchSizes.length = 0;
    observedPreparedSql.length = 0;
    assert.deepEqual(await observedRepository.notificationOutbox.getMany([], 'ready'), []);
    assert.equal(observedBatchSizes.length, 0);
    assert.equal(observedPreparedSql.length, 0);

    for (const firstAccess of ['point', 'bulk', 'owner', 'mutation'] as const) {
      observedBatchSizes.length = 0;
      observedPreparedSql.length = 0;
      const unit = await observedRepository.begin(Date.parse('2026-01-01T00:00:23.000Z'));
      assert.deepEqual(await unit.getMany([]), []);
      assert.deepEqual(observedBatchSizes, []);
      assert.deepEqual(observedPreparedSql, []);
      if (firstAccess === 'point') assert.equal((await unit.get(claimKey))?.key.path, claimKey.path);
      else if (firstAccess === 'bulk') {
        assert.deepEqual((await unit.getMany([claimKey, commerceKeys.claimCode('STARTUP-MISSING')]))
          .map((record) => record?.key.path ?? null), [claimKey.path, null]);
      } else if (firstAccess === 'owner') {
        assert.deepEqual((await unit.queryDeliveryOrdersByOwner({ owner: 'runtime-wallet', limit: 5 }))
          .map((record) => record.key.path), [deliveryKey.path]);
      } else await unit.update(claimKey, { startupProbe: true });
      assert.deepEqual(observedBatchSizes, [3], firstAccess);
      if (firstAccess === 'mutation') await unit.update(checkoutKey, { startupProbe: true });
      else assert.equal((await unit.get(checkoutKey))?.key.path, checkoutKey.path);
      assert.deepEqual(observedBatchSizes, [3, 2], firstAccess);
      assert.equal(observedPreparedSql.filter((sql) => /FROM commerce_authority_control WHERE singleton = 1/.test(sql)).length, 1);
      unit.rollback();
    }

    observedBatchSizes.length = 0;
    observedPreparedSql.length = 0;
    await observedRepository.run(Date.parse('2026-01-01T00:00:23.000Z'), async (unit) => {
      assert.equal((await unit.get(claimKey))?.key.path, claimKey.path);
      await unit.update(claimKey, { startupRoundTripProbe: true });
    });
    assert.deepEqual(observedBatchSizes, [3, 4]);
    assert.equal((await repository.get(claimKey))?.data.startupRoundTripProbe, true);

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
    assert.equal(dueReadyRowsRead <= 10, true, `Due notification query read ${dueReadyRowsRead} rows: ${observedPreparedSql.join("\n")}`);
    const readyDueSql = observedPreparedSql.find((sql) => sql.includes('commerce_notification_outbox') && sql.includes('next_attempt_at_ms'));
    assert.ok(readyDueSql);
    const readyDuePlan = await env.COMMERCE_DB.prepare(`EXPLAIN QUERY PLAN ${readyDueSql}`)
      .bind(10, 8)
      .all<{ detail: string }>();
    const readyDuePlanDetails = readyDuePlan.results.map((row) => row.detail).join('\n');
    assert.match(readyDuePlanDetails, /SEARCH .* USING (?:COVERING )?INDEX commerce_notification_outbox_family_due\b/);
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

    const notificationOwner = 'large-notification-owner';
    for (let offset = 0; offset < 1000; offset += 50) {
      const completedKeys = Array.from({ length: 50 }, (_, index) => commerceKeys.deliveryOrder('notification-load', `completed-${offset + index}`));
      const otherKeys = Array.from({ length: 50 }, (_, index) => commerceKeys.deliveryOrder('notification-load', `other-${offset + index}`));
      const ineligibleKeys = Array.from({ length: 50 }, (_, index) => commerceKeys.deliveryOrder('notification-load', `ineligible-${offset + index}`));
      await env.COMMERCE_DB.batch([
        ...completedKeys.map((key) => insertDocument(env.COMMERCE_DB, key, { owner: notificationOwner, status: 'ready_to_ship' })),
        ...otherKeys.map((key) => insertDocument(env.COMMERCE_DB, key, { owner: 'other-notification-owner', status: 'ready_to_ship' })),
        ...ineligibleKeys.map((key) => insertDocument(env.COMMERCE_DB, key, { owner: notificationOwner, status: 'processing' })),
        env.COMMERCE_DB.prepare('UPDATE commerce_authority_control SET documents_revision = documents_revision + 1 WHERE singleton = 1'),
      ]);
      await env.COMMERCE_DB.batch([...otherKeys, ...ineligibleKeys].map((key) => insertOutbox(env.COMMERCE_DB, key, 1_000)));
    }
    observedBatchResults = undefined;
    assert.deepEqual(await observedRepository.queryPendingReadyNotifications({ owner: notificationOwner, limit: 8 }), []);
    const emptyNotificationRowsRead = Number(latestObservedBatchResults()?.[1]?.meta.rows_read);
    assert.equal(emptyNotificationRowsRead <= 4, true, `Empty notification lookup read ${emptyNotificationRowsRead} rows`);
    const activeNotificationKeys = ['active-1', 'active-2'].map((id) => commerceKeys.deliveryOrder('notification-load', id));
    await env.COMMERCE_DB.batch([
      ...activeNotificationKeys.map((key) => insertDocument(env.COMMERCE_DB, key, { owner: notificationOwner, status: 'ready_to_ship' })),
      env.COMMERCE_DB.prepare('UPDATE commerce_authority_control SET documents_revision = documents_revision + 1 WHERE singleton = 1'),
    ]);
    await env.COMMERCE_DB.batch(activeNotificationKeys.map((key) => insertOutbox(env.COMMERCE_DB, key, 1_000)));
    observedBatchResults = undefined;
    observedPreparedSql.length = 0;
    assert.deepEqual((await observedRepository.queryPendingReadyNotifications({ owner: notificationOwner, limit: 1 }))
      .map((record) => record.key.path), [activeNotificationKeys[0].path]);
    const matchingNotificationRowsRead = Number(latestObservedBatchResults()?.[1]?.meta.rows_read);
    assert.equal(matchingNotificationRowsRead <= 8, true, `Matching notification lookup read ${matchingNotificationRowsRead} rows`);
    const ownerNotificationSql = observedPreparedSql.find((sql) => sql.includes('INDEXED BY commerce_notification_outbox_pending_owner_path'));
    assert.ok(ownerNotificationSql);
    const ownerNotificationPlan = await env.COMMERCE_DB.prepare(`EXPLAIN QUERY PLAN ${ownerNotificationSql}`)
      .bind(notificationOwner, 1).all<{ detail: string }>();
    assert.match(ownerNotificationPlan.results.map((row) => row.detail).join('\n'),
      /SEARCH pending USING (?:COVERING )?INDEX commerce_notification_outbox_pending_owner_path/);
    assert.deepEqual((await observedRepository.queryPendingReadyNotifications({
      owner: notificationOwner, limit: 1, startAfterPath: activeNotificationKeys[0].path,
    })).map((record) => record.key.path), [activeNotificationKeys[1].path]);
    const originalNotification = await repository.notificationOutbox.get(activeNotificationKeys[0].path, 'ready');
    assert.ok(originalNotification);
    await repository.run(Date.now(), (unit) => unit.update(activeNotificationKeys[0], { owner: 'transferred-notification-owner' }));
    assert.deepEqual(await repository.notificationOutbox.get(activeNotificationKeys[0].path, 'ready'), originalNotification);
    assert.deepEqual((await observedRepository.queryPendingReadyNotifications({ owner: 'transferred-notification-owner', limit: 8 }))
      .map((record) => record.key.path), [activeNotificationKeys[0].path]);
    await repository.run(Date.now(), async (unit) => {
      await unit.update(activeNotificationKeys[0], { owner: notificationOwner });
      await unit.cancelNotificationOutbox(activeNotificationKeys[0].path, 'ready');
    });
    assert.deepEqual(await observedRepository.queryPendingReadyNotifications({ owner: 'transferred-notification-owner', limit: 8 }), []);
    assert.deepEqual((await observedRepository.queryPendingReadyNotifications({ owner: notificationOwner, limit: 8 }))
      .map((record) => record.key.path), [activeNotificationKeys[1].path]);

    const indexedSessionId = 'cs_live_indexed';
    const indexedPaymentIntentId = 'pi_indexed';
    const indexedCheckoutKey = commerceKeys.stripeCheckout('stripe-indexes', indexedSessionId);
    const indexedDeliveryKey = commerceKeys.deliveryOrder('stripe-indexes', 'indexed');
    await env.COMMERCE_DB.batch([
      insertDocument(env.COMMERCE_DB, indexedCheckoutKey, {
        stripePaymentIntentId: indexedPaymentIntentId,
      }),
      insertDocument(env.COMMERCE_DB, indexedDeliveryKey, {
        source: STRIPE_OFFCHAIN_DELIVERY_ORDER_SOURCE,
        stripeCheckoutSessionId: indexedSessionId,
        stripePaymentIntentId: indexedPaymentIntentId,
      }),
    ]);
    for (let offset = 0; offset < 600; offset += 100) {
      await env.COMMERCE_DB.batch(Array.from({ length: 100 }, (_, index) => {
        const id = offset + index;
        return [
          insertDocument(env.COMMERCE_DB, commerceKeys.stripeCheckout('stripe-indexes', `cs_live_unrelated_${id}`), {
            stripePaymentIntentId: `pi_unrelated_${id}`,
          }),
          insertDocument(env.COMMERCE_DB, commerceKeys.deliveryOrder('stripe-indexes', `unrelated-${id}`), {
            source: STRIPE_OFFCHAIN_DELIVERY_ORDER_SOURCE,
            stripeCheckoutSessionId: `cs_live_unrelated_${id}`,
            stripePaymentIntentId: `pi_unrelated_${id}`,
          }),
        ];
      }).flat());
    }

    for (const analyze of [false, true]) {
      if (analyze) await env.COMMERCE_DB.prepare('ANALYZE commerce_documents').run();
      for (const missing of [false, true]) {
        const linkedQuery = stripeChargebackLinkedSessionsQuery(missing ? 'pi_missing_indexed' : indexedPaymentIntentId);
        const linkedRows = await env.COMMERCE_DB.prepare(linkedQuery.sql).bind(...linkedQuery.bindings)
          .all<{ session_id: unknown }>();
        assert.deepEqual(linkedRows.results, missing ? [] : [{ session_id: indexedSessionId }]);
        assert.ok(Number.isSafeInteger(linkedRows.meta.rows_read));
        assert.ok(linkedRows.meta.rows_read <= 12, `Linked sessions read ${linkedRows.meta.rows_read} rows (analyzed: ${analyze})`);
        const linkedPlan = await env.COMMERCE_DB.prepare(`EXPLAIN QUERY PLAN ${linkedQuery.sql}`)
          .bind(...linkedQuery.bindings).all<{ detail: string }>();
        const linkedPlanDetails = linkedPlan.results.map((row) => row.detail).join('\n');
        assert.match(linkedPlanDetails, /SEARCH commerce_documents USING INDEX commerce_documents_stripe_payment_intent\b/);
        assert.doesNotMatch(linkedPlanDetails, /SCAN commerce_documents/i);

        const matchedQuery = stripeChargebackMatchedDocumentsQuery(missing ? 'cs_live_missing_indexed' : indexedSessionId);
        const matchedRows = await env.COMMERCE_DB.prepare(matchedQuery.sql).bind(...matchedQuery.bindings)
          .all<{ document_path: string }>();
        assert.deepEqual(matchedRows.results.map((row) => row.document_path).sort(),
          missing ? [] : [indexedCheckoutKey.path, indexedDeliveryKey.path].sort());
        assert.ok(Number.isSafeInteger(matchedRows.meta.rows_read));
        assert.ok(matchedRows.meta.rows_read <= 12, `Matched documents read ${matchedRows.meta.rows_read} rows (analyzed: ${analyze})`);
        const matchedPlan = await env.COMMERCE_DB.prepare(`EXPLAIN QUERY PLAN ${matchedQuery.sql}`)
          .bind(...matchedQuery.bindings).all<{ detail: string }>();
        const matchedPlanDetails = matchedPlan.results.map((row) => row.detail).join('\n');
        assert.match(matchedPlanDetails, /SEARCH commerce_documents USING INDEX commerce_stripe_checkouts_session_id\b/);
        assert.match(matchedPlanDetails, /SEARCH commerce_documents USING INDEX commerce_stripe_delivery_orders_session_id\b/);
        assert.doesNotMatch(matchedPlanDetails, /SCAN commerce_documents/i);
      }
    }

    for (let offset = 0; offset < 1000; offset += 50) {
      const keys = Array.from({ length: 50 }, (_, index) => commerceKeys.stripeCheckout('stripe-due-load', `cs_inactive_${offset + index}`));
      await env.COMMERCE_DB.batch([
        ...keys.map((key, index) => insertDocument(env.COMMERCE_DB, key, {
          status: index % 2 ? 'processing' : 'fulfillment_pending', manualRefundReviewRequired: true,
        })),
        env.COMMERCE_DB.prepare('UPDATE commerce_authority_control SET documents_revision = documents_revision + 1 WHERE singleton = 1'),
      ]);
      await env.COMMERCE_DB.batch(keys.map((key) => insertOutbox(env.COMMERCE_DB, key, 0, 'stripe_terminal', 'manual_review')));
    }
    const suspendedKey = commerceKeys.stripeCheckout('stripe-due-load', 'cs_inactive_0');
    const suspendedOutbox = await repository.notificationOutbox.get(suspendedKey.path, 'stripe_terminal');
    assert.ok(suspendedOutbox);
    for (const analyze of [false, true]) {
      if (analyze) await env.COMMERCE_DB.prepare('ANALYZE').run();
      observedBatchResults = undefined;
      assert.deepEqual(await observedRepository.queryDueStripeTerminalNotifications(5, 20), []);
      const rowsRead = Number(latestObservedBatchResults()?.[1]?.meta.rows_read);
      assert.ok(Number.isSafeInteger(rowsRead) && rowsRead <= 4,
        `Suspended Stripe notification query read ${rowsRead} rows (analyzed: ${analyze})`);
    }
    const stripeDueKeys = ['cs_due_a', 'cs_due_b', 'cs_due_earlier', 'cs_due_future']
      .map((id) => commerceKeys.stripeCheckout('stripe-due-load', id));
    const stripeDueTimes = [2, 2, 1, 6];
    await env.COMMERCE_DB.batch([
      ...stripeDueKeys.map((key) => insertDocument(env.COMMERCE_DB, key, {
        status: 'fulfillment_failed', manualRefundReviewRequired: true,
      })),
      env.COMMERCE_DB.prepare('UPDATE commerce_authority_control SET documents_revision = documents_revision + 1 WHERE singleton = 1'),
    ]);
    await env.COMMERCE_DB.batch(stripeDueKeys.map((key, index) =>
      insertOutbox(env.COMMERCE_DB, key, stripeDueTimes[index], 'stripe_terminal', 'manual_review')));
    observedBatchResults = undefined;
    observedPreparedSql.length = 0;
    assert.deepEqual((await observedRepository.queryDueStripeTerminalNotifications(5, 2)).map((record) => record.key.path),
      [stripeDueKeys[2].path, stripeDueKeys[0].path]);
    const matchedStripeDueRowsRead = Number(latestObservedBatchResults()?.[1]?.meta.rows_read);
    assert.ok(Number.isSafeInteger(matchedStripeDueRowsRead) && matchedStripeDueRowsRead <= 12,
      `Matching Stripe notification query read ${matchedStripeDueRowsRead} rows`);
    const stripeDueSql = observedPreparedSql.find((sql) => sql.includes('INDEXED BY commerce_notification_outbox_stripe_due_at'));
    assert.ok(stripeDueSql);
    const stripeDuePlan = await env.COMMERCE_DB.prepare(`EXPLAIN QUERY PLAN ${stripeDueSql}`)
      .bind(5, 2).all<{ detail: string }>();
    const stripeDuePlanDetails = stripeDuePlan.results.map((row) => row.detail).join('\n');
    assert.match(stripeDuePlanDetails, /SEARCH due USING (?:COVERING )?INDEX commerce_notification_outbox_stripe_due_at/);
    assert.doesNotMatch(stripeDuePlanDetails, /SCAN (?:commerce_documents|document|outbox)|USE TEMP B-TREE/i);
    assert.deepEqual((await observedRepository.queryDueStripeTerminalNotifications(5, 20)).map((record) => record.key.path),
      [stripeDueKeys[2].path, stripeDueKeys[0].path, stripeDueKeys[1].path]);
    await repository.run(Date.now(), (unit) => unit.update(suspendedKey, { status: 'fulfillment_failed' }));
    assert.deepEqual(await repository.notificationOutbox.get(suspendedKey.path, 'stripe_terminal'), suspendedOutbox);
    assert.deepEqual((await observedRepository.queryDueStripeTerminalNotifications(0, 20)).map((record) => record.key.path), [suspendedKey.path]);
    await repository.run(Date.now(), (unit) => unit.update(suspendedKey, { manualRefundReviewRequired: false }));
    assert.deepEqual(await observedRepository.queryDueStripeTerminalNotifications(0, 20), []);
    assert.deepEqual(await repository.notificationOutbox.get(suspendedKey.path, 'stripe_terminal'), suspendedOutbox);

    const pausedReadUnit = await observedRepository.begin(Date.parse('2026-01-01T00:00:24.000Z'));
    const pausedWriteUnit = await observedRepository.begin(Date.parse('2026-01-01T00:00:25.000Z'));
    const pausedEmptyUnit = await observedRepository.begin(Date.parse('2026-01-01T00:00:26.000Z'));
    await pausedReadUnit.get(claimKey);
    await pausedWriteUnit.get(claimKey);
    const claimBeforePause = await repository.get(claimKey);

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
    for (const firstAccess of ['point', 'bulk', 'owner', 'mutation'] as const) {
      observedBatchSizes.length = 0;
      observedPreparedSql.length = 0;
      const unit = await observedRepository.begin(Date.parse('2026-01-01T00:00:27.000Z'));
      assert.deepEqual(await unit.getMany([]), []);
      assert.deepEqual(observedBatchSizes, []);
      assert.deepEqual(observedPreparedSql, []);
      const access = () => firstAccess === 'point' ? unit.get(claimKey)
        : firstAccess === 'bulk' ? unit.getMany([claimKey])
          : firstAccess === 'owner' ? unit.queryDeliveryOrdersByOwner({ owner: 'runtime-wallet', limit: 5 })
            : unit.update(claimKey, { pausedStartupProbe: true });
      for (let attempt = 0; attempt < 2; attempt += 1) {
        await assert.rejects(access(),
          (error: unknown) => error instanceof CommerceRepositoryError && error.code === 'unavailable', firstAccess);
      }
      assert.deepEqual(observedBatchSizes, [3, 3], firstAccess);
      unit.rollback();
    }
    await pausedWriteUnit.update(claimKey, { pausedCommitProbe: true });
    for (const unit of [pausedReadUnit, pausedWriteUnit, pausedEmptyUnit]) {
      await assert.rejects(unit.commit(),
        (error: unknown) => error instanceof CommerceRepositoryError && error.code === 'unavailable');
    }
    const claimAfterPause = await env.COMMERCE_DB.prepare(`SELECT document_json, version
      FROM commerce_documents WHERE document_path = ?`).bind(claimKey.path)
      .first<{ document_json: string; version: number }>();
    assert.deepEqual(JSON.parse(claimAfterPause!.document_json), claimBeforePause?.data);
    assert.equal(claimAfterPause?.version, claimBeforePause?.version);

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
    assert.equal(pausedRowsRead <= 4, true, `Paused pending notifications read ${pausedRowsRead} rows`);

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
    assert.equal(pausedTerminalNotificationRowsRead <= 4, true, `Paused Stripe notifications read ${pausedTerminalNotificationRowsRead} rows`);

    observedBatchResults = undefined;
    await assert.rejects(
      observedRepository.queryDueReadyNotifications({ dueAtMs: 10, limit: 8 }),
      (error: unknown) => error instanceof CommerceRepositoryError && error.code === 'unavailable',
    );
    const pausedReadyNotificationRowsRead = Number(latestObservedBatchResults()?.[1]?.meta.rows_read);
    assert.equal(Number.isSafeInteger(pausedReadyNotificationRowsRead), true);
    assert.equal(pausedReadyNotificationRowsRead <= 4, true, `Paused ready notifications read ${pausedReadyNotificationRowsRead} rows`);

    for (const read of [
      () => observedRepository.queryDeliveryHistory({ owners: ['named-owner'] }),
      () => observedRepository.queryFulfillmentOrders({ dropId: 'named-reads', limit: 2 }),
      () => observedRepository.queryManualReviewCheckouts({ dropId: 'named-reads', limit: 26 }),
      () => observedRepository.queryLegacyClaimAssignments({ code: 'RUNTIME-LEGACY' }),
    ]) {
      await assert.rejects(read(),
        (error: unknown) => error instanceof CommerceRepositoryError && error.code === 'unavailable');
    }

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
