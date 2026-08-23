import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createPrivateKey, randomUUID } from 'node:crypto';
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
import { SignJWT, importPKCS8 } from 'jose';
import {
  isExactShopInventoryResponse,
  isExactShopPackStatusResponse,
  isExactShopPendingOpenBoxesResponse,
} from '../functions/src/shared/shopApi.ts';
import { isExactSubscribeToNotificationsResponse } from '../functions/src/shared/notificationSubscription.ts';
import { stripeCheckoutReconciliationQuery } from '../functions/src/shared/stripeCheckoutReconciliation.ts';
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
import {
  firestoreReaderServiceAccountEmail,
  firestoreWriterServiceAccountEmail,
  readCloudflareFirestoreKeychainCredential,
} from './cloudflare-firestore-keychain.ts';

type Mode = 'release' | 'preview' | 'production' | 'rollback';

type CliOptions = {
  firestoreServiceAccountFile?: string;
  firestoreWriterServiceAccountFile?: string;
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
  sourceCommit: string;
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
  includeProfileState?: boolean;
  includeStripeWebhook?: boolean;
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

type QueueResourceDependencies = {
  create: (name: string, environment: NodeJS.ProcessEnv) => void;
  info: (name: string, environment: NodeJS.ProcessEnv) => string;
};

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
  notificationSmoke?: typeof smokeNotificationDelivery;
  pauseRevealQueue?: (environment: NodeJS.ProcessEnv) => void;
  pauseFulfillmentQueue?: (environment: NodeJS.ProcessEnv) => void;
  repauseRevealQueue?: (environment: NodeJS.ProcessEnv) => void;
  repauseFulfillmentQueue?: (environment: NodeJS.ProcessEnv) => void;
  resumeRevealQueue?: (environment: NodeJS.ProcessEnv) => void;
  resumeFulfillmentQueue?: (environment: NodeJS.ProcessEnv) => void;
  verifyQueueConsumers?: (environment: NodeJS.ProcessEnv) => void;
  wrangler: typeof runWrangler;
};

type RollbackSequenceInput = {
  manifest: ReleaseManifest;
  smokeOwner: string;
  versionId: string;
  wranglerEnvironment: NodeJS.ProcessEnv;
};

type RollbackSequenceDependencies = {
  apiDeployment: (environment: NodeJS.ProcessEnv) => CloudflareDeploymentStatus | Promise<CloudflareDeploymentStatus>;
  disableReconciliationSchedule: (environment: NodeJS.ProcessEnv) => void;
  evidence: typeof writeProductionEvidence;
  frontendDeployment: (environment: NodeJS.ProcessEnv) => CloudflareDeploymentStatus | Promise<CloudflareDeploymentStatus>;
  notificationSmoke?: typeof smokeNotificationDelivery;
  pauseRevealQueue: (environment: NodeJS.ProcessEnv) => void;
  pauseFulfillmentQueue?: (environment: NodeJS.ProcessEnv) => void;
  record: typeof recordApiProductionVersion;
  repauseRevealQueue: (environment: NodeJS.ProcessEnv) => void;
  repauseFulfillmentQueue?: (environment: NodeJS.ProcessEnv) => void;
  resumeRevealQueue: (environment: NodeJS.ProcessEnv) => void;
  resumeFulfillmentQueue?: (environment: NodeJS.ProcessEnv) => void;
  sleep: CloudflareSleep;
  smoke: typeof smokeApi;
  verifyQueueConsumers: (environment: NodeJS.ProcessEnv) => void;
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
  firestoreServiceAccountJson: string;
  firestoreWriterServiceAccountJson: string;
  heliusApiKey: string;
  logsDirectory: string;
  smokeOwner: string;
  wranglerEnvironment: NodeJS.ProcessEnv;
};

type CompleteApiReleaseDependencies = {
  apiDeployment: (environment: NodeJS.ProcessEnv) => CloudflareDeploymentStatus | Promise<CloudflareDeploymentStatus>;
  frontendDeployment: (environment: NodeJS.ProcessEnv) => CloudflareDeploymentStatus | Promise<CloudflareDeploymentStatus>;
  manifest: () => ReleaseManifest;
  prepareQueues?: (environment: NodeJS.ProcessEnv) => void;
  production: typeof runProductionSequence;
  record: typeof recordApiProductionVersion;
  triggerDryRun: (environment: NodeJS.ProcessEnv) => void;
  upload: typeof uploadApiCandidate;
  validate: () => void;
};

