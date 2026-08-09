import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertUniqueProfileShipmentManifestId,
  auditProfileShipments,
  backfillProfileShipments,
  formatErrorCauseChain,
  parseProfileShipmentBackfillArgs,
  profileShipmentFingerprint,
  runProfileShipmentBackfillCli,
} from '../functions/scripts/backfillProfileShipments.ts';
import { profileShipmentDocumentId } from '../functions/src/profileShipments.ts';

const OWNER_ONE = '11111111111111111111111111111111';
const OWNER_TWO = 'So11111111111111111111111111111111111111112';

type StoredDestination = {
  data: any;
  updateTime: { version: number; toMillis(): number };
};

function fakeFirestore(params: {
  sources: Record<string, any>;
  destinations?: Record<string, any>;
  unexpectedSources?: Record<string, any>;
  unexpectedDestinations?: Record<string, any>;
  destinationsWithoutUpdateTime?: string[];
  failReadOnlyAudits?: number[];
  failWriteTransactions?: number[];
  afterReadOnlyQuery?: (
    info: { auditNumber: number; queryNumber: number; collectionGroup: string; cursorPath: string | null },
    state: ReturnType<typeof createState>,
  ) => void;
  conditionalDelete?: (
    path: string,
    state: ReturnType<typeof createState>,
    performDefault: () => Promise<void>,
  ) => Promise<void>;
  beforeFirstConditionalDelete?: (state: ReturnType<typeof createState>) => void;
}) {
  const state = createState(params);
  let firstConditionalDelete = true;
  const calls = {
    transactionOptions: [] as Array<{ readOnly?: boolean } | undefined>,
    readOnlyAudits: 0,
    writeTransactions: 0,
    writeAttempts: 0,
  };

  function snapshot(path: string, data: any, updateTime?: StoredDestination['updateTime']) {
    return {
      id: path.split('/').at(-1) || '',
      ref: { path },
      exists: true,
      data: () => structuredClone(data),
      ...(updateTime ? { updateTime } : {}),
    };
  }

  function missingSnapshot(path: string) {
    return {
      id: path.split('/').at(-1) || '',
      ref: { path },
      exists: false,
      data: () => undefined,
    };
  }

  function snapshotState() {
    const cloneValues = (values: Map<string, any>) => new Map(
      [...values.entries()].map(([path, value]) => [path, structuredClone(value)]),
    );
    const cloneDestinations = (values: Map<string, StoredDestination>) => new Map(
      [...values.entries()].map(([path, stored]) => [path, {
        data: structuredClone(stored.data),
        updateTime: stored.updateTime,
      }]),
    );
    return {
      sources: cloneValues(state.sources),
      unexpectedSources: cloneValues(state.unexpectedSources),
      destinations: cloneDestinations(state.destinations),
      unexpectedDestinations: cloneDestinations(state.unexpectedDestinations),
    };
  }

  function collectionGroup(name: string) {
    let pageSize = Number.POSITIVE_INFINITY;
    let cursorPath: string | null = null;
    const read = (readState: ReturnType<typeof snapshotState>) => {
      const entries = name === 'deliveryOrders'
        ? [...readState.sources.entries(), ...readState.unexpectedSources.entries()]
          .map(([path, data]) => snapshot(path, data))
        : name === 'shipments'
          ? [...readState.destinations.entries(), ...readState.unexpectedDestinations.entries()]
            .map(([path, stored]) => snapshot(
              path,
              stored.data,
              params.destinationsWithoutUpdateTime?.includes(path) ? undefined : stored.updateTime,
            ))
          : [];
      const docs = entries
        .filter((doc) => cursorPath == null || doc.ref.path > cursorPath)
        .sort((left, right) => left.ref.path.localeCompare(right.ref.path))
        .slice(0, pageSize);
      return { docs };
    };
    const query: any = {
      __read: read,
      __collectionGroup: name,
      __cursorPath: () => cursorPath,
      orderBy: () => query,
      select: () => query,
      limit: (value: number) => {
        pageSize = value;
        return query;
      },
      startAfter: (value: string) => {
        cursorPath = value;
        return query;
      },
      get: async () => read(snapshotState()),
    };
    return query;
  }

  function doc(path: string) {
    return {
      path,
      id: path.split('/').at(-1) || '',
      delete: async (precondition: { lastUpdateTime: StoredDestination['updateTime'] }) => {
        calls.writeAttempts += 1;
        if (firstConditionalDelete) {
          firstConditionalDelete = false;
          params.beforeFirstConditionalDelete?.(state);
        }
        const performDefault = async () => {
          const stored = state.destinations.get(path);
          if (!stored) throw Object.assign(new Error('not found'), { code: 5 });
          if (stored.updateTime !== precondition.lastUpdateTime) {
            throw Object.assign(new Error('failed precondition'), { code: 9 });
          }
          state.destinations.delete(path);
        };
        if (params.conditionalDelete) {
          await params.conditionalDelete(path, state, performDefault);
          return;
        }
        await performDefault();
      },
    };
  }

  const db = {
    collectionGroup,
    doc,
    runTransaction: async (
      operation: (tx: any) => Promise<any>,
      options?: { readOnly?: boolean },
    ) => {
      calls.transactionOptions.push(options);
      if (options?.readOnly) {
        calls.readOnlyAudits += 1;
        const auditNumber = calls.readOnlyAudits;
        if (params.failReadOnlyAudits?.includes(auditNumber)) {
          throw new Error(`read-only audit ${auditNumber} failed`);
        }
        const readState = snapshotState();
        let queryNumber = 0;
        return operation({
          get: async (target: any) => {
            if (typeof target.__read === 'function') {
              const result = target.__read(readState);
              queryNumber += 1;
              params.afterReadOnlyQuery?.({
                auditNumber,
                queryNumber,
                collectionGroup: target.__collectionGroup,
                cursorPath: target.__cursorPath(),
              }, state);
              return result;
            }
            if (readState.sources.has(target.path)) {
              return snapshot(target.path, readState.sources.get(target.path));
            }
            const destination = readState.destinations.get(target.path);
            return destination
              ? snapshot(target.path, destination.data, destination.updateTime)
              : missingSnapshot(target.path);
          },
          set: () => {
            throw new Error('read-only transaction attempted a write');
          },
          delete: () => {
            throw new Error('read-only transaction attempted a write');
          },
        });
      }
      calls.writeTransactions += 1;
      if (params.failWriteTransactions?.includes(calls.writeTransactions)) {
        throw new Error(`write transaction ${calls.writeTransactions} failed`);
      }
      const writes: Array<{ kind: 'set' | 'delete'; path: string; data?: any }> = [];
      const result = await operation({
        get: async (target: any) => {
          if (typeof target.__read === 'function') return target.__read(snapshotState());
          if (state.sources.has(target.path)) return snapshot(target.path, state.sources.get(target.path));
          const destination = state.destinations.get(target.path);
          return destination
            ? snapshot(target.path, destination.data, destination.updateTime)
            : missingSnapshot(target.path);
        },
        getAll: async (...refs: Array<{ path: string }>) =>
          refs.map((ref) => {
            const destination = state.destinations.get(ref.path);
            return destination
              ? snapshot(ref.path, destination.data, destination.updateTime)
              : missingSnapshot(ref.path);
          }),
        set: (ref: { path: string }, data: any) => writes.push({ kind: 'set', path: ref.path, data }),
        delete: (ref: { path: string }) => writes.push({ kind: 'delete', path: ref.path }),
      });
      for (const write of writes) {
        calls.writeAttempts += 1;
        if (write.kind === 'delete') state.destinations.delete(write.path);
        else state.setDestination(write.path, write.data);
      }
      return result;
    },
  };
  return { db: db as any, state, calls };
}

