import bs58 from 'bs58';
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  type FetchFn,
} from '@solana/web3.js';
import { getApiDrop, type ApiDropConfig } from './dropConfig.js';
import {
  BoxMinterConfigCodecError,
  decodeBoxMinterConfigData,
  type DecodedBoxMinterConfigData,
} from '../../../../shared/boxMinterConfigCodec.js';
import {
  BOX_MINTER_CONFIG_SEED,
  isBoxMinterDiscountMintsPerWallet,
  isConfiguredBoxMinterItemsPerBox,
} from '../../../../shared/boxMinterProtocol.js';
import {
  boxMinterMetadataBaseMatchesDrop,
  normalizeDropId,
  type SolanaCluster,
} from '../../../../shared/deploymentCore.js';
import {
  BUBBLEGUM_PROGRAM_ADDRESS,
  MPL_ACCOUNT_COMPRESSION_PROGRAM_ADDRESS,
  MPL_CORE_CPI_SIGNER_ADDRESS,
  MPL_CORE_PROGRAM_ADDRESS,
  MPL_NOOP_PROGRAM_ADDRESS,
  SPL_NOOP_PROGRAM_ADDRESS,
} from '../../../../shared/solanaProgramAddresses.js';
import {
  cancelResponseBody,
  readBoundedResponseBytes,
  type ProfileProviderFetch,
} from './boundedResponse.js';
import {
  createTimedAbortScope,
  isSignalCancellationError,
  raceWithSignal,
  sleepWithSignal,
} from './boundedRequest.js';
import { isRecord } from './dataAccess.js';
import { DeliveryReceiptError, mapProviderError } from './deliveryReceiptErrors.js';
import { heliusRpcUrl } from './solanaProvider.js';

export { DeliveryReceiptError } from './deliveryReceiptErrors.js';

const PROVIDER_MAX_BYTES = 2 * 1024 * 1024;
const RPC_TIMEOUT_MS = 8_000;
export const TX_SEND_TIMEOUT_MS = 12_000;
export const TX_CONFIRM_TIMEOUT_MS = 25_000;
const TX_CONFIRM_POLL_MS = 800;
export const MAX_U32 = 0xffff_ffff;
const MPL_CORE_COLLECTION_V1_DISCRIMINATOR = 5;
const MPL_CORE_COLLECTION_V1_MIN_BYTES = 49;
const IX_CLOSE_DELIVERY = Buffer.from('ae641ab98ea5f208', 'hex');
const IX_MINT_RECEIPTS = Buffer.from('c7c2556f92996a77', 'hex');
const MPL_CORE_PROGRAM_ID = new PublicKey(MPL_CORE_PROGRAM_ADDRESS);
const SPL_NOOP_PROGRAM_ID = new PublicKey(SPL_NOOP_PROGRAM_ADDRESS);
const MPL_NOOP_PROGRAM_ID = new PublicKey(MPL_NOOP_PROGRAM_ADDRESS);
const MPL_ACCOUNT_COMPRESSION_PROGRAM_ID = new PublicKey(MPL_ACCOUNT_COMPRESSION_PROGRAM_ADDRESS);
const BUBBLEGUM_PROGRAM_ID = new PublicKey(BUBBLEGUM_PROGRAM_ADDRESS);
const MPL_CORE_CPI_SIGNER = new PublicKey(MPL_CORE_CPI_SIGNER_ADDRESS);

export type DeliveryRuntime = {
  config: ApiDropConfig;
  dropId: string;
  cluster: SolanaCluster;
  boxMinterProgramId: PublicKey;
  boxMinterConfigPda: PublicKey;
  collectionMint: PublicKey;
  receiptsMerkleTree: PublicKey;
  itemsPerBox: number;
  maxSupply: number;
  maxDudeId: number;
};

type DecodedOnchainConfig = {
  admin: PublicKey;
  coreCollection: PublicKey;
  decoded: DecodedBoxMinterConfigData;
};

export type ProviderContext = {
  apiKey: string;
  fetch: ProfileProviderFetch;
  signal: AbortSignal;
};

