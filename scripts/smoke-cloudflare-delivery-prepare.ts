import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SignJWT, importPKCS8 } from 'jose';
import nacl from 'tweetnacl';
import {
  ComputeBudgetProgram,
  PublicKey,
  SystemProgram,
  VersionedTransaction,
} from '@solana/web3.js';
import {
  decodeFirestoreFields,
  FIRESTORE_DOCUMENTS_BASE_URL,
  isRecord,
} from '../cloud/workers/api/src/firestoreRest.js';
import { getFunctionsDrop } from '../functions/src/config/deployment.js';
import { BOX_MINTER_CONFIG_SEED } from '../functions/src/shared/boxMinterProtocol.js';
import { DELIVERY_PREPARE_ATTEMPT_HEADER } from '../functions/src/shared/contracts.js';
import type { SolanaCluster } from '../functions/src/shared/deploymentCore.js';
import { isBase58Bytes } from '../functions/src/shared/solanaRpcProxy.js';
import {
  BUBBLEGUM_PROGRAM_ADDRESS,
  MPL_ACCOUNT_COMPRESSION_PROGRAM_ADDRESS,
  MPL_CORE_CPI_SIGNER_ADDRESS,
  MPL_CORE_PROGRAM_ADDRESS,
  MPL_NOOP_PROGRAM_ADDRESS,
  SPL_NOOP_PROGRAM_ADDRESS,
} from '../functions/src/shared/solanaProgramAddresses.js';
import { calculateDeliveryLamports } from '../functions/src/shared/shipping.js';
import {
  firestoreWriterServiceAccountEmail,
  readCloudflareFirestoreKeychainCredential,
} from './cloudflare-firestore-keychain.js';
type PreparedDeliveryDocument = {
  fields: Record<string, unknown>;
  updateTime: string;
};

type SmokeDependencies = {
  deletePreparedDocument: (credential: string, path: string, updateTime: string) => Promise<void>;
  fetch: typeof fetch;
  loadPreparedDocument: (credential: string, path: string) => Promise<PreparedDeliveryDocument>;
  readWriterCredential: () => string;
  simulatePreparedDelivery: (fetchImpl: typeof fetch, encodedTx: string, cluster: SolanaCluster) => Promise<void>;
};

const smokeTokenName = 'DELIVERY_PREPARE_SMOKE_FIREBASE_TOKEN';
const smokeOwnerName = 'DELIVERY_PREPARE_SMOKE_OWNER';
const smokeDropIdName = 'DELIVERY_PREPARE_SMOKE_DROP_ID';
const smokeAddressIdName = 'DELIVERY_PREPARE_SMOKE_ADDRESS_ID';
const smokeItemIdsName = 'DELIVERY_PREPARE_SMOKE_ITEM_IDS';
const googleOAuthTokenUrl = 'https://oauth2.googleapis.com/token';
const googleDatastoreScope = 'https://www.googleapis.com/auth/datastore';
const deliverDiscriminator = Buffer.from('fa83de39d3e5d193', 'hex');

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join('\0') === [...keys].sort().join('\0');
}

function invalidPreparedDocument(): never {
  throw new Error('Prepared delivery document did not match the smoke request.');
}

function preparedRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : invalidPreparedDocument();
}

function preparedArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : invalidPreparedDocument();
}