function createState(params: {
  sources: Record<string, any>;
  destinations?: Record<string, any>;
  unexpectedSources?: Record<string, any>;
  unexpectedDestinations?: Record<string, any>;
}) {
  let version = 0;
  const destination = (data: any): StoredDestination => ({
    data: structuredClone(data),
    updateTime: { version: ++version, toMillis: () => version },
  });
  const state = {
    sources: new Map(Object.entries(params.sources)),
    unexpectedSources: new Map(Object.entries(params.unexpectedSources || {})),
    destinations: new Map(
      Object.entries(params.destinations || {}).map(([path, data]) => [path, destination(data)]),
    ),
    unexpectedDestinations: new Map(
      Object.entries(params.unexpectedDestinations || {}).map(([path, data]) => [path, destination(data)]),
    ),
    setDestination(path: string, data: any) {
      this.destinations.set(path, destination(data));
    },
  };
  return state;
}

function sourcePath(id: number): string {
  return `drops/card_nft_2/deliveryOrders/${id}`;
}

function destinationPath(owner: string, id: number): string {
  return `profiles/${owner}/shipments/${profileShipmentDocumentId(sourcePath(id))}`;
}

function expectedData(id: number, status = 'processing') {
  return {
    dropId: 'card_nft_2',
    deliveryId: id,
    status,
    items: [],
    sortAt: 0,
  };
}

function fakeCliRuntime(
  db: any,
  emulatorHost = '',
  options: { deleteError?: Error; maxAuditDocumentsEnv?: string } = {},
) {
  type FakeApp = { name: string; options: { projectId?: string } };
  const calls = {
    initialized: [] as Array<{ options: { projectId: string }; name: string; app: FakeApp }>,
    firestoreApps: [] as FakeApp[],
    deleted: [] as FakeApp[],
    logs: [] as string[],
  };
  const runtime = {
    emulatorHost,
    maxAuditDocumentsEnv: options.maxAuditDocumentsEnv,
    getApps: () => [] as FakeApp[],
    initializeApp: (options: { projectId: string }, name: string) => {
      const app = { name, options };
      calls.initialized.push({ options, name, app });
      return app;
    },
    deleteApp: async (app: FakeApp) => {
      calls.deleted.push(app);
      if (options.deleteError) throw options.deleteError;
    },
    getFirestore: (app: FakeApp) => {
      calls.firestoreApps.push(app);
      return db;
    },
    log: (value: string) => {
      calls.logs.push(value);
    },
  };
  return { runtime, calls };
}

