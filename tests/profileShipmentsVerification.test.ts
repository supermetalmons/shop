import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertUniqueProfileShipmentManifestId,
  parseProfileShipmentVerifierArgs,
  profileShipmentFingerprint,
  runProfileShipmentVerifierCli,
  verifyProfileShipments,
} from '../functions/scripts/verifyProfileShipments.ts';
import { profileShipmentDocumentId } from '../functions/src/profileShipments.ts';

const OWNER_ONE = '11111111111111111111111111111111';
const OWNER_TWO = 'So11111111111111111111111111111111111111112';

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

function createState(params: {
  sources: Record<string, any>;
  destinations?: Record<string, any>;
  unexpectedSources?: Record<string, any>;
  unexpectedDestinations?: Record<string, any>;
}) {
  const state = {
    sources: new Map(Object.entries(params.sources)),
    unexpectedSources: new Map(Object.entries(params.unexpectedSources || {})),
    destinations: new Map(Object.entries(params.destinations || {})),
    unexpectedDestinations: new Map(Object.entries(params.unexpectedDestinations || {})),
    setDestination(path: string, data: any) {
      this.destinations.set(path, structuredClone(data));
    },
  };
  return state;
}

function fakeFirestore(params: {
  sources: Record<string, any>;
  destinations?: Record<string, any>;
  unexpectedSources?: Record<string, any>;
  unexpectedDestinations?: Record<string, any>;
  failReadOnlyAudits?: number[];
  afterReadOnlyQuery?: (
    info: { auditNumber: number; queryNumber: number; collectionGroup: string; cursorPath: string | null },
    state: ReturnType<typeof createState>,
  ) => void;
}) {
  const state = createState(params);
  const calls = {
    transactionOptions: [] as Array<{ readOnly?: boolean } | undefined>,
    readOnlyAudits: 0,
  };

  function snapshot(path: string, data: any) {
    return {
      id: path.split('/').at(-1) || '',
      ref: { path },
      exists: true,
      data: () => structuredClone(data),
    };
  }

  function snapshotState() {
    const clone = (values: Map<string, any>) => new Map(
      [...values.entries()].map(([path, value]) => [path, structuredClone(value)]),
    );
    return {
      sources: clone(state.sources),
      unexpectedSources: clone(state.unexpectedSources),
      destinations: clone(state.destinations),
      unexpectedDestinations: clone(state.unexpectedDestinations),
    };
  }

  function collectionGroup(name: string) {
    let pageSize = Number.POSITIVE_INFINITY;
    let cursorPath: string | null = null;
    const read = (readState: ReturnType<typeof snapshotState>) => {
      const values = name === 'deliveryOrders'
        ? [...readState.sources.entries(), ...readState.unexpectedSources.entries()]
        : name === 'shipments'
          ? [...readState.destinations.entries(), ...readState.unexpectedDestinations.entries()]
          : [];
      const docs = values
        .map(([path, data]) => snapshot(path, data))
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
    };
    return query;
  }

  const db = {
    collectionGroup,
    runTransaction: async (
      operation: (tx: any) => Promise<any>,
      options?: { readOnly?: boolean },
    ) => {
      calls.transactionOptions.push(options);
      assert.equal(options?.readOnly, true);
      calls.readOnlyAudits += 1;
      const auditNumber = calls.readOnlyAudits;
      if (params.failReadOnlyAudits?.includes(auditNumber)) {
        throw new Error(`read-only audit ${auditNumber} failed`);
      }
      const readState = snapshotState();
      let queryNumber = 0;
      return operation({
        get: async (target: any) => {
          const result = target.__read(readState);
          queryNumber += 1;
          params.afterReadOnlyQuery?.({
            auditNumber,
            queryNumber,
            collectionGroup: target.__collectionGroup,
            cursorPath: target.__cursorPath(),
          }, state);
          return result;
        },
      });
    },
  };
  return { db: db as any, state, calls };
}

