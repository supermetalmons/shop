import { PublicKey } from '@solana/web3.js';
import {
  getAdminIrlRedeemTargetEligibility,
  type AdminIrlRedeemTargetKind,
} from '../../../../shared/adminIrlEligibility.js';
import { isAdminIrlRedeemFinalizeOperationId } from '../../../../shared/contracts.js';
import {
  normalizeStripeReceiptClaimCode,
  requireStripeReceiptClaimCode,
} from '../../../../shared/stripeReceiptClaims.js';
import { getAdminIrlRedeemUnsupportedReason, type AdminIrlRedeemBoxBaseInput } from './adminIrlRedeem.js';
import {
  AdminIrlRedeemFinalizeError,
  WORKFLOW_EXECUTION_FIELD,
  canonicalPublicKey,
  canonicalSignature,
  parseWorkflowError,
  workflowPendingEffect,
  type AdminIrlRedeemFinalizeWorkflowError,
  type AdminIrlRedeemFinalizeWorkflowPendingEffect,
} from './adminIrlRedeemFinalizeWorkflowState.js';
import { type CommerceDocumentData } from './commerceRepository.js';
import { isRecord } from './dataAccess.js';
import { type ApiDropConfig } from './dropConfig.js';
import { buildRuntime as buildAdminIrlRedeemRuntime } from './adminIrlRedeemRuntime.js';
import { deriveDeliveryPda } from './deliveryReceiptOnchain.js';

export const MAX_ITEMS = 32;
export const MAX_DELIVERY_ALLOCATION_ATTEMPTS = 16;
export const WORKFLOW_DRAFT_FIELD = 'workflowPublicationDraftV1';

type Runtime = ReturnType<typeof buildAdminIrlRedeemRuntime>;
export type FinalizeRequest = { requestId: string; dropId: string; transferSignature: string };
export type RequestItem = {
  assetId: string;
  kind: 'box' | 'card_receipt';
  refId: number;
};

export type PendingFinalizeSubmission =
  | {
    kind: 'internal_delivery';
    signature: string;
    blockhash: string;
    deliveryId: number;
    deliveryPda: string;
  }
  | {
    kind: 'receipt_mint';
    signature: string;
    blockhash: string;
    assetIds: string[];
  };

export type AdminIrlRedeemFinalizeWorkflowOnchainV1 = {
  adminWallet: string;
  coreCollection: string;
  treasury: string;
};

export type AdminIrlRedeemFinalizeWorkflowExecutionV1 = {
  version: 1;
  operationId: string;
  owner: string;
  transferSignature: string;
  adminWallet: string;
  config: ApiDropConfig;
  pendingEffect?: AdminIrlRedeemFinalizeWorkflowPendingEffect;
  onchain?: AdminIrlRedeemFinalizeWorkflowOnchainV1;
  failure?: AdminIrlRedeemFinalizeWorkflowError;
};

type AdminIrlRedeemFinalizeWorkflowCardDraftV1 = {
  version: 1;
  targetKind: 'card_receipt';
  receiptOwner: string;
  card: { figureId: number; receiptAssetId: string };
};

type AdminIrlRedeemFinalizeWorkflowPreparedPackDraftV1 = {
  version: 1;
  targetKind: 'pack';
  mode: 'prepared';
  receiptOwner: string;
  internalDelivery: InternalDelivery;
  closeDeliveryTx: string | null;
  receiptTxs: string[];
  boxes: AdminIrlRedeemBoxBaseInput[];
};

type AdminIrlRedeemFinalizeWorkflowMarkerReuseDraftV1 = {
  version: 1;
  targetKind: 'pack';
  mode: 'marker_reuse';
  receiptOwner: string;
  deliveryId: number;
  sourceRequestId: string;
  fingerprint: string;
};

export type AdminIrlRedeemFinalizeWorkflowPublicationDraftV1 =
  | AdminIrlRedeemFinalizeWorkflowCardDraftV1
  | AdminIrlRedeemFinalizeWorkflowPreparedPackDraftV1
  | AdminIrlRedeemFinalizeWorkflowMarkerReuseDraftV1;