test('backfill CLI requires an explicit project and apply confirmations', () => {
  assert.throws(() => parseProfileShipmentBackfillArgs([]), /--project is required/);
  assert.deepEqual(
    parseProfileShipmentBackfillArgs(['--project', 'mons-shop']),
    {
      projectId: 'mons-shop',
      apply: false,
      verify: false,
      confirmProject: null,
      confirmTriggerDeployed: false,
      allowEmulator: false,
      pageSize: 400,
      concurrency: 10,
      maxAuditDocuments: 20_000,
    },
  );
  assert.throws(
    () => parseProfileShipmentBackfillArgs(['--project', 'mons-shop', '--apply']),
    /--confirm-project/,
  );
  assert.throws(
    () => parseProfileShipmentBackfillArgs([
      '--project', 'mons-shop', '--apply', '--confirm-project', 'other-project', '--confirm-trigger-deployed',
    ]),
    /exactly match/,
  );
  assert.throws(
    () => parseProfileShipmentBackfillArgs([
      '--project', 'mons-shop', '--apply', '--confirm-project', 'mons-shop',
    ]),
    /--confirm-trigger-deployed/,
  );
  assert.equal(
    parseProfileShipmentBackfillArgs([
      '--project', 'mons-shop',
      '--apply',
      '--confirm-project', 'mons-shop',
      '--confirm-trigger-deployed',
      '--page-size', '25',
      '--concurrency', '4',
      '--max-audit-documents', '1234',
    ]).apply,
    true,
  );
  assert.throws(
    () => parseProfileShipmentBackfillArgs(['--project', 'mons-shop', '--max-audit-documents', '0']),
    /Invalid value for --max-audit-documents/,
  );
  assert.throws(
    () => parseProfileShipmentBackfillArgs(['--project', 'mons-shop', '--max-audit-documents', '50001']),
    /Invalid value for --max-audit-documents/,
  );
  assert.equal(
    parseProfileShipmentBackfillArgs(
      ['--project', 'mons-shop'],
      { maxAuditDocuments: '30000' },
    ).maxAuditDocuments,
    30_000,
  );
  assert.equal(
    parseProfileShipmentBackfillArgs(
      ['--project', 'mons-shop', '--max-audit-documents', '1234'],
      { maxAuditDocuments: '30000' },
    ).maxAuditDocuments,
    1_234,
  );
  assert.throws(
    () => parseProfileShipmentBackfillArgs(
      ['--project', 'mons-shop'],
      { maxAuditDocuments: '50001' },
    ),
    /PROFILE_SHIPMENTS_MAX_AUDIT_DOCUMENTS/,
  );
});

test('backfill CLI verify fails on drift and still cleans up its named Admin app', async () => {
  const fake = fakeFirestore({
    sources: {
      [sourcePath(1)]: { owner: OWNER_ONE, status: 'processing', items: [] },
    },
  });
  const cli = fakeCliRuntime(fake.db);

  await assert.rejects(
    runProfileShipmentBackfillCli(['--project', 'mons-shop', '--verify'], cli.runtime),
    /Profile shipment projection drift remains/,
  );
  assert.equal(cli.calls.initialized.length, 1);
  assert.deepEqual(cli.calls.deleted, [cli.calls.initialized[0].app]);
  assert.equal(fake.state.destinations.size, 0);
});

test('backfill CLI preserves the primary failure when Admin app cleanup also fails', async () => {
  const fake = fakeFirestore({
    sources: {
      [sourcePath(1)]: { owner: OWNER_ONE, status: 'processing', items: [] },
    },
  });
  const cli = fakeCliRuntime(fake.db, '', { deleteError: new Error('cleanup failed') });

  await assert.rejects(
    runProfileShipmentBackfillCli(['--project', 'mons-shop', '--verify'], cli.runtime),
    /Profile shipment projection drift remains/,
  );
  assert.equal(cli.calls.deleted.length, 1);
  assert.ok(cli.calls.logs.some((entry) => /cleanup also failed: cleanup failed/.test(entry)));
});

