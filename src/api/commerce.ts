import type {
  AdminIrlRedeemFinalizeResult,
  AdminIrlRedeemPreparedTxResponse,
  DeliverySelection,
  IssueReceiptsResult,
  PrepareDeliveryRequest,
  PrepareDeliveryResponse,
  PrepareIrlClaimRequest,
  PrepareIrlClaimResponse,
  PrepareReceiptTransferRequest,
  PrepareReceiptTransferResponse,
  PreparedTxResponse,
  RecoverDeliveryOrdersArgs,
  RecoverDeliveryOrdersResult,
  RevealDudesResponse,
  RevealDudesSubmissionUnknownDetails,
  StripeCheckoutSessionRequest,
  StripeCheckoutSessionResponse,
  StripeReceiptClaimResult,
} from '../types';
import {
  FRONTEND_DROPS,
  normalizeDropId,
} from '../config/deployment';
import { isStripeReceiptClaimCode } from '../../shared/stripeReceiptClaims.ts';
import {
  isBase58Bytes,
  isNonZeroBase58Bytes,
} from '../../shared/solanaRpcProxy.ts';
import {
  callProfileApi as defaultCallProfileApi,
  ProfileApiError,
  type AuthenticatedApiCall,
} from './transport';
import {
  hasExactKeys,
  hasExactRequiredAndOptionalKeys,
  isRecord,
} from './validation';

export function parseRevealDudesResponse(
  value: unknown,
  dropId: string,
): RevealDudesResponse | null {
  const drop = FRONTEND_DROPS[dropId];
  if (
    !drop ||
    !isRecord(value) ||
    !hasExactKeys(value, ['signature', 'dudeIds']) ||
    typeof value.signature !== 'string' ||
    !isNonZeroBase58Bytes(value.signature, 64) ||
    !Array.isArray(value.dudeIds) ||
    value.dudeIds.length !== drop.itemsPerBox
  ) return null;
  const maxDudeId = drop.maxSupply * drop.itemsPerBox;
  const dudeIds: number[] = [];
  for (const id of value.dudeIds) {
    if (typeof id !== 'number' || !Number.isSafeInteger(id) || id < 1 || id > maxDudeId) return null;
    dudeIds.push(id);
  }
  if (new Set(dudeIds).size !== dudeIds.length) return null;
  return { signature: value.signature, dudeIds };
}

export function parseRevealDudesSubmissionUnknownDetails(
  value: unknown,
  dropId: string,
): RevealDudesSubmissionUnknownDetails | null {
  if (!isRecord(value)) return null;
  if (
    !hasExactKeys(value, ['kind', 'submission']) ||
    value.kind !== 'reveal-submission-unknown' ||
    !isRecord(value.submission) ||
    !hasExactKeys(value.submission, ['signature', 'recentBlockhash', 'dudeIds']) ||
    typeof value.submission.recentBlockhash !== 'string' ||
    !isNonZeroBase58Bytes(value.submission.recentBlockhash, 32)
  ) return null;
  const parsed = parseRevealDudesResponse({
    signature: value.submission.signature,
    dudeIds: value.submission.dudeIds,
  }, dropId);
  if (!parsed) return null;
  return {
    kind: 'reveal-submission-unknown',
    submission: {
      signature: parsed.signature,
      recentBlockhash: value.submission.recentBlockhash,
      dudeIds: parsed.dudeIds,
    },
  };
}

export function revealDudesSubmissionUnknownDetails(
  error: unknown,
  dropId: string,
): RevealDudesSubmissionUnknownDetails | null {
  if (!(error instanceof ProfileApiError)) return null;
  return parseRevealDudesSubmissionUnknownDetails(error.details, dropId);
}

function stripeCheckoutRequestQuantity(quantity: StripeCheckoutSessionRequest['quantity']): number | undefined {
  if (quantity === undefined) return undefined;
  if (!Number.isInteger(quantity) || quantity < 1) {
    throw new Error('Stripe checkout quantity must be a positive integer');
  }
  return quantity;
}

