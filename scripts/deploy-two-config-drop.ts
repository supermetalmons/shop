import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import {
  AddressLookupTableAccount, AddressLookupTableProgram, ComputeBudgetProgram, Connection,
  Keypair, PublicKey, SystemInstruction, SystemProgram, TransactionInstruction, TransactionMessage, VersionedTransaction,
  type AccountInfo,
} from '@solana/web3.js';
import { BOX_MINTER_CONFIG_SEED } from '../shared/boxMinterProtocol.ts';
import { PREORDER_PAYMENT_RECIPIENTS } from '../shared/preorders.ts';
import {
  BUBBLEGUM_PROGRAM_ADDRESS, MPL_ACCOUNT_COMPRESSION_PROGRAM_ADDRESS, MPL_CORE_CPI_SIGNER_ADDRESS,
  MPL_CORE_PROGRAM_ADDRESS, MPL_NOOP_PROGRAM_ADDRESS, SPL_NOOP_PROGRAM_ADDRESS,
} from '../shared/solanaProgramAddresses.ts';
import {
  assertExistingConfigMatchesResume, bubblegumTreeConfigPda, buildCreateBubblegumTreeConfigV2Ix,
  buildDiscountMerkleData, buildInitializeSplitPaymentsV1Ix, decodeMplCoreCollectionBase,
  decodeMplCoreCollectionRoyalties, decodeMplCoreCollectionUpdateDelegates, decodeReceiptTreeState,
  finalizeDiscountMerkleAndDeploymentRegistry, getConcurrentMerkleTreeAccountSize,
  IX_MPL_CORE_UPDATE_COLLECTION_PLUGIN_V1, mplCorePluginUpdateDelegate,
  readMplCoreCollectionPluginRecords, registerDeploymentCleanup, validateDiscountMerkleDatasetForDeploy,
} from './deploy-all-onchain.ts';
import {
  acquireDeploymentRegistryMutationLock, normalizeAndValidateDropId, normalizeDeploymentDropForRegistry, readDeploymentDropRegistry,
  renderDeploymentRegistryFileFromSource, writeDeploymentRegistryFile, type DeploymentDropConfigSerialized,
} from './shared/deploymentRegistry.ts';
import { loadNewDropConfigById } from './shared/newDropLoader.ts';
import { resolveDeploymentDiscountAddresses } from './shared/deploymentDiscounts.ts';
import { createScriptSolanaConnection, resolveScriptSolanaRpcUrl, scriptSolanaRpcHost } from './shared/solanaRpcEnvironment.ts';
import type { NewDropConfig } from './shared/newDropConfig.ts';
import { loadPreorderCollectionConfig, type PreparedPreorderCollectionConfig } from './shared/preorderCollectionConfig.ts';
import { parsePrivateKeyInput, promptMaskedInput, promptYConfirmation } from './shared/interactive.ts';
import {
  closedMiNotePreorderConfig, MI_NOTE_CLUSTER_GENESIS, parseMiNoteDropManifest,
  verifyMiNoteDropManifest, type MiNoteDropManifest,
} from './shared/miNoteDropManifest.ts';
import { verifyTwoConfigGateForDeployment } from './verify-two-config-programs.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const USAGE = 'npm run deploy-two-config-drop -- <dropId> --manifest <inventory.json> [--write] [--yes] [--allow-mainnet]';
const APPROVED_PROGRAMS = {
  devnet: '8oFSao3VA9DrZouLe3ZFqkbUsjuF6aFDr1eJPh4pyh6',
  'mainnet-beta': '7FGMn1z6TMi6ndyVooP9n1y3zuWhcrxfcJgcSQs6VNNU',
} as const;
const CORE_PROGRAM = new PublicKey(MPL_CORE_PROGRAM_ADDRESS);
const COMPRESSION_PROGRAM = new PublicKey(MPL_ACCOUNT_COMPRESSION_PROGRAM_ADDRESS);
const TREE = { maxDepth: 14, maxBufferSize: 64, canopyDepth: 0 } as const;
type Cluster = keyof typeof APPROVED_PROGRAMS;
type StepKind = 'delegates' | 'mint-config' | 'operations-config' | 'receipt-tree' | 'lookup-table';

export type TwoConfigDeploymentArgs = {
  dropId: string;
  manifestPath: string;
  write: boolean;
  allowMainnet: boolean;
  yes?: boolean;
};

export function parseTwoConfigDeploymentArgs(argv: string[]): TwoConfigDeploymentArgs | null {
  if (argv.length === 1 && argv[0] === '--help') return null;
  let dropId = '';
  let manifestPath = '';
  let write = false;
  let allowMainnet = false;
  let yes = false;
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--manifest' && !manifestPath && argv[index + 1] && !argv[index + 1].startsWith('--')) manifestPath = argv[++index];
    else if (value === '--write' && !write) write = true;
    else if (value === '--allow-mainnet' && !allowMainnet) allowMainnet = true;
    else if (value === '--yes' && !yes) yes = true;
    else if (!value.startsWith('-') && !dropId) dropId = normalizeAndValidateDropId(value, 'dropId');
    else throw new Error(`Unknown, duplicate, or incomplete argument: ${value}\n${USAGE}`);
  }
  if (!dropId || !manifestPath || (allowMainnet || yes) && !write) throw new Error(USAGE);
  return { dropId, manifestPath, write, allowMainnet, yes };
}

export type TwoConfigDeploymentPlan = {
  version: 1;
  dropId: string;
  cluster: Cluster;
  authority: string;
  collection: string;
  programId: string;
  mintConfig: { configId: string; boxMinterConfigPda: string; maxSupply: number; itemsPerBox: 0 };
  operationsConfig: { configId: string; boxMinterConfigPda: string; maxSupply: number; itemsPerBox: 2 };
  receiptTree: { address: string; seed: string; space: number; maxDepth: 14; maxBufferSize: 64; canopyDepth: 0 };
  recipeSha256: string;
  manifestSha256: string;
};

function digest(value: unknown): string {
  return createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
}

function configAddress(programId: PublicKey, configId: string): PublicKey {
  return PublicKey.findProgramAddressSync([
    Buffer.from(BOX_MINTER_CONFIG_SEED), createHash('sha256').update(configId).digest(),
  ], programId)[0];
}

