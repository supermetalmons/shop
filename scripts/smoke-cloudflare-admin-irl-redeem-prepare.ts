import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SignJWT, importPKCS8 } from 'jose';
import {
  ComputeBudgetProgram,
  PublicKey,
  SystemProgram,
  VersionedTransaction,
} from '@solana/web3.js';
import { getFunctionsDrop } from '../functions/src/config/deployment.js';
import {
  ADMIN_IRL_REDEEM_PREPARE_ATTEMPT_HEADER,
} from '../functions/src/shared/contracts.js';
import { isBase58Bytes } from '../functions/src/shared/solanaRpcProxy.js';
import {
  MPL_CORE_PROGRAM_ADDRESS,
  SPL_NOOP_PROGRAM_ADDRESS,
} from '../functions/src/shared/solanaProgramAddresses.js';
import {
  FIRESTORE_DOCUMENTS_BASE_URL,
  decodeFirestoreFields,
  isRecord,
} from '../cloud/workers/api/src/firestoreRest.js';
import {
  firestoreWriterServiceAccountEmail,
  readCloudflareFirestoreKeychainCredential,
} from './cloudflare-firestore-keychain.js';
type PreparedAdminIrlDocument = {
  fields: Record<string, unknown>;
  updateTime: string;
};

type SmokeDependencies = {
  deletePreparedDocument: (credential: string, path: string, updateTime: string) => Promise<void>;
  fetch: typeof fetch;
  loadPreparedDocument: (credential: string, path: string) => Promise<PreparedAdminIrlDocument>;
  readWriterCredential: () => string;
  simulatePreparedTransaction: (fetchImpl: typeof fetch, encodedTx: string, cluster: 'mainnet-beta' | 'devnet') => Promise<void>;
};

const smokeTokenName = 'ADMIN_IRL_REDEEM_PREPARE_SMOKE_FIREBASE_TOKEN';
const smokeOwnerName = 'ADMIN_IRL_REDEEM_PREPARE_SMOKE_OWNER';
const smokeDropIdName = 'ADMIN_IRL_REDEEM_PREPARE_SMOKE_DROP_ID';
const smokeItemIdsName = 'ADMIN_IRL_REDEEM_PREPARE_SMOKE_ITEM_IDS';
const googleOAuthTokenUrl = 'https://oauth2.googleapis.com/token';
const googleDatastoreScope = 'https://www.googleapis.com/auth/datastore';
const mplCoreProgram = new PublicKey(MPL_CORE_PROGRAM_ADDRESS);

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join('\0') === [...keys].sort().join('\0');
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const maximumBytes = 32 * 1024;
  const declared = Number(response.headers.get('Content-Length'));
  if (Number.isFinite(declared) && declared > maximumBytes) throw new Error('Response was too large.');
  if (!response.body) throw new Error('Response was empty.');
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
      throw new Error('Response was too large.');
    }
    chunks.push(decoder.decode(value, { stream: true }));
  }
  chunks.push(decoder.decode());
  return JSON.parse(chunks.join(''));
}

function parseWriterCredential(value: string): { clientEmail: string; privateKey: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error('Firestore writer credential is invalid.');
  }
  if (!isRecord(parsed)) throw new Error('Firestore writer credential is invalid.');
  const clientEmail = typeof parsed.client_email === 'string' ? parsed.client_email.trim() : '';
  const privateKey = typeof parsed.private_key === 'string' ? parsed.private_key : '';
  const projectId = typeof parsed.project_id === 'string' ? parsed.project_id.trim() : '';
  if (
    clientEmail !== firestoreWriterServiceAccountEmail ||
    projectId !== 'mons-shop' ||
    !privateKey.startsWith('-----BEGIN PRIVATE KEY-----')
  ) {
    throw new Error('Firestore writer credential is invalid.');
  }
  return { clientEmail, privateKey };
}