export type StartedRequest = {
  adminWallet: string;
  requestId: string;
  dropId: string;
  owner: string;
  targetKind: AdminIrlRedeemTargetKind;
  itemIds: string[];
  items: RequestItem[];
  receiptTxs: string[];
  internalDeliveryId?: number;
  internalDeliveryPda?: string;
  internalDeliveryTx?: string;
  closeDeliveryTx?: string;
  pendingFinalizeSubmission?: PendingFinalizeSubmission;
  workflowFinalizeV1?: AdminIrlRedeemFinalizeWorkflowExecutionV1;
  workflowPublicationDraftV1?: AdminIrlRedeemFinalizeWorkflowPublicationDraftV1;
};

export type InternalDelivery = {
  deliveryId: number;
  deliveryPda: string;
  deliveryTx: string | null;
};

export type AdminIrlRedeemFinalizeResponse = {
  processed: true;
  dropId: string;
  requestId: string;
  deliveryId?: number;
  receiptTxs: string[];
  claimCodes: string[];
  boxes: Array<{ boxId: number; receiptAssetId?: string; claimCode?: string; dudeIds?: number[] }>;
  cards: Array<{ figureId: number; receiptAssetId: string; claimCode?: string }>;
};

export function normalizeReceiptTxs(value: unknown): string[] {
  return Array.isArray(value)
    ? Array.from(new Set(value.filter((entry): entry is string => typeof entry === 'string' && Boolean(entry.trim())).map((entry) => entry.trim())))
    : [];
}

export function normalizePendingFinalizeSubmission(value: unknown): PendingFinalizeSubmission | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) {
    throw new AdminIrlRedeemFinalizeError('failed-precondition', 'Stored Admin IRL redeem submission recovery is invalid.');
  }
  const signature = canonicalSignature(value.signature);
  const blockhash = canonicalPublicKey(value.blockhash);
  if (!signature || !blockhash) {
    throw new AdminIrlRedeemFinalizeError('failed-precondition', 'Stored Admin IRL redeem submission recovery is invalid.');
  }
  if (value.kind === 'internal_delivery') {
    const deliveryId = Math.floor(Number(value.deliveryId));
    const deliveryPda = canonicalPublicKey(value.deliveryPda);
    if (!Number.isSafeInteger(deliveryId) || deliveryId < 1 || !deliveryPda) {
      throw new AdminIrlRedeemFinalizeError('failed-precondition', 'Stored Admin IRL redeem submission recovery is invalid.');
    }
    return { kind: value.kind, signature, blockhash, deliveryId, deliveryPda };
  }
  if (value.kind === 'receipt_mint' && Array.isArray(value.assetIds)) {
    const assetIds = value.assetIds.map(canonicalPublicKey);
    if (!assetIds.length || assetIds.length > 3 || assetIds.some((assetId) => !assetId) || new Set(assetIds).size !== assetIds.length) {
      throw new AdminIrlRedeemFinalizeError('failed-precondition', 'Stored Admin IRL redeem submission recovery is invalid.');
    }
    return { kind: value.kind, signature, blockhash, assetIds: assetIds as string[] };
  }
  throw new AdminIrlRedeemFinalizeError('failed-precondition', 'Stored Admin IRL redeem submission recovery is invalid.');
}

export function samePendingFinalizeSubmission(left: PendingFinalizeSubmission, right: PendingFinalizeSubmission): boolean {
  if (left.kind !== right.kind || left.signature !== right.signature || left.blockhash !== right.blockhash) return false;
  if (left.kind === 'internal_delivery' && right.kind === 'internal_delivery') {
    return left.deliveryId === right.deliveryId && left.deliveryPda === right.deliveryPda;
  }
  return left.kind === 'receipt_mint' && right.kind === 'receipt_mint' &&
    left.assetIds.length === right.assetIds.length && left.assetIds.every((assetId, index) => assetId === right.assetIds[index]);
}

function workflowConfig(value: unknown, dropId: string): ApiDropConfig {
  if (!isRecord(value) || value.dropId !== dropId) {
    throw new AdminIrlRedeemFinalizeError('failed-precondition', 'Stored Admin IRL redeem Workflow configuration is invalid.');
  }
  const config = JSON.parse(JSON.stringify(value)) as ApiDropConfig;
  try {
    const runtime = buildAdminIrlRedeemRuntime(config);
    const unsupported = getAdminIrlRedeemUnsupportedReason({
      dropFamily: runtime.config.dropFamily,
      itemsPerBox: runtime.itemsPerBox,
      sharesCollectionMint: false,
    });
    if (unsupported) throw new Error(unsupported);
  } catch {
    throw new AdminIrlRedeemFinalizeError('failed-precondition', 'Stored Admin IRL redeem Workflow configuration is invalid.');
  }
  return config;
}