export async function createTwoConfigDeploymentPlan(args: {
  config: NewDropConfig;
  manifest: MiNoteDropManifest;
  source: DeploymentDropConfigSerialized | undefined;
}): Promise<TwoConfigDeploymentPlan> {
  const { config, source } = args;
  const manifest = parseMiNoteDropManifest(args.manifest);
  const drop = config.onchain;
  const preorder = closedMiNotePreorderConfig(manifest.sourcePreorder.preorderId);
  const cluster = config.deploy.solanaCluster;
  if (cluster !== 'devnet' && cluster !== 'mainnet-beta') throw new Error('Two-config deployment supports devnet and mainnet-beta only.');
  if (!config.deploy.reuseProgramId || !config.deploy.reuseProgramIdFromDropId || !source ||
    source.dropId !== config.deploy.reuseProgramIdFromDropId || source.solanaCluster !== cluster ||
    source.boxMinterProgramId !== APPROVED_PROGRAMS[cluster] || source.metadataPathFormat !== 'compact') {
    throw new Error('Choose an explicit same-cluster compact shared-program source drop; deploying or upgrading a program is unsupported.');
  }
  if (drop.dropId !== manifest.sourcePreorder.preorderId || drop.dropFamily !== 'mi_note_cards' ||
    preorder.cluster !== cluster || config.deploy.coreCollectionPubkey !== preorder.collection ||
    drop.metadataBase !== manifest.metadataBase || drop.itemsPerBox !== 2 || drop.maxSupply !== manifest.packCount ||
    !drop.operationsConfig || drop.operationsConfig.configId === drop.dropId ||
    drop.operationsConfig.maxSupply * 2 !== manifest.maxFigureId ||
    !isDeepStrictEqual(drop.inventoryManifest, { sha256: manifest.sha256, cardIds: manifest.eligibleCardIds }) ||
    drop.stripeCheckoutEnabled !== false || drop.salesMode && drop.salesMode !== 'standard' || drop.receiptPoolId || drop.mintSelection) {
    throw new Error('Recipe must describe the closed preorder collection, exact saved inventory manifest, and standard two-card pack roles.');
  }
  if (!isDeepStrictEqual(drop.receiptsTree, TREE) || !drop.paymentRouting ||
    !isDeepStrictEqual(drop.paymentRouting.mintProceeds, PREORDER_PAYMENT_RECIPIENTS.map(address => ({ address, percentage: 50 }))) ||
    drop.priceSol !== 0.25 || drop.discountPriceSol !== 0.25 || drop.namePrefix !== 'pack' || drop.figureNamePrefix !== 'card') {
    throw new Error('Mi Note deployment requires the reviewed 0.25 SOL price, 50/50 proceeds, pack/card labels, and 14/64/0 receipt tree.');
  }
  normalizeAndValidateDropId(drop.operationsConfig.configId, 'operations configId');
  const program = new PublicKey(source.boxMinterProgramId);
  const seed = digest(`two-config-receipts:${cluster}:${drop.dropId}`).slice(0, 32);
  const tree = await PublicKey.createWithSeed(new PublicKey(preorder.authority), seed, COMPRESSION_PROGRAM);
  return {
    version: 1, dropId: drop.dropId, cluster, authority: preorder.authority, collection: preorder.collection,
    programId: program.toBase58(),
    mintConfig: { configId: drop.dropId, boxMinterConfigPda: configAddress(program, drop.dropId).toBase58(), maxSupply: drop.maxSupply, itemsPerBox: 0 },
    operationsConfig: { ...drop.operationsConfig, boxMinterConfigPda: configAddress(program, drop.operationsConfig.configId).toBase58(), itemsPerBox: 2 },
    receiptTree: { address: tree.toBase58(), seed, space: getConcurrentMerkleTreeAccountSize(14, 64, 0), ...TREE },
    recipeSha256: digest(config), manifestSha256: manifest.sha256,
  };
}

type CollectionSnapshot = {
  base: ReturnType<typeof collectionPreservationState>;
  delegates: string[];
};

function collectionPreservationState(data: Buffer) {
  const base = decodeMplCoreCollectionBase(data);
  const records = readMplCoreCollectionPluginRecords(data);
  if (!records || !isDeepStrictEqual(records.map(record => record.pluginType).sort((a, b) => a - b), [0, 4, 15])) {
    throw new Error('Collection must retain exactly Royalties, UpdateDelegate, and BubblegumV2 plugins.');
  }
  const baseLength = 1 + 32 + 4 + Buffer.byteLength(base.name) + 4 + Buffer.byteLength(base.uri) + 8;
  if (data[baseLength] !== 3 || data.length < baseLength + 9) throw new Error('Invalid collection plugin header.');
  const registryOffset = Number(data.readBigUInt64LE(baseLength + 1));
  const byOffset = [...records].sort((a, b) => a.offset - b.offset);
  return {
    baseHex: data.subarray(0, baseLength).toString('hex'),
    plugins: byOffset.map((record, index) => ({
      type: record.pluginType, authorityKind: record.authorityKind,
      authorityAddress: record.authorityAddress?.toBase58() ?? null,
      payload: record.pluginType === 4 ? null : data.subarray(record.offset, byOffset[index + 1]?.offset ?? registryOffset).toString('hex'),
    })).sort((a, b) => a.type - b.type),
  };
}

function inspectCollection(account: AccountInfo<Buffer> | null, plan: TwoConfigDeploymentPlan,
  config: PreparedPreorderCollectionConfig, expected?: CollectionSnapshot): CollectionSnapshot {
  if (!account || account.executable || !account.owner.equals(CORE_PROGRAM)) throw new Error('Existing preorder collection is missing or has the wrong owner.');
  const data = Buffer.from(account.data);
  const base = decodeMplCoreCollectionBase(data);
  const royalties = decodeMplCoreCollectionRoyalties(data);
  const update = decodeMplCoreCollectionUpdateDelegates(data);
  if (base.updateAuthority.toBase58() !== plan.authority || base.name !== config.collectionMetadata.name ||
    base.uri !== config.collectionMetadataUri || !royalties || royalties.authorityKind !== 2 || royalties.ruleSetKind !== 0 ||
    royalties.basisPoints !== config.collectionMetadata.sellerFeeBasisPoints ||
    !isDeepStrictEqual(royalties.creators.map(creator => ({ address: creator.address.toBase58(), share: creator.percentage })), config.collectionMetadata.creators) ||
    !update || update.authorityKind !== 2 || !update.delegates.some(delegate => delegate.toBase58() === plan.authority)) {
    throw new Error('Collection authority, metadata, royalties, or delegate authority differs from the existing preorder deployment.');
  }
  const snapshot = { base: collectionPreservationState(data), delegates: update.delegates.map(delegate => delegate.toBase58()) };
  if (new Set(snapshot.delegates).size !== snapshot.delegates.length || expected &&
    (!isDeepStrictEqual(snapshot.base, expected.base) || expected.delegates.some(delegate => !snapshot.delegates.includes(delegate)))) {
    throw new Error('Collection state changed or an existing delegate was removed.');
  }
  return snapshot;
}