async function firestoreAccessToken(credentialJson: string): Promise<string> {
  const credential = parseWriterCredential(credentialJson);
  const issuedAt = Math.floor(Date.now() / 1000);
  const key = await importPKCS8(credential.privateKey, 'RS256');
  const assertion = await new SignJWT({ scope: googleDatastoreScope })
    .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
    .setIssuer(credential.clientEmail)
    .setSubject(credential.clientEmail)
    .setAudience(googleOAuthTokenUrl)
    .setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + 3600)
    .sign(key);
  const response = await fetch(googleOAuthTokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error('Unable to authenticate the Firestore writer credential.');
  }
  const payload = await readBoundedJson(response);
  const accessToken = isRecord(payload) && typeof payload.access_token === 'string'
    ? payload.access_token
    : '';
  if (!accessToken) throw new Error('Unable to authenticate the Firestore writer credential.');
  return accessToken;
}

async function loadPreparedDocument(
  credential: string,
  path: string,
): Promise<PreparedAdminIrlDocument> {
  const accessToken = await firestoreAccessToken(credential);
  const response = await fetch(`${FIRESTORE_DOCUMENTS_BASE_URL}/${path}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error('Unable to verify the prepared Admin IRL redeem request.');
  }
  const payload = await readBoundedJson(response);
  const fields = isRecord(payload) ? decodeFirestoreFields(payload.fields) : null;
  const updateTime = isRecord(payload) && typeof payload.updateTime === 'string' ? payload.updateTime : '';
  if (!fields || !updateTime) throw new Error('Prepared Admin IRL redeem request was invalid.');
  return { fields, updateTime };
}

async function deletePreparedDocument(
  credential: string,
  path: string,
  updateTime: string,
): Promise<void> {
  const accessToken = await firestoreAccessToken(credential);
  const url = new URL(`${FIRESTORE_DOCUMENTS_BASE_URL}/${path}`);
  url.searchParams.set('currentDocument.updateTime', updateTime);
  const response = await fetch(url, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error('Prepared Admin IRL redeem cleanup failed.');
  }
  await response.body?.cancel().catch(() => undefined);
}

function parseItemIds(value: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`${smokeItemIdsName} must be a JSON array.`);
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length < 1 ||
    parsed.length > 32 ||
    !parsed.every((item) => isBase58Bytes(item, 32)) ||
    new Set(parsed).size !== parsed.length
  ) {
    throw new Error(`${smokeItemIdsName} must contain 1-32 unique asset ids.`);
  }
  return parsed.map(String);
}

function preparedResponse(payload: unknown): {
  encodedTx: string;
  requestId: string;
  dropId: string;
  adminWallet: string;
  itemCount: number;
  targetKind: 'pack';
} {
  if (
    !isRecord(payload) ||
    !hasExactKeys(payload, ['encodedTx', 'requestId', 'dropId', 'adminWallet', 'itemCount', 'targetKind']) ||
    typeof payload.encodedTx !== 'string' ||
    payload.encodedTx.length === 0 ||
    payload.encodedTx.length > 16 * 1024 ||
    typeof payload.requestId !== 'string' ||
    !/^[A-Za-z0-9]{20}$/.test(payload.requestId) ||
    typeof payload.dropId !== 'string' ||
    !isBase58Bytes(payload.adminWallet, 32) ||
    !Number.isSafeInteger(payload.itemCount) ||
    Number(payload.itemCount) < 1 ||
    payload.targetKind !== 'pack'
  ) {
    throw new Error('Authenticated smoke returned an invalid Admin IRL redeem response.');
  }
  return {
    encodedTx: payload.encodedTx,
    requestId: payload.requestId,
    dropId: payload.dropId,
    adminWallet: String(payload.adminWallet),
    itemCount: Number(payload.itemCount),
    targetKind: 'pack',
  };
}

function validatePreparedDocument(
  document: PreparedAdminIrlDocument,
  expected: {
    requestId: string;
    dropId: string;
    owner: string;
    adminWallet: string;
    itemIds: string[];
    prepareAttemptId: string;
  },
): void {
  const fields = document.fields;
  if (!hasExactKeys(fields, [
    'adminWallet',
    'createdAt',
    'dropId',
    'itemIds',
    'items',
    'owner',
    'prepareAttemptId',
    'preparedExpiresAt',
    'status',
    'targetKind',
    'updatedAt',
  ])) throw new Error('Prepared Admin IRL redeem request did not match the smoke request.');
  if (
    fields.status !== 'prepared' ||
    fields.dropId !== expected.dropId ||
    fields.owner !== expected.owner ||
    fields.adminWallet !== expected.adminWallet ||
    fields.targetKind !== 'pack' ||
    fields.prepareAttemptId !== expected.prepareAttemptId ||
    !Number.isSafeInteger(fields.createdAt) ||
    !Number.isSafeInteger(fields.updatedAt) ||
    !Number.isSafeInteger(fields.preparedExpiresAt) ||
    Number(fields.preparedExpiresAt) <= Number(fields.createdAt) ||
    JSON.stringify(fields.itemIds) !== JSON.stringify(expected.itemIds) ||
    !Array.isArray(fields.items) ||
    fields.items.length !== expected.itemIds.length
  ) throw new Error('Prepared Admin IRL redeem request did not match the smoke request.');
  fields.items.forEach((value, index) => {
    if (
      !isRecord(value) ||
      !hasExactKeys(value, ['assetId', 'kind', 'refId']) ||
      value.assetId !== expected.itemIds[index] ||
      value.kind !== 'box' ||
      !Number.isSafeInteger(value.refId) ||
      Number(value.refId) < 1
    ) throw new Error('Prepared Admin IRL redeem request did not match the smoke request.');
  });
}

function validatePreparedTransaction(
  payload: ReturnType<typeof preparedResponse>,
  expected: { owner: string; itemIds: string[] },
): void {
  let transaction: VersionedTransaction;
  try {
    transaction = VersionedTransaction.deserialize(Buffer.from(payload.encodedTx, 'base64'));
  } catch {
    throw new Error('Authenticated smoke returned an invalid Admin IRL redeem transaction.');
  }
  const message = transaction.message;
  const signers = message.staticAccountKeys.slice(0, message.header.numRequiredSignatures);
  if (
    signers.length !== 1 ||
    signers[0].toBase58() !== expected.owner ||
    transaction.signatures.length !== 1 ||
    transaction.signatures[0].some((byte) => byte !== 0) ||
    message.addressTableLookups.length !== 0 ||
    message.compiledInstructions.length !== expected.itemIds.length + 1
  ) throw new Error('Authenticated smoke returned an invalid Admin IRL redeem signer state.');
  const compute = message.compiledInstructions[0];
  if (!message.staticAccountKeys[compute.programIdIndex].equals(ComputeBudgetProgram.programId)) {
    throw new Error('Authenticated smoke returned an invalid compute budget instruction.');
  }
  message.compiledInstructions.slice(1).forEach((instruction, index) => {
    const accounts = Array.from(instruction.accountKeyIndexes, (accountIndex) => message.staticAccountKeys[accountIndex]);
    const data = Buffer.from(instruction.data);
    if (
      !message.staticAccountKeys[instruction.programIdIndex].equals(mplCoreProgram) ||
      !data.equals(Buffer.from([14, 0])) ||
      accounts.length !== 7 ||
      !accounts[0].equals(new PublicKey(expected.itemIds[index])) ||
      !accounts[2].equals(new PublicKey(expected.owner)) ||
      !accounts[3].equals(new PublicKey(expected.owner)) ||
      !accounts[4].equals(new PublicKey(payload.adminWallet)) ||
      !accounts[5].equals(SystemProgram.programId) ||
      !accounts[6].equals(new PublicKey(SPL_NOOP_PROGRAM_ADDRESS))
    ) throw new Error('Authenticated smoke returned invalid Admin IRL redeem instruction accounts.');
  });
}

async function simulatePreparedTransaction(
  fetchImpl: typeof fetch,
  encodedTx: string,
  cluster: 'mainnet-beta' | 'devnet',
): Promise<void> {
  const id = 'admin-irl-redeem-prepare-smoke';
  const response = await fetchImpl(`https://api.mons.shop/rpc/${cluster}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: 'https://mons.shop',
      'Solana-Client': id,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id,
      method: 'simulateTransaction',
      params: [encodedTx, { commitment: 'confirmed', encoding: 'base64', sigVerify: false }],
    }),
    cache: 'no-store',
    redirect: 'manual',
    signal: AbortSignal.timeout(30_000),
  });
  const payload = await readBoundedJson(response);
  const result = isRecord(payload) && payload.jsonrpc === '2.0' && payload.id === id && isRecord(payload.result)
    ? payload.result
    : null;
  const value = result && isRecord(result.value) ? result.value : null;
  if (!response.ok || !value || value.err !== null) {
    throw new Error('Authenticated smoke Admin IRL redeem transaction simulation failed.');
  }
}