function normalizeWorkflowOnchain(value: unknown): AdminIrlRedeemFinalizeWorkflowOnchainV1 | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value) || Object.keys(value).length !== 3) {
    throw new AdminIrlRedeemFinalizeError('failed-precondition', 'Stored Admin IRL redeem Workflow on-chain configuration is invalid.');
  }
  const adminWallet = canonicalPublicKey(value.adminWallet);
  const coreCollection = canonicalPublicKey(value.coreCollection);
  const treasury = canonicalPublicKey(value.treasury);
  if (!adminWallet || !coreCollection || !treasury) {
    throw new AdminIrlRedeemFinalizeError('failed-precondition', 'Stored Admin IRL redeem Workflow on-chain configuration is invalid.');
  }
  return { adminWallet, coreCollection, treasury };
}

export function normalizeWorkflowExecution(
  value: unknown,
  body: FinalizeRequest,
): AdminIrlRedeemFinalizeWorkflowExecutionV1 {
  if (!isRecord(value) || value.version !== 1) {
    throw new AdminIrlRedeemFinalizeError('failed-precondition', 'Stored Admin IRL redeem Workflow execution is invalid.');
  }
  const operationId = typeof value.operationId === 'string' ? value.operationId : '';
  const owner = canonicalPublicKey(value.owner);
  const transferSignature = canonicalSignature(value.transferSignature);
  const adminWallet = canonicalPublicKey(value.adminWallet);
  if (
    !isAdminIrlRedeemFinalizeOperationId(operationId) ||
    !owner || !transferSignature || transferSignature !== body.transferSignature || !adminWallet
  ) {
    throw new AdminIrlRedeemFinalizeError('failed-precondition', 'Stored Admin IRL redeem Workflow execution is invalid.');
  }
  const onchain = normalizeWorkflowOnchain(value.onchain);
  const failure = value.failure === undefined ? undefined : parseWorkflowError(value.failure);
  const pending = workflowPendingEffect(value);
  if (
    (value.failure !== undefined && !failure) ||
    !pending.valid
  ) {
    throw new AdminIrlRedeemFinalizeError('failed-precondition', 'Stored Admin IRL redeem Workflow execution is invalid.');
  }
  return {
    version: 1,
    operationId,
    owner,
    transferSignature,
    adminWallet,
    config: workflowConfig(value.config, body.dropId),
    ...(pending.valid && pending.effect ? { pendingEffect: pending.effect } : {}),
    ...(onchain ? { onchain } : {}),
    ...(failure ? { failure } : {}),
  };
}

