import bs58 from 'bs58';
import nacl from 'tweetnacl';
import {
  Connection,
  type FetchFn,
  Keypair,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import { getFunctionsDrop, type FunctionsDropConfig } from '../../../../functions/src/config/deployment.js';
import {
  ADDRESS_CIPHER_SECRET_KEY_LENGTH,
  addressCipherHint,
  encryptAddressCipherText,
  serializeAddressCipherPayload,
} from '../../../../functions/src/shared/addressCipher.js';
import {
  decodeBoxMinterConfigData,
  type DecodedBoxMinterConfigData,
} from '../../../../functions/src/shared/boxMinterConfigCodec.js';
import { BOX_MINTER_CONFIG_SEED } from '../../../../functions/src/shared/boxMinterProtocol.js';
import { normalizeCountryCode } from '../../../../functions/src/shared/countryNormalization.js';
import {
  boxMinterMetadataBaseMatchesDrop,
  normalizeDropId,
} from '../../../../functions/src/shared/deploymentCore.js';
import { dropDeliveryOrderPath } from '../../../../functions/src/dropPaths.js';
import {
  shouldTrackPackStatusForDrop,
  PACK_STATUS_SCHEMA_VERSION,
} from '../../../../functions/src/shared/packStatus.js';
import {
  BUBBLEGUM_PROGRAM_ADDRESS,
  MPL_ACCOUNT_COMPRESSION_PROGRAM_ADDRESS,
  MPL_CORE_CPI_SIGNER_ADDRESS,
  MPL_CORE_PROGRAM_ADDRESS,
  MPL_NOOP_PROGRAM_ADDRESS,
} from '../../../../functions/src/shared/solanaProgramAddresses.js';
import {
  processStripeCheckoutFulfillmentDocument,
  type StripeCheckoutDropRuntime,
  type StripeCheckoutFlowDeps,
  type StripeCheckoutFulfillmentProcessResult,
  type StripeCheckoutOnchainConfig,
} from '../../../../functions/src/stripeCheckout/service.js';
import { StripeCheckoutFulfillmentError } from '../../../../functions/src/stripeCheckout/errors.js';
import { stripeCheckoutFieldValue } from '../../../../functions/src/stripeCheckout/store.js';
import {
  publishStripeCheckoutTerminalNotifications,
  type StripeCheckoutTerminalNotificationResult,
} from '../../../../functions/src/stripeCheckout/terminalNotifications.js';
import type { StripeCheckoutFulfillmentJobV1 } from '../../../../functions/src/shared/stripeCheckoutFulfillmentJob.js';
import { FirestoreWriteConflict, createGoogleAccessTokenProvider } from './firestoreRest.js';
import { createWorkerStripeCheckoutStore } from './stripeCheckoutFirestore.js';

const RPC_TIMEOUT_MS = 8_000;
const TX_SEND_TIMEOUT_MS = 12_000;
const TX_CONFIRM_TIMEOUT_MS = 25_000;
const TX_CONFIRM_POLL_MS = 800;

const BUBBLEGUM_PROGRAM_ID = new PublicKey(BUBBLEGUM_PROGRAM_ADDRESS);
const MPL_NOOP_PROGRAM_ID = new PublicKey(MPL_NOOP_PROGRAM_ADDRESS);
const MPL_ACCOUNT_COMPRESSION_PROGRAM_ID = new PublicKey(MPL_ACCOUNT_COMPRESSION_PROGRAM_ADDRESS);
const MPL_CORE_PROGRAM_ID = new PublicKey(MPL_CORE_PROGRAM_ADDRESS);
const MPL_CORE_CPI_SIGNER = new PublicKey(MPL_CORE_CPI_SIGNER_ADDRESS);
const MPL_CORE_COLLECTION_V1_DISCRIMINATOR = 5;
const MPL_CORE_COLLECTION_V1_MIN_BYTES = 49;

type FulfillmentRuntime = StripeCheckoutDropRuntime & {
  config: FunctionsDropConfig;
};

type FulfillmentEnv = Pick<Env,
  | 'ADDRESS_DECRYPTION_SECRET'
  | 'COSIGNER_SECRET'
  | 'FIRESTORE_WRITER_SERVICE_ACCOUNT_JSON'
  | 'HELIUS_API_KEY'
  | 'NOTIFICATION_EMAIL_QUEUE'
  | 'STRIPE_RESTRICTED_KEY'
  | 'STRIPE_RESTRICTED_KEY_LIVE'
  | 'STRIPE_SECRET_KEY'
  | 'STRIPE_SECRET_KEY_LIVE'
>;

type FulfillmentProcessingResult = {
  fulfillment: StripeCheckoutFulfillmentProcessResult;
  notifications: StripeCheckoutTerminalNotificationResult;
};

const accessTokenProvider = createGoogleAccessTokenProvider();

function fulfillmentError(
  code: ConstructorParameters<typeof StripeCheckoutFulfillmentError>[0],
  message: string,
  details?: unknown,
): StripeCheckoutFulfillmentError {
  return new StripeCheckoutFulfillmentError(code, message, details);
}

function configuredPublicKey(label: string, value: string | undefined): PublicKey {
  const normalized = String(value || '').trim();
  if (!normalized) throw fulfillmentError('failed-precondition', `${label} is not configured`);
  try {
    return new PublicKey(normalized);
  } catch {
    throw fulfillmentError('failed-precondition', `${label} is invalid`);
  }
}

function fulfillmentRuntime(rawDropId: unknown): FulfillmentRuntime {
  const dropId = typeof rawDropId === 'string' ? normalizeDropId(rawDropId) : '';
  if (!dropId || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(dropId)) {
    throw fulfillmentError('invalid-argument', 'Invalid dropId');
  }
  const config = getFunctionsDrop(dropId);
  if (!config) throw fulfillmentError('invalid-argument', `Unsupported dropId: ${dropId}`);
  const cluster = config.solanaCluster;
  if (cluster !== 'devnet' && cluster !== 'mainnet-beta') {
    throw fulfillmentError('failed-precondition', 'Stripe checkout is only enabled for devnet and mainnet drops.');
  }
  const boxMinterProgramId = configuredPublicKey('BOX_MINTER_PROGRAM_ID', config.boxMinterProgramId);
  const boxMinterConfigPda = config.boxMinterConfigPda
    ? configuredPublicKey('BOX_MINTER_CONFIG_PDA', config.boxMinterConfigPda)
    : PublicKey.findProgramAddressSync([Buffer.from(BOX_MINTER_CONFIG_SEED)], boxMinterProgramId)[0];
  const collectionMint = configuredPublicKey('COLLECTION_MINT', config.collectionMint);
  const receiptsMerkleTree = configuredPublicKey('RECEIPTS_MERKLE_TREE', config.receiptsMerkleTree);
  return {
    dropId,
    cluster,
    itemsPerBox: config.itemsPerBox,
    maxSupply: config.maxSupply,
    boxMinterProgramId,
    boxMinterConfigPda,
    collectionMint,
    receiptsMerkleTree,
    receiptsMerkleTreeStr: receiptsMerkleTree.toBase58(),
    config,
  };
}

function heliusOrigin(cluster: FulfillmentRuntime['cluster']): string {
  return cluster === 'mainnet-beta' ? 'https://mainnet.helius-rpc.com' : 'https://devnet.helius-rpc.com';
}

function connection(runtime: FulfillmentRuntime, apiKey: string, signal: AbortSignal): Connection {
  const normalized = apiKey.trim();
  if (!normalized) throw fulfillmentError('unavailable', 'HELIUS_API_KEY is not configured');
  return new Connection(`${heliusOrigin(runtime.cluster)}/?api-key=${encodeURIComponent(normalized)}`, {
    commitment: 'confirmed',
    disableRetryOnRateLimit: true,
    fetch: ((input, init) => fetch(input, {
      ...init,
      signal: init?.signal ? AbortSignal.any([signal, init.signal]) : signal,
    })) as FetchFn,
  });
}

async function withTimeout<T>(promise: Promise<T>, milliseconds: number, label: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(fulfillmentError('deadline-exceeded', `${label} timed out after ${milliseconds}ms`)),
          milliseconds,
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function transactionErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function transactionLogs(error: unknown): string[] {
  const logs = error && typeof error === 'object' && 'logs' in error ? (error as { logs?: unknown }).logs : undefined;
  return Array.isArray(logs) ? logs.map(String) : [];
}

function rateLimitOrRpcError(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes('429') ||
    normalized.includes('rate limit') ||
    normalized.includes('too many requests') ||
    normalized.includes('timed out') ||
    normalized.includes('timeout') ||
    normalized.includes('fetch failed') ||
    normalized.includes('econnreset') ||
    normalized.includes('etimedout') ||
    normalized.includes('service unavailable') ||
    normalized.includes('gateway timeout') ||
    normalized.includes('rpc error')
  );
}

function blockhashOrAccountInUseError(message: string, logs: readonly string[]): boolean {
  const normalized = `${message}\n${logs.join('\n')}`.toLowerCase();
  return (
    normalized.includes('blockhash not found') ||
    normalized.includes('blockhash expired') ||
    normalized.includes('transaction expired') ||
    normalized.includes('block height exceeded') ||
    normalized.includes('account in use') ||
    normalized.includes('already in use')
  );
}

async function waitForSignature(
  rpc: Connection,
  signature: string,
  timeoutMs: number,
): Promise<{ ok: true } | { ok: false; error: unknown; logs: string[] }> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const result = await withTimeout(
        rpc.getSignatureStatuses([signature], { searchTransactionHistory: Date.now() - startedAt > 6_000 }),
        RPC_TIMEOUT_MS,
        'getSignatureStatuses',
      );
      const status = result.value[0];
      if (status?.err) {
        const transaction = await withTimeout(
          rpc.getTransaction(signature, { maxSupportedTransactionVersion: 0 }),
          RPC_TIMEOUT_MS,
          'getTransaction:failed',
        ).catch(() => null);
        return {
          ok: false,
          error: status.err,
          logs: Array.isArray(transaction?.meta?.logMessages) ? transaction.meta.logMessages : [],
        };
      }
      if (status?.confirmationStatus === 'confirmed' || status?.confirmationStatus === 'finalized') return { ok: true };
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, TX_CONFIRM_POLL_MS));
  }
  const transaction = await withTimeout(
    rpc.getTransaction(signature, { maxSupportedTransactionVersion: 0 }),
    RPC_TIMEOUT_MS,
    'getTransaction:timeout',
  ).catch(() => null);
  if (transaction?.meta && !transaction.meta.err) return { ok: true };
  return {
    ok: false,
    error: transaction?.meta?.err || 'timeout',
    logs: Array.isArray(transaction?.meta?.logMessages) ? transaction.meta.logMessages : [],
  };
}

