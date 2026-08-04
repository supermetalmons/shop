import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  Connection,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import {
  ACCOUNT_COMPRESSION,
  ADMIN,
  BUBBLEGUM,
  COLLECTION,
  CORE_BATCH_SIZE,
  DELIVERY_LOOKUP_TABLE,
  MAINNET_GENESIS,
  MPL_CORE,
  NEW_BASE,
  OLD_BASE,
  PROGRAM_DATA,
  PROGRAM_ID,
  RECEIPTS_TREE,
  RECEIPTS_TREE_CONFIG,
  SHARED_CONFIGS,
  UPGRADEABLE_LOADER,
  accountData,
  assertCardConfig,
  assertReceiptTreeConfig,
  authorityIncludes,
  batches,
  classifyCollectionAsset,
  configuredMainnetRpc,
  decodeConfig,
  expectedName,
  parseRawCollection,
  parseRawCoreAsset,
  planChecksum,
  repositoryRoot,
  rpc,
  sanitizedRpcUrl,
  searchAllCollectionAssets,
  sha256,
  updateCollectionInstruction,
  updateCoreInstruction,
  updateReceiptInstruction,
  type Asset,
  type ReceiptTarget,
} from './shared/cardNft2UriMigration.ts';

type Simulation = {
  label: string;
  err: unknown;
  unitsConsumed: number | undefined;
  logs: string[] | null | undefined;
};

const args = process.argv.slice(2);
if (args.some((arg) => /keypair|private|secret|signer|send|rpc-url/i.test(arg))) {
  throw new Error('The planner is read-only and does not accept signing material or RPC arguments');
}
let rollback = false;
let simulate = false;
let outputPath = path.join(repositoryRoot(), '.cache', 'card-nft-2-uri-migration', 'plan.json');
let simulationLimit = Number.POSITIVE_INFINITY;
for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  if (arg === '--rollback') {
    rollback = true;
  } else if (arg === '--simulate') {
    simulate = true;
  } else if (arg === '--out') {
    outputPath = path.resolve(String(args[++index] || '').trim());
    if (!outputPath) throw new Error('--out requires a path');
  } else if (arg === '--simulation-limit') {
    simulationLimit = Number(args[++index]);
    if (!Number.isInteger(simulationLimit) || simulationLimit < 1) {
      throw new Error('--simulation-limit requires a positive integer');
    }
  } else {
    throw new Error(`Unknown option: ${arg}`);
  }
}

const sourceBase = rollback ? NEW_BASE : OLD_BASE;
const targetBase = rollback ? OLD_BASE : NEW_BASE;
const { rpcUrl, rpcSource } = configuredMainnetRpc();
const connection = new Connection(rpcUrl, 'finalized');
const lookupTable = (await connection.getAddressLookupTable(DELIVERY_LOOKUP_TABLE, {
  commitment: 'finalized',
})).value;
if (!lookupTable) throw new Error(`Missing Card lookup table ${DELIVERY_LOOKUP_TABLE}`);

async function simulateInstructions(label: string, instructions: TransactionInstruction[]): Promise<Simulation> {
  const latest = await connection.getLatestBlockhash('confirmed');
  const transaction = new VersionedTransaction(new TransactionMessage({
    payerKey: ADMIN,
    recentBlockhash: latest.blockhash,
    instructions,
  }).compileToV0Message([lookupTable]));
  const result = await connection.simulateTransaction(transaction, {
    commitment: 'confirmed',
    replaceRecentBlockhash: true,
    sigVerify: false,
  });
  return {
    label,
    err: result.value.err,
    unitsConsumed: result.value.unitsConsumed,
    logs: result.value.logs,
  };
}

async function concurrentMap<T, R>(items: T[], concurrency: number, callback: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await callback(items[index], index);
    }
  }));
  return results;
}

