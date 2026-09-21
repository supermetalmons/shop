import bs58 from 'bs58';
import type { VersionedTransaction } from '@solana/web3.js';
import { isSignalCancellationError, sleepWithSignal } from './boundedRequest.js';
import { isRecord } from './dataAccess.js';
import {
  RevealDudesError,
  RevealRpcError,
  type ProviderContext,
  type RevealRuntime,
  type RevealSubmission,
  type RevealSubmissionOutcome,
} from './revealDudesDomain.js';
import { rpcCall } from './revealDudesOnchain.js';

const TX_SEND_TIMEOUT_MS = 12_000;

const TX_CONFIRM_TIMEOUT_MS = 25_000;

const TX_CONFIRM_POLL_MS = 800;

function transactionErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const TRANSACTION_ERROR_NAMES = new Set([
  'AccountInUse',
  'AccountLoadedTwice',
  'AccountNotFound',
  'ProgramAccountNotFound',
  'InsufficientFundsForFee',
  'InvalidAccountForFee',
  'AlreadyProcessed',
  'BlockhashNotFound',
  'CallChainTooDeep',
  'MissingSignatureForFee',
  'InvalidAccountIndex',
  'SignatureFailure',
  'InvalidProgramForExecution',
  'SanitizeFailure',
  'ClusterMaintenance',
  'AccountBorrowOutstanding',
  'WouldExceedMaxBlockCostLimit',
  'UnsupportedVersion',
  'InvalidWritableAccount',
  'WouldExceedMaxAccountCostLimit',
  'WouldExceedAccountDataBlockLimit',
  'TooManyAccountLocks',
  'AddressLookupTableNotFound',
  'InvalidAddressLookupTableOwner',
  'InvalidAddressLookupTableData',
  'InvalidAddressLookupTableIndex',
  'InvalidRentPayingAccount',
  'WouldExceedMaxVoteCostLimit',
  'WouldExceedAccountDataTotalLimit',
  'MaxLoadedAccountsDataSizeExceeded',
  'InvalidLoadedAccountsDataSizeLimit',
  'ResanitizationNeeded',
  'UnbalancedTransaction',
  'ProgramCacheHitMaxLimit',
  'CommitCancelled',
]);

const INSTRUCTION_ERROR_NAMES = new Set([
  'GenericError',
  'InvalidArgument',
  'InvalidInstructionData',
  'InvalidAccountData',
  'AccountDataTooSmall',
  'InsufficientFunds',
  'IncorrectProgramId',
  'MissingRequiredSignature',
  'AccountAlreadyInitialized',
  'UninitializedAccount',
  'UnbalancedInstruction',
  'ModifiedProgramId',
  'ExternalAccountLamportSpend',
  'ExternalAccountDataModified',
  'ReadonlyLamportChange',
  'ReadonlyDataModified',
  'DuplicateAccountIndex',
  'ExecutableModified',
  'RentEpochModified',
  'NotEnoughAccountKeys',
  'AccountDataSizeChanged',
  'AccountNotExecutable',
  'AccountBorrowFailed',
  'AccountBorrowOutstanding',
  'DuplicateAccountOutOfSync',
  'InvalidError',
  'ExecutableDataModified',
  'ExecutableLamportChange',
  'ExecutableAccountNotRentExempt',
  'UnsupportedProgramId',
  'CallDepth',
  'MissingAccount',
  'ReentrancyNotAllowed',
  'MaxSeedLengthExceeded',
  'InvalidSeeds',
  'InvalidRealloc',
  'ComputationalBudgetExceeded',
  'PrivilegeEscalation',
  'ProgramEnvironmentSetupFailure',
  'ProgramFailedToComplete',
  'ProgramFailedToCompile',
  'Immutable',
  'IncorrectAuthority',
  'BorshIoError',
  'AccountNotRentExempt',
  'InvalidAccountOwner',
  'ArithmeticOverflow',
  'UnsupportedSysvar',
  'IllegalOwner',
  'MaxAccountsDataAllocationsExceeded',
  'MaxAccountsExceeded',
  'MaxInstructionTraceLengthExceeded',
  'BuiltinProgramsMustConsumeComputeUnits',
]);

function isByteIndex(value: unknown): boolean {
  return Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= 0xff;
}

function isInstructionError(value: unknown): boolean {
  if (typeof value === 'string') return INSTRUCTION_ERROR_NAMES.has(value);
  if (!isRecord(value) || Object.keys(value).length !== 1) return false;
  if (Number.isSafeInteger(value.Custom)) {
    return Number(value.Custom) >= 0 && Number(value.Custom) <= 0xffff_ffff;
  }
  return typeof value.BorshIoError === 'string';
}

