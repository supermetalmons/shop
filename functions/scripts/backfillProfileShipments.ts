import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import {
  deleteApp,
  getApps,
  initializeApp,
  type App as FirebaseAdminApp,
} from 'firebase-admin/app';
import {
  FieldPath,
  getFirestore,
  type Firestore,
  type Timestamp,
  type Transaction,
} from 'firebase-admin/firestore';
import {
  DELIVERY_ORDER_SUMMARY_FIELDS,
  applyProfileShipmentSyncPlanWithResult,
  buildProfileShipment,
  classifyProfileShipmentSource,
  type ProfileShipmentInvalidSourceReason,
  type ProfileShipmentSyncPlan,
} from '../src/profileShipments.ts';

export type BackfillOptions = {
  apply: boolean;
  pageSize: number;
  concurrency?: number;
  maxAuditDocuments?: number;
};

export type ProfileShipmentAudit = {
  sourceDocumentsScanned: number;
  eligibleSources: number;
  ineligibleSources: number;
  invalidSources: number;
  invalidSourceReasons: Record<ProfileShipmentInvalidSourceReason, number>;
  unexpectedSourcePaths: number;
  sourcePages: number;
  destinationDocumentsScanned: number;
  exactDestinations: number;
  orphanDestinations: number;
  wrongOwnerDestinations: number;
  mismatchedDestinations: number;
  missingDestinations: number;
  unexpectedDestinationPaths: number;
  destinationPages: number;
  deletePreconditionsMissing: number;
  inSync: boolean;
};

export type ProfileShipmentBackfillResult = {
  dryRun: boolean;
  before: ProfileShipmentAudit;
  applied?: {
    conditionalDeletesPlanned: number;
    conditionalDeletesSucceeded: number;
    conditionalDeleteConflicts: number;
    sourceDocumentsScanned: number;
    sourceTransactions: number;
    projectionUpserts: number;
    baselineDeletes: number;
  };
  after?: ProfileShipmentAudit;
  inSync: boolean;
};

export type BackfillCliOptions = Required<BackfillOptions> & {
  projectId: string;
  verify: boolean;
  confirmProject: string | null;
  confirmTriggerDeployed: boolean;
  allowEmulator: boolean;
};

type SourceDoc = {
  id: string;
  ref: { path: string };
  data(): any;
};

type DestinationDoc = SourceDoc & {
  updateTime?: Timestamp;
};

type ExpectedShipment = {
  sourcePath: string;
  ownerWallet: string;
  documentId: string;
  fingerprint: string;
};

type ConditionalDelete = {
  path: string;
  updateTime: Timestamp;
};

type AuditPlan = {
  summary: ProfileShipmentAudit;
  expectedByDocumentId: Map<string, ExpectedShipment>;
  expectedBySourcePath: Map<string, ExpectedShipment>;
  conditionalDeletes: ConditionalDelete[];
};

type AuditReader = Pick<Transaction, 'get'>;

type BackfillCliApp = {
  name: string;
  options: { projectId?: string };
};

export type ProfileShipmentBackfillCliRuntime<App extends BackfillCliApp> = {
  emulatorHost: string;
  maxAuditDocumentsEnv?: string;
  getApps(): App[];
  initializeApp(options: { projectId: string }, name: string): App;
  deleteApp(app: App): Promise<void>;
  getFirestore(app: App): Firestore;
  log(value: string): void;
};

function usage(): string {
  return [
    'Audit or reconcile sanitized profile shipment summaries.',
    '',
    'Usage:',
    '  npm run backfill:profile-shipments -- --project <project-id>',
    '  npm run backfill:profile-shipments -- --project <project-id> --verify',
    '  npm run backfill:profile-shipments -- --project <project-id> --apply --confirm-project <project-id> --confirm-trigger-deployed',
    '',
    'Options:',
    '  --project <id>               Required Firestore project.',
    '  --verify                     Read only and fail when projection drift exists.',
    '  --apply                      Repair drift, then verify. Without this flag no writes occur.',
    '  --confirm-project <id>       Required for apply and must exactly match --project.',
    '  --confirm-trigger-deployed   Required for apply.',
    '  --allow-emulator             Required when FIRESTORE_EMULATOR_HOST is set.',
    '  --page-size <n>              Read 1..450 documents per page (default: 400).',
    '  --max-audit-documents <n>    Audit at most 1..50000 source-plus-destination documents (default: 20000).',
    '  --concurrency <n>            Run 1..20 repair operations concurrently (default: 10).',
    '  -h, --help                   Show this help.',
  ].join('\n');
}