async function rawAccounts(addresses: string[]): Promise<Map<string, { owner: string; data: Buffer }>> {
  const result = new Map<string, { owner: string; data: Buffer }>();
  for (const group of batches(addresses, 100)) {
    const response = await rpc<any>(rpcUrl, 'getMultipleAccounts', [
      group,
      { encoding: 'base64', commitment: 'finalized' },
    ]);
    if (!Array.isArray(response?.value) || response.value.length !== group.length) {
      throw new Error('getMultipleAccounts returned an unexpected result');
    }
    for (let index = 0; index < group.length; index += 1) {
      const account = response.value[index];
      if (!account) throw new Error(`Missing mutable Core account ${group[index]}`);
      result.set(group[index], {
        owner: String(account.owner),
        data: Buffer.from(account.data[0], 'base64'),
      });
    }
  }
  return result;
}

const genesisHash = await rpc<string>(rpcUrl, 'getGenesisHash');
if (genesisHash !== MAINNET_GENESIS) throw new Error(`Unexpected genesis hash ${genesisHash}`);
const accountAddresses = [
  PROGRAM_ID,
  PROGRAM_DATA,
  ...Object.values(SHARED_CONFIGS),
  COLLECTION,
  RECEIPTS_TREE,
  RECEIPTS_TREE_CONFIG,
];
const accountResponses = await Promise.all(accountAddresses.map((address) => rpc<any>(rpcUrl, 'getAccountInfo', [
  address.toBase58(),
  { encoding: 'base64', commitment: 'finalized' },
])));
const accountMap = new Map(accountAddresses.map((address, index) => [address.toBase58(), accountResponses[index]]));
const programAccount = accountMap.get(PROGRAM_ID.toBase58());
const programDataAccount = accountMap.get(PROGRAM_DATA.toBase58());
const programBytes = accountData(programAccount, PROGRAM_ID.toBase58());
const programDataBytes = accountData(programDataAccount, PROGRAM_DATA.toBase58());
if (programAccount.value.owner !== UPGRADEABLE_LOADER.toBase58()
  || !programAccount.value.executable
  || programBytes.readUInt32LE(0) !== 2
  || !programBytes.subarray(4, 36).equals(PROGRAM_DATA.toBuffer())) {
  throw new Error('Shared program state mismatch');
}
if (programDataAccount.value.owner !== UPGRADEABLE_LOADER.toBase58()
  || programDataBytes.readUInt32LE(0) !== 3
  || programDataBytes[12] !== 1
  || !programDataBytes.subarray(13, 45).equals(ADMIN.toBuffer())) {
  throw new Error('ProgramData authority mismatch');
}

const sharedConfigs: Record<string, { address: string; bytes: number; sha256: string; decoded: ReturnType<typeof decodeConfig> }> = {};
for (const [dropId, address] of Object.entries(SHARED_CONFIGS)) {
  const response = accountMap.get(address.toBase58());
  const data = accountData(response, address.toBase58());
  if (response.value.owner !== PROGRAM_ID.toBase58()) throw new Error(`Shared config owner mismatch: ${dropId}`);
  const decoded = decodeConfig(data);
  if (decoded.admin !== ADMIN.toBase58()) throw new Error(`Shared config admin mismatch: ${dropId}`);
  if (dropId === 'card_nft_2') assertCardConfig(decoded);
  sharedConfigs[dropId] = { address: address.toBase58(), bytes: data.length, sha256: sha256(data), decoded };
}
const cardConfig = sharedConfigs.card_nft_2.decoded;
if (cardConfig.uriBase !== sourceBase && cardConfig.uriBase !== targetBase) {
  throw new Error(`Card config URI is outside the approved migration roots: ${cardConfig.uriBase}`);
}

