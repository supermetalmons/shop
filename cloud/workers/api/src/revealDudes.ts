import bs58 from 'bs58';
import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import { z } from 'zod';
import type { RevealDudesSubmissionUnknownDetails } from '../../../../shared/contracts.js';
import { encodeFinalizeOpenBoxArgs } from '../../../../shared/finalizeOpenBoxArgs.js';
import { SPL_NOOP_PROGRAM_ADDRESS } from '../../../../shared/solanaProgramAddresses.js';
import { type RequestAuthContext, RequestIdentityError, resolveRequestWallet, verifyRequestIdentity, type RequestIdentity } from './requestIdentity.js';
import type { ProfileProviderFetch } from './boundedResponse.js';
import { withAuthenticatedRequest } from './authenticatedRequest.js';
import {
  isRequestCancellationError,
  isSignalCancellationError,
  raceReadWithSignal,
  readBoundedRequestJson,
  runCriticalRequestOperation,
  sleepWithSignal,
  type RequestDeadline,
} from './boundedRequest.js';
import { isRecord, ProfileReadError } from './dataAccess.js';
import {
  registerDeferredWork,
  rethrowDeferredWorkRegistrationError,
  type DeferredWork,
} from './deferredWork.js';
import { httpStatusForApiErrorCode, jsonResponse } from './httpResponse.js';
import { RevealSubmissionStoragePausedError } from './revealSubmissionD1.js';
import { resolveRevealSubmission } from './revealSubmissionLifecycle.js';
import {
  MPL_CORE_PROGRAM_ID,
  RevealDudesError,
  runtimeForDrop,
  type ProviderContext,
  type RevealContext,
  type RevealErrorCode,
  type RevealRuntime,
  type RevealSubmission,
} from './revealDudesDomain.js';
import {
  PROVIDER_ATTEMPT_TIMEOUT_MS,
  loadLatestBlockhash,
  loadPendingOpen,
  rpcCall,
  validateOnchainConfig,
} from './revealDudesOnchain.js';
import {
  reconcileRevealSubmission,
  sendAndConfirmTransaction,
  waitForSignature,
} from './revealDudesTransactions.js';
import {
  assignDudes,
  confirmRevealSubmission,
  countOnlineRevealPackStatus,
  failRevealSubmission,
  loadBoundWallet,
  loadRevealSubmission,
  requireRevealSubmissionStorageControl,
  reserveRevealSubmission,
} from './revealDudesStore.js';
import {
  REVEAL_BACKGROUND_JOB_TIMEOUT_MS,
  enqueueRevealBackgroundJob,
} from './revealDudesBackground.js';

export { RevealDudesError } from './revealDudesDomain.js';
export {
  isRevealBackgroundJob,
  processRevealBackgroundJobMessage,
  revealBackgroundJobRetryDelaySeconds,
  type RevealBackgroundJob,
} from './revealDudesBackground.js';

export const REVEAL_DUDES_PATH = '/boxes/reveal';

const REQUEST_MAX_BYTES = 4096;

const HANDLER_TIMEOUT_MS = 55_000;

const BACKGROUND_PACK_STATUS_TIMEOUT_MS = 10_000;

const REVEAL_BACKGROUND_JOB_INITIAL_DELAY_SECONDS = 5;

const SPL_NOOP_PROGRAM_ID = new PublicKey(SPL_NOOP_PROGRAM_ADDRESS);

type RevealMetrics = {
  upstreamCalls: number;
  providerDurationMs: number;
};

export type RevealDudesResult = {
  response: Response;
  metrics: RevealMetrics;
  authOutcome: 'accepted' | 'rejected' | 'provider-failure';
  dropId?: string;
  boxAssetId?: string;
  assignmentOutcome?: 'existing' | 'created';
  transactionOutcome?: 'confirmed' | 'failed' | 'unknown';
};