function defaultDependencies(): SmokeDependencies {
  return {
    deletePreparedDocument,
    fetch: (input, init) => fetch(input, init),
    loadPreparedDocument,
    readWriterCredential: () => {
      const credential = readCloudflareFirestoreKeychainCredential(firestoreWriterServiceAccountEmail);
      parseWriterCredential(credential);
      return credential;
    },
    simulatePreparedTransaction,
  };
}

async function smokeAndCleanupAdminIrlRedeemPrepare(
  environment: NodeJS.ProcessEnv = process.env,
  overrides: Partial<SmokeDependencies> = {},
): Promise<void> {
  const dependencies = { ...defaultDependencies(), ...overrides };
  const token = String(environment[smokeTokenName] || '').trim();
  const owner = String(environment[smokeOwnerName] || '').trim();
  const dropId = String(environment[smokeDropIdName] || '').trim().toLowerCase();
  const itemIds = parseItemIds(String(environment[smokeItemIdsName] || ''));
  if (!token || token.length > 16 * 1024) throw new Error(`${smokeTokenName} is required.`);
  if (!isBase58Bytes(owner, 32)) throw new Error(`${smokeOwnerName} must be a valid wallet.`);
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(dropId)) throw new Error(`${smokeDropIdName} must be a valid drop id.`);
  const config = getFunctionsDrop(dropId);
  if (!config || (config.solanaCluster !== 'mainnet-beta' && config.solanaCluster !== 'devnet')) {
    throw new Error(`${smokeDropIdName} must identify a supported drop.`);
  }
  const prepareAttemptId = randomUUID();
  const credential = dependencies.readWriterCredential();
  const response = await dependencies.fetch('https://api.mons.shop/admin/irl-redeem/prepare', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Origin: 'https://mons.shop',
      [ADMIN_IRL_REDEEM_PREPARE_ATTEMPT_HEADER]: prepareAttemptId,
    },
    body: JSON.stringify({ owner, dropId, itemIds }),
    cache: 'no-store',
    redirect: 'manual',
    signal: AbortSignal.timeout(65_000),
  });
  const payload = await readBoundedJson(response);
  if (response.status !== 200) throw new Error(`Authenticated smoke failed with HTTP ${response.status}.`);
  const prepared = preparedResponse(payload);
  if (prepared.dropId !== dropId || prepared.itemCount !== itemIds.length) {
    throw new Error('Authenticated smoke returned an incompatible Admin IRL redeem response.');
  }
  const path = `drops/${dropId}/adminIrlRedeemRequests/${prepared.requestId}`;
  const document = await dependencies.loadPreparedDocument(credential, path);
  if (document.fields.prepareAttemptId !== prepareAttemptId) {
    throw new Error('Prepared Admin IRL redeem request did not match the smoke attempt.');
  }
  try {
    validatePreparedDocument(document, {
      requestId: prepared.requestId,
      dropId,
      owner,
      adminWallet: prepared.adminWallet,
      itemIds,
      prepareAttemptId,
    });
    validatePreparedTransaction(prepared, { owner, itemIds });
    await dependencies.simulatePreparedTransaction(dependencies.fetch, prepared.encodedTx, config.solanaCluster);
  } finally {
    await dependencies.deletePreparedDocument(credential, path, document.updateTime);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  smokeAndCleanupAdminIrlRedeemPrepare().catch((error) => {
    console.error(`[smoke-admin-irl-redeem-prepare] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
