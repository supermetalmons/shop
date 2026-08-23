import { randomInt } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  Transaction,
} from '@solana/web3.js';
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import {
  ADDRESS_CIPHER_SECRET_KEY_LENGTH,
  addressCipherHint,
  encryptAddressCipherText,
  serializeAddressCipherPayload,
} from '../src/shared/addressCipher.ts';
import { enqueueNotificationEmailJob } from '../src/cloudflareNotifications.ts';
import {
  BUBBLEGUM_PROGRAM_ADDRESS,
  MPL_ACCOUNT_COMPRESSION_PROGRAM_ADDRESS,
  MPL_CORE_CPI_SIGNER_ADDRESS,
  MPL_CORE_PROGRAM_ADDRESS,
  MPL_NOOP_PROGRAM_ADDRESS,
} from '../src/shared/solanaProgramAddresses.ts';
import { bubblegumMintV2Ix } from '../src/bubblegum.ts';
import { decodeBoxMinterConfigData } from '../src/shared/boxMinterConfigCodec.ts';
import { normalizeCountryCode } from '../src/shared/countryNormalization.ts';
import {
  getReceiptPoolDeployment,
} from '../src/shared/deploymentRegistry.ts';
import { requireFunctionsDrop } from '../src/config/deployment.ts';
import {
  STRIPE_CHECKOUT_OWNER_KIND_FIREBASE,
  STRIPE_CHECKOUT_STATUS,
  buildStripeOffchainAddressSnapshot,
  deriveAdminOrderPda,
  generateUniqueStripeReceiptClaimCodes,
  stripeCheckoutOwnerId,
  stripeCheckoutSessionOrderHash,
  validateStripeCheckoutContract,
  validateStripeCheckoutDocumentData,
} from '../src/stripeCheckout/contract.ts';
import { fetchStripeCheckoutSession } from '../src/stripeCheckout/service.ts';
import {
  CARD_NFT_BINDER_OVERSELL_ADMIN,
  CARD_NFT_BINDER_OVERSELL_COLLECTION,
  CARD_NFT_BINDER_OVERSELL_DROP_ID,
  CARD_NFT_BINDER_OVERSELL_PROJECT_ID,
  CARD_NFT_BINDER_OVERSELL_RECOVERY_ITEMS,
  CARD_NFT_BINDER_OVERSELL_SESSION_IDS,
  CARD_NFT_BINDER_OVERSELL_TREE,
  buildCardNftBinderOversellFirestoreCommit,
  publishCardNftBinderOversellTerminalNotifications,
  shouldPublishCardNftBinderOversellRecoveryNotifications,
  type CardNftBinderOversellRecoveryItem,
} from '../../scripts/shared/binderOversellRecovery.ts';
import {
  createFirebaseCliFirestoreRestClient,
  decodeFirestoreRestDocument,
  type FirestoreRestDocument,
} from '../../scripts/shared/firebaseCliFirestoreRest.ts';
import {
  bubblegumTreeConfigPda,
  decodeReceiptTreeState,
  validateReceiptPoolDeploymentOnchain,
} from '../../scripts/deploy-all-onchain.ts';

type Args = {
  execute: boolean;
};

type JournalEntry = {
  sessionId: string;
  metadataId: number;
  signature?: string;
  signedTransactionBase64?: string;
  blockhash?: string;
  lastValidBlockHeight?: number;
  status?: 'signed' | 'confirmed' | 'committed';
  assetId?: string;
  deliveryId?: number;
  claimCode?: string;
  notificationsPublished?: boolean;
};

type RecoveryJournal = {
  version: 1;
  dropId: typeof CARD_NFT_BINDER_OVERSELL_DROP_ID;
  entries: Record<string, JournalEntry>;
};

type RecoveryContext = {
  checkout: FirestoreRestDocument;
  stripeSession: any;
  stripeClient: any;
  firebaseUid: string;
  owner: string;
  addressSnapshot: Record<string, unknown>;
  orderHash: Buffer;
  orderHashHex: string;
  adminOrderPda: PublicKey;
};

type DasAsset = {
  id?: string;
  ownership?: { owner?: string };
  compression?: { tree?: string };
  grouping?: Array<{ group_key?: string; group_value?: string }>;
  content?: {
    json_uri?: string;
    metadata?: { name?: string };
  };
};

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);
const journalPath = path.join(
  repoRoot,
  '.cache',
  'card-nft-binder-oversell-recovery.json',
);
const drop = requireFunctionsDrop(CARD_NFT_BINDER_OVERSELL_DROP_ID);
const collection = new PublicKey(CARD_NFT_BINDER_OVERSELL_COLLECTION);
const merkleTree = new PublicKey(CARD_NFT_BINDER_OVERSELL_TREE);
const admin = new PublicKey(CARD_NFT_BINDER_OVERSELL_ADMIN);
const bubblegumProgram = new PublicKey(BUBBLEGUM_PROGRAM_ADDRESS);
const treeConfig = bubblegumTreeConfigPda(merkleTree);
const firebase = createFirebaseCliFirestoreRestClient({
  projectId: CARD_NFT_BINDER_OVERSELL_PROJECT_ID,
});

function usage(): string {
  return [
    'Audit or execute the fixed five-order Card NFT Binder oversell recovery.',
    '',
    'Usage:',
    '  npm run recover-card-nft-binder-oversell',
    '  npm run recover-card-nft-binder-oversell -- --execute',
  ].join('\n');
}

function parseArgs(argv: string[]): Args {
  if (argv.includes('-h') || argv.includes('--help')) {
    console.log(usage());
    process.exit(0);
  }
  const unknown = argv.filter((arg) => arg !== '--execute');
  if (unknown.length) {
    throw new Error(`Unknown argument: ${unknown[0]}\n\n${usage()}`);
  }
  return { execute: argv.includes('--execute') };
}

