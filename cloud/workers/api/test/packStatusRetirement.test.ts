import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto';
import {
  chmodSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Timestamp } from '@google-cloud/firestore';
import {
  PACK_STATUS_SUPPORTED_DROP_IDS,
  type PackStatusCounters,
} from '../../../../shared/packStatus.ts';
import {
  isAllowedPackStatusRetirementDeletePath,
  isPackStatusRetirementReceipt,
  packStatusEventCollectionPath,
  packStatusRetirementWriterPublicKeySha256,
  packStatusSummaryDocumentPath,
  parsePackStatusRetirementArgs,
  readPackStatusRetirementFirestoreCredential,
  runPackStatusRetirement,
  verifyPackStatusRetirementApiVersion,
  verifyPackStatusRetirementCandidate,
  type PackStatusRetirementDependencies,
  type PackStatusRetirementD1Event,
  type PackStatusRetirementFirestore,
  type PackStatusRetirementReceipt,
} from '../../../../scripts/retire-pack-status-firestore.ts';
import type { D1IntegrityReport } from '../../../../scripts/migrate-pack-status-to-d1.ts';
import { firestoreWriterServiceAccountEmail } from '../../../../scripts/cloudflare-firestore-keychain.ts';

const supportedDropIds = [...PACK_STATUS_SUPPORTED_DROP_IDS].sort();

function writerCredentialJson(): string {
  const privateKey = generateKeyPairSync('rsa', { modulusLength: 2048 })
    .privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
  return JSON.stringify({
    client_email: firestoreWriterServiceAccountEmail,
    private_key: privateKey,
    project_id: 'mons-shop',
  });
}

function counters(dropId: string): PackStatusCounters {
  return {
    dropId,
    totalInitialSupply: 10,
    totalCards: 30,
    cardsPerPack: 3,
    unsealedOnline: 1,
    redeemedIrlNormal: 2,
    redeemedIrlStripe: 3,
    redeemedUnsealedCards: 4,
  };
}

function eventKey(index: number): string {
  return `event-${String(index).padStart(4, '0')}`;
}

function eventDocumentId(index: number): string {
  return `onlineReveal_${encodeURIComponent(eventKey(index))}`;
}

function eventData(dropId: string, index: number): Record<string, unknown> {
  return {
    createdAt: Timestamp.fromMillis(1_000 + index),
    dropId,
    eventKey: eventKey(index),
    increments: { unsealedOnline: 1 },
    quantity: 1,
    type: 'onlineReveal',
    version: 1,
  };
}

function canonicalEventPayload(dropId: string, index: number) {
  return {
    boxAssetId: null,
    checkoutSessionId: null,
    createdAtMs: 1_000 + index,
    deliveryId: null,
    dropId,
    eventKey: eventKey(index),
    increments: {
      unsealedOnline: 1,
      redeemedIrlNormal: 0,
      redeemedIrlStripe: 0,
      redeemedUnsealedCards: 0,
    },
    quantity: 1,
    signature: null,
    type: 'onlineReveal',
  };
}

function eventPayloadSha256(dropId: string, index: number): string {
  const { createdAtMs: _createdAtMs, ...semantic } = canonicalEventPayload(dropId, index);
  return createHash('sha256').update(JSON.stringify(semantic)).digest('hex');
}

function d1EventPayloadSha256(dropId: string, index: number): string {
  return createHash('sha256').update(JSON.stringify(canonicalEventPayload(dropId, index))).digest('hex');
}

function d1Report(eventCounts: Record<string, number>): D1IntegrityReport {
  const drops = supportedDropIds.map((dropId) => ({
    dropId,
    eventCount: eventCounts[dropId] || 0,
    historicalEventCount: eventCounts[dropId] || 0,
    appliedEventCount: 0,
    counters: counters(dropId),
  }));
  return {
    cacheGeneration: 7,
    drops,
    eventCount: drops.reduce((total, drop) => total + drop.eventCount, 0),
  };
}

function d1Events(eventCounts: Record<string, number>): PackStatusRetirementD1Event[] {
  return supportedDropIds.flatMap((dropId) => (
    Array.from({ length: eventCounts[dropId] || 0 }, (_value, index) => ({
      applyDelta: 0 as const,
      d1PayloadSha256: d1EventPayloadSha256(dropId, index),
      deltas: {
        unsealedOnline: 1,
        redeemedIrlNormal: 0,
        redeemedIrlStripe: 0,
        redeemedUnsealedCards: 0,
      },
      documentId: eventDocumentId(index),
      dropId,
      payloadSha256: eventPayloadSha256(dropId, index),
    }))
  ));
}

class MemoryFirestore implements PackStatusRetirementFirestore {
  readonly documents = new Map<string, Record<string, unknown>>();
  readonly deleteCalls: string[][] = [];
  readonly summaryUpdateTimes = new Map<string, string>();
  afterSummaryDelete: (() => void) | undefined;
  beforeSummaryDelete: (() => void) | undefined;
  failDeleteCall: number | undefined;
  listCalls = 0;
  onList: ((dropId: string, call: number) => void) | undefined;