function fail(message: string): never {
  throw new Error(message);
}

function requiredArg(argv: string[], index: number, flag: string): string {
  const value = String(argv[index + 1] || '').trim();
  if (!value || value.startsWith('--')) fail(`Missing value for ${flag}\n\n${usage()}`);
  return value;
}

function parseAuditDocumentLimit(value: string, label: string): number {
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > 50_000) {
    fail(`Invalid value for ${label}; expected an integer from 1 to 50000`);
  }
  return limit;
}

export function parseProfileShipmentBackfillArgs(
  argv: string[],
  environment: { maxAuditDocuments?: string } = {},
): BackfillCliOptions {
  const environmentLimit = String(environment.maxAuditDocuments || '').trim();
  const options: BackfillCliOptions = {
    projectId: '',
    apply: false,
    verify: false,
    confirmProject: null,
    confirmTriggerDeployed: false,
    allowEmulator: false,
    pageSize: 400,
    concurrency: 10,
    maxAuditDocuments: environmentLimit
      ? parseAuditDocumentLimit(environmentLimit, 'PROFILE_SHIPMENTS_MAX_AUDIT_DOCUMENTS')
      : 20_000,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '-h' || arg === '--help') {
      console.log(usage());
      process.exit(0);
    }
    if (arg === '--project') {
      options.projectId = requiredArg(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg === '--verify') {
      options.verify = true;
      continue;
    }
    if (arg === '--apply') {
      options.apply = true;
      continue;
    }
    if (arg === '--confirm-project') {
      options.confirmProject = requiredArg(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg === '--confirm-trigger-deployed') {
      options.confirmTriggerDeployed = true;
      continue;
    }
    if (arg === '--allow-emulator') {
      options.allowEmulator = true;
      continue;
    }
    if (arg === '--page-size') {
      const pageSize = Number(requiredArg(argv, index, arg));
      if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 450) {
        fail(`Invalid value for --page-size\n\n${usage()}`);
      }
      options.pageSize = pageSize;
      index += 1;
      continue;
    }
    if (arg === '--concurrency') {
      const concurrency = Number(requiredArg(argv, index, arg));
      if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 20) {
        fail(`Invalid value for --concurrency\n\n${usage()}`);
      }
      options.concurrency = concurrency;
      index += 1;
      continue;
    }
    if (arg === '--max-audit-documents') {
      options.maxAuditDocuments = parseAuditDocumentLimit(requiredArg(argv, index, arg), arg);
      index += 1;
      continue;
    }
    fail(`Unknown arg: ${arg}\n\n${usage()}`);
  }

  if (!options.projectId) fail(`--project is required\n\n${usage()}`);
  if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(options.projectId)) {
    fail(`Invalid Firebase project id: ${options.projectId}`);
  }
  if (options.apply && options.verify) fail('--apply already verifies; do not combine it with --verify');
  if (options.apply && options.confirmProject !== options.projectId) {
    fail('--confirm-project must exactly match --project when applying');
  }
  if (options.apply && !options.confirmTriggerDeployed) {
    fail('--confirm-trigger-deployed is required when applying');
  }
  return options;
}

function exactSourcePath(path: string): boolean {
  const parts = String(path || '').split('/');
  return parts.length === 4 && parts[0] === 'drops' && Boolean(parts[1]) && parts[2] === 'deliveryOrders' && Boolean(parts[3]);
}

function destinationPath(path: string): { ownerWallet: string; documentId: string } | null {
  const parts = String(path || '').split('/');
  if (parts.length !== 4 || parts[0] !== 'profiles' || !parts[1] || parts[2] !== 'shipments' || !parts[3]) return null;
  return { ownerWallet: parts[1], documentId: parts[3] };
}

