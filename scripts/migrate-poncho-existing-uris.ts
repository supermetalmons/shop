import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import bs58 from 'bs58';
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionExpiredBlockheightExceededError,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import { parsePrivateKeyInput, promptMaskedInput, promptYConfirmation } from './shared/interactive.ts';

const GENESIS_HASH = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
const PROGRAM_ID = new PublicKey('C96UF1dNPzAiRoWPDyU1BRVez5Rfqf2WeFy6gipkBS5A');
const CONFIG_PDA = new PublicKey('2bYowarQZyoBjHmu1fzHDnWUfQRctLL4YHr7yhYjnVQq');
const ADMIN = new PublicKey('kPG2L5zuxqNkvWvJNptbkqnPhk4nGjnGp7jwDFZPQgx');
const COLLECTION = new PublicKey('JCTP3kK3xGtWs5mDHxJBuRro38HftaiCDdKsfkXuK2gH');
const RECEIPTS_TREE = new PublicKey('5wCjVex6yXCms518RccxmAaVMGoPvTEQcb4UR3MYtQow');
const RECEIPTS_TREE_CONFIG = new PublicKey('3ZDjwqjnahBUPhprv8WXt2jAyJahQo2TEEfPAwTnTRNp');
const MPL_CORE = new PublicKey('CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d');
const SPL_NOOP = new PublicKey('noopb9bkMVfRPU8AsbpTUg8AQkHtKwMYZiFUjNRtMmV');
const MPL_NOOP = new PublicKey('mnoopTCrg4p8ry25e4bcWA9XZjbNjMTfgYVGGEdRsf3');
const ACCOUNT_COMPRESSION = new PublicKey('mcmt6YrQEMKw8Mw43FmpRLmf7BqRnFMKmAcbxE3xkAW');
const BUBBLEGUM = new PublicKey('BGUMAp9Gq7iTEuizy4pqaxsTyUCBK68MDfK752saRPUY');
const LOADER = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');
const OLD_BASE = 'https://assets.mons.link/drops/poncho';
const NEW_BASE = 'https://cdn.lil.org/nft/poncho_drifella';
const RELEASE_SOURCE_COMMIT = 'e16a8e63cdb97fc0a663e181b1e81cf86f3fd53f';
const RELEASE_IMAGE = 'solanafoundation/solana-verifiable-build@sha256:695f890e620db8c39afe5112e048599f8ee395a0cab5a2e572f30a72c6366cb4';
const CONFIG_DISCRIMINATOR = Buffer.from([62, 29, 116, 188, 219, 247, 48, 227]);
const MIGRATE_COLLECTION_URI = Buffer.from([191, 243, 226, 185, 115, 83, 70, 48]);
const MIGRATE_CORE_ASSET_URI = Buffer.from([50, 156, 65, 239, 42, 228, 129, 192]);
const MIGRATE_RECEIPT_URI = Buffer.from([6, 57, 254, 113, 22, 138, 253, 162]);
const CORE_BATCH_SIZE = 16;
const CORE_FETCH_SIZE = 100;

type Target = {
  address: string;
  kind: 'box' | 'figure';
  referenceId: number;
  sourceUri: string;
  targetUri: string;
};

type ReceiptTarget = Target & { owner: string; leafId: number };

type Checkpoint = {
  schemaVersion: 2;
  planSha256: string;
  targetBase: string;
  completedCollection: boolean;
  completedCore: string[];
  completedReceipts: string[];
  skippedBurnedCore: string[];
  skippedBurnedReceipts: string[];
  transactions: Array<{ signature: string; kind: string; targets: string[] }>;
  pending: null | { signature: string; kind: string; targets: string[] };
};

function option(name: string) {
  const index = process.argv.indexOf(name);
  if (index < 0) return null;
  const value = process.argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
  return value;
}

const argv = process.argv.slice(2);
if (argv.some((arg) => /keypair|private|secret|signer/i.test(arg))) {
  throw new Error('Signing material cannot be provided as a command-line argument');
}
const send = argv.includes('--send');
const rollback = argv.includes('--rollback');
const planPath = resolve(option('--plan') || '.cache/poncho-existing-uri-migration/plan.json');
const statePath = resolve(option('--state') || '.cache/poncho-existing-uri-migration/state.json');
const heliusApiKey = process.env.HELIUS_API_KEY;
if (!heliusApiKey) throw new Error('HELIUS_API_KEY is required');
const rpcUrl = process.env.HELIUS_RPC_URL
  || `https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(heliusApiKey)}`;
const connection = new Connection(rpcUrl, 'confirmed');
const sourceBase = rollback ? NEW_BASE : OLD_BASE;
const targetBase = rollback ? OLD_BASE : NEW_BASE;
let rpcId = 0;

