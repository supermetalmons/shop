import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import {
  clusterApiUrl,
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
  type AccountInfo,
} from '@solana/web3.js';
import bs58 from 'bs58';
import { MPL_CORE_PROGRAM_ADDRESS } from '../shared/solanaProgramAddresses.ts';
import {
  buildCreateMplCoreCollectionV2Ix,
  decodeMplCoreCollectionBase,
  decodeMplCoreCollectionRoyalties,
  decodeMplCoreCollectionUpdateDelegates,
  parseCollectionRoyaltyCreators,
  readMplCoreCollectionPluginRecords,
} from './deploy-all-onchain.ts';
import { assertReceiptPoolRpcGenesisHash } from './deploy-receipt-pool.ts';
import { normalizeAndValidateDropId, resolveDropAssetUrl } from './shared/deploymentRegistry.ts';
import { parsePrivateKeyInput, promptMaskedInput, promptYConfirmation } from './shared/interactive.ts';
import {
  loadPreorderCollectionConfig,
  preparePreorderCollectionConfig,
  type PreparedPreorderCollectionConfig,
} from './shared/preorderCollectionConfig.ts';

type PreorderCollectionSnapshot = Omit<PreparedPreorderCollectionConfig, 'solanaRpcUrl'>;

export type PreorderCollectionDeployment = {
  version: 1;
  config: PreorderCollectionSnapshot;
  collectionMint: string;
  transactionSignature: string;
  deployedAt: string;
  finalizedSlot: number;
};

type PreorderCollectionJournal = {
  version: 1;
  config: PreorderCollectionSnapshot;
  collectionMint: string;
  transactionSignature: string;
  blockhash: string;
  lastValidBlockHeight: number;
  createdAt: string;
};

export type PreorderCollectionDeployDependencies = {
  createConnection: (rpcUrl: string) => Connection;
  fetch: typeof fetch;
  promptPrivateKey: () => Promise<string>;
  confirm: (prompt: string) => Promise<boolean>;
  log: (message: string) => void;
  now: () => Date;
  generateCollection: () => Keypair;
};

const CORE_PROGRAM = new PublicKey(MPL_CORE_PROGRAM_ADDRESS);
const USAGE = 'npm run deploy-preorder-collection -- <collectionId>';

export function parsePreorderCollectionArgs(argv: string[]): string | null {
  if (argv.length === 1 && argv[0] === '--help') return null;
  if (argv.length !== 1) throw new Error(`Exactly one collectionId is required.\nRun: ${USAGE}`);
  return normalizeAndValidateDropId(argv[0], 'collectionId');
}

