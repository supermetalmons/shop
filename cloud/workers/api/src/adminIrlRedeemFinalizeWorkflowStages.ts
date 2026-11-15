import { Keypair, PublicKey } from '@solana/web3.js';
import type { AdminIrlRedeemBoxBaseInput } from './adminIrlRedeem.js';
import { PendingFinalizeSubmissionError, summarizeAdminIrlRedeemFinalizeError as summarizeError } from './adminIrlRedeemErrors.js';
import {
  createConnection,
  findReceiptAssets,
  runtimeSupportsFinalize,
  verifyCardTransfer,
  verifyPackTransfer,
  waitForCardReceipt,
} from './adminIrlRedeemFinalizeOnchainReads.js';
import { closeInternalDelivery, ensureInternalDelivery, mintPackReceipts } from './adminIrlRedeemFinalizeReceiptActions.js';
import {
  adminIrlRedeemFinalizeOperationId,
  canonicalWallet,
  requestPath,
  requestSchema,
} from './adminIrlRedeemFinalizeRequest.js';
import { reconcileStartedRequestSubmission } from './adminIrlRedeemFinalizeSubmission.js';
import type {
  AdminIrlRedeemFinalizeRequest,
  AdminIrlRedeemFinalizeWorkflowPhaseResult,
  AdminIrlRedeemFinalizeWorkflowReservation,
  AdminIrlRedeemFinalizeWorkflowStageArgs,
  CommerceContext,
} from './adminIrlRedeemFinalizeTypes.js';
import {
  AdminIrlRedeemFinalizeError,
  WORKFLOW_EXECUTION_FIELD,
  adminIrlRedeemFinalizeOperationIdForWallet,
  canonicalPublicKey,
  canonicalSignature,
  type AdminIrlRedeemFinalizeWorkflowError,
  type AdminIrlRedeemFinalizeWorkflowPayload,
  type AdminIrlRedeemFinalizeWorkflowResultReference,
} from './adminIrlRedeemFinalizeWorkflowState.js';
import { buildRuntime as buildAdminIrlRedeemRuntime, type ProviderContext } from './adminIrlRedeemOnchain.js';
import {
  completeFromExistingMarkers,
  publishCard,
  publishPack,
  reusableExistingMarkerState,
} from './adminIrlRedeemPublicationStore.js';
import {
  completeResponse,
  finalizeRequestOwner,
  validateWorkflowCompletion,
  validateWorkflowDraftForRequest,
  type AdminIrlRedeemFinalizeResponse,
  type AdminIrlRedeemFinalizeWorkflowExecutionV1,
  type AdminIrlRedeemFinalizeWorkflowPublicationDraftV1,
  type FinalizeRequest,
  type StartedRequest,
} from './adminIrlRedeemRequestState.js';
import {
  enterWorkflow,
  persistWorkflowDraft,
  persistWorkflowOnchain,
  recordWorkflowFailure,
  startFinalize,
} from './adminIrlRedeemRequestStore.js';
import { D1CommerceRepository, commerceKeys } from './commerceRepository.js';
import { readCommerceRecord } from './commerceTransactions.js';
import { isRecord } from './dataAccess.js';
import { assignDudesForBox } from './deliveryDudeAssignments.js';
import { projectPendingDeliveryPackStatus } from './deliveryPackStatusOutbox.js';
import { secureRandomInt } from './deliveryRandom.js';
import { decodeCosigner, fetchOnchainConfig as fetchDeliveryOnchainConfig } from './deliveryReceiptOnchain.js';
import { API_DROPS, type ApiDropConfig } from './dropConfig.js';

function workflowCommerceContext(
  env: Pick<Env, 'COMMERCE_DB'> & Partial<Pick<Env, 'DATA_DB'>>,
  signal: AbortSignal,
  nowMs = Date.now(),
): CommerceContext {
  return {
    repository: new D1CommerceRepository(env.COMMERCE_DB),
    nowMs,
    providerFetch: (input, init) => fetch(input, init),
    signal,
    dataDb: env.DATA_DB,
  };
}

function workflowProviderContext(
  env: Pick<Env, 'HELIUS_API_KEY'>,
  signal: AbortSignal,
): ProviderContext {
  const apiKey = String(env.HELIUS_API_KEY || '').trim();
  if (!apiKey) {
    throw new AdminIrlRedeemFinalizeError('unavailable', 'Admin IRL redeem finalization is temporarily unavailable.');
  }
  return { apiKey, providerFetch: (input, init) => fetch(input, init), signal };
}