export function buildTwoConfigDelegateUpdateInstruction(plan: TwoConfigDeploymentPlan, delegates: readonly string[]): TransactionInstruction {
  const union = [...new Set([...delegates, plan.mintConfig.boxMinterConfigPda, plan.operationsConfig.boxMinterConfigPda])];
  const authority = new PublicKey(plan.authority);
  return new TransactionInstruction({
    programId: CORE_PROGRAM,
    keys: [
      { pubkey: new PublicKey(plan.collection), isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: true, isWritable: true },
      { pubkey: authority, isSigner: true, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: new PublicKey(SPL_NOOP_PROGRAM_ADDRESS), isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([Buffer.from([IX_MPL_CORE_UPDATE_COLLECTION_PLUGIN_V1]), mplCorePluginUpdateDelegate(union.map(value => new PublicKey(value)))]),
  });
}

export type TwoConfigJournalTransaction = {
  step: StepKind;
  signature: string;
  transactionBase64: string;
  blockhash: string;
  lastValidBlockHeight: number;
  resources: string[];
  signedAt: string;
  status: 'signed' | 'finalized' | 'failed' | 'expired' | 'state-verified';
  finalizedSlot?: number;
};

type DeploymentJournal = {
  version: 1;
  plan: TwoConfigDeploymentPlan;
  collection: CollectionSnapshot;
  createdAt: string;
  lookupTable?: { address: string; recentSlot: number };
  transactions: TwoConfigJournalTransaction[];
  finalizedSlot?: number;
};

export function validateTwoConfigJournalTransaction(entry: TwoConfigJournalTransaction, authority: string): VersionedTransaction {
  if (!['delegates', 'mint-config', 'operations-config', 'receipt-tree', 'lookup-table'].includes(entry.step) ||
    !['signed', 'finalized', 'failed', 'expired', 'state-verified'].includes(entry.status) ||
    !Number.isSafeInteger(entry.lastValidBlockHeight) || entry.lastValidBlockHeight < 0 ||
    !Array.isArray(entry.resources) || entry.resources.some(value => new PublicKey(value).toBase58() !== value) ||
    !Number.isFinite(Date.parse(entry.signedAt))) throw new Error('Invalid transaction journal entry.');
  const bytes = Buffer.from(entry.transactionBase64, 'base64');
  const transaction = VersionedTransaction.deserialize(bytes);
  if (Buffer.from(transaction.serialize()).toString('base64') !== entry.transactionBase64 ||
    transaction.message.header.numRequiredSignatures !== 1 || transaction.signatures.length !== 1 ||
    transaction.message.staticAccountKeys[0].toBase58() !== authority || transaction.message.recentBlockhash !== entry.blockhash ||
    bs58.encode(transaction.signatures[0]) !== entry.signature ||
    !nacl.sign.detached.verify(transaction.message.serialize(), transaction.signatures[0], new PublicKey(authority).toBytes())) {
    throw new Error('Journal transaction bytes or signature do not match the expected authority.');
  }
  return transaction;
}

export async function inspectTwoConfigJournalTransaction(connection: Pick<Connection, 'getSignatureStatuses' | 'getBlockHeight'>,
  entry: TwoConfigJournalTransaction): Promise<{ status: 'finalized' | 'failed' | 'expired' | 'pending'; slot?: number }> {
  const read = () => connection.getSignatureStatuses([entry.signature], { searchTransactionHistory: true });
  let result = (await read()).value[0];
  if (result?.confirmationStatus === 'finalized') return { status: result.err ? 'failed' : 'finalized', slot: result.slot };
  if (result) return { status: 'pending' };
  if (await connection.getBlockHeight('finalized') <= entry.lastValidBlockHeight) return { status: 'pending' };
  result = (await read()).value[0];
  if (result?.confirmationStatus === 'finalized') return { status: result.err ? 'failed' : 'finalized', slot: result.slot };
  return { status: result ? 'pending' : 'expired' };
}

function writeDurableJson(filePath: string, value: unknown, expectedContent?: string): string {
  const content = `${JSON.stringify(value, null, 2)}\n`;
  const directory = path.dirname(filePath);
  mkdirSync(directory, { recursive: true });
  if (expectedContent !== undefined && (!existsSync(filePath) || readFileSync(filePath, 'utf8') !== expectedContent)) {
    throw new Error(`Public deployment file changed while in use: ${filePath}`);
  }
  const temporary = `${filePath}.${randomUUID()}.tmp`;
  const descriptor = openSync(temporary, 'wx', 0o600);
  try { writeFileSync(descriptor, content, 'utf8'); fsyncSync(descriptor); } finally { closeSync(descriptor); }
  try {
    if (expectedContent === undefined) linkSync(temporary, filePath);
    else renameSync(temporary, filePath);
    const parent = openSync(directory, 'r');
    try { fsyncSync(parent); } finally { closeSync(parent); }
  } finally { rmSync(temporary, { force: true }); }
  if (readFileSync(filePath, 'utf8') !== content) throw new Error(`Public deployment file verification failed: ${filePath}`);
  return content;
}

type DeploymentContext = {
  config: NewDropConfig;
  plan: TwoConfigDeploymentPlan;
  collectionConfig: PreparedPreorderCollectionConfig;
  discountRoot: Buffer;
};

function initializeArguments(context: DeploymentContext, step: 'mint-config' | 'operations-config') {
  const { config, plan, discountRoot } = context;
  const drop = config.onchain;
  const role = step === 'mint-config' ? plan.mintConfig : plan.operationsConfig;
  return {
    programId: new PublicKey(plan.programId), admin: new PublicKey(plan.authority),
    treasury: new PublicKey(drop.paymentRouting!.deliveryPaymentReceiver), coreCollection: new PublicKey(plan.collection),
    priceLamports: BigInt(Math.round(drop.priceSol * 1_000_000_000)),
    discountPriceLamports: BigInt(Math.round(drop.discountPriceSol * 1_000_000_000)),
    discountMintsPerWallet: drop.discountMintsPerWallet, discountMerkleRoot: discountRoot,
    maxSupply: role.maxSupply, itemsPerBox: role.itemsPerBox, maxPerTx: drop.maxPerTx,
    namePrefix: drop.namePrefix, figureNamePrefix: drop.figureNamePrefix, symbol: drop.symbol!, metadataBase: drop.metadataBase,
    dropSeed: createHash('sha256').update(role.configId).digest(),
    mintProceeds: drop.paymentRouting!.mintProceeds.map(recipient => ({ address: new PublicKey(recipient.address), percentage: recipient.percentage })),
  };
}

function lookupAddresses(context: DeploymentContext): PublicKey[] {
  const { plan, config } = context;
  return [...new Set([
    plan.programId, plan.mintConfig.boxMinterConfigPda, plan.operationsConfig.boxMinterConfigPda,
    plan.authority, config.onchain.paymentRouting!.deliveryPaymentReceiver, plan.collection,
    MPL_CORE_PROGRAM_ADDRESS, SystemProgram.programId.toBase58(), ComputeBudgetProgram.programId.toBase58(),
    SPL_NOOP_PROGRAM_ADDRESS, MPL_NOOP_PROGRAM_ADDRESS, MPL_ACCOUNT_COMPRESSION_PROGRAM_ADDRESS,
    BUBBLEGUM_PROGRAM_ADDRESS, MPL_CORE_CPI_SIGNER_ADDRESS, plan.receiptTree.address,
    bubblegumTreeConfigPda(new PublicKey(plan.receiptTree.address)).toBase58(),
  ])].map(value => new PublicKey(value));
}

function assertRecoveryTransactionMatchesPlan(transaction: VersionedTransaction, entry: TwoConfigJournalTransaction,
  context: DeploymentContext, journal: DeploymentJournal): void {
  const { plan } = context;
  const payer = new PublicKey(plan.authority);
  const actual = TransactionMessage.decompile(transaction.message).instructions;
  let instructions: TransactionInstruction[];
  if (entry.step === 'mint-config' || entry.step === 'operations-config') {
    instructions = [buildInitializeSplitPaymentsV1Ix(initializeArguments(context, entry.step))];
  } else if (entry.step === 'delegates') {
    const data = actual[1]?.data;
    if (!data || data.length < 6 || data[0] !== IX_MPL_CORE_UPDATE_COLLECTION_PLUGIN_V1 || data[1] !== 4) throw new Error('Invalid recovered delegate update.');
    const count = data.readUInt32LE(2);
    if (data.length !== 6 + count * 32) throw new Error('Invalid recovered delegate list.');
    const delegates = Array.from({ length: count }, (_, index) => new PublicKey(data.subarray(6 + index * 32, 38 + index * 32)).toBase58());
    if (journal.collection.delegates.some(value => !delegates.includes(value))) throw new Error('Recovered transaction removes an existing delegate.');
    instructions = [buildTwoConfigDelegateUpdateInstruction(plan, delegates)];
  } else if (entry.step === 'receipt-tree') {
    const created = SystemInstruction.decodeCreateWithSeed(actual[1]);
    if (!Number.isSafeInteger(created.lamports) || created.lamports <= 0) throw new Error('Invalid recovered receipt-tree funding.');
    instructions = [SystemProgram.createAccountWithSeed({
      fromPubkey: payer, newAccountPubkey: new PublicKey(plan.receiptTree.address), basePubkey: payer,
      seed: plan.receiptTree.seed, space: plan.receiptTree.space, lamports: created.lamports, programId: COMPRESSION_PROGRAM,
    }), buildCreateBubblegumTreeConfigV2Ix({ merkleTree: new PublicKey(plan.receiptTree.address), payer, treeCreator: payer,
      maxDepth: 14, maxBufferSize: 64, isPublic: false })];
  } else {
    if (!journal.lookupTable) throw new Error('Recovered lookup-table transaction has no recorded resource.');
    const [create, lookupTable] = AddressLookupTableProgram.createLookupTable({ payer, authority: payer, recentSlot: journal.lookupTable.recentSlot });
    instructions = [create, AddressLookupTableProgram.extendLookupTable({ payer, authority: payer, lookupTable, addresses: lookupAddresses(context) })];
  }
  const expected = new TransactionMessage({ payerKey: payer, recentBlockhash: entry.blockhash,
    instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }), ...instructions] }).compileToV0Message();
  if (!Buffer.from(expected.serialize()).equals(Buffer.from(transaction.message.serialize()))) {
    throw new Error('Signed recovery transaction differs from the approved deployment instructions.');
  }
}