type RevealDudesDependencies = {
  assignDudes: typeof assignDudes;
  confirmRevealSubmission: typeof confirmRevealSubmission;
  countOnlineRevealPackStatus: typeof countOnlineRevealPackStatus;
  failRevealSubmission: typeof failRevealSubmission;
  loadLatestBlockhash: typeof loadLatestBlockhash;
  loadPendingOpen: typeof loadPendingOpen;
  loadRevealSubmission: typeof loadRevealSubmission;
  loadStorageControl: typeof requireRevealSubmissionStorageControl;
  loadBoundWallet: typeof loadBoundWallet;
  nowMs: () => number;
  providerFetch: ProfileProviderFetch;
  randomInt: (maxExclusive: number) => number;
  reconcileRevealSubmission: typeof reconcileRevealSubmission;
  reserveRevealSubmission: typeof reserveRevealSubmission;
  sendAndConfirmTransaction: typeof sendAndConfirmTransaction;
  sleep: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  timeoutMs: number;
  validateOnchainConfig: typeof validateOnchainConfig;
  verifyIdentity: typeof verifyRequestIdentity;
};

function secureRandomInt(maxExclusive: number): number {
  const maximum = Math.floor(Number(maxExclusive));
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 0x1_0000_0000) {
    throw new RangeError('maxExclusive must be a positive 32-bit integer');
  }
  const range = 0x1_0000_0000;
  const limit = Math.floor(range / maximum) * maximum;
  const values = new Uint32Array(1);
  do {
    crypto.getRandomValues(values);
  } while (values[0] >= limit);
  return values[0] % maximum;
}

const defaultDependencies: RevealDudesDependencies = {
  assignDudes,
  confirmRevealSubmission,
  countOnlineRevealPackStatus,
  failRevealSubmission,
  loadLatestBlockhash,
  loadPendingOpen,
  loadRevealSubmission,
  loadStorageControl: requireRevealSubmissionStorageControl,
  loadBoundWallet,
  nowMs: () => Date.now(),
  providerFetch: (input, init) => fetch(input, init),
  randomInt: secureRandomInt,
  reconcileRevealSubmission,
  reserveRevealSubmission,
  sendAndConfirmTransaction,
  sleep: sleepWithSignal,
  timeoutMs: HANDLER_TIMEOUT_MS,
  validateOnchainConfig,
  verifyIdentity: verifyRequestIdentity,
};

const requestSchema = z.object({
  owner: z.string().min(1).max(64),
  boxAssetId: z.string().min(1).max(64),
  dropId: z.string().min(1).max(64),
}).strict();

type RevealRequest = z.infer<typeof requestSchema>;

function errorResponse(error: RevealDudesError): Response {
  return jsonResponse({
    error: {
      code: error.code,
      message: error.message,
      ...(error.details === undefined ? {} : { details: error.details }),
    },
  }, httpStatusForApiErrorCode(error.code, 503));
}

function summarizeError(error: unknown): Record<string, unknown> {
  if (error instanceof RevealDudesError) {
    return {
      kind: error.name,
      code: error.code,
      message: error.message,
      ...(error.details === undefined ? {} : { details: error.details }),
    };
  }
  if (error instanceof Error) return { kind: error.name, message: error.message };
  return { kind: typeof error, message: String(error) };
}

async function readRequestBody(request: Request, signal: AbortSignal): Promise<RevealRequest> {
  const value = await readBoundedRequestJson(request, {
    maxBytes: REQUEST_MAX_BYTES,
    signal,
    createError: (failure) => new RevealDudesError(
      'invalid-argument',
      failure === 'unsupported-media-type'
        ? 'Content-Type must be application/json.'
        : failure === 'too-large'
          ? 'Reveal request is too large.'
          : 'Invalid reveal request.',
    ),
  });
  const parsed = requestSchema.safeParse(value);
  if (!parsed.success) throw new RevealDudesError('invalid-argument', 'Invalid reveal request.');
  return parsed.data;
}

function canonicalPublicKey(value: string, label: string): PublicKey {
  try {
    return new PublicKey(value);
  } catch {
    throw new RevealDudesError('invalid-argument', `Invalid ${label}.`);
  }
}