function workflowSigner(env: Pick<Env, 'COSIGNER_SECRET'>): Keypair {
  const secret = String(env.COSIGNER_SECRET || '').trim();
  if (!secret) {
    throw new AdminIrlRedeemFinalizeError('unavailable', 'Admin IRL redeem finalization is temporarily unavailable.');
  }
  return decodeCosigner(secret);
}

function workflowResultReference(
  dropId: string,
  requestId: string,
): AdminIrlRedeemFinalizeWorkflowResultReference {
  return { kind: 'admin-irl-redeem-finalize-v1', dropId, requestId };
}

async function projectWorkflowPackStatus(
  commerce: CommerceContext,
  response: AdminIrlRedeemFinalizeResponse,
): Promise<void> {
  const deliveryId = response.deliveryId;
  if (typeof deliveryId !== 'number' || !Number.isSafeInteger(deliveryId) || deliveryId < 1 || response.boxes.length < 1) {
    return;
  }
  try {
    await projectPendingDeliveryPackStatus({
      context: commerce,
      deliveryId,
      dropId: response.dropId,
    });
  } catch (error) {
    console.error({
      event: 'admin_irl_redeem_pack_status_projection_failed',
      dropId: response.dropId,
      deliveryId,
      error: summarizeError(error),
    });
  }
}

type LoadedWorkflowRequest =
  | Readonly<{
      status: 'complete';
      response: AdminIrlRedeemFinalizeResponse;
      body: FinalizeRequest;
      commerce: CommerceContext;
    }>
  | Readonly<{
      status: 'started';
      body: FinalizeRequest;
      commerce: CommerceContext;
      request: StartedRequest;
      execution: AdminIrlRedeemFinalizeWorkflowExecutionV1;
      draft?: AdminIrlRedeemFinalizeWorkflowPublicationDraftV1;
    }>;

async function loadWorkflowRequest(
  args: AdminIrlRedeemFinalizeWorkflowStageArgs,
  confirmEntry = false,
): Promise<LoadedWorkflowRequest> {
  const commerce = workflowCommerceContext(args.env, args.signal);
  return { ...await enterWorkflow(commerce, args, confirmEntry), commerce };
}

export async function reserveAdminIrlRedeemFinalizeWorkflow(args: Readonly<{
  body: AdminIrlRedeemFinalizeRequest;
  env: Pick<Env, 'COMMERCE_DB'> & Partial<Pick<Env, 'DATA_DB'>>;
  operationId: string;
  signal: AbortSignal;
  staffWallet: string;
  nowMs?: number;
}>): Promise<AdminIrlRedeemFinalizeWorkflowReservation> {
  const parsed = requestSchema.safeParse(args.body);
  if (!parsed.success) {
    throw new AdminIrlRedeemFinalizeError('invalid-argument', 'Invalid Admin IRL redeem finalization request.');
  }
  const wallet = canonicalWallet(args.staffWallet);
  if (args.operationId !== await adminIrlRedeemFinalizeOperationId(parsed.data, wallet)) {
    throw new AdminIrlRedeemFinalizeError('invalid-argument', 'Invalid Admin IRL redeem Workflow operation id.');
  }
  const config = API_DROPS[parsed.data.dropId];
  if (!config) throw new AdminIrlRedeemFinalizeError('invalid-argument', `Unsupported dropId: ${parsed.data.dropId}`);
  const snapshot = JSON.parse(JSON.stringify(config)) as ApiDropConfig;
  runtimeSupportsFinalize(buildAdminIrlRedeemRuntime(snapshot));
  const commerce = workflowCommerceContext(args.env, args.signal, args.nowMs ?? Date.now());
  const prepared = await readCommerceRecord(
    commerce,
    commerceKeys.adminIrlRedeemRequest(parsed.data.dropId, parsed.data.requestId),
  );
  if (!prepared) throw new AdminIrlRedeemFinalizeError('not-found', 'Admin IRL redeem request not found.');
  const owner = finalizeRequestOwner(prepared.data, wallet);
  const adminWallet = canonicalPublicKey(prepared.data.adminWallet);
  if (!adminWallet) {
    throw new AdminIrlRedeemFinalizeError('failed-precondition', 'Admin IRL redeem request admin wallet is invalid.');
  }
  const execution: AdminIrlRedeemFinalizeWorkflowExecutionV1 = {
    version: 1,
    operationId: args.operationId,
    owner,
    transferSignature: parsed.data.transferSignature,
    adminWallet,
    config: snapshot,
    pendingEffect: { kind: 'create', untilMs: 0 },
  };
  const started = await startFinalize(
    commerce,
    parsed.data,
    wallet,
    args.operationId,
    args.nowMs ?? Date.now(),
    execution,
  );
  if (started.status === 'complete') {
    return { status: 'complete', result: completeResponse(parsed.data.dropId, parsed.data.requestId, started.request) };
  }
  return {
    status: 'reserved',
    payload: { version: 1, dropId: parsed.data.dropId, requestId: parsed.data.requestId },
  };
}

