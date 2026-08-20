import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PublicKey, VersionedTransaction } from '@solana/web3.js';
import { isBase58Bytes } from '../functions/src/shared/solanaRpcProxy.js';

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
  readManifest: () => ReleaseManifest;
  runFirebaseDelete: (environment: NodeJS.ProcessEnv) => void;
};

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const smokeTokenName = 'RECEIPT_TRANSFER_SMOKE_FIREBASE_TOKEN';
const smokeOwnerName = 'RECEIPT_TRANSFER_SMOKE_OWNER';
const smokeDropIdName = 'RECEIPT_TRANSFER_SMOKE_DROP_ID';
const smokeAssetIdName = 'RECEIPT_TRANSFER_SMOKE_ASSET_ID';
const smokeDestinationName = 'RECEIPT_TRANSFER_SMOKE_DESTINATION';

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
  return JSON.parse(chunks.join(''));
}

function validatePreparedTransaction(
  payload: unknown,
  expected: { owner: string; dropId: string; assetId: string },
): void {
  if (
    !isRecord(payload) ||
    Object.keys(payload).sort().join(',') !== 'certificateId,dropId,encodedTx' ||
    typeof payload.encodedTx !== 'string' ||
    payload.encodedTx.length === 0 ||
    payload.encodedTx.length > 16 * 1024 ||
    payload.dropId !== expected.dropId ||
    payload.certificateId !== expected.assetId
  ) {
    throw new Error('Authenticated smoke returned an invalid receipt transfer response.');
  }
  let transaction: VersionedTransaction;
  try {
    transaction = VersionedTransaction.deserialize(Buffer.from(payload.encodedTx, 'base64'));
  } catch {
    throw new Error('Authenticated smoke returned an invalid transaction.');
  }
  const signers = transaction.message.staticAccountKeys.slice(0, transaction.message.header.numRequiredSignatures);
  if (
    signers.length !== 1 ||
    !signers[0].equals(new PublicKey(expected.owner)) ||
    transaction.signatures.length !== 1 ||
    transaction.signatures[0].some((byte) => byte !== 0)
  ) {
    throw new Error('Authenticated smoke returned an invalid receipt transfer signer state.');
  }
}

function defaultDependencies(): DecommissionDependencies {
  return {
    fetch: (input, init) => fetch(input, init),
    readManifest: () => JSON.parse(
      readFileSync(resolve(repoRoot, 'cloud', 'release-manifest.json'), 'utf8'),
    ) as ReleaseManifest,
    runFirebaseDelete: (environment) => {
      const binary = resolve(repoRoot, 'node_modules', '.bin', process.platform === 'win32' ? 'firebase.cmd' : 'firebase');
      const result = spawnSync(binary, [
        'functions:delete',
        'prepareReceiptTransferTx',
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

export async function decommissionFirebasePrepareReceiptTransfer(
  environment: NodeJS.ProcessEnv = process.env,
  overrides: Partial<DecommissionDependencies> = {},
): Promise<void> {
  const dependencies = { ...defaultDependencies(), ...overrides };
  const token = String(environment[smokeTokenName] || '').trim();
  const owner = String(environment[smokeOwnerName] || '').trim();
  const dropId = String(environment[smokeDropIdName] || '').trim().toLowerCase();
  const assetId = String(environment[smokeAssetIdName] || '').trim();
  const destination = String(environment[smokeDestinationName] || '').trim();
  if (!token || token.length > 16 * 1024) throw new Error(`${smokeTokenName} is required.`);
  if (!isBase58Bytes(owner, 32)) throw new Error(`${smokeOwnerName} must be a valid wallet.`);
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(dropId)) throw new Error(`${smokeDropIdName} must be a valid drop id.`);
  if (!isBase58Bytes(assetId, 32)) throw new Error(`${smokeAssetIdName} must be a valid receipt asset.`);
  if (!isBase58Bytes(destination, 32) || destination === owner || destination === PublicKey.default.toBase58()) {
    throw new Error(`${smokeDestinationName} must be a different non-system wallet.`);
  }
  const manifest = dependencies.readManifest();
  if (!releasePairsEqual(manifest.currentProduction, manifest.approvedRollback)) {
    throw new Error('Approved rollback still references a pre-cutover release pair.');
  }
  const response = await dependencies.fetch('https://api.mons.shop/receipts/transfer/prepare', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Origin: 'https://mons.shop',
    },
    body: JSON.stringify({ owner, dropId, receiptAssetId: assetId, destination }),
    cache: 'no-store',
    redirect: 'manual',
    signal: AbortSignal.timeout(65_000),
  });
  const payload = await readBoundedJson(response);
  if (response.status !== 200) throw new Error(`Authenticated smoke failed with HTTP ${response.status}.`);
  validatePreparedTransaction(payload, { owner, dropId, assetId });
  const childEnvironment = { ...environment };
  delete childEnvironment[smokeTokenName];
  delete childEnvironment[smokeOwnerName];
  delete childEnvironment[smokeDropIdName];
  delete childEnvironment[smokeAssetIdName];
  delete childEnvironment[smokeDestinationName];
  dependencies.runFirebaseDelete(childEnvironment);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  decommissionFirebasePrepareReceiptTransfer().catch((error) => {
    console.error(`[decommission-receipt-transfer] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