function preparedItemKind(value: unknown): 'box' | 'dude' {
  return value === 'box' || value === 'dude' ? value : invalidPreparedDocument();
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
): Promise<PreparedDeliveryDocument> {
  const accessToken = await firestoreAccessToken(credential);
  const response = await fetch(`${FIRESTORE_DOCUMENTS_BASE_URL}/${path}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error('Unable to verify the prepared delivery document.');
  }
  const payload = await readBoundedJson(response);
  const fields = isRecord(payload) ? decodeFirestoreFields(payload.fields) : null;
  const updateTime = isRecord(payload) && typeof payload.updateTime === 'string' ? payload.updateTime : '';
  if (!fields || !updateTime) throw new Error('Prepared delivery document was invalid.');
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
    throw new Error('Prepared delivery cleanup failed.');
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

function u32LE(value: number): Buffer {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(value >>> 0, 0);
  return buffer;
}

function deliveryConfig(dropId: string): {
  programId: PublicKey;
  configPda: PublicKey;
  treasury: PublicKey;
  collection: PublicKey;
  lookupTable?: PublicKey;
  lookupAddresses: PublicKey[];
  cluster: SolanaCluster;
} {
  const config = getFunctionsDrop(dropId);
  if (!config) throw new Error('Authenticated smoke used an unsupported drop.');
  const programId = new PublicKey(config.boxMinterProgramId);
  const configPda = config.boxMinterConfigPda
    ? new PublicKey(config.boxMinterConfigPda)
    : PublicKey.findProgramAddressSync([Buffer.from(BOX_MINTER_CONFIG_SEED)], programId)[0];
  const lookupTable = config.deliveryLookupTable ? new PublicKey(config.deliveryLookupTable) : undefined;
  const treasury = new PublicKey(config.treasury);
  const collection = new PublicKey(config.collectionMint);
  const bubblegum = new PublicKey(BUBBLEGUM_PROGRAM_ADDRESS);
  const receiptTree = config.receiptsMerkleTree ? new PublicKey(config.receiptsMerkleTree) : undefined;
  const lookupAddresses = uniquePublicKeys([
    programId,
    configPda,
    treasury,
    collection,
    new PublicKey(MPL_CORE_PROGRAM_ADDRESS),
    SystemProgram.programId,
    ComputeBudgetProgram.programId,
    new PublicKey(SPL_NOOP_PROGRAM_ADDRESS),
    new PublicKey(MPL_NOOP_PROGRAM_ADDRESS),
    new PublicKey(MPL_ACCOUNT_COMPRESSION_PROGRAM_ADDRESS),
    bubblegum,
    new PublicKey(MPL_CORE_CPI_SIGNER_ADDRESS),
    ...(receiptTree ? [
      receiptTree,
      PublicKey.findProgramAddressSync([receiptTree.toBuffer()], bubblegum)[0],
    ] : []),
  ]);
  return {
    programId,
    configPda,
    treasury,
    collection,
    cluster: config.solanaCluster,
    lookupAddresses,
    ...(lookupTable ? { lookupTable } : {}),
  };
}

function uniquePublicKeys(keys: PublicKey[]): PublicKey[] {
  const seen = new Set<string>();
  return keys.filter((key) => {
    const encoded = key.toBase58();
    if (seen.has(encoded)) return false;
    seen.add(encoded);
    return true;
  });
}

function deliveryPda(programId: PublicKey, configPda: PublicKey, deliveryId: number): [PublicKey, number] {
  const legacyConfig = PublicKey.findProgramAddressSync([Buffer.from(BOX_MINTER_CONFIG_SEED)], programId)[0];
  const seeds: Uint8Array[] = [Buffer.from('delivery')];
  if (!configPda.equals(legacyConfig)) seeds.push(configPda.toBuffer());
  seeds.push(u32LE(deliveryId));
  return PublicKey.findProgramAddressSync(seeds, programId);
}

function validatePreparedTransaction(
  payload: unknown,
  expected: { owner: string; dropId: string; itemIds: string[] },
): { cluster: SolanaCluster; deliveryId: number; deliveryLamports: number; deliveryPda: string; encodedTx: string } {
  if (
    !isRecord(payload) ||
    Object.keys(payload).sort().join(',') !== 'deliveryId,deliveryLamports,encodedTx' ||
    typeof payload.encodedTx !== 'string' ||
    payload.encodedTx.length === 0 ||
    payload.encodedTx.length > 16 * 1024 ||
    !Number.isSafeInteger(payload.deliveryId) ||
    Number(payload.deliveryId) < 1 ||
    Number(payload.deliveryId) >= 2 ** 31 ||
    !Number.isSafeInteger(payload.deliveryLamports) ||
    Number(payload.deliveryLamports) < 0
  ) {
    throw new Error('Authenticated smoke returned an invalid delivery response.');
  }
  let transaction: VersionedTransaction;
  try {
    transaction = VersionedTransaction.deserialize(Buffer.from(payload.encodedTx, 'base64'));
  } catch {
    throw new Error('Authenticated smoke returned an invalid delivery transaction.');
  }
  const signers = transaction.message.staticAccountKeys.slice(0, transaction.message.header.numRequiredSignatures);
  const ownerIndex = signers.findIndex((key) => key.toBase58() === expected.owner);
  if (
    ownerIndex !== 0 ||
    signers.length !== 2 ||
    transaction.signatures.length !== signers.length ||
    transaction.signatures[ownerIndex]?.some((byte) => byte !== 0)
  ) {
    throw new Error('Authenticated smoke returned an invalid delivery signer state.');
  }
  const message = transaction.message.serialize();
  const hasServerSignature = transaction.signatures.some((signature, index) =>
    index !== ownerIndex &&
    signature.some((byte) => byte !== 0) &&
    nacl.sign.detached.verify(message, signature, signers[index].toBytes()));
  if (!hasServerSignature) throw new Error('Authenticated smoke transaction is missing the server signature.');
  const deliveryId = Number(payload.deliveryId);
  const deliveryLamports = Number(payload.deliveryLamports);
  const config = deliveryConfig(expected.dropId);
  const staticKeys = transaction.message.staticAccountKeys;
  const lookups = transaction.message.addressTableLookups;
  if (
    (config.lookupTable && (lookups.length !== 1 || !lookups[0].accountKey.equals(config.lookupTable))) ||
    (!config.lookupTable && lookups.length !== 0)
  ) {
    throw new Error('Authenticated smoke returned an unexpected delivery lookup table.');
  }
  const loadedWritable: PublicKey[] = [];
  const loadedReadonly: PublicKey[] = [];
  for (const lookup of lookups) {
    for (const index of lookup.writableIndexes) {
      const key = config.lookupAddresses[index];
      if (!key) throw new Error('Authenticated smoke returned an invalid delivery lookup index.');
      loadedWritable.push(key);
    }
    for (const index of lookup.readonlyIndexes) {
      const key = config.lookupAddresses[index];
      if (!key) throw new Error('Authenticated smoke returned an invalid delivery lookup index.');
      loadedReadonly.push(key);
    }
  }
  const resolvedKeys = [...staticKeys, ...loadedWritable, ...loadedReadonly];
  const resolvedKey = (index: number): PublicKey => {
    const key = resolvedKeys[index];
    if (!key) throw new Error('Authenticated smoke returned unresolved delivery accounts.');
    return key;
  };
  const deliveryInstructions = transaction.message.compiledInstructions.filter(
    (instruction) => resolvedKey(instruction.programIdIndex).equals(config.programId),
  );
  if (deliveryInstructions.length !== 1 || transaction.message.compiledInstructions.length !== 2) {
    throw new Error('Authenticated smoke returned an invalid delivery instruction set.');
  }
  const otherInstruction = transaction.message.compiledInstructions.find((instruction) => instruction !== deliveryInstructions[0]);
  const expectedComputeInstruction = ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 });
  if (
    !otherInstruction ||
    !resolvedKey(otherInstruction.programIdIndex).equals(ComputeBudgetProgram.programId) ||
    otherInstruction.accountKeyIndexes.length !== 0 ||
    !Buffer.from(otherInstruction.data).equals(expectedComputeInstruction.data)
  ) {
    throw new Error('Authenticated smoke returned an invalid delivery instruction set.');
  }
  const instruction = deliveryInstructions[0];
  const data = Buffer.from(instruction.data);
  const accountIndexes = Array.from(instruction.accountKeyIndexes);
  const accountWritable = (position: number): boolean => transaction.message.isAccountWritable(accountIndexes[position]);
  const [expectedDeliveryPda, expectedDeliveryBump] = deliveryPda(config.programId, config.configPda, deliveryId);
  if (
    data.length !== 21 ||
    !data.subarray(0, 8).equals(deliverDiscriminator) ||
    data.readUInt32LE(8) !== deliveryId ||
    data.readBigUInt64LE(12) !== BigInt(deliveryLamports) ||
    data[20] !== expectedDeliveryBump ||
    accountIndexes.length !== 9 + expected.itemIds.length
  ) {
    throw new Error('Authenticated smoke returned invalid delivery instruction data.');
  }
  const staticAccount = (position: number): PublicKey => {
    return resolvedKey(accountIndexes[position]);
  };
  if (
    !staticAccount(0).equals(config.configPda) ||
    !staticAccount(1).equals(signers[1]) ||
    !staticAccount(2).equals(new PublicKey(expected.owner)) ||
    !staticAccount(3).equals(config.treasury) ||
    !staticAccount(4).equals(config.collection) ||
    !staticAccount(5).equals(new PublicKey(MPL_CORE_PROGRAM_ADDRESS)) ||
    !staticAccount(6).equals(SystemProgram.programId) ||
    !staticAccount(7).equals(new PublicKey(SPL_NOOP_PROGRAM_ADDRESS)) ||
    !staticAccount(8).equals(expectedDeliveryPda) ||
    !expected.itemIds.every((itemId, index) => staticAccount(9 + index).equals(new PublicKey(itemId))) ||
    accountWritable(0) ||
    accountWritable(1) ||
    !accountWritable(2) ||
    !accountWritable(3) ||
    accountWritable(4) ||
    accountWritable(5) ||
    accountWritable(6) ||
    accountWritable(7) ||
    !accountWritable(8) ||
    !expected.itemIds.every((_itemId, index) => accountWritable(9 + index))
  ) {
    throw new Error('Authenticated smoke returned invalid delivery instruction accounts.');
  }
  return {
    cluster: config.cluster,
    deliveryId,
    deliveryLamports,
    deliveryPda: expectedDeliveryPda.toBase58(),
    encodedTx: payload.encodedTx,
  };
}

async function simulatePreparedDelivery(
  fetchImpl: typeof fetch,
  encodedTx: string,
  cluster: SolanaCluster,
): Promise<void> {
  if (cluster !== 'mainnet-beta' && cluster !== 'devnet') {
    throw new Error('Authenticated smoke used an unsupported Solana cluster.');
  }
  const id = 'delivery-prepare-smoke';
  const response = await fetchImpl(`https://api.mons.shop/rpc/${cluster}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: 'https://mons.shop',
      'Solana-Client': 'delivery-prepare-smoke',
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
    throw new Error('Authenticated smoke delivery transaction simulation failed.');
  }
}

