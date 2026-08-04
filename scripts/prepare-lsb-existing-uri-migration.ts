import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import bs58 from 'bs58';
import {
  Connection,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';

const GENESIS_HASH = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
const PROGRAM_ID = new PublicKey('22NeePs5wgkzP4j5sPzfzJqXsFAu9SUMiGBznPQVaAep');
const CONFIG_PDA = new PublicKey('iGsmSPPYJovrb7jNFCX6BimZN5Z7dpkmCuW9SYAgcMc');
const ADMIN = new PublicKey('kPG2L5zuxqNkvWvJNptbkqnPhk4nGjnGp7jwDFZPQgx');
const COLLECTION = new PublicKey('7c3tY7nEZ6yDuUCrsL6dX7AFcCqKbwMwS6HRvdZXeQXr');
const RECEIPTS_TREE = new PublicKey('Bep28XBM8LEjdCHgTzhuo5hFazpKrKgxDaEcnRg2VThV');
const RECEIPTS_TREE_CONFIG = new PublicKey('61nRmLFVKe7x63Frz9TM2AkGSTmuDyYAuppAwZUee5tX');
const MPL_CORE = new PublicKey('CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d');
const SPL_NOOP = new PublicKey('noopb9bkMVfRPU8AsbpTUg8AQkHtKwMYZiFUjNRtMmV');
const MPL_NOOP = new PublicKey('mnoopTCrg4p8ry25e4bcWA9XZjbNjMTfgYVGGEdRsf3');
const ACCOUNT_COMPRESSION = new PublicKey('mcmt6YrQEMKw8Mw43FmpRLmf7BqRnFMKmAcbxE3xkAW');
const BUBBLEGUM = new PublicKey('BGUMAp9Gq7iTEuizy4pqaxsTyUCBK68MDfK752saRPUY');
const LOADER = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');
const OLD_BASE = 'https://assets.mons.link/drops/lsb';
const NEW_BASE = 'https://cdn.lil.org/nft/little_swag_boxes';
const CONFIG_DISCRIMINATOR = Buffer.from([62, 29, 116, 188, 219, 247, 48, 227]);
const MIGRATE_COLLECTION_URI = Buffer.from([191, 243, 226, 185, 115, 83, 70, 48]);
const MIGRATE_CORE_ASSET_URI = Buffer.from([50, 156, 65, 239, 42, 228, 129, 192]);
const MIGRATE_RECEIPT_URI = Buffer.from([6, 57, 254, 113, 22, 138, 253, 162]);
const MAX_RECEIPT_PROOF_ACCOUNTS = 14;
const CORE_BOX_PATH = '/json/boxes/';
const CORE_FIGURE_PATH = '/json/figures/';
const RECEIPT_BOX_PATH = '/json/receipts/boxes/';
const RECEIPT_FIGURE_PATH = '/json/receipts/figures/';

type Asset = Record<string, any>;
type MigrationKind = 'box' | 'figure';

type CoreTarget = {
  address: string;
  kind: MigrationKind;
  referenceId: number;
  sourceUri: string;
  targetUri: string;
};

type ReceiptTarget = CoreTarget & {
  owner: string;
  leafId: number;
};

function flagValue(name: string) {
  const index = process.argv.indexOf(name);
  if (index < 0) return null;
  const value = process.argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
  return value;
}

const args = process.argv.slice(2);
if (args.some((arg) => /keypair|private|secret|signer/i.test(arg))) {
  throw new Error('The read-only planner does not accept signing material');
}
const rollback = args.includes('--rollback');
const simulate = args.includes('--simulate');
const testUnauthorized = args.includes('--test-unauthorized');
if (testUnauthorized && !simulate) throw new Error('--test-unauthorized requires --simulate');
const outputPath = resolve(flagValue('--out') || '.cache/lsb-existing-uri-migration/plan.json');
const simulationLimitValue = flagValue('--simulation-limit');
const simulationLimit = simulationLimitValue ? Number(simulationLimitValue) : Number.POSITIVE_INFINITY;
if (!Number.isFinite(simulationLimit) && simulationLimitValue) {
  throw new Error('--simulation-limit must be a positive integer');
}
if (simulationLimitValue && (!Number.isInteger(simulationLimit) || simulationLimit < 1)) {
  throw new Error('--simulation-limit must be a positive integer');
}

const heliusApiKey = process.env.HELIUS_API_KEY;
if (!heliusApiKey) throw new Error('HELIUS_API_KEY is required');
const rpcUrl = process.env.HELIUS_RPC_URL
  || `https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(heliusApiKey)}`;
const simulationRpcUrl = process.env.LSB_SIMULATION_RPC_URL || rpcUrl;
const connection = new Connection(simulationRpcUrl, 'finalized');
const sourceBase = rollback ? NEW_BASE : OLD_BASE;
const targetBase = rollback ? OLD_BASE : NEW_BASE;
let rpcId = 0;

async function rpc<T>(method: string, params: unknown = []): Promise<T> {
  for (let attempt = 0; attempt < 7; attempt += 1) {
    const response = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
    });
    if (response.ok) {
      const payload = await response.json() as { result?: T; error?: { message?: string; code?: number } };
      if (!payload.error) return payload.result as T;
      if (payload.error.code !== 429 && payload.error.code !== -32005) {
        throw new Error(`${method}: ${payload.error.message || JSON.stringify(payload.error)}`);
      }
    } else if (response.status !== 429 && response.status < 500) {
      throw new Error(`${method}: HTTP ${response.status}`);
    }
    if (attempt === 6) throw new Error(`${method}: RPC retry limit exceeded`);
    const retryAfter = Number(response.headers.get('retry-after'));
    const delay = Number.isFinite(retryAfter) && retryAfter > 0
      ? retryAfter * 1000
      : Math.min(5_000, 250 * 2 ** attempt) + Math.floor(Math.random() * 150);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, delay));
  }
  throw new Error(`${method}: unreachable retry state`);
}

