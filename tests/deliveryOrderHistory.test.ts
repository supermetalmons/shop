import assert from 'node:assert/strict';
import test from 'node:test';
import {
  STRIPE_OWNER_MERGE_BATCH_SIZE,
  StripeOwnerMergeSessionChangedError,
  StripeOwnerMergeUnexpectedPathError,
  classifyStripeOwnerMergeError,
  mergeFirebaseStripeDeliveryOrdersToWalletInDb,
} from '../functions/src/deliveryOrderHistory.ts';
import { stripeCheckoutOwnerId } from '../functions/src/stripeCheckout/contract.ts';

const OWNER_ONE = '11111111111111111111111111111111';
const OWNER_TWO = 'So11111111111111111111111111111111111111112';

type FakeDeliveryDoc = {
  ref: { path: string; doc: FakeDeliveryDoc };
  data: Record<string, unknown>;
};

type FakeDbOptions = {
  sessionExists?: boolean;
  sessionWallet?: string;
  sessionExpiresAt?: number;
  rebindBeforeFirstCommitTo?: string;
  rebindAfterFirstCommitTo?: string;
  retryFirstCommit?: boolean;
};

function timestamp(millis: number) {
  return { toMillis: () => millis };
}

function fakeDeliveryDoc(path: string, data: Record<string, unknown>): FakeDeliveryDoc {
  const doc = { ref: null as unknown as FakeDeliveryDoc['ref'], data };
  doc.ref = { path, doc };
  return doc;
}

function firebaseOwnedDocs(uid: string, count: number): FakeDeliveryDoc[] {
  const firebaseOwner = stripeCheckoutOwnerId(uid);
  return Array.from({ length: count }, (_, index) =>
    fakeDeliveryDoc(`drops/drop/deliveryOrders/${index + 1}`, {
      owner: firebaseOwner,
      firebaseUid: uid,
      stripeCheckoutSessionId: `cs_test_${index + 1}`,
      source: 'stripe_offchain',
    }),
  );
}