function loadLocalEnv(): void {
  for (const envPath of [
    path.join(repoRoot, 'functions/.env'),
    path.join(repoRoot, 'functions/.env.local'),
    path.join(repoRoot, '.env'),
    path.join(repoRoot, '.env.local'),
  ]) {
    if (!existsSync(envPath)) continue;
    const loadEnvFile = (
      process as typeof process & {
        loadEnvFile?: (filePath: string) => void;
      }
    ).loadEnvFile;
    if (loadEnvFile) {
      loadEnvFile(envPath);
      continue;
    }
    for (const rawLine of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
      const match = rawLine
        .trim()
        .match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (!match || process.env[match[1]]) continue;
      process.env[match[1]] = match[2].trim().replace(/^['"]|['"]$/g, '');
    }
  }
}

function readSecret(name: string, optional = false): string {
  const result = spawnSync(
    'gcloud',
    [
      'secrets',
      'versions',
      'access',
      'latest',
      '--secret',
      name,
      '--project',
      CARD_NFT_BINDER_OVERSELL_PROJECT_ID,
    ],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      env: process.env,
      maxBuffer: 1024 * 1024,
    },
  );
  const value = String(result.stdout || '').trim();
  if (result.status === 0 && value) return value;
  if (optional) return '';
  throw new Error(`Unable to access required secret ${name}`);
}

function decodeCosigner(secret: string): Keypair {
  const bytes = bs58.decode(secret.trim());
  if (bytes.length !== 64) {
    throw new Error('COSIGNER_SECRET must decode to 64 bytes');
  }
  const signer = Keypair.fromSecretKey(bytes);
  if (!signer.publicKey.equals(admin)) {
    throw new Error('COSIGNER_SECRET does not match the binder admin');
  }
  return signer;
}

function addressEncryptor(secret: string): (plaintext: string) => {
  encrypted: string;
  hint: string;
} {
  const bytes = Buffer.from(secret.trim(), 'base64');
  if (bytes.length !== ADDRESS_CIPHER_SECRET_KEY_LENGTH) {
    throw new Error(
      `ADDRESS_DECRYPTION_SECRET must decode to ${ADDRESS_CIPHER_SECRET_KEY_LENGTH} bytes`,
    );
  }
  const recipientPublicKey = nacl.box.keyPair.fromSecretKey(bytes).publicKey;
  return (plaintext) => {
    const encrypted = serializeAddressCipherPayload(
      encryptAddressCipherText(plaintext, recipientPublicKey),
      (value) => Buffer.from(value).toString('base64'),
    );
    return {
      encrypted,
      hint: addressCipherHint(plaintext),
    };
  };
}

function emptyJournal(): RecoveryJournal {
  return {
    version: 1,
    dropId: CARD_NFT_BINDER_OVERSELL_DROP_ID,
    entries: Object.fromEntries(
      CARD_NFT_BINDER_OVERSELL_RECOVERY_ITEMS.map((item) => [
        item.sessionId,
        {
          sessionId: item.sessionId,
          metadataId: item.metadataId,
        },
      ]),
    ),
  };
}

function loadJournal(): RecoveryJournal {
  if (!existsSync(journalPath)) return emptyJournal();
  const parsed = JSON.parse(readFileSync(journalPath, 'utf8')) as RecoveryJournal;
  if (
    parsed.version !== 1 ||
    parsed.dropId !== CARD_NFT_BINDER_OVERSELL_DROP_ID
  ) {
    throw new Error('Recovery journal identity is invalid');
  }
  const keys = Object.keys(parsed.entries).sort();
  const expected = [...CARD_NFT_BINDER_OVERSELL_SESSION_IDS].sort();
  if (
    keys.length !== expected.length ||
    keys.some((key, index) => key !== expected[index])
  ) {
    throw new Error('Recovery journal session scope is invalid');
  }
  for (const item of CARD_NFT_BINDER_OVERSELL_RECOVERY_ITEMS) {
    const entry = parsed.entries[item.sessionId];
    if (
      entry.sessionId !== item.sessionId ||
      entry.metadataId !== item.metadataId
    ) {
      throw new Error('Recovery journal item identity is invalid');
    }
  }
  return parsed;
}

function saveJournal(journal: RecoveryJournal): void {
  mkdirSync(path.dirname(journalPath), { recursive: true });
  const temporaryPath = `${journalPath}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(journal, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  renameSync(temporaryPath, journalPath);
}

async function fetchFirestoreDocument(
  documentPath: string,
): Promise<FirestoreRestDocument | undefined> {
  const raw = await firebase.request({
    url: firebase.documentUrl(documentPath),
    allow404: true,
  });
  return raw ? decodeFirestoreRestDocument(raw) : undefined;
}

async function listStripeCheckouts(): Promise<FirestoreRestDocument[]> {
  const documents: FirestoreRestDocument[] = [];
  let pageToken = '';
  do {
    const url = firebase.documentUrl(
      `drops/${CARD_NFT_BINDER_OVERSELL_DROP_ID}/stripeCheckouts`,
    );
    url.searchParams.set('pageSize', '100');
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    const response = await firebase.request({ url });
    for (const raw of Array.isArray(response?.documents)
      ? response.documents
      : []) {
      const decoded = decodeFirestoreRestDocument(raw);
      if (decoded) documents.push(decoded);
    }
    pageToken = String(response?.nextPageToken || '');
  } while (pageToken);
  return documents;
}

function assertFixedCheckoutState(
  item: CardNftBinderOversellRecoveryItem,
  checkout: FirestoreRestDocument,
  allowFulfilled: boolean,
): void {
  const data = checkout.data;
  const status = String(data.status || '');
  if (
    status !== STRIPE_CHECKOUT_STATUS.FULFILLMENT_FAILED &&
    !(allowFulfilled && status === STRIPE_CHECKOUT_STATUS.FULFILLED)
  ) {
    throw new Error(`${item.sessionId} has unexpected status ${status}`);
  }
  if (
    status === STRIPE_CHECKOUT_STATUS.FULFILLMENT_FAILED &&
    data.manualRefundReviewRequired !== true
  ) {
    throw new Error(`${item.sessionId} is not in manual refund review`);
  }
  validateStripeCheckoutDocumentData({
    dropId: CARD_NFT_BINDER_OVERSELL_DROP_ID,
    sessionId: item.sessionId,
    expectedLivemode: true,
    checkout: data,
  });
  if (
    Number(data.quantity) !== 1 ||
    Number(data.unitAmountCents) !== 10_000
  ) {
    throw new Error(`${item.sessionId} is not the exact quantity-one order`);
  }
}

async function validateMetadata(
  item: CardNftBinderOversellRecoveryItem,
): Promise<void> {
  const response = await fetch(item.uri, {
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) {
    throw new Error(`${item.uri} returned HTTP ${response.status}`);
  }
  const metadata = (await response.json()) as {
    id?: unknown;
    name?: unknown;
  };
  if (
    Number(metadata.id) !== item.metadataId ||
    String(metadata.name || '') !== `Binder Receipt #${item.metadataId}`
  ) {
    throw new Error(`${item.uri} metadata identity mismatch`);
  }
}