const collectionRawData = accountData(accountMap.get(COLLECTION.toBase58()), COLLECTION.toBase58());
if (accountMap.get(COLLECTION.toBase58()).value.owner !== MPL_CORE.toBase58()) {
  throw new Error('Collection raw account owner mismatch');
}
const treeResponse = accountMap.get(RECEIPTS_TREE.toBase58());
const treeConfigResponse = accountMap.get(RECEIPTS_TREE_CONFIG.toBase58());
if (treeResponse.value.owner !== ACCOUNT_COMPRESSION.toBase58()) throw new Error('Receipt tree owner mismatch');
if (treeConfigResponse.value.owner !== BUBBLEGUM.toBase58()) throw new Error('Receipt TreeConfig owner mismatch');
const treeConfigAuthority = assertReceiptTreeConfig(accountData(treeConfigResponse, RECEIPTS_TREE_CONFIG.toBase58()));
const rawCollection = parseRawCollection(collectionRawData);
if (rawCollection.updateAuthority !== ADMIN.toBase58() || rawCollection.name !== 'Card NFT 2') {
  throw new Error('Collection raw authority or name mismatch');
}
const collectionSourceUri = `${sourceBase}/collection.json`;
const collectionTargetUri = `${targetBase}/collection.json`;
if (rawCollection.uri !== collectionSourceUri && rawCollection.uri !== collectionTargetUri) {
  throw new Error(`Unexpected collection raw URI ${rawCollection.uri}`);
}
const collectionRequiresMigration = rawCollection.uri === collectionSourceUri;
const [collectionAsset, inventory] = await Promise.all([
  rpc<Asset>(rpcUrl, 'getAsset', { id: COLLECTION.toBase58() }),
  searchAllCollectionAssets(rpcUrl),
]);
if (!authorityIncludes(collectionAsset) || collectionAsset.content?.json_uri !== rawCollection.uri) {
  throw new Error('Collection DAS state does not match the raw account');
}
const classified = classifyCollectionAsset(inventory.assets, sourceBase, targetBase);

const rawCore = await rawAccounts(classified.coreTargets.map((target) => target.address));
for (const target of classified.coreTargets) {
  const account = rawCore.get(target.address)!;
  if (account.owner !== MPL_CORE.toBase58()) throw new Error(`Core owner mismatch: ${target.address}`);
  const parsed = parseRawCoreAsset(account.data);
  if (parsed.updateAuthorityKind !== 2 || parsed.updateAuthority !== COLLECTION.toBase58()) {
    throw new Error(`Core update authority mismatch: ${target.address}`);
  }
  if (parsed.name !== expectedName(target.kind, target.referenceId, false)) {
    throw new Error(`Core raw name mismatch: ${target.address}`);
  }
  if (parsed.uri !== target.sourceUri) throw new Error(`Core raw URI mismatch: ${target.address}`);
}

async function freshReceiptInstruction(target: ReceiptTarget): Promise<TransactionInstruction> {
  const [asset, proof] = await Promise.all([
    rpc<Asset>(rpcUrl, 'getAsset', { id: target.address }),
    rpc<any>(rpcUrl, 'getAssetProof', { id: target.address }),
  ]);
  const current = classifyCollectionAsset([asset], sourceBase, targetBase).receiptTargets[0];
  if (!current || current.address !== target.address || current.referenceId !== target.referenceId) {
    throw new Error(`Receipt changed during planning: ${target.address}`);
  }
  return updateReceiptInstruction(asset, proof, target.targetUri);
}

const coreBatches = batches(classified.coreTargets);
let simulations: null | {
  collection: Simulation | null;
  core: Simulation[];
  receipts: Simulation[];
  failures: number;
} = null;
if (simulate) {
  const collection = collectionRequiresMigration
    ? await simulateInstructions('collection', [updateCollectionInstruction(collectionTargetUri)])
    : null;
  const core = await concurrentMap(coreBatches.slice(0, simulationLimit), 3, async (batch, index) => simulateInstructions(
    `core batch ${index + 1}`,
    batch.map((target) => updateCoreInstruction(new PublicKey(target.address), target.targetUri)),
  ));
  const receipts = await concurrentMap(classified.receiptTargets.slice(0, simulationLimit), 2, async (target) => simulateInstructions(
    `receipt ${target.address}`,
    [await freshReceiptInstruction(target)],
  ));
  const all = [collection, ...core, ...receipts].filter((value): value is Simulation => value != null);
  const failures = all.filter((result) => result.err != null);
  simulations = {
    collection,
    core,
    receipts,
    failures: failures.length,
  };
  if (failures.length) {
    const first = failures[0];
    throw new Error(`Simulation failed for ${first.label}: ${JSON.stringify(first.err)}\n${first.logs?.join('\n') || ''}`);
  }
}