function cosigner(env: Env): Keypair {
  const secret = typeof env.COSIGNER_SECRET === 'string' ? env.COSIGNER_SECRET.trim() : '';
  if (!secret) throw new RevealDudesError('unavailable', 'Reveal signing is temporarily unavailable.');
  try {
    const bytes = bs58.decode(secret);
    if (bytes.length !== 64) throw new Error('invalid');
    return Keypair.fromSecretKey(bytes);
  } catch {
    throw new RevealDudesError('unavailable', 'Reveal signing is temporarily unavailable.');
  }
}

async function failRevealSubmissionSafely(
  dependency: typeof failRevealSubmission,
  context: RevealContext,
  runtime: RevealRuntime,
  boxAssetId: string,
  submission: RevealSubmission,
): Promise<void> {
  try {
    await dependency(context, runtime, boxAssetId, submission);
  } catch (error) {
    console.warn({
      event: 'reveal_submission_fail_status_failed',
      dropId: runtime.dropId,
      boxAssetId,
      signature: submission.signature,
      error: summarizeError(error),
    });
  }
}

function scheduleRevealBackground(
  defer: DeferredWork,
  promise: Promise<unknown>,
): void {
  const guarded = promise.catch((error) => {
    console.error({ event: 'reveal_background_error', error: summarizeError(error) });
  });
  registerDeferredWork(defer, guarded);
}

function scheduleConfirmedPackStatusRepair(
  dependencies: RevealDudesDependencies,
  defer: DeferredWork,
  context: RevealContext,
  runtime: RevealRuntime,
  boxAssetId: string,
  submission: RevealSubmission,
): void {
  scheduleRevealBackground(
    defer,
    dependencies.countOnlineRevealPackStatus(
      {
        ...context,
        nowMs: dependencies.nowMs(),
        providerFetch: dependencies.providerFetch,
        signal: AbortSignal.timeout(BACKGROUND_PACK_STATUS_TIMEOUT_MS),
      },
      runtime,
      boxAssetId,
      submission.signature,
    ),
  );
}

function unknownSubmissionError(
  submission: RevealSubmission,
  code: RevealErrorCode = 'unavailable',
  message = 'Reveal transaction submission status is unknown. Try again.',
): RevealDudesError {
  const details: RevealDudesSubmissionUnknownDetails = {
    kind: 'reveal-submission-unknown',
    submission: {
      signature: submission.signature,
      recentBlockhash: submission.recentBlockhash,
      dudeIds: [...submission.dudeIds],
    },
  };
  return new RevealDudesError(code, message, details);
}

async function finalizeConfirmedSubmissionForResponse(
  dependencies: RevealDudesDependencies,
  deadline: RequestDeadline,
  defer: DeferredWork,
  context: RevealContext,
  runtime: RevealRuntime,
  boxAssetId: string,
  submission: RevealSubmission,
): Promise<void> {
  try {
    await runCriticalRequestOperation(
      () => dependencies.confirmRevealSubmission(context, runtime, boxAssetId, submission),
      { deadline, defer },
    );
  } catch (error) {
    rethrowDeferredWorkRegistrationError(error);
    if (deadline.timedOut() && isSignalCancellationError(deadline.signal, error)) {
      throw unknownSubmissionError(
        submission,
        'deadline-exceeded',
        'Reveal transaction is confirmed, but finalization is incomplete. Try again.',
      );
    }
    if (isSignalCancellationError(context.signal, error)) throw context.signal.reason;
    const code =
      (error instanceof RevealDudesError && error.code === 'deadline-exceeded') ||
      (error instanceof ProfileReadError && error.code === 'deadline-exceeded')
      ? 'deadline-exceeded'
      : 'unavailable';
    throw unknownSubmissionError(
      submission,
      code,
      'Reveal transaction is confirmed, but finalization is incomplete. Try again.',
    );
  }
}