  constructor(eventCounts: Record<string, number>) {
    for (const dropId of supportedDropIds) {
      this.documents.set(packStatusSummaryDocumentPath(dropId), {
        ...counters(dropId),
        version: 1,
      });
      this.summaryUpdateTimes.set(
        packStatusSummaryDocumentPath(dropId),
        `${1_000 + supportedDropIds.indexOf(dropId)}:0`,
      );
      for (let index = 0; index < (eventCounts[dropId] || 0); index += 1) {
        const id = eventDocumentId(index);
        this.documents.set(`${packStatusEventCollectionPath(dropId)}/${id}`, eventData(dropId, index));
      }
    }
  }

  readSummary(dropId: string): { data: Record<string, unknown>; updateTime: string } | null {
    const path = packStatusSummaryDocumentPath(dropId);
    const data = this.documents.get(path);
    const updateTime = this.summaryUpdateTimes.get(path);
    return data && updateTime ? { data, updateTime } : null;
  }

  listEventDocuments(
    dropId: string,
    afterId: string | undefined,
    limit: number,
  ): Array<{ id: string; data: Record<string, unknown> }> {
    this.listCalls += 1;
    this.onList?.(dropId, this.listCalls);
    const prefix = `${packStatusEventCollectionPath(dropId)}/`;
    return [...this.documents.keys()]
      .filter((path) => path.startsWith(prefix))
      .map((path) => path.slice(prefix.length))
      .filter((id) => afterId === undefined || id > afterId)
      .sort()
      .slice(0, limit)
      .map((id) => ({ id, data: this.documents.get(`${prefix}${id}`)! }));
  }

  deleteEventDocumentPaths(paths: readonly string[]): void {
    this.deleteCalls.push([...paths]);
    if (this.failDeleteCall === this.deleteCalls.length) throw new Error('injected Firestore delete failure');
    for (const path of paths) this.documents.delete(path);
  }

  deleteSummaryDocuments(documents: readonly { path: string; updateTime: string }[]): void {
    this.beforeSummaryDelete?.();
    for (const document of documents) {
      if (
        !this.documents.has(document.path) ||
        this.summaryUpdateTimes.get(document.path) !== document.updateTime
      ) throw new Error('FAILED_PRECONDITION: summary updateTime changed');
    }
    this.deleteCalls.push(documents.map((document) => document.path));
    for (const document of documents) {
      this.documents.delete(document.path);
      this.summaryUpdateTimes.delete(document.path);
    }
    this.afterSummaryDelete?.();
  }
}

function makeDependencies(
  firestore: MemoryFirestore,
  report: D1IntegrityReport,
  eventCounts: Record<string, number>,
  initialReceipt?: PackStatusRetirementReceipt,
): PackStatusRetirementDependencies & {
  apiVerificationCalls: string[];
  bookmarkCalls: { value: number };
  receipt: { value: PackStatusRetirementReceipt | undefined };
  writes: Array<{
    expected: PackStatusRetirementReceipt | undefined;
    next: PackStatusRetirementReceipt;
  }>;
} {
  const bookmarkCalls = { value: 0 };
  const apiVerificationCalls: string[] = [];
  const receipt = { value: initialReceipt };
  const writes: Array<{
    expected: PackStatusRetirementReceipt | undefined;
    next: PackStatusRetirementReceipt;
  }> = [];
  let timestamp = Date.parse('2026-08-24T18:00:00.000Z');
  return {
    apiVerificationCalls,
    bookmarkCalls,
    currentD1Bookmark: () => {
      bookmarkCalls.value += 1;
      return '00000000-1111-2222-3333-444444444444';
    },
    firestore,
    log: () => undefined,
    now: () => {
      const value = new Date(timestamp);
      timestamp += 1_000;
      return value;
    },
    readD1Events: () => d1Events(eventCounts),
    readD1Integrity: () => report,
    readReceipt: () => receipt.value,
    receipt,
    verifyApiVersion: (apiVersionId) => {
      apiVerificationCalls.push(apiVersionId);
    },
    writeReceipt: (next, expected) => {
      assert.deepEqual(receipt.value, expected);
      writes.push({ next, expected });
      receipt.value = structuredClone(next);
    },
    writes,
  };
}

test('retirement CLI parsing requires one exact mode and confirmation phrase', () => {
  const versionId = randomUUID();
  assert.deepEqual(parsePackStatusRetirementArgs(['--dry-run']), { mode: 'dry-run' });
  assert.deepEqual(parsePackStatusRetirementArgs([
    '--dry-run',
    '--firestore-writer-service-account-file',
    '/tmp/writer.json',
  ]), {
    mode: 'dry-run',
    firestoreWriterServiceAccountFile: '/tmp/writer.json',
  });
  assert.deepEqual(parsePackStatusRetirementArgs([
    '--confirm',
    'RETIRE_FIRESTORE_PACK_STATUS',
    '--api-version-id',
    versionId.toUpperCase(),
  ]), { mode: 'confirm', apiVersionId: versionId });
  assert.deepEqual(parsePackStatusRetirementArgs([
    '--confirm',
    'RETIRE_FIRESTORE_PACK_STATUS',
    '--api-version-id',
    versionId,
    '--firestore-writer-service-account-file',
    '/tmp/writer.json',
  ]), {
    mode: 'confirm',
    apiVersionId: versionId,
    firestoreWriterServiceAccountFile: '/tmp/writer.json',
  });
  assert.throws(() => parsePackStatusRetirementArgs([]), /requires --confirm/);
  assert.throws(
    () => parsePackStatusRetirementArgs(['--confirm', 'wrong', '--api-version-id', versionId]),
    /RETIRE_FIRESTORE_PACK_STATUS/,
  );
  assert.throws(
    () => parsePackStatusRetirementArgs(['--confirm', 'RETIRE_FIRESTORE_PACK_STATUS']),
    /exact UUID/,
  );
  assert.throws(
    () => parsePackStatusRetirementArgs(['--dry-run', '--api-version-id', versionId]),
    /cannot be combined/,
  );
  assert.throws(
    () => parsePackStatusRetirementArgs(['--dry-run', '--drop-id', 'card_nft_2']),
    /Unknown argument/,
  );
  assert.throws(
    () => parsePackStatusRetirementArgs([
      '--dry-run',
      '--firestore-writer-service-account-file',
      'one.json',
      '--firestore-writer-service-account-file',
      'two.json',
    ]),
    /may only be provided once/,
  );
});