export function normalizeWorkflowDraft(
  value: unknown,
): AdminIrlRedeemFinalizeWorkflowPublicationDraftV1 | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value) || value.version !== 1) {
    throw new AdminIrlRedeemFinalizeError('failed-precondition', 'Stored Admin IRL redeem publication draft is invalid.');
  }
  const receiptOwner = canonicalPublicKey(value.receiptOwner);
  if (!receiptOwner) {
    throw new AdminIrlRedeemFinalizeError('failed-precondition', 'Stored Admin IRL redeem publication draft is invalid.');
  }
  const exactKeys = (record: Record<string, unknown>, keys: readonly string[]) =>
    Object.keys(record).length === keys.length && keys.every((key) => Object.hasOwn(record, key));
  if (
    value.targetKind === 'card_receipt' && isRecord(value.card) &&
    exactKeys(value, ['version', 'targetKind', 'receiptOwner', 'card']) &&
    exactKeys(value.card, ['figureId', 'receiptAssetId'])
  ) {
    const figureId = value.card.figureId;
    const receiptAssetId = canonicalPublicKey(value.card.receiptAssetId);
    if (typeof figureId !== 'number' || !Number.isSafeInteger(figureId) || figureId < 1 || !receiptAssetId) {
      throw new AdminIrlRedeemFinalizeError('failed-precondition', 'Stored Admin IRL redeem publication draft is invalid.');
    }
    return { version: 1, targetKind: value.targetKind, receiptOwner, card: { figureId, receiptAssetId } };
  }
  if (
    value.targetKind === 'pack' && value.mode === 'marker_reuse' &&
    exactKeys(value, [
      'version', 'targetKind', 'mode', 'receiptOwner',
      'deliveryId', 'sourceRequestId', 'fingerprint',
    ]) &&
    typeof value.deliveryId === 'number' && Number.isSafeInteger(value.deliveryId) && value.deliveryId > 0 &&
    typeof value.sourceRequestId === 'string' && /^[A-Za-z0-9_-]{8,128}$/.test(value.sourceRequestId) &&
    typeof value.fingerprint === 'string' && /^[a-f0-9]{64}$/.test(value.fingerprint)
  ) {
    return {
      version: 1,
      targetKind: value.targetKind,
      mode: value.mode,
      receiptOwner,
      deliveryId: value.deliveryId,
      sourceRequestId: value.sourceRequestId,
      fingerprint: value.fingerprint,
    };
  }
  if (
    value.targetKind === 'pack' && value.mode === 'prepared' &&
    isRecord(value.internalDelivery) && Array.isArray(value.boxes) &&
    exactKeys(value, [
      'version', 'targetKind', 'mode', 'receiptOwner', 'internalDelivery',
      'closeDeliveryTx', 'receiptTxs', 'boxes',
    ]) &&
    exactKeys(value.internalDelivery, ['deliveryId', 'deliveryPda', 'deliveryTx'])
  ) {
    const deliveryId = value.internalDelivery.deliveryId;
    const deliveryPda = canonicalPublicKey(value.internalDelivery.deliveryPda);
    const rawDeliveryTx = value.internalDelivery.deliveryTx;
    const deliveryTx = rawDeliveryTx === null ? null : canonicalSignature(rawDeliveryTx);
    const closeDeliveryTx = value.closeDeliveryTx === null ? null : canonicalSignature(value.closeDeliveryTx);
    const receiptTxs = Array.isArray(value.receiptTxs)
      ? value.receiptTxs.map(canonicalSignature)
      : null;
    const boxes = value.boxes.map((entry): AdminIrlRedeemBoxBaseInput | null => {
      if (!isRecord(entry)) return null;
      const boxId = entry.boxId;
      const originalAssetId = canonicalPublicKey(entry.originalAssetId);
      const receiptAssetId = canonicalPublicKey(entry.receiptAssetId);
      const rawDudeIds = Array.isArray(entry.dudeIds) ? entry.dudeIds : [];
      const dudeIds = rawDudeIds;
      return exactKeys(entry, ['boxId', 'originalAssetId', 'receiptAssetId', 'dudeIds']) &&
        typeof boxId === 'number' && Number.isSafeInteger(boxId) && boxId > 0 && originalAssetId && receiptAssetId && dudeIds.length &&
        dudeIds.every((id): id is number => typeof id === 'number' && Number.isSafeInteger(id) && id > 0)
        ? { boxId, originalAssetId, receiptAssetId, dudeIds }
        : null;
    });
    if (
      typeof deliveryId !== 'number' || !Number.isSafeInteger(deliveryId) || deliveryId < 1 || !deliveryPda ||
      (rawDeliveryTx !== null && !deliveryTx) ||
      (value.closeDeliveryTx !== null && !closeDeliveryTx) ||
      !receiptTxs || receiptTxs.some((signature) => !signature) ||
      new Set(receiptTxs).size !== receiptTxs.length ||
      !boxes.length || boxes.length > MAX_ITEMS || boxes.some((box) => !box)
    ) {
      throw new AdminIrlRedeemFinalizeError('failed-precondition', 'Stored Admin IRL redeem publication draft is invalid.');
    }
    return {
      version: 1,
      targetKind: value.targetKind,
      mode: value.mode,
      receiptOwner,
      internalDelivery: { deliveryId, deliveryPda, deliveryTx: deliveryTx || null },
      closeDeliveryTx: closeDeliveryTx || null,
      receiptTxs: receiptTxs as string[],
      boxes: boxes as AdminIrlRedeemBoxBaseInput[],
    };
  }
  throw new AdminIrlRedeemFinalizeError('failed-precondition', 'Stored Admin IRL redeem publication draft is invalid.');
}