async function auditRecoveryContext(
  item: CardNftBinderOversellRecoveryItem,
  stripeApiKeys: string[],
  encryptAddress: ReturnType<typeof addressEncryptor>,
  connection: Connection,
  allowFulfilled: boolean,
): Promise<RecoveryContext> {
  const checkoutPath = `drops/${CARD_NFT_BINDER_OVERSELL_DROP_ID}/stripeCheckouts/${item.sessionId}`;
  const checkout = await fetchFirestoreDocument(checkoutPath);
  if (!checkout?.updateTime) {
    throw new Error(`${item.sessionId} checkout document is missing`);
  }
  assertFixedCheckoutState(item, checkout, allowFulfilled);
  const { session, stripe } = await fetchStripeCheckoutSession(
    item.sessionId,
    stripeApiKeys,
    'live',
  );
  const lineItems = await stripe.checkout.sessions.listLineItems(
    item.sessionId,
    {
      limit: 10,
      expand: ['data.price'],
    },
  );
  const contract = validateStripeCheckoutContract({
    session,
    lineItems,
    expectedUnitAmountCents: 10_000,
    expectedQuantity: 1,
    expectedCurrency: 'usd',
    expectedLivemode: true,
  });
  if ('ignored' in contract) {
    throw new Error(`${item.sessionId} is not an off-chain fulfillment session`);
  }
  const firebaseUid = String(checkout.data.uid || '').trim();
  if (
    String(session.id || '') !== item.sessionId ||
    String(session.metadata?.dropId || '') !==
      CARD_NFT_BINDER_OVERSELL_DROP_ID ||
    String(session.metadata?.uid || '') !== firebaseUid ||
    String(session.metadata?.quantity || '') !== '1'
  ) {
    throw new Error(`${item.sessionId} Stripe metadata mismatch`);
  }
  const owner = stripeCheckoutOwnerId(firebaseUid);
  if (
    String(checkout.data.owner || '') !== owner ||
    String(checkout.data.ownerKind || '') !==
      STRIPE_CHECKOUT_OWNER_KIND_FIREBASE ||
    String(checkout.data.firebaseUid || '') !== firebaseUid
  ) {
    throw new Error(`${item.sessionId} checkout owner identity mismatch`);
  }
  const addressSnapshot = buildStripeOffchainAddressSnapshot({
    session,
    encryptAddress,
    normalizeCountryCode,
    dropFamily: 'card_nft_binder',
  });
  const orderHash = stripeCheckoutSessionOrderHash(item.sessionId, true);
  const orderHashHex = orderHash.toString('hex');
  const marker = await fetchFirestoreDocument(
    `drops/${CARD_NFT_BINDER_OVERSELL_DROP_ID}/offchainOrders/${orderHashHex}`,
  );
  const configPda = new PublicKey(String(drop.boxMinterConfigPda || ''));
  const programId = new PublicKey(drop.boxMinterProgramId);
  const adminOrderPda = deriveAdminOrderPda(
    programId,
    configPda,
    orderHash,
  )[0];
  const adminOrder = await connection.getAccountInfo(adminOrderPda, {
    commitment: 'confirmed',
  });
  const fulfilled =
    checkout.data.status === STRIPE_CHECKOUT_STATUS.FULFILLED;
  if (!fulfilled && (marker || adminOrder)) {
    throw new Error(`${item.sessionId} already has an order marker`);
  }
  if (fulfilled && !marker) {
    throw new Error(`${item.sessionId} is fulfilled without an order marker`);
  }
  await validateMetadata(item);
  return {
    checkout,
    stripeSession: session,
    stripeClient: stripe,
    firebaseUid,
    owner,
    addressSnapshot,
    orderHash,
    orderHashHex,
    adminOrderPda,
  };
}

function heliusRpcUrl(): string {
  const key = String(
    process.env.HELIUS_API_KEY || process.env.VITE_HELIUS_API_KEY || '',
  ).trim();
  if (!key) throw new Error('HELIUS_API_KEY is required');
  return `https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(key)}`;
}