function decodeConfig(data: Buffer) {
  if (data.length !== 289) throw new Error(`Config length is ${data.length}, expected 289`);
  if (!data.subarray(0, 8).equals(CONFIG_DISCRIMINATOR)) throw new Error('Config discriminator mismatch');
  let offset = 8;
  const pubkey = () => {
    const value = new PublicKey(data.subarray(offset, offset + 32)).toBase58();
    offset += 32;
    return value;
  };
  const admin = pubkey();
  const treasury = pubkey();
  const coreCollection = pubkey();
  offset += 8 + 8 + 32;
  const maxSupply = data.readUInt32LE(offset);
  offset += 4 + 1 + 4;
  const string = () => {
    const length = data.readUInt32LE(offset);
    offset += 4;
    const end = offset + length;
    if (end > data.length) throw new Error('Config string exceeds account data');
    const value = data.subarray(offset, end).toString('utf8');
    offset = end;
    return value;
  };
  string();
  string();
  const uriBase = string();
  return { admin, treasury, coreCollection, maxSupply, uriBase };
}

function strictReference(uri: string, base: string, path: string, maximum: number) {
  const prefix = `${base}${path}`;
  if (!uri.startsWith(prefix) || !uri.endsWith('.json')) return null;
  const stem = uri.slice(prefix.length, -'.json'.length);
  if (!/^[1-9]\d*$/.test(stem)) return null;
  const referenceId = Number(stem);
  return Number.isSafeInteger(referenceId) && referenceId <= maximum ? referenceId : null;
}

function authorityIncludes(asset: Asset, address: PublicKey) {
  return Array.isArray(asset.authorities) && asset.authorities.some(
    (authority: any) => authority?.address === address.toBase58()
      && Array.isArray(authority.scopes)
      && authority.scopes.includes('full'),
  );
}

function inCollection(asset: Asset) {
  return Array.isArray(asset.grouping) && asset.grouping.some(
    (group: any) => group?.group_key === 'collection' && group?.group_value === COLLECTION.toBase58(),
  );
}

function classifyUri(uri: string, maxSupply: number, receipt: boolean) {
  const paths = receipt
    ? [[RECEIPT_BOX_PATH, 'box', maxSupply], [RECEIPT_FIGURE_PATH, 'figure', 999]] as const
    : [[CORE_BOX_PATH, 'box', maxSupply], [CORE_FIGURE_PATH, 'figure', 999]] as const;
  for (const [path, kind, maximum] of paths) {
    const sourceId = strictReference(uri, sourceBase, path, maximum);
    if (sourceId !== null) return { status: 'source' as const, path, kind, referenceId: sourceId };
    const targetId = strictReference(uri, targetBase, path, maximum);
    if (targetId !== null) return { status: 'target' as const, path, kind, referenceId: targetId };
  }
  return null;
}