test('backfill CLI requires emulator opt-in before initializing any Admin app', async () => {
  const fake = fakeFirestore({ sources: {} });
  const blocked = fakeCliRuntime(fake.db, '127.0.0.1:8080');

  await assert.rejects(
    runProfileShipmentBackfillCli(['--project', 'mons-shop'], blocked.runtime),
    /--allow-emulator/,
  );
  assert.equal(blocked.calls.initialized.length, 0);
  assert.equal(blocked.calls.firestoreApps.length, 0);
  assert.equal(blocked.calls.deleted.length, 0);

  const allowed = fakeCliRuntime(fake.db, '127.0.0.1:8080');
  const result = await runProfileShipmentBackfillCli(
    ['--project', 'mons-shop', '--allow-emulator'],
    allowed.runtime,
  );
  assert.equal(result.inSync, true);
  assert.equal(allowed.calls.initialized.length, 1);
  assert.equal(allowed.calls.deleted.length, 1);
});

test('backfill CLI initializes the explicit project under its fixed name and cleans it up', async () => {
  const fake = fakeFirestore({ sources: {} });
  const cli = fakeCliRuntime(fake.db);

  await runProfileShipmentBackfillCli(['--project', 'mons-shop'], cli.runtime);

  assert.equal(cli.calls.initialized.length, 1);
  const initialized = cli.calls.initialized[0];
  assert.deepEqual(initialized.options, { projectId: 'mons-shop' });
  assert.equal(initialized.name, 'profile-shipment-backfill');
  assert.deepEqual(cli.calls.firestoreApps, [initialized.app]);
  assert.deepEqual(cli.calls.deleted, [initialized.app]);
  assert.match(cli.calls.logs[0], /"projectId":"mons-shop"/);
});

test('manifest collision guard aborts before later apply work can run', () => {
  const manifest = new Map([
    ['same-id', { sourcePath: sourcePath(1) }],
  ]);
  let writes = 0;

  assert.throws(() => {
    assertUniqueProfileShipmentManifestId(manifest, {
      sourcePath: sourcePath(2),
      documentId: 'same-id',
    });
    writes += 1;
  }, /Profile shipment document id collision: same-id/);
  assert.equal(writes, 0);
  assert.doesNotThrow(() => {
    assertUniqueProfileShipmentManifestId(manifest, {
      sourcePath: sourcePath(1),
      documentId: 'same-id',
    });
  });
});

test('shipment fingerprints ignore object key order but detect nested and extra-field drift', () => {
  const expected = {
    dropId: 'card_nft_2',
    deliveryId: 1,
    status: 'processing',
    items: [{ kind: 'box', refId: 4 }],
    sortAt: 10,
  };
  const reordered = {
    sortAt: 10,
    items: [{ refId: 4, kind: 'box' }],
    status: 'processing',
    deliveryId: 1,
    dropId: 'card_nft_2',
  };

  assert.equal(profileShipmentFingerprint(reordered), profileShipmentFingerprint(expected));
  assert.notEqual(
    profileShipmentFingerprint({ ...reordered, claimCode: 'must-not-survive' }),
    profileShipmentFingerprint(expected),
  );
  assert.notEqual(
    profileShipmentFingerprint({ ...reordered, items: [{ refId: 5, kind: 'box' }] }),
    profileShipmentFingerprint(expected),
  );
});

test('repair failures print their complete cause chain', () => {
  const root = new Error('write failed');
  const wrapped = new Error('writes may have committed', { cause: root });
  assert.equal(
    formatErrorCauseChain(wrapped),
    'writes may have committed\nCaused by: write failed',
  );
});

test('dry-run audits both sides without writing or touching unexpected paths', async () => {
  const fake = fakeFirestore({
    sources: {
      [sourcePath(1)]: { owner: OWNER_ONE, status: 'processing', items: [] },
      [sourcePath(2)]: { owner: OWNER_ONE, status: 'prepared', items: [] },
      [sourcePath(3)]: { owner: OWNER_ONE, status: 'ready_to_ship', items: [] },
    },
    destinations: {
      [destinationPath(OWNER_TWO, 1)]: expectedData(1),
      [destinationPath(OWNER_ONE, 2)]: expectedData(2),
    },
    unexpectedSources: {
      'archives/card_nft_2/deliveryOrders/8': { owner: OWNER_ONE, status: 'processing', items: [] },
    },
    unexpectedDestinations: {
      'archives/owner/shipments/unrelated': { private: true },
    },
  });
  const before = [...fake.state.destinations.entries()];
  const result = await backfillProfileShipments(fake.db, { apply: false, pageSize: 1, concurrency: 2 });

  assert.equal(result.dryRun, true);
  assert.equal(result.before.eligibleSources, 2);
  assert.equal(result.before.ineligibleSources, 1);
  assert.equal(result.before.invalidSources, 0);
  assert.equal(result.before.unexpectedSourcePaths, 1);
  assert.equal(result.before.wrongOwnerDestinations, 1);
  assert.equal(result.before.orphanDestinations, 1);
  assert.equal(result.before.missingDestinations, 2);
  assert.equal(result.before.unexpectedDestinationPaths, 1);
  assert.equal(result.inSync, false);
  assert.deepEqual([...fake.state.destinations.entries()], before);
  assert.equal(fake.state.unexpectedDestinations.size, 1);
});

