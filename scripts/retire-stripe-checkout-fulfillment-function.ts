import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { STRIPE_CHECKOUT_FULFILLMENT_PROCESSOR } from '../functions/src/shared/stripeCheckoutFulfillmentJob.ts';
import { STRIPE_CHECKOUT_STATUS } from '../functions/src/shared/stripeCheckoutSession.ts';
import { parseCloudflareDeploymentStatus, stableCloudflareVersionId } from './cloudflare-deployment-state.ts';
import { deployApiTestHooks } from './deploy-cloudflare-api.ts';
import {
  createFirebaseCliFirestoreRestClient,
  decodeFirestoreRestDocument,
  type FirebaseCliFirestoreRestClient,
} from './shared/firebaseCliFirestoreRest.ts';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const wranglerBinary = resolve(repoRoot, 'node_modules', '.bin', process.platform === 'win32' ? 'wrangler.cmd' : 'wrangler');
const firebaseBinary = resolve(repoRoot, 'node_modules', '.bin', process.platform === 'win32' ? 'firebase.cmd' : 'firebase');
const configArgs = ['--config', 'cloud/workers/api/wrangler.jsonc', '--env-file', 'cloud/workers/api/release.env'];
const functionName = 'processStripeCheckoutFulfillment';
const functionRegion = 'us-central1';
const projectId = 'mons-shop';
const cloudflareAccountId = 'e25f90fc073ea309b54b8b5144bf28e0';
const cloudflareWorkerName = 'mons-shop-api';
const fulfillmentQueueName = 'mons-shop-stripe-fulfillment';
const reconciliationCron = '*/5 * * * *';
const firestoreQueryPageSize = 200;
const proofMaxAgeMs = 60 * 60 * 1_000;
const proofFutureToleranceMs = 5 * 60 * 1_000;
const versionPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const sessionPattern = /^[A-Za-z0-9_:-]{4,256}$/;

type Options = {
  apiVersionId: string;
  confirm: boolean;
  dropId: string;
  sessionId: string;
  tokenFile?: string;
};

