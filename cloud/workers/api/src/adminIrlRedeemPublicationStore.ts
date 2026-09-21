import { ADMIN_IRL_REDEEM_DELIVERY_ORDER_SOURCE } from '../../../../shared/fulfillmentSources.js';
import {
  STRIPE_RECEIPT_CLAIM_CODE_NAMESPACE,
  generateUniqueStripeReceiptClaimCodes,
  normalizeStripeReceiptClaimCode,
  requireStripeReceiptClaimCode,
  stripeReceiptClaimCodeMaybe,
} from '../../../../shared/stripeReceiptClaims.js';
import {
  ADMIN_IRL_REDEEM_CARD_MARKER_VERSION,
  buildAdminIrlRedeemCardClaimCodeDocument,
  buildAdminIrlRedeemCardDeliveryOrderDocument,
  buildAdminIrlRedeemCardMarkerDocument,
  buildAdminIrlRedeemClaimCodeDocument,
  buildAdminIrlRedeemDeliveryOrderDocument,
  buildAdminIrlRedeemMarkerDocument,
  buildAdminIrlRedeemSelectionKey,
  resolveAdminIrlRedeemMarkerReuse,
  type AdminIrlRedeemBoxBaseInput,
  type AdminIrlRedeemCardInput,
  type AdminIrlRedeemMarkerReuseResolution,
} from './adminIrlRedeem.js';
import {
  AdminIrlRedeemFinalizeError,
  WORKFLOW_EXECUTION_FIELD,
} from './adminIrlRedeemFinalizeWorkflowState.js';
import {
  type AdminIrlRedeemFinalizeResponse,
  type FinalizeRequest,
  type InternalDelivery,
  MAX_DELIVERY_ALLOCATION_ATTEMPTS,
  MAX_ITEMS,
  type StartedRequest,
  WORKFLOW_DRAFT_FIELD,
  completeResponse,
  normalizeReceiptTxs,
  validateWorkflowCompletion,
} from './adminIrlRedeemRequestState.js';
import { type AdminIrlRedeemRuntime } from './adminIrlRedeemRuntime.js';
import {
  commerceFieldValue,
  commerceKeys,
  isCommerceDeleteField,
  type CommerceDocumentData,
  type CommerceDocumentKey,
  type CommerceDocumentWriteData,
  type CommerceUnitOfWork,
} from './commerceRepository.js';
import {
  readCommerceRecord,
  runCommerceTransaction,
  type CommerceRepositoryContext,
} from './commerceTransactions.js';
import { isRecord } from './dataAccess.js';
import { createDeliveryPackStatusProjectionOutbox } from './deliveryPackStatusOutbox.js';
import { secureRandomInt } from './deliveryRandom.js';

type CommerceContext = CommerceRepositoryContext;
type Runtime = AdminIrlRedeemRuntime;
function markerKeys(dropId: string, boxes: ReadonlyArray<{ originalAssetId: string; receiptAssetId?: string }>): CommerceDocumentKey[] {
  const keys = boxes.flatMap((box) => [
    commerceKeys.adminIrlRedeemPackMarker(dropId, box.originalAssetId),
    ...(box.receiptAssetId ? [commerceKeys.adminIrlRedeemReceiptMarker(dropId, box.receiptAssetId)] : []),
  ]);
  return Array.from(new Map(keys.map((key) => [key.path, key])).values());
}

function dudeIdsByBoxId(order: Record<string, unknown>): Map<number, number[]> {
  const result = new Map<number, number[]>();
  if (!Array.isArray(order.irlClaims)) return result;
  for (const value of order.irlClaims) {
    if (!isRecord(value) || typeof value.boxId !== 'number' || !Number.isSafeInteger(value.boxId) ||
      value.boxId < 1 || !Array.isArray(value.dudeIds) ||
      !value.dudeIds.every((id) => typeof id === 'number' && Number.isSafeInteger(id) && id > 0) ||
      new Set(value.dudeIds).size !== value.dudeIds.length) {
      throw markerConflict('marker delivery order assignments are invalid');
    }
    result.set(value.boxId, value.dudeIds as number[]);
  }
  return result;
}