async function dasRequest(
  rpcUrl: string,
  method: string,
  params: unknown,
): Promise<any> {
  const response = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: `${method}-${Date.now()}`,
      method,
      params,
    }),
  });
  const payload = await response.json();
  if (!response.ok || payload?.error) {
    throw new Error(
      payload?.error?.message || `Helius ${method} request failed`,
    );
  }
  return payload.result;
}

function assetCollection(asset: DasAsset): string {
  const matches = (asset.grouping || [])
    .filter((group) => group.group_key === 'collection')
    .map((group) => String(group.group_value || ''))
    .filter(Boolean);
  return matches.length === 1 ? matches[0] : '';
}

async function findAssetsWithUri(
  rpcUrl: string,
  uri: string,
): Promise<DasAsset[]> {
  const matches: DasAsset[] = [];
  for (let page = 1; page <= 4; page += 1) {
    const result = await dasRequest(rpcUrl, 'searchAssets', {
      grouping: ['collection', CARD_NFT_BINDER_OVERSELL_COLLECTION],
      page,
      limit: 1000,
      options: {
        showUnverifiedCollections: false,
        showCollectionMetadata: true,
      },
    });
    const items = Array.isArray(result?.items) ? result.items : [];
    for (const asset of items) {
      if (String(asset?.content?.json_uri || '') === uri) {
        matches.push(asset);
      }
    }
    if (items.length < 1000) break;
  }
  return matches;
}

function validateDasAsset(
  item: CardNftBinderOversellRecoveryItem,
  asset: DasAsset,
  expectedAssetId?: string,
): string {
  const assetId = String(asset.id || '');
  if (
    !assetId ||
    (expectedAssetId && assetId !== expectedAssetId) ||
    String(asset.ownership?.owner || '') !==
      CARD_NFT_BINDER_OVERSELL_ADMIN ||
    String(asset.compression?.tree || '') !==
      CARD_NFT_BINDER_OVERSELL_TREE ||
    assetCollection(asset) !== CARD_NFT_BINDER_OVERSELL_COLLECTION ||
    String(asset.content?.json_uri || '') !== item.uri ||
    String(asset.content?.metadata?.name || '') !== item.name
  ) {
    throw new Error(`${item.sessionId} indexed receipt identity mismatch`);
  }
  return assetId;
}

async function waitForDasAsset(
  rpcUrl: string,
  item: CardNftBinderOversellRecoveryItem,
  assetId: string,
): Promise<DasAsset> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const matches = await findAssetsWithUri(rpcUrl, item.uri);
      if (matches.length > 1) {
        throw new Error(`${item.uri} resolves to duplicate receipt assets`);
      }
      if (matches.length === 1) {
        validateDasAsset(item, matches[0], assetId);
        const proof = await dasRequest(rpcUrl, 'getAssetProof', {
          id: assetId,
        });
        if (
          String(proof?.tree_id || proof?.treeId || '') !==
          CARD_NFT_BINDER_OVERSELL_TREE
        ) {
          throw new Error(`${item.sessionId} receipt proof tree mismatch`);
        }
        return matches[0];
      }
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  throw new Error(
    `${item.sessionId} receipt did not index correctly: ${
      lastError instanceof Error ? lastError.message : String(lastError || '')
    }`,
  );
}

function transactionAccountKeys(transaction: any): PublicKey[] {
  const message = transaction.transaction.message as any;
  return Array.isArray(message.accountKeys)
    ? message.accountKeys.map((key: any) =>
        key instanceof PublicKey ? key : new PublicKey(key),
      )
    : Array.isArray(message.staticAccountKeys)
      ? message.staticAccountKeys
      : [];
}

function bubblegumV2LeafAssetIds(
  transaction: any,
): string[] {
  const keys = transactionAccountKeys(transaction);
  const noop = new PublicKey(MPL_NOOP_PROGRAM_ADDRESS);
  const assetIds = new Set<string>();
  for (const group of transaction.meta?.innerInstructions || []) {
    for (const instruction of group.instructions as any[]) {
      if (!keys[instruction.programIdIndex]?.equals(noop)) continue;
      const data =
        typeof instruction.data === 'string'
          ? Buffer.from(bs58.decode(instruction.data))
          : Buffer.from(instruction.data || []);
      if (
        data.length < 41 ||
        data[0] !== 1 ||
        data[1] !== 0 ||
        data.readUInt32LE(2) !== data.length - 6 ||
        data[6] !== 1 ||
        data[7] !== 1 ||
        data[8] !== 1
      ) {
        continue;
      }
      assetIds.add(new PublicKey(data.subarray(9, 41)).toBase58());
    }
  }
  return [...assetIds];
}

async function transactionAssetId(
  connection: Connection,
  signature: string,
): Promise<string> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const transaction = await connection.getTransaction(signature, {
      commitment: 'confirmed',
      maxSupportedTransactionVersion: 0,
    });
    if (transaction) {
      if (transaction.meta?.err) {
        throw new Error(`${signature} failed on chain`);
      }
      const assetIds = bubblegumV2LeafAssetIds(transaction);
      if (assetIds.length !== 1) {
        throw new Error(
          `${signature} emitted ${assetIds.length} Bubblegum leaf assets`,
        );
      }
      return assetIds[0];
    }
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  throw new Error(`${signature} transaction details are unavailable`);
}