async function sendAndConfirmSignedTx(
  rpc: Connection,
  transaction: VersionedTransaction,
  label: string,
  options: { sendTimeoutMs?: number; confirmTimeoutMs?: number } = {},
): Promise<string> {
  const signature = bs58.encode(transaction.signatures[0]);
  let sendError: unknown;
  try {
    await withTimeout(
      rpc.sendTransaction(transaction, { maxRetries: 2 }),
      options.sendTimeoutMs ?? TX_SEND_TIMEOUT_MS,
      `sendTransaction:${label}`,
    );
  } catch (error) {
    sendError = error;
  }
  if (sendError) {
    const logs = transactionLogs(sendError);
    if (logs.length) {
      const message = transactionErrorMessage(sendError);
      const code = blockhashOrAccountInUseError(message, logs)
        ? 'aborted'
        : rateLimitOrRpcError(message) ? 'unavailable' : 'failed-precondition';
      throw fulfillmentError(code, `${label} transaction preflight failed`, {
        signature,
        lastError: message,
        lastLogs: logs.slice(0, 80),
      });
    }
    if ((await waitForSignature(rpc, signature, 12_000)).ok) return signature;
    throw fulfillmentError('unavailable', `${label} transaction submission status unknown (try again)`, {
      signature,
      lastError: transactionErrorMessage(sendError),
      maybeSubmitted: true,
    });
  }
  const confirmation = await waitForSignature(rpc, signature, options.confirmTimeoutMs ?? TX_CONFIRM_TIMEOUT_MS);
  if (confirmation.ok) return signature;
  const message = transactionErrorMessage(confirmation.error);
  throw fulfillmentError(/timeout/i.test(message) ? 'deadline-exceeded' : 'failed-precondition', `${label} transaction not confirmed (try again)`, {
    signature,
    lastError: message,
    lastLogs: confirmation.logs.slice(0, 80),
  });
}