function canonicalFingerprintValue(value: unknown, ancestors: WeakSet<object>): unknown {
  if (value === null) return ['null'];
  if (value === undefined) return ['undefined'];
  if (typeof value === 'string') return ['string', value];
  if (typeof value === 'boolean') return ['boolean', value];
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return ['number', 'NaN'];
    if (value === Number.POSITIVE_INFINITY) return ['number', 'Infinity'];
    if (value === Number.NEGATIVE_INFINITY) return ['number', '-Infinity'];
    if (Object.is(value, -0)) return ['number', '-0'];
    return ['number', value];
  }
  if (typeof value === 'bigint') return ['bigint', value.toString()];
  if (typeof value !== 'object') return [typeof value, String(value)];
  if (value instanceof Date) return ['date', value.toISOString()];
  if (ArrayBuffer.isView(value)) {
    const bytes = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
    return ['bytes', bytes.toString('base64')];
  }
  if (typeof (value as any).toMillis === 'function') {
    return ['timestamp', Number((value as any).toMillis())];
  }
  if (typeof (value as any).path === 'string' && typeof (value as any).get === 'function') {
    return ['reference', (value as any).path];
  }
  if (ancestors.has(value)) fail('Cannot fingerprint cyclic profile shipment data');
  ancestors.add(value);
  const canonical = Array.isArray(value)
    ? ['array', value.map((entry) => canonicalFingerprintValue(entry, ancestors))]
    : [
        'object',
        Object.keys(value)
          .sort()
          .map((key) => [key, canonicalFingerprintValue((value as Record<string, unknown>)[key], ancestors)]),
      ];
  ancestors.delete(value);
  return canonical;
}