function buildSignedMint(
  item: CardNftBinderOversellRecoveryItem,
  signer: Keypair,
  blockhash: string,
): Transaction {
  const transaction = new Transaction({
    feePayer: signer.publicKey,
    recentBlockhash: blockhash,
  });
  transaction.add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 250_000 }),
    bubblegumMintV2Ix({
      bubblegumProgramId: bubblegumProgram,
      mplNoopProgramId: new PublicKey(MPL_NOOP_PROGRAM_ADDRESS),
      mplAccountCompressionProgramId: new PublicKey(
        MPL_ACCOUNT_COMPRESSION_PROGRAM_ADDRESS,
      ),
      mplCoreProgramId: new PublicKey(MPL_CORE_PROGRAM_ADDRESS),
      mplCoreCpiSigner: new PublicKey(MPL_CORE_CPI_SIGNER_ADDRESS),
      treeConfig,
      payer: signer.publicKey,
      treeCreatorOrDelegate: signer.publicKey,
      collectionAuthority: signer.publicKey,
      leafOwner: signer.publicKey,
      leafDelegate: signer.publicKey,
      merkleTree,
      coreCollection: collection,
      name: item.name,
      uri: item.uri,
    }),
  );
  transaction.sign(signer);
  return transaction;
}

async function simulateMint(
  connection: Connection,
  item: CardNftBinderOversellRecoveryItem,
  signer: Keypair,
): Promise<void> {
  const latest = await connection.getLatestBlockhash('confirmed');
  const transaction = buildSignedMint(item, signer, latest.blockhash);
  const simulation = await connection.simulateTransaction(transaction);
  if (simulation.value.err) {
    throw new Error(
      `${item.sessionId} signed MintV2 simulation failed: ${JSON.stringify(
        simulation.value.err,
      )}`,
    );
  }
}

async function signatureState(
  connection: Connection,
  signature: string,
): Promise<'confirmed' | 'failed' | 'pending' | 'missing'> {
  const response = await connection.getSignatureStatuses([signature], {
    searchTransactionHistory: true,
  });
  const status = response.value[0];
  if (!status) return 'missing';
  if (status.err) return 'failed';
  if (
    status.confirmationStatus === 'confirmed' ||
    status.confirmationStatus === 'finalized'
  ) {
    return 'confirmed';
  }
  return 'pending';
}

async function resolveSignedMint(
  connection: Connection,
  entry: JournalEntry,
): Promise<'confirmed' | 'expired' | 'pending'> {
  if (
    !entry.signature ||
    !entry.signedTransactionBase64 ||
    !entry.blockhash ||
    !entry.lastValidBlockHeight
  ) {
    throw new Error(`${entry.sessionId} signed journal entry is incomplete`);
  }
  const state = await signatureState(connection, entry.signature);
  if (state === 'failed') {
    throw new Error(`${entry.signature} failed on chain`);
  }
  if (state === 'confirmed') return 'confirmed';
  const blockHeight = await connection.getBlockHeight('confirmed');
  if (blockHeight > entry.lastValidBlockHeight) return 'expired';
  return 'pending';
}

async function sendJournaledMint(
  connection: Connection,
  entry: JournalEntry,
): Promise<void> {
  if (
    !entry.signature ||
    !entry.signedTransactionBase64 ||
    !entry.blockhash ||
    !entry.lastValidBlockHeight
  ) {
    throw new Error(`${entry.sessionId} signed journal entry is incomplete`);
  }
  const raw = Buffer.from(entry.signedTransactionBase64, 'base64');
  try {
    const returnedSignature = await connection.sendRawTransaction(raw, {
      skipPreflight: false,
      maxRetries: 5,
    });
    if (returnedSignature !== entry.signature) {
      throw new Error('RPC returned a different transaction signature');
    }
  } catch (error) {
    const state = await resolveSignedMint(connection, entry);
    if (state === 'confirmed') return;
    throw error;
  }
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const state = await resolveSignedMint(connection, entry);
    if (state === 'confirmed') return;
    if (state === 'expired') {
      throw new Error(`${entry.signature} expired without landing`);
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error(`${entry.signature} confirmation remains ambiguous`);
}

async function readReceiptTreeState(connection: Connection) {
  const [treeAccount, configAccount] = await connection.getMultipleAccountsInfo(
    [merkleTree, treeConfig],
    { commitment: 'confirmed' },
  );
  if (!treeAccount || !configAccount) {
    throw new Error('Receipt tree accounts are unavailable');
  }
  return decodeReceiptTreeState({
    merkleTreeData: Buffer.from(treeAccount.data),
    treeConfigData: Buffer.from(configAccount.data),
  });
}

async function assertOnchainConfiguration(
  connection: Connection,
  expectedTreeMints: number,
): Promise<void> {
  const configPda = new PublicKey(String(drop.boxMinterConfigPda || ''));
  const account = await connection.getAccountInfo(configPda, {
    commitment: 'confirmed',
  });
  if (!account) throw new Error('Binder on-chain config is unavailable');
  const decoded = decodeBoxMinterConfigData(account.data);
  if (
    !new PublicKey(decoded.admin).equals(admin) ||
    !new PublicKey(decoded.coreCollection).equals(collection) ||
    decoded.maxSupply !== 15 ||
    decoded.minted !== 15 ||
    decoded.itemsPerBox !== 0 ||
    decoded.uriBase !==
      'https://cdn.lil.org/nft/card_nft_binder/json'
  ) {
    throw new Error('Binder on-chain config changed from the approved 15/15 state');
  }
  const tree = await readReceiptTreeState(connection);
  if (
    !tree.creator.equals(admin) ||
    !tree.delegate.equals(admin) ||
    tree.numMinted !== expectedTreeMints
  ) {
    throw new Error(
      `Receipt tree state mismatch: expected ${expectedTreeMints}, got ${tree.numMinted}`,
    );
  }
}

async function validateReceiptPool(connection: Connection): Promise<void> {
  const pool = getReceiptPoolDeployment(
    'mainnet-beta',
    String(drop.receiptPoolId || ''),
  );
  if (!pool) throw new Error('Mainnet receipt pool deployment is missing');
  await validateReceiptPoolDeploymentOnchain({
    connection,
    collectionMint: collection,
    receiptsMerkleTree: merkleTree,
    authority: admin,
    collectionMetadataUri: pool.collectionMetadataUri,
    collectionName: pool.collectionName,
    royaltiesBasisPoints: pool.royaltiesBasisPoints,
    royaltiesRecipient: new PublicKey(pool.royaltiesRecipient),
    receiptsTreeMaxDepth: pool.receiptsTreeMaxDepth,
    receiptsTreeMaxBufferSize: pool.receiptsTreeMaxBufferSize,
    receiptsTreeCanopyDepth: pool.receiptsTreeCanopyDepth,
  });
}

async function allocateFirestoreIds(
  entry: JournalEntry,
): Promise<{ deliveryId: number; claimCode: string }> {
  if (entry.deliveryId && entry.claimCode) {
    return {
      deliveryId: entry.deliveryId,
      claimCode: entry.claimCode,
    };
  }
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const deliveryId = randomInt(1, 2 ** 31);
    const claimCode = generateUniqueStripeReceiptClaimCodes(1)[0];
    const [delivery, claim] = await Promise.all([
      fetchFirestoreDocument(
        `drops/${CARD_NFT_BINDER_OVERSELL_DROP_ID}/deliveryOrders/${deliveryId}`,
      ),
      fetchFirestoreDocument(`claimCodes/${claimCode}`),
    ]);
    if (!delivery && !claim) return { deliveryId, claimCode };
  }
  throw new Error('Unable to allocate delivery id and claim code');
}