function markerConflict(reason?: string): AdminIrlRedeemFinalizeError {
  return new AdminIrlRedeemFinalizeError('failed-precondition', 'One or more selected items already have Admin IRL claim codes.', {
    ...(reason ? { reason } : {}),
  });
}

async function markerResolution(
  transaction: CommerceUnitOfWork,
  dropId: string,
  selectionKey: string,
  boxes: ReadonlyArray<{ originalAssetId: string; receiptAssetId?: string }>,
): Promise<AdminIrlRedeemMarkerReuseResolution> {
  const markers = await transaction.getMany(markerKeys(dropId, boxes));
  return resolveAdminIrlRedeemMarkerReuse({
    dropId,
    selectionKey,
    originalAssetIds: boxes.map((box) => box.originalAssetId),
    markers: markers.map((document) => document?.data || null),
  });
}

function completedMarkerReuse(
  request: CommerceDocumentData,
  order: Record<string, unknown>,
  resolution: Extract<AdminIrlRedeemMarkerReuseResolution, { status: 'reuse' }>,
): CommerceDocumentData {
  if (order.source !== ADMIN_IRL_REDEEM_DELIVERY_ORDER_SOURCE) throw markerConflict('marker delivery order source mismatch');
  const byBox = dudeIdsByBoxId(order);
  const receiptTxs = Array.from(new Set([...normalizeReceiptTxs(order.receiptTxs), ...normalizeReceiptTxs(request.receiptTxs)]));
  return {
    ...request,
    status: 'complete',
    deliveryId: resolution.deliveryId,
    receiptTxs,
    claimCodes: resolution.claimCodes,
    boxes: resolution.boxes.map((box) => ({ ...box, dudeIds: byBox.get(box.boxId) || [] })),
    duplicateOfRequestId: resolution.requestId,
  };
}

type MarkerReuseReference = {
  deliveryId: number;
  sourceRequestId: string;
  fingerprint: string;
};

async function markerReuseReference(completed: Record<string, unknown>): Promise<MarkerReuseReference> {
  const deliveryId = Number(completed.deliveryId);
  const sourceRequestId = typeof completed.duplicateOfRequestId === 'string' ? completed.duplicateOfRequestId : '';
  if (!Number.isSafeInteger(deliveryId) || deliveryId < 1 || !/^[A-Za-z0-9_-]{8,128}$/.test(sourceRequestId)) {
    throw markerConflict('marker completion identity is invalid');
  }
  const stable = {
    deliveryId,
    sourceRequestId,
    receiptTxs: normalizeReceiptTxs(completed.receiptTxs),
    claimCodes: Array.isArray(completed.claimCodes) ? completed.claimCodes : [],
    boxes: Array.isArray(completed.boxes) ? completed.boxes : [],
  };
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(stable)));
  return {
    deliveryId,
    sourceRequestId,
    fingerprint: Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join(''),
  };
}

async function resolveExistingMarkerCompletion(
  commerce: CommerceContext,
  transaction: CommerceUnitOfWork,
  body: FinalizeRequest,
  request: StartedRequest,
  fields: CommerceDocumentData,
): Promise<{ completed: CommerceDocumentData; reference: MarkerReuseReference } | null> {
  const selectionKey = buildAdminIrlRedeemSelectionKey({ dropId: body.dropId, originalAssetIds: request.itemIds });
  const resolution = await markerResolution(
    transaction,
    body.dropId,
    selectionKey,
    request.items.map((item) => ({ originalAssetId: item.assetId })),
  );
  if (resolution.status === 'none') return null;
  if (resolution.status === 'conflict') throw markerConflict(resolution.reason);
  const order = await readCommerceRecord(
    commerce,
    commerceKeys.deliveryOrder(body.dropId, String(resolution.deliveryId)),
    transaction,
  );
  if (!order) throw markerConflict('marker delivery order missing');
  const completed = completedMarkerReuse(fields, order.data, resolution);
  validateWorkflowCompletion(completeResponse(body.dropId, body.requestId, completed), completed);
  return { completed, reference: await markerReuseReference(completed) };
}