function configuredPublicKey(value: string | undefined, label: string, required = true): PublicKey {
  const normalized = String(value || '').trim();
  if (!normalized) {
    if (!required) return PublicKey.default;
    throw new DeliveryReceiptError('failed-precondition', `${label} is not configured.`);
  }
  try {
    const key = new PublicKey(normalized);
    if (required && key.equals(PublicKey.default)) {
      throw new DeliveryReceiptError('failed-precondition', `${label} is not configured.`);
    }
    return key;
  } catch (error) {
    if (error instanceof DeliveryReceiptError) throw error;
    throw new DeliveryReceiptError('failed-precondition', `${label} is invalid.`);
  }
}

export function runtimeForDrop(rawDropId: string): DeliveryRuntime {
  const dropId = normalizeDropId(rawDropId);
  const config = getApiDrop(dropId);
  if (!config) throw new DeliveryReceiptError('invalid-argument', `Unsupported dropId: ${dropId}`);
  const itemsPerBox = Number(config.itemsPerBox);
  const maxSupply = Number(config.maxSupply);
  const maxDudeId = itemsPerBox * maxSupply;
  if (
    !isConfiguredBoxMinterItemsPerBox(itemsPerBox) ||
    !Number.isInteger(maxSupply) || maxSupply < 1 || maxSupply > 0xffff_ffff ||
    !Number.isSafeInteger(maxDudeId) || maxDudeId > 0xffff
  ) {
    throw new DeliveryReceiptError('failed-precondition', 'Delivery drop configuration is invalid.', { dropId });
  }
  const boxMinterProgramId = configuredPublicKey(config.boxMinterProgramId, 'BOX_MINTER_PROGRAM_ID');
  const boxMinterConfigPda = configuredPublicKey(config.boxMinterConfigPda, 'BOX_MINTER_CONFIG_PDA', false);
  return {
    config,
    dropId,
    cluster: config.solanaCluster,
    boxMinterProgramId,
    boxMinterConfigPda: boxMinterConfigPda.equals(PublicKey.default)
      ? PublicKey.findProgramAddressSync([Buffer.from(BOX_MINTER_CONFIG_SEED)], boxMinterProgramId)[0]
      : boxMinterConfigPda,
    collectionMint: configuredPublicKey(config.collectionMint, 'COLLECTION_MINT'),
    receiptsMerkleTree: configuredPublicKey(config.receiptsMerkleTree, 'RECEIPTS_MERKLE_TREE'),
    itemsPerBox,
    maxSupply,
    maxDudeId,
  };
}

export function decodeCosigner(secret: string): Keypair {
  let decoded: Uint8Array;
  try {
    decoded = bs58.decode(secret.trim());
  } catch {
    throw new DeliveryReceiptError('unavailable', 'Receipt issuance is temporarily unavailable.');
  }
  if (decoded.length !== 64) {
    throw new DeliveryReceiptError('unavailable', 'Receipt issuance is temporarily unavailable.');
  }
  try {
    return Keypair.fromSecretKey(decoded);
  } catch {
    throw new DeliveryReceiptError('unavailable', 'Receipt issuance is temporarily unavailable.');
  }
}

async function readBoundedProviderResponse(response: Response, signal: AbortSignal): Promise<Uint8Array> {
  return readBoundedResponseBytes(response, {
    maxBytes: PROVIDER_MAX_BYTES,
    signal,
    createError: (failure) => new DeliveryReceiptError(
      'unavailable',
      failure === 'too-large'
        ? 'Receipt provider returned too much data.'
        : failure === 'stream-failed'
          ? 'Receipt provider is temporarily unavailable.'
          : 'Receipt provider returned an invalid response.',
    ),
  });
}