async function verifyCommittedRecovery(
  item: CardNftBinderOversellRecoveryItem,
  context: RecoveryContext,
  receiptTx: string,
  deliveryId: number,
  claimCode: string,
): Promise<void> {
  const [checkout, delivery, marker, claim] = await Promise.all([
    fetchFirestoreDocument(
      `drops/${CARD_NFT_BINDER_OVERSELL_DROP_ID}/stripeCheckouts/${item.sessionId}`,
    ),
    fetchFirestoreDocument(
      `drops/${CARD_NFT_BINDER_OVERSELL_DROP_ID}/deliveryOrders/${deliveryId}`,
    ),
    fetchFirestoreDocument(
      `drops/${CARD_NFT_BINDER_OVERSELL_DROP_ID}/offchainOrders/${context.orderHashHex}`,
    ),
    fetchFirestoreDocument(`claimCodes/${claimCode}`),
  ]);
  if (
    checkout?.data.status !== STRIPE_CHECKOUT_STATUS.FULFILLED ||
    Number(checkout.data.deliveryId) !== deliveryId ||
    Number(checkout.data.metadataId) !== item.metadataId ||
    String(checkout.data.receiptTx || '') !== receiptTx ||
    Number(delivery?.data.deliveryId) !== deliveryId ||
    Number(delivery?.data.metadataId) !== item.metadataId ||
    String(delivery?.data.receiptTxs?.[0] || '') !== receiptTx ||
    Number(marker?.data.deliveryId) !== deliveryId ||
    String(marker?.data.receiptTx || '') !== receiptTx ||
    String(claim?.data.status || '') !== 'unclaimed' ||
    Number(claim?.data.boxId) !== item.metadataId ||
    String(claim?.data.stripeCheckoutSessionId || '') !== item.sessionId
  ) {
    throw new Error(`${item.sessionId} committed Firestore state mismatch`);
  }
}

async function publishPendingRecoveryNotifications(
  item: CardNftBinderOversellRecoveryItem,
  entry: JournalEntry,
  journal: RecoveryJournal,
  notificationEnqueueSecret: string,
): Promise<void> {
  if (
    !shouldPublishCardNftBinderOversellRecoveryNotifications(
      entry.notificationsPublished,
    )
  ) {
    return;
  }
  await publishCardNftBinderOversellTerminalNotifications({
    item,
    dependencies: {
      loadCheckout: async () => {
        const checkout = await fetchFirestoreDocument(
          `drops/${CARD_NFT_BINDER_OVERSELL_DROP_ID}/stripeCheckouts/${item.sessionId}`,
        );
        return checkout
          ? { path: checkout.path, data: checkout.data }
          : null;
      },
      loadDeliveryOrder: async (dropId, deliveryId) => {
        const order = await fetchFirestoreDocument(
          `drops/${dropId}/deliveryOrders/${deliveryId}`,
        );
        return order?.data || null;
      },
      enqueueJob: (job) =>
        enqueueNotificationEmailJob({
          job,
          secret: notificationEnqueueSecret,
        }),
    },
  });
  entry.notificationsPublished = true;
  saveJournal(journal);
}

