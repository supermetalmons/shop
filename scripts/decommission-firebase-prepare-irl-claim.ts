import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VersionedTransaction } from '@solana/web3.js';
import nacl from 'tweetnacl';
import { IRL_CLAIM_CODE_DIGITS, normalizeIrlClaimCode } from '../functions/src/claimCodes.js';
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
const smokeTokenName = 'IRL_CLAIM_SMOKE_FIREBASE_TOKEN';
const smokeOwnerName = 'IRL_CLAIM_SMOKE_OWNER';
const smokeCodeName = 'IRL_CLAIM_SMOKE_CODE';

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

function validatePreparedTransaction(payload: unknown, owner: string): void {
  if (
    !isRecord(payload) ||
    Object.keys(payload).sort().join(',') !== 'certificateId,certificates,dropId,encodedTx,message' ||
    typeof payload.encodedTx !== 'string' ||
    payload.encodedTx.length === 0 ||
    payload.encodedTx.length > 16 * 1024 ||
    typeof payload.dropId !== 'string' ||
    !Array.isArray(payload.certificates) ||
    payload.certificates.length === 0 ||
    !payload.certificates.every((id) => Number.isSafeInteger(id) && Number(id) > 0) ||
    typeof payload.certificateId !== 'string' ||
    !isBase58Bytes(payload.certificateId, 32) ||
    typeof payload.message !== 'string' ||
    payload.message.length === 0
  ) {
    throw new Error('Authenticated smoke returned an invalid claim response.');
  }
  let transaction: VersionedTransaction;
  try {
    transaction = VersionedTransaction.deserialize(Buffer.from(payload.encodedTx, 'base64'));
  } catch {
    throw new Error('Authenticated smoke returned an invalid transaction.');
  }
  const signers = transaction.message.staticAccountKeys.slice(
    0,
    transaction.message.header.numRequiredSignatures,
  );
  const ownerIndex = signers.findIndex((key) => key.toBase58() === owner);
  if (ownerIndex !== 0 || transaction.signatures[ownerIndex]?.some((byte) => byte !== 0)) {
    throw new Error('Authenticated smoke returned an invalid wallet signature state.');
  }
  const message = transaction.message.serialize();
  if (!transaction.signatures.some((signature, index) =>
    index !== ownerIndex &&
    signature.some((byte) => byte !== 0) &&
    nacl.sign.detached.verify(message, signature, signers[index].toBytes()))) {
    throw new Error('Authenticated smoke transaction is missing the server signature.');
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
        'prepareIrlClaimTx',
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

export async function decommissionFirebasePrepareIrlClaim(
  environment: NodeJS.ProcessEnv = process.env,
  overrides: Partial<DecommissionDependencies> = {},
): Promise<void> {
  const dependencies = { ...defaultDependencies(), ...overrides };
  const token = String(environment[smokeTokenName] || '').trim();
  const owner = String(environment[smokeOwnerName] || '').trim();
  const code = String(environment[smokeCodeName] || '').trim();
  if (!token || token.length > 16 * 1024) throw new Error(`${smokeTokenName} is required.`);
  if (!isBase58Bytes(owner, 32)) throw new Error(`${smokeOwnerName} must be a valid wallet.`);
  if (normalizeIrlClaimCode(code) !== code || code.length !== IRL_CLAIM_CODE_DIGITS) {
    throw new Error(`${smokeCodeName} must be an exact ${IRL_CLAIM_CODE_DIGITS}-digit code.`);
  }
  const manifest = dependencies.readManifest();
  if (!releasePairsEqual(manifest.currentProduction, manifest.approvedRollback)) {
    throw new Error('Approved rollback still references a pre-cutover release pair.');
  }
  const response = await dependencies.fetch('https://api.mons.shop/claims/irl/prepare', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Origin: 'https://mons.shop',
    },
    body: JSON.stringify({ owner, code }),
    cache: 'no-store',
    redirect: 'manual',
    signal: AbortSignal.timeout(65_000),
  });
  const payload = await readBoundedJson(response);
  if (response.status !== 200) throw new Error(`Authenticated smoke failed with HTTP ${response.status}.`);
  validatePreparedTransaction(payload, owner);
  const childEnvironment = { ...environment };
  delete childEnvironment[smokeTokenName];
  delete childEnvironment[smokeOwnerName];
  delete childEnvironment[smokeCodeName];
  dependencies.runFirebaseDelete(childEnvironment);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  decommissionFirebasePrepareIrlClaim().catch((error) => {
    console.error(`[decommission-irl-claim] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