function stepAddresses(step: StepKind, plan: TwoConfigDeploymentPlan, journal: DeploymentJournal): string[] {
  if (step === 'delegates') return [plan.collection];
  if (step === 'mint-config') return [plan.mintConfig.boxMinterConfigPda];
  if (step === 'operations-config') return [plan.operationsConfig.boxMinterConfigPda];
  if (step === 'receipt-tree') return [plan.receiptTree.address, bubblegumTreeConfigPda(new PublicKey(plan.receiptTree.address)).toBase58()];
  return journal.lookupTable ? [journal.lookupTable.address] : [];
}

function validateStepAccounts(step: StepKind, accounts: readonly (AccountInfo<Buffer> | null)[], context: DeploymentContext,
  journal: DeploymentJournal): boolean {
  const { plan } = context;
  if (!accounts.length || accounts.every(account => account === null)) return false;
  if (accounts.some(account => account === null)) throw new Error(`Partially initialized ${step}; preserve the journal and inspect the accounts.`);
  if (step === 'delegates') {
    const state = inspectCollection(accounts[0], plan, context.collectionConfig, journal.collection);
    return [plan.mintConfig.boxMinterConfigPda, plan.operationsConfig.boxMinterConfigPda].every(value => state.delegates.includes(value));
  }
  if (step === 'mint-config' || step === 'operations-config') {
    const account = accounts[0]!;
    if (account.executable || account.owner.toBase58() !== plan.programId) throw new Error(`Wrong ${step} account owner.`);
    assertExistingConfigMatchesResume({ data: Buffer.from(account.data), ...initializeArguments(context, step) });
    return true;
  }
  if (step === 'receipt-tree') {
    const [merkle, config] = accounts;
    if (merkle!.executable || config!.executable || !merkle!.owner.equals(COMPRESSION_PROGRAM) ||
      config!.owner.toBase58() !== BUBBLEGUM_PROGRAM_ADDRESS || merkle!.data.length !== plan.receiptTree.space) {
      throw new Error('Receipt tree account owner or allocated size differs from the deployment plan.');
    }
    const tree = decodeReceiptTreeState({ merkleTreeData: Buffer.from(merkle!.data), treeConfigData: Buffer.from(config!.data) });
    if (tree.maxDepth !== TREE.maxDepth || tree.maxBufferSize !== TREE.maxBufferSize || tree.version !== 1 ||
      tree.authority.toBase58() !== bubblegumTreeConfigPda(new PublicKey(plan.receiptTree.address)).toBase58() ||
      tree.creator.toBase58() !== plan.authority || tree.delegate.toBase58() !== plan.authority ||
      tree.totalCapacity !== 2 ** TREE.maxDepth || tree.numMinted !== 0 || tree.isPublic) {
      throw new Error('Receipt tree must be private, unused, and controlled by the existing collection authority.');
    }
    return true;
  }
  const account = accounts[0]!;
  if (account.executable || !account.owner.equals(AddressLookupTableProgram.programId)) throw new Error('Wrong lookup-table account owner.');
  const table = AddressLookupTableAccount.deserialize(account.data);
  if (table.authority?.toBase58() !== plan.authority || table.deactivationSlot !== 0xffff_ffff_ffff_ffffn ||
    !isDeepStrictEqual(table.addresses.map(value => value.toBase58()), lookupAddresses(context).map(value => value.toBase58()))) {
    throw new Error('Lookup table authority or addresses do not match both config roles.');
  }
  return true;
}

