import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createCommerceD1Harness,
  seedCommerceDocument,
  type CommerceD1CallObservation,
} from './commerceD1Harness.ts';
import { createDeferredWorkCollector } from './deferredWork.ts';
import {
  createDeliveryPackStatusProjectionOutbox,
  projectPendingDeliveryPackStatus,
  reconcilePendingDeliveryPackStatusProjections,
  scheduleDeliveryPackStatusProjection,
} from '../src/deliveryPackStatusOutbox.ts';
import { runtimeForDrop } from '../src/deliveryReceiptOnchain.ts';
import { D1CommerceRepository, commerceKeys, type CommerceDocumentData } from '../src/commerceRepository.ts';
import { readCommerceRecord } from '../src/commerceTransactions.ts';

const READY_NOTIFICATION_NOW_MS = 1_700_000_000_000;

async function nativeDeliveryContext(
  fields: Record<string, unknown>,
  options: Parameters<typeof createCommerceD1Harness>[0] = {},
) {
  const harness = createCommerceD1Harness(options);
  seedCommerceDocument(harness, {
    key: commerceKeys.deliveryOrder('card_nft_2', '7'),
    data: fields as CommerceDocumentData,
  });
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
  hasEvent?: boolean;
} = {}) {
  let attempts = 0;
  let applied = 0;
  let failures = args.failures || 0;
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
  const completed = await readCommerceRecord(
    native.context,
    commerceKeys.deliveryOrder('card_nft_2', '7'),
  );
  assert.equal(projection.applied, 1);
  assert.equal(completed?.data.packStatusProjectionState, 'completed');
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
  const pending = await readCommerceRecord(
    { ...native.context, signal: new AbortController().signal },
    commerceKeys.deliveryOrder('card_nft_2', '7'),
  );

  assert.equal(outcome, 'pending');
  assert.equal(projection.attempts, 1);
  assert.equal(pending?.data.packStatusProjectionState, 'pending');
  assert.equal(pending?.data.packStatusProjectionFailureCount, 1);
  assert.equal(pending?.data.packStatusProjectionLastErrorCode, 'aborted');
  assert.equal(pending?.data.packStatusProjectionNextAttemptAtMs, READY_NOTIFICATION_NOW_MS + 5 * 60_000);
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

  const completed = await readCommerceRecord(
    { ...native.context, signal: new AbortController().signal },
    commerceKeys.deliveryOrder('card_nft_2', '7'),
  );
  assert.equal(projection.applied, 1);
  assert.equal(completed?.data.packStatusProjectionState, 'completed');
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
  const outbox = createDeliveryPackStatusProjectionOutbox(runtime, order, READY_NOTIFICATION_NOW_MS);
  assert.equal(outbox.packStatusProjectionState, 'pending');
  assert.equal(outbox.packStatusProjectionNextAttemptAtMs, READY_NOTIFICATION_NOW_MS);
  assert.equal(outbox.packStatusProjectionFailureCount, 0);
  assert.deepEqual(createDeliveryPackStatusProjectionOutbox(runtime, { ...order, items: [] }), {});
});

test('projection completion and retry scheduling each reuse one transactional document read', async () => {
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
    assert.equal(documentReadCount(calls), 2);
  }
});

test('projection transitions reread conflicts and preserve a concurrent terminal state', async () => {
  for (const available of [true, false]) {
    let reads = 0;
    const order = pendingOrder(7);
    const native = await nativeDeliveryContext(order, {
      observeBatchAfterCommit: ({ statements }) => {
        if (!statements.some(({ sql }) => sql.includes('document_json') && /\b(?:FROM|JOIN) commerce_documents\b/.test(sql))) return;
        reads += 1;
        if (reads !== 2) return;
        seedCommerceDocument(native.harness, {
          key: commerceKeys.deliveryOrder('card_nft_2', '7'),
          data: { ...order, packStatusProjectionState: 'failed', packStatusProjectionLastErrorCode: 'manual-review' },
          version: 2,
        });
      },
    });
    if (available) native.context.dataDb = projectionDataDb().db;
    await projectPendingDeliveryPackStatus({
      context: native.context,
      deliveryId: 7,
      dropId: 'card_nft_2',
      nowMs: () => READY_NOTIFICATION_NOW_MS,
      log: () => {},
    });
    assert.equal(reads, 3);
    const stored = await readCommerceRecord(native.context, commerceKeys.deliveryOrder('card_nft_2', '7'));
    assert.equal(stored?.data.packStatusProjectionState, 'failed');
    assert.equal(stored?.data.packStatusProjectionLastErrorCode, 'manual-review');
    assert.equal(stored?.data.packStatusProjectionFailureCount, 0);
  }
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
  }
  const projection = projectionDataDb();
  assert.equal(await reconcilePendingDeliveryPackStatusProjections(
    { COMMERCE_DB: harness.db, DATA_DB: projection.db },
    new AbortController().signal,
    { dropIds: ['card_nft_2'], nowMs: () => READY_NOTIFICATION_NOW_MS, log: () => {} },
  ), 3);
  const context = { repository: new D1CommerceRepository(harness.db), nowMs: READY_NOTIFICATION_NOW_MS, signal: new AbortController().signal };
  const invalid = await readCommerceRecord(context, commerceKeys.deliveryOrder('card_nft_2', '1'));
  assert.equal(invalid?.data.packStatusProjectionState, 'failed');
  assert.equal(invalid?.data.packStatusProjectionLastErrorCode, 'invalid-order-identity');
  assert.equal((await readCommerceRecord(context, commerceKeys.deliveryOrder('card_nft_2', '5')))?.data.packStatusProjectionState, 'pending');
  assert.equal(projection.applied, 3);
});