function fakeCliRuntime(db: any, emulatorHost = '', deleteError?: Error) {
  type FakeApp = { name: string; options: { projectId?: string } };
  const calls = {
    initialized: [] as Array<{ options: { projectId: string }; name: string; app: FakeApp }>,
    firestoreApps: [] as FakeApp[],
    deleted: [] as FakeApp[],
    logs: [] as string[],
  };
  const runtime = {
    emulatorHost,
    getApps: () => [] as FakeApp[],
    initializeApp: (options: { projectId: string }, name: string) => {
      const app = { name, options };
      calls.initialized.push({ options, name, app });
      return app;
    },
    deleteApp: async (app: FakeApp) => {
      calls.deleted.push(app);
      if (deleteError) throw deleteError;
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

test('verifier CLI requires an explicit project and bounded audit ceiling', () => {
  assert.throws(() => parseProfileShipmentVerifierArgs([]), /--project is required/);
  assert.deepEqual(
    parseProfileShipmentVerifierArgs(['--project', 'mons-shop']),
    {
      projectId: 'mons-shop',
      allowEmulator: false,
      maxAuditDocuments: 20_000,
    },
  );
  assert.equal(
    parseProfileShipmentVerifierArgs([
      '--project', 'mons-shop',
      '--allow-emulator',
      '--max-audit-documents', '1234',
    ]).maxAuditDocuments,
    1_234,
  );
  assert.throws(
    () => parseProfileShipmentVerifierArgs(['--project', 'mons-shop', '--max-audit-documents', '0']),
    /Invalid value for --max-audit-documents/,
  );
  assert.throws(
    () => parseProfileShipmentVerifierArgs(['--project', 'mons-shop', '--max-audit-documents', '50001']),
    /Invalid value for --max-audit-documents/,
  );
  assert.throws(
    () => parseProfileShipmentVerifierArgs(['--project', 'mons-shop', '--apply']),
    /Unknown arg: --apply/,
  );
});

test('verifier CLI fails on drift and cleans up its named Admin app', async () => {
  const fake = fakeFirestore({
    sources: {
      [sourcePath(1)]: { owner: OWNER_ONE, status: 'processing', items: [] },
    },
  });
  const cli = fakeCliRuntime(fake.db);

  await assert.rejects(
    runProfileShipmentVerifierCli(['--project', 'mons-shop'], cli.runtime),
    /Profile shipment projection drift detected/,
  );
  assert.equal(cli.calls.initialized.length, 1);
  assert.equal(cli.calls.initialized[0].name, 'profile-shipment-verifier');
  assert.deepEqual(cli.calls.initialized[0].options, { projectId: 'mons-shop' });
  assert.deepEqual(cli.calls.firestoreApps, [cli.calls.initialized[0].app]);
  assert.deepEqual(cli.calls.deleted, [cli.calls.initialized[0].app]);
  assert.ok(cli.calls.logs.some((entry) => entry === 'No Firestore writes performed.'));
});

test('verifier CLI preserves its primary failure when Admin app cleanup also fails', async () => {
  const fake = fakeFirestore({
    sources: {
      [sourcePath(1)]: { owner: OWNER_ONE, status: 'processing', items: [] },
    },
  });
  const cli = fakeCliRuntime(fake.db, '', new Error('cleanup failed'));

  await assert.rejects(
    runProfileShipmentVerifierCli(['--project', 'mons-shop'], cli.runtime),
    /Profile shipment projection drift detected/,
  );
  assert.ok(cli.calls.logs.some((entry) => /cleanup also failed: cleanup failed/.test(entry)));
});

test('verifier CLI requires explicit emulator opt-in before initializing Admin', async () => {
  const fake = fakeFirestore({ sources: {} });
  const blocked = fakeCliRuntime(fake.db, '127.0.0.1:8080');

  await assert.rejects(
    runProfileShipmentVerifierCli(['--project', 'mons-shop'], blocked.runtime),
    /--allow-emulator/,
  );
  assert.equal(blocked.calls.initialized.length, 0);
  assert.equal(blocked.calls.firestoreApps.length, 0);

  const allowed = fakeCliRuntime(fake.db, '127.0.0.1:8080');
  const result = await runProfileShipmentVerifierCli(
    ['--project', 'mons-shop', '--allow-emulator'],
    allowed.runtime,
  );
  assert.equal(result.inSync, true);
  assert.equal(allowed.calls.initialized.length, 1);
  assert.equal(allowed.calls.deleted.length, 1);
});

test('shipment fingerprints ignore key order and detect nested or extra-field drift', () => {
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

test('manifest collision guard rejects one projection id for different sources', () => {
  const manifest = new Map([
    ['same-id', { sourcePath: sourcePath(1) }],
  ]);
  assert.throws(() => {
    assertUniqueProfileShipmentManifestId(manifest, {
      sourcePath: sourcePath(2),
      documentId: 'same-id',
    });
  }, /Profile shipment document id collision: same-id/);
  assert.doesNotThrow(() => {
    assertUniqueProfileShipmentManifestId(manifest, {
      sourcePath: sourcePath(1),
      documentId: 'same-id',
    });
  });
});

test('verification reports every destination drift category without writes', async () => {
  const fake = fakeFirestore({
    sources: {
      [sourcePath(1)]: { owner: OWNER_ONE, status: 'processing', items: [] },
      [sourcePath(2)]: { owner: OWNER_ONE, status: 'processing', items: [] },
      [sourcePath(3)]: { owner: OWNER_ONE, status: 'processing', items: [] },
      [sourcePath(4)]: { owner: OWNER_ONE, status: 'processing', items: [] },
      [sourcePath(5)]: { owner: OWNER_ONE, status: 'prepared', items: [] },
      [sourcePath(6)]: { owner: 'invalid-owner', status: 'processing', items: [] },
    },
    destinations: {
      [destinationPath(OWNER_TWO, 1)]: expectedData(1),
      [destinationPath(OWNER_ONE, 2)]: { ...expectedData(2), status: 'ready_to_ship' },
      [destinationPath(OWNER_ONE, 4)]: expectedData(4),
      [destinationPath(OWNER_ONE, 5)]: expectedData(5),
    },
    unexpectedSources: {
      'archives/card_nft_2/deliveryOrders/8': { owner: OWNER_ONE, status: 'processing', items: [] },
    },
    unexpectedDestinations: {
      'archives/owner/shipments/unrelated': { private: true },
    },
  });
  const before = structuredClone([...fake.state.destinations.entries()]);
  const result = await verifyProfileShipments(fake.db, { pageSize: 1 });

  assert.equal(result.exactDestinations, 1);
  assert.equal(result.orphanDestinations, 1);
  assert.equal(result.wrongOwnerDestinations, 1);
  assert.equal(result.mismatchedDestinations, 1);
  assert.equal(result.missingDestinations, 2);
  assert.equal(result.invalidSources, 1);
  assert.equal(result.unexpectedSourcePaths, 1);
  assert.equal(result.unexpectedDestinationPaths, 1);
  assert.equal(result.inSync, false);
  assert.deepEqual([...fake.state.destinations.entries()], before);
  assert.deepEqual(fake.calls.transactionOptions, [{ readOnly: true }]);
});

test('verification classifies malformed and deliberately excluded sources', async () => {
  const fake = fakeFirestore({
    sources: {
      [sourcePath(1)]: { owner: OWNER_ONE, status: 'ready_to_ship', dropId: 'different_drop', items: [] },
      [sourcePath(2)]: { owner: 'invalid-owner', status: 'processing', items: [] },
      [sourcePath(3)]: { owner: 'firebase:uid', source: 'stripe_offchain', status: 'ready_to_ship', items: [] },
      [sourcePath(4)]: { owner: 'invalid-owner', source: 'admin_irl_redeem', status: 'ready_to_ship', items: [] },
      [sourcePath(5)]: { owner: OWNER_ONE, status: 'processing', deliveryId: 6, items: [] },
      'drops/card_nft_2/deliveryOrders/0': { owner: OWNER_ONE, status: 'processing', items: [] },
      'drops/card_nft_2/deliveryOrders/01': { owner: OWNER_ONE, status: 'processing', items: [] },
      'drops/card_nft_2/deliveryOrders/07': { owner: OWNER_ONE, status: 'prepared', items: [] },
    },
  });

  const result = await verifyProfileShipments(fake.db, { pageSize: 2 });
  assert.equal(result.eligibleSources, 0);
  assert.equal(result.ineligibleSources, 8);
  assert.equal(result.invalidSources, 6);
  assert.equal(result.invalidSourceReasons.drop_id_mismatch, 1);
  assert.equal(result.invalidSourceReasons.invalid_owner, 1);
  assert.equal(result.invalidSourceReasons.delivery_id_mismatch, 1);
  assert.equal(result.invalidSourceReasons.invalid_delivery_id, 3);
  assert.equal(result.inSync, false);
});

test('verification reads sources and destinations from one snapshot', async () => {
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

  const first = await verifyProfileShipments(fake.db, { pageSize: 10 });
  const second = await verifyProfileShipments(fake.db, { pageSize: 10 });
  assert.equal(first.inSync, true);
  assert.equal(second.inSync, true);
  assert.deepEqual(fake.calls.transactionOptions, [{ readOnly: true }, { readOnly: true }]);
});

test('pagination sees a behind-cursor insertion only on the next verification', async () => {
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

  const first = await verifyProfileShipments(fake.db, { pageSize: 1 });
  const second = await verifyProfileShipments(fake.db, { pageSize: 1 });
  assert.equal(first.sourceDocumentsScanned, 2);
  assert.equal(first.destinationDocumentsScanned, 2);
  assert.equal(first.inSync, true);
  assert.equal(second.sourceDocumentsScanned, 3);
  assert.equal(second.destinationDocumentsScanned, 3);
  assert.equal(second.inSync, true);
});

test('verification fails closed when the combined audit ceiling is exceeded', async () => {
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
    verifyProfileShipments(fake.db, { maxAuditDocuments: 2, pageSize: 10 }),
    /exceeded --max-audit-documents=2/,
  );
  assert.deepEqual(fake.calls.transactionOptions, [{ readOnly: true }]);
});

test('clean verification reports exact parity', async () => {
  const fake = fakeFirestore({
    sources: {
      [sourcePath(1)]: { owner: OWNER_ONE, status: 'processing', items: [] },
    },
    destinations: {
      [destinationPath(OWNER_ONE, 1)]: expectedData(1),
    },
  });

  const result = await verifyProfileShipments(fake.db);
  assert.equal(result.sourceDocumentsScanned, 1);
  assert.equal(result.destinationDocumentsScanned, 1);
  assert.equal(result.exactDestinations, 1);
  assert.equal(result.inSync, true);
});
