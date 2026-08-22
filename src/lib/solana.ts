import bs58 from 'bs58';
import {
  Connection,
  PublicKey,
  SIGNATURE_LENGTH_IN_BYTES,
  VersionedTransaction,
  type SendOptions,
} from '@solana/web3.js';
import {
  ADDRESS_CIPHER_PUBLIC_KEY_LENGTH,
  addressCipherHint,
  encryptAddressCipherText,
  serializeAddressCipherPayload,
} from '../../functions/src/shared/addressCipher.js';
import {
  isExactShopRpcResponse,
  isNonZeroBase58Bytes,
  type ShopRpcRequest,
} from '../../functions/src/shared/solanaRpcProxy.ts';
import { monsApiOrigin } from './monsApiOrigin';

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

function sleep(ms: number, signal?: AbortSignal) {
  if (!signal) return new Promise<void>((resolve) => setTimeout(resolve, ms));
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', abort);
      resolve();
    }, ms);
    const abort = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      reject(signal.reason);
    };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}

const ALREADY_PROCESSED_ERROR_RE = /this transaction has already been processed|already been processed/i;
const BLOCKHASH_EXPIRED_ERROR_RE =
  /blockhash[\s_-]*not[\s_-]*found|blockhash expired|transaction expired|expired blockhash|signature has expired|block height exceeded|TransactionExpiredBlockheightExceededError/i;
const DETERMINISTIC_SHOP_RPC_ERROR_CODES = new Set([-32005, -32096, -32097]);
const DETERMINISTIC_SHOP_RPC_MESSAGE_RE = /^(?:rate limit exceeded|origin not allowed|rate limit unavailable)$/i;
const DETERMINISTIC_SHOP_RPC_CODE_IN_JSON_RE = /"code"\s*:\s*(-32005|-32096|-32097)(?=\s*[,}])/;

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
  return isNonZeroBase58Bytes(value, SIGNATURE_LENGTH_IN_BYTES);
}

function requireValidTransactionSignature(value: unknown): string {
  if (typeof value === 'string' && isLikelyBase58Signature(value)) return value;
  throw new Error('Wallet returned an invalid transaction signature');
}

type AttemptPollingOptions = {
  attempts?: number;
  delayMs?: number;
};

export type SignatureWaitOptions = AttemptPollingOptions & {
  timeoutMs?: number;
  requestTimeoutMs?: number;
  signal?: AbortSignal;
};

// Only the duplicate-submit recovery path uses this longer window.
// That keeps normal failures fast while giving devnet/load-balanced RPCs
// enough time to surface a transaction we already know was accepted elsewhere.
const ALREADY_PROCESSED_RECOVERY_WAIT: AttemptPollingOptions = {
  attempts: 15,
  delayMs: 1_000,
};

const SUBMITTED_SIGNATURE_WAIT: SignatureWaitOptions = {
  delayMs: 500,
  timeoutMs: 12_000,
  requestTimeoutMs: 2_000,
};

const TRANSACTION_CONFIRMATION_WAIT: SignatureWaitOptions = {
  delayMs: 500,
  timeoutMs: 75_000,
  requestTimeoutMs: 35_000,
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
  signal: AbortSignal;
};

function createDeadline(timeoutMs: number): Deadline {
  let reached = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const controller = new AbortController();
  const promise = new Promise<typeof DEADLINE_REACHED>((resolve) => {
    timer = setTimeout(() => {
      reached = true;
      controller.abort(new DOMException('Deadline reached', 'TimeoutError'));
      resolve(DEADLINE_REACHED);
    }, Math.max(0, timeoutMs));
  });
  return {
    promise,
    reached: () => reached,
    signal: controller.signal,
    cancel: () => {
      if (timer != null) clearTimeout(timer);
      timer = null;
    },
  };
}