function fail(message: string): never {
  throw new Error(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function usage(): string {
  return [
    'Usage:',
    '  npm run retire:stripe-fulfillment-function -- --api-version-id <uuid> --drop-id card_nft_binder_devnet --session-id <id> --confirm',
    '',
    'Optional:',
    '  --token-file <path>',
  ].join('\n');
}

function parseArgs(argv: string[]): Options {
  let apiVersionId = '';
  let confirm = false;
  let dropId = '';
  let sessionId = '';
  let tokenFile: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (option === '--confirm') {
      confirm = true;
      continue;
    }
    if (!['--api-version-id', '--drop-id', '--session-id', '--token-file'].includes(option)) {
      fail(`Unknown option: ${option}\n\n${usage()}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) fail(`Missing value for ${option}\n\n${usage()}`);
    index += 1;
    if (option === '--api-version-id') apiVersionId = value.toLowerCase();
    if (option === '--drop-id') dropId = value;
    if (option === '--session-id') sessionId = value;
    if (option === '--token-file') tokenFile = value;
  }
  if (!versionPattern.test(apiVersionId)) fail(`Invalid --api-version-id\n\n${usage()}`);
  if (dropId !== 'card_nft_binder_devnet') fail('Retirement proof must use card_nft_binder_devnet.');
  if (!sessionPattern.test(sessionId)) fail('Invalid --session-id.');
  if (!confirm) fail(`Retirement requires --confirm.\n\n${usage()}`);
  return { apiVersionId, confirm, dropId, sessionId, ...(tokenFile ? { tokenFile } : {}) };
}

function readToken(path: string | undefined): string {
  if (!path) {
    const token = String(process.env.CLOUDFLARE_API_TOKEN || '').trim();
    if (!token) fail('Set CLOUDFLARE_API_TOKEN or pass --token-file.');
    return token;
  }
  const resolved = resolve(path);
  const entry = lstatSync(resolved);
  if (!entry.isFile() || entry.isSymbolicLink()) fail('--token-file must be a regular non-symlink file.');
  if ((entry.mode & 0o077) !== 0) fail('--token-file permissions must not allow group or other access.');
  const token = readFileSync(resolved, 'utf8').trim();
  if (!token) fail('--token-file is empty.');
  return token;
}

function runJson(command: string, args: string[], environment: NodeJS.ProcessEnv, label: string): unknown {
  const output = runOutput(command, args, environment, label);
  try {
    return JSON.parse(output) as unknown;
  } catch {
    return fail(`${label} returned invalid JSON.`);
  }
}

function runOutput(command: string, args: string[], environment: NodeJS.ProcessEnv, label: string): string {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: 'utf8',
    env: environment,
    shell: false,
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  if (result.error) fail(`${label} could not start: ${result.error.message}`);
  if (result.status !== 0) fail(`${label} failed with exit code ${result.status ?? 1}.`);
  return String(result.stdout || '');
}

function firebaseFunctions(): Array<Record<string, unknown>> {
  const value = runJson(
    firebaseBinary,
    ['functions:list', '--project', projectId, '--json'],
    { ...process.env, FIREBASE_CLI_DISABLE_UPDATE_CHECK: '1' },
    'Firebase function inspection',
  );
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('Firebase function inspection returned an invalid response.');
  const result = (value as Record<string, unknown>).result;
  if (!Array.isArray(result)) fail('Firebase function inspection returned an invalid function list.');
  return result.filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object' && !Array.isArray(entry));
}

async function verifyFirestoreProof(
  options: Options,
  client: FirebaseCliFirestoreRestClient = createFirebaseCliFirestoreRestClient({ projectId }),
  nowMs = Date.now(),
): Promise<void> {
  const checkoutPath = `drops/${options.dropId}/stripeCheckouts/${options.sessionId}`;
  const checkout = decodeFirestoreRestDocument(await client.request({
    url: client.documentUrl(checkoutPath),
    allow404: true,
  }));
  if (!checkout) fail(`Missing checkout proof at ${checkoutPath}.`);
  if (checkout.data.fulfillmentProcessor !== STRIPE_CHECKOUT_FULFILLMENT_PROCESSOR) {
    fail('Checkout proof was not delegated to the Cloudflare fulfillment processor.');
  }
  if (checkout.data.fulfillmentCompletedBy !== STRIPE_CHECKOUT_FULFILLMENT_PROCESSOR) {
    fail('Checkout proof was not completed by the Cloudflare fulfillment processor.');
  }
  const fulfillmentCompletedAtMs = Date.parse(String(checkout.data.fulfillmentCompletedAt || ''));
  if (
    !Number.isFinite(fulfillmentCompletedAtMs) ||
    fulfillmentCompletedAtMs > nowMs + proofFutureToleranceMs ||
    nowMs - fulfillmentCompletedAtMs > proofMaxAgeMs
  ) {
    fail('Checkout proof must have a valid Cloudflare completion timestamp from the last hour.');
  }
  if (checkout.data.status !== STRIPE_CHECKOUT_STATUS.FULFILLED) {
    fail(`Checkout proof is not fulfilled; current status is ${String(checkout.data.status || 'missing')}.`);
  }
  const deliveryId = Number(checkout.data.deliveryId);
  if (!Number.isSafeInteger(deliveryId) || deliveryId <= 0) fail('Checkout proof has no valid deliveryId.');
  const deliveryPath = `drops/${options.dropId}/deliveryOrders/${deliveryId}`;
  const delivery = decodeFirestoreRestDocument(await client.request({
    url: client.documentUrl(deliveryPath),
    allow404: true,
  }));
  if (!delivery) fail(`Missing delivery-order proof at ${deliveryPath}.`);
  if (
    delivery.data.stripeCheckoutSessionId !== options.sessionId ||
    delivery.data.status !== 'ready_to_ship' ||
    delivery.data.source !== 'stripe_offchain'
  ) {
    fail('Delivery-order proof does not match the fulfilled Stripe checkout.');
  }
}

function activeStripeCheckoutQuery(limit: number, afterDocumentName?: string): Record<string, unknown> {
  return {
    structuredQuery: {
      select: {
        fields: ['fulfillmentProcessor', 'status'].map((fieldPath) => ({ fieldPath })),
      },
      from: [{ collectionId: 'stripeCheckouts', allDescendants: true }],
      orderBy: [{ field: { fieldPath: '__name__' }, direction: 'ASCENDING' }],
      limit,
      ...(afterDocumentName
        ? {
            startAt: {
              before: false,
              values: [{ referenceValue: afterDocumentName }],
            },
          }
        : {}),
    },
  };
}

async function verifyNoLegacyActiveCheckouts(
  client: Pick<FirebaseCliFirestoreRestClient, 'documentsUrl' | 'request'> = createFirebaseCliFirestoreRestClient({ projectId }),
  pageSize = firestoreQueryPageSize,
): Promise<void> {
  if (!Number.isSafeInteger(pageSize) || pageSize <= 0 || pageSize > 1_000) fail('Invalid Firestore query page size.');
  let afterDocumentName: string | undefined;
  let readTime: string | undefined;
  for (;;) {
    const response: unknown = await client.request({
      url: client.documentsUrl(':runQuery'),
      method: 'POST',
      body: {
        ...activeStripeCheckoutQuery(pageSize, afterDocumentName),
        ...(readTime ? { readTime } : {}),
      },
    });
    if (!Array.isArray(response)) fail('Legacy checkout inspection returned an invalid response.');
    const documents: Array<{ name: string; path: string; data: Record<string, unknown> }> = [];
    let observedReadTime: string | undefined;
    for (const entry of response) {
      if (!isRecord(entry)) fail('Legacy checkout inspection returned an invalid entry.');
      if (entry.readTime !== undefined) {
        if (typeof entry.readTime !== 'string' || !Number.isFinite(Date.parse(entry.readTime))) {
          fail('Legacy checkout inspection returned an invalid read time.');
        }
        if (readTime && entry.readTime !== readTime) {
          fail('Legacy checkout inspection changed snapshots during pagination.');
        }
        observedReadTime = entry.readTime;
      }
      if (entry.document === undefined) continue;
      if (!isRecord(entry.document) || typeof entry.document.name !== 'string') {
        fail('Legacy checkout inspection returned an invalid document.');
      }
      const document = decodeFirestoreRestDocument(entry.document);
      if (!document) fail('Legacy checkout inspection returned an undecodable document.');
      documents.push({ name: entry.document.name, path: document.path, data: document.data });
    }
    if (!observedReadTime) fail('Legacy checkout inspection returned no snapshot read time.');
    readTime ??= observedReadTime;
    if (documents.length > pageSize) fail('Legacy checkout inspection exceeded its requested page size.');
    for (const document of documents) {
      const active = document.data.status === STRIPE_CHECKOUT_STATUS.FULFILLMENT_PENDING ||
        document.data.status === STRIPE_CHECKOUT_STATUS.PROCESSING;
      if (active && document.data.fulfillmentProcessor !== STRIPE_CHECKOUT_FULFILLMENT_PROCESSOR) {
        fail(`Legacy active Stripe checkout remains at ${document.path}.`);
      }
    }
    if (documents.length < pageSize) return;
    const nextDocumentName = documents.at(-1)?.name;
    if (!nextDocumentName || nextDocumentName === afterDocumentName) {
      fail('Legacy checkout inspection did not make pagination progress.');
    }
    afterDocumentName = nextDocumentName;
  }
}

function cloudflareResult(value: unknown, label: string): unknown {
  if (!isRecord(value) || value.success !== true || !('result' in value)) {
    fail(`${label} returned an invalid Cloudflare response.`);
  }
  return value.result;
}

function assertFulfillmentQueueResumed(value: unknown): void {
  const queues = cloudflareResult(value, 'Stripe fulfillment queue inspection');
  if (!Array.isArray(queues)) fail('Stripe fulfillment queue inspection returned an invalid result.');
  const matches = queues.filter((queue) => isRecord(queue) && queue.queue_name === fulfillmentQueueName);
  if (matches.length !== 1) {
    fail('Cloudflare did not return the exact Stripe fulfillment queue.');
  }
  const queue = matches[0];
  if (!isRecord(queue) || !isRecord(queue.settings) || queue.settings.delivery_paused !== false) {
    fail('Stripe fulfillment queue delivery is not confirmed resumed.');
  }
}

function assertReviewedCronInstalled(value: unknown): void {
  const result = cloudflareResult(value, 'Stripe fulfillment reconciliation schedule inspection');
  if (!isRecord(result) || !Array.isArray(result.schedules)) {
    fail('Stripe fulfillment reconciliation schedule inspection returned an invalid result.');
  }
  const schedules = result.schedules;
  if (schedules.length !== 1 || !isRecord(schedules[0]) || schedules[0].cron !== reconciliationCron) {
    fail('The exact reviewed Stripe fulfillment reconciliation schedule is not installed.');
  }
}

async function verifyCloudflareFulfillmentRuntime(
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const headers = { Authorization: `Bearer ${token}` };
  const queueUrl = new URL(`https://api.cloudflare.com/client/v4/accounts/${cloudflareAccountId}/queues`);
  queueUrl.searchParams.set('name', fulfillmentQueueName);
  const cronUrl = new URL(
    `https://api.cloudflare.com/client/v4/accounts/${cloudflareAccountId}/workers/scripts/${cloudflareWorkerName}/schedules`,
  );
  const [queueResponse, cronResponse] = await Promise.all([
    fetchImpl(queueUrl, { headers }),
    fetchImpl(cronUrl, { headers }),
  ]);
  if (!queueResponse.ok) fail(`Stripe fulfillment queue inspection failed with HTTP ${queueResponse.status}.`);
  if (!cronResponse.ok) fail(`Stripe fulfillment schedule inspection failed with HTTP ${cronResponse.status}.`);
  assertFulfillmentQueueResumed(await queueResponse.json());
  assertReviewedCronInstalled(await cronResponse.json());
}

function deleteFunction(): void {
  const result = spawnSync(
    firebaseBinary,
    ['functions:delete', functionName, '--region', functionRegion, '--project', projectId, '--force'],
    {
      cwd: repoRoot,
      env: { ...process.env, FIREBASE_CLI_DISABLE_UPDATE_CHECK: '1' },
      shell: false,
      stdio: 'inherit',
    },
  );
  if (result.error) fail(`Firebase function deletion could not start: ${result.error.message}`);
  if (result.status !== 0) fail(`Firebase function deletion failed with exit code ${result.status ?? 1}.`);
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (!existsSync(wranglerBinary) || !existsSync(firebaseBinary)) fail('Install repository dependencies before retirement.');
  const manifest = deployApiTestHooks.readReleaseManifest();
  if (
    manifest.currentProduction.apiVersionId.toLowerCase() !== options.apiVersionId ||
    manifest.approvedRollback.apiVersionId.toLowerCase() !== options.apiVersionId
  ) {
    fail('The requested API version must be both current production and the approved rollback target.');
  }
  const token = readToken(options.tokenFile);
  const environment = deployApiTestHooks.authenticatedWranglerEnvironment(token);
  const status = parseCloudflareDeploymentStatus(runOutput(
    wranglerBinary,
    ['deployments', 'status', '--json', ...configArgs],
    environment,
    'Cloudflare deployment inspection',
  ));
  if (stableCloudflareVersionId(status) !== options.apiVersionId) {
    fail('The live Cloudflare API version does not match the requested retirement version.');
  }
  const before = firebaseFunctions();
  if (!before.some((entry) => (
    entry.id === functionName &&
    entry.state === 'ACTIVE' &&
    typeof entry.uri === 'string' &&
    entry.uri.includes(`://${functionRegion}-${projectId}.cloudfunctions.net/`)
  ))) {
    fail(`${functionName} is not an active ${functionRegion} Firebase function.`);
  }
  deployApiTestHooks.assertExactQueueConsumers(environment);
  await verifyCloudflareFulfillmentRuntime(token);
  await verifyNoLegacyActiveCheckouts();
  await verifyFirestoreProof(options);
  deleteFunction();
  if (firebaseFunctions().some((entry) => entry.id === functionName)) {
    fail(`${functionName} still appears in the Firebase function list after deletion.`);
  }
  console.log(`[stripe-fulfillment-retirement] Deleted ${functionName} after verifying Cloudflare API ${options.apiVersionId}.`);
}

export const retireStripeFulfillmentTestHooks = {
  activeStripeCheckoutQuery,
  assertFulfillmentQueueResumed,
  assertReviewedCronInstalled,
  parseArgs,
  verifyCloudflareFulfillmentRuntime,
  verifyFirestoreProof,
  verifyNoLegacyActiveCheckouts,
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`[stripe-fulfillment-retirement] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
