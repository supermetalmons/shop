import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createCommerceD1Harness,
  seedCommerceDocument,
  seedPackStatusOutbox,
  type CommerceD1CallObservation,
} from './commerceD1Harness.ts';
import { createDeferredWorkCollector } from './deferredWork.ts';
import {
  shouldEnqueueDeliveryPackStatusProjection,
  projectPendingDeliveryPackStatus,
  reconcilePendingDeliveryPackStatusProjections,
  scheduleDeliveryPackStatusProjection,
} from '../src/deliveryPackStatusOutbox.ts';
import { runtimeForDrop } from '../src/deliveryReceiptOnchain.ts';
import { D1CommerceRepository, commerceKeys, type CommerceDocumentData } from '../src/commerceRepository.ts';
import type { PackStatusOutboxRecord } from '../../../../shared/packStatusOutbox.ts';

const READY_NOTIFICATION_NOW_MS = 1_700_000_000_000;

function pendingOutbox(dropId = 'card_nft_2', deliveryId = 7, fields: Partial<PackStatusOutboxRecord> = {}): PackStatusOutboxRecord {
  return { parentPath: commerceKeys.deliveryOrder(dropId, String(deliveryId)).path, dropId,
    generation: crypto.randomUUID(), state: 'pending', revision: 1, failureCount: 0, nextAttemptAtMs: 0,
    completedAtMs: null, failedAtMs: null, lastErrorCode: null, createdAtMs: 0, updatedAtMs: 0, ...fields };
}


async function nativeDeliveryContext(
  fields: Record<string, unknown>,
  options: Parameters<typeof createCommerceD1Harness>[0] = {},
) {
  const harness = createCommerceD1Harness(options);
  seedCommerceDocument(harness, {
    key: commerceKeys.deliveryOrder('card_nft_2', '7'),
    data: fields as CommerceDocumentData,
  });
  if (fields.packStatusProjectionState === 'pending') {
    seedPackStatusOutbox(harness, pendingOutbox('card_nft_2', 7, {
      nextAttemptAtMs: Number(fields.packStatusProjectionNextAttemptAtMs ?? 0),
      failureCount: Number(fields.packStatusProjectionFailureCount ?? 0),
    }));
  }
  return {
    harness,
    context: {
      repository: new D1CommerceRepository(harness.db),
      nowMs: READY_NOTIFICATION_NOW_MS,
      signal: new AbortController().signal,
      dataDb: undefined as D1Database | undefined,
    },
  };
}

function projectionDataDb(args: {
  delay?: () => Promise<void>;
  failures?: number;
  lostResponses?: number;
  hasEvent?: boolean;
} = {}) {
  let attempts = 0;
  let applied = 0;
  let failures = args.failures || 0;
  let lostResponses = args.lostResponses || 0;
  const events = new Set<string>();
  return {
    db: {
      prepare() {
        let key = '';
        return {
          bind(...values: unknown[]) {
            key = JSON.stringify(values.slice(0, 3));
            return this;
          },
          async run() {
            attempts += 1;
            await args.delay?.();
            if (failures > 0) {
              failures -= 1;
              throw new Error('d1 unavailable');
            }
            const changes = args.hasEvent || events.has(key) ? 0 : 1;
            if (changes) {
              events.add(key);
              applied += 1;
            }
            if (lostResponses > 0) {
              lostResponses -= 1;
              throw new Error('d1 response lost after commit');
            }
            return { success: true, results: [], meta: { changes } };
          },
        };
      },
    } as unknown as Env['DATA_DB'],
    get applied() { return applied; },
    get attempts() { return attempts; },
  };
}

