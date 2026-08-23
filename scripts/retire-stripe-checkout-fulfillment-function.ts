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
} from './shared/firebaseCliFirestoreRest.ts';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const wranglerBinary = resolve(repoRoot, 'node_modules', '.bin', process.platform === 'win32' ? 'wrangler.cmd' : 'wrangler');
const firebaseBinary = resolve(repoRoot, 'node_modules', '.bin', process.platform === 'win32' ? 'firebase.cmd' : 'firebase');
const configArgs = ['--config', 'cloud/workers/api/wrangler.jsonc', '--env-file', 'cloud/workers/api/release.env'];
const functionName = 'processStripeCheckoutFulfillment';
const functionRegion = 'us-central1';
const projectId = 'mons-shop';
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

async function verifyFirestoreProof(options: Options): Promise<void> {
  const client = createFirebaseCliFirestoreRestClient({ projectId });
  const checkoutPath = `drops/${options.dropId}/stripeCheckouts/${options.sessionId}`;
  const checkout = decodeFirestoreRestDocument(await client.request({
    url: client.documentUrl(checkoutPath),
    allow404: true,
  }));
  if (!checkout) fail(`Missing checkout proof at ${checkoutPath}.`);
  if (checkout.data.fulfillmentProcessor !== STRIPE_CHECKOUT_FULFILLMENT_PROCESSOR) {
    fail('Checkout proof was not delegated to the Cloudflare fulfillment processor.');
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
  deployApiTestHooks.assertExactQueueConsumers(environment);
  await verifyFirestoreProof(options);
  const before = firebaseFunctions();
  if (!before.some((entry) => (
    entry.id === functionName &&
    entry.state === 'ACTIVE' &&
    typeof entry.uri === 'string' &&
    entry.uri.includes(`://${functionRegion}-${projectId}.cloudfunctions.net/`)
  ))) {
    fail(`${functionName} is not an active ${functionRegion} Firebase function.`);
  }
  deleteFunction();
  if (firebaseFunctions().some((entry) => entry.id === functionName)) {
    fail(`${functionName} still appears in the Firebase function list after deletion.`);
  }
  console.log(`[stripe-fulfillment-retirement] Deleted ${functionName} after verifying Cloudflare API ${options.apiVersionId}.`);
}

export const retireStripeFulfillmentTestHooks = {
  parseArgs,
  verifyFirestoreProof,
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`[stripe-fulfillment-retirement] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
