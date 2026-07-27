import bs58 from 'bs58';
import {
  Connection,
  PublicKey,
  SIGNATURE_LENGTH_IN_BYTES,
  VersionedTransaction,
  type SendOptions,
  type SignatureStatus,
} from '@solana/web3.js';
import {
  ADDRESS_CIPHER_PUBLIC_KEY_LENGTH,
  addressCipherHint,
  encryptAddressCipherText,
  serializeAddressCipherPayload,
} from '../../functions/src/shared/addressCipher.js';

export { normalizeCountryCode } from '../../functions/src/shared/countryNormalization.ts';

function unwrapTxErrorMessage(err: unknown): string {
  if (!err) return 'Unexpected error';
  if (typeof err === 'string') return err;
  if (err instanceof Error && err.message) return err.message;
  const anyErr = err as any;
  if (typeof anyErr?.message === 'string' && anyErr.message) return anyErr.message;
  if (typeof anyErr?.error?.message === 'string' && anyErr.error.message) return anyErr.error.message;
  if (typeof anyErr?.error === 'string' && anyErr.error) return anyErr.error;
  return 'Unexpected error';
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

const ALREADY_PROCESSED_ERROR_RE = /this transaction has already been processed|already been processed/i;
const BLOCKHASH_EXPIRED_ERROR_RE =
  /blockhash[\s_-]*not[\s_-]*found|blockhash expired|transaction expired|expired blockhash|signature has expired|block height exceeded|TransactionExpiredBlockheightExceededError/i;

export function isBlockhashExpiredError(err: unknown, seen = new Set<unknown>(), depth = 0): boolean {
  if (!err || depth > 6) return false;
  if (typeof err === 'object') {
    if (seen.has(err)) return false;
    seen.add(err);
  }
  const anyErr = err as any;
  const msg = unwrapTxErrorMessage(err);
  if (BLOCKHASH_EXPIRED_ERROR_RE.test(msg)) return true;
  if (anyErr?.simulationError && isBlockhashExpiredError(anyErr.simulationError, seen, depth + 1)) return true;
  if (anyErr?.cause && isBlockhashExpiredError(anyErr.cause, seen, depth + 1)) return true;
  return false;
}

function isAlreadyProcessedError(err: unknown): boolean {
  if (!err) return false;
  const anyErr = err as any;
  const msg = unwrapTxErrorMessage(err);
  if (ALREADY_PROCESSED_ERROR_RE.test(msg)) return true;
  if (anyErr?.cause) return isAlreadyProcessedError(anyErr.cause);
  return false;
}

function isValidTransactionSignatureBytes(value: unknown): value is Uint8Array {
  if (!(value instanceof Uint8Array) || value.length !== SIGNATURE_LENGTH_IN_BYTES) return false;
  for (let i = 0; i < value.length; i += 1) {
    if (value[i] !== 0) return true;
  }
  return false;
}

function isLikelyBase58Signature(value: string): boolean {
  if (value.length < 64 || value.length > 88 || !/^[1-9A-HJ-NP-Za-km-z]+$/.test(value)) return false;
  try {
    return isValidTransactionSignatureBytes(bs58.decode(value));
  } catch {
    return false;
  }
}

function requireValidTransactionSignature(value: unknown): string {
  if (typeof value === 'string' && isLikelyBase58Signature(value)) return value;
  throw new Error('Wallet returned an invalid transaction signature');
}

type AttemptPollingOptions = {
  attempts?: number;
  delayMs?: number;
};

type SignatureWaitOptions = AttemptPollingOptions & {
  timeoutMs?: number;
  requestTimeoutMs?: number;
};

// Only the duplicate-submit recovery path uses this longer window.
// That keeps normal failures fast while giving devnet/load-balanced RPCs
// enough time to surface a transaction we already know was accepted elsewhere.
const ALREADY_PROCESSED_RECOVERY_WAIT: AttemptPollingOptions = {
  attempts: 15,
  delayMs: 1_000,
};

// Keep post-submit confirmation bounded and explicit. This is one status RPC call
// per interval for a single active transaction, plus one history lookup at the end.
const SUBMITTED_SIGNATURE_WAIT: SignatureWaitOptions = {
  delayMs: 500,
  timeoutMs: 12_000,
  requestTimeoutMs: 2_000,
};

const DEFAULT_SIGNATURE_STATUS_REQUEST_TIMEOUT_MS = 2_000;
const DEFAULT_RECONCILIATION_TIMEOUT_MS = 3 * 60_000;
const DEFAULT_RECONCILIATION_POLL_INTERVAL_MS = 3_000;
const DEFAULT_PREPARED_TRANSACTION_SIMULATION_TIMEOUT_MS = 10_000;
const DEFAULT_SIGNED_TRANSACTION_SEND_TIMEOUT_MS = 10_000;

function normalizeIntegerOption(value: unknown, fallback: number, minimum: number): number {
  const candidate = typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  return Math.max(minimum, Math.floor(candidate));
}

function normalizeOptionalIntegerOption(value: unknown, minimum: number): number | null {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(minimum, Math.floor(value))
    : null;
}

const DEADLINE_REACHED = Symbol('deadline-reached');

type Deadline = {
  promise: Promise<typeof DEADLINE_REACHED>;
  reached: () => boolean;
  cancel: () => void;
};

function createDeadline(timeoutMs: number): Deadline {
  let reached = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const promise = new Promise<typeof DEADLINE_REACHED>((resolve) => {
    timer = setTimeout(() => {
      reached = true;
      resolve(DEADLINE_REACHED);
    }, Math.max(0, timeoutMs));
  });
  return {
    promise,
    reached: () => reached,
    cancel: () => {
      if (timer != null) clearTimeout(timer);
      timer = null;
    },
  };
}

async function raceDeadline<T>(promise: Promise<T>, deadline: Deadline): Promise<T | typeof DEADLINE_REACHED> {
  if (deadline.reached()) return DEADLINE_REACHED;
  return Promise.race([promise, deadline.promise]);
}

async function withRequestTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  const deadline = createDeadline(Math.max(1, timeoutMs));
  try {
    const result = await raceDeadline(promise, deadline);
    if (result === DEADLINE_REACHED) {
      throw new Error('Solana RPC request timed out');
    }
    return result;
  } finally {
    deadline.cancel();
  }
}