export function profileShipmentFingerprint(value: unknown): string {
  const canonical = JSON.stringify(canonicalFingerprintValue(value, new WeakSet()));
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

export function assertUniqueProfileShipmentManifestId(
  expectedByDocumentId: ReadonlyMap<string, { sourcePath: string }>,
  expected: { sourcePath: string; documentId: string },
): void {
  const collision = expectedByDocumentId.get(expected.documentId);
  if (collision && collision.sourcePath !== expected.sourcePath) {
    fail(`Profile shipment document id collision: ${expected.documentId}`);
  }
}

function auditPageLimit(pageSize: number, remainingDocuments: number): number {
  return Math.min(pageSize, remainingDocuments + 1);
}

function assertAuditBudget(
  documentCount: number,
  remainingDocuments: number,
  maxAuditDocuments: number,
): void {
  if (documentCount <= remainingDocuments) return;
  fail(
    `Profile shipment audit exceeded --max-audit-documents=${maxAuditDocuments}. ` +
      'Rerun with a higher limit (maximum 50000) after confirming the expected collection size.',
  );
}

async function scanExpectedShipments(
  db: Firestore,
  reader: AuditReader,
  pageSize: number,
  maxAuditDocuments: number,
): Promise<{
  expectedByDocumentId: Map<string, ExpectedShipment>;
  expectedBySourcePath: Map<string, ExpectedShipment>;
  sourceDocumentsScanned: number;
  eligibleSources: number;
  ineligibleSources: number;
  invalidSources: number;
  invalidSourceReasons: Record<ProfileShipmentInvalidSourceReason, number>;
  unexpectedSourcePaths: number;
  sourcePages: number;
}> {
  const expectedByDocumentId = new Map<string, ExpectedShipment>();
  const expectedBySourcePath = new Map<string, ExpectedShipment>();
  let cursorPath: string | null = null;
  let sourceDocumentsScanned = 0;
  let eligibleSources = 0;
  let ineligibleSources = 0;
  let invalidSources = 0;
  const invalidSourceReasons: Record<ProfileShipmentInvalidSourceReason, number> = {
    invalid_path: 0,
    invalid_owner: 0,
    invalid_summary: 0,
    drop_id_mismatch: 0,
    invalid_delivery_id: 0,
    delivery_id_mismatch: 0,
  };
  let unexpectedSourcePaths = 0;
  let sourcePages = 0;

  for (;;) {
    const remainingDocuments = maxAuditDocuments - sourceDocumentsScanned;
    let query = db
      .collectionGroup('deliveryOrders')
      .orderBy(FieldPath.documentId())
      .select('owner', ...DELIVERY_ORDER_SUMMARY_FIELDS)
      .limit(auditPageLimit(pageSize, remainingDocuments));
    if (cursorPath) query = query.startAfter(cursorPath);
    const snapshot = await reader.get(query);
    if (snapshot.docs.length === 0) break;
    assertAuditBudget(snapshot.docs.length, remainingDocuments, maxAuditDocuments);
    sourcePages += 1;

    for (const doc of snapshot.docs as SourceDoc[]) {
      sourceDocumentsScanned += 1;
      if (!exactSourcePath(doc.ref.path)) {
        unexpectedSourcePaths += 1;
        continue;
      }
      const classification = classifyProfileShipmentSource(doc.id, doc.data(), doc.ref.path);
      if (classification.kind !== 'projected') {
        ineligibleSources += 1;
        if (classification.kind === 'invalid') {
          invalidSources += 1;
          invalidSourceReasons[classification.reason] += 1;
        }
        continue;
      }
      const projection = classification.projection;
      eligibleSources += 1;
      const expected: ExpectedShipment = {
        sourcePath: doc.ref.path,
        ownerWallet: projection.ownerWallet,
        documentId: projection.documentId,
        fingerprint: profileShipmentFingerprint(projection.data),
      };
      assertUniqueProfileShipmentManifestId(expectedByDocumentId, expected);
      expectedByDocumentId.set(expected.documentId, expected);
      expectedBySourcePath.set(expected.sourcePath, expected);
    }

    cursorPath = snapshot.docs[snapshot.docs.length - 1].ref.path;
    if (snapshot.docs.length < auditPageLimit(pageSize, remainingDocuments)) break;
  }

  return {
    expectedByDocumentId,
    expectedBySourcePath,
    sourceDocumentsScanned,
    eligibleSources,
    ineligibleSources,
    invalidSources,
    invalidSourceReasons,
    unexpectedSourcePaths,
    sourcePages,
  };
}

export async function auditProfileShipments(
  db: Firestore,
  pageSize: number,
  maxAuditDocuments = 20_000,
): Promise<AuditPlan> {
  if (!Number.isInteger(maxAuditDocuments) || maxAuditDocuments < 1 || maxAuditDocuments > 50_000) {
    fail('maxAuditDocuments must be an integer from 1 to 50000');
  }
  return db.runTransaction(async (tx) => {
    const expected = await scanExpectedShipments(db, tx, pageSize, maxAuditDocuments);
    const seenAtExpectedOwner = new Set<string>();
    const conditionalDeletes: ConditionalDelete[] = [];
    let cursorPath: string | null = null;
    let destinationDocumentsScanned = 0;
    let exactDestinations = 0;
    let orphanDestinations = 0;
    let wrongOwnerDestinations = 0;
    let mismatchedDestinations = 0;
    let unexpectedDestinationPaths = 0;
    let destinationPages = 0;
    let deletePreconditionsMissing = 0;

    for (;;) {
      const remainingDocuments = maxAuditDocuments -
        expected.sourceDocumentsScanned -
        destinationDocumentsScanned;
      const pageLimit = auditPageLimit(pageSize, remainingDocuments);
      let query = db.collectionGroup('shipments').orderBy(FieldPath.documentId()).limit(pageLimit);
      if (cursorPath) query = query.startAfter(cursorPath);
      const snapshot = await tx.get(query);
      if (snapshot.docs.length === 0) break;
      assertAuditBudget(snapshot.docs.length, remainingDocuments, maxAuditDocuments);
      destinationPages += 1;

      for (const doc of snapshot.docs as DestinationDoc[]) {
        destinationDocumentsScanned += 1;
        const target = destinationPath(doc.ref.path);
        if (!target) {
          unexpectedDestinationPaths += 1;
          continue;
        }
        const expectedTarget = expected.expectedByDocumentId.get(target.documentId);
        let shouldDelete = false;
        if (!expectedTarget) {
          orphanDestinations += 1;
          shouldDelete = true;
        } else if (expectedTarget.ownerWallet !== target.ownerWallet) {
          wrongOwnerDestinations += 1;
          shouldDelete = true;
        } else {
          seenAtExpectedOwner.add(target.documentId);
          if (profileShipmentFingerprint(doc.data()) === expectedTarget.fingerprint) exactDestinations += 1;
          else mismatchedDestinations += 1;
        }
        if (shouldDelete) {
          if (doc.updateTime) conditionalDeletes.push({ path: doc.ref.path, updateTime: doc.updateTime });
          else deletePreconditionsMissing += 1;
        }
      }

      cursorPath = snapshot.docs[snapshot.docs.length - 1].ref.path;
      if (snapshot.docs.length < pageLimit) break;
    }

    const missingDestinations = [...expected.expectedByDocumentId.keys()]
      .filter((documentId) => !seenAtExpectedOwner.has(documentId))
      .length;
    const inSync = expected.invalidSources === 0 &&
      expected.unexpectedSourcePaths === 0 &&
      orphanDestinations === 0 &&
      wrongOwnerDestinations === 0 &&
      mismatchedDestinations === 0 &&
      missingDestinations === 0 &&
      unexpectedDestinationPaths === 0 &&
      deletePreconditionsMissing === 0;

    return {
      summary: {
        sourceDocumentsScanned: expected.sourceDocumentsScanned,
        eligibleSources: expected.eligibleSources,
        ineligibleSources: expected.ineligibleSources,
        invalidSources: expected.invalidSources,
        invalidSourceReasons: expected.invalidSourceReasons,
        unexpectedSourcePaths: expected.unexpectedSourcePaths,
        sourcePages: expected.sourcePages,
        destinationDocumentsScanned,
        exactDestinations,
        orphanDestinations,
        wrongOwnerDestinations,
        mismatchedDestinations,
        missingDestinations,
        unexpectedDestinationPaths,
        destinationPages,
        deletePreconditionsMissing,
        inSync,
      },
      expectedByDocumentId: expected.expectedByDocumentId,
      expectedBySourcePath: expected.expectedBySourcePath,
      conditionalDeletes,
    };
  }, { readOnly: true });
}

function assertApplyAuditIsSafe(audit: ProfileShipmentAudit): void {
  if (
    audit.unexpectedSourcePaths === 0 &&
    audit.invalidSources === 0 &&
    audit.unexpectedDestinationPaths === 0 &&
    audit.deletePreconditionsMissing === 0
  ) return;
  fail([
    'Refusing to apply profile shipment repairs because the audit found out-of-contract or unsafe documents:',
    `invalidSources=${audit.invalidSources}`,
    `invalidSourceReasons=${JSON.stringify(audit.invalidSourceReasons)}`,
    `unexpectedSourcePaths=${audit.unexpectedSourcePaths}`,
    `unexpectedDestinationPaths=${audit.unexpectedDestinationPaths}`,
    `deletePreconditionsMissing=${audit.deletePreconditionsMissing}`,
  ].join(' '));
}

async function forEachConcurrent<T>(items: T[], concurrency: number, operation: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0;
  let stopped = false;
  let firstError: unknown;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (!stopped) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      try {
        await operation(items[index]);
      } catch (error) {
        if (!stopped) {
          stopped = true;
          firstError = error;
        }
      }
    }
  });
  await Promise.all(workers);
  if (stopped) throw firstError;
}