async function raceDeadline<T>(
  promise: Promise<T>,
  deadline: Deadline,
  signal?: AbortSignal,
): Promise<T | typeof DEADLINE_REACHED> {
  if (deadline.reached()) return DEADLINE_REACHED;
  if (!signal) return Promise.race([promise, deadline.promise]);
  if (signal.aborted) throw signal.reason;
  let abort: (() => void) | null = null;
  const aborted = new Promise<never>((_resolve, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
  });
  try {
    return await Promise.race([promise, deadline.promise, aborted]);
  } finally {
    if (abort) signal.removeEventListener('abort', abort);
  }
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
      DETERMINISTIC_SHOP_RPC_MESSAGE_RE.test(message.trim()) ||
      DETERMINISTIC_SHOP_RPC_CODE_IN_JSON_RE.test(message) ||
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
  if (DETERMINISTIC_SHOP_RPC_ERROR_CODES.has(anyErr?.code)) return true;
  if (Array.isArray(anyErr?.logs) && anyErr.logs.length > 0) return true;

  const message = unwrapTxErrorMessage(err);
  const nestedErrors = [anyErr?.cause, anyErr?.error].filter(Boolean);
  const transactionMessage = typeof anyErr?.transactionMessage === 'string'
    ? anyErr.transactionMessage
    : nestedErrors.length === 0
      ? message
      : '';
  if (
    DETERMINISTIC_SHOP_RPC_MESSAGE_RE.test(transactionMessage.trim()) ||
    DETERMINISTIC_SHOP_RPC_CODE_IN_JSON_RE.test(message)
  ) {
    return true;
  }
  if (
    /simulation failed|transaction simulation failed|preflight failure|signature verification failure|invalid params|invalid request|method not found|parse error|unsupported transaction version|user rejected|user declined/i.test(
      transactionMessage,
    )
  ) {
    return true;
  }
  return nestedErrors.some((nestedError) => (
    isDeterministicSignedTransactionSendError(nestedError, seen, depth + 1)
  ));
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(value);
  return required.every((key) => Object.prototype.hasOwnProperty.call(value, key)) &&
    keys.every((key) => allowed.has(key));
}

type PolledSignatureStatus = {
  slot: number;
  confirmations: number | null;
  err: unknown;
  confirmationStatus?: 'processed' | 'confirmed' | 'finalized' | null;
};

type RpcContextResult<T> = {
  contextSlot: number;
  value: T;
};

type PolledConfirmationStatus = NonNullable<PolledSignatureStatus['confirmationStatus']> | null;

function isPolledConfirmationStatus(value: unknown): value is PolledConfirmationStatus {
  return value === null || value === 'processed' || value === 'confirmed' || value === 'finalized';
}

function requireSignatureStatusResult(value: unknown): RpcContextResult<PolledSignatureStatus | null> {
  if (
    !isRecord(value) ||
    !isRecord(value.context) ||
    !Number.isSafeInteger(value.context.slot) ||
    Number(value.context.slot) < 0
  ) {
    throw new Error('Solana RPC returned an invalid signature-status response');
  }
  if (!Array.isArray(value.value) || value.value.length !== 1) {
    throw new Error('Solana RPC returned an invalid signature-status response');
  }
  const status = value.value[0];
  if (status === null) {
    return {
      contextSlot: Number(value.context.slot),
      value: null,
    };
  }
  const confirmationStatus = isRecord(status) ? status.confirmationStatus : undefined;
  if (
    !isRecord(status) ||
    !Number.isSafeInteger(status.slot) ||
    Number(status.slot) < 0 ||
    !(status.confirmations === null || (
      Number.isSafeInteger(status.confirmations) && Number(status.confirmations) >= 0
    )) ||
    !Object.prototype.hasOwnProperty.call(status, 'err') ||
    (confirmationStatus !== undefined && !isPolledConfirmationStatus(confirmationStatus))
  ) {
    throw new Error('Solana RPC returned an invalid signature-status response');
  }
  const parsedConfirmationStatus = isPolledConfirmationStatus(confirmationStatus)
    ? confirmationStatus
    : undefined;
  return {
    contextSlot: Number(value.context.slot),
    value: {
      slot: Number(status.slot),
      confirmations: status.confirmations === null ? null : Number(status.confirmations),
      err: status.err,
      ...(parsedConfirmationStatus !== undefined ? { confirmationStatus: parsedConfirmationStatus } : {}),
    },
  };
}

type RequestAbortScope = {
  signal: AbortSignal;
  dispose: () => void;
};

function createRequestAbortScope(
  requestTimeoutMs: number,
  signals: readonly (AbortSignal | undefined)[],
): RequestAbortScope {
  const controller = new AbortController();
  const aborters = signals.flatMap((signal) => {
    if (!signal) return [];
    const abort = () => {
      if (!controller.signal.aborted) {
        controller.abort(signal.reason ?? new DOMException('Aborted', 'AbortError'));
      }
    };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    return [{ signal, abort }];
  });
  const timeout = setTimeout(() => {
    if (!controller.signal.aborted) {
      controller.abort(new DOMException('Solana RPC request timed out', 'TimeoutError'));
    }
  }, requestTimeoutMs);
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timeout);
      for (const { signal, abort } of aborters) signal.removeEventListener('abort', abort);
    },
  };
}