function completeRequestValues(completed: CommerceDocumentData): CommerceDocumentWriteData {
  return {
    status: 'complete',
    ...(Number.isSafeInteger(completed.deliveryId) ? { deliveryId: completed.deliveryId } : {}),
    receiptTxs: normalizeReceiptTxs(completed.receiptTxs),
    claimCodes: Array.isArray(completed.claimCodes) ? completed.claimCodes : [],
    ...(Array.isArray(completed.boxes) ? { boxes: completed.boxes } : {}),
    ...(Array.isArray(completed.cards) ? { cards: completed.cards } : {}),
    ...(typeof completed.duplicateOfRequestId === 'string' ? { duplicateOfRequestId: completed.duplicateOfRequestId } : {}),
    ...(Number.isSafeInteger(completed.internalDeliveryId) ? { internalDeliveryId: completed.internalDeliveryId } : {}),
    ...(typeof completed.internalDeliveryPda === 'string' ? { internalDeliveryPda: completed.internalDeliveryPda } : {}),
    ...(typeof completed.internalDeliveryTx === 'string' ? { internalDeliveryTx: completed.internalDeliveryTx } : {}),
    ...(typeof completed.closeDeliveryTx === 'string' ? { closeDeliveryTx: completed.closeDeliveryTx } : {}),
    processingAttemptId: commerceFieldValue.delete(),
    processingStartedAt: commerceFieldValue.delete(),
    processingLeaseExpiresAt: commerceFieldValue.delete(),
    preparedExpiresAt: commerceFieldValue.delete(),
    pendingFinalizeSubmission: commerceFieldValue.delete(),
    [WORKFLOW_DRAFT_FIELD]: commerceFieldValue.delete(),
    [`${WORKFLOW_EXECUTION_FIELD}.failure`]: commerceFieldValue.delete(),
    [`${WORKFLOW_EXECUTION_FIELD}.instanceCreationPending`]: commerceFieldValue.delete(),
    [`${WORKFLOW_EXECUTION_FIELD}.pendingEffect`]: commerceFieldValue.delete(),
    completedAt: commerceFieldValue.serverTimestamp(),
    updatedAt: commerceFieldValue.serverTimestamp(),
  };
}

export async function completeFromExistingMarkers(
  commerce: CommerceContext,
  body: FinalizeRequest,
  attemptId: string,
  request: StartedRequest,
  expected?: MarkerReuseReference,
): Promise<AdminIrlRedeemFinalizeResponse | null> {
  const result = await runCommerceTransaction<
    { status: 'none' } |
    { status: 'complete'; request: Record<string, unknown> }
  >(commerce, async (transaction) => {
    const document = await readCommerceRecord(
      commerce,
      commerceKeys.adminIrlRedeemRequest(body.dropId, body.requestId),
      transaction,
    );
    if (!document) throw new AdminIrlRedeemFinalizeError('not-found', 'Admin IRL redeem request not found.');
    if (document.data.status === 'complete') return { status: 'complete' as const, request: document.data };
    if (document.data.status !== 'processing' || document.data.processingAttemptId !== attemptId) {
      throw new AdminIrlRedeemFinalizeError('aborted', 'Admin IRL redeem processing lease changed.');
    }
    const resolved = await resolveExistingMarkerCompletion(commerce, transaction, body, request, document.data);
    if (!resolved) return { status: 'none' as const };
    if (expected && (
      resolved.reference.deliveryId !== expected.deliveryId ||
      resolved.reference.sourceRequestId !== expected.sourceRequestId ||
      resolved.reference.fingerprint !== expected.fingerprint
    )) throw markerConflict('marker reuse state changed after draft');
    await transaction.update(document.key, completeRequestValues(resolved.completed));
    return { status: 'complete' as const, request: resolved.completed };
  });
  return result.status === 'none' ? null : completeResponse(body.dropId, body.requestId, result.request);
}