async function rpc<T>(method: string, params: unknown = []): Promise<T> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const response = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
    });
    if (response.ok) {
      const payload = await response.json() as { result?: T; error?: { code?: number; message?: string } };
      if (!payload.error) return payload.result as T;
      if (payload.error.code !== 429 && payload.error.code !== -32005) {
        throw new Error(`${method}: ${payload.error.message || JSON.stringify(payload.error)}`);
      }
    } else if (response.status !== 429 && response.status < 500) {
      throw new Error(`${method}: HTTP ${response.status}`);
    }
    if (attempt === 7) throw new Error(`${method}: RPC retry limit exceeded`);
    const delay = Math.min(5_000, 250 * 2 ** attempt) + Math.floor(Math.random() * 150);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, delay));
  }
  throw new Error(`${method}: unreachable retry state`);
}

function readString(data: Buffer, offset: number) {
  const length = data.readUInt32LE(offset);
  const start = offset + 4;
  const end = start + length;
  if (end > data.length) throw new Error('String exceeds account data');
  return { value: data.subarray(start, end).toString('utf8'), offset: end };
}

function decodeConfig(data: Buffer) {
  if (data.length !== 307 || !data.subarray(0, 8).equals(CONFIG_DISCRIMINATOR)) {
    throw new Error('Config layout mismatch');
  }
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
  offset += 4;
  const maxPerTx = data[offset];
  offset += 1;
  const itemsPerBox = data[offset];
  offset += 1;
  const minted = data.readUInt32LE(offset);
  offset += 4;
  const name = readString(data, offset);
  offset = name.offset;
  const symbol = readString(data, offset);
  offset = symbol.offset;
  const uri = readString(data, offset);
  offset = uri.offset;
  const started = data[offset] === 1;
  const bump = data[offset + 1];
  const discountMintsPerWallet = data[offset + 2];
  offset += 3;
  const figureName = readString(data, offset);
  const maxFigureId = maxSupply * itemsPerBox;
  if (!Number.isSafeInteger(maxFigureId) || maxFigureId < 1 || maxFigureId > 0xffff) {
    throw new Error(`Invalid maximum figure ID ${maxFigureId}`);
  }
  return {
    admin,
    treasury,
    coreCollection,
    maxSupply,
    maxPerTx,
    itemsPerBox,
    minted,
    namePrefix: name.value,
    symbol: symbol.value,
    uriBase: uri.value,
    started,
    bump,
    discountMintsPerWallet,
    figureNamePrefix: figureName.value,
    maxFigureId,
  };
}

function parseCoreUri(data: Buffer) {
  if (data[0] !== 1) throw new Error('MPL Core asset discriminator mismatch');
  let offset = 1 + 32;
  const authorityKind = data[offset];
  offset += 1;
  if (authorityKind !== 2) throw new Error('MPL Core asset is not collection-controlled');
  const authority = new PublicKey(data.subarray(offset, offset + 32));
  offset += 32;
  if (!authority.equals(COLLECTION)) throw new Error('MPL Core collection authority mismatch');
  offset = readString(data, offset).offset;
  return readString(data, offset).value;
}

function parseCollectionUri(data: Buffer) {
  if (data[0] !== 5) throw new Error('MPL Core collection discriminator mismatch');
  const authority = new PublicKey(data.subarray(1, 33));
  if (!authority.equals(CONFIG_PDA)) throw new Error('Collection update authority mismatch');
  let offset = readString(data, 33).offset;
  return readString(data, offset).value;
}

function collectionInstruction() {
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

function coreInstruction(address: string) {
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: CONFIG_PDA, isSigner: false, isWritable: false },
      { pubkey: ADMIN, isSigner: true, isWritable: true },
      { pubkey: new PublicKey(address), isSigner: false, isWritable: true },
      { pubkey: COLLECTION, isSigner: false, isWritable: false },
      { pubkey: MPL_CORE, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: SPL_NOOP, isSigner: false, isWritable: false },
    ],
    data: MIGRATE_CORE_ASSET_URI,
  });
}

function numberBuffer(bytes: number, value: number) {
  const data = Buffer.alloc(bytes);
  if (bytes === 8) data.writeBigUInt64LE(BigInt(value));
  else if (bytes === 4) data.writeUInt32LE(value);
  else data.writeUInt16LE(value);
  return data;
}

function inCollection(asset: any) {
  return Array.isArray(asset.grouping) && asset.grouping.some(
    (group: any) => group?.group_key === 'collection' && group?.group_value === COLLECTION.toBase58(),
  );
}