async function fetchShopRpcResult(
  endpoint: string,
  requestBody: ShopRpcRequest,
  requestTimeoutMs: number,
  signals: readonly (AbortSignal | undefined)[],
): Promise<unknown> {
  const scope = createRequestAbortScope(requestTimeoutMs, signals);
  try {
    if (scope.signal.aborted) throw scope.signal.reason;
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
      cache: 'no-store',
      signal: scope.signal,
    });
    if (scope.signal.aborted) throw scope.signal.reason;
    let payload: unknown;
    try {
      payload = await response.json();
    } catch (error) {
      if (scope.signal.aborted) throw scope.signal.reason;
      throw new Error('Solana RPC returned malformed JSON', { cause: error });
    }
    if (scope.signal.aborted) throw scope.signal.reason;
    if (!isExactShopRpcResponse(payload, requestBody.id)) {
      throw new Error('Solana RPC returned an invalid response');
    }
    if (payload.error) {
      throw Object.assign(new Error(`Solana RPC request failed: ${payload.error.message}`), {
        code: payload.error.code,
        data: payload.error.data,
      });
    }
    if (!response.ok) {
      throw new Error(`Solana RPC request failed with HTTP ${response.status}`);
    }
    return payload.result;
  } finally {
    scope.dispose();
  }
}

function shopRpcEndpointForConnection(connection: Connection): string | null {
  const endpoint = Reflect.get(connection, 'rpcEndpoint');
  if (typeof endpoint === 'string' && endpoint.length > 0) {
    const origin = monsApiOrigin();
    if (endpoint !== `${origin}/rpc/mainnet-beta` && endpoint !== `${origin}/rpc/devnet`) {
      throw new Error('Solana RPC connection does not use the mons API');
    }
    return endpoint;
  }
  if (connection instanceof Connection) {
    throw new Error('Solana RPC connection is missing its endpoint');
  }
  return null;
}

async function fetchSignatureStatusResult(
  endpoint: string,
  signature: string,
  searchTransactionHistory: boolean,
  requestTimeoutMs: number,
  signals: readonly (AbortSignal | undefined)[],
): Promise<RpcContextResult<PolledSignatureStatus | null>> {
  const requestBody: ShopRpcRequest = {
    jsonrpc: '2.0',
    id: 1,
    method: 'getSignatureStatuses',
    params: [[signature], { searchTransactionHistory }],
  };
  const result = await fetchShopRpcResult(endpoint, requestBody, requestTimeoutMs, signals);
  return requireSignatureStatusResult(result);
}

async function getSignatureStatusResult(
  connection: Connection,
  signature: string,
  searchTransactionHistory: boolean,
  requestTimeoutMs = DEFAULT_SIGNATURE_STATUS_REQUEST_TIMEOUT_MS,
  signals: readonly (AbortSignal | undefined)[] = [],
): Promise<RpcContextResult<PolledSignatureStatus | null>> {
  const endpoint = shopRpcEndpointForConnection(connection);
  if (endpoint) {
    return fetchSignatureStatusResult(endpoint, signature, searchTransactionHistory, requestTimeoutMs, signals);
  }
  const getSignatureStatus = Reflect.get(connection, 'getSignatureStatus');
  if (typeof getSignatureStatus !== 'function') {
    throw new Error('Solana RPC connection is missing its endpoint');
  }
  const statusPromise = Reflect.apply(getSignatureStatus, connection, [
    signature,
    { searchTransactionHistory },
  ]) as Promise<unknown>;
  const result = await withRequestTimeout(statusPromise, requestTimeoutMs);
  if (!isRecord(result) || !Object.prototype.hasOwnProperty.call(result, 'value')) {
    throw new Error('Solana RPC returned an invalid signature-status response');
  }
  return requireSignatureStatusResult({
    context: result.context,
    value: [result.value],
  });
}

async function getSignatureStatusValue(
  connection: Connection,
  signature: string,
  searchTransactionHistory: boolean,
  requestTimeoutMs = DEFAULT_SIGNATURE_STATUS_REQUEST_TIMEOUT_MS,
  signals: readonly (AbortSignal | undefined)[] = [],
): Promise<PolledSignatureStatus | null> {
  return (await getSignatureStatusResult(
    connection,
    signature,
    searchTransactionHistory,
    requestTimeoutMs,
    signals,
  )).value;
}