function validateOnchainConfig(
  runtime: FulfillmentRuntime,
  decoded: DecodedBoxMinterConfigData,
): StripeCheckoutOnchainConfig {
  const mismatch = (condition: boolean, message: string, details?: Record<string, unknown>) => {
    if (condition) throw fulfillmentError('failed-precondition', message, { dropId: runtime.dropId, ...details });
  };
  mismatch(decoded.itemsPerBox !== runtime.itemsPerBox, 'On-chain itemsPerBox does not match deployment config');
  mismatch(decoded.maxSupply !== runtime.maxSupply, 'On-chain maxSupply does not match deployment config');
  mismatch(
    decoded.discountMintsPerWallet !== runtime.config.discountMintsPerWallet,
    'On-chain discount limit does not match deployment config',
  );
  mismatch(
    !boxMinterMetadataBaseMatchesDrop(
      decoded.uriBase,
      runtime.config.metadataBase,
      runtime.config.metadataBaseAliases,
    ),
    'On-chain metadata base does not match deployment config',
  );
  const treasury = new PublicKey(decoded.treasury).toBase58();
  mismatch(treasury !== runtime.config.treasury, 'On-chain treasury does not match deployment config');
  const configuredRouting = runtime.config.paymentRouting;
  const onchainRouting = decoded.paymentRouting;
  if (!configuredRouting) {
    mismatch(onchainRouting?.schema !== 'legacy', 'On-chain payment routing does not match deployment config');
  } else {
    mismatch(onchainRouting?.schema !== 'split-payments-v1', 'On-chain payment routing does not match deployment config');
    if (onchainRouting?.schema === 'split-payments-v1') {
      mismatch(
        new PublicKey(onchainRouting.deliveryPaymentReceiver).toBase58() !== configuredRouting.deliveryPaymentReceiver ||
          onchainRouting.mintProceeds.length !== configuredRouting.mintProceeds.length,
        'On-chain payment routing does not match deployment config',
      );
      configuredRouting.mintProceeds.forEach((expected, index) => {
        const actual = onchainRouting.mintProceeds[index];
        mismatch(
          !actual || new PublicKey(actual.address).toBase58() !== expected.address || actual.percentage !== expected.percentage,
          'On-chain payment routing does not match deployment config',
          { recipientIndex: index },
        );
      });
    }
  }
  return {
    admin: new PublicKey(decoded.admin),
    coreCollection: new PublicKey(decoded.coreCollection),
  };
}