function stripeCheckoutSessionPayload(args: StripeCheckoutSessionRequest): StripeCheckoutSessionRequest {
  const payload: StripeCheckoutSessionRequest = {
    dropId: args.dropId,
  };
  if (typeof args.variantKey === 'string' && args.variantKey.trim()) {
    payload.variantKey = args.variantKey.trim();
  }
  const quantity = stripeCheckoutRequestQuantity(args.quantity);
  if (quantity !== undefined) {
    payload.quantity = quantity;
  }
  if (typeof args.returnUrl === 'string' && args.returnUrl.trim()) {
    payload.returnUrl = args.returnUrl.trim();
  }
  return payload;
}

export function parseStripeCheckoutSessionResponse(value: unknown): StripeCheckoutSessionResponse | null {
  if (!isRecord(value) || !hasExactKeys(value, ['id', 'url', 'livemode'])) return null;
  if (
    typeof value.id !== 'string' || !/^cs_(?:test|live)_[A-Za-z0-9_]+$/.test(value.id) ||
    typeof value.url !== 'string' || !value.url ||
    typeof value.livemode !== 'boolean'
  ) return null;
  let url: URL;
  try {
    url = new URL(value.url);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  return { id: value.id, url: value.url, livemode: value.livemode };
}

export function parseDeliveryPrepareResponse(response: unknown): PrepareDeliveryResponse | null {
  if (
    !isRecord(response) ||
    !hasExactKeys(response, ['encodedTx', 'blockhashContextSlot', 'deliveryLamports', 'deliveryId']) ||
    typeof response.encodedTx !== 'string' ||
    response.encodedTx.length === 0 ||
    response.encodedTx.length > 16 * 1024 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(response.encodedTx) ||
    !Number.isSafeInteger(response.blockhashContextSlot) ||
    Number(response.blockhashContextSlot) < 0 ||
    !Number.isSafeInteger(response.deliveryLamports) ||
    Number(response.deliveryLamports) < 0 ||
    !Number.isSafeInteger(response.deliveryId) ||
    Number(response.deliveryId) < 1 ||
    Number(response.deliveryId) >= 2 ** 31
  ) return null;
  return {
    encodedTx: response.encodedTx,
    blockhashContextSlot: Number(response.blockhashContextSlot),
    deliveryLamports: Number(response.deliveryLamports),
    deliveryId: Number(response.deliveryId),
  };
}

export function parseReceiptTransferPrepareResponse(response: unknown): PrepareReceiptTransferResponse | null {
  if (
    !isRecord(response) ||
    !hasExactKeys(response, ['encodedTx', 'dropId', 'certificateId']) ||
    typeof response.encodedTx !== 'string' ||
    response.encodedTx.length === 0 ||
    response.encodedTx.length > 16 * 1024 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(response.encodedTx) ||
    typeof response.dropId !== 'string' ||
    normalizeDropId(response.dropId) !== response.dropId ||
    !FRONTEND_DROPS[response.dropId] ||
    typeof response.certificateId !== 'string' ||
    !isBase58Bytes(response.certificateId, 32)
  ) {
    return null;
  }
  return {
    encodedTx: response.encodedTx,
    dropId: response.dropId,
    certificateId: response.certificateId,
  };
}

export function parseAdminIrlRedeemPrepareResponse(value: unknown): AdminIrlRedeemPreparedTxResponse | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['encodedTx', 'requestId', 'dropId', 'adminWallet', 'itemCount', 'targetKind']) ||
    typeof value.encodedTx !== 'string' ||
    value.encodedTx.length === 0 ||
    value.encodedTx.length > 16 * 1024 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(value.encodedTx) ||
    typeof value.requestId !== 'string' ||
    !/^[A-Za-z0-9]{20}$/.test(value.requestId) ||
    typeof value.dropId !== 'string' ||
    normalizeDropId(value.dropId) !== value.dropId ||
    !FRONTEND_DROPS[value.dropId] ||
    typeof value.adminWallet !== 'string' ||
    !isBase58Bytes(value.adminWallet, 32) ||
    !Number.isSafeInteger(value.itemCount) ||
    Number(value.itemCount) < 1 ||
    Number(value.itemCount) > 32 ||
    (value.targetKind !== 'pack' && value.targetKind !== 'card_receipt') ||
    (value.targetKind === 'card_receipt' && value.itemCount !== 1)
  ) return null;
  return {
    encodedTx: value.encodedTx,
    requestId: value.requestId,
    dropId: value.dropId,
    adminWallet: value.adminWallet,
    itemCount: Number(value.itemCount),
    targetKind: value.targetKind,
  };
}