async function waitForCondition(check: () => Promise<boolean>, opts: AttemptPollingOptions = {}): Promise<boolean> {
  const attempts = Math.max(1, Math.floor(opts.attempts ?? 6));
  const delayMs = Math.max(0, Math.floor(opts.delayMs ?? 500));

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      if (await check()) return true;
    } catch {
      // Ignore transient RPC issues and keep polling briefly.
    }
    if (attempt < attempts - 1 && delayMs > 0) {
      await sleep(delayMs);
    }
  }

  return false;
}

async function extractSendTransactionLogs(err: unknown): Promise<string[] | undefined> {
  if (!err) return undefined;
  const anyErr = err as any;

  const directLogs = anyErr?.logs;
  if (Array.isArray(directLogs) && directLogs.every((l: any) => typeof l === 'string')) {
    return directLogs as string[];
  }

  const getLogs = anyErr?.getLogs;
  if (typeof getLogs === 'function') {
    try {
      const result = await getLogs.call(anyErr);
      if (Array.isArray(result) && result.every((l: any) => typeof l === 'string')) {
        return result as string[];
      }
    } catch {
      // Ignore getLogs failures; we'll fall back to message-only errors.
    }
  }

  // Some adapters wrap the underlying SendTransactionError under `cause`.
  if (anyErr?.cause) return extractSendTransactionLogs(anyErr.cause);
  return undefined;
}

function extractTransactionSignature(tx: VersionedTransaction): string | null {
  const signature = tx.signatures[0];
  if (!isValidTransactionSignatureBytes(signature)) return null;
  return bs58.encode(signature);
}

function extractSignatureCandidate(value: unknown, seen = new Set<unknown>(), depth = 0): string | null {
  if (!value || depth > 4) return null;
  if (typeof value !== 'object') return null;
  if (seen.has(value)) return null;
  seen.add(value);

  const anyValue = value as any;
  const directSignature = anyValue?.signature;
  if (typeof directSignature === 'string' && isLikelyBase58Signature(directSignature)) {
    return directSignature;
  }
  if (isValidTransactionSignatureBytes(directSignature)) {
    return bs58.encode(directSignature);
  }

  const candidateKeys = ['cause', 'error', 'transactionError', 'data'];
  for (const key of candidateKeys) {
    const nested = anyValue?.[key];
    const nestedSignature = extractSignatureCandidate(nested, seen, depth + 1);
    if (nestedSignature) return nestedSignature;
  }

  return null;
}