function isConfirmedSignatureStatus(status: PolledSignatureStatus | null): boolean {
  if (!status || status.err !== null) return false;
  return hasConfirmedSignatureCommitment(status);
}

function hasConfirmedSignatureCommitment(status: PolledSignatureStatus): boolean {
  if (status.confirmationStatus != null) {
    return status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized';
  }
  return (
    status.confirmations === null ||
    (typeof status.confirmations === 'number' && status.confirmations > 0)
  );
}

function assertSignatureStatusSucceeded(signature: string, status: PolledSignatureStatus | null) {
  if (status?.err && hasConfirmedSignatureCommitment(status)) {
    throw new SubmittedTransactionFailureError(signature, status.err);
  }
}

async function waitForSuccessfulSignature(
  connection: Connection,
  signature: string,
  opts: SignatureWaitOptions = {},
  pollHistoricalUntilDeadline = false,
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
        let status: PolledSignatureStatus | null;
        try {
          const statusResult = await raceDeadline(
            getSignatureStatusValue(
              connection,
              signature,
              false,
              requestTimeoutMs,
              [opts.signal, pollingDeadline.signal],
            ),
            pollingDeadline,
            opts.signal,
          );
          if (statusResult === DEADLINE_REACHED) break;
          status = statusResult;
        } catch {
          if (opts.signal?.aborted) throw opts.signal.reason;
          if (pollingDeadline.reached()) break;
          status = null;
        }
        assertSignatureStatusSucceeded(signature, status);
        if (isConfirmedSignatureStatus(status)) return true;

        if (delayMs > 0) {
          const delayResult = await raceDeadline(sleep(delayMs, opts.signal), pollingDeadline, opts.signal);
          if (delayResult === DEADLINE_REACHED) break;
        }
      }

      if (pollHistoricalUntilDeadline) {
        while (!overallDeadline.reached()) {
          let historicalStatus: PolledSignatureStatus | null;
          try {
            const historicalResult = await raceDeadline(
              getSignatureStatusValue(
                connection,
                signature,
                true,
                requestTimeoutMs,
                [opts.signal, overallDeadline.signal],
              ),
              overallDeadline,
              opts.signal,
            );
            if (historicalResult === DEADLINE_REACHED) break;
            historicalStatus = historicalResult;
          } catch {
            if (opts.signal?.aborted) throw opts.signal.reason;
            if (overallDeadline.reached()) break;
            historicalStatus = null;
          }
          assertSignatureStatusSucceeded(signature, historicalStatus);
          if (isConfirmedSignatureStatus(historicalStatus)) return true;

          if (delayMs > 0) {
            const delayResult = await raceDeadline(sleep(delayMs, opts.signal), overallDeadline, opts.signal);
            if (delayResult === DEADLINE_REACHED) break;
          }
        }
        return false;
      }

      let historicalStatus: PolledSignatureStatus | null;
      try {
        const historicalResult = await raceDeadline(
          getSignatureStatusValue(
            connection,
            signature,
            true,
            requestTimeoutMs,
            [opts.signal, overallDeadline.signal],
          ),
          overallDeadline,
          opts.signal,
        );
        if (historicalResult === DEADLINE_REACHED) return false;
        historicalStatus = historicalResult;
      } catch {
        if (opts.signal?.aborted) throw opts.signal.reason;
        return false;
      }
      assertSignatureStatusSucceeded(signature, historicalStatus);
      return isConfirmedSignatureStatus(historicalStatus);
    } finally {
      pollingDeadline.cancel();
      overallDeadline.cancel();
    }
  }

  const attempts = Math.max(1, Math.floor(opts.attempts ?? 6));
  const delayMs = Math.max(0, Math.floor(opts.delayMs ?? 500));

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    let status: PolledSignatureStatus | null;
    try {
      status = await getSignatureStatusValue(
        connection,
        signature,
        false,
        requestTimeoutMs,
        [opts.signal],
      );
    } catch {
      if (opts.signal?.aborted) throw opts.signal.reason;
      status = null;
    }
    assertSignatureStatusSucceeded(signature, status);
    if (isConfirmedSignatureStatus(status)) return true;

    if (attempt < attempts - 1 && delayMs > 0) {
      await sleep(delayMs, opts.signal);
    }
  }

  let historicalStatus: PolledSignatureStatus | null;
  try {
    historicalStatus = await getSignatureStatusValue(
      connection,
      signature,
      true,
      requestTimeoutMs,
      [opts.signal],
    );
  } catch {
    if (opts.signal?.aborted) throw opts.signal.reason;
    historicalStatus = null;
  }
  assertSignatureStatusSucceeded(signature, historicalStatus);
  return isConfirmedSignatureStatus(historicalStatus);
}