export function normalizeItems(request: Record<string, unknown>): {
  itemIds: string[];
  items: RequestItem[];
  targetKind: AdminIrlRedeemTargetKind;
} {
  const rawItems = Array.isArray(request.items) ? request.items : [];
  const items = rawItems.map((value): RequestItem | null => {
    if (!isRecord(value)) return null;
    const rawAssetId = typeof value.assetId === 'string' ? value.assetId.trim() : '';
    const assetId = canonicalPublicKey(rawAssetId);
    const refId = Math.floor(Number(value.refId));
    if (
      !assetId || assetId !== rawAssetId ||
      !Number.isSafeInteger(refId) || refId < 1 || refId > 0xffff_ffff
    ) return null;
    if (value.kind === 'box' || value.kind === 'card_receipt') return { assetId, kind: value.kind, refId };
    return null;
  }).filter((value): value is RequestItem => value !== null);
  if (!items.length || items.length !== rawItems.length || items.length > MAX_ITEMS) {
    throw new AdminIrlRedeemFinalizeError('failed-precondition', 'Admin IRL redeem request is missing selected items.');
  }
  if (new Set(items.map((item) => item.assetId)).size !== items.length || new Set(items.map((item) => item.refId)).size !== items.length) {
    throw new AdminIrlRedeemFinalizeError('failed-precondition', 'Admin IRL redeem request contains duplicate selected items.');
  }
  const targetKinds = new Set(items.map((item) => item.kind === 'box' ? 'pack' : 'card_receipt'));
  if (targetKinds.size !== 1) {
    throw new AdminIrlRedeemFinalizeError('failed-precondition', 'Admin IRL redeem request cannot mix packs and card receipts.');
  }
  const targetKind = Array.from(targetKinds)[0] as AdminIrlRedeemTargetKind;
  if ((request.targetKind === 'card_receipt' ? 'card_receipt' : 'pack') !== targetKind) {
    throw new AdminIrlRedeemFinalizeError('failed-precondition', 'Admin IRL redeem request target kind mismatch.');
  }
  const eligibility = getAdminIrlRedeemTargetEligibility({ targetKind, itemCount: items.length });
  if (!eligibility.eligible) {
    throw new AdminIrlRedeemFinalizeError('failed-precondition', 'Admin IRL redeem supports one card receipt at a time.');
  }
  const itemIds = items.map((item) => item.assetId);
  const storedItemIds = Array.isArray(request.itemIds)
    ? request.itemIds.filter((value): value is string => typeof value === 'string').map((value) => value.trim())
    : [];
  if (storedItemIds.length !== itemIds.length || storedItemIds.some((value, index) => value !== itemIds[index])) {
    throw new AdminIrlRedeemFinalizeError('failed-precondition', 'Admin IRL redeem request selected item mismatch.');
  }
  return { itemIds, items, targetKind };
}

export function completeResponse(dropId: string, requestId: string, request: Record<string, unknown>): AdminIrlRedeemFinalizeResponse {
  const boxes = Array.isArray(request.boxes) ? request.boxes.flatMap((value) => {
    if (!isRecord(value)) return [];
    const boxId = Math.floor(Number(value.boxId));
    if (!Number.isSafeInteger(boxId) || boxId < 1) return [];
    const receiptAssetId = typeof value.receiptAssetId === 'string' ? value.receiptAssetId.trim() : '';
    const claimCode = typeof value.claimCode === 'string' ? normalizeStripeReceiptClaimCode(value.claimCode) : '';
    const dudeIds = Array.isArray(value.dudeIds)
      ? value.dudeIds.map(Number).filter((id) => Number.isSafeInteger(id) && id > 0)
      : [];
    return [{ boxId, ...(receiptAssetId ? { receiptAssetId } : {}), ...(claimCode ? { claimCode } : {}), ...(dudeIds.length ? { dudeIds } : {}) }];
  }) : [];
  const cards = Array.isArray(request.cards) ? request.cards.flatMap((value) => {
    if (!isRecord(value)) return [];
    const figureId = Math.floor(Number(value.figureId));
    const receiptAssetId = typeof value.receiptAssetId === 'string' ? value.receiptAssetId.trim() : '';
    if (!Number.isSafeInteger(figureId) || figureId < 1 || !receiptAssetId) return [];
    const claimCode = typeof value.claimCode === 'string' ? normalizeStripeReceiptClaimCode(value.claimCode) : '';
    return [{ figureId, receiptAssetId, ...(claimCode ? { claimCode } : {}) }];
  }) : [];
  const deliveryId = Math.floor(Number(request.deliveryId));
  return {
    processed: true,
    dropId,
    requestId,
    ...(Number.isSafeInteger(deliveryId) && deliveryId > 0 ? { deliveryId } : {}),
    receiptTxs: normalizeReceiptTxs(request.receiptTxs),
    claimCodes: Array.isArray(request.claimCodes)
      ? request.claimCodes.map(normalizeStripeReceiptClaimCode).filter(Boolean)
      : [],
    boxes,
    cards,
  };
}