export function parseIssueReceiptsResult(value: unknown): IssueReceiptsResult | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['processed', 'deliveryId', 'receiptsMinted', 'receiptTxs', 'closeDeliveryTx']) ||
    value.processed !== true ||
    !Number.isSafeInteger(value.deliveryId) ||
    Number(value.deliveryId) < 1 ||
    Number(value.deliveryId) > 0xffff_ffff ||
    !Number.isSafeInteger(value.receiptsMinted) ||
    Number(value.receiptsMinted) < 0 ||
    !Array.isArray(value.receiptTxs) ||
    !value.receiptTxs.every((signature) => typeof signature === 'string' && isNonZeroBase58Bytes(signature, 64)) ||
    (value.closeDeliveryTx !== null && (
      typeof value.closeDeliveryTx !== 'string' ||
      !isNonZeroBase58Bytes(value.closeDeliveryTx, 64)
    ))
  ) return null;
  return {
    processed: true,
    deliveryId: Number(value.deliveryId),
    receiptsMinted: Number(value.receiptsMinted),
    receiptTxs: value.receiptTxs as string[],
    closeDeliveryTx: value.closeDeliveryTx as string | null,
  };
}

const DELIVERY_RECOVERY_OUTCOMES = new Set([
  'recovered',
  'failed',
  'lease_active',
  'attempt_capped',
  'not_eligible',
  'missing_delivery',
  'not_found',
  'skipped_status',
]);

export function parseRecoverDeliveryOrdersResult(value: unknown): RecoverDeliveryOrdersResult | null {
  if (
    !isRecord(value) ||
    !hasExactRequiredAndOptionalKeys(
      value,
      ['attempted', 'recovered', 'remainingProcessing', 'walletRecovery', 'results'],
      ['nextCheckAt'],
    ) ||
    !Number.isSafeInteger(value.attempted) || Number(value.attempted) < 0 ||
    !Number.isSafeInteger(value.recovered) || Number(value.recovered) < 0 ||
    !Number.isSafeInteger(value.remainingProcessing) || Number(value.remainingProcessing) < 0 ||
    (value.nextCheckAt !== undefined && (!Number.isFinite(value.nextCheckAt) || Number(value.nextCheckAt) < 0)) ||
    !isRecord(value.walletRecovery) ||
    !hasExactKeys(value.walletRecovery, ['remainingProcessing', 'nextCheckAt']) ||
    !Number.isSafeInteger(value.walletRecovery.remainingProcessing) ||
    Number(value.walletRecovery.remainingProcessing) < 0 ||
    (value.walletRecovery.nextCheckAt !== null && (
      !Number.isFinite(value.walletRecovery.nextCheckAt) ||
      Number(value.walletRecovery.nextCheckAt) < 0
    )) ||
    !Array.isArray(value.results)
  ) return null;
  for (const result of value.results) {
    if (
      !isRecord(result) ||
      !hasExactRequiredAndOptionalKeys(
        result,
        ['dropId', 'deliveryId', 'statusBefore', 'outcome', 'verification'],
        ['message', 'errorCode'],
      ) ||
      typeof result.dropId !== 'string' || normalizeDropId(result.dropId) !== result.dropId ||
      !FRONTEND_DROPS[result.dropId] ||
      !Number.isSafeInteger(result.deliveryId) || Number(result.deliveryId) < 1 ||
      Number(result.deliveryId) > 0xffff_ffff ||
      typeof result.statusBefore !== 'string' || !result.statusBefore || result.statusBefore.length > 64 ||
      typeof result.outcome !== 'string' || !DELIVERY_RECOVERY_OUTCOMES.has(result.outcome) ||
      result.verification !== 'delivery_pda' ||
      (result.message !== undefined && (typeof result.message !== 'string' || result.message.length > 300)) ||
      (result.errorCode !== undefined && (typeof result.errorCode !== 'string' || result.errorCode.length > 64))
    ) return null;
  }
  if (
    value.remainingProcessing !== value.walletRecovery.remainingProcessing ||
    (value.nextCheckAt === undefined
      ? value.walletRecovery.nextCheckAt !== null
      : value.nextCheckAt !== value.walletRecovery.nextCheckAt)
  ) return null;
  return value as RecoverDeliveryOrdersResult;
}