export async function reusableExistingMarkerState(
  commerce: CommerceContext,
  body: FinalizeRequest,
  attemptId: string,
  request: StartedRequest,
): Promise<
  | { status: 'none' }
  | { status: 'complete' }
  | ({ status: 'reuse' } & MarkerReuseReference)
> {
  return runCommerceTransaction<
    | { status: 'none' }
    | { status: 'complete' }
    | ({ status: 'reuse' } & MarkerReuseReference)
  >(commerce, async (transaction) => {
    const document = await readCommerceRecord(
      commerce,
      commerceKeys.adminIrlRedeemRequest(body.dropId, body.requestId),
      transaction,
    );
    if (!document) throw new AdminIrlRedeemFinalizeError('not-found', 'Admin IRL redeem request not found.');
    if (document.data.status === 'complete') return { status: 'complete' as const };
    if (document.data.status !== 'processing' || document.data.processingAttemptId !== attemptId) {
      throw new AdminIrlRedeemFinalizeError('aborted', 'Admin IRL redeem processing lease changed.');
    }
    const resolved = await resolveExistingMarkerCompletion(commerce, transaction, body, request, document.data);
    return resolved
      ? { status: 'reuse' as const, ...resolved.reference }
      : { status: 'none' as const };
  });
}

function newDeliveryId(): number {
  return secureRandomInt(2 ** 31 - 1) + 1;
}

function newClaimCodes(quantity: number): string[] {
  if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > MAX_ITEMS) {
    throw new AdminIrlRedeemFinalizeError('invalid-argument', 'Invalid receipt claim code quantity.');
  }
  return generateUniqueStripeReceiptClaimCodes(quantity);
}

