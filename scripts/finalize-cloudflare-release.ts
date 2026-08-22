import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export type ReleaseVersionPair = {
  apiVersionId: string;
  frontendVersionId: string;
};

export type ReleaseManifest = {
  schemaVersion: 1;
  recordedAt: string;
  currentProduction: ReleaseVersionPair;
  approvedRollback: ReleaseVersionPair;
  allowDirectHeliusFrontendRollback: false;
};

type FinalizeOptions = {
  evidenceDirectory?: string;
  manifestPath?: string;
  now?: Date;
};

type RecordApiProductionOptions = FinalizeOptions & {
  expectedCurrentProduction: ReleaseVersionPair;
};

type RecordFrontendProductionOptions = FinalizeOptions & {
  expectedCurrentProduction: ReleaseVersionPair;
};

type ApproveCurrentApiRollbackOptions = FinalizeOptions;

export type ProductionEvidenceKind = 'api' | 'frontend';

export type ProductionEvidence = {
  schemaVersion: 1;
  kind: ProductionEvidenceKind;
  workerName: 'mons-shop-api' | 'mons-shop';
  versionId: string;
  verifiedAt: string;
};

type ProductionEvidenceOptions = {
  directory?: string;
  now?: Date;
};

type FinalizeCliOptions = ReleaseVersionPair & {
  confirm: true;
};

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const releaseManifestPath = resolve(repoRoot, 'cloud', 'release-manifest.json');
export const cloudflareVersionIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const productionEvidenceDirectory = resolve(repoRoot, '.cache', 'cloudflare-production-evidence');
const productionEvidenceMaxAgeMs = 24 * 60 * 60 * 1000;
const evidenceClockSkewMs = 5 * 60 * 1000;
const evidenceWorkerNames = {
  api: 'mons-shop-api',
  frontend: 'mons-shop',
} as const;

function usage(): string {
  return [
    'Record an already verified API and frontend production release.',
    '',
    'Usage:',
    '  npm run release:finalize -- --api-version-id <uuid> --frontend-version-id <uuid> --confirm',
    '',
    'This command does not deploy and requires fresh evidence written by both production deploy helpers.',
  ].join('\n');
}

function fail(message: string): never {
  throw new Error(message);
}

function isReleaseVersionPair(value: unknown): value is ReleaseVersionPair {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const pair = value as Record<string, unknown>;
  return Object.keys(pair).sort().join(',') === 'apiVersionId,frontendVersionId' &&
    typeof pair.apiVersionId === 'string' && cloudflareVersionIdPattern.test(pair.apiVersionId) &&
    typeof pair.frontendVersionId === 'string' && cloudflareVersionIdPattern.test(pair.frontendVersionId);
}

export function isReleaseManifest(value: unknown): value is ReleaseManifest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const manifest = value as Record<string, unknown>;
  return Object.keys(manifest).sort().join(',') === [
    'allowDirectHeliusFrontendRollback',
    'approvedRollback',
    'currentProduction',
    'recordedAt',
    'schemaVersion',
  ].sort().join(',') &&
    manifest.schemaVersion === 1 &&
    typeof manifest.recordedAt === 'string' && Number.isFinite(Date.parse(manifest.recordedAt)) &&
    isReleaseVersionPair(manifest.currentProduction) &&
    isReleaseVersionPair(manifest.approvedRollback) &&
    manifest.allowDirectHeliusFrontendRollback === false;
}

export function readReleaseManifest(path = releaseManifestPath): ReleaseManifest {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    fail('The tracked Cloudflare release manifest could not be read.');
  }
  if (!isReleaseManifest(value)) fail('The tracked Cloudflare release manifest is invalid.');
  return value;
}

export function productionEvidencePath(
  kind: ProductionEvidenceKind,
  versionId: string,
  directory = productionEvidenceDirectory,
): string {
  if (!cloudflareVersionIdPattern.test(versionId)) fail('Production evidence requires an exact version UUID.');
  return resolve(directory, `${kind}-${versionId.toLowerCase()}.json`);
}

export function isProductionEvidence(
  value: unknown,
  expectedKind?: ProductionEvidenceKind,
  expectedVersionId?: string,
  now = new Date(),
): value is ProductionEvidence {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Number.isFinite(now.getTime())) return false;
  const evidence = value as Record<string, unknown>;
  if (Object.keys(evidence).sort().join(',') !== [
    'kind',
    'schemaVersion',
    'verifiedAt',
    'versionId',
    'workerName',
  ].sort().join(',')) return false;
  if (evidence.schemaVersion !== 1 || (evidence.kind !== 'api' && evidence.kind !== 'frontend')) return false;
  if (evidence.workerName !== evidenceWorkerNames[evidence.kind]) return false;
  if (typeof evidence.versionId !== 'string' || !cloudflareVersionIdPattern.test(evidence.versionId)) return false;
  if (expectedKind && evidence.kind !== expectedKind) return false;
  if (expectedVersionId && evidence.versionId.toLowerCase() !== expectedVersionId.toLowerCase()) return false;
  if (typeof evidence.verifiedAt !== 'string') return false;
  const verifiedAt = Date.parse(evidence.verifiedAt);
  const ageMs = now.getTime() - verifiedAt;
  return Number.isFinite(verifiedAt) && ageMs >= -evidenceClockSkewMs && ageMs <= productionEvidenceMaxAgeMs;
}