test('native pack-status projection applies once and marks the delivery complete', async () => {
  const native = await nativeDeliveryContext({
    deliveryId: 7,
    status: 'ready_to_ship',
    packStatusProjectionState: 'pending',
    packStatusProjectionNextAttemptAtMs: READY_NOTIFICATION_NOW_MS,
    packStatusProjectionFailureCount: 0,
    items: [{ kind: 'box', refId: 1 }],
  });
  const projection = projectionDataDb();
  native.context.dataDb = projection.db;
  assert.equal(await projectPendingDeliveryPackStatus({
    context: native.context,
    deliveryId: 7,
    dropId: 'card_nft_2',
    nowMs: () => READY_NOTIFICATION_NOW_MS,
  }), 'completed');
  const completed = await native.context.repository.packStatusOutbox.get(commerceKeys.deliveryOrder('card_nft_2', '7').path);
  assert.equal(projection.applied, 1);
  assert.equal(completed?.state, 'completed');
});

test('an unmarked historical ready order is never replayed', async () => {
  const native = await nativeDeliveryContext({ deliveryId: 7, status: 'ready_to_ship', items: [{ kind: 'box', refId: 1 }] });
  const projection = projectionDataDb();
  native.context.dataDb = projection.db;
  assert.equal(await projectPendingDeliveryPackStatus({ context: native.context, deliveryId: 7,
    dropId: 'card_nft_2', nowMs: () => READY_NOTIFICATION_NOW_MS }), 'not-needed');
  assert.equal(projection.attempts, 0);
  assert.equal(await native.context.repository.packStatusOutbox.get(pendingOutbox().parentPath), null);
});

test('a successful DATA event survives failed Commerce acknowledgment without double counting', async () => {
  const native = await nativeDeliveryContext(pendingOrder(7));
  const projection = projectionDataDb();
  native.context.dataDb = projection.db;
  const repository = native.context.repository.packStatusOutbox;
  const compareAndSet = repository.compareAndSet.bind(repository);
  repository.compareAndSet = async () => { throw new Error('Commerce unavailable'); };
  const args = { context: native.context, deliveryId: 7, dropId: 'card_nft_2',
    nowMs: () => READY_NOTIFICATION_NOW_MS, log: () => {} };
  await assert.rejects(projectPendingDeliveryPackStatus(args), /Commerce unavailable/);
  assert.equal((await repository.get(pendingOutbox().parentPath))?.state, 'pending');
  repository.compareAndSet = compareAndSet;
  assert.equal(await projectPendingDeliveryPackStatus(args), 'completed');
  assert.equal(projection.attempts, 2);
  assert.equal(projection.applied, 1);
});

test('a DATA response lost after commit schedules a retry that completes without double counting', async () => {
  const native = await nativeDeliveryContext(pendingOrder(7));
  const projection = projectionDataDb({ lostResponses: 1 });
  native.context.dataDb = projection.db;
  const args = { context: native.context, deliveryId: 7, dropId: 'card_nft_2', log: () => {} };
  assert.equal(await projectPendingDeliveryPackStatus({ ...args, nowMs: () => READY_NOTIFICATION_NOW_MS }), 'pending');
  const pending = await native.context.repository.packStatusOutbox.get(pendingOutbox().parentPath);
  assert.equal(pending?.state, 'pending');
  assert.equal(pending?.failureCount, 1);
  assert.equal(pending?.lastErrorCode, 'd1-write-failed');
  assert.equal(pending?.nextAttemptAtMs, READY_NOTIFICATION_NOW_MS + 5 * 60_000);
  assert.equal(projection.applied, 1);
  assert.equal(projection.attempts, 1);

  assert.equal(await projectPendingDeliveryPackStatus({ ...args,
    nowMs: () => READY_NOTIFICATION_NOW_MS + 5 * 60_000 }), 'completed');
  assert.equal((await native.context.repository.packStatusOutbox.get(pendingOutbox().parentPath))?.state, 'completed');
  assert.equal(projection.applied, 1);
  assert.equal(projection.attempts, 2);
});