export async function publishPack(
  commerce: CommerceContext,
  runtime: Runtime,
  body: FinalizeRequest,
  attemptId: string,
  request: StartedRequest,
  receiptOwner: string,
  internal: InternalDelivery,
  closeDeliveryTx: string | null,
  receiptTxs: string[],
  boxes: AdminIrlRedeemBoxBaseInput[],
): Promise<AdminIrlRedeemFinalizeResponse> {
  const selectionKey = buildAdminIrlRedeemSelectionKey({
    dropId: runtime.dropId,
    originalAssetIds: boxes.map((box) => box.originalAssetId),
  });
  for (let attempt = 0; attempt < MAX_DELIVERY_ALLOCATION_ATTEMPTS; attempt += 1) {
    const deliveryId = newDeliveryId();
    const claimCodes = newClaimCodes(boxes.length);
    const boxesWithCodes = boxes.map((box, index) => ({ ...box, receiptClaimCode: claimCodes[index] }));
    const orderKey = commerceKeys.deliveryOrder(runtime.dropId, String(deliveryId));
    const claimKeys = claimCodes.map(commerceKeys.claimCode);
    const result = await runCommerceTransaction<
      { status: 'collision' } |
      { status: 'complete'; request: Record<string, unknown> } |
      { status: 'created'; request: Record<string, unknown>; order: Record<string, unknown> }
    >(commerce, async (transaction) => {
      const document = await readCommerceRecord(
        commerce,
        commerceKeys.adminIrlRedeemRequest(body.dropId, body.requestId),
        transaction,
      );
      if (!document) throw new AdminIrlRedeemFinalizeError('not-found', 'Admin IRL redeem request not found.');
      if (document.data.status === 'complete') return { status: 'complete' as const, request: document.data };
      if (document.data.status !== 'processing' || document.data.processingAttemptId !== attemptId) {
        throw new AdminIrlRedeemFinalizeError('aborted', 'Admin IRL redeem processing lease changed.');
      }
      const resolution = await markerResolution(transaction, runtime.dropId, selectionKey, boxesWithCodes);
      if (resolution.status === 'conflict') throw markerConflict(resolution.reason);
      if (resolution.status === 'reuse') {
        const existingOrder = await readCommerceRecord(
          commerce,
          commerceKeys.deliveryOrder(runtime.dropId, String(resolution.deliveryId)),
          transaction,
        );
        if (!existingOrder) throw markerConflict('marker delivery order missing');
        const completed = completedMarkerReuse(document.data, existingOrder.data, resolution);
        validateWorkflowCompletion(completeResponse(runtime.dropId, request.requestId, completed), completed);
        await transaction.update(document.key, completeRequestValues(completed));
        return { status: 'complete' as const, request: completed };
      }
      if (await readCommerceRecord(commerce, orderKey, transaction)) {
        return { status: 'collision' as const };
      }
      const claims = await transaction.getMany(claimKeys);
      if (claims.some(Boolean)) return { status: 'collision' as const };
      const order = buildAdminIrlRedeemDeliveryOrderDocument({
        dropId: runtime.dropId,
        deliveryId,
        requestId: request.requestId,
        owner: request.owner,
        receiptOwner,
        transferSignature: body.transferSignature,
        receiptTxs,
        boxes: boxesWithCodes,
      });
      const orderValues: CommerceDocumentWriteData = {
        ...order,
        ...Object.fromEntries(Object.entries(createDeliveryPackStatusProjectionOutbox(runtime, order, commerce.nowMs))
          .filter(([, value]) => !isCommerceDeleteField(value))),
      };
      const claimValues = boxesWithCodes.map((box) => ({
        ...buildAdminIrlRedeemClaimCodeDocument({
          dropId: runtime.dropId,
          deliveryId,
          owner: request.owner,
          receiptOwner,
          requestId: request.requestId,
          box,
        }),
        createdAt: commerceFieldValue.serverTimestamp(),
        updatedAt: commerceFieldValue.serverTimestamp(),
      }));
      const markers = new Map<string, { key: CommerceDocumentKey; values: CommerceDocumentWriteData }>();
      boxesWithCodes.forEach((box) => {
        const marker = buildAdminIrlRedeemMarkerDocument({
          dropId: runtime.dropId,
          deliveryId,
          requestId: request.requestId,
          owner: request.owner,
          transferSignature: body.transferSignature,
          selectionKey,
          box,
        });
        for (const key of markerKeys(runtime.dropId, [box])) {
          markers.set(key.path, {
            key,
            values: {
              ...marker,
              createdAt: commerceFieldValue.serverTimestamp(),
            },
          });
        }
      });
      const completed: CommerceDocumentData = {
        ...document.data,
        status: 'complete',
        deliveryId,
        internalDeliveryId: internal.deliveryId,
        internalDeliveryPda: internal.deliveryPda,
        ...(internal.deliveryTx ? { internalDeliveryTx: internal.deliveryTx } : {}),
        ...(closeDeliveryTx ? { closeDeliveryTx } : {}),
        receiptTxs,
        claimCodes,
        boxes: boxesWithCodes.map((box) => ({
          boxId: box.boxId,
          originalAssetId: box.originalAssetId,
          receiptAssetId: box.receiptAssetId,
          claimCode: box.receiptClaimCode,
          dudeIds: box.dudeIds,
        })),
      };
      await transaction.getMany([
        orderKey,
        ...claimKeys,
        ...Array.from(markers.values(), ({ key }) => key),
        document.key,
      ]);
      await transaction.create(orderKey, {
        ...orderValues,
        createdAt: commerceFieldValue.serverTimestamp(),
        processedAt: commerceFieldValue.serverTimestamp(),
      });
      for (const [index, values] of claimValues.entries()) {
        await transaction.create(claimKeys[index], values);
      }
      for (const { key, values } of markers.values()) await transaction.create(key, values);
      await transaction.update(document.key, completeRequestValues(completed));
      return { status: 'created' as const, request: completed, order };
    });
    if (result.status === 'collision') continue;
    return completeResponse(runtime.dropId, request.requestId, result.request);
  }
  throw new AdminIrlRedeemFinalizeError('unavailable', 'Failed to allocate Admin IRL redeem delivery id or claim codes.');
}

