import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  clusterApiUrl,
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionMessage,
  VersionedTransaction,
  type Commitment,
} from '@solana/web3.js';
import bs58 from 'bs58';
import {
  BUBBLEGUM_PROGRAM_ADDRESS,
  MPL_ACCOUNT_COMPRESSION_PROGRAM_ADDRESS,
  MPL_CORE_PROGRAM_ADDRESS,
  MPL_NOOP_PROGRAM_ADDRESS,
} from '../shared/solanaProgramAddresses.ts';
import {
  receiptPoolDeploymentKey,
  type ReceiptPoolDeployment,
} from '../shared/deploymentRegistry.ts';
import {
  acquireDeploymentRegistryMutationLock,
  assertReceiptPoolDropRelations,
  readDeploymentDropRegistry,
  renderReceiptPoolDeploymentsFileFromSource,
  writeDeploymentRegistryFile,
} from './shared/deploymentRegistry.ts';
import {
  parsePrivateKeyInput,
  promptMaskedInput,
  promptYConfirmation,
} from './shared/interactive.ts';
import {
  receiptPoolJournalPathSegment,
  requireReceiptPoolSpec,
  type ReceiptPoolSpec,
} from './shared/receiptPoolConfig.ts';
import type { SolanaCluster } from './shared/newDropConfig.ts';
import {
  buildCreateBubblegumTreeConfigV2Ix,
  buildCreateMplCoreCollectionV2Ix,
  getConcurrentMerkleTreeAccountSize,
  validateReceiptPoolDeploymentOnchain,
} from './deploy-all-onchain.ts';

type ReceiptPoolDeployJournal = {
  version: 1;
  solanaCluster: SolanaCluster;
  receiptPoolId: string;
  collectionMint: string;
  receiptsMerkleTree: string;
  blockhash: string;
  lastValidBlockHeight: number;
  transactionSignature: string;
  createdAt: string;
};

export type ReceiptPoolJournalRetryState =
  | 'recover'
  | 'partial'
  | 'wait_for_expiry'
  | 'regenerate';

export const RECEIPT_POOL_FINALIZED_COMMITMENT =
  'finalized' as const satisfies Commitment;

export type ReceiptPoolSolanaCluster = Extract<
  SolanaCluster,
  'devnet' | 'mainnet-beta'
>;

export const RECEIPT_POOL_CLUSTER_GENESIS_HASHES: Readonly<
  Record<ReceiptPoolSolanaCluster, string>
> = {
  devnet: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
  'mainnet-beta': '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
};

export function assertReceiptPoolRpcGenesisHash(args: {
  solanaCluster: ReceiptPoolSolanaCluster;
  genesisHash: string;
}): void {
  const expected = RECEIPT_POOL_CLUSTER_GENESIS_HASHES[args.solanaCluster];
  if (args.genesisHash !== expected) {
    throw new Error(
      `Receipt pool RPC genesis hash mismatch for ${args.solanaCluster}: expected ${expected}, got ${args.genesisHash}`,
    );
  }
}

export function classifyReceiptPoolJournalRetry(args: {
  collectionExists: boolean;
  treeExists: boolean;
  currentBlockHeight: number;
  lastValidBlockHeight: number;
}): ReceiptPoolJournalRetryState {
  if (args.collectionExists !== args.treeExists) return 'partial';
  if (args.collectionExists) return 'recover';
  return args.currentBlockHeight <= args.lastValidBlockHeight
    ? 'wait_for_expiry'
    : 'regenerate';
}

function requireCluster(
  value: string | undefined,
): ReceiptPoolSolanaCluster {
  if (value === 'devnet' || value === 'mainnet-beta') return value;
  throw new Error(
    'Cluster must be devnet or mainnet-beta.\nRun: npm run deploy-receipt-pool -- mons_shop_receipts devnet',
  );
}