test('retirement credential source requires the exact private writer file or Keychain value', () => {
  const directory = mkdtempSync(join(tmpdir(), 'mons-shop-pack-status-retirement-credential-'));
  const credentialPath = join(directory, 'writer.json');
  const permissivePath = join(directory, 'permissive.json');
  const symlinkPath = join(directory, 'writer-link.json');
  const value = writerCredentialJson();
  try {
    writeFileSync(credentialPath, value, { encoding: 'utf8', mode: 0o600 });
    const fromFile = readPackStatusRetirementFirestoreCredential(
      credentialPath,
      () => assert.fail('file credential fell back to Keychain'),
    );
    assert.equal(fromFile.client_email, firestoreWriterServiceAccountEmail);
    assert.equal(fromFile.project_id, 'mons-shop');
    assert.match(fromFile.private_key, /BEGIN PRIVATE KEY/);
    assert.match(packStatusRetirementWriterPublicKeySha256(fromFile), /^[0-9a-f]{64}$/);

    let keychainAccount = '';
    const fromKeychain = readPackStatusRetirementFirestoreCredential(undefined, (account) => {
      keychainAccount = account;
      return value;
    });
    assert.equal(keychainAccount, firestoreWriterServiceAccountEmail);
    assert.equal(fromKeychain.private_key, fromFile.private_key);

    writeFileSync(permissivePath, value, { encoding: 'utf8', mode: 0o600 });
    chmodSync(permissivePath, 0o644);
    assert.throws(
      () => readPackStatusRetirementFirestoreCredential(permissivePath),
      /permissions/,
    );
    symlinkSync(credentialPath, symlinkPath);
    assert.throws(
      () => readPackStatusRetirementFirestoreCredential(symlinkPath),
      /non-symlink/,
    );
    const wrongCredential = JSON.stringify({
      ...JSON.parse(value),
      client_email: 'wrong@mons-shop.iam.gserviceaccount.com',
    });
    assert.throws(
      () => readPackStatusRetirementFirestoreCredential(undefined, () => wrongCredential),
      /reviewed service account/,
    );
  } finally {
    rmSync(directory, { recursive: true });
  }
});

test('retirement candidate binding requires fresh reviewed source, writer key, and published HEAD', () => {
  const apiVersionId = randomUUID();
  const writerHash = 'a'.repeat(64);
  const sourceCommit = '1'.repeat(40);
  const headCommit = '2'.repeat(40);
  const candidate = {
    directHeliusMedianMs: 20,
    firestoreWriterPublicKeySha256: writerHash,
    includeDevnet: true,
    previewUrl: `https://${apiVersionId.slice(0, 8)}-mons-shop-api.lil-org.workers.dev`,
    runs: 5,
    smokeOwner: 'A87Upx1f1whNV5P8xQCK2YUTwE3uMYigjoKJAF3jiNpz',
    sourceCommit,
    testedAt: new Date().toISOString(),
    versionId: apiVersionId,
    workerMedianMs: 10,
    workerName: 'mons-shop-api',
  } as const;
  const dependencies = {
    gitDiffPaths: () => ['cloud/release-manifest.json'],
    gitIsAncestor: () => true,
    readCandidate: () => candidate,
    readHeadCommit: () => headCommit,
    readRemoteMainCommit: () => headCommit,
    readWorktreePaths: () => ['cloud/pack-status-firestore-retirement.json'],
  };
  assert.equal(
    verifyPackStatusRetirementCandidate(apiVersionId, writerHash, dependencies),
    candidate,
  );
  assert.throws(
    () => verifyPackStatusRetirementCandidate(apiVersionId, 'b'.repeat(64), dependencies),
    /missing, stale, mismatched/,
  );
  assert.throws(
    () => verifyPackStatusRetirementCandidate(apiVersionId, writerHash, {
      ...dependencies,
      gitIsAncestor: () => false,
    }),
    /not an ancestor/,
  );
  assert.throws(
    () => verifyPackStatusRetirementCandidate(apiVersionId, writerHash, {
      ...dependencies,
      gitDiffPaths: () => ['scripts/retire-pack-status-firestore.ts'],
    }),
    /Tracked code changed/,
  );
  assert.throws(
    () => verifyPackStatusRetirementCandidate(apiVersionId, writerHash, {
      ...dependencies,
      readRemoteMainCommit: () => '3'.repeat(40),
    }),
    /not the exact published origin\/main/,
  );
  assert.throws(
    () => verifyPackStatusRetirementCandidate(apiVersionId, writerHash, {
      ...dependencies,
      readCandidate: () => ({
        ...candidate,
        testedAt: new Date(Date.now() - 7 * 60 * 60 * 1_000).toISOString(),
      }),
    }),
    /missing, stale, mismatched/,
  );
  assert.throws(
    () => verifyPackStatusRetirementCandidate(apiVersionId, writerHash, {
      ...dependencies,
      readCandidate: () => undefined,
    }),
    /missing, stale, mismatched/,
  );
});