function fullAuthority(asset: any, address: PublicKey) {
  return Array.isArray(asset.authorities) && asset.authorities.some(
    (authority: any) => authority?.address === address.toBase58()
      && Array.isArray(authority.scopes)
      && authority.scopes.includes('full'),
  );
}

function referenceAt(uri: string, base: string, path: string, maximum: number) {
  const prefix = `${base}${path}`;
  if (!uri.startsWith(prefix) || !uri.endsWith('.json')) return null;
  const stem = uri.slice(prefix.length, -5);
  if (!/^[1-9]\d*$/.test(stem)) return null;
  const value = Number(stem);
  return Number.isSafeInteger(value) && value <= maximum ? value : null;
}

function classifyLiveUri(uri: string, config: ReturnType<typeof decodeConfig>, receipt: boolean) {
  const paths = receipt
    ? [['/json/receipts/boxes/', 'box', config.maxSupply], ['/json/receipts/figures/', 'figure', config.maxFigureId]] as const
    : [['/json/boxes/', 'box', config.maxSupply], ['/json/figures/', 'figure', config.maxFigureId]] as const;
  for (const [path, kind, maximum] of paths) {
    const source = referenceAt(uri, sourceBase, path, maximum);
    if (source !== null) return { status: 'source' as const, kind, referenceId: source };
    const target = referenceAt(uri, targetBase, path, maximum);
    if (target !== null) return { status: 'target' as const, kind, referenceId: target };
  }
  return null;
}

async function assertNoUnexpectedLiveLegacyTargets(
  config: ReturnType<typeof decodeConfig>,
  plannedCore: Set<string>,
  plannedReceipts: Set<string>,
) {
  const liveSourceCore = new Set<string>();
  const liveSourceReceipts = new Set<string>();
  let total = 0;
  for (let page = 1; ; page += 1) {
    const result = await rpc<any>('searchAssets', {
      grouping: ['collection', COLLECTION.toBase58()],
      page,
      limit: 1000,
      options: { showUnverifiedCollections: true, showCollectionMetadata: true },
    });
    total += result.items.length;
    for (const asset of result.items) {
      if (!asset.id || !inCollection(asset)) throw new Error(`Invalid collection grouping for ${asset.id || 'unknown'}`);
      const receipt = asset.interface === 'MplBubblegumV2';
      if (asset.interface !== 'MplCoreAsset' && !receipt) {
        throw new Error(`Unexpected live collection interface ${asset.id}: ${asset.interface}`);
      }
      const classification = classifyLiveUri(String(asset.content?.json_uri || ''), config, receipt);
      if (!classification) throw new Error(`Unexpected live metadata URI ${asset.id}`);
      if (asset.burnt) continue;
      if (receipt) {
        if (!asset.mutable || asset.compression?.tree !== RECEIPTS_TREE.toBase58()) {
          throw new Error(`Live receipt authority or tree mismatch: ${asset.id}`);
        }
        if (classification.status === 'source') liveSourceReceipts.add(asset.id);
      } else {
        if (!asset.mutable || !fullAuthority(asset, CONFIG_PDA)) {
          throw new Error(`Live Core authority mismatch: ${asset.id}`);
        }
        if (classification.status === 'source') liveSourceCore.add(asset.id);
      }
    }
    if (total >= result.total || result.items.length === 0) break;
  }
  const unexpectedCore = [...liveSourceCore].filter((address) => !plannedCore.has(address));
  const unexpectedReceipts = [...liveSourceReceipts].filter((address) => !plannedReceipts.has(address));
  if (unexpectedCore.length || unexpectedReceipts.length) {
    throw new Error(`Unexpected new legacy targets after planning: ${JSON.stringify({
      core: unexpectedCore,
      receipts: unexpectedReceipts,
    })}`);
  }
  return { liveSourceCore, liveSourceReceipts };
}