async function assertMetadataJson(spec: ReceiptPoolSpec): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  let response: Response;
  try {
    response = await fetch(spec.collectionMetadataUri, {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok) {
    throw new Error(
      `Receipt pool metadata returned ${response.status}: ${spec.collectionMetadataUri}`,
    );
  }
  const value = (await response.json()) as Record<string, unknown>;
  const properties =
    value.properties &&
    typeof value.properties === 'object' &&
    !Array.isArray(value.properties)
      ? (value.properties as Record<string, unknown>)
      : {};
  const creators = Array.isArray(properties.creators)
    ? properties.creators
    : [];
  const creator = creators[0] as Record<string, unknown> | undefined;
  const mismatches = [
    value.name === spec.collectionName ? '' : 'name',
    value.symbol === spec.collectionSymbol ? '' : 'symbol',
    value.description === spec.collectionDescription ? '' : 'description',
    value.external_url === spec.collectionExternalUrl
      ? ''
      : 'external_url',
    value.image === spec.collectionImage ? '' : 'image',
    value.seller_fee_basis_points === spec.royaltiesBasisPoints
      ? ''
      : 'seller_fee_basis_points',
    creators.length === 1 &&
    creator?.address === spec.royaltiesRecipient &&
    creator?.share === 100
      ? ''
      : 'creators',
  ].filter(Boolean);
  if (mismatches.length) {
    throw new Error(
      `Receipt pool metadata mismatch in ${mismatches.join(', ')}: ${spec.collectionMetadataUri}`,
    );
  }
}

function deploymentFromSpec(args: {
  spec: ReceiptPoolSpec;
  solanaCluster: SolanaCluster;
  collectionMint: PublicKey;
  receiptsMerkleTree: PublicKey;
}): ReceiptPoolDeployment {
  return {
    solanaCluster: args.solanaCluster,
    receiptPoolId: args.spec.receiptPoolId,
    collectionMint: args.collectionMint.toBase58(),
    receiptsMerkleTree: args.receiptsMerkleTree.toBase58(),
    authority: args.spec.authority,
    collectionMetadataUri: args.spec.collectionMetadataUri,
    collectionName: args.spec.collectionName,
    collectionSymbol: args.spec.collectionSymbol,
    royaltiesBasisPoints: args.spec.royaltiesBasisPoints,
    royaltiesRecipient: args.spec.royaltiesRecipient,
    receiptsTreeMaxDepth: args.spec.receiptsTree.maxDepth,
    receiptsTreeMaxBufferSize: args.spec.receiptsTree.maxBufferSize,
    receiptsTreeCanopyDepth: args.spec.receiptsTree.canopyDepth,
  };
}

export function assertReceiptPoolDeploymentMatchesSpec(args: {
  deployment: ReceiptPoolDeployment;
  spec: ReceiptPoolSpec;
  solanaCluster: SolanaCluster;
}): void {
  const expected = deploymentFromSpec({
    spec: args.spec,
    solanaCluster: args.solanaCluster,
    collectionMint: new PublicKey(args.deployment.collectionMint),
    receiptsMerkleTree: new PublicKey(
      args.deployment.receiptsMerkleTree,
    ),
  });
  for (const key of Object.keys(expected) as Array<
    keyof ReceiptPoolDeployment
  >) {
    if (args.deployment[key] !== expected[key]) {
      throw new Error(
        `Receipt pool deployment ${key} mismatch: expected ${String(expected[key])}, got ${String(args.deployment[key])}`,
      );
    }
  }
}

async function validateDeployment(args: {
  connection: Connection;
  deployment: ReceiptPoolDeployment;
  spec: ReceiptPoolSpec;
  solanaCluster: SolanaCluster;
  commitment: Commitment;
}): Promise<void> {
  assertReceiptPoolDeploymentMatchesSpec(args);
  await validateReceiptPoolDeploymentOnchain({
    connection: args.connection,
    collectionMint: new PublicKey(args.deployment.collectionMint),
    receiptsMerkleTree: new PublicKey(
      args.deployment.receiptsMerkleTree,
    ),
    authority: new PublicKey(args.spec.authority),
    collectionMetadataUri: args.spec.collectionMetadataUri,
    collectionName: args.spec.collectionName,
    royaltiesBasisPoints: args.spec.royaltiesBasisPoints,
    royaltiesRecipient: new PublicKey(args.spec.royaltiesRecipient),
    receiptsTreeMaxDepth: args.spec.receiptsTree.maxDepth,
    receiptsTreeMaxBufferSize:
      args.spec.receiptsTree.maxBufferSize,
    receiptsTreeCanopyDepth: args.spec.receiptsTree.canopyDepth,
    commitment: args.commitment,
  });
}

export async function completeReceiptPoolJournal(args: {
  journalPath: string;
  finalize: () => Promise<void>;
  commit?: () => Promise<void>;
  removeJournal?: (journalPath: string) => void;
}): Promise<void> {
  await args.finalize();
  await args.commit?.();
  (args.removeJournal || ((journalPath) => rmSync(journalPath, { force: true })))(
    args.journalPath,
  );
}

function readJournal(filePath: string): ReceiptPoolDeployJournal | null {
  if (!existsSync(filePath)) return null;
  const value = JSON.parse(
    readFileSync(filePath, 'utf8'),
  ) as ReceiptPoolDeployJournal;
  if (
    value.version !== 1 ||
    !value.collectionMint ||
    !value.receiptsMerkleTree ||
    !value.blockhash ||
    !Number.isInteger(value.lastValidBlockHeight) ||
    !value.transactionSignature
  ) {
    throw new Error(`Invalid receipt pool deployment journal: ${filePath}`);
  }
  return value;
}

function writeJournal(
  filePath: string,
  journal: ReceiptPoolDeployJournal,
): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(journal, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
}

async function commitPoolDeployment(args: {
  root: string;
  deployment: ReceiptPoolDeployment;
}): Promise<void> {
  const registryPath = path.join(
    args.root,
    'shared',
    'deploymentRegistry.ts',
  );
  const release = acquireDeploymentRegistryMutationLock({
    root: args.root,
    operation: `deploy receipt pool ${args.deployment.receiptPoolId}`,
  });
  try {
    const registry = await readDeploymentDropRegistry(registryPath);
    const key = receiptPoolDeploymentKey(
      args.deployment.solanaCluster,
      args.deployment.receiptPoolId,
    );
    const existing = registry.receiptPools[key];
    if (existing) {
      if (JSON.stringify(existing) !== JSON.stringify(args.deployment)) {
        throw new Error(`Receipt pool registry row already conflicts: ${key}`);
      }
      return;
    }
    const nextReceiptPools = {
      ...registry.receiptPools,
      [key]: args.deployment,
    };
    assertReceiptPoolDropRelations({
      drops: registry.drops,
      receiptPools: nextReceiptPools,
    });
    const nextContent = renderReceiptPoolDeploymentsFileFromSource({
      filePath: registryPath,
      existingContent: registry.sourceContent,
      receiptPools: nextReceiptPools,
    });
    writeDeploymentRegistryFile({
      filePath: registryPath,
      expectedContent: registry.sourceContent,
      nextContent,
    });
    const written = await readDeploymentDropRegistry(registryPath);
    if (
      JSON.stringify(written.receiptPools[key]) !==
      JSON.stringify(args.deployment)
    ) {
      throw new Error(`Receipt pool registry verification failed: ${key}`);
    }
  } finally {
    release();
  }
}

async function assertRequiredPrograms(
  connection: Connection,
): Promise<void> {
  const programs = [
    MPL_CORE_PROGRAM_ADDRESS,
    BUBBLEGUM_PROGRAM_ADDRESS,
    MPL_ACCOUNT_COMPRESSION_PROGRAM_ADDRESS,
    MPL_NOOP_PROGRAM_ADDRESS,
  ].map((address) => new PublicKey(address));
  const accounts = await connection.getMultipleAccountsInfo(programs, {
    commitment: 'confirmed',
  });
  accounts.forEach((account, index) => {
    if (!account?.executable) {
      throw new Error(
        `Required Solana program is unavailable: ${programs[index].toBase58()}`,
      );
    }
  });
}

async function main(): Promise<void> {
  const [receiptPoolId, clusterArg, ...extra] = process.argv.slice(2);
  if (!receiptPoolId || !clusterArg || extra.length) {
    throw new Error(
      'Run: npm run deploy-receipt-pool -- mons_shop_receipts devnet',
    );
  }
  const spec = requireReceiptPoolSpec(receiptPoolId);
  const solanaCluster = requireCluster(clusterArg);
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const registryPath = path.join(
    root,
    'shared',
    'deploymentRegistry.ts',
  );
  const rpcUrl =
    String(process.env.SOLANA_RPC_URL || '').trim() ||
    clusterApiUrl(solanaCluster);
  const connection = new Connection(rpcUrl, {
    commitment: 'confirmed',
  });
  assertReceiptPoolRpcGenesisHash({
    solanaCluster,
    genesisHash: await connection.getGenesisHash(),
  });
  await Promise.all([
    assertMetadataJson(spec),
    assertRequiredPrograms(connection),
  ]);
  const registry = await readDeploymentDropRegistry(registryPath);
  const key = receiptPoolDeploymentKey(
    solanaCluster,
    spec.receiptPoolId,
  );
  const journalPath = path.join(
    root,
    '.cache',
    'receipt-pool-deployments',
    `${receiptPoolJournalPathSegment({
      solanaCluster,
      receiptPoolId: spec.receiptPoolId,
    })}.json`,
  );
  const existing = registry.receiptPools[key];
  if (existing) {
    await completeReceiptPoolJournal({
      journalPath,
      finalize: () =>
        validateDeployment({
          connection,
          deployment: existing,
          spec,
          solanaCluster,
          commitment: RECEIPT_POOL_FINALIZED_COMMITMENT,
        }),
    });
    console.log(`Receipt pool is already deployed and valid: ${key}`);
    return;
  }
  const journal = readJournal(journalPath);
  if (journal) {
    if (
      journal.solanaCluster !== solanaCluster ||
      journal.receiptPoolId !== spec.receiptPoolId
    ) {
      throw new Error(
        `Receipt pool journal identity mismatch: ${journalPath}`,
      );
    }
    const collectionMint = new PublicKey(journal.collectionMint);
    const receiptsMerkleTree = new PublicKey(
      journal.receiptsMerkleTree,
    );
    const currentBlockHeight = await connection.getBlockHeight(
      RECEIPT_POOL_FINALIZED_COMMITMENT,
    );
    const [collectionInfo, treeInfo] =
      await connection.getMultipleAccountsInfo(
        [collectionMint, receiptsMerkleTree],
        { commitment: RECEIPT_POOL_FINALIZED_COMMITMENT },
      );
    const retryState = classifyReceiptPoolJournalRetry({
      collectionExists: Boolean(collectionInfo),
      treeExists: Boolean(treeInfo),
      currentBlockHeight,
      lastValidBlockHeight: journal.lastValidBlockHeight,
    });
    if (retryState === 'partial') {
      throw new Error(
        `Receipt pool journal has a partial on-chain deployment: ${journalPath}`,
      );
    }
    if (retryState === 'recover' && collectionInfo && treeInfo) {
      const deployment = deploymentFromSpec({
        spec,
        solanaCluster,
        collectionMint,
        receiptsMerkleTree,
      });
      await completeReceiptPoolJournal({
        journalPath,
        finalize: () =>
          validateDeployment({
            connection,
            deployment,
            spec,
            solanaCluster,
            commitment: RECEIPT_POOL_FINALIZED_COMMITMENT,
          }),
        commit: () => commitPoolDeployment({ root, deployment }),
      });
      console.log(`Recovered and registered receipt pool: ${key}`);
      return;
    }
    if (retryState === 'wait_for_expiry') {
      throw new Error(
        `Receipt pool transaction is still live through block height ${journal.lastValidBlockHeight}; current height is ${currentBlockHeight}. Wait for expiry before regenerating addresses: ${journalPath}`,
      );
    }
  }

  console.log('Enter the receipt pool authority private key.');
  const payer = parsePrivateKeyInput(
    await promptMaskedInput('receipt pool authority private key: '),
  );
  const authority = new PublicKey(spec.authority);
  if (!payer.publicKey.equals(authority)) {
    throw new Error(
      `Receipt pool authority mismatch: expected ${authority.toBase58()}, got ${payer.publicKey.toBase58()}`,
    );
  }
  const collection = Keypair.generate();
  const merkleTree = Keypair.generate();
  const treeSpace = getConcurrentMerkleTreeAccountSize(
    spec.receiptsTree.maxDepth,
    spec.receiptsTree.maxBufferSize,
    spec.receiptsTree.canopyDepth,
  );
  const treeRent = await connection.getMinimumBalanceForRentExemption(
    treeSpace,
    'confirmed',
  );
  const createCollection = buildCreateMplCoreCollectionV2Ix({
    collection: collection.publicKey,
    updateAuthority: payer.publicKey,
    updateDelegates: [payer.publicKey],
    payer: payer.publicKey,
    systemProgram: SystemProgram.programId,
    name: spec.collectionName,
    uri: spec.collectionMetadataUri,
    royaltiesBps: spec.royaltiesBasisPoints,
    royaltiesRecipient: new PublicKey(spec.royaltiesRecipient),
    royaltiesAuthority: null,
  });
  const createTreeAccount = SystemProgram.createAccount({
    fromPubkey: payer.publicKey,
    newAccountPubkey: merkleTree.publicKey,
    lamports: treeRent,
    space: treeSpace,
    programId: new PublicKey(MPL_ACCOUNT_COMPRESSION_PROGRAM_ADDRESS),
  });
  const createTreeConfig = buildCreateBubblegumTreeConfigV2Ix({
    merkleTree: merkleTree.publicKey,
    payer: payer.publicKey,
    treeCreator: payer.publicKey,
    maxDepth: spec.receiptsTree.maxDepth,
    maxBufferSize: spec.receiptsTree.maxBufferSize,
    isPublic: null,
  });
  const transaction = new Transaction().add(
    createCollection,
    createTreeAccount,
    createTreeConfig,
  );
  transaction.feePayer = payer.publicKey;
  const latestBlockhash =
    await connection.getLatestBlockhash('confirmed');
  transaction.recentBlockhash = latestBlockhash.blockhash;
  const message = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: latestBlockhash.blockhash,
    instructions: transaction.instructions,
  }).compileToV0Message();
  const signedTransaction = new VersionedTransaction(message);
  signedTransaction.sign([payer, collection, merkleTree]);
  const transactionSignature = bs58.encode(
    signedTransaction.signatures[0],
  );
  const simulation = await connection.simulateTransaction(
    signedTransaction,
    {
      commitment: 'confirmed',
      sigVerify: true,
      accounts: {
        encoding: 'base64',
        addresses: [payer.publicKey.toBase58()],
      },
    },
  );
  if (simulation.value.err) {
    throw new Error(
      `Receipt pool simulation failed: ${JSON.stringify(simulation.value.err)}\n${simulation.value.logs?.join('\n') || ''}`,
    );
  }
  const fee =
    (
      await connection.getFeeForMessage(
        message,
        'confirmed',
      )
    ).value ?? 0;
  const payerBalance = await connection.getBalance(
    payer.publicKey,
    'confirmed',
  );
  const simulatedPayerBalance =
    simulation.value.accounts?.[0]?.lamports;
  const totalSpendEstimate =
    simulatedPayerBalance == null
      ? null
      : Math.max(0, payerBalance - simulatedPayerBalance);

  console.log('');
  console.log(`cluster: ${solanaCluster}`);
  console.log(`rpc: ${rpcUrl}`);
  console.log(`payer: ${payer.publicKey.toBase58()}`);
  console.log(`collection: ${collection.publicKey.toBase58()}`);
  console.log(`receipt tree: ${merkleTree.publicKey.toBase58()}`);
  console.log(`tree rent: ${treeRent} lamports`);
  console.log(`transaction fee estimate: ${fee} lamports`);
  if (totalSpendEstimate != null) {
    console.log(
      `total simulated payer spend: ${totalSpendEstimate} lamports`,
    );
  }
  if (!(await promptYConfirmation('Send this transaction? Type y: '))) {
    throw new Error('Cancelled');
  }

  writeJournal(journalPath, {
    version: 1,
    solanaCluster,
    receiptPoolId: spec.receiptPoolId,
    collectionMint: collection.publicKey.toBase58(),
    receiptsMerkleTree: merkleTree.publicKey.toBase58(),
    blockhash: latestBlockhash.blockhash,
    lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
    transactionSignature,
    createdAt: new Date().toISOString(),
  });
  const signature = await connection.sendRawTransaction(
    signedTransaction.serialize(),
    {
      skipPreflight: true,
      maxRetries: 3,
    },
  );
  if (signature !== transactionSignature) {
    throw new Error(
      `RPC returned unexpected transaction signature ${signature}`,
    );
  }
  const deployment = deploymentFromSpec({
    spec,
    solanaCluster,
    collectionMint: collection.publicKey,
    receiptsMerkleTree: merkleTree.publicKey,
  });
  await completeReceiptPoolJournal({
    journalPath,
    finalize: async () => {
      const confirmation = await connection.confirmTransaction(
        {
          signature,
          blockhash: latestBlockhash.blockhash,
          lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
        },
        RECEIPT_POOL_FINALIZED_COMMITMENT,
      );
      if (confirmation.value.err) {
        throw new Error(
          `Receipt pool transaction failed: ${JSON.stringify(confirmation.value.err)}`,
        );
      }
      await validateDeployment({
        connection,
        deployment,
        spec,
        solanaCluster,
        commitment: RECEIPT_POOL_FINALIZED_COMMITMENT,
      });
    },
    commit: () => commitPoolDeployment({ root, deployment }),
  });
  console.log(`Receipt pool deployed: ${signature}`);
  console.log(`Registry key: ${key}`);
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  return Boolean(
    entry && path.resolve(entry) === fileURLToPath(import.meta.url),
  );
}

if (isDirectRun()) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
