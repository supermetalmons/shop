import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  isExactShopInventoryResponse,
  isExactShopPackStatusResponse,
  isExactShopPendingOpenBoxesResponse,
} from '../functions/src/shared/shopApi.ts';
import { isExactSubscribeToNotificationsResponse } from '../functions/src/shared/notificationSubscription.ts';
import { FULFILLMENT_ADMIN_WALLET_ADDRESSES } from '../functions/src/shared/fulfillmentAccess.ts';
import { isBase58Bytes } from '../functions/src/shared/solanaRpcProxy.ts';
import { benchmarkApi, type ApiBenchmarkResult } from './benchmark-cloudflare-api.ts';
import {
  cloudflareVersionIdPattern as versionIdPattern,
  isReleaseManifest,
  readReleaseManifest,
  recordApiProductionVersion,
  type ReleaseManifest,
  type ReleaseVersionPair,
  writeProductionEvidence,
} from './finalize-cloudflare-release.ts';
import {
  cloudflareReleaseExitCode,
  formatCloudflareReleaseError,
  guardCloudflareReleaseStart,
  readWranglerDeploymentStatus,
  reconcileCloudflareStableVersion,
  stableCloudflareVersionId,
  type CloudflareDeploymentStatus,
  type CloudflareSleep,
} from './cloudflare-deployment-state.ts';

type Mode = 'release' | 'preview' | 'production' | 'triggers' | 'rollback';

type CliOptions = {
  mode: Mode;
  smokeOwner: string;
  tokenFile?: string;
  versionId?: string;
};

type UploadMetadata = {
  versionId: string;
  previewUrl: string;
};

type CandidateRecord = UploadMetadata & ApiBenchmarkResult & {
  includeDevnet: true;
  workerName: 'mons-shop-api';
  smokeOwner: string;
  testedAt: string;
};

type SmokeApiOptions = {
  expectedInventoryDropId?: string;
  forbiddenInventoryDropId?: string;
  includeDevnet: boolean;
  includeNotificationSubscription?: boolean;
  includePackStatus?: boolean;
  owner: string;
};

export type SecretFileOperations = {
  chmod: (path: string, mode: number) => void;
  exists: (path: string) => boolean;
  lstat: (path: string) => { isDirectory: () => boolean; isSymbolicLink: () => boolean };
  mkdtemp: (prefix: string) => string;
  realpath: (path: string) => string;
  remove: (path: string, options: { recursive: true }) => void;
  stat: (path: string) => { mode: number };
  write: (
    path: string,
    data: string,
    options: { encoding: 'utf8'; flag: 'wx'; mode: number },
  ) => void;
};

type TerminationSignalHost = {
  exit: (code: number) => never | void;
  once: (signal: 'SIGINT' | 'SIGTERM', listener: () => void) => unknown;
  removeListener: (signal: 'SIGINT' | 'SIGTERM', listener: () => void) => unknown;
};

type ProcessRunner = (
  command: string,
  args: string[],
  environment: NodeJS.ProcessEnv,
  label: string,
) => void;

type ProductionSequenceInput = {
  candidateSmoke?: SmokeApiOptions;
  expectedCurrentVersionId: string;
  heliusApiKey: string;
  previewUrl: string;
  smokeOwner: string;
  versionId: string;
  verifyBeforePromotion?: () => Promise<void>;
  wranglerEnvironment: NodeJS.ProcessEnv;
};

type ProductionSequenceDependencies = {
  benchmark: typeof benchmarkApi;
  deployment: (environment: NodeJS.ProcessEnv) => CloudflareDeploymentStatus | Promise<CloudflareDeploymentStatus>;
  evidence: typeof writeProductionEvidence;
  sleep: CloudflareSleep;
  smoke: typeof smokeApi;
  wrangler: typeof runWrangler;
};

type ApiProductionCandidateDependencies = {
  deployment: (environment: NodeJS.ProcessEnv) => CloudflareDeploymentStatus | Promise<CloudflareDeploymentStatus>;
  readCandidate: (versionId: string, smokeOwner: string) => CandidateRecord | undefined;
};

type SmokeApiDependencies = {
  fetchSmoke: typeof fetchSmoke;
};

type CompleteApiReleaseInput = {
  apiToken: string;
  checkEnvironment: NodeJS.ProcessEnv;
  heliusApiKey: string;
  logsDirectory: string;
  smokeOwner: string;
  wranglerEnvironment: NodeJS.ProcessEnv;
};

type CompleteApiReleaseDependencies = {
  apiDeployment: (environment: NodeJS.ProcessEnv) => CloudflareDeploymentStatus | Promise<CloudflareDeploymentStatus>;
  frontendDeployment: (environment: NodeJS.ProcessEnv) => CloudflareDeploymentStatus | Promise<CloudflareDeploymentStatus>;
  manifest: () => ReleaseManifest;
  production: typeof runProductionSequence;
  record: typeof recordApiProductionVersion;
  triggerDryRun: (environment: NodeJS.ProcessEnv) => void;
  upload: typeof uploadApiCandidate;
  validate: () => void;
};

class DeployFailure extends Error {
  readonly exitCode: number;