export function validateWorkflowCompletion(
  response: AdminIrlRedeemFinalizeResponse,
  request: Record<string, unknown>,
): AdminIrlRedeemFinalizeResponse {
  let normalizedItems: ReturnType<typeof normalizeItems>;
  let runtime: Runtime;
  try {
    normalizedItems = normalizeItems(request);
    const execution = request[WORKFLOW_EXECUTION_FIELD];
    if (!isRecord(execution)) throw new Error('missing Workflow execution');
    runtime = buildAdminIrlRedeemRuntime(workflowConfig(execution.config, response.dropId));
  } catch {
    throw new AdminIrlRedeemFinalizeError('internal', 'Stored Admin IRL redeem Workflow result is invalid.');
  }
  const rawReceiptTxs = Array.isArray(request.receiptTxs) ? request.receiptTxs : [];
  const rawClaimCodes = Array.isArray(request.claimCodes) ? request.claimCodes : [];
  const rawBoxes = Array.isArray(request.boxes) ? request.boxes : [];
  const rawCards = Array.isArray(request.cards) ? request.cards : [];
  const nestedClaimCodes = [
    ...response.boxes.map((box) => box.claimCode),
    ...response.cards.map((card) => card.claimCode),
  ];
  const receiptAssetIds = [
    ...response.boxes.map((box) => box.receiptAssetId),
    ...response.cards.map((card) => card.receiptAssetId),
  ];
  const allDudeIds = response.boxes.flatMap((box) => box.dudeIds || []);
  const validClaimCodes = response.claimCodes.every((code) => {
    try { return requireStripeReceiptClaimCode(code) === code; } catch { return false; }
  });
  const rawReceiptTxsValid = rawReceiptTxs.every((signature) =>
    typeof signature === 'string' && canonicalSignature(signature) === signature);
  const rawClaimCodesValid = rawClaimCodes.every((code) => {
    if (typeof code !== 'string') return false;
    try { return requireStripeReceiptClaimCode(code) === code; } catch { return false; }
  });
  const rawBoxesValid = rawBoxes.every((value, index) => {
    if (!isRecord(value) || Object.keys(value).length !== 5 || !Array.isArray(value.dudeIds)) return false;
    const item = normalizedItems.items[index];
    const dudeIds = value.dudeIds;
    return item?.kind === 'box' &&
      typeof value.boxId === 'number' && value.boxId === item.refId &&
      value.originalAssetId === item.assetId &&
      typeof value.receiptAssetId === 'string' && canonicalPublicKey(value.receiptAssetId) === value.receiptAssetId &&
      typeof value.claimCode === 'string' && normalizeStripeReceiptClaimCode(value.claimCode) === value.claimCode &&
      dudeIds.length === runtime.itemsPerBox &&
      dudeIds.every((id) => typeof id === 'number' && Number.isSafeInteger(id) && id > 0 && id <= runtime.maxDudeId) &&
      new Set(dudeIds).size === dudeIds.length;
  });
  const rawCardsValid = rawCards.every((value, index) => {
    if (!isRecord(value) || Object.keys(value).length !== 3) return false;
    const item = normalizedItems.items[index];
    return item?.kind === 'card_receipt' &&
      typeof value.figureId === 'number' && value.figureId === item.refId &&
      value.receiptAssetId === item.assetId &&
      typeof value.claimCode === 'string' && normalizeStripeReceiptClaimCode(value.claimCode) === value.claimCode;
  });
  if (
    response.deliveryId === undefined ||
    rawReceiptTxs.length !== response.receiptTxs.length ||
    rawClaimCodes.length !== response.claimCodes.length ||
    rawBoxes.length !== response.boxes.length ||
    rawCards.length !== response.cards.length ||
    (response.boxes.length === 0) === (response.cards.length === 0) ||
    response.cards.length > 1 ||
    !rawReceiptTxsValid || !rawClaimCodesValid || !rawBoxesValid || !rawCardsValid ||
    response.receiptTxs.some((signature) => canonicalSignature(signature) !== signature) ||
    new Set(response.receiptTxs).size !== response.receiptTxs.length ||
    !validClaimCodes || new Set(response.claimCodes).size !== response.claimCodes.length ||
    nestedClaimCodes.length !== response.claimCodes.length ||
    nestedClaimCodes.some((code) => typeof code !== 'string') ||
    nestedClaimCodes.some((code, index) => code !== response.claimCodes[index]) ||
    receiptAssetIds.some((assetId) => typeof assetId !== 'string' || canonicalPublicKey(assetId) !== assetId) ||
    new Set(receiptAssetIds).size !== receiptAssetIds.length ||
    new Set(response.boxes.map((box) => box.boxId)).size !== response.boxes.length ||
    new Set(response.cards.map((card) => card.figureId)).size !== response.cards.length ||
    new Set(allDudeIds).size !== allDudeIds.length ||
    (normalizedItems.targetKind === 'pack'
      ? response.boxes.length !== normalizedItems.items.length || response.cards.length !== 0 ||
        response.boxes.some((box, index) => box.boxId !== normalizedItems.items[index]?.refId)
      : response.cards.length !== 1 || response.boxes.length !== 0 ||
        response.cards[0]?.figureId !== normalizedItems.items[0]?.refId)
  ) {
    throw new AdminIrlRedeemFinalizeError('internal', 'Stored Admin IRL redeem Workflow result is invalid.');
  }
  return response;
}