export async function confirmSubmittedTransactionByPolling(
  connection: Connection,
  signatureValue: string,
  options: SignatureWaitOptions = {},
): Promise<void> {
  const signature = requireValidTransactionSignature(signatureValue);
  const confirmed = await waitForSuccessfulSignature(
    connection,
    signature,
    {
      ...TRANSACTION_CONFIRMATION_WAIT,
      ...options,
    },
    true,
  );
  if (!confirmed) {
    throw new PotentiallySubmittedTransactionError(
      signature,
      new Error('Transaction confirmation timed out'),
    );
  }
}

export type SubmittedTransactionReconciliationResult = 'confirmed' | 'failed' | 'expired' | 'unknown';

export type SubmittedTransactionReconciliationOptions = {
  detectExpiry?: boolean;
  timeoutMs?: number;
  pollIntervalMs?: number;
  requestTimeoutMs?: number;
  signal?: AbortSignal;
};

function requireValidRecentBlockhash(value: unknown): string {
  if (typeof value === 'string' && isNonZeroBase58Bytes(value, 32)) return value;
  throw new Error('Invalid recent blockhash');
}

function requireBlockhashValidityResult(
  value: unknown,
  minContextSlot: number,
): RpcContextResult<boolean> {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['context', 'value']) ||
    typeof value.value !== 'boolean' ||
    !isRecord(value.context) ||
    !hasExactKeys(value.context, ['slot'], ['apiVersion']) ||
    !Number.isSafeInteger(value.context.slot) ||
    Number(value.context.slot) < 0 ||
    (value.context.apiVersion !== undefined && typeof value.context.apiVersion !== 'string') ||
    Number(value.context.slot) < minContextSlot
  ) {
    throw new Error('Solana RPC returned an invalid blockhash-validity response');
  }
  return {
    contextSlot: Number(value.context.slot),
    value: value.value,
  };
}

async function fetchBlockhashValidityValue(
  endpoint: string,
  recentBlockhash: string,
  minContextSlot: number,
  requestTimeoutMs: number,
  signals: readonly (AbortSignal | undefined)[],
): Promise<RpcContextResult<boolean>> {
  const requestBody: ShopRpcRequest = {
    jsonrpc: '2.0',
    id: 1,
    method: 'isBlockhashValid',
    params: [recentBlockhash, { commitment: 'confirmed', minContextSlot }],
  };
  const result = await fetchShopRpcResult(endpoint, requestBody, requestTimeoutMs, signals);
  return requireBlockhashValidityResult(result, minContextSlot);
}

async function getBlockhashValidityValue(
  connection: Connection,
  recentBlockhash: string,
  minContextSlot: number,
  requestTimeoutMs: number,
  signals: readonly (AbortSignal | undefined)[],
): Promise<RpcContextResult<boolean>> {
  const endpoint = shopRpcEndpointForConnection(connection);
  if (endpoint) {
    return fetchBlockhashValidityValue(endpoint, recentBlockhash, minContextSlot, requestTimeoutMs, signals);
  }
  const isBlockhashValid = Reflect.get(connection, 'isBlockhashValid');
  if (typeof isBlockhashValid !== 'function') {
    throw new Error('Solana RPC connection is missing its endpoint');
  }
  const activeSignal = signals.find((signal) => signal?.aborted);
  if (activeSignal?.aborted) throw activeSignal.reason;
  const result = await withRequestTimeout(
    Reflect.apply(isBlockhashValid, connection, [
      recentBlockhash,
      { commitment: 'confirmed', minContextSlot },
    ]),
    requestTimeoutMs,
  );
  return requireBlockhashValidityResult(result, minContextSlot);
}

/**
 * Observe a transaction that may already have been submitted. This never sends or
 * resends the transaction. Expiration is conclusive only when the signature is
 * absent from the live cache and history after its recent blockhash becomes invalid.
 */