type QueueConsumer = {
  deadLetterQueue: string;
  maxBatchSize: number;
  maxBatchTimeoutMs: number;
  maxConcurrency: number;
  maxRetries: number;
  retryDelay: number;
  script: string;
  type: string;
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
const gitCommitPattern = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const defaultSmokeOwner = FULFILLMENT_ADMIN_WALLET_ADDRESSES[0];
const expectedReleaseDropId = 'clear_cards_devnet_v2';
const forbiddenReleaseDropId = 'clear_cards_devnet';
const notificationSmokeEmail = 'ivan@ivan.lol';
const notificationQueueName = 'mons-shop-notification-emails';
const notificationDeadLetterQueueName = 'mons-shop-notification-emails-dlq';
const revealQueueName = 'mons-shop-reveal-reconciliation';
const revealDeadLetterQueueName = 'mons-shop-reveal-reconciliation-dlq';
const stripeFulfillmentQueueName = 'mons-shop-stripe-fulfillment';
const stripeFulfillmentDeadLetterQueueName = 'mons-shop-stripe-fulfillment-dlq';
const notificationSmokeTimeoutMs = 90_000;
const firestoreProjectId = 'mons-shop';
const firestoreDatabaseName = `projects/${firestoreProjectId}/databases/(default)`;
const googleOAuthTokenUrl = 'https://oauth2.googleapis.com/token';
const googleDatastoreScope = 'https://www.googleapis.com/auth/datastore';
const DEFAULT_SMOKE_TIMEOUT_MS = 15_000;
const INVENTORY_SMOKE_TIMEOUT_MS = 70_000;
const CRON_TRIGGER_PROPAGATION_MS = 15 * 60 * 1000;
const SMOKE_PROPAGATION_DELAYS_MS = [0, 500, 1_500, 3_000, 5_000, 10_000, 15_000] as const;
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
    '  npm run deploy:api -- release --firestore-service-account-file <path> --firestore-writer-service-account-file <path> [--smoke-owner <wallet>] [--token-file <path>]',
    '  npm run deploy:api -- preview --firestore-service-account-file <path> --firestore-writer-service-account-file <path> --smoke-owner <wallet> [--token-file <path>]',
    '  npm run deploy:api -- production --version-id <uuid> --smoke-owner <wallet> [--token-file <path>]',
    '  npm run deploy:api -- rollback --version-id <uuid> --smoke-owner <wallet> [--token-file <path>]',
    '',
    'The default release validates, uploads, verifies, promotes, and records one exact Worker version.',
    'Release, preview, and production require HELIUS_API_KEY in the process environment.',
    'Release and preview use macOS Keychain credentials by default or accept dedicated reader and writer JSON files.',
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
  const knownModes: readonly Mode[] = ['release', 'preview', 'production', 'rollback'];
  const mode: Mode = requestedMode && knownModes.includes(requestedMode as Mode) ? requestedMode as Mode : 'release';
  const optionStart = mode === requestedMode ? 1 : 0;
  if (requestedMode && !requestedMode.startsWith('--') && optionStart === 0) {
    fail(`Expected release, preview, production, or rollback.\n\n${usage()}`, 2);
  }
  let smokeOwner = mode === 'release' ? defaultSmokeOwner : '';
  let firestoreServiceAccountFile: string | undefined;
  let firestoreWriterServiceAccountFile: string | undefined;
  let tokenFile: string | undefined;
  let versionId: string | undefined;
  for (let index = optionStart; index < argv.length; index += 1) {
    const option = argv[index];
    const value = argv[index + 1];
    if (
      option !== '--firestore-service-account-file' &&
      option !== '--firestore-writer-service-account-file' &&
      option !== '--smoke-owner' &&
      option !== '--token-file' &&
      option !== '--version-id'
    ) {
      fail(`Unknown argument: ${option}\n\n${usage()}`, 2);
    }
    if (!value || value.startsWith('--')) fail(`Missing value for ${option}.`, 2);
    index += 1;
    if (option === '--firestore-service-account-file') firestoreServiceAccountFile = value;
    if (option === '--firestore-writer-service-account-file') firestoreWriterServiceAccountFile = value;
    if (option === '--smoke-owner') smokeOwner = value.trim();
    if (option === '--token-file') tokenFile = value;
    if (option === '--version-id') versionId = value.trim().toLowerCase();
  }
  if (!isBase58Bytes(smokeOwner, 32)) fail('--smoke-owner must be a valid 32-byte Solana address.', 2);
  if ((mode === 'production' || mode === 'rollback') && (!versionId || !versionIdPattern.test(versionId))) {
    fail(`${mode} requires an exact UUID --version-id.`, 2);
  }
  if ((mode === 'release' || mode === 'preview') && versionId) fail(`--version-id is not valid in ${mode} mode.`, 2);
  if (mode !== 'release' && mode !== 'preview' && (firestoreServiceAccountFile || firestoreWriterServiceAccountFile)) {
    fail(`Firestore service-account file options are not valid in ${mode} mode.`, 2);
  }
  if (Boolean(firestoreServiceAccountFile) !== Boolean(firestoreWriterServiceAccountFile)) {
    fail('Firestore reader and writer service-account file options must be supplied together.', 2);
  }
  if ((mode === 'release' || mode === 'preview') && !firestoreServiceAccountFile && process.platform !== 'darwin') {
    fail(`${mode} requires Firestore service-account files outside macOS.`, 2);
  }
  return {
    firestoreServiceAccountFile,
    firestoreWriterServiceAccountFile,
    mode,
    smokeOwner,
    tokenFile,
    versionId,
  };
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

function validateFirestoreCredentialJson(value: string, expectedEmail: string, label: string): string {
  if (!value || Buffer.byteLength(value, 'utf8') > 64 * 1024) {
    fail(`${label} Firestore service-account JSON is empty or oversized.`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    fail(`${label} Firestore service-account file is not valid JSON.`);
  }
  if (!isRecord(parsed)) fail(`${label} Firestore service-account file must contain a JSON object.`);
  const projectId = typeof parsed.project_id === 'string' ? parsed.project_id.trim() : '';
  const clientEmail = typeof parsed.client_email === 'string' ? parsed.client_email.trim() : '';
  const rawPrivateKey = typeof parsed.private_key === 'string' ? parsed.private_key : '';
  const privateKey = rawPrivateKey ? `${rawPrivateKey.trimEnd()}\n` : '';
  if (
    projectId !== firestoreProjectId ||
    clientEmail !== expectedEmail ||
    !privateKey.startsWith('-----BEGIN PRIVATE KEY-----\n') ||
    !privateKey.endsWith('-----END PRIVATE KEY-----\n') ||
    privateKey.length > 32 * 1024
  ) {
    fail(`${label} Firestore credential must be the ${expectedEmail} key for project ${firestoreProjectId}.`);
  }
  return JSON.stringify({ project_id: projectId, client_email: clientEmail, private_key: privateKey });
}

function validateFirestoreServiceAccountJson(value: string): string {
  return validateFirestoreCredentialJson(value, firestoreReaderServiceAccountEmail, 'Reader');
}

function validateFirestoreWriterServiceAccountJson(value: string): string {
  const validated = validateFirestoreCredentialJson(value, firestoreWriterServiceAccountEmail, 'Writer');
  try {
    createPrivateKey((JSON.parse(validated) as { private_key: string }).private_key);
  } catch {
    fail('Writer Firestore credential must contain a valid PKCS8 private key.');
  }
  return validated;
}

async function verifyFirestoreWriterAccess(
  value: string,
  providerFetch: typeof fetch = fetch,
  nowMs = Date.now(),
): Promise<void> {
  const credential = JSON.parse(validateFirestoreWriterServiceAccountJson(value)) as {
    client_email: string;
    private_key: string;
  };
  const issuedAt = Math.floor(nowMs / 1000);
  const key = await importPKCS8(credential.private_key, 'RS256');
  const assertion = await new SignJWT({ scope: googleDatastoreScope })
    .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
    .setIssuer(credential.client_email)
    .setSubject(credential.client_email)
    .setAudience(googleOAuthTokenUrl)
    .setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + 3600)
    .sign(key);
  let tokenResponse: Response;
  try {
    tokenResponse = await providerFetch(googleOAuthTokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion,
      }),
      signal: AbortSignal.timeout(DEFAULT_SMOKE_TIMEOUT_MS),
    });
  } catch {
    fail('Unable to verify the Firestore writer credential.');
  }
  if (!tokenResponse.ok) {
    await tokenResponse.body?.cancel().catch(() => undefined);
    fail('Unable to verify the Firestore writer credential.');
  }
  let tokenPayload: unknown;
  try {
    tokenPayload = await tokenResponse.json();
  } catch {
    fail('Unable to verify the Firestore writer credential.');
  }
  const accessToken = isRecord(tokenPayload) && typeof tokenPayload.access_token === 'string'
    ? tokenPayload.access_token
    : '';
  if (!accessToken) fail('Unable to verify the Firestore writer credential.');
  const documentName = `${firestoreDatabaseName}/documents/cloudflareReleaseChecks/${randomUUID()}`;
  const deleteUrl = new URL(`https://firestore.googleapis.com/v1/${documentName}`);
  deleteUrl.searchParams.set('currentDocument.exists', 'false');
  let deleteResponse: Response;
  try {
    deleteResponse = await providerFetch(deleteUrl, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(DEFAULT_SMOKE_TIMEOUT_MS),
    });
  } catch {
    fail('Firestore writer access verification failed.');
  }
  if (!deleteResponse.ok) {
    await deleteResponse.body?.cancel().catch(() => undefined);
    fail('Firestore writer access verification failed.');
  }
  await deleteResponse.body?.cancel().catch(() => undefined);
  let queryResponse: Response;
  try {
    queryResponse = await providerFetch(
      `https://firestore.googleapis.com/v1/${firestoreDatabaseName}/documents:runQuery`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(stripeCheckoutReconciliationQuery(nowMs, 1)),
        signal: AbortSignal.timeout(DEFAULT_SMOKE_TIMEOUT_MS),
      },
    );
  } catch {
    fail('Firestore fulfillment reconciliation index verification failed.');
  }
  if (!queryResponse.ok) {
    await queryResponse.body?.cancel().catch(() => undefined);
    fail('Firestore fulfillment reconciliation index verification failed.');
  }
  await queryResponse.body?.cancel().catch(() => undefined);
}

function readFirestoreCredential(
  path: string | undefined,
  option: string,
  validate: (value: string) => string,
): string {
  if (!path) fail(`Missing ${option}.`);
  const resolvedPath = resolve(path);
  let value: string;
  try {
    const entry = lstatSync(resolvedPath);
    if (!entry.isFile() || entry.isSymbolicLink()) fail(`${option} must reference a regular non-symlink file.`);
    if ((entry.mode & 0o077) !== 0) fail(`${option} file permissions must not allow group or other access.`);
    value = readFileSync(resolvedPath, 'utf8');
  } catch (error) {
    if (error instanceof DeployFailure) throw error;
    const detail = error instanceof Error ? error.message : String(error);
    fail(`Unable to read ${option}: ${detail}`);
  }
  return validate(value);
}

function readFirestoreServiceAccount(path: string | undefined): string {
  return path
    ? readFirestoreCredential(path, '--firestore-service-account-file', validateFirestoreServiceAccountJson)
    : validateFirestoreServiceAccountJson(
        readCloudflareFirestoreKeychainCredential(firestoreReaderServiceAccountEmail),
      );
}