test('retirement API verification binds manifest, evidence, live pair, and denied public rules', async () => {
  const apiVersionId = randomUUID();
  const writerPublicKeySha256 = 'a'.repeat(64);
  const currentProduction = {
    apiVersionId,
    frontendVersionId: randomUUID(),
  };
  const manifest = {
    schemaVersion: 2 as const,
    recordedAt: '2026-08-24T18:00:00.000Z',
    currentProduction,
    approvedRollback: { ...currentProduction },
  };
  const events: string[] = [];
  await verifyPackStatusRetirementApiVersion(apiVersionId, writerPublicKeySha256, {
    readManifest: () => {
      events.push('manifest');
      return manifest;
    },
    requireApiEvidence: (versionId) => {
      assert.equal(versionId, apiVersionId);
      events.push('evidence');
    },
    verifyCandidate: (versionId, writerHash) => {
      assert.equal(versionId, apiVersionId);
      assert.equal(writerHash, writerPublicKeySha256);
      events.push('candidate');
    },
    readLiveApiVersion: () => {
      events.push('live-api');
      return apiVersionId;
    },
    readLiveFrontendVersion: () => {
      events.push('live-frontend');
      return currentProduction.frontendVersionId;
    },
    verifyFirestoreRulesDenyPackStatus: () => {
      events.push('rules');
    },
  });
  assert.deepEqual(events, ['manifest', 'evidence', 'candidate', 'live-api', 'live-frontend', 'rules']);

  events.length = 0;
  await assert.rejects(
    verifyPackStatusRetirementApiVersion(randomUUID(), writerPublicKeySha256, {
      readManifest: () => {
        events.push('manifest');
        return manifest;
      },
      requireApiEvidence: () => events.push('evidence'),
      verifyCandidate: () => events.push('candidate'),
      readLiveApiVersion: () => {
        events.push('live-api');
        return apiVersionId;
      },
      readLiveFrontendVersion: () => currentProduction.frontendVersionId,
      verifyFirestoreRulesDenyPackStatus: () => undefined,
    }),
    /tracked current production API/,
  );
  assert.deepEqual(events, ['manifest']);

  events.length = 0;
  await assert.rejects(
    verifyPackStatusRetirementApiVersion(apiVersionId, writerPublicKeySha256, {
      readManifest: () => {
        events.push('manifest');
        return {
          ...manifest,
          approvedRollback: {
            apiVersionId: randomUUID(),
            frontendVersionId: randomUUID(),
          },
        };
      },
      requireApiEvidence: () => events.push('evidence'),
      verifyCandidate: () => events.push('candidate'),
      readLiveApiVersion: () => {
        events.push('live-api');
        return apiVersionId;
      },
      readLiveFrontendVersion: () => currentProduction.frontendVersionId,
      verifyFirestoreRulesDenyPackStatus: () => undefined,
    }),
    /approved recovery pair/,
  );
  assert.deepEqual(events, ['manifest']);

  await assert.rejects(
    verifyPackStatusRetirementApiVersion(apiVersionId, writerPublicKeySha256, {
      readManifest: () => manifest,
      requireApiEvidence: () => {
        throw new Error('missing production evidence');
      },
      readLiveApiVersion: () => assert.fail('missing evidence reached live lookup'),
      readLiveFrontendVersion: () => assert.fail('missing evidence reached frontend lookup'),
      verifyCandidate: () => assert.fail('missing evidence reached candidate lookup'),
      verifyFirestoreRulesDenyPackStatus: () => assert.fail('missing evidence reached rules check'),
    }),
    /missing production evidence/,
  );
  await assert.rejects(
    verifyPackStatusRetirementApiVersion(apiVersionId, writerPublicKeySha256, {
      readManifest: () => manifest,
      requireApiEvidence: () => undefined,
      verifyCandidate: () => undefined,
      readLiveApiVersion: () => randomUUID(),
      readLiveFrontendVersion: () => currentProduction.frontendVersionId,
      verifyFirestoreRulesDenyPackStatus: () => undefined,
    }),
    /Cloudflare reports API/,
  );
  await assert.rejects(
    verifyPackStatusRetirementApiVersion(apiVersionId, writerPublicKeySha256, {
      readManifest: () => manifest,
      requireApiEvidence: () => undefined,
      verifyCandidate: () => undefined,
      readLiveApiVersion: () => apiVersionId,
      readLiveFrontendVersion: () => randomUUID(),
      verifyFirestoreRulesDenyPackStatus: () => undefined,
    }),
    /Cloudflare reports frontend/,
  );
  await assert.rejects(
    verifyPackStatusRetirementApiVersion(apiVersionId, writerPublicKeySha256, {
      readManifest: () => manifest,
      requireApiEvidence: () => undefined,
      verifyCandidate: () => undefined,
      readLiveApiVersion: () => apiVersionId,
      readLiveFrontendVersion: () => currentProduction.frontendVersionId,
      verifyFirestoreRulesDenyPackStatus: () => {
        throw new Error('public pack status is still readable');
      },
    }),
    /still readable/,
  );
});