export function parseAdminIrlRedeemFinalizeResult(value: unknown): AdminIrlRedeemFinalizeResult | null {
  if (
    !isRecord(value) ||
    !hasExactRequiredAndOptionalKeys(
      value,
      ['processed', 'dropId', 'requestId', 'receiptTxs', 'claimCodes', 'boxes', 'cards'],
      ['deliveryId'],
    ) ||
    value.processed !== true ||
    typeof value.dropId !== 'string' || normalizeDropId(value.dropId) !== value.dropId || !FRONTEND_DROPS[value.dropId] ||
    typeof value.requestId !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(value.requestId) ||
    (value.deliveryId !== undefined && (!Number.isSafeInteger(value.deliveryId) || Number(value.deliveryId) < 1)) ||
    !Array.isArray(value.receiptTxs) ||
    !value.receiptTxs.every((signature) => isNonZeroBase58Bytes(signature, 64)) ||
    new Set(value.receiptTxs).size !== value.receiptTxs.length ||
    !Array.isArray(value.claimCodes) ||
    !value.claimCodes.every(isStripeReceiptClaimCode) ||
    new Set(value.claimCodes).size !== value.claimCodes.length ||
    !Array.isArray(value.boxes) ||
    !Array.isArray(value.cards)
  ) return null;
  for (const box of value.boxes) {
    if (
      !isRecord(box) ||
      !hasExactRequiredAndOptionalKeys(box, ['boxId'], ['receiptAssetId', 'claimCode', 'dudeIds']) ||
      !Number.isSafeInteger(box.boxId) || Number(box.boxId) < 1 || Number(box.boxId) > 0xffff_ffff ||
      (box.receiptAssetId !== undefined && !isBase58Bytes(box.receiptAssetId, 32)) ||
      (box.claimCode !== undefined && !isStripeReceiptClaimCode(box.claimCode)) ||
      (box.dudeIds !== undefined && (
        !Array.isArray(box.dudeIds) ||
        !box.dudeIds.every((id) => Number.isSafeInteger(id) && Number(id) > 0 && Number(id) <= 0xffff) ||
        new Set(box.dudeIds).size !== box.dudeIds.length
      ))
    ) return null;
  }
  for (const card of value.cards) {
    if (
      !isRecord(card) ||
      !hasExactRequiredAndOptionalKeys(card, ['figureId', 'receiptAssetId'], ['claimCode']) ||
      !Number.isSafeInteger(card.figureId) || Number(card.figureId) < 1 || Number(card.figureId) > 0xffff_ffff ||
      !isBase58Bytes(card.receiptAssetId, 32) ||
      (card.claimCode !== undefined && !isStripeReceiptClaimCode(card.claimCode))
    ) return null;
  }
  return value as AdminIrlRedeemFinalizeResult;
}

export function parseIrlClaimPrepareResponse(response: unknown): PrepareIrlClaimResponse | null {
  if (
    !isRecord(response) ||
    !hasExactKeys(response, [
      'encodedTx',
      'blockhashContextSlot',
      'dropId',
      'certificates',
      'certificateId',
      'message',
    ]) ||
    typeof response.dropId !== 'string'
  ) {
    return null;
  }
  const drop = FRONTEND_DROPS[response.dropId];
  if (
    typeof response.encodedTx !== 'string' ||
    response.encodedTx.length === 0 ||
    response.encodedTx.length > 16 * 1024 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(response.encodedTx) ||
    !Number.isSafeInteger(response.blockhashContextSlot) ||
    Number(response.blockhashContextSlot) < 0 ||
    normalizeDropId(response.dropId) !== response.dropId ||
    !drop ||
    !Array.isArray(response.certificates) ||
    response.certificates.length === 0 ||
    response.certificates.length !== drop.itemsPerBox ||
    !response.certificates.every((id) =>
      Number.isSafeInteger(id) &&
      Number(id) > 0 &&
      Number(id) <= drop.maxSupply * drop.itemsPerBox
    ) ||
    new Set(response.certificates).size !== response.certificates.length ||
    typeof response.certificateId !== 'string' ||
    !isBase58Bytes(response.certificateId, 32) ||
    typeof response.message !== 'string' ||
    response.message.length === 0 ||
    response.message.length > 512
  ) {
    return null;
  }
  return {
    encodedTx: response.encodedTx,
    blockhashContextSlot: Number(response.blockhashContextSlot),
    dropId: response.dropId,
    certificates: response.certificates as number[],
    certificateId: response.certificateId,
    message: response.message,
  };
}