function isTransactionError(value: unknown): boolean {
  if (typeof value === 'string') return TRANSACTION_ERROR_NAMES.has(value);
  if (!isRecord(value) || Object.keys(value).length !== 1) return false;
  if (Array.isArray(value.InstructionError)) {
    const [index, error] = value.InstructionError;
    return value.InstructionError.length === 2 && isByteIndex(index) && isInstructionError(error);
  }
  if (isByteIndex(value.DuplicateInstruction)) return true;
  for (const name of ['InsufficientFundsForRent', 'ProgramExecutionTemporarilyRestricted']) {
    const detail = value[name];
    if (
      isRecord(detail) &&
      Object.keys(detail).length === 1 &&
      isByteIndex(detail.account_index)
    ) return true;
  }
  return false;
}

type ConfirmedTransactionOutcome =
  | { outcome: 'confirmed'; logs: string[] }
  | { outcome: 'failed'; error: unknown; logs: string[] }
  | { outcome: 'unknown'; logs: string[] };

function confirmedTransactionOutcome(value: unknown, signature: string): ConfirmedTransactionOutcome {
  if (!isRecord(value) || !Number.isSafeInteger(value.slot) || Number(value.slot) < 0) {
    return { outcome: 'unknown', logs: [] };
  }
  const transaction = value.transaction;
  const meta = value.meta;
  if (
    !isRecord(transaction) ||
    !Array.isArray(transaction.signatures) ||
    transaction.signatures[0] !== signature ||
    !isRecord(meta) ||
    !Object.hasOwn(meta, 'err')
  ) {
    return { outcome: 'unknown', logs: [] };
  }
  const logs = Array.isArray(meta.logMessages)
    ? meta.logMessages.filter((entry): entry is string => typeof entry === 'string').slice(0, 80)
    : [];
  if (meta.err === null) return { outcome: 'confirmed', logs };
  return isTransactionError(meta.err)
    ? { outcome: 'failed', error: meta.err, logs }
    : { outcome: 'unknown', logs };
}

type ParsedSignatureStatus = {
  err: unknown;
  confirmations: number | null;
  confirmationStatus?: 'processed' | 'confirmed' | 'finalized' | null;
};

type ParsedSignatureStatusResult = {
  contextSlot: number;
  status: ParsedSignatureStatus | null;
};

function parseSignatureStatusResult(result: unknown): ParsedSignatureStatusResult | undefined {
  if (
    !isRecord(result) ||
    !isRecord(result.context) ||
    !Number.isSafeInteger(result.context.slot) ||
    Number(result.context.slot) < 0 ||
    !Array.isArray(result.value) ||
    result.value.length !== 1
  ) return undefined;
  const contextSlot = Number(result.context.slot);
  const status = result.value[0];
  if (status === null) return { contextSlot, status: null };
  if (
    !isRecord(status) ||
    !Number.isSafeInteger(status.slot) ||
    Number(status.slot) < 0 ||
    !(status.confirmations === null || (
      Number.isSafeInteger(status.confirmations) && Number(status.confirmations) >= 0
    )) ||
    !Object.hasOwn(status, 'err') ||
    !(
      status.confirmationStatus === undefined ||
      status.confirmationStatus === null ||
      status.confirmationStatus === 'processed' ||
      status.confirmationStatus === 'confirmed' ||
      status.confirmationStatus === 'finalized'
    )
  ) return undefined;
  return {
    contextSlot,
    status: {
      err: status.err,
      confirmations: status.confirmations === null ? null : Number(status.confirmations),
      confirmationStatus: status.confirmationStatus,
    },
  };
}

function hasConfirmedSignatureCommitment(status: ParsedSignatureStatus): boolean {
  if (status.confirmationStatus != null) {
    return status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized';
  }
  return status.confirmations === null || status.confirmations > 0;
}

function signatureStatusOutcome(
  status: ParsedSignatureStatus | null,
): 'confirmed' | 'failed' | 'pending' | 'absent' {
  if (status === null) return 'absent';
  if (!hasConfirmedSignatureCommitment(status)) return 'pending';
  if (status.err === null) return 'confirmed';
  return isTransactionError(status.err) ? 'failed' : 'pending';
}

function preflightFailure(error: unknown): { logs: string[] } | null {
  if (!(error instanceof RevealRpcError) || error.rpcCode !== -32002 || !isRecord(error.rpcData)) return null;
  if (error.rpcData.err === 'AlreadyProcessed') return null;
  if (!isTransactionError(error.rpcData.err) || !Array.isArray(error.rpcData.logs)) return null;
  if (!error.rpcData.logs.every((value) => typeof value === 'string')) return null;
  return {
    logs: error.rpcData.logs.filter((value): value is string => typeof value === 'string').slice(0, 80),
  };
}

