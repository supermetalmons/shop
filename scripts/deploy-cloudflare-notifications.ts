import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  readWranglerDeploymentStatus,
  stableCloudflareVersionId,
} from './cloudflare-deployment-state.ts';
import { cloudflareVersionIdPattern } from './finalize-cloudflare-release.ts';

type NotificationReleaseManifest = {
  schemaVersion: 1;
  recordedAt: string;
  currentProductionVersionId: string;
  approvedRollbackVersionId: string;
};

type ReleaseMode = 'release' | 'rollback';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const wranglerBinary = resolve(repoRoot, 'node_modules', '.bin', process.platform === 'win32' ? 'wrangler.cmd' : 'wrangler');
const configPath = 'cloud/workers/notifications/wrangler.jsonc';
const releaseEnvPath = 'cloud/workers/notifications/release.env';
const manifestPath = resolve(repoRoot, 'cloud/notifications-release-manifest.json');
const configArgs = ['--config', configPath, '--env-file', releaseEnvPath] as const;
const workerName = 'mons-shop-notifications';
const accountId = 'e25f90fc073ea309b54b8b5144bf28e0';
const smokeTimeoutMs = 45_000;

function fail(message: string): never {
  throw new Error(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}

export function isNotificationReleaseManifest(value: unknown): value is NotificationReleaseManifest {
  if (!isRecord(value) || !hasExactKeys(value, [
    'schemaVersion',
    'recordedAt',
    'currentProductionVersionId',
    'approvedRollbackVersionId',
  ])) return false;
  return value.schemaVersion === 1 &&
    typeof value.recordedAt === 'string' && Number.isFinite(Date.parse(value.recordedAt)) &&
    typeof value.currentProductionVersionId === 'string' && cloudflareVersionIdPattern.test(value.currentProductionVersionId) &&
    typeof value.approvedRollbackVersionId === 'string' && cloudflareVersionIdPattern.test(value.approvedRollbackVersionId);
}

export function readNotificationReleaseManifest(path = manifestPath): NotificationReleaseManifest {
  const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!isNotificationReleaseManifest(value)) fail('Notification release manifest is invalid.');
  return value;
}

export function parseNotificationUploadMetadata(output: string): string {
  for (const line of output.trim().split(/\r?\n/).reverse()) {
    try {
      const value = JSON.parse(line) as Record<string, unknown>;
      if (
        value.type === 'version-upload' &&
        value.worker_name === workerName &&
        typeof value.version_id === 'string' &&
        cloudflareVersionIdPattern.test(value.version_id)
      ) return value.version_id.toLowerCase();
    } catch {}
  }
  return fail('Wrangler did not report an exact notification Worker version.');
}

export function notificationSmokeJobId(output: string): string {
  const match = output.match(/^Job ID:\s*([0-9a-f-]{36})$/im);
  if (!match || !cloudflareVersionIdPattern.test(match[1])) fail('Notification smoke did not report an exact job ID.');
  return match[1].toLowerCase();
}

export function notificationSmokeLogSucceeded(output: string, jobId: string): boolean {
  return output.includes(jobId) && output.includes('notification_email_sent');
}

function parseArgs(argv: string[]): { mode: ReleaseMode; versionId?: string } {
  if (!argv.length) return { mode: 'release' };
  if (argv[0] !== 'rollback' || argv[1] !== '--version-id' || !argv[2] || argv.length !== 3) {
    fail('Usage: npm run deploy:notifications -- [rollback --version-id <uuid>]');
  }
  if (!cloudflareVersionIdPattern.test(argv[2])) fail('Rollback requires an exact version UUID.');
  return { mode: 'rollback', versionId: argv[2].toLowerCase() };
}

function credentialFreeEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const environment = { ...source };
  for (const name of Object.keys(environment)) {
    const normalized = name.toUpperCase();
    if (
      normalized.startsWith('CLOUDFLARE_') ||
      normalized.startsWith('CF_') ||
      normalized.startsWith('WRANGLER_') ||
      normalized === 'RESEND_API_KEY' ||
      normalized === 'NOTIFICATION_ENQUEUE_SECRET' ||
      normalized === 'FIRESTORE_SERVICE_ACCOUNT_JSON' ||
      normalized === 'FIRESTORE_WRITER_SERVICE_ACCOUNT_JSON' ||
      normalized === 'GOOGLE_APPLICATION_CREDENTIALS'
    ) delete environment[name];
  }
  return environment;
}