test('retirement deletion allowlist contains only supported event and summary documents', () => {
  for (const dropId of PACK_STATUS_SUPPORTED_DROP_IDS) {
    assert.equal(isAllowedPackStatusRetirementDeletePath(packStatusSummaryDocumentPath(dropId)), true);
    assert.equal(
      isAllowedPackStatusRetirementDeletePath(`${packStatusEventCollectionPath(dropId)}/event-id`),
      true,
    );
  }
  for (const path of [
    'drops/card_nft_2/meta/dudePool',
    'drops/card_nft_2/deliveryOrders/1',
    'drops/card_nft_2/packStatusEvents',
    'drops/card_nft_2/packStatusEvents/event/subcollection/doc',
    'drops/unsupported/meta/packStatus',
    'drops/unsupported/packStatusEvents/event-id',
    'profiles/owner',
  ]) assert.equal(isAllowedPackStatusRetirementDeletePath(path), false, path);
  assert.throws(() => packStatusSummaryDocumentPath('../unsupported'), /Unsupported/);
  assert.throws(() => packStatusEventCollectionPath('unsupported'), /Unsupported/);
});

test('dry run requires exact D1 and Firestore parity without bookmark, receipt, or deletion', async () => {
  const eventCounts = Object.fromEntries(supportedDropIds.map((dropId, index) => [dropId, index + 1]));
  const firestore = new MemoryFirestore(eventCounts);
  const dependencies = makeDependencies(firestore, d1Report(eventCounts), eventCounts);
  const result = await runPackStatusRetirement({ mode: 'dry-run' }, dependencies);
  assert.equal(result.mode, 'dry-run');
  if (result.mode !== 'dry-run') assert.fail('expected dry-run result');
  assert.equal(result.firestore.summaryCount, 3);
  assert.equal(result.firestore.eventCount, 6);
  assert.equal(dependencies.bookmarkCalls.value, 0);
  assert.equal(dependencies.writes.length, 0);
  assert.deepEqual(firestore.deleteCalls, []);
  assert.deepEqual(dependencies.apiVerificationCalls, []);

  const changedEventPath = `${packStatusEventCollectionPath(supportedDropIds[0])}/${eventDocumentId(0)}`;
  firestore.documents.set(changedEventPath, {
    ...eventData(supportedDropIds[0], 0),
    createdAt: Timestamp.fromMillis(99_999),
  });
  assert.equal((await runPackStatusRetirement({ mode: 'dry-run' }, dependencies)).mode, 'dry-run');
  firestore.documents.set(changedEventPath, {
    ...eventData(supportedDropIds[0], 0),
    quantity: 2,
  });
  await assert.rejects(
    () => runPackStatusRetirement({ mode: 'dry-run' }, dependencies),
    /event payloads differ/,
  );
  assert.equal(dependencies.bookmarkCalls.value, 0);
  assert.equal(dependencies.writes.length, 0);
});

test('retirement accepts proven D1-only applied growth over the frozen Firestore baseline', async () => {
  const firestoreCounts = Object.fromEntries(supportedDropIds.map((dropId) => [dropId, 1]));
  const d1Counts = { ...firestoreCounts, [supportedDropIds[0]]: 2 };
  const firestore = new MemoryFirestore(firestoreCounts);
  const report = d1Report(d1Counts);
  report.drops[0].counters = {
    ...report.drops[0].counters,
    unsealedOnline: report.drops[0].counters.unsealedOnline + 2,
  };
  const events = d1Events(d1Counts);
  const d1OnlyEvent = events.find((event) => (
    event.dropId === supportedDropIds[0] && event.documentId === eventDocumentId(1)
  ))!;
  d1OnlyEvent.applyDelta = 1;
  d1OnlyEvent.deltas = {
    unsealedOnline: 2,
    redeemedIrlNormal: 0,
    redeemedIrlStripe: 0,
    redeemedUnsealedCards: 0,
  };
  const dependencies = makeDependencies(firestore, report, d1Counts);
  dependencies.readD1Events = () => events;

  const result = await runPackStatusRetirement({ mode: 'dry-run' }, dependencies);
  assert.equal(result.mode, 'dry-run');
  if (result.mode !== 'dry-run') assert.fail('expected dry-run result');
  const frozen = result.firestore.drops.find((drop) => drop.dropId === supportedDropIds[0])!;
  assert.equal(frozen.eventCount, 1);
  assert.equal(frozen.d1OnlyEventCount, 1);
  assert.equal(frozen.d1OnlyDeltas.unsealedOnline, 2);
  assert.equal(frozen.counters.unsealedOnline, 1);
  assert.equal(result.d1.drops[0].counters.unsealedOnline, 3);
});