function readFirestoreWriterServiceAccount(path: string | undefined): string {
  return path
    ? readFirestoreCredential(
        path,
        '--firestore-writer-service-account-file',
        validateFirestoreWriterServiceAccountJson,
      )
    : validateFirestoreWriterServiceAccountJson(
        readCloudflareFirestoreKeychainCredential(firestoreWriterServiceAccountEmail),
      );
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
      normalized === 'COSIGNER_SECRET' ||
      normalized === 'RESEND_API_KEY' ||
      normalized === 'RESEND_CONTACTS_API_KEY' ||
      normalized === 'NOTIFICATION_ENQUEUE_SECRET' ||
      normalized === 'FIRESTORE_SERVICE_ACCOUNT_JSON' ||
      normalized === 'FIRESTORE_WRITER_SERVICE_ACCOUNT_JSON' ||
      normalized === 'ADDRESS_DECRYPTION_SECRET' ||
      normalized === 'SHIPSTATION_API_KEY' ||
      normalized === 'SHIPSTATION_SHIP_FROM' ||
      normalized === 'STRIPE_SECRET_KEY' ||
      normalized === 'STRIPE_RESTRICTED_KEY' ||
      normalized === 'STRIPE_SECRET_KEY_LIVE' ||
      normalized === 'STRIPE_RESTRICTED_KEY_LIVE' ||
      normalized === 'STRIPE_WEBHOOK_SECRET_DEVNET' ||
      normalized === 'STRIPE_WEBHOOK_SECRET' ||
      normalized === 'GOOGLE_APPLICATION_CREDENTIALS' ||
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

function notificationSmokeEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const environment = credentialFreeEnvironment(source);
  for (const name of ['NOTIFICATION_ENQUEUE_SECRET', 'GOOGLE_APPLICATION_CREDENTIALS'] as const) {
    const value = String(source[name] || '').trim();
    if (value) environment[name] = value;
  }
  return environment;
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

function runProcessForOutput(command: string, args: string[], environment: NodeJS.ProcessEnv, label: string): string {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: 'utf8',
    env: environment,
    shell: false,
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  if (result.error) fail(`${label} could not start: ${result.error.message}`);
  if (result.status !== 0) fail(`${label} failed with exit code ${result.status ?? 1}.`, result.status ?? 1);
  return String(result.stdout || '');
}

const queueResourceDependencies: QueueResourceDependencies = {
  create: (name, environment) => runWrangler(
    ['queues', 'create', name, ...configArgs],
    environment,
    `Queue creation: ${name}`,
  ),
  info: (name, environment) => runProcessForOutput(
    wranglerBinary,
    ['queues', 'info', name, ...configArgs],
    environment,
    `Queue inspection: ${name}`,
  ),
};

function pauseRevealDelivery(environment: NodeJS.ProcessEnv, label: string): void {
  runWrangler(
    ['queues', 'pause-delivery', revealQueueName, ...configArgs],
    environment,
    label,
  );
}

function pauseStripeFulfillmentDelivery(environment: NodeJS.ProcessEnv, label: string): void {
  runWrangler(
    ['queues', 'pause-delivery', stripeFulfillmentQueueName, ...configArgs],
    environment,
    label,
  );
}

function assertQueueResource(name: string, output: string): void {
  const lines = output
    .replace(/\u001b\[[0-9;]*m/g, '')
    .split(/\r?\n/)
    .map((line) => line.trim());
  if (!lines.includes(`Queue Name: ${name}`)) {
    fail(`Wrangler did not confirm the exact ${name} queue resource.`);
  }
}

function ensureQueueResource(
  name: string,
  createIfMissing: boolean,
  environment: NodeJS.ProcessEnv,
  dependencies: QueueResourceDependencies = queueResourceDependencies,
): void {
  try {
    assertQueueResource(name, dependencies.info(name, environment));
    return;
  } catch (inspectionError) {
    if (!createIfMissing) throw inspectionError;
    try {
      dependencies.create(name, environment);
    } catch (creationError) {
      try {
        assertQueueResource(name, dependencies.info(name, environment));
        return;
      } catch (verificationError) {
        throw new AggregateError(
          [inspectionError, creationError, verificationError],
          `Unable to safely create or verify queue ${name}.`,
        );
      }
    }
  }
  assertQueueResource(name, dependencies.info(name, environment));
}

function ensureApiQueueResources(
  environment: NodeJS.ProcessEnv,
  dependencies: QueueResourceDependencies = queueResourceDependencies,
): void {
  ensureQueueResource(notificationQueueName, false, environment, dependencies);
  ensureQueueResource(notificationDeadLetterQueueName, false, environment, dependencies);
  ensureQueueResource(revealQueueName, true, environment, dependencies);
  ensureQueueResource(revealDeadLetterQueueName, true, environment, dependencies);
  ensureQueueResource(stripeFulfillmentQueueName, true, environment, dependencies);
  ensureQueueResource(stripeFulfillmentDeadLetterQueueName, true, environment, dependencies);
}

function readCleanSourceCommit(): string {
  const environment = credentialFreeEnvironment();
  const status = runProcessForOutput('git', ['status', '--porcelain'], environment, 'Git status').trim();
  if (status) fail('API candidate upload requires a clean Git worktree.');
  const commit = runProcessForOutput('git', ['rev-parse', '--verify', 'HEAD'], environment, 'Git HEAD').trim().toLowerCase();
  if (!gitCommitPattern.test(commit)) fail('Git HEAD did not resolve to an exact commit.');
  return commit;
}

function parseQueueConsumers(output: string): QueueConsumer[] {
  let value: unknown;
  try {
    value = JSON.parse(output) as unknown;
  } catch {
    fail('Wrangler did not return valid queue consumer JSON.');
  }
  if (!Array.isArray(value)) fail('Wrangler did not return a queue consumer list.');
  return value.map((entry) => {
    if (!isRecord(entry) || !isRecord(entry.settings)) {
      return fail('Wrangler returned an invalid queue consumer.');
    }
    const deadLetterQueue = entry.dead_letter_queue;
    const maxBatchSize = entry.settings.batch_size;
    const maxBatchTimeoutMs = entry.settings.max_wait_time_ms;
    const maxConcurrency = entry.settings.max_concurrency;
    const maxRetries = entry.settings.max_retries;
    const retryDelay = entry.settings.retry_delay;
    const script = entry.script;
    const type = entry.type;
    if (
      typeof deadLetterQueue !== 'string' ||
      typeof maxBatchSize !== 'number' ||
      typeof maxBatchTimeoutMs !== 'number' ||
      typeof maxConcurrency !== 'number' ||
      typeof maxRetries !== 'number' ||
      typeof retryDelay !== 'number' ||
      typeof script !== 'string' ||
      typeof type !== 'string'
    ) {
      return fail('Wrangler returned an invalid queue consumer.');
    }
    return {
      deadLetterQueue,
      maxBatchSize,
      maxBatchTimeoutMs,
      maxConcurrency,
      maxRetries,
      retryDelay,
      script,
      type,
    };
  });
}

function notificationConsumerMatches(consumer: QueueConsumer, script: string): boolean {
  return consumer.script === script &&
    consumer.type === 'worker' &&
    consumer.deadLetterQueue === notificationDeadLetterQueueName &&
    consumer.maxBatchSize === 5 &&
    consumer.maxBatchTimeoutMs === 5_000 &&
    consumer.maxRetries === 5 &&
    consumer.maxConcurrency === 1 &&
    consumer.retryDelay === 0;
}

function assertSoleNotificationConsumer(consumers: readonly QueueConsumer[], script: string): void {
  if (consumers.length !== 1 || !notificationConsumerMatches(consumers[0], script)) {
    fail(`Notification queue must have exactly one reviewed ${script} consumer.`);
  }
}

function revealConsumerMatches(consumer: QueueConsumer, script: string): boolean {
  return consumer.script === script &&
    consumer.type === 'worker' &&
    consumer.deadLetterQueue === revealDeadLetterQueueName &&
    consumer.maxBatchSize === 1 &&
    consumer.maxBatchTimeoutMs === 1_000 &&
    consumer.maxRetries === 10 &&
    consumer.maxConcurrency === 1 &&
    consumer.retryDelay === 0;
}

function assertSoleRevealConsumer(consumers: readonly QueueConsumer[], script: string): void {
  if (consumers.length !== 1 || !revealConsumerMatches(consumers[0], script)) {
    fail(`Reveal queue must have exactly one reviewed ${script} consumer.`);
  }
}

function stripeFulfillmentConsumerMatches(consumer: QueueConsumer, script: string): boolean {
  return consumer.script === script &&
    consumer.type === 'worker' &&
    consumer.deadLetterQueue === stripeFulfillmentDeadLetterQueueName &&
    consumer.maxBatchSize === 1 &&
    consumer.maxBatchTimeoutMs === 1_000 &&
    consumer.maxRetries === 10 &&
    consumer.maxConcurrency === 1 &&
    consumer.retryDelay === 60;
}

function assertSoleStripeFulfillmentConsumer(consumers: readonly QueueConsumer[], script: string): void {
  if (consumers.length !== 1 || !stripeFulfillmentConsumerMatches(consumers[0], script)) {
    fail(`Stripe fulfillment queue must have exactly one reviewed ${script} consumer.`);
  }
}

function readQueueConsumers(
  queueName: string,
  label: string,
  environment: NodeJS.ProcessEnv,
): QueueConsumer[] {
  return parseQueueConsumers(runProcessForOutput(
    wranglerBinary,
    ['queues', 'consumer', 'worker', 'list', queueName, '--json', ...configArgs],
    environment,
    label,
  ));
}

function readNotificationQueueConsumers(environment: NodeJS.ProcessEnv): QueueConsumer[] {
  return readQueueConsumers(notificationQueueName, 'Notification queue consumer inspection', environment);
}

function readRevealQueueConsumers(environment: NodeJS.ProcessEnv): QueueConsumer[] {
  return readQueueConsumers(revealQueueName, 'Reveal queue consumer inspection', environment);
}

function readStripeFulfillmentQueueConsumers(environment: NodeJS.ProcessEnv): QueueConsumer[] {
  return readQueueConsumers(
    stripeFulfillmentQueueName,
    'Stripe fulfillment queue consumer inspection',
    environment,
  );
}

function assertExactQueueConsumers(environment: NodeJS.ProcessEnv): void {
  assertSoleNotificationConsumer(readNotificationQueueConsumers(environment), workerName);
  assertSoleRevealConsumer(readRevealQueueConsumers(environment), workerName);
  assertSoleStripeFulfillmentConsumer(readStripeFulfillmentQueueConsumers(environment), workerName);
}

function assertApprovedApiRollback(manifest: ReleaseManifest, versionId: string): void {
  const targetVersionId = versionId.toLowerCase();
  if (targetVersionId !== manifest.approvedRollback.apiVersionId.toLowerCase()) {
    fail('API rollback version is not the approved target in cloud/release-manifest.json.');
  }
  if (manifest.currentProduction.apiVersionId.toLowerCase() === targetVersionId) {
    fail('No distinct API rollback is approved; deploy a new API version.');
  }
  if (
    manifest.currentProduction.frontendVersionId.toLowerCase() !==
    manifest.approvedRollback.frontendVersionId.toLowerCase()
  ) {
    fail('The live frontend must first be restored to the approved rollback frontend version.');
  }
}

async function closeTail(tail: ChildProcessWithoutNullStreams): Promise<void> {
  if (tail.exitCode !== null) return;
  tail.kill('SIGINT');
  await Promise.race([
    new Promise<void>((resolvePromise) => tail.once('exit', () => resolvePromise())),
    sleep(2_000),
  ]);
  if (tail.exitCode === null) tail.kill('SIGKILL');
}

function notificationSmokeJobId(output: string): string {
  const match = output.match(/^Job ID:\s*([0-9a-f-]{36})$/im);
  if (!match || !versionIdPattern.test(match[1])) fail('Notification smoke did not report an exact job ID.');
  return match[1].toLowerCase();
}

type NotificationSmokeOutcome = 'sent' | 'retry' | 'failed' | null;

function notificationSmokeEvent(value: unknown, jobId: string): NotificationSmokeOutcome {
  if (Array.isArray(value)) {
    for (const entry of value) {
      const outcome = notificationSmokeEvent(entry, jobId);
      if (outcome) return outcome;
    }
    return null;
  }
  if (!isRecord(value)) return null;
  if (value.jobId === jobId) {
    if (value.event === 'notification_email_sent') return 'sent';
    if (value.event === 'notification_email_retry') return 'retry';
    if (value.event === 'notification_email_failed_permanent') return 'failed';
  }
  for (const entry of Object.values(value)) {
    const outcome = notificationSmokeEvent(entry, jobId);
    if (outcome) return outcome;
  }
  return null;
}

function notificationSmokeLogOutcome(output: string, jobId: string): NotificationSmokeOutcome {
  const firstDocument = output.indexOf('{');
  if (firstDocument < 0) return null;
  for (const document of output.slice(firstDocument).trim().split(/(?<=\})\s*(?=\{)/)) {
    if (!document) continue;
    try {
      const outcome = notificationSmokeEvent(JSON.parse(document) as unknown, jobId);
      if (outcome) return outcome;
    } catch {}
  }
  return null;
}

function notificationSmokeLogSucceeded(output: string, jobId: string): boolean {
  return notificationSmokeLogOutcome(output, jobId) === 'sent';
}

async function smokeNotificationDelivery(
  environment: NodeJS.ProcessEnv,
  tailWorkerName = workerName,
): Promise<void> {
  const tail = spawn(wranglerBinary, ['tail', tailWorkerName, '--format', 'json'], {
    cwd: repoRoot,
    env: environment,
    shell: false,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let tailOutput = '';
  tail.stdout.setEncoding('utf8');
  tail.stderr.setEncoding('utf8');
  tail.stdout.on('data', (chunk) => { tailOutput += String(chunk); });
  tail.stderr.on('data', (chunk) => { tailOutput += String(chunk); });
  try {
    await sleep(7_000);
    if (tail.exitCode !== null) fail('Notification live tail ended before the smoke request.');
    const smokeOutput = runProcessForOutput(
      process.platform === 'win32' ? 'npm.cmd' : 'npm',
      ['run', 'test-resend-notification-email', '--', '--kind', 'stripe-manual-review'],
      notificationSmokeEnvironment(),
      'Notification end-to-end smoke',
    );
    const jobId = notificationSmokeJobId(smokeOutput);
    const deadline = Date.now() + notificationSmokeTimeoutMs;
    while (Date.now() < deadline) {
      const outcome = notificationSmokeLogOutcome(tailOutput, jobId);
      if (outcome === 'sent') {
        console.log(`[api-deploy] Notification smoke job ${jobId} sent successfully through ${tailWorkerName}.`);
        return;
      }
      if (outcome === 'retry' || outcome === 'failed') {
        fail(`Notification smoke job ${jobId} did not send successfully.`);
      }
      await sleep(500);
    }
    fail(`Notification smoke job ${jobId} was not observed before the timeout.`);
  } finally {
    await closeTail(tail);
  }
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
  firestoreServiceAccountJson = '',
  firestoreWriterServiceAccountJson = '',
): { directory: string; path: string; dispose: () => void } {
  const secret = heliusApiKey.trim();
  if (!secret) fail('A Helius API key is required for Worker candidate upload.');
  const firestoreSecret = validateFirestoreServiceAccountJson(firestoreServiceAccountJson);
  const firestoreWriterSecret = validateFirestoreWriterServiceAccountJson(firestoreWriterServiceAccountJson);
  let directory: string | undefined;
  try {
    directory = operations.mkdtemp(join(tmpdir(), 'mons-shop-api-secret-'));
    operations.chmod(directory, 0o700);
    if ((operations.stat(directory).mode & 0o777) !== 0o700) fail('Unable to enforce mode 0700 on the temporary secrets directory.');
    const path = join(directory, 'secrets.json');
    operations.write(path, JSON.stringify({
      HELIUS_API_KEY: secret,
      FIRESTORE_SERVICE_ACCOUNT_JSON: firestoreSecret,
      FIRESTORE_WRITER_SERVICE_ACCOUNT_JSON: firestoreWriterSecret,
    }), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
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
  const secrets = value.secrets;
  const triggers = value.triggers;
  if (
    !isRecord(queues) ||
    !hasExactKeys(queues, ['consumers', 'producers']) ||
    !Array.isArray(queues.producers) ||
    queues.producers.length !== 3 ||
    !Array.isArray(queues.consumers) ||
    queues.consumers.length !== 3
  ) {
    return false;
  }
  const notificationProducer = queues.producers[0];
  const revealProducer = queues.producers[1];
  const stripeFulfillmentProducer = queues.producers[2];
  const notificationConsumer = queues.consumers[0];
  const revealConsumer = queues.consumers[1];
  const stripeFulfillmentConsumer = queues.consumers[2];
  return isRecord(triggers) &&
    hasExactKeys(triggers, ['crons']) &&
    Array.isArray(triggers.crons) &&
    triggers.crons.length === 1 &&
    triggers.crons[0] === '*/5 * * * *' &&
    isRecord(secrets) &&
    hasExactKeys(secrets, ['required']) &&
    Array.isArray(secrets.required) &&
    [...secrets.required].sort().join('\0') === [
      'FIRESTORE_SERVICE_ACCOUNT_JSON',
      'FIRESTORE_WRITER_SERVICE_ACCOUNT_JSON',
      'HELIUS_API_KEY',
      'COSIGNER_SECRET',
      'RESEND_API_KEY',
      'NOTIFICATION_ENQUEUE_SECRET',
      'RESEND_CONTACTS_API_KEY',
      'ADDRESS_DECRYPTION_SECRET',
      'SHIPSTATION_API_KEY',
      'SHIPSTATION_SHIP_FROM',
      'STRIPE_SECRET_KEY',
      'STRIPE_RESTRICTED_KEY',
      'STRIPE_SECRET_KEY_LIVE',
      'STRIPE_RESTRICTED_KEY_LIVE',
      'STRIPE_WEBHOOK_SECRET_DEVNET',
      'STRIPE_WEBHOOK_SECRET',
    ].sort().join('\0') &&
    isRecord(route) &&
    hasExactKeys(route, ['pattern', 'custom_domain']) &&
    route.pattern === new URL(productionUrl).hostname &&
    route.custom_domain === true &&
    isRecord(notificationProducer) &&
    hasExactKeys(notificationProducer, ['binding', 'queue']) &&
    notificationProducer.binding === 'NOTIFICATION_EMAIL_QUEUE' &&
    notificationProducer.queue === notificationQueueName &&
    isRecord(revealProducer) &&
    hasExactKeys(revealProducer, ['binding', 'queue']) &&
    revealProducer.binding === 'REVEAL_BACKGROUND_QUEUE' &&
    revealProducer.queue === revealQueueName &&
    isRecord(stripeFulfillmentProducer) &&
    hasExactKeys(stripeFulfillmentProducer, ['binding', 'queue']) &&
    stripeFulfillmentProducer.binding === 'STRIPE_FULFILLMENT_QUEUE' &&
    stripeFulfillmentProducer.queue === stripeFulfillmentQueueName &&
    isRecord(notificationConsumer) &&
    hasExactKeys(notificationConsumer, [
      'dead_letter_queue',
      'max_batch_size',
      'max_batch_timeout',
      'max_concurrency',
      'max_retries',
      'queue',
    ]) &&
    notificationConsumer.queue === notificationQueueName &&
    notificationConsumer.dead_letter_queue === notificationDeadLetterQueueName &&
    notificationConsumer.max_batch_size === 5 &&
    notificationConsumer.max_batch_timeout === 5 &&
    notificationConsumer.max_retries === 5 &&
    notificationConsumer.max_concurrency === 1 &&
    isRecord(revealConsumer) &&
    hasExactKeys(revealConsumer, [
      'dead_letter_queue',
      'max_batch_size',
      'max_batch_timeout',
      'max_concurrency',
      'max_retries',
      'queue',
    ]) &&
    revealConsumer.queue === revealQueueName &&
    revealConsumer.dead_letter_queue === revealDeadLetterQueueName &&
    revealConsumer.max_batch_size === 1 &&
    revealConsumer.max_batch_timeout === 1 &&
    revealConsumer.max_retries === 10 &&
    revealConsumer.max_concurrency === 1 &&
    isRecord(stripeFulfillmentConsumer) &&
    hasExactKeys(stripeFulfillmentConsumer, [
      'dead_letter_queue',
      'max_batch_size',
      'max_batch_timeout',
      'max_concurrency',
      'max_retries',
      'queue',
      'retry_delay',
    ]) &&
    stripeFulfillmentConsumer.queue === stripeFulfillmentQueueName &&
    stripeFulfillmentConsumer.dead_letter_queue === stripeFulfillmentDeadLetterQueueName &&
    stripeFulfillmentConsumer.max_batch_size === 1 &&
    stripeFulfillmentConsumer.max_batch_timeout === 1 &&
    stripeFulfillmentConsumer.max_retries === 10 &&
    stripeFulfillmentConsumer.max_concurrency === 1 &&
    stripeFulfillmentConsumer.retry_delay === 60;
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
      `API Wrangler config must target only ${workerName}, account ${accountId}, the ${new URL(productionUrl).hostname} custom domain, the reviewed queues, and the Stripe fulfillment reconciliation schedule.`,
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
    'sourceCommit',
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
    typeof record.sourceCommit === 'string' && gitCommitPattern.test(record.sourceCommit) &&
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

function writeCandidateRecord(
  metadata: UploadMetadata,
  smokeOwner: string,
  benchmark: ApiBenchmarkResult,
  sourceCommit: string,
): void {
  const record: CandidateRecord = {
    workerName,
    ...metadata,
    includeDevnet: true,
    smokeOwner,
    sourceCommit,
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
  for (const delay of SMOKE_PROPAGATION_DELAYS_MS) {
    if (delay) await new Promise((resolvePromise) => setTimeout(resolvePromise, delay));
    const startedAt = performance.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { ...init, redirect: 'manual', signal: controller.signal });
      if (
        (response.status === 404 || response.status === 502 || response.status === 504) &&
        delay !== SMOKE_PROPAGATION_DELAYS_MS.at(-1)
      ) {
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
      if (delay === SMOKE_PROPAGATION_DELAYS_MS.at(-1)) fail(`${label} failed after bounded retries.`);
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

  if (options.includeStripeWebhook === true) {
    const stripeWebhook = await request(`${baseUrl}/webhooks/stripe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    }, 'Stripe webhook configuration smoke request');
    if (stripeWebhook.response.status !== 400) fail('Stripe webhook configuration smoke response was invalid.');
    assertResponseHeaders(stripeWebhook.response, 'Stripe webhook configuration smoke response');
  }

  if (options.includeProfileState === true) {
    for (const [pathname, body] of [
      ['/auth/solana', { wallet: defaultSmokeOwner, message: 'smoke', signature: Array(64).fill(0) }],
      ['/claims/irl/prepare', { owner: defaultSmokeOwner, code: '0000000000' }],
      ['/receipts/stripe/claim', { code: 'ABCDEF-1234567890', recipient: defaultSmokeOwner }],
      ['/receipts/transfer/prepare', {
        owner: defaultSmokeOwner,
        dropId: expectedReleaseDropId,
        receiptAssetId: defaultSmokeOwner,
        destination: '11111111111111111111111111111112',
      }],
      ['/delivery/prepare', {
        owner: defaultSmokeOwner,
        dropId: expectedReleaseDropId,
        itemIds: ['11111111111111111111111111111112'],
        addressId: 'AbCdEfGhIjKlMnOpQrSt',
      }],
      ['/delivery/receipts/issue', {
        owner: defaultSmokeOwner,
        dropId: expectedReleaseDropId,
        deliveryId: 1,
        signature: '1'.repeat(64),
      }],
      ['/delivery/receipts/recover', { dropId: expectedReleaseDropId }],
      ['/admin/irl-redeem/prepare', {
        owner: defaultSmokeOwner,
        dropId: 'card_nft_2',
        itemIds: ['11111111111111111111111111111112'],
      }],
      ['/admin/irl-redeem/finalize', {
        requestId: 'AbCdEfGhIjKlMnOpQrSt',
        dropId: 'card_nft_2',
        transferSignature: '1'.repeat(64),
      }],
      ['/boxes/reveal', {
        owner: defaultSmokeOwner,
        boxAssetId: '11111111111111111111111111111112',
        dropId: expectedReleaseDropId,
      }],
      ['/checkout/session', { dropId: 'card_nft_binder_devnet' }],
      ['/profile/reconcile', {}],
      ['/profile/state', {}],
      ['/profile/addresses', { encrypted: 'smoke', country: 'US', hint: 'smoke' }],
      ['/admin/delivery-order-owners', {}],
      ['/fulfillment/orders', { dropId: 'card_nft_2', limit: 1 }],
      ['/fulfillment/order-address', { dropId: 'card_nft_2', deliveryId: 1, full: 'smoke' }],
      ['/fulfillment/order-status', { dropId: 'card_nft_2', deliveryId: 1, status: 'Preparing' }],
      ['/fulfillment/manual-review-checkouts', { dropId: 'card_nft_2' }],
      ['/fulfillment/shipstation-label', { dropId: 'card_nft_2', deliveryId: 1 }],
      ['/fulfillment/shipstation-label-purchase', {
        dropId: 'card_nft_2',
        deliveryId: 1,
        rateId: 'rate-1',
        expectedTotal: { currency: 'usd', amount: 12 },
        requestId: '6ba7b810-9dad-11d1-80b4-00c04fd430c8',
      }],
      ['/fulfillment/shipstation-label-void', {
        dropId: 'card_nft_2',
        deliveryId: 1,
        labelId: 'se-label',
      }],
      ['/fulfillment/shipstation-rates', { dropId: 'card_nft_2', deliveryId: 1 }],
      ['/fulfillment/shipstation-shipment', { dropId: 'card_nft_2', deliveryId: 1 }],
    ] as const) {
      const capability = await request(`${baseUrl}${pathname}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: 'https://mons.shop' },
        body: JSON.stringify(body),
      }, `${pathname} capability smoke request`);
      const payload = await capability.response.json() as { error?: { code?: unknown } };
      if (
        capability.response.status !== 401 ||
        capability.response.headers.get('access-control-allow-origin') !== 'https://mons.shop' ||
        payload.error?.code !== 'unauthenticated'
      ) fail(`${pathname} capability smoke response was invalid.`);
      assertResponseHeaders(capability.response, `${pathname} capability smoke response`);
    }
  }

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
  const deploy = (label: string): void => {
    dependencies.wrangler(args, input.wranglerEnvironment, label);
    dependencies.verifyQueueConsumers?.(input.wranglerEnvironment);
  };
  try {
    deploy('Reviewed trigger deployment');
  } catch (firstError) {
    try {
      deploy('Reviewed trigger deployment retry');
      console.log('[api-deploy] Reviewed trigger deployment converged on its declarative retry.');
    } catch (retryError) {
      throw new AggregateError(
        [firstError, retryError],
        'Reviewed API trigger deployment failed twice; the exact candidate remains live with stateful queues paused.',
      );
    }
  }
}

function deployApiTriggersWithoutReconciliationSchedule(
  environment: NodeJS.ProcessEnv,
  wrangler: typeof runWrangler = runWrangler,
): void {
  const directory = mkdtempSync(join(tmpdir(), 'mons-shop-api-rollback-triggers-'));
  chmodSync(directory, 0o700);
  const path = join(directory, 'wrangler.json');
  const config = JSON.parse(readFileSync(resolve(repoRoot, configPath), 'utf8')) as Record<string, unknown>;
  delete config.$schema;
  config.main = resolve(repoRoot, 'cloud/workers/api/src/index.ts');
  config.triggers = { crons: [] };
  writeFileSync(path, `${JSON.stringify(config)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  try {
    wrangler(
      ['triggers', 'deploy', '--config', path, '--env-file', releaseEnvPath],
      environment,
      'Disable Stripe reconciliation schedule before approved API rollback',
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
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

function revealQueuePausedFailure(error: unknown, message: string): Error {
  return new Error(
    `${message} Stateful queue delivery remains paused. Fix forward, then rerun the production command with the same exact candidate for guarded resume.`,
    { cause: error },
  );
}

function productionCandidateSmoke(input: ProductionSequenceInput): SmokeApiOptions {
  return input.candidateSmoke || { includeDevnet: true, includeStripeWebhook: true, owner: input.smokeOwner };
}

function repauseStatefulQueuesAfterFailure(
  error: unknown,
  reveal: (() => void) | undefined,
  fulfillment: (() => void) | undefined,
  message: string,
): void {
  const repauseErrors: unknown[] = [];
  if (!reveal) {
    repauseErrors.push(new Error('No reveal re-pause operation was configured.'));
  } else {
    try {
      reveal();
    } catch (repauseError) {
      repauseErrors.push(repauseError);
    }
  }
  if (fulfillment) {
    try {
      fulfillment();
    } catch (repauseError) {
      repauseErrors.push(repauseError);
    }
  }
  if (repauseErrors.length) throw new AggregateError([error, ...repauseErrors], message);
}

function repauseRevealQueueAfterFailure(
  error: unknown,
  input: ProductionSequenceInput,
  dependencies: ProductionSequenceDependencies,
): void {
  const repause = dependencies.repauseRevealQueue ?? dependencies.pauseRevealQueue;
  const repauseFulfillment = dependencies.repauseFulfillmentQueue ?? dependencies.pauseFulfillmentQueue;
  repauseStatefulQueuesAfterFailure(
    error,
    repause ? () => repause(input.wranglerEnvironment) : undefined,
    repauseFulfillment ? () => repauseFulfillment(input.wranglerEnvironment) : undefined,
    'Stateful queue delivery could not be fully re-paused after a post-resume failure. Inspect production immediately.',
  );
}

function restoreStatefulQueuesAfterPauseFailure(
  error: unknown,
  environment: NodeJS.ProcessEnv,
  dependencies: Pick<
    ProductionSequenceDependencies,
    'pauseRevealQueue' | 'pauseFulfillmentQueue' | 'resumeRevealQueue' | 'resumeFulfillmentQueue'
  >,
  message: string,
): never {
  const restoreErrors: unknown[] = [];
  for (const [pause, resume, label] of [
    [dependencies.pauseFulfillmentQueue, dependencies.resumeFulfillmentQueue, 'fulfillment'],
    [dependencies.pauseRevealQueue, dependencies.resumeRevealQueue, 'reveal'],
  ] as const) {
    if (!pause) continue;
    if (!resume) {
      restoreErrors.push(new Error(`No ${label} queue resume operation was configured.`));
      continue;
    }
    try {
      resume(environment);
    } catch (restoreError) {
      restoreErrors.push(restoreError);
    }
  }
  if (restoreErrors.length) {
    throw new AggregateError(
      [error, ...restoreErrors],
      `${message} Queue delivery could not be fully restored; inspect production immediately.`,
    );
  }
  throw new Error(`${message} Queue delivery was restored; no version mutation was attempted.`, { cause: error });
}

async function runProductionSequence(
  input: ProductionSequenceInput,
  dependencies: ProductionSequenceDependencies = {
    benchmark: benchmarkApi,
    deployment: readApiDeploymentStatus,
    evidence: writeProductionEvidence,
    notificationSmoke: smokeNotificationDelivery,
    pauseRevealQueue: (environment) => pauseRevealDelivery(
      environment,
      'Reveal queue pause before trigger deployment',
    ),
    pauseFulfillmentQueue: (environment) => pauseStripeFulfillmentDelivery(
      environment,
      'Stripe fulfillment queue pause before trigger deployment',
    ),
    repauseRevealQueue: (environment) => pauseRevealDelivery(
      environment,
      'Reveal queue re-pause after verification failure',
    ),
    repauseFulfillmentQueue: (environment) => pauseStripeFulfillmentDelivery(
      environment,
      'Stripe fulfillment queue re-pause after verification failure',
    ),
    resumeRevealQueue: (environment) => runWrangler(
      ['queues', 'resume-delivery', revealQueueName, ...configArgs],
      environment,
      'Reveal queue resume after exact candidate promotion',
    ),
    resumeFulfillmentQueue: (environment) => runWrangler(
      ['queues', 'resume-delivery', stripeFulfillmentQueueName, ...configArgs],
      environment,
      'Stripe fulfillment queue resume after exact candidate promotion',
    ),
    sleep,
    smoke: smokeApi,
    verifyQueueConsumers: assertExactQueueConsumers,
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

  try {
    dependencies.pauseRevealQueue?.(input.wranglerEnvironment);
    dependencies.pauseFulfillmentQueue?.(input.wranglerEnvironment);
  } catch (error) {
    restoreStatefulQueuesAfterPauseFailure(
      error,
      input.wranglerEnvironment,
      dependencies,
      'Stateful queue delivery could not be paused.',
    );
  }
  if (!releaseStart.resumeCandidate) {
    try {
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
    } catch (error) {
      throw revealQueuePausedFailure(error, 'API pre-promotion verification failed.');
    }

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
        const failure = new AggregateError(
          [promotionError, stateError],
          'API exact-version promotion failed and live mutation state could not be safely reconciled.',
        );
        throw revealQueuePausedFailure(failure, failure.message);
      }
      const failure = new Error(
        'API exact-version promotion returned, but live mutation state could not be safely reconciled.',
        { cause: stateError },
      );
      throw revealQueuePausedFailure(failure, failure.message);
    }
    if (observedVersionId !== candidateVersionId) {
      const failure = promotionError ?? new Error(`API exact-version promotion left baseline ${observedVersionId} live.`);
      throw revealQueuePausedFailure(failure, 'API promotion did not make the exact candidate live.');
    }
    if (promotionError !== undefined) {
      throw revealQueuePausedFailure(
        promotionError,
        `API candidate ${candidateVersionId} appears live, but the promotion command failed.`,
      );
    }
  }

  try {
    deployReviewedApiTriggers(input, dependencies);
  } catch (error) {
    throw revealQueuePausedFailure(
      error,
      `API candidate ${candidateVersionId} is live, but reviewed triggers could not be verified.`,
    );
  }

  if (dependencies.resumeRevealQueue || dependencies.resumeFulfillmentQueue) {
    try {
      await assertApiLiveVersion(
        candidateVersionId,
        input,
        dependencies,
        'API exact candidate pre-resume guard',
      );
    } catch (error) {
      throw revealQueuePausedFailure(error, 'API exact candidate could not be reverified before resuming reveal delivery.');
    }
  }

  let revealResumeAttempted = false;
  let fulfillmentResumeAttempted = false;
  try {
    if (dependencies.resumeRevealQueue) {
      revealResumeAttempted = true;
      dependencies.resumeRevealQueue(input.wranglerEnvironment);
    }
    if (dependencies.resumeFulfillmentQueue) {
      fulfillmentResumeAttempted = true;
      dependencies.resumeFulfillmentQueue(input.wranglerEnvironment);
    }
    await dependencies.smoke(productionUrl, candidateSmoke);
    await dependencies.notificationSmoke?.(input.wranglerEnvironment, workerName);
    await assertApiLiveVersion(
      candidateVersionId,
      input,
      dependencies,
      'API production commit verification',
    );
    dependencies.evidence('api', candidateVersionId);
  } catch (error) {
    if (revealResumeAttempted || fulfillmentResumeAttempted) {
      repauseRevealQueueAfterFailure(error, input, dependencies);
    }
    throw revealQueuePausedFailure(
      error,
      `API candidate ${candidateVersionId} failed post-resume verification.`,
    );
  }
}

async function uploadApiCandidate(input: {
  apiToken: string;
  candidateSmoke: SmokeApiOptions;
  firestoreServiceAccountJson: string;
  firestoreWriterServiceAccountJson: string;
  heliusApiKey: string;
  logsDirectory: string;
  smokeOwner: string;
  wranglerEnvironment: NodeJS.ProcessEnv;
}): Promise<UploadMetadata> {
  if (input.candidateSmoke.owner !== input.smokeOwner) fail('Candidate smoke owner did not match the upload owner.');
  const sourceCommit = readCleanSourceCommit();
  const secretFile = createSecretFile(
    secretFileOperations,
    input.heliusApiKey,
    input.firestoreServiceAccountJson,
    input.firestoreWriterServiceAccountJson,
  );
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
    writeCandidateRecord(metadata, input.smokeOwner, benchmark, sourceCommit);
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

async function runRollbackSequence(
  input: RollbackSequenceInput,
  dependencies: RollbackSequenceDependencies = {
    apiDeployment: readApiDeploymentStatus,
    disableReconciliationSchedule: deployApiTriggersWithoutReconciliationSchedule,
    evidence: writeProductionEvidence,
    frontendDeployment: readFrontendDeploymentStatus,
    notificationSmoke: smokeNotificationDelivery,
    pauseRevealQueue: (environment) => pauseRevealDelivery(
      environment,
      'Reveal queue pause before approved API rollback',
    ),
    pauseFulfillmentQueue: (environment) => pauseStripeFulfillmentDelivery(
      environment,
      'Stripe fulfillment queue pause before approved API rollback',
    ),
    record: recordApiProductionVersion,
    repauseRevealQueue: (environment) => pauseRevealDelivery(
      environment,
      'Reveal queue re-pause after rollback verification failure',
    ),
    repauseFulfillmentQueue: (environment) => pauseStripeFulfillmentDelivery(
      environment,
      'Stripe fulfillment queue re-pause after rollback verification failure',
    ),
    resumeRevealQueue: (environment) => runWrangler(
      ['queues', 'resume-delivery', revealQueueName, ...configArgs],
      environment,
      'Reveal queue resume after approved API rollback',
    ),
    resumeFulfillmentQueue: (environment) => runWrangler(
      ['queues', 'resume-delivery', stripeFulfillmentQueueName, ...configArgs],
      environment,
      'Stripe fulfillment queue resume after approved API rollback',
    ),
    sleep,
    smoke: smokeApi,
    verifyQueueConsumers: assertExactQueueConsumers,
    wrangler: runWrangler,
  },
): Promise<void> {
  const targetVersionId = input.versionId.toLowerCase();
  assertApprovedApiRollback(input.manifest, targetVersionId);
  const initialLivePair = await readStableReleasePair(input.wranglerEnvironment, dependencies);
  assertReleasePair(initialLivePair, input.manifest.currentProduction, 'Rollback preflight');

  try {
    dependencies.pauseRevealQueue(input.wranglerEnvironment);
    dependencies.pauseFulfillmentQueue?.(input.wranglerEnvironment);
    dependencies.disableReconciliationSchedule(input.wranglerEnvironment);
    await dependencies.sleep(CRON_TRIGGER_PROPAGATION_MS);
  } catch (error) {
    restoreStatefulQueuesAfterPauseFailure(
      error,
      input.wranglerEnvironment,
      dependencies,
      'Stateful delivery could not be paused and the reconciliation schedule fully disabled.',
    );
  }

  let resumeAttempted = false;
  let fulfillmentResumeAttempted = false;
  try {
    dependencies.wrangler([
      'rollback',
      targetVersionId,
      '--yes',
      '--message',
      'Explicit approved mons-shop-api rollback',
      ...configArgs,
    ], input.wranglerEnvironment, 'Approved API rollback');
    const observedVersionId = await reconcileCloudflareStableVersion({
      allowedPendingVersionIds: [input.manifest.currentProduction.apiVersionId],
      preferredVersionId: targetVersionId,
      read: () => dependencies.apiDeployment(input.wranglerEnvironment),
      sleep: dependencies.sleep,
      workerLabel: workerName,
    });
    if (observedVersionId !== targetVersionId) {
      throw new Error(`API rollback left version ${observedVersionId} live.`);
    }
    const pausedPair = await readStableReleasePair(input.wranglerEnvironment, dependencies);
    assertReleasePair(pausedPair, input.manifest.approvedRollback, 'Paused rollback verification');
    dependencies.verifyQueueConsumers(input.wranglerEnvironment);
    await dependencies.smoke(productionUrl, { includeDevnet: true, owner: input.smokeOwner });

    resumeAttempted = true;
    dependencies.resumeRevealQueue(input.wranglerEnvironment);
    if (dependencies.resumeFulfillmentQueue) {
      fulfillmentResumeAttempted = true;
      dependencies.resumeFulfillmentQueue(input.wranglerEnvironment);
    }
    await dependencies.smoke(productionUrl, { includeDevnet: true, owner: input.smokeOwner });
    await dependencies.notificationSmoke?.(input.wranglerEnvironment, workerName);
    const finalLivePair = await readStableReleasePair(input.wranglerEnvironment, dependencies);
    assertReleasePair(finalLivePair, input.manifest.approvedRollback, 'Rollback commit verification');
    dependencies.evidence('api', targetVersionId);
    dependencies.record(targetVersionId, {
      expectedCurrentProduction: input.manifest.currentProduction,
    });
  } catch (error) {
    if (resumeAttempted || fulfillmentResumeAttempted) {
      repauseStatefulQueuesAfterFailure(
        error,
        () => dependencies.repauseRevealQueue(input.wranglerEnvironment),
        dependencies.repauseFulfillmentQueue
          ? () => dependencies.repauseFulfillmentQueue?.(input.wranglerEnvironment)
          : undefined,
        'API rollback failed and stateful queue delivery could not be re-paused. Inspect production immediately.',
      );
    }
    throw new Error(
      'Approved API rollback failed. Stateful queue delivery remains paused; inspect the live pair before retrying the exact approved rollback.',
      { cause: error },
    );
  }
}

async function runCompleteApiRelease(
  input: CompleteApiReleaseInput,
  dependencies: CompleteApiReleaseDependencies = {
    apiDeployment: readApiDeploymentStatus,
    frontendDeployment: readFrontendDeploymentStatus,
    manifest: readReleaseManifest,
    prepareQueues: ensureApiQueueResources,
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
  dependencies.prepareQueues?.(input.wranglerEnvironment);

  const candidateSmoke: SmokeApiOptions = {
    expectedInventoryDropId: expectedReleaseDropId,
    forbiddenInventoryDropId: forbiddenReleaseDropId,
    includeDevnet: true,
    includeNotificationSubscription: true,
    includePackStatus: true,
    includeProfileState: true,
    includeStripeWebhook: true,
    owner: input.smokeOwner,
  };
  const metadata = await dependencies.upload({
    apiToken: input.apiToken,
    candidateSmoke,
    firestoreServiceAccountJson: input.firestoreServiceAccountJson,
    firestoreWriterServiceAccountJson: input.firestoreWriterServiceAccountJson,
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
    const firestoreServiceAccountJson = readFirestoreServiceAccount(options.firestoreServiceAccountFile);
    const firestoreWriterServiceAccountJson = readFirestoreWriterServiceAccount(options.firestoreWriterServiceAccountFile);
    await verifyFirestoreWriterAccess(firestoreWriterServiceAccountJson);
    const apiToken = readApiToken(options.tokenFile);
    const wranglerEnvironment = authenticatedWranglerEnvironment(apiToken);
    assertSoleNotificationConsumer(readNotificationQueueConsumers(wranglerEnvironment), workerName);
    const metadata = await runCompleteApiRelease({
      apiToken,
      checkEnvironment,
      firestoreServiceAccountJson,
      firestoreWriterServiceAccountJson,
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
    const firestoreServiceAccountJson = readFirestoreServiceAccount(options.firestoreServiceAccountFile);
    const firestoreWriterServiceAccountJson = readFirestoreWriterServiceAccount(options.firestoreWriterServiceAccountFile);
    await verifyFirestoreWriterAccess(firestoreWriterServiceAccountJson);
    runApiValidation();
    const apiToken = readApiToken(options.tokenFile);
    const wranglerEnvironment = authenticatedWranglerEnvironment(apiToken);
    ensureApiQueueResources(wranglerEnvironment);
    assertSoleNotificationConsumer(readNotificationQueueConsumers(wranglerEnvironment), workerName);
    await uploadApiCandidate({
      apiToken,
      candidateSmoke: { includeDevnet: true, includeNotificationSubscription: true, includePackStatus: true, includeProfileState: true, includeStripeWebhook: true, owner: options.smokeOwner },
      firestoreServiceAccountJson,
      firestoreWriterServiceAccountJson,
      heliusApiKey,
      logsDirectory,
      smokeOwner: options.smokeOwner,
      wranglerEnvironment,
    });
    return;
  }

  if (options.mode === 'production') {
    runWrangler(['triggers', 'deploy', '--dry-run', ...configArgs], checkEnvironment, 'Trigger configuration dry-run');
  }
  const apiToken = readApiToken(options.tokenFile);
  const wranglerEnvironment = authenticatedWranglerEnvironment(apiToken);
  ensureApiQueueResources(wranglerEnvironment);
  assertSoleNotificationConsumer(readNotificationQueueConsumers(wranglerEnvironment), workerName);

  if (options.mode === 'rollback') {
    const manifest = readReleaseManifest();
    await runRollbackSequence({
      manifest,
      smokeOwner: options.smokeOwner,
      versionId: options.versionId!,
      wranglerEnvironment,
    });
    console.log(`[api-deploy] Rolled back and verified version ${options.versionId}; release metadata was updated.`);
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
      candidateSmoke: { includeDevnet: true, includeNotificationSubscription: true, includePackStatus: true, includeProfileState: true, includeStripeWebhook: true, owner: options.smokeOwner },
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
}

export const deployApiTestHooks = {
  assertApiDeploymentConfig,
  assertInventorySmokeDrops,
  authenticatedWranglerEnvironment,
  candidateRecordPath,
  createSecretFile,
  defaultSmokeOwner,
  notificationSmokeEmail,
  notificationSmokeEnvironment,
  notificationSmokeJobId,
  notificationSmokeLogOutcome,
  notificationSmokeLogSucceeded,
  smokePropagationDelaysMs: SMOKE_PROPAGATION_DELAYS_MS,
  defaultSmokeTimeoutMs: DEFAULT_SMOKE_TIMEOUT_MS,
  expectedReleaseDropId,
  expectedPreviewOrigin,
  ensureApiQueueResources,
  ensureQueueResource,
  installTerminationCleanup,
  inventorySmokeTimeoutMs: INVENTORY_SMOKE_TIMEOUT_MS,
  isExactApiDeploymentConfig,
  isCandidateRecord,
  isReleaseManifest,
  parseArgs,
  parseQueueConsumers,
  parseUploadMetadata,
  removeSecretDirectory,
  readReleaseManifest,
  readFirestoreServiceAccount,
  readFirestoreWriterServiceAccount,
  readStableReleasePair,
  deployApiTriggersWithoutReconciliationSchedule,
  repauseRevealQueueAfterFailure,
  requireCandidateRecord,
  resolveHeliusApiKey,
  resolveApiProductionPreviewUrl,
  runApiValidation,
  runCompleteApiRelease,
  runProductionSequence,
  runRollbackSequence,
  secretFileOperations,
  smokeApi,
  validationEnvironment,
  validateFirestoreServiceAccountJson,
  validateFirestoreWriterServiceAccountJson,
  assertQueueResource,
  assertApprovedApiRollback,
  assertSoleRevealConsumer,
  assertSoleNotificationConsumer,
  assertSoleStripeFulfillmentConsumer,
  stripeFulfillmentConsumerMatches,
  assertExactQueueConsumers,
  verifyFirestoreWriterAccess,
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    const message = formatCloudflareReleaseError(error);
    const exitCode = cloudflareReleaseExitCode(error);
    console.error(`\n[api-deploy] ${message}\n`);
    process.exitCode = exitCode;
  });
}