test('a lost completion acknowledgment preserves the already completed outbox', async () => {
  const native = await nativeDeliveryContext(pendingOrder(7));
  const projection = projectionDataDb();
  native.context.dataDb = projection.db;
  const repository = native.context.repository.packStatusOutbox;
  const compareAndSet = repository.compareAndSet.bind(repository);
  repository.compareAndSet = async (args) => {
    const result = await compareAndSet(args);
    if (args.changes.state === 'completed') throw new Error('acknowledgment lost');
    return result;
  };
  assert.equal(await projectPendingDeliveryPackStatus({ context: native.context, deliveryId: 7,
    dropId: 'card_nft_2', nowMs: () => READY_NOTIFICATION_NOW_MS, log: () => {} }), 'completed');
  assert.equal((await repository.get(pendingOutbox().parentPath))?.failureCount, 0);
  assert.equal(projection.applied, 1);
});

test('an ineligible pending projection becomes cancelled without changing its order', async () => {
  const native = await nativeDeliveryContext({ ...pendingOrder(7), source: 'admin_irl_redeem',
    adminIrlRedeem: { targetKind: 'card_receipt' } });
  const before = await native.context.repository.get(commerceKeys.deliveryOrder('card_nft_2', '7'));
  const projection = projectionDataDb();
  native.context.dataDb = projection.db;
  assert.equal(await projectPendingDeliveryPackStatus({ context: native.context, deliveryId: 7,
    dropId: 'card_nft_2', nowMs: () => READY_NOTIFICATION_NOW_MS, log: () => {} }), 'not-needed');
  assert.equal((await native.context.repository.packStatusOutbox.get(pendingOutbox().parentPath))?.state, 'cancelled');
  assert.deepEqual(await native.context.repository.get(commerceKeys.deliveryOrder('card_nft_2', '7')), before);
  assert.equal(projection.attempts, 0);
});

test('pack-status projection persists retry state when a non-cooperative D1 write is cancelled', async () => {
  const native = await nativeDeliveryContext({
    deliveryId: 7,
    status: 'ready_to_ship',
    packStatusProjectionState: 'pending',
    packStatusProjectionNextAttemptAtMs: 0,
    packStatusProjectionFailureCount: 0,
    items: [{ kind: 'box', refId: 1 }],
  });
  const controller = new AbortController();
  const cancellation = new DOMException('caller cancelled', 'AbortError');
  const projection = projectionDataDb({
    delay: () => new Promise<void>(() => controller.abort(cancellation)),
  });
  native.context.dataDb = projection.db;
  native.context.signal = controller.signal;

  const outcome = await projectPendingDeliveryPackStatus({
    context: native.context,
    deliveryId: 7,
    dropId: 'card_nft_2',
    nowMs: () => READY_NOTIFICATION_NOW_MS,
  });
  const pending = await native.context.repository.packStatusOutbox.get(commerceKeys.deliveryOrder('card_nft_2', '7').path);

  assert.equal(outcome, 'pending');
  assert.equal(projection.attempts, 1);
  assert.equal(pending?.state, 'pending');
  assert.equal(pending?.failureCount, 1);
  assert.equal(pending?.lastErrorCode, 'aborted');
  assert.equal(pending?.nextAttemptAtMs, READY_NOTIFICATION_NOW_MS + 5 * 60_000);
});

test('scheduled pack-status projection survives request cancellation', async () => {
  const native = await nativeDeliveryContext({
    deliveryId: 7,
    status: 'ready_to_ship',
    packStatusProjectionState: 'pending',
    packStatusProjectionNextAttemptAtMs: 0,
    packStatusProjectionFailureCount: 0,
    items: [{ kind: 'box', refId: 1 }],
  });
  const projection = projectionDataDb();
  const controller = new AbortController();
  native.context.dataDb = projection.db;
  native.context.signal = controller.signal;
  const deferred = createDeferredWorkCollector();
  controller.abort(new Error('client disconnected'));

  scheduleDeliveryPackStatusProjection({
    context: native.context,
    deliveryId: 7,
    dropId: 'card_nft_2',
    waitUntil: deferred.defer,
  });
  await deferred.drain();

  const completed = await native.context.repository.packStatusOutbox.get(commerceKeys.deliveryOrder('card_nft_2', '7').path);
  assert.equal(projection.applied, 1);
  assert.equal(completed?.state, 'completed');
});