const planScope = {
  rollback,
  sourceBase,
  targetBase,
  collection: collectionRequiresMigration ? {
    address: COLLECTION.toBase58(),
    sourceUri: collectionSourceUri,
    targetUri: collectionTargetUri,
  } : null,
  coreTargets: classified.coreTargets,
  receiptTargets: classified.receiptTargets,
};
const checksum = planChecksum(planScope);
const plan = {
  schemaVersion: 1,
  createdAt: new Date().toISOString(),
  mode: simulate ? 'simulate' : 'plan',
  rollback,
  sourceBase,
  targetBase,
  genesisHash,
  rpc: sanitizedRpcUrl(rpcUrl),
  rpcCredential: rpcSource,
  program: {
    address: PROGRAM_ID.toBase58(),
    programData: PROGRAM_DATA.toBase58(),
    deploymentSlot: Number(programDataBytes.readBigUInt64LE(4)),
    capacity: programDataBytes.length - 45,
    payloadSha256: sha256(programDataBytes.subarray(45)),
    authority: ADMIN.toBase58(),
  },
  configs: sharedConfigs,
  collection: {
    address: COLLECTION.toBase58(),
    accountSha256: sha256(collectionRawData),
    sourceUri: collectionSourceUri,
    targetUri: collectionTargetUri,
    requiresMigration: collectionRequiresMigration,
  },
  inventory: {
    pages: inventory.pages,
    uniqueAssets: inventory.assets.length,
    liveCore: classified.coreTargets.length + classified.alreadyTarget.core,
    liveReceipts: classified.receiptTargets.length + classified.alreadyTarget.receipts,
    burnedCore: classified.burned.core,
    burnedReceipts: classified.burned.receipts,
    alreadyTarget: classified.alreadyTarget,
  },
  coreBatchSize: CORE_BATCH_SIZE,
  lookupTable: {
    address: DELIVERY_LOOKUP_TABLE.toBase58(),
    addressesSha256: sha256(Buffer.concat(lookupTable.state.addresses.map((address) => address.toBuffer()))),
  },
  receiptInfrastructure: {
    tree: RECEIPTS_TREE.toBase58(),
    treeOwner: ACCOUNT_COMPRESSION.toBase58(),
    treeConfig: RECEIPTS_TREE_CONFIG.toBase58(),
    treeConfigOwner: BUBBLEGUM.toBase58(),
    ...treeConfigAuthority,
  },
  coreBatches: coreBatches.map((batch) => batch.map((target) => target.address)),
  transactionsRequired: Number(collectionRequiresMigration) + coreBatches.length + classified.receiptTargets.length,
  planScope,
  planChecksum: checksum,
  simulations,
};
await mkdir(path.dirname(outputPath), { recursive: true, mode: 0o700 });
await writeFile(outputPath, `${JSON.stringify(plan, null, 2)}\n`, { mode: 0o600 });
console.log('Card NFT 2 existing-URI plan prepared.');
console.log('mode                 :', plan.mode);
console.log('direction            :', rollback ? 'rollback' : 'forward');
console.log('output               :', outputPath);
console.log('DAS pages            :', inventory.pages);
console.log('unique records       :', inventory.assets.length);
console.log('collection mutation  :', collectionRequiresMigration ? 1 : 0);
console.log('Core mutations       :', classified.coreTargets.length);
console.log('Core batches         :', coreBatches.length);
console.log('receipt mutations    :', classified.receiptTargets.length);
console.log('burned Core          :', classified.burned.core);
console.log('burned receipts      :', classified.burned.receipts);
console.log('maximum transactions :', plan.transactionsRequired);
console.log('plan checksum        :', checksum);
if (simulations) console.log('simulations          :', `${1 + simulations.core.length + simulations.receipts.length} passed`);