function compactTarget(asset: Asset, classification: NonNullable<ReturnType<typeof classifyUri>>): CoreTarget {
  return {
    address: asset.id,
    kind: classification.kind,
    referenceId: classification.referenceId,
    sourceUri: `${sourceBase}${classification.path}${classification.referenceId}.json`,
    targetUri: `${targetBase}${classification.path}${classification.referenceId}.json`,
  };
}

function migrateCollectionInstruction() {
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: CONFIG_PDA, isSigner: false, isWritable: false },
      { pubkey: ADMIN, isSigner: true, isWritable: true },
      { pubkey: COLLECTION, isSigner: false, isWritable: true },
      { pubkey: MPL_CORE, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: SPL_NOOP, isSigner: false, isWritable: false },
    ],
    data: MIGRATE_COLLECTION_URI,
  });
}

function migrateCoreInstruction(asset: PublicKey, admin = ADMIN) {
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: CONFIG_PDA, isSigner: false, isWritable: false },
      { pubkey: admin, isSigner: true, isWritable: true },
      { pubkey: asset, isSigner: false, isWritable: true },
      { pubkey: COLLECTION, isSigner: false, isWritable: false },
      { pubkey: MPL_CORE, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: SPL_NOOP, isSigner: false, isWritable: false },
    ],
    data: MIGRATE_CORE_ASSET_URI,
  });
}

function u64(value: number) {
  const data = Buffer.alloc(8);
  data.writeBigUInt64LE(BigInt(value));
  return data;
}

function u32(value: number) {
  const data = Buffer.alloc(4);
  data.writeUInt32LE(value);
  return data;
}

function u16(value: number) {
  const data = Buffer.alloc(2);
  data.writeUInt16LE(value);
  return data;
}

async function migrateReceiptInstruction(target: ReceiptTarget) {
  const [asset, proof] = await Promise.all([
    rpc<Asset>('getAsset', { id: target.address }),
    rpc<any>('getAssetProof', { id: target.address }),
  ]);
  const classification = classifyUri(String(asset.content?.json_uri || ''), 333, true);
  if (!classification || classification.status !== 'source'
    || classification.kind !== target.kind || classification.referenceId !== target.referenceId) {
    throw new Error(`Receipt changed since planning: ${target.address}`);
  }
  if (asset.interface !== 'MplBubblegumV2' || asset.burnt || !asset.mutable || !inCollection(asset)) {
    throw new Error(`Invalid receipt state: ${target.address}`);
  }
  const owner = String(asset.ownership?.owner || '');
  const delegate = asset.ownership?.delegated ? String(asset.ownership?.delegate || '') : owner;
  if (!owner || !delegate || owner !== target.owner) throw new Error(`Receipt ownership changed: ${target.address}`);
  const compression = asset.compression || {};
  if (compression.tree !== RECEIPTS_TREE.toBase58()
    || compression.flags !== 0
    || compression.leaf_id !== target.leafId
    || !compression.asset_data_hash) {
    throw new Error(`Invalid receipt compression state: ${target.address}`);
  }
  if (proof.tree_id !== RECEIPTS_TREE.toBase58() || !Array.isArray(proof.proof)
    || proof.proof.length > MAX_RECEIPT_PROOF_ACCOUNTS) {
    throw new Error(`Invalid receipt proof: ${target.address}`);
  }
  const root = Buffer.from(bs58.decode(proof.root));
  const assetDataHash = Buffer.from(bs58.decode(compression.asset_data_hash));
  if (root.length !== 32 || assetDataHash.length !== 32) throw new Error(`Invalid receipt hashes: ${target.address}`);
  const data = Buffer.concat([
    MIGRATE_RECEIPT_URI,
    root,
    assetDataHash,
    Buffer.from([compression.flags]),
    u64(compression.leaf_id),
    u32(compression.leaf_id),
    Buffer.from([target.kind === 'box' ? 0 : 1]),
    u16(target.referenceId),
  ]);
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: CONFIG_PDA, isSigner: false, isWritable: false },
      { pubkey: ADMIN, isSigner: true, isWritable: true },
      { pubkey: new PublicKey(owner), isSigner: false, isWritable: false },
      { pubkey: new PublicKey(delegate), isSigner: false, isWritable: false },
      { pubkey: RECEIPTS_TREE, isSigner: false, isWritable: true },
      { pubkey: RECEIPTS_TREE_CONFIG, isSigner: false, isWritable: true },
      { pubkey: COLLECTION, isSigner: false, isWritable: false },
      { pubkey: BUBBLEGUM, isSigner: false, isWritable: false },
      { pubkey: MPL_NOOP, isSigner: false, isWritable: false },
      { pubkey: ACCOUNT_COMPRESSION, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ...proof.proof.map((node: string) => ({
        pubkey: new PublicKey(node),
        isSigner: false,
        isWritable: false,
      })),
    ],
    data,
  });
}