function pendingOrder(deliveryId: number, dropId = 'card_nft_2'): CommerceDocumentData {
  return {
    deliveryId,
    dropId,
    status: 'ready_to_ship',
    packStatusProjectionState: 'pending',
    packStatusProjectionNextAttemptAtMs: 0,
    packStatusProjectionFailureCount: 0,
    items: [{ kind: 'box', refId: deliveryId }],
  };
}

function documentReadCount(calls: readonly CommerceD1CallObservation[]): number {
  return calls.flatMap((call) => call.method === 'batch' ? call.statements : [call])
    .filter(({ sql }) => sql.includes('document_json') && /\b(?:FROM|JOIN) commerce_documents\b/.test(sql)).length;
}

test('delivery outbox creation only schedules eligible countable orders', () => {
  const runtime = runtimeForDrop('card_nft_2');
  const order = pendingOrder(7);
  assert.equal(shouldEnqueueDeliveryPackStatusProjection(runtime, order), true);
  assert.equal(shouldEnqueueDeliveryPackStatusProjection(runtime, { ...order, items: [] }), false);
});

test('projection completion and retry scheduling read the order once and never write it', async () => {
  for (const available of [true, false]) {
    const calls: CommerceD1CallObservation[] = [];
    const native = await nativeDeliveryContext(pendingOrder(7), {
      observeCall: (call) => calls.push(call),
    });
    if (available) native.context.dataDb = projectionDataDb().db;
    assert.equal(await projectPendingDeliveryPackStatus({
      context: native.context,
      deliveryId: 7,
      dropId: 'card_nft_2',
      nowMs: () => READY_NOTIFICATION_NOW_MS,
      log: () => {},
    }), available ? 'completed' : 'pending');
    assert.equal(documentReadCount(calls), 1);
    assert.equal(calls.flatMap((call) => call.method === 'batch' ? call.statements : [call])
      .some(({ sql }) => /(?:UPDATE|INSERT INTO) commerce_documents/.test(sql)), false);
  }
});

test('projection CAS preserves a concurrent terminal state', async () => {
  const native = await nativeDeliveryContext(pendingOrder(7));
  const expected = (await native.context.repository.packStatusOutbox.get(pendingOutbox().parentPath))!;
  const projection = projectionDataDb({ delay: async () => {
    await native.context.repository.packStatusOutbox.compareAndSet({ expected, nowMs: READY_NOTIFICATION_NOW_MS,
      changes: { state: 'failed', failureCount: 0, nextAttemptAtMs: null, completedAtMs: null,
        failedAtMs: READY_NOTIFICATION_NOW_MS, lastErrorCode: 'manual-review' } });
  } });
  native.context.dataDb = projection.db;
  assert.equal(await projectPendingDeliveryPackStatus({ context: native.context, deliveryId: 7,
    dropId: 'card_nft_2', nowMs: () => READY_NOTIFICATION_NOW_MS, log: () => {} }), 'failed');
  const stored = await native.context.repository.packStatusOutbox.get(expected.parentPath);
  assert.equal(stored?.state, 'failed');
  assert.equal(stored?.lastErrorCode, 'manual-review');
  assert.equal(stored?.failureCount, 0);
});

