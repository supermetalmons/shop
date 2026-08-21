import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Keypair } from '@solana/web3.js';
import { isBase58Bytes } from '../functions/src/shared/solanaRpcProxy.js';
import {
  readWranglerDeploymentStatus,
  stableCloudflareVersionId,
} from './cloudflare-deployment-state.js';

type ReleasePair = {
  apiVersionId: string;
  frontendVersionId: string;
};

type ReleaseManifest = {
  currentProduction: ReleasePair;
  approvedRollback: ReleasePair;
};

type DecommissionDependencies = {
  fetch: typeof fetch;
  randomBoxAssetId: () => string;
  readLivePair: (environment: NodeJS.ProcessEnv) => ReleasePair;
  readManifest: () => ReleaseManifest;
  runFirebaseDelete: (environment: NodeJS.ProcessEnv) => void;
};

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const smokeTokenName = 'REVEAL_DUDES_SMOKE_FIREBASE_TOKEN';
const smokeOwnerName = 'REVEAL_DUDES_SMOKE_OWNER';
const smokeDropId = 'clear_cards_devnet_v2';
const productionOrigin = 'https://api.mons.shop';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function pairsEqual(left: ReleasePair, right: ReleasePair): boolean {
  return left.apiVersionId.toLowerCase() === right.apiVersionId.toLowerCase() &&
    left.frontendVersionId.toLowerCase() === right.frontendVersionId.toLowerCase();
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const maximumBytes = 16 * 1024;
  const declared = Number(response.headers.get('Content-Length'));
  if (Number.isFinite(declared) && declared > maximumBytes) throw new Error('Smoke response was too large.');
  if (!response.body) throw new Error('Smoke response was empty.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const chunks: string[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maximumBytes) {
      await reader.cancel();
      throw new Error('Smoke response was too large.');
    }
    chunks.push(decoder.decode(value, { stream: true }));
  }
  chunks.push(decoder.decode());
  return JSON.parse(chunks.join('')) as unknown;
}

function validateSmokeResponse(response: Response, payload: unknown, boxAssetId: string): void {
  if (
    response.status !== 404 ||
    response.headers.get('access-control-allow-origin') !== 'https://mons.shop' ||
    !/no-store/i.test(response.headers.get('cache-control') || '') ||
    !isRecord(payload) ||
    Object.keys(payload).sort().join(',') !== 'error' ||
    !isRecord(payload.error) ||
    Object.keys(payload.error).sort().join(',') !== 'code,details,message' ||
    payload.error.code !== 'not-found' ||
    payload.error.message !== 'Pending open not found. Start opening the box first, then reveal.' ||
    !isRecord(payload.error.details) ||
    payload.error.details.boxAssetId !== boxAssetId ||
    typeof payload.error.details.pending !== 'string' ||
    !isBase58Bytes(payload.error.details.pending, 32)
  ) {
    throw new Error('Authenticated reveal smoke returned an unexpected response.');
  }
}

function authenticatedWranglerEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const token = String(environment.CLOUDFLARE_API_TOKEN || '').trim();
  if (!token) throw new Error('CLOUDFLARE_API_TOKEN is required.');
  return {
    ...environment,
    CLOUDFLARE_API_TOKEN: token,
    WRANGLER_LOG_PATH: resolve(repoRoot, '.cache', 'wrangler-logs'),
    WRANGLER_LOG_SANITIZE: 'true',
    WRANGLER_SEND_ERROR_REPORTS: 'false',
    WRANGLER_SEND_METRICS: 'false',
  };
}

function defaultDependencies(): DecommissionDependencies {
  const wranglerBinary = resolve(repoRoot, 'node_modules', '.bin', process.platform === 'win32' ? 'wrangler.cmd' : 'wrangler');
  const read = (environment: NodeJS.ProcessEnv, config: string) => stableCloudflareVersionId(readWranglerDeploymentStatus({
    configArgs: ['--config', config],
    cwd: repoRoot,
    environment,
    wranglerBinary,
  }));
  return {
    fetch: (input, init) => fetch(input, init),
    randomBoxAssetId: () => Keypair.generate().publicKey.toBase58(),
    readLivePair: (environment) => ({
      apiVersionId: read(environment, 'cloud/workers/api/wrangler.jsonc'),
      frontendVersionId: read(environment, 'wrangler.jsonc'),
    }),
    readManifest: () => JSON.parse(
      readFileSync(resolve(repoRoot, 'cloud', 'release-manifest.json'), 'utf8'),
    ) as ReleaseManifest,
    runFirebaseDelete: (environment) => {
      const firebaseBinary = resolve(repoRoot, 'node_modules', '.bin', process.platform === 'win32' ? 'firebase.cmd' : 'firebase');
      const result = spawnSync(firebaseBinary, [
        'functions:delete',
        'revealDudes',
        '--project',
        'mons-shop',
        '--region',
        'us-central1',
        '--force',
      ], { cwd: repoRoot, env: environment, stdio: 'inherit' });
      if (result.error) throw result.error;
      if (result.status !== 0) throw new Error(`Firebase deletion failed with exit code ${result.status ?? 'unknown'}.`);
    },
  };
}

function firebaseChildEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(environment).filter(([name]) =>
    name !== smokeTokenName &&
    name !== smokeOwnerName &&
    name !== 'HELIUS_API_KEY' &&
    !name.startsWith('CLOUDFLARE_') &&
    !name.startsWith('WRANGLER_')));
}

export async function decommissionFirebaseRevealDudes(
  environment: NodeJS.ProcessEnv = process.env,
  overrides: Partial<DecommissionDependencies> = {},
): Promise<void> {
  const dependencies = { ...defaultDependencies(), ...overrides };
  const token = String(environment[smokeTokenName] || '').trim();
  const owner = String(environment[smokeOwnerName] || '').trim();
  if (!token || token.length > 16 * 1024) throw new Error(`${smokeTokenName} is required.`);
  if (!isBase58Bytes(owner, 32)) throw new Error(`${smokeOwnerName} must be a valid wallet.`);
  const manifest = dependencies.readManifest();
  if (!pairsEqual(manifest.currentProduction, manifest.approvedRollback)) {
    throw new Error('Approved rollback still references a pre-cutover release pair.');
  }
  const wranglerEnvironment = authenticatedWranglerEnvironment(environment);
  const livePair = dependencies.readLivePair(wranglerEnvironment);
  if (!pairsEqual(livePair, manifest.currentProduction)) {
    throw new Error('Live Cloudflare production does not match the tracked release pair.');
  }
  const boxAssetId = dependencies.randomBoxAssetId();
  if (!isBase58Bytes(boxAssetId, 32)) throw new Error('Reveal smoke generated an invalid box asset id.');
  const response = await dependencies.fetch(`${productionOrigin}/boxes/reveal`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Origin: 'https://mons.shop',
    },
    body: JSON.stringify({ owner, boxAssetId, dropId: smokeDropId }),
    cache: 'no-store',
    redirect: 'manual',
    signal: AbortSignal.timeout(65_000),
  });
  validateSmokeResponse(response, await readBoundedJson(response), boxAssetId);
  dependencies.runFirebaseDelete(firebaseChildEnvironment(environment));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  decommissionFirebaseRevealDudes().catch((error) => {
    console.error(`[decommission-reveal-dudes] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