export async function resumeAndReconcileAdminIrlRedeemFinalizeWorkflow(
  args: AdminIrlRedeemFinalizeWorkflowStageArgs,
): Promise<AdminIrlRedeemFinalizeWorkflowPhaseResult> {
  const loaded = await loadWorkflowRequest(args, true);
  if (loaded.status === 'complete') return { status: 'complete' };
  if (loaded.draft) return { status: 'drafted' };
  const runtime = buildAdminIrlRedeemRuntime(loaded.execution.config);
  const provider = workflowProviderContext(args.env, args.signal);
  await reconcileStartedRequestSubmission({
    commerce: loaded.commerce,
    provider,
    runtime,
    path: requestPath(loaded.body),
    attemptId: args.operationId,
    request: loaded.request,
  });
  return { status: 'ready' };
}

export async function validateAdminIrlRedeemFinalizeWorkflow(
  args: AdminIrlRedeemFinalizeWorkflowStageArgs,
): Promise<AdminIrlRedeemFinalizeWorkflowPhaseResult> {
  const loaded = await loadWorkflowRequest(args);
  if (loaded.status === 'complete') return { status: 'complete' };
  if (loaded.draft) return { status: 'drafted' };
  if (loaded.request.pendingFinalizeSubmission) throw new PendingFinalizeSubmissionError();
  const runtime = buildAdminIrlRedeemRuntime(loaded.execution.config);
  const provider = workflowProviderContext(args.env, args.signal);
  const connection = createConnection(provider, runtime);
  const signer = workflowSigner(args.env);
  const onchain = await fetchDeliveryOnchainConfig(connection, runtime);
  const pinned = {
    adminWallet: onchain.admin.toBase58(),
    coreCollection: onchain.coreCollection.toBase58(),
    treasury: new PublicKey(onchain.decoded.treasury).toBase58(),
  };
  if (pinned.adminWallet !== loaded.request.adminWallet || !signer.publicKey.equals(onchain.admin)) {
    throw new AdminIrlRedeemFinalizeError('failed-precondition', 'COSIGNER_SECRET does not match the prepared on-chain admin.');
  }
  await persistWorkflowOnchain(loaded, pinned);
  if (loaded.request.targetKind === 'card_receipt') {
    const card = loaded.request.items[0];
    if (!card || card.kind !== 'card_receipt') {
      throw new AdminIrlRedeemFinalizeError('failed-precondition', 'Admin IRL card receipt request is invalid.');
    }
    await verifyCardTransfer(
      connection,
      runtime,
      loaded.body.transferSignature,
      loaded.request.owner,
      pinned.adminWallet,
      onchain.coreCollection,
      card.assetId,
    );
    return { status: 'ready' };
  }
  await verifyPackTransfer(
    connection,
    loaded.body.transferSignature,
    loaded.request.owner,
    pinned.adminWallet,
    onchain.coreCollection,
    loaded.request.itemIds,
  );
  return { status: 'ready' };
}