export async function waitForSignature(
  context: ProviderContext,
  runtime: RevealRuntime,
  signature: string,
  timeoutMs: number,
): Promise<{ ok: true } | { ok: false; error: unknown; logs: string[] }> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const searchTransactionHistory = Date.now() - startedAt > 6_000;
      const result = await rpcCall(context, runtime, 'getSignatureStatuses', [
        [signature],
        { searchTransactionHistory },
      ], { attempts: 1 });
      const parsed = parseSignatureStatusResult(result);
      const outcome = parsed === undefined ? 'pending' : signatureStatusOutcome(parsed.status);
      if (outcome === 'failed') {
        const transaction = await loadTransactionBestEffort(context, runtime, signature);
        const corroborated = confirmedTransactionOutcome(transaction, signature);
        if (corroborated.outcome === 'confirmed') return { ok: true };
        if (corroborated.outcome === 'failed') {
          return { ok: false, error: corroborated.error, logs: corroborated.logs };
        }
      }
      if (outcome === 'confirmed') return { ok: true };
    } catch (error) {
      if (isSignalCancellationError(context.signal, error)) throw context.signal.reason;
    }
    await sleepWithSignal(TX_CONFIRM_POLL_MS, context.signal);
  }
  const transaction = await loadTransactionBestEffort(context, runtime, signature);
  const corroborated = confirmedTransactionOutcome(transaction, signature);
  if (corroborated.outcome === 'confirmed') return { ok: true };
  return {
    ok: false,
    error: corroborated.outcome === 'failed' ? corroborated.error : 'timeout',
    logs: corroborated.logs,
  };
}

async function loadTransaction(
  context: ProviderContext,
  runtime: RevealRuntime,
  signature: string,
): Promise<Record<string, unknown> | null> {
  const value = await rpcCall(context, runtime, 'getTransaction', [signature, {
    commitment: 'confirmed',
    encoding: 'json',
    maxSupportedTransactionVersion: 0,
  }], { attempts: 1 });
  return isRecord(value) ? value : null;
}

async function loadTransactionBestEffort(
  context: ProviderContext,
  runtime: RevealRuntime,
  signature: string,
): Promise<Record<string, unknown> | null> {
  try {
    return await loadTransaction(context, runtime, signature);
  } catch (error) {
    if (isSignalCancellationError(context.signal, error)) throw context.signal.reason;
    return null;
  }
}

async function corroborateRevealSubmissionOutcome(
  context: ProviderContext,
  runtime: RevealRuntime,
  signature: string,
): Promise<'confirmed' | 'failed' | 'unknown'> {
  const transaction = await loadTransactionBestEffort(context, runtime, signature);
  return confirmedTransactionOutcome(transaction, signature).outcome;
}

type ParsedBlockhashValidity = {
  contextSlot: number;
  valid: boolean;
};

function parseBlockhashValidity(result: unknown): ParsedBlockhashValidity | undefined {
  if (
    !isRecord(result) ||
    !isRecord(result.context) ||
    !Number.isSafeInteger(result.context.slot) ||
    Number(result.context.slot) < 0 ||
    typeof result.value !== 'boolean'
  ) return undefined;
  return {
    contextSlot: Number(result.context.slot),
    valid: result.value,
  };
}

export async function reconcileRevealSubmission(
  context: ProviderContext,
  runtime: RevealRuntime,
  submission: RevealSubmission,
): Promise<RevealSubmissionOutcome> {
  try {
    const current = parseSignatureStatusResult(await rpcCall(context, runtime, 'getSignatureStatuses', [
      [submission.signature],
      { searchTransactionHistory: false },
    ], { attempts: 1 }));
    if (!current) return 'unknown';
    const currentOutcome = signatureStatusOutcome(current.status);
    if (currentOutcome === 'confirmed') return currentOutcome;
    if (currentOutcome === 'failed') {
      return corroborateRevealSubmissionOutcome(context, runtime, submission.signature);
    }
    if (currentOutcome !== 'absent') return 'unknown';
    const minContextSlot = Math.max(submission.blockhashContextSlot, current.contextSlot);
    const blockhashValidity = parseBlockhashValidity(await rpcCall(context, runtime, 'isBlockhashValid', [
      submission.recentBlockhash,
      { commitment: 'confirmed', minContextSlot },
    ], { attempts: 1 }));
    if (
      !blockhashValidity ||
      blockhashValidity.valid ||
      blockhashValidity.contextSlot < minContextSlot
    ) return 'unknown';
    const historical = parseSignatureStatusResult(await rpcCall(context, runtime, 'getSignatureStatuses', [
      [submission.signature],
      { searchTransactionHistory: true },
    ], { attempts: 1 }));
    if (!historical) return 'unknown';
    const historicalOutcome = signatureStatusOutcome(historical.status);
    if (historicalOutcome === 'confirmed') return historicalOutcome;
    if (historicalOutcome === 'failed') {
      return corroborateRevealSubmissionOutcome(context, runtime, submission.signature);
    }
    return historicalOutcome === 'absent' && historical.contextSlot >= blockhashValidity.contextSlot
      ? 'expired'
      : 'unknown';
  } catch (error) {
    if (isSignalCancellationError(context.signal, error)) throw context.signal.reason;
    return 'unknown';
  }
}