function describeSignatureStatusError(err: unknown): string {
  if (!err) return 'Unknown transaction error';
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

class PreparedTransactionSimulationError extends Error {
  readonly simulationError: unknown;
  readonly logs: string[];

  constructor(simulationError: unknown, logs: string[] | null) {
    super(`Transaction simulation failed: ${describeSignatureStatusError(simulationError)}`);
    this.name = 'PreparedTransactionSimulationError';
    this.simulationError = simulationError;
    this.logs = logs ?? [];
  }
}

export class PotentiallySubmittedTransactionError extends Error {
  readonly signature: string;
  readonly cause: unknown;

  constructor(signature: string, cause: unknown) {
    const detail = unwrapTxErrorMessage(cause);
    super(
      `Transaction may have been submitted, but its status is uncertain (${signature})${
        detail && detail !== 'Unexpected error' ? `: ${detail}` : ''
      }`,
    );
    this.name = 'PotentiallySubmittedTransactionError';
    this.signature = signature;
    this.cause = cause;
  }
}

export function isPotentiallySubmittedTransactionError(err: unknown): err is PotentiallySubmittedTransactionError {
  const anyErr = err as any;
  return (
    (err instanceof PotentiallySubmittedTransactionError || anyErr?.name === 'PotentiallySubmittedTransactionError') &&
    typeof anyErr?.signature === 'string' &&
    isLikelyBase58Signature(anyErr.signature)
  );
}

export class SubmittedTransactionFailureError extends Error {
  readonly signature: string;
  readonly transactionError: unknown;

  constructor(signature: string, transactionError: unknown) {
    super(`Transaction failed: ${describeSignatureStatusError(transactionError)}`);
    this.name = 'SubmittedTransactionFailureError';
    this.signature = signature;
    this.transactionError = transactionError;
  }
}

export function isSubmittedTransactionFailureError(err: unknown): err is SubmittedTransactionFailureError {
  const anyErr = err as any;
  return (
    (err instanceof SubmittedTransactionFailureError || anyErr?.name === 'SubmittedTransactionFailureError') &&
    typeof anyErr?.signature === 'string' &&
    isLikelyBase58Signature(anyErr.signature)
  );
}

function isDeterministicSignedTransactionSendError(err: unknown, seen = new Set<unknown>(), depth = 0): boolean {
  if (!err || depth > 4) return false;
  if (typeof err !== 'object') {
    const message = unwrapTxErrorMessage(err);
    return (
      isBlockhashExpiredError(err) ||
      /simulation failed|transaction simulation failed|preflight failure|signature verification failure|user rejected|user declined/i.test(
        message,
      )
    );
  }
  if (seen.has(err)) return false;
  seen.add(err);

  if (isBlockhashExpiredError(err) || isSubmittedTransactionFailureError(err)) return true;
  const anyErr = err as any;
  if (anyErr?.name === 'PreparedTransactionSimulationError') return true;
  if (anyErr?.code === 4001 || anyErr?.code === 4100) return true;
  if (anyErr?.transactionError != null) return true;
  if (Array.isArray(anyErr?.logs) && anyErr.logs.length > 0) return true;

  const message = unwrapTxErrorMessage(err);
  if (
    /simulation failed|transaction simulation failed|preflight failure|signature verification failure|invalid params|invalid request|method not found|parse error|unsupported transaction version|user rejected|user declined/i.test(
      message,
    )
  ) {
    return true;
  }
  return anyErr?.cause ? isDeterministicSignedTransactionSendError(anyErr.cause, seen, depth + 1) : false;
}

/**
 * Classify an error thrown after a signed transaction was handed to an RPC send call.
 * Callers should invoke this only at that boundary: signing or wallet-approval errors
 * happen before submission is possible and must remain ordinary failures.
 */
export function classifySignedTransactionSendError(tx: VersionedTransaction, err: unknown): unknown {
  if (isPotentiallySubmittedTransactionError(err)) return err;
  const signature = extractTransactionSignature(tx) || extractSignatureCandidate(err);
  if (isAlreadyProcessedError(err)) {
    return signature ? new PotentiallySubmittedTransactionError(signature, err) : err;
  }
  if (isDeterministicSignedTransactionSendError(err)) return err;
  return signature ? new PotentiallySubmittedTransactionError(signature, err) : err;
}

export type SendSignedTransactionViaConnectionOptions = {
  timeoutMs?: number;
  sendOptions?: SendOptions;
  onBroadcastAttempt?: (signature: string) => void;
};

/**
 * Submit an already-signed transaction through the provided RPC connection.
 * The deadline starts after local serialization, so only the ambiguous network
 * submission boundary is timed and classified as potentially submitted.
 */
export async function sendSignedTransactionViaConnection(
  tx: VersionedTransaction,
  connection: Connection,
  options: SendSignedTransactionViaConnectionOptions = {},
): Promise<string> {
  const raw = tx.serialize();
  const signature = extractTransactionSignature(tx);
  if (!signature) {
    throw new Error('Signed transaction is missing the fee payer signature');
  }
  const timeoutMs = normalizeIntegerOption(
    options.timeoutMs,
    DEFAULT_SIGNED_TRANSACTION_SEND_TIMEOUT_MS,
    1,
  );

  options.onBroadcastAttempt?.(signature);
  try {
    await withRequestTimeout(connection.sendRawTransaction(raw, options.sendOptions), timeoutMs);
    return signature;
  } catch (err) {
    throw classifySignedTransactionSendError(tx, err);
  }
}

async function getSignatureStatusValue(
  connection: Connection,
  signature: string,
  searchTransactionHistory: boolean,
  requestTimeoutMs = DEFAULT_SIGNATURE_STATUS_REQUEST_TIMEOUT_MS,
): Promise<SignatureStatus | null> {
  const status = await withRequestTimeout(
    connection.getSignatureStatus(signature, { searchTransactionHistory }),
    requestTimeoutMs,
  );
  return status.value ?? null;
}

function isConfirmedSignatureStatus(status: SignatureStatus | null): boolean {
  if (!status || status.err) return false;
  return (
    status.confirmationStatus === 'confirmed' ||
    status.confirmationStatus === 'finalized' ||
    status.confirmations === null ||
    (typeof status.confirmations === 'number' && status.confirmations > 0)
  );
}

function assertSignatureStatusSucceeded(signature: string, status: SignatureStatus | null) {
  if (status?.err) {
    throw new SubmittedTransactionFailureError(signature, status.err);
  }
}

async function waitForSuccessfulSignature(
  connection: Connection,
  signature: string,
  opts: SignatureWaitOptions = {},
): Promise<boolean> {
  const timeoutMs = normalizeOptionalIntegerOption(opts.timeoutMs, 1);
  const requestTimeoutMs = normalizeIntegerOption(
    opts.requestTimeoutMs,
    DEFAULT_SIGNATURE_STATUS_REQUEST_TIMEOUT_MS,
    1,
  );
  if (timeoutMs != null) {
    const overallDeadline = createDeadline(timeoutMs);
    const pollingDeadline = createDeadline(Math.max(0, timeoutMs - requestTimeoutMs));
    const delayMs = Math.max(0, Math.floor(opts.delayMs ?? 500));
    try {
      while (!pollingDeadline.reached()) {
        const statusResult = await raceDeadline(
          getSignatureStatusValue(connection, signature, false, requestTimeoutMs).catch(() => null),
          pollingDeadline,
        );
        if (statusResult === DEADLINE_REACHED) break;
        assertSignatureStatusSucceeded(signature, statusResult);
        if (isConfirmedSignatureStatus(statusResult)) return true;

        if (delayMs > 0) {
          const delayResult = await raceDeadline(sleep(delayMs), pollingDeadline);
          if (delayResult === DEADLINE_REACHED) break;
        }
      }

      const historicalResult = await raceDeadline(
        getSignatureStatusValue(connection, signature, true, requestTimeoutMs).catch(() => null),
        overallDeadline,
      );
      if (historicalResult === DEADLINE_REACHED) return false;
      assertSignatureStatusSucceeded(signature, historicalResult);
      return isConfirmedSignatureStatus(historicalResult);
    } finally {
      pollingDeadline.cancel();
      overallDeadline.cancel();
    }
  }

  const attempts = Math.max(1, Math.floor(opts.attempts ?? 6));
  const delayMs = Math.max(0, Math.floor(opts.delayMs ?? 500));

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const status = await getSignatureStatusValue(connection, signature, false, requestTimeoutMs).catch(() => null);
    assertSignatureStatusSucceeded(signature, status);
    if (isConfirmedSignatureStatus(status)) return true;

    if (attempt < attempts - 1 && delayMs > 0) {
      await sleep(delayMs);
    }
  }

  const historicalStatus = await getSignatureStatusValue(connection, signature, true, requestTimeoutMs).catch(
    () => null,
  );
  assertSignatureStatusSucceeded(signature, historicalStatus);
  return isConfirmedSignatureStatus(historicalStatus);
}