function authenticatedEnvironment(): NodeJS.ProcessEnv {
  const token = String(process.env.CLOUDFLARE_API_TOKEN || '').trim();
  if (!token) fail('CLOUDFLARE_API_TOKEN is required.');
  return {
    ...credentialFreeEnvironment(),
    CLOUDFLARE_API_TOKEN: token,
    WRANGLER_LOG_PATH: resolve(repoRoot, '.cache', 'wrangler-logs'),
    WRANGLER_LOG_SANITIZE: 'true',
    WRANGLER_SEND_ERROR_REPORTS: 'false',
    WRANGLER_SEND_METRICS: 'false',
  };
}

function run(command: string, args: string[], label: string, environment: NodeJS.ProcessEnv, capture = false): string {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: 'utf8',
    env: environment,
    shell: false,
    stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
  });
  if (result.error) fail(`${label} could not start: ${result.error.message}`);
  if (result.status !== 0) fail(`${label} failed with exit code ${result.status ?? 1}.`);
  return String(result.stdout || '');
}

function assertCleanWorktree(): void {
  const status = run('git', ['status', '--porcelain'], 'Git status', process.env, true).trim();
  if (status) fail('Notification release requires a clean Git worktree.');
}

function assertDeploymentConfig(): void {
  const config = JSON.parse(readFileSync(resolve(repoRoot, configPath), 'utf8')) as unknown;
  if (!isRecord(config)) fail('Notification Worker config is invalid.');
  const consumers = isRecord(config.queues) && Array.isArray(config.queues.consumers) ? config.queues.consumers : [];
  const consumer = consumers[0];
  if (
    config.name !== workerName ||
    config.account_id !== accountId ||
    config.workers_dev !== false ||
    config.preview_urls !== false ||
    Object.hasOwn(config, 'routes') ||
    consumers.length !== 1 ||
    !isRecord(consumer) ||
    consumer.queue !== 'mons-shop-notification-emails' ||
    consumer.dead_letter_queue !== 'mons-shop-notification-emails-dlq' ||
    consumer.max_retries !== 5 ||
    consumer.max_concurrency !== 1
  ) fail('Notification Worker config does not match the reviewed production target.');
}

function liveVersion(environment: NodeJS.ProcessEnv): string {
  return stableCloudflareVersionId(readWranglerDeploymentStatus({
    configArgs,
    cwd: repoRoot,
    environment,
    wranglerBinary,
  }));
}

function uploadCandidate(environment: NodeJS.ProcessEnv): string {
  const outputDirectory = resolve(repoRoot, '.cache', 'wrangler-logs');
  mkdirSync(outputDirectory, { recursive: true });
  const outputPath = resolve(outputDirectory, `notifications-upload-${process.pid}-${Date.now()}.json`);
  try {
    run(wranglerBinary, [
      'versions', 'upload', '--strict', ...configArgs,
    ], 'Notification candidate upload', {
      ...environment,
      WRANGLER_OUTPUT_FILE_PATH: outputPath,
    });
    return parseNotificationUploadMetadata(readFileSync(outputPath, 'utf8'));
  } finally {
    rmSync(outputPath, { force: true });
  }
}

function deployVersion(versionId: string, environment: NodeJS.ProcessEnv, message: string): void {
  run(wranglerBinary, [
    'versions', 'deploy', `${versionId}@100`, '--yes', '--message', message, ...configArgs,
  ], 'Notification version deployment', environment);
}