test('audit and apply fail closed for malformed active shipment sources', async () => {
  const fake = fakeFirestore({
    sources: {
      [sourcePath(1)]: {
        owner: OWNER_ONE,
        status: 'ready_to_ship',
        dropId: 'different_drop',
        items: [],
      },
      [sourcePath(2)]: {
        owner: 'invalid-owner',
        status: 'processing',
        items: [],
      },
      [sourcePath(3)]: {
        owner: 'firebase:uid',
        source: 'stripe_offchain',
        status: 'ready_to_ship',
        items: [],
      },
      [sourcePath(4)]: {
        owner: 'invalid-owner',
        source: 'admin_irl_redeem',
        status: 'ready_to_ship',
        items: [],
      },
      [sourcePath(5)]: {
        owner: OWNER_ONE,
        status: 'processing',
        deliveryId: 6,
        items: [],
      },
      'drops/card_nft_2/deliveryOrders/0': {
        owner: OWNER_ONE,
        status: 'processing',
        items: [],
      },
      'drops/card_nft_2/deliveryOrders/01': {
        owner: OWNER_ONE,
        status: 'processing',
        items: [],
      },
      'drops/card_nft_2/deliveryOrders/07': {
        owner: OWNER_ONE,
        status: 'prepared',
        items: [],
      },
    },
  });

  const audit = await backfillProfileShipments(fake.db, { apply: false, pageSize: 2 });
  assert.equal(audit.before.eligibleSources, 0);
  assert.equal(audit.before.ineligibleSources, 8);
  assert.equal(audit.before.invalidSources, 6);
  assert.equal(audit.before.invalidSourceReasons.drop_id_mismatch, 1);
  assert.equal(audit.before.invalidSourceReasons.invalid_owner, 1);
  assert.equal(audit.before.invalidSourceReasons.delivery_id_mismatch, 1);
  assert.equal(audit.before.invalidSourceReasons.invalid_delivery_id, 3);
  assert.equal(audit.inSync, false);

  await assert.rejects(
    backfillProfileShipments(fake.db, { apply: true, pageSize: 2, concurrency: 1 }),
    /invalidSources=6/,
  );
  assert.equal(fake.calls.writeAttempts, 0);
});

test('audit reads sources and destinations from one read-only snapshot', async () => {
  let moved = false;
  const fake = fakeFirestore({
    sources: {
      [sourcePath(1)]: { owner: OWNER_ONE, status: 'processing', items: [] },
    },
    destinations: {
      [destinationPath(OWNER_ONE, 1)]: expectedData(1),
    },
    afterReadOnlyQuery: (info, state) => {
      if (moved || info.auditNumber !== 1 || info.collectionGroup !== 'deliveryOrders') return;
      moved = true;
      state.sources.set(sourcePath(1), { owner: OWNER_TWO, status: 'ready_to_ship', items: [] });
      state.destinations.delete(destinationPath(OWNER_ONE, 1));
      state.setDestination(destinationPath(OWNER_TWO, 1), expectedData(1, 'ready_to_ship'));
    },
  });

  const first = await auditProfileShipments(fake.db, 10);
  assert.equal(first.summary.inSync, true);
  assert.equal(
    first.expectedByDocumentId.get(profileShipmentDocumentId(sourcePath(1)))?.ownerWallet,
    OWNER_ONE,
  );

  const second = await auditProfileShipments(fake.db, 10);
  assert.equal(second.summary.inSync, true);
  assert.equal(
    second.expectedByDocumentId.get(profileShipmentDocumentId(sourcePath(1)))?.ownerWallet,
    OWNER_TWO,
  );
  assert.deepEqual(
    fake.calls.transactionOptions.filter((options) => options?.readOnly),
    [{ readOnly: true }, { readOnly: true }],
  );
});

test('a source inserted behind the page cursor appears only in the next audit', async () => {
  let inserted = false;
  const fake = fakeFirestore({
    sources: {
      [sourcePath(2)]: { owner: OWNER_ONE, status: 'processing', items: [] },
      [sourcePath(3)]: { owner: OWNER_ONE, status: 'processing', items: [] },
    },
    destinations: {
      [destinationPath(OWNER_ONE, 2)]: expectedData(2),
      [destinationPath(OWNER_ONE, 3)]: expectedData(3),
    },
    afterReadOnlyQuery: (info, state) => {
      if (inserted || info.auditNumber !== 1 || info.queryNumber !== 1) return;
      inserted = true;
      state.sources.set(sourcePath(1), { owner: OWNER_ONE, status: 'processing', items: [] });
      state.setDestination(destinationPath(OWNER_ONE, 1), expectedData(1));
    },
  });

  const first = await auditProfileShipments(fake.db, 1);
  assert.equal(first.summary.sourceDocumentsScanned, 2);
  assert.equal(first.summary.destinationDocumentsScanned, 2);
  assert.equal(first.summary.inSync, true);

  const second = await auditProfileShipments(fake.db, 1);
  assert.equal(second.summary.sourceDocumentsScanned, 3);
  assert.equal(second.summary.destinationDocumentsScanned, 3);
  assert.equal(second.summary.inSync, true);
});