async function receiptInstruction(
  target: ReceiptTarget,
  config: ReturnType<typeof decodeConfig>,
): Promise<TransactionInstruction | 'target' | 'burned'> {
  const [asset, proof] = await Promise.all([
    rpc<any>('getAsset', { id: target.address }),
    rpc<any>('getAssetProof', { id: target.address }),
  ]);
  const uri = String(asset.content?.json_uri || '');
  if (asset.interface !== 'MplBubblegumV2' || !inCollection(asset)) {
    throw new Error(`Receipt collection or interface mismatch: ${target.address}`);
  }
  if (asset.burnt) {
    if (uri !== target.sourceUri && uri !== target.targetUri) {
      throw new Error(`Burned receipt URI mismatch ${target.address}: ${uri}`);
    }
    return 'burned';
  }
  if (uri === target.targetUri) return 'target';
  if (uri !== target.sourceUri) throw new Error(`Unexpected receipt URI ${target.address}: ${uri}`);
  const label = target.kind === 'box' ? config.namePrefix : config.figureNamePrefix;
  const expectedName = `receipt · ${label}${label.endsWith(' ') ? '' : ' '}${target.referenceId}`;
  if (!asset.mutable
    || asset.content?.metadata?.name !== expectedName
    || asset.content?.metadata?.symbol !== ''
    || asset.royalty?.basis_points !== 0
    || asset.royalty?.primary_sale_happened !== false
    || asset.compression?.tree !== RECEIPTS_TREE.toBase58()
    || asset.compression?.flags !== 0
    || asset.compression?.leaf_id !== target.leafId
    || proof.tree_id !== RECEIPTS_TREE.toBase58()
    || !Array.isArray(proof.proof) || proof.proof.length !== 14) {
    throw new Error(`Receipt metadata or proof mismatch: ${target.address}`);
  }
  const owner = String(asset.ownership?.owner || '');
  const delegate = asset.ownership?.delegated ? String(asset.ownership?.delegate || '') : owner;
  if (!owner || !delegate) throw new Error(`Receipt ownership is unavailable: ${target.address}`);
  const root = Buffer.from(bs58.decode(proof.root));
  const assetDataHash = Buffer.from(bs58.decode(asset.compression.asset_data_hash));
  if (root.length !== 32 || assetDataHash.length !== 32) throw new Error('Receipt hash length mismatch');
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
      ...proof.proof.map((address: string) => ({
        pubkey: new PublicKey(address), isSigner: false, isWritable: false,
      })),
    ],
    data: Buffer.concat([
      MIGRATE_RECEIPT_URI,
      root,
      assetDataHash,
      Buffer.from([asset.compression.flags]),
      numberBuffer(8, target.leafId),
      numberBuffer(4, target.leafId),
      Buffer.from([target.kind === 'box' ? 0 : 1]),
      numberBuffer(2, target.referenceId),
    ]),
  });
}

async function saveCheckpoint(checkpoint: Checkpoint) {
  await mkdir(dirname(statePath), { recursive: true });
  const temporaryPath = `${statePath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(checkpoint, null, 2)}\n`, { mode: 0o600 });
  await rename(temporaryPath, statePath);
}

async function loadCheckpoint(planSha256: string): Promise<Checkpoint> {
  try {
    const checkpoint = JSON.parse(await readFile(statePath, 'utf8')) as Checkpoint;
    if (checkpoint.schemaVersion !== 2 || checkpoint.planSha256 !== planSha256
      || checkpoint.targetBase !== targetBase) {
      throw new Error('Migration checkpoint does not match this plan and direction');
    }
    return checkpoint;
  } catch (error: any) {
    if (error?.code !== 'ENOENT') throw error;
    return {
      schemaVersion: 2,
      planSha256,
      targetBase,
      completedCollection: false,
      completedCore: [],
      completedReceipts: [],
      skippedBurnedCore: [],
      skippedBurnedReceipts: [],
      transactions: [],
      pending: null,
    };
  }
}

function markCompleted(checkpoint: Checkpoint, kind: string, targets: string[]) {
  if (kind === 'collection') checkpoint.completedCollection = true;
  if (kind === 'core') checkpoint.completedCore.push(...targets);
  if (kind === 'receipt') checkpoint.completedReceipts.push(...targets);
}

async function recoverPending(checkpoint: Checkpoint) {
  if (!checkpoint.pending) return;
  const pending = checkpoint.pending;
  const status = (await connection.getSignatureStatuses([pending.signature], { searchTransactionHistory: true })).value[0];
  if (status?.err) throw new Error(`Pending transaction failed: ${pending.signature}`);
  if (status?.confirmationStatus === 'confirmed' || status?.confirmationStatus === 'finalized') {
    markCompleted(checkpoint, pending.kind, pending.targets);
    checkpoint.transactions.push(pending);
  }
  checkpoint.pending = null;
  await saveCheckpoint(checkpoint);
}