test('a non-cooperative CAS reread remains bounded by request cancellation', { timeout: 1_000 }, async () => {
  const native = await nativeDeliveryContext(pendingOrder(7));
  const expected = (await native.context.repository.packStatusOutbox.get(pendingOutbox().parentPath))!;
  const controller = new AbortController();
  native.context.signal = controller.signal;
  const repository = native.context.repository.packStatusOutbox;
  const get = repository.get.bind(repository);
  let reads = 0;
  repository.get = (path) => {
    reads += 1;
    if (reads === 2) return new Promise(() => setTimeout(() => controller.abort(new DOMException('cancelled', 'AbortError')), 0));
    return get(path);
  };
  native.context.dataDb = projectionDataDb({ delay: async () => {
    await repository.compareAndSet({ expected, nowMs: READY_NOTIFICATION_NOW_MS,
      changes: { state: 'failed', failureCount: 0, nextAttemptAtMs: null, completedAtMs: null,
        failedAtMs: READY_NOTIFICATION_NOW_MS, lastErrorCode: 'manual-review' } });
  } }).db;
  assert.equal(await projectPendingDeliveryPackStatus({ context: native.context, deliveryId: 7,
    dropId: 'card_nft_2', nowMs: () => READY_NOTIFICATION_NOW_MS, log: () => {} }), 'failed');
  assert.equal(reads, 3);
});

test('projection sweep shares its four-order cap fairly across drops with concurrency two', async () => {
  const harness = createCommerceD1Harness();
  const dropIds = ['card_nft_2', 'little_swag_boxes', 'poncho_drifella'];
  for (const dropId of dropIds) {
    for (const deliveryId of [1, 2, 3]) {
      seedCommerceDocument(harness, {
        key: commerceKeys.deliveryOrder(dropId, String(deliveryId)),
        data: pendingOrder(deliveryId, dropId),
      });
      seedPackStatusOutbox(harness, pendingOutbox(dropId, deliveryId));
    }
  }
  const events: Record<string, unknown>[] = [];
  let active = 0;
  let maximumActive = 0;
  const projection = projectionDataDb({
    delay: async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
    },
  });
  const env = { COMMERCE_DB: harness.db, DATA_DB: projection.db };
  assert.equal(await reconcilePendingDeliveryPackStatusProjections(env, new AbortController().signal, {
    dropIds,
    nowMs: () => READY_NOTIFICATION_NOW_MS,
    log: (event) => events.push(event),
  }), 4);
  assert.equal(projection.applied, 4);
  assert.equal(maximumActive, 2);
  assert.deepEqual(events.filter((event) => event.event === 'delivery_pack_status_projection_completed')
    .map((event) => `${event.dropId}:${event.deliveryId}`).sort(), [
    'card_nft_2:1', 'card_nft_2:2', 'little_swag_boxes:1', 'poncho_drifella:1',
  ]);
});

test('projection sweep marks malformed identities failed and counts them against its cap', async () => {
  const harness = createCommerceD1Harness();
  for (const deliveryId of [1, 2, 3, 4, 5]) {
    seedCommerceDocument(harness, {
      key: commerceKeys.deliveryOrder('card_nft_2', String(deliveryId)),
      data: { ...pendingOrder(deliveryId), ...(deliveryId === 1 ? { deliveryId: 99 } : {}) },
    });
    seedPackStatusOutbox(harness, pendingOutbox('card_nft_2', deliveryId));
  }
  const projection = projectionDataDb();
  assert.equal(await reconcilePendingDeliveryPackStatusProjections(
    { COMMERCE_DB: harness.db, DATA_DB: projection.db },
    new AbortController().signal,
    { dropIds: ['card_nft_2'], nowMs: () => READY_NOTIFICATION_NOW_MS, log: () => {} },
  ), 4);
  const context = { repository: new D1CommerceRepository(harness.db), nowMs: READY_NOTIFICATION_NOW_MS, signal: new AbortController().signal };
  const invalid = await context.repository.packStatusOutbox.get(commerceKeys.deliveryOrder('card_nft_2', '1').path);
  assert.equal(invalid?.state, 'failed');
  assert.equal(invalid?.lastErrorCode, 'invalid-order-identity');
  assert.equal((await context.repository.packStatusOutbox.get(commerceKeys.deliveryOrder('card_nft_2', '5').path))?.state, 'pending');
  assert.equal(projection.applied, 3);
});