export async function sendAndConfirmTransaction(
  context: ProviderContext,
  runtime: RevealRuntime,
  transaction: VersionedTransaction,
  overrides: { waitForSignature?: typeof waitForSignature } = {},
): Promise<string> {
  if (context.signal.aborted) throw context.signal.reason;
  const waitForTransaction = overrides.waitForSignature ?? waitForSignature;
  const signature = bs58.encode(transaction.signatures[0]);
  let sendError: unknown;
  try {
    const result = await rpcCall(context, runtime, 'sendTransaction', [
      Buffer.from(transaction.serialize()).toString('base64'),
      { encoding: 'base64', maxRetries: 2, preflightCommitment: 'confirmed' },
    ], { attempts: 1, timeoutMs: TX_SEND_TIMEOUT_MS });
    if (result !== signature) throw new RevealDudesError('unavailable', 'Reveal provider returned an unexpected transaction signature.');
  } catch (error) {
    sendError = error;
  }
  if (sendError) {
    const preflight = preflightFailure(sendError);
    if (preflight) {
      throw new RevealDudesError('failed-precondition', 'Reveal transaction preflight failed.', {
        signature,
        lastError: transactionErrorMessage(sendError),
        lastLogs: preflight.logs,
      });
    }
    let maybe: Awaited<ReturnType<typeof waitForSignature>>;
    try {
      maybe = await waitForTransaction(context, runtime, signature, TX_SEND_TIMEOUT_MS);
    } catch (error) {
      const cancelled = isSignalCancellationError(context.signal, error);
      const unknownSubmission = new RevealDudesError(
        cancelled ? 'deadline-exceeded' : 'unavailable',
        'Reveal transaction submission status is unknown. Try again.',
        {
          signature,
          lastError: transactionErrorMessage(sendError),
          maybeSubmitted: true,
        },
      );
      if (cancelled) Object.defineProperty(unknownSubmission, 'cause', { value: context.signal.reason });
      throw unknownSubmission;
    }
    if (maybe.ok) return signature;
    const maybeMessage = transactionErrorMessage(maybe.error);
    if (!/timeout/i.test(maybeMessage)) {
      throw new RevealDudesError('failed-precondition', 'Reveal transaction was not confirmed. Try again.', {
        signature,
        lastError: maybeMessage,
        lastLogs: maybe.logs.slice(0, 80),
      });
    }
    throw new RevealDudesError('unavailable', 'Reveal transaction submission status is unknown. Try again.', {
      signature,
      lastError: transactionErrorMessage(sendError),
      maybeSubmitted: true,
    });
  }
  let confirmed: Awaited<ReturnType<typeof waitForSignature>>;
  try {
    confirmed = await waitForTransaction(context, runtime, signature, TX_CONFIRM_TIMEOUT_MS);
  } catch (error) {
    const cancelled = isSignalCancellationError(context.signal, error);
    const unknownSubmission = new RevealDudesError('deadline-exceeded', 'Reveal transaction was not confirmed. Try again.', {
      signature,
      lastError: 'timeout',
      maybeSubmitted: true,
    });
    if (cancelled) Object.defineProperty(unknownSubmission, 'cause', { value: context.signal.reason });
    throw unknownSubmission;
  }
  if (confirmed.ok) return signature;
  const message = transactionErrorMessage(confirmed.error);
  const timedOut = /timeout/i.test(message);
  throw new RevealDudesError(timedOut ? 'deadline-exceeded' : 'failed-precondition', 'Reveal transaction was not confirmed. Try again.', {
    signature,
    lastError: message,
    lastLogs: confirmed.logs.slice(0, 80),
    ...(timedOut ? { maybeSubmitted: true } : {}),
  });
}