  constructor(message: string, exitCode = 1) {
    super(message);
    this.name = 'DeployFailure';
    this.exitCode = exitCode;
  }
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const wranglerBinary = resolve(repoRoot, 'node_modules', '.bin', process.platform === 'win32' ? 'wrangler.cmd' : 'wrangler');
const configPath = 'cloud/workers/api/wrangler.jsonc';
const releaseEnvPath = 'cloud/workers/api/release.env';
const configArgs = ['--config', configPath, '--env-file', releaseEnvPath];
const frontendConfigArgs = ['--config', 'wrangler.jsonc'];
const workerName = 'mons-shop-api';
const accountId = 'e25f90fc073ea309b54b8b5144bf28e0';
const productionUrl = 'https://api.mons.shop';
const workersDevSubdomain = 'lil-org.workers.dev';
const candidateRecordDirectory = resolve(repoRoot, '.cache', 'mons-shop-api-candidates');
const candidateRecordMaxAgeMs = 6 * 60 * 60 * 1000;
const candidateRecordClockSkewMs = 5 * 60 * 1000;
const defaultSmokeOwner = FULFILLMENT_ADMIN_WALLET_ADDRESSES[0];
const expectedReleaseDropId = 'clear_cards_devnet_v2';
const forbiddenReleaseDropId = 'clear_cards_devnet';
const notificationSmokeEmail = 'ivan@ivan.lol';
const DEFAULT_SMOKE_TIMEOUT_MS = 15_000;
const INVENTORY_SMOKE_TIMEOUT_MS = 70_000;
const secretFileOperations: SecretFileOperations = {
  chmod: chmodSync,
  exists: existsSync,
  lstat: lstatSync,
  mkdtemp: mkdtempSync,
  realpath: realpathSync,
  remove: rmSync,
  stat: statSync,
  write: writeFileSync,
};

function usage(): string {
  return [
    'Release, update, or roll back the mons-shop-api Worker.',
    '',
    'Usage:',
    '  npm run deploy:api',
    '  npm run deploy:api -- release [--smoke-owner <wallet>] [--token-file <path>]',
    '  npm run deploy:api -- preview --smoke-owner <wallet> [--token-file <path>]',
    '  npm run deploy:api -- production --version-id <uuid> --smoke-owner <wallet> [--token-file <path>]',
    '  npm run deploy:api -- triggers --smoke-owner <wallet> [--token-file <path>]',
    '  npm run deploy:api -- rollback --version-id <uuid> --smoke-owner <wallet> [--token-file <path>]',
    '',
    'The default release validates, uploads, verifies, promotes, and records one exact Worker version.',
    'Release, preview, and production require HELIUS_API_KEY in the process environment.',
    'Preview mode uploads the secret through a temporary mode-0600 file inside a mode-0700 directory.',
  ].join('\n');
}

function fail(message: string, exitCode = 1): never {
  throw new DeployFailure(message, exitCode);
}

function parseArgs(argv: string[]): CliOptions {
  if (argv.includes('-h') || argv.includes('--help')) {
    console.log(usage());
    process.exit(0);
  }
  const requestedMode = argv[0];
  const knownModes: readonly Mode[] = ['release', 'preview', 'production', 'triggers', 'rollback'];
  const mode: Mode = requestedMode && knownModes.includes(requestedMode as Mode) ? requestedMode as Mode : 'release';
  const optionStart = mode === requestedMode ? 1 : 0;
  if (requestedMode && !requestedMode.startsWith('--') && optionStart === 0) {
    fail(`Expected release, preview, production, triggers, or rollback.\n\n${usage()}`, 2);
  }
  let smokeOwner = mode === 'release' ? defaultSmokeOwner : '';
  let tokenFile: string | undefined;
  let versionId: string | undefined;
  for (let index = optionStart; index < argv.length; index += 1) {
    const option = argv[index];
    const value = argv[index + 1];
    if (option !== '--smoke-owner' && option !== '--token-file' && option !== '--version-id') {
      fail(`Unknown argument: ${option}\n\n${usage()}`, 2);
    }
    if (!value || value.startsWith('--')) fail(`Missing value for ${option}.`, 2);
    index += 1;
    if (option === '--smoke-owner') smokeOwner = value.trim();
    if (option === '--token-file') tokenFile = value;
    if (option === '--version-id') versionId = value.trim().toLowerCase();
  }
  if (!isBase58Bytes(smokeOwner, 32)) fail('--smoke-owner must be a valid 32-byte Solana address.', 2);
  if ((mode === 'production' || mode === 'rollback') && (!versionId || !versionIdPattern.test(versionId))) {
    fail(`${mode} requires an exact UUID --version-id.`, 2);
  }
  if ((mode === 'release' || mode === 'preview' || mode === 'triggers') && versionId) fail(`--version-id is not valid in ${mode} mode.`, 2);
  return { mode, smokeOwner, tokenFile, versionId };
}

function resolveHeliusApiKey(
  source: Readonly<Record<string, string | undefined>> = process.env,
): string {
  return source.HELIUS_API_KEY?.trim() || '';
}

function readApiToken(path?: string): string {
  const token = path ? readFileSync(resolve(path), 'utf8').trim() : String(process.env.CLOUDFLARE_API_TOKEN || '').trim();
  if (!token) fail('Missing Cloudflare authentication. Pass --token-file or set CLOUDFLARE_API_TOKEN.');
  return token;
}

function credentialFreeEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const environment = { ...source };
  for (const name of Object.keys(environment)) {
    const normalized = name.toUpperCase();
    if (
      normalized.startsWith('CLOUDFLARE_') ||
      normalized.startsWith('CF_') ||
      normalized.startsWith('WRANGLER_') ||
      normalized === 'HELIUS_API_KEY' ||
      normalized === 'RESEND_CONTACTS_API_KEY' ||
      normalized === 'NOTIFICATION_ENQUEUE_SECRET' ||
      normalized === 'VITE_HELIUS_API_KEY' ||
      normalized === 'DOTENV_KEY'
    ) {
      delete environment[name];
    }
  }
  return environment;
}

function validationEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return {
    ...credentialFreeEnvironment(source),
    CI: 'true',
    WRANGLER_LOG_PATH: resolve(repoRoot, '.cache', 'wrangler-logs'),
    WRANGLER_LOG_SANITIZE: 'true',
    WRANGLER_SEND_ERROR_REPORTS: 'false',
    WRANGLER_SEND_METRICS: 'false',
  };
}

function authenticatedWranglerEnvironment(apiToken: string, source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return {
    ...validationEnvironment(source),
    CLOUDFLARE_API_TOKEN: apiToken,
  };
}

function installTerminationCleanup(
  cleanup: () => void,
  host: TerminationSignalHost = process,
): () => void {
  let active = true;
  const removeHandlers = (): void => {
    if (!active) return;
    active = false;
    host.removeListener('SIGINT', handleSigint);
    host.removeListener('SIGTERM', handleSigterm);
  };
  const handle = (signal: 'SIGINT' | 'SIGTERM'): void => {
    removeHandlers();
    let cleanupFailed = false;
    try {
      cleanup();
    } catch {
      cleanupFailed = true;
      console.error('[api-deploy] Temporary secret cleanup failed during termination.');
    }
    host.exit(cleanupFailed ? 1 : signal === 'SIGINT' ? 130 : 143);
  };
  const handleSigint = (): void => handle('SIGINT');
  const handleSigterm = (): void => handle('SIGTERM');
  host.once('SIGINT', handleSigint);
  host.once('SIGTERM', handleSigterm);
  return removeHandlers;
}

function runWrangler(args: string[], environment: NodeJS.ProcessEnv, label: string): void {
  runProcess(wranglerBinary, args, environment, label);
}

function runProcess(command: string, args: string[], environment: NodeJS.ProcessEnv, label: string): void {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    env: environment,
    stdio: 'inherit',
    shell: false,
  });
  if (result.error) fail(`${label} could not start: ${result.error.message}`);
  if (result.status !== 0) fail(`${label} failed with exit code ${result.status ?? 1}.`, result.status ?? 1);
}

function readApiDeploymentStatus(environment: NodeJS.ProcessEnv): CloudflareDeploymentStatus {
  return readWranglerDeploymentStatus({
    configArgs,
    cwd: repoRoot,
    environment,
    wranglerBinary,
  });
}