function isConditionalDeleteConflict(error: unknown): boolean {
  const code = (error as any)?.code;
  return code === 5 || code === 9 || code === 'not-found' || code === 'failed-precondition';
}

async function applyConditionalDeletes(
  db: Firestore,
  candidates: ConditionalDelete[],
  concurrency: number,
): Promise<{ succeeded: number; conflicts: number }> {
  let succeeded = 0;
  let conflicts = 0;
  await forEachConcurrent(candidates, concurrency, async (candidate) => {
    try {
      await db.doc(candidate.path).delete({ lastUpdateTime: candidate.updateTime });
      succeeded += 1;
    } catch (error) {
      if (!isConditionalDeleteConflict(error)) throw error;
      conflicts += 1;
    }
  });
  return { succeeded, conflicts };
}

type SourceReconcileCounts = {
  sourceTransactions: number;
  projectionUpserts: number;
  baselineDeletes: number;
};

async function reconcileSource(
  db: Firestore,
  sourcePath: string,
  baseline: ExpectedShipment | undefined,
): Promise<SourceReconcileCounts> {
  return db.runTransaction(async (tx) => {
    const sourceRef = db.doc(sourcePath);
    const sourceSnapshot = await tx.get(sourceRef);
    const current = sourceSnapshot.exists
      ? buildProfileShipment(sourceSnapshot.id, sourceSnapshot.data(), sourceSnapshot.ref.path)
      : null;
    const baselineKey = baseline ? `${baseline.ownerWallet}/${baseline.documentId}` : null;
    const currentKey = current ? `${current.ownerWallet}/${current.documentId}` : null;
    const plan: ProfileShipmentSyncPlan = {
      deletes: baseline && baselineKey !== currentKey
        ? [{ ownerWallet: baseline.ownerWallet, documentId: baseline.documentId }]
        : [],
      upsert: current,
    };
    const result = await applyProfileShipmentSyncPlanWithResult(db, tx, plan);
    return {
      sourceTransactions: 1,
      projectionUpserts: result.upserts,
      baselineDeletes: result.deletes,
    };
  });
}

