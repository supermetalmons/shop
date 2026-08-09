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
  type Transaction,
} from 'firebase-admin/firestore';
import {
  DELIVERY_ORDER_SUMMARY_FIELDS,
  classifyProfileShipmentSource,
  type ProfileShipmentSourceClassification,
} from '../src/profileShipments.ts';

const DEFAULT_MAX_AUDIT_DOCUMENTS = 20_000;
const MAX_AUDIT_DOCUMENTS = 50_000;
const AUDIT_PAGE_SIZE = 400;

type ProfileShipmentInvalidSourceReason = Extract<
  ProfileShipmentSourceClassification,
  { kind: 'invalid' }
>['reason'];

export type ProfileShipmentVerification = {
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
  inSync: boolean;
};

export type ProfileShipmentVerifierCliOptions = {
  projectId: string;
  allowEmulator: boolean;
  maxAuditDocuments: number;
};

type SourceDoc = {
  id: string;
  ref: { path: string };
  data(): any;
};

type ExpectedShipment = {
  sourcePath: string;
  ownerWallet: string;
  documentId: string;
  fingerprint: string;
};

type AuditReader = Pick<Transaction, 'get'>;

type VerifierCliApp = {
  name: string;
  options: { projectId?: string };
};

export type ProfileShipmentVerifierCliRuntime<App extends VerifierCliApp> = {
  emulatorHost: string;
  getApps(): App[];
  initializeApp(options: { projectId: string }, name: string): App;
  deleteApp(app: App): Promise<void>;
  getFirestore(app: App): Firestore;
  log(value: string): void;
};

function usage(): string {
  return [
    'Verify sanitized profile shipment summaries against delivery orders.',
    '',
    'Usage:',
    '  npm run verify:profile-shipments',
    '  npm run verify:profile-shipments -- --max-audit-documents <count>',
    '',
    'Options:',
    '  --project <id>                 Required Firebase project.',
    '  --allow-emulator               Required when FIRESTORE_EMULATOR_HOST is set.',
    '  --max-audit-documents <count>  Inspect at most 1..50000 source-plus-destination documents (default: 20000).',
    '  -h, --help                     Show this help.',
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

function parseAuditDocumentLimit(value: string): number {
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_AUDIT_DOCUMENTS) {
    fail(`Invalid value for --max-audit-documents; expected an integer from 1 to ${MAX_AUDIT_DOCUMENTS}`);
  }
  return limit;
}

export function parseProfileShipmentVerifierArgs(argv: string[]): ProfileShipmentVerifierCliOptions {
  const options: ProfileShipmentVerifierCliOptions = {
    projectId: '',
    allowEmulator: false,
    maxAuditDocuments: DEFAULT_MAX_AUDIT_DOCUMENTS,
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
    if (arg === '--allow-emulator') {
      options.allowEmulator = true;
      continue;
    }
    if (arg === '--max-audit-documents') {
      options.maxAuditDocuments = parseAuditDocumentLimit(requiredArg(argv, index, arg));
      index += 1;
      continue;
    }
    fail(`Unknown arg: ${arg}\n\n${usage()}`);
  }

  if (!options.projectId) fail(`--project is required\n\n${usage()}`);
  if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(options.projectId)) {
    fail(`Invalid Firebase project id: ${options.projectId}`);
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
    `Profile shipment verification exceeded --max-audit-documents=${maxAuditDocuments}. ` +
      `Rerun with a higher limit up to ${MAX_AUDIT_DOCUMENTS} after confirming the expected collection size.`,
  );
}

async function scanExpectedShipments(
  db: Firestore,
  reader: AuditReader,
  pageSize: number,
  maxAuditDocuments: number,
): Promise<{
  expectedByDocumentId: Map<string, ExpectedShipment>;
  sourceDocumentsScanned: number;
  eligibleSources: number;
  ineligibleSources: number;
  invalidSources: number;
  invalidSourceReasons: Record<ProfileShipmentInvalidSourceReason, number>;
  unexpectedSourcePaths: number;
  sourcePages: number;
}> {
  const expectedByDocumentId = new Map<string, ExpectedShipment>();
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
    const pageLimit = auditPageLimit(pageSize, remainingDocuments);
    let query = db
      .collectionGroup('deliveryOrders')
      .orderBy(FieldPath.documentId())
      .select('owner', ...DELIVERY_ORDER_SUMMARY_FIELDS)
      .limit(pageLimit);
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
    }

    cursorPath = snapshot.docs[snapshot.docs.length - 1].ref.path;
    if (snapshot.docs.length < pageLimit) break;
  }

  return {
    expectedByDocumentId,
    sourceDocumentsScanned,
    eligibleSources,
    ineligibleSources,
    invalidSources,
    invalidSourceReasons,
    unexpectedSourcePaths,
    sourcePages,
  };
}