function rollbackVersion(versionId: string, environment: NodeJS.ProcessEnv, message: string): void {
  run(wranglerBinary, [
    'rollback', versionId, '--yes', '--message', message, ...configArgs,
  ], 'Notification Worker rollback', environment);
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

async function closeTail(tail: ChildProcessWithoutNullStreams): Promise<void> {
  if (tail.exitCode !== null) return;
  tail.kill('SIGINT');
  await Promise.race([
    new Promise<void>((resolvePromise) => tail.once('exit', () => resolvePromise())),
    wait(2_000),
  ]);
  if (tail.exitCode === null) tail.kill('SIGKILL');
}

async function smokeNotificationDelivery(environment: NodeJS.ProcessEnv): Promise<void> {
  const tail = spawn(wranglerBinary, ['tail', workerName, '--format', 'json'], {
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
    await wait(7_000);
    if (tail.exitCode !== null) fail('Notification live tail ended before the smoke request.');
    const smokeOutput = run('npm', [
      'run', 'test-resend-notification-email', '--', '--kind', 'stripe-manual-review',
    ], 'Notification end-to-end smoke', process.env, true);
    const jobId = notificationSmokeJobId(smokeOutput);
    const deadline = Date.now() + smokeTimeoutMs;
    while (Date.now() < deadline) {
      if (notificationSmokeLogSucceeded(tailOutput, jobId)) {
        console.log(`[notifications-deploy] Smoke job ${jobId} sent successfully.`);
        return;
      }
      if (
        tailOutput.includes(jobId) &&
        (tailOutput.includes('notification_email_retry') || tailOutput.includes('notification_email_failed_permanent'))
      ) fail(`Notification smoke job ${jobId} did not send successfully.`);
      await wait(500);
    }
    fail(`Notification smoke job ${jobId} was not observed before the timeout.`);
  } finally {
    await closeTail(tail);
  }
}

function recordRelease(currentVersionId: string, rollbackVersionId: string): void {
  const manifest: NotificationReleaseManifest = {
    schemaVersion: 1,
    recordedAt: new Date().toISOString(),
    currentProductionVersionId: currentVersionId,
    approvedRollbackVersionId: rollbackVersionId,
  };
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  run('git', ['add', 'cloud/notifications-release-manifest.json'], 'Stage notification release manifest', process.env);
  run('git', [
    'commit', '-m', `release notifications ${currentVersionId}`,
  ], 'Commit notification release manifest', process.env);
}

async function release(environment: NodeJS.ProcessEnv): Promise<void> {
  const manifest = readNotificationReleaseManifest();
  const baseline = liveVersion(environment);
  if (baseline !== manifest.currentProductionVersionId) {
    fail(`Live notification version ${baseline} did not match tracked production ${manifest.currentProductionVersionId}.`);
  }
  run('npm', ['run', 'check:notifications'], 'Notification validation', {
    ...credentialFreeEnvironment(),
    CI: 'true',
    WRANGLER_LOG_PATH: resolve(repoRoot, '.cache', 'wrangler-logs'),
  });
  const candidate = uploadCandidate(environment);
  deployVersion(candidate, environment, 'Guarded notification release');
  if (liveVersion(environment) !== candidate) fail('Notification candidate did not converge to 100%.');
  try {
    await smokeNotificationDelivery(environment);
  } catch (error) {
    rollbackVersion(baseline, environment, 'Automatic recovery after notification smoke failure');
    if (liveVersion(environment) !== baseline) fail('Notification automatic recovery did not restore the baseline.');
    throw error;
  }
  recordRelease(candidate, baseline);
  console.log(`[notifications-deploy] Production version ${candidate} deployed, smoked, and recorded.`);
}

async function rollback(environment: NodeJS.ProcessEnv, requestedVersionId: string): Promise<void> {
  const manifest = readNotificationReleaseManifest();
  if (requestedVersionId !== manifest.approvedRollbackVersionId) {
    fail('Rollback version is not the approved notification target.');
  }
  const baseline = liveVersion(environment);
  if (baseline !== manifest.currentProductionVersionId) fail('Live notification version did not match tracked production.');
  rollbackVersion(requestedVersionId, environment, 'Explicit notification rollback');
  if (liveVersion(environment) !== requestedVersionId) fail('Notification rollback did not converge to 100%.');
  try {
    await smokeNotificationDelivery(environment);
  } catch (error) {
    deployVersion(baseline, environment, 'Recovery after failed notification rollback smoke');
    if (liveVersion(environment) !== baseline) fail('Failed rollback smoke could not restore the prior production version.');
    throw error;
  }
  recordRelease(requestedVersionId, baseline);
  console.log(`[notifications-deploy] Rolled back to ${requestedVersionId}, smoked, and recorded.`);
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (!existsSync(wranglerBinary)) fail('Pinned Wrangler binary not found.');
  assertDeploymentConfig();
  assertCleanWorktree();
  const environment = authenticatedEnvironment();
  if (options.mode === 'rollback') await rollback(environment, options.versionId!);
  else await release(environment);
}

export const notificationsDeployTestHooks = {
  isNotificationReleaseManifest,
  notificationSmokeJobId,
  notificationSmokeLogSucceeded,
  parseNotificationUploadMetadata,
  readNotificationReleaseManifest,
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
