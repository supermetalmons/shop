import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeStripeReceiptClaimCode, requireStripeReceiptClaimCode } from '../functions/src/shared/stripeReceiptClaims.js';
import { isBase58Bytes } from '../functions/src/shared/solanaRpcProxy.js';

type ReleasePair = { apiVersionId: string; frontendVersionId: string };
type ReleaseManifest = { currentProduction: ReleasePair; approvedRollback: ReleasePair };
type Dependencies = {
  fetch: typeof fetch;
  readManifest: () => ReleaseManifest;
  runFirebaseDelete: (environment: NodeJS.ProcessEnv) => void;
};

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const environmentNames = {
  token: 'STRIPE_RECEIPT_CLAIM_SMOKE_FIREBASE_TOKEN',
  code: 'STRIPE_RECEIPT_CLAIM_SMOKE_CODE',
  recipient: 'STRIPE_RECEIPT_CLAIM_SMOKE_RECIPIENT',
  dropId: 'STRIPE_RECEIPT_CLAIM_SMOKE_DROP_ID',
  deliveryId: 'STRIPE_RECEIPT_CLAIM_SMOKE_DELIVERY_ID',
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function releasePairsEqual(left: ReleasePair, right: ReleasePair): boolean {
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

function validateClaimResponse(value: unknown, expectedDropId: string, expectedDeliveryId: number): void {
  if (!isRecord(value)) throw new Error('Smoke returned an invalid receipt claim response.');
  const required = ['deliveryId', 'dropId', 'processed', 'receiptTxs', 'receiptsTransferred'];
  const optional = ['figureIds', 'receiptAssetIds', 'receiptKind'];
  if (Object.keys(value).some((key) => !required.includes(key) && !optional.includes(key)) || required.some((key) => !Object.hasOwn(value, key))) {
    throw new Error('Smoke returned an invalid receipt claim response.');
  }
  if (
    value.processed !== true ||
    value.dropId !== expectedDropId ||
    value.deliveryId !== expectedDeliveryId ||
    !Number.isSafeInteger(value.receiptsTransferred) ||
    Number(value.receiptsTransferred) < 1 ||
    !Array.isArray(value.receiptTxs) ||
    !value.receiptTxs.every((signature) => typeof signature === 'string' && isBase58Bytes(signature, 64)) ||
    (value.receiptKind !== undefined && value.receiptKind !== 'box' && value.receiptKind !== 'figure') ||
    (value.figureIds !== undefined && (
      !Array.isArray(value.figureIds) ||
      !value.figureIds.every((id) => Number.isSafeInteger(id) && Number(id) > 0)
    )) ||
    (value.receiptAssetIds !== undefined && (
      !Array.isArray(value.receiptAssetIds) ||
      !value.receiptAssetIds.every((assetId) => typeof assetId === 'string' && isBase58Bytes(assetId, 32))
    ))
  ) {
    throw new Error('Smoke returned an invalid receipt claim response.');
  }
}

function defaultDependencies(): Dependencies {
  return {
    fetch: (input, init) => fetch(input, init),
    readManifest: () => JSON.parse(
      readFileSync(resolve(repoRoot, 'cloud', 'release-manifest.json'), 'utf8'),
    ) as ReleaseManifest,
    runFirebaseDelete: (environment) => {
      const binary = resolve(repoRoot, 'node_modules', '.bin', process.platform === 'win32' ? 'firebase.cmd' : 'firebase');
      const result = spawnSync(binary, [
        'functions:delete',
        'claimStripeReceipt',
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

export async function decommissionFirebaseClaimStripeReceipt(
  environment: NodeJS.ProcessEnv = process.env,
  overrides: Partial<Dependencies> = {},
): Promise<void> {
  const dependencies = { ...defaultDependencies(), ...overrides };
  const token = String(environment[environmentNames.token] || '').trim();
  const rawCode = String(environment[environmentNames.code] || '').trim();
  const recipient = String(environment[environmentNames.recipient] || '').trim();
  const dropId = String(environment[environmentNames.dropId] || '').trim();
  const deliveryId = Number(environment[environmentNames.deliveryId]);
  if (!token || token.length > 16 * 1024) throw new Error(`${environmentNames.token} is required.`);
  let code: string;
  try { code = requireStripeReceiptClaimCode(rawCode); }
  catch { throw new Error(`${environmentNames.code} must be an exact Stripe receipt claim code.`); }
  if (rawCode !== code || code !== normalizeStripeReceiptClaimCode(rawCode)) {
    throw new Error(`${environmentNames.code} must use canonical uppercase formatting.`);
  }
  if (!isBase58Bytes(recipient, 32)) throw new Error(`${environmentNames.recipient} must be a valid wallet.`);
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(dropId)) throw new Error(`${environmentNames.dropId} is invalid.`);
  if (!Number.isSafeInteger(deliveryId) || deliveryId < 1) throw new Error(`${environmentNames.deliveryId} must be positive.`);
  const manifest = dependencies.readManifest();
  if (!releasePairsEqual(manifest.currentProduction, manifest.approvedRollback)) {
    throw new Error('Approved rollback still references a pre-cutover release pair.');
  }
  const request = async () => {
    const response = await dependencies.fetch('https://api.mons.shop/receipts/stripe/claim', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Origin: 'https://mons.shop',
      },
      body: JSON.stringify({ code, recipient }),
      cache: 'no-store',
      redirect: 'manual',
      signal: AbortSignal.timeout(190_000),
    });
    const payload = await readBoundedJson(response);
    if (response.status !== 200) throw new Error(`Authenticated smoke failed with HTTP ${response.status}.`);
    validateClaimResponse(payload, dropId, deliveryId);
    return payload;
  };
  const first = await request();
  const second = await request();
  if (JSON.stringify(first) !== JSON.stringify(second)) {
    throw new Error('Repeated receipt claim smoke responses were not idempotent.');
  }
  const childEnvironment = { ...environment };
  for (const name of Object.values(environmentNames)) delete childEnvironment[name];
  dependencies.runFirebaseDelete(childEnvironment);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  decommissionFirebaseClaimStripeReceipt().catch((error) => {
    console.error(`[decommission-stripe-receipt-claim] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