export function writeProductionEvidence(
  kind: ProductionEvidenceKind,
  versionId: string,
  options: ProductionEvidenceOptions = {},
): ProductionEvidence {
  const now = options.now || new Date();
  if (!Number.isFinite(now.getTime())) fail('The production evidence timestamp is invalid.');
  const directory = resolve(options.directory || productionEvidenceDirectory);
  const evidence: ProductionEvidence = {
    schemaVersion: 1,
    kind,
    workerName: evidenceWorkerNames[kind],
    versionId: versionId.toLowerCase(),
    verifiedAt: now.toISOString(),
  };
  if (!isProductionEvidence(evidence, kind, versionId, now)) fail('Refusing to write invalid production evidence.');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const path = productionEvidencePath(kind, versionId, directory);
  const temporaryPath = resolve(directory, `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(evidence, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    if (existsSync(path)) unlinkSync(path);
    renameSync(temporaryPath, path);
  } catch (error) {
    try {
      if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Production evidence write and cleanup both failed.');
    }
    throw error;
  }
  return evidence;
}

export function requireProductionEvidence(
  kind: ProductionEvidenceKind,
  versionId: string,
  options: ProductionEvidenceOptions = {},
): ProductionEvidence {
  const now = options.now || new Date();
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(productionEvidencePath(kind, versionId, options.directory), 'utf8'));
  } catch {
    fail(`Release finalization requires ${kind} evidence from the production deploy helper.`);
  }
  if (!isProductionEvidence(value, kind, versionId, now)) {
    fail(`The ${kind} production evidence is invalid, stale, or belongs to another version.`);
  }
  return value;
}

export function parseFinalizeReleaseArgs(argv: string[]): FinalizeCliOptions {
  let apiVersionId: string | undefined;
  let frontendVersionId: string | undefined;
  let confirm = false;
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (option === '--confirm') {
      if (confirm) fail('--confirm may only be provided once.');
      confirm = true;
      continue;
    }
    if (option !== '--api-version-id' && option !== '--frontend-version-id') {
      fail(`Unknown argument: ${option}\n\n${usage()}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) fail(`Missing value for ${option}.`);
    index += 1;
    if (option === '--api-version-id') {
      if (apiVersionId) fail('--api-version-id may only be provided once.');
      apiVersionId = value;
    } else {
      if (frontendVersionId) fail('--frontend-version-id may only be provided once.');
      frontendVersionId = value;
    }
  }
  if (!apiVersionId || !cloudflareVersionIdPattern.test(apiVersionId)) fail('--api-version-id must be an exact UUID.');
  if (!frontendVersionId || !cloudflareVersionIdPattern.test(frontendVersionId)) fail('--frontend-version-id must be an exact UUID.');
  if (!confirm) fail('Refusing to update release metadata without --confirm.');
  return { apiVersionId, frontendVersionId, confirm: true };
}

export function finalizeReleaseManifest(
  versions: ReleaseVersionPair,
  options: FinalizeOptions = {},
): ReleaseManifest {
  if (!isReleaseVersionPair(versions)) fail('Both production version IDs must be exact UUIDs.');
  const path = resolve(options.manifestPath || releaseManifestPath);
  const now = options.now || new Date();
  if (!Number.isFinite(now.getTime())) fail('The release timestamp is invalid.');
  requireProductionEvidence('api', versions.apiVersionId, { directory: options.evidenceDirectory, now });
  requireProductionEvidence('frontend', versions.frontendVersionId, { directory: options.evidenceDirectory, now });
  const current = readReleaseManifest(path);
  const next: ReleaseManifest = {
    ...current,
    recordedAt: now.toISOString(),
    currentProduction: { ...versions },
  };
  return writeReleaseManifest(path, next);
}