test('apply performs no writes when its initial snapshot audit fails', async () => {
  const orphanPath = destinationPath(OWNER_ONE, 9);
  const fake = fakeFirestore({
    sources: {},
    destinations: { [orphanPath]: expectedData(9) },
    failReadOnlyAudits: [1],
  });

  await assert.rejects(
    backfillProfileShipments(fake.db, { apply: true, pageSize: 10, concurrency: 1 }),
    /read-only audit 1 failed/,
  );
  assert.equal(fake.calls.writeAttempts, 0);
  assert.equal(fake.state.destinations.has(orphanPath), true);
  assert.deepEqual(fake.calls.transactionOptions, [{ readOnly: true }]);
});

test('audit document budget exhaustion fails before any repair writes', async () => {
  const fake = fakeFirestore({
    sources: {
      [sourcePath(1)]: { owner: OWNER_ONE, status: 'processing', items: [] },
      [sourcePath(2)]: { owner: OWNER_ONE, status: 'processing', items: [] },
    },
    destinations: {
      [destinationPath(OWNER_ONE, 1)]: expectedData(1),
    },
  });

  await assert.rejects(
    backfillProfileShipments(fake.db, {
      apply: true,
      pageSize: 10,
      concurrency: 1,
      maxAuditDocuments: 2,
    }),
    /exceeded --max-audit-documents=2/,
  );
  assert.equal(fake.calls.writeAttempts, 0);
  assert.equal(fake.calls.writeTransactions, 0);
});

test('post-apply audit failures require an explicit follow-up verification', async () => {
  const fake = fakeFirestore({
    sources: {
      [sourcePath(1)]: { owner: OWNER_ONE, status: 'processing', items: [] },
    },
    failReadOnlyAudits: [2],
  });

  await assert.rejects(
    backfillProfileShipments(fake.db, { apply: true, pageSize: 10, concurrency: 1 }),
    /writes may have committed.*rerun with --verify/,
  );
  assert.equal(fake.state.destinations.has(destinationPath(OWNER_ONE, 1)), true);
  assert.ok(fake.calls.writeAttempts > 0);
  assert.deepEqual(
    fake.calls.transactionOptions.filter((options) => options?.readOnly),
    [{ readOnly: true }, { readOnly: true }],
  );
});

test('a later conditional-delete failure reports that writes may have committed', async () => {
  const paths = [
    destinationPath(OWNER_ONE, 7),
    destinationPath(OWNER_ONE, 8),
  ].sort();
  const fake = fakeFirestore({
    sources: {},
    destinations: {
      [paths[0]]: expectedData(7),
      [paths[1]]: expectedData(8),
    },
    conditionalDelete: async (path, _state, performDefault) => {
      if (path === paths[1]) throw new Error('later conditional delete failed');
      await performDefault();
    },
  });

  await assert.rejects(
    backfillProfileShipments(fake.db, { apply: true, pageSize: 10, concurrency: 1 }),
    (error: Error & { cause?: unknown }) => {
      assert.match(error.message, /writes may have committed.*rerun with --verify/);
      assert.match((error.cause as Error).message, /later conditional delete failed/);
      return true;
    },
  );
  assert.equal(fake.state.destinations.has(paths[0]), false);
  assert.equal(fake.state.destinations.has(paths[1]), true);
});

test('a later source-reconciliation failure reports that writes may have committed', async () => {
  const fake = fakeFirestore({
    sources: {
      [sourcePath(1)]: { owner: OWNER_ONE, status: 'processing', items: [] },
      [sourcePath(2)]: { owner: OWNER_ONE, status: 'processing', items: [] },
    },
    failWriteTransactions: [2],
  });

  await assert.rejects(
    backfillProfileShipments(fake.db, { apply: true, pageSize: 10, concurrency: 1 }),
    (error: Error & { cause?: unknown }) => {
      assert.match(error.message, /writes may have committed.*rerun with --verify/);
      assert.match((error.cause as Error).message, /write transaction 2 failed/);
      return true;
    },
  );
  assert.equal(fake.state.destinations.has(destinationPath(OWNER_ONE, 1)), true);
  assert.equal(fake.state.destinations.has(destinationPath(OWNER_ONE, 2)), false);
});