async function reconcileCurrentSources(
  db: Firestore,
  baselineBySourcePath: Map<string, ExpectedShipment>,
  pageSize: number,
  concurrency: number,
): Promise<SourceReconcileCounts & { sourceDocumentsScanned: number }> {
  const seenBaselinePaths = new Set<string>();
  const counts = {
    sourceDocumentsScanned: 0,
    sourceTransactions: 0,
    projectionUpserts: 0,
    baselineDeletes: 0,
  };
  let cursorPath: string | null = null;

  const applyCounts = (result: SourceReconcileCounts) => {
    counts.sourceTransactions += result.sourceTransactions;
    counts.projectionUpserts += result.projectionUpserts;
    counts.baselineDeletes += result.baselineDeletes;
  };

  for (;;) {
    let query = db
      .collectionGroup('deliveryOrders')
      .orderBy(FieldPath.documentId())
      .select('owner', ...DELIVERY_ORDER_SUMMARY_FIELDS)
      .limit(pageSize);
    if (cursorPath) query = query.startAfter(cursorPath);
    const snapshot = await query.get();
    if (snapshot.docs.length === 0) break;
    const sources = (snapshot.docs as SourceDoc[]).filter((doc) => exactSourcePath(doc.ref.path));
    counts.sourceDocumentsScanned += sources.length;

    await forEachConcurrent(sources, concurrency, async (source) => {
      const baseline = baselineBySourcePath.get(source.ref.path);
      if (baseline) seenBaselinePaths.add(source.ref.path);
      const approximateCurrent = buildProfileShipment(source.id, source.data(), source.ref.path);
      if (!baseline && !approximateCurrent) return;
      applyCounts(await reconcileSource(db, source.ref.path, baseline));
    });

    cursorPath = snapshot.docs[snapshot.docs.length - 1].ref.path;
    if (snapshot.docs.length < pageSize) break;
  }

  const missingBaselineSources = [...baselineBySourcePath.values()]
    .filter((baseline) => !seenBaselinePaths.has(baseline.sourcePath));
  await forEachConcurrent(missingBaselineSources, concurrency, async (baseline) => {
    applyCounts(await reconcileSource(db, baseline.sourcePath, baseline));
  });
  return counts;
}