test('retirement rejects missing historical events and unexplained D1 counter differences', async () => {
  const firestoreCounts = Object.fromEntries(supportedDropIds.map((dropId) => [dropId, 1]));
  const d1Counts = { ...firestoreCounts, [supportedDropIds[0]]: 2 };

  const historicalFirestore = new MemoryFirestore(firestoreCounts);
  const historicalDependencies = makeDependencies(
    historicalFirestore,
    d1Report(d1Counts),
    d1Counts,
  );
  await assert.rejects(
    () => runPackStatusRetirement({ mode: 'dry-run' }, historicalDependencies),
    /unmatched historical event/,
  );

  const unexplainedFirestore = new MemoryFirestore(firestoreCounts);
  const unexplainedDependencies = makeDependencies(
    unexplainedFirestore,
    d1Report(d1Counts),
    d1Counts,
  );
  const unexplainedEvents = d1Events(d1Counts);
  unexplainedEvents.find((event) => (
    event.dropId === supportedDropIds[0] && event.documentId === eventDocumentId(1)
  ))!.applyDelta = 1;
  unexplainedDependencies.readD1Events = () => unexplainedEvents;
  await assert.rejects(
    () => runPackStatusRetirement({ mode: 'dry-run' }, unexplainedDependencies),
    /do not equal the frozen Firestore summary/,
  );

  const extraFirestoreCounts = { ...firestoreCounts, [supportedDropIds[0]]: 2 };
  const missingD1Firestore = new MemoryFirestore(extraFirestoreCounts);
  const missingD1Dependencies = makeDependencies(
    missingD1Firestore,
    d1Report(firestoreCounts),
    firestoreCounts,
  );
  await assert.rejects(
    () => runPackStatusRetirement({ mode: 'dry-run' }, missingD1Dependencies),
    /event missing from D1/,
  );
});

test('confirmed retirement fails a public-rule prerequisite before bookmark, receipt, or deletion', async () => {
  const eventCounts = Object.fromEntries(supportedDropIds.map((dropId) => [dropId, 1]));
  const firestore = new MemoryFirestore(eventCounts);
  const initialReport = d1Report(eventCounts);
  const dependencies = makeDependencies(firestore, initialReport, eventCounts);
  const before = [...firestore.documents.entries()];
  dependencies.verifyApiVersion = () => {
    throw new Error('public Firestore pack status is still readable');
  };
  await assert.rejects(
    () => runPackStatusRetirement({ mode: 'confirm', apiVersionId: randomUUID() }, dependencies),
    /still readable/,
  );
  assert.equal(dependencies.bookmarkCalls.value, 0);
  assert.equal(dependencies.writes.length, 0);
  assert.deepEqual(firestore.deleteCalls, []);
  assert.deepEqual([...firestore.documents.entries()], before);
});

test('confirmed retirement re-verifies the API after recording its durable plan', async () => {
  const eventCounts = Object.fromEntries(supportedDropIds.map((dropId) => [dropId, 1]));
  const firestore = new MemoryFirestore(eventCounts);
  const initialReport = d1Report(eventCounts);
  const dependencies = makeDependencies(firestore, initialReport, eventCounts);
  let verificationCalls = 0;
  dependencies.verifyApiVersion = () => {
    verificationCalls += 1;
    if (verificationCalls === 2) throw new Error('API changed after retirement planning');
  };
  await assert.rejects(
    () => runPackStatusRetirement({ mode: 'confirm', apiVersionId: randomUUID() }, dependencies),
    /changed after retirement planning/,
  );
  assert.equal(verificationCalls, 2);
  assert.equal(dependencies.receipt.value?.status, 'planned');
  assert.equal(dependencies.writes.length, 1);
  assert.equal(dependencies.bookmarkCalls.value, 1);
  assert.deepEqual(firestore.deleteCalls, []);
});

test('confirmed retirement rejects a late Firestore copy of a preexisting D1-only event', async () => {
  const firestoreCounts = Object.fromEntries(supportedDropIds.map((dropId) => [dropId, 1]));
  const d1Counts = { ...firestoreCounts, [supportedDropIds[0]]: 2 };
  const firestore = new MemoryFirestore(firestoreCounts);
  const report = d1Report(d1Counts);
  report.drops[0].counters = {
    ...report.drops[0].counters,
    unsealedOnline: report.drops[0].counters.unsealedOnline + 1,
  };
  const events = d1Events(d1Counts);
  events.find((event) => (
    event.dropId === supportedDropIds[0] && event.documentId === eventDocumentId(1)
  ))!.applyDelta = 1;
  const dependencies = makeDependencies(firestore, report, d1Counts);
  dependencies.readD1Events = () => events;
  const latePath = `${packStatusEventCollectionPath(supportedDropIds[0])}/${eventDocumentId(1)}`;
  firestore.onList = (dropId, call) => {
    if (call === supportedDropIds.length + 1) {
      firestore.documents.set(latePath, eventData(dropId, 1));
    }
  };
  await assert.rejects(
    () => runPackStatusRetirement({ mode: 'confirm', apiVersionId: randomUUID() }, dependencies),
    /late pack-status event outside the recorded deletion plan/,
  );
  assert.equal(dependencies.receipt.value?.status, 'planned');
  assert.equal(dependencies.apiVerificationCalls.length, 2);
  assert.deepEqual(firestore.deleteCalls, []);
  assert.equal(firestore.documents.has(latePath), true);
});

test('summary updateTime preconditions reject a late mutation without deleting summaries', async () => {
  const eventCounts = Object.fromEntries(supportedDropIds.map((dropId) => [dropId, 1]));
  const firestore = new MemoryFirestore(eventCounts);
  const dependencies = makeDependencies(firestore, d1Report(eventCounts), eventCounts);
  const changedPath = packStatusSummaryDocumentPath(supportedDropIds[0]);
  firestore.beforeSummaryDelete = () => {
    firestore.documents.set(changedPath, {
      ...firestore.documents.get(changedPath),
      unsealedOnline: 99,
    });
    firestore.summaryUpdateTimes.set(changedPath, '9000:1');
  };
  await assert.rejects(
    () => runPackStatusRetirement({ mode: 'confirm', apiVersionId: randomUUID() }, dependencies),
    /FAILED_PRECONDITION/,
  );
  assert.equal(dependencies.receipt.value?.status, 'planned');
  for (const dropId of supportedDropIds) {
    assert.equal(firestore.documents.has(packStatusSummaryDocumentPath(dropId)), true);
  }
});