function isMplCoreCollectionAccount(
  account: { data: Uint8Array; owner: PublicKey } | null,
): boolean {
  return account !== null &&
    account.owner.equals(MPL_CORE_PROGRAM_ID) &&
    account.data.length >= MPL_CORE_COLLECTION_V1_MIN_BYTES &&
    account.data[0] === MPL_CORE_COLLECTION_V1_DISCRIMINATOR;
}

async function onchainConfig(runtime: FulfillmentRuntime, rpc: Connection): Promise<StripeCheckoutOnchainConfig> {
  const [collectionInfo, info] = await withTimeout(
    rpc.getMultipleAccountsInfo([runtime.collectionMint, runtime.boxMinterConfigPda], { commitment: 'confirmed' }),
    RPC_TIMEOUT_MS,
    'getMultipleAccountsInfo:stripeCheckoutConfig',
  );
  if (!isMplCoreCollectionAccount(collectionInfo)) {
    throw fulfillmentError('failed-precondition', 'Collection account is missing or invalid');
  }
  if (!info?.data || !info.owner.equals(runtime.boxMinterProgramId)) {
    throw fulfillmentError('failed-precondition', 'Box minter config PDA is missing or invalid');
  }
  let decoded;
  try {
    decoded = decodeBoxMinterConfigData(Buffer.from(info.data), { validateDiscriminator: true });
  } catch (error) {
    throw fulfillmentError('failed-precondition', error instanceof Error ? error.message : String(error));
  }
  return validateOnchainConfig(runtime, decoded);
}

function signer(secret: string): Keypair {
  let bytes: Uint8Array;
  try {
    bytes = bs58.decode(secret.trim());
  } catch {
    throw fulfillmentError('unavailable', 'COSIGNER_SECRET is not configured');
  }
  if (bytes.length !== 64) throw fulfillmentError('unavailable', 'COSIGNER_SECRET is not configured');
  return Keypair.fromSecretKey(bytes);
}