async function sendInstructions(
  signer: Keypair,
  checkpoint: Checkpoint,
  kind: string,
  targets: string[],
  instructions: TransactionInstruction[],
) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const latest = await connection.getLatestBlockhash('confirmed');
    const transaction = new VersionedTransaction(new TransactionMessage({
      payerKey: ADMIN,
      recentBlockhash: latest.blockhash,
      instructions,
    }).compileToV0Message());
    transaction.sign([signer]);
    const simulation = await connection.simulateTransaction(transaction, {
      commitment: 'confirmed',
      sigVerify: true,
    });
    if (simulation.value.err) {
      throw new Error(`Simulation failed for ${kind}: ${JSON.stringify({
        err: simulation.value.err,
        logs: simulation.value.logs,
      })}`);
    }
    const signature = bs58.encode(transaction.signatures[0]);
    checkpoint.pending = { signature, kind, targets };
    await saveCheckpoint(checkpoint);
    try {
      const submitted = await connection.sendRawTransaction(transaction.serialize(), {
        skipPreflight: false,
        maxRetries: 5,
        preflightCommitment: 'confirmed',
      });
      if (submitted !== signature) throw new Error('RPC returned a different transaction signature');
      const confirmation = await connection.confirmTransaction({ signature, ...latest }, 'confirmed');
      if (confirmation.value.err) throw new Error(`Transaction failed: ${signature}`);
    } catch (error) {
      if (!(error instanceof TransactionExpiredBlockheightExceededError)) throw error;
      const status = (await connection.getSignatureStatuses(
        [signature],
        { searchTransactionHistory: true },
      )).value[0];
      if (status?.err) throw new Error(`Transaction failed: ${signature}`);
      if (status?.confirmationStatus !== 'confirmed' && status?.confirmationStatus !== 'finalized') {
        checkpoint.pending = null;
        await saveCheckpoint(checkpoint);
        console.log(`Blockhash expired for ${kind}; retrying with a fresh signature (${attempt + 1}/10).`);
        continue;
      }
    }
    markCompleted(checkpoint, kind, targets);
    checkpoint.transactions.push({ signature, kind, targets });
    checkpoint.pending = null;
    await saveCheckpoint(checkpoint);
    return { signature, unitsConsumed: simulation.value.unitsConsumed };
  }
  throw new Error(`Blockhash expired repeatedly for ${kind}`);
}

async function waitForReceiptIndex(target: ReceiptTarget) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const asset = await rpc<any>('getAsset', { id: target.address });
    if (asset.content?.json_uri === target.targetUri) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 2_000));
  }
  throw new Error(`DAS did not index migrated receipt within two minutes: ${target.address}`);
}

const planBytes = await readFile(planPath);
const planSha256 = createHash('sha256').update(planBytes).digest('hex');
const plan = JSON.parse(planBytes.toString('utf8')) as {
  rollback: boolean;
  genesisHash: string;
  sourceBase: string;
  targetBase: string;
  observedSnapshot: Record<string, number>;
  planScope: {
    rollback: boolean;
    sourceBase: string;
    targetBase: string;
    collection: string | null;
    coreTargets: string[];
    receiptTargets: string[];
  };
  planChecksum: string;
  coreBatches: string[][];
  transactionsRequired: number;
  config: { sha256: string };
  coreTargets: Target[];
  receiptTargets: ReceiptTarget[];
};
const computedPlanChecksum = createHash('sha256')
  .update(JSON.stringify(plan.planScope))
  .digest('hex');
const plannedCoreAddresses = plan.coreTargets.map((target) => target.address);
const plannedReceiptAddresses = plan.receiptTargets.map((target) => target.address);
const flattenedCoreBatches = plan.coreBatches.flat();
if (plan.genesisHash !== GENESIS_HASH
  || plan.rollback !== rollback
  || plan.sourceBase !== sourceBase
  || plan.targetBase !== targetBase
  || plan.planScope.rollback !== rollback
  || plan.planScope.sourceBase !== sourceBase
  || plan.planScope.targetBase !== targetBase
  || plan.planChecksum !== computedPlanChecksum
  || JSON.stringify(plan.planScope.coreTargets) !== JSON.stringify(plannedCoreAddresses)
  || JSON.stringify(plan.planScope.receiptTargets) !== JSON.stringify(plannedReceiptAddresses)
  || JSON.stringify(flattenedCoreBatches) !== JSON.stringify(plannedCoreAddresses)
  || plan.coreBatches.some((batch) => batch.length < 1 || batch.length > CORE_BATCH_SIZE)
  || new Set([...plannedCoreAddresses, ...plannedReceiptAddresses]).size
    !== plannedCoreAddresses.length + plannedReceiptAddresses.length
  || plan.transactionsRequired !== Number(Boolean(plan.planScope.collection))
    + plan.coreBatches.length + plan.receiptTargets.length) {
  throw new Error('Migration plan scope, checksum, batches, or transaction count mismatch');
}
const manifest = JSON.parse(await readFile(
  new URL('../onchain/releases/poncho-drifella-existing-uri-migration.json', import.meta.url),
  'utf8',
));
const expectedElfSha256 = String(manifest.release?.elfSha256 || '');
const expectedElfBytes = Number(manifest.release?.elfBytes || 0);
if (manifest.genesisHash !== GENESIS_HASH
  || manifest.programId !== PROGRAM_ID.toBase58()
  || manifest.configPda !== CONFIG_PDA.toBase58()
  || manifest.admin !== ADMIN.toBase58()
  || manifest.coreCollection !== COLLECTION.toBase58()
  || manifest.receiptsTree !== RECEIPTS_TREE.toBase58()
  || manifest.receiptsTreeConfig !== RECEIPTS_TREE_CONFIG.toBase58()
  || manifest.legacyUriBase !== OLD_BASE
  || manifest.canonicalUriBase !== NEW_BASE
  || manifest.release?.sourceCommit !== RELEASE_SOURCE_COMMIT
  || manifest.release?.baseImage !== RELEASE_IMAGE
  || manifest.release?.identicalIndependentBuilds !== true
  || !expectedElfSha256
  || !expectedElfBytes) {
  throw new Error('Migration manifest scope mismatch');
}

