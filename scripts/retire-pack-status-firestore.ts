import { createHash, createPrivateKey, createPublicKey, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { FieldPath, Firestore, Timestamp } from '@google-cloud/firestore';
import {
  PACK_STATUS_SUPPORTED_DROP_IDS,
  type PackStatusCounters,
} from '../shared/packStatus.ts';
import {
  firestoreWriterServiceAccountEmail,
  readCloudflareFirestoreKeychainCredential,
} from './cloudflare-firestore-keychain.ts';
import {
  currentD1Bookmark,
  queryD1,
  readD1Integrity,
  type D1IntegrityReport,
} from './migrate-pack-status-to-d1.ts';
import {
  readWranglerDeploymentStatus,
  stableCloudflareVersionId,
} from './cloudflare-deployment-state.ts';
import {
  readReleaseManifest,
  requireProductionEvidence,
  type ReleaseManifest,
} from './finalize-cloudflare-release.ts';

type PackStatusRetirementCredentialArgs = {
  firestoreWriterServiceAccountFile?: string;
};

export type PackStatusRetirementArgs = PackStatusRetirementCredentialArgs & (
  | { mode: 'dry-run' }
  | { mode: 'confirm'; apiVersionId: string }
);

export type PackStatusRetirementFirestore = {
  deleteEventDocumentPaths: (paths: readonly string[]) => void | Promise<void>;
  deleteSummaryDocuments: (
    documents: readonly { path: string; updateTime: string }[],
  ) => void | Promise<void>;
  listEventDocuments: (
    dropId: string,
    afterId: string | undefined,
    limit: number,
  ) => readonly { id: string; data: Record<string, unknown> }[] |
    Promise<readonly { id: string; data: Record<string, unknown> }[]>;
  readSummary: (dropId: string) => {
    data: Record<string, unknown>;
    updateTime: string;
  } | null | Promise<{
    data: Record<string, unknown>;
    updateTime: string;
  } | null>;
};

type FirestoreSummarySnapshot = {
  counters: PackStatusCounters;
  updateTime: string;
};

type FirestoreDropSnapshot = {
  dropId: string;
  events: Array<{ id: string; payloadSha256: string }>;
  summary: FirestoreSummarySnapshot | null;
};

type FirestoreSnapshot = {
  drops: FirestoreDropSnapshot[];
  eventCount: number;
  summaryCount: number;
};

type RetirementD1Snapshot = {
  cacheGeneration: number;
  drops: Array<{
    counters: PackStatusCounters;
    dropId: string;
    eventHashes: string[];
    eventSetSha256: string;
    eventCount: number;
  }>;
  eventCount: number;
};

export type PackStatusRetirementDeltas = {
  redeemedIrlNormal: number;
  redeemedIrlStripe: number;
  redeemedUnsealedCards: number;
  unsealedOnline: number;
};

export type PackStatusRetirementD1Event = {
  applyDelta: 0 | 1;
  d1PayloadSha256: string;
  deltas: PackStatusRetirementDeltas;
  documentId: string;
  dropId: string;
  payloadSha256: string;
};

type RetirementFirestoreBefore = {
  drops: Array<{
    counters: PackStatusCounters;
    d1OnlyDeltas: PackStatusRetirementDeltas;
    d1OnlyEventCount: number;
    dropId: string;
    eventHashes: string[];
    eventCount: number;
    summaryPresent: true;
    updateTime: string;
  }>;
  eventCount: number;
  summaryCount: number;
};

type RetirementPostDelete = {
  drops: Array<{
    dropId: string;
    eventCount: 0;
    summaryPresent: false;
  }>;
  eventCount: 0;
  summaryCount: 0;
  verifiedAt: string;
};

export type PackStatusRetirementReceipt = {
  apiVersionId: string;
  completedAt: string | null;
  d1: RetirementD1Snapshot;
  d1Bookmark: string;
  finalD1Bookmark: string | null;
  firestoreBefore: RetirementFirestoreBefore;
  plannedAt: string;
  postDelete: RetirementPostDelete | null;
  schemaVersion: 1;
  status: 'planned' | 'completed';
};

export type PackStatusRetirementDependencies = {
  currentD1Bookmark: () => string | Promise<string>;
  firestore: PackStatusRetirementFirestore;
  log: (message: string) => void;
  now: () => Date;
  readD1Events: () => readonly PackStatusRetirementD1Event[] | Promise<readonly PackStatusRetirementD1Event[]>;
  readD1Integrity: () => D1IntegrityReport | Promise<D1IntegrityReport>;
  readReceipt: () => PackStatusRetirementReceipt | undefined;
  verifyApiVersion: (apiVersionId: string) => void | Promise<void>;
  writeReceipt: (
    next: PackStatusRetirementReceipt,
    expected: PackStatusRetirementReceipt | undefined,
  ) => void;
};

export type PackStatusRetirementResult =
  | {
      d1: RetirementD1Snapshot;
      firestore: RetirementFirestoreBefore;
      mode: 'dry-run';
    }
  | {
      mode: 'receipt';
      receipt: PackStatusRetirementReceipt;
    };

export type FirestoreCredential = {
  client_email: string;
  private_key: string;
  project_id: string;
};

const confirmationPhrase = 'RETIRE_FIRESTORE_PACK_STATUS';
const projectId = 'mons-shop';
const pageSize = 250;
const retirementSmokeOwner = 'A87Upx1f1whNV5P8xQCK2YUTwE3uMYigjoKJAF3jiNpz';
const candidateRecordMaxAgeMs = 6 * 60 * 60 * 1000;
const candidateRecordClockSkewMs = 5 * 60 * 1000;
const gitCommitPattern = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const apiConfigArgs = [
  '--config',
  'cloud/workers/api/wrangler.jsonc',
  '--env-file',
  'cloud/workers/api/release.env',
] as const;
const frontendConfigArgs = ['--config', 'wrangler.jsonc'] as const;
const cloudflareVersionIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const sha256Pattern = /^[0-9a-f]{64}$/;
const firestoreUpdateTimePattern = /^\d+:\d{1,9}$/;
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const wranglerBinary = resolve(
  repoRoot,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'wrangler.cmd' : 'wrangler',
);
const candidateRecordDirectory = resolve(repoRoot, '.cache', 'mons-shop-api-candidates');
export const packStatusRetirementReceiptPath = resolve(
  repoRoot,
  'cloud',
  'pack-status-firestore-retirement.json',
);
const supportedDropIds = [...PACK_STATUS_SUPPORTED_DROP_IDS].sort();

function fail(message: string): never {
  throw new Error(message);
}

function usage(): string {
  return [
    'Usage:',
    '  node --import tsx scripts/retire-pack-status-firestore.ts --dry-run [--firestore-writer-service-account-file <path>]',
    `  node --import tsx scripts/retire-pack-status-firestore.ts --confirm ${confirmationPhrase} --api-version-id <uuid> [--firestore-writer-service-account-file <path>]`,
  ].join('\n');
}

export function parsePackStatusRetirementArgs(argv: string[]): PackStatusRetirementArgs {
  let dryRun = false;
  let confirmation: string | undefined;
  let apiVersionId: string | undefined;
  let firestoreWriterServiceAccountFile: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (option === '--dry-run') {
      if (dryRun) fail('--dry-run may only be provided once.');
      dryRun = true;
      continue;
    }
    if (
      option !== '--confirm' &&
      option !== '--api-version-id' &&
      option !== '--firestore-writer-service-account-file'
    ) {
      fail(`Unknown argument: ${option}\n\n${usage()}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) fail(`Missing value for ${option}.`);
    index += 1;
    if (option === '--confirm') {
      if (confirmation !== undefined) fail('--confirm may only be provided once.');
      confirmation = value;
    } else if (option === '--api-version-id') {
      if (apiVersionId !== undefined) fail('--api-version-id may only be provided once.');
      apiVersionId = value;
    } else {
      if (firestoreWriterServiceAccountFile !== undefined) {
        fail('--firestore-writer-service-account-file may only be provided once.');
      }
      firestoreWriterServiceAccountFile = value;
    }
  }
  if (dryRun) {
    if (confirmation !== undefined || apiVersionId !== undefined) {
      fail('--dry-run cannot be combined with confirmation arguments.');
    }
    return {
      mode: 'dry-run',
      ...(firestoreWriterServiceAccountFile ? { firestoreWriterServiceAccountFile } : {}),
    };
  }
  if (confirmation !== confirmationPhrase) {
    fail(`Confirmed retirement requires --confirm ${confirmationPhrase}.`);
  }
  if (!apiVersionId || !cloudflareVersionIdPattern.test(apiVersionId)) {
    fail('Confirmed retirement requires --api-version-id with an exact UUID.');
  }
  return {
    mode: 'confirm',
    apiVersionId: apiVersionId.toLowerCase(),
    ...(firestoreWriterServiceAccountFile ? { firestoreWriterServiceAccountFile } : {}),
  };
}

export type PackStatusRetirementApiVersionDependencies = {
  readLiveApiVersion: () => string;
  readLiveFrontendVersion: () => string;
  readManifest: () => ReleaseManifest;
  requireApiEvidence: (apiVersionId: string) => unknown;
  verifyCandidate: (apiVersionId: string, writerPublicKeySha256: string) => void;
  verifyFirestoreRulesDenyPackStatus: () => void | Promise<void>;
};

type RetirementCandidateRecord = {
  directHeliusMedianMs: number;
  firestoreWriterPublicKeySha256: string;
  includeDevnet: true;
  previewUrl: string;
  runs: 5;
  smokeOwner: string;
  sourceCommit: string;
  testedAt: string;
  versionId: string;
  workerMedianMs: number;
  workerName: 'mons-shop-api';
};

export type PackStatusRetirementCandidateDependencies = {
  gitDiffPaths: (sourceCommit: string) => string[];
  gitIsAncestor: (sourceCommit: string) => boolean;
  readHeadCommit: () => string;
  readCandidate: (apiVersionId: string) => unknown;
  readRemoteMainCommit: () => string;
  readWorktreePaths: () => string[];
};

function gitOutput(args: readonly string[]): string {
  const result = spawnSync('git', [...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    killSignal: 'SIGKILL',
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 15_000,
  });
  if (result.status !== 0) fail(`Git verification failed while running ${args[0]}.`);
  return String(result.stdout || '').trim();
}

function candidateRecordPath(apiVersionId: string): string {
  return resolve(candidateRecordDirectory, `${apiVersionId.toLowerCase()}.json`);
}

function readCandidate(apiVersionId: string): unknown {
  const path = candidateRecordPath(apiVersionId);
  let entry;
  try {
    entry = lstatSync(path);
  } catch {
    return fail('The exact API candidate record is missing.');
  }
  if (
    !entry.isFile() ||
    entry.isSymbolicLink() ||
    (entry.mode & 0o077) !== 0 ||
    entry.size <= 0 ||
    entry.size > 64 * 1024
  ) {
    fail('The exact API candidate record is not a private regular file.');
  }
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return fail('The exact API candidate record is invalid JSON.');
  }
}

function isRetirementCandidateRecord(
  value: unknown,
  apiVersionId: string,
  writerPublicKeySha256: string,
  now = new Date(),
): value is RetirementCandidateRecord {
  if (!isRecord(value) || !exactKeys(value, [
    'directHeliusMedianMs',
    'firestoreWriterPublicKeySha256',
    'includeDevnet',
    'previewUrl',
    'runs',
    'smokeOwner',
    'sourceCommit',
    'testedAt',
    'versionId',
    'workerMedianMs',
    'workerName',
  ])) return false;
  const testedAt = typeof value.testedAt === 'string' ? Date.parse(value.testedAt) : Number.NaN;
  const ageMs = now.getTime() - testedAt;
  const expectedPreviewUrl = `https://${apiVersionId.slice(0, 8).toLowerCase()}-mons-shop-api.lil-org.workers.dev`;
  return value.workerName === 'mons-shop-api' &&
    value.includeDevnet === true &&
    value.versionId === apiVersionId.toLowerCase() &&
    value.previewUrl === expectedPreviewUrl &&
    value.smokeOwner === retirementSmokeOwner &&
    typeof value.sourceCommit === 'string' && gitCommitPattern.test(value.sourceCommit) &&
    value.firestoreWriterPublicKeySha256 === writerPublicKeySha256 &&
    Number.isFinite(now.getTime()) && Number.isFinite(testedAt) &&
    ageMs >= -candidateRecordClockSkewMs && ageMs <= candidateRecordMaxAgeMs &&
    value.runs === 5 &&
    typeof value.workerMedianMs === 'number' && Number.isFinite(value.workerMedianMs) && value.workerMedianMs >= 0 &&
    typeof value.directHeliusMedianMs === 'number' && Number.isFinite(value.directHeliusMedianMs) &&
    value.directHeliusMedianMs >= 0 && value.workerMedianMs < value.directHeliusMedianMs;
}

export function verifyPackStatusRetirementCandidate(
  apiVersionId: string,
  writerPublicKeySha256: string,
  dependencies: PackStatusRetirementCandidateDependencies = {
    gitDiffPaths: (sourceCommit) => {
      const output = gitOutput(['diff', '--name-only', `${sourceCommit}..HEAD`, '--']);
      return output ? output.split('\n') : [];
    },
    gitIsAncestor: (sourceCommit) => spawnSync(
      'git',
      ['merge-base', '--is-ancestor', sourceCommit, 'HEAD'],
      {
        cwd: repoRoot,
        encoding: 'utf8',
        killSignal: 'SIGKILL',
        shell: false,
        stdio: 'ignore',
        timeout: 15_000,
      },
    ).status === 0,
    readHeadCommit: () => gitOutput(['rev-parse', '--verify', 'HEAD']).toLowerCase(),
    readCandidate,
    readRemoteMainCommit: () => {
      const output = gitOutput(['ls-remote', '--heads', 'origin', 'refs/heads/main']);
      return output.split(/\s+/, 1)[0]?.toLowerCase() || '';
    },
    readWorktreePaths: () => {
      const output = gitOutput(['status', '--porcelain', '--untracked-files=all']);
      return output ? output.split('\n').map((entry) => entry.slice(3)) : [];
    },
  },
): RetirementCandidateRecord {
  const normalizedVersionId = apiVersionId.toLowerCase();
  if (!cloudflareVersionIdPattern.test(normalizedVersionId) || !sha256Pattern.test(writerPublicKeySha256)) {
    fail('Candidate binding requires exact API and writer-key hashes.');
  }
  const candidate = dependencies.readCandidate(normalizedVersionId);
  if (!isRetirementCandidateRecord(candidate, normalizedVersionId, writerPublicKeySha256)) {
    fail('The API candidate record is missing, stale, mismatched, or failed its benchmark.');
  }
  if (!dependencies.gitIsAncestor(candidate.sourceCommit)) {
    fail('The API candidate source commit is not an ancestor of HEAD.');
  }
  const headCommit = dependencies.readHeadCommit();
  const remoteMainCommit = dependencies.readRemoteMainCommit();
  if (
    !gitCommitPattern.test(headCommit) ||
    !gitCommitPattern.test(remoteMainCommit) ||
    headCommit !== remoteMainCommit
  ) fail('Local HEAD is not the exact published origin/main commit.');
  const descendantPaths = dependencies.gitDiffPaths(candidate.sourceCommit);
  if (descendantPaths.some((path) => path !== 'cloud/release-manifest.json')) {
    fail('Tracked code changed after the reviewed API candidate source commit.');
  }
  const worktreePaths = dependencies.readWorktreePaths();
  if (worktreePaths.some((path) => path !== 'cloud/pack-status-firestore-retirement.json')) {
    fail('The retirement worktree contains unrelated uncommitted changes.');
  }
  return candidate;
}

function readLiveWorkerVersion(configArgs: readonly string[]): string {
  const apiToken = String(process.env.CLOUDFLARE_API_TOKEN || '').trim();
  if (!apiToken) fail('CLOUDFLARE_API_TOKEN is required to verify the live API before retirement.');
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    CLOUDFLARE_API_TOKEN: apiToken,
    WRANGLER_LOG_SANITIZE: 'true',
    WRANGLER_SEND_ERROR_REPORTS: 'false',
    WRANGLER_SEND_METRICS: 'false',
  };
  for (const name of [
    'FIRESTORE_SERVICE_ACCOUNT_JSON',
    'FIRESTORE_WRITER_SERVICE_ACCOUNT_JSON',
    'GOOGLE_APPLICATION_CREDENTIALS',
  ]) Reflect.deleteProperty(environment, name);
  return stableCloudflareVersionId(readWranglerDeploymentStatus({
    configArgs,
    cwd: repoRoot,
    environment,
    wranglerBinary,
  }));
}

function readLiveApiVersion(): string {
  return readLiveWorkerVersion(apiConfigArgs);
}

function readLiveFrontendVersion(): string {
  return readLiveWorkerVersion(frontendConfigArgs);
}

async function verifyFirestoreRulesDenyPackStatus(): Promise<void> {
  for (const dropId of supportedDropIds) {
    let response: Response;
    try {
      response = await fetch(
        `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/` +
          `drops/${encodeURIComponent(dropId)}/meta/packStatus`,
        {
          headers: { Accept: 'application/json' },
          method: 'GET',
          redirect: 'manual',
          signal: AbortSignal.timeout(15_000),
        },
      );
    } catch {
      fail(`Firestore public-rule verification was ambiguous for ${dropId}.`);
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      fail(`Firestore public-rule verification returned invalid JSON for ${dropId}.`);
    }
    const error = isRecord(payload) && isRecord(payload.error) ? payload.error : null;
    if (response.status !== 403 || error?.status !== 'PERMISSION_DENIED') {
      fail(`Firestore public pack-status reads are not proven denied for ${dropId}.`);
    }
  }
}

export async function verifyPackStatusRetirementApiVersion(
  apiVersionId: string,
  writerPublicKeySha256: string,
  dependencies: PackStatusRetirementApiVersionDependencies = {
    readLiveApiVersion,
    readLiveFrontendVersion,
    readManifest: readReleaseManifest,
    requireApiEvidence: (versionId) => requireProductionEvidence('api', versionId),
    verifyCandidate: verifyPackStatusRetirementCandidate,
    verifyFirestoreRulesDenyPackStatus,
  },
): Promise<void> {
  if (!cloudflareVersionIdPattern.test(apiVersionId)) {
    fail('Retirement API verification requires an exact version UUID.');
  }
  const expected = apiVersionId.toLowerCase();
  const manifest = dependencies.readManifest();
  if (manifest.currentProduction.apiVersionId.toLowerCase() !== expected) {
    fail('The retirement API version does not match the tracked current production API.');
  }
  if (
    manifest.approvedRollback.apiVersionId.toLowerCase() !==
      manifest.currentProduction.apiVersionId.toLowerCase() ||
    manifest.approvedRollback.frontendVersionId.toLowerCase() !==
      manifest.currentProduction.frontendVersionId.toLowerCase()
  ) {
    fail('The approved recovery pair must exactly match current production before Firestore retirement.');
  }
  dependencies.requireApiEvidence(expected);
  dependencies.verifyCandidate(expected, writerPublicKeySha256);
  const liveVersionId = dependencies.readLiveApiVersion().toLowerCase();
  if (liveVersionId !== expected) {
    fail(`Cloudflare reports API ${liveVersionId}, not the requested retirement API ${expected}.`);
  }
  const expectedFrontendVersionId = manifest.currentProduction.frontendVersionId.toLowerCase();
  const liveFrontendVersionId = dependencies.readLiveFrontendVersion().toLowerCase();
  if (liveFrontendVersionId !== expectedFrontendVersionId) {
    fail(
      `Cloudflare reports frontend ${liveFrontendVersionId}, not tracked production frontend ` +
      `${expectedFrontendVersionId}.`,
    );
  }
  await dependencies.verifyFirestoreRulesDenyPackStatus();
}

function requireSupportedDropId(dropId: string): string {
  if (!PACK_STATUS_SUPPORTED_DROP_IDS.includes(dropId as never)) {
    fail(`Unsupported pack-status retirement drop: ${dropId}.`);
  }
  return dropId;
}

export function packStatusEventCollectionPath(dropId: string): string {
  return `drops/${requireSupportedDropId(dropId)}/packStatusEvents`;
}

export function packStatusSummaryDocumentPath(dropId: string): string {
  return `drops/${requireSupportedDropId(dropId)}/meta/packStatus`;
}

export function isAllowedPackStatusRetirementDeletePath(path: string): boolean {
  const parts = path.split('/');
  if (parts.length !== 4 || parts[0] !== 'drops') return false;
  if (!PACK_STATUS_SUPPORTED_DROP_IDS.includes(parts[1] as never)) return false;
  if (parts[2] === 'meta') return parts[3] === 'packStatus';
  return parts[2] === 'packStatusEvents' && Boolean(parts[3]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return Object.keys(value).sort().join('\0') === [...expected].sort().join('\0');
}

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function nonnegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function isFirestoreUpdateTime(value: unknown): value is string {
  if (typeof value !== 'string' || !firestoreUpdateTimePattern.test(value)) return false;
  const [seconds, nanoseconds] = value.split(':').map(Number);
  return positiveInteger(seconds) &&
    nonnegativeInteger(nanoseconds) &&
    nanoseconds < 1_000_000_000;
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

type CanonicalPackStatusEvent = {
  boxAssetId: string | null;
  checkoutSessionId: string | null;
  createdAtMs: number;
  deliveryId: number | null;
  dropId: string;
  eventKey: string;
  increments: PackStatusRetirementDeltas;
  quantity: number;
  signature: string | null;
  type: 'onlineReveal' | 'redeemedIrlNormal' | 'redeemedIrlStripe';
};

function optionalEventString(value: unknown, label: string): string | null {
  if (value == null) return null;
  if (typeof value !== 'string' || !value) fail(`${label} must be a non-empty string when present.`);
  return value;
}

function firestoreEventTimestampMs(value: unknown, label: string): number {
  if (!(value instanceof Timestamp)) fail(`${label} must be a Firestore timestamp.`);
  const milliseconds = value.toMillis();
  if (!nonnegativeInteger(milliseconds)) fail(`${label} must resolve to a safe timestamp.`);
  return milliseconds;
}

function packStatusEventType(value: unknown): CanonicalPackStatusEvent['type'] {
  if (value === 'onlineReveal' || value === 'redeemedIrlNormal' || value === 'redeemedIrlStripe') return value;
  return fail('Pack-status event type is invalid.');
}

function firestorePackStatusEvent(
  dropId: string,
  documentId: string,
  data: Record<string, unknown>,
): CanonicalPackStatusEvent {
  const type = packStatusEventType(data.type);
  const eventKey = optionalEventString(data.eventKey, `${documentId}.eventKey`);
  if (
    data.version !== 1 ||
    !eventKey ||
    data.dropId !== dropId ||
    documentId !== `${type}_${encodeURIComponent(eventKey)}`
  ) {
    fail(`Firestore pack-status event identity is invalid for ${documentId}.`);
  }
  const rawIncrements = data.increments;
  let increments: PackStatusRetirementDeltas;
  if (rawIncrements == null && type === 'onlineReveal') {
    increments = { ...zeroDeltas(), unsealedOnline: 1 };
  } else {
    if (!isRecord(rawIncrements)) fail(`${documentId}.increments must be an object.`);
    increments = {
      unsealedOnline: Number(rawIncrements.unsealedOnline ?? 0),
      redeemedIrlNormal: Number(rawIncrements.redeemedIrlNormal ?? 0),
      redeemedIrlStripe: Number(rawIncrements.redeemedIrlStripe ?? 0),
      redeemedUnsealedCards: Number(rawIncrements.redeemedUnsealedCards ?? 0),
    };
  }
  if (!isRetirementDeltas(increments) || Object.values(increments).every((delta) => delta === 0)) {
    fail(`${documentId}.increments are invalid.`);
  }
  const quantity = Number(data.quantity);
  const deliveryId = data.deliveryId == null ? null : Number(data.deliveryId);
  if (!positiveInteger(quantity) || (deliveryId !== null && !positiveInteger(deliveryId))) {
    fail(`${documentId} contains invalid quantities.`);
  }
  return {
    boxAssetId: optionalEventString(data.boxAssetId, `${documentId}.boxAssetId`),
    checkoutSessionId: optionalEventString(data.checkoutSessionId, `${documentId}.checkoutSessionId`),
    createdAtMs: firestoreEventTimestampMs(data.createdAt, `${documentId}.createdAt`),
    deliveryId,
    dropId,
    eventKey,
    increments,
    quantity,
    signature: optionalEventString(data.signature, `${documentId}.signature`),
    type,
  };
}

function packStatusEventPayloadSha256(event: CanonicalPackStatusEvent): string {
  const { createdAtMs: _createdAtMs, ...semantic } = event;
  return createHash('sha256').update(canonical(semantic)).digest('hex');
}

function d1PackStatusEventPayloadSha256(event: CanonicalPackStatusEvent): string {
  return createHash('sha256').update(canonical(event)).digest('hex');
}

function isPackStatusCounters(value: unknown, dropId: string): value is PackStatusCounters {
  if (!isRecord(value) || !exactKeys(value, [
    'cardsPerPack',
    'dropId',
    'redeemedIrlNormal',
    'redeemedIrlStripe',
    'redeemedUnsealedCards',
    'totalCards',
    'totalInitialSupply',
    'unsealedOnline',
  ])) return false;
  return value.dropId === dropId &&
    positiveInteger(value.totalInitialSupply) &&
    positiveInteger(value.totalCards) &&
    positiveInteger(value.cardsPerPack) &&
    value.totalCards === value.totalInitialSupply * value.cardsPerPack &&
    nonnegativeInteger(value.unsealedOnline) &&
    nonnegativeInteger(value.redeemedIrlNormal) &&
    nonnegativeInteger(value.redeemedIrlStripe) &&
    nonnegativeInteger(value.redeemedUnsealedCards);
}

function isSortedSha256Values(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((hash, index) => (
    typeof hash === 'string' &&
    sha256Pattern.test(hash) &&
    (index === 0 || hash > value[index - 1])
  ));
}

function isD1Snapshot(value: unknown): value is RetirementD1Snapshot {
  if (!isRecord(value) || !exactKeys(value, ['cacheGeneration', 'drops', 'eventCount'])) return false;
  if (!positiveInteger(value.cacheGeneration) || !nonnegativeInteger(value.eventCount) || !Array.isArray(value.drops)) {
    return false;
  }
  if (value.drops.length !== supportedDropIds.length) return false;
  let total = 0;
  for (let index = 0; index < supportedDropIds.length; index += 1) {
    const drop = value.drops[index];
    const dropId = supportedDropIds[index];
    if (
      !isRecord(drop) ||
      !exactKeys(drop, [
        'counters',
        'dropId',
        'eventCount',
        'eventHashes',
        'eventSetSha256',
      ]) ||
      drop.dropId !== dropId ||
      !nonnegativeInteger(drop.eventCount) ||
      !isSortedSha256Values(drop.eventHashes) ||
      drop.eventHashes.length !== drop.eventCount ||
      typeof drop.eventSetSha256 !== 'string' ||
      !sha256Pattern.test(drop.eventSetSha256) ||
      eventSetSha256(drop.eventHashes) !== drop.eventSetSha256 ||
      !isPackStatusCounters(drop.counters, dropId)
    ) return false;
    total += drop.eventCount;
  }
  return total === value.eventCount;
}

function isRetirementDeltas(value: unknown): value is PackStatusRetirementDeltas {
  return isRecord(value) && exactKeys(value, [
    'redeemedIrlNormal',
    'redeemedIrlStripe',
    'redeemedUnsealedCards',
    'unsealedOnline',
  ]) &&
    nonnegativeInteger(value.redeemedIrlNormal) &&
    nonnegativeInteger(value.redeemedIrlStripe) &&
    nonnegativeInteger(value.redeemedUnsealedCards) &&
    nonnegativeInteger(value.unsealedOnline);
}

function countersWithDeltas(
  counters: PackStatusCounters,
  deltas: PackStatusRetirementDeltas,
): PackStatusCounters {
  const next = {
    ...counters,
    unsealedOnline: counters.unsealedOnline + deltas.unsealedOnline,
    redeemedIrlNormal: counters.redeemedIrlNormal + deltas.redeemedIrlNormal,
    redeemedIrlStripe: counters.redeemedIrlStripe + deltas.redeemedIrlStripe,
    redeemedUnsealedCards: counters.redeemedUnsealedCards + deltas.redeemedUnsealedCards,
  };
  if (!isPackStatusCounters(next, counters.dropId)) fail('Pack-status retirement deltas overflowed safe counters.');
  return next;
}

function isFirestoreBefore(value: unknown): value is RetirementFirestoreBefore {
  if (!isRecord(value) || !exactKeys(value, ['drops', 'eventCount', 'summaryCount'])) return false;
  if (
    value.summaryCount !== supportedDropIds.length ||
    !nonnegativeInteger(value.eventCount) ||
    !Array.isArray(value.drops) ||
    value.drops.length !== supportedDropIds.length
  ) return false;
  let total = 0;
  for (let index = 0; index < supportedDropIds.length; index += 1) {
    const drop = value.drops[index];
    if (
      !isRecord(drop) ||
      !exactKeys(drop, [
        'counters',
        'd1OnlyDeltas',
        'd1OnlyEventCount',
        'dropId',
        'eventHashes',
        'eventCount',
        'summaryPresent',
        'updateTime',
      ]) ||
      drop.dropId !== supportedDropIds[index] ||
      !nonnegativeInteger(drop.eventCount) ||
      !isSortedSha256Values(drop.eventHashes) ||
      drop.eventHashes.length !== drop.eventCount ||
      !nonnegativeInteger(drop.d1OnlyEventCount) ||
      !isRetirementDeltas(drop.d1OnlyDeltas) ||
      !isPackStatusCounters(drop.counters, supportedDropIds[index]) ||
      !isFirestoreUpdateTime(drop.updateTime) ||
      drop.summaryPresent !== true
    ) return false;
    total += drop.eventCount;
  }
  return total === value.eventCount;
}

function isPostDelete(value: unknown): value is RetirementPostDelete {
  if (!isRecord(value) || !exactKeys(value, ['drops', 'eventCount', 'summaryCount', 'verifiedAt'])) return false;
  if (value.summaryCount !== 0 || value.eventCount !== 0 || !isIsoTimestamp(value.verifiedAt)) return false;
  if (!Array.isArray(value.drops) || value.drops.length !== supportedDropIds.length) return false;
  return value.drops.every((drop, index) => isRecord(drop) &&
    exactKeys(drop, ['dropId', 'eventCount', 'summaryPresent']) &&
    drop.dropId === supportedDropIds[index] &&
    drop.eventCount === 0 &&
    drop.summaryPresent === false);
}

export function isPackStatusRetirementReceipt(value: unknown): value is PackStatusRetirementReceipt {
  if (!isRecord(value) || !exactKeys(value, [
    'apiVersionId',
    'completedAt',
    'd1',
    'd1Bookmark',
    'finalD1Bookmark',
    'firestoreBefore',
    'plannedAt',
    'postDelete',
    'schemaVersion',
    'status',
  ])) return false;
  if (
    value.schemaVersion !== 1 ||
    (value.status !== 'planned' && value.status !== 'completed') ||
    typeof value.apiVersionId !== 'string' ||
    !cloudflareVersionIdPattern.test(value.apiVersionId) ||
    typeof value.d1Bookmark !== 'string' ||
    !value.d1Bookmark ||
    !isIsoTimestamp(value.plannedAt) ||
    !isD1Snapshot(value.d1) ||
    !isFirestoreBefore(value.firestoreBefore)
  ) return false;
  const d1 = value.d1;
  const firestoreBefore = value.firestoreBefore;
  try {
    if (d1.drops.some((drop, index) => {
      const frozen = firestoreBefore.drops[index];
      return drop.dropId !== frozen.dropId ||
        drop.eventCount !== frozen.eventCount + frozen.d1OnlyEventCount ||
        canonical(drop.counters) !== canonical(countersWithDeltas(frozen.counters, frozen.d1OnlyDeltas));
    })) return false;
  } catch {
    return false;
  }
  if (value.status === 'planned') {
    return value.completedAt === null && value.finalD1Bookmark === null && value.postDelete === null;
  }
  return isIsoTimestamp(value.completedAt) &&
    typeof value.finalD1Bookmark === 'string' &&
    Boolean(value.finalD1Bookmark) &&
    isPostDelete(value.postDelete);
}

function parseFirestoreSummary(dropId: string, value: Record<string, unknown> | null): PackStatusCounters | null {
  if (value === null) return null;
  const counters: PackStatusCounters = {
    dropId,
    totalInitialSupply: Number(value.totalInitialSupply),
    totalCards: Number(value.totalCards),
    cardsPerPack: Number(value.cardsPerPack),
    unsealedOnline: Number(value.unsealedOnline),
    redeemedIrlNormal: Number(value.redeemedIrlNormal),
    redeemedIrlStripe: Number(value.redeemedIrlStripe),
    redeemedUnsealedCards: Number(value.redeemedUnsealedCards),
  };
  if (value.version !== 1 || value.dropId !== dropId || !isPackStatusCounters(counters, dropId)) {
    fail(`Firestore pack-status summary is invalid for ${dropId}.`);
  }
  return counters;
}

function requireFirestoreUpdateTime(value: string, dropId: string): string {
  if (!isFirestoreUpdateTime(value)) {
    fail(`Firestore pack-status summary updateTime is invalid for ${dropId}.`);
  }
  return value;
}

function firestoreTimestampToken(value: Timestamp): string {
  return `${value.seconds}:${value.nanoseconds}`;
}

function firestoreTimestampFromToken(value: string): Timestamp {
  if (!isFirestoreUpdateTime(value)) fail('Firestore summary delete updateTime is invalid.');
  const [seconds, nanoseconds] = value.split(':').map(Number);
  return new Timestamp(seconds, nanoseconds);
}

function validateEventDocumentPage(
  dropId: string,
  page: readonly { id: string; data: Record<string, unknown> }[],
  afterId: string | undefined,
): Array<{ id: string; payloadSha256: string }> {
  if (page.length > pageSize) fail(`Firestore returned an oversized event page for ${dropId}.`);
  const ids = page.map((document) => String(document.id));
  for (let index = 0; index < ids.length; index += 1) {
    const id = ids[index];
    if (!id || id.includes('/') || (afterId !== undefined && id <= afterId) || (index > 0 && id <= ids[index - 1])) {
      fail(`Firestore returned an invalid event page for ${dropId}.`);
    }
  }
  return page.map((document, index) => ({
    id: ids[index],
    payloadSha256: packStatusEventPayloadSha256(
      firestorePackStatusEvent(dropId, ids[index], document.data),
    ),
  }));
}

async function readFirestoreSnapshot(firestore: PackStatusRetirementFirestore): Promise<FirestoreSnapshot> {
  const drops: FirestoreDropSnapshot[] = [];
  for (const dropId of supportedDropIds) {
    const events: Array<{ id: string; payloadSha256: string }> = [];
    let afterId: string | undefined;
    while (true) {
      const page = validateEventDocumentPage(
        dropId,
        await firestore.listEventDocuments(dropId, afterId, pageSize),
        afterId,
      );
      events.push(...page);
      if (page.length < pageSize) break;
      afterId = page.at(-1)?.id;
    }
    const summary = await firestore.readSummary(dropId);
    drops.push({
      dropId,
      events,
      summary: summary ? {
        counters: parseFirestoreSummary(dropId, summary.data)!,
        updateTime: requireFirestoreUpdateTime(summary.updateTime, dropId),
      } : null,
    });
  }
  return {
    drops,
    eventCount: drops.reduce((total, drop) => total + drop.events.length, 0),
    summaryCount: drops.filter((drop) => drop.summary !== null).length,
  };
}

function eventSetSha256(hashes: readonly string[]): string {
  return createHash('sha256').update(JSON.stringify(hashes)).digest('hex');
}

function firestoreEventHash(id: string, payloadSha256: string): string {
  return createHash('sha256').update(`${id}\0${payloadSha256}`).digest('hex');
}

function d1EventHash(event: PackStatusRetirementD1Event): string {
  return createHash('sha256')
    .update(`${event.documentId}\0${event.d1PayloadSha256}\0${event.applyDelta}`)
    .digest('hex');
}

function zeroDeltas(): PackStatusRetirementDeltas {
  return {
    unsealedOnline: 0,
    redeemedIrlNormal: 0,
    redeemedIrlStripe: 0,
    redeemedUnsealedCards: 0,
  };
}

function addDeltas(
  total: PackStatusRetirementDeltas,
  next: PackStatusRetirementDeltas,
): PackStatusRetirementDeltas {
  const combined = {
    unsealedOnline: total.unsealedOnline + next.unsealedOnline,
    redeemedIrlNormal: total.redeemedIrlNormal + next.redeemedIrlNormal,
    redeemedIrlStripe: total.redeemedIrlStripe + next.redeemedIrlStripe,
    redeemedUnsealedCards: total.redeemedUnsealedCards + next.redeemedUnsealedCards,
  };
  if (!isRetirementDeltas(combined)) fail('D1-only pack-status deltas overflowed safe integers.');
  return combined;
}

function normalizedD1Events(
  value: readonly PackStatusRetirementD1Event[],
): Map<string, PackStatusRetirementD1Event[]> {
  const byDrop = new Map(supportedDropIds.map((dropId) => [dropId, [] as PackStatusRetirementD1Event[]]));
  for (const event of value) {
    if (
      !isRecord(event) ||
      !exactKeys(event, [
        'applyDelta',
        'd1PayloadSha256',
        'deltas',
        'documentId',
        'dropId',
        'payloadSha256',
      ]) ||
      !PACK_STATUS_SUPPORTED_DROP_IDS.includes(event.dropId as never) ||
      !event.documentId ||
      event.documentId.includes('/') ||
      (event.applyDelta !== 0 && event.applyDelta !== 1) ||
      !sha256Pattern.test(event.d1PayloadSha256) ||
      !sha256Pattern.test(event.payloadSha256) ||
      !isRetirementDeltas(event.deltas) ||
      Object.values(event.deltas).every((delta) => delta === 0)
    ) fail('D1 returned an invalid pack-status event for retirement.');
    byDrop.get(event.dropId as (typeof supportedDropIds)[number])!.push(event);
  }
  for (const [dropId, events] of byDrop) {
    events.sort((left, right) => left.documentId.localeCompare(right.documentId));
    if (events.some((event, index) => index > 0 && event.documentId === events[index - 1].documentId)) {
      fail(`D1 returned duplicate pack-status event identities for ${dropId}.`);
    }
  }
  return byDrop;
}

function d1Snapshot(
  report: D1IntegrityReport,
  eventsByDrop: Map<string, PackStatusRetirementD1Event[]>,
): RetirementD1Snapshot {
  const byDrop = new Map(report.drops.map((drop) => [drop.dropId, drop]));
  const drops = supportedDropIds.map((dropId) => {
    const drop = byDrop.get(dropId);
    if (!drop) fail(`D1 integrity report is missing ${dropId}.`);
    const events = eventsByDrop.get(dropId)!;
    if (events.length !== drop.eventCount) fail(`D1 event identity count is inconsistent for ${dropId}.`);
    const hashes = events.map(d1EventHash).sort();
    return {
      counters: drop.counters,
      dropId,
      eventHashes: hashes,
      eventSetSha256: eventSetSha256(hashes),
      eventCount: drop.eventCount,
    };
  });
  const snapshot = {
    cacheGeneration: report.cacheGeneration,
    drops,
    eventCount: report.eventCount,
  };
  if (!isD1Snapshot(snapshot)) fail('D1 integrity report cannot be recorded for retirement.');
  return snapshot;
}

function canonical(value: unknown): string {
  return JSON.stringify(value);
}

function assertInitialParity(
  d1: RetirementD1Snapshot,
  d1EventsByDrop: Map<string, PackStatusRetirementD1Event[]>,
  firestore: FirestoreSnapshot,
): RetirementFirestoreBefore {
  if (firestore.summaryCount !== supportedDropIds.length) {
    fail('Firestore does not contain the exact three pack-status summaries.');
  }
  const drops: RetirementFirestoreBefore['drops'] = [];
  for (let index = 0; index < d1.drops.length; index += 1) {
    const d1Drop = d1.drops[index];
    const firestoreDrop = firestore.drops[index];
    if (d1Drop.dropId !== firestoreDrop.dropId || !firestoreDrop.summary) {
      fail(`Firestore and D1 pack-status identities differ for ${d1Drop.dropId}.`);
    }
    const d1Events = d1EventsByDrop.get(d1Drop.dropId)!;
    const d1EventsById = new Map(d1Events.map((event) => [event.documentId, event]));
    const firestoreIds = new Set(firestoreDrop.events.map((event) => event.id));
    if (firestoreDrop.events.some((event) => !d1EventsById.has(event.id))) {
      fail(`Firestore contains an event missing from D1 for ${d1Drop.dropId}.`);
    }
    if (firestoreDrop.events.some((event) => (
      d1EventsById.get(event.id)!.payloadSha256 !== event.payloadSha256
    ))) fail(`Firestore and D1 event payloads differ for ${d1Drop.dropId}.`);
    const d1OnlyEvents = d1Events.filter((event) => !firestoreIds.has(event.documentId));
    if (d1OnlyEvents.some((event) => event.applyDelta !== 1)) {
      fail(`D1 contains an unmatched historical event for ${d1Drop.dropId}.`);
    }
    const d1OnlyDeltas = d1OnlyEvents.reduce(
      (total, event) => addDeltas(total, event.deltas),
      zeroDeltas(),
    );
    if (
      canonical(d1Drop.counters) !==
      canonical(countersWithDeltas(firestoreDrop.summary.counters, d1OnlyDeltas))
    ) {
      fail(`D1 counters do not equal the frozen Firestore summary plus D1-only deltas for ${d1Drop.dropId}.`);
    }
    drops.push({
      counters: firestoreDrop.summary.counters,
      d1OnlyDeltas,
      d1OnlyEventCount: d1OnlyEvents.length,
      dropId: d1Drop.dropId,
      eventHashes: firestoreDrop.events.map((event) => (
        firestoreEventHash(event.id, event.payloadSha256)
      )).sort(),
      eventCount: firestoreDrop.events.length,
      summaryPresent: true,
      updateTime: firestoreDrop.summary.updateTime,
    });
  }
  const before: RetirementFirestoreBefore = {
    drops,
    eventCount: firestore.eventCount,
    summaryCount: firestore.summaryCount,
  };
  if (!isFirestoreBefore(before)) fail('Firestore retirement baseline is invalid.');
  return before;
}

function reproveRecordedBaseline(
  receipt: PackStatusRetirementReceipt,
  currentD1: RetirementD1Snapshot,
  currentD1EventsByDrop: Map<string, PackStatusRetirementD1Event[]>,
): RetirementFirestoreBefore {
  const drops: RetirementFirestoreBefore['drops'] = [];
  for (let index = 0; index < receipt.d1.drops.length; index += 1) {
    const planned = receipt.d1.drops[index];
    const current = currentD1.drops[index];
    const currentHashes = new Set(current.eventHashes);
    if (
      planned.dropId !== current.dropId ||
      planned.eventHashes.some((hash) => !currentHashes.has(hash))
    ) fail('D1 pack-status events did not grow monotonically after retirement planning.');
    const frozen = receipt.firestoreBefore.drops[index];
    const frozenHashes = new Set(frozen.eventHashes);
    const currentFirestoreHashes = new Set(currentD1EventsByDrop.get(current.dropId)!.map((event) => (
      firestoreEventHash(event.documentId, event.payloadSha256)
    )));
    if (frozen.eventHashes.some((hash) => !currentFirestoreHashes.has(hash))) {
      fail(`Recorded Firestore events are missing from D1 for ${current.dropId}.`);
    }
    const d1OnlyEvents = currentD1EventsByDrop.get(current.dropId)!.filter(
      (event) => !frozenHashes.has(firestoreEventHash(event.documentId, event.payloadSha256)),
    );
    if (d1OnlyEvents.some((event) => event.applyDelta !== 1)) {
      fail(`D1 contains an unmatched historical event for ${current.dropId}.`);
    }
    const d1OnlyDeltas = d1OnlyEvents.reduce(
      (total, event) => addDeltas(total, event.deltas),
      zeroDeltas(),
    );
    if (canonical(current.counters) !== canonical(countersWithDeltas(frozen.counters, d1OnlyDeltas))) {
      fail(`D1 counters do not equal the frozen Firestore summary plus D1-only deltas for ${current.dropId}.`);
    }
    drops.push({
      ...frozen,
      d1OnlyDeltas,
      d1OnlyEventCount: d1OnlyEvents.length,
    });
  }
  const proven: RetirementFirestoreBefore = {
    drops,
    eventCount: receipt.firestoreBefore.eventCount,
    summaryCount: receipt.firestoreBefore.summaryCount,
  };
  if (!isFirestoreBefore(proven)) fail('Recorded Firestore baseline proof is invalid.');
  return proven;
}

function assertRemainingWithinPlan(
  receipt: PackStatusRetirementReceipt,
  snapshot: FirestoreSnapshot,
): void {
  for (let index = 0; index < snapshot.drops.length; index += 1) {
    const current = snapshot.drops[index];
    const planned = receipt.firestoreBefore.drops[index];
    const plannedCounters = planned.counters;
    if (current.dropId !== planned.dropId || current.events.length > planned.eventCount) {
      fail('Firestore pack-status data grew after the retirement plan was recorded.');
    }
    if (current.summary !== null && canonical(current.summary.counters) !== canonical(plannedCounters)) {
      fail('A Firestore pack-status summary changed after the retirement plan was recorded.');
    }
    if (current.summary !== null && current.summary.updateTime !== planned.updateTime) {
      fail('A Firestore pack-status summary updateTime changed after the retirement plan was recorded.');
    }
    const plannedHashes = new Set(planned.eventHashes);
    if (current.events.some((event) => (
      !plannedHashes.has(firestoreEventHash(event.id, event.payloadSha256))
    ))) {
      fail('Firestore contains a pack-status event that was not present in the retirement plan.');
    }
  }
}

function requireValidDate(now: Date): string {
  if (!Number.isFinite(now.getTime())) fail('Retirement timestamp is invalid.');
  return now.toISOString();
}

function completedPostDelete(snapshot: FirestoreSnapshot, verifiedAt: string): RetirementPostDelete {
  if (snapshot.summaryCount !== 0 || snapshot.eventCount !== 0) {
    fail('Firestore pack-status deletion verification found remaining documents.');
  }
  const value: RetirementPostDelete = {
    drops: snapshot.drops.map((drop) => ({
      dropId: drop.dropId,
      eventCount: 0,
      summaryPresent: false,
    })),
    eventCount: 0,
    summaryCount: 0,
    verifiedAt,
  };
  if (!isPostDelete(value)) fail('Post-delete verification is invalid.');
  return value;
}

async function deleteExactPackStatusDocuments(
  firestore: PackStatusRetirementFirestore,
  frozenFirestore: RetirementFirestoreBefore,
  presentSummaryDropIds: ReadonlySet<string>,
): Promise<void> {
  for (const dropId of supportedDropIds) {
    const frozenDrop = frozenFirestore.drops.find((drop) => drop.dropId === dropId);
    if (!frozenDrop) fail(`Recorded Firestore deletion plan is missing ${dropId}.`);
    const allowedHashes = new Set(frozenDrop.eventHashes);
    while (true) {
      const events = validateEventDocumentPage(
        dropId,
        await firestore.listEventDocuments(dropId, undefined, pageSize),
        undefined,
      );
      if (events.length === 0) break;
      if (events.some((event) => (
        !allowedHashes.has(firestoreEventHash(event.id, event.payloadSha256))
      ))) {
        fail('Firestore contains a late pack-status event outside the recorded deletion plan.');
      }
      const paths = events.map((event) => `${packStatusEventCollectionPath(dropId)}/${event.id}`);
      if (paths.some((path) => !isAllowedPackStatusRetirementDeletePath(path))) {
        fail('Refusing to delete a document outside the pack-status retirement allowlist.');
      }
      await firestore.deleteEventDocumentPaths(paths);
    }
  }
  const summaries = frozenFirestore.drops
    .filter((drop) => presentSummaryDropIds.has(drop.dropId))
    .map((drop) => ({
      path: packStatusSummaryDocumentPath(drop.dropId),
      updateTime: drop.updateTime,
    }));
  if (summaries.some((summary) => !isAllowedPackStatusRetirementDeletePath(summary.path))) {
    fail('Refusing to delete a summary outside the pack-status retirement allowlist.');
  }
  if (summaries.length) await firestore.deleteSummaryDocuments(summaries);
}

export async function runPackStatusRetirement(
  args: PackStatusRetirementArgs,
  dependencies: PackStatusRetirementDependencies,
): Promise<PackStatusRetirementResult> {
  const existing = dependencies.readReceipt();
  if (existing !== undefined && !isPackStatusRetirementReceipt(existing)) {
    fail('The tracked pack-status retirement receipt is invalid.');
  }
  if (
    existing &&
    args.mode === 'confirm' &&
    existing.apiVersionId.toLowerCase() !== args.apiVersionId.toLowerCase()
  ) fail('The requested API version does not match the recorded retirement plan.');
  if (args.mode === 'confirm' && existing?.status !== 'completed') {
    await dependencies.verifyApiVersion(args.apiVersionId);
  }

  const currentD1EventsByDrop = normalizedD1Events(await dependencies.readD1Events());
  const currentD1 = d1Snapshot(
    await dependencies.readD1Integrity(),
    currentD1EventsByDrop,
  );
  const currentFirestore = await readFirestoreSnapshot(dependencies.firestore);

  if (existing) {
    if (existing.status === 'completed') {
      completedPostDelete(currentFirestore, existing.postDelete!.verifiedAt);
      dependencies.log('[pack-status-retirement] Firestore pack-status retirement is already complete.');
      return { mode: 'receipt', receipt: existing };
    }
    reproveRecordedBaseline(existing, currentD1, currentD1EventsByDrop);
    assertRemainingWithinPlan(existing, currentFirestore);
    if (args.mode === 'dry-run') {
      dependencies.log('[pack-status-retirement] A planned retirement is waiting to be resumed.');
      return { mode: 'receipt', receipt: existing };
    }
  } else {
    const before = assertInitialParity(currentD1, currentD1EventsByDrop, currentFirestore);
    if (args.mode === 'dry-run') {
      dependencies.log(
        `[pack-status-retirement] Dry run passed: ${before.summaryCount} summaries and ${before.eventCount} events are ready for retirement.`,
      );
      return { mode: 'dry-run', d1: currentD1, firestore: before };
    }
    const plannedAt = requireValidDate(dependencies.now());
    const bookmark = await dependencies.currentD1Bookmark();
    if (typeof bookmark !== 'string' || !bookmark) fail('D1 Time Travel returned no bookmark.');
    const planned: PackStatusRetirementReceipt = {
      apiVersionId: args.apiVersionId.toLowerCase(),
      completedAt: null,
      d1: currentD1,
      d1Bookmark: bookmark,
      finalD1Bookmark: null,
      firestoreBefore: before,
      plannedAt,
      postDelete: null,
      schemaVersion: 1,
      status: 'planned',
    };
    if (!isPackStatusRetirementReceipt(planned)) fail('Refusing to write an invalid retirement plan.');
    dependencies.writeReceipt(planned, undefined);
    dependencies.log('[pack-status-retirement] Planned receipt recorded before deletion.');
    return finishPackStatusRetirement(
      planned,
      new Set(currentFirestore.drops.filter((drop) => drop.summary).map((drop) => drop.dropId)),
      dependencies,
    );
  }

  return finishPackStatusRetirement(
    existing,
    new Set(currentFirestore.drops.filter((drop) => drop.summary).map((drop) => drop.dropId)),
    dependencies,
  );
}

async function finishPackStatusRetirement(
  planned: PackStatusRetirementReceipt,
  presentSummaryDropIds: ReadonlySet<string>,
  dependencies: PackStatusRetirementDependencies,
): Promise<PackStatusRetirementResult> {
  await dependencies.verifyApiVersion(planned.apiVersionId);
  await deleteExactPackStatusDocuments(
    dependencies.firestore,
    planned.firestoreBefore,
    presentSummaryDropIds,
  );
  const afterFirestore = await readFirestoreSnapshot(dependencies.firestore);
  const verifiedAt = requireValidDate(dependencies.now());
  const postDelete = completedPostDelete(afterFirestore, verifiedAt);
  await dependencies.verifyApiVersion(planned.apiVersionId);
  const d1AfterEvents = normalizedD1Events(await dependencies.readD1Events());
  const d1After = d1Snapshot(await dependencies.readD1Integrity(), d1AfterEvents);
  const finalFirestoreEvidence = reproveRecordedBaseline(planned, d1After, d1AfterEvents);
  const finalD1Bookmark = await dependencies.currentD1Bookmark();
  if (typeof finalD1Bookmark !== 'string' || !finalD1Bookmark) {
    fail('D1 Time Travel returned no final bookmark.');
  }
  const completed: PackStatusRetirementReceipt = {
    ...planned,
    completedAt: verifiedAt,
    d1: d1After,
    finalD1Bookmark,
    firestoreBefore: finalFirestoreEvidence,
    postDelete,
    status: 'completed',
  };
  if (!isPackStatusRetirementReceipt(completed)) fail('Refusing to write an invalid completed receipt.');
  dependencies.writeReceipt(completed, planned);
  dependencies.log(
    `[pack-status-retirement] Completed: removed ${planned.firestoreBefore.summaryCount} summaries and ${planned.firestoreBefore.eventCount} events.`,
  );
  return { mode: 'receipt', receipt: completed };
}

function readReceipt(path = packStatusRetirementReceiptPath): PackStatusRetirementReceipt | undefined {
  if (!existsSync(path)) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return fail('The tracked pack-status retirement receipt could not be read.');
  }
  if (!isPackStatusRetirementReceipt(value)) fail('The tracked pack-status retirement receipt is invalid.');
  return value;
}

function writeReceipt(
  next: PackStatusRetirementReceipt,
  expected: PackStatusRetirementReceipt | undefined,
  path = packStatusRetirementReceiptPath,
): void {
  if (!isPackStatusRetirementReceipt(next)) fail('Refusing to write an invalid retirement receipt.');
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = resolve(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(next, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: expected && existsSync(path) ? statSync(path).mode & 0o777 : 0o644,
    });
    const temporaryDescriptor = openSync(temporaryPath, 'r');
    try {
      fsyncSync(temporaryDescriptor);
    } finally {
      closeSync(temporaryDescriptor);
    }
    if (expected === undefined) {
      if (existsSync(path)) fail('A retirement receipt appeared concurrently.');
      linkSync(temporaryPath, path);
      unlinkSync(temporaryPath);
      const directoryDescriptor = openSync(dirname(path), 'r');
      try {
        fsyncSync(directoryDescriptor);
      } finally {
        closeSync(directoryDescriptor);
      }
      return;
    }
    const current = readReceipt(path);
    if (!current || canonical(current) !== canonical(expected)) {
      fail('The retirement receipt changed concurrently.');
    }
    renameSync(temporaryPath, path);
    const directoryDescriptor = openSync(dirname(path), 'r');
    try {
      fsyncSync(directoryDescriptor);
    } finally {
      closeSync(directoryDescriptor);
    }
  } finally {
    if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
  }
}

function parseFirestoreCredential(value: string): FirestoreCredential {
  if (!value || Buffer.byteLength(value, 'utf8') > 64 * 1024) {
    fail('Firestore writer credential is empty or oversized.');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return fail('Firestore writer credential is not valid JSON.');
  }
  if (!isRecord(parsed)) fail('Firestore writer credential must contain one JSON object.');
  const rawPrivateKey = typeof parsed.private_key === 'string' ? parsed.private_key : '';
  const credential = {
    client_email: typeof parsed.client_email === 'string' ? parsed.client_email.trim() : '',
    private_key: rawPrivateKey ? `${rawPrivateKey.trimEnd()}\n` : '',
    project_id: typeof parsed.project_id === 'string' ? parsed.project_id.trim() : '',
  };
  if (
    credential.client_email !== firestoreWriterServiceAccountEmail ||
    credential.project_id !== projectId ||
    !credential.private_key.startsWith('-----BEGIN PRIVATE KEY-----\n') ||
    !credential.private_key.endsWith('-----END PRIVATE KEY-----\n') ||
    credential.private_key.length > 32 * 1024
  ) fail('Firestore writer credential does not match the reviewed service account.');
  try {
    createPrivateKey(credential.private_key);
  } catch {
    fail('Firestore writer credential does not contain a valid PKCS8 private key.');
  }
  return credential;
}

export function readPackStatusRetirementFirestoreCredential(
  path: string | undefined,
  keychainReader: (account: string) => string = readCloudflareFirestoreKeychainCredential,
): FirestoreCredential {
  if (!path) return parseFirestoreCredential(keychainReader(firestoreWriterServiceAccountEmail));
  const resolvedPath = resolve(path);
  let entry;
  try {
    entry = lstatSync(resolvedPath);
  } catch {
    return fail('Firestore writer credential file could not be inspected.');
  }
  if (!entry.isFile() || entry.isSymbolicLink()) {
    fail('Firestore writer credential must be a regular non-symlink file.');
  }
  if ((entry.mode & 0o077) !== 0) {
    fail('Firestore writer credential file permissions must not allow group or other access.');
  }
  if (entry.size <= 0 || entry.size > 64 * 1024) {
    fail('Firestore writer credential file is empty or oversized.');
  }
  let value: string;
  try {
    value = readFileSync(resolvedPath, 'utf8');
  } catch {
    return fail('Firestore writer credential file could not be read.');
  }
  return parseFirestoreCredential(value);
}

export function packStatusRetirementWriterPublicKeySha256(
  credential: FirestoreCredential,
): string {
  const publicKey = createPublicKey(createPrivateKey(credential.private_key)).export({
    format: 'der',
    type: 'spki',
  });
  return createHash('sha256').update(publicKey).digest('hex');
}

function firestoreAdapter(db: Firestore): PackStatusRetirementFirestore {
  return {
    async readSummary(dropId) {
      requireSupportedDropId(dropId);
      const snapshot = await db.doc(packStatusSummaryDocumentPath(dropId)).get();
      if (!snapshot.exists) return null;
      if (!snapshot.data() || !snapshot.updateTime) {
        fail(`Firestore pack-status summary metadata is missing for ${dropId}.`);
      }
      return {
        data: snapshot.data()!,
        updateTime: firestoreTimestampToken(snapshot.updateTime),
      };
    },
    async listEventDocuments(dropId, afterId, limit) {
      requireSupportedDropId(dropId);
      let query: any = db.collection(packStatusEventCollectionPath(dropId))
        .orderBy(FieldPath.documentId())
        .limit(limit);
      if (afterId) query = query.startAfter(afterId);
      const snapshot = await query.get();
      return snapshot.docs.map((document: { id: string; data: () => Record<string, unknown> }) => ({
        data: document.data(),
        id: document.id,
      }));
    },
    async deleteEventDocumentPaths(paths) {
      if (paths.length === 0 || paths.length > pageSize) fail('Firestore delete batch size is invalid.');
      if (paths.some((path) => (
        !isAllowedPackStatusRetirementDeletePath(path) || path.split('/')[2] !== 'packStatusEvents'
      ))) {
        fail('Refusing to delete a document outside the pack-status retirement allowlist.');
      }
      const batch = db.batch();
      for (const path of paths) batch.delete(db.doc(path));
      await batch.commit();
    },
    async deleteSummaryDocuments(documents) {
      if (
        documents.length < 1 ||
        documents.length > supportedDropIds.length ||
        documents.some((document) => (
          !isAllowedPackStatusRetirementDeletePath(document.path) ||
          document.path.split('/')[2] !== 'meta' ||
          !isFirestoreUpdateTime(document.updateTime)
        )) ||
        new Set(documents.map((document) => document.path)).size !== documents.length
      ) fail('Firestore summary delete preconditions are not exact.');
      const batch = db.batch();
      for (const document of documents) {
        batch.delete(db.doc(document.path), {
          lastUpdateTime: firestoreTimestampFromToken(document.updateTime),
        });
      }
      await batch.commit();
    },
  };
}

function readD1Events(): PackStatusRetirementD1Event[] {
  const events: PackStatusRetirementD1Event[] = [];
  for (const row of queryD1(`SELECT
      drop_id, event_type, event_key, apply_delta,
      unsealed_online_delta, redeemed_irl_normal_delta,
      redeemed_irl_stripe_delta, redeemed_unsealed_cards_delta,
      quantity, delivery_id, checkout_session_id, box_asset_id, signature, created_at_ms
    FROM pack_status_events ORDER BY drop_id, event_type, event_key`)) {
    const dropId = typeof row.drop_id === 'string' ? row.drop_id : '';
    const eventType = typeof row.event_type === 'string' ? row.event_type : '';
    const eventKey = typeof row.event_key === 'string' ? row.event_key : '';
    const deltas = {
      unsealedOnline: Number(row.unsealed_online_delta),
      redeemedIrlNormal: Number(row.redeemed_irl_normal_delta),
      redeemedIrlStripe: Number(row.redeemed_irl_stripe_delta),
      redeemedUnsealedCards: Number(row.redeemed_unsealed_cards_delta),
    };
    const applyDelta = Number(row.apply_delta);
    const type = packStatusEventType(eventType);
    const quantity = Number(row.quantity);
    const deliveryId = row.delivery_id == null ? null : Number(row.delivery_id);
    const createdAtMs = Number(row.created_at_ms);
    if (
      !PACK_STATUS_SUPPORTED_DROP_IDS.includes(dropId as never) ||
      !['onlineReveal', 'redeemedIrlNormal', 'redeemedIrlStripe'].includes(eventType) ||
      !eventKey ||
      (applyDelta !== 0 && applyDelta !== 1) ||
      !positiveInteger(quantity) ||
      (deliveryId !== null && !positiveInteger(deliveryId)) ||
      !nonnegativeInteger(createdAtMs) ||
      !isRetirementDeltas(deltas) ||
      Object.values(deltas).every((delta) => delta === 0)
    ) fail('D1 returned an invalid pack-status event identity.');
    const canonicalEvent: CanonicalPackStatusEvent = {
      boxAssetId: optionalEventString(row.box_asset_id, `${eventKey}.box_asset_id`),
      checkoutSessionId: optionalEventString(row.checkout_session_id, `${eventKey}.checkout_session_id`),
      createdAtMs,
      deliveryId,
      dropId,
      eventKey,
      increments: deltas,
      quantity,
      signature: optionalEventString(row.signature, `${eventKey}.signature`),
      type,
    };
    events.push({
      applyDelta,
      d1PayloadSha256: d1PackStatusEventPayloadSha256(canonicalEvent),
      deltas,
      documentId: `${type}_${encodeURIComponent(eventKey)}`,
      dropId,
      payloadSha256: packStatusEventPayloadSha256(canonicalEvent),
    });
  }
  return events;
}

async function main(): Promise<void> {
  const args = parsePackStatusRetirementArgs(process.argv.slice(2));
  const credential = readPackStatusRetirementFirestoreCredential(
    args.firestoreWriterServiceAccountFile,
  );
  const writerPublicKeySha256 = packStatusRetirementWriterPublicKeySha256(credential);
  const db = new Firestore({
    projectId,
    credentials: {
      client_email: credential.client_email,
      private_key: credential.private_key,
    },
  });
  try {
    await runPackStatusRetirement(args, {
      currentD1Bookmark,
      firestore: firestoreAdapter(db),
      log: console.log,
      now: () => new Date(),
      readD1Events,
      readD1Integrity,
      readReceipt,
      verifyApiVersion: (apiVersionId) => verifyPackStatusRetirementApiVersion(
        apiVersionId,
        writerPublicKeySha256,
      ),
      writeReceipt,
    });
  } finally {
    await db.terminate();
  }
}

function isDirectRun(): boolean {
  return Boolean(process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href);
}

if (isDirectRun()) {
  main().catch((error) => {
    console.error(`[pack-status-retirement] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