function addressEncryptor(secret: string): (plaintext: string) => { encrypted: string; hint: string } | null {
  const secretKey = Buffer.from(secret.trim(), 'base64');
  if (secretKey.length !== ADDRESS_CIPHER_SECRET_KEY_LENGTH) {
    throw fulfillmentError('unavailable', 'ADDRESS_DECRYPTION_SECRET is not configured for Stripe fulfillment');
  }
  const recipient = nacl.box.keyPair.fromSecretKey(secretKey).publicKey;
  return (plaintext) => {
    const normalized = plaintext.trim();
    if (!normalized) return null;
    const parts = encryptAddressCipherText(normalized, recipient);
    return {
      encrypted: serializeAddressCipherPayload(parts, (value) => Buffer.from(value).toString('base64')),
      hint: addressCipherHint(normalized),
    };
  };
}

function summary(error: unknown): Record<string, unknown> {
  if (error instanceof StripeCheckoutFulfillmentError) {
    return { kind: error.name, code: error.code, message: error.message, details: error.details };
  }
  if (error instanceof Error) return { kind: error.name, message: error.message };
  return { kind: typeof error, message: String(error) };
}

function stripeKeys(env: FulfillmentEnv): string[] {
  return Array.from(new Set([
    env.STRIPE_SECRET_KEY,
    env.STRIPE_RESTRICTED_KEY,
    env.STRIPE_SECRET_KEY_LIVE,
    env.STRIPE_RESTRICTED_KEY_LIVE,
  ].map((value) => String(value || '').trim()).filter(Boolean)));
}

function flowDependencies(
  env: FulfillmentEnv,
  store: ReturnType<typeof createWorkerStripeCheckoutStore>,
  signal: AbortSignal,
): StripeCheckoutFlowDeps<FulfillmentRuntime, StripeCheckoutOnchainConfig> {
  return {
    requireDropId: (dropId) => fulfillmentRuntime(dropId).dropId,
    getDropRuntime: fulfillmentRuntime,
    connection: (runtime) => connection(runtime, env.HELIUS_API_KEY, signal),
    ensureOnchainCoreConfig: (runtime) => onchainConfig(runtime, connection(runtime, env.HELIUS_API_KEY, signal)),
    requireStripeCheckoutCollectionMatchesConfig: (runtime, config, code = 'failed-precondition') => {
      if (!runtime.collectionMint.equals(config.coreCollection)) {
        throw fulfillmentError(code, 'COLLECTION_MINT does not match on-chain config', {
          configured: runtime.collectionMint.toBase58(),
          onchain: config.coreCollection.toBase58(),
          dropId: runtime.dropId,
        });
      }
    },
    cosigner: () => signer(env.COSIGNER_SECRET),
    encryptAddress: addressEncryptor(env.ADDRESS_DECRYPTION_SECRET),
    normalizeCountryCode,
    buildTx: (instructions, payer, blockhash, signers) => {
      const transaction = new VersionedTransaction(
        new TransactionMessage({ payerKey: payer, recentBlockhash: blockhash, instructions }).compileToV0Message(),
      );
      if (signers.length) transaction.sign(signers);
      return transaction;
    },
    sendAndConfirmSignedTx,
    withTimeout,
    isAlreadyExistsError: (error) => error instanceof FirestoreWriteConflict && error.status === 'ALREADY_EXISTS',
    summarizeError: summary,
    programs: {
      bubblegumProgramId: BUBBLEGUM_PROGRAM_ID,
      mplNoopProgramId: MPL_NOOP_PROGRAM_ID,
      mplAccountCompressionProgramId: MPL_ACCOUNT_COMPRESSION_PROGRAM_ID,
      mplCoreProgramId: MPL_CORE_PROGRAM_ID,
      mplCoreCpiSigner: MPL_CORE_CPI_SIGNER,
    },
    rpcTimeoutMs: RPC_TIMEOUT_MS,
    txSendTimeoutMs: TX_SEND_TIMEOUT_MS,
    txConfirmTimeoutMs: TX_CONFIRM_TIMEOUT_MS,
    signal,
    countPackStatus: async ({ dropRuntime, orderHashHex, quantity, deliveryId, checkoutSessionId }) => {
      if (!shouldTrackPackStatusForDrop(dropRuntime)) return;
      const eventPath = `drops/${dropRuntime.dropId}/packStatusEvents/redeemedIrlStripe_${encodeURIComponent(orderHashHex)}`;
      await store.runTransaction(async (transaction) => {
        const eventReference = store.doc(eventPath);
        if ((await transaction.get(eventReference)).exists) return;
        transaction.update(store.doc(`drops/${dropRuntime.dropId}/meta/packStatus`), {
          redeemedIrlStripe: stripeCheckoutFieldValue.increment(quantity),
          updatedAt: stripeCheckoutFieldValue.serverTimestamp(),
        });
        transaction.create(eventReference, {
          version: PACK_STATUS_SCHEMA_VERSION,
          dropId: dropRuntime.dropId,
          type: 'redeemedIrlStripe',
          eventKey: orderHashHex,
          quantity,
          increments: { redeemedIrlStripe: quantity },
          deliveryId,
          checkoutSessionId,
          createdAt: stripeCheckoutFieldValue.serverTimestamp(),
        });
      });
    },
    logPackStatusError: (entry) => console.warn(entry),
  };
}