export function recordApiProductionVersion(
  versionId: string,
  options: RecordApiProductionOptions,
): ReleaseManifest {
  if (!cloudflareVersionIdPattern.test(versionId)) fail('The API production version ID must be an exact UUID.');
  if (!isReleaseVersionPair(options.expectedCurrentProduction)) fail('The expected production pair must contain exact UUIDs.');
  const path = resolve(options.manifestPath || releaseManifestPath);
  const now = options.now || new Date();
  if (!Number.isFinite(now.getTime())) fail('The release timestamp is invalid.');
  requireProductionEvidence('api', versionId, { directory: options.evidenceDirectory, now });
  const current = readReleaseManifest(path);
  if (
    current.currentProduction.apiVersionId.toLowerCase() !== options.expectedCurrentProduction.apiVersionId.toLowerCase() ||
    current.currentProduction.frontendVersionId.toLowerCase() !== options.expectedCurrentProduction.frontendVersionId.toLowerCase()
  ) {
    fail('The tracked production pair changed during deployment; refusing to overwrite release metadata.');
  }
  const next: ReleaseManifest = {
    ...current,
    recordedAt: now.toISOString(),
    currentProduction: {
      apiVersionId: versionId.toLowerCase(),
      frontendVersionId: options.expectedCurrentProduction.frontendVersionId.toLowerCase(),
    },
  };
  return writeReleaseManifest(path, next);
}

export function recordFrontendProductionVersion(
  versionId: string,
  options: RecordFrontendProductionOptions,
): ReleaseManifest {
  if (!cloudflareVersionIdPattern.test(versionId)) fail('The frontend production version ID must be an exact UUID.');
  if (!isReleaseVersionPair(options.expectedCurrentProduction)) fail('The expected production pair must contain exact UUIDs.');
  const path = resolve(options.manifestPath || releaseManifestPath);
  const now = options.now || new Date();
  if (!Number.isFinite(now.getTime())) fail('The release timestamp is invalid.');
  requireProductionEvidence('frontend', versionId, { directory: options.evidenceDirectory, now });
  const current = readReleaseManifest(path);
  if (
    current.currentProduction.apiVersionId.toLowerCase() !== options.expectedCurrentProduction.apiVersionId.toLowerCase() ||
    current.currentProduction.frontendVersionId.toLowerCase() !== options.expectedCurrentProduction.frontendVersionId.toLowerCase()
  ) {
    fail('The tracked production pair changed during deployment; refusing to overwrite release metadata.');
  }
  const next: ReleaseManifest = {
    ...current,
    recordedAt: now.toISOString(),
    currentProduction: {
      apiVersionId: options.expectedCurrentProduction.apiVersionId.toLowerCase(),
      frontendVersionId: versionId.toLowerCase(),
    },
  };
  return writeReleaseManifest(path, next);
}

export function approveCurrentApiRollback(
  versionId: string,
  options: ApproveCurrentApiRollbackOptions = {},
): ReleaseManifest {
  if (!cloudflareVersionIdPattern.test(versionId)) fail('The API rollback version ID must be an exact UUID.');
  const path = resolve(options.manifestPath || releaseManifestPath);
  const now = options.now || new Date();
  if (!Number.isFinite(now.getTime())) fail('The release timestamp is invalid.');
  const normalizedVersionId = versionId.toLowerCase();
  requireProductionEvidence('api', normalizedVersionId, { directory: options.evidenceDirectory, now });
  const current = readReleaseManifest(path);
  if (current.currentProduction.apiVersionId.toLowerCase() !== normalizedVersionId) {
    fail('Only the current production API version can be approved as the rollback target.');
  }
  if (
    current.currentProduction.frontendVersionId.toLowerCase() !==
    current.approvedRollback.frontendVersionId.toLowerCase()
  ) {
    fail('The current frontend does not match the approved rollback frontend.');
  }
  if (current.approvedRollback.apiVersionId.toLowerCase() === normalizedVersionId) return current;
  return writeReleaseManifest(path, {
    ...current,
    recordedAt: now.toISOString(),
    approvedRollback: {
      apiVersionId: normalizedVersionId,
      frontendVersionId: current.approvedRollback.frontendVersionId.toLowerCase(),
    },
  });
}

function writeReleaseManifest(path: string, next: ReleaseManifest): ReleaseManifest {
  if (!isReleaseManifest(next)) fail('Refusing to write invalid release metadata.');

  const temporaryPath = resolve(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  const mode = statSync(path).mode & 0o777;
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(next, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode,
    });
    renameSync(temporaryPath, path);
  } catch (error) {
    try {
      if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Release metadata write and temporary-file cleanup both failed.');
    }
    throw error;
  }
  return next;
}

function main(): void {
  if (process.argv.slice(2).some((value) => value === '-h' || value === '--help')) {
    console.log(usage());
    return;
  }
  const { apiVersionId, frontendVersionId } = parseFinalizeReleaseArgs(process.argv.slice(2));
  const manifest = finalizeReleaseManifest({ apiVersionId, frontendVersionId });
  console.log(`[release] Recorded API production version ${manifest.currentProduction.apiVersionId}.`);
  console.log(`[release] Recorded frontend production version ${manifest.currentProduction.frontendVersionId}.`);
  console.log(`[release] Preserved approved rollback API ${manifest.approvedRollback.apiVersionId} and frontend ${manifest.approvedRollback.frontendVersionId}.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(`\n[release] ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