test('a failed concurrent delete drains its started sibling before CLI cleanup', async () => {
  const paths = [
    destinationPath(OWNER_ONE, 7),
    destinationPath(OWNER_ONE, 8),
    destinationPath(OWNER_ONE, 9),
  ].sort();
  let releaseSibling!: () => void;
  let markSiblingStarted!: () => void;
  const siblingGate = new Promise<void>((resolve) => {
    releaseSibling = resolve;
  });
  const siblingStarted = new Promise<void>((resolve) => {
    markSiblingStarted = resolve;
  });
  const started: string[] = [];
  const fake = fakeFirestore({
    sources: {},
    destinations: {
      [paths[0]]: expectedData(7),
      [paths[1]]: expectedData(8),
      [paths[2]]: expectedData(9),
    },
    conditionalDelete: async (path, _state, performDefault) => {
      started.push(path);
      if (path === paths[0]) throw new Error('first concurrent delete failed');
      if (path === paths[1]) {
        markSiblingStarted();
        await siblingGate;
      }
      await performDefault();
    },
  });
  const cli = fakeCliRuntime(fake.db);
  const operation = runProfileShipmentBackfillCli([
    '--project', 'mons-shop',
    '--apply',
    '--confirm-project', 'mons-shop',
    '--confirm-trigger-deployed',
    '--concurrency', '2',
  ], cli.runtime);
  const rejection = assert.rejects(operation, /writes may have committed.*rerun with --verify/);

  await siblingStarted;
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(started, paths.slice(0, 2));
  assert.equal(cli.calls.deleted.length, 0);

  releaseSibling();
  await rejection;
  assert.deepEqual(started, paths.slice(0, 2));
  assert.equal(cli.calls.deleted.length, 1);
  assert.equal(fake.state.destinations.has(paths[2]), true);
});

test('unexpected paths make verify fail and apply abort before writes', async () => {
  const fake = fakeFirestore({
    sources: {},
    unexpectedSources: {
      'archives/card_nft_2/deliveryOrders/8': { owner: OWNER_ONE, status: 'processing', items: [] },
    },
    unexpectedDestinations: {
      'archives/owner/shipments/unrelated': { private: true },
    },
  });

  const audit = await backfillProfileShipments(fake.db, { apply: false, pageSize: 10 });
  assert.equal(audit.before.unexpectedSourcePaths, 1);
  assert.equal(audit.before.unexpectedDestinationPaths, 1);
  assert.equal(audit.inSync, false);

  await assert.rejects(
    backfillProfileShipments(fake.db, { apply: true, pageSize: 10, concurrency: 1 }),
    /invalidSources=0 .*unexpectedSourcePaths=1 unexpectedDestinationPaths=1 deletePreconditionsMissing=0/,
  );
  assert.equal(fake.calls.writeAttempts, 0);
  assert.equal(fake.state.unexpectedSources.size, 1);
  assert.equal(fake.state.unexpectedDestinations.size, 1);
});

test('apply refuses stale destinations without a safe delete precondition', async () => {
  const orphanPath = destinationPath(OWNER_ONE, 9);
  const fake = fakeFirestore({
    sources: {},
    destinations: { [orphanPath]: expectedData(9) },
    destinationsWithoutUpdateTime: [orphanPath],
  });

  const audit = await auditProfileShipments(fake.db, 10);
  assert.equal(audit.summary.deletePreconditionsMissing, 1);
  assert.equal(audit.summary.inSync, false);
  await assert.rejects(
    backfillProfileShipments(fake.db, { apply: true, pageSize: 10, concurrency: 1 }),
    /deletePreconditionsMissing=1/,
  );
  assert.equal(fake.calls.writeAttempts, 0);
  assert.equal(fake.state.destinations.has(orphanPath), true);
});

test('apply removes stale owners, replaces mismatches, creates missing summaries, and verifies parity', async () => {
  const fake = fakeFirestore({
    sources: {
      [sourcePath(1)]: { owner: OWNER_ONE, status: 'processing', items: [] },
      [sourcePath(2)]: { owner: OWNER_ONE, status: 'prepared', items: [] },
      [sourcePath(3)]: { owner: OWNER_ONE, status: 'ready_to_ship', items: [] },
      [sourcePath(4)]: { owner: OWNER_ONE, status: 'processing', items: [] },
    },
    destinations: {
      [destinationPath(OWNER_TWO, 1)]: expectedData(1),
      [destinationPath(OWNER_ONE, 2)]: expectedData(2),
      [destinationPath(OWNER_ONE, 4)]: { ...expectedData(4), claimCode: 'must-be-removed' },
    },
  });
  const result = await backfillProfileShipments(fake.db, { apply: true, pageSize: 2, concurrency: 2 });

  assert.equal(result.inSync, true);
  assert.equal(result.applied?.conditionalDeletesSucceeded, 2);
  assert.equal(fake.state.destinations.has(destinationPath(OWNER_TWO, 1)), false);
  assert.deepEqual(fake.state.destinations.get(destinationPath(OWNER_ONE, 1))?.data, expectedData(1));
  assert.deepEqual(fake.state.destinations.get(destinationPath(OWNER_ONE, 3))?.data, expectedData(3, 'ready_to_ship'));
  assert.deepEqual(fake.state.destinations.get(destinationPath(OWNER_ONE, 4))?.data, expectedData(4));
  assert.equal(result.after?.inSync, true);

  const secondApply = await backfillProfileShipments(fake.db, { apply: true, pageSize: 2, concurrency: 2 });
  const readOnlyAuditsBeforeCleanApply = fake.calls.readOnlyAudits;
  const writeTransactionsBeforeCleanApply = fake.calls.writeTransactions;
  const cleanApply = await backfillProfileShipments(fake.db, { apply: true, pageSize: 2, concurrency: 2 });
  assert.equal(fake.calls.readOnlyAudits, readOnlyAuditsBeforeCleanApply + 1);
  assert.equal(fake.calls.writeTransactions, writeTransactionsBeforeCleanApply);
  assert.equal(cleanApply.after, cleanApply.before);
  assert.deepEqual(cleanApply.applied, {
    conditionalDeletesPlanned: 0,
    conditionalDeletesSucceeded: 0,
    conditionalDeleteConflicts: 0,
    sourceDocumentsScanned: 0,
    sourceTransactions: 0,
    projectionUpserts: 0,
    baselineDeletes: 0,
  });
  assert.equal(secondApply.before.inSync, true);
  assert.equal(secondApply.applied?.conditionalDeletesSucceeded, 0);
  assert.equal(secondApply.applied?.projectionUpserts, 0);
  assert.equal(secondApply.applied?.baselineDeletes, 0);
  assert.equal(secondApply.inSync, true);
});