export type SubmittedTransactionReconciliationResult = 'confirmed' | 'failed' | 'expired' | 'unknown';

export type SubmittedTransactionReconciliationOptions = {
  timeoutMs?: number;
  pollIntervalMs?: number;
  requestTimeoutMs?: number;
};

function requireValidRecentBlockhash(value: unknown): string {
  if (typeof value !== 'string' || !value) {
    throw new Error('Invalid recent blockhash');
  }
  try {
    if (bs58.decode(value).length === 32) return value;
  } catch {
    // Fall through to the stable validation error below.
  }
  throw new Error('Invalid recent blockhash');
}

/**
 * Observe a transaction that may already have been submitted. This never sends or
 * resends the transaction. Expiration is conclusive only when the signature is
 * absent from the live cache and history after its recent blockhash becomes invalid.
 */
export async function reconcileSubmittedTransaction(
  connection: Connection,
  submission: { signature: string; recentBlockhash: string },
  options: SubmittedTransactionReconciliationOptions = {},
): Promise<SubmittedTransactionReconciliationResult> {
  const signature = requireValidTransactionSignature(submission.signature);
  const recentBlockhash = requireValidRecentBlockhash(submission.recentBlockhash);
  const timeoutMs = normalizeIntegerOption(
    options.timeoutMs,
    DEFAULT_RECONCILIATION_TIMEOUT_MS,
    1,
  );
  const pollIntervalMs = normalizeIntegerOption(
    options.pollIntervalMs,
    DEFAULT_RECONCILIATION_POLL_INTERVAL_MS,
    0,
  );
  const requestTimeoutMs = normalizeIntegerOption(
    options.requestTimeoutMs,
    DEFAULT_SIGNATURE_STATUS_REQUEST_TIMEOUT_MS,
    1,
  );
  const deadline = createDeadline(timeoutMs);

  try {
    while (!deadline.reached()) {
      let status: SignatureStatus | null;
      try {
        const statusResult = await raceDeadline(
          getSignatureStatusValue(connection, signature, false, requestTimeoutMs),
          deadline,
        );
        if (statusResult === DEADLINE_REACHED) return 'unknown';
        status = statusResult;
      } catch {
        status = null;
        if (pollIntervalMs > 0) {
          const delayResult = await raceDeadline(sleep(pollIntervalMs), deadline);
          if (delayResult === DEADLINE_REACHED) return 'unknown';
        }
        continue;
      }

      if (status?.err) return 'failed';
      if (isConfirmedSignatureStatus(status)) return 'confirmed';

      if (status == null) {
        let blockhashValid: boolean;
        try {
          const validityResult = await raceDeadline(
            withRequestTimeout(
              connection.isBlockhashValid(recentBlockhash, { commitment: 'confirmed' }),
              requestTimeoutMs,
            ),
            deadline,
          );
          if (validityResult === DEADLINE_REACHED) return 'unknown';
          blockhashValid = validityResult.value;
        } catch {
          blockhashValid = true;
        }

        if (!blockhashValid) {
          try {
            const historicalResult = await raceDeadline(
              getSignatureStatusValue(connection, signature, true, requestTimeoutMs),
              deadline,
            );
            if (historicalResult === DEADLINE_REACHED) return 'unknown';
            if (historicalResult?.err) return 'failed';
            if (isConfirmedSignatureStatus(historicalResult)) return 'confirmed';
            if (historicalResult == null) return 'expired';
          } catch {
            // A failed history lookup cannot prove expiration; keep observing.
          }
        }
      }

      if (pollIntervalMs > 0) {
        const delayResult = await raceDeadline(sleep(pollIntervalMs), deadline);
        if (delayResult === DEADLINE_REACHED) return 'unknown';
      }
    }
    return 'unknown';
  } finally {
    deadline.cancel();
  }
}