export async function prepareAdminIrlRedeemFinalizeWorkflowDraft(
  args: AdminIrlRedeemFinalizeWorkflowStageArgs,
): Promise<AdminIrlRedeemFinalizeWorkflowPhaseResult> {
  const loaded = await loadWorkflowRequest(args);
  if (loaded.status === 'complete') return { status: 'complete' };
  if (loaded.draft) return { status: 'drafted' };
  const runtime = buildAdminIrlRedeemRuntime(loaded.execution.config);
  if (loaded.request.pendingFinalizeSubmission) {
    const provider = workflowProviderContext(args.env, args.signal);
    await reconcileStartedRequestSubmission({
      commerce: loaded.commerce,
      provider,
      runtime,
      path: requestPath(loaded.body),
      attemptId: args.operationId,
      request: loaded.request,
    });
  }
  const markerState = loaded.request.targetKind === 'pack'
    ? await reusableExistingMarkerState(loaded.commerce, loaded.body, args.operationId, loaded.request)
    : { status: 'none' as const };
  if (markerState.status === 'complete') return { status: 'complete' };
  if (markerState.status === 'reuse') {
    await persistWorkflowDraft(loaded, {
      version: 1,
      targetKind: 'pack',
      mode: 'marker_reuse',
      receiptOwner: loaded.request.adminWallet,
      deliveryId: markerState.deliveryId,
      sourceRequestId: markerState.sourceRequestId,
      fingerprint: markerState.fingerprint,
    });
    return { status: 'drafted' };
  }
  const provider = workflowProviderContext(args.env, args.signal);
  const pinned = loaded.execution.onchain;
  if (!pinned) {
    throw new AdminIrlRedeemFinalizeError('failed-precondition', 'Admin IRL redeem Workflow configuration was not validated.');
  }
  const signer = workflowSigner(args.env);
  if (signer.publicKey.toBase58() !== pinned.adminWallet || pinned.adminWallet !== loaded.request.adminWallet) {
    throw new AdminIrlRedeemFinalizeError('failed-precondition', 'COSIGNER_SECRET does not match the prepared on-chain admin.');
  }
  const connection = createConnection(provider, runtime);
  const current = await fetchDeliveryOnchainConfig(connection, runtime);
  if (
    current.admin.toBase58() !== pinned.adminWallet ||
    current.coreCollection.toBase58() !== pinned.coreCollection ||
    new PublicKey(current.decoded.treasury).toBase58() !== pinned.treasury
  ) {
    throw new AdminIrlRedeemFinalizeError('failed-precondition', 'Admin IRL redeem on-chain configuration changed.');
  }
  if (loaded.request.targetKind === 'card_receipt') {
    const card = loaded.request.items[0];
    if (!card || card.kind !== 'card_receipt') {
      throw new AdminIrlRedeemFinalizeError('failed-precondition', 'Admin IRL card receipt request is invalid.');
    }
    await waitForCardReceipt(provider, runtime, card.assetId, card.refId, pinned.adminWallet);
    await persistWorkflowDraft(loaded, {
      version: 1,
      targetKind: 'card_receipt',
      receiptOwner: pinned.adminWallet,
      card: { figureId: card.refId, receiptAssetId: card.assetId },
    });
    return { status: 'drafted' };
  }
  const internal = await ensureInternalDelivery(
    connection,
    provider,
    runtime,
    signer,
    current,
    loaded.commerce,
    requestPath(loaded.body),
    args.operationId,
    loaded.request,
  );
  const receiptTxs = await mintPackReceipts(
    connection,
    provider,
    runtime,
    signer,
    current.coreCollection,
    loaded.request.items,
    loaded.commerce,
    requestPath(loaded.body),
    args.operationId,
    loaded.request.receiptTxs,
  );
  const assets = await findReceiptAssets(
    connection,
    provider,
    runtime,
    pinned.adminWallet,
    loaded.request.items,
    receiptTxs,
  );
  const boxes: AdminIrlRedeemBoxBaseInput[] = [];
  for (const item of loaded.request.items) {
    const matches = assets.get(item.refId) || [];
    if (matches.length === 0) {
      throw new AdminIrlRedeemFinalizeError('unavailable', 'Admin IRL redeem pack receipt is not indexed yet.');
    }
    const receiptAssetId = matches.length === 1 ? canonicalPublicKey(matches[0].id) : undefined;
    if (matches.length !== 1 || !receiptAssetId) {
      throw new AdminIrlRedeemFinalizeError('failed-precondition', 'Admin IRL redeem pack receipt indexing is ambiguous.');
    }
    const dudeIds = await assignDudesForBox(
      loaded.commerce,
      runtime,
      receiptAssetId,
      secureRandomInt,
    );
    boxes.push({ boxId: item.refId, originalAssetId: item.assetId, receiptAssetId, dudeIds });
  }
  const closeDeliveryTx = await closeInternalDelivery(
    connection,
    runtime,
    signer,
    loaded.commerce,
    requestPath(loaded.body),
    args.operationId,
    loaded.request,
    internal,
  ).catch(() => null);
  await persistWorkflowDraft(loaded, {
    version: 1,
    targetKind: 'pack',
    mode: 'prepared',
    receiptOwner: pinned.adminWallet,
    internalDelivery: internal,
    closeDeliveryTx,
    receiptTxs,
    boxes,
  });
  return { status: 'drafted' };
}