async function simulateInstruction(
  instruction: TransactionInstruction | TransactionInstruction[],
  payer = ADMIN,
) {
  const { blockhash } = await connection.getLatestBlockhash('finalized');
  const message = new TransactionMessage({
    payerKey: payer,
    recentBlockhash: blockhash,
    instructions: Array.isArray(instruction) ? instruction : [instruction],
  }).compileToV0Message();
  const transaction = new VersionedTransaction(message);
  const result = await connection.simulateTransaction(transaction, {
    commitment: 'finalized',
    sigVerify: false,
    replaceRecentBlockhash: true,
  });
  return {
    err: result.value.err,
    unitsConsumed: result.value.unitsConsumed,
    logs: result.value.err ? result.value.logs : undefined,
  };
}

async function concurrentMap<T, R>(values: T[], concurrency: number, task: (value: T) => Promise<R>) {
  const results = new Array<R>(values.length);
  let next = 0;
  async function worker() {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= values.length) return;
      results[index] = await task(values[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, worker));
  return results;
}

const manifest = JSON.parse(await readFile(
  new URL('../onchain/releases/little-swag-boxes-existing-uri-migration.json', import.meta.url),
  'utf8',
));
const manifestMatches = manifest.genesisHash === GENESIS_HASH
  && manifest.programId === PROGRAM_ID.toBase58()
  && manifest.configPda === CONFIG_PDA.toBase58()
  && manifest.admin === ADMIN.toBase58()
  && manifest.coreCollection === COLLECTION.toBase58()
  && manifest.receiptsTree === RECEIPTS_TREE.toBase58()
  && manifest.receiptsTreeConfig === RECEIPTS_TREE_CONFIG.toBase58()
  && manifest.legacyUriBase === OLD_BASE
  && manifest.canonicalUriBase === NEW_BASE
  && JSON.stringify(manifest.instructions.migrateCollectionUri.discriminator) === JSON.stringify([...MIGRATE_COLLECTION_URI])
  && JSON.stringify(manifest.instructions.migrateCoreAssetUri.discriminator) === JSON.stringify([...MIGRATE_CORE_ASSET_URI])
  && JSON.stringify(manifest.instructions.migrateReceiptUri.discriminator) === JSON.stringify([...MIGRATE_RECEIPT_URI]);
if (!manifestMatches) throw new Error('Migration manifest does not match the fixed planner scope');