export async function publishCard(
  commerce: CommerceContext,
  runtime: Runtime,
  body: FinalizeRequest,
  attemptId: string,
  request: StartedRequest,
  receiptOwner: string,
  card: Omit<AdminIrlRedeemCardInput, 'receiptClaimCode'>,
): Promise<AdminIrlRedeemFinalizeResponse> {
  const markerKey = commerceKeys.adminIrlRedeemReceiptMarker(runtime.dropId, card.receiptAssetId);
  for (let attempt = 0; attempt < MAX_DELIVERY_ALLOCATION_ATTEMPTS; attempt += 1) {
    const deliveryId = newDeliveryId();
    const claimCode = newClaimCodes(1)[0];
    const cardWithCode = { ...card, receiptClaimCode: claimCode };
    const orderKey = commerceKeys.deliveryOrder(runtime.dropId, String(deliveryId));
    const claimKey = commerceKeys.claimCode(claimCode);
    const result = await runCommerceTransaction<
      { status: 'collision' } |
      { status: 'complete'; request: Record<string, unknown> } |
      { status: 'created'; request: Record<string, unknown> }
    >(commerce, async (transaction) => {
      const document = await readCommerceRecord(
        commerce,
        commerceKeys.adminIrlRedeemRequest(body.dropId, body.requestId),
        transaction,
      );
      if (!document) throw new AdminIrlRedeemFinalizeError('not-found', 'Admin IRL redeem request not found.');
      if (document.data.status === 'complete') return { status: 'complete' as const, request: document.data };
      if (document.data.status !== 'processing' || document.data.processingAttemptId !== attemptId) {
        throw new AdminIrlRedeemFinalizeError('aborted', 'Admin IRL redeem processing lease changed.');
      }
      const existingMarker = await readCommerceRecord(commerce, markerKey, transaction);
      if (existingMarker) {
        const marker = existingMarker.data;
        const existingDeliveryId = Math.floor(Number(marker.deliveryId));
        let existingClaimCode = '';
        try { existingClaimCode = requireStripeReceiptClaimCode(marker.claimCode); } catch { throw markerConflict('invalid card receipt marker claim code'); }
        if (
          marker.version !== ADMIN_IRL_REDEEM_CARD_MARKER_VERSION ||
          marker.source !== ADMIN_IRL_REDEEM_DELIVERY_ORDER_SOURCE ||
          marker.targetKind !== 'card_receipt' || marker.dropId !== runtime.dropId ||
          marker.receiptAssetId !== card.receiptAssetId || Number(marker.figureId) !== card.figureId ||
          !Number.isSafeInteger(existingDeliveryId) || existingDeliveryId < 1 || marker.owner !== request.owner
        ) throw markerConflict('card receipt marker mismatch');
        const [order, claim] = await transaction.getMany([
          commerceKeys.deliveryOrder(runtime.dropId, String(existingDeliveryId)),
          commerceKeys.claimCode(existingClaimCode),
        ]);
        if (!order || !claim) throw markerConflict('card receipt marker order or claim missing');
        const item = Array.isArray(order.data.items) && isRecord(order.data.items[0]) ? order.data.items[0] : {};
        const orderClaim = isRecord(order.data.stripeReceiptClaim) ? order.data.stripeReceiptClaim : {};
        if (
          order.data.source !== ADMIN_IRL_REDEEM_DELIVERY_ORDER_SOURCE ||
          !isRecord(order.data.adminIrlRedeem) || order.data.adminIrlRedeem.targetKind !== 'card_receipt' ||
          order.data.owner !== request.owner || !Array.isArray(order.data.items) || order.data.items.length !== 1 ||
          item.kind !== 'dude' || Number(item.refId) !== card.figureId || item.assetId !== card.receiptAssetId ||
          orderClaim.receiptKind !== 'figure' || orderClaim.receiptAssetId !== card.receiptAssetId ||
          Number(orderClaim.figureId) !== card.figureId || stripeReceiptClaimCodeMaybe(orderClaim) !== existingClaimCode ||
          claim.data.namespace !== STRIPE_RECEIPT_CLAIM_CODE_NAMESPACE || claim.data.source !== ADMIN_IRL_REDEEM_DELIVERY_ORDER_SOURCE ||
          claim.data.dropId !== runtime.dropId || Number(claim.data.deliveryId) !== existingDeliveryId ||
          claim.data.receiptKind !== 'figure' || claim.data.receiptAssetId !== card.receiptAssetId || Number(claim.data.figureId) !== card.figureId ||
          normalizeStripeReceiptClaimCode(claim.data.code) !== existingClaimCode
        ) throw markerConflict('card receipt marker order or claim mismatch');
        const completed: CommerceDocumentData = {
          ...document.data,
          status: 'complete',
          deliveryId: existingDeliveryId,
          receiptTxs: normalizeReceiptTxs(order.data.receiptTxs),
          claimCodes: [existingClaimCode],
          cards: [{ figureId: card.figureId, receiptAssetId: card.receiptAssetId, claimCode: existingClaimCode }],
          duplicateOfRequestId: marker.requestId,
        };
        await transaction.update(document.key, completeRequestValues(completed));
        return { status: 'complete' as const, request: completed };
      }
      const [orderExists, claimExists] = await transaction.getMany([orderKey, claimKey]);
      if (orderExists || claimExists) return { status: 'collision' as const };
      const order = buildAdminIrlRedeemCardDeliveryOrderDocument({
        dropId: runtime.dropId,
        deliveryId,
        requestId: request.requestId,
        owner: request.owner,
        receiptOwner,
        transferSignature: body.transferSignature,
        card: cardWithCode,
      });
      const claim = buildAdminIrlRedeemCardClaimCodeDocument({
        dropId: runtime.dropId,
        deliveryId,
        owner: request.owner,
        receiptOwner,
        requestId: request.requestId,
        card: cardWithCode,
      });
      const marker = buildAdminIrlRedeemCardMarkerDocument({
        dropId: runtime.dropId,
        deliveryId,
        requestId: request.requestId,
        owner: request.owner,
        transferSignature: body.transferSignature,
        card: cardWithCode,
      });
      const completed: CommerceDocumentData = {
        ...document.data,
        status: 'complete',
        deliveryId,
        receiptTxs: [body.transferSignature],
        claimCodes: [claimCode],
        cards: [{ figureId: card.figureId, receiptAssetId: card.receiptAssetId, claimCode }],
      };
      await transaction.getMany([orderKey, claimKey, markerKey, document.key]);
      await transaction.create(orderKey, {
        ...order,
        createdAt: commerceFieldValue.serverTimestamp(),
        processedAt: commerceFieldValue.serverTimestamp(),
      });
      await transaction.create(claimKey, {
        ...claim,
        createdAt: commerceFieldValue.serverTimestamp(),
        updatedAt: commerceFieldValue.serverTimestamp(),
      });
      await transaction.create(markerKey, {
        ...marker,
        createdAt: commerceFieldValue.serverTimestamp(),
      });
      await transaction.update(document.key, completeRequestValues(completed));
      return { status: 'created' as const, request: completed };
    });
    if (result.status === 'collision') continue;
    return completeResponse(runtime.dropId, request.requestId, result.request);
  }
  throw new AdminIrlRedeemFinalizeError('unavailable', 'Failed to allocate Admin IRL card receipt delivery id or claim code.');
}