function snapshot(config: PreparedPreorderCollectionConfig): PreorderCollectionSnapshot {
  return {
    collectionId: config.collectionId,
    solanaCluster: config.solanaCluster,
    authority: config.authority,
    collectionMetadataUri: config.collectionMetadataUri,
    collectionMetadata: structuredClone(config.collectionMetadata),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function assertPreorderCollectionMetadata(
  config: PreparedPreorderCollectionConfig,
  value: unknown,
): void {
  if (!isRecord(value)) throw new Error('Collection metadata JSON must be an object');
  const expected = config.collectionMetadata;
  const fields = {
    name: expected.name,
    symbol: expected.symbol,
    description: expected.description,
    image: expected.image,
    external_url: expected.externalUrl,
    seller_fee_basis_points: expected.sellerFeeBasisPoints,
  };
  const mismatches = Object.entries(fields)
    .filter(([key, wanted]) => value[key] !== wanted)
    .map(([key]) => key);
  const creators = parseCollectionRoyaltyCreators(value).map((creator) => ({
    address: creator.address.toBase58(),
    share: creator.percentage,
  }));
  if (!isDeepStrictEqual(creators, expected.creators)) mismatches.push('properties.creators');
  if (mismatches.length) {
    throw new Error(`Collection metadata mismatch in ${mismatches.join(', ')}: ${config.collectionMetadataUri}`);
  }
}

async function validateHostedMetadata(config: PreparedPreorderCollectionConfig, fetchMetadata: typeof fetch): Promise<void> {
  const response = await fetchMetadata(resolveDropAssetUrl(config.collectionMetadataUri), {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Collection metadata returned HTTP ${response.status}`);
  assertPreorderCollectionMetadata(config, await response.json());
}

export function validatePreorderCollectionAccount(args: {
  config: PreparedPreorderCollectionConfig;
  account: AccountInfo<Buffer> | null;
}): void {
  const { config, account } = args;
  if (!account || account.executable || !account.owner.equals(CORE_PROGRAM)) {
    throw new Error('Missing preorder collection or unexpected Core account owner');
  }
  const data = Buffer.from(account.data);
  const base = decodeMplCoreCollectionBase(data);
  if (!base.updateAuthority.equals(new PublicKey(config.authority))) {
    throw new Error('Preorder collection update authority mismatch');
  }
  if (base.name !== config.collectionMetadata.name || base.uri !== config.collectionMetadataUri) {
    throw new Error('Preorder collection name or metadata URI mismatch');
  }
  const plugins = readMplCoreCollectionPluginRecords(data);
  if (
    !plugins ||
    !isDeepStrictEqual(plugins.map((plugin) => plugin.pluginType).sort((a, b) => a - b), [0, 4, 15]) ||
    plugins.some((plugin) => data[plugin.offset] !== plugin.pluginType)
  ) {
    throw new Error('Preorder collection must have only Royalties, UpdateDelegate, and BubblegumV2 plugins with mutable metadata');
  }
  const royalties = decodeMplCoreCollectionRoyalties(data);
  if (
    !royalties || royalties.authorityKind !== 2 || royalties.ruleSetKind !== 0 ||
    royalties.basisPoints !== config.collectionMetadata.sellerFeeBasisPoints ||
    !isDeepStrictEqual(
      royalties.creators.map((creator) => ({ address: creator.address.toBase58(), share: creator.percentage })),
      config.collectionMetadata.creators,
    )
  ) throw new Error('Preorder collection royalties mismatch');
  const delegates = decodeMplCoreCollectionUpdateDelegates(data);
  if (
    !delegates || delegates.authorityKind !== 2 || delegates.delegates.length !== 1 ||
    !delegates.delegates[0].equals(new PublicKey(config.authority))
  ) throw new Error('Preorder collection UpdateDelegate must be controlled by UpdateAuthority and delegate only to the deployer');
}

function syncDirectory(directory: string): void {
  const descriptor = openSync(directory, 'r');
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
}

function writePublicRecord(filePath: string, record: unknown): void {
  const content = `${JSON.stringify(record, null, 2)}\n`;
  if (existsSync(filePath)) {
    if (readFileSync(filePath, 'utf8') === content) return;
    throw new Error(`Conflicting preorder deployment file; refusing to overwrite: ${filePath}`);
  }
  const directory = path.dirname(filePath);
  mkdirSync(directory, { recursive: true });
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporaryPath, 'wx', 0o600);
    writeFileSync(descriptor, content, 'utf8');
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    linkSync(temporaryPath, filePath);
    syncDirectory(directory);
    if (readFileSync(filePath, 'utf8') !== content) throw new Error(`Preorder deployment file verification failed: ${filePath}`);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    rmSync(temporaryPath, { force: true });
  }
}

function acquireLock(lockPath: string): () => void {
  mkdirSync(path.dirname(lockPath), { recursive: true });
  const contents = JSON.stringify({ pid: process.pid, token: randomUUID() });
  try {
    writeFileSync(lockPath, contents, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    throw new Error(`Another preorder collection deployment may be running. Lock: ${lockPath}\nRemove a stale lock only after verifying its process has stopped; keep the deployment journal.`);
  }
  return () => {
    if (existsSync(lockPath) && readFileSync(lockPath, 'utf8') === contents) rmSync(lockPath);
  };
}

function requireBase58(value: unknown, bytes: number, label: string): string {
  if (typeof value === 'string') {
    try {
      const decoded = bs58.decode(value);
      if (decoded.length === bytes && decoded.some((byte) => byte !== 0)) return value;
    } catch {}
  }
  throw new Error(`Invalid ${label} in preorder deployment record`);
}

function requireTimestamp(value: unknown): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw new Error('Invalid timestamp in preorder deployment record');
  }
  return value;
}

function readPublicRecord(
  filePath: string,
  config: PreparedPreorderCollectionConfig,
  kind: 'deployment' | 'journal',
): PreorderCollectionDeployment | PreorderCollectionJournal | null {
  if (!existsSync(filePath)) return null;
  const value: unknown = JSON.parse(readFileSync(filePath, 'utf8'));
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.config)) {
    throw new Error(`Invalid preorder ${kind}: ${filePath}`);
  }
  const recorded = preparePreorderCollectionConfig({
    ...value.config,
    isMainnet: value.config.solanaCluster === 'mainnet-beta',
  }, config.collectionId);
  if (!isDeepStrictEqual(value.config, snapshot(recorded)) || !isDeepStrictEqual(value.config, snapshot(config))) {
    throw new Error(`Preorder ${kind} configuration conflicts with the selected config: ${filePath}`);
  }
  const common = {
    version: 1 as const,
    config: snapshot(recorded),
    collectionMint: requireBase58(value.collectionMint, 32, 'collection address'),
    transactionSignature: requireBase58(value.transactionSignature, 64, 'transaction signature'),
  };
  if (kind === 'deployment') {
    if (!Number.isSafeInteger(value.finalizedSlot) || Number(value.finalizedSlot) < 0) {
      throw new Error(`Invalid finalized slot in ${filePath}`);
    }
    return { ...common, deployedAt: requireTimestamp(value.deployedAt), finalizedSlot: Number(value.finalizedSlot) };
  }
  if (!Number.isSafeInteger(value.lastValidBlockHeight) || Number(value.lastValidBlockHeight) < 0) {
    throw new Error(`Invalid last valid block height in ${filePath}`);
  }
  return {
    ...common,
    blockhash: requireBase58(value.blockhash, 32, 'blockhash'),
    lastValidBlockHeight: Number(value.lastValidBlockHeight),
    createdAt: requireTimestamp(value.createdAt),
  };
}

function printDeployment(record: PreorderCollectionDeployment, filePath: string, log: (message: string) => void): void {
  log(`Collection verified on ${record.config.solanaCluster}: ${record.collectionMint}`);
  log(`coreCollectionPubkey: '${record.collectionMint}',`);
  log(`Deployment record: ${filePath}`);
  log('Before reusing this collection for a drop, add that drop\'s config PDA to the collection UpdateDelegate plugin.');
}

export async function runPreorderCollectionDeployment(
  args: { root: string; collectionId: string },
  overrides: Partial<PreorderCollectionDeployDependencies> = {},
): Promise<PreorderCollectionDeployment | null> {
  const deps: PreorderCollectionDeployDependencies = {
    createConnection: (rpcUrl) => new Connection(rpcUrl, 'confirmed'),
    fetch: globalThis.fetch,
    promptPrivateKey: () => promptMaskedInput('deployer private key: '),
    confirm: promptYConfirmation,
    log: console.log,
    now: () => new Date(),
    generateCollection: () => Keypair.generate(),
    ...overrides,
  };
  const { config, configPath } = await loadPreorderCollectionConfig(args);
  const configuration = snapshot(config);
  const stateDirectory = path.join(args.root, '.cache', 'preorder-collection-deployments', config.solanaCluster);
  const journalPath = path.join(stateDirectory, `${config.collectionId}.json`);
  const recordPath = path.join(args.root, 'scripts', 'preorderCollectionDeployments', config.solanaCluster, `${config.collectionId}.json`);
  const release = acquireLock(path.join(stateDirectory, `${config.collectionId}.lock`));
  try {
    const connection = deps.createConnection(config.solanaRpcUrl || clusterApiUrl(config.solanaCluster));
    assertReceiptPoolRpcGenesisHash({ solanaCluster: config.solanaCluster, genesisHash: await connection.getGenesisHash() });
    const program = await connection.getAccountInfo(CORE_PROGRAM, 'finalized');
    if (!program?.executable) throw new Error('Metaplex Core program is unavailable on the selected RPC');

    const existing = readPublicRecord(recordPath, config, 'deployment') as PreorderCollectionDeployment | null;
    const journal = readPublicRecord(journalPath, config, 'journal') as PreorderCollectionJournal | null;
    if (existing) {
      if (journal && (journal.collectionMint !== existing.collectionMint || journal.transactionSignature !== existing.transactionSignature)) {
        throw new Error('Preorder journal conflicts with the completed deployment record');
      }
      const result = await connection.getAccountInfoAndContext(new PublicKey(existing.collectionMint), {
        commitment: 'finalized', minContextSlot: existing.finalizedSlot,
      });
      if (result.context.slot < existing.finalizedSlot) throw new Error('RPC returned stale collection state for the completed deployment');
      validatePreorderCollectionAccount({ config, account: result.value });
      if (journal) rmSync(journalPath);
      printDeployment(existing, recordPath, deps.log);
      return existing;
    }

    if (journal) {
      const epoch = await connection.getEpochInfo('finalized');
      if (!Number.isSafeInteger(epoch.blockHeight) || !Number.isSafeInteger(epoch.absoluteSlot)) {
        throw new Error('RPC did not return a finalized block height and slot; preserving preorder journal');
      }
      const result = await connection.getAccountInfoAndContext(new PublicKey(journal.collectionMint), {
        commitment: 'finalized', minContextSlot: epoch.absoluteSlot,
      });
      if (result.context.slot < epoch.absoluteSlot) throw new Error('RPC returned stale collection state; preserving preorder journal');
      if (result.value) {
        validatePreorderCollectionAccount({ config, account: result.value });
        const recovered: PreorderCollectionDeployment = {
          version: 1, config: configuration, collectionMint: journal.collectionMint,
          transactionSignature: journal.transactionSignature, deployedAt: journal.createdAt, finalizedSlot: result.context.slot,
        };
        writePublicRecord(recordPath, recovered);
        rmSync(journalPath);
        deps.log('Recovered the original finalized collection.');
        printDeployment(recovered, recordPath, deps.log);
        return recovered;
      }
      const statuses = await connection.getSignatureStatuses([journal.transactionSignature], { searchTransactionHistory: true });
      const status = statuses.value[0];
      if (status && !status.err) {
        throw new Error(`Previous deployment transaction has landed but its finalized collection is unavailable; preserving ${journalPath}`);
      }
      if (epoch.blockHeight! <= journal.lastValidBlockHeight || (status && status.confirmationStatus !== 'finalized')) {
        throw new Error(`Previous deployment is still unresolved. Wait for finalized expiry before retrying; preserving ${journalPath}`);
      }
      deps.log('Previous transaction expired without creating a collection; preparing a fresh deployment.');
    }

    await validateHostedMetadata(config, deps.fetch);
    mkdirSync(path.dirname(recordPath), { recursive: true });
    const probe = path.join(path.dirname(recordPath), `.${randomUUID()}.probe`);
    writePublicRecord(probe, { writable: true });
    rmSync(probe);
    deps.log(`Config: ${configPath}`);
    deps.log(`Cluster: ${config.solanaCluster}`);
    deps.log(`Authority: ${config.authority}`);
    deps.log(`Collection metadata: ${config.collectionMetadataUri}`);
    deps.log('Enter the deployer wallet private key (input is hidden; base58 or JSON array).');
    const payer = parsePrivateKeyInput(await deps.promptPrivateKey());
    if (payer.publicKey.toBase58() !== config.authority) {
      throw new Error(`Deployer authority mismatch: expected ${config.authority}, got ${payer.publicKey.toBase58()}`);
    }
    const collection = deps.generateCollection();
    const create = buildCreateMplCoreCollectionV2Ix({
      collection: collection.publicKey,
      updateAuthority: payer.publicKey,
      updateDelegates: [payer.publicKey],
      payer: payer.publicKey,
      systemProgram: SystemProgram.programId,
      name: config.collectionMetadata.name,
      uri: config.collectionMetadataUri,
      royaltiesBps: config.collectionMetadata.sellerFeeBasisPoints,
      royaltiesCreators: config.collectionMetadata.creators.map((creator) => ({ address: new PublicKey(creator.address), percentage: creator.share })),
      royaltiesAuthority: null,
    });
    const blockhash = await connection.getLatestBlockhash('confirmed');
    const message = new TransactionMessage({
      payerKey: payer.publicKey, recentBlockhash: blockhash.blockhash, instructions: [create],
    }).compileToV0Message();
    const transaction = new VersionedTransaction(message);
    transaction.sign([payer, collection]);
    const simulation = await connection.simulateTransaction(transaction, {
      commitment: 'confirmed', sigVerify: true,
      accounts: { encoding: 'base64', addresses: [collection.publicKey.toBase58()] },
    });
    if (simulation.value.err) {
      throw new Error(`Preorder collection simulation failed: ${JSON.stringify(simulation.value.err)}\n${simulation.value.logs?.join('\n') || ''}`);
    }
    const simulatedAccount = simulation.value.accounts?.[0];
    if (!simulatedAccount || !Array.isArray(simulatedAccount.data) || simulatedAccount.data[1] !== 'base64') {
      throw new Error('Simulation did not return the created collection account');
    }
    validatePreorderCollectionAccount({
      config,
      account: {
        ...simulatedAccount,
        data: Buffer.from(simulatedAccount.data[0], 'base64'),
        owner: new PublicKey(simulatedAccount.owner),
        rentEpoch: simulatedAccount.rentEpoch ?? 0,
      },
    });
    const collectionRent = simulatedAccount.lamports;
    const fee = (await connection.getFeeForMessage(message, 'confirmed')).value;
    if (!Number.isSafeInteger(collectionRent) || Number(collectionRent) <= 0 || !Number.isSafeInteger(fee) || fee == null || fee < 0) {
      throw new Error('RPC did not return a valid simulated collection funding amount and transaction fee');
    }
    deps.log(`Collection: ${collection.publicKey.toBase58()}`);
    deps.log(`Royalties: ${config.collectionMetadata.sellerFeeBasisPoints} bps; ${config.collectionMetadata.creators.map((creator) => `${creator.address} (${creator.share}%)`).join(', ')}`);
    deps.log('Plugins: Royalties, BubblegumV2, UpdateDelegate (deployer only). Metadata remains mutable.');
    deps.log(`Estimated cost: ${(Number(collectionRent) + fee) / 1_000_000_000} SOL (${collectionRent} lamports collection funding + ${fee} lamports transaction fee).`);
    if (!(await deps.confirm('Send this collection creation transaction? Type y: '))) {
      deps.log('Cancelled.');
      return null;
    }
    await validateHostedMetadata(config, deps.fetch);
    if (await connection.getBlockHeight('confirmed') > blockhash.lastValidBlockHeight) {
      throw new Error('Transaction expired while awaiting confirmation; rerun to simulate a fresh transaction');
    }
    const transactionSignature = bs58.encode(transaction.signatures[0]);
    const nextJournal: PreorderCollectionJournal = {
      version: 1, config: configuration, collectionMint: collection.publicKey.toBase58(), transactionSignature,
      blockhash: blockhash.blockhash, lastValidBlockHeight: blockhash.lastValidBlockHeight, createdAt: deps.now().toISOString(),
    };
    if (journal) rmSync(journalPath);
    writePublicRecord(journalPath, nextJournal);
    try {
      const signature = await connection.sendRawTransaction(transaction.serialize(), { skipPreflight: false, maxRetries: 3 });
      if (signature !== transactionSignature) throw new Error('RPC returned an unexpected transaction signature');
      const confirmation = await connection.confirmTransaction({ ...blockhash, signature }, 'finalized');
      if (confirmation.value.err) throw new Error(`Collection creation failed: ${JSON.stringify(confirmation.value.err)}`);
      const result = await connection.getAccountInfoAndContext(collection.publicKey, {
        commitment: 'finalized', minContextSlot: confirmation.context.slot,
      });
      if (result.context.slot < confirmation.context.slot) throw new Error('RPC returned stale collection state after finalization');
      validatePreorderCollectionAccount({ config, account: result.value });
      const deployment: PreorderCollectionDeployment = {
        version: 1, config: configuration, collectionMint: collection.publicKey.toBase58(), transactionSignature,
        deployedAt: nextJournal.createdAt, finalizedSlot: result.context.slot,
      };
      writePublicRecord(recordPath, deployment);
      rmSync(journalPath);
      printDeployment(deployment, recordPath, deps.log);
      return deployment;
    } catch (error) {
      deps.log(`Deployment may have been submitted. Keep ${journalPath} and rerun the same command to recover ${nextJournal.collectionMint}.`);
      throw error;
    }
  } finally {
    release();
  }
}

async function main(): Promise<void> {
  const collectionId = parsePreorderCollectionArgs(process.argv.slice(2));
  if (collectionId === null) {
    console.log(`${USAGE}\nFill scripts/newPreorderCollections/<collectionId>.ts and publish its metadata JSON first.\nCreates only a mutable Core collection; no NFTs, receipt tree, or drop config.`);
    return;
  }
  await runPreorderCollectionDeployment({
    root: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), collectionId,
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = (error as { exitCode?: number })?.exitCode || 1;
  });
}
