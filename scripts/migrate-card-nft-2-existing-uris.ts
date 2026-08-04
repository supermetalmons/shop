import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import bs58 from 'bs58';
import {
  Connection,
  Keypair,
  PublicKey,
  TransactionExpiredBlockheightExceededError,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import { parsePrivateKeyInput, promptMaskedInput, promptYConfirmation } from './shared/interactive.ts';
import {
  ACCOUNT_COMPRESSION,
  ADMIN,
  BUBBLEGUM,
  COLLECTION,
  CONFIG_PDA,
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
  batches,
  classifyCollectionAsset,
  classifyUri,
  configuredMainnetRpc,
  decodeConfig,
  expectedName,
  parseRawCollection,
  parseRawCoreAsset,
  planChecksum,
  repositoryRoot,
  rpc,
  searchAllCollectionAssets,
  sha256,
  updateCollectionInstruction,
  updateCoreInstruction,
  updateReceiptInstruction,
  type Asset,
  type CoreTarget,
  type ReceiptTarget,
} from './shared/cardNft2UriMigration.ts';

type Plan = {
  schemaVersion: number;
  mode: string;
  rollback: boolean;
  sourceBase: string;
  targetBase: string;
  genesisHash: string;
  program: {
    address: string;
    programData: string;
    deploymentSlot: number;
    capacity: number;
    payloadSha256: string;
    authority: string;
  };
  configs: Record<string, { address: string; bytes: number; sha256: string }>;
  collection: {
    address: string;
    accountSha256: string;
    sourceUri: string;
    targetUri: string;
    requiresMigration: boolean;
  };
  inventory: {
    burnedCore: number;
    burnedReceipts: number;
  };
  coreBatchSize: number;
  lookupTable: { address: string; addressesSha256: string };
  receiptInfrastructure: {
    tree: string;
    treeOwner: string;
    treeConfig: string;
    treeConfigOwner: string;
    creator: string;
    delegate: string;
  };
  coreBatches: string[][];
  transactionsRequired: number;
  planScope: {
    rollback: boolean;
    sourceBase: string;
    targetBase: string;
    collection: null | { address: string; sourceUri: string; targetUri: string };
    coreTargets: CoreTarget[];
    receiptTargets: ReceiptTarget[];
  };
  planChecksum: string;
  simulations: null | {
    collection: unknown | null;
    core: unknown[];
    receipts: unknown[];
    failures: number;
  };
};

type Checkpoint = {
  schemaVersion: 1;
  planFileSha256: string;
  planChecksum: string;
  targetBase: string;
  completedCollection: boolean;
  completedCore: string[];
  completedReceipts: string[];
  skippedBurnedCore: string[];
  skippedBurnedReceipts: string[];
  transactions: Array<{ signature: string; kind: string; targets: string[] }>;
  pending: null | { signature: string; kind: string; targets: string[] };
};

const argv = process.argv.slice(2);
if (argv.some((arg) => /keypair|private|secret|signer|rpc-url/i.test(arg))) {
  throw new Error('Signing material and RPC URLs cannot be provided as command-line arguments');
}
let send = false;
let rollback = false;
let planPath = path.join(repositoryRoot(), '.cache', 'card-nft-2-uri-migration', 'plan.json');
let statePath = path.join(repositoryRoot(), '.cache', 'card-nft-2-uri-migration', 'state.json');
for (let index = 0; index < argv.length; index += 1) {
  const arg = argv[index];
  if (arg === '--send') send = true;
  else if (arg === '--rollback') rollback = true;
  else if (arg === '--plan') {
    planPath = path.resolve(String(argv[++index] || '').trim());
    if (!planPath) throw new Error('--plan requires a path');
  } else if (arg === '--state') {
    statePath = path.resolve(String(argv[++index] || '').trim());
    if (!statePath) throw new Error('--state requires a path');
  } else throw new Error(`Unknown option: ${arg}`);
}

const sourceBase = rollback ? NEW_BASE : OLD_BASE;
const targetBase = rollback ? OLD_BASE : NEW_BASE;
const { rpcUrl, rpcSource } = configuredMainnetRpc();
const connection = new Connection(rpcUrl, 'confirmed');
const lookupTable = (await connection.getAddressLookupTable(DELIVERY_LOOKUP_TABLE, {
  commitment: 'finalized',
})).value;
if (!lookupTable) throw new Error(`Missing Card lookup table ${DELIVERY_LOOKUP_TABLE}`);
const lookupTableHash = sha256(Buffer.concat(lookupTable.state.addresses.map((address) => address.toBuffer())));

async function saveCheckpoint(checkpoint: Checkpoint): Promise<void> {
  await mkdir(path.dirname(statePath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${statePath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(checkpoint, null, 2)}\n`, { mode: 0o600 });
  await rename(temporaryPath, statePath);
}

async function loadCheckpoint(planFileSha256: string, checksum: string): Promise<Checkpoint> {
  try {
    const value = JSON.parse(await readFile(statePath, 'utf8')) as Checkpoint;
    if (value.schemaVersion !== 1
      || value.planFileSha256 !== planFileSha256
      || value.planChecksum !== checksum
      || value.targetBase !== targetBase) {
      throw new Error('Checkpoint does not match the immutable plan and direction');
    }
    return value;
  } catch (error: any) {
    if (error?.code !== 'ENOENT') throw error;
    return {
      schemaVersion: 1,
      planFileSha256,
      planChecksum: checksum,
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

function markCompleted(checkpoint: Checkpoint, kind: string, targets: string[]): void {
  if (kind === 'collection') checkpoint.completedCollection = true;
  if (kind === 'core') checkpoint.completedCore.push(...targets);
  if (kind === 'receipt') checkpoint.completedReceipts.push(...targets);
}

async function recoverPending(checkpoint: Checkpoint): Promise<void> {
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
  makeInstructions: () => Promise<TransactionInstruction[]> | TransactionInstruction[],
): Promise<string> {
  for (let attempt = 1; attempt <= 10; attempt += 1) {
    const instructions = await makeInstructions();
    const latest = await connection.getLatestBlockhash('confirmed');
    const transaction = new VersionedTransaction(new TransactionMessage({
      payerKey: ADMIN,
      recentBlockhash: latest.blockhash,
      instructions,
    }).compileToV0Message([lookupTable]));
    transaction.sign([signer]);
    const simulation = await connection.simulateTransaction(transaction, {
      commitment: 'confirmed',
      sigVerify: true,
    });
    if (simulation.value.err) {
      throw new Error(`Simulation failed for ${kind}: ${JSON.stringify(simulation.value.err)}\n${simulation.value.logs?.join('\n') || ''}`);
    }
    const signature = bs58.encode(transaction.signatures[0]);
    checkpoint.pending = { signature, kind, targets };
    await saveCheckpoint(checkpoint);
    try {
      const submitted = await connection.sendRawTransaction(transaction.serialize(), {
        skipPreflight: false,
        preflightCommitment: 'confirmed',
        maxRetries: 5,
      });
      if (submitted !== signature) throw new Error('RPC returned a different transaction signature');
      const confirmation = await connection.confirmTransaction({ signature, ...latest }, 'confirmed');
      if (confirmation.value.err) throw new Error(`Transaction failed: ${signature}`);
    } catch (error) {
      if (!(error instanceof TransactionExpiredBlockheightExceededError)) throw error;
      const status = (await connection.getSignatureStatuses([signature], { searchTransactionHistory: true })).value[0];
      if (status?.err) throw new Error(`Transaction failed: ${signature}`);
      if (status?.confirmationStatus !== 'confirmed' && status?.confirmationStatus !== 'finalized') {
        checkpoint.pending = null;
        await saveCheckpoint(checkpoint);
        console.log(`Blockhash expired for ${kind}; retrying with a fresh proof, blockhash, and signature (${10 - attempt} left).`);
        continue;
      }
    }
    markCompleted(checkpoint, kind, targets);
    checkpoint.transactions.push({ signature, kind, targets });
    checkpoint.pending = null;
    await saveCheckpoint(checkpoint);
    return signature;
  }
  throw new Error(`Blockhash expired repeatedly for ${kind}`);
}

async function freshReceiptState(target: ReceiptTarget): Promise<
  { status: 'source'; instruction: TransactionInstruction }
  | { status: 'target' | 'burned' }
> {
  const [asset, proof] = await Promise.all([
    rpc<Asset>(rpcUrl, 'getAsset', { id: target.address }),
    rpc<any>(rpcUrl, 'getAssetProof', { id: target.address }),
  ]);
  const uri = String(asset.content?.json_uri || '');
  if (asset.interface !== 'MplBubblegumV2') throw new Error(`Receipt interface mismatch: ${target.address}`);
  const classification = classifyUri(uri, sourceBase, targetBase, true);
  if (!classification
    || classification.kind !== target.kind
    || classification.referenceId !== target.referenceId) {
    throw new Error(`Receipt metadata changed outside the plan: ${target.address}`);
  }
  if (asset.burnt) return { status: 'burned' };
  if (classification.status === 'target') return { status: 'target' };
  if (asset.content?.metadata?.name !== expectedName(target.kind, target.referenceId, true)) {
    throw new Error(`Receipt name mismatch: ${target.address}`);
  }
  return { status: 'source', instruction: updateReceiptInstruction(asset, proof, target.targetUri) };
}

async function waitForReceipt(target: ReceiptTarget): Promise<void> {
  for (let attempt = 0; attempt < 90; attempt += 1) {
    const asset = await rpc<Asset>(rpcUrl, 'getAsset', { id: target.address });
    if (asset.content?.json_uri === target.targetUri) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 2_000));
  }
  throw new Error(`DAS did not index the receipt migration: ${target.address}`);
}

async function currentSharedConfigs(): Promise<Map<string, Buffer>> {
  const result = new Map<string, Buffer>();
  const addresses = Object.values(SHARED_CONFIGS);
  const responses = await Promise.all(addresses.map((address) => rpc<any>(rpcUrl, 'getAccountInfo', [
    address.toBase58(),
    { encoding: 'base64', commitment: 'finalized' },
  ])));
  addresses.forEach((address, index) => result.set(address.toBase58(), accountData(responses[index], address.toBase58())));
  return result;
}

async function assertNoUnexpectedSourceTargets(plan: Plan): Promise<{
  sourceCore: Set<string>;
  sourceReceipts: Set<string>;
  burnedCore: number;
  burnedReceipts: number;
}> {
  const inventory = await searchAllCollectionAssets(rpcUrl);
  const classified = classifyCollectionAsset(inventory.assets, sourceBase, targetBase);
  const plannedCore = new Set(plan.planScope.coreTargets.map((target) => target.address));
  const plannedReceipts = new Set(plan.planScope.receiptTargets.map((target) => target.address));
  const sourceCore = new Set(classified.coreTargets.map((target) => target.address));
  const sourceReceipts = new Set(classified.receiptTargets.map((target) => target.address));
  const unexpectedCore = [...sourceCore].filter((address) => !plannedCore.has(address));
  const unexpectedReceipts = [...sourceReceipts].filter((address) => !plannedReceipts.has(address));
  if (unexpectedCore.length || unexpectedReceipts.length) {
    throw new Error(`Unexpected new legacy targets: ${JSON.stringify({ core: unexpectedCore, receipts: unexpectedReceipts })}`);
  }
  return {
    sourceCore,
    sourceReceipts,
    burnedCore: classified.burned.core,
    burnedReceipts: classified.burned.receipts,
  };
}

const planFile = await readFile(planPath);
const planFileSha256 = createHash('sha256').update(planFile).digest('hex');
const plan = JSON.parse(planFile.toString('utf8')) as Plan;
const computedChecksum = planChecksum(plan.planScope);
const coreTargets = plan.planScope.coreTargets;
const receiptTargets = plan.planScope.receiptTargets;
const flattenedBatches = plan.coreBatches.flat();
if (plan.schemaVersion !== 1
  || plan.mode !== 'simulate'
  || plan.rollback !== rollback
  || plan.sourceBase !== sourceBase
  || plan.targetBase !== targetBase
  || plan.genesisHash !== MAINNET_GENESIS
  || plan.program.address !== PROGRAM_ID.toBase58()
  || plan.program.programData !== PROGRAM_DATA.toBase58()
  || plan.program.authority !== ADMIN.toBase58()
  || plan.collection.address !== COLLECTION.toBase58()
  || plan.coreBatchSize !== CORE_BATCH_SIZE
  || plan.lookupTable.address !== DELIVERY_LOOKUP_TABLE.toBase58()
  || plan.lookupTable.addressesSha256 !== lookupTableHash
  || plan.receiptInfrastructure.tree !== RECEIPTS_TREE.toBase58()
  || plan.receiptInfrastructure.treeOwner !== ACCOUNT_COMPRESSION.toBase58()
  || plan.receiptInfrastructure.treeConfig !== RECEIPTS_TREE_CONFIG.toBase58()
  || plan.receiptInfrastructure.treeConfigOwner !== BUBBLEGUM.toBase58()
  || plan.receiptInfrastructure.creator !== ADMIN.toBase58()
  || plan.receiptInfrastructure.delegate !== ADMIN.toBase58()
  || plan.planChecksum !== computedChecksum
  || plan.simulations?.failures !== 0
  || plan.simulations.core.length !== plan.coreBatches.length
  || plan.simulations.receipts.length !== receiptTargets.length
  || Boolean(plan.simulations.collection) !== plan.collection.requiresMigration
  || JSON.stringify(flattenedBatches) !== JSON.stringify(coreTargets.map((target) => target.address))
  || plan.coreBatches.some((batch) => batch.length < 1 || batch.length > CORE_BATCH_SIZE)
  || plan.transactionsRequired !== Number(plan.collection.requiresMigration) + plan.coreBatches.length + receiptTargets.length
  || new Set([...flattenedBatches, ...receiptTargets.map((target) => target.address)]).size
    !== flattenedBatches.length + receiptTargets.length) {
  throw new Error('Plan identity, simulations, checksum, batches, or transaction count mismatch');
}
for (const [targets, receipt] of [[coreTargets, false], [receiptTargets, true]] as const) {
  for (const target of targets) {
    const classified = classifyUri(target.sourceUri, sourceBase, targetBase, receipt);
    if (!classified
      || classified.status !== 'source'
      || classified.kind !== target.kind
      || classified.referenceId !== target.referenceId
      || target.targetUri !== classified.targetUri) {
      throw new Error(`Invalid planned metadata target: ${target.address}`);
    }
    new PublicKey(target.address);
  }
}

const genesisHash = await connection.getGenesisHash();
if (genesisHash !== MAINNET_GENESIS) throw new Error(`Refusing non-mainnet genesis ${genesisHash}`);
const [programAccount, programDataAccount, collectionAccount, treeAccount, treeConfigAccount, sharedConfigs] = await Promise.all([
  connection.getAccountInfo(PROGRAM_ID, 'finalized'),
  connection.getAccountInfo(PROGRAM_DATA, 'finalized'),
  connection.getAccountInfo(COLLECTION, 'finalized'),
  connection.getAccountInfo(RECEIPTS_TREE, 'finalized'),
  connection.getAccountInfo(RECEIPTS_TREE_CONFIG, 'finalized'),
  currentSharedConfigs(),
]);
if (!programAccount?.executable || !programAccount.owner.equals(UPGRADEABLE_LOADER)
  || !programDataAccount?.owner.equals(UPGRADEABLE_LOADER)
  || !collectionAccount?.owner.equals(MPL_CORE)
  || programDataAccount.data[12] !== 1
  || !programDataAccount.data.subarray(13, 45).equals(ADMIN.toBuffer())) {
  throw new Error('Program, ProgramData, collection, or authority mismatch');
}
if (!treeAccount?.owner.equals(ACCOUNT_COMPRESSION) || !treeConfigAccount?.owner.equals(BUBBLEGUM)) {
  throw new Error('Receipt tree or TreeConfig owner mismatch');
}
assertReceiptTreeConfig(Buffer.from(treeConfigAccount.data));
if (sha256(programDataAccount.data.subarray(45)) !== plan.program.payloadSha256
  || programDataAccount.data.length - 45 !== plan.program.capacity) {
  throw new Error('Program executable changed after planning');
}
for (const [dropId, address] of Object.entries(SHARED_CONFIGS)) {
  const data = sharedConfigs.get(address.toBase58())!;
  if (sha256(data) !== plan.configs[dropId]?.sha256) throw new Error(`Shared config changed after planning: ${dropId}`);
}
const cardConfig = decodeConfig(sharedConfigs.get(CONFIG_PDA.toBase58())!);
assertCardConfig(cardConfig);
if (cardConfig.uriBase !== targetBase) throw new Error(`Card config is not at ${targetBase}`);
const rawCollectionBefore = parseRawCollection(Buffer.from(collectionAccount.data));
if (rawCollectionBefore.updateAuthority !== ADMIN.toBase58() || rawCollectionBefore.name !== 'Card NFT 2') {
  throw new Error('Collection authority or name mismatch');
}
if (rawCollectionBefore.uri !== plan.collection.sourceUri && rawCollectionBefore.uri !== plan.collection.targetUri) {
  throw new Error(`Unexpected collection URI ${rawCollectionBefore.uri}`);
}
if (rawCollectionBefore.uri === plan.collection.sourceUri && !plan.collection.requiresMigration) {
  throw new Error('Collection became a new source target after planning');
}
await assertNoUnexpectedSourceTargets(plan);

console.log('Card NFT 2 existing-URI migration preflight passed.');
console.log('mode                 :', send ? 'approved send' : 'read-only preflight');
console.log('direction            :', `${sourceBase} -> ${targetBase}`);
console.log('rpc                  :', new URL(rpcUrl).host);
console.log('rpc credential       :', rpcSource);
console.log('program              :', PROGRAM_ID.toBase58());
console.log('program payload hash :', plan.program.payloadSha256);
console.log('plan                  :', planPath);
console.log('plan file SHA-256     :', planFileSha256);
console.log('plan checksum         :', plan.planChecksum);
console.log('collection mutations :', Number(plan.collection.requiresMigration));
console.log('Core mutations       :', coreTargets.length);
console.log('Core batches          :', plan.coreBatches.length);
console.log('receipt mutations    :', receiptTargets.length);
console.log('maximum transactions :', plan.transactionsRequired);
if (!send) {
  console.log('Preflight only. No private key was requested and no transaction was sent.');
  process.exit(0);
}

console.log('Enter the config admin private key (input is hidden).');
console.log('Accepted formats: base58 secret key or a JSON byte array.');
let keyInput = await promptMaskedInput('config admin private key: ');
let signer: Keypair | undefined;
try {
  signer = parsePrivateKeyInput(keyInput);
  keyInput = '';
  if (!signer.publicKey.equals(ADMIN)) {
    throw new Error(`Private key address is ${signer.publicKey.toBase58()}, expected ${ADMIN.toBase58()}`);
  }
  console.log('Private key address verified:', signer.publicKey.toBase58());
  if (!await promptYConfirmation('Send the approved MAINNET existing-URI migration? [y/N] ')) {
    console.log('Cancelled before send.');
    process.exit(0);
  }
  const checkpoint = await loadCheckpoint(planFileSha256, plan.planChecksum);
  await recoverPending(checkpoint);
  const completedCore = new Set([...checkpoint.completedCore, ...checkpoint.skippedBurnedCore]);
  const completedReceipts = new Set([...checkpoint.completedReceipts, ...checkpoint.skippedBurnedReceipts]);

  const currentCollection = await connection.getAccountInfo(COLLECTION, 'confirmed');
  if (!currentCollection) throw new Error('Collection account disappeared');
  const collectionState = parseRawCollection(Buffer.from(currentCollection.data));
  if (collectionState.uri === plan.collection.targetUri) checkpoint.completedCollection = true;
  else if (collectionState.uri !== plan.collection.sourceUri) throw new Error(`Collection URI changed: ${collectionState.uri}`);
  if (!checkpoint.completedCollection) {
    const signature = await sendInstructions(
      signer,
      checkpoint,
      'collection',
      [COLLECTION.toBase58()],
      () => [updateCollectionInstruction(plan.collection.targetUri)],
    );
    console.log('Collection:', signature);
  }

  const pendingCore: CoreTarget[] = [];
  for (const group of batches(coreTargets, 100)) {
    const active = group.filter((target) => !completedCore.has(target.address));
    if (!active.length) continue;
    const accounts = await connection.getMultipleAccountsInfo(
      active.map((target) => new PublicKey(target.address)),
      'confirmed',
    );
    for (let index = 0; index < active.length; index += 1) {
      const target = active[index];
      const account = accounts[index];
      if (!account) {
        const asset = await rpc<Asset>(rpcUrl, 'getAsset', { id: target.address });
        const uri = String(asset.content?.json_uri || '');
        if (!asset.burnt || asset.interface !== 'MplCoreAsset' || (uri !== target.sourceUri && uri !== target.targetUri)) {
          throw new Error(`Missing Core account is not a verified burn: ${target.address}`);
        }
        checkpoint.skippedBurnedCore.push(target.address);
        completedCore.add(target.address);
        continue;
      }
      if (!account.owner.equals(MPL_CORE)) throw new Error(`Core owner changed: ${target.address}`);
      const raw = parseRawCoreAsset(Buffer.from(account.data));
      if (raw.updateAuthorityKind !== 2
        || raw.updateAuthority !== COLLECTION.toBase58()
        || raw.name !== expectedName(target.kind, target.referenceId, false)) {
        throw new Error(`Core authority or name changed: ${target.address}`);
      }
      if (raw.uri === target.targetUri) {
        checkpoint.completedCore.push(target.address);
        completedCore.add(target.address);
      } else if (raw.uri === target.sourceUri) pendingCore.push(target);
      else throw new Error(`Core URI changed outside the plan: ${target.address}`);
    }
    await saveCheckpoint(checkpoint);
  }
  for (const group of batches(pendingCore, CORE_BATCH_SIZE)) {
    const signature = await sendInstructions(
      signer,
      checkpoint,
      'core',
      group.map((target) => target.address),
      () => group.map((target) => updateCoreInstruction(new PublicKey(target.address), target.targetUri)),
    );
    group.forEach((target) => completedCore.add(target.address));
    console.log(`Core ${completedCore.size}/${coreTargets.length}: ${signature}`);
  }

  for (const target of receiptTargets) {
    if (completedReceipts.has(target.address)) continue;
    const current = await freshReceiptState(target);
    if (current.status === 'target') {
      checkpoint.completedReceipts.push(target.address);
      completedReceipts.add(target.address);
      await saveCheckpoint(checkpoint);
      continue;
    }
    if (current.status === 'burned') {
      checkpoint.skippedBurnedReceipts.push(target.address);
      completedReceipts.add(target.address);
      await saveCheckpoint(checkpoint);
      continue;
    }
    const signature = await sendInstructions(
      signer,
      checkpoint,
      'receipt',
      [target.address],
      async () => {
        const fresh = await freshReceiptState(target);
        if (fresh.status !== 'source') throw new Error(`Receipt changed while preparing transaction: ${target.address}`);
        return [fresh.instruction];
      },
    );
    await waitForReceipt(target);
    completedReceipts.add(target.address);
    console.log(`Receipt ${completedReceipts.size}/${receiptTargets.length}: ${signature}`);
  }

  for (;;) {
    let pending = 0;
    for (const group of batches(checkpoint.transactions, 256)) {
      const signatures = group.map((entry) => entry.signature);
      const statuses = await connection.getSignatureStatuses(signatures, { searchTransactionHistory: true });
      statuses.value.forEach((status, index) => {
        if (status?.err) throw new Error(`Finalized transaction failure: ${signatures[index]}`);
        if (status?.confirmationStatus !== 'finalized') pending += 1;
      });
    }
    if (!pending) break;
    console.log(`Waiting for finalized commitment on ${pending} transactions...`);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 2_000));
  }

  const collectionAfter = await connection.getAccountInfo(COLLECTION, 'finalized');
  if (!collectionAfter || parseRawCollection(Buffer.from(collectionAfter.data)).uri !== plan.collection.targetUri) {
    throw new Error('Final collection URI verification failed');
  }
  for (const group of batches(coreTargets.filter((target) => !checkpoint.skippedBurnedCore.includes(target.address)), 100)) {
    const accounts = await connection.getMultipleAccountsInfo(group.map((target) => new PublicKey(target.address)), 'finalized');
    group.forEach((target, index) => {
      if (!accounts[index] || parseRawCoreAsset(Buffer.from(accounts[index]!.data)).uri !== target.targetUri) {
        throw new Error(`Final Core URI verification failed: ${target.address}`);
      }
    });
  }
  for (const group of batches(receiptTargets.filter((target) => !checkpoint.skippedBurnedReceipts.includes(target.address)), 100)) {
    const assets = await rpc<Asset[]>(rpcUrl, 'getAssetBatch', { ids: group.map((target) => target.address) });
    group.forEach((target, index) => {
      if (assets[index]?.id !== target.address || assets[index]?.content?.json_uri !== target.targetUri) {
        throw new Error(`Final receipt URI verification failed: ${target.address}`);
      }
    });
  }
  const remaining = await assertNoUnexpectedSourceTargets(plan);
  if (remaining.sourceCore.size || remaining.sourceReceipts.size) {
    throw new Error(`Mutable legacy URIs remain: ${JSON.stringify({
      core: [...remaining.sourceCore],
      receipts: [...remaining.sourceReceipts],
    })}`);
  }
  const finalConfigs = await currentSharedConfigs();
  for (const [dropId, address] of Object.entries(SHARED_CONFIGS)) {
    if (sha256(finalConfigs.get(address.toBase58())!) !== plan.configs[dropId].sha256) {
      throw new Error(`Shared config changed during asset migration: ${dropId}`);
    }
  }
  const programDataAfter = await connection.getAccountInfo(PROGRAM_DATA, 'finalized');
  if (!programDataAfter
    || !programDataAfter.data.subarray(13, 45).equals(ADMIN.toBuffer())
    || sha256(programDataAfter.data.subarray(45)) !== plan.program.payloadSha256) {
    throw new Error('Program authority or executable changed during asset migration');
  }
  const completionPath = `${statePath}.complete.json`;
  await writeFile(completionPath, `${JSON.stringify({
    schemaVersion: 1,
    completedAt: new Date().toISOString(),
    direction: { sourceBase, targetBase },
    planPath,
    planFileSha256,
    planChecksum: plan.planChecksum,
    program: PROGRAM_ID.toBase58(),
    programPayloadSha256: plan.program.payloadSha256,
    configSha256: plan.configs.card_nft_2.sha256,
    collection: COLLECTION.toBase58(),
    migrated: {
      core: coreTargets.length,
      receipts: receiptTargets.length,
    },
    skippedBurnedAfterPlanning: {
      core: checkpoint.skippedBurnedCore,
      receipts: checkpoint.skippedBurnedReceipts,
    },
    immutableBurnedAtPlanning: {
      core: plan.inventory.burnedCore,
      receipts: plan.inventory.burnedReceipts,
    },
    transactions: checkpoint.transactions,
  }, null, 2)}\n`, { mode: 0o600 });
  console.log('Migration verified and checkpointed:', statePath);
  console.log('Completion report:', completionPath);
  console.log('Transactions:', checkpoint.transactions.length);
} finally {
  keyInput = '';
  signer?.secretKey.fill(0);
}