export async function reconcileSubmittedTransaction(
  connection: Connection,
  submission: { signature: string; recentBlockhash: string; blockhashContextSlot?: number },
  options: SubmittedTransactionReconciliationOptions = {},
): Promise<SubmittedTransactionReconciliationResult> {
  const signature = requireValidTransactionSignature(submission.signature);
  const recentBlockhash = requireValidRecentBlockhash(submission.recentBlockhash);
  const blockhashContextSlot = submission.blockhashContextSlot === undefined
    ? 0
    : normalizeIntegerOption(submission.blockhashContextSlot, 0, 0);
  if (
    submission.blockhashContextSlot !== undefined &&
    (!Number.isSafeInteger(submission.blockhashContextSlot) || submission.blockhashContextSlot < 0)
  ) throw new Error('Invalid blockhash context slot');
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
  const shouldDetectExpiry = options.detectExpiry !== false;
  const searchTransactionHistory = !shouldDetectExpiry;
  const deadline = createDeadline(timeoutMs);

  try {
    if (options.signal?.aborted) throw options.signal.reason;
    while (!deadline.reached()) {
      let statusResult: RpcContextResult<PolledSignatureStatus | null>;
      try {
        const currentResult = await raceDeadline(
          getSignatureStatusResult(
            connection,
            signature,
            searchTransactionHistory,
            requestTimeoutMs,
            [options.signal, deadline.signal],
          ),
          deadline,
          options.signal,
        );
        if (currentResult === DEADLINE_REACHED) return 'unknown';
        statusResult = currentResult;
      } catch {
        if (options.signal?.aborted) throw options.signal.reason;
        if (deadline.reached()) return 'unknown';
        if (pollIntervalMs > 0) {
          const delayResult = await raceDeadline(
            sleep(pollIntervalMs, options.signal),
            deadline,
            options.signal,
          );
          if (delayResult === DEADLINE_REACHED) return 'unknown';
        }
        continue;
      }

      const status = statusResult.value;

      if (status?.err && hasConfirmedSignatureCommitment(status)) return 'failed';
      if (isConfirmedSignatureStatus(status)) return 'confirmed';

      if (status == null && shouldDetectExpiry) {
        let validityResult: RpcContextResult<boolean> | null;
        try {
          const validityResponse = await raceDeadline(
            getBlockhashValidityValue(
              connection,
              recentBlockhash,
              Math.max(blockhashContextSlot, statusResult.contextSlot),
              requestTimeoutMs,
              [options.signal, deadline.signal],
            ),
            deadline,
            options.signal,
          );
          if (validityResponse === DEADLINE_REACHED) return 'unknown';
          validityResult = validityResponse;
        } catch {
          if (options.signal?.aborted) throw options.signal.reason;
          if (deadline.reached()) return 'unknown';
          validityResult = null;
        }

        if (validityResult?.value === false) {
          try {
            const historicalResult = await raceDeadline(
              getSignatureStatusResult(
                connection,
                signature,
                true,
                requestTimeoutMs,
                [options.signal, deadline.signal],
              ),
              deadline,
              options.signal,
            );
            if (historicalResult === DEADLINE_REACHED) return 'unknown';
            const historicalStatus = historicalResult.value;
            if (historicalStatus?.err && hasConfirmedSignatureCommitment(historicalStatus)) return 'failed';
            if (isConfirmedSignatureStatus(historicalStatus)) return 'confirmed';
            if (
              historicalStatus == null &&
              historicalResult.contextSlot >= validityResult.contextSlot
            ) return 'expired';
          } catch {
            if (options.signal?.aborted) throw options.signal.reason;
            if (deadline.reached()) return 'unknown';
            // A failed history lookup cannot prove expiration; keep observing.
          }
        }
      }

      if (pollIntervalMs > 0) {
        const delayResult = await raceDeadline(
          sleep(pollIntervalMs, options.signal),
          deadline,
          options.signal,
        );
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

  let submissionStatusPolled = false;
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
    submissionStatusPolled = true;
    const submitted = await waitForSuccessfulSignature(connection, signature, SUBMITTED_SIGNATURE_WAIT);
    if (!submitted) {
      throw new PotentiallySubmittedTransactionError(
        signature,
        new Error('Transaction confirmation timed out; it may still complete. Wait a moment before retrying.'),
      );
    }
    return signature;
  } catch (err) {
    if (isPotentiallySubmittedTransactionError(err)) {
      await notifySubmitted(err.signature);
      if (submissionStatusPolled) throw err;
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