async function commitRecovery(
  item: CardNftBinderOversellRecoveryItem,
  context: RecoveryContext,
  entry: JournalEntry,
  journal: RecoveryJournal,
  notificationEnqueueSecret: string,
): Promise<void> {
  if (!entry.signature || !entry.assetId) {
    throw new Error(`${item.sessionId} confirmed receipt journal is incomplete`);
  }
  const allocation = await allocateFirestoreIds(entry);
  entry.deliveryId = allocation.deliveryId;
  entry.claimCode = allocation.claimCode;
  saveJournal(journal);
  const currentCheckout = await fetchFirestoreDocument(
    `drops/${CARD_NFT_BINDER_OVERSELL_DROP_ID}/stripeCheckouts/${item.sessionId}`,
  );
  if (!currentCheckout?.updateTime) {
    throw new Error(`${item.sessionId} checkout disappeared before commit`);
  }
  if (currentCheckout.data.status === STRIPE_CHECKOUT_STATUS.FULFILLED) {
    await verifyCommittedRecovery(
      item,
      context,
      entry.signature,
      allocation.deliveryId,
      allocation.claimCode,
    );
    entry.status = 'committed';
    saveJournal(journal);
    await publishPendingRecoveryNotifications(
      item,
      entry,
      journal,
      notificationEnqueueSecret,
    );
    return;
  }
  assertFixedCheckoutState(item, currentCheckout, false);
  const commit = buildCardNftBinderOversellFirestoreCommit({
    checkoutUpdateTime: currentCheckout.updateTime,
    item,
    receiptTx: entry.signature,
    deliveryId: allocation.deliveryId,
    claimCode: allocation.claimCode,
    owner: context.owner,
    firebaseUid: context.firebaseUid,
    receiptOwner: CARD_NFT_BINDER_OVERSELL_ADMIN,
    orderHashHex: context.orderHashHex,
    stripeSession: context.stripeSession,
    addressSnapshot: context.addressSnapshot,
  });
  entry.notificationsPublished = false;
  saveJournal(journal);
  try {
    await firebase.request({
      url: firebase.documentsUrl(':commit'),
      method: 'POST',
      body: { writes: commit.writes },
    });
  } catch (error) {
    try {
      await verifyCommittedRecovery(
        item,
        context,
        entry.signature,
        allocation.deliveryId,
        allocation.claimCode,
      );
    } catch {
      throw error;
    }
  }
  await verifyCommittedRecovery(
    item,
    context,
    entry.signature,
    allocation.deliveryId,
    allocation.claimCode,
  );
  entry.status = 'committed';
  saveJournal(journal);
  await publishPendingRecoveryNotifications(
    item,
    entry,
    journal,
    notificationEnqueueSecret,
  );
}

async function recoverOne(
  item: CardNftBinderOversellRecoveryItem,
  index: number,
  args: Args,
  journal: RecoveryJournal,
  signer: Keypair,
  stripeApiKeys: string[],
  encryptAddress: ReturnType<typeof addressEncryptor>,
  connection: Connection,
  rpcUrl: string,
  notificationEnqueueSecret: string,
): Promise<void> {
  const entry = journal.entries[item.sessionId];
  const context = await auditRecoveryContext(
    item,
    stripeApiKeys,
    encryptAddress,
    connection,
    entry.status === 'committed' ||
      (entry.status === 'confirmed' &&
        Boolean(entry.deliveryId && entry.claimCode)),
  );
  const existingAssets = await findAssetsWithUri(rpcUrl, item.uri);
  if (existingAssets.length > 1) {
    throw new Error(`${item.uri} already has duplicate receipt assets`);
  }
  if (entry.status === 'committed') {
    if (existingAssets.length !== 1 || !entry.assetId) {
      throw new Error(`${item.sessionId} committed receipt asset is missing`);
    }
    validateDasAsset(item, existingAssets[0], entry.assetId);
    if (!entry.signature || !entry.deliveryId || !entry.claimCode) {
      throw new Error(`${item.sessionId} committed journal is incomplete`);
    }
    await verifyCommittedRecovery(
      item,
      context,
      entry.signature,
      entry.deliveryId,
      entry.claimCode,
    );
    if (args.execute) {
      await publishPendingRecoveryNotifications(
        item,
        entry,
        journal,
        notificationEnqueueSecret,
      );
    }
    console.log(
      `[${index + 1}/5] verified committed rb${item.metadataId}.json`,
    );
    return;
  }
  if (!args.execute) {
    if (existingAssets.length) {
      throw new Error(`${item.uri} is already minted without a committed recovery`);
    }
    await simulateMint(connection, item, signer);
    console.log(
      `[${index + 1}/5] audited and simulated rb${item.metadataId}.json`,
    );
    return;
  }
  if (entry.status === 'signed') {
    const state = await resolveSignedMint(connection, entry);
    if (state === 'confirmed') {
      entry.assetId = await transactionAssetId(
        connection,
        String(entry.signature),
      );
      entry.status = 'confirmed';
      saveJournal(journal);
    } else if (state === 'pending') {
      await assertOnchainConfiguration(connection, 15 + index);
      await sendJournaledMint(connection, entry);
      entry.assetId = await transactionAssetId(
        connection,
        String(entry.signature),
      );
      entry.status = 'confirmed';
      saveJournal(journal);
    } else {
      await assertOnchainConfiguration(connection, 15 + index);
      if (existingAssets.length) {
        throw new Error(`${item.uri} exists after its journaled mint expired`);
      }
      delete entry.signature;
      delete entry.signedTransactionBase64;
      delete entry.blockhash;
      delete entry.lastValidBlockHeight;
      delete entry.status;
      saveJournal(journal);
    }
  }
  if (!entry.status) {
    await assertOnchainConfiguration(connection, 15 + index);
    if (existingAssets.length) {
      throw new Error(`${item.uri} already exists before mint`);
    }
    await simulateMint(connection, item, signer);
    const latest = await connection.getLatestBlockhash('confirmed');
    const transaction = buildSignedMint(item, signer, latest.blockhash);
    const signature = bs58.encode(
      transaction.signatures[0].signature as Buffer,
    );
    entry.signature = signature;
    entry.signedTransactionBase64 = transaction
      .serialize()
      .toString('base64');
    entry.blockhash = latest.blockhash;
    entry.lastValidBlockHeight = latest.lastValidBlockHeight;
    entry.status = 'signed';
    saveJournal(journal);
    await sendJournaledMint(connection, entry);
    entry.assetId = await transactionAssetId(connection, signature);
    entry.status = 'confirmed';
    saveJournal(journal);
  }
  if (entry.status === 'confirmed') {
    if (!entry.assetId || !entry.signature) {
      throw new Error(`${item.sessionId} confirmed journal is incomplete`);
    }
    await waitForDasAsset(rpcUrl, item, entry.assetId);
    await assertOnchainConfiguration(connection, 16 + index);
    await commitRecovery(
      item,
      context,
      entry,
      journal,
      notificationEnqueueSecret,
    );
  }
  console.log(
    `[${index + 1}/5] minted and fulfilled rb${item.metadataId}.json ${entry.signature}`,
  );
}