test('completed summary deletion resumes idempotently after receipt persistence fails', async () => {
  const eventCounts = Object.fromEntries(supportedDropIds.map((dropId) => [dropId, 1]));
  const firestore = new MemoryFirestore(eventCounts);
  const initialReport = d1Report(eventCounts);
  const dependencies = makeDependencies(firestore, initialReport, eventCounts);
  const writeReceipt = dependencies.writeReceipt;
  let failCompletedWrite = true;
  dependencies.writeReceipt = (next, expected) => {
    if (next.status === 'completed' && failCompletedWrite) {
      throw new Error('injected completed receipt persistence failure');
    }
    writeReceipt(next, expected);
  };
  const apiVersionId = randomUUID();
  await assert.rejects(
    () => runPackStatusRetirement({ mode: 'confirm', apiVersionId }, dependencies),
    /persistence failure/,
  );
  assert.equal(dependencies.receipt.value?.status, 'planned');
  assert.equal(
    [...firestore.documents.keys()].some(isAllowedPackStatusRetirementDeletePath),
    false,
  );

  const grownCounts = { ...eventCounts, [supportedDropIds[0]]: 2 };
  const grownReport = d1Report(grownCounts);
  grownReport.drops[0].counters = {
    ...grownReport.drops[0].counters,
    unsealedOnline: grownReport.drops[0].counters.unsealedOnline + 1,
  };
  const grownEvents = d1Events(grownCounts);
  grownEvents.find((event) => (
    event.dropId === supportedDropIds[0] && event.documentId === eventDocumentId(1)
  ))!.applyDelta = 1;
  dependencies.readD1Events = () => grownEvents;
  dependencies.readD1Integrity = () => grownReport;
  failCompletedWrite = false;
  const resumed = await runPackStatusRetirement({ mode: 'confirm', apiVersionId }, dependencies);
  assert.equal(resumed.mode, 'receipt');
  if (resumed.mode !== 'receipt') assert.fail('expected receipt result');
  assert.equal(resumed.receipt.status, 'completed');
  assert.equal(resumed.receipt.d1.eventCount, initialReport.eventCount + 1);
});

test('retirement re-proves and records monotonic D1-only growth that lands during deletion', async () => {
  const firestoreCounts = Object.fromEntries(supportedDropIds.map((dropId) => [dropId, 1]));
  const grownCounts = { ...firestoreCounts, [supportedDropIds[0]]: 2 };
  const firestore = new MemoryFirestore(firestoreCounts);
  const initialReport = d1Report(firestoreCounts);
  const grownReport = d1Report(grownCounts);
  grownReport.drops[0].counters = {
    ...grownReport.drops[0].counters,
    unsealedOnline: grownReport.drops[0].counters.unsealedOnline + 1,
  };
  const initialEvents = d1Events(firestoreCounts);
  const grownEvents = d1Events(grownCounts);
  grownEvents.find((event) => (
    event.dropId === supportedDropIds[0] && event.documentId === eventDocumentId(1)
  ))!.applyDelta = 1;
  const dependencies = makeDependencies(firestore, initialReport, firestoreCounts);
  let grown = false;
  firestore.afterSummaryDelete = () => {
    grown = true;
  };
  dependencies.readD1Events = () => grown ? grownEvents : initialEvents;
  dependencies.readD1Integrity = () => grown ? grownReport : initialReport;

  const result = await runPackStatusRetirement({ mode: 'confirm', apiVersionId: randomUUID() }, dependencies);
  assert.equal(result.mode, 'receipt');
  if (result.mode !== 'receipt') assert.fail('expected receipt result');
  assert.equal(result.receipt.status, 'completed');
  assert.equal(result.receipt.d1.eventCount, initialReport.eventCount + 1);
  assert.equal(result.receipt.firestoreBefore.drops[0].d1OnlyEventCount, 1);
  assert.equal(result.receipt.firestoreBefore.drops[0].d1OnlyDeltas.unsealedOnline, 1);
});