const genesisHash = await rpc<string>('getGenesisHash');
if (genesisHash !== GENESIS_HASH) throw new Error(`Refusing non-mainnet genesis hash ${genesisHash}`);
const [programResponse, configResponse, collectionAsset] = await Promise.all([
  rpc<any>('getAccountInfo', [PROGRAM_ID.toBase58(), { encoding: 'base64', commitment: 'finalized' }]),
  rpc<any>('getAccountInfo', [CONFIG_PDA.toBase58(), { encoding: 'base64', commitment: 'finalized' }]),
  rpc<Asset>('getAsset', { id: COLLECTION.toBase58() }),
]);
if (!programResponse.value?.executable || programResponse.value.owner !== LOADER.toBase58()) {
  throw new Error('Program executable or loader mismatch');
}
if (!configResponse.value || configResponse.value.owner !== PROGRAM_ID.toBase58()) {
  throw new Error('Config account owner mismatch');
}
const programAccountData = Buffer.from(programResponse.value.data[0], 'base64');
if (programAccountData.readUInt32LE(0) !== 2) throw new Error('Program account is not upgradeable');
const programDataAddress = new PublicKey(programAccountData.subarray(4, 36));
const programDataResponse = await rpc<any>('getAccountInfo', [
  programDataAddress.toBase58(),
  { encoding: 'base64', commitment: 'finalized' },
]);
const programData = Buffer.from(programDataResponse.value.data[0], 'base64');
if (programDataResponse.value.owner !== LOADER.toBase58() || programData.readUInt32LE(0) !== 3) {
  throw new Error('ProgramData account mismatch');
}
const configData = Buffer.from(configResponse.value.data[0], 'base64');
const config = decodeConfig(configData);
if (config.admin !== ADMIN.toBase58() || config.coreCollection !== COLLECTION.toBase58()) {
  throw new Error('Config authority or collection mismatch');
}
if (config.uriBase !== targetBase) {
  throw new Error(`Config URI must equal migration target ${targetBase}, found ${config.uriBase}`);
}
if (collectionAsset.interface !== 'MplCoreCollection' || collectionAsset.burnt
  || !authorityIncludes(collectionAsset, CONFIG_PDA)) {
  throw new Error('Collection authority or state mismatch');
}
const collectionSourceUri = `${sourceBase}/collection.json`;
const collectionTargetUri = `${targetBase}/collection.json`;
const collectionUri = String(collectionAsset.content?.json_uri || '');
if (collectionUri !== collectionSourceUri && collectionUri !== collectionTargetUri) {
  throw new Error(`Unexpected collection URI ${collectionUri}`);
}

const assets: Asset[] = [];
for (let page = 1; ; page += 1) {
  const result = await rpc<any>('searchAssets', {
    grouping: ['collection', COLLECTION.toBase58()],
    page,
    limit: 1000,
    options: { showUnverifiedCollections: true, showCollectionMetadata: true },
  });
  assets.push(...result.items);
  if (assets.length >= result.total || result.items.length === 0) break;
}

const coreTargets: CoreTarget[] = [];
const receiptTargets: ReceiptTarget[] = [];
const alreadyTarget = { core: 0, receipts: 0 };
let burnedCoreRecords = 0;
for (const asset of assets) {
  if (!asset.id || !inCollection(asset)) throw new Error(`Invalid collection grouping for ${asset.id || 'unknown'}`);
  const uri = String(asset.content?.json_uri || '');
  if (asset.interface === 'MplCoreAsset') {
    const classification = classifyUri(uri, config.maxSupply, false);
    if (!classification) throw new Error(`Unexpected Core URI ${asset.id}: ${uri}`);
    if (asset.burnt) {
      burnedCoreRecords += 1;
      continue;
    }
    if (!asset.mutable || !authorityIncludes(asset, CONFIG_PDA)) {
      throw new Error(`Core asset authority or mutability mismatch: ${asset.id}`);
    }
    if (classification.status === 'source') coreTargets.push(compactTarget(asset, classification));
    else alreadyTarget.core += 1;
    continue;
  }
  if (asset.interface === 'MplBubblegumV2') {
    if (asset.burnt || !asset.mutable || asset.compression?.tree !== RECEIPTS_TREE.toBase58()) {
      throw new Error(`Compressed receipt state mismatch: ${asset.id}`);
    }
    const classification = classifyUri(uri, config.maxSupply, true);
    if (!classification) throw new Error(`Unexpected receipt URI ${asset.id}: ${uri}`);
    const expectedName = `receipt · ${classification.kind} ${classification.referenceId}`;
    if (asset.content?.metadata?.name !== expectedName
      || asset.content?.metadata?.symbol !== ''
      || asset.royalty?.basis_points !== 0
      || asset.royalty?.primary_sale_happened !== false
      || !Array.isArray(asset.creators) || asset.creators.length !== 0) {
      throw new Error(`Compressed receipt metadata mismatch: ${asset.id}`);
    }
    if (classification.status === 'source') {
      receiptTargets.push({
        ...compactTarget(asset, classification),
        owner: String(asset.ownership?.owner || ''),
        leafId: Number(asset.compression?.leaf_id),
      });
    } else {
      alreadyTarget.receipts += 1;
    }
    continue;
  }
  throw new Error(`Unexpected collection interface ${asset.id}: ${asset.interface}`);
}
coreTargets.sort((left, right) => left.address.localeCompare(right.address));
receiptTargets.sort((left, right) => left.leafId - right.leafId);