export function parseStripeReceiptClaimResponse(value: unknown): StripeReceiptClaimResult | null {
  if (!isRecord(value) || !hasExactRequiredAndOptionalKeys(
    value,
    ['processed', 'dropId', 'deliveryId', 'receiptsTransferred', 'receiptTxs'],
    ['receiptKind', 'figureIds', 'receiptAssetIds'],
  )) return null;
  if (
    value.processed !== true ||
    typeof value.dropId !== 'string' ||
    normalizeDropId(value.dropId) !== value.dropId ||
    !FRONTEND_DROPS[value.dropId] ||
    !Number.isSafeInteger(value.deliveryId) ||
    Number(value.deliveryId) < 1 ||
    !Number.isSafeInteger(value.receiptsTransferred) ||
    Number(value.receiptsTransferred) < 1 ||
    !Array.isArray(value.receiptTxs) ||
    !value.receiptTxs.every((signature) => typeof signature === 'string' && isBase58Bytes(signature, 64)) ||
    (value.receiptKind !== undefined && value.receiptKind !== 'box' && value.receiptKind !== 'figure') ||
    (value.figureIds !== undefined && (
      !Array.isArray(value.figureIds) ||
      !value.figureIds.every((figureId) => Number.isSafeInteger(figureId) && Number(figureId) > 0) ||
      new Set(value.figureIds).size !== value.figureIds.length
    )) ||
    (value.receiptAssetIds !== undefined && (
      !Array.isArray(value.receiptAssetIds) ||
      !value.receiptAssetIds.every((assetId) => typeof assetId === 'string' && isBase58Bytes(assetId, 32)) ||
      new Set(value.receiptAssetIds).size !== value.receiptAssetIds.length
    ))
  ) return null;
  return {
    processed: true,
    dropId: value.dropId,
    deliveryId: Number(value.deliveryId),
    receiptsTransferred: Number(value.receiptsTransferred),
    receiptTxs: value.receiptTxs as string[],
    ...(value.receiptKind ? { receiptKind: value.receiptKind as 'box' | 'figure' } : {}),
    ...(value.figureIds ? { figureIds: value.figureIds as number[] } : {}),
    ...(value.receiptAssetIds ? { receiptAssetIds: value.receiptAssetIds as string[] } : {}),
  };
}