export async function recoverAlreadyProcessedSignature(
  tx: VersionedTransaction | null,
  connection: Connection,
  err: unknown,
): Promise<string | null> {
  if (!isAlreadyProcessedError(err)) return null;
  const signature = (tx ? extractTransactionSignature(tx) : null) || extractSignatureCandidate(err);
  if (!signature) return null;
  const confirmed = await waitForSuccessfulSignature(connection, signature, ALREADY_PROCESSED_RECOVERY_WAIT);
  if (!confirmed) return null;
  console.warn('[mons/solana] transaction was already processed; treating existing signature as success', {
    signature,
    error: unwrapTxErrorMessage(err),
  });
  return signature;
}

async function waitForAccounts(
  connection: Connection,
  accounts: readonly PublicKey[],
  opts: AttemptPollingOptions = {},
): Promise<boolean> {
  return waitForCondition(async () => {
    const infos = await connection.getMultipleAccountsInfo([...accounts], { commitment: 'confirmed' });
    return infos.length === accounts.length && infos.every(Boolean);
  }, opts);
}

export async function recoverAlreadyProcessedAccounts(
  connection: Connection,
  accounts: readonly PublicKey[],
  err: unknown,
): Promise<boolean> {
  if (!isAlreadyProcessedError(err)) return false;
  if (!accounts.length) return false;
  const confirmed = await waitForAccounts(connection, accounts, ALREADY_PROCESSED_RECOVERY_WAIT);
  if (!confirmed) return false;
  console.warn('[mons/solana] transaction was already processed; treating confirmed account changes as success', {
    accounts: accounts.map((account) => account.toBase58()),
    error: unwrapTxErrorMessage(err),
  });
  return true;
}