async function readStep(connection: Connection, step: StepKind, context: DeploymentContext, journal: DeploymentJournal, minContextSlot: number) {
  const addresses = stepAddresses(step, context.plan, journal);
  if (!addresses.length) return { ready: false, slot: minContextSlot };
  const result = await connection.getMultipleAccountsInfoAndContext(addresses.map(value => new PublicKey(value)), {
    commitment: 'finalized', minContextSlot,
  });
  if (result.context.slot < minContextSlot) throw new Error('RPC returned stale finalized deployment state.');
  return { ready: validateStepAccounts(step, result.value, context, journal), slot: result.context.slot };
}

async function assertDelegateUpdatePreservesCollection(connection: Connection, transaction: VersionedTransaction,
  context: DeploymentContext, journal: DeploymentJournal, minContextSlot: number) {
  const result = await connection.getMultipleAccountsInfoAndContext([new PublicKey(context.plan.collection)], {
    commitment: 'finalized', minContextSlot,
  });
  if (result.context.slot < minContextSlot) throw new Error('RPC returned stale finalized deployment state.');
  const current = inspectCollection(result.value[0], context.plan, context.collectionConfig, journal.collection);
  const data = TransactionMessage.decompile(transaction.message).instructions[1].data;
  const delegates = Array.from({ length: data.readUInt32LE(2) }, (_, index) =>
    new PublicKey(data.subarray(6 + index * 32, 38 + index * 32)).toBase58());
  if (current.delegates.some(delegate => !delegates.includes(delegate))) {
    throw new Error('Collection delegates changed after review; rerun to prepare and simulate a fresh update.');
  }
}

async function buildStepInstructions(connection: Connection, step: StepKind, context: DeploymentContext, journal: DeploymentJournal) {
  const { plan } = context;
  const payer = new PublicKey(plan.authority);
  let instructions: TransactionInstruction[];
  let rentLamports = 0;
  if (step === 'delegates') {
    const current = await connection.getAccountInfo(new PublicKey(plan.collection), 'finalized');
    const snapshot = inspectCollection(current, plan, context.collectionConfig, journal.collection);
    instructions = [buildTwoConfigDelegateUpdateInstruction(plan, snapshot.delegates)];
  } else if (step === 'mint-config' || step === 'operations-config') {
    instructions = [buildInitializeSplitPaymentsV1Ix(initializeArguments(context, step))];
    rentLamports = await connection.getMinimumBalanceForRentExemption(488, 'finalized');
  } else if (step === 'receipt-tree') {
    const tree = new PublicKey(plan.receiptTree.address);
    rentLamports = await connection.getMinimumBalanceForRentExemption(plan.receiptTree.space, 'finalized');
    instructions = [
      SystemProgram.createAccountWithSeed({
        fromPubkey: payer, newAccountPubkey: tree, basePubkey: payer, seed: plan.receiptTree.seed,
        lamports: rentLamports, space: plan.receiptTree.space, programId: COMPRESSION_PROGRAM,
      }),
      buildCreateBubblegumTreeConfigV2Ix({ merkleTree: tree, payer, treeCreator: payer, maxDepth: 14, maxBufferSize: 64, isPublic: false }),
    ];
  } else {
    if (!journal.lookupTable) throw new Error('Missing lookup-table resource identity.');
    const [create, address] = AddressLookupTableProgram.createLookupTable({ payer, authority: payer, recentSlot: journal.lookupTable.recentSlot });
    if (address.toBase58() !== journal.lookupTable.address) throw new Error('Lookup-table identity differs from its recorded rooted slot.');
    const addresses = lookupAddresses(context);
    rentLamports = await connection.getMinimumBalanceForRentExemption(56 + addresses.length * 32, 'finalized');
    instructions = [create, AddressLookupTableProgram.extendLookupTable({ payer, authority: payer, lookupTable: address, addresses })];
  }
  return { instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }), ...instructions], rentLamports };
}

function simulationAccount(value: unknown): AccountInfo<Buffer> | null {
  if (value === null) return null;
  if (!value || typeof value !== 'object') throw new Error('Missing simulated account state.');
  const account = value as { data?: unknown; owner?: unknown; executable?: unknown; lamports?: unknown; rentEpoch?: unknown };
  if (!Array.isArray(account.data) || account.data[1] !== 'base64' || typeof account.data[0] !== 'string' ||
    typeof account.owner !== 'string' || typeof account.executable !== 'boolean' ||
    typeof account.lamports !== 'number' || !Number.isSafeInteger(account.lamports) || account.lamports < 0) {
    throw new Error('Invalid simulated deployment account.');
  }
  return { data: Buffer.from(account.data[0], 'base64'), owner: new PublicKey(account.owner), executable: account.executable,
    lamports: account.lamports, rentEpoch: typeof account.rentEpoch === 'number' ? account.rentEpoch : 0 };
}

function readJournal(filePath: string, plan: TwoConfigDeploymentPlan): { journal: DeploymentJournal; source: string } | undefined {
  if (!existsSync(filePath)) return undefined;
  const source = readFileSync(filePath, 'utf8');
  const journal = JSON.parse(source) as DeploymentJournal;
  if (journal.version !== 1 || !isDeepStrictEqual(journal.plan, plan) || !journal.collection ||
    !Array.isArray(journal.collection.delegates) || !Array.isArray(journal.transactions) ||
    !Number.isFinite(Date.parse(journal.createdAt))) throw new Error('Recovery journal does not match the immutable deployment plan.');
  for (const transaction of journal.transactions) validateTwoConfigJournalTransaction(transaction, plan.authority);
  if (journal.transactions.filter(entry => entry.status === 'signed').length > 1) throw new Error('Journal contains multiple unresolved transactions.');
  if (journal.lookupTable) {
    const [, address] = AddressLookupTableProgram.createLookupTable({ authority: new PublicKey(plan.authority), payer: new PublicKey(plan.authority), recentSlot: journal.lookupTable.recentSlot });
    if (address.toBase58() !== journal.lookupTable.address) throw new Error('Invalid lookup table in deployment journal.');
  }
  return { journal, source };
}