export function finalizeRequestOwner(request: Record<string, unknown>, wallet: string): string {
  let owner: string;
  try {
    owner = new PublicKey(String(request.owner || '')).toBase58();
  } catch {
    throw new AdminIrlRedeemFinalizeError('failed-precondition', 'Admin IRL redeem request owner is invalid.');
  }
  if (owner !== wallet) {
    throw new AdminIrlRedeemFinalizeError('permission-denied', 'Only the requesting admin wallet can finalize this Admin IRL redeem.');
  }
  return owner;
}

export function startedFinalizeRequest(
  body: FinalizeRequest,
  request: Record<string, unknown>,
  owner: string,
): StartedRequest {
  const normalized = normalizeItems(request);
  const adminWallet = canonicalPublicKey(request.adminWallet);
  if (!adminWallet) {
    throw new AdminIrlRedeemFinalizeError('failed-precondition', 'Admin IRL redeem request admin wallet is invalid.');
  }
  const pendingFinalizeSubmission = normalizePendingFinalizeSubmission(request.pendingFinalizeSubmission);
  const workflowFinalizeV1 = request[WORKFLOW_EXECUTION_FIELD] === undefined
    ? undefined
    : normalizeWorkflowExecution(request[WORKFLOW_EXECUTION_FIELD], body);
  const workflowPublicationDraftV1 = normalizeWorkflowDraft(request[WORKFLOW_DRAFT_FIELD]);
  const internalDeliveryId = Math.floor(Number(request.internalDeliveryId));
  return {
    adminWallet,
    requestId: body.requestId,
    dropId: body.dropId,
    owner,
    targetKind: normalized.targetKind,
    itemIds: normalized.itemIds,
    items: normalized.items,
    receiptTxs: normalizeReceiptTxs(request.receiptTxs),
    ...(Number.isSafeInteger(internalDeliveryId) && internalDeliveryId > 0 ? { internalDeliveryId } : {}),
    ...(typeof request.internalDeliveryPda === 'string' && request.internalDeliveryPda ? { internalDeliveryPda: request.internalDeliveryPda } : {}),
    ...(typeof request.internalDeliveryTx === 'string' && request.internalDeliveryTx ? { internalDeliveryTx: request.internalDeliveryTx } : {}),
    ...(typeof request.closeDeliveryTx === 'string' && request.closeDeliveryTx ? { closeDeliveryTx: request.closeDeliveryTx } : {}),
    ...(pendingFinalizeSubmission ? { pendingFinalizeSubmission } : {}),
    ...(workflowFinalizeV1 ? { workflowFinalizeV1 } : {}),
    ...(workflowPublicationDraftV1 ? { workflowPublicationDraftV1 } : {}),
  };
}