function describeRequiredSigners(tx: VersionedTransaction): { required: string[]; missingNonPayer: string[] } | null {
  const msg: any = (tx as any).message;
  const header = msg?.header;
  const staticKeys = msg?.staticAccountKeys;
  const num = header?.numRequiredSignatures;
  if (!Array.isArray(staticKeys) || typeof num !== 'number' || num <= 0) return null;

  const required = staticKeys.slice(0, num).map((k: any) => (typeof k?.toBase58 === 'function' ? k.toBase58() : String(k)));
  const missingNonPayer: string[] = [];
  for (let i = 1; i < Math.min(required.length, tx.signatures.length); i += 1) {
    if (!isValidTransactionSignatureBytes(tx.signatures[i])) missingNonPayer.push(required[i]);
  }
  return { required, missingNonPayer };
}

type SendPreparedTransactionOptions = {
  onSubmitted?: (signature: string, tx: VersionedTransaction) => void | Promise<void>;
  simulateBeforeSigning?: boolean;
  simulationTimeoutMs?: number;
};

export async function sendPreparedTransaction(
  encodedTx: string,
  connection: Connection,
  signer: (tx: VersionedTransaction) => Promise<string>,
  options: SendPreparedTransactionOptions = {},
): Promise<string> {
  let tx: VersionedTransaction;
  try {
    tx = VersionedTransaction.deserialize(Buffer.from(encodedTx, 'base64'));
  } catch (err) {
    throw new Error(`Invalid transaction payload (decode failed): ${unwrapTxErrorMessage(err)}`);
  }

  // If the backend forgot to include a required non-wallet signature, preflight will fail with
  // "Transaction signature verification failure" before any program logs exist. Surface this up-front.
  const signerInfo = describeRequiredSigners(tx);
  if (signerInfo?.missingNonPayer?.length) {
    console.error('[mons/solana] prepared transaction is missing required server signatures', signerInfo);
  }

  let submittedNotified = false;
  const notifySubmitted = async (signature: string) => {
    if (submittedNotified) return;
    submittedNotified = true;
    await options.onSubmitted?.(signature, tx);
  };

  try {
    if (options.simulateBeforeSigning) {
      const simulationTimeoutMs = normalizeIntegerOption(
        options.simulationTimeoutMs,
        DEFAULT_PREPARED_TRANSACTION_SIMULATION_TIMEOUT_MS,
        1,
      );
      const simulation = await withRequestTimeout(
        connection.simulateTransaction(tx, {
          sigVerify: false,
          commitment: 'confirmed',
        }),
        simulationTimeoutMs,
      );
      if (simulation.value.err) {
        throw new PreparedTransactionSimulationError(simulation.value.err, simulation.value.logs);
      }
    }

    const signature = requireValidTransactionSignature(await signer(tx));
    await notifySubmitted(signature);
    const submitted = await waitForSuccessfulSignature(connection, signature, SUBMITTED_SIGNATURE_WAIT);
    if (!submitted) {
      throw new Error(
        `Transaction was submitted, but confirmation timed out (${signature}). It may still complete; wait a moment before retrying.`,
      );
    }
    return signature;
  } catch (err) {
    if (isPotentiallySubmittedTransactionError(err)) {
      await notifySubmitted(err.signature);
      const submitted = await waitForSuccessfulSignature(connection, err.signature, SUBMITTED_SIGNATURE_WAIT);
      if (submitted) return err.signature;
      throw err;
    }
    const recoveredSignature = await recoverAlreadyProcessedSignature(tx, connection, err);
    if (recoveredSignature) {
      await notifySubmitted(recoveredSignature);
      return recoveredSignature;
    }
    if (isSubmittedTransactionFailureError(err)) {
      console.error('[mons/solana] transaction failed', {
        signature: err.signature,
        error: err.transactionError,
        ...(signerInfo ? { signerInfo } : {}),
      });
      throw err;
    }
    const logs = await extractSendTransactionLogs(err);
    let msg = unwrapTxErrorMessage(err);
    if (logs?.length) {
      const idx = msg.indexOf('Logs:');
      if (idx !== -1) msg = msg.slice(0, idx).trim();
    }
    if (logs?.length) {
      // Keep this noisy output limited to failures; these logs are essential for diagnosing on-chain issues.
      console.error('[mons/solana] transaction failed', { message: msg, logs, ...(signerInfo ? { signerInfo } : {}) });
    } else {
      console.error('[mons/solana] transaction failed', { error: err, ...(signerInfo ? { signerInfo } : {}) });
    }
    const hint = isBlockhashExpiredError(err)
      ? ' (try again; also ensure your wallet network matches the app cluster)'
      : '';
    const logHint = logs?.length ? ' (see console for full program logs)' : '';
    throw new Error(`${msg || 'Transaction failed'}${hint}${logHint}`);
  }
}