function buildDeploymentRow(context: DeploymentContext, manifest: MiNoteDropManifest, lookupTable: string): DeploymentDropConfigSerialized {
  const { config, plan, discountRoot } = context;
  const drop = config.onchain;
  const row: DeploymentDropConfigSerialized = {
    solanaCluster: plan.cluster, dropId: plan.dropId, dropFamily: 'mi_note_cards',
    collectionName: context.collectionConfig.collectionMetadata.name,
    ...(drop.displayName ? { displayName: drop.displayName } : {}),
    metadataBase: manifest.metadataBase, metadataPathFormat: 'compact', paymentRouting: drop.paymentRouting!,
    priceSol: drop.priceSol, discountPriceSol: drop.discountPriceSol, stripeCheckoutEnabled: false,
    discountMintsPerWallet: drop.discountMintsPerWallet, discountMerkleRoot: discountRoot.toString('hex'),
    maxSupply: drop.maxSupply, itemsPerBox: drop.itemsPerBox, maxPerTx: drop.maxPerTx,
    namePrefix: drop.namePrefix, figureNamePrefix: drop.figureNamePrefix, symbol: drop.symbol!,
    boxMinterProgramId: plan.programId, boxMinterConfigPda: plan.mintConfig.boxMinterConfigPda,
    operationsConfig: { configId: plan.operationsConfig.configId, boxMinterConfigPda: plan.operationsConfig.boxMinterConfigPda, maxSupply: plan.operationsConfig.maxSupply },
    inventoryManifest: { sha256: manifest.sha256, cardIds: [...manifest.eligibleCardIds] },
    collectionMint: plan.collection, receiptsMerkleTree: plan.receiptTree.address,
    receiptsTreeMaxDepth: 14, receiptsTreeCanopyDepth: 0, deliveryLookupTable: lookupTable,
  };
  const normalized = normalizeDeploymentDropForRegistry(row);
  if (!normalized) throw new Error('Could not normalize the deployment registry row.');
  return normalized;
}

export type TwoConfigDeploymentDependencies = {
  createConnection: (endpoint: string, cluster: Cluster) => Connection;
  loadConfig: typeof loadNewDropConfigById;
  loadCollectionConfig: typeof loadPreorderCollectionConfig;
  readRegistry: typeof readDeploymentDropRegistry;
  verifyManifest: typeof verifyMiNoteDropManifest;
  verifyGate: typeof verifyTwoConfigGateForDeployment;
  promptPrivateKey: () => Promise<string>;
  confirm: (question: string) => Promise<boolean>;
  log: (message: string) => void;
  now: () => Date;
};

const defaultDependencies: TwoConfigDeploymentDependencies = {
  createConnection: (endpoint, cluster) => createScriptSolanaConnection({ cluster, explicitUrl: endpoint }),
  loadConfig: loadNewDropConfigById, loadCollectionConfig: loadPreorderCollectionConfig,
  readRegistry: readDeploymentDropRegistry, verifyManifest: verifyMiNoteDropManifest,
  verifyGate: verifyTwoConfigGateForDeployment,
  promptPrivateKey: () => promptMaskedInput('Existing collection authority private key (masked, memory only): '),
  confirm: promptYConfirmation, log: message => console.log(message), now: () => new Date(),
};