const genesisHash = await connection.getGenesisHash();
if (genesisHash !== GENESIS_HASH) throw new Error(`Refusing non-mainnet genesis hash ${genesisHash}`);
const [programAccount, configAccount, collectionAccount] = await connection.getMultipleAccountsInfo(
  [PROGRAM_ID, CONFIG_PDA, COLLECTION],
  'finalized',
);
if (!programAccount?.executable || !programAccount.owner.equals(LOADER)
  || !configAccount?.owner.equals(PROGRAM_ID) || !collectionAccount?.owner.equals(MPL_CORE)) {
  throw new Error('Program, config, or collection account ownership mismatch');
}
const programDataAddress = new PublicKey(programAccount.data.subarray(4, 36));
const programData = await connection.getAccountInfo(programDataAddress, 'finalized');
if (!programData || !programData.owner.equals(LOADER)) throw new Error('ProgramData account mismatch');
if (programData.data[12] !== 1
  || !new PublicKey(programData.data.subarray(13, 45)).equals(ADMIN)) {
  throw new Error('Program upgrade authority mismatch');
}
const elf = Buffer.from(programData.data.subarray(45));
const elfSha256 = createHash('sha256').update(elf).digest('hex');
const config = decodeConfig(Buffer.from(configAccount.data));
const configSha256 = createHash('sha256').update(configAccount.data).digest('hex');
if (config.admin !== ADMIN.toBase58() || config.coreCollection !== COLLECTION.toBase58()
  || config.uriBase !== targetBase) {
  throw new Error('Config scope or target URI mismatch');
}
if (configSha256 !== plan.config.sha256) {
  throw new Error('Config changed after the finalized migration plan was created');
}
for (const [targets, receipt] of [[plan.coreTargets, false], [plan.receiptTargets, true]] as const) {
  for (const target of targets) {
  const maximum = target.kind === 'box' ? config.maxSupply : config.maxFigureId;
  const path = target.kind === 'box'
    ? (receipt ? '/json/receipts/boxes/' : '/json/boxes/')
    : (receipt ? '/json/receipts/figures/' : '/json/figures/');
  if (!Number.isInteger(target.referenceId) || target.referenceId < 1 || target.referenceId > maximum
    || target.sourceUri !== `${sourceBase}${path}${target.referenceId}.json`
    || target.targetUri !== `${targetBase}${path}${target.referenceId}.json`) {
    throw new Error(`Invalid migration target metadata: ${target.address}`);
  }
  new PublicKey(target.address);
  }
}
const collectionUriBefore = parseCollectionUri(Buffer.from(collectionAccount.data));
if (collectionUriBefore === `${sourceBase}/collection.json`) {
  if (plan.planScope.collection !== COLLECTION.toBase58()) {
    throw new Error('Collection became a new legacy target after planning');
  }
} else if (collectionUriBefore !== `${targetBase}/collection.json`) {
  throw new Error(`Unexpected collection URI ${collectionUriBefore}`);
}
await assertNoUnexpectedLiveLegacyTargets(
  config,
  new Set(plannedCoreAddresses),
  new Set(plannedReceiptAddresses),
);

const summary = {
  mode: send ? 'send' : 'preflight',
  direction: `${sourceBase} -> ${targetBase}`,
  rpcHost: new URL(rpcUrl).host,
  program: PROGRAM_ID.toBase58(),
  programData: programDataAddress.toBase58(),
  deploymentSlot: Number(programData.data.readBigUInt64LE(4)),
  elfBytes: elf.length,
  elfSha256,
  expectedElfBytes: expectedElfBytes || null,
  expectedElfSha256: expectedElfSha256 || null,
  plan: planPath,
  planSha256,
  planChecksum: plan.planChecksum,
  targets: {
    collection: Number(Boolean(plan.planScope.collection)),
    core: plan.coreTargets.length,
    receipts: plan.receiptTargets.length,
    burnedHistoricalRecordsExcluded: {
      core: plan.observedSnapshot.burnedCoreRecords,
      compressed: plan.observedSnapshot.burnedCompressedRecords,
    },
  },
  maximumTransactions: plan.transactionsRequired,
};
process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
if (!send) {
  console.log('Preflight only. No private key was requested and no transaction was sent.');
  process.exit(0);
}
if (elfSha256 !== expectedElfSha256 || elf.length !== expectedElfBytes) {
  throw new Error('Deployed ELF does not match the approved migration release');
}