const observedSnapshot = {
  collectionAssets: assets.length,
  liveCoreAssets: coreTargets.length + alreadyTarget.core,
  burnedCoreRecords,
  liveCompressedReceipts: receiptTargets.length + alreadyTarget.receipts,
};
for (const [key, expected] of Object.entries(manifest.expectedSnapshot)) {
  if (observedSnapshot[key as keyof typeof observedSnapshot] !== expected) {
    throw new Error(`Live inventory ${key} changed: expected ${expected}, found ${observedSnapshot[key as keyof typeof observedSnapshot]}`);
  }
}

let simulations: any = null;
if (simulate) {
  const coreSample = coreTargets.slice(0, simulationLimit);
  const receiptSample = receiptTargets.slice(0, simulationLimit);
  const collection = collectionUri === collectionSourceUri
    ? await simulateInstruction(migrateCollectionInstruction())
    : null;
  const core = await concurrentMap(coreSample, 4, async (target) => ({
    address: target.address,
    ...await simulateInstruction(migrateCoreInstruction(new PublicKey(target.address))),
  }));
  const coreBatches = await concurrentMap(
    Array.from({ length: Math.ceil(coreSample.length / 16) }, (_, index) => coreSample.slice(index * 16, index * 16 + 16)),
    3,
    async (batch) => ({
      addresses: batch.map((target) => target.address),
      ...await simulateInstruction(batch.map((target) => migrateCoreInstruction(new PublicKey(target.address)))),
    }),
  );
  const receipts = await concurrentMap(receiptSample, 1, async (target) => ({
    address: target.address,
    ...await simulateInstruction(await migrateReceiptInstruction(target)),
  }));
  const unauthorized = testUnauthorized && coreTargets.length
    ? await simulateInstruction(
      migrateCoreInstruction(new PublicKey(coreTargets[0].address), new PublicKey(config.treasury)),
      new PublicKey(config.treasury),
    )
    : null;
  if (unauthorized && (!unauthorized.err
    || !unauthorized.logs?.some((line: string) => line.includes('ConstraintHasOne')))) {
    throw new Error('Unauthorized migration simulation did not fail with ConstraintHasOne');
  }
  const failures = [collection, ...core, ...coreBatches, ...receipts].filter((result) => result?.err);
  simulations = {
    limit: Number.isFinite(simulationLimit) ? simulationLimit : null,
    collection,
    core,
    coreBatches,
    receipts,
    unauthorized,
    failures: failures.length,
  };
  if (failures.length) process.exitCode = 2;
}

const plan = {
  schemaVersion: 1,
  createdAt: new Date().toISOString(),
  mode: simulate ? 'simulate' : 'plan',
  rollback,
  genesisHash,
  rpcHost: new URL(rpcUrl).host,
  simulationRpcHost: simulate ? new URL(simulationRpcUrl).host : null,
  sourceBase,
  targetBase,
  program: {
    address: PROGRAM_ID.toBase58(),
    programDataAddress: programDataAddress.toBase58(),
    deploymentSlot: Number(programData.readBigUInt64LE(4)),
    elfBytes: programData.length - 45,
    elfSha256: createHash('sha256').update(programData.subarray(45)).digest('hex'),
  },
  config: {
    address: CONFIG_PDA.toBase58(),
    bytes: configData.length,
    sha256: createHash('sha256').update(configData).digest('hex'),
    decoded: config,
  },
  collection: {
    address: COLLECTION.toBase58(),
    sourceUri: collectionSourceUri,
    targetUri: collectionTargetUri,
    status: collectionUri === collectionTargetUri ? 'target' : 'source',
  },
  observedSnapshot,
  alreadyTarget,
  immutableHistoricalRecords: burnedCoreRecords,
  transactionsRequired: Number(collectionUri === collectionSourceUri)
    + coreTargets.length + receiptTargets.length,
  coreTargets,
  receiptTargets,
  simulations,
};

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(plan, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({
  outputPath,
  mode: plan.mode,
  rollback,
  sourceBase,
  targetBase,
  program: plan.program,
  observedSnapshot,
  alreadyTarget,
  immutableHistoricalRecords: burnedCoreRecords,
  transactionsRequired: plan.transactionsRequired,
  simulations: simulations && {
    collection: Boolean(simulations.collection),
    core: simulations.core.length,
    receipts: simulations.receipts.length,
    failures: simulations.failures,
  },
}, null, 2)}\n`);