test('confirmed retirement records its bookmark and deletes only exact paginated allowlisted paths', async () => {
  const eventCounts = {
    [supportedDropIds[0]]: 251,
    [supportedDropIds[1]]: 2,
    [supportedDropIds[2]]: 1,
  };
  const firestore = new MemoryFirestore(eventCounts);
  const unrelated = [
    'drops/card_nft_2/meta/dudePool',
    'drops/unsupported/meta/packStatus',
    'drops/unsupported/packStatusEvents/event-0000',
    'profiles/owner',
  ];
  for (const path of unrelated) firestore.documents.set(path, { preserved: true });
  const dependencies = makeDependencies(firestore, d1Report(eventCounts), eventCounts);
  const apiVersionId = randomUUID();
  const targetedBefore = [...firestore.documents.keys()]
    .filter(isAllowedPackStatusRetirementDeletePath)
    .sort();

  const result = await runPackStatusRetirement({ mode: 'confirm', apiVersionId }, dependencies);
  assert.equal(result.mode, 'receipt');
  if (result.mode !== 'receipt') assert.fail('expected receipt result');
  assert.equal(result.receipt.status, 'completed');
  assert.equal(result.receipt.apiVersionId, apiVersionId);
  assert.equal(result.receipt.d1Bookmark, '00000000-1111-2222-3333-444444444444');
  assert.equal(result.receipt.firestoreBefore.summaryCount, 3);
  assert.equal(result.receipt.firestoreBefore.eventCount, 254);
  assert.equal(result.receipt.postDelete?.summaryCount, 0);
  assert.equal(result.receipt.postDelete?.eventCount, 0);
  assert.equal(isPackStatusRetirementReceipt(result.receipt), true);
  assert.doesNotMatch(JSON.stringify(result.receipt), /event-\d{4}/);
  assert.equal(dependencies.bookmarkCalls.value, 2);
  assert.deepEqual(dependencies.apiVerificationCalls, [apiVersionId, apiVersionId, apiVersionId]);
  assert.deepEqual(dependencies.writes.map((write) => write.next.status), ['planned', 'completed']);
  assert.equal(firestore.deleteCalls.some((paths) => paths.length === 250), true);
  const deleted = firestore.deleteCalls.flat().sort();
  assert.deepEqual(deleted, targetedBefore);
  for (const path of targetedBefore) assert.equal(firestore.documents.has(path), false, path);
  for (const path of unrelated) assert.deepEqual(firestore.documents.get(path), { preserved: true });
});

test('planned receipt resumes partial deletion and completed receipt is idempotent', async () => {
  const eventCounts = {
    [supportedDropIds[0]]: 251,
    [supportedDropIds[1]]: 1,
    [supportedDropIds[2]]: 1,
  };
  const firestore = new MemoryFirestore(eventCounts);
  const report = d1Report(eventCounts);
  const dependencies = makeDependencies(firestore, report, eventCounts);
  const apiVersionId = randomUUID();
  firestore.failDeleteCall = 2;

  await assert.rejects(
    () => runPackStatusRetirement({ mode: 'confirm', apiVersionId }, dependencies),
    /injected Firestore delete failure/,
  );
  assert.equal(dependencies.receipt.value?.status, 'planned');
  assert.equal(dependencies.writes.length, 1);
  assert.equal(dependencies.bookmarkCalls.value, 1);
  assert.deepEqual(dependencies.apiVerificationCalls, [apiVersionId, apiVersionId]);
  assert.equal(
    firestore.listEventDocuments(supportedDropIds[0], undefined, 1).length,
    1,
  );

  const deleteCallsBeforeRejectedResume = firestore.deleteCalls.length;
  const verifiedApiVersion = dependencies.verifyApiVersion;
  dependencies.verifyApiVersion = () => {
    throw new Error('planned receipt API is no longer live');
  };
  await assert.rejects(
    () => runPackStatusRetirement({ mode: 'confirm', apiVersionId }, dependencies),
    /no longer live/,
  );
  assert.equal(firestore.deleteCalls.length, deleteCallsBeforeRejectedResume);
  assert.equal(dependencies.writes.length, 1);
  assert.equal(dependencies.bookmarkCalls.value, 1);
  dependencies.verifyApiVersion = verifiedApiVersion;

  const remainingEventPath = `${packStatusEventCollectionPath(supportedDropIds[0])}/${eventDocumentId(250)}`;
  const unexpectedEventPath = `${packStatusEventCollectionPath(supportedDropIds[0])}/${eventDocumentId(9_999)}`;
  firestore.documents.delete(remainingEventPath);
  firestore.documents.set(unexpectedEventPath, eventData(supportedDropIds[0], 9_999));
  await assert.rejects(
    () => runPackStatusRetirement({ mode: 'confirm', apiVersionId }, dependencies),
    /not present in the retirement plan/,
  );
  firestore.documents.delete(unexpectedEventPath);
  firestore.documents.set(remainingEventPath, eventData(supportedDropIds[0], 250));

  firestore.failDeleteCall = undefined;
  const resumed = await runPackStatusRetirement({ mode: 'confirm', apiVersionId }, dependencies);
  assert.equal(resumed.mode, 'receipt');
  if (resumed.mode !== 'receipt') assert.fail('expected receipt result');
  assert.equal(resumed.receipt.status, 'completed');
  assert.equal(dependencies.writes.length, 2);
  assert.equal(dependencies.bookmarkCalls.value, 2);

  const deleteCallCount = firestore.deleteCalls.length;
  const writeCount = dependencies.writes.length;
  eventCounts[supportedDropIds[0]] += 1;
  const changedDrop = report.drops.find((drop) => drop.dropId === supportedDropIds[0])!;
  changedDrop.eventCount += 1;
  changedDrop.appliedEventCount += 1;
  report.eventCount += 1;
  const completed = await runPackStatusRetirement({ mode: 'confirm', apiVersionId }, dependencies);
  assert.equal(completed.mode, 'receipt');
  assert.equal(firestore.deleteCalls.length, deleteCallCount);
  assert.equal(dependencies.writes.length, writeCount);
  assert.equal(dependencies.bookmarkCalls.value, 2);
  assert.deepEqual(dependencies.apiVerificationCalls, [
    apiVersionId,
    apiVersionId,
    apiVersionId,
    apiVersionId,
    apiVersionId,
    apiVersionId,
  ]);
  await assert.rejects(
    () => runPackStatusRetirement({ mode: 'confirm', apiVersionId: randomUUID() }, dependencies),
    /does not match the recorded retirement plan/,
  );
});
