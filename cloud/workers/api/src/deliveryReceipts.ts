import { runtimeForDrop, type ProviderContext } from './deliveryReceiptOnchain.js';
import { DeliveryReceiptError, summarizeDeliveryReceiptError as summarizeError } from './deliveryReceiptErrors.js';
import type { IssueReceiptsResult, RecoverDeliveryOrdersResult } from '../../../../shared/contracts.js';
import { normalizeDropId } from '../../../../shared/deploymentCore.js';
import {
  type RequestAuthContext,
  RequestIdentityError,
  verifyRequestIdentity,
  type RequestIdentity,
} from './requestIdentity.js';
import type { ProfileProviderFetch } from './boundedResponse.js';
import { isRequestCancellationError, runCriticalRequestOperation } from './boundedRequest.js';
import { requestIdentityErrorDetails, withAuthenticatedRequest } from './authenticatedRequest.js';
import { ProfileReadError } from './dataAccess.js';
import { httpStatusForApiErrorCode, jsonResponse } from './httpResponse.js';
import { rethrowDeferredWorkRegistrationError, type DeferredWork } from './deferredWork.js';
import { D1CommerceRepository } from './commerceRepository.js';
import { deliveryRecoveryFailure } from './deliveryRecoveryAttempt.js';
import {
  type IssueRequest,
  type DeliveryReceiptsEnv,
  type CommerceContext,
  type RecoverRequest,
  readRequestBody,
  loadBoundWallet,
} from './deliveryReceiptRequest.js';
import { type ReceiptIssueResult, issueReceiptsRequest } from './deliveryReceiptIssuance.js';
import { recoverReceiptsRequest, validateRecoveryRequestMode } from './deliveryReceiptRecovery.js';
import {
  assertDeliveryPayers,
  assertDeliverArgsMatchOrder,
  decodeDeliveryRecord,
  normalizeAssignedDudeIds,
} from './deliveryReceiptVerification.js';
import {
  probePendingReceiptSubmission,
  reconcilePendingReceiptSubmission,
  pendingReceiptItems,
  ReceiptBatchRetryExhaustedError,
  sendReceiptBatch,
  shouldShrinkReceiptBatch,
} from './deliveryReceiptSubmission.js';

export const DELIVERY_RECEIPTS_ISSUE_PATH = '/delivery/receipts/issue';

export const DELIVERY_RECEIPTS_RECOVER_PATH = '/delivery/receipts/recover';

const HANDLER_TIMEOUT_MS = 55_000;

type DeliveryRequestMetrics = {
  upstreamCalls: number;
  providerDurationMs: number;
};

export type DeliveryReceiptRequestResult = {
  response: Response;
  metrics: DeliveryRequestMetrics;
  authOutcome: 'accepted' | 'rejected' | 'provider-failure';
  dropId?: string;
  deliveryId?: number;
  verification?: 'signature' | 'delivery_pda';
  attempted?: number;
  recovered?: number;
  recoveryMode?: 'targeted' | 'page' | 'legacy-rejected';
};

type DeliveryReceiptDependencies = {
  issue: (
    body: IssueRequest,
    identity: RequestIdentity,
    env: DeliveryReceiptsEnv,
    commerce: CommerceContext,
    provider: ProviderContext,
    waitUntil: DeferredWork,
  ) => Promise<ReceiptIssueResult>;
  nowMs: () => number;
  providerFetch: ProfileProviderFetch;
  recover: (
    body: RecoverRequest,
    identity: RequestIdentity,
    env: DeliveryReceiptsEnv,
    commerce: CommerceContext,
    provider: ProviderContext,
    waitUntil: DeferredWork,
  ) => Promise<RecoverDeliveryOrdersResult>;
  timeoutMs: number;
  verifyIdentity: typeof verifyRequestIdentity;
};

function errorResponse(error: DeliveryReceiptError): Response {
  return jsonResponse({
    error: {
      code: error.code,
      message: error.message,
    },
  }, httpStatusForApiErrorCode(error.code, 503), {
    headers: { 'Timing-Allow-Origin': '*' },
  });
}

const defaultDependencies: DeliveryReceiptDependencies = {
  issue: issueReceiptsRequest,
  nowMs: () => Date.now(),
  providerFetch: (input, init) => fetch(input, init),
  recover: recoverReceiptsRequest,
  timeoutMs: HANDLER_TIMEOUT_MS,
  verifyIdentity: verifyRequestIdentity,
};