function fakeDb(docs: FakeDeliveryDoc[], options: FakeDbOptions = {}) {
  let sessionExists = options.sessionExists !== false;
  let sessionData: Record<string, unknown> = {
    wallet: options.sessionWallet ?? OWNER_ONE,
    expiresAt: timestamp(options.sessionExpiresAt ?? Date.now() + 60_000),
  };
  let sessionVersion = 0;
  let attempts = 0;
  let probeReads = 0;
  let writeCommits = 0;
  let rebindPending = typeof options.rebindBeforeFirstCommitTo === 'string';
  let retryPending = options.retryFirstCommit === true;

  const db = {
    get attempts() {
      return attempts;
    },
    get writeCommits() {
      return writeCommits;
    },
    get probeReads() {
      return probeReads;
    },
    doc(path: string) {
      return { kind: 'session', path };
    },
    collectionGroup(collectionId: string) {
      assert.equal(collectionId, 'deliveryOrders');
      let ownerFilter = '';
      let limitCount = Number.POSITIVE_INFINITY;
      const query = {
        kind: 'query',
        where(field: string, op: string, value: string) {
          assert.equal(field, 'owner');
          assert.equal(op, '==');
          ownerFilter = value;
          return query;
        },
        limit(value: number) {
          limitCount = value;
          return query;
        },
        select() {
          return query;
        },
        snapshot() {
          const matched = docs.filter((doc) => doc.data.owner === ownerFilter).slice(0, limitCount);
          return { empty: matched.length === 0, size: matched.length, docs: matched };
        },
        async get() {
          probeReads += 1;
          return query.snapshot();
        },
      };
      return query;
    },
    async runTransaction(update: (tx: any) => Promise<number>) {
      for (;;) {
        attempts += 1;
        const readVersion = sessionVersion;
        const writes: Array<{ ref: FakeDeliveryDoc['ref']; data: Record<string, unknown> }> = [];
        let writesStarted = false;
        const result = await update({
          async get(target: any) {
            if (writesStarted) throw new Error('Transaction read occurred after a write');
            if (target.kind === 'session') {
              assert.match(target.path, /^authSessions\//);
              return {
                exists: sessionExists,
                data: () => sessionData,
              };
            }
            if (target.kind === 'query') return target.snapshot();
            throw new Error('Unexpected transaction read');
          },
          update(ref: FakeDeliveryDoc['ref'], data: Record<string, unknown>) {
            writesStarted = true;
            writes.push({ ref, data });
          },
        });

        if (rebindPending) {
          rebindPending = false;
          sessionExists = true;
          sessionData = {
            wallet: options.rebindBeforeFirstCommitTo,
            expiresAt: timestamp(Date.now() + 60_000),
          };
          sessionVersion += 1;
          continue;
        }
        if (retryPending) {
          retryPending = false;
          sessionVersion += 1;
          continue;
        }
        if (readVersion !== sessionVersion) continue;
        if (writes.length > 0) {
          writes.forEach(({ ref, data }) => Object.assign(ref.doc.data, data));
          writeCommits += 1;
          if (writeCommits === 1 && options.rebindAfterFirstCommitTo) {
            sessionData = {
              wallet: options.rebindAfterFirstCommitTo,
              expiresAt: timestamp(Date.now() + 60_000),
            };
            sessionVersion += 1;
          }
        }
        return result;
      }
    },
  };
  return db;
}

test('Stripe owner merge atomically reassigns the visible cohort and is idempotent', async () => {
  const uid = 'anon_uid_123';
  const firebaseOwner = stripeCheckoutOwnerId(uid);
  const docs = firebaseOwnedDocs(uid, 2);
  docs.push(
    fakeDeliveryDoc('drops/drop/deliveryOrders/wallet-owned', {
      owner: OWNER_ONE,
      firebaseUid: uid,
      stripeCheckoutSessionId: 'cs_test_wallet',
      source: 'stripe_offchain',
    }),
  );
  const db = fakeDb(docs);

  assert.equal(await mergeFirebaseStripeDeliveryOrdersToWalletInDb(db as any, uid, OWNER_ONE), 2);
  assert.equal(db.writeCommits, 1);
  for (const doc of docs.slice(0, 2)) {
    assert.equal(doc.data.owner, OWNER_ONE);
    assert.equal(doc.data.firebaseUid, uid);
    assert.equal(doc.data.source, 'stripe_offchain');
    assert.equal(doc.data.mergedFirebaseUid, uid);
    assert.equal(doc.data.previousOwner, firebaseOwner);
    assert.ok(doc.data.ownerMergedAt);
  }
  const firstMergedAt = docs[0].data.ownerMergedAt;

  assert.equal(await mergeFirebaseStripeDeliveryOrdersToWalletInDb(db as any, uid, OWNER_ONE), 0);
  assert.equal(db.probeReads, 2);
  assert.equal(db.attempts, 1);
  assert.equal(db.writeCommits, 1);
  assert.equal(docs[0].data.ownerMergedAt, firstMergedAt);
  assert.equal(docs[2].data.ownerMergedAt, undefined);
});

test('Stripe owner merge opens no transaction when the ownership probe is empty', async () => {
  const uid = 'anon_uid_empty';
  const db = fakeDb([], { sessionWallet: OWNER_TWO, sessionExpiresAt: 0 });

  assert.equal(await mergeFirebaseStripeDeliveryOrdersToWalletInDb(db as any, uid, OWNER_ONE), 0);
  assert.equal(db.probeReads, 1);
  assert.equal(db.attempts, 0);
  assert.equal(db.writeCommits, 0);
});

test('an order appearing after an empty Stripe probe is merged on the next attempt', async () => {
  const uid = 'anon_uid_late_order';
  const docs: FakeDeliveryDoc[] = [];
  const db = fakeDb(docs);
  assert.equal(await mergeFirebaseStripeDeliveryOrdersToWalletInDb(db as any, uid, OWNER_ONE), 0);
  docs.push(...firebaseOwnedDocs(uid, 1));
  assert.equal(await mergeFirebaseStripeDeliveryOrdersToWalletInDb(db as any, uid, OWNER_ONE), 1);
  assert.equal(docs[0].data.owner, OWNER_ONE);
  assert.equal(db.attempts, 1);
});

test('Stripe owner merge succeeds at the exact batch size', async () => {
  const uid = 'anon_uid_limit';
  const docs = firebaseOwnedDocs(uid, STRIPE_OWNER_MERGE_BATCH_SIZE);
  const db = fakeDb(docs);

  assert.equal(
    await mergeFirebaseStripeDeliveryOrdersToWalletInDb(db as any, uid, OWNER_ONE),
    STRIPE_OWNER_MERGE_BATCH_SIZE,
  );
  assert.equal(db.writeCommits, 1);
  assert.equal(db.attempts, 2);
  assert.ok(docs.every((doc) => doc.data.owner === OWNER_ONE));
});

test('Stripe owner merge continues across session-validated batches', async () => {
  const uid = 'anon_uid_over_limit';
  const docs = firebaseOwnedDocs(uid, STRIPE_OWNER_MERGE_BATCH_SIZE + 1);
  const db = fakeDb(docs);

  assert.equal(
    await mergeFirebaseStripeDeliveryOrdersToWalletInDb(db as any, uid, OWNER_ONE),
    STRIPE_OWNER_MERGE_BATCH_SIZE + 1,
  );
  assert.equal(db.writeCommits, 2);
  assert.equal(db.attempts, 2);
  assert.ok(docs.every((doc) => doc.data.owner === OWNER_ONE));
});

test('Stripe owner merge stops before a later batch after a session rebind', async () => {
  const uid = 'anon_uid_rebind_between_batches';
  const firebaseOwner = stripeCheckoutOwnerId(uid);
  const docs = firebaseOwnedDocs(uid, STRIPE_OWNER_MERGE_BATCH_SIZE + 1);
  const db = fakeDb(docs, { rebindAfterFirstCommitTo: OWNER_TWO });

  await assert.rejects(
    mergeFirebaseStripeDeliveryOrdersToWalletInDb(db as any, uid, OWNER_ONE),
    (err: unknown) => err instanceof StripeOwnerMergeSessionChangedError && err.reason === 'wallet_mismatch',
  );
  assert.equal(db.writeCommits, 1);
  assert.equal(db.attempts, 2);
  assert.ok(docs.slice(0, STRIPE_OWNER_MERGE_BATCH_SIZE).every((doc) => doc.data.owner === OWNER_ONE));
  assert.equal(docs.at(-1)?.data.owner, firebaseOwner);
});

test('Stripe owner merge rejects mismatched sessions and ignores legacy expiry', async () => {
  const uid = 'anon_uid_session';
  const docs = firebaseOwnedDocs(uid, 1);
  const mismatchedDb = fakeDb(docs, { sessionWallet: OWNER_TWO });
  await assert.rejects(
    mergeFirebaseStripeDeliveryOrdersToWalletInDb(mismatchedDb as any, uid, OWNER_ONE),
    (err: unknown) => err instanceof StripeOwnerMergeSessionChangedError && err.reason === 'wallet_mismatch',
  );
  assert.equal(mismatchedDb.writeCommits, 0);

  const expiredDb = fakeDb(docs, { sessionExpiresAt: Date.now() - 1 });
  assert.equal(await mergeFirebaseStripeDeliveryOrdersToWalletInDb(expiredDb as any, uid, OWNER_ONE), 1);
  assert.equal(expiredDb.writeCommits, 1);
});

test('Stripe owner merge preserves the absent-session legacy wallet UID fallback', async () => {
  const uid = OWNER_ONE;
  const docs = firebaseOwnedDocs(uid, 1);
  const db = fakeDb(docs, { sessionExists: false });

  assert.equal(await mergeFirebaseStripeDeliveryOrdersToWalletInDb(db as any, uid, OWNER_ONE), 1);
  assert.equal(docs[0].data.owner, OWNER_ONE);
});

test('Stripe owner merge cannot commit an old wallet after a session rebind', async () => {
  const uid = 'anon_uid_rebind';
  const firebaseOwner = stripeCheckoutOwnerId(uid);
  const docs = firebaseOwnedDocs(uid, 2);
  const db = fakeDb(docs, { rebindBeforeFirstCommitTo: OWNER_TWO });

  await assert.rejects(
    mergeFirebaseStripeDeliveryOrdersToWalletInDb(db as any, uid, OWNER_ONE),
    (err: unknown) => err instanceof StripeOwnerMergeSessionChangedError && err.reason === 'wallet_mismatch',
  );
  assert.equal(db.attempts, 2);
  assert.equal(db.writeCommits, 0);
  assert.ok(docs.every((doc) => doc.data.owner === firebaseOwner));
});

test('Stripe owner merge transaction retries do not double-count or partially apply', async () => {
  const uid = 'anon_uid_retry';
  const docs = firebaseOwnedDocs(uid, 3);
  const db = fakeDb(docs, { retryFirstCommit: true });

  assert.equal(await mergeFirebaseStripeDeliveryOrdersToWalletInDb(db as any, uid, OWNER_ONE), 3);
  assert.equal(db.attempts, 2);
  assert.equal(db.writeCommits, 1);
  assert.ok(docs.every((doc) => doc.data.owner === OWNER_ONE));
});

test('Stripe owner merge rejects unexpected collection-group paths without partial writes', async () => {
  const uid = 'anon_uid_path';
  const firebaseOwner = stripeCheckoutOwnerId(uid);
  const docs = firebaseOwnedDocs(uid, 1);
  docs.push(
    fakeDeliveryDoc('archives/drop/deliveryOrders/2', {
      owner: firebaseOwner,
      firebaseUid: uid,
      source: 'stripe_offchain',
    }),
  );
  const db = fakeDb(docs);

  await assert.rejects(
    mergeFirebaseStripeDeliveryOrdersToWalletInDb(db as any, uid, OWNER_ONE),
    (err: unknown) => err instanceof StripeOwnerMergeUnexpectedPathError,
  );
  assert.equal(db.writeCommits, 0);
  assert.ok(docs.every((doc) => doc.data.owner === firebaseOwner));
});

test('Stripe owner merge rejects noncanonical delivery document ids atomically', async () => {
  for (const documentId of ['0', '01']) {
    const uid = `anon_uid_path_${documentId}`;
    const firebaseOwner = stripeCheckoutOwnerId(uid);
    const docs = [
      fakeDeliveryDoc(`drops/drop/deliveryOrders/${documentId}`, {
        owner: firebaseOwner,
        firebaseUid: uid,
        source: 'stripe_offchain',
      }),
    ];
    const db = fakeDb(docs);
    await assert.rejects(
      mergeFirebaseStripeDeliveryOrdersToWalletInDb(db as any, uid, OWNER_ONE),
      StripeOwnerMergeUnexpectedPathError,
    );
    assert.equal(db.writeCommits, 0);
  }
});

test('Stripe merge error classification is pure and exhaustive for known failures', () => {
  assert.deepEqual(
    classifyStripeOwnerMergeError(new StripeOwnerMergeSessionChangedError('expired')),
    { kind: 'session_changed', reason: 'expired' },
  );
  assert.deepEqual(
    classifyStripeOwnerMergeError(new StripeOwnerMergeUnexpectedPathError('bad/path')),
    { kind: 'unexpected_path', path: 'bad/path' },
  );
  assert.deepEqual(classifyStripeOwnerMergeError(new Error('unknown')), { kind: 'unknown' });
});