export async function backfillProfileShipments(
  db: Firestore,
  options: BackfillOptions,
): Promise<ProfileShipmentBackfillResult> {
  const concurrency = options.concurrency ?? 10;
  const maxAuditDocuments = options.maxAuditDocuments ?? 20_000;
  const before = await auditProfileShipments(db, options.pageSize, maxAuditDocuments);
  if (!options.apply) {
    return {
      dryRun: true,
      before: before.summary,
      inSync: before.summary.inSync,
    };
  }

  assertApplyAuditIsSafe(before.summary);
  if (before.summary.inSync) {
    return {
      dryRun: false,
      before: before.summary,
      applied: {
        conditionalDeletesPlanned: 0,
        conditionalDeletesSucceeded: 0,
        conditionalDeleteConflicts: 0,
        sourceDocumentsScanned: 0,
        sourceTransactions: 0,
        projectionUpserts: 0,
        baselineDeletes: 0,
      },
      after: before.summary,
      inSync: true,
    };
  }
  try {
    const deletes = await applyConditionalDeletes(db, before.conditionalDeletes, concurrency);
    const sourceReconciliation = await reconcileCurrentSources(
      db,
      before.expectedBySourcePath,
      options.pageSize,
      concurrency,
    );
    const after = await auditProfileShipments(db, options.pageSize, maxAuditDocuments);
    return {
      dryRun: false,
      before: before.summary,
      applied: {
        conditionalDeletesPlanned: before.conditionalDeletes.length,
        conditionalDeletesSucceeded: deletes.succeeded,
        conditionalDeleteConflicts: deletes.conflicts,
        ...sourceReconciliation,
      },
      after: after.summary,
      inSync: after.summary.inSync,
    };
  } catch (cause) {
    const error = new Error(
      'Profile shipment repair writes may have committed; rerun with --verify before retrying.',
    );
    (error as Error & { cause?: unknown }).cause = cause;
    throw error;
  }
}

export async function runProfileShipmentBackfillCli<App extends BackfillCliApp>(
  argv: string[],
  runtime: ProfileShipmentBackfillCliRuntime<App>,
): Promise<ProfileShipmentBackfillResult> {
  const options = parseProfileShipmentBackfillArgs(argv, {
    maxAuditDocuments: runtime.maxAuditDocumentsEnv,
  });
  const emulatorHost = String(runtime.emulatorHost || '').trim();
  if (emulatorHost && !options.allowEmulator) {
    fail('FIRESTORE_EMULATOR_HOST is set; pass --allow-emulator to target it explicitly');
  }
  const appName = 'profile-shipment-backfill';
  const existing = runtime.getApps().find((app) => app.name === appName);
  if (existing && existing.options.projectId !== options.projectId) {
    fail(`Existing Admin app project mismatch: ${existing.options.projectId || 'unknown'}`);
  }
  const app = existing || runtime.initializeApp({ projectId: options.projectId }, appName);
  const db = runtime.getFirestore(app);
  runtime.log(JSON.stringify({
    mode: options.apply ? 'apply' : options.verify ? 'verify' : 'audit',
    projectId: options.projectId,
    databaseId: '(default)',
    emulatorHost: emulatorHost || null,
    maxAuditDocuments: options.maxAuditDocuments,
  }));

  let failed = false;
  try {
    const result = await backfillProfileShipments(db, options);
    runtime.log(JSON.stringify(result, null, 2));
    if (!options.apply) runtime.log('No Firestore writes performed.');
    if ((options.apply || options.verify) && !result.inSync) {
      fail('Profile shipment projection drift remains');
    }
    return result;
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    if (!existing) {
      try {
        await runtime.deleteApp(app);
      } catch (cleanupError) {
        if (!failed) throw cleanupError;
        runtime.log(`Admin app cleanup also failed: ${formatErrorCauseChain(cleanupError)}`);
      }
    }
  }
}

async function main(): Promise<void> {
  await runProfileShipmentBackfillCli<FirebaseAdminApp>(process.argv.slice(2), {
    emulatorHost: String(process.env.FIRESTORE_EMULATOR_HOST || ''),
    maxAuditDocumentsEnv: String(process.env.PROFILE_SHIPMENTS_MAX_AUDIT_DOCUMENTS || ''),
    getApps,
    initializeApp,
    deleteApp,
    getFirestore,
    log: (value) => console.log(value),
  });
}

function isDirectRun(): boolean {
  return Boolean(process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href);
}

export function formatErrorCauseChain(error: unknown): string {
  const messages: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current != null && !seen.has(current)) {
    seen.add(current);
    messages.push(current instanceof Error ? current.message : String(current));
    current = typeof current === 'object' ? (current as { cause?: unknown }).cause : undefined;
  }
  return messages.join('\nCaused by: ');
}

if (isDirectRun()) {
  main().catch((error) => {
    console.error(formatErrorCauseChain(error));
    process.exitCode = 1;
  });
}