export async function publishAdminIrlRedeemFinalizeWorkflow(
  args: AdminIrlRedeemFinalizeWorkflowStageArgs,
): Promise<AdminIrlRedeemFinalizeWorkflowResultReference> {
  const loaded = await loadWorkflowRequest(args);
  if (loaded.status === 'complete') {
    await projectWorkflowPackStatus(loaded.commerce, loaded.response);
    return workflowResultReference(loaded.body.dropId, loaded.body.requestId);
  }
  const draft = loaded.draft;
  if (!draft) {
    throw new AdminIrlRedeemFinalizeError('failed-precondition', 'Admin IRL redeem publication draft is missing.');
  }
  const runtime = buildAdminIrlRedeemRuntime(loaded.execution.config);
  validateWorkflowDraftForRequest(draft, loaded.request, runtime);
  if (draft.targetKind === 'card_receipt') {
    await publishCard(
      loaded.commerce,
      runtime,
      loaded.body,
      args.operationId,
      loaded.request,
      draft.receiptOwner,
      draft.card,
    );
  } else if (draft.mode === 'marker_reuse') {
    const completed = await completeFromExistingMarkers(
      loaded.commerce,
      loaded.body,
      args.operationId,
      loaded.request,
      {
        deliveryId: draft.deliveryId,
        sourceRequestId: draft.sourceRequestId,
        fingerprint: draft.fingerprint,
      },
    );
    if (!completed) {
      throw new AdminIrlRedeemFinalizeError('failed-precondition', 'Admin IRL redeem marker reuse state changed.');
    }
    await projectWorkflowPackStatus(loaded.commerce, completed);
  } else {
    const completed = await publishPack(
      loaded.commerce,
      runtime,
      loaded.body,
      args.operationId,
      loaded.request,
      draft.receiptOwner,
      draft.internalDelivery,
      draft.closeDeliveryTx,
      draft.receiptTxs,
      draft.boxes,
    );
    await projectWorkflowPackStatus(loaded.commerce, completed);
  }
  return workflowResultReference(loaded.body.dropId, loaded.body.requestId);
}

export async function cleanupAdminIrlRedeemFinalizeWorkflow(args: Readonly<{
  env: Pick<Env, 'COMMERCE_DB'> & Partial<Pick<Env, 'DATA_DB'>>;
  error: AdminIrlRedeemFinalizeWorkflowError;
  operationId: string;
  payload: AdminIrlRedeemFinalizeWorkflowPayload;
  signal: AbortSignal;
}>): Promise<{ cleared: boolean }> {
  return recordWorkflowFailure({
    commerce: workflowCommerceContext(args.env, args.signal),
    error: args.error,
    operationId: args.operationId,
    payload: args.payload,
  });
}

export async function loadAdminIrlRedeemFinalizeWorkflowResult(args: Readonly<{
  env: Pick<Env, 'COMMERCE_DB'>;
  operationId: string;
  reference?: AdminIrlRedeemFinalizeWorkflowResultReference;
}>): Promise<AdminIrlRedeemFinalizeResponse> {
  const repository = new D1CommerceRepository(args.env.COMMERCE_DB);
  const document = await repository.getAdminIrlRedeemRequestForWorkflowStatus(args.operationId);
  if (!document) throw new AdminIrlRedeemFinalizeError('not-found', 'Admin IRL redeem Workflow operation not found.');
  const fields = document.data;
  const execution = isRecord(fields[WORKFLOW_EXECUTION_FIELD]) ? fields[WORKFLOW_EXECUTION_FIELD] : null;
  const owner = canonicalPublicKey(fields.owner);
  const transferSignature = canonicalSignature(fields.transferSignature);
  if (
    !execution || execution.version !== 1 || execution.operationId !== args.operationId ||
    !owner || execution.owner !== owner || execution.transferSignature !== transferSignature || !transferSignature
  ) {
    throw new AdminIrlRedeemFinalizeError('internal', 'Stored Admin IRL redeem Workflow result is invalid.');
  }
  const dropId = document.key.dropId || '';
  const requestId = document.key.documentId;
  if (
    args.operationId !== await adminIrlRedeemFinalizeOperationIdForWallet({ dropId, requestId, transferSignature }, owner) ||
    fields.status !== 'complete' || fields.dropId !== dropId ||
    (args.reference && (args.reference.dropId !== dropId || args.reference.requestId !== requestId))
  ) {
    throw new AdminIrlRedeemFinalizeError('internal', 'Stored Admin IRL redeem Workflow result is invalid.');
  }
  return validateWorkflowCompletion(completeResponse(dropId, requestId, fields), fields);
}