async function finalVerification(
  connection: Connection,
  rpcUrl: string,
  journal: RecoveryJournal,
  createdCheckoutIds: string[],
): Promise<void> {
  await assertOnchainConfiguration(connection, 20);
  const checkouts = await listStripeCheckouts();
  const manual = checkouts.filter(
    (checkout) => checkout.data.manualRefundReviewRequired === true,
  );
  const created = checkouts
    .filter((checkout) => checkout.data.status === STRIPE_CHECKOUT_STATUS.CREATED)
    .map((checkout) => checkout.id)
    .sort();
  if (manual.length !== 0) {
    throw new Error(`Manual review count is ${manual.length}, expected zero`);
  }
  if (
    created.length !== createdCheckoutIds.length ||
    created.some((id, index) => id !== createdCheckoutIds[index])
  ) {
    throw new Error('Unrelated created checkout set changed');
  }
  for (const item of CARD_NFT_BINDER_OVERSELL_RECOVERY_ITEMS) {
    const entry = journal.entries[item.sessionId];
    if (
      entry.status !== 'committed' ||
      !entry.assetId ||
      entry.notificationsPublished === false
    ) {
      throw new Error(`${item.sessionId} recovery is incomplete`);
    }
    const assets = await findAssetsWithUri(rpcUrl, item.uri);
    if (assets.length !== 1) {
      throw new Error(`${item.uri} does not resolve to exactly one asset`);
    }
    validateDasAsset(item, assets[0], entry.assetId);
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  loadLocalEnv();
  if (
    drop.solanaCluster !== 'mainnet-beta' ||
    drop.maxSupply !== 15 ||
    drop.receiptMaxId !== 20
  ) {
    throw new Error('Binder deployment registry recovery bounds are invalid');
  }
  const rpcUrl = heliusRpcUrl();
  const connection = new Connection(rpcUrl, 'confirmed');
  const signer = decodeCosigner(readSecret('COSIGNER_SECRET'));
  const encryptAddress = addressEncryptor(
    readSecret('ADDRESS_DECRYPTION_SECRET'),
  );
  const stripeApiKeys = [
    readSecret('STRIPE_SECRET_KEY_LIVE', true),
    readSecret('STRIPE_RESTRICTED_KEY_LIVE', true),
  ].filter(Boolean);
  if (!stripeApiKeys.length) {
    throw new Error('No live Stripe API key is available');
  }
  const journal = loadJournal();
  const notificationEnqueueRequired = CARD_NFT_BINDER_OVERSELL_RECOVERY_ITEMS.some(
    (item) => {
      const entry = journal.entries[item.sessionId];
      return (
        entry.status !== 'committed' ||
        shouldPublishCardNftBinderOversellRecoveryNotifications(
          entry.notificationsPublished,
        )
      );
    },
  );
  const notificationEnqueueSecret = args.execute && notificationEnqueueRequired
    ? readSecret('NOTIFICATION_ENQUEUE_SECRET')
    : '';
  const initialCheckouts = await listStripeCheckouts();
  const createdCheckoutIds = initialCheckouts
    .filter((checkout) => checkout.data.status === STRIPE_CHECKOUT_STATUS.CREATED)
    .map((checkout) => checkout.id)
    .sort();
  if (createdCheckoutIds.length !== 6) {
    throw new Error(
      `Expected six unrelated created checkouts, found ${createdCheckoutIds.length}`,
    );
  }
  await validateReceiptPool(connection);
  if (!args.execute) {
    const uncommitted = CARD_NFT_BINDER_OVERSELL_RECOVERY_ITEMS.filter(
      (item) => journal.entries[item.sessionId].status !== 'committed',
    ).length;
    await assertOnchainConfiguration(connection, 20 - uncommitted);
    console.log('Mode: dry-run');
  } else {
    console.log('Mode: execute');
  }
  for (
    let index = 0;
    index < CARD_NFT_BINDER_OVERSELL_RECOVERY_ITEMS.length;
    index += 1
  ) {
    await recoverOne(
      CARD_NFT_BINDER_OVERSELL_RECOVERY_ITEMS[index],
      index,
      args,
      journal,
      signer,
      stripeApiKeys,
      encryptAddress,
      connection,
      rpcUrl,
      notificationEnqueueSecret,
    );
  }
  if (args.execute) {
    await finalVerification(
      connection,
      rpcUrl,
      journal,
      createdCheckoutIds,
    );
    console.log('Recovery complete: five receipts and five fulfillments verified');
  } else {
    console.log('Dry-run complete: all five exact recovery items are ready');
  }
}

function isDirectRun(): boolean {
  return Boolean(
    process.argv[1] &&
      path.resolve(process.argv[1]) === fileURLToPath(import.meta.url),
  );
}

if (isDirectRun()) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