console.log('Enter the config admin private key (input is hidden).');
console.log('Accepted formats: base58 secret key or a JSON byte array.');
const signer = parsePrivateKeyInput(await promptMaskedInput('config admin private key: '));
if (!signer.publicKey.equals(ADMIN)) throw new Error(`Private key address is ${signer.publicKey}, expected ${ADMIN}`);
console.log(`Private key address verified: ${signer.publicKey.toBase58()}`);
if (!await promptYConfirmation('Send the approved MAINNET existing-URI migration? [y/N] ')) {
  console.log('Cancelled.');
  process.exit(0);
}

const checkpoint = await loadCheckpoint(planSha256);
await recoverPending(checkpoint);
const completedCore = new Set([...checkpoint.completedCore, ...checkpoint.skippedBurnedCore]);
const completedReceipts = new Set([...checkpoint.completedReceipts, ...checkpoint.skippedBurnedReceipts]);

if (collectionUriBefore === `${targetBase}/collection.json`) checkpoint.completedCollection = true;
if (!checkpoint.completedCollection) {
  const result = await sendInstructions(signer, checkpoint, 'collection', [COLLECTION.toBase58()], [collectionInstruction()]);
  console.log(`Collection migrated: ${result.signature}`);
}

const pendingCoreTargets: Target[] = [];
for (let offset = 0; offset < plan.coreTargets.length; offset += CORE_FETCH_SIZE) {
  const targets = plan.coreTargets.slice(offset, offset + CORE_FETCH_SIZE)
    .filter((target) => !completedCore.has(target.address));
  if (!targets.length) continue;
  const accounts = await connection.getMultipleAccountsInfo(targets.map((target) => new PublicKey(target.address)), 'confirmed');
  for (let index = 0; index < targets.length; index += 1) {
    const target = targets[index];
    const account = accounts[index];
    if (!account) {
      const asset = await rpc<any>('getAsset', { id: target.address });
      const uri = String(asset.content?.json_uri || '');
      if (asset.interface !== 'MplCoreAsset' || !asset.burnt || !inCollection(asset)
        || (uri !== target.sourceUri && uri !== target.targetUri)) {
        throw new Error(`Missing Core account is not a proven burn: ${target.address}`);
      }
      checkpoint.skippedBurnedCore.push(target.address);
      completedCore.add(target.address);
      continue;
    }
    if (!account.owner.equals(MPL_CORE)) throw new Error(`Invalid Core account ${target.address}`);
    const uri = parseCoreUri(Buffer.from(account.data));
    if (uri === target.targetUri) {
      completedCore.add(target.address);
      checkpoint.completedCore.push(target.address);
    } else if (uri === target.sourceUri) pendingCoreTargets.push(target);
    else throw new Error(`Unexpected Core URI ${target.address}: ${uri}`);
  }
  await saveCheckpoint(checkpoint);
}
for (let index = 0; index < pendingCoreTargets.length; index += CORE_BATCH_SIZE) {
  const batch = pendingCoreTargets.slice(index, index + CORE_BATCH_SIZE);
  const result = await sendInstructions(
    signer,
    checkpoint,
    'core',
    batch.map((target) => target.address),
    batch.map((target) => coreInstruction(target.address)),
  );
  batch.forEach((target) => completedCore.add(target.address));
  console.log(`Core ${completedCore.size}/${plan.coreTargets.length}: ${result.signature}`);
}

for (const target of plan.receiptTargets) {
  if (completedReceipts.has(target.address)) continue;
  const instruction = await receiptInstruction(target, config);
  if (instruction === 'target') {
    completedReceipts.add(target.address);
    checkpoint.completedReceipts.push(target.address);
    await saveCheckpoint(checkpoint);
    continue;
  }
  if (instruction === 'burned') {
    completedReceipts.add(target.address);
    checkpoint.skippedBurnedReceipts.push(target.address);
    await saveCheckpoint(checkpoint);
    continue;
  }
  const result = await sendInstructions(signer, checkpoint, 'receipt', [target.address], [instruction]);
  await waitForReceiptIndex(target);
  completedReceipts.add(target.address);
  console.log(`Receipt ${completedReceipts.size}/${plan.receiptTargets.length}: ${result.signature}`);
}