export async function verifyProfileShipments(
  db: Firestore,
  options: { maxAuditDocuments?: number; pageSize?: number } = {},
): Promise<ProfileShipmentVerification> {
  const maxAuditDocuments = options.maxAuditDocuments ?? DEFAULT_MAX_AUDIT_DOCUMENTS;
  const pageSize = options.pageSize ?? AUDIT_PAGE_SIZE;
  if (!Number.isInteger(maxAuditDocuments) || maxAuditDocuments < 1 || maxAuditDocuments > MAX_AUDIT_DOCUMENTS) {
    fail(`maxAuditDocuments must be an integer from 1 to ${MAX_AUDIT_DOCUMENTS}`);
  }
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 450) {
    fail('pageSize must be an integer from 1 to 450');
  }

  return db.runTransaction(async (tx) => {
    const expected = await scanExpectedShipments(db, tx, pageSize, maxAuditDocuments);
    const seenAtExpectedOwner = new Set<string>();
    let cursorPath: string | null = null;
    let destinationDocumentsScanned = 0;
    let exactDestinations = 0;
    let orphanDestinations = 0;
    let wrongOwnerDestinations = 0;
    let mismatchedDestinations = 0;
    let unexpectedDestinationPaths = 0;
    let destinationPages = 0;

    for (;;) {
      const remainingDocuments = maxAuditDocuments - expected.sourceDocumentsScanned - destinationDocumentsScanned;
      const pageLimit = auditPageLimit(pageSize, remainingDocuments);
      let query = db.collectionGroup('shipments').orderBy(FieldPath.documentId()).limit(pageLimit);
      if (cursorPath) query = query.startAfter(cursorPath);
      const snapshot = await tx.get(query);
      if (snapshot.docs.length === 0) break;
      assertAuditBudget(snapshot.docs.length, remainingDocuments, maxAuditDocuments);
      destinationPages += 1;

      for (const doc of snapshot.docs as SourceDoc[]) {
        destinationDocumentsScanned += 1;
        const target = destinationPath(doc.ref.path);
        if (!target) {
          unexpectedDestinationPaths += 1;
          continue;
        }
        const expectedTarget = expected.expectedByDocumentId.get(target.documentId);
        if (!expectedTarget) {
          orphanDestinations += 1;
        } else if (expectedTarget.ownerWallet !== target.ownerWallet) {
          wrongOwnerDestinations += 1;
        } else {
          seenAtExpectedOwner.add(target.documentId);
          if (profileShipmentFingerprint(doc.data()) === expectedTarget.fingerprint) exactDestinations += 1;
          else mismatchedDestinations += 1;
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
      unexpectedDestinationPaths === 0;

    return {
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
      inSync,
    };
  }, { readOnly: true });
}

export async function runProfileShipmentVerifierCli<App extends VerifierCliApp>(
  argv: string[],
  runtime: ProfileShipmentVerifierCliRuntime<App>,
): Promise<ProfileShipmentVerification> {
  const options = parseProfileShipmentVerifierArgs(argv);
  const emulatorHost = String(runtime.emulatorHost || '').trim();
  if (emulatorHost && !options.allowEmulator) {
    fail('FIRESTORE_EMULATOR_HOST is set; pass --allow-emulator to target it explicitly');
  }
  const appName = 'profile-shipment-verifier';
  const existing = runtime.getApps().find((app) => app.name === appName);
  if (existing && existing.options.projectId !== options.projectId) {
    fail(`Existing Admin app project mismatch: ${existing.options.projectId || 'unknown'}`);
  }
  const app = existing || runtime.initializeApp({ projectId: options.projectId }, appName);
  const db = runtime.getFirestore(app);
  runtime.log(JSON.stringify({
    mode: 'verify',
    projectId: options.projectId,
    databaseId: '(default)',
    emulatorHost: emulatorHost || null,
    maxAuditDocuments: options.maxAuditDocuments,
  }));

  let failed = false;
  try {
    const result = await verifyProfileShipments(db, { maxAuditDocuments: options.maxAuditDocuments });
    runtime.log(JSON.stringify(result, null, 2));
    runtime.log('No Firestore writes performed.');
    if (!result.inSync) fail('Profile shipment projection drift detected');
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

async function main(): Promise<void> {
  await runProfileShipmentVerifierCli<FirebaseAdminApp>(process.argv.slice(2), {
    emulatorHost: String(process.env.FIRESTORE_EMULATOR_HOST || ''),
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

if (isDirectRun()) {
  main().catch((error) => {
    console.error(formatErrorCauseChain(error));
    process.exitCode = 1;
  });
}