function preparedResponseIdentity(payload: unknown): { deliveryId: number; deliveryLamports: number } {
  if (
    !isRecord(payload) ||
    !Number.isSafeInteger(payload.deliveryId) ||
    Number(payload.deliveryId) < 1 ||
    Number(payload.deliveryId) >= 2 ** 31 ||
    !Number.isSafeInteger(payload.deliveryLamports) ||
    Number(payload.deliveryLamports) < 0
  ) {
    throw new Error('Authenticated smoke returned an invalid delivery response.');
  }
  return {
    deliveryId: Number(payload.deliveryId),
    deliveryLamports: Number(payload.deliveryLamports),
  };
}

function validatePreparedDocument(
  document: PreparedDeliveryDocument,
  expected: {
    dropId: string;
    owner: string;
    addressId: string;
    itemIds: string[];
    deliveryId: number;
    deliveryLamports: number;
    deliveryPda: string;
    prepareAttemptId: string;
  },
): void {
  const config = getFunctionsDrop(expected.dropId);
  const fields = document.fields;
  if (!config || !hasExactKeys(fields, [
    'addressId',
    'addressSnapshot',
    'createdAt',
    'deliveryId',
    'deliveryLamports',
    'deliveryPda',
    'dropId',
    'itemIds',
    'items',
    ...(config.deliveryLookupTable ? ['lookupTable'] : []),
    'owner',
    'prepareAttemptId',
    'receiptRecovery',
    'status',
  ])) invalidPreparedDocument();
  if (
    fields.status !== 'prepared' ||
    fields.dropId !== expected.dropId ||
    fields.owner !== expected.owner ||
    fields.addressId !== expected.addressId ||
    fields.deliveryId !== expected.deliveryId ||
    fields.deliveryLamports !== expected.deliveryLamports ||
    fields.deliveryPda !== expected.deliveryPda ||
    fields.prepareAttemptId !== expected.prepareAttemptId ||
    fields.lookupTable !== (config.deliveryLookupTable || undefined) ||
    !Number.isSafeInteger(fields.createdAt) ||
    Number(fields.createdAt) <= 0 ||
    !Array.isArray(fields.itemIds) ||
    JSON.stringify(fields.itemIds) !== JSON.stringify(expected.itemIds)
  ) invalidPreparedDocument();
  const addressSnapshot = preparedRecord(fields.addressSnapshot);
  if (addressSnapshot.id !== expected.addressId) invalidPreparedDocument();
  const country = typeof addressSnapshot.countryCode === 'string' && addressSnapshot.countryCode
    ? addressSnapshot.countryCode
    : typeof addressSnapshot.country === 'string' ? addressSnapshot.country : invalidPreparedDocument();
  if (typeof addressSnapshot.encrypted !== 'string') invalidPreparedDocument();
  const storedItems = preparedArray(fields.items);
  if (storedItems.length !== expected.itemIds.length) invalidPreparedDocument();
  const maxDudeId = config.maxSupply * config.itemsPerBox;
  const items = storedItems.map((value, index) => {
    const item = preparedRecord(value);
    const kind = preparedItemKind(item.kind);
    if (
      !hasExactKeys(item, ['assetId', 'kind', 'refId']) ||
      item.assetId !== expected.itemIds[index] ||
      !Number.isSafeInteger(item.refId) ||
      Number(item.refId) < 1 ||
      (kind === 'box' ? Number(item.refId) > 0xffff_ffff : Number(item.refId) > maxDudeId)
    ) invalidPreparedDocument();
    return { kind };
  });
  if (
    calculateDeliveryLamports(items, country, config.itemsPerBox, config.dropFamily, 'arithmetic') !==
    expected.deliveryLamports
  ) invalidPreparedDocument();
  const receiptRecovery = preparedRecord(fields.receiptRecovery);
  if (
    !hasExactKeys(receiptRecovery, ['nextPreparedProbeAt', 'preparedProbeCount']) ||
    receiptRecovery.preparedProbeCount !== 0 ||
    !Number.isSafeInteger(receiptRecovery.nextPreparedProbeAt) ||
    Number(receiptRecovery.nextPreparedProbeAt) <= 0
  ) invalidPreparedDocument();
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
    simulatePreparedDelivery,
  };
}