const collectionAfter = await connection.getAccountInfo(COLLECTION, 'finalized');
if (!collectionAfter || parseCollectionUri(Buffer.from(collectionAfter.data)) !== `${targetBase}/collection.json`) {
  throw new Error('Final collection URI verification failed');
}
for (;;) {
  let pendingFinalization = 0;
  for (let offset = 0; offset < checkpoint.transactions.length; offset += 256) {
    const signatures = checkpoint.transactions.slice(offset, offset + 256).map((entry) => entry.signature);
    const statuses = await connection.getSignatureStatuses(signatures, { searchTransactionHistory: true });
    statuses.value.forEach((status, index) => {
      if (status?.err) throw new Error(`Final transaction failure: ${signatures[index]}`);
      if (status?.confirmationStatus !== 'finalized') pendingFinalization += 1;
    });
  }
  if (!pendingFinalization) break;
  console.log(`Waiting for finalized commitment on ${pendingFinalization} transactions...`);
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 2_000));
}

for (let offset = 0; offset < plan.coreTargets.length; offset += CORE_FETCH_SIZE) {
  const targets = plan.coreTargets.slice(offset, offset + CORE_FETCH_SIZE)
    .filter((target) => !checkpoint.skippedBurnedCore.includes(target.address));
  if (!targets.length) continue;
  const accounts = await connection.getMultipleAccountsInfo(
    targets.map((target) => new PublicKey(target.address)),
    'finalized',
  );
  targets.forEach((target, index) => {
    const account = accounts[index];
    if (!account?.owner.equals(MPL_CORE) || parseCoreUri(Buffer.from(account.data)) !== target.targetUri) {
      throw new Error(`Final Core URI verification failed: ${target.address}`);
    }
  });
}
for (let offset = 0; offset < plan.receiptTargets.length; offset += 100) {
  const targets = plan.receiptTargets.slice(offset, offset + 100)
    .filter((target) => !checkpoint.skippedBurnedReceipts.includes(target.address));
  if (!targets.length) continue;
  const assets = await rpc<any[]>('getAssetBatch', { ids: targets.map((target) => target.address) });
  targets.forEach((target, index) => {
    if (assets[index]?.id !== target.address || assets[index]?.content?.json_uri !== target.targetUri) {
      throw new Error(`Final receipt URI verification failed: ${target.address}`);
    }
  });
}
const configAfter = await connection.getAccountInfo(CONFIG_PDA, 'finalized');
if (!configAfter || createHash('sha256').update(configAfter.data).digest('hex') !== configSha256) {
  throw new Error('Config changed during asset migration');
}
const remainingLegacy = await assertNoUnexpectedLiveLegacyTargets(
  config,
  new Set(plannedCoreAddresses),
  new Set(plannedReceiptAddresses),
);
if (remainingLegacy.liveSourceCore.size || remainingLegacy.liveSourceReceipts.size) {
  throw new Error(`Legacy live URIs remain after migration: ${JSON.stringify({
    core: [...remainingLegacy.liveSourceCore],
    receipts: [...remainingLegacy.liveSourceReceipts],
  })}`);
}
const programDataAfter = await connection.getAccountInfo(programDataAddress, 'finalized');
if (!programDataAfter || programDataAfter.data[12] !== 1
  || !new PublicKey(programDataAfter.data.subarray(13, 45)).equals(ADMIN)
  || createHash('sha256').update(programDataAfter.data.subarray(45)).digest('hex') !== elfSha256) {
  throw new Error('Program executable or upgrade authority changed during migration');
}
const completion = {
  completedAt: new Date().toISOString(),
  targetBase,
  program: PROGRAM_ID.toBase58(),
  elfSha256,
  configSha256,
  collection: COLLECTION.toBase58(),
  coreAssets: plan.coreTargets.length,
  compressedReceipts: plan.receiptTargets.length,
  skippedBurnedAfterPlanning: {
    core: checkpoint.skippedBurnedCore,
    compressed: checkpoint.skippedBurnedReceipts,
  },
  immutableHistoricalRecords: {
    core: plan.observedSnapshot.burnedCoreRecords,
    compressed: plan.observedSnapshot.burnedCompressedRecords,
  },
  transactions: checkpoint.transactions,
};
const completionPath = `${statePath}.complete.json`;
await writeFile(completionPath, `${JSON.stringify(completion, null, 2)}\n`, { mode: 0o600 });
console.log(`Migration verified and checkpointed: ${statePath}`);
console.log(`Completion report: ${completionPath}`);
console.log(`Transactions: ${checkpoint.transactions.length}`);