export async function handleDeliveryReceiptRequest(
  request: Request,
  env: DeliveryReceiptsEnv,
  path: typeof DELIVERY_RECEIPTS_ISSUE_PATH | typeof DELIVERY_RECEIPTS_RECOVER_PATH,
  defer: DeferredWork,
  authContext: RequestAuthContext = {},
  overrides: Partial<DeliveryReceiptDependencies> = {},
): Promise<DeliveryReceiptRequestResult> {
  const dependencies = { ...defaultDependencies, ...overrides };
  if (request.method !== 'POST') {
    await request.body?.cancel().catch(() => undefined);
    const response = errorResponse(new DeliveryReceiptError('invalid-argument', 'Method not allowed.'));
    response.headers.set('Allow', 'POST, OPTIONS');
    return {
      response: new Response(response.body, { headers: response.headers, status: 405 }),
      metrics: { upstreamCalls: 0, providerDurationMs: 0 },
      authOutcome: 'rejected',
    };
  }
  return withAuthenticatedRequest(request, {
    authContext,
    opsDb: env.OPS_DB,
    timeoutMessage: 'Delivery receipt request timed out',
    dependencies,
  }, async ({ deadline, metrics, trackedFetch, authenticate }) => {
    let identity: RequestIdentity | undefined;
    let dropId: string | undefined;
    let deliveryId: number | undefined;
    let recoveryMode: DeliveryReceiptRequestResult['recoveryMode'];
    try {
      const verifiedIdentity = await authenticate();
      identity = verifiedIdentity;
      const rawBody = await readRequestBody(
        request,
        deadline.signal,
        path === DELIVERY_RECEIPTS_ISSUE_PATH ? 'issue' : 'recover',
      );
      if (path === DELIVERY_RECEIPTS_RECOVER_PATH) {
        const recoveryBody = rawBody as RecoverRequest;
        recoveryMode = recoveryBody.deliveryId !== undefined ? 'targeted' : recoveryBody.cursor !== undefined ? 'page' : 'legacy-rejected';
        validateRecoveryRequestMode(recoveryBody);
      }
      const apiKey = String(env.HELIUS_API_KEY || '').trim();
      const cosignerSecret = String(env.COSIGNER_SECRET || '').trim();
      if (!apiKey || !cosignerSecret) {
        throw new DeliveryReceiptError('unavailable', 'Receipt issuance is temporarily unavailable.');
      }
      const common: CommerceContext = {
        repository: new D1CommerceRepository(env.COMMERCE_DB),
        nowMs: dependencies.nowMs(),
        providerFetch: trackedFetch,
        signal: deadline.signal,
        dataDb: env.DATA_DB,
      };
      const provider: ProviderContext = { apiKey, fetch: trackedFetch, signal: deadline.signal };
      if (path === DELIVERY_RECEIPTS_ISSUE_PATH) {
        const body = rawBody as IssueRequest;
        dropId = normalizeDropId(body.dropId);
        deliveryId = body.deliveryId;
        const result: IssueReceiptsResult = await runCriticalRequestOperation(
          () => dependencies.issue(
            body,
            verifiedIdentity,
            env,
            common,
            provider,
            defer,
          ),
          { deadline, defer },
        );
        return {
          response: jsonResponse(result, 200, {
            headers: { 'Timing-Allow-Origin': '*' },
          }),
          metrics,
          authOutcome: 'accepted',
          dropId,
          deliveryId,
          verification: 'signature',
        };
      }
      const body = rawBody as RecoverRequest;
      dropId = body.dropId ? normalizeDropId(body.dropId) : undefined;
      deliveryId = body.deliveryId;
      const result = await runCriticalRequestOperation(
        () => dependencies.recover(
          body,
          verifiedIdentity,
          env,
          common,
          provider,
          defer,
        ),
        { deadline, defer },
      );
      return {
        response: jsonResponse(result, 200, {
          headers: { 'Timing-Allow-Origin': '*' },
        }),
        metrics,
        authOutcome: 'accepted',
        ...(dropId ? { dropId } : {}),
        ...(deliveryId === undefined ? {} : { deliveryId }),
        verification: 'delivery_pda',
        attempted: result.attempted,
        recovered: result.recovered,
        recoveryMode,
      };
    } catch (error) {
      rethrowDeferredWorkRegistrationError(error);
      let receiptError: DeliveryReceiptError;
      if (isRequestCancellationError(request, error)) throw error;
      if (deadline.timedOut()) {
        receiptError = new DeliveryReceiptError('deadline-exceeded', 'Delivery receipt request timed out.');
      } else if (error instanceof RequestIdentityError) {
        const mapped = requestIdentityErrorDetails(error, {
          code: 'unavailable',
          message: 'Authentication is temporarily unavailable.',
        });
        receiptError = new DeliveryReceiptError(mapped.code, mapped.message);
      } else if (error instanceof DeliveryReceiptError) {
        receiptError = error;
      } else if (error instanceof ProfileReadError) {
        receiptError = new DeliveryReceiptError(
          error.code === 'deadline-exceeded' ? 'deadline-exceeded' : 'unavailable',
          'Receipt data is temporarily unavailable.',
        );
      } else {
        console.error({
          event: 'delivery_receipt_unhandled_error',
          path,
          ...(dropId ? { dropId } : {}),
          ...(deliveryId === undefined ? {} : { deliveryId }),
          error: summarizeError(error),
        });
        receiptError = new DeliveryReceiptError('internal', 'Delivery receipt request failed.');
      }
      return {
        response: errorResponse(receiptError),
        metrics,
        authOutcome: identity
          ? 'accepted'
          : error instanceof RequestIdentityError && error.kind !== 'invalid-token'
            ? 'provider-failure'
            : 'rejected',
        ...(dropId ? { dropId } : {}),
        ...(deliveryId === undefined ? {} : { deliveryId }),
        verification: path === DELIVERY_RECEIPTS_ISSUE_PATH ? 'signature' : 'delivery_pda',
        ...(recoveryMode ? { recoveryMode } : {}),
      };
    }
  });
}

export const deliveryReceiptTestHooks = {
  assertDeliveryPayers,
  assertDeliverArgsMatchOrder,
  decodeDeliveryRecord,
  deliveryRecoveryFailure,
  issueReceiptsRequest,
  probePendingReceiptSubmission,
  reconcilePendingReceiptSubmission,
  loadBoundWallet,
  normalizeAssignedDudeIds,
  pendingReceiptItems,
  ReceiptBatchRetryExhaustedError,
  recoverReceiptsRequest,
  runtimeForDrop,
  sendReceiptBatch,
  shouldShrinkReceiptBatch,
};