async function smokeAndCleanupDeliveryPrepare(
  environment: NodeJS.ProcessEnv = process.env,
  overrides: Partial<SmokeDependencies> = {},
): Promise<void> {
  const dependencies = { ...defaultDependencies(), ...overrides };
  const token = String(environment[smokeTokenName] || '').trim();
  const owner = String(environment[smokeOwnerName] || '').trim();
  const dropId = String(environment[smokeDropIdName] || '').trim().toLowerCase();
  const addressId = String(environment[smokeAddressIdName] || '').trim();
  const itemIds = parseItemIds(String(environment[smokeItemIdsName] || ''));
  const prepareAttemptId = randomUUID();
  if (!token || token.length > 16 * 1024) throw new Error(`${smokeTokenName} is required.`);
  if (!isBase58Bytes(owner, 32)) throw new Error(`${smokeOwnerName} must be a valid wallet.`);
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(dropId)) throw new Error(`${smokeDropIdName} must be a valid drop id.`);
  if (!/^[A-Za-z0-9]{20}$/.test(addressId)) throw new Error(`${smokeAddressIdName} must be a valid address id.`);
  const credential = dependencies.readWriterCredential();
  const response = await dependencies.fetch('https://api.mons.shop/delivery/prepare', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Origin: 'https://mons.shop',
      [DELIVERY_PREPARE_ATTEMPT_HEADER]: prepareAttemptId,
    },
    body: JSON.stringify({ owner, dropId, itemIds, addressId }),
    cache: 'no-store',
    redirect: 'manual',
    signal: AbortSignal.timeout(65_000),
  });
  const payload = await readBoundedJson(response);
  if (response.status !== 200) throw new Error(`Authenticated smoke failed with HTTP ${response.status}.`);
  const identity = preparedResponseIdentity(payload);
  const config = deliveryConfig(dropId);
  const expectedDeliveryPda = deliveryPda(config.programId, config.configPda, identity.deliveryId)[0].toBase58();
  const path = `drops/${dropId}/deliveryOrders/${identity.deliveryId}`;
  const document = await dependencies.loadPreparedDocument(credential, path);
  if (document.fields.prepareAttemptId !== prepareAttemptId) {
    throw new Error('Prepared delivery document did not match the smoke attempt.');
  }
  try {
    validatePreparedDocument(document, {
      dropId,
      owner,
      addressId,
      itemIds,
      deliveryId: identity.deliveryId,
      deliveryLamports: identity.deliveryLamports,
      deliveryPda: expectedDeliveryPda,
      prepareAttemptId,
    });
    const prepared = validatePreparedTransaction(payload, { owner, dropId, itemIds });
    await dependencies.simulatePreparedDelivery(dependencies.fetch, prepared.encodedTx, prepared.cluster);
  } finally {
    await dependencies.deletePreparedDocument(credential, path, document.updateTime);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  smokeAndCleanupDeliveryPrepare().catch((error) => {
    console.error(`[smoke-delivery-prepare] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