test('conditional cleanup never deletes a destination changed after audit', async () => {
  const orphanPath = destinationPath(OWNER_ONE, 9);
  const fake = fakeFirestore({
    sources: {},
    destinations: { [orphanPath]: expectedData(9) },
    beforeFirstConditionalDelete: (state) => {
      state.setDestination(orphanPath, { ...expectedData(9), status: 'changed-concurrently' });
    },
  });
  const result = await backfillProfileShipments(fake.db, { apply: true, pageSize: 10, concurrency: 1 });

  assert.equal(result.applied?.conditionalDeleteConflicts, 1);
  assert.equal(fake.state.destinations.has(orphanPath), true);
  assert.equal(result.inSync, false);
  assert.equal(result.after?.orphanDestinations, 1);
});

test('final source reconciliation converges an owner move that races cleanup', async () => {
  const stalePath = destinationPath(OWNER_ONE, 9);
  const fake = fakeFirestore({
    sources: {
      [sourcePath(1)]: { owner: OWNER_ONE, status: 'processing', items: [] },
    },
    destinations: {
      [destinationPath(OWNER_ONE, 1)]: expectedData(1),
      [stalePath]: expectedData(9),
    },
    beforeFirstConditionalDelete: (state) => {
      state.sources.set(sourcePath(1), { owner: OWNER_TWO, status: 'ready_to_ship', items: [] });
      state.destinations.delete(destinationPath(OWNER_ONE, 1));
      state.setDestination(destinationPath(OWNER_TWO, 1), expectedData(1, 'ready_to_ship'));
    },
  });
  const result = await backfillProfileShipments(fake.db, { apply: true, pageSize: 10, concurrency: 1 });

  assert.equal(result.inSync, true);
  assert.equal(fake.state.destinations.has(destinationPath(OWNER_ONE, 1)), false);
  assert.deepEqual(
    fake.state.destinations.get(destinationPath(OWNER_TWO, 1))?.data,
    expectedData(1, 'ready_to_ship'),
  );
});

test('an audited source deleted during cleanup has its baseline summary removed transactionally', async () => {
  const stalePath = destinationPath(OWNER_ONE, 9);
  const fake = fakeFirestore({
    sources: {
      [sourcePath(1)]: { owner: OWNER_ONE, status: 'processing', items: [] },
    },
    destinations: {
      [destinationPath(OWNER_ONE, 1)]: expectedData(1),
      [stalePath]: expectedData(9),
    },
    beforeFirstConditionalDelete: (state) => {
      state.sources.delete(sourcePath(1));
    },
  });
  const result = await backfillProfileShipments(fake.db, { apply: true, pageSize: 10, concurrency: 1 });

  assert.equal(result.inSync, true);
  assert.equal(fake.state.destinations.has(destinationPath(OWNER_ONE, 1)), false);
  assert.equal(result.applied?.baselineDeletes, 1);
});

test('a clean audit reports exact parity', async () => {
  const fake = fakeFirestore({
    sources: {
      [sourcePath(1)]: { owner: OWNER_ONE, status: 'processing', items: [] },
    },
    destinations: {
      [destinationPath(OWNER_ONE, 1)]: expectedData(1),
    },
  });
  const audit = await auditProfileShipments(fake.db, 10);
  assert.equal(audit.summary.inSync, true);
  assert.equal(audit.summary.exactDestinations, 1);
  assert.equal(audit.conditionalDeletes.length, 0);
});