export function workflowExecutionForReplay(
  value: unknown,
  body: FinalizeRequest,
  requested: AdminIrlRedeemFinalizeWorkflowExecutionV1,
  allowTerminalFailure: boolean,
): AdminIrlRedeemFinalizeWorkflowExecutionV1 {
  if (value === undefined) return requested;
  const existing = normalizeWorkflowExecution(value, body);
  if (
    existing.operationId !== requested.operationId ||
    existing.owner !== requested.owner ||
    existing.transferSignature !== requested.transferSignature ||
    existing.adminWallet !== requested.adminWallet
  ) {
    throw new AdminIrlRedeemFinalizeError('failed-precondition', 'Stored Admin IRL redeem Workflow execution changed.');
  }
  if (existing.failure && !existing.failure.retryable && !allowTerminalFailure) {
    throw new AdminIrlRedeemFinalizeError(existing.failure.code, existing.failure.message);
  }
  return {
    version: 1,
    operationId: existing.operationId,
    owner: existing.owner,
    transferSignature: existing.transferSignature,
    adminWallet: existing.adminWallet,
    config: existing.config,
    ...(existing.pendingEffect ? { pendingEffect: existing.pendingEffect } : {}),
    ...(existing.onchain ? { onchain: existing.onchain } : {}),
    ...(existing.failure ? { failure: existing.failure } : {}),
  };
}

export function workflowExecutionData(execution: AdminIrlRedeemFinalizeWorkflowExecutionV1): CommerceDocumentData {
  const { paymentRouting, ...config } = execution.config;
  return {
    ...execution,
    config: paymentRouting ? {
      ...execution.config,
      paymentRouting: {
        ...paymentRouting,
        mintProceeds: [...paymentRouting.mintProceeds],
      },
    } : config,
  };
}

export function validateWorkflowDraftForRequest(
  draft: AdminIrlRedeemFinalizeWorkflowPublicationDraftV1,
  request: StartedRequest,
  runtime: Runtime,
): void {
  if (draft.receiptOwner !== request.adminWallet || draft.targetKind !== request.targetKind) {
    throw new AdminIrlRedeemFinalizeError('failed-precondition', 'Stored Admin IRL redeem publication draft does not match the request.');
  }
  if (draft.targetKind === 'card_receipt') {
    const item = request.items[0];
    if (
      request.items.length !== 1 || !item || item.kind !== 'card_receipt' ||
      draft.card.figureId !== item.refId || draft.card.receiptAssetId !== item.assetId
    ) {
      throw new AdminIrlRedeemFinalizeError('failed-precondition', 'Stored Admin IRL redeem publication draft does not match the request.');
    }
    return;
  }
  if (draft.mode === 'marker_reuse') return;
  const [expectedDeliveryPda] = deriveDeliveryPda(runtime, draft.internalDelivery.deliveryId);
  if (
    expectedDeliveryPda.toBase58() !== draft.internalDelivery.deliveryPda ||
    request.internalDeliveryId !== draft.internalDelivery.deliveryId ||
    request.internalDeliveryPda !== draft.internalDelivery.deliveryPda ||
    (request.internalDeliveryTx || null) !== draft.internalDelivery.deliveryTx ||
    (request.closeDeliveryTx || null) !== draft.closeDeliveryTx ||
    request.receiptTxs.length !== draft.receiptTxs.length ||
    request.receiptTxs.some((signature, index) => signature !== draft.receiptTxs[index]) ||
    draft.boxes.length !== request.items.length ||
    new Set(draft.boxes.map((box) => box.receiptAssetId)).size !== draft.boxes.length ||
    new Set(draft.boxes.flatMap((box) => box.dudeIds)).size !== draft.boxes.reduce((sum, box) => sum + box.dudeIds.length, 0) ||
    draft.boxes.some((box, index) => {
      const item = request.items[index];
      return !item || item.kind !== 'box' || box.boxId !== item.refId ||
        box.originalAssetId !== item.assetId || box.dudeIds.length !== runtime.itemsPerBox ||
        box.dudeIds.some((dudeId) => dudeId > runtime.maxDudeId);
    })
  ) {
    throw new AdminIrlRedeemFinalizeError('failed-precondition', 'Stored Admin IRL redeem publication draft does not match the request.');
  }
}