function readFrontendDeploymentStatus(environment: NodeJS.ProcessEnv): CloudflareDeploymentStatus {
  return readWranglerDeploymentStatus({
    configArgs: frontendConfigArgs,
    cwd: repoRoot,
    environment,
    wranglerBinary,
  });
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

function runApiValidation(
  source: NodeJS.ProcessEnv = process.env,
  runner: ProcessRunner = runProcess,
): void {
  runner(
    process.platform === 'win32' ? 'npm.cmd' : 'npm',
    ['run', 'check:api'],
    validationEnvironment(source),
    'Complete API validation',
  );
}

function createSecretFile(
  operations: SecretFileOperations = secretFileOperations,
  heliusApiKey = String(process.env.HELIUS_API_KEY || '').trim(),
): { directory: string; path: string; dispose: () => void } {
  const secret = heliusApiKey.trim();
  if (!secret) fail('A Helius API key is required for Worker candidate upload.');
  let directory: string | undefined;
  try {
    directory = operations.mkdtemp(join(tmpdir(), 'mons-shop-api-secret-'));
    operations.chmod(directory, 0o700);
    if ((operations.stat(directory).mode & 0o777) !== 0o700) fail('Unable to enforce mode 0700 on the temporary secrets directory.');
    const path = join(directory, 'secrets.json');
    operations.write(path, JSON.stringify({ HELIUS_API_KEY: secret }), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    operations.chmod(path, 0o600);
    if ((operations.stat(path).mode & 0o777) !== 0o600) fail('Unable to enforce mode 0600 on the temporary secrets file.');
    return { directory, path, dispose: () => removeSecretDirectory(directory!, operations) };
  } catch (error) {
    if (!directory) throw error;
    try {
      removeSecretDirectory(directory, operations);
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Temporary secret setup and cleanup both failed.');
    }
    throw error;
  }
}

function removeSecretDirectory(directory: string, operations: SecretFileOperations = secretFileOperations): void {
  if (!operations.exists(directory)) return;
  const temporaryRoot = operations.realpath(tmpdir());
  const parent = operations.realpath(dirname(directory));
  const entry = operations.lstat(directory);
  if (parent !== temporaryRoot || !basename(directory).startsWith('mons-shop-api-secret-') || !entry.isDirectory() || entry.isSymbolicLink()) {
    fail('Refusing to remove an unexpected temporary secret path.');
  }
  const resolvedDirectory = operations.realpath(directory);
  if (dirname(resolvedDirectory) !== temporaryRoot) fail('Refusing to remove a redirected temporary secret path.');
  operations.remove(directory, { recursive: true });
}

function expectedPreviewOrigin(versionId: string): string {
  return `https://${versionId.slice(0, 8).toLowerCase()}-${workerName}.${workersDevSubdomain}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join('\0') === [...keys].sort().join('\0');
}

function isExactApiDeploymentConfig(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (
    value.name !== workerName ||
    value.account_id !== accountId ||
    value.main !== 'src/index.ts' ||
    value.workers_dev !== false ||
    value.preview_urls !== true ||
    Object.hasOwn(value, 'ratelimits') ||
    !Array.isArray(value.routes) ||
    value.routes.length !== 1
  ) {
    return false;
  }
  const route = value.routes[0];
  const queues = value.queues;
  if (!isRecord(queues) || !hasExactKeys(queues, ['producers']) || !Array.isArray(queues.producers) || queues.producers.length !== 1) {
    return false;
  }
  const notificationProducer = queues.producers[0];
  return isRecord(route) &&
    hasExactKeys(route, ['pattern', 'custom_domain']) &&
    route.pattern === new URL(productionUrl).hostname &&
    route.custom_domain === true &&
    isRecord(notificationProducer) &&
    hasExactKeys(notificationProducer, ['binding', 'queue']) &&
    notificationProducer.binding === 'NOTIFICATION_EMAIL_QUEUE' &&
    notificationProducer.queue === 'mons-shop-notification-emails';
}

function assertApiDeploymentConfig(path = resolve(repoRoot, configPath)): void {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    fail(`Unable to read API Wrangler config: ${detail}`);
  }
  if (!isExactApiDeploymentConfig(value)) {
    fail(
      `API Wrangler config must target only ${workerName}, account ${accountId}, the ${new URL(productionUrl).hostname} custom domain, and the reviewed notification queue.`,
    );
  }
}

function isCandidateRecord(value: unknown, now = new Date()): value is CandidateRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const testedAt = typeof record.testedAt === 'string' ? Date.parse(record.testedAt) : Number.NaN;
  const ageMs = now.getTime() - testedAt;
  return Object.keys(record).sort().join(',') === [
    'includeDevnet',
    'legacyMedianMs',
    'previewUrl',
    'runs',
    'smokeOwner',
    'testedAt',
    'versionId',
    'workerMedianMs',
    'workerName',
  ].sort().join(',') &&
    record.includeDevnet === true &&
    record.workerName === workerName &&
    typeof record.versionId === 'string' && versionIdPattern.test(record.versionId) &&
    typeof record.previewUrl === 'string' && record.previewUrl === expectedPreviewOrigin(record.versionId) &&
    typeof record.smokeOwner === 'string' && isBase58Bytes(record.smokeOwner, 32) &&
    Number.isFinite(now.getTime()) && Number.isFinite(testedAt) &&
    ageMs >= -candidateRecordClockSkewMs && ageMs <= candidateRecordMaxAgeMs &&
    Number.isSafeInteger(record.runs) && Number(record.runs) === 5 &&
    typeof record.workerMedianMs === 'number' && Number.isFinite(record.workerMedianMs) && record.workerMedianMs >= 0 &&
    typeof record.legacyMedianMs === 'number' && Number.isFinite(record.legacyMedianMs) && record.legacyMedianMs >= 0 &&
    record.workerMedianMs < record.legacyMedianMs;
}

function candidateRecordPath(versionId: string): string {
  if (!versionIdPattern.test(versionId)) fail('Refusing to resolve an invalid candidate version ID.');
  return resolve(candidateRecordDirectory, `${versionId.toLowerCase()}.json`);
}

function writeCandidateRecord(metadata: UploadMetadata, smokeOwner: string, benchmark: ApiBenchmarkResult): void {
  const record: CandidateRecord = {
    workerName,
    ...metadata,
    includeDevnet: true,
    smokeOwner,
    testedAt: new Date().toISOString(),
    ...benchmark,
  };
  mkdirSync(candidateRecordDirectory, { recursive: true, mode: 0o700 });
  chmodSync(candidateRecordDirectory, 0o700);
  const path = candidateRecordPath(metadata.versionId);
  rmSync(path, { force: true });
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  chmodSync(path, 0o600);
}

function requireCandidateRecord(versionId: string, smokeOwner: string, now = new Date()): CandidateRecord {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(candidateRecordPath(versionId), 'utf8'));
  } catch {
    fail('Production promotion requires the local candidate record created by preview mode.');
  }
  if (!isCandidateRecord(value, now) || value.versionId.toLowerCase() !== versionId.toLowerCase() || value.smokeOwner !== smokeOwner) {
    fail('Candidate record is stale or does not match the exact version ID and smoke owner being promoted.');
  }
  return value;
}

function readCandidateRecordIfValid(
  versionId: string,
  smokeOwner: string,
  now = new Date(),
): CandidateRecord | undefined {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(candidateRecordPath(versionId), 'utf8'));
  } catch {
    return undefined;
  }
  if (
    !isCandidateRecord(value, now) ||
    value.versionId.toLowerCase() !== versionId.toLowerCase() ||
    value.smokeOwner !== smokeOwner
  ) return undefined;
  return value;
}

async function resolveApiProductionPreviewUrl(
  input: {
    expectedCurrentVersionId: string;
    smokeOwner: string;
    versionId: string;
    wranglerEnvironment: NodeJS.ProcessEnv;
  },
  dependencies: ApiProductionCandidateDependencies = {
    deployment: readApiDeploymentStatus,
    readCandidate: readCandidateRecordIfValid,
  },
): Promise<string> {
  const candidateVersionId = input.versionId.toLowerCase();
  const candidate = dependencies.readCandidate(candidateVersionId, input.smokeOwner);
  if (candidate) return candidate.previewUrl;
  const liveVersionId = stableCloudflareVersionId(await dependencies.deployment(input.wranglerEnvironment));
  const releaseStart = guardCloudflareReleaseStart({
    candidateVersionId,
    expectedCurrentVersionId: input.expectedCurrentVersionId,
    liveVersionId,
    workerLabel: workerName,
  });
  if (!releaseStart.resumeCandidate) {
    fail('Production promotion requires a fresh local candidate record created by preview mode.');
  }
  return expectedPreviewOrigin(candidateVersionId);
}

function createBootstrapConfig(directory: string): string {
  const sourcePath = resolve(repoRoot, configPath);
  const config = JSON.parse(readFileSync(sourcePath, 'utf8')) as Record<string, unknown>;
  delete config.$schema;
  delete config.routes;
  config.main = resolve(repoRoot, 'cloud/workers/api/src/index.ts');
  const path = join(directory, 'wrangler.bootstrap.json');
  writeFileSync(path, JSON.stringify(config), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

async function workerExists(apiToken: string): Promise<boolean> {
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${workerName}`,
    { headers: { Authorization: `Bearer ${apiToken}` }, signal: AbortSignal.timeout(15_000) },
  );
  await response.body?.cancel().catch(() => undefined);
  if (response.status === 200) return true;
  if (response.status === 404) return false;
  fail(`Unable to check Worker bootstrap state (Cloudflare returned ${response.status}).`);
}

function parseUploadMetadata(path: string): UploadMetadata {
  const lines = readFileSync(path, 'utf8').trim().split(/\r?\n/).reverse();
  const upload = lines.flatMap((line) => {
    try {
      const value = JSON.parse(line) as Record<string, unknown>;
      return value.type === 'version-upload' ? [value] : [];
    } catch {
      return [];
    }
  })[0];
  if (!upload || upload.worker_name !== workerName || typeof upload.version_id !== 'string' || !versionIdPattern.test(upload.version_id)) {
    fail('Wrangler did not report a valid uploaded Worker version.');
  }
  if (typeof upload.preview_url !== 'string') fail('Wrangler did not report a version preview URL.');
  const expectedOrigin = expectedPreviewOrigin(upload.version_id);
  if (upload.preview_url !== expectedOrigin) {
    fail('Wrangler reported an unexpected version preview URL.');
  }
  return { versionId: upload.version_id.toLowerCase(), previewUrl: expectedOrigin };
}

function assertResponseHeaders(response: Response, label: string): void {
  if (!String(response.headers.get('cache-control') || '').toLowerCase().split(',').some((part) => part.trim() === 'no-store')) {
    fail(`${label} was missing Cache-Control: no-store.`);
  }
  if (!response.headers.get('server-timing')) fail(`${label} was missing Server-Timing.`);
}

async function fetchSmoke(
  url: string,
  init: RequestInit,
  label: string,
  timeoutMs = DEFAULT_SMOKE_TIMEOUT_MS,
): Promise<{ response: Response; durationMs: number }> {
  for (const delay of [0, 500, 1500, 3000]) {
    if (delay) await new Promise((resolvePromise) => setTimeout(resolvePromise, delay));
    const startedAt = performance.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { ...init, redirect: 'manual', signal: controller.signal });
      if ((response.status === 404 || response.status === 502 || response.status === 504) && delay !== 3000) {
        await response.body?.cancel().catch(() => undefined);
        continue;
      }
      const body = response.body ? await response.arrayBuffer() : null;
      const bufferedResponse = new Response(body?.byteLength ? body : null, {
        headers: response.headers,
        status: response.status,
        statusText: response.statusText,
      });
      return { response: bufferedResponse, durationMs: performance.now() - startedAt };
    } catch {
      if (delay === 3000) fail(`${label} failed after bounded retries.`);
    } finally {
      clearTimeout(timeout);
    }
  }
  fail(`${label} failed after bounded retries.`);
}