export function createConnection(context: ProviderContext, runtime: DeliveryRuntime): Connection {
  const boundedFetch: FetchFn = async (input, init) => {
    const scope = createTimedAbortScope(context.signal, {
      timeoutMs: RPC_TIMEOUT_MS,
      timeoutMessage: 'Receipt provider request timed out',
    });
    try {
      const response = await raceWithSignal(context.fetch(input, {
        ...init,
        redirect: 'manual',
        signal: scope.signal,
      }), scope.signal);
      if (!response.ok) {
        await cancelResponseBody(response);
        throw new DeliveryReceiptError('unavailable', 'Receipt provider is temporarily unavailable.');
      }
      const body = await readBoundedProviderResponse(response, scope.signal);
      return new Response(Uint8Array.from(body).buffer, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    } catch (error) {
      if (isSignalCancellationError(context.signal, error)) throw context.signal.reason;
      if (scope.timedOut() && isSignalCancellationError(scope.signal, error)) {
        throw new DeliveryReceiptError('deadline-exceeded', 'Receipt provider request timed out.');
      }
      throw mapProviderError(error, 'Receipt provider is temporarily unavailable.');
    } finally {
      scope.dispose();
    }
  };
  return new Connection(heliusRpcUrl(runtime.cluster, context.apiKey), {
    commitment: 'confirmed',
    disableRetryOnRateLimit: true,
    fetch: boundedFetch,
  });
}

function u16LE(value: number): Buffer {
  const buffer = Buffer.alloc(2);
  buffer.writeUInt16LE(value & 0xffff, 0);
  return buffer;
}

function u32LE(value: number): Buffer {
  if (!Number.isInteger(value) || value < 0 || value > MAX_U32) {
    throw new DeliveryReceiptError('invalid-argument', 'Invalid unsigned 32-bit integer.');
  }
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(value, 0);
  return buffer;
}

export function deriveDeliveryPda(runtime: DeliveryRuntime, deliveryId: number): [PublicKey, number] {
  const singleton = PublicKey.findProgramAddressSync(
    [Buffer.from(BOX_MINTER_CONFIG_SEED)],
    runtime.boxMinterProgramId,
  )[0];
  const seeds: Uint8Array[] = [Buffer.from('delivery')];
  if (!runtime.boxMinterConfigPda.equals(singleton)) seeds.push(runtime.boxMinterConfigPda.toBuffer());
  seeds.push(u32LE(deliveryId));
  return PublicKey.findProgramAddressSync(seeds, runtime.boxMinterProgramId);
}

function deriveTreeConfigPda(merkleTree: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([merkleTree.toBuffer()], BUBBLEGUM_PROGRAM_ID)[0];
}

function decodeOnchainConfig(data: Buffer): DecodedOnchainConfig {
  try {
    const decoded = decodeBoxMinterConfigData(data, { validateDiscriminator: true });
    return {
      admin: new PublicKey(decoded.admin),
      coreCollection: new PublicKey(decoded.coreCollection),
      decoded,
    };
  } catch (error) {
    if (error instanceof BoxMinterConfigCodecError) {
      throw new DeliveryReceiptError('failed-precondition', error.message, error.details);
    }
    throw error;
  }
}

function paymentRoutingMatches(config: ApiDropConfig, decoded: DecodedBoxMinterConfigData): boolean {
  const routing = decoded.paymentRouting;
  if (!routing) return false;
  if (!config.paymentRouting) return routing.schema === 'legacy';
  if (routing.schema !== 'split-payments-v1') return false;
  if (
    new PublicKey(routing.deliveryPaymentReceiver).toBase58() !== config.paymentRouting.deliveryPaymentReceiver ||
    routing.mintProceeds.length !== config.paymentRouting.mintProceeds.length
  ) return false;
  return config.paymentRouting.mintProceeds.every((expected, index) => {
    const actual = routing.mintProceeds[index];
    return Boolean(actual) &&
      new PublicKey(actual.address).toBase58() === expected.address &&
      actual.percentage === expected.percentage;
  });
}

function assertOnchainConfigMatchesRuntime(runtime: DeliveryRuntime, config: DecodedOnchainConfig): void {
  const decoded = config.decoded;
  if (
    !config.coreCollection.equals(runtime.collectionMint) ||
    decoded.itemsPerBox !== runtime.itemsPerBox ||
    decoded.maxSupply !== runtime.maxSupply ||
    decoded.discountMintsPerWallet !== runtime.config.discountMintsPerWallet ||
    !isBoxMinterDiscountMintsPerWallet(decoded.discountMintsPerWallet) ||
    !boxMinterMetadataBaseMatchesDrop(
      decoded.uriBase,
      runtime.config.metadataBase,
      runtime.config.metadataBaseAliases,
    ) ||
    new PublicKey(decoded.treasury).toBase58() !== runtime.config.treasury ||
    !paymentRoutingMatches(runtime.config, decoded)
  ) {
    throw new DeliveryReceiptError('failed-precondition', 'Committed drop configuration does not match the on-chain config.');
  }
}

export async function fetchOnchainConfig(
  connection: Connection,
  runtime: DeliveryRuntime,
): Promise<DecodedOnchainConfig> {
  const [collection, info] = await connection.getMultipleAccountsInfo(
    [runtime.collectionMint, runtime.boxMinterConfigPda],
    { commitment: 'confirmed' },
  );
  if (
    !collection?.data ||
    !collection.owner.equals(MPL_CORE_PROGRAM_ID) ||
    collection.data.length < MPL_CORE_COLLECTION_V1_MIN_BYTES ||
    collection.data[0] !== MPL_CORE_COLLECTION_V1_DISCRIMINATOR
  ) {
    throw new DeliveryReceiptError('failed-precondition', 'Configured collection is not an MPL Core collection.');
  }
  if (!info?.data || info.data.length < 104) {
    throw new DeliveryReceiptError('failed-precondition', 'Box minter config PDA was not found.', {
      dropId: runtime.dropId,
      configPda: runtime.boxMinterConfigPda.toBase58(),
    });
  }
  if (!info.owner.equals(runtime.boxMinterProgramId)) {
    throw new DeliveryReceiptError('failed-precondition', 'Box minter config PDA has an unexpected owner.', {
      dropId: runtime.dropId,
    });
  }
  const config = decodeOnchainConfig(Buffer.from(info.data));
  assertOnchainConfigMatchesRuntime(runtime, config);
  return config;
}

export function mplCoreBurnInstruction(args: {
  asset: PublicKey;
  coreCollection: PublicKey;
  signer: PublicKey;
}): TransactionInstruction {
  return new TransactionInstruction({
    programId: MPL_CORE_PROGRAM_ID,
    keys: [
      { pubkey: args.asset, isSigner: false, isWritable: true },
      { pubkey: args.coreCollection, isSigner: false, isWritable: true },
      { pubkey: args.signer, isSigner: true, isWritable: true },
      { pubkey: args.signer, isSigner: true, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: SPL_NOOP_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([12, 0]),
  });
}

function encodeMintReceiptsArgs(
  runtime: DeliveryRuntime,
  boxIds: readonly number[],
  dudeIds: readonly number[],
): Buffer {
  for (const id of boxIds) {
    if (!Number.isSafeInteger(id) || id < 1 || id > 0xffff_ffff) {
      throw new DeliveryReceiptError('invalid-argument', `Invalid box id: ${id}`);
    }
  }
  for (const id of dudeIds) {
    if (!Number.isSafeInteger(id) || id < 1 || id > runtime.maxDudeId) {
      throw new DeliveryReceiptError('invalid-argument', `Invalid figure id: ${id}`);
    }
  }
  return Buffer.concat([
    IX_MINT_RECEIPTS,
    u32LE(boxIds.length),
    ...boxIds.map(u32LE),
    u32LE(dudeIds.length),
    ...dudeIds.map(u16LE),
  ]);
}

export function mintReceiptsInstruction(args: {
  runtime: DeliveryRuntime;
  signer: PublicKey;
  recipient: PublicKey;
  coreCollection: PublicKey;
  boxIds: readonly number[];
  dudeIds: readonly number[];
}): TransactionInstruction {
  return new TransactionInstruction({
    programId: args.runtime.boxMinterProgramId,
    keys: [
      { pubkey: args.runtime.boxMinterConfigPda, isSigner: false, isWritable: false },
      { pubkey: args.signer, isSigner: true, isWritable: true },
      { pubkey: args.recipient, isSigner: false, isWritable: false },
      { pubkey: args.runtime.receiptsMerkleTree, isSigner: false, isWritable: true },
      { pubkey: deriveTreeConfigPda(args.runtime.receiptsMerkleTree), isSigner: false, isWritable: true },
      { pubkey: args.coreCollection, isSigner: false, isWritable: true },
      { pubkey: BUBBLEGUM_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: MPL_NOOP_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: MPL_ACCOUNT_COMPRESSION_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: MPL_CORE_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: MPL_CORE_CPI_SIGNER, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: encodeMintReceiptsArgs(args.runtime, args.boxIds, args.dudeIds),
  });
}

export function closeDeliveryInstruction(args: {
  runtime: DeliveryRuntime;
  signer: PublicKey;
  deliveryPda: PublicKey;
  deliveryId: number;
  deliveryBump: number;
}): TransactionInstruction {
  return new TransactionInstruction({
    programId: args.runtime.boxMinterProgramId,
    keys: [
      { pubkey: args.runtime.boxMinterConfigPda, isSigner: false, isWritable: false },
      { pubkey: args.signer, isSigner: true, isWritable: true },
      { pubkey: args.deliveryPda, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([
      IX_CLOSE_DELIVERY,
      u32LE(args.deliveryId),
      Buffer.from([args.deliveryBump & 0xff]),
    ]),
  });
}

export function buildTransaction(
  instructions: readonly TransactionInstruction[],
  payer: PublicKey,
  blockhash: string,
  signer: Keypair,
): VersionedTransaction {
  const transaction = new VersionedTransaction(new TransactionMessage({
    payerKey: payer,
    recentBlockhash: blockhash,
    instructions: [...instructions],
  }).compileToV0Message());
  transaction.sign([signer]);
  return transaction;
}

export function transactionErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export function unknownTransactionSubmissionError(args: {
  label: string;
  signal: AbortSignal;
  signature: string;
  details?: Record<string, unknown>;
}): DeliveryReceiptError {
  const error = new DeliveryReceiptError(
    args.signal.reason instanceof DOMException && args.signal.reason.name === 'TimeoutError'
      ? 'deadline-exceeded'
      : 'aborted',
    `${args.label} transaction submission status is unknown. Try again.`,
    { ...args.details, signature: args.signature, maybeSubmitted: true },
  );
  Object.defineProperty(error, 'cause', { value: args.signal.reason });
  return error;
}

export function transactionErrorLogs(error: unknown): string[] {
  if (!isRecord(error) || !Array.isArray(error.logs)) return [];
  return error.logs.map(String);
}

export function looksLikeAccountInUseError(message: string, logs: readonly string[]): boolean {
  const value = `${message}\n${logs.join('\n')}`.toLowerCase();
  return value.includes('account in use') || value.includes('already in use');
}

export function looksLikeBlockhashError(message: string): boolean {
  const value = message.toLowerCase();
  return value.includes('blockhash not found') ||
    value.includes('blockhash expired') ||
    value.includes('transaction expired') ||
    value.includes('block height exceeded') ||
    value.includes('transactionexpiredblockheightexceedederror');
}

export function looksLikeRateLimitOrRpcError(message: string): boolean {
  const value = message.toLowerCase();
  return value.includes('429') ||
    value.includes('rate limit') ||
    value.includes('too many requests') ||
    value.includes('timed out') ||
    value.includes('timeout') ||
    value.includes('fetch failed') ||
    value.includes('socket hang up') ||
    value.includes('econnreset') ||
    value.includes('etimedout') ||
    value.includes('service unavailable') ||
    value.includes('gateway timeout') ||
    (value.includes('rpc') && value.includes('error'));
}

export function hasConfirmedSignatureCommitment(status: {
  confirmationStatus?: string | null;
  confirmations: number | null;
} | null | undefined): boolean {
  if (!status) return false;
  if (status.confirmationStatus != null) {
    return status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized';
  }
  return status.confirmations === null || (
    Number.isSafeInteger(status.confirmations) && Number(status.confirmations) > 0
  );
}

export async function waitForSignature(
  connection: Connection,
  signature: string,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<{ ok: true } | { ok: false; definitive: boolean; error: unknown; logs: string[] }> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (signal.aborted) throw signal.reason;
    try {
      const statuses = await connection.getSignatureStatuses([signature], {
        searchTransactionHistory: Date.now() - startedAt > 6_000,
      });
      const status = statuses.value[0];
      if (status?.err) {
        let logs: string[] = [];
        try {
          const transaction = await connection.getTransaction(signature, { maxSupportedTransactionVersion: 0 });
          logs = Array.isArray(transaction?.meta?.logMessages)
            ? transaction.meta.logMessages.filter((entry): entry is string => typeof entry === 'string')
            : [];
        } catch {}
        return { ok: false, definitive: true, error: status.err, logs };
      }
      if (hasConfirmedSignatureCommitment(status)) {
        return { ok: true };
      }
    } catch (error) {
      if (isSignalCancellationError(signal, error)) throw error;
    }
    await sleepWithSignal(TX_CONFIRM_POLL_MS, signal);
  }
  try {
    const transaction = await connection.getTransaction(signature, { maxSupportedTransactionVersion: 0 });
    if (transaction?.meta && !transaction.meta.err) return { ok: true };
    return {
      ok: false,
      definitive: Boolean(transaction?.meta?.err),
      error: transaction?.meta?.err || 'timeout',
      logs: Array.isArray(transaction?.meta?.logMessages)
        ? transaction.meta.logMessages.filter((entry): entry is string => typeof entry === 'string')
        : [],
    };
  } catch (error) {
    if (isSignalCancellationError(signal, error)) throw error;
    return { ok: false, definitive: false, error: 'timeout', logs: [] };
  }
}

export async function sendAndConfirmSignedTransaction(
  connection: Connection,
  transaction: VersionedTransaction,
  signal: AbortSignal,
  label: string,
  onBroadcastStart?: () => void,
): Promise<string> {
  if (signal.aborted) throw signal.reason;
  const signature = bs58.encode(transaction.signatures[0]);
  try {
    let sendError: unknown;
    try {
      onBroadcastStart?.();
      await connection.sendTransaction(transaction, { maxRetries: 2 });
    } catch (error) {
      sendError = error;
    }
    if (sendError) {
      const logs = transactionErrorLogs(sendError);
      if (logs.length) {
        const message = transactionErrorMessage(sendError);
        const code = looksLikeBlockhashError(message) || looksLikeAccountInUseError(message, logs)
          ? 'aborted'
          : looksLikeRateLimitOrRpcError(message) ? 'unavailable' : 'failed-precondition';
        throw new DeliveryReceiptError(code, `${label} transaction preflight failed.`, {
          definitiveFailure: true,
          lastError: message,
          lastLogs: logs.slice(0, 80),
        });
      }
      const maybe = await waitForSignature(connection, signature, signal, TX_SEND_TIMEOUT_MS);
      if (maybe.ok) return signature;
      throw new DeliveryReceiptError('unavailable', `${label} transaction submission status is unknown. Try again.`, {
        maybeSubmitted: true,
        lastError: transactionErrorMessage(sendError),
      });
    }
    const confirmed = await waitForSignature(connection, signature, signal, TX_CONFIRM_TIMEOUT_MS);
    if (confirmed.ok) return signature;
    const message = transactionErrorMessage(confirmed.error);
    throw new DeliveryReceiptError(
      /timeout/i.test(message) ? 'deadline-exceeded' : 'failed-precondition',
      `${label} transaction was not confirmed. Try again.`,
      {
        ...(confirmed.definitive ? { definitiveFailure: true } : {}),
        lastError: message,
        lastLogs: confirmed.logs.slice(0, 80),
      },
    );
  } catch (error) {
    if (isSignalCancellationError(signal, error)) {
      throw unknownTransactionSubmissionError({ label, signal, signature });
    }
    throw error;
  }
}