export async function processStripeCheckoutFulfillmentJob(
  job: StripeCheckoutFulfillmentJobV1,
  env: FulfillmentEnv,
  signal: AbortSignal,
  options: { persistenceSignal?: AbortSignal; treatRetryableFailureAsTerminal?: boolean } = {},
): Promise<FulfillmentProcessingResult> {
  const store = createWorkerStripeCheckoutStore({
    accessTokenProvider,
    providerFetch: (input, init) => fetch(input, init),
    serviceAccountJson: env.FIRESTORE_WRITER_SERVICE_ACCOUNT_JSON,
    signal: options.persistenceSignal || signal,
  });
  const checkoutPath = `drops/${job.dropId}/stripeCheckouts/${job.sessionId}`;
  const fulfillment = await processStripeCheckoutFulfillmentDocument({
    db: store,
    dropId: job.dropId,
    sessionId: job.sessionId,
    checkoutRef: store.doc(checkoutPath),
    apiKeys: stripeKeys(env),
    deps: flowDependencies(env, store, signal),
    treatRetryableFailureAsTerminal: options.treatRetryableFailureAsTerminal,
  });
  if (fulfillment.status === 'ignored' && fulfillment.reason === 'not_pending') {
    throw fulfillmentError('aborted', 'Stripe checkout is not ready for fulfillment', {
      dropId: job.dropId,
      sessionId: job.sessionId,
    });
  }
  const notifications = await publishStripeCheckoutTerminalNotifications({
    dropId: job.dropId,
    sessionId: job.sessionId,
    dependencies: {
      loadCheckout: async () => {
        const checkout = await store.doc(checkoutPath).get();
        const data = checkout.data();
        return checkout.exists && data ? { path: checkoutPath, data } : null;
      },
      loadDeliveryOrder: async (dropId, deliveryId) => {
        const order = await store.doc(dropDeliveryOrderPath(dropId, deliveryId)).get();
        return order.exists ? order.data() || null : null;
      },
      enqueueJob: async (notificationJob) => {
        await env.NOTIFICATION_EMAIL_QUEUE.send(notificationJob);
      },
      getDropName: (dropId) => {
        const config = getFunctionsDrop(dropId);
        return config?.displayName || config?.collectionName || dropId;
      },
    },
  });
  const terminalExpected = fulfillment.status !== 'ignored' || (
    fulfillment.reason === 'already_fulfilled' || fulfillment.reason === 'failed'
  );
  if (
    terminalExpected &&
    (notifications.outcome === 'invalid' || notifications.outcome === 'not_terminal')
  ) {
    throw fulfillmentError('unavailable', 'Stripe checkout terminal notification could not be published', {
      outcome: notifications.outcome,
      reason: notifications.reason,
      dropId: job.dropId,
      sessionId: job.sessionId,
    });
  }
  return { fulfillment, notifications };
}

export const stripeCheckoutFulfillmentTestHooks = {
  fulfillmentRuntime,
  isMplCoreCollectionAccount,
  validateOnchainConfig,
};