function assertInventorySmokeDrops(
  items: readonly { dropId: string }[],
  options: Pick<SmokeApiOptions, 'expectedInventoryDropId' | 'forbiddenInventoryDropId'>,
): void {
  if (options.expectedInventoryDropId && !items.some((item) => item.dropId === options.expectedInventoryDropId)) {
    fail(`Inventory smoke response did not contain ${options.expectedInventoryDropId}.`);
  }
  if (options.forbiddenInventoryDropId && items.some((item) => item.dropId === options.forbiddenInventoryDropId)) {
    fail(`Inventory smoke response still contained ${options.forbiddenInventoryDropId}.`);
  }
}

async function smokeApi(
  baseUrl: string,
  options: SmokeApiOptions,
  dependencies: SmokeApiDependencies = { fetchSmoke },
): Promise<void> {
  const request = dependencies.fetchSmoke;
  const health = await request(`${baseUrl}/health`, { method: 'GET' }, 'Health smoke request');
  if (health.response.status !== 200 || JSON.stringify(await health.response.json()) !== JSON.stringify({ ok: true })) fail('Health smoke response was invalid.');
  assertResponseHeaders(health.response, 'Health smoke response');

  const cors = await request(`${baseUrl}/inventory`, {
    method: 'OPTIONS',
    headers: { Origin: 'https://mons.shop', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'Content-Type' },
  }, 'CORS smoke request');
  if (cors.response.status !== 204 || cors.response.headers.get('access-control-allow-origin') !== '*') fail('CORS smoke response was invalid.');
  assertResponseHeaders(cors.response, 'CORS smoke response');

  let packStatusDurationMs: number | undefined;
  if (options.includePackStatus === true) {
    const packStatus = await request(
      `${baseUrl}/pack-status/card_nft_2`,
      { method: 'GET', headers: { Origin: 'https://mons.shop' } },
      'Pack-status smoke request',
    );
    if (packStatus.response.status !== 200) {
      fail(`Pack-status smoke request returned ${packStatus.response.status}.`);
    }
    assertResponseHeaders(packStatus.response, 'Pack-status smoke response');
    const packStatusPayload: unknown = await packStatus.response.json();
    if (
      !isExactShopPackStatusResponse(packStatusPayload) ||
      !packStatusPayload.packStatus ||
      packStatusPayload.packStatus.dropId !== 'card_nft_2'
    ) {
      fail('Pack-status smoke response had an unexpected shape.');
    }
    packStatusDurationMs = Math.round(packStatus.durationMs);
  }

  if (options.includeNotificationSubscription === true) {
    const notification = await request(`${baseUrl}/notifications/subscribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://mons.shop' },
      body: JSON.stringify({ email: notificationSmokeEmail }),
    }, 'Notification subscription smoke request');
    if (notification.response.status !== 200) {
      fail(`Notification subscription smoke request returned ${notification.response.status}.`);
    }
    assertResponseHeaders(notification.response, 'Notification subscription smoke response');
    if (!isExactSubscribeToNotificationsResponse(await notification.response.json())) {
      fail('Notification subscription smoke response had an unexpected shape.');
    }
  }

  const deniedRpcCors = await request(`${baseUrl}/rpc/mainnet-beta`, {
    method: 'OPTIONS',
    headers: { Origin: 'https://not-mons.example', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'Content-Type' },
  }, 'RPC denied-CORS smoke request');
  if (deniedRpcCors.response.status !== 403 || deniedRpcCors.response.headers.has('access-control-allow-origin')) {
    fail('RPC denied-CORS smoke response was invalid.');
  }
  assertResponseHeaders(deniedRpcCors.response, 'RPC denied-CORS smoke response');

  const allowedRpcCors = await request(`${baseUrl}/rpc/devnet`, {
    method: 'OPTIONS',
    headers: {
      Origin: 'https://mons.shop',
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'content-type,solana-client',
    },
  }, 'RPC allowed-CORS smoke request');
  if (
    allowedRpcCors.response.status !== 204 ||
    allowedRpcCors.response.headers.get('access-control-allow-origin') !== 'https://mons.shop' ||
    !String(allowedRpcCors.response.headers.get('access-control-allow-headers')).toLowerCase().split(/\s*,\s*/).includes('solana-client')
  ) {
    fail('RPC allowed-CORS smoke response was invalid.');
  }
  assertResponseHeaders(allowedRpcCors.response, 'RPC allowed-CORS smoke response');

  const durations: Record<string, number> = {};
  for (const route of ['/inventory', '/pending-open-boxes'] as const) {
    const result = await request(`${baseUrl}${route}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://mons.shop' },
      body: JSON.stringify(options.includeDevnet ? { owner: options.owner, includeDevnet: true } : { owner: options.owner }),
    }, `${route} smoke request`, INVENTORY_SMOKE_TIMEOUT_MS);
    if (result.response.status !== 200) fail(`${route} smoke request returned ${result.response.status}.`);
    assertResponseHeaders(result.response, `${route} smoke response`);
    const payload: unknown = await result.response.json();
    if (route === '/inventory') {
      if (!isExactShopInventoryResponse(payload)) fail(`${route} smoke response had an unexpected shape.`);
      assertInventorySmokeDrops(payload.items, options);
    } else if (!isExactShopPendingOpenBoxesResponse(payload)) {
      fail(`${route} smoke response had an unexpected shape.`);
    }
    durations[route] = Math.round(result.durationMs);
  }
  for (const cluster of ['mainnet-beta', 'devnet'] as const) {
    const id = `smoke-${cluster}`;
    const rpc = await request(`${baseUrl}/rpc/${cluster}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://mons.shop' },
      body: JSON.stringify({ jsonrpc: '2.0', id, method: 'getLatestBlockhash', params: [{ commitment: 'confirmed' }] }),
    }, `${cluster} RPC smoke request`);
    if (rpc.response.status !== 200 || rpc.response.headers.get('access-control-allow-origin') !== 'https://mons.shop') {
      fail(`${cluster} RPC smoke request returned an invalid status or CORS header.`);
    }
    assertResponseHeaders(rpc.response, `${cluster} RPC smoke response`);
    const payload = await rpc.response.json() as Record<string, any>;
    if (
      payload.jsonrpc !== '2.0' ||
      payload.id !== id ||
      !isBase58Bytes(payload.result?.value?.blockhash, 32) ||
      !Number.isSafeInteger(payload.result?.value?.lastValidBlockHeight) ||
      payload.result.value.lastValidBlockHeight < 0
    ) {
      fail(`${cluster} RPC smoke response had an unexpected shape.`);
    }
    durations[`/rpc/${cluster}`] = Math.round(rpc.durationMs);
  }
  console.log(
    `[api-deploy] Smoke latency: packStatus=${packStatusDurationMs === undefined ? 'skipped' : `${packStatusDurationMs}ms`} ` +
    `inventory=${durations['/inventory']}ms pending=${durations['/pending-open-boxes']}ms ` +
    `mainnetRpc=${durations['/rpc/mainnet-beta']}ms devnetRpc=${durations['/rpc/devnet']}ms`,
  );
}

function deployReviewedApiTriggers(
  input: ProductionSequenceInput,
  dependencies: ProductionSequenceDependencies,
): void {
  const args = ['triggers', 'deploy', ...configArgs];
  try {
    dependencies.wrangler(args, input.wranglerEnvironment, 'Reviewed trigger deployment');
  } catch (firstError) {
    try {
      dependencies.wrangler(args, input.wranglerEnvironment, 'Reviewed trigger deployment retry');
      console.log('[api-deploy] Reviewed trigger deployment converged on its declarative retry.');
    } catch (retryError) {
      throw new AggregateError(
        [firstError, retryError],
        'Reviewed API trigger deployment failed twice; no new Worker version was promoted.',
      );
    }
  }
}

async function exactApiLiveVersion(
  input: ProductionSequenceInput,
  dependencies: ProductionSequenceDependencies,
): Promise<string> {
  return stableCloudflareVersionId(await dependencies.deployment(input.wranglerEnvironment));
}

async function assertApiLiveVersion(
  expectedVersionId: string,
  input: ProductionSequenceInput,
  dependencies: ProductionSequenceDependencies,
  label: string,
): Promise<void> {
  const liveVersionId = await exactApiLiveVersion(input, dependencies);
  if (liveVersionId !== expectedVersionId) {
    throw new Error(`${label} expected ${expectedVersionId}, but Cloudflare reported ${liveVersionId}.`);
  }
}

async function reconcileApiVersion(
  preferredVersionId: string,
  allowedPendingVersionIds: readonly string[],
  input: ProductionSequenceInput,
  dependencies: ProductionSequenceDependencies,
  requireAllPendingObservations = false,
): Promise<string> {
  return reconcileCloudflareStableVersion({
    allowedPendingVersionIds,
    preferredVersionId,
    read: () => dependencies.deployment(input.wranglerEnvironment),
    requireAllPendingObservations,
    sleep: dependencies.sleep,
    workerLabel: workerName,
  });
}

async function recoverApiProduction(
  releaseError: unknown,
  baselineVersionId: string,
  candidateVersionId: string,
  input: ProductionSequenceInput,
  dependencies: ProductionSequenceDependencies,
): Promise<never> {
  let observedVersionId: string;
  try {
    observedVersionId = await reconcileApiVersion(
      candidateVersionId,
      [baselineVersionId],
      input,
      dependencies,
    );
  } catch (stateError) {
    throw new AggregateError(
      [releaseError, stateError],
      'API release failed after the candidate became mutation-eligible, and live state was unsafe to overwrite. No blind rollback was attempted; inspect deployment status and recover manually.',
    );
  }

  let rollbackCommandError: unknown;
  const recoveryVerificationErrors: unknown[] = [];
  let baselineConfirmed = observedVersionId === baselineVersionId;
  if (observedVersionId === candidateVersionId && candidateVersionId !== baselineVersionId) {
    try {
      await assertApiLiveVersion(
        candidateVersionId,
        input,
        dependencies,
        'API pre-rollback candidate guard',
      );
    } catch (stateError) {
      throw new AggregateError(
        [releaseError, stateError],
        'API release failed, but the candidate changed after reconciliation; automatic rollback was suppressed. Inspect deployment status and recover manually.',
      );
    }
    try {
      dependencies.wrangler([
        'rollback',
        baselineVersionId,
        '--yes',
        '--message',
        'Automatic recovery after failed mons-shop-api release',
        ...configArgs,
      ], input.wranglerEnvironment, 'API compensating rollback');
    } catch (rollbackError) {
      rollbackCommandError = rollbackError;
    }
    try {
      const recoveredVersionId = await reconcileApiVersion(
        baselineVersionId,
        [candidateVersionId],
        input,
        dependencies,
      );
      if (recoveredVersionId !== baselineVersionId) {
        recoveryVerificationErrors.push(new Error(
          `API compensating rollback did not make baseline ${baselineVersionId} live; ${recoveredVersionId} remained active.`,
        ));
      } else {
        baselineConfirmed = true;
      }
    } catch (stateError) {
      recoveryVerificationErrors.push(stateError);
    }
  }

  if (baselineConfirmed) {
    try {
      const candidateSmoke = productionCandidateSmoke(input);
      await dependencies.smoke(productionUrl, {
        includeDevnet: candidateSmoke.includeDevnet,
        owner: input.smokeOwner,
      });
    } catch (smokeError) {
      recoveryVerificationErrors.push(smokeError);
    }
    try {
      await assertApiLiveVersion(
        baselineVersionId,
        input,
        dependencies,
        'API recovery verification',
      );
    } catch (stateError) {
      recoveryVerificationErrors.push(stateError);
    }
  }

  if (recoveryVerificationErrors.length > 0) {
    throw new AggregateError(
      [releaseError, ...(rollbackCommandError === undefined ? [] : [rollbackCommandError]), ...recoveryVerificationErrors],
      'API production release failed and exact baseline recovery was not cleanly verified. No further automatic mutation was attempted; inspect deployment status and recover manually.',
    );
  }
  if (rollbackCommandError !== undefined) {
    console.log(`[api-deploy] Automatic recovery verified at version ${baselineVersionId} despite a rollback command failure.`);
    throw new AggregateError(
      [releaseError, rollbackCommandError],
      'API production release failed; baseline recovery was verified, but the rollback command reported failure.',
    );
  }
  console.log(`[api-deploy] Automatic recovery verified at version ${baselineVersionId}.`);
  throw releaseError;
}

function resumedApiReleaseFailure(error: unknown, candidateVersionId: string): Error {
  return new Error(
    `API candidate ${candidateVersionId} was already live when this command started. Automatic rollback was suppressed because this invocation did not capture its predecessor; inspect production and rerun the same production command after resolving the failure.`,
    { cause: error },
  );
}

function apiEvidenceFailure(error: unknown, candidateVersionId: string): Error {
  return new Error(
    `API candidate ${candidateVersionId} remains live and verified, but production evidence could not be written. No rollback was attempted; rerun the same production command with this version ID to regenerate evidence through guarded resume.`,
    { cause: error },
  );
}

function productionCandidateSmoke(input: ProductionSequenceInput): SmokeApiOptions {
  return input.candidateSmoke || { includeDevnet: true, owner: input.smokeOwner };
}

async function runProductionSequence(
  input: ProductionSequenceInput,
  dependencies: ProductionSequenceDependencies = {
    benchmark: benchmarkApi,
    deployment: readApiDeploymentStatus,
    evidence: writeProductionEvidence,
    sleep,
    smoke: smokeApi,
    wrangler: runWrangler,
  },
): Promise<void> {
  const candidateSmoke = productionCandidateSmoke(input);
  if (candidateSmoke.owner !== input.smokeOwner) fail('Candidate smoke owner did not match the release owner.');
  await dependencies.smoke(input.previewUrl, candidateSmoke);
  await dependencies.benchmark(
    {
      apiOrigin: input.previewUrl,
      includeDevnet: candidateSmoke.includeDevnet,
      owner: input.smokeOwner,
      runs: 5,
    },
    input.heliusApiKey,
  );

  const candidateVersionId = input.versionId.toLowerCase();
  const initialLiveVersionId = await exactApiLiveVersion(input, dependencies);
  const releaseStart = guardCloudflareReleaseStart({
    candidateVersionId,
    expectedCurrentVersionId: input.expectedCurrentVersionId,
    liveVersionId: initialLiveVersionId,
    workerLabel: workerName,
  });

  if (releaseStart.resumeCandidate) {
    try {
      deployReviewedApiTriggers(input, dependencies);
    } catch (error) {
      throw resumedApiReleaseFailure(error, candidateVersionId);
    }
  } else {
    deployReviewedApiTriggers(input, dependencies);
    await dependencies.smoke(productionUrl, {
      includeDevnet: candidateSmoke.includeDevnet,
      owner: input.smokeOwner,
    });
    await assertApiLiveVersion(
      releaseStart.baselineVersionId,
      input,
      dependencies,
      'API pre-promotion baseline recheck',
    );
    await input.verifyBeforePromotion?.();

    let promotionError: unknown;
    try {
      dependencies.wrangler([
        'versions',
        'deploy',
        '--version-id',
        candidateVersionId,
        '--percentage',
        '100',
        '--yes',
        ...configArgs,
      ], input.wranglerEnvironment, 'Exact version promotion');
    } catch (error) {
      promotionError = error;
    }

    let observedVersionId: string;
    try {
      observedVersionId = await reconcileApiVersion(
        candidateVersionId,
        [releaseStart.baselineVersionId],
        input,
        dependencies,
        true,
      );
    } catch (stateError) {
      if (promotionError !== undefined) {
        throw new AggregateError(
          [promotionError, stateError],
          'API exact-version promotion failed and live mutation state could not be safely reconciled. No blind rollback was attempted; inspect deployment status and recover manually.',
        );
      }
      throw new Error(
        'API exact-version promotion returned, but live mutation state could not be safely reconciled. No blind rollback was attempted; inspect deployment status and recover manually.',
        { cause: stateError },
      );
    }
    if (observedVersionId !== candidateVersionId) {
      if (promotionError !== undefined) throw promotionError;
      throw new Error(`API exact-version promotion left baseline ${observedVersionId} live.`);
    }
    if (promotionError !== undefined) {
      await recoverApiProduction(
        promotionError,
        releaseStart.baselineVersionId,
        candidateVersionId,
        input,
        dependencies,
      );
    }
  }

  try {
    await dependencies.smoke(productionUrl, candidateSmoke);
    await assertApiLiveVersion(
      candidateVersionId,
      input,
      dependencies,
      'API production commit verification',
    );
  } catch (error) {
    if (releaseStart.resumeCandidate) {
      throw resumedApiReleaseFailure(error, candidateVersionId);
    }
    await recoverApiProduction(
      error,
      releaseStart.baselineVersionId,
      candidateVersionId,
      input,
      dependencies,
    );
  }
  try {
    dependencies.evidence('api', candidateVersionId);
  } catch (error) {
    throw apiEvidenceFailure(error, candidateVersionId);
  }
}

async function uploadApiCandidate(input: {
  apiToken: string;
  candidateSmoke: SmokeApiOptions;
  heliusApiKey: string;
  logsDirectory: string;
  smokeOwner: string;
  wranglerEnvironment: NodeJS.ProcessEnv;
}): Promise<UploadMetadata> {
  if (input.candidateSmoke.owner !== input.smokeOwner) fail('Candidate smoke owner did not match the upload owner.');
  const secretFile = createSecretFile(secretFileOperations, input.heliusApiKey);
  const removeTerminationCleanup = installTerminationCleanup(secretFile.dispose);
  const outputFile = resolve(input.logsDirectory, `api-upload-${process.pid}-${Date.now()}.json`);
  let metadata: UploadMetadata | undefined;
  let releaseError: unknown;
  try {
    if (!await workerExists(input.apiToken)) {
      const bootstrapConfig = createBootstrapConfig(secretFile.directory);
      console.log('[api-deploy] Bootstrapping route-free Worker before candidate upload.');
      runWrangler([
        'deploy', '--strict', '--secrets-file', secretFile.path, '--config', bootstrapConfig, '--env-file', releaseEnvPath,
      ], input.wranglerEnvironment, 'Route-free Worker bootstrap');
    }
    const uploadEnvironment = { ...input.wranglerEnvironment, WRANGLER_OUTPUT_FILE_PATH: outputFile };
    runWrangler([
      'versions', 'upload', '--strict', '--preview-alias', 'candidate', '--secrets-file', secretFile.path, ...configArgs,
    ], uploadEnvironment, 'Candidate version upload');
    metadata = parseUploadMetadata(outputFile);
    console.log(`[api-deploy] Version: ${metadata.versionId}`);
    console.log(`[api-deploy] Preview: ${metadata.previewUrl}`);
    await smokeApi(metadata.previewUrl, input.candidateSmoke);
    const benchmark = await benchmarkApi(
      {
        apiOrigin: metadata.previewUrl,
        includeDevnet: input.candidateSmoke.includeDevnet,
        owner: input.smokeOwner,
        runs: 5,
      },
      input.heliusApiKey,
    );
    writeCandidateRecord(metadata, input.smokeOwner, benchmark);
    console.log(`[api-deploy] Candidate smoke checks and benchmark passed; record written for ${metadata.versionId}.`);
  } catch (error) {
    releaseError = error;
  }
  removeTerminationCleanup();
  let secretCleanupError: unknown;
  let outputCleanupError: unknown;
  try {
    secretFile.dispose();
  } catch (error) {
    secretCleanupError = error;
  }
  try {
    rmSync(outputFile, { force: true });
  } catch (error) {
    outputCleanupError = error;
  }
  const errors = [releaseError, secretCleanupError, outputCleanupError].filter((error) => error !== undefined);
  if (errors.length > 1) throw new AggregateError(errors, 'Candidate release cleanup failed after another release error.');
  if (errors.length === 1) throw errors[0];
  if (!metadata) fail('Candidate upload completed without exact version metadata.');
  return metadata;
}

async function readStableReleasePair(
  environment: NodeJS.ProcessEnv,
  dependencies: Pick<CompleteApiReleaseDependencies, 'apiDeployment' | 'frontendDeployment'>,
): Promise<ReleaseVersionPair> {
  const [apiStatus, frontendStatus] = await Promise.all([
    dependencies.apiDeployment(environment),
    dependencies.frontendDeployment(environment),
  ]);
  return {
    apiVersionId: stableCloudflareVersionId(apiStatus),
    frontendVersionId: stableCloudflareVersionId(frontendStatus),
  };
}

function assertReleasePair(
  actual: ReleaseVersionPair,
  expected: ReleaseVersionPair,
  label: string,
): void {
  if (
    actual.apiVersionId !== expected.apiVersionId.toLowerCase() ||
    actual.frontendVersionId !== expected.frontendVersionId.toLowerCase()
  ) {
    fail(
      `${label} expected API ${expected.apiVersionId} and frontend ${expected.frontendVersionId}, ` +
      `but Cloudflare reported API ${actual.apiVersionId} and frontend ${actual.frontendVersionId}.`,
    );
  }
}

async function runCompleteApiRelease(
  input: CompleteApiReleaseInput,
  dependencies: CompleteApiReleaseDependencies = {
    apiDeployment: readApiDeploymentStatus,
    frontendDeployment: readFrontendDeploymentStatus,
    manifest: readReleaseManifest,
    production: runProductionSequence,
    record: recordApiProductionVersion,
    triggerDryRun: (environment) => runWrangler(
      ['triggers', 'deploy', '--dry-run', ...configArgs],
      environment,
      'Trigger configuration dry-run',
    ),
    upload: uploadApiCandidate,
    validate: runApiValidation,
  },
): Promise<UploadMetadata> {
  const expectedCurrentProduction = dependencies.manifest().currentProduction;
  const initialLivePair = await readStableReleasePair(input.wranglerEnvironment, dependencies);
  assertReleasePair(initialLivePair, expectedCurrentProduction, 'Release preflight');

  dependencies.validate();
  dependencies.triggerDryRun(input.checkEnvironment);

  const candidateSmoke: SmokeApiOptions = {
    expectedInventoryDropId: expectedReleaseDropId,
    forbiddenInventoryDropId: forbiddenReleaseDropId,
    includeDevnet: true,
    includeNotificationSubscription: true,
    includePackStatus: true,
    owner: input.smokeOwner,
  };
  const metadata = await dependencies.upload({
    apiToken: input.apiToken,
    candidateSmoke,
    heliusApiKey: input.heliusApiKey,
    logsDirectory: input.logsDirectory,
    smokeOwner: input.smokeOwner,
    wranglerEnvironment: input.wranglerEnvironment,
  });
  await dependencies.production({
    candidateSmoke,
    expectedCurrentVersionId: expectedCurrentProduction.apiVersionId,
    heliusApiKey: input.heliusApiKey,
    previewUrl: metadata.previewUrl,
    smokeOwner: input.smokeOwner,
    verifyBeforePromotion: async () => {
      const frontendVersionId = stableCloudflareVersionId(
        await dependencies.frontendDeployment(input.wranglerEnvironment),
      );
      if (frontendVersionId !== expectedCurrentProduction.frontendVersionId.toLowerCase()) {
        fail(
          `Frontend changed before API promotion: expected ${expectedCurrentProduction.frontendVersionId}, ` +
          `but Cloudflare reported ${frontendVersionId}.`,
        );
      }
    },
    versionId: metadata.versionId,
    wranglerEnvironment: input.wranglerEnvironment,
  });

  const finalLivePair = await readStableReleasePair(input.wranglerEnvironment, dependencies);
  assertReleasePair(finalLivePair, {
    apiVersionId: metadata.versionId,
    frontendVersionId: expectedCurrentProduction.frontendVersionId,
  }, 'Release commit verification');
  try {
    dependencies.record(metadata.versionId, { expectedCurrentProduction });
  } catch (error) {
    const command = `npm run release:finalize -- --api-version-id ${metadata.versionId} ` +
      `--frontend-version-id ${expectedCurrentProduction.frontendVersionId} --confirm`;
    throw new Error(
      `API version ${metadata.versionId} is live and verified, but cloud/release-manifest.json was not updated. ` +
      `After verifying fresh production evidence, reconcile it with: ${command}`,
      { cause: error },
    );
  }
  return metadata;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const nodeMajor = Number.parseInt(process.versions.node.split('.')[0], 10);
  if (!Number.isFinite(nodeMajor) || nodeMajor < 22) fail(`Node 22 or newer is required; current version is ${process.versions.node}.`);
  if (!existsSync(wranglerBinary)) fail('Pinned Wrangler binary not found. Run npm install first.');
  assertApiDeploymentConfig();
  const logsDirectory = resolve(repoRoot, '.cache', 'wrangler-logs');
  mkdirSync(logsDirectory, { recursive: true });
  const checkEnvironment = validationEnvironment();
  const heliusApiKey = resolveHeliusApiKey();
  console.log(`[api-deploy] Mode: ${options.mode}`);

  if (options.mode === 'release') {
    if (!heliusApiKey) fail('Release requires HELIUS_API_KEY in the process environment.');
    const apiToken = readApiToken(options.tokenFile);
    const wranglerEnvironment = authenticatedWranglerEnvironment(apiToken);
    const metadata = await runCompleteApiRelease({
      apiToken,
      checkEnvironment,
      heliusApiKey,
      logsDirectory,
      smokeOwner: options.smokeOwner,
      wranglerEnvironment,
    });
    console.log(`[api-deploy] Production version ${metadata.versionId} deployed, verified, and recorded.`);
    return;
  }

  if (options.mode === 'preview') {
    if (!heliusApiKey) fail('Preview mode requires HELIUS_API_KEY in the process environment.');
    runApiValidation();
    const apiToken = readApiToken(options.tokenFile);
    const wranglerEnvironment = authenticatedWranglerEnvironment(apiToken);
    await uploadApiCandidate({
      apiToken,
      candidateSmoke: { includeDevnet: true, includeNotificationSubscription: true, includePackStatus: true, owner: options.smokeOwner },
      heliusApiKey,
      logsDirectory,
      smokeOwner: options.smokeOwner,
      wranglerEnvironment,
    });
    return;
  }

  if (options.mode === 'production' || options.mode === 'triggers') {
    runWrangler(['triggers', 'deploy', '--dry-run', ...configArgs], checkEnvironment, 'Trigger configuration dry-run');
  }
  const apiToken = readApiToken(options.tokenFile);
  const wranglerEnvironment = authenticatedWranglerEnvironment(apiToken);

  if (options.mode === 'rollback') {
    const releaseManifest = readReleaseManifest();
    if (options.versionId !== releaseManifest.approvedRollback.apiVersionId) {
      fail('API rollback version is not the approved target in cloud/release-manifest.json.');
    }
    runWrangler(['rollback', options.versionId!, '--yes', '--message', 'Explicit mons-shop-api rollback', ...configArgs], wranglerEnvironment, 'Worker rollback');
    await smokeApi(productionUrl, { includeDevnet: true, owner: options.smokeOwner });
    console.log(`[api-deploy] Rolled back and verified version ${options.versionId}.`);
    return;
  }

  if (options.mode === 'production') {
    if (!heliusApiKey) fail('Production mode requires HELIUS_API_KEY for the mandatory direct-path benchmark.');
    const expectedCurrentVersionId = readReleaseManifest().currentProduction.apiVersionId;
    const previewUrl = await resolveApiProductionPreviewUrl({
      expectedCurrentVersionId,
      smokeOwner: options.smokeOwner,
      versionId: options.versionId!,
      wranglerEnvironment,
    });
    await runProductionSequence({
      candidateSmoke: { includeDevnet: true, includeNotificationSubscription: true, includePackStatus: true, owner: options.smokeOwner },
      expectedCurrentVersionId,
      heliusApiKey,
      previewUrl,
      smokeOwner: options.smokeOwner,
      versionId: options.versionId!,
      wranglerEnvironment,
    });
    console.log(`[api-deploy] Production version ${options.versionId} and custom-domain trigger verified.`);
    return;
  }
  runWrangler(['triggers', 'deploy', ...configArgs], wranglerEnvironment, 'Reviewed trigger deployment');
  await smokeApi(productionUrl, { includeDevnet: true, owner: options.smokeOwner });
  console.log('[api-deploy] Custom-domain trigger verified.');
}

export const deployApiTestHooks = {
  assertApiDeploymentConfig,
  assertInventorySmokeDrops,
  authenticatedWranglerEnvironment,
  candidateRecordPath,
  createSecretFile,
  defaultSmokeOwner,
  notificationSmokeEmail,
  defaultSmokeTimeoutMs: DEFAULT_SMOKE_TIMEOUT_MS,
  expectedReleaseDropId,
  expectedPreviewOrigin,
  installTerminationCleanup,
  inventorySmokeTimeoutMs: INVENTORY_SMOKE_TIMEOUT_MS,
  isExactApiDeploymentConfig,
  isCandidateRecord,
  isReleaseManifest,
  parseArgs,
  parseUploadMetadata,
  removeSecretDirectory,
  readReleaseManifest,
  readStableReleasePair,
  requireCandidateRecord,
  resolveHeliusApiKey,
  resolveApiProductionPreviewUrl,
  runApiValidation,
  runCompleteApiRelease,
  runProductionSequence,
  secretFileOperations,
  smokeApi,
  validationEnvironment,
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    const message = formatCloudflareReleaseError(error);
    const exitCode = cloudflareReleaseExitCode(error);
    console.error(`\n[api-deploy] ${message}\n`);
    process.exitCode = exitCode;
  });
}