export function encryptAddressPayload(
  plaintext: string,
  recipientPublicKey: string,
): { cipherText: string; hint: string } {
  const rawKey = (recipientPublicKey || '').trim();
  if (!rawKey) {
    throw new Error('Missing address encryption public key (set `ADDRESS_ENCRYPTION_PUBLIC_KEY` in src/App.tsx)');
  }

  let remoteKey: Uint8Array;
  try {
    remoteKey = Buffer.from(rawKey, 'base64');
  } catch {
    remoteKey = new Uint8Array();
  }

  if (remoteKey.length !== ADDRESS_CIPHER_PUBLIC_KEY_LENGTH) {
    const looksBase58 = /^[1-9A-HJ-NP-Za-km-z]+$/.test(rawKey);
    const hint = looksBase58
      ? ' It looks like you pasted a base58 Solana address. This must be a TweetNaCl box (Curve25519) public key encoded in base64.'
      : '';
    throw new Error(
      `Invalid address encryption public key: expected base64 Curve25519 public key (${ADDRESS_CIPHER_PUBLIC_KEY_LENGTH} bytes), got ${remoteKey.length} bytes after base64 decode.${hint}`,
    );
  }
  const parts = encryptAddressCipherText(plaintext, remoteKey);
  const cipherText = serializeAddressCipherPayload(
    parts,
    (value) => Buffer.from(value).toString('base64'),
  );

  // Very small hint to display in UI without leaking full address
  const hint = addressCipherHint(plaintext);

  return { cipherText, hint };
}

export function shortAddress(addr: string, chars = 4) {
  return addr.length <= chars * 2 ? addr : `${addr.slice(0, chars)}...${addr.slice(-chars)}`;
}

export function buildSignInMessage(wallet: string, uid: string): string {
  const domain = window?.location?.hostname || 'mons.shop';
  const ts = new Date().toISOString();
  return `Sign in to mons.shop as ${wallet}\nDomain: ${domain}\nTimestamp: ${ts}\nSession: ${uid}`;
}