export function createCommerceApiClient(
  callProfileApi: AuthenticatedApiCall = defaultCallProfileApi,
) {
  async function revealDudes(
    owner: string,
    boxAssetId: string,
    dropId: string,
  ): Promise<RevealDudesResponse> {
    const normalizedDropId = normalizeDropId(dropId);
    const response = await callProfileApi('/boxes/reveal', {
      owner,
      boxAssetId,
      dropId: normalizedDropId,
    });
    const parsed = parseRevealDudesResponse(response, normalizedDropId);
    if (!parsed) throw new Error('Invalid reveal response');
    return parsed;
  }
  async function createStripeCheckoutSession(
    args: StripeCheckoutSessionRequest,
  ): Promise<StripeCheckoutSessionResponse & { authSubject: string }> {
    const credential: { authSubject?: string } = {};
    const response = await callProfileApi('/checkout/session', stripeCheckoutSessionPayload(args), credential);
    const session = parseStripeCheckoutSessionResponse(response);
    if (!session || !credential.authSubject) throw new Error('Invalid Stripe checkout session response');
    return { ...session, authSubject: credential.authSubject };
  }
  async function requestDeliveryTx(
    owner: string,
    selection: DeliverySelection,
    dropId: string,
  ): Promise<PrepareDeliveryResponse> {
    const response = await callProfileApi<PrepareDeliveryRequest>('/delivery/prepare', {
      owner,
      dropId,
      itemIds: selection.itemIds,
      addressId: selection.addressId,
    });
    const parsed = parseDeliveryPrepareResponse(response);
    if (!parsed) throw new Error('Invalid delivery preparation response');
    return parsed;
  }

  async function prepareReceiptTransferTx(args: {
    owner: string;
    dropId: string;
    receiptAssetId: string;
    destination: string;
  }): Promise<PreparedTxResponse> {
    const response = await callProfileApi<PrepareReceiptTransferRequest>('/receipts/transfer/prepare', args);
    const parsed = parseReceiptTransferPrepareResponse(response);
    if (!parsed) throw new Error('Invalid receipt transfer transaction response');
    return parsed;
  }

  async function prepareAdminIrlRedeemTx(args: {
    owner: string;
    dropId: string;
    itemIds: string[];
  }): Promise<AdminIrlRedeemPreparedTxResponse> {
    const dropId = normalizeDropId(args.dropId);
    const response = await callProfileApi('/admin/irl-redeem/prepare', { ...args, dropId });
    const parsed = parseAdminIrlRedeemPrepareResponse(response);
    if (!parsed || parsed.dropId !== dropId || parsed.itemCount !== args.itemIds.length) {
      throw new Error('Invalid Admin IRL redeem preparation response');
    }
    return parsed;
  }

  async function finalizeAdminIrlRedeem(args: {
    requestId: string;
    dropId: string;
    transferSignature: string;
  }): Promise<AdminIrlRedeemFinalizeResult> {
    const response = await callProfileApi('/admin/irl-redeem/finalize', args);
    const parsed = parseAdminIrlRedeemFinalizeResult(response);
    if (!parsed) throw new Error('Invalid Admin IRL redeem finalization response');
    return parsed;
  }

  async function issueReceipts(
    owner: string,
    deliveryId: number,
    signature: string,
    dropId: string,
  ): Promise<IssueReceiptsResult> {
    const response = await callProfileApi('/delivery/receipts/issue', {
      owner,
      deliveryId,
      signature,
      dropId,
    });
    const parsed = parseIssueReceiptsResult(response);
    if (!parsed || parsed.deliveryId !== deliveryId) throw new Error('Invalid receipt issuance response');
    return parsed;
  }

  async function recoverMyDeliveryOrders(args?: RecoverDeliveryOrdersArgs): Promise<RecoverDeliveryOrdersResult> {
    const payload: RecoverDeliveryOrdersArgs = {};
    if (typeof args?.dropId === 'string' && args.dropId.trim()) {
      payload.dropId = args.dropId.trim().toLowerCase();
    }
    if (typeof args?.deliveryId === 'number' && Number.isFinite(args.deliveryId)) {
      payload.deliveryId = Math.floor(args.deliveryId);
    }
    if (args?.force === true) {
      payload.force = true;
    }
    const response = await callProfileApi('/delivery/receipts/recover', payload);
    const parsed = parseRecoverDeliveryOrdersResult(response);
    if (!parsed) throw new Error('Invalid delivery recovery response');
    return parsed;
  }

  async function requestClaimTx(
    owner: string,
    code: string,
  ): Promise<PrepareIrlClaimResponse> {
    const response = await callProfileApi<PrepareIrlClaimRequest>('/claims/irl/prepare', { owner, code });
    const parsed = parseIrlClaimPrepareResponse(response);
    if (!parsed) throw new Error('Invalid IRL claim transaction response');
    return parsed;
  }

  async function claimStripeReceipt(args: { code: string; recipient: string }): Promise<StripeReceiptClaimResult> {
    const response = await callProfileApi('/receipts/stripe/claim', {
      code: args.code,
      recipient: args.recipient,
    });
    const parsed = parseStripeReceiptClaimResponse(response);
    if (!parsed) throw new Error('Invalid Stripe receipt claim response');
    return parsed;
  }


  return {
    claimStripeReceipt,
    createStripeCheckoutSession,
    finalizeAdminIrlRedeem,
    issueReceipts,
    prepareAdminIrlRedeemTx,
    prepareReceiptTransferTx,
    recoverMyDeliveryOrders,
    requestClaimTx,
    requestDeliveryTx,
    revealDudes,
  };
}

const commerceApiClient = createCommerceApiClient();

export const {
  claimStripeReceipt,
  createStripeCheckoutSession,
  finalizeAdminIrlRedeem,
  issueReceipts,
  prepareAdminIrlRedeemTx,
  prepareReceiptTransferTx,
  recoverMyDeliveryOrders,
  requestClaimTx,
  requestDeliveryTx,
  revealDudes,
} = commerceApiClient;