export async function runTwoConfigDropDeployment(args: TwoConfigDeploymentArgs & { root?: string },
  overrides: Partial<TwoConfigDeploymentDependencies> = {}): Promise<{ plan: TwoConfigDeploymentPlan; ready: boolean; recordPath: string }> {
  if ((args.yes || args.allowMainnet) && !args.write) throw new Error(USAGE);
  const deps = { ...defaultDependencies, ...overrides };
  const confirm = (question: string) => args.yes ? Promise.resolve(true) : deps.confirm(question);
  const root = args.root || ROOT;
  const manifestPath = path.resolve(root, args.manifestPath);
  const manifestSource = readFileSync(manifestPath, 'utf8');
  const manifest = parseMiNoteDropManifest(JSON.parse(manifestSource));
  const { config } = await deps.loadConfig({ root, dropId: args.dropId });
  if (args.write && config.deploy.solanaCluster === 'mainnet-beta' && !args.allowMainnet) {
    throw new Error('Mainnet writes require both --write and --allow-mainnet. No transaction was signed or sent.');
  }
  const discount = buildDiscountMerkleData(resolveDeploymentDiscountAddresses({ root, config: config.onchain }));
  const registryPath = path.join(root, 'shared/deploymentRegistry.ts');
  let registry = await deps.readRegistry(registryPath);
  const plan = await createTwoConfigDeploymentPlan({ config, manifest, source: registry.drops[config.deploy.reuseProgramIdFromDropId || ''] });
  const { config: collectionConfig } = await deps.loadCollectionConfig({ root, collectionId: manifest.sourcePreorder.preorderId });
  if (collectionConfig.authority !== plan.authority || collectionConfig.solanaCluster !== plan.cluster) throw new Error('Preorder collection recipe has a different authority or cluster.');
  const savedCollection = JSON.parse(readFileSync(path.join(root, 'scripts/preorderCollectionDeployments', plan.cluster, `${collectionConfig.collectionId}.json`), 'utf8'));
  if (savedCollection.collectionMint !== plan.collection || savedCollection.config?.authority !== plan.authority) throw new Error('Saved preorder collection deployment does not match the selected collection.');
  const rpcUrl = resolveScriptSolanaRpcUrl({ cluster: plan.cluster, root,
    explicitUrl: config.deploy.solanaRpcUrl || process.env.MI_NOTE_PREORDER_RPC_URL });
  const connection = deps.createConnection(rpcUrl, plan.cluster);
  if (await connection.getGenesisHash() !== MI_NOTE_CLUSTER_GENESIS[plan.cluster]) throw new Error('Deployment RPC has the wrong cluster genesis.');
  await deps.verifyManifest(manifest);
  const gate = await deps.verifyGate({ cluster: plan.cluster, rpcUrl });
  if (gate.target.programs.find(program => program.name === 'box_minter')?.programId !== plan.programId) throw new Error('Source program differs from the locally tested shared program.');
  const discountDataset = await validateDiscountMerkleDatasetForDeploy({ root, dropId: plan.dropId, dropFamily: 'mi_note_cards', merkleRoot: discount.root, proofs: discount.proofs });
  const context: DeploymentContext = { config, plan, collectionConfig, discountRoot: discount.root };
  const journalPath = path.join(root, '.cache/two-config-deployments', plan.cluster, `${plan.dropId}.json`);
  const recordPath = path.join(root, 'releases', plan.dropId.replaceAll('_', '-'), 'deployment.json');
  const recorded = readJournal(journalPath, plan);
  let journal: DeploymentJournal = recorded?.journal || {
    version: 1, plan, createdAt: deps.now().toISOString(), transactions: [],
    collection: inspectCollection(await connection.getAccountInfo(new PublicKey(plan.collection), 'finalized'), plan, collectionConfig),
  };
  let journalSource = recorded?.source;
  const persist = () => { journalSource = writeDurableJson(journalPath, journal, journalSource); };
  const steps: StepKind[] = ['delegates', 'mint-config', 'operations-config', 'receipt-tree', 'lookup-table'];
  let finalizedSlot = Math.max(manifest.chain.slot, journal.finalizedSlot ?? 0,
    ...journal.transactions.map(entry => entry.finalizedSlot ?? 0));
  const states = [];
  for (const step of steps) {
    const state = await readStep(connection, step, context, journal, finalizedSlot);
    finalizedSlot = Math.max(finalizedSlot, state.slot);
    states.push({ step, ready: state.ready });
  }
  const validationRow = buildDeploymentRow(context, manifest, journal.lookupTable?.address || '');
  const registered = registry.drops[plan.dropId];
  if (registered && !isDeepStrictEqual(registered, validationRow)) throw new Error('An existing logical registry row conflicts with the deployment journal and recipe.');
  renderDeploymentRegistryFileFromSource({ filePath: registryPath, existingContent: registry.sourceContent,
    drops: { ...registry.drops, [plan.dropId]: validationRow }, tombstones: registry.tombstones });
  deps.log(JSON.stringify({ mode: args.write ? 'write' : 'read-only', ...plan, states,
    rpcHost: scriptSolanaRpcHost(rpcUrl),
    priceSol: config.onchain.priceSol, paymentRouting: config.onchain.paymentRouting,
    preorderCardsPreserved: manifest.excludedCardIds.length, inventoryCards: manifest.eligibleCardIds.length,
    receiptTreeRentLamports: await connection.getMinimumBalanceForRentExemption(plan.receiptTree.space, 'finalized'),
    gateCompletedAt: gate.gate.completedAt, journalPath, recordPath }, null, 2));
  if (!args.write) return { plan, ready: states.every(state => state.ready), recordPath };

  const release = acquireDeploymentRegistryMutationLock({ root, operation: `deploy-two-config:${plan.dropId}` });
  const cleanup = registerDeploymentCleanup({ releaseDeploymentRegistryLock: release });
  let signer: Keypair | undefined;
  try {
    const revalidate = async () => {
      registry = await deps.readRegistry(registryPath);
      if (readFileSync(manifestPath, 'utf8') !== manifestSource) throw new Error('Inventory manifest changed after review.');
      const fresh = await deps.loadConfig({ root, dropId: args.dropId });
      if (digest(fresh.config) !== plan.recipeSha256) throw new Error('Recipe changed after review.');
      if (!isDeepStrictEqual(buildDiscountMerkleData(resolveDeploymentDiscountAddresses({ root, config: fresh.config.onchain })), discount)) {
        throw new Error('Discount dataset changed after review.');
      }
      const freshPlan = await createTwoConfigDeploymentPlan({ config: fresh.config, manifest, source: registry.drops[config.deploy.reuseProgramIdFromDropId || ''] });
      if (!isDeepStrictEqual(freshPlan, plan)) throw new Error('Shared-program source changed after review.');
      await deps.verifyManifest(manifest);
      await deps.verifyGate({ cluster: plan.cluster, rpcUrl });
      for (const role of ['delegates', 'mint-config', 'operations-config'] as const) {
        const state = await readStep(connection, role, context, journal, finalizedSlot);
        finalizedSlot = Math.max(finalizedSlot, state.slot);
      }
    };
    await revalidate();
    if (!journalSource) persist();

    for (const step of steps) {
      const unresolved = journal.transactions.find(entry => entry.status === 'signed');
      if (unresolved) {
        const transaction = validateTwoConfigJournalTransaction(unresolved, plan.authority);
        assertRecoveryTransactionMatchesPlan(transaction, unresolved, context, journal);
        if (!isDeepStrictEqual(unresolved.resources, stepAddresses(unresolved.step, plan, journal))) throw new Error('Unresolved transaction resource addresses differ from the recovery journal.');
        const outcome = await inspectTwoConfigJournalTransaction(connection, unresolved);
        const effect = await readStep(connection, unresolved.step, context, journal, Math.max(finalizedSlot, outcome.slot || 0));
        finalizedSlot = Math.max(finalizedSlot, effect.slot);
        if (outcome.status === 'finalized' && !effect.ready) throw new Error('Finalized transaction has not produced the expected accounts; preserve the journal.');
        if (effect.ready) {
          unresolved.status = outcome.status === 'finalized' ? 'finalized' : 'state-verified';
          unresolved.finalizedSlot = effect.slot;
          persist();
        } else if (outcome.status === 'expired' || outcome.status === 'failed') {
          unresolved.status = outcome.status;
          persist();
        } else {
          deps.log(`Recovering ${unresolved.step} with the original signature ${unresolved.signature}; resources ${unresolved.resources.join(', ')}.`);
          if (!await confirm(`Recover ${unresolved.step} by resending the same signed transaction ${unresolved.signature} on ${plan.cluster}? Type y: `)) throw new Error('Cancelled; the public recovery journal is retained.');
          await revalidate();
          if (unresolved.step === 'delegates') await assertDelegateUpdatePreservesCollection(connection, transaction, context, journal, finalizedSlot);
          const signature = await connection.sendRawTransaction(transaction.serialize(), { skipPreflight: false, maxRetries: 3 });
          if (signature !== unresolved.signature) throw new Error('RPC returned a different recovery transaction signature.');
          const confirmation = await connection.confirmTransaction({ signature, blockhash: unresolved.blockhash, lastValidBlockHeight: unresolved.lastValidBlockHeight }, 'finalized');
          if (confirmation.value.err) throw new Error(`Recovery transaction failed; preserve the journal: ${JSON.stringify(confirmation.value.err)}`);
          const verified = await readStep(connection, unresolved.step, context, journal, confirmation.context.slot);
          if (!verified.ready) throw new Error('Recovered transaction state is not ready.');
          unresolved.status = 'finalized'; unresolved.finalizedSlot = verified.slot;
          finalizedSlot = Math.max(finalizedSlot, verified.slot); persist();
        }
      }
      const existing = await readStep(connection, step, context, journal, finalizedSlot);
      finalizedSlot = Math.max(finalizedSlot, existing.slot);
      if (existing.ready) continue;
      if (step === 'lookup-table') {
        const recentSlot = await connection.getSlot('finalized');
        const [, address] = AddressLookupTableProgram.createLookupTable({ authority: new PublicKey(plan.authority), payer: new PublicKey(plan.authority), recentSlot });
        journal.lookupTable = { address: address.toBase58(), recentSlot };
        persist();
      }
      const { instructions, rentLamports } = await buildStepInstructions(connection, step, context, journal);
      const blockhash = await connection.getLatestBlockhash('finalized');
      const transaction = new VersionedTransaction(new TransactionMessage({ payerKey: new PublicKey(plan.authority), recentBlockhash: blockhash.blockhash, instructions }).compileToV0Message());
      if (transaction.serialize().length > 1232) throw new Error(`${step} transaction exceeds Solana packet size.`);
      const resources = stepAddresses(step, plan, journal);
      const simulation = await connection.simulateTransaction(transaction, {
        sigVerify: false, commitment: 'finalized', minContextSlot: finalizedSlot,
        accounts: { encoding: 'base64', addresses: resources },
      });
      if (simulation.value.err) throw new Error(`${step} simulation failed: ${JSON.stringify(simulation.value.err)}\n${(simulation.value.logs || []).join('\n')}`);
      if (!simulation.value.accounts || !validateStepAccounts(step, simulation.value.accounts.map(simulationAccount), context, journal)) {
        throw new Error(`${step} simulation did not produce the exact expected state.`);
      }
      const before = await connection.getMultipleAccountsInfoAndContext(resources.map(value => new PublicKey(value)), { commitment: 'finalized', minContextSlot: finalizedSlot });
      const simulatedFunding = simulation.value.accounts.map(simulationAccount).reduce((total, account, index) =>
        total + Math.max(0, (account?.lamports || 0) - (before.value[index]?.lamports || 0)), 0);
      const fee = (await connection.getFeeForMessage(transaction.message, 'finalized')).value;
      if (!Number.isSafeInteger(fee) || Number(fee) < 0) throw new Error('RPC did not return a valid transaction fee.');
      deps.log(`${step}: simulation passed; payer ${plan.authority}; cluster ${plan.cluster}; fee ${fee} lamports; simulated account funding ${simulatedFunding} lamports (rent estimate ${rentLamports}); resources ${resources.join(', ')}.`);
      if (!await confirm(`Sign and send this ${step} transaction? Type y: `)) throw new Error('Cancelled; the public recovery journal is retained.');
      if (!signer) {
        signer = parsePrivateKeyInput(await deps.promptPrivateKey());
        if (signer.publicKey.toBase58() !== plan.authority) throw new Error('Signer does not match the existing collection authority.');
      }
      await revalidate();
      if (step === 'delegates') await assertDelegateUpdatePreservesCollection(connection, transaction, context, journal, finalizedSlot);
      if (await connection.getBlockHeight('finalized') > blockhash.lastValidBlockHeight) throw new Error('Transaction expired during confirmation; rerun to simulate a fresh transaction.');
      transaction.sign([signer]);
      const entry: TwoConfigJournalTransaction = {
        step, signature: bs58.encode(transaction.signatures[0]), transactionBase64: Buffer.from(transaction.serialize()).toString('base64'),
        blockhash: blockhash.blockhash, lastValidBlockHeight: blockhash.lastValidBlockHeight,
        resources, signedAt: deps.now().toISOString(), status: 'signed',
      };
      journal.transactions.push(entry); persist();
      const signature = await connection.sendRawTransaction(transaction.serialize(), { skipPreflight: false, maxRetries: 3 });
      if (signature !== entry.signature) throw new Error('RPC returned an unexpected transaction signature; preserve the recovery journal.');
      const confirmation = await connection.confirmTransaction({ ...blockhash, signature }, 'finalized');
      if (confirmation.value.err) throw new Error(`${step} failed; preserve the recovery journal: ${JSON.stringify(confirmation.value.err)}`);
      const verified = await readStep(connection, step, context, journal, confirmation.context.slot);
      if (!verified.ready) throw new Error(`${step} finalized state is incomplete.`);
      entry.status = 'finalized'; entry.finalizedSlot = verified.slot;
      finalizedSlot = Math.max(finalizedSlot, verified.slot); persist();
    }

    await revalidate();
    for (const step of steps) {
      const state = await readStep(connection, step, context, journal, finalizedSlot);
      if (!state.ready) throw new Error(`Cannot register the drop before ${step} is finalized.`);
      finalizedSlot = Math.max(finalizedSlot, state.slot);
    }
    const row = buildDeploymentRow(context, manifest, journal.lookupTable!.address);
    registry = await deps.readRegistry(registryPath);
    if (registry.drops[plan.dropId] && !isDeepStrictEqual(registry.drops[plan.dropId], row)) throw new Error('An existing registry row conflicts with the finalized deployment.');
    const nextContent = renderDeploymentRegistryFileFromSource({ filePath: registryPath, existingContent: registry.sourceContent,
      drops: { ...registry.drops, [plan.dropId]: row }, tombstones: registry.tombstones });
    await finalizeDiscountMerkleAndDeploymentRegistry({
      root: discount.root, proofs: discount.proofs, filePath: discountDataset.filePath,
      commitRegistryChanges: async () => writeDeploymentRegistryFile({ filePath: registryPath, expectedContent: registry.sourceContent, nextContent }),
    });
    const committed = await deps.readRegistry(registryPath);
    if (!isDeepStrictEqual(committed.drops[plan.dropId], row)) {
      const actual = committed.drops[plan.dropId];
      const fields = [...new Set([...Object.keys(row), ...Object.keys(actual || {})])].filter(key => !isDeepStrictEqual(actual?.[key], row[key]));
      throw new Error(`Finalized registry row could not be verified (${fields.join(', ')}); preserve the journal.`);
    }
    journal.finalizedSlot = finalizedSlot; persist();
    const record = { version: 1, plan, drop: row, finalizedSlot, deployedAt: journal.createdAt,
      transactions: journal.transactions, gate: gate.gate, preorderMetadataPreserved: true, mintStarted: false };
    if (existsSync(recordPath)) {
      const previous = JSON.parse(readFileSync(recordPath, 'utf8'));
      if (!isDeepStrictEqual(previous.plan, plan) || !isDeepStrictEqual(previous.drop, row)) throw new Error('A different public deployment record already exists.');
    } else writeDurableJson(recordPath, record);
    deps.log(`Both roles and receipts are finalized. Registry and public record saved. Mint remains stopped. ${recordPath}`);
    return { plan, ready: true, recordPath };
  } finally {
    signer?.secretKey.fill(0);
    cleanup.cleanup();
  }
}

async function main() {
  const args = parseTwoConfigDeploymentArgs(process.argv.slice(2));
  if (!args) { console.log(`${USAGE}\nDefault is read-only. This command never deploys a program or starts minting.`); return; }
  await runTwoConfigDropDeployment(args);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
}