function scheduleFailedSubmission(
  dependencies: RevealDudesDependencies,
  defer: DeferredWork,
  context: RevealContext,
  runtime: RevealRuntime,
  boxAssetId: string,
  submission: RevealSubmission,
): void {
  scheduleRevealBackground(
    defer,
    failInterruptedRevealSubmission(dependencies, context, runtime, boxAssetId, submission),
  );
}

function failInterruptedRevealSubmission(
  dependencies: RevealDudesDependencies,
  context: RevealContext,
  runtime: RevealRuntime,
  boxAssetId: string,
  submission: RevealSubmission,
): Promise<void> {
  return failRevealSubmissionSafely(
    dependencies.failRevealSubmission,
    {
      ...context,
      providerFetch: dependencies.providerFetch,
      signal: AbortSignal.timeout(PROVIDER_ATTEMPT_TIMEOUT_MS),
    },
    runtime,
    boxAssetId,
    submission,
  );
}

export async function handleRevealDudes(
  request: Request,
  env: Env,
  defer: DeferredWork,
  authContext: RequestAuthContext = {},
  overrides: Partial<RevealDudesDependencies> = {},
): Promise<RevealDudesResult> {
  const dependencies = { ...defaultDependencies, ...overrides };
  let authOutcome: RevealDudesResult['authOutcome'] = 'rejected';
  let dropId: string | undefined;
  let boxAssetId: string | undefined;
  let assignmentOutcome: RevealDudesResult['assignmentOutcome'];
  let transactionOutcome: RevealDudesResult['transactionOutcome'];
  if (request.method !== 'POST') {
    await request.body?.cancel().catch(() => undefined);
    return {
      response: jsonResponse(
        { error: { code: 'invalid-argument', message: 'Method not allowed.' } },
        405,
        { headers: { Allow: 'POST, OPTIONS' } },
      ),
      metrics: { upstreamCalls: 0, providerDurationMs: 0 },
      authOutcome,
    };
  }
  return withAuthenticatedRequest<RevealDudesResult>(request, {
    authContext,
    opsDb: env.OPS_DB,
    timeoutMessage: 'Reveal request timed out',
    dependencies,
  }, async ({ deadline, metrics, trackedFetch: meteredFetch, authenticate }) => {
    try {
      const body = await readRequestBody(request, deadline.signal);
      const owner = canonicalPublicKey(body.owner, 'wallet address');
      const resolvedBoxAssetId = canonicalPublicKey(body.boxAssetId, 'boxAssetId').toBase58();
      boxAssetId = resolvedBoxAssetId;
      const runtime = runtimeForDrop(body.dropId);
      dropId = runtime.dropId;
      let identity: RequestIdentity;
      try {
        identity = await authenticate();
      } catch (error) {
        if (error instanceof RequestIdentityError) {
          authOutcome = error.kind === 'invalid-token' ? 'rejected' : 'provider-failure';
          throw new RevealDudesError(
            error.kind === 'invalid-token'
              ? 'unauthenticated'
              : error.kind === 'provider-timeout' ? 'deadline-exceeded' : 'unavailable',
            error.kind === 'invalid-token' ? 'Authentication is required.' : 'Authentication is temporarily unavailable.',
          );
        }
        throw error;
      }
      authOutcome = 'provider-failure';
      const storageControl = await raceReadWithSignal(
        dependencies.loadStorageControl(env.OPS_DB, deadline.signal),
        deadline.signal,
      );
      const revealContext: RevealContext = {
        commerceDb: env.COMMERCE_DB,
        nowMs: dependencies.nowMs(),
        providerFetch: meteredFetch,
        signal: deadline.signal,
        dataDb: env.DATA_DB,
        opsDb: env.OPS_DB,
      };
      const confirmedResult = (
        submission: RevealSubmission,
        signature: string,
        confirmedAssignmentOutcome?: RevealDudesResult['assignmentOutcome'],
      ): RevealDudesResult => {
        transactionOutcome = 'confirmed';
        scheduleConfirmedPackStatusRepair(
          dependencies,
          defer,
          revealContext,
          runtime,
          resolvedBoxAssetId,
          submission,
        );
        return {
          response: jsonResponse({ signature, dudeIds: submission.dudeIds }, 200),
          metrics,
          authOutcome,
          dropId,
          boxAssetId,
          ...(confirmedAssignmentOutcome ? { assignmentOutcome: confirmedAssignmentOutcome } : {}),
          transactionOutcome,
        };
      };
      const sessionWallet = await raceReadWithSignal(
        resolveRequestWallet(
          identity,
          (uid) => dependencies.loadBoundWallet(revealContext, env.OPS_DB, uid),
        ),
        deadline.signal,
      );
      if (sessionWallet !== owner.toBase58()) {
        authOutcome = 'rejected';
        throw new RevealDudesError('permission-denied', 'Owners only.');
      }
      authOutcome = 'accepted';
      if (storageControl.paused) {
        throw new RevealDudesError('unavailable', 'Reveal migration is in progress. Try again.');
      }
      const storedSubmission = await raceReadWithSignal(
        dependencies.loadRevealSubmission(revealContext, runtime, resolvedBoxAssetId),
        deadline.signal,
      );
      if (storedSubmission && storedSubmission.owner !== owner.toBase58()) {
        authOutcome = 'rejected';
        throw new RevealDudesError('permission-denied', 'Owners only.');
      }
      if (storedSubmission?.status === 'confirmed') {
        return confirmedResult(storedSubmission, storedSubmission.signature);
      }
      const apiKey = typeof env.HELIUS_API_KEY === 'string' ? env.HELIUS_API_KEY.trim() : '';
      if (!apiKey) throw new RevealDudesError('unavailable', 'Reveal provider is temporarily unavailable.');
      const providerContext: ProviderContext = { apiKey, fetch: meteredFetch, signal: deadline.signal };
      const resolveExistingSubmission = (submission: RevealSubmission) => resolveRevealSubmission({
        submission,
        reconcile: () => dependencies.reconcileRevealSubmission(providerContext, runtime, submission),
        confirm: async () => {
          transactionOutcome = 'confirmed';
          await finalizeConfirmedSubmissionForResponse(
            dependencies,
            deadline,
            defer,
            revealContext,
            runtime,
            resolvedBoxAssetId,
            submission,
          );
        },
      });
      let replaceSubmission: RevealSubmission | undefined;
      if (storedSubmission) {
        const outcome = await resolveExistingSubmission(storedSubmission);
        if (outcome === 'confirmed') {
          return confirmedResult(storedSubmission, storedSubmission.signature);
        }
        if (outcome === 'unknown') {
          transactionOutcome = 'unknown';
          throw unknownSubmissionError(storedSubmission);
        }
        replaceSubmission = storedSubmission;
      }
      const onchain = await dependencies.validateOnchainConfig(providerContext, runtime);
      const signer = cosigner(env);
      if (!signer.publicKey.equals(onchain.admin)) {
        throw new RevealDudesError('failed-precondition', 'COSIGNER_SECRET does not match the on-chain admin.', {
          expectedAdmin: onchain.admin.toBase58(),
          cosigner: signer.publicKey.toBase58(),
        });
      }
      const boxAsset = new PublicKey(boxAssetId);
      const pending = await dependencies.loadPendingOpen(providerContext, runtime, owner, boxAsset);
      const assignment = await runCriticalRequestOperation(
        () => dependencies.assignDudes(revealContext, runtime, resolvedBoxAssetId, dependencies),
        { deadline, defer },
      );
      assignmentOutcome = assignment.outcome;
      const instruction = new TransactionInstruction({
        programId: runtime.boxMinterProgramId,
        keys: [
          { pubkey: runtime.boxMinterConfigPda, isSigner: false, isWritable: false },
          { pubkey: signer.publicKey, isSigner: true, isWritable: true },
          { pubkey: boxAsset, isSigner: false, isWritable: true },
          { pubkey: onchain.coreCollection, isSigner: false, isWritable: true },
          { pubkey: MPL_CORE_PROGRAM_ID, isSigner: false, isWritable: false },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
          { pubkey: SPL_NOOP_PROGRAM_ID, isSigner: false, isWritable: false },
          { pubkey: pending.pendingPda, isSigner: false, isWritable: true },
          { pubkey: owner, isSigner: false, isWritable: false },
          ...pending.dudeAssets.map((pubkey) => ({ pubkey, isSigner: false, isWritable: true })),
        ],
        data: Buffer.from(encodeFinalizeOpenBoxArgs(assignment.dudeIds, {
          itemsPerBox: runtime.itemsPerBox,
          maxDudeId: runtime.maxDudeId,
          pendingLayout: pending.layout,
        })),
      });
      const latestBlockhash = await dependencies.loadLatestBlockhash(providerContext, runtime);
      const transaction = new VersionedTransaction(new TransactionMessage({
        payerKey: signer.publicKey,
        recentBlockhash: latestBlockhash.blockhash,
        instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }), instruction],
      }).compileToV0Message());
      transaction.sign([signer]);
      const candidate: RevealSubmission = {
        owner: owner.toBase58(),
        signature: bs58.encode(transaction.signatures[0]),
        recentBlockhash: latestBlockhash.blockhash,
        blockhashContextSlot: latestBlockhash.blockhashContextSlot,
        dudeIds: [...assignment.dudeIds],
        reservationId: crypto.randomUUID(),
        status: 'pending',
      };
      let reservation: Awaited<ReturnType<typeof reserveRevealSubmission>>;
      try {
        reservation = await runCriticalRequestOperation(
          async () => {
            try {
              return await dependencies.reserveRevealSubmission(
                revealContext,
                runtime,
                resolvedBoxAssetId,
                candidate,
                replaceSubmission,
                dependencies,
              );
            } finally {
              if (deadline.clientAborted() || deadline.timeoutSignal.aborted) {
                await failInterruptedRevealSubmission(
                  dependencies,
                  revealContext,
                  runtime,
                  resolvedBoxAssetId,
                  candidate,
                );
              }
            }
          },
          { deadline, defer },
        );
      } catch (error) {
        if (
          deadline.signal.aborted &&
          !deadline.clientAborted() &&
          !deadline.timeoutSignal.aborted
        ) {
          scheduleFailedSubmission(
            dependencies,
            defer,
            revealContext,
            runtime,
            boxAssetId,
            candidate,
          );
        }
        throw error;
      }
      if (reservation.submission.status === 'confirmed') {
        return confirmedResult(reservation.submission, reservation.submission.signature, assignmentOutcome);
      }
      if (!reservation.owned) {
        if (reservation.submission.owner !== owner.toBase58()) {
          authOutcome = 'rejected';
          throw new RevealDudesError('permission-denied', 'Owners only.');
        }
        const outcome = await resolveExistingSubmission(reservation.submission);
        if (outcome === 'confirmed') {
          return confirmedResult(reservation.submission, reservation.submission.signature, assignmentOutcome);
        }
        if (outcome === 'unknown') {
          transactionOutcome = 'unknown';
          throw unknownSubmissionError(reservation.submission);
        }
        transactionOutcome = 'failed';
        throw new RevealDudesError('aborted', 'Reveal submission changed. Try again.');
      }
      const submission = reservation.submission;
      try {
        await runCriticalRequestOperation(
          async () => {
            try {
              await enqueueRevealBackgroundJob(
                env.REVEAL_BACKGROUND_QUEUE,
                runtime,
                resolvedBoxAssetId,
                submission,
                REVEAL_BACKGROUND_JOB_INITIAL_DELAY_SECONDS,
              );
            } finally {
              if (deadline.clientAborted() || deadline.timeoutSignal.aborted) {
                await failInterruptedRevealSubmission(
                  dependencies,
                  revealContext,
                  runtime,
                  resolvedBoxAssetId,
                  submission,
                );
              }
            }
          },
          { deadline, defer },
        );
      } catch (error) {
        rethrowDeferredWorkRegistrationError(error);
        transactionOutcome = 'failed';
        if (!deadline.clientAborted() && !deadline.timeoutSignal.aborted) {
          scheduleFailedSubmission(
            dependencies,
            defer,
            revealContext,
            runtime,
            resolvedBoxAssetId,
            submission,
          );
        }
        if (deadline.signal.aborted && error === deadline.signal.reason) throw error;
        throw new RevealDudesError('unavailable', 'Reveal processing is temporarily unavailable. Try again.');
      }
      deadline.signal.throwIfAborted();
      let signature: string;
      try {
        signature = await dependencies.sendAndConfirmTransaction(providerContext, runtime, transaction);
        transactionOutcome = 'confirmed';
      } catch (error) {
        const cancellationDerived = isSignalCancellationError(deadline.signal, error);
        const submissionUnknown = cancellationDerived || (
          error instanceof RevealDudesError &&
          isRecord(error.details) && error.details.maybeSubmitted === true
        );
        transactionOutcome = submissionUnknown ? 'unknown' : 'failed';
        if (submissionUnknown) {
          console.warn({
            event: 'reveal_transaction_unknown',
            dropId: runtime.dropId,
            boxAssetId,
            signature: submission.signature,
            error: summarizeError(error),
          });
          if (cancellationDerived && deadline.clientAborted()) throw error;
          if (error instanceof RevealDudesError) {
            throw unknownSubmissionError(submission, error.code, error.message);
          }
          throw error;
        }
        if (deadline.signal.aborted) {
          scheduleFailedSubmission(
            dependencies,
            defer,
            revealContext,
            runtime,
            boxAssetId,
            submission,
          );
        } else {
          await failRevealSubmissionSafely(
            dependencies.failRevealSubmission,
            revealContext,
            runtime,
            boxAssetId,
            submission,
          );
        }
        throw error;
      }
      await finalizeConfirmedSubmissionForResponse(
        dependencies,
        deadline,
        defer,
        revealContext,
        runtime,
        resolvedBoxAssetId,
        submission,
      );
      return confirmedResult(submission, signature, assignmentOutcome);
    } catch (error) {
      rethrowDeferredWorkRegistrationError(error);
      if (isRequestCancellationError(request, error)) throw error;
      let normalized: RevealDudesError;
      if (error instanceof RevealDudesError) normalized = error;
      else if (error instanceof RevealSubmissionStoragePausedError) {
        normalized = new RevealDudesError('unavailable', 'Reveal migration is in progress. Try again.');
      }
      else if (error instanceof ProfileReadError) {
        normalized = new RevealDudesError(error.code, error.message, error.details);
      } else if (deadline.timedOut()) {
        normalized = new RevealDudesError('deadline-exceeded', 'Reveal request timed out.');
      } else {
        normalized = new RevealDudesError('internal', 'Reveal failed.');
      }
      if (['invalid-argument', 'unauthenticated', 'permission-denied'].includes(normalized.code)) {
        authOutcome = 'rejected';
      }
      return {
        response: errorResponse(normalized),
        metrics,
        authOutcome,
        ...(dropId ? { dropId } : {}),
        ...(boxAssetId ? { boxAssetId } : {}),
        ...(assignmentOutcome ? { assignmentOutcome } : {}),
        ...(transactionOutcome ? { transactionOutcome } : {}),
      };
    }
  });
}

export const revealDudesTestHooks = {
  assignDudes,
  countOnlineRevealPackStatus,
  confirmRevealSubmission,
  enqueueRevealBackgroundJob,
  loadLatestBlockhash,
  loadPendingOpen,
  loadRevealSubmission,
  loadBoundWallet,
  reconcileRevealSubmission,
  reserveRevealSubmission,
  revealBackgroundJobTimeoutMs: REVEAL_BACKGROUND_JOB_TIMEOUT_MS,
  failRevealSubmission,
  rpcCall,
  runtimeForDrop,
  sendAndConfirmTransaction,
  waitForSignature,
};
