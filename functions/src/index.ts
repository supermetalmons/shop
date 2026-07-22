import { getApps, initializeApp } from 'firebase-admin/app';
import { FieldPath, FieldValue, Timestamp, getFirestore, type DocumentReference } from 'firebase-admin/firestore';
import { onDocumentUpdated, onDocumentWritten } from 'firebase-functions/v2/firestore';
import { onCall, onRequest, type CallableOptions, type CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { defineSecret } from 'firebase-functions/params';
import * as logger from 'firebase-functions/logger';
import {
  ComputeBudgetProgram,
  Connection,
  PublicKey,
  Keypair,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  AddressLookupTableAccount,
} from '@solana/web3.js';
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import type Stripe from 'stripe';
import type { Resend as ResendClient } from 'resend';
import { createHash, randomInt } from 'crypto';
import { existsSync, readFileSync } from 'fs';
import { z } from 'zod';
import { fileURLToPath } from 'url';
// IMPORTANT (Node ESM): include `.js` extension so the compiled `lib/` output resolves at runtime.
import { FUNCTIONS_DROPS, normalizeDropBase, type FunctionsDropConfig } from './config/deployment.js';
import {
  HELIUS_COLLECTION_GROUPING_OPTIONS,
  assetGroupingAllowsTreeVerifiedCollectionMatch,
  assetGroupingCollectionMints,
  uniqueAssetGroupingCollectionMint,
} from './dasAssetCollections.js';
import {
  dropAdminIrlRedeemPackMarkerPath,
  dropAdminIrlRedeemReceiptMarkerPath,
  dropAdminIrlRedeemRequestPath,
  dropAdminIrlRedeemRequestsCollectionPath,
  dropDeliveryOrderPath,
  dropDeliveryOrdersCollectionPath,
  dropDudePoolPath,
  dropRootPath,
} from './dropPaths.js';
import {
  countDeliveryOrderDudeItems,
  countDeliveryOrderBoxItems,
  countNormalIrlPackStatus,
  countOnlineRevealPackStatus,
} from './packStatus.js';
import {
  assignDudesForBox,
  ensureIrlClaimCodeForBox as ensureIrlClaimCodeForBoxShared,
  stripeAssignedIrlClaimForBox,
  type StripeAssignedIrlClaim,
} from './cardAssignment.js';
import { decodePendingOpenBox } from './pendingOpenBox.js';
import { encodeFinalizeOpenBoxArgs } from './finalizeOpenBoxArgs.js';
import { normalizeCountryCode } from './normalizers.js';
import {
  ADMIN_IRL_REDEEM_DELIVERY_ORDER_SOURCE,
  STRIPE_CHECKOUT_STATUS,
  STRIPE_RECEIPT_CLAIM_CODE_NAMESPACE,
  collectStripeReceiptClaimsByBoxId,
  generateUniqueStripeReceiptClaimCodes,
  hasPluralStripeReceiptClaims,
  isReceiptClaimDeliveryOrderSource,
  isStripeOffchainFulfillmentSession,
  normalizeStripeCheckoutQuantity,
  normalizeStripeReceiptClaimCode,
  orderStripeReceiptClaimByBoxId,
  requireStripeReceiptClaimCode,
  resolveMintSelectionVariantIndex,
  shouldProcessStripeCheckoutFulfillmentWrite,
  stripeReceiptClaimCodeMaybe,
  stripeReceiptClaimBoxMapKey,
  stripeReceiptClaimSummary,
  stripeCheckoutOwnerId,
} from './stripeCheckout/contract.js';
import {
  ADMIN_IRL_REDEEM_ADDRESS_SNAPSHOT,
  ADMIN_IRL_REDEEM_CARD_MARKER_VERSION,
  buildAdminIrlRedeemCardClaimCodeDocument,
  buildAdminIrlRedeemCardDeliveryOrderDocument,
  buildAdminIrlRedeemCardMarkerDocument,
  buildAdminIrlRedeemMarkerDocument,
  buildAdminIrlRedeemClaimCodeDocument,
  buildAdminIrlRedeemDeliveryOrderDocument,
  buildAdminIrlRedeemSelectionKey,
  getAdminIrlRedeemUnsupportedReason,
  resolveAdminIrlRedeemMarkerReuse,
  type AdminIrlRedeemMarkerReuseResolution,
  type AdminIrlRedeemBoxBaseInput,
  type AdminIrlRedeemCardInput,
} from './adminIrlRedeem.js';
import {
  activeDirectCardReceiptClaimSignatures,
  adminIrlCardReceiptProofHasIdentity,
  classifyAdminIrlCardReceiptLookupError,
  classifyDirectCardReceiptClaimSubmission,
  classifyDirectCardReceiptClaimTransferVerificationError,
  directCardReceiptClaimHasRecipientLock,
  directCardReceiptClaimSubmissionProvesNoDelivery,
  resolveDirectCardReceiptClaimRecoveryAction,
  shouldKeepDirectCardReceiptClaimProcessing,
  type DirectCardReceiptClaimSubmission,
  type DirectCardReceiptClaimTransferEvidence,
} from './adminIrlCardReceipt.js';
import { assetProofMatchesTree, assetProofTreePublicKey } from './receiptProof.js';
import { IX_BUBBLEGUM_TRANSFER_V2, bubblegumTransferV2Ix } from './bubblegum.js';
import {
  RESEND_NON_CHECKOUT_ERROR_NOTIFICATION_EMAILS_DISABLED_REASON,
  firstRejectedReadyToShipNotificationError,
  normalizeNotificationEmailRecipient,
  planReadyToShipOrderNotifications,
  resolveNotificationDeliveryId,
  shouldNotifyBuyerForDeliveryShippedWrite,
  shouldNotifyShippersForDeliveryReadyToShipWrite,
  shouldSendResendNotificationEmail,
  validateNotificationEmailRecipient,
  type ResendNotificationEmailKind,
} from './notifications.js';
import {
  NOTIFICATION_EMAIL_FROM,
  buildBuyerOrderReceivedEmailContent,
  buildBuyerOrderShippedEmailContent,
  buildShipperReadyToShipEmailContent,
  buildStripeCheckoutManualReviewEmailContent,
  fulfillmentAppUrlForOrder,
  summarizeShipperReadyOrderItems,
  type BuyerOrderReceivedEmailMessage,
  type BuyerOrderShippedEmailMessage,
  type BuyerVisibleOrderEmailItem,
  type ShipperReadyToShipEmailMessage,
  type ShipperVisibleOrderEmailItem,
  type StripeCheckoutManualReviewEmailMessage,
} from './notificationEmails.js';
import {
  planResendInboundForward,
  resendWebhookHeaders,
  resendWebhookRawBody,
  type ResendReceivedEventCompat,
} from './resendInbound.js';
import { createResendInboundProvider } from './resendInboundProvider.js';
import { resendInboundHttpResponse } from './resendInboundHttp.js';
import { processResendInboundForward } from './resendInboundService.js';
import { FirestoreResendInboundStore } from './resendInboundStore.js';
import { isRetryableResendError, summarizeResendError, type ResendErrorSummary } from './resendErrors.js';
import {
  createResendSubscribersProvider,
  subscribeResendContact,
} from './resendSubscribers.js';
import {
  buildBuyerVisibleOrderEmailItems,
  buildShipperVisibleOrderEmailItems,
} from './orderEmailItems.js';
import { mergeFirebaseStripeDeliveryOrdersToWalletInDb } from './deliveryOrderHistory.js';
import {
  normalizeOptionalFulfillmentTrackingCode,
  resolveFulfillmentTrackingHref,
  sanitizeFulfillmentTrackingCode,
} from './fulfillmentTracking.js';
import {
  FULFILLMENT_STATUS_OPTIONS,
  normalizeFulfillmentStatus,
} from './fulfillmentStatus.js';
import { parseRequest } from './request.js';
import {
  buildStripeCheckoutManualReviewSummary,
  createStripeCheckoutSessionForRequest,
  createTestStripeCheckoutSessionForRequest,
  fetchStripeCheckoutSession,
  handleStripeWebhookEvent,
  isStripeCheckoutManualReviewCandidate,
  processStripeCheckoutFulfillmentDocument,
  requireStripeCheckoutSessionId,
  stripeApiModeForCluster,
  stripeWebhookRawBody,
  stripeWebhookSignature,
  type StripeCheckoutKind,
  type StripeCheckoutFlowDeps,
  type StripeCheckoutManualReviewSummary,
  type StripeCheckoutOnchainConfig,
} from './stripeCheckout/service.js';
import { constructStripeWebhookEvent } from './stripeCheckout/client.js';
import { toMillisMaybe } from './time.js';
import { IRL_CLAIM_CODE_DIGITS, normalizeIrlClaimCode } from './claimCodes.js';
import {
  paginateCardNft2UnrevealedCandidateIds,
  type ListCardNft2UnrevealedCardsRequest,
  type ListCardNft2UnrevealedCardsResponse,
} from './cardNft2Unrevealed.js';
import type {
  DeliveryOrderItemSummary,
  DeliveryOrderSummary,
  DeliveryRecoveryOutcome,
  DeliveryRecoveryState,
  FulfillmentOrderAddress,
  FulfillmentOrderBox,
  FulfillmentOrderCardClaim,
  FulfillmentOrderWithCardClaims as FulfillmentOrder,
  RecoverDeliveryOrdersItemResult as RecoverMyDeliveryOrdersItemResult,
  RecoverDeliveryOrdersResult as RecoverMyDeliveryOrdersResult,
} from './shared/contracts.js';
import {
  dasAssetBoxId,
  dasAssetDudeId,
  dasAssetKind,
  dasAssetLooksBurntOrClosed,
} from './shared/dasAsset.js';
import {
  normalizeBoxMinterMetadataBaseForComparison,
  normalizeDropId as normalizeDropIdShared,
} from './shared/deploymentCore.js';
import {
  BOX_MINTER_CONFIG_SEED,
  BOX_MINTER_MAX_DISCOUNT_MINTS_PER_WALLET as MAX_DISCOUNT_MINTS_PER_WALLET,
  BOX_MINTER_MAX_ITEMS_PER_BOX as MAX_ITEMS_PER_BOX,
  BOX_MINTER_MIN_CONFIGURED_ITEMS_PER_BOX as MIN_ITEMS_PER_BOX,
  BOX_MINTER_MIN_DISCOUNT_MINTS_PER_WALLET as MIN_DISCOUNT_MINTS_PER_WALLET,
  BOX_MINTER_MIN_OPENABLE_ITEMS_PER_BOX as MIN_OPENABLE_ITEMS_PER_BOX,
  BOX_MINTER_MINT_VARIANT_KIND_NONE as MINT_VARIANT_KIND_NONE,
  BOX_MINTER_MINT_VARIANT_KIND_SIZE as MINT_VARIANT_KIND_SIZE,
  BOX_MINTER_MINT_VARIANT_OPTION_COUNT as MINT_VARIANT_OPTION_COUNT,
  BOX_MINTER_PENDING_OPEN_SEED,
  isBoxMinterDiscountMintsPerWallet,
  isConfiguredBoxMinterItemsPerBox,
  type BoxMinterMintVariantTuple,
} from './shared/boxMinterProtocol.js';
import {
  heliusSearchAssetsHasNextPage,
  heliusSearchAssetsItems,
} from './shared/heliusDas.js';
import {
  CARD_NFT_2_BASE_DELIVERY_CARD_COUNT,
  CARD_NFT_2_EXTRA_LAMPORTS,
  CARD_NFT_2_INTL_BASE_LAMPORTS,
  INTL_DELIVERY_BASE_LAMPORTS,
  INTL_DELIVERY_EXTRA_LAMPORTS,
  LITTLE_SWAG_HOODIES_INTL_DELIVERY_BASE_LAMPORTS,
  LITTLE_SWAG_HOODIES_INTL_DELIVERY_EXTRA_LAMPORTS,
  calculateDeliveryLamports,
  isDirectDeliveryItemsPerBox,
  normalizeDeliveryUnitsPerBox,
} from './shared/shipping.js';
import {
  ADMIN_IRL_REDEEM_ADDITIONAL_WALLET_ADDRESSES,
  FULFILLMENT_ADMIN_WALLET_ADDRESSES,
  SHIPPER_FULFILLMENT_ACCESS,
  walletCanViewSensitiveFulfillmentAddress,
  walletHasAdminAccess,
  walletHasAdminIrlRedeemAccess,
  walletHasFulfillmentDropAccess,
} from './shared/fulfillmentAccess.js';
import {
  getAdminIrlRedeemTargetEligibility,
  type AdminIrlRedeemTargetKind,
} from './shared/adminIrlEligibility.js';
import {
  BoxMinterConfigCodecError,
  decodeBoxMinterConfigData as decodeBoxMinterConfigDataShared,
} from './shared/boxMinterConfigCodec.js';
import {
  ADDRESS_CIPHER_SECRET_KEY_LENGTH,
  addressCipherHint,
  decryptAddressCipherText,
  encryptAddressCipherText,
  parseAddressCipherPayload,
  serializeAddressCipherPayload,
} from './shared/addressCipher.js';
import { summarizePayloadShape } from './shared/logSummaries.js';
import {
  BUBBLEGUM_PROGRAM_ADDRESS,
  MPL_ACCOUNT_COMPRESSION_PROGRAM_ADDRESS,
  MPL_CORE_CPI_SIGNER_ADDRESS,
  MPL_CORE_PROGRAM_ADDRESS,
  MPL_NOOP_PROGRAM_ADDRESS,
  SPL_NOOP_PROGRAM_ADDRESS,
} from './shared/solanaProgramAddresses.js';
import { normalizeCallableErrorCode } from './shared/callableErrorCode.js';

// Firebase/Google Secret Manager secrets (Cloud Functions v2).
// Configure via: `firebase functions:secrets:set COSIGNER_SECRET`
const COSIGNER_SECRET = defineSecret('COSIGNER_SECRET');
// Base64-encoded Curve25519 secret key for decrypting delivery addresses (TweetNaCl box).
const ADDRESS_DECRYPTION_SECRET = defineSecret('ADDRESS_DECRYPTION_SECRET');
const RESEND_API_KEY = defineSecret('RESEND_API_KEY');
const RESEND_INBOUND_API_KEY = defineSecret('RESEND_INBOUND_API_KEY');
const RESEND_WEBHOOK_SECRET = defineSecret('RESEND_WEBHOOK_SECRET');
const STRIPE_RESTRICTED_KEY = defineSecret('STRIPE_RESTRICTED_KEY');
const STRIPE_SECRET_KEY = defineSecret('STRIPE_SECRET_KEY');
const STRIPE_RESTRICTED_KEY_LIVE = defineSecret('STRIPE_RESTRICTED_KEY_LIVE');
const STRIPE_SECRET_KEY_LIVE = defineSecret('STRIPE_SECRET_KEY_LIVE');
const STRIPE_WEBHOOK_SECRET = defineSecret('STRIPE_WEBHOOK_SECRET');
const STRIPE_WEBHOOK_SECRET_DEVNET = defineSecret('STRIPE_WEBHOOK_SECRET_DEVNET');

function loadLocalEnv() {
  const envPaths = [
    fileURLToPath(new URL('../.env', import.meta.url)),
    fileURLToPath(new URL('../.env.local', import.meta.url)),
  ];

  // Prefer Node's built-in loader when available.
  const loadEnvFile = (process as any).loadEnvFile as ((path: string) => void) | undefined;

  for (const envPath of envPaths) {
    if (!existsSync(envPath)) continue;

    try {
      if (typeof loadEnvFile === 'function') {
        loadEnvFile(envPath);
        continue;
      }
    } catch {
      // Fall back to the minimal parser below.
    }

    try {
      const content = readFileSync(envPath, 'utf8');
      const lines = content.split(/\r?\n/);
      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#')) continue;
        const withoutExport = line.startsWith('export ') ? line.slice('export '.length).trim() : line;
        const eq = withoutExport.indexOf('=');
        if (eq <= 0) continue;
        const key = withoutExport.slice(0, eq).trim();
        let value = withoutExport.slice(eq + 1).trim();
        if (!key) continue;
        if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
        if (value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1);
        if (!(key in process.env)) process.env[key] = value;
      }
    } catch {
      // Ignore env loading failures; missing vars will be caught by runtime checks.
    }
  }
}

loadLocalEnv();

const app = getApps()[0] || initializeApp();
const db = getFirestore(app);

type CallableReq<T = any> = CallableRequest<T>;

function uidFromRequest(request: CallableReq<any>): string | null {
  return request.auth?.uid || null;
}

function requireAuth(request: CallableReq<any>): string {
  const uid = uidFromRequest(request);
  if (!request.auth || !uid) {
    throw new HttpsError('unauthenticated', 'The function must be called while authenticated.');
  }
  return uid;
}

const WALLET_SESSION_COLLECTION = 'authSessions';
const WALLET_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
// Hardcoded (no env / no deployment config) to avoid config sprawl.
const RPC_TIMEOUT_MS = 8_000;
// Issue-receipts tx retry/confirm tuning.
// Hardcoded (no env) to keep deployments deterministic and avoid config sprawl.
const TX_SEND_TIMEOUT_MS = 12_000;
const TX_CONFIRM_TIMEOUT_MS = 25_000;
const TX_CONFIRM_POLL_MS = 800;
const TX_MAX_SEND_ATTEMPTS = 3;
const FULFILLMENT_ORDER_LIMIT = 1000;

type SolanaCluster = 'devnet' | 'testnet' | 'mainnet-beta';

type DropRuntime = {
  dropId: string;
  config: FunctionsDropConfig;
  cluster: SolanaCluster;
  heliusRpcBase: string;
  connectionRpcUrl: string;
  boxMinterProgramId: PublicKey;
  boxMinterConfigPda: PublicKey;
  collectionMint: PublicKey;
  collectionMintStr: string;
  receiptsMerkleTree: PublicKey;
  receiptsMerkleTreeStr: string;
  deliveryLookupTable: PublicKey;
  deliveryLookupTableStr: string;
  itemsPerBox: number;
  discountMintsPerWallet: number;
  maxSupply: number;
  maxDudeId: number;
};

function isOpenableDrop(dropRuntime: Pick<DropRuntime, 'itemsPerBox'>): boolean {
  return dropRuntime.itemsPerBox >= MIN_OPENABLE_ITEMS_PER_BOX;
}

function assertOpenableDrop(dropRuntime: Pick<DropRuntime, 'itemsPerBox'>, message: string): void {
  if (!isOpenableDrop(dropRuntime)) {
    throw new HttpsError('failed-precondition', message);
  }
}

function normalizeDropId(dropId: string): string {
  const value = normalizeDropIdShared(dropId);
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(value)) {
    throw new HttpsError('invalid-argument', 'Invalid dropId');
  }
  return value;
}

function heliusRpcBaseForCluster(cluster: SolanaCluster): string {
  return cluster === 'mainnet-beta'
    ? 'https://mainnet.helius-rpc.com'
    : cluster === 'testnet'
      ? 'https://testnet.helius-rpc.com'
      : 'https://devnet.helius-rpc.com';
}

function requireConfiguredPubkey(label: string, value: string | undefined): PublicKey {
  const v = (value || '').trim();
  if (!v) return PublicKey.default;
  try {
    return new PublicKey(v);
  } catch (err) {
    throw new Error(`${label} is invalid in functions/src/config/deployment.ts: ${String(err)}`);
  }
}

function buildDropRuntime(config: FunctionsDropConfig): DropRuntime {
  const dropId = normalizeDropId(config.dropId);
  const cluster = config.solanaCluster as SolanaCluster;
  if (cluster !== 'devnet' && cluster !== 'testnet' && cluster !== 'mainnet-beta') {
    throw new Error(`solanaCluster is invalid in functions/src/config/deployment.ts for drop ${dropId}: ${config.solanaCluster}`);
  }
  const itemsPerBox = Number(config.itemsPerBox);
  if (!isConfiguredBoxMinterItemsPerBox(itemsPerBox)) {
    throw new Error(
      `itemsPerBox is invalid in functions/src/config/deployment.ts for drop ${dropId}: ${config.itemsPerBox} (expected integer ${MIN_ITEMS_PER_BOX}..${MAX_ITEMS_PER_BOX})`,
    );
  }
  const maxSupply = Number(config.maxSupply);
  if (!Number.isInteger(maxSupply) || maxSupply < 1 || maxSupply > 0xffff_ffff) {
    throw new Error(`maxSupply is invalid in functions/src/config/deployment.ts for drop ${dropId}: ${config.maxSupply}`);
  }
  const discountMintsPerWalletRaw = Number(config.discountMintsPerWallet);
  if (!isBoxMinterDiscountMintsPerWallet(discountMintsPerWalletRaw)) {
    throw new Error(
      `discountMintsPerWallet is invalid in functions/src/config/deployment.ts for drop ${dropId}: ${config.discountMintsPerWallet} (expected integer ${MIN_DISCOUNT_MINTS_PER_WALLET}..${MAX_DISCOUNT_MINTS_PER_WALLET})`,
    );
  }
  const discountMintsPerWallet = discountMintsPerWalletRaw;
  const maxDudeId = maxSupply * itemsPerBox;
  if (!Number.isFinite(maxDudeId) || maxDudeId > 0xffff) {
    throw new Error(
      `Configured max figure id is invalid in functions/src/config/deployment.ts for drop ${dropId}: maxSupply=${maxSupply}, itemsPerBox=${itemsPerBox}`,
    );
  }
  const boxMinterProgramId = requireConfiguredPubkey('BOX_MINTER_PROGRAM_ID', config.boxMinterProgramId);
  const configuredBoxMinterConfigPda = String(config.boxMinterConfigPda || '').trim();
  const boxMinterConfigPda = configuredBoxMinterConfigPda
    ? requireConfiguredPubkey('BOX_MINTER_CONFIG_PDA', configuredBoxMinterConfigPda)
    : PublicKey.findProgramAddressSync([Buffer.from(BOX_MINTER_CONFIG_SEED)], boxMinterProgramId)[0];
  const collectionMint = requireConfiguredPubkey('COLLECTION_MINT', config.collectionMint);
  const receiptsMerkleTree = requireConfiguredPubkey('RECEIPTS_MERKLE_TREE', config.receiptsMerkleTree);
  const deliveryLookupTable = requireConfiguredPubkey('DELIVERY_LOOKUP_TABLE', config.deliveryLookupTable);
  const heliusRpcBase = heliusRpcBaseForCluster(cluster);
  const apiKey = (process.env.HELIUS_API_KEY || '').trim();
  const connectionRpcUrl = apiKey ? `${heliusRpcBase}/?api-key=${apiKey}` : '';
  return {
    dropId,
    config,
    cluster,
    heliusRpcBase,
    connectionRpcUrl,
    boxMinterProgramId,
    boxMinterConfigPda,
    collectionMint,
    collectionMintStr: collectionMint.equals(PublicKey.default) ? '' : collectionMint.toBase58(),
    receiptsMerkleTree,
    receiptsMerkleTreeStr: receiptsMerkleTree.equals(PublicKey.default) ? '' : receiptsMerkleTree.toBase58(),
    deliveryLookupTable,
    deliveryLookupTableStr: deliveryLookupTable.equals(PublicKey.default) ? '' : deliveryLookupTable.toBase58(),
    itemsPerBox,
    discountMintsPerWallet,
    maxSupply,
    maxDudeId,
  };
}

const DROP_RUNTIMES: Record<string, DropRuntime> = Object.create(null);
Object.entries(FUNCTIONS_DROPS).forEach(([dropIdKey, dropConfig]) => {
  const runtime = buildDropRuntime(dropConfig);
  DROP_RUNTIMES[normalizeDropId(dropIdKey)] = runtime;
});
if (!Object.keys(DROP_RUNTIMES).length) {
  throw new Error('functions/src/config/deployment.ts has no configured drops');
}
const DROP_RUNTIME_COUNTS_BY_CLUSTER_AND_COLLECTION = new Map<string, number>();
const DROP_RUNTIME_COUNTS_BY_REVEAL_SCOPE = new Map<string, number>();
const DROP_RUNTIME_COUNTS_BY_REVEAL_SCOPE_AND_COLLECTION = new Map<string, number>();
Object.values(DROP_RUNTIMES).forEach((runtime) => {
  const clusterCollectionKey = dropRuntimeClusterCollectionKey(runtime);
  DROP_RUNTIME_COUNTS_BY_CLUSTER_AND_COLLECTION.set(
    clusterCollectionKey,
    (DROP_RUNTIME_COUNTS_BY_CLUSTER_AND_COLLECTION.get(clusterCollectionKey) || 0) + 1,
  );
  const scopeKey = revealScopeKey(runtime);
  DROP_RUNTIME_COUNTS_BY_REVEAL_SCOPE.set(scopeKey, (DROP_RUNTIME_COUNTS_BY_REVEAL_SCOPE.get(scopeKey) || 0) + 1);
  const collectionScopeKey = revealScopeCollectionKey(runtime);
  DROP_RUNTIME_COUNTS_BY_REVEAL_SCOPE_AND_COLLECTION.set(
    collectionScopeKey,
    (DROP_RUNTIME_COUNTS_BY_REVEAL_SCOPE_AND_COLLECTION.get(collectionScopeKey) || 0) + 1,
  );
});

function getDropRuntime(dropId: string): DropRuntime {
  const normalizedDropId = normalizeDropId(dropId);
  const runtime = DROP_RUNTIMES[normalizedDropId];
  if (!runtime) {
    throw new HttpsError('invalid-argument', `Unsupported dropId: ${normalizedDropId}`);
  }
  return runtime;
}

function requiresRevealAssetDisambiguation(
  dropRuntime: Pick<DropRuntime, 'cluster' | 'boxMinterProgramId' | 'itemsPerBox'>,
): boolean {
  const scopeKey = revealScopeKey(dropRuntime);
  return (DROP_RUNTIME_COUNTS_BY_REVEAL_SCOPE.get(scopeKey) || 0) > 1;
}

function revealScopeKey(
  dropRuntime: Pick<DropRuntime, 'cluster' | 'boxMinterProgramId' | 'itemsPerBox'>,
): string {
  return `${dropRuntime.cluster}:${dropRuntime.boxMinterProgramId.toBase58()}:${dropRuntime.itemsPerBox}`;
}

function dropRuntimeClusterCollectionKey(
  dropRuntime: Pick<DropRuntime, 'cluster' | 'collectionMintStr'>,
): string {
  return `${dropRuntime.cluster}:${dropRuntime.collectionMintStr}`;
}

function revealScopeCollectionKey(
  dropRuntime: Pick<DropRuntime, 'cluster' | 'boxMinterProgramId' | 'itemsPerBox' | 'collectionMintStr'>,
): string {
  return `${revealScopeKey(dropRuntime)}:${dropRuntime.collectionMintStr}`;
}

function clusterSharesCollectionMint(
  dropRuntime: Pick<DropRuntime, 'cluster' | 'collectionMintStr'>,
): boolean {
  if (!dropRuntime.collectionMintStr) return false;
  return (DROP_RUNTIME_COUNTS_BY_CLUSTER_AND_COLLECTION.get(dropRuntimeClusterCollectionKey(dropRuntime)) || 0) > 1;
}

function revealScopeSharesCollectionMint(
  dropRuntime: Pick<DropRuntime, 'cluster' | 'boxMinterProgramId' | 'itemsPerBox' | 'collectionMintStr'>,
): boolean {
  if (!dropRuntime.collectionMintStr) return false;
  return (DROP_RUNTIME_COUNTS_BY_REVEAL_SCOPE_AND_COLLECTION.get(revealScopeCollectionKey(dropRuntime)) || 0) > 1;
}

function requireDropId(rawDropId: unknown): string {
  if (typeof rawDropId !== 'string' || !rawDropId.trim()) {
    throw new HttpsError('invalid-argument', 'dropId is required');
  }
  const dropId = normalizeDropId(rawDropId);
  if (!DROP_RUNTIMES[dropId]) throw new HttpsError('invalid-argument', `Unsupported dropId: ${dropId}`);
  return dropId;
}

function normalizeWallet(wallet: string): string {
  try {
    return new PublicKey(wallet).toBase58();
  } catch {
    throw new HttpsError('invalid-argument', 'Invalid wallet address');
  }
}

async function requireWalletSession(request: CallableReq<any>): Promise<{ uid: string; wallet: string }> {
  const uid = requireAuth(request);
  const snap = await db.doc(`${WALLET_SESSION_COLLECTION}/${uid}`).get();
  const data = snap.exists ? (snap.data() as any) : null;
  const wallet = typeof data?.wallet === 'string' ? data.wallet : null;

  // Backwards compatibility: if the caller is already authenticated as the wallet UID.
  if (!wallet) {
    try {
      return { uid, wallet: normalizeWallet(uid) };
    } catch {
      throw new HttpsError('unauthenticated', 'Sign in with your wallet first.');
    }
  }

  const expiresAt = data?.expiresAt;
  if (expiresAt && typeof expiresAt.toMillis === 'function' && expiresAt.toMillis() < Date.now()) {
    throw new HttpsError('unauthenticated', 'Wallet session expired. Sign in again.');
  }

  return { uid, wallet: normalizeWallet(wallet) };
}

type ShipperReadyToShipNotificationConfig = {
  dropIds: string[];
  emails: string[];
};

const SHIPPER_READY_TO_SHIP_NOTIFICATIONS: ShipperReadyToShipNotificationConfig[] = [
  {
    dropIds: ['little_swag_boxes', 'poncho_drifella', 'drifella_shirt', 'little_swag_hoodies', 'card_nft_2'],
    emails: ['supermetalxbosch@gmail.com'],
  },
];

const SHIPPER_DROP_IDS_BY_WALLET = new Map<string, Set<string>>();
const SHIPPER_READY_EMAILS_BY_DROP_ID = new Map<string, Set<string>>();
SHIPPER_FULFILLMENT_ACCESS.forEach(({ wallet: rawWallet, dropIds: rawDropIds }) => {
  try {
    const wallet = new PublicKey(rawWallet).toBase58();
    const normalizedDropIds = SHIPPER_DROP_IDS_BY_WALLET.get(wallet) || new Set<string>();
    rawDropIds.forEach((rawDropId) => {
      const dropId = normalizeDropId(rawDropId);
      if (!DROP_RUNTIMES[dropId]) {
        throw new Error(`Unsupported shipper dropId: ${dropId}`);
      }
      normalizedDropIds.add(dropId);
    });
    SHIPPER_DROP_IDS_BY_WALLET.set(wallet, normalizedDropIds);
  } catch (err) {
    console.error('[mons/functions] invalid shipper fulfillment access config', { rawWallet, rawDropIds, error: summarizeError(err) });
  }
});
SHIPPER_READY_TO_SHIP_NOTIFICATIONS.forEach(({ dropIds: rawDropIds, emails: rawEmails }) => {
  try {
    const emails = rawEmails
      .map((rawEmail) => {
        const email = normalizeNotificationEmailRecipient(rawEmail);
        if (!email) {
          console.error('[mons/functions] invalid shipper ready-to-ship notification email', { rawEmail });
        }
        return email;
      })
      .filter((email): email is string => Boolean(email));
    if (!emails.length) return;

    rawDropIds.forEach((rawDropId) => {
      const dropId = normalizeDropId(rawDropId);
      if (!DROP_RUNTIMES[dropId]) {
        throw new Error(`Unsupported shipper ready-to-ship notification dropId: ${dropId}`);
      }
      const emailsForDrop = SHIPPER_READY_EMAILS_BY_DROP_ID.get(dropId) || new Set<string>();
      emails.forEach((email) => emailsForDrop.add(email));
      SHIPPER_READY_EMAILS_BY_DROP_ID.set(dropId, emailsForDrop);
    });
  } catch (err) {
    console.error('[mons/functions] invalid shipper ready-to-ship notification config', {
      rawDropIds,
      rawEmails,
      error: summarizeError(err),
    });
  }
});

const ADMIN_WALLETS = new Set<string>();
FULFILLMENT_ADMIN_WALLET_ADDRESSES.forEach((raw) => {
  try {
    ADMIN_WALLETS.add(new PublicKey(raw).toBase58());
  } catch (err) {
    console.error('[mons/functions] invalid admin wallet', raw, summarizeError(err));
  }
});

const ADMIN_IRL_REDEEM_WALLETS = new Set<string>(ADMIN_WALLETS);
ADMIN_IRL_REDEEM_ADDITIONAL_WALLET_ADDRESSES.forEach((raw) => {
  try {
    ADMIN_IRL_REDEEM_WALLETS.add(new PublicKey(raw).toBase58());
  } catch (err) {
    console.error('[mons/functions] invalid Admin IRL Redeem wallet', raw, summarizeError(err));
  }
});

function hasFulfillmentDropAccess(wallet: string, dropId: string): boolean {
  return walletHasFulfillmentDropAccess(wallet, dropId, ADMIN_WALLETS, SHIPPER_DROP_IDS_BY_WALLET);
}

function canViewSensitiveFulfillmentAddress(wallet: string, dropId: string): boolean {
  return walletCanViewSensitiveFulfillmentAddress(wallet, dropId, ADMIN_WALLETS, SHIPPER_DROP_IDS_BY_WALLET);
}

async function requireFulfillmentDropAccess(request: CallableReq<any>, dropId: string): Promise<{ uid: string; wallet: string }> {
  const { uid, wallet } = await requireWalletSession(request);
  if (!hasFulfillmentDropAccess(wallet, dropId)) {
    throw new HttpsError('permission-denied', 'Fulfillment access denied.');
  }
  return { uid, wallet };
}

async function requireAdminAccess(request: CallableReq<any>): Promise<{ uid: string; wallet: string }> {
  const { uid, wallet } = await requireWalletSession(request);
  if (!walletHasAdminAccess(wallet, ADMIN_WALLETS)) {
    throw new HttpsError('permission-denied', 'Admin access denied.');
  }
  return { uid, wallet };
}

async function requireAdminIrlRedeemAccess(request: CallableReq<any>): Promise<{ uid: string; wallet: string }> {
  const { uid, wallet } = await requireWalletSession(request);
  if (!walletHasAdminIrlRedeemAccess(wallet, ADMIN_IRL_REDEEM_WALLETS)) {
    throw new HttpsError('permission-denied', 'Admin IRL Redeem access denied.');
  }
  return { uid, wallet };
}

// MPL Core program id (uncompressed Core assets).
const MPL_CORE_PROGRAM_ID = new PublicKey(MPL_CORE_PROGRAM_ADDRESS);
// Solana SPL Noop program (commonly used as Metaplex "log wrapper").
const SPL_NOOP_PROGRAM_ID = new PublicKey(SPL_NOOP_PROGRAM_ADDRESS);
// Metaplex Noop program (used by Bubblegum v2).
const MPL_NOOP_PROGRAM_ID = new PublicKey(MPL_NOOP_PROGRAM_ADDRESS);
// MPL Account Compression program (used by Bubblegum v2).
const MPL_ACCOUNT_COMPRESSION_PROGRAM_ID = new PublicKey(MPL_ACCOUNT_COMPRESSION_PROGRAM_ADDRESS);
// Bubblegum program (compressed NFTs).
const BUBBLEGUM_PROGRAM_ID = new PublicKey(BUBBLEGUM_PROGRAM_ADDRESS);
// Bubblegum -> MPL-Core CPI signer (used when minting cNFTs to an MPL-Core collection).
const MPL_CORE_CPI_SIGNER = new PublicKey(MPL_CORE_CPI_SIGNER_ADDRESS);

// Anchor discriminator = sha256("account:DeliveryRecord")[0..8]
const ACCOUNT_DELIVERY_RECORD = Buffer.from('2b0f869afad50393', 'hex');
// Anchor discriminator = sha256("global:deliver")[0..8]
const IX_DELIVER = Buffer.from('fa83de39d3e5d193', 'hex');
// Anchor discriminator = sha256("global:close_delivery")[0..8]
const IX_CLOSE_DELIVERY = Buffer.from('ae641ab98ea5f208', 'hex');
// Anchor discriminator = sha256("global:mint_receipts")[0..8]
const IX_MINT_RECEIPTS = Buffer.from('c7c2556f92996a77', 'hex');

// Bubblegum v2 burn discriminator (kinobi generated).
const IX_BURN_V2 = Buffer.from([115, 210, 34, 240, 232, 143, 183, 16]);

const MAX_DELIVERY_ITEMS = 32;
const SERVER_INVALID_DELIVERY_UNITS_POLICY = 'arithmetic' as const;
const DELIVERY_RECOVERY_LEASE_MS = 90_000;
const DELIVERY_RECOVERY_PROCESSING_RETRY_DELAY_MS = 30_000;
const MAX_DELIVERY_RECOVERY_ORDERS_PER_CALL = 2;
const DELIVERY_RECOVERY_PREPARED_CHECK_DELAYS_MS = [30_000, 2 * 60 * 1000, 10 * 60 * 1000] as const;
const MAX_PREPARED_DELIVERY_RECOVERY_CHECKS = DELIVERY_RECOVERY_PREPARED_CHECK_DELAYS_MS.length;
const STRIPE_RECEIPT_CLAIM_PROCESSING_LEASE_MS = 90_000;
const DIRECT_CARD_RECEIPT_SUBMISSION_RESOLUTION_MAX_WAIT_MS = 90_000;
const DIRECT_CARD_RECEIPT_SUBMISSION_RESOLUTION_POLL_MS = 2_000;
const DIRECT_CARD_RECEIPT_SUBMISSION_PROCESSING_LEASE_MS = 4 * 60 * 1000;
const ADMIN_IRL_REDEEM_PREPARED_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const ADMIN_IRL_REDEEM_PROCESSING_LEASE_MS = 10 * 60 * 1000;
const ADMIN_IRL_REDEEM_RECEIPT_INDEX_MAX_WAIT_MS = 30_000;
const ADMIN_IRL_REDEEM_RECEIPT_INDEX_POLL_MS = 2_000;
const ADMIN_IRL_REDEEM_ASSET_FETCH_CONCURRENCY = 4;
const MAX_CONFIGURED_ITEMS_PER_BOX = Math.max(
  1,
  ...Object.values(DROP_RUNTIMES).map((runtime) =>
    normalizeDeliveryUnitsPerBox(runtime.itemsPerBox, SERVER_INVALID_DELIVERY_UNITS_POLICY),
  ),
);
const MAX_DELIVERY_FIGURES = MAX_DELIVERY_ITEMS * MAX_CONFIGURED_ITEMS_PER_BOX;
const MIN_DELIVERY_LAMPORTS = 0;
const MAX_GENERIC_DELIVERY_LAMPORTS =
  INTL_DELIVERY_BASE_LAMPORTS +
  Math.max(0, MAX_DELIVERY_FIGURES - MAX_CONFIGURED_ITEMS_PER_BOX) * INTL_DELIVERY_EXTRA_LAMPORTS;
const MAX_HOODIE_DELIVERY_LAMPORTS =
  LITTLE_SWAG_HOODIES_INTL_DELIVERY_BASE_LAMPORTS +
  Math.max(0, MAX_DELIVERY_ITEMS - 1) * LITTLE_SWAG_HOODIES_INTL_DELIVERY_EXTRA_LAMPORTS;
const MAX_CARD_NFT_2_DELIVERY_LAMPORTS =
  CARD_NFT_2_INTL_BASE_LAMPORTS +
  Math.max(0, MAX_DELIVERY_FIGURES - CARD_NFT_2_BASE_DELIVERY_CARD_COUNT) * CARD_NFT_2_EXTRA_LAMPORTS;
const MAX_DELIVERY_LAMPORTS = Math.max(
  MAX_GENERIC_DELIVERY_LAMPORTS,
  MAX_HOODIE_DELIVERY_LAMPORTS,
  MAX_CARD_NFT_2_DELIVERY_LAMPORTS,
);

// Optional: Address Lookup Table to shrink delivery tx size (allows more items per tx).
// Should contain: config PDA, treasury, core collection, MPL core program id, system program id, SPL noop program id.
const DELIVERY_LUT_CACHE_TTL_MS = 10 * 60 * 1000;
const cachedDeliveryLutByDrop = new Map<string, { lut: AddressLookupTableAccount; cachedAtMs: number }>();

function assertConfiguredProgramId(key: PublicKey, label: string) {
  if (key.equals(PublicKey.default)) {
    throw new HttpsError('failed-precondition', `${label} is not configured (see functions/src/config/deployment.ts)`);
  }
}

function decodeSecretKey(secret: string | undefined, label: string) {
  const value = (secret || '').trim();
  if (!value) throw new Error(`${label} is not set`);
  let decoded: Uint8Array;
  try {
    decoded = bs58.decode(value);
  } catch (err) {
    throw new Error(`${label} must be valid base58: ${String(err)}`);
  }
  if (decoded.length !== 64) throw new Error(`${label} must decode to 64 bytes (got ${decoded.length})`);
  return decoded;
}

function decodeBase64Secret(secret: string | undefined, label: string, expectedBytes: number): Uint8Array {
  const value = (secret || '').trim();
  if (!value) throw new Error(`${label} is not set`);
  let decoded: Uint8Array;
  try {
    decoded = Buffer.from(value, 'base64');
  } catch (err) {
    throw new Error(`${label} must be valid base64: ${String(err)}`);
  }
  if (decoded.length !== expectedBytes) {
    throw new Error(`${label} must decode to ${expectedBytes} bytes (got ${decoded.length})`);
  }
  return decoded;
}

let cachedCosigner: Keypair | null = null;
function cosigner() {
  if (!cachedCosigner) {
    cachedCosigner = Keypair.fromSecretKey(decodeSecretKey(COSIGNER_SECRET.value(), 'COSIGNER_SECRET'));
  }
  return cachedCosigner;
}

let cachedAddressDecryptKey: Uint8Array | null = null;
let cachedAddressDecryptKeyState: 'unset' | 'ready' | 'missing' = 'unset';
function addressDecryptKeyMaybe(): Uint8Array | null {
  if (cachedAddressDecryptKeyState === 'ready') return cachedAddressDecryptKey;
  if (cachedAddressDecryptKeyState === 'missing') return null;
  try {
    cachedAddressDecryptKey = decodeBase64Secret(
      ADDRESS_DECRYPTION_SECRET.value(),
      'ADDRESS_DECRYPTION_SECRET',
      ADDRESS_CIPHER_SECRET_KEY_LENGTH,
    );
    cachedAddressDecryptKeyState = 'ready';
    return cachedAddressDecryptKey;
  } catch (err) {
    cachedAddressDecryptKeyState = 'missing';
    console.warn('[mons/functions] ADDRESS_DECRYPTION_SECRET unavailable; returning encrypted addresses', summarizeError(err));
    return null;
  }
}

function decodeAddressCipherPart(part: string): Uint8Array | null {
  if (!part) return null;
  try {
    return Buffer.from(part, 'base64');
  } catch {
    return null;
  }
}

function decryptAddressPayload(payload: string): string | null {
  try {
    const parts = parseAddressCipherPayload(payload, decodeAddressCipherPart);
    if (!parts) return null;
    const secret = addressDecryptKeyMaybe();
    if (!secret) return null;
    return decryptAddressCipherText(parts, secret);
  } catch {
    return null;
  }
}

function encryptAddressPayloadForFulfillment(plaintext: string): { encrypted: string; hint: string } | null {
  try {
    const messageText = String(plaintext || '').trim();
    if (!messageText) return null;
    const secret = addressDecryptKeyMaybe();
    if (!secret) {
      throw new HttpsError('unavailable', 'ADDRESS_DECRYPTION_SECRET is not configured for Stripe fulfillment');
    }
    const recipient = nacl.box.keyPair.fromSecretKey(secret).publicKey;
    const parts = encryptAddressCipherText(messageText, recipient);
    const encrypted = serializeAddressCipherPayload(
      parts,
      (value) => Buffer.from(value).toString('base64'),
    );
    const hint = addressCipherHint(messageText);
    return { encrypted, hint };
  } catch (err) {
    if (err instanceof HttpsError) throw err;
    console.warn('[mons/functions] failed to encrypt webhook shipping address', summarizeError(err));
    throw new HttpsError('unavailable', 'Stripe checkout shipping address could not be encrypted', {
      error: summarizeError(err),
    });
  }
}

function ensureAuthorityKeys() {
  // Prepared transactions require a server-side cosigner signature.
  cosigner();
}

function secretParamValueMaybe(secret: { value: () => string }): string {
  try {
    return (secret.value() || '').trim();
  } catch {
    return '';
  }
}

function envOrSecretValue(envName: string, secret: { value: () => string }): string {
  return (process.env[envName] || '').trim() || secretParamValueMaybe(secret);
}

function stripeApiKeys(): string[] {
  const values = [
    envOrSecretValue('STRIPE_SECRET_KEY', STRIPE_SECRET_KEY),
    envOrSecretValue('STRIPE_RESTRICTED_KEY', STRIPE_RESTRICTED_KEY),
    envOrSecretValue('STRIPE_SECRET_KEY_LIVE', STRIPE_SECRET_KEY_LIVE),
    envOrSecretValue('STRIPE_RESTRICTED_KEY_LIVE', STRIPE_RESTRICTED_KEY_LIVE),
  ]
    .map((value) => String(value || '').trim())
    .filter(Boolean);
  return Array.from(new Set(values));
}

type StripeWebhookSecretScope = 'devnet' | 'mainnet';

type StripeWebhookEndpointSecret = {
  envName: 'STRIPE_WEBHOOK_SECRET_DEVNET' | 'STRIPE_WEBHOOK_SECRET';
  scope: StripeWebhookSecretScope;
  value: string;
};

function stripeWebhookEndpointSecrets(): StripeWebhookEndpointSecret[] {
  const devnetSecret = envOrSecretValue('STRIPE_WEBHOOK_SECRET_DEVNET', STRIPE_WEBHOOK_SECRET_DEVNET);
  const mainnetSecret = envOrSecretValue('STRIPE_WEBHOOK_SECRET', STRIPE_WEBHOOK_SECRET);
  if (!devnetSecret && !mainnetSecret) {
    throw new HttpsError('failed-precondition', 'Stripe webhook secret is not configured.');
  }
  if (devnetSecret && mainnetSecret && devnetSecret === mainnetSecret) {
    throw new HttpsError(
      'failed-precondition',
      'STRIPE_WEBHOOK_SECRET_DEVNET and STRIPE_WEBHOOK_SECRET must be different.',
    );
  }

  return [
    ...(devnetSecret
      ? [{ envName: 'STRIPE_WEBHOOK_SECRET_DEVNET' as const, scope: 'devnet' as const, value: devnetSecret }]
      : []),
    ...(mainnetSecret
      ? [{ envName: 'STRIPE_WEBHOOK_SECRET' as const, scope: 'mainnet' as const, value: mainnetSecret }]
      : []),
  ];
}

function stripeWebhookSecretScopeForCluster(cluster: SolanaCluster): StripeWebhookSecretScope {
  return cluster === 'devnet' ? 'devnet' : 'mainnet';
}

async function constructStripeWebhookEventFromConfiguredSecrets(
  rawBody: Buffer,
  signature: string,
  endpointSecrets: readonly StripeWebhookEndpointSecret[],
): Promise<{
  event: Stripe.Event;
  verifiedSecretEnvName: StripeWebhookEndpointSecret['envName'];
  verifiedSecretScope: StripeWebhookSecretScope;
}> {
  let lastError: unknown;
  for (const endpointSecret of endpointSecrets) {
    try {
      const event = await constructStripeWebhookEvent(rawBody, signature, endpointSecret.value);
      return {
        event,
        verifiedSecretEnvName: endpointSecret.envName,
        verifiedSecretScope: endpointSecret.scope,
      };
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError || new HttpsError('invalid-argument', 'Invalid Stripe webhook signature');
}

function stripeWebhookSecretScopeForEvent(event: Stripe.Event): {
  dropId: string;
  cluster: SolanaCluster;
  expectedSecretScope: StripeWebhookSecretScope;
} | null {
  if (event.type !== 'checkout.session.completed' && event.type !== 'checkout.session.async_payment_succeeded') {
    return null;
  }
  const session = event.data.object as Stripe.Checkout.Session;
  if (!isStripeOffchainFulfillmentSession(session)) return null;

  const dropId = requireDropId(session.metadata?.dropId);
  const dropRuntime = getDropRuntime(dropId);
  return {
    dropId,
    cluster: dropRuntime.cluster,
    expectedSecretScope: stripeWebhookSecretScopeForCluster(dropRuntime.cluster),
  };
}

type ParsedSolanaSignInMessage = {
  wallet: string;
  domain: string;
  timestamp: string;
  session: string;
};

function parseSolanaSignInMessage(message: string): ParsedSolanaSignInMessage {
  const raw = typeof message === 'string' ? message.trim() : '';
  if (!raw) throw new HttpsError('invalid-argument', 'Missing sign-in message');
  if (raw.length > 1024) throw new HttpsError('invalid-argument', 'Sign-in message too long');

  const lines = raw
    .split(/\r?\n/g)
    .map((l) => l.trim())
    .filter((l) => l.length);

  const header = lines[0] || '';
  const prefix = 'Sign in to mons.shop as ';
  if (!header.startsWith(prefix)) {
    throw new HttpsError('invalid-argument', 'Invalid sign-in message (bad header)');
  }
  const wallet = header.slice(prefix.length).trim();
  if (!wallet) throw new HttpsError('invalid-argument', 'Invalid sign-in message (missing wallet)');

  const kv: Record<string, string> = {};
  for (const line of lines.slice(1)) {
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (!key || !value) continue;
    if (!(key in kv)) kv[key] = value;
  }

  const domain = kv.Domain || '';
  const timestamp = kv.Timestamp || '';
  const session = kv.Session || '';

  if (!domain) throw new HttpsError('invalid-argument', 'Invalid sign-in message (missing Domain)');
  if (!timestamp) throw new HttpsError('invalid-argument', 'Invalid sign-in message (missing Timestamp)');
  if (!session) throw new HttpsError('invalid-argument', 'Invalid sign-in message (missing Session)');

  return { wallet, domain, timestamp, session };
}

function safeJsonByteLength(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value ?? null), 'utf8');
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function truncateForLog(value: unknown, maxLen: number): string | null {
  if (typeof value !== 'string') return null;
  const s = value.trim();
  if (!s) return null;
  return s.length > maxLen ? s.slice(0, maxLen) : s;
}

function safeUrlOriginForLog(value: unknown, maxLen: number): string | null {
  if (typeof value !== 'string') return null;
  const s = value.trim();
  if (!s) return null;
  try {
    return new URL(s).origin;
  } catch {
    return s.length > maxLen ? s.slice(0, maxLen) : s;
  }
}

function hashForLog(value: string): string {
  const salt = process.env.LOG_HASH_SALT || '';
  return createHash('sha256').update(`${salt}${value}`).digest('hex').slice(0, 16);
}

function isExpectedHttpsErrorCode(code: unknown): boolean {
  if (typeof code !== 'string') return false;
  return [
    'invalid-argument',
    'failed-precondition',
    'permission-denied',
    'unauthenticated',
    'not-found',
    'already-exists',
    'out-of-range',
    // Often thrown when the user/request rate is too high; still typically user-actionable.
    'resource-exhausted',
  ].includes(code);
}

function isGrpcAlreadyExists(err: unknown): boolean {
  const anyErr = err as any;
  const code = anyErr?.code;
  return code === 6 || code === '6' || code === 'ALREADY_EXISTS';
}

function callableMeta(request: CallableReq<any>) {
  const raw = (request as any).rawRequest as any;
  const headers = raw?.headers || {};
  const forwarded = headers['x-forwarded-for'];
  const ip = typeof forwarded === 'string' ? forwarded.split(',')[0].trim() : raw?.ip;
  const origin = truncateForLog(headers.origin, 200);
  const refererOrigin = safeUrlOriginForLog(headers.referer, 200);
  const userAgent = truncateForLog(headers['user-agent'], 256);
  const trace = truncateForLog(headers['x-cloud-trace-context'], 200);
  return {
    uid: request.auth?.uid || null,
    origin,
    referer: refererOrigin,
    userAgent,
    // Hash IP instead of logging raw IP to reduce sensitivity of logs.
    ipHash: ip ? hashForLog(String(ip)) : null,
    trace,
  };
}

function summarizeError(err: unknown) {
  const anyErr = err as any;
  const isHttpsError = anyErr && typeof anyErr === 'object' && typeof anyErr.code === 'string' && anyErr.code !== 'UNKNOWN';
  if (isHttpsError) {
    return {
      kind: 'HttpsError',
      code: anyErr.code,
      message: anyErr.message,
      details: anyErr.details,
    };
  }
  if (err instanceof Error) {
    const stack = typeof err.stack === 'string' ? err.stack.slice(0, 4000) : undefined;
    const retryableEmailError = isRetryableNotificationEmailError(err)
      ? { reason: err.reason, ...(err.details !== undefined ? { details: err.details } : {}) }
      : {};
    return { kind: err.name, message: err.message, ...retryableEmailError, ...(stack ? { stack } : {}) };
  }
  return { kind: typeof err, message: String(err) };
}

function onCallLogged<TReq, TRes>(
  name: string,
  handler: (request: CallableReq<TReq>) => Promise<TRes>,
  options: CallableOptions = {},
) {
  return onCall(options, async (request: CallableReq<TReq>) => {
    const startedAt = Date.now();
    const debug = (request as any)?.data?.__debug as any;
    const debugCallId = typeof debug?.callId === 'string' ? debug.callId : null;
    const baseMeta = { ...callableMeta(request), debugCallId };
    try {
      logger.info(`${name}:call`, { ...baseMeta, data: summarizePayloadShape((request as any).data) });
    } catch (logErr) {
      // Never fail the function because structured logging couldn't serialize something.
      console.error(`${name}:call logger failed`, { logError: summarizeError(logErr), meta: baseMeta });
    }
    try {
      const result = await handler(request);
      const ms = Date.now() - startedAt;
      try {
        logger.info(`${name}:ok`, { ...baseMeta, ms });
      } catch (logErr) {
        console.error(`${name}:ok logger failed`, { logError: summarizeError(logErr), meta: baseMeta, ms });
      }
      return result;
    } catch (err) {
      const ms = Date.now() - startedAt;
      try {
        const code = (err as any)?.code;
        const summary = summarizeError(err);
        if (isExpectedHttpsErrorCode(code)) {
          // Expected/user-actionable errors: avoid logging stacks and keep severity lower.
          logger.warn(`${name}:rejected`, { ...baseMeta, ms, error: summary });
        } else {
          const errorForLog = err instanceof Error ? err : new Error(String(err));
          logger.error(`${name}:error`, errorForLog, { ...baseMeta, ms, error: summary });
        }
      } catch (logErr) {
        console.error(`${name}:error logger failed`, {
          logError: summarizeError(logErr),
          meta: baseMeta,
          ms,
          error: summarizeError(err),
        });
      }
      throw err;
    }
  });
}

function onCallAuthed<TReq, TRes>(
  name: string,
  handler: (request: CallableReq<TReq>, uid: string) => Promise<TRes>,
  options: CallableOptions = {},
) {
  return onCallLogged<TReq, TRes>(name, async (request: CallableReq<TReq>) => {
    const uid = requireAuth(request);
    return handler(request, uid);
  }, options);
}

function heliusRpcEndpoint(runtime: DropRuntime) {
  const apiKey = (process.env.HELIUS_API_KEY || '').trim();
  if (!apiKey) throw new Error('Missing HELIUS_API_KEY');
  return `${runtime.heliusRpcBase}/?api-key=${apiKey}`;
}

function connection(runtime: DropRuntime) {
  const endpoint = runtime.connectionRpcUrl || heliusRpcEndpoint(runtime);
  return new Connection(endpoint, { commitment: 'confirmed', disableRetryOnRateLimit: true });
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function txErrMessage(err: unknown) {
  if (err instanceof Error) return err.message;
  return String(err);
}

function txErrLogs(err: unknown): string[] {
  const logs = (err as any)?.logs;
  return Array.isArray(logs) ? logs.map((l) => String(l)) : [];
}

function transactionPreflightError(label: string, signature: string, err: unknown, logs: string[]): HttpsError {
  const message = txErrMessage(err);
  let code: 'aborted' | 'failed-precondition' | 'unavailable' = 'failed-precondition';
  if (looksLikeBlockhashError(message) || looksLikeAccountInUseError(message, logs)) {
    code = 'aborted';
  } else if (looksLikeRateLimitOrRpcError(message)) {
    code = 'unavailable';
  }
  return new HttpsError(code, `${label} transaction preflight failed`, {
    signature,
    lastError: message,
    lastLogs: logs.slice(0, 80),
  });
}

function looksLikeComputeLimitError(message: string, logs: string[]) {
  const haystack = `${message}\n${logs.join('\n')}`.toLowerCase();
  return (
    haystack.includes('computational budget exceeded') ||
    haystack.includes('exceeded maximum compute') ||
    haystack.includes('program failed to complete') ||
    haystack.includes('compute units') && haystack.includes('consumed') && haystack.includes('failed')
  );
}

function looksLikeAccountInUseError(message: string, logs: string[]) {
  const haystack = `${message}\n${logs.join('\n')}`.toLowerCase();
  return haystack.includes('account in use') || haystack.includes('already in use');
}

function looksLikeBlockhashError(message: string) {
  const m = message.toLowerCase();
  return (
    m.includes('blockhash not found') ||
    m.includes('blockhash expired') ||
    m.includes('transaction expired') ||
    m.includes('block height exceeded') ||
    m.includes('transactionexpiredblockheightexceedederror')
  );
}

function looksLikeRateLimitOrRpcError(message: string) {
  const m = message.toLowerCase();
  return (
    m.includes('429') ||
    m.includes('rate limit') ||
    m.includes('too many requests') ||
    m.includes('timed out') ||
    m.includes('timeout') ||
    m.includes('fetch failed') ||
    m.includes('socket hang up') ||
    m.includes('econnreset') ||
    m.includes('etimedout') ||
    m.includes('service unavailable') ||
    m.includes('gateway timeout') ||
    m.includes('rpc') && m.includes('error')
  );
}

async function waitForSignature(
  conn: Connection,
  signature: string,
  opts: { timeoutMs: number; pollMs: number },
): Promise<{ ok: true } | { ok: false; err: any; logs?: string[]; tx?: any }> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < opts.timeoutMs) {
    try {
      // Only hit full history lookups after we've waited a bit; it's slower and usually unnecessary.
      const searchHistory = Date.now() - startedAt > 6_000;
      const res = await withTimeout(
        conn.getSignatureStatuses([signature], { searchTransactionHistory: searchHistory }),
        RPC_TIMEOUT_MS,
        'getSignatureStatuses',
      );
      const st = res?.value?.[0] || null;
      if (st?.err) {
        // Best-effort fetch logs for debugging/classification.
        let tx: any = null;
        try {
          tx = await withTimeout(
            conn.getTransaction(signature, { maxSupportedTransactionVersion: 0 }),
            RPC_TIMEOUT_MS,
            'getTransaction:failedTx',
          );
        } catch {
          // ignore
        }
        const logs = Array.isArray(tx?.meta?.logMessages) ? tx.meta.logMessages : [];
        return { ok: false, err: st.err, logs, tx };
      }
      const status = st?.confirmationStatus;
      if (status === 'confirmed' || status === 'finalized') return { ok: true };
    } catch {
      // ignore transient polling failures
    }

    await sleep(opts.pollMs);
  }

  // Timeout: try one last fetch to see if it landed.
  try {
    const tx = await withTimeout(conn.getTransaction(signature, { maxSupportedTransactionVersion: 0 }), RPC_TIMEOUT_MS, 'getTransaction:timeoutTx');
    if (tx?.meta && !tx.meta.err) return { ok: true };
    const logs = Array.isArray(tx?.meta?.logMessages) ? tx.meta.logMessages : [];
    return { ok: false, err: tx?.meta?.err || 'timeout', logs, tx };
  } catch {
    return { ok: false, err: 'timeout' };
  }
}

async function sendAndConfirmSignedTx(
  conn: Connection,
  tx: VersionedTransaction,
  label: string,
  opts: { sendTimeoutMs?: number; confirmTimeoutMs?: number } = {},
): Promise<string> {
  const sig = bs58.encode(tx.signatures[0]);
  const sendTimeoutMs = opts.sendTimeoutMs ?? TX_SEND_TIMEOUT_MS;
  const confirmTimeoutMs = opts.confirmTimeoutMs ?? TX_CONFIRM_TIMEOUT_MS;

  let sendErr: unknown = null;
  try {
    await withTimeout(conn.sendTransaction(tx, { maxRetries: 2 }), sendTimeoutMs, `sendTransaction:${label}`);
  } catch (err) {
    sendErr = err;
  }

  if (sendErr) {
    const logs = txErrLogs(sendErr);
    // If preflight simulation produced logs, we can treat it as a deterministic failure (not "maybe submitted").
    if (logs.length) throw transactionPreflightError(label, sig, sendErr, logs);

    // Unclear if it was submitted; wait briefly for it to land anyway.
    const maybe = await waitForSignature(conn, sig, { timeoutMs: 12_000, pollMs: TX_CONFIRM_POLL_MS });
    if (maybe.ok) return sig;
    const code = (sendErr as any)?.code === 'deadline-exceeded' ? 'deadline-exceeded' : 'unavailable';
    throw new HttpsError(code, `${label} transaction submission status unknown (try again)`, {
      signature: sig,
      lastError: txErrMessage(sendErr),
      maybeSubmitted: true,
    });
  }

  const confirmed = await waitForSignature(conn, sig, { timeoutMs: confirmTimeoutMs, pollMs: TX_CONFIRM_POLL_MS });
  if (confirmed.ok) return sig;

  // TS narrowing can be finicky on boolean discriminants in some configs; use a structural guard.
  if (!('err' in confirmed)) return sig;

  const msg = txErrMessage(confirmed.err);
  const logs = Array.isArray(confirmed.logs) ? confirmed.logs : [];
  const code = /timeout/i.test(msg) ? 'deadline-exceeded' : 'failed-precondition';
  throw new HttpsError(code, `${label} transaction not confirmed (try again)`, {
    signature: sig,
    lastError: msg,
    lastLogs: logs.slice(0, 80),
  });
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  const timeout = sleep(ms).then(() => {
    throw new HttpsError('deadline-exceeded', `${label} timed out after ${ms}ms`);
  });
  return Promise.race([promise, timeout]);
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  mapItem: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(items.length, Math.max(1, Math.floor(concurrency)));
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < items.length) {
        const index = nextIndex;
        nextIndex += 1;
        results[index] = await mapItem(items[index], index);
      }
    }),
  );
  return results;
}

function assertConfiguredPublicKey(key: PublicKey, label: string) {
  if (key.equals(PublicKey.default)) {
    throw new HttpsError('failed-precondition', `${label} is not configured (see functions/src/config/deployment.ts)`);
  }
}

const ONCHAIN_CONFIG_CHECK_TTL_MS = 5 * 60 * 1000;
type OnchainConfigCheck =
  | { lastCheckedMs: number; ok: false }
  | { lastCheckedMs: number; ok: true; config: DecodedBoxMinterConfig };
const onchainConfigCheckByDrop = new Map<string, OnchainConfigCheck>();

async function ensureOnchainCoreConfig(dropRuntime: DropRuntime, force = false): Promise<DecodedBoxMinterConfig> {
  const now = Date.now();
  const cached = onchainConfigCheckByDrop.get(dropRuntime.dropId);
  if (!force && cached?.ok && now - cached.lastCheckedMs < ONCHAIN_CONFIG_CHECK_TTL_MS) return cached.config;
  onchainConfigCheckByDrop.set(dropRuntime.dropId, { lastCheckedMs: now, ok: false });

  ensureAuthorityKeys();
  assertConfiguredProgramId(dropRuntime.boxMinterProgramId, 'BOX_MINTER_PROGRAM_ID');
  assertConfiguredPublicKey(dropRuntime.collectionMint, 'COLLECTION_MINT');

  const pubkeys = [dropRuntime.collectionMint, dropRuntime.boxMinterConfigPda];
  const infos = await withTimeout(
    connection(dropRuntime).getMultipleAccountsInfo(pubkeys, { commitment: 'confirmed' }),
    RPC_TIMEOUT_MS,
    'getMultipleAccountsInfo',
  );

  const missing: Record<string, string> = {};
  for (let i = 0; i < pubkeys.length; i += 1) {
    if (infos[i]) continue;
    const key = pubkeys[i];
    const label = key.equals(dropRuntime.collectionMint) ? 'COLLECTION_MINT' : 'BOX_MINTER_CONFIG_PDA';
    missing[label] = key.toBase58();
  }

  if (Object.keys(missing).length) {
    throw new HttpsError(
      'failed-precondition',
      'On-chain mint config is missing or mismatched. Re-run `npm run deploy-all-onchain -- <dropId>`, update functions env, and redeploy.',
      {
        missing,
        collection: dropRuntime.collectionMint.toBase58(),
        configPda: dropRuntime.boxMinterConfigPda.toBase58(),
        dropId: dropRuntime.dropId,
      },
    );
  }

  const collectionInfo = infos[0];
  const configInfo = infos[1];
  if (collectionInfo && !collectionInfo.owner.equals(MPL_CORE_PROGRAM_ID)) {
    throw new HttpsError(
      'failed-precondition',
      'COLLECTION_MINT is not an MPL Core collection account for this cluster.',
      {
        collection: dropRuntime.collectionMint.toBase58(),
        expectedOwner: MPL_CORE_PROGRAM_ID.toBase58(),
        actualOwner: collectionInfo.owner.toBase58(),
        dropId: dropRuntime.dropId,
      },
    );
  }

  if (!configInfo?.data) {
    throw new HttpsError(
      'failed-precondition',
      'On-chain mint config is missing or unreadable. Re-run `npm run deploy-all-onchain -- <dropId>`, update functions env, and redeploy.',
      { configPda: dropRuntime.boxMinterConfigPda.toBase58(), dropId: dropRuntime.dropId },
    );
  }
  const decoded = decodeBoxMinterConfigData(Buffer.from(configInfo.data));
  if (decoded.itemsPerBox !== dropRuntime.itemsPerBox) {
    throw new HttpsError(
      'failed-precondition',
      'functions/src/config/deployment.ts is out of sync with the on-chain itemsPerBox value.',
      {
        configuredItemsPerBox: dropRuntime.itemsPerBox,
        onchainItemsPerBox: decoded.itemsPerBox,
        configPda: dropRuntime.boxMinterConfigPda.toBase58(),
        dropId: dropRuntime.dropId,
      },
    );
  }
  if (decoded.maxSupply !== dropRuntime.maxSupply) {
    throw new HttpsError(
      'failed-precondition',
      'functions/src/config/deployment.ts is out of sync with the on-chain maxSupply value.',
      {
        configuredMaxSupply: dropRuntime.maxSupply,
        onchainMaxSupply: decoded.maxSupply,
        configPda: dropRuntime.boxMinterConfigPda.toBase58(),
        dropId: dropRuntime.dropId,
      },
    );
  }
  if (decoded.discountMintsPerWallet !== dropRuntime.discountMintsPerWallet) {
    throw new HttpsError(
      'failed-precondition',
      'functions/src/config/deployment.ts is out of sync with the on-chain discountMintsPerWallet value.',
      {
        configuredDiscountMintsPerWallet: dropRuntime.discountMintsPerWallet,
        onchainDiscountMintsPerWallet: decoded.discountMintsPerWallet,
        configPda: dropRuntime.boxMinterConfigPda.toBase58(),
        dropId: dropRuntime.dropId,
      },
    );
  }
  if (normalizeBoxMinterMetadataBaseForComparison(decoded.uriBase) !== normalizeDropBase(dropRuntime.config.metadataBase)) {
    throw new HttpsError(
      'failed-precondition',
      'functions/src/config/deployment.ts is out of sync with the on-chain metadata base for this drop.',
      {
        configuredMetadataBase: normalizeDropBase(dropRuntime.config.metadataBase),
        onchainMetadataBase: normalizeBoxMinterMetadataBaseForComparison(decoded.uriBase),
        onchainMetadataBaseRaw: decoded.uriBase,
        configPda: dropRuntime.boxMinterConfigPda.toBase58(),
        dropId: dropRuntime.dropId,
      },
    );
  }

  onchainConfigCheckByDrop.set(dropRuntime.dropId, { lastCheckedMs: now, ok: true, config: decoded });
  return decoded;
}

function parseSignature(sig: number[] | string) {
  if (typeof sig === 'string') return bs58.decode(sig);
  return Uint8Array.from(sig);
}

async function heliusJson(url: string, label: string, retries = 3, backoffMs = 400) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await withTimeout(fetch(url), RPC_TIMEOUT_MS, `heliusJson:${label}`);
      if (res.ok) return await res.json();

      const status = res.status;
      // 404 can be transient right after mint/transfer while the asset indexes.
      const retriable = status === 429 || status >= 500 || status === 404;
      if (retriable && attempt < retries) {
        await sleep(backoffMs * 2 ** attempt);
        continue;
      }

      if (status === 404) {
        throw new HttpsError('not-found', `${label}: not found (Helius 404)`, { status });
      }
      if (status === 400) {
        throw new HttpsError('invalid-argument', `${label}: bad request (Helius 400)`, { status });
      }
      if (status === 401 || status === 403) {
        throw new HttpsError('failed-precondition', `${label}: unauthorized (check Helius API key)`, {
          status,
        });
      }
      if (status === 429) {
        throw new HttpsError('resource-exhausted', `${label}: rate limited`, { status });
      }
      if (status >= 500) {
        throw new HttpsError('unavailable', `${label}: upstream unavailable`, { status });
      }
      throw new HttpsError('unknown', `${label}: HTTP ${status}`, { status });
    } catch (err) {
      const anyErr = err as any;
      const isHttpsError = anyErr && typeof anyErr === 'object' && typeof anyErr.code === 'string' && anyErr.code !== 'UNKNOWN';
      if (isHttpsError) {
        const code = String(anyErr.code);
        const retriableCode =
          code === 'unavailable' || code === 'resource-exhausted' || code === 'deadline-exceeded' || code === 'unknown';
        if (!retriableCode || attempt === retries) throw err;
        await sleep(backoffMs * 2 ** attempt);
        continue;
      }

      if (attempt === retries) {
        throw new HttpsError('unavailable', `${label}: request failed`, {
          message: err instanceof Error ? err.message : String(err),
        });
      }
      await sleep(backoffMs * 2 ** attempt);
    }
  }
  // Unreachable, but keeps TS happy.
  throw new HttpsError('unavailable', `${label}: request failed`);
}

async function heliusRpc<T>(dropRuntime: DropRuntime, method: string, params: any, label: string): Promise<T> {
  const url = heliusRpcEndpoint(dropRuntime);
  const res = await withTimeout(
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: label, method, params }),
    }),
    RPC_TIMEOUT_MS,
    `heliusRpc:${method}`,
  );
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok || json?.error) {
    const message = json?.error?.message || res.statusText || 'Unknown Helius RPC error';
    const upstreamCode = json?.error?.code;
    logger.warn('Helius RPC error', {
      method,
      label,
      status: res.status,
      upstreamCode,
      message,
    });
    throw new HttpsError('unavailable', `${label}: ${message}`, {
      method,
      status: res.status,
      upstreamCode,
    });
  }
  return json.result as T;
}

const HELIUS_ASSETS_PAGE_LIMIT = 1000;
const HELIUS_ASSETS_MAX_SEARCH_PAGES = 64;
const FUNCTIONS_DAS_NAME_POLICY = { metadataNameMode: 'string-only' } as const;
const FUNCTIONS_DAS_BURN_POLICY = {
  missingAssetResult: true,
  nonBooleanFlagIsBurnt: false,
} as const;

function heliusSearchAssetsParams(owner: string, page: number, grouping?: readonly [string, string]) {
  const params: any = {
    ownerAddress: owner,
    page,
    limit: HELIUS_ASSETS_PAGE_LIMIT,
    options: HELIUS_COLLECTION_GROUPING_OPTIONS,
  };
  if (grouping) params.grouping = grouping;
  return params;
}

async function findOwnedAssetByPredicate(params: {
  owner: string;
  dropRuntime: DropRuntime;
  matches: (asset: any) => boolean;
  grouping?: readonly [string, string];
  label: string;
}): Promise<{ asset: any | null; sawItems: boolean }> {
  let asset: any | null = null;
  const { sawItems } = await scanOwnedAssets({
    owner: params.owner,
    dropRuntime: params.dropRuntime,
    grouping: params.grouping,
    label: params.label,
    visit: (candidate) => {
      if (!params.matches(candidate)) return false;
      asset = candidate;
      return true;
    },
  });
  return { asset, sawItems };
}

async function scanOwnedAssets(params: {
  owner: string;
  dropRuntime: DropRuntime;
  grouping?: readonly [string, string];
  label: string;
  visit: (asset: any) => boolean | Promise<boolean>;
}): Promise<{ sawItems: boolean; stopped: boolean }> {
  return scanOwnedAssetPages({
    owner: params.owner,
    dropRuntime: params.dropRuntime,
    grouping: params.grouping,
    label: params.label,
    visitPage: async (items) => {
      for (const item of items) {
        if (await params.visit(item)) return true;
      }
      return false;
    },
  });
}

async function scanOwnedAssetPages(params: {
  owner: string;
  dropRuntime: DropRuntime;
  grouping?: readonly [string, string];
  label: string;
  visitPage: (items: any[]) => boolean | Promise<boolean>;
}): Promise<{ sawItems: boolean; stopped: boolean }> {
  let sawItems = false;
  for (let page = 1; page <= HELIUS_ASSETS_MAX_SEARCH_PAGES; page += 1) {
    const result = await heliusRpc<any>(
      params.dropRuntime,
      'searchAssets',
      heliusSearchAssetsParams(params.owner, page, params.grouping),
      params.label,
    );
    const items = heliusSearchAssetsItems(result);
    sawItems ||= items.length > 0;

    if (await params.visitPage(items)) return { sawItems, stopped: true };
    if (!heliusSearchAssetsHasNextPage(result, page, items, HELIUS_ASSETS_PAGE_LIMIT)) {
      return { sawItems, stopped: false };
    }
  }

  logger.warn('Helius searchAssets page cap reached while finding asset', {
    owner: params.owner,
    dropId: params.dropRuntime.dropId,
    collection: params.dropRuntime.collectionMintStr || null,
    grouped: Boolean(params.grouping),
    maxPages: HELIUS_ASSETS_MAX_SEARCH_PAGES,
  });
  throw new HttpsError('unavailable', 'Too many assets to search for receipt; try again or contact support.', {
    dropId: params.dropRuntime.dropId,
    maxPages: HELIUS_ASSETS_MAX_SEARCH_PAGES,
  });
}

async function fetchAssetsOwned(owner: string, dropRuntime: DropRuntime) {
  // Helius DAS expects `grouping` as a tuple: [groupKey, groupValue]
  // (assets returned by the API use objects like { group_key, group_value }).
  //
  // NOTE: Newly minted assets can briefly miss collection-group indexing on devnet.
  // We first try the collection-group query (fast/small), then fall back to an ungrouped query
  // and filter locally by explicit collection identity from the asset payload.
  if (dropRuntime.collectionMintStr) {
    const grouping = ['collection', dropRuntime.collectionMintStr] as const;
    const grouped = await heliusRpc<any>(dropRuntime, 'searchAssets', heliusSearchAssetsParams(owner, 1, grouping), 'Helius assets error');
    const items = heliusSearchAssetsItems(grouped);
    if (items.length) return items;
    logger.warn('Helius searchAssets returned 0 items for collection grouping; falling back to ungrouped search', {
      owner,
      collection: dropRuntime.collectionMintStr,
      dropId: dropRuntime.dropId,
    });
  }

  const result = await heliusRpc<any>(dropRuntime, 'searchAssets', heliusSearchAssetsParams(owner, 1), 'Helius assets error');
  return heliusSearchAssetsItems(result);
}

function looksBurntOrClosedInHelius(asset: any): boolean {
  return dasAssetLooksBurntOrClosed(asset, FUNCTIONS_DAS_BURN_POLICY);
}

async function fetchAsset(assetId: string, dropRuntime: DropRuntime) {
  // Use DAS RPC to keep behavior consistent with `searchAssets` (inventory).
  let asset: any;
  try {
    asset = await heliusRpc<any>(
      dropRuntime,
      'getAsset',
      { id: assetId, options: HELIUS_COLLECTION_GROUPING_OPTIONS },
      'Helius asset error',
    );
  } catch (err) {
    const anyErr = err as any;
    const upstreamCode = anyErr?.details?.upstreamCode;
    const msg = String(anyErr?.message || '');
    const looksLikeRpcMethodMismatch =
      upstreamCode === -32601 || upstreamCode === -32602 || /method not found|invalid params/i.test(msg);
    if (!looksLikeRpcMethodMismatch) throw err;
    // Fallback to legacy REST endpoint if RPC method signature isn't supported.
    const helius = process.env.HELIUS_API_KEY;
    const clusterParam = dropRuntime.cluster === 'mainnet-beta' ? '' : `&cluster=${dropRuntime.cluster}`;
    const url = `https://api.helius.xyz/v0/assets?ids[]=${assetId}&api-key=${helius}${clusterParam}`;
    const json = await heliusJson(url, 'Helius asset error');
    asset = Array.isArray(json) ? json[0] : (json as any)?.[0];
  }
  if (!asset) {
    throw new HttpsError(
      'not-found',
      'Asset not found. If you just minted/transferred/opened this item, wait a few seconds and retry.',
      { assetId },
    );
  }
  return asset;
}

async function fetchAssetProof(assetId: string, dropRuntime: DropRuntime) {
  let proof: any;
  try {
    proof = await heliusRpc<any>(dropRuntime, 'getAssetProof', { id: assetId }, 'Helius asset proof error');
  } catch (err) {
    const anyErr = err as any;
    const upstreamCode = anyErr?.details?.upstreamCode;
    const msg = String(anyErr?.message || '');
    const looksLikeRpcMethodMismatch =
      upstreamCode === -32601 || upstreamCode === -32602 || /method not found|invalid params/i.test(msg);
    if (!looksLikeRpcMethodMismatch) throw err;
    // Fallback to REST endpoint if RPC method signature isn't supported.
    const helius = process.env.HELIUS_API_KEY;
    const clusterParam = dropRuntime.cluster === 'mainnet-beta' ? '' : `&cluster=${dropRuntime.cluster}`;
    const url = `https://api.helius.xyz/v0/assets/${assetId}/proof?api-key=${helius}${clusterParam}`;
    proof = await heliusJson(url, 'Helius asset proof error');
  }
  if (!proof) {
    throw new HttpsError('not-found', 'Asset proof not found', { assetId });
  }
  return proof;
}

function getAssetKind(asset: any): 'box' | 'dude' | 'certificate' | null {
  return dasAssetKind(asset, FUNCTIONS_DAS_NAME_POLICY);
}

function getBoxIdFromAsset(asset: any): string | undefined {
  return dasAssetBoxId(asset, FUNCTIONS_DAS_NAME_POLICY);
}

function getDudeIdFromAsset(asset: any): number | undefined {
  return dasAssetDudeId(asset);
}

function assetMatchesDropCollection(
  asset: any,
  dropRuntime: DropRuntime,
  allowedKinds?: ReadonlyArray<'box' | 'dude' | 'certificate'>,
): boolean {
  const kind = getAssetKind(asset);
  if (!kind) return false;
  if (allowedKinds && !allowedKinds.includes(kind)) return false;

  const collectionMint = uniqueAssetGroupingCollectionMint(asset);
  return Boolean(dropRuntime.collectionMintStr) && collectionMint === dropRuntime.collectionMintStr;
}

function assetMatchesRequestedDrop(asset: any, dropRuntime: DropRuntime): boolean {
  return assetMatchesDropCollection(asset, dropRuntime) && !clusterSharesCollectionMint(dropRuntime);
}

async function fetchAssetRetry(assetId: string, dropRuntime: DropRuntime) {
  // DAS can be briefly inconsistent right after mint/transfer. Retry a few times so a newly minted
  // box that already shows in inventory can still be opened immediately.
  const startedAt = Date.now();
  const maxWaitMs = 12_000;
  const maxAttempts = 6;
  let lastErr: unknown;
  for (let attempt = 0; attempt < maxAttempts && Date.now() - startedAt < maxWaitMs; attempt++) {
    try {
      return await fetchAsset(assetId, dropRuntime);
    } catch (err) {
      lastErr = err;
      const anyErr = err as any;
      const isHttpsError = anyErr && typeof anyErr === 'object' && typeof anyErr.code === 'string' && anyErr.code !== 'UNKNOWN';
      // Only retry on transient upstream/indexing failures.
      const retriable =
        !isHttpsError ||
        anyErr.code === 'not-found' ||
        anyErr.code === 'unavailable' ||
        anyErr.code === 'resource-exhausted' ||
        anyErr.code === 'deadline-exceeded';
      if (!retriable) throw err;
      if (attempt < maxAttempts - 1) {
        await sleep(300 * 2 ** attempt);
      }
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

function u16LE(value: number) {
  const buf = Buffer.alloc(2);
  buf.writeUInt16LE(value & 0xffff, 0);
  return buf;
}

function u32LE(value: number) {
  const buf = Buffer.alloc(4);
  buf.writeUInt32LE(value >>> 0, 0);
  return buf;
}

function u64LE(value: number) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) {
    throw new HttpsError('invalid-argument', `Invalid u64 value: ${value}`);
  }
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(BigInt(Math.floor(n)), 0);
  return buf;
}

function borshOption(inner?: Buffer | null) {
  return inner ? Buffer.concat([Buffer.from([1]), inner]) : Buffer.from([0]);
}

function encodeDeliverArgs(args: { deliveryId: number; feeLamports: number; deliveryBump: number }): Buffer {
  const deliveryId = Number(args.deliveryId);
  const feeLamports = Number(args.feeLamports);
  const bump = Number(args.deliveryBump);
  if (!Number.isFinite(deliveryId) || deliveryId <= 0 || deliveryId > 0xffff_ffff) {
    throw new HttpsError('invalid-argument', 'Invalid deliveryId');
  }
  if (!Number.isFinite(feeLamports) || feeLamports < MIN_DELIVERY_LAMPORTS || feeLamports > MAX_DELIVERY_LAMPORTS) {
    throw new HttpsError('invalid-argument', 'Invalid delivery_fee_lamports');
  }
  if (!Number.isFinite(bump) || bump < 0 || bump > 255) {
    throw new HttpsError('invalid-argument', 'Invalid delivery bump');
  }
  return Buffer.concat([IX_DELIVER, u32LE(deliveryId), u64LE(feeLamports), Buffer.from([bump & 0xff])]);
}

function decodeDeliverArgs(data: Buffer): { deliveryId: number; feeLamports: number; deliveryBump: number } {
  if (!Buffer.isBuffer(data)) data = Buffer.from(data || []);
  if (data.length < 8 + 4 + 8 + 1) {
    throw new HttpsError('invalid-argument', 'Invalid deliver instruction data (too short)');
  }
  const disc = data.subarray(0, 8);
  if (!disc.equals(IX_DELIVER)) {
    throw new HttpsError('invalid-argument', 'Transaction is not a box_minter deliver instruction');
  }
  const deliveryId = data.readUInt32LE(8);
  const feeLamportsBig = data.readBigUInt64LE(12);
  if (feeLamportsBig > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new HttpsError('failed-precondition', 'delivery_fee_lamports is too large');
  }
  const feeLamports = Number(feeLamportsBig);
  const deliveryBump = data.readUInt8(20);
  return { deliveryId, feeLamports, deliveryBump };
}

function encodeCloseDeliveryArgs(args: { deliveryId: number; deliveryBump: number }): Buffer {
  const deliveryId = Number(args.deliveryId);
  const bump = Number(args.deliveryBump);
  if (!Number.isFinite(deliveryId) || deliveryId <= 0 || deliveryId > 0xffff_ffff) {
    throw new HttpsError('invalid-argument', 'Invalid deliveryId');
  }
  if (!Number.isFinite(bump) || bump < 0 || bump > 255) {
    throw new HttpsError('invalid-argument', 'Invalid delivery bump');
  }
  return Buffer.concat([IX_CLOSE_DELIVERY, u32LE(deliveryId), Buffer.from([bump & 0xff])]);
}

function isLegacySingletonConfigPda(programId: PublicKey, configPda: PublicKey): boolean {
  return configPda.equals(
    PublicKey.findProgramAddressSync([Buffer.from(BOX_MINTER_CONFIG_SEED)], programId)[0],
  );
}

function deriveDeliveryPda(
  programId: PublicKey,
  configPda: PublicKey,
  deliveryId: number,
): [PublicKey, number] {
  const seeds: Uint8Array[] = [Buffer.from('delivery')];
  if (!isLegacySingletonConfigPda(programId, configPda)) {
    seeds.push(configPda.toBuffer());
  }
  seeds.push(u32LE(deliveryId));
  return PublicKey.findProgramAddressSync(seeds, programId);
}

function deriveDeliveryPdaForDrop(
  dropRuntime: Pick<DropRuntime, 'boxMinterProgramId' | 'boxMinterConfigPda'>,
  deliveryId: number,
): [PublicKey, number] {
  return deriveDeliveryPda(dropRuntime.boxMinterProgramId, dropRuntime.boxMinterConfigPda, deliveryId);
}

function deriveTreeConfigPda(merkleTree: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([merkleTree.toBuffer()], BUBBLEGUM_PROGRAM_ID)[0];
}

function mplCoreTransferV1Ix(args: {
  asset: PublicKey;
  coreCollection: PublicKey;
  payer: PublicKey;
  authority: PublicKey;
  newOwner: PublicKey;
}) {
  return new TransactionInstruction({
    programId: MPL_CORE_PROGRAM_ID,
    keys: [
      { pubkey: args.asset, isSigner: false, isWritable: true }, // asset
      { pubkey: args.coreCollection, isSigner: false, isWritable: false }, // collection
      { pubkey: args.payer, isSigner: true, isWritable: true }, // payer
      { pubkey: args.authority, isSigner: true, isWritable: false }, // authority
      { pubkey: args.newOwner, isSigner: false, isWritable: false }, // new_owner
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, // system
      { pubkey: SPL_NOOP_PROGRAM_ID, isSigner: false, isWritable: false }, // log_wrapper
    ],
    // TransferV1 discriminator=14, compression_proof=None (0)
    data: Buffer.from([14, 0]),
  });
}

function mplCoreBurnV1Ix(args: { asset: PublicKey; coreCollection: PublicKey; authority: PublicKey; payer: PublicKey }) {
  return new TransactionInstruction({
    programId: MPL_CORE_PROGRAM_ID,
    keys: [
      { pubkey: args.asset, isSigner: false, isWritable: true }, // asset
      { pubkey: args.coreCollection, isSigner: false, isWritable: true }, // collection
      { pubkey: args.payer, isSigner: true, isWritable: true }, // payer
      { pubkey: args.authority, isSigner: true, isWritable: false }, // authority
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, // system
      { pubkey: SPL_NOOP_PROGRAM_ID, isSigner: false, isWritable: false }, // log_wrapper
    ],
    // BurnV1 discriminator=12, compression_proof=None (0)
    data: Buffer.from([12, 0]),
  });
}

function bs58Bytes32(value: string, label: string): Buffer {
  const text = String(value || '').trim();
  if (!text) {
    throw new HttpsError('failed-precondition', `Missing ${label}`);
  }
  let out: Uint8Array;
  try {
    out = bs58.decode(text);
  } catch (err) {
    throw new HttpsError('failed-precondition', `Invalid ${label} (base58 decode failed)`, {
      label,
      message: err instanceof Error ? err.message : String(err),
    });
  }
  if (out.length !== 32) {
    throw new HttpsError('failed-precondition', `Invalid ${label} length (expected 32 bytes)`, {
      label,
      bytes: out.length,
    });
  }
  return Buffer.from(out);
}

function bubblegumBurnV2Ix(args: {
  payer: PublicKey;
  authority: PublicKey;
  leafOwner: PublicKey;
  leafDelegate: PublicKey;
  merkleTree: PublicKey;
  coreCollection: PublicKey;
  root: Buffer; // 32 bytes
  dataHash: Buffer; // 32 bytes
  creatorHash: Buffer; // 32 bytes
  assetDataHash?: Buffer | null; // 32 bytes
  flags?: number | null; // u8
  nonce: number; // u64 (leaf_id)
  index: number; // u32
  proof: PublicKey[];
}) {
  const treeConfig = deriveTreeConfigPda(args.merkleTree);
  const nonce = Number(args.nonce);
  const index = Number(args.index);
  if (!Number.isFinite(nonce) || nonce < 0) {
    throw new HttpsError('failed-precondition', 'Invalid burn nonce');
  }
  if (!Number.isFinite(index) || index < 0) {
    throw new HttpsError('failed-precondition', 'Invalid burn index');
  }

  const root = Buffer.isBuffer(args.root) ? args.root : Buffer.from(args.root || []);
  const dataHash = Buffer.isBuffer(args.dataHash) ? args.dataHash : Buffer.from(args.dataHash || []);
  const creatorHash = Buffer.isBuffer(args.creatorHash) ? args.creatorHash : Buffer.from(args.creatorHash || []);
  if (root.length !== 32 || dataHash.length !== 32 || creatorHash.length !== 32) {
    throw new HttpsError('failed-precondition', 'Invalid burn hash lengths');
  }
  const assetDataHash = args.assetDataHash ? Buffer.from(args.assetDataHash) : null;
  if (assetDataHash && assetDataHash.length !== 32) {
    throw new HttpsError('failed-precondition', 'Invalid assetDataHash length');
  }
  const flagsNum = args.flags == null ? null : Number(args.flags);
  if (flagsNum != null && (!Number.isFinite(flagsNum) || flagsNum < 0 || flagsNum > 0xff)) {
    throw new HttpsError('failed-precondition', 'Invalid burn flags');
  }
  const proof = Array.isArray(args.proof) ? args.proof : [];

  const data = Buffer.concat([
    IX_BURN_V2,
    root,
    dataHash,
    creatorHash,
    borshOption(assetDataHash),
    borshOption(flagsNum == null ? null : Buffer.from([flagsNum & 0xff])),
    u64LE(nonce),
    u32LE(index),
  ]);

  return new TransactionInstruction({
    programId: BUBBLEGUM_PROGRAM_ID,
    keys: [
      { pubkey: treeConfig, isSigner: false, isWritable: true }, // treeConfig
      { pubkey: args.payer, isSigner: true, isWritable: true }, // payer
      { pubkey: args.authority, isSigner: true, isWritable: false }, // authority
      { pubkey: args.leafOwner, isSigner: false, isWritable: false }, // leafOwner
      { pubkey: args.leafDelegate, isSigner: false, isWritable: false }, // leafDelegate
      { pubkey: args.merkleTree, isSigner: false, isWritable: true }, // merkleTree
      { pubkey: args.coreCollection, isSigner: false, isWritable: true }, // coreCollection
      { pubkey: MPL_CORE_CPI_SIGNER, isSigner: false, isWritable: false }, // mplCoreCpiSigner
      { pubkey: MPL_NOOP_PROGRAM_ID, isSigner: false, isWritable: false }, // logWrapper
      { pubkey: MPL_ACCOUNT_COMPRESSION_PROGRAM_ID, isSigner: false, isWritable: false }, // compressionProgram
      { pubkey: MPL_CORE_PROGRAM_ID, isSigner: false, isWritable: false }, // mplCoreProgram
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, // systemProgram
      ...proof.map((pubkey) => ({ pubkey, isSigner: false, isWritable: false })),
    ],
    data,
  });
}

type DecodedBoxMinterConfig = {
  admin: PublicKey;
  treasury: PublicKey;
  coreCollection: PublicKey;
  maxSupply: number;
  maxPerTx: number;
  itemsPerBox: number;
  minted: number;
  started: boolean;
  discountMintsPerWallet: number;
  mintVariantKind: number;
  mintVariantStartIds: BoxMinterMintVariantTuple;
  mintVariantEndIds: BoxMinterMintVariantTuple;
  mintVariantNextIds: BoxMinterMintVariantTuple;
  uriBase: string;
  dropSeed?: Buffer;
};

function throwBoxMinterConfigHttpsError(error: BoxMinterConfigCodecError): never {
  switch (error.reason) {
    case 'config-truncated':
      throw new HttpsError(
        'failed-precondition',
        'Box minter config data is truncated.',
        error.details,
      );
    case 'invalid-items-per-box':
      throw new HttpsError(
        'failed-precondition',
        'On-chain config has invalid itemsPerBox',
        { itemsPerBox: error.details?.itemsPerBox },
      );
    case 'variant-data-truncated':
      throw new HttpsError(
        'failed-precondition',
        'Box minter config variant data is truncated',
      );
    case 'drop-seed-truncated':
      throw new HttpsError(
        'failed-precondition',
        'Box minter config drop seed data is truncated',
      );
    case 'unexpected-config-trailing-data':
      throw new HttpsError(
        'failed-precondition',
        'Unexpected trailing data after the box minter config payload',
      );
    case 'unexpected-drop-seed-trailing-data':
      throw new HttpsError(
        'failed-precondition',
        'Unexpected trailing data after the box minter drop seed',
      );
    default:
      throw error;
  }
}

function decodeBoxMinterConfigData(data: Buffer | Uint8Array): DecodedBoxMinterConfig {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  let decoded;
  try {
    decoded = decodeBoxMinterConfigDataShared(buf, { validateDiscriminator: false });
  } catch (error) {
    if (error instanceof BoxMinterConfigCodecError) {
      throwBoxMinterConfigHttpsError(error);
    }
    throw error;
  }

  const dropSeed = decoded.dropSeed ? Buffer.from(decoded.dropSeed) : undefined;
  return {
    admin: new PublicKey(decoded.admin),
    treasury: new PublicKey(decoded.treasury),
    coreCollection: new PublicKey(decoded.coreCollection),
    maxSupply: decoded.maxSupply,
    maxPerTx: decoded.maxPerTx,
    itemsPerBox: decoded.itemsPerBox,
    minted: decoded.minted,
    started: decoded.started,
    discountMintsPerWallet: decoded.discountMintsPerWallet,
    mintVariantKind: decoded.mintVariantKind,
    mintVariantStartIds: decoded.mintVariantStartIds,
    mintVariantEndIds: decoded.mintVariantEndIds,
    mintVariantNextIds: decoded.mintVariantNextIds,
    uriBase: decoded.uriBase,
    ...(dropSeed ? { dropSeed } : {}),
  };
}

async function fetchDecodedBoxMinterConfigAccount(params: {
  dropRuntime: DropRuntime;
  conn: Connection;
  context: string;
}): Promise<DecodedBoxMinterConfig> {
  const { dropRuntime, conn, context } = params;
  const cfgInfo = await withTimeout(
    conn.getAccountInfo(dropRuntime.boxMinterConfigPda, { commitment: 'confirmed' }),
    RPC_TIMEOUT_MS,
    context,
  );
  if (!cfgInfo?.data || cfgInfo.data.length < 8 + 32 * 3) {
    throw new HttpsError(
      'failed-precondition',
      'Box minter config PDA not found. Re-run `npm run deploy-all-onchain -- <dropId>`, update env, and redeploy.',
      { configPda: dropRuntime.boxMinterConfigPda.toBase58(), dropId: dropRuntime.dropId },
    );
  }
  return decodeBoxMinterConfigData(Buffer.from(cfgInfo.data));
}

function requireStripeCheckoutAvailable(params: {
  dropRuntime: DropRuntime;
  cfg: DecodedBoxMinterConfig;
  checkoutKind: StripeCheckoutKind;
  variantKey?: string;
  quantity: number;
}): void {
  const { dropRuntime, cfg, checkoutKind, variantKey } = params;
  let quantity: number;
  try {
    quantity = normalizeStripeCheckoutQuantity(params.quantity);
  } catch (err) {
    throw new HttpsError('invalid-argument', err instanceof Error ? err.message : 'Stripe checkout quantity is invalid.');
  }
  if (!cfg.started) {
    throw new HttpsError('failed-precondition', 'Mint has not started.');
  }
  if (cfg.minted + quantity > cfg.maxSupply) {
    throw new HttpsError('failed-precondition', 'Mint is sold out.');
  }
  if (quantity > cfg.maxPerTx) {
    throw new HttpsError('failed-precondition', `Stripe checkout quantity cannot exceed ${cfg.maxPerTx}.`);
  }

  if (checkoutKind === 'standard_pack') {
    if (isDirectDeliveryItemsPerBox(cfg.itemsPerBox) || cfg.mintVariantKind !== MINT_VARIANT_KIND_NONE) {
      throw new HttpsError('failed-precondition', 'Stripe pack checkout requires a non-variant pack drop.');
    }
    return;
  }

  if (!isDirectDeliveryItemsPerBox(cfg.itemsPerBox)) {
    throw new HttpsError('failed-precondition', 'Stripe checkout is only available for direct-delivery size drops.');
  }
  if (cfg.mintVariantKind !== MINT_VARIANT_KIND_SIZE) {
    throw new HttpsError('failed-precondition', 'Stripe checkout requires on-chain size variant minting.');
  }

  let variantIndex: number;
  try {
    variantIndex = resolveMintSelectionVariantIndex(dropRuntime.config.mintSelection, variantKey || '');
  } catch (err) {
    throw new HttpsError('invalid-argument', err instanceof Error ? err.message : String(err));
  }
  if (variantIndex < 0 || variantIndex >= MINT_VARIANT_OPTION_COUNT) {
    throw new HttpsError('invalid-argument', 'Invalid size variant.');
  }

  const option = dropRuntime.config.mintSelection?.options?.[variantIndex];
  const startId = cfg.mintVariantStartIds[variantIndex];
  const endId = cfg.mintVariantEndIds[variantIndex];
  if (!option || option.startId !== startId || option.endId !== endId) {
    throw new HttpsError('failed-precondition', 'Drop mint selection is out of sync with on-chain variant ranges.');
  }

  const nextId = cfg.mintVariantNextIds[variantIndex];
  if (nextId < startId) {
    throw new HttpsError('failed-precondition', 'On-chain size variant state is invalid.');
  }
  if (nextId > endId || nextId + quantity - 1 > endId) {
    throw new HttpsError('failed-precondition', 'Selected size is sold out.');
  }
}

function requireStripeCheckoutFulfillmentPrerequisites(cfg: DecodedBoxMinterConfig): void {
  let signer: Keypair;
  try {
    signer = cosigner();
  } catch (err) {
    throw new HttpsError('failed-precondition', 'COSIGNER_SECRET is not configured for Stripe checkout fulfillment', {
      error: summarizeError(err),
    });
  }
  if (!signer.publicKey.equals(cfg.admin)) {
    throw new HttpsError('failed-precondition', 'COSIGNER_SECRET does not match on-chain admin', {
      expectedAdmin: cfg.admin.toBase58(),
      cosigner: signer.publicKey.toBase58(),
    });
  }
  if (!addressDecryptKeyMaybe()) {
    throw new HttpsError(
      'failed-precondition',
      'ADDRESS_DECRYPTION_SECRET is not configured correctly for Stripe checkout fulfillment',
    );
  }
}

function requireStripeCheckoutCollectionMatchesConfig(
  dropRuntime: DropRuntime,
  cfg: DecodedBoxMinterConfig,
  code: 'failed-precondition' | 'unavailable' = 'failed-precondition',
): void {
  if (dropRuntime.collectionMint.equals(cfg.coreCollection)) return;
  throw new HttpsError(code, 'COLLECTION_MINT does not match on-chain config', {
    configured: dropRuntime.collectionMint.toBase58(),
    onchain: cfg.coreCollection.toBase58(),
    dropId: dropRuntime.dropId,
  });
}

function stripeCheckoutFlowDeps(): StripeCheckoutFlowDeps<DropRuntime, DecodedBoxMinterConfig & StripeCheckoutOnchainConfig> {
  return {
    requireDropId,
    getDropRuntime,
    connection,
    fetchCheckoutConfig: fetchDecodedBoxMinterConfigAccount,
    ensureOnchainCoreConfig,
    requireStripeCheckoutAvailable,
    requireStripeCheckoutFulfillmentPrerequisites,
    requireStripeCheckoutCollectionMatchesConfig,
    cosigner,
    encryptAddress: encryptAddressPayloadForFulfillment,
    normalizeCountryCode,
    buildTx,
    sendAndConfirmSignedTx,
    withTimeout,
    isAlreadyExistsError: isGrpcAlreadyExists,
    summarizeError,
    programs: {
      bubblegumProgramId: BUBBLEGUM_PROGRAM_ID,
      mplNoopProgramId: MPL_NOOP_PROGRAM_ID,
      mplAccountCompressionProgramId: MPL_ACCOUNT_COMPRESSION_PROGRAM_ID,
      mplCoreProgramId: MPL_CORE_PROGRAM_ID,
      mplCoreCpiSigner: MPL_CORE_CPI_SIGNER,
    },
    rpcTimeoutMs: RPC_TIMEOUT_MS,
    txSendTimeoutMs: TX_SEND_TIMEOUT_MS,
    txConfirmTimeoutMs: TX_CONFIRM_TIMEOUT_MS,
  };
}

function encodeMintReceiptsArgs(args: { boxIds: number[]; dudeIds: number[] }, dropRuntime: DropRuntime): Buffer {
  const boxIds = Array.isArray(args.boxIds) ? args.boxIds.map((n) => Number(n)) : [];
  const dudeIds = Array.isArray(args.dudeIds) ? args.dudeIds.map((n) => Number(n)) : [];

  boxIds.forEach((id) => {
    if (!Number.isFinite(id) || id < 1 || id > 0xffff_ffff) {
      throw new HttpsError('invalid-argument', `Invalid box id: ${id}`);
    }
  });
  dudeIds.forEach((id) => {
    if (!Number.isFinite(id) || id < 1 || id > dropRuntime.maxDudeId) {
      throw new HttpsError('invalid-argument', `Invalid dude id: ${id}`);
    }
  });

  return Buffer.concat([
    IX_MINT_RECEIPTS,
    u32LE(boxIds.length),
    ...boxIds.map((id) => u32LE(Math.floor(id))),
    u32LE(dudeIds.length),
    ...dudeIds.map((id) => u16LE(Math.floor(id))),
  ]);
}

function decodeDeliveryRecord(data: Buffer): {
  payer: PublicKey;
  deliveryFeeLamports: number;
  itemCount: number;
} {
  if (!Buffer.isBuffer(data)) data = Buffer.from(data || []);
  const expectedLen = 8 + 32 + 8 + 2;
  if (data.length < expectedLen) {
    throw new HttpsError('failed-precondition', 'Invalid DeliveryRecord account data (too short)');
  }
  const disc = data.subarray(0, 8);
  if (!disc.equals(ACCOUNT_DELIVERY_RECORD)) {
    throw new HttpsError('failed-precondition', 'Invalid DeliveryRecord account discriminator');
  }
  let o = 8;
  const payer = new PublicKey(data.subarray(o, o + 32));
  o += 32;
  const feeLamportsBig = data.readBigUInt64LE(o);
  if (feeLamportsBig > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new HttpsError('failed-precondition', 'delivery_fee_lamports is too large');
  }
  const deliveryFeeLamports = Number(feeLamportsBig);
  o += 8;
  const itemCount = data.readUInt16LE(o);
  return { payer, deliveryFeeLamports, itemCount };
}

async function assignDudes(dropId: string, boxAssetId: string): Promise<number[]> {
  return assignDudesForBox({
    db,
    dropRuntime: getDropRuntime(dropId),
    boxAssetId,
    logger,
    summarizeError,
  });
}

const CARD_NFT_2_UNREVEALED_DROP_ID = 'card_nft_2';

async function listCardNft2UnrevealedCardIds(
  rawRequest: unknown,
): Promise<ListCardNft2UnrevealedCardsResponse> {
  const request =
    rawRequest && typeof rawRequest === 'object'
      ? (rawRequest as ListCardNft2UnrevealedCardsRequest)
      : {};
  const dropRuntime = getDropRuntime(CARD_NFT_2_UNREVEALED_DROP_ID);
  if (dropRuntime.config.dropFamily !== 'card_nft_2') {
    throw new HttpsError('failed-precondition', 'Card NFT 2 drop config is invalid.');
  }

  const poolSnap = await db.doc(dropDudePoolPath(dropRuntime.dropId)).get();
  const rawPool = poolSnap.exists ? (poolSnap.data() as any)?.available : undefined;
  return paginateCardNft2UnrevealedCandidateIds({
    rawPool,
    limit: request.limit,
    cursor: request.cursor,
    maxCardId: dropRuntime.maxDudeId,
  });
}

function normalizeDropIdMaybe(rawDropId: unknown): string | null {
  if (typeof rawDropId !== 'string' || !rawDropId.trim()) return null;
  try {
    return normalizeDropId(rawDropId);
  } catch {
    return null;
  }
}

function dropIdFromBoxAssignmentPath(path: string): string | null {
  const parts = String(path || '').split('/');
  if (parts.length !== 4) return null;
  if (parts[0] !== 'drops' || parts[2] !== 'boxAssignments') return null;
  return normalizeDropIdMaybe(parts[1]);
}

async function resolveClaimDropIdForCode(code: string, claim: any): Promise<string> {
  const fromClaim = normalizeDropIdMaybe(claim?.dropId);
  if (fromClaim) return fromClaim;

  const byCodeSnap = await db.collectionGroup('boxAssignments').where('irlClaimCode', '==', code).limit(2).get();
  const dropIds = new Set<string>();
  byCodeSnap.docs.forEach((doc) => {
    const dropId = dropIdFromBoxAssignmentPath(doc.ref.path);
    if (dropId) dropIds.add(dropId);
  });
  if (dropIds.size === 1) return Array.from(dropIds)[0];
  if (dropIds.size > 1) {
    throw new HttpsError('failed-precondition', 'Claim code is linked to multiple drops; contact support.');
  }

  throw new HttpsError('failed-precondition', 'Claim code record is missing dropId and could not be resolved.');
}

async function ensureIrlClaimCodeForBox(params: {
  dropId: string;
  ownerWallet: string;
  deliveryId: number;
  boxAssetId: string;
  boxId: number;
  dudeIds: number[];
}): Promise<string> {
  return ensureIrlClaimCodeForBoxShared({
    db,
    dropRuntime: getDropRuntime(params.dropId),
    ownerWallet: params.ownerWallet,
    deliveryId: params.deliveryId,
    boxAssetId: params.boxAssetId,
    boxId: params.boxId,
    dudeIds: params.dudeIds,
    logger,
  });
}

type AdminIrlRedeemRequestItem =
  | {
      assetId: string;
      kind: 'box';
      refId: number;
    }
  | {
      assetId: string;
      kind: 'card_receipt';
      refId: number;
    };

function normalizeAdminIrlRedeemRequestItems(request: any): {
  itemIds: string[];
  items: AdminIrlRedeemRequestItem[];
  targetKind: AdminIrlRedeemTargetKind;
} {
  const itemsRaw = Array.isArray(request?.items) ? request.items : [];
  const items: AdminIrlRedeemRequestItem[] = itemsRaw
    .map((item: any) => {
      const assetId = typeof item?.assetId === 'string' ? item.assetId.trim() : '';
      const refId = Math.floor(Number(item?.refId));
      if (!assetId || !Number.isFinite(refId) || refId <= 0 || refId > 0xffff_ffff) return null;
      if (item?.kind === 'box') return { assetId, kind: 'box' as const, refId };
      if (item?.kind === 'card_receipt') return { assetId, kind: 'card_receipt' as const, refId };
      return null;
    })
    .filter((item: AdminIrlRedeemRequestItem | null): item is AdminIrlRedeemRequestItem => Boolean(item));
  if (!itemsRaw.length || items.length !== itemsRaw.length) {
    throw new HttpsError('failed-precondition', 'Admin IRL redeem request is missing selected items');
  }

  const targetKinds = new Set(items.map((item) => (item.kind === 'box' ? 'pack' : 'card_receipt')));
  if (targetKinds.size !== 1) {
    throw new HttpsError('failed-precondition', 'Admin IRL redeem request cannot mix packs and card receipts');
  }
  const targetKind = Array.from(targetKinds)[0] as AdminIrlRedeemTargetKind;
  const storedTargetKind = request?.targetKind === 'card_receipt' ? 'card_receipt' : 'pack';
  if (storedTargetKind !== targetKind) {
    throw new HttpsError('failed-precondition', 'Admin IRL redeem request target kind mismatch');
  }
  const targetEligibility = getAdminIrlRedeemTargetEligibility({
    targetKind,
    itemCount: items.length,
  });
  if ('reason' in targetEligibility && targetEligibility.reason === 'invalid-card-receipt-count') {
    throw new HttpsError('failed-precondition', 'Admin IRL redeem supports one card receipt at a time');
  }

  const itemIds = items.map((item) => item.assetId);
  if (new Set(itemIds).size !== itemIds.length) {
    throw new HttpsError('failed-precondition', 'Admin IRL redeem request contains duplicate selected items');
  }
  const refIds = items.map((item) => item.refId);
  if (new Set(refIds).size !== refIds.length) {
    throw new HttpsError('failed-precondition', 'Admin IRL redeem request contains duplicate item ids');
  }

  const storedItemIds = Array.isArray(request?.itemIds)
    ? request.itemIds.map((id: any) => (typeof id === 'string' ? id.trim() : '')).filter(Boolean)
    : [];
  if (!storedItemIds.length || storedItemIds.length !== itemIds.length) {
    throw new HttpsError('failed-precondition', 'Admin IRL redeem request selected item mismatch');
  }
  const mismatchIndex = storedItemIds.findIndex((assetId: string, index: number) => assetId !== itemIds[index]);
  if (mismatchIndex >= 0) {
    throw new HttpsError('failed-precondition', 'Admin IRL redeem request selected item mismatch', {
      index: mismatchIndex,
    });
  }

  return { itemIds, items, targetKind };
}

type AdminIrlRedeemStartedRequest = {
  requestId: string;
  dropId: string;
  owner: string;
  targetKind: AdminIrlRedeemTargetKind;
  itemIds: string[];
  items: AdminIrlRedeemRequestItem[];
  receiptTxs: string[];
  internalDeliveryId?: number;
  internalDeliveryPda?: string;
  internalDeliveryTx?: string;
  closeDeliveryTx?: string;
};

type AdminIrlInternalDeliveryResult = {
  deliveryId: number;
  deliveryPda: string;
  deliveryTx: string | null;
};

type CompletedAdminIrlRedeemResponseBox = {
  boxId: number;
  receiptAssetId?: string;
  claimCode?: string;
  dudeIds?: number[];
};

type CompletedAdminIrlRedeemResponseCard = {
  figureId: number;
  receiptAssetId: string;
  claimCode?: string;
};

function requireAdminIrlRedeemRequestId(rawRequestId: unknown): string {
  const requestId = String(rawRequestId || '').trim();
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(requestId)) {
    throw new HttpsError('invalid-argument', 'Invalid admin IRL redeem request id');
  }
  return requestId;
}

function requireCardNft2AdminIrlRedeemDrop(dropRuntime: DropRuntime): void {
  const unsupportedReason = getAdminIrlRedeemUnsupportedReason({
    dropFamily: dropRuntime.config.dropFamily,
    itemsPerBox: dropRuntime.itemsPerBox,
    sharesCollectionMint: clusterSharesCollectionMint(dropRuntime),
  });
  if (unsupportedReason) throw new HttpsError('failed-precondition', unsupportedReason);
}

function pendingOpenPdaForBox(dropRuntime: DropRuntime, boxAsset: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(BOX_MINTER_PENDING_OPEN_SEED), boxAsset.toBuffer()],
    dropRuntime.boxMinterProgramId,
  )[0];
}

function normalizeAdminIrlResponseDudeIds(raw: unknown): number[] {
  return Array.isArray(raw)
    ? raw.map((id: any) => Math.floor(Number(id))).filter((id: number) => Number.isFinite(id) && id > 0)
    : [];
}

function normalizeCompletedAdminIrlRedeemBox(box: any): CompletedAdminIrlRedeemResponseBox | null {
  const boxId = Math.floor(Number(box?.boxId));
  if (!Number.isFinite(boxId) || boxId <= 0) return null;
  const receiptAssetId = typeof box?.receiptAssetId === 'string' ? box.receiptAssetId : undefined;
  const claimCode = typeof box?.claimCode === 'string' ? normalizeStripeReceiptClaimCode(box.claimCode) : undefined;
  const dudeIds = normalizeAdminIrlResponseDudeIds(box?.dudeIds);
  return {
    boxId,
    ...(receiptAssetId ? { receiptAssetId } : {}),
    ...(claimCode ? { claimCode } : {}),
    ...(dudeIds.length ? { dudeIds } : {}),
  };
}

function normalizeCompletedAdminIrlRedeemCard(card: any): CompletedAdminIrlRedeemResponseCard | null {
  const figureId = Math.floor(Number(card?.figureId));
  const receiptAssetId = typeof card?.receiptAssetId === 'string' ? card.receiptAssetId.trim() : '';
  if (!Number.isFinite(figureId) || figureId <= 0 || !receiptAssetId) return null;
  const claimCode = typeof card?.claimCode === 'string' ? normalizeStripeReceiptClaimCode(card.claimCode) : undefined;
  return { figureId, receiptAssetId, ...(claimCode ? { claimCode } : {}) };
}

function adminIrlRedeemCompleteResponse(params: {
  dropId: string;
  requestId: string;
  request: any;
}): {
  processed: true;
  dropId: string;
  requestId: string;
  deliveryId?: number;
  receiptTxs: string[];
  claimCodes: string[];
  boxes: CompletedAdminIrlRedeemResponseBox[];
  cards: CompletedAdminIrlRedeemResponseCard[];
} {
  const request = params.request || {};
  return {
    processed: true,
    dropId: params.dropId,
    requestId: params.requestId,
    ...(Number.isFinite(Number(request.deliveryId)) ? { deliveryId: Math.floor(Number(request.deliveryId)) } : {}),
    receiptTxs: normalizeReceiptTxs(request.receiptTxs),
    claimCodes: Array.isArray(request.claimCodes)
      ? request.claimCodes.map((code: any) => normalizeStripeReceiptClaimCode(code)).filter(Boolean)
      : [],
    boxes: Array.isArray(request.boxes)
      ? request.boxes
          .map(normalizeCompletedAdminIrlRedeemBox)
          .filter((box): box is CompletedAdminIrlRedeemResponseBox => Boolean(box))
      : [],
    cards: Array.isArray(request.cards)
      ? request.cards
          .map(normalizeCompletedAdminIrlRedeemCard)
          .filter((card): card is CompletedAdminIrlRedeemResponseCard => Boolean(card))
      : [],
  };
}

function adminIrlRedeemPreparedExpiresAt(nowMs = Date.now()): Timestamp {
  return Timestamp.fromMillis(nowMs + ADMIN_IRL_REDEEM_PREPARED_TTL_MS);
}

function generateAdminIrlReceiptClaimCodes(quantity: number): string[] {
  const normalizedQuantity = Math.floor(Number(quantity));
  if (!Number.isFinite(normalizedQuantity) || normalizedQuantity <= 0 || normalizedQuantity > MAX_DELIVERY_ITEMS) {
    throw new HttpsError('invalid-argument', 'Invalid receipt claim code quantity');
  }
  return generateUniqueStripeReceiptClaimCodes(normalizedQuantity);
}

function adminIrlRedeemMarkerConflict(reason?: string): HttpsError {
  return new HttpsError('failed-precondition', 'One or more selected items already have Admin IRL claim codes', {
    ...(reason ? { reason } : {}),
  });
}

function adminIrlRedeemSelectionKeyForRequest(dropId: string, request: AdminIrlRedeemStartedRequest): string {
  return buildAdminIrlRedeemSelectionKey({
    dropId,
    originalAssetIds: request.items.map((item) => item.assetId),
  });
}

function adminIrlRedeemSelectionKeyForBoxes(dropId: string, boxes: readonly AdminIrlRedeemBoxBaseInput[]): string {
  return buildAdminIrlRedeemSelectionKey({
    dropId,
    originalAssetIds: boxes.map((box) => box.originalAssetId),
  });
}

function adminIrlRedeemMarkerRefs(params: {
  dropId: string;
  boxes: ReadonlyArray<{ originalAssetId: string; receiptAssetId?: string }>;
}): DocumentReference[] {
  const refs = new Map<string, DocumentReference>();
  const addRef = (ref: DocumentReference) => refs.set(ref.path, ref);
  params.boxes.forEach((box) => {
    addRef(db.doc(dropAdminIrlRedeemPackMarkerPath(params.dropId, box.originalAssetId)));
    if (box.receiptAssetId) addRef(db.doc(dropAdminIrlRedeemReceiptMarkerPath(params.dropId, box.receiptAssetId)));
  });
  return Array.from(refs.values());
}

async function resolveAdminIrlRedeemMarkerReuseInTransaction(params: {
  tx: FirebaseFirestore.Transaction;
  dropId: string;
  selectionKey: string;
  boxes: ReadonlyArray<{ originalAssetId: string; receiptAssetId?: string }>;
}): Promise<AdminIrlRedeemMarkerReuseResolution> {
  const markerRefs = adminIrlRedeemMarkerRefs({ dropId: params.dropId, boxes: params.boxes });
  const markerSnaps = await Promise.all(markerRefs.map((ref) => params.tx.get(ref)));
  return resolveAdminIrlRedeemMarkerReuse({
    dropId: params.dropId,
    selectionKey: params.selectionKey,
    originalAssetIds: params.boxes.map((box) => box.originalAssetId),
    markers: markerSnaps.map((snap) => (snap.exists ? (snap.data() as Record<string, unknown>) : null)),
  });
}

function adminIrlRedeemDudeIdsByBoxId(order: any): Map<number, number[]> {
  const byBoxId = new Map<number, number[]>();
  const claimsRaw = Array.isArray(order?.irlClaims) ? order.irlClaims : [];
  for (const claim of claimsRaw) {
    const boxId = Math.floor(Number(claim?.boxId));
    if (!Number.isFinite(boxId) || boxId <= 0) continue;
    byBoxId.set(boxId, normalizeAdminIrlResponseDudeIds(claim?.dudeIds));
  }
  return byBoxId;
}

async function completeAdminIrlRedeemRequestFromMarkerReuse(params: {
  tx: FirebaseFirestore.Transaction;
  requestRef: DocumentReference;
  request: any;
  dropId: string;
  resolution: Extract<AdminIrlRedeemMarkerReuseResolution, { status: 'reuse' }>;
}): Promise<any> {
  const orderRef = db.doc(dropDeliveryOrderPath(params.dropId, params.resolution.deliveryId));
  const orderSnap = await params.tx.get(orderRef);
  if (!orderSnap.exists) {
    throw adminIrlRedeemMarkerConflict('marker delivery order missing');
  }
  const order = orderSnap.data() as any;
  if (order?.source !== ADMIN_IRL_REDEEM_DELIVERY_ORDER_SOURCE) {
    throw adminIrlRedeemMarkerConflict('marker delivery order source mismatch');
  }
  const requestReceiptTxs = normalizeReceiptTxs(params.request?.receiptTxs);
  const existingReceiptTxs = normalizeReceiptTxs(order?.receiptTxs);
  const receiptTxs = Array.from(new Set([...existingReceiptTxs, ...requestReceiptTxs]));
  const dudeIdsByBoxId = adminIrlRedeemDudeIdsByBoxId(order);
  const boxes = params.resolution.boxes.map((box) => ({
    boxId: box.boxId,
    originalAssetId: box.originalAssetId,
    receiptAssetId: box.receiptAssetId,
    claimCode: box.claimCode,
    dudeIds: dudeIdsByBoxId.get(box.boxId) || [],
  }));
  const completedRequest = {
    ...params.request,
    status: 'complete',
    deliveryId: params.resolution.deliveryId,
    receiptTxs,
    claimCodes: params.resolution.claimCodes,
    boxes,
    duplicateOfRequestId: params.resolution.requestId,
  };
  params.tx.set(
    params.requestRef,
    {
      status: 'complete',
      deliveryId: params.resolution.deliveryId,
      receiptTxs,
      claimCodes: params.resolution.claimCodes,
      boxes,
      duplicateOfRequestId: params.resolution.requestId,
      processingAttemptId: FieldValue.delete(),
      processingStartedAt: FieldValue.delete(),
      processingLeaseExpiresAt: FieldValue.delete(),
      preparedExpiresAt: FieldValue.delete(),
      completedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );
  return completedRequest;
}

async function completeAdminIrlRedeemFromExistingMarkers(params: {
  requestRef: DocumentReference;
  attemptId: string;
  dropRuntime: DropRuntime;
  request: AdminIrlRedeemStartedRequest;
}): Promise<ReturnType<typeof adminIrlRedeemCompleteResponse> | null> {
  const selectionKey = adminIrlRedeemSelectionKeyForRequest(params.dropRuntime.dropId, params.request);
  const result = await db.runTransaction(async (tx) => {
    const requestSnap = await tx.get(params.requestRef);
    if (!requestSnap.exists) throw new HttpsError('not-found', 'Admin IRL redeem request not found');
    const request = requestSnap.data() as any;
    if (request?.status === 'complete') return { status: 'complete' as const, request };
    if (request?.status !== 'processing' || request?.processingAttemptId !== params.attemptId) {
      throw new HttpsError('aborted', 'Admin IRL redeem processing lease changed');
    }

    const resolution = await resolveAdminIrlRedeemMarkerReuseInTransaction({
      tx,
      dropId: params.dropRuntime.dropId,
      selectionKey,
      boxes: params.request.items.map((item) => ({ originalAssetId: item.assetId })),
    });
    if (resolution.status === 'none') return { status: 'none' as const };
    if (resolution.status === 'conflict') throw adminIrlRedeemMarkerConflict(resolution.reason);
    const completedRequest = await completeAdminIrlRedeemRequestFromMarkerReuse({
      tx,
      requestRef: params.requestRef,
      request,
      dropId: params.dropRuntime.dropId,
      resolution,
    });
    return { status: 'complete' as const, request: completedRequest };
  });

  if (result.status === 'none') return null;
  return adminIrlRedeemCompleteResponse({
    dropId: params.dropRuntime.dropId,
    requestId: params.request.requestId,
    request: result.request,
  });
}

async function startAdminIrlRedeemFinalize(params: {
  requestRef: DocumentReference;
  dropId: string;
  requestId: string;
  wallet: string;
  transferSignature: string;
  attemptId: string;
  nowMs: number;
}): Promise<
  | { status: 'complete'; request: any }
  | { status: 'started'; request: AdminIrlRedeemStartedRequest }
> {
  const leaseExpiresAt = Timestamp.fromMillis(params.nowMs + ADMIN_IRL_REDEEM_PROCESSING_LEASE_MS);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(params.requestRef);
    if (!snap.exists) throw new HttpsError('not-found', 'Admin IRL redeem request not found');
    const request = snap.data() as any;
    if (request?.dropId !== params.dropId) {
      throw new HttpsError('failed-precondition', 'Admin IRL redeem request drop mismatch');
    }
    const owner = normalizeWallet(request?.owner);
    if (owner !== params.wallet) {
      throw new HttpsError('permission-denied', 'Only the requesting admin wallet can finalize this Admin IRL redeem.');
    }
    if (request?.status === 'complete') {
      return { status: 'complete' as const, request };
    }

    const processingLeaseExpiresAt = toMillisMaybe(request?.processingLeaseExpiresAt) ?? 0;
    if (request?.status === 'processing' && processingLeaseExpiresAt > params.nowMs) {
      throw new HttpsError('aborted', 'This Admin IRL redeem request is already being finalized');
    }

    const { itemIds, items, targetKind } = normalizeAdminIrlRedeemRequestItems(request);
    const receiptTxs = normalizeReceiptTxs(request?.receiptTxs);
    const internalDeliveryIdRaw = Math.floor(Number(request?.internalDeliveryId));
    const internalDeliveryId = Number.isFinite(internalDeliveryIdRaw) && internalDeliveryIdRaw > 0 ? internalDeliveryIdRaw : undefined;
    const internalDeliveryPda = typeof request?.internalDeliveryPda === 'string' ? request.internalDeliveryPda.trim() : '';
    const internalDeliveryTx = typeof request?.internalDeliveryTx === 'string' ? request.internalDeliveryTx.trim() : '';
    const closeDeliveryTx = typeof request?.closeDeliveryTx === 'string' ? request.closeDeliveryTx.trim() : '';

    tx.set(
      params.requestRef,
      {
        status: 'processing',
        transferSignature: params.transferSignature,
        processingAttemptId: params.attemptId,
        processingStartedAt: FieldValue.serverTimestamp(),
        processingLeaseExpiresAt: leaseExpiresAt,
        preparedExpiresAt: FieldValue.delete(),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );

    return {
      status: 'started' as const,
      request: {
        requestId: params.requestId,
        dropId: params.dropId,
        owner,
        targetKind,
        itemIds,
        items,
        receiptTxs,
        ...(internalDeliveryId ? { internalDeliveryId } : {}),
        ...(internalDeliveryPda ? { internalDeliveryPda } : {}),
        ...(internalDeliveryTx ? { internalDeliveryTx } : {}),
        ...(closeDeliveryTx ? { closeDeliveryTx } : {}),
      },
    };
  });
}

async function clearAdminIrlRedeemFinalizeProcessing(params: {
  requestRef: DocumentReference;
  attemptId: string;
  err: unknown;
}): Promise<void> {
  await db
    .runTransaction(async (tx) => {
      const snap = await tx.get(params.requestRef);
      if (!snap.exists) return;
      const request = snap.data() as any;
      if (request?.status !== 'processing' || request?.processingAttemptId !== params.attemptId) return;
      tx.set(
        params.requestRef,
        {
          status: 'prepared',
          lastFinalizeError: summarizeError(params.err),
          lastFinalizeErrorAt: FieldValue.serverTimestamp(),
          processingAttemptId: FieldValue.delete(),
          processingStartedAt: FieldValue.delete(),
          processingLeaseExpiresAt: FieldValue.delete(),
          preparedExpiresAt: adminIrlRedeemPreparedExpiresAt(),
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
    })
    .catch((cleanupErr) => {
      logger.warn('adminIrlRedeem:cleanup_failed', { error: summarizeError(cleanupErr) });
    });
}

function compiledInstructionAccounts(ix: any, keys: PublicKey[]): PublicKey[] {
  const accountKeyIndexesRaw: any = ix?.accountKeyIndexes;
  const accountKeyIndexes: number[] = Array.isArray(accountKeyIndexesRaw)
    ? accountKeyIndexesRaw
    : Array.from(accountKeyIndexesRaw || []);
  return accountKeyIndexes.map((idx: number) => keys[idx]).filter((key: PublicKey | undefined): key is PublicKey => Boolean(key));
}

function compiledInstructionData(ix: any): Buffer {
  const dataField = ix?.data;
  return typeof dataField === 'string' ? Buffer.from(bs58.decode(dataField)) : Buffer.from(dataField || []);
}

function bubblegumV2LeafAssetIdsFromTransaction(tx: any): string[] {
  const keys = resolveInstructionAccounts(tx);
  const assetIds = new Set<string>();
  for (const group of tx?.meta?.innerInstructions || []) {
    for (const ix of group?.instructions || []) {
      const program = keys[ix.programIdIndex];
      if (!program?.equals(MPL_NOOP_PROGRAM_ID)) continue;

      const data = compiledInstructionData(ix);
      // AccountCompressionEvent::ApplicationData(V1) wraps a Bubblegum
      // LeafSchemaEvent. All three Borsh enum variants are 1 for a V2 leaf.
      if (
        data.length < 41 ||
        data[0] !== 1 ||
        data[1] !== 0 ||
        data.readUInt32LE(2) !== data.length - 6
      ) {
        continue;
      }
      if (data[6] !== 1 || data[7] !== 1 || data[8] !== 1) continue;
      assetIds.add(new PublicKey(data.subarray(9, 41)).toBase58());
    }
  }
  return Array.from(assetIds);
}

async function verifyAdminIrlRedeemTransferSignature(params: {
  conn: Connection;
  dropRuntime: DropRuntime;
  signature: string;
  ownerWallet: string;
  adminWallet: string;
  coreCollection: PublicKey;
  itemIds: string[];
}): Promise<void> {
  const tx = await withTimeout(
    params.conn.getTransaction(params.signature, { maxSupportedTransactionVersion: 0 }),
    RPC_TIMEOUT_MS,
    'getTransaction:adminIrlRedeemTransfer',
  );
  if (!tx) {
    throw new HttpsError('unavailable', 'Admin IRL redeem transfer transaction not found yet; retry shortly');
  }
  if (tx.meta?.err) {
    throw new HttpsError('failed-precondition', 'Admin IRL redeem transfer transaction failed', {
      err: tx.meta.err,
    });
  }
  const payer = getPayerFromTx(tx);
  if (!payer || payer.toBase58() !== params.ownerWallet) {
    throw new HttpsError('failed-precondition', 'Admin IRL redeem transfer payer does not match requester');
  }

  const keys = resolveInstructionAccounts(tx);
  const transferredAssets: string[] = [];
  for (const ix of tx?.transaction?.message?.compiledInstructions || []) {
    const program = keys[ix.programIdIndex];
    if (!program || !program.equals(MPL_CORE_PROGRAM_ID)) continue;
    const data = compiledInstructionData(ix);
    if (data[0] !== 14 || data[1] !== 0) continue;
    const accounts = compiledInstructionAccounts(ix, keys);
    if (accounts.length < 7) continue;
    const [asset, collection, payerAccount, authority, newOwner] = accounts;
    if (!collection?.equals(params.coreCollection)) continue;
    if (payerAccount?.toBase58() !== params.ownerWallet) continue;
    if (authority?.toBase58() !== params.ownerWallet) continue;
    if (newOwner?.toBase58() !== params.adminWallet) continue;
    if (asset) transferredAssets.push(asset.toBase58());
  }

  if (transferredAssets.length !== params.itemIds.length) {
    throw new HttpsError('failed-precondition', 'Admin IRL redeem transfer item count mismatch', {
      expected: params.itemIds.length,
      got: transferredAssets.length,
    });
  }
  params.itemIds.forEach((expected, index) => {
    if (transferredAssets[index] !== expected) {
      throw new HttpsError('failed-precondition', 'Admin IRL redeem transfer asset mismatch', {
        index,
        expected,
        got: transferredAssets[index],
      });
    }
  });
}

async function verifyDirectCardReceiptTransferSignature(params: {
  conn: Connection;
  dropRuntime: DropRuntime;
  signature: string;
  fromWallet: string;
  toWallet: string;
  coreCollection: PublicKey;
  receiptAssetId: string;
  rpcLabel: string;
}): Promise<void> {
  const tx = await withTimeout(
    params.conn.getTransaction(params.signature, { maxSupportedTransactionVersion: 0 }),
    RPC_TIMEOUT_MS,
    params.rpcLabel,
  );
  if (!tx) throw new HttpsError('unavailable', 'Card receipt transfer transaction not found yet; retry shortly');
  if (tx.meta?.err) {
    throw new HttpsError('failed-precondition', 'Card receipt transfer transaction failed', { err: tx.meta.err });
  }
  const payer = getPayerFromTx(tx);
  if (!payer || payer.toBase58() !== params.fromWallet) {
    throw new HttpsError('failed-precondition', 'Card receipt transfer payer does not match sender');
  }

  const keys = resolveInstructionAccounts(tx);
  let matchingTransfers = 0;
  for (const ix of tx?.transaction?.message?.compiledInstructions || []) {
    const program = keys[ix.programIdIndex];
    if (!program?.equals(BUBBLEGUM_PROGRAM_ID)) continue;
    const data = compiledInstructionData(ix);
    if (!data.subarray(0, IX_BUBBLEGUM_TRANSFER_V2.length).equals(IX_BUBBLEGUM_TRANSFER_V2)) continue;
    const accounts = compiledInstructionAccounts(ix, keys);
    if (accounts.length < 8) continue;
    const [, transferPayer, authority, leafOwner, , newOwner, merkleTree, collection] = accounts;
    if (transferPayer?.toBase58() !== params.fromWallet) continue;
    if (authority?.toBase58() !== params.fromWallet) continue;
    if (leafOwner?.toBase58() !== params.fromWallet) continue;
    if (newOwner?.toBase58() !== params.toWallet) continue;
    if (!merkleTree?.equals(params.dropRuntime.receiptsMerkleTree)) continue;
    if (!collection?.equals(params.coreCollection)) continue;
    matchingTransfers += 1;
  }
  if (matchingTransfers !== 1) {
    throw new HttpsError('failed-precondition', 'Card receipt transfer instruction mismatch', {
      expected: 1,
      got: matchingTransfers,
    });
  }
  const transferredAssetIds = bubblegumV2LeafAssetIdsFromTransaction(tx);
  if (transferredAssetIds.length !== 1 || transferredAssetIds[0] !== params.receiptAssetId) {
    throw new HttpsError('failed-precondition', 'Card receipt transfer asset mismatch', {
      expected: params.receiptAssetId,
      got: transferredAssetIds,
    });
  }
}

async function mintAdminIrlPackReceipts(params: {
  conn: Connection;
  dropRuntime: DropRuntime;
  signer: Keypair;
  coreCollection: PublicKey;
  items: AdminIrlRedeemRequestItem[];
  requestRef: DocumentReference;
  existingReceiptTxs?: string[];
}): Promise<string[]> {
  const targetAssetPks = params.items.map((item) => new PublicKey(item.assetId));
  const infos = await withTimeout(
    params.conn.getMultipleAccountsInfo(targetAssetPks, { commitment: 'confirmed', dataSlice: { offset: 0, length: 2 } }),
    RPC_TIMEOUT_MS,
    'getMultipleAccountsInfo:adminIrlRedeemPacks',
  );
  const pending = params.items
    // MPL Core leaves a one-byte tombstone account after Burn. Only accounts
    // with asset data beyond that tombstone still need receipt processing.
    .map((item, index) => ({
      ...item,
      assetPk: targetAssetPks[index],
      exists: Boolean(infos[index] && infos[index].data.length > 1),
    }))
    .filter((item) => item.exists);
  const receiptTxs: string[] = Array.from(new Set(normalizeReceiptTxs(params.existingReceiptTxs)));
  const recordReceiptProgress = async (sig: string, processedCount: number) => {
    if (sig && !receiptTxs.includes(sig)) receiptTxs.push(sig);
    pending.splice(0, processedCount);
    await params.requestRef.set(
      {
        receiptTxs,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
  };

  while (pending.length) {
    let n = Math.min(pending.length, 3);
    let lastErr: unknown = null;
    while (n >= 1) {
      const batch = pending.slice(0, n);
      const batchAssetPks = batch.map((item) => item.assetPk);
      const batchAssetsWereBurned = async (context: string) => {
        const postInfos = await withTimeout(
          params.conn.getMultipleAccountsInfo(batchAssetPks, {
            commitment: 'confirmed',
            dataSlice: { offset: 0, length: 2 },
          }),
          RPC_TIMEOUT_MS,
          context,
        );
        return postInfos.every((accountInfo) => !accountInfo || accountInfo.data.length <= 1);
      };
      const instructions: TransactionInstruction[] = [
        ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
        ...batch.map((item) =>
          mplCoreBurnV1Ix({
            asset: item.assetPk,
            coreCollection: params.coreCollection,
            authority: params.signer.publicKey,
            payer: params.signer.publicKey,
          }),
        ),
        buildMintReceiptsIx({
          dropRuntime: params.dropRuntime,
          cosignerPk: params.signer.publicKey,
          recipientPk: params.signer.publicKey,
          coreCollection: params.coreCollection,
          boxIds: batch.map((item) => item.refId),
          dudeIds: [],
        }),
      ];

      let succeeded = false;
      for (let attempt = 0; attempt < Math.max(1, TX_MAX_SEND_ATTEMPTS); attempt += 1) {
        const { blockhash } = await withTimeout(
          params.conn.getLatestBlockhash('confirmed'),
          RPC_TIMEOUT_MS,
          'getLatestBlockhash:adminIrlRedeemReceipts',
        );
        let txCandidate: VersionedTransaction;
        let rawLen = 0;
        try {
          txCandidate = buildTx(instructions, params.signer.publicKey, blockhash, [params.signer]);
          rawLen = txCandidate.serialize().length;
          if (rawLen > SOLANA_MAX_RAW_TX_BYTES) {
            lastErr = new RangeError(`Admin IRL redeem receipt transaction too large (${rawLen} bytes)`);
            break;
          }
        } catch (err) {
          if (!transactionEncodingTooLarge(err)) throw err;
          lastErr = err;
          break;
        }

        const sig = bs58.encode(txCandidate.signatures[0]);
        let sendErr: unknown = null;
        try {
          await withTimeout(
            params.conn.sendTransaction(txCandidate, { maxRetries: 2 }),
            TX_SEND_TIMEOUT_MS,
            'sendTransaction:adminIrlRedeemReceipts',
          );
        } catch (err) {
          sendErr = err;
        }

        if (sendErr) {
          const msg = txErrMessage(sendErr);
          const logs = txErrLogs(sendErr);
          lastErr = sendErr;
          if (logs.length && !(looksLikeAccountInUseError(msg, logs) || looksLikeRateLimitOrRpcError(msg) || looksLikeBlockhashError(msg))) {
            break;
          }
          const maybe = await waitForSignature(params.conn, sig, { timeoutMs: 12_000, pollMs: TX_CONFIRM_POLL_MS });
          if (maybe.ok) {
            await recordReceiptProgress(sig, n);
            succeeded = true;
            break;
          }
          if (await batchAssetsWereBurned('getMultipleAccountsInfo:adminIrlRedeemPostSend')) {
            await recordReceiptProgress(sig, n);
            succeeded = true;
            break;
          }
          await sleep(Math.min(600 * 2 ** Math.min(attempt, 4), 4_000));
          continue;
        }

        const confirmed = await waitForSignature(params.conn, sig, { timeoutMs: TX_CONFIRM_TIMEOUT_MS, pollMs: TX_CONFIRM_POLL_MS });
        if (confirmed.ok) {
          await recordReceiptProgress(sig, n);
          succeeded = true;
          break;
        }

        if (await batchAssetsWereBurned('getMultipleAccountsInfo:adminIrlRedeemPostConfirm')) {
          await recordReceiptProgress(sig, n);
          succeeded = true;
          break;
        }

        lastErr = (confirmed as { ok: false; err: any }).err;
        await sleep(Math.min(600 * 2 ** Math.min(attempt, 4), 4_000));
      }

      if (succeeded) break;
      n -= 1;
    }

    if (n < 1) {
      throw new HttpsError('failed-precondition', 'Unable to mint Admin IRL redeem pack receipts', {
        lastError: txErrMessage(lastErr),
        lastLogs: txErrLogs(lastErr).slice(0, 80),
      });
    }
  }

  return receiptTxs;
}

async function collectReceiptAssetsOwnedByBoxId(params: {
  ownerWallet: string;
  dropRuntime: DropRuntime;
  boxIds: Set<number>;
  grouping?: readonly [string, string];
}): Promise<{ byBoxId: Map<number, any[]>; sawItems: boolean }> {
  const byBoxId = new Map<number, any[]>();
  const visit = (asset: any) => {
    const rawBoxId = Number(getBoxIdFromAsset(asset));
    const boxId = Math.floor(rawBoxId);
    if (!Number.isFinite(boxId) || !params.boxIds.has(boxId)) return false;
    if (!stripeReceiptAssetMatches(asset, params.dropRuntime, boxId, params.ownerWallet)) return false;
    const entries = byBoxId.get(boxId) || [];
    if (!entries.some((entry) => String(entry?.id || '') === String(asset?.id || ''))) entries.push(asset);
    byBoxId.set(boxId, entries);
    return false;
  };
  const result = await scanOwnedAssets({
    owner: params.ownerWallet,
    dropRuntime: params.dropRuntime,
    grouping: params.grouping,
    label: 'Helius admin IRL redeem receipt assets error',
    visit,
  });
  return { byBoxId, sawItems: result.sawItems };
}

async function findAdminIrlReceiptAssets(params: {
  ownerWallet: string;
  dropRuntime: DropRuntime;
  boxIds: number[];
}): Promise<Map<number, any[]>> {
  if (clusterSharesCollectionMint(params.dropRuntime)) return new Map<number, any[]>();

  const mergeReceiptAssetMaps = (left: Map<number, any[]>, right: Map<number, any[]>): Map<number, any[]> => {
    const merged = new Map<number, any[]>();
    const add = (boxId: number, asset: any) => {
      const assetId = String(asset?.id || '');
      if (!assetId) return;
      const entries = merged.get(boxId) || [];
      if (!entries.some((entry) => String(entry?.id || '') === assetId)) entries.push(asset);
      merged.set(boxId, entries);
    };
    left.forEach((assets, boxId) => assets.forEach((asset) => add(boxId, asset)));
    right.forEach((assets, boxId) => assets.forEach((asset) => add(boxId, asset)));
    return merged;
  };
  const allBoxIdsFoundOnce = (byBoxId: Map<number, any[]>): boolean =>
    params.boxIds.every((boxId) => (byBoxId.get(boxId) || []).length === 1);
  const boxIds = new Set(params.boxIds);
  if (params.dropRuntime.collectionMintStr) {
    const grouped = await collectReceiptAssetsOwnedByBoxId({
      ownerWallet: params.ownerWallet,
      dropRuntime: params.dropRuntime,
      boxIds,
      grouping: ['collection', params.dropRuntime.collectionMintStr] as const,
    });
    if (allBoxIdsFoundOnce(grouped.byBoxId)) return grouped.byBoxId;
    logger.warn(
      grouped.sawItems
        ? 'Helius collection-grouped search did not find every expected Admin IRL receipt; falling back to ungrouped search'
        : 'Helius searchAssets returned 0 items for Admin IRL receipt collection grouping; falling back to ungrouped search',
      {
        owner: params.ownerWallet,
        collection: params.dropRuntime.collectionMintStr,
        dropId: params.dropRuntime.dropId,
        expectedBoxIds: params.boxIds,
        foundBoxIds: Array.from(grouped.byBoxId.keys()),
      },
    );
    const ungrouped = await collectReceiptAssetsOwnedByBoxId({
      ownerWallet: params.ownerWallet,
      dropRuntime: params.dropRuntime,
      boxIds,
    });
    return mergeReceiptAssetMaps(grouped.byBoxId, ungrouped.byBoxId);
  }
  return (
    await collectReceiptAssetsOwnedByBoxId({
      ownerWallet: params.ownerWallet,
      dropRuntime: params.dropRuntime,
      boxIds,
    })
  ).byBoxId;
}

async function waitForAdminIrlReceiptAssets(params: {
  conn: Connection;
  ownerWallet: string;
  dropRuntime: DropRuntime;
  items: AdminIrlRedeemRequestItem[];
  receiptTxs: string[];
}): Promise<Map<number, any[]>> {
  if (clusterSharesCollectionMint(params.dropRuntime)) return new Map<number, any[]>();

  // Owner searches can lag or permanently omit an individual compressed asset.
  // Read the canonical Bubblegum V2 leaf events from the receipt transactions,
  // then fetch those assets directly and verify their box metadata.
  try {
    const signatures = normalizeReceiptTxs(params.receiptTxs);
    const transactions = await withTimeout(
      params.conn.getTransactions(signatures, { maxSupportedTransactionVersion: 0 }),
      RPC_TIMEOUT_MS,
      'getTransactions:adminIrlRedeemReceiptAssets',
    );
    const receiptAssetIds: string[] = [];
    for (const tx of transactions) {
      receiptAssetIds.push(...bubblegumV2LeafAssetIdsFromTransaction(tx));
    }
    if (receiptAssetIds.length === params.items.length) {
      const assets = await mapWithConcurrency(receiptAssetIds, ADMIN_IRL_REDEEM_ASSET_FETCH_CONCURRENCY, (assetId) =>
        fetchAssetRetry(assetId, params.dropRuntime),
      );
      const direct = new Map<number, any[]>();
      const expectedBoxIds = new Set(params.items.map((item) => item.refId));
      assets.forEach((asset) => {
        const boxId = Math.floor(Number(getBoxIdFromAsset(asset)));
        if (!Number.isFinite(boxId) || !expectedBoxIds.has(boxId)) return;
        if (!stripeReceiptAssetMatches(asset, params.dropRuntime, boxId, params.ownerWallet)) return;

        const entries = direct.get(boxId) || [];
        if (!entries.some((entry) => String(entry?.id || '') === String(asset?.id || ''))) entries.push(asset);
        direct.set(boxId, entries);
      });
      if (params.items.every((item) => (direct.get(item.refId) || []).length === 1)) return direct;
    }
  } catch (err) {
    logger.warn('Admin IRL receipt transaction fallback failed; using owner search', {
      dropId: params.dropRuntime.dropId,
      error: summarizeError(err),
    });
  }

  const boxIds = params.items.map((item) => item.refId);
  const startedAt = Date.now();
  let last = new Map<number, any[]>();
  while (Date.now() - startedAt <= ADMIN_IRL_REDEEM_RECEIPT_INDEX_MAX_WAIT_MS) {
    last = await findAdminIrlReceiptAssets({
      ownerWallet: params.ownerWallet,
      dropRuntime: params.dropRuntime,
      boxIds,
    });
    const allFound = boxIds.every((boxId) => (last.get(boxId) || []).length === 1);
    if (allFound) return last;
    await sleep(ADMIN_IRL_REDEEM_RECEIPT_INDEX_POLL_MS);
  }
  return last;
}

async function ensureAdminIrlInternalDelivery(params: {
  conn: Connection;
  dropRuntime: DropRuntime;
  signer: Keypair;
  cfg: DecodedBoxMinterConfig;
  requestRef: DocumentReference;
  request: AdminIrlRedeemStartedRequest;
}): Promise<AdminIrlInternalDeliveryResult> {
  const assetPks = params.request.items.map((item) => new PublicKey(item.assetId));
  const MAX_INTERNAL_DELIVERY_ID_ATTEMPTS = 16;
  let addressLookupTablesPromise: Promise<AddressLookupTableAccount[] | []> | null = null;
  const loadAddressLookupTables = () => {
    addressLookupTablesPromise ??= getDeliveryLookupTable(params.conn, params.dropRuntime);
    return addressLookupTablesPromise;
  };

  const sendInternalDelivery = async (
    deliveryId: number,
    deliveryPda: PublicKey,
    deliveryBump: number,
    options: { skipExistingCheck?: boolean } = {},
  ) => {
    const deliveryPdaBase58 = deliveryPda.toBase58();
    if (params.request.internalDeliveryTx) {
      return {
        deliveryId,
        deliveryPda: deliveryPdaBase58,
        deliveryTx: params.request.internalDeliveryTx,
      };
    }

    if (!options.skipExistingCheck) {
      const existingDeliveryRecord = await withTimeout(
        params.conn.getAccountInfo(deliveryPda, { commitment: 'confirmed', dataSlice: { offset: 0, length: 0 } }),
        RPC_TIMEOUT_MS,
        'getAccountInfo:adminIrlInternalDeliveryPda',
      );
      if (existingDeliveryRecord) {
        return {
          deliveryId,
          deliveryPda: deliveryPdaBase58,
          deliveryTx: null,
        };
      }
    }

    const addressLookupTables = await loadAddressLookupTables();
    const deliverIx = new TransactionInstruction({
      programId: params.dropRuntime.boxMinterProgramId,
      keys: [
        { pubkey: params.dropRuntime.boxMinterConfigPda, isSigner: false, isWritable: false },
        { pubkey: params.signer.publicKey, isSigner: true, isWritable: false },
        { pubkey: params.signer.publicKey, isSigner: true, isWritable: true },
        { pubkey: params.cfg.treasury, isSigner: false, isWritable: true },
        { pubkey: params.cfg.coreCollection, isSigner: false, isWritable: false },
        { pubkey: MPL_CORE_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: SPL_NOOP_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: deliveryPda, isSigner: false, isWritable: true },
        ...assetPks.map((pubkey) => ({ pubkey, isSigner: false, isWritable: true })),
      ],
      data: encodeDeliverArgs({ deliveryId, feeLamports: 0, deliveryBump }),
    });
    const instructions = [ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }), deliverIx];
    const sizeTx = buildTx(instructions, params.signer.publicKey, DUMMY_BLOCKHASH, [params.signer], addressLookupTables);
    const raw = sizeTx.serialize();
    if (raw.length > SOLANA_MAX_RAW_TX_BYTES) {
      throw new HttpsError(
        'failed-precondition',
        `Admin IRL internal delivery transaction too large (${raw.length} bytes > ${SOLANA_MAX_RAW_TX_BYTES}). Try fewer packs.`,
        { rawBytes: raw.length, maxRawBytes: SOLANA_MAX_RAW_TX_BYTES, items: assetPks.length },
      );
    }

    const { blockhash } = await withTimeout(
      params.conn.getLatestBlockhash('confirmed'),
      RPC_TIMEOUT_MS,
      'getLatestBlockhash:adminIrlInternalDelivery',
    );
    const tx = buildTx(instructions, params.signer.publicKey, blockhash, [params.signer], addressLookupTables);
    let deliveryTx: string;
    try {
      deliveryTx = await sendAndConfirmSignedTx(params.conn, tx, 'adminIrlInternalDelivery', {
        sendTimeoutMs: TX_SEND_TIMEOUT_MS,
        confirmTimeoutMs: TX_CONFIRM_TIMEOUT_MS,
      });
    } catch (err) {
      const maybeSubmittedSignature =
        typeof (err as any)?.details?.signature === 'string' ? String((err as any).details.signature).trim() : '';
      const landed = await withTimeout(
        params.conn.getAccountInfo(deliveryPda, { commitment: 'confirmed', dataSlice: { offset: 0, length: 0 } }),
        RPC_TIMEOUT_MS,
        'getAccountInfo:adminIrlInternalDeliveryPda:postError',
      ).catch(() => null);
      if (!landed) throw err;
      const result = {
        deliveryId,
        deliveryPda: deliveryPdaBase58,
        deliveryTx: maybeSubmittedSignature || null,
      };
      await params.requestRef.set(
        {
          internalDeliveryId: result.deliveryId,
          internalDeliveryPda: result.deliveryPda,
          ...(result.deliveryTx ? { internalDeliveryTx: result.deliveryTx } : {}),
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
      return result;
    }
    const result = {
      deliveryId,
      deliveryPda: deliveryPdaBase58,
      deliveryTx,
    };
    await params.requestRef.set(
      {
        internalDeliveryId: result.deliveryId,
        internalDeliveryPda: result.deliveryPda,
        internalDeliveryTx: result.deliveryTx,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
    return result;
  };

  if (params.request.internalDeliveryId && params.request.internalDeliveryPda) {
    const [expectedDeliveryPda, deliveryBump] = deriveDeliveryPdaForDrop(params.dropRuntime, params.request.internalDeliveryId);
    if (expectedDeliveryPda.toBase58() !== params.request.internalDeliveryPda) {
      throw new HttpsError('failed-precondition', 'Stored Admin IRL internal delivery PDA does not match delivery id', {
        deliveryId: params.request.internalDeliveryId,
        expected: expectedDeliveryPda.toBase58(),
        got: params.request.internalDeliveryPda,
      });
    }
    return sendInternalDelivery(params.request.internalDeliveryId, expectedDeliveryPda, deliveryBump);
  }

  for (let attempt = 0; attempt < MAX_INTERNAL_DELIVERY_ID_ATTEMPTS; attempt += 1) {
    const deliveryId = randomInt(1, 2 ** 31);
    const [deliveryPda, deliveryBump] = deriveDeliveryPdaForDrop(params.dropRuntime, deliveryId);
    const existingDeliveryRecord = await withTimeout(
      params.conn.getAccountInfo(deliveryPda, { commitment: 'confirmed', dataSlice: { offset: 0, length: 0 } }),
      RPC_TIMEOUT_MS,
      'getAccountInfo:adminIrlInternalDeliveryPda:allocate',
    );
    if (existingDeliveryRecord) continue;

    await params.requestRef.set(
      {
        internalDeliveryId: deliveryId,
        internalDeliveryPda: deliveryPda.toBase58(),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
    return sendInternalDelivery(deliveryId, deliveryPda, deliveryBump, { skipExistingCheck: true });
  }

  throw new HttpsError('unavailable', 'Failed to allocate hidden Admin IRL delivery id');
}

async function closeAdminIrlInternalDeliveryRecord(params: {
  conn: Connection;
  dropRuntime: DropRuntime;
  signer: Keypair;
  requestRef: DocumentReference;
  request: AdminIrlRedeemStartedRequest;
  internalDelivery: AdminIrlInternalDeliveryResult;
}): Promise<string | null> {
  if (params.request.closeDeliveryTx) return params.request.closeDeliveryTx;
  const [deliveryPda, deliveryBump] = deriveDeliveryPdaForDrop(params.dropRuntime, params.internalDelivery.deliveryId);
  const deliveryInfo = await withTimeout(
    params.conn.getAccountInfo(deliveryPda, { commitment: 'confirmed', dataSlice: { offset: 0, length: 0 } }),
    RPC_TIMEOUT_MS,
    'getAccountInfo:adminIrlInternalDeliveryPda:close',
  );
  if (!deliveryInfo) return null;

  try {
    const closeIx = new TransactionInstruction({
      programId: params.dropRuntime.boxMinterProgramId,
      keys: [
        { pubkey: params.dropRuntime.boxMinterConfigPda, isSigner: false, isWritable: false },
        { pubkey: params.signer.publicKey, isSigner: true, isWritable: true },
        { pubkey: deliveryPda, isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: encodeCloseDeliveryArgs({ deliveryId: params.internalDelivery.deliveryId, deliveryBump }),
    });
    const { blockhash } = await withTimeout(
      params.conn.getLatestBlockhash('confirmed'),
      RPC_TIMEOUT_MS,
      'getLatestBlockhash:adminIrlInternalDeliveryClose',
    );
    const tx = buildTx(
      [ComputeBudgetProgram.setComputeUnitLimit({ units: 250_000 }), closeIx],
      params.signer.publicKey,
      blockhash,
      [params.signer],
    );
    const closeDeliveryTx = await sendAndConfirmSignedTx(params.conn, tx, 'adminIrlInternalDeliveryClose', {
      sendTimeoutMs: TX_SEND_TIMEOUT_MS,
      confirmTimeoutMs: TX_CONFIRM_TIMEOUT_MS,
    });
    await params.requestRef.set(
      {
        closeDeliveryTx,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
    return closeDeliveryTx;
  } catch (err) {
    logger.warn('adminIrlRedeem:internalDeliveryCloseFailed', {
      dropId: params.dropRuntime.dropId,
      requestId: params.request.requestId,
      deliveryId: params.internalDelivery.deliveryId,
      error: summarizeError(err),
    });
    return null;
  }
}

async function publishCompletedAdminIrlRedeem(params: {
  requestRef: DocumentReference;
  attemptId: string;
  dropRuntime: DropRuntime;
  request: AdminIrlRedeemStartedRequest;
  transferSignature: string;
  receiptOwner: string;
  internalDelivery: AdminIrlInternalDeliveryResult;
  closeDeliveryTx: string | null;
  receiptTxs: string[];
  boxes: AdminIrlRedeemBoxBaseInput[];
}): Promise<ReturnType<typeof adminIrlRedeemCompleteResponse>> {
  const maxAttempts = 16;
  const selectionKey = adminIrlRedeemSelectionKeyForBoxes(params.dropRuntime.dropId, params.boxes);
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const deliveryId = randomInt(1, 2 ** 31);
    const orderRef = db.doc(dropDeliveryOrderPath(params.dropRuntime.dropId, deliveryId));
    const claimCodes = generateAdminIrlReceiptClaimCodes(params.boxes.length);
    const boxesWithCodes = params.boxes.map((box, index) => ({
      ...box,
      receiptClaimCode: claimCodes[index],
    }));
    const claimRefs = claimCodes.map((code) => db.doc(`claimCodes/${code}`));

    const result = await db.runTransaction(async (tx) => {
      const requestSnap = await tx.get(params.requestRef);
      if (!requestSnap.exists) throw new HttpsError('not-found', 'Admin IRL redeem request not found');
      const request = requestSnap.data() as any;
      if (request?.status === 'complete') return { status: 'complete' as const, request };
      if (request?.status !== 'processing' || request?.processingAttemptId !== params.attemptId) {
        throw new HttpsError('aborted', 'Admin IRL redeem processing lease changed');
      }
      const markerResolution = await resolveAdminIrlRedeemMarkerReuseInTransaction({
        tx,
        dropId: params.dropRuntime.dropId,
        selectionKey,
        boxes: boxesWithCodes,
      });
      if (markerResolution.status === 'reuse') {
        const completedRequest = await completeAdminIrlRedeemRequestFromMarkerReuse({
          tx,
          requestRef: params.requestRef,
          request,
          dropId: params.dropRuntime.dropId,
          resolution: markerResolution,
        });
        return { status: 'complete' as const, request: completedRequest };
      }
      if (markerResolution.status === 'conflict') throw adminIrlRedeemMarkerConflict(markerResolution.reason);
      const orderSnap = await tx.get(orderRef);
      if (orderSnap.exists) return { status: 'collision' as const };
      const claimSnaps = await Promise.all(claimRefs.map((ref) => tx.get(ref)));
      if (claimSnaps.some((snap) => snap.exists)) return { status: 'collision' as const };

      const orderDoc = buildAdminIrlRedeemDeliveryOrderDocument({
        dropId: params.dropRuntime.dropId,
        deliveryId,
        requestId: params.request.requestId,
        owner: params.request.owner,
        receiptOwner: params.receiptOwner,
        transferSignature: params.transferSignature,
        receiptTxs: params.receiptTxs,
        boxes: boxesWithCodes,
      });
      tx.create(orderRef, {
        ...orderDoc,
        createdAt: FieldValue.serverTimestamp(),
        processedAt: FieldValue.serverTimestamp(),
      });
      boxesWithCodes.forEach((box, index) => {
        tx.create(claimRefs[index], {
          ...buildAdminIrlRedeemClaimCodeDocument({
            dropId: params.dropRuntime.dropId,
            deliveryId,
            owner: params.request.owner,
            receiptOwner: params.receiptOwner,
            requestId: params.request.requestId,
            box,
          }),
          createdAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        });
      });
      const markerDocsByPath = new Map<string, { ref: DocumentReference; data: Record<string, unknown> }>();
      boxesWithCodes.forEach((box) => {
        const markerDoc = {
          ...buildAdminIrlRedeemMarkerDocument({
            dropId: params.dropRuntime.dropId,
            deliveryId,
            requestId: params.request.requestId,
            owner: params.request.owner,
            transferSignature: params.transferSignature,
            selectionKey,
            box,
          }),
          createdAt: FieldValue.serverTimestamp(),
        };
        const packMarkerRef = db.doc(dropAdminIrlRedeemPackMarkerPath(params.dropRuntime.dropId, box.originalAssetId));
        markerDocsByPath.set(packMarkerRef.path, { ref: packMarkerRef, data: markerDoc });
        const receiptMarkerRef = db.doc(dropAdminIrlRedeemReceiptMarkerPath(params.dropRuntime.dropId, box.receiptAssetId));
        markerDocsByPath.set(receiptMarkerRef.path, { ref: receiptMarkerRef, data: markerDoc });
      });
      markerDocsByPath.forEach(({ ref, data }) => tx.create(ref, data));
      tx.set(
        params.requestRef,
        {
          status: 'complete',
          deliveryId,
          internalDeliveryId: params.internalDelivery.deliveryId,
          internalDeliveryPda: params.internalDelivery.deliveryPda,
          ...(params.internalDelivery.deliveryTx ? { internalDeliveryTx: params.internalDelivery.deliveryTx } : {}),
          ...(params.closeDeliveryTx ? { closeDeliveryTx: params.closeDeliveryTx } : {}),
          receiptTxs: params.receiptTxs,
          claimCodes,
          boxes: boxesWithCodes.map((box) => ({
            boxId: box.boxId,
            originalAssetId: box.originalAssetId,
            receiptAssetId: box.receiptAssetId,
            claimCode: box.receiptClaimCode,
            dudeIds: box.dudeIds,
          })),
          processingAttemptId: FieldValue.delete(),
          processingStartedAt: FieldValue.delete(),
          processingLeaseExpiresAt: FieldValue.delete(),
          preparedExpiresAt: FieldValue.delete(),
          completedAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
      return { status: 'created' as const, deliveryId, claimCodes, boxesWithCodes };
    });

    if (result.status === 'collision') continue;
    if (result.status === 'complete') {
      return adminIrlRedeemCompleteResponse({
        dropId: params.dropRuntime.dropId,
        requestId: params.request.requestId,
        request: result.request,
      });
    }

    void countNormalIrlPackStatus({
      db,
      dropRuntime: params.dropRuntime,
      deliveryId: result.deliveryId,
      packQuantity: params.boxes.length,
      unsealedCardQuantity: 0,
    }).catch((err) => {
      logger.warn('adminIrlRedeem:packStatusCountFailed', {
        dropId: params.dropRuntime.dropId,
        deliveryId: result.deliveryId,
        error: summarizeError(err),
      });
    });

    return {
      processed: true as const,
      dropId: params.dropRuntime.dropId,
      requestId: params.request.requestId,
      deliveryId: result.deliveryId,
      receiptTxs: params.receiptTxs,
      claimCodes: result.claimCodes,
      boxes: result.boxesWithCodes.map((box) => ({
        boxId: box.boxId,
        receiptAssetId: box.receiptAssetId,
        claimCode: box.receiptClaimCode,
        dudeIds: box.dudeIds,
      })),
      cards: [],
    };
  }
  throw new HttpsError('unavailable', 'Failed to allocate Admin IRL redeem delivery id or claim codes');
}

async function waitForAdminIrlCardReceipt(params: {
  dropRuntime: DropRuntime;
  receiptAssetId: string;
  figureId: number;
  adminWallet: string;
}): Promise<void> {
  const startedAt = Date.now();
  let lastOwner = '';
  let lastTransientLookupError: unknown = null;
  const recordLookupError = (err: unknown) => {
    const disposition = classifyAdminIrlCardReceiptLookupError(err);
    if (disposition === 'indexing') {
      lastTransientLookupError = null;
      return;
    }
    if (disposition === 'transient') {
      lastTransientLookupError = err;
      return;
    }

    const code = String((err as any)?.code || '').replace(/^functions\//, '');
    if (code && code !== 'unavailable' && code !== 'resource-exhausted' && code !== 'deadline-exceeded') {
      throw err;
    }
    throw new HttpsError('failed-precondition', 'Admin IRL card receipt lookup failed', {
      receiptAssetId: params.receiptAssetId,
      lastError: summarizeError(err),
    });
  };

  while (Date.now() - startedAt <= ADMIN_IRL_REDEEM_RECEIPT_INDEX_MAX_WAIT_MS) {
    let asset: any = null;
    try {
      asset = await fetchAsset(params.receiptAssetId, params.dropRuntime);
      lastTransientLookupError = null;
      lastOwner = typeof asset?.ownership?.owner === 'string' ? asset.ownership.owner : '';
    } catch (err) {
      recordLookupError(err);
    }
    if (asset && lastOwner === params.adminWallet) {
      if (getAssetKind(asset) !== 'certificate') {
        throw new HttpsError('failed-precondition', 'Admin IRL redeem selected asset is not a receipt');
      }
      if (!assetMatchesRequestedDrop(asset, params.dropRuntime)) {
        throw new HttpsError('failed-precondition', 'Admin IRL redeem receipt does not belong to the requested drop');
      }
      if (Number(getDudeIdFromAsset(asset)) !== params.figureId) {
        throw new HttpsError('failed-precondition', 'Admin IRL redeem card receipt figure id changed');
      }
      let proof: any = null;
      try {
        proof = await fetchAssetProof(params.receiptAssetId, params.dropRuntime);
        lastTransientLookupError = null;
      } catch (err) {
        recordLookupError(err);
      }
      if (adminIrlCardReceiptProofHasIdentity(proof)) {
        parseCompressedReceiptProof({
          asset,
          proof,
          dropRuntime: params.dropRuntime,
          expectedOwner: params.adminWallet,
        });
        return;
      }
    }
    await sleep(ADMIN_IRL_REDEEM_RECEIPT_INDEX_POLL_MS);
  }
  if (lastTransientLookupError) {
    throw new HttpsError('unavailable', 'Admin IRL card receipt lookup failed while waiting for indexing; retry shortly', {
      receiptAssetId: params.receiptAssetId,
      expectedOwner: params.adminWallet,
      lastOwner,
      lastError: summarizeError(lastTransientLookupError),
    });
  }
  throw new HttpsError('unavailable', 'Admin IRL card receipt is not indexed under the deployer wallet yet', {
    receiptAssetId: params.receiptAssetId,
    expectedOwner: params.adminWallet,
    lastOwner,
  });
}

async function publishCompletedAdminIrlCardRedeem(params: {
  requestRef: DocumentReference;
  attemptId: string;
  dropRuntime: DropRuntime;
  request: AdminIrlRedeemStartedRequest;
  transferSignature: string;
  receiptOwner: string;
  card: Omit<AdminIrlRedeemCardInput, 'receiptClaimCode'>;
}): Promise<ReturnType<typeof adminIrlRedeemCompleteResponse>> {
  const markerRef = db.doc(dropAdminIrlRedeemReceiptMarkerPath(params.dropRuntime.dropId, params.card.receiptAssetId));
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const deliveryId = randomInt(1, 2 ** 31);
    const claimCode = generateAdminIrlReceiptClaimCodes(1)[0];
    const cardWithClaimCode: AdminIrlRedeemCardInput = { ...params.card, receiptClaimCode: claimCode };
    const orderRef = db.doc(dropDeliveryOrderPath(params.dropRuntime.dropId, deliveryId));
    const claimRef = db.doc(`claimCodes/${claimCode}`);

    const result = await db.runTransaction(async (tx) => {
      const requestSnap = await tx.get(params.requestRef);
      if (!requestSnap.exists) throw new HttpsError('not-found', 'Admin IRL redeem request not found');
      const request = requestSnap.data() as any;
      if (request?.status === 'complete') return { status: 'complete' as const, request };
      if (request?.status !== 'processing' || request?.processingAttemptId !== params.attemptId) {
        throw new HttpsError('aborted', 'Admin IRL redeem processing lease changed');
      }

      const markerSnap = await tx.get(markerRef);
      if (markerSnap.exists) {
        const marker = markerSnap.data() as any;
        if (
          marker?.version !== ADMIN_IRL_REDEEM_CARD_MARKER_VERSION ||
          marker?.source !== ADMIN_IRL_REDEEM_DELIVERY_ORDER_SOURCE ||
          marker?.targetKind !== 'card_receipt' ||
          marker?.dropId !== params.dropRuntime.dropId ||
          marker?.receiptAssetId !== params.card.receiptAssetId ||
          Math.floor(Number(marker?.figureId)) !== params.card.figureId
        ) {
          throw adminIrlRedeemMarkerConflict('card receipt marker mismatch');
        }
        const existingDeliveryId = Math.floor(Number(marker?.deliveryId));
        let existingClaimCode = '';
        try {
          existingClaimCode = requireStripeReceiptClaimCode(marker?.claimCode);
        } catch {
          throw adminIrlRedeemMarkerConflict('invalid card receipt marker claim code');
        }
        if (
          !Number.isFinite(existingDeliveryId) ||
          existingDeliveryId <= 0 ||
          marker?.owner !== params.request.owner
        ) {
          throw adminIrlRedeemMarkerConflict('invalid card receipt marker');
        }
        const existingOrderRef = db.doc(dropDeliveryOrderPath(params.dropRuntime.dropId, existingDeliveryId));
        const existingOrderSnap = await tx.get(existingOrderRef);
        if (!existingOrderSnap.exists) throw adminIrlRedeemMarkerConflict('card receipt marker order missing');
        const existingClaimRef = db.doc(`claimCodes/${existingClaimCode}`);
        const existingClaimSnap = await tx.get(existingClaimRef);
        if (!existingClaimSnap.exists) throw adminIrlRedeemMarkerConflict('card receipt marker claim missing');
        const existingOrder = existingOrderSnap.data() as any;
        const existingOrderItem = Array.isArray(existingOrder?.items) ? existingOrder.items[0] : null;
        const existingOrderClaim = existingOrder?.stripeReceiptClaim;
        const existingClaim = existingClaimSnap.data() as any;
        if (
          existingOrder?.source !== ADMIN_IRL_REDEEM_DELIVERY_ORDER_SOURCE ||
          existingOrder?.adminIrlRedeem?.targetKind !== 'card_receipt' ||
          existingOrder?.owner !== params.request.owner ||
          !Array.isArray(existingOrder?.items) ||
          existingOrder.items.length !== 1 ||
          existingOrderItem?.kind !== 'dude' ||
          Math.floor(Number(existingOrderItem?.refId)) !== params.card.figureId ||
          existingOrderItem?.assetId !== params.card.receiptAssetId ||
          existingOrderClaim?.receiptKind !== 'figure' ||
          existingOrderClaim?.receiptAssetId !== params.card.receiptAssetId ||
          Math.floor(Number(existingOrderClaim?.figureId)) !== params.card.figureId ||
          stripeReceiptClaimCodeMaybe(existingOrderClaim) !== existingClaimCode ||
          existingClaim?.namespace !== STRIPE_RECEIPT_CLAIM_CODE_NAMESPACE ||
          existingClaim?.source !== ADMIN_IRL_REDEEM_DELIVERY_ORDER_SOURCE ||
          existingClaim?.dropId !== params.dropRuntime.dropId ||
          Math.floor(Number(existingClaim?.deliveryId)) !== existingDeliveryId ||
          existingClaim?.receiptKind !== 'figure' ||
          existingClaim?.receiptAssetId !== params.card.receiptAssetId ||
          Math.floor(Number(existingClaim?.figureId)) !== params.card.figureId ||
          normalizeStripeReceiptClaimCode(existingClaim?.code) !== existingClaimCode
        ) {
          throw adminIrlRedeemMarkerConflict('card receipt marker order or claim mismatch');
        }
        const cards = [{ figureId: params.card.figureId, receiptAssetId: params.card.receiptAssetId, claimCode: existingClaimCode }];
        const completedRequest = {
          ...request,
          status: 'complete',
          deliveryId: existingDeliveryId,
          receiptTxs: normalizeReceiptTxs(existingOrder?.receiptTxs),
          claimCodes: [existingClaimCode],
          cards,
          duplicateOfRequestId: marker?.requestId,
        };
        tx.set(
          params.requestRef,
          {
            status: 'complete',
            deliveryId: existingDeliveryId,
            receiptTxs: completedRequest.receiptTxs,
            claimCodes: [existingClaimCode],
            cards,
            duplicateOfRequestId: marker?.requestId,
            processingAttemptId: FieldValue.delete(),
            processingStartedAt: FieldValue.delete(),
            processingLeaseExpiresAt: FieldValue.delete(),
            preparedExpiresAt: FieldValue.delete(),
            completedAt: FieldValue.serverTimestamp(),
            updatedAt: FieldValue.serverTimestamp(),
          },
          { merge: true },
        );
        return { status: 'complete' as const, request: completedRequest };
      }

      const [orderSnap, claimSnap] = await Promise.all([tx.get(orderRef), tx.get(claimRef)]);
      if (orderSnap.exists || claimSnap.exists) return { status: 'collision' as const };
      tx.create(orderRef, {
        ...buildAdminIrlRedeemCardDeliveryOrderDocument({
          dropId: params.dropRuntime.dropId,
          deliveryId,
          requestId: params.request.requestId,
          owner: params.request.owner,
          receiptOwner: params.receiptOwner,
          transferSignature: params.transferSignature,
          card: cardWithClaimCode,
        }),
        createdAt: FieldValue.serverTimestamp(),
        processedAt: FieldValue.serverTimestamp(),
      });
      tx.create(claimRef, {
        ...buildAdminIrlRedeemCardClaimCodeDocument({
          dropId: params.dropRuntime.dropId,
          deliveryId,
          owner: params.request.owner,
          receiptOwner: params.receiptOwner,
          requestId: params.request.requestId,
          card: cardWithClaimCode,
        }),
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
      tx.create(markerRef, {
        ...buildAdminIrlRedeemCardMarkerDocument({
          dropId: params.dropRuntime.dropId,
          deliveryId,
          requestId: params.request.requestId,
          owner: params.request.owner,
          transferSignature: params.transferSignature,
          card: cardWithClaimCode,
        }),
        createdAt: FieldValue.serverTimestamp(),
      });
      const cards = [
        {
          figureId: cardWithClaimCode.figureId,
          receiptAssetId: cardWithClaimCode.receiptAssetId,
          claimCode,
        },
      ];
      tx.set(
        params.requestRef,
        {
          status: 'complete',
          deliveryId,
          receiptTxs: [params.transferSignature],
          claimCodes: [claimCode],
          cards,
          processingAttemptId: FieldValue.delete(),
          processingStartedAt: FieldValue.delete(),
          processingLeaseExpiresAt: FieldValue.delete(),
          preparedExpiresAt: FieldValue.delete(),
          completedAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
      return { status: 'created' as const, deliveryId, claimCode, cards };
    });

    if (result.status === 'collision') continue;
    if (result.status === 'complete') {
      return adminIrlRedeemCompleteResponse({
        dropId: params.dropRuntime.dropId,
        requestId: params.request.requestId,
        request: result.request,
      });
    }
    return adminIrlRedeemCompleteResponse({
      dropId: params.dropRuntime.dropId,
      requestId: params.request.requestId,
      request: {
        deliveryId: result.deliveryId,
        receiptTxs: [params.transferSignature],
        claimCodes: [result.claimCode],
        cards: result.cards,
      },
    });
  }
  throw new HttpsError('unavailable', 'Failed to allocate Admin IRL card receipt delivery id or claim code');
}

function buildTx(
  instructions: TransactionInstruction[],
  payer: PublicKey,
  recentBlockhash: string,
  signers: Keypair[] = [],
  addressLookupTables: AddressLookupTableAccount[] = [],
) {
  const message = new TransactionMessage({ payerKey: payer, recentBlockhash, instructions }).compileToV0Message(addressLookupTables);
  const tx = new VersionedTransaction(message);
  if (signers.length) tx.sign(signers);
  return tx;
}

async function getDeliveryLookupTable(conn: Connection, dropRuntime: DropRuntime): Promise<AddressLookupTableAccount[] | []> {
  if (!dropRuntime.deliveryLookupTableStr) return [];
  const now = Date.now();
  const cached = cachedDeliveryLutByDrop.get(dropRuntime.dropId);
  if (cached && now - cached.cachedAtMs < DELIVERY_LUT_CACHE_TTL_MS) return [cached.lut];

  const res = await withTimeout(
    conn.getAddressLookupTable(dropRuntime.deliveryLookupTable),
    RPC_TIMEOUT_MS,
    'getAddressLookupTable:delivery',
  );
  const lut = res?.value || null;
  if (!lut) {
    throw new HttpsError('failed-precondition', 'DELIVERY_LOOKUP_TABLE not found on-chain', {
      deliveryLookupTable: dropRuntime.deliveryLookupTableStr,
      cluster: dropRuntime.cluster,
      dropId: dropRuntime.dropId,
    });
  }
  cachedDeliveryLutByDrop.set(dropRuntime.dropId, { lut, cachedAtMs: now });
  return [lut];
}

const SOLANA_MAX_RAW_TX_BYTES = 1232;
const DUMMY_BLOCKHASH = '11111111111111111111111111111111';
function transactionEncodingTooLarge(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    err instanceof RangeError &&
    (/encoding overruns Uint8Array/i.test(msg) ||
      /offset.*out of range/i.test(msg) ||
      String((err as any)?.code || '') === 'ERR_OUT_OF_RANGE')
  );
}

async function buildTxWithOptionalDeliveryLookupTable(params: {
  conn: Connection;
  dropRuntime: DropRuntime;
  build: (luts: AddressLookupTableAccount[]) => VersionedTransaction;
  encodeTooLargeMessage: string;
  encodeTooLargeDetails: Record<string, unknown>;
  packetTooLargeMessage: (rawBytes: number, maxRawBytes: number) => string;
  packetTooLargeDetails: Record<string, unknown>;
}): Promise<{ tx: VersionedTransaction; raw: Uint8Array }> {
  let addressLookupTables: AddressLookupTableAccount[] | null = null;
  const loadLookupTables = async () => {
    if (addressLookupTables) return addressLookupTables;
    try {
      addressLookupTables = await getDeliveryLookupTable(params.conn, params.dropRuntime);
    } catch {
      addressLookupTables = [];
    }
    return addressLookupTables;
  };
  const buildAndSerialize = (luts: AddressLookupTableAccount[]) => {
    const tx = params.build(luts);
    return { tx, raw: tx.serialize() };
  };
  const throwEncodeTooLarge = (): never => {
    throw new HttpsError('failed-precondition', params.encodeTooLargeMessage, params.encodeTooLargeDetails);
  };

  let tx: VersionedTransaction;
  let raw: Uint8Array;
  try {
    ({ tx, raw } = buildAndSerialize([]));
  } catch (err) {
    if (!transactionEncodingTooLarge(err)) throw err;
    const luts = await loadLookupTables();
    if (!luts.length) throwEncodeTooLarge();
    try {
      ({ tx, raw } = buildAndSerialize(luts));
    } catch (lutErr) {
      if (!transactionEncodingTooLarge(lutErr)) throw lutErr;
      throwEncodeTooLarge();
    }
  }

  if (raw.length > SOLANA_MAX_RAW_TX_BYTES) {
    const luts = await loadLookupTables();
    if (luts.length) {
      try {
        ({ tx, raw } = buildAndSerialize(luts));
      } catch (err) {
        if (!transactionEncodingTooLarge(err)) throw err;
        throwEncodeTooLarge();
      }
    }
  }
  if (raw.length > SOLANA_MAX_RAW_TX_BYTES) {
    throw new HttpsError(
      'failed-precondition',
      params.packetTooLargeMessage(raw.length, SOLANA_MAX_RAW_TX_BYTES),
      {
        rawBytes: raw.length,
        maxRawBytes: SOLANA_MAX_RAW_TX_BYTES,
        ...params.packetTooLargeDetails,
      },
    );
  }

  return { tx, raw };
}

type DeliveryOrderOwnersCursor = {
  path: string;
};

const SHIPPER_READY_NOTIFICATION_DOC_ID = 'shipper-ready-to-ship';
const SHIPPER_READY_NOTIFICATION_LEASE_MS = 5 * 60 * 1000;
const BUYER_ORDER_RECEIVED_NOTIFICATION_DOC_ID = 'order-received';
const BUYER_ORDER_RECEIVED_NOTIFICATION_LEASE_MS = 5 * 60 * 1000;
const BUYER_ORDER_RECEIVED_MISSING_RECIPIENT_REASON = 'buyer_order_received_email_recipient_missing_or_invalid';
const BUYER_ORDER_SHIPPED_NOTIFICATION_DOC_ID = 'order-shipped';
const BUYER_ORDER_SHIPPED_NOTIFICATION_LEASE_MS = 5 * 60 * 1000;
const BUYER_ORDER_SHIPPED_MISSING_RECIPIENT_REASON = 'buyer_order_shipped_email_recipient_missing_or_invalid';
const STRIPE_CHECKOUT_MANUAL_REVIEW_NOTIFICATION_DOC_ID = 'stripe-checkout-manual-review';
const STRIPE_CHECKOUT_MANUAL_REVIEW_NOTIFICATION_LEASE_MS = 5 * 60 * 1000;
const STRIPE_CHECKOUT_MANUAL_REVIEW_EMAIL = 'ivan@ivan.lol';

type EmailNotificationReservation =
  | { reserved: true; reason: 'reserved' }
  | { reserved: false; reason: 'already_completed' }
  | { reserved: false; reason: 'send_in_progress'; leaseExpiresAt: number };

type NotificationEmailResult =
  | { status: 'sent'; provider: string; messageId?: string }
  | { status: 'skipped'; provider: string; reason: string }
  | { status: 'failed_permanent'; provider: string; reason: string; providerError: ResendErrorSummary };

type RetryableNotificationEmailErrorName =
  | 'RetryableBuyerOrderReceivedEmailError'
  | 'RetryableBuyerOrderShippedEmailError'
  | 'RetryableShipperReadyEmailError'
  | 'RetryableStripeCheckoutManualReviewEmailError';

class RetryableNotificationEmailError extends Error {
  readonly reason: string;
  readonly details?: unknown;

  constructor(name: RetryableNotificationEmailErrorName, message: string, reason: string, details?: unknown) {
    super(message);
    this.name = name;
    this.reason = reason;
    this.details = details;
  }
}

function isRetryableNotificationEmailError(err: unknown): err is RetryableNotificationEmailError {
  return err instanceof RetryableNotificationEmailError && typeof err.reason === 'string';
}

function createResendClient(apiKey: () => string): () => Promise<ResendClient | null> {
  let cachedClient: ResendClient | null = null;
  return async () => {
    if (cachedClient) return cachedClient;
    const key = apiKey();
    if (!key) return null;
    const { Resend } = await import('resend');
    cachedClient = new Resend(key);
    return cachedClient;
  };
}

const resendClient = createResendClient(() => envOrSecretValue('RESEND_API_KEY', RESEND_API_KEY));
const resendInboundClient = createResendClient(() =>
  envOrSecretValue('RESEND_INBOUND_API_KEY', RESEND_INBOUND_API_KEY),
);
const resendContactsClient = createResendClient(() =>
  envOrSecretValue('RESEND_INBOUND_API_KEY', RESEND_INBOUND_API_KEY),
);

function resendWebhookSecret(): string {
  return envOrSecretValue('RESEND_WEBHOOK_SECRET', RESEND_WEBHOOK_SECRET);
}

async function sendBuyerOrderReceivedEmail(
  message: BuyerOrderReceivedEmailMessage,
): Promise<NotificationEmailResult> {
  const email = buildBuyerOrderReceivedEmailContent(message);
  return sendResendNotificationEmail({
    notificationKind: 'buyer_order_received',
    idempotencyKey: message.idempotencyKey,
    recipients: message.recipients,
    subject: email.subject,
    text: email.text,
    html: email.html,
    retryableErrorName: 'RetryableBuyerOrderReceivedEmailError',
    missingApiKeyMessage: 'RESEND_API_KEY is not configured for buyer order-received email',
    missingApiKeyDetails: { dropId: message.dropId, deliveryId: message.deliveryId, recipientCount: message.recipients.length },
    retryableFailurePrefix: 'resend buyer order-received email failed',
  });
}

async function sendBuyerOrderShippedEmail(message: BuyerOrderShippedEmailMessage): Promise<NotificationEmailResult> {
  const email = buildBuyerOrderShippedEmailContent(message);
  return sendResendNotificationEmail({
    notificationKind: 'buyer_order_shipped',
    idempotencyKey: message.idempotencyKey,
    recipients: message.recipients,
    subject: email.subject,
    text: email.text,
    html: email.html,
    retryableErrorName: 'RetryableBuyerOrderShippedEmailError',
    missingApiKeyMessage: 'RESEND_API_KEY is not configured for buyer order-shipped email',
    missingApiKeyDetails: { dropId: message.dropId, deliveryId: message.deliveryId, recipientCount: message.recipients.length },
    retryableFailurePrefix: 'resend buyer order-shipped email failed',
  });
}

async function sendShipperReadyToShipEmail(
  message: ShipperReadyToShipEmailMessage,
): Promise<NotificationEmailResult> {
  const email = buildShipperReadyToShipEmailContent(message);
  return sendResendNotificationEmail({
    notificationKind: 'shipper_ready_to_ship',
    idempotencyKey: message.idempotencyKey,
    recipients: message.recipients,
    subject: email.subject,
    text: email.text,
    html: email.html,
    retryableErrorName: 'RetryableShipperReadyEmailError',
    missingApiKeyMessage: 'RESEND_API_KEY is not configured for shipper ready-to-ship email',
    missingApiKeyDetails: { dropId: message.dropId, deliveryId: message.deliveryId, recipientCount: message.recipients.length },
    retryableFailurePrefix: 'resend shipper ready email failed',
  });
}

function optionalTrimmedString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

async function sendStripeCheckoutManualReviewEmail(
  message: StripeCheckoutManualReviewEmailMessage,
): Promise<NotificationEmailResult> {
  const email = buildStripeCheckoutManualReviewEmailContent(message);
  return sendResendNotificationEmail({
    notificationKind: 'stripe_checkout_manual_review',
    idempotencyKey: message.idempotencyKey,
    recipients: message.recipients,
    subject: email.subject,
    text: email.text,
    html: email.html,
    retryableErrorName: 'RetryableStripeCheckoutManualReviewEmailError',
    missingApiKeyMessage: 'RESEND_API_KEY is not configured for Stripe checkout manual review email',
    missingApiKeyDetails: { dropId: message.dropId, sessionId: message.sessionId, recipientCount: message.recipients.length },
    retryableFailurePrefix: 'resend Stripe checkout manual review email failed',
  });
}

async function sendResendNotificationEmail(params: {
  notificationKind: ResendNotificationEmailKind;
  idempotencyKey: string;
  recipients: string[];
  subject: string;
  text: string;
  html: string;
  retryableErrorName: RetryableNotificationEmailErrorName;
  missingApiKeyMessage: string;
  missingApiKeyDetails: unknown;
  retryableFailurePrefix: string;
}): Promise<NotificationEmailResult> {
  if (!shouldSendResendNotificationEmail(params.notificationKind)) {
    return {
      status: 'skipped',
      provider: 'resend',
      reason: RESEND_NON_CHECKOUT_ERROR_NOTIFICATION_EMAILS_DISABLED_REASON,
    };
  }

  const resend = await resendClient();
  if (!resend) {
    throw new RetryableNotificationEmailError(
      params.retryableErrorName,
      params.missingApiKeyMessage,
      'resend_api_key_not_configured',
      params.missingApiKeyDetails,
    );
  }

  const result = await resend.emails.send(
    {
      from: NOTIFICATION_EMAIL_FROM,
      to: params.recipients,
      subject: params.subject,
      text: params.text,
      html: params.html,
    },
    { idempotencyKey: params.idempotencyKey },
  );

  if (result.error) {
    const providerError = summarizeResendError(result.error);
    if (isRetryableResendError(providerError)) {
      throw new RetryableNotificationEmailError(
        params.retryableErrorName,
        `${params.retryableFailurePrefix}: ${providerError.message}`,
        'resend_retryable_error',
        providerError,
      );
    }
    return {
      status: 'failed_permanent',
      provider: 'resend',
      reason: `resend_${providerError.name}`,
      providerError,
    };
  }

  return { status: 'sent', provider: 'resend', ...(result.data?.id ? { messageId: result.data.id } : {}) };
}

async function reserveEmailNotification(params: {
  notificationRef: FirebaseFirestore.DocumentReference;
  nowMs: number;
  leaseMs: number;
  notification: Record<string, unknown>;
}): Promise<EmailNotificationReservation> {
  return db.runTransaction<EmailNotificationReservation>(async (tx) => {
    const snap = await tx.get(params.notificationRef);
    const existing = snap.exists ? (snap.data() as any) : null;
    const existingStatus = typeof existing?.status === 'string' ? existing.status : '';
    if (
      existing?.sentAt ||
      existingStatus === 'sent' ||
      existingStatus === 'skipped' ||
      existingStatus === 'failed_permanent'
    ) {
      return { reserved: false, reason: 'already_completed' };
    }

    const leaseExpiresAt = toMillisMaybe(existing?.leaseExpiresAt) || 0;
    if (existingStatus === 'sending' && leaseExpiresAt > params.nowMs) {
      return { reserved: false, reason: 'send_in_progress', leaseExpiresAt };
    }

    tx.set(
      params.notificationRef,
      {
        ...params.notification,
        attempts: FieldValue.increment(1),
        lastAttemptAt: FieldValue.serverTimestamp(),
        leaseExpiresAt: Timestamp.fromMillis(params.nowMs + params.leaseMs),
        failedAt: FieldValue.delete(),
        skippedAt: FieldValue.delete(),
        skipReason: FieldValue.delete(),
        lastError: FieldValue.delete(),
      },
      { merge: true },
    );

    return { reserved: true, reason: 'reserved' };
  });
}

async function recordEmailNotificationSendResult(
  notificationRef: FirebaseFirestore.DocumentReference,
  result: NotificationEmailResult,
): Promise<void> {
  if (result.status === 'sent') {
    await notificationRef.set(
      {
        status: 'sent',
        sentAt: FieldValue.serverTimestamp(),
        transport: {
          provider: result.provider,
          ...(result.messageId ? { messageId: result.messageId } : {}),
        },
        leaseExpiresAt: FieldValue.delete(),
        failedAt: FieldValue.delete(),
        skippedAt: FieldValue.delete(),
        skipReason: FieldValue.delete(),
        lastError: FieldValue.delete(),
      },
      { merge: true },
    );
    return;
  }

  if (result.status === 'skipped') {
    await notificationRef.set(
      {
        status: 'skipped',
        skippedAt: FieldValue.serverTimestamp(),
        skipReason: result.reason,
        transport: {
          provider: result.provider,
        },
        leaseExpiresAt: FieldValue.delete(),
        failedAt: FieldValue.delete(),
        failureReason: FieldValue.delete(),
        lastError: FieldValue.delete(),
      },
      { merge: true },
    );
    return;
  }

  await notificationRef.set(
    {
      status: 'failed_permanent',
      failedAt: FieldValue.serverTimestamp(),
      failureReason: result.reason,
      transport: {
        provider: result.provider,
        error: result.providerError,
      },
      leaseExpiresAt: FieldValue.delete(),
      skippedAt: FieldValue.delete(),
      skipReason: FieldValue.delete(),
      lastError: result.providerError,
    },
    { merge: true },
  );
}

async function recordEmailNotificationSendFailure(
  notificationRef: FirebaseFirestore.DocumentReference,
  errorSummary: unknown,
): Promise<void> {
  await notificationRef.set(
    {
      status: 'failed',
      failedAt: FieldValue.serverTimestamp(),
      lastError: errorSummary,
      leaseExpiresAt: FieldValue.delete(),
    },
    { merge: true },
  );
}

type ReservedEmailNotificationParams = {
  notificationRef: FirebaseFirestore.DocumentReference;
  leaseMs: number;
  notification: Record<string, unknown>;
  reservedElsewhereLogEvent: string;
  failureLogEvent: string;
  failureWriteFailedLogEvent: string;
  logMeta: Record<string, unknown>;
  retryableErrorName: RetryableNotificationEmailErrorName;
  sendInProgressMessage: string;
  send: () => Promise<NotificationEmailResult>;
};

async function runReservedEmailNotification(params: ReservedEmailNotificationParams): Promise<void> {
  const reservation = await reserveEmailNotification({
    notificationRef: params.notificationRef,
    nowMs: Date.now(),
    leaseMs: params.leaseMs,
    notification: params.notification,
  });

  if (!reservation.reserved) {
    logger.info(params.reservedElsewhereLogEvent, {
      ...params.logMeta,
      reason: reservation.reason,
      ...(reservation.reason === 'send_in_progress' ? { leaseExpiresAt: reservation.leaseExpiresAt } : {}),
    });
    if (reservation.reason === 'send_in_progress') {
      throw new RetryableNotificationEmailError(
        params.retryableErrorName,
        params.sendInProgressMessage,
        'notification_send_in_progress',
        { ...params.logMeta, leaseExpiresAt: reservation.leaseExpiresAt },
      );
    }
    return;
  }

  try {
    const result = await params.send();
    await recordEmailNotificationSendResult(params.notificationRef, result);
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    const errorSummary = summarizeError(err);
    logger.error(params.failureLogEvent, error, {
      ...params.logMeta,
      error: errorSummary,
    });
    await recordEmailNotificationSendFailure(params.notificationRef, errorSummary).catch((writeErr) => {
      const writeError = writeErr instanceof Error ? writeErr : new Error(String(writeErr));
      logger.error(params.failureWriteFailedLogEvent, writeError, {
        ...params.logMeta,
        error: summarizeError(writeErr),
      });
    });
    throw err;
  }
}

type BuyerOrderEmailItems = BuyerVisibleOrderEmailItem[];
type ShipperOrderEmailItems = ShipperVisibleOrderEmailItem[];

async function sendShipperReadyToShipNotification(params: {
  orderRef: DocumentReference;
  order: any;
  dropId: string;
  dropName: string;
  deliveryId: number;
  recipients: string[];
  itemPreviews: ShipperOrderEmailItems;
}): Promise<void> {
  const notificationRef = params.orderRef.collection('notifications').doc(SHIPPER_READY_NOTIFICATION_DOC_ID);
  const idempotencyKey = `${params.dropId}:${params.deliveryId}:ready_to_ship`;
  await runReservedEmailNotification({
    notificationRef,
    leaseMs: SHIPPER_READY_NOTIFICATION_LEASE_MS,
    notification: {
      type: 'shipper_ready_to_ship',
      status: 'sending',
      dropId: params.dropId,
      deliveryId: params.deliveryId,
      deliveryDocId: String(params.deliveryId),
      orderPath: params.orderRef.path,
      recipients: params.recipients,
      recipientCount: params.recipients.length,
      idempotencyKey,
    },
    reservedElsewhereLogEvent: 'notifyShippersOnDeliveryReadyToShip:shipperReadyReservedElsewhere',
    failureLogEvent: 'notifyShippersOnDeliveryReadyToShip:shipperReadyFailed',
    failureWriteFailedLogEvent: 'notifyShippersOnDeliveryReadyToShip:shipperReadyFailureWriteFailed',
    logMeta: { dropId: params.dropId, deliveryId: params.deliveryId },
    retryableErrorName: 'RetryableShipperReadyEmailError',
    sendInProgressMessage: 'shipper ready-to-ship notification send lease is still active',
    send: () =>
      sendShipperReadyToShipEmail({
        idempotencyKey,
        recipients: params.recipients,
        dropId: params.dropId,
        dropName: params.dropName,
        deliveryId: params.deliveryId,
        owner: typeof params.order.owner === 'string' ? params.order.owner : '',
        items: summarizeShipperReadyOrderItems(params.order),
        itemPreviews: params.itemPreviews,
        fulfillmentUrl: fulfillmentAppUrlForOrder(params.dropId, params.deliveryId),
      }),
  });
}

async function sendBuyerOrderReceivedNotification(params: {
  orderRef: DocumentReference;
  order: any;
  dropId: string;
  dropName: string;
  deliveryId: number;
  recipient: string | null;
  items: BuyerOrderEmailItems;
}): Promise<void> {
  const recipients = params.recipient ? [params.recipient] : [];
  const notificationRef = params.orderRef.collection('notifications').doc(BUYER_ORDER_RECEIVED_NOTIFICATION_DOC_ID);
  const idempotencyKey = `${params.dropId}:${params.deliveryId}:order_received`;
  await runReservedEmailNotification({
    notificationRef,
    leaseMs: BUYER_ORDER_RECEIVED_NOTIFICATION_LEASE_MS,
    notification: {
      type: 'buyer_order_received',
      status: 'sending',
      dropId: params.dropId,
      deliveryId: params.deliveryId,
      deliveryDocId: String(params.deliveryId),
      orderPath: params.orderRef.path,
      recipients,
      recipientCount: recipients.length,
      idempotencyKey,
    },
    reservedElsewhereLogEvent: 'notifyShippersOnDeliveryReadyToShip:buyerOrderReceivedReservedElsewhere',
    failureLogEvent: 'notifyShippersOnDeliveryReadyToShip:buyerOrderReceivedFailed',
    failureWriteFailedLogEvent: 'notifyShippersOnDeliveryReadyToShip:buyerOrderReceivedFailureWriteFailed',
    logMeta: { dropId: params.dropId, deliveryId: params.deliveryId },
    retryableErrorName: 'RetryableBuyerOrderReceivedEmailError',
    sendInProgressMessage: 'buyer order-received notification send lease is still active',
    send: async () => {
      if (!params.recipient) {
        logger.info('notifyShippersOnDeliveryReadyToShip:buyerOrderReceivedSkipped', {
          dropId: params.dropId,
          deliveryId: params.deliveryId,
          reason: BUYER_ORDER_RECEIVED_MISSING_RECIPIENT_REASON,
          hasEmailField: typeof params.order?.addressSnapshot?.email === 'string',
        });
        return {
          status: 'skipped',
          provider: 'resend',
          reason: BUYER_ORDER_RECEIVED_MISSING_RECIPIENT_REASON,
        };
      }

      return sendBuyerOrderReceivedEmail({
        idempotencyKey,
        recipients,
        dropId: params.dropId,
        dropName: params.dropName,
        deliveryId: params.deliveryId,
        items: params.items,
      });
    },
  });
}

async function sendBuyerOrderShippedNotification(params: {
  orderRef: DocumentReference;
  order: any;
  dropId: string;
  dropName: string;
  deliveryId: number;
  recipient: string | null;
  items: BuyerOrderEmailItems;
  trackingUrl: string;
}): Promise<void> {
  const recipients = params.recipient ? [params.recipient] : [];
  const notificationRef = params.orderRef.collection('notifications').doc(BUYER_ORDER_SHIPPED_NOTIFICATION_DOC_ID);
  const idempotencyKey = `${params.dropId}:${params.deliveryId}:order_shipped`;
  await runReservedEmailNotification({
    notificationRef,
    leaseMs: BUYER_ORDER_SHIPPED_NOTIFICATION_LEASE_MS,
    notification: {
      type: 'buyer_order_shipped',
      status: 'sending',
      dropId: params.dropId,
      deliveryId: params.deliveryId,
      deliveryDocId: String(params.deliveryId),
      orderPath: params.orderRef.path,
      recipients,
      recipientCount: recipients.length,
      idempotencyKey,
      trackingUrl: params.trackingUrl,
    },
    reservedElsewhereLogEvent: 'notifyBuyerOnDeliveryShipped:reservedElsewhere',
    failureLogEvent: 'notifyBuyerOnDeliveryShipped:failed',
    failureWriteFailedLogEvent: 'notifyBuyerOnDeliveryShipped:failureWriteFailed',
    logMeta: { dropId: params.dropId, deliveryId: params.deliveryId },
    retryableErrorName: 'RetryableBuyerOrderShippedEmailError',
    sendInProgressMessage: 'buyer order-shipped notification send lease is still active',
    send: async () => {
      if (!params.recipient) {
        logger.info('notifyBuyerOnDeliveryShipped:skipped', {
          dropId: params.dropId,
          deliveryId: params.deliveryId,
          reason: BUYER_ORDER_SHIPPED_MISSING_RECIPIENT_REASON,
          hasEmailField: typeof params.order?.addressSnapshot?.email === 'string',
        });
        return {
          status: 'skipped',
          provider: 'resend',
          reason: BUYER_ORDER_SHIPPED_MISSING_RECIPIENT_REASON,
        };
      }

      return sendBuyerOrderShippedEmail({
        idempotencyKey,
        recipients,
        dropId: params.dropId,
        dropName: params.dropName,
        deliveryId: params.deliveryId,
        items: params.items,
        trackingUrl: params.trackingUrl,
      });
    },
  });
}

export const notifyShippersOnDeliveryReadyToShip = onDocumentWritten(
  {
    document: 'drops/{dropId}/deliveryOrders/{deliveryId}',
    secrets: [RESEND_API_KEY],
    retry: true,
  },
  async (event) => {
    const beforeSnap = event.data?.before;
    const afterSnap = event.data?.after;
    if (!afterSnap?.exists) return;
    if (
      !shouldNotifyShippersForDeliveryReadyToShipWrite({
        before: beforeSnap?.exists ? { status: beforeSnap.get('status') } : null,
        after: { status: afterSnap.get('status'), source: afterSnap.get('source') },
        ignoredSources: [ADMIN_IRL_REDEEM_DELIVERY_ORDER_SOURCE],
      })
    ) {
      return;
    }
    const after = afterSnap.data() as any;

    let dropId: string;
    let dropName: string;
    try {
      dropId = requireDropId(event.params.dropId);
      const dropRuntime = getDropRuntime(dropId);
      dropName = dropRuntime.config.collectionName || dropId;
    } catch (err) {
      logger.warn('notifyShippersOnDeliveryReadyToShip:invalidDrop', {
        dropId: event.params.dropId,
        error: summarizeError(err),
      });
      return;
    }

    const deliveryDocId = String(event.params.deliveryId || '').trim();
    const deliveryId = resolveNotificationDeliveryId({
      deliveryDocId,
      storedDeliveryId: after.deliveryId,
    });
    if (!deliveryId) {
      logger.warn('notifyShippersOnDeliveryReadyToShip:invalidDeliveryId', {
        dropId,
        deliveryDocId,
        storedDeliveryId: after.deliveryId ?? null,
      });
      return;
    }

    const notificationPlan = planReadyToShipOrderNotifications({
      buyerEmail: after?.addressSnapshot?.email,
      shipperRecipients: Array.from(SHIPPER_READY_EMAILS_BY_DROP_ID.get(dropId) || []).sort(),
    });
    const buyerOrderEmailItems: BuyerOrderEmailItems = notificationPlan.buyerRecipient
      ? await buildBuyerVisibleOrderEmailItems(after, { dropId })
      : [];
    const shipperOrderEmailItems: ShipperOrderEmailItems = notificationPlan.shipperRecipients.length
      ? await buildShipperVisibleOrderEmailItems(after, { dropId })
      : [];
    const orderRef = afterSnap.ref;
    const tasks: Promise<void>[] = [
      sendBuyerOrderReceivedNotification({
        orderRef,
        order: after,
        dropId,
        dropName,
        deliveryId,
        recipient: notificationPlan.buyerRecipient,
        items: buyerOrderEmailItems,
      }),
    ];

    if (notificationPlan.shipperRecipients.length) {
      tasks.push(
        sendShipperReadyToShipNotification({
          orderRef,
          order: after,
          dropId,
          dropName,
          deliveryId,
          recipients: notificationPlan.shipperRecipients,
          itemPreviews: shipperOrderEmailItems,
        }),
      );
    }

    const results = await Promise.allSettled(tasks);
    const rejected = firstRejectedReadyToShipNotificationError(results, isRetryableNotificationEmailError);
    if (rejected) throw rejected;
  },
);

export const notifyBuyerOnDeliveryShipped = onDocumentUpdated(
  {
    document: 'drops/{dropId}/deliveryOrders/{deliveryId}',
    secrets: [RESEND_API_KEY],
    retry: true,
  },
  async (event) => {
    const beforeSnap = event.data?.before;
    const afterSnap = event.data?.after;
    if (!beforeSnap || !afterSnap) return;
    if (
      !shouldNotifyBuyerForDeliveryShippedWrite({
        before: {
          fulfillmentStatus: beforeSnap.get('fulfillmentStatus'),
          fulfillmentTrackingCode: beforeSnap.get('fulfillmentTrackingCode'),
        },
        after: {
          fulfillmentStatus: afterSnap.get('fulfillmentStatus'),
          fulfillmentTrackingCode: afterSnap.get('fulfillmentTrackingCode'),
          source: afterSnap.get('source'),
        },
        ignoredSources: [ADMIN_IRL_REDEEM_DELIVERY_ORDER_SOURCE],
      })
    ) {
      return;
    }

    let dropId: string;
    let dropName: string;
    try {
      dropId = requireDropId(event.params.dropId);
      const dropRuntime = getDropRuntime(dropId);
      dropName = dropRuntime.config.collectionName || dropId;
    } catch (err) {
      logger.warn('notifyBuyerOnDeliveryShipped:invalidDrop', {
        dropId: event.params.dropId,
        error: summarizeError(err),
      });
      return;
    }

    const deliveryDocId = String(event.params.deliveryId || '').trim();
    const order = afterSnap.data() as any;
    const deliveryId = resolveNotificationDeliveryId({
      deliveryDocId,
      storedDeliveryId: order.deliveryId,
    });
    if (!deliveryId) {
      logger.warn('notifyBuyerOnDeliveryShipped:invalidDeliveryId', {
        dropId,
        deliveryDocId,
        storedDeliveryId: order.deliveryId ?? null,
      });
      return;
    }

    const trackingUrl = resolveFulfillmentTrackingHref(order.fulfillmentTrackingCode);
    if (!trackingUrl) return;

    const recipient = validateNotificationEmailRecipient(order?.addressSnapshot?.email);
    const items = recipient ? await buildBuyerVisibleOrderEmailItems(order, { dropId }) : [];
    await sendBuyerOrderShippedNotification({
      orderRef: afterSnap.ref,
      order,
      dropId,
      dropName,
      deliveryId,
      recipient,
      items,
      trackingUrl,
    });
  },
);

export const notifyStripeCheckoutManualReview = onDocumentUpdated(
  {
    document: 'drops/{dropId}/stripeCheckouts/{sessionId}',
    secrets: [RESEND_API_KEY],
    retry: true,
  },
  async (event) => {
    const beforeSnap = event.data?.before;
    const afterSnap = event.data?.after;
    if (!beforeSnap || !afterSnap) return;
    if (
      afterSnap.get('status') !== STRIPE_CHECKOUT_STATUS.FULFILLMENT_FAILED ||
      afterSnap.get('manualRefundReviewRequired') !== true
    ) {
      return;
    }
    if (
      beforeSnap.get('status') === STRIPE_CHECKOUT_STATUS.FULFILLMENT_FAILED &&
      beforeSnap.get('manualRefundReviewRequired') === true
    ) {
      return;
    }

    let dropId: string;
    let dropName: string;
    let sessionId: string;
    try {
      dropId = requireDropId(event.params.dropId);
      sessionId = requireStripeCheckoutSessionId(event.params.sessionId);
      const dropRuntime = getDropRuntime(dropId);
      dropName = dropRuntime.config.collectionName || dropId;
    } catch (err) {
      logger.warn('notifyStripeCheckoutManualReview:invalidParams', {
        dropId: event.params.dropId,
        sessionId: event.params.sessionId,
        error: summarizeError(err),
      });
      return;
    }

    const recipient = normalizeNotificationEmailRecipient(STRIPE_CHECKOUT_MANUAL_REVIEW_EMAIL);
    if (!recipient) {
      logger.warn('notifyStripeCheckoutManualReview:invalidRecipient', { email: STRIPE_CHECKOUT_MANUAL_REVIEW_EMAIL });
      return;
    }
    const recipients = [recipient];
    const checkout = afterSnap.data() as any;
    const checkoutRef = afterSnap.ref;
    const notificationRef = checkoutRef.collection('notifications').doc(STRIPE_CHECKOUT_MANUAL_REVIEW_NOTIFICATION_DOC_ID);
    const idempotencyKey = `${dropId}:${sessionId}:stripe_manual_review`;

    await runReservedEmailNotification({
      notificationRef,
      leaseMs: STRIPE_CHECKOUT_MANUAL_REVIEW_NOTIFICATION_LEASE_MS,
      notification: {
        type: 'stripe_checkout_manual_review',
        status: 'sending',
        dropId,
        sessionId,
        checkoutPath: checkoutRef.path,
        recipients,
        recipientCount: recipients.length,
        idempotencyKey,
      },
      reservedElsewhereLogEvent: 'notifyStripeCheckoutManualReview:reservedElsewhere',
      failureLogEvent: 'notifyStripeCheckoutManualReview:failed',
      failureWriteFailedLogEvent: 'notifyStripeCheckoutManualReview:failureWriteFailed',
      logMeta: { dropId, sessionId },
      retryableErrorName: 'RetryableStripeCheckoutManualReviewEmailError',
      sendInProgressMessage: 'Stripe checkout manual review notification send lease is still active',
      send: () =>
        sendStripeCheckoutManualReviewEmail({
          idempotencyKey,
          recipients,
          dropId,
          dropName,
          sessionId,
          checkoutPath: checkoutRef.path,
          livemode: checkout?.livemode === true,
          variantKey: optionalTrimmedString(checkout?.variantKey),
          owner: optionalTrimmedString(checkout?.owner),
          firebaseUid: optionalTrimmedString(checkout?.firebaseUid || checkout?.uid),
          manualRefundReviewReason: optionalTrimmedString(checkout?.manualRefundReviewReason),
          lastFulfillmentError: checkout?.lastFulfillmentError,
          createdAt: toMillisMaybe(checkout?.createdAt),
          fulfillmentRequestedAt: toMillisMaybe(checkout?.fulfillmentRequestedAt),
          processingStartedAt: toMillisMaybe(checkout?.processingStartedAt),
          failedAt: toMillisMaybe(checkout?.failedAt),
        }),
    });
  },
);

function dropIdFromDeliveryOrderPath(path: string): string | null {
  const parts = String(path || '').split('/');
  if (parts.length !== 4) return null;
  if (parts[0] !== 'drops' || parts[2] !== 'deliveryOrders') return null;
  return normalizeDropIdMaybe(parts[1]);
}

function resolveDeliveryOrderDropId(order: any, docPath: string): string | null {
  return normalizeDropIdMaybe(order?.dropId) || dropIdFromDeliveryOrderPath(docPath);
}

function toDeliveryOrderSummary(docId: string, order: any, docPath: string): DeliveryOrderSummary | null {
  if (order?.source === ADMIN_IRL_REDEEM_DELIVERY_ORDER_SOURCE) return null;

  const deliveryIdRaw = order?.deliveryId ?? docId;
  const deliveryId = Number(deliveryIdRaw);
  if (!Number.isFinite(deliveryId)) return null;
  const dropId = resolveDeliveryOrderDropId(order, docPath);
  if (!dropId) return null;

  const itemsRaw = Array.isArray(order?.items) ? order.items : [];
  const items = itemsRaw
    .filter((item: any) => item && (item.kind === 'box' || item.kind === 'dude'))
    .map((item: any) => ({
      kind: item.kind as 'box' | 'dude',
      refId: Math.floor(Number(item.refId)),
    }))
    .filter((item: DeliveryOrderItemSummary) => Number.isFinite(item.refId) && item.refId > 0);

  return {
    dropId,
    deliveryId,
    status: typeof order?.status === 'string' ? order.status : 'unknown',
    stripeCheckoutSessionId: optionalTrimmedString(order?.stripeCheckoutSessionId),
    createdAt: toMillisMaybe(order?.createdAt),
    processingAt: toMillisMaybe(order?.processingAt),
    processedAt: toMillisMaybe(order?.processedAt),
    items,
    fulfillmentStatus: normalizeFulfillmentStatus(order?.fulfillmentStatus),
    fulfillmentTrackingCode: normalizeOptionalFulfillmentTrackingCode(order?.fulfillmentTrackingCode),
    fulfillmentUpdatedAt: toMillisMaybe(order?.fulfillmentUpdatedAt),
  };
}

const DELIVERY_ORDER_SUMMARY_FIELDS = [
  'dropId',
  'deliveryId',
  'source',
  'status',
  'stripeCheckoutSessionId',
  'createdAt',
  'processingAt',
  'processedAt',
  'items',
  'fulfillmentStatus',
  'fulfillmentTrackingCode',
  'fulfillmentUpdatedAt',
] as const;

function toDeliveryOrderSummaries(docs: Array<{ id: string; data(): any; ref: { path: string } }>): DeliveryOrderSummary[] {
  return docs
    .map((doc) => toDeliveryOrderSummary(doc.id, doc.data(), doc.ref.path))
    .filter((entry): entry is DeliveryOrderSummary => Boolean(entry));
}

async function fetchDeliveryOrderHistory(ownerId: string): Promise<DeliveryOrderSummary[]> {
  const [readySnap, processingSnap] = await Promise.all([
    db
      .collectionGroup('deliveryOrders')
      .where('owner', '==', ownerId)
      .where('status', '==', 'ready_to_ship')
      .select(...DELIVERY_ORDER_SUMMARY_FIELDS)
      .get(),
    db
      .collectionGroup('deliveryOrders')
      .where('owner', '==', ownerId)
      .where('status', '==', 'processing')
      .select(...DELIVERY_ORDER_SUMMARY_FIELDS)
      .get(),
  ]);

  const summaries = toDeliveryOrderSummaries([...readySnap.docs, ...processingSnap.docs]);
  summaries.sort(
    (a, b) => (b.processedAt ?? b.processingAt ?? b.createdAt ?? 0) - (a.processedAt ?? a.processingAt ?? a.createdAt ?? 0),
  );
  return summaries;
}

function encodeDeliveryOrderOwnersCursor(cursor: DeliveryOrderOwnersCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function parseDeliveryOrderOwnersCursor(rawCursor: unknown): DeliveryOrderOwnersCursor | null {
  if (typeof rawCursor !== 'string' || !rawCursor.trim()) return null;
  try {
    const decoded = Buffer.from(rawCursor, 'base64url').toString('utf8');
    const parsed = JSON.parse(decoded) as unknown;
    const path = typeof parsed === 'string' ? parsed : (parsed as Partial<DeliveryOrderOwnersCursor>)?.path;
    if (typeof path !== 'string' || !dropIdFromDeliveryOrderPath(path)) throw new Error('path');
    return { path };
  } catch {
    throw new HttpsError('invalid-argument', 'Invalid cursor');
  }
}

function toFulfillmentOrder(
  docId: string,
  order: any,
  options: { canViewSensitiveAddress: boolean; dropId: string },
): FulfillmentOrder | null {
  const deliveryIdRaw = order?.deliveryId ?? docId;
  const deliveryId = Number(deliveryIdRaw);
  if (!Number.isFinite(deliveryId)) return null;
  const owner = typeof order?.owner === 'string' ? order.owner : '';
  const source = typeof order?.source === 'string' ? order.source : undefined;
  const status = typeof order?.status === 'string' ? order.status : 'unknown';
  const isAdminIrlRedeem = source === ADMIN_IRL_REDEEM_DELIVERY_ORDER_SOURCE;

  const addressSnapshot = order?.addressSnapshot || {};
  const encrypted = typeof addressSnapshot?.encrypted === 'string' ? addressSnapshot.encrypted : '';
  const rawEmail = typeof addressSnapshot?.email === 'string' ? addressSnapshot.email : undefined;
  const rawPhone = typeof addressSnapshot?.phone === 'string' ? addressSnapshot.phone.trim() || undefined : undefined;
  let full: string | null = null;
  let email = rawEmail;
  let phone = rawPhone;
  let encryptedPayload = encrypted || undefined;
  if (isAdminIrlRedeem) {
    full = ADMIN_IRL_REDEEM_ADDRESS_SNAPSHOT.label;
    email = undefined;
    phone = undefined;
    encryptedPayload = undefined;
  } else if (options.canViewSensitiveAddress) {
    if (encrypted) {
      full = decryptAddressPayload(encrypted);
    }
  } else {
    full = encrypted ? '***' : null;
    email = undefined;
    phone = undefined;
    encryptedPayload = undefined;
  }

  const address: FulfillmentOrderAddress = {
    label: isAdminIrlRedeem
      ? ADMIN_IRL_REDEEM_ADDRESS_SNAPSHOT.label
      : typeof addressSnapshot?.label === 'string'
        ? addressSnapshot.label
        : undefined,
    email,
    phone,
    country: isAdminIrlRedeem
      ? ADMIN_IRL_REDEEM_ADDRESS_SNAPSHOT.country
      : typeof addressSnapshot?.country === 'string'
        ? addressSnapshot.country
        : undefined,
    countryCode: typeof addressSnapshot?.countryCode === 'string' ? addressSnapshot.countryCode : undefined,
    hint: typeof addressSnapshot?.hint === 'string' ? addressSnapshot.hint : undefined,
    encrypted: encryptedPayload,
    full,
  };

  const itemsRaw = Array.isArray(order?.items) ? order.items : [];
  const boxItems = itemsRaw
    .filter((item: any) => item && item.kind === 'box')
    .map((item: any) => ({
      assetId: typeof item.assetId === 'string' ? item.assetId : undefined,
      refId: Math.floor(Number(item.refId)),
    }))
    .filter((item: any) => Number.isFinite(item.refId) && item.refId > 0);

  const looseDudeItems = itemsRaw
    .filter((item: any) => item && item.kind === 'dude')
    .map((item: any) => ({
      figureId: Math.floor(Number(item.refId)),
      assetId: typeof item.assetId === 'string' ? item.assetId.trim() : '',
    }))
    .filter((item: { figureId: number }) => Number.isFinite(item.figureId) && item.figureId > 0);
  const looseDudes = looseDudeItems.map((item: { figureId: number }) => item.figureId).sort((a: number, b: number) => a - b);

  const claimsRaw = Array.isArray(order?.irlClaims) ? order.irlClaims : [];
  const claimsByBoxId = new Map<number, { code?: string; dudeIds?: number[]; boxAssetId?: string }>();
  for (const claim of claimsRaw) {
    const boxId = Math.floor(Number(claim?.boxId));
    if (!Number.isFinite(boxId) || boxId <= 0) continue;
    const dudeIdsRaw = Array.isArray(claim?.dudeIds) ? claim.dudeIds : [];
    const dudeIds = dudeIdsRaw.map((id: any) => Math.floor(Number(id))).filter((id: number) => Number.isFinite(id) && id > 0);
    claimsByBoxId.set(boxId, {
      code: typeof claim?.code === 'string' ? claim.code : undefined,
      dudeIds,
      boxAssetId: typeof claim?.boxAssetId === 'string' ? claim.boxAssetId : undefined,
    });
  }

  const stripeReceiptClaimsByBoxId = collectStripeReceiptClaimsByBoxId(order);

  const boxes: FulfillmentOrderBox[] = boxItems
    .map((item) => {
      const claim = claimsByBoxId.get(item.refId);
      const receiptClaim = stripeReceiptClaimsByBoxId.get(item.refId);
      return {
        boxId: item.refId,
        assetId: item.assetId || claim?.boxAssetId,
        claimCode: claim?.code,
        ...(receiptClaim?.code ? { receiptClaimCode: receiptClaim.code } : {}),
        ...(receiptClaim?.status ? { receiptClaimStatus: receiptClaim.status } : {}),
        dudeIds: Array.isArray(claim?.dudeIds) ? claim.dudeIds : [],
      };
    })
    .sort((a, b) => a.boxId - b.boxId);

  const cardClaims: FulfillmentOrderCardClaim[] = [];
  const directCardClaim = order?.stripeReceiptClaim;
  if (
    isAdminIrlRedeem &&
    order?.adminIrlRedeem?.targetKind === 'card_receipt' &&
    directCardClaim?.receiptKind === 'figure'
  ) {
    const figureId = Math.floor(Number(directCardClaim?.figureId));
    const receiptAssetId = typeof directCardClaim?.receiptAssetId === 'string' ? directCardClaim.receiptAssetId.trim() : '';
    const item = looseDudeItems.find(
      (candidate: { figureId: number; assetId: string }) =>
        candidate.figureId === figureId && (!receiptAssetId || !candidate.assetId || candidate.assetId === receiptAssetId),
    );
    if (item && receiptAssetId) {
      const summary = stripeReceiptClaimSummary(directCardClaim);
      cardClaims.push({
        figureId,
        assetId: receiptAssetId,
        ...(summary.code ? { receiptClaimCode: summary.code } : {}),
        ...(summary.status ? { receiptClaimStatus: summary.status } : {}),
      });
    }
  }

  return {
    dropId: options.dropId,
    deliveryId,
    owner,
    source,
    status,
    createdAt: toMillisMaybe(order?.createdAt),
    processedAt: toMillisMaybe(order?.processedAt),
    fulfillmentStatus: normalizeFulfillmentStatus(order?.fulfillmentStatus),
    fulfillmentTrackingCode: normalizeOptionalFulfillmentTrackingCode(order?.fulfillmentTrackingCode),
    fulfillmentUpdatedAt: toMillisMaybe(order?.fulfillmentUpdatedAt),
    fulfillmentInternalStatus: typeof order?.fulfillmentInternalStatus === 'string' ? order.fulfillmentInternalStatus : undefined,
    address,
    boxes,
    looseDudes,
    cardClaims,
  };
}

function resolveInstructionAccounts(tx: any): PublicKey[] {
  if (!tx?.transaction?.message) return [];
  const accountKeys = tx.transaction.message.getAccountKeys({
    accountKeysFromLookups: tx.meta?.loadedAddresses,
  });
  const lookupWritable = (accountKeys?.accountKeysFromLookups?.writable || []).map((k: any) => new PublicKey(k));
  const lookupReadonly = (accountKeys?.accountKeysFromLookups?.readonly || []).map((k: any) => new PublicKey(k));
  const staticKeys = (accountKeys?.staticAccountKeys || []).map((k: any) => new PublicKey(k));
  return [...staticKeys, ...lookupWritable, ...lookupReadonly];
}

function getPayerFromTx(tx: any): PublicKey | null {
  const accounts = resolveInstructionAccounts(tx);
  return accounts.length ? accounts[0] : null;
}

type DeliveryOrderDoc = {
  id: string;
  ref: FirebaseFirestore.DocumentReference;
  data(): any;
};

function normalizeRecoveryErrorCode(err: unknown): string | undefined {
  const code = typeof (err as any)?.code === 'string' ? String((err as any).code) : '';
  const normalized = normalizeCallableErrorCode(code);
  return normalized || undefined;
}

function normalizeRecoveryMessage(message: unknown): string | undefined {
  const value = String(message || '').trim();
  if (!value) return undefined;
  return value.slice(0, 300);
}

function processingDeliveryRecoveryReferenceMs(order: any): number {
  const createdAt = toMillisMaybe(order?.createdAt) ?? 0;
  const processingAt = toMillisMaybe(order?.processingAt) ?? 0;
  const lastAttemptAt = toMillisMaybe(order?.receiptRecovery?.lastAttemptAt) ?? 0;
  return Math.max(lastAttemptAt, processingAt, createdAt);
}

function preparedDeliveryRecoveryCheckCount(order: any): number {
  const raw = Number(order?.receiptRecovery?.preparedProbeCount || 0);
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  return Math.floor(raw);
}

function nextPreparedDeliveryRecoveryDelayMs(probeCount: number): number | null {
  return DELIVERY_RECOVERY_PREPARED_CHECK_DELAYS_MS[probeCount] ?? null;
}

function preparedDeliveryRecoveryNextCheckMs(order: any): number | null {
  const probeCount = preparedDeliveryRecoveryCheckCount(order);
  if (probeCount >= MAX_PREPARED_DELIVERY_RECOVERY_CHECKS) return null;
  const scheduledAt = toMillisMaybe(order?.receiptRecovery?.nextPreparedProbeAt);
  if (scheduledAt && scheduledAt > 0) return scheduledAt;
  const createdAt = toMillisMaybe(order?.createdAt) ?? 0;
  if (createdAt <= 0) return Date.now();
  const initialDelayMs = nextPreparedDeliveryRecoveryDelayMs(probeCount) ?? 0;
  return createdAt + initialDelayMs;
}

function processingDeliveryRecoveryNextCheckMs(order: any, nowMs: number): number | null {
  const status = typeof order?.status === 'string' ? order.status : '';
  if (status !== 'processing') return null;
  const leaseExpiresAt = toMillisMaybe(order?.receiptRecovery?.leaseExpiresAt) ?? 0;
  const lastAttemptAt = toMillisMaybe(order?.receiptRecovery?.lastAttemptAt) ?? 0;
  const retryAt = lastAttemptAt > 0 ? lastAttemptAt + DELIVERY_RECOVERY_PROCESSING_RETRY_DELAY_MS : nowMs;
  const nextCheckAt = Math.max(retryAt, leaseExpiresAt);
  return Math.max(nowMs, nextCheckAt);
}

function nextDeliveryRecoveryCheckMs(current: number | undefined, candidate: number | null): number | undefined {
  if (candidate == null || !Number.isFinite(candidate)) return current;
  if (current == null || candidate < current) return candidate;
  return current;
}

function deliveryRecoveryPriorityMs(order: any): number {
  const status = typeof order?.status === 'string' ? order.status : '';
  const createdAt = toMillisMaybe(order?.createdAt) ?? 0;
  if (status === 'processing') return processingDeliveryRecoveryReferenceMs(order);
  if (status === 'prepared') return preparedDeliveryRecoveryNextCheckMs(order) ?? createdAt;
  return createdAt;
}

function compareDeliveryRecoveryCandidates(left: DeliveryOrderDoc, right: DeliveryOrderDoc): number {
  const leftOrder = left.data() || {};
  const rightOrder = right.data() || {};
  const leftStatus = typeof leftOrder?.status === 'string' ? leftOrder.status : '';
  const rightStatus = typeof rightOrder?.status === 'string' ? rightOrder.status : '';
  if (leftStatus !== rightStatus) {
    if (leftStatus === 'processing') return -1;
    if (rightStatus === 'processing') return 1;
  }
  const leftPriority = deliveryRecoveryPriorityMs(leftOrder);
  const rightPriority = deliveryRecoveryPriorityMs(rightOrder);
  if (leftPriority !== rightPriority) return leftPriority - rightPriority;
  return left.ref.path.localeCompare(right.ref.path);
}

function deliveryRecoveryEligibility(order: any, nowMs: number, force: boolean): {
  eligible: boolean;
  outcome?: DeliveryRecoveryOutcome;
  message?: string;
} {
  const status = typeof order?.status === 'string' ? order.status : 'unknown';
  if (status === 'processing') {
    if (force) return { eligible: true };
    const lastAttemptAt = toMillisMaybe(order?.receiptRecovery?.lastAttemptAt) ?? 0;
    if (lastAttemptAt > 0 && nowMs - lastAttemptAt < DELIVERY_RECOVERY_PROCESSING_RETRY_DELAY_MS) {
      return { eligible: false, outcome: 'not_eligible', message: 'processing order retry backoff is active' };
    }
    return { eligible: true };
  }
  if (status === 'prepared') {
    if (force) return { eligible: true };
    const nextCheckAt = preparedDeliveryRecoveryNextCheckMs(order);
    if (nextCheckAt == null) {
      return { eligible: false, outcome: 'not_eligible', message: 'prepared order recovery checks are exhausted' };
    }
    if (nextCheckAt > nowMs) {
      return { eligible: false, outcome: 'not_eligible', message: 'prepared order is not due for recovery yet' };
    }
    return { eligible: true };
  }
  if (status === 'prepared_abandoned') {
    if (force) return { eligible: true };
    return { eligible: false, outcome: 'not_eligible', message: 'prepared order recovery checks are exhausted' };
  }
  return { eligible: false, outcome: 'skipped_status', message: `order status \`${status}\` is not recoverable` };
}

function orderResultBase(doc: DeliveryOrderDoc): {
  dropId: string;
  deliveryId: number;
  statusBefore: string;
} | null {
  const order = doc.data() || {};
  const deliveryId = Number(order?.deliveryId ?? doc.id);
  if (!Number.isFinite(deliveryId) || deliveryId <= 0) return null;
  const dropId = resolveDeliveryOrderDropId(order, doc.ref.path);
  if (!dropId) return null;
  return {
    dropId,
    deliveryId,
    statusBefore: typeof order?.status === 'string' ? order.status : 'unknown',
  };
}

async function listOwnedDeliveryOrdersByStatus(
  ownerWallet: string,
  status: 'prepared' | 'processing',
  filterDropId?: string,
): Promise<DeliveryOrderDoc[]> {
  const snap = await db
    .collectionGroup('deliveryOrders')
    .where('owner', '==', ownerWallet)
    .where('status', '==', status)
    .get();
  if (!filterDropId) return snap.docs;
  return snap.docs.filter((doc) => {
    const dropId = resolveDeliveryOrderDropId(doc.data(), doc.ref.path);
    return dropId === filterDropId;
  });
}

async function fetchConfirmedDeliveryRecordAccount(params: {
  dropRuntime: DropRuntime;
  conn: Connection;
  deliveryId: number;
  context: string;
  includeData?: boolean;
}) {
  const { dropRuntime, conn, deliveryId, context, includeData = true } = params;
  const [expectedDeliveryPda, expectedDeliveryBump] = deriveDeliveryPdaForDrop(dropRuntime, deliveryId);
  const deliveryInfo = await withTimeout(
    conn.getAccountInfo(
      expectedDeliveryPda,
      includeData ? { commitment: 'confirmed' } : { commitment: 'confirmed', dataSlice: { offset: 0, length: 0 } },
    ),
    RPC_TIMEOUT_MS,
    context,
  );
  if (!deliveryInfo) return null;
  if (!deliveryInfo.owner.equals(dropRuntime.boxMinterProgramId)) {
    throw new HttpsError('failed-precondition', 'Delivery record PDA is owned by the wrong program');
  }
  return { expectedDeliveryPda, expectedDeliveryBump, deliveryInfo };
}

async function hasConfirmedDeliveryRecord(dropId: string, deliveryId: number): Promise<boolean> {
  return hasConfirmedDeliveryRecordForDeliveryOrder({
    dropId,
    deliveryId,
  });
}

async function recordPreparedDeliveryRecoveryMiss(
  orderRef: FirebaseFirestore.DocumentReference,
  order: any,
  nowMs: number,
): Promise<number | null> {
  const probeCount = preparedDeliveryRecoveryCheckCount(order);
  const nextProbeCount = probeCount + 1;
  const nextDelayMs = nextPreparedDeliveryRecoveryDelayMs(nextProbeCount);
  await orderRef.update({
    'receiptRecovery.preparedProbeCount': nextProbeCount,
    'receiptRecovery.lastPreparedProbeAt': Timestamp.fromMillis(nowMs),
    'receiptRecovery.nextPreparedProbeAt':
      nextDelayMs != null ? Timestamp.fromMillis(nowMs + nextDelayMs) : FieldValue.delete(),
    ...(nextDelayMs == null ? { status: 'prepared_abandoned', preparedRecoveryAbandonedAt: Timestamp.fromMillis(nowMs) } : {}),
  });
  return nextDelayMs != null ? nowMs + nextDelayMs : null;
}

async function stopPreparedDeliveryRecoveryChecks(
  orderRef: FirebaseFirestore.DocumentReference,
  order: any,
  nowMs: number,
) {
  const probeCount = Math.max(preparedDeliveryRecoveryCheckCount(order), MAX_PREPARED_DELIVERY_RECOVERY_CHECKS);
  await orderRef.update({
    status: 'prepared_abandoned',
    preparedRecoveryAbandonedAt: Timestamp.fromMillis(nowMs),
    'receiptRecovery.preparedProbeCount': probeCount,
    'receiptRecovery.lastPreparedProbeAt': Timestamp.fromMillis(nowMs),
    'receiptRecovery.nextPreparedProbeAt': FieldValue.delete(),
  });
}

async function fetchDeliveryRecoveryState(
  ownerWallet: string,
  filterDropId?: string,
): Promise<DeliveryRecoveryState & { remainingProcessing: number }> {
  const nowMs = Date.now();
  const [processingDocs, preparedDocs] = await Promise.all([
    listOwnedDeliveryOrdersByStatus(ownerWallet, 'processing', filterDropId),
    listOwnedDeliveryOrdersByStatus(ownerWallet, 'prepared', filterDropId),
  ]);

  let nextCheckAt: number | undefined;
  for (const doc of processingDocs) {
    nextCheckAt = nextDeliveryRecoveryCheckMs(nextCheckAt, processingDeliveryRecoveryNextCheckMs(doc.data(), nowMs));
  }
  for (const doc of preparedDocs) {
    nextCheckAt = nextDeliveryRecoveryCheckMs(nextCheckAt, preparedDeliveryRecoveryNextCheckMs(doc.data()));
  }

  return {
    remainingProcessing: processingDocs.length,
    ...(nextCheckAt != null ? { nextCheckAt } : {}),
  };
}

async function acquireDeliveryRecoveryLease(
  orderRef: FirebaseFirestore.DocumentReference,
  ownerWallet: string,
  nowMs: number,
  force: boolean,
): Promise<
  | { acquired: true }
  | {
      acquired: false;
      result: RecoverMyDeliveryOrdersItemResult;
    }
> {
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(orderRef);
    if (!snap.exists) {
      const deliveryId = Number(orderRef.id);
      const dropId = dropIdFromDeliveryOrderPath(orderRef.path) || '';
      return {
        acquired: false as const,
        result: {
          dropId,
          deliveryId,
          statusBefore: 'missing',
          outcome: 'not_found' as const,
          verification: 'delivery_pda' as const,
          message: 'delivery order not found',
        },
      };
    }

    const order = snap.data() as any;
    const base = orderResultBase({
      id: snap.id,
      ref: snap.ref,
      data: () => order,
    });
    if (!base) {
      return {
        acquired: false as const,
        result: {
          dropId: '',
          deliveryId: Number(snap.id) || 0,
          statusBefore: typeof order?.status === 'string' ? order.status : 'unknown',
          outcome: 'failed' as const,
          verification: 'delivery_pda' as const,
          message: 'delivery order is missing recovery identifiers',
        },
      };
    }

    if (order?.owner && order.owner !== ownerWallet) {
      return {
        acquired: false as const,
        result: {
          ...base,
          outcome: 'failed' as const,
          verification: 'delivery_pda' as const,
          message: 'order belongs to a different wallet',
          errorCode: 'permission-denied',
        },
      };
    }

    const eligibility = deliveryRecoveryEligibility(order, nowMs, force);
    if (!eligibility.eligible) {
      return {
        acquired: false as const,
        result: {
          ...base,
          outcome: eligibility.outcome || 'not_eligible',
          verification: 'delivery_pda' as const,
          ...(eligibility.message ? { message: eligibility.message } : {}),
        },
      };
    }

    const leaseExpiresAt = toMillisMaybe(order?.receiptRecovery?.leaseExpiresAt) ?? 0;
    if (leaseExpiresAt > nowMs) {
      return {
        acquired: false as const,
        result: {
          ...base,
          outcome: 'lease_active' as const,
          verification: 'delivery_pda' as const,
          message: 'another client is already retrying this order',
        },
      };
    }

    const attemptCountRaw = Number(order?.receiptRecovery?.attemptCount || 0);
    const attemptCount = Number.isFinite(attemptCountRaw) && attemptCountRaw > 0 ? Math.floor(attemptCountRaw) + 1 : 1;
    tx.set(
      orderRef,
      {
        receiptRecovery: {
          leaseExpiresAt: Timestamp.fromMillis(nowMs + DELIVERY_RECOVERY_LEASE_MS),
          lastAttemptAt: Timestamp.fromMillis(nowMs),
          attemptCount,
        },
      },
      { merge: true },
    );
    return { acquired: true as const };
  });
}

async function finalizeDeliveryRecoveryAttempt(
  orderRef: FirebaseFirestore.DocumentReference,
  result: { errorCode?: string; message?: string },
) {
  await orderRef.update({
    'receiptRecovery.leaseExpiresAt': FieldValue.delete(),
    'receiptRecovery.lastErrorCode': result.errorCode ? result.errorCode : FieldValue.delete(),
    'receiptRecovery.lastErrorMessage': result.message ? result.message : FieldValue.delete(),
  });
}

async function buildProfileResponse(profileWallet: string, profileData: any, includeRecoveryState: boolean) {
  const [orders, deliveryRecoveryState] = await Promise.all([
    fetchDeliveryOrderHistory(profileWallet),
    includeRecoveryState ? fetchDeliveryRecoveryState(profileWallet) : Promise.resolve<DeliveryRecoveryState | null>(null),
  ]);
  const deliveryRecovery =
    deliveryRecoveryState?.nextCheckAt != null ? ({ nextCheckAt: deliveryRecoveryState.nextCheckAt } satisfies DeliveryRecoveryState) : null;

  return {
    profile: {
      ...profileData,
      wallet: profileWallet,
      email: profileData.email,
      orders,
      ...(deliveryRecovery ? { deliveryRecovery } : {}),
    },
  };
}

async function tryMergeFirebaseStripeDeliveryOrdersToWallet(
  uid: string,
  wallet: string,
  logContext: 'solanaAuth' | 'getProfile',
): Promise<number> {
  try {
    const merged = await mergeFirebaseStripeDeliveryOrdersToWalletInDb(db, uid, wallet);
    if (merged > 0) {
      logger.info(`${logContext}:stripeOwnerMerge`, { wallet, merged });
    }
    return merged;
  } catch (err) {
    logger.warn(`${logContext}:stripeOwnerMergeFailed`, { wallet, error: summarizeError(err) });
    return 0;
  }
}

export const solanaAuth = onCallAuthed('solanaAuth', async (request, uid) => {
  const schema = z.object({
    wallet: z.string().min(32).max(64),
    message: z.string().min(1).max(1024),
    signature: z.array(z.number().int().min(0).max(255)).length(64),
    mergeStripeDeliveryOrders: z.boolean().optional(),
  });
  const { wallet: rawWallet, message, signature, mergeStripeDeliveryOrders } = parseRequest(schema, request.data);
  const wallet = normalizeWallet(rawWallet);

  const statement = parseSolanaSignInMessage(message);
  const statementWallet = normalizeWallet(statement.wallet);
  if (statementWallet !== wallet) {
    throw new HttpsError('invalid-argument', 'Wallet mismatch in signed message');
  }
  if (statement.session !== uid) {
    throw new HttpsError('permission-denied', 'Signed message does not match caller');
  }

  // Soft-ish sanity check: accept timestamps within ±2 days to avoid rejecting clients
  // with mildly incorrect clocks/timezones, while still preventing very stale replays.
  const tsMs = Date.parse(statement.timestamp);
  if (!Number.isFinite(tsMs)) {
    throw new HttpsError('invalid-argument', 'Invalid Timestamp in signed message');
  }
  const MAX_SKEW_MS = 2 * 24 * 60 * 60 * 1000;
  const skewMs = Math.abs(Date.now() - tsMs);
  if (skewMs > MAX_SKEW_MS) {
    throw new HttpsError('failed-precondition', 'Signed message timestamp is too far from current time');
  }

  const pubkey = new PublicKey(wallet);
  const verified = nacl.sign.detached.verify(new TextEncoder().encode(message), parseSignature(signature), pubkey.toBytes());
  if (!verified) throw new HttpsError('unauthenticated', 'Invalid signature');

  await db.doc(`${WALLET_SESSION_COLLECTION}/${uid}`).set(
    {
      wallet,
      updatedAt: FieldValue.serverTimestamp(),
      expiresAt: Timestamp.fromMillis(Date.now() + WALLET_SESSION_TTL_MS),
    },
    { merge: true },
  );

  const profileRef = db.doc(`profiles/${wallet}`);
  const snap = await profileRef.get();
  const profileData = snap.exists ? (snap.data() as any) : {};
  if (!snap.exists) await profileRef.set({ wallet }, { merge: true });
  if (mergeStripeDeliveryOrders === true) {
    await tryMergeFirebaseStripeDeliveryOrdersToWallet(uid, wallet, 'solanaAuth');
  }
  return buildProfileResponse(wallet, profileData, true);
});

export const getProfile = onCallLogged('getProfile', async (request) => {
  const { uid, wallet } = await requireWalletSession(request);
  const schema = z.object({
    ownerWallet: z.string().optional(),
    mergeStripeDeliveryOrders: z.boolean().optional(),
  });
  const { ownerWallet: rawOwnerWallet, mergeStripeDeliveryOrders } = parseRequest(schema, request.data || {});

  let profileWallet = wallet;
  if (typeof rawOwnerWallet === 'string' && rawOwnerWallet.trim()) {
    const requestedWallet = normalizeWallet(rawOwnerWallet.trim());
    if (requestedWallet !== wallet) {
      await requireAdminAccess(request);
    }
    profileWallet = requestedWallet;
  }

  const profileRef = db.doc(`profiles/${profileWallet}`);
  const snap = await profileRef.get();
  const profileData = snap.exists ? (snap.data() as any) : {};
  if (!snap.exists && profileWallet === wallet) {
    await profileRef.set({ wallet: profileWallet }, { merge: true });
  }
  if (profileWallet === wallet && mergeStripeDeliveryOrders === true) {
    await tryMergeFirebaseStripeDeliveryOrdersToWallet(uid, wallet, 'getProfile');
  }
  return buildProfileResponse(profileWallet, profileData, profileWallet === wallet);
});

export const getAnonymousStripeDeliveryHistory = onCallAuthed('getAnonymousStripeDeliveryHistory', async (_request, uid) => {
  const orders = await fetchDeliveryOrderHistory(stripeCheckoutOwnerId(uid));
  return { orders };
});

export const listDeliveryOrderOwners = onCallLogged('listDeliveryOrderOwners', async (request) => {
  await requireAdminAccess(request);
  const schema = z.object({
    cursor: z.string().min(1).max(2000).optional(),
    pageSize: z.number().int().min(1).max(500).optional(),
  });
  const { cursor: rawCursor, pageSize: rawPageSize } = parseRequest(schema, request.data || {});
  const owners: string[] = [];
  const seenOwners = new Set<string>();
  let cursor = parseDeliveryOrderOwnersCursor(rawCursor);
  const pageSize = rawPageSize ?? 200;
  const fetchLimit = Math.min(Math.max(pageSize * 3, pageSize + 1), 500);
  let hasMore = false;

  while (owners.length < pageSize) {
    let query = db
      .collectionGroup('deliveryOrders')
      .select('owner')
      .orderBy(FieldPath.documentId(), 'asc')
      .limit(fetchLimit);
    if (cursor) {
      query = query.startAfter(cursor.path);
    }

    const snap = await query.get();
    if (snap.empty) {
      hasMore = false;
      cursor = null;
      break;
    }

    let lastProcessedCursor: DeliveryOrderOwnersCursor | null = null;
    let lastProcessedIndex = -1;
    for (let index = 0; index < snap.docs.length; index += 1) {
      const doc = snap.docs[index];
      lastProcessedCursor = { path: doc.ref.path };
      lastProcessedIndex = index;
      const rawOwner = doc.get('owner');

      if (typeof rawOwner !== 'string' || !rawOwner.trim()) continue;
      try {
        const owner = normalizeWallet(rawOwner.trim());
        if (seenOwners.has(owner)) continue;
        seenOwners.add(owner);
        owners.push(owner);
        if (owners.length >= pageSize) break;
      } catch {
        // Ignore malformed historical values.
      }
    }

    if (!lastProcessedCursor || lastProcessedIndex < 0) {
      hasMore = false;
      cursor = null;
      break;
    }

    cursor = lastProcessedCursor;
    const endedEarly = lastProcessedIndex < snap.docs.length - 1;
    if (owners.length >= pageSize) {
      hasMore = endedEarly || snap.size === fetchLimit;
      break;
    }

    if (snap.size < fetchLimit) {
      hasMore = false;
      cursor = null;
      break;
    }

    hasMore = true;
  }

  const nextCursor = hasMore && cursor ? encodeDeliveryOrderOwnersCursor(cursor) : null;
  return {
    owners,
    nextCursor,
    hasMore: Boolean(nextCursor),
  };
});

export const saveAddress = onCallLogged('saveAddress', async (request) => {
  const { wallet } = await requireWalletSession(request);

  // Reject obviously oversized payloads early to reduce Firestore doc size/cost risk.
  const MAX_SAVE_ADDRESS_BYTES = 10 * 1024;
  const rawBytes = safeJsonByteLength((request as any)?.data);
  if (!Number.isFinite(rawBytes) || rawBytes > MAX_SAVE_ADDRESS_BYTES) {
    throw new HttpsError('invalid-argument', 'Request payload too large');
  }

  const schema = z.object({
    encrypted: z.string().max(4096),
    country: z.string().max(64),
    countryCode: z.string().max(32).optional(),
    hint: z.string().max(256),
    email: z.string().email().max(254).optional(),
  });
  const body = parseRequest(schema, request.data);
  const id = db.collection('tmp').doc().id;
  const countryCode = normalizeCountryCode(body.countryCode || body.country);
  const addressRef = db.doc(`profiles/${wallet}/addresses/${id}`);
  await addressRef.set(
    {
      ...body,
      countryCode: countryCode || body.countryCode,
      id,
      createdAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );
  await db.doc(`profiles/${wallet}`).set(
    { wallet, ...(body.email ? { email: body.email } : {}) },
    { merge: true },
  );
  return {
    id,
    country: body.country,
    countryCode: countryCode || body.countryCode,
    encrypted: body.encrypted,
    hint: body.hint,
    email: body.email,
  };
});

export const removeAddress = onCallLogged('removeAddress', async (request) => {
  const { wallet } = await requireWalletSession(request);
  const schema = z.object({
    addressId: z.string().min(4).max(128).regex(/^[A-Za-z0-9_-]+$/),
  });
  const { addressId } = parseRequest(schema, request.data);
  const addressRef = db.doc(`profiles/${wallet}/addresses/${addressId}`);
  const snap = await addressRef.get();
  if (!snap.exists) {
    return { id: addressId, removed: false };
  }
  await addressRef.delete();
  return { id: addressId, removed: true };
});

export const subscribeToNotifications = onCallAuthed(
  'subscribeToNotifications',
  async (request) => {
    const { email: rawEmail } = parseRequest(
      z.object({ email: z.unknown() }),
      request.data,
    );
    const email = normalizeNotificationEmailRecipient(rawEmail);
    if (!email) {
      throw new HttpsError('invalid-argument', 'Enter a valid email address.');
    }

    try {
      const resend = await resendContactsClient();
      if (!resend) throw new Error('Resend Contacts is not configured.');
      return await subscribeResendContact({
        email,
        provider: createResendSubscribersProvider(resend),
      });
    } catch {
      throw new HttpsError('internal', 'Unable to subscribe.');
    }
  },
  { secrets: [RESEND_INBOUND_API_KEY] },
);

export const resendInboundWebhook = onRequest(
  {
    secrets: [RESEND_INBOUND_API_KEY, RESEND_WEBHOOK_SECRET],
    memory: '1GiB',
    cpu: 1,
    concurrency: 1,
    maxInstances: 2,
    timeoutSeconds: 120,
  },
  async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (req.method !== 'POST') {
      res.status(405).send('Method not allowed');
      return;
    }

    const resend = await resendInboundClient();
    const webhookSecret = resendWebhookSecret();
    if (!resend || !webhookSecret) {
      logger.error('resendInboundWebhook', { outcome: 'failed_retryable', reason: 'not_configured' });
      res.status(500).send('Resend inbound webhook is not configured');
      return;
    }

    let event: ReturnType<typeof resend.webhooks.verify>;
    let webhookId: string;
    try {
      const headers = resendWebhookHeaders(req);
      webhookId = headers.id;
      event = resend.webhooks.verify({
        payload: resendWebhookRawBody(req),
        headers,
        webhookSecret,
      });
    } catch (err) {
      logger.warn('resendInboundWebhook', { outcome: 'rejected', reason: 'invalid_signature' });
      res.status(400).send('Invalid Resend webhook signature');
      return;
    }

    if (event.type !== 'email.received') {
      res.json({ received: true, ignored: true, reason: 'unsupported_event_type' });
      return;
    }

    let route;
    try {
      route = planResendInboundForward(event as ResendReceivedEventCompat);
    } catch (err) {
      logger.error('resendInboundWebhook', {
        webhookId,
        outcome: 'rejected',
        reason: 'invalid_event',
      });
      res.status(400).send('Invalid Resend email.received event');
      return;
    }

    if (route.kind === 'ignored') {
      logger.info('resendInboundWebhook', {
        webhookId,
        emailId: event.data.email_id,
        outcome: 'ignored',
        reason: route.reason,
      });
      res.json({ received: true, ignored: true, reason: route.reason });
      return;
    }

    let outcome;
    try {
      outcome = await processResendInboundForward({
        plan: route.plan,
        webhookId,
        provider: createResendInboundProvider(resend),
        store: new FirestoreResendInboundStore(db),
      });
    } catch (err) {
      logger.error('resendInboundWebhook', {
        webhookId,
        emailId: route.plan.emailId,
        outcome: 'failed_retryable',
        reason: 'storage_or_processing_failure',
      });
      res.status(500).send('Unable to process Resend inbound email');
      return;
    }

    logger.info('resendInboundWebhook', {
      webhookId,
      emailId: route.plan.emailId,
      outcome: outcome.kind,
      ...('reason' in outcome ? { reason: outcome.reason } : {}),
      ...('attempts' in outcome ? { attempts: outcome.attempts } : {}),
      ...('providerStatus' in outcome ? { providerStatus: outcome.providerStatus } : {}),
    });

    const httpResponse = resendInboundHttpResponse(outcome);
    if (httpResponse.retryAfter) res.set('Retry-After', httpResponse.retryAfter);
    if (typeof httpResponse.body === 'string') {
      res.status(httpResponse.status).send(httpResponse.body);
    } else {
      res.status(httpResponse.status).json(httpResponse.body);
    }
  },
);

export const stripeWebhook = onRequest(
  { secrets: [STRIPE_WEBHOOK_SECRET, STRIPE_WEBHOOK_SECRET_DEVNET] },
  async (req, res) => {
    if (req.method !== 'POST') {
      res.status(405).send('Method not allowed');
      return;
    }

    let endpointSecrets: StripeWebhookEndpointSecret[];
    try {
      endpointSecrets = stripeWebhookEndpointSecrets();
    } catch (err) {
      logger.error('stripeWebhook:notConfigured', err instanceof Error ? err : new Error(String(err)), {
        error: summarizeError(err),
      });
      res.status(500).send('Stripe webhook is not configured');
      return;
    }

    let event: Stripe.Event;
    let verifiedSecretEnvName: StripeWebhookEndpointSecret['envName'];
    let verifiedSecretScope: StripeWebhookSecretScope;
    try {
      const verified = await constructStripeWebhookEventFromConfiguredSecrets(
        stripeWebhookRawBody(req),
        stripeWebhookSignature(req),
        endpointSecrets,
      );
      event = verified.event;
      verifiedSecretEnvName = verified.verifiedSecretEnvName;
      verifiedSecretScope = verified.verifiedSecretScope;
    } catch (err) {
      logger.warn('stripeWebhook:signatureRejected', { error: summarizeError(err) });
      res.status(400).send('Invalid Stripe webhook signature');
      return;
    }

    try {
      const expectedScope = stripeWebhookSecretScopeForEvent(event);
      if (expectedScope && verifiedSecretScope !== expectedScope.expectedSecretScope) {
        logger.warn('stripeWebhook:secretScopeRejected', {
          eventId: event.id,
          dropId: expectedScope.dropId,
          cluster: expectedScope.cluster,
          verifiedSecretEnvName,
          verifiedSecretScope,
          expectedSecretScope: expectedScope.expectedSecretScope,
        });
        res.status(400).send('Invalid Stripe webhook signature');
        return;
      }

      const result = await handleStripeWebhookEvent({
        db,
        event,
        requireDropId,
        getDropRuntime,
      });
      logger.info('stripeWebhook:handled', {
        eventId: event.id,
        sessionId: 'sessionId' in result ? result.sessionId || null : null,
        dropId: 'dropId' in result ? result.dropId || null : null,
        deliveryId: 'deliveryId' in result ? result.deliveryId || null : null,
        queued: result.queued === true,
        reason: 'reason' in result ? result.reason || null : null,
        ignored: result.ignored === true,
        awaitingPayment: 'awaitingPayment' in result && result.awaitingPayment === true,
      });
      res.json({ received: true, ...result });
    } catch (err) {
      logger.error('stripeWebhook:error', err instanceof Error ? err : new Error(String(err)), {
        eventId: event.id,
        error: summarizeError(err),
      });
      res.status(500).json({ received: true, error: err instanceof Error ? err.message : String(err) });
    }
  },
);

export const processStripeCheckoutFulfillment = onDocumentWritten(
  {
    document: 'drops/{dropId}/stripeCheckouts/{sessionId}',
    secrets: [
      STRIPE_SECRET_KEY,
      STRIPE_RESTRICTED_KEY,
      STRIPE_SECRET_KEY_LIVE,
      STRIPE_RESTRICTED_KEY_LIVE,
      COSIGNER_SECRET,
      ADDRESS_DECRYPTION_SECRET,
    ],
    retry: true,
    timeoutSeconds: 180,
  },
  async (event) => {
    const beforeSnap = event.data?.before;
    const checkoutSnap = event.data?.after;
    if (!checkoutSnap?.exists) return;
    if (
      !shouldProcessStripeCheckoutFulfillmentWrite({
        beforeStatus: beforeSnap?.exists ? beforeSnap.get('status') : undefined,
        afterStatus: checkoutSnap.get('status'),
      })
    ) {
      return;
    }

    const dropId = requireDropId(event.params.dropId);
    const sessionId = requireStripeCheckoutSessionId(event.params.sessionId);
    const checkoutRef = checkoutSnap.ref;
    const result = await processStripeCheckoutFulfillmentDocument({
      db,
      dropId,
      sessionId,
      checkoutRef,
      apiKeys: stripeApiKeys(),
      deps: stripeCheckoutFlowDeps(),
    });
    if (result.status === 'ignored') {
      logger.info('processStripeCheckoutFulfillment:notProcessed', {
        dropId,
        sessionId,
        reason: result.reason,
      });
      return;
    }
    if (result.status === 'fulfilled') {
      logger.info('processStripeCheckoutFulfillment:fulfilled', {
        dropId: result.dropId || dropId,
        sessionId,
        deliveryId: result.deliveryId || null,
        metadataId: result.metadataId || null,
        metadataIds: result.metadataIds || null,
      });
      return;
    }
    logger.warn('processStripeCheckoutFulfillment:manualReviewRequired', {
      dropId,
      sessionId,
      error: result.error,
    });
  },
);

export const createStripeCheckoutSession = onCallAuthed(
  'createStripeCheckoutSession',
  async (request, uid) =>
    createStripeCheckoutSessionForRequest({
      db,
      request,
      uid,
      apiKeys: stripeApiKeys(),
      deps: stripeCheckoutFlowDeps(),
    }),
  {
    secrets: [
      STRIPE_RESTRICTED_KEY,
      STRIPE_SECRET_KEY,
      STRIPE_RESTRICTED_KEY_LIVE,
      STRIPE_SECRET_KEY_LIVE,
      COSIGNER_SECRET,
      ADDRESS_DECRYPTION_SECRET,
    ],
  },
);

export const createTestStripeCheckoutSession = onCallAuthed(
  'createTestStripeCheckoutSession',
  async (request, uid) =>
    createTestStripeCheckoutSessionForRequest({
      db,
      request,
      uid,
      apiKeys: stripeApiKeys(),
      deps: stripeCheckoutFlowDeps(),
    }),
  { secrets: [STRIPE_RESTRICTED_KEY, STRIPE_SECRET_KEY, COSIGNER_SECRET, ADDRESS_DECRYPTION_SECRET] },
);

export const listFulfillmentOrders = onCallLogged(
  'listFulfillmentOrders',
  async (request) => {
    const schema = z.object({
      dropId: z.string().min(1).max(64),
      limit: z.number().int().min(1).max(FULFILLMENT_ORDER_LIMIT).optional(),
      cursor: z
        .object({
          processedAt: z.object({
            seconds: z.number().int().min(0),
            nanos: z.number().int().min(0).max(999_999_999),
          }),
          id: z.string().min(1).max(128),
        })
        .nullable()
        .optional(),
    });
    const { dropId: requestDropId, limit = FULFILLMENT_ORDER_LIMIT, cursor } = parseRequest(schema, request.data);
    const dropId = requireDropId(requestDropId);
    const { wallet } = await requireFulfillmentDropAccess(request, dropId);
    const allowSensitiveAddressView = canViewSensitiveFulfillmentAddress(wallet, dropId);

    let query = db
      .collection(dropDeliveryOrdersCollectionPath(dropId))
      .where('status', '==', 'ready_to_ship')
      .orderBy('processedAt', 'desc')
      .orderBy(FieldPath.documentId(), 'desc')
      .limit(limit + 1);

    if (cursor) {
      const ts = new Timestamp(cursor.processedAt.seconds, cursor.processedAt.nanos);
      query = query.startAfter(ts, cursor.id);
    }

    const snap = await query.get();
    const hasMore = snap.docs.length > limit;
    const pageDocs = hasMore ? snap.docs.slice(0, limit) : snap.docs;
    const orders = pageDocs
      .map((doc) =>
        toFulfillmentOrder(doc.id, doc.data(), {
          canViewSensitiveAddress: allowSensitiveAddressView,
          dropId,
        }),
      )
      .filter((entry): entry is FulfillmentOrder => Boolean(entry));

    const last = hasMore ? pageDocs[pageDocs.length - 1] : null;
    const lastProcessedAt = last ? last.get('processedAt') : null;
    const lastSeconds = typeof lastProcessedAt?.seconds === 'number' ? lastProcessedAt.seconds : null;
    const lastNanos = typeof lastProcessedAt?.nanoseconds === 'number' ? lastProcessedAt.nanoseconds : null;
    const nextCursor =
      hasMore && last && lastSeconds != null && lastNanos != null
        ? { processedAt: { seconds: lastSeconds, nanos: lastNanos }, id: last.id }
        : null;

    return { orders, nextCursor };
  },
  { secrets: [ADDRESS_DECRYPTION_SECRET] },
);

export const listFulfillmentManualReviewCheckouts = onCallLogged(
  'listFulfillmentManualReviewCheckouts',
  async (request) => {
    const schema = z.object({ dropId: z.string().min(1).max(64) });
    const { dropId: requestDropId } = parseRequest(schema, request.data);
    const dropId = requireDropId(requestDropId);
    const { wallet } = await requireFulfillmentDropAccess(request, dropId);
    const allowSensitiveAddressView = canViewSensitiveFulfillmentAddress(wallet, dropId);
    const dropRuntime = getDropRuntime(dropId);
    const apiMode = stripeApiModeForCluster(dropRuntime.cluster);
    const apiKeys = stripeApiKeys();

    const snap = await db
      .collection(`${dropRootPath(dropId)}/stripeCheckouts`)
      .where('manualRefundReviewRequired', '==', true)
      .get();

    const summaries = await Promise.all(
      snap.docs.map(async (doc) => {
        const checkout = doc.data();
        if (!isStripeCheckoutManualReviewCandidate(checkout)) return null;

        let sessionId: string;
        try {
          sessionId = requireStripeCheckoutSessionId(checkout?.sessionId || doc.id);
        } catch (err) {
          logger.warn('listFulfillmentManualReviewCheckouts:invalidSessionId', {
            dropId,
            docId: doc.id,
            error: summarizeError(err),
          });
          return null;
        }

        let session: Stripe.Checkout.Session | null = null;
        try {
          session = (await fetchStripeCheckoutSession(sessionId, apiKeys, apiMode)).session;
        } catch (err) {
          logger.warn('listFulfillmentManualReviewCheckouts:stripeSessionFetchFailed', {
            dropId,
            sessionId,
            error: summarizeError(err),
          });
        }

        return buildStripeCheckoutManualReviewSummary({
          dropId,
          sessionId,
          checkout,
          session,
          canViewSensitiveAddress: allowSensitiveAddressView,
        });
      }),
    );

    const checkouts = summaries
      .filter((entry): entry is StripeCheckoutManualReviewSummary => Boolean(entry))
      .sort(
        (a, b) =>
          (b.failedAt || b.createdAt || 0) - (a.failedAt || a.createdAt || 0) ||
          b.sessionId.localeCompare(a.sessionId),
      );

    return { checkouts };
  },
  { secrets: [STRIPE_RESTRICTED_KEY, STRIPE_SECRET_KEY, STRIPE_RESTRICTED_KEY_LIVE, STRIPE_SECRET_KEY_LIVE] },
);

export const updateFulfillmentStatus = onCallLogged('updateFulfillmentStatus', async (request) => {
  const schema = z.object({
    dropId: z.string().min(1).max(64),
    deliveryId: z.number().int().positive(),
    status: z.union([z.enum(FULFILLMENT_STATUS_OPTIONS), z.literal(''), z.null()]),
    trackingCode: z.string().optional(),
  });
  const { dropId: requestDropId, deliveryId, status, trackingCode } = parseRequest(schema, request.data);
  const dropId = requireDropId(requestDropId);
  const { wallet } = await requireFulfillmentDropAccess(request, dropId);
  const nextStatus = status || '';

  const orderRef = db.doc(dropDeliveryOrderPath(dropId, deliveryId));
  const snap = await orderRef.get();
  if (!snap.exists) {
    throw new HttpsError('not-found', 'Delivery order not found');
  }

  const update: Record<string, unknown> = {
    dropId,
    fulfillmentUpdatedAt: FieldValue.serverTimestamp(),
    fulfillmentUpdatedBy: wallet,
  };
  if (nextStatus) {
    update.fulfillmentStatus = nextStatus;
  } else {
    update.fulfillmentStatus = FieldValue.delete();
  }
  let nextTrackingCode = normalizeOptionalFulfillmentTrackingCode((snap.data() as any)?.fulfillmentTrackingCode);
  if (nextStatus === 'Shipped') {
    nextTrackingCode = sanitizeFulfillmentTrackingCode(trackingCode);
    update.fulfillmentTrackingCode = nextTrackingCode || FieldValue.delete();
  }

  await orderRef.set(update, { merge: true });
  return { deliveryId, fulfillmentStatus: nextStatus, ...(nextTrackingCode ? { fulfillmentTrackingCode: nextTrackingCode } : {}) };
});

export const updateFulfillmentInternalStatus = onCallLogged('updateFulfillmentInternalStatus', async (request) => {
  const schema = z.object({
    dropId: z.string().min(1).max(64),
    deliveryId: z.number().int().positive(),
    status: z.enum(['🟢', '🟡', '🔴', '🏁']),
  });
  const { dropId: requestDropId, deliveryId, status } = parseRequest(schema, request.data);
  const dropId = requireDropId(requestDropId);
  const { wallet } = await requireFulfillmentDropAccess(request, dropId);

  const orderRef = db.doc(dropDeliveryOrderPath(dropId, deliveryId));
  const snap = await orderRef.get();
  if (!snap.exists) {
    throw new HttpsError('not-found', 'Delivery order not found');
  }

  await orderRef.set(
    {
      dropId,
      fulfillmentInternalStatus: status,
      fulfillmentInternalUpdatedAt: FieldValue.serverTimestamp(),
      fulfillmentInternalUpdatedBy: wallet,
    },
    { merge: true },
  );

  return { deliveryId, fulfillmentInternalStatus: status };
});

export const listCardNft2UnrevealedCards = onCallAuthed(
  'listCardNft2UnrevealedCards',
  async (request) => listCardNft2UnrevealedCardIds(request.data),
);

export const revealDudes = onCallLogged(
  'revealDudes',
  async (request) => {
  const { wallet } = await requireWalletSession(request);
  const schema = z.object({ owner: z.string(), boxAssetId: z.string(), dropId: z.string().min(1).max(64) });
  const { owner, boxAssetId, dropId: requestDropId } = parseRequest(schema, request.data);
  const dropId = requireDropId(requestDropId);
  const dropRuntime = getDropRuntime(dropId);
  const ownerWallet = normalizeWallet(owner);
  if (wallet !== ownerWallet) throw new HttpsError('permission-denied', 'Owners only');
  const ownerPk = new PublicKey(ownerWallet);

  await ensureOnchainCoreConfig(dropRuntime);

  let boxAssetPk: PublicKey;
  try {
    boxAssetPk = new PublicKey(boxAssetId);
  } catch {
    throw new HttpsError('invalid-argument', 'Invalid boxAssetId');
  }

  const conn = connection(dropRuntime);

  // Load on-chain config and enforce server cosigner matches on-chain admin.
  const cfg = await fetchDecodedBoxMinterConfigAccount({
    dropRuntime,
    conn,
    context: 'getAccountInfo:boxMinterConfig:reveal',
  });
  const cfgAdmin = cfg.admin;
  const cfgCoreCollection = cfg.coreCollection;
  const signer = cosigner();
  if (!signer.publicKey.equals(cfgAdmin)) {
    throw new HttpsError(
      'failed-precondition',
      `COSIGNER_SECRET pubkey ${signer.publicKey.toBase58()} does not match box minter admin ${cfgAdmin.toBase58()}`,
      { expectedAdmin: cfgAdmin.toBase58(), cosigner: signer.publicKey.toBase58() },
    );
  }
  assertConfiguredPublicKey(dropRuntime.collectionMint, 'COLLECTION_MINT');
  if (!dropRuntime.collectionMint.equals(cfgCoreCollection)) {
    throw new HttpsError('failed-precondition', 'COLLECTION_MINT does not match on-chain config (functions/src/config/deployment.ts)', {
      configured: dropRuntime.collectionMint.toBase58(),
      onchain: cfgCoreCollection.toBase58(),
      dropId,
    });
  }

  // Read pending open record from chain.
  const pendingPda = pendingOpenPdaForBox(dropRuntime, boxAssetPk);
  const pendingInfo = await withTimeout(
    conn.getAccountInfo(pendingPda, { commitment: 'confirmed' }),
    RPC_TIMEOUT_MS,
    'getAccountInfo:pendingOpenBox',
  );
  if (!pendingInfo?.data) {
    throw new HttpsError(
      'not-found',
      'Pending open not found. Start opening the box first (send it to the vault), then reveal.',
      { pending: pendingPda.toBase58(), boxAssetId },
    );
  }
  const pending = decodePendingOpenBox(pendingInfo.data, { expectedDudeCount: dropRuntime.itemsPerBox });
  if (!pending.owner.equals(ownerPk) || !pending.boxAsset.equals(boxAssetPk)) {
    throw new HttpsError('permission-denied', 'Pending open belongs to a different wallet', {
      owner: ownerWallet,
      pendingOwner: pending.owner.toBase58(),
      boxAssetId,
      pending: pendingPda.toBase58(),
    });
  }
  if (pending.dudeAssets.length !== dropRuntime.itemsPerBox) {
    throw new HttpsError(
      'failed-precondition',
      `Pending open has invalid figure placeholder count (expected ${dropRuntime.itemsPerBox})`,
      {
        pending: pendingPda.toBase58(),
        boxAssetId,
        expected: dropRuntime.itemsPerBox,
        actual: pending.dudeAssets.length,
        dropId,
      },
    );
  }

  if (pending.config && !pending.config.equals(dropRuntime.boxMinterConfigPda)) {
    throw new HttpsError('failed-precondition', 'Pending open belongs to a different drop config', {
      boxAssetId,
      dropId,
      pending: pendingPda.toBase58(),
      pendingConfig: pending.config.toBase58(),
      expectedConfig: dropRuntime.boxMinterConfigPda.toBase58(),
    });
  }

  if (!pending.config && requiresRevealAssetDisambiguation(dropRuntime)) {
    const revealScopeCollectionShared = revealScopeSharesCollectionMint(dropRuntime);
    if (revealScopeCollectionShared) {
      throw new HttpsError('failed-precondition', 'Legacy pending open cannot be disambiguated for a shared collection mint', {
        boxAssetId,
        dropId,
        pending: pendingPda.toBase58(),
        expectedCollectionMint: dropRuntime.collectionMintStr || null,
        revealScopeSharesCollectionMint: revealScopeCollectionShared,
      });
    }

    const boxAsset = await fetchAssetRetry(boxAssetId, dropRuntime);
    if (getAssetKind(boxAsset) !== 'box') {
      throw new HttpsError('failed-precondition', 'Pending open asset is not a box', {
        boxAssetId,
        dropId,
        pending: pendingPda.toBase58(),
      });
    }
    if (!assetMatchesDropCollection(boxAsset, dropRuntime, ['box'])) {
      const collectionMints = assetGroupingCollectionMints(boxAsset);
      throw new HttpsError('failed-precondition', 'Box asset does not belong to the requested drop', {
        boxAssetId,
        dropId,
        pending: pendingPda.toBase58(),
        expectedCollectionMint: dropRuntime.collectionMintStr || null,
        assetGroupingCollectionMints: collectionMints,
        assetUniqueGroupingCollectionMint: uniqueAssetGroupingCollectionMint(boxAsset),
        revealScopeSharesCollectionMint: revealScopeCollectionShared,
      });
    }
  }

  // Assign dudes NOW (after the box has already been transferred away); keep this admin-only.
  const dudeIds = await assignDudes(dropId, boxAssetId);

  const finalizeIx = new TransactionInstruction({
    programId: dropRuntime.boxMinterProgramId,
    keys: [
      { pubkey: dropRuntime.boxMinterConfigPda, isSigner: false, isWritable: false },
      { pubkey: signer.publicKey, isSigner: true, isWritable: true },
      { pubkey: boxAssetPk, isSigner: false, isWritable: true },
      { pubkey: cfgCoreCollection, isSigner: false, isWritable: true },
      { pubkey: MPL_CORE_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: SPL_NOOP_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: pendingPda, isSigner: false, isWritable: true },
      { pubkey: ownerPk, isSigner: false, isWritable: false },
      ...pending.dudeAssets.map((pubkey) => ({ pubkey, isSigner: false, isWritable: true })),
    ],
    data: encodeFinalizeOpenBoxArgs(dudeIds, {
      itemsPerBox: dropRuntime.itemsPerBox,
      maxDudeId: dropRuntime.maxDudeId,
      pendingLayout: pending.layout,
    }),
  });

  const instructions: TransactionInstruction[] = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
    finalizeIx,
  ];

  const { blockhash } = await withTimeout(conn.getLatestBlockhash('confirmed'), RPC_TIMEOUT_MS, 'getLatestBlockhash:revealDudes');
  const tx = buildTx(instructions, signer.publicKey, blockhash, [signer]);

  const sig = await sendAndConfirmSignedTx(conn, tx, 'revealDudes');
  void countOnlineRevealPackStatus({ db, dropRuntime, boxAssetId, signature: sig }).catch((err) => {
    logger.warn('revealDudes:packStatusCountFailed', {
      dropId,
      boxAssetId,
      signature: sig,
      error: summarizeError(err),
    });
  });

  return { signature: sig, dudeIds };
  },
  { secrets: [COSIGNER_SECRET] },
);

export const prepareAdminIrlRedeemTx = onCallLogged(
  'prepareAdminIrlRedeemTx',
  async (request) => {
    const schema = z.object({
      owner: z.string(),
      itemIds: z.array(z.string()).min(1),
      dropId: z.string().min(1).max(64),
    });
    const { owner, itemIds, dropId: requestDropId } = parseRequest(schema, request.data);
    const dropId = requireDropId(requestDropId);
    const dropRuntime = getDropRuntime(dropId);
    requireCardNft2AdminIrlRedeemDrop(dropRuntime);

    const { wallet } = await requireAdminIrlRedeemAccess(request);
    const ownerWallet = normalizeWallet(owner);
    if (wallet !== ownerWallet) throw new HttpsError('permission-denied', 'Owners only');

    const uniqueItemIds = Array.from(new Set(itemIds));
    if (uniqueItemIds.length !== itemIds.length) {
      throw new HttpsError('invalid-argument', 'Duplicate itemIds are not allowed');
    }
    if (uniqueItemIds.length > MAX_DELIVERY_ITEMS) {
      throw new HttpsError('invalid-argument', `Too many items in one Admin IRL redeem request (max ${MAX_DELIVERY_ITEMS})`);
    }

    const conn = connection(dropRuntime);
    const cfg = await fetchDecodedBoxMinterConfigAccount({
      dropRuntime,
      conn,
      context: 'getAccountInfo:adminIrlRedeemConfig',
    });
    requireStripeCheckoutCollectionMatchesConfig(dropRuntime, cfg);

    const ownerPk = new PublicKey(ownerWallet);
    const assetPks = uniqueItemIds.map((assetId) => {
      try {
        return new PublicKey(assetId);
      } catch {
        throw new HttpsError('invalid-argument', 'Invalid asset id');
      }
    });

    const assets = await mapWithConcurrency(uniqueItemIds, ADMIN_IRL_REDEEM_ASSET_FETCH_CONCURRENCY, (assetId) =>
      fetchAssetRetry(assetId, dropRuntime),
    );
    const assetKinds = assets.map((asset) => getAssetKind(asset));
    const isCardReceiptRequest = assetKinds.some((kind) => kind === 'certificate');
    const targetKind: AdminIrlRedeemTargetKind = isCardReceiptRequest ? 'card_receipt' : 'pack';
    const targetEligibility = getAdminIrlRedeemTargetEligibility({
      targetKind,
      itemCount: assets.length,
    });
    if (
      isCardReceiptRequest &&
      (!targetEligibility.eligible || assetKinds[0] !== 'certificate')
    ) {
      throw new HttpsError('failed-precondition', 'Admin IRL redeem supports one card receipt at a time and cannot mix item types');
    }
    const orderItems: AdminIrlRedeemRequestItem[] = assets.map((asset, index) => {
      const assetId = uniqueItemIds[index];
      const kind = assetKinds[index];
      if (!assetMatchesRequestedDrop(asset, dropRuntime)) {
        throw new HttpsError('failed-precondition', 'Item does not belong to the requested drop');
      }
      const assetOwner = asset?.ownership?.owner;
      if (assetOwner !== ownerWallet) {
        throw new HttpsError('failed-precondition', 'Item not owned by wallet');
      }

      if (kind === 'certificate') {
        const refId = Number(getDudeIdFromAsset(asset));
        if (!Number.isInteger(refId) || refId <= 0 || refId > dropRuntime.maxDudeId) {
          throw new HttpsError('failed-precondition', 'Admin IRL redeem receipt must be a card receipt with a valid figure id');
        }
        return { assetId, kind: 'card_receipt', refId: Math.floor(refId) };
      }
      if (kind !== 'box') {
        throw new HttpsError('failed-precondition', 'Admin IRL redeem is only available for packs or card receipts');
      }
      const refId = Number(getBoxIdFromAsset(asset));
      if (!Number.isFinite(refId) || refId <= 0 || refId > 0xffff_ffff) {
        throw new HttpsError('failed-precondition', 'Box id missing from metadata');
      }
      return { assetId, kind: 'box', refId: Math.floor(refId) };
    });
    if (new Set(orderItems.map((item) => item.refId)).size !== orderItems.length) {
      throw new HttpsError('failed-precondition', 'Duplicate box ids are not allowed');
    }

    if (targetKind === 'card_receipt') {
      const existingMarker = await db
        .doc(dropAdminIrlRedeemReceiptMarkerPath(dropId, uniqueItemIds[0]))
        .get();
      if (existingMarker.exists) {
        throw new HttpsError('failed-precondition', 'This card receipt has already been redeemed for an Admin IRL order');
      }
    }

    let instructions: TransactionInstruction[];
    if (targetKind === 'pack') {
      const pendingOpenPdas = assetPks.map((assetPk) => pendingOpenPdaForBox(dropRuntime, assetPk));
      const pendingOpenInfos = await withTimeout(
        conn.getMultipleAccountsInfo(pendingOpenPdas, { commitment: 'confirmed', dataSlice: { offset: 0, length: 0 } }),
        RPC_TIMEOUT_MS,
        'getMultipleAccountsInfo:adminIrlRedeemPendingOpens',
      );
      const pendingOpenIndex = pendingOpenInfos.findIndex(Boolean);
      if (pendingOpenIndex >= 0) {
        throw new HttpsError('failed-precondition', 'Pending reveal packs cannot be redeemed for Admin IRL events', {
          assetId: uniqueItemIds[pendingOpenIndex],
          pending: pendingOpenPdas[pendingOpenIndex]?.toBase58(),
        });
      }

      const transferInstructions = assetPks.map((asset) =>
        mplCoreTransferV1Ix({
          asset,
          coreCollection: cfg.coreCollection,
          payer: ownerPk,
          authority: ownerPk,
          newOwner: cfg.admin,
        }),
      );
      instructions = [ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }), ...transferInstructions];
      const sizeTx = buildTx(instructions, ownerPk, DUMMY_BLOCKHASH);
      const raw = sizeTx.serialize();
      if (raw.length > SOLANA_MAX_RAW_TX_BYTES) {
        let maxFit = 0;
        for (let n = assetPks.length - 1; n >= 1; n -= 1) {
          const candidateInstructions: TransactionInstruction[] = [
            ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
            ...transferInstructions.slice(0, n),
          ];
          if (buildTx(candidateInstructions, ownerPk, DUMMY_BLOCKHASH).serialize().length <= SOLANA_MAX_RAW_TX_BYTES) {
            maxFit = n;
            break;
          }
        }
        throw new HttpsError(
          'failed-precondition',
          `Admin IRL redeem transfer transaction too large (${raw.length} bytes > ${SOLANA_MAX_RAW_TX_BYTES}). Try fewer packs.` +
            (maxFit ? ` Estimated max that fits: ${maxFit}.` : ' Try 1 pack.'),
          { rawBytes: raw.length, maxRawBytes: SOLANA_MAX_RAW_TX_BYTES, items: assetPks.length, maxFit },
        );
      }
    } else {
      if (!dropRuntime.receiptsMerkleTreeStr) {
        throw new HttpsError('failed-precondition', 'Receipt cNFT tree is not configured', { dropId });
      }
      const cardAsset = assets[0];
      const proof = await fetchAssetProof(uniqueItemIds[0], dropRuntime);
      const proofContext = parseCompressedReceiptProof({
        asset: cardAsset,
        proof,
        dropRuntime,
        expectedOwner: ownerWallet,
      });
      const transferIx = buildCompressedReceiptTransferIx({
        proofContext,
        owner: ownerPk,
        newOwner: cfg.admin,
        coreCollection: cfg.coreCollection,
      });
      instructions = [ComputeBudgetProgram.setComputeUnitLimit({ units: 700_000 }), transferIx];
    }

    const requestRef = db.collection(dropAdminIrlRedeemRequestsCollectionPath(dropId)).doc();
    try {
      await requestRef.create({
        dropId,
        status: 'prepared',
        owner: ownerWallet,
        targetKind,
        adminWallet: cfg.admin.toBase58(),
        itemIds: uniqueItemIds,
        items: orderItems,
        preparedExpiresAt: adminIrlRedeemPreparedExpiresAt(),
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
    } catch (err) {
      if (!isGrpcAlreadyExists(err)) throw err;
      throw new HttpsError('aborted', 'Admin IRL redeem request collision. Retry.');
    }

    try {
      const { blockhash } = await withTimeout(
        conn.getLatestBlockhash('confirmed'),
        RPC_TIMEOUT_MS,
        'getLatestBlockhash:prepareAdminIrlRedeemTx',
      );
      const solanaTx = targetKind === 'card_receipt'
        ? (
            await buildTxWithOptionalDeliveryLookupTable({
              conn,
              dropRuntime,
              build: (luts) => buildTx(instructions, ownerPk, blockhash, [], luts),
              encodeTooLargeMessage: 'Admin IRL card receipt transfer is too large to encode.',
              encodeTooLargeDetails: { dropId, receiptAssetId: uniqueItemIds[0] },
              packetTooLargeMessage: (rawBytes, maxRawBytes) =>
                `Admin IRL card receipt transfer transaction too large (${rawBytes} bytes > ${maxRawBytes}).`,
              packetTooLargeDetails: { dropId, receiptAssetId: uniqueItemIds[0] },
            })
          ).tx
        : buildTx(instructions, ownerPk, blockhash);
      return {
        encodedTx: Buffer.from(solanaTx.serialize()).toString('base64'),
        requestId: requestRef.id,
        dropId,
        adminWallet: cfg.admin.toBase58(),
        itemCount: uniqueItemIds.length,
        targetKind,
      };
    } catch (err) {
      try {
        await requestRef.delete();
      } catch (cleanupErr) {
        logger.warn('prepareAdminIrlRedeemTx:cleanup_failed', {
          dropId,
          requestId: requestRef.id,
          error: summarizeError(cleanupErr),
        });
      }
      throw err;
    }
  },
);

export const finalizeAdminIrlRedeem = onCallLogged(
  'finalizeAdminIrlRedeem',
  async (request) => {
    const schema = z.object({
      requestId: z.string(),
      dropId: z.string().min(1).max(64),
      transferSignature: z.string(),
    });
    const { requestId: rawRequestId, dropId: requestDropId, transferSignature: rawTransferSignature } = parseRequest(
      schema,
      request.data,
    );
    const dropId = requireDropId(requestDropId);
    const dropRuntime = getDropRuntime(dropId);
    requireCardNft2AdminIrlRedeemDrop(dropRuntime);
    const requestId = requireAdminIrlRedeemRequestId(rawRequestId);
    const transferSignature = String(rawTransferSignature || '').trim();
    if (!transferSignature || !/^[1-9A-HJ-NP-Za-km-z]{64,128}$/.test(transferSignature)) {
      throw new HttpsError('invalid-argument', 'Invalid Admin IRL redeem transfer signature');
    }

    const { wallet } = await requireAdminIrlRedeemAccess(request);
    const requestRef = db.doc(dropAdminIrlRedeemRequestPath(dropId, requestId));
    const nowMs = Date.now();
    const attemptId = `admin_irl:${stripeReceiptClaimAttemptId(nowMs)}`;
    const started = await startAdminIrlRedeemFinalize({
      requestRef,
      dropId,
      requestId,
      wallet,
      transferSignature,
      attemptId,
      nowMs,
    });
    if (started.status === 'complete') {
      return adminIrlRedeemCompleteResponse({ dropId, requestId, request: started.request });
    }

    try {
      const conn = connection(dropRuntime);
      const cfg = await ensureOnchainCoreConfig(dropRuntime, true);
      requireStripeCheckoutCollectionMatchesConfig(dropRuntime, cfg);
      const signer = cosigner();
      if (!signer.publicKey.equals(cfg.admin)) {
        throw new HttpsError('failed-precondition', 'COSIGNER_SECRET does not match on-chain admin', {
          expectedAdmin: cfg.admin.toBase58(),
          cosigner: signer.publicKey.toBase58(),
        });
      }
      if (!dropRuntime.receiptsMerkleTreeStr) {
        throw new HttpsError(
          'failed-precondition',
          'Receipt cNFT tree is not configured (set `receiptsMerkleTree` in functions/src/config/deployment.ts)',
          { dropId },
        );
      }

      if (started.request.targetKind === 'card_receipt') {
        const cardItem = started.request.items[0];
        if (!cardItem || cardItem.kind !== 'card_receipt') {
          throw new HttpsError('failed-precondition', 'Admin IRL card receipt request is invalid');
        }
        await verifyDirectCardReceiptTransferSignature({
          conn,
          dropRuntime,
          signature: transferSignature,
          fromWallet: started.request.owner,
          toWallet: signer.publicKey.toBase58(),
          coreCollection: cfg.coreCollection,
          receiptAssetId: cardItem.assetId,
          rpcLabel: 'getTransaction:adminIrlCardReceiptTransfer',
        });
        await waitForAdminIrlCardReceipt({
          dropRuntime,
          receiptAssetId: cardItem.assetId,
          figureId: cardItem.refId,
          adminWallet: signer.publicKey.toBase58(),
        });
        const completed = await publishCompletedAdminIrlCardRedeem({
          requestRef,
          attemptId,
          dropRuntime,
          request: started.request,
          transferSignature,
          receiptOwner: signer.publicKey.toBase58(),
          card: { figureId: cardItem.refId, receiptAssetId: cardItem.assetId },
        });
        return completed;
      }

      await verifyAdminIrlRedeemTransferSignature({
        conn,
        dropRuntime,
        signature: transferSignature,
        ownerWallet: started.request.owner,
        adminWallet: signer.publicKey.toBase58(),
        coreCollection: cfg.coreCollection,
        itemIds: started.request.itemIds,
      });

      const existing = await completeAdminIrlRedeemFromExistingMarkers({
        requestRef,
        attemptId,
        dropRuntime,
        request: started.request,
      });
      if (existing) return existing;

      const internalDelivery = await ensureAdminIrlInternalDelivery({
        conn,
        dropRuntime,
        signer,
        cfg,
        requestRef,
        request: started.request,
      });
      const receiptTxs = await mintAdminIrlPackReceipts({
        conn,
        dropRuntime,
        signer,
        coreCollection: cfg.coreCollection,
        items: started.request.items,
        requestRef,
        existingReceiptTxs: started.request.receiptTxs,
      });
      const receiptAssetsByBoxId = await waitForAdminIrlReceiptAssets({
        conn,
        ownerWallet: signer.publicKey.toBase58(),
        dropRuntime,
        items: started.request.items,
        receiptTxs,
      });

      const boxes: AdminIrlRedeemBoxBaseInput[] = [];
      for (const item of started.request.items) {
        const receiptAssets = receiptAssetsByBoxId.get(item.refId) || [];
        if (receiptAssets.length !== 1) {
          throw new HttpsError('failed-precondition', 'Admin IRL redeem pack receipt is not uniquely indexed yet', {
            dropId,
            boxId: item.refId,
            expected: 1,
            got: receiptAssets.length,
          });
        }
        const receiptAssetId = String(receiptAssets[0]?.id || '');
        if (!receiptAssetId) {
          throw new HttpsError('failed-precondition', 'Admin IRL redeem pack receipt is missing an asset id', {
            dropId,
            boxId: item.refId,
          });
        }
        const dudeIds = await assignDudes(dropId, receiptAssetId);
        boxes.push({
          boxId: item.refId,
          originalAssetId: item.assetId,
          receiptAssetId,
          dudeIds,
        });
      }
      const closeDeliveryTx = await closeAdminIrlInternalDeliveryRecord({
        conn,
        dropRuntime,
        signer,
        requestRef,
        request: started.request,
        internalDelivery,
      });

      return await publishCompletedAdminIrlRedeem({
        requestRef,
        attemptId,
        dropRuntime,
        request: started.request,
        transferSignature,
        receiptOwner: signer.publicKey.toBase58(),
        internalDelivery,
        closeDeliveryTx,
        receiptTxs,
        boxes,
      });
    } catch (err) {
      await clearAdminIrlRedeemFinalizeProcessing({ requestRef, attemptId, err });
      throw err;
    }
  },
  { secrets: [COSIGNER_SECRET], timeoutSeconds: 540 },
);

export const prepareDeliveryTx = onCallLogged(
  'prepareDeliveryTx',
  async (request) => {
  const { wallet } = await requireWalletSession(request);
  const schema = z.object({
    owner: z.string(),
    itemIds: z.array(z.string()).min(1),
    addressId: z.string(),
    dropId: z.string().min(1).max(64),
  });
  const { owner, itemIds, addressId, dropId: requestDropId } = parseRequest(schema, request.data);
  const dropId = requireDropId(requestDropId);
  const dropRuntime = getDropRuntime(dropId);
  const ownerWallet = normalizeWallet(owner);
  if (wallet !== ownerWallet) throw new HttpsError('permission-denied', 'Owners only');

  await ensureOnchainCoreConfig(dropRuntime);

  const uniqueItemIds = Array.from(new Set(itemIds));
  if (uniqueItemIds.length !== itemIds.length) {
    throw new HttpsError('invalid-argument', 'Duplicate itemIds are not allowed');
  }

  // Keep this comfortably above realistic tx-size limits while preventing accidental huge requests.
  if (uniqueItemIds.length > MAX_DELIVERY_ITEMS) {
    throw new HttpsError('invalid-argument', `Too many items in one delivery request (max ${MAX_DELIVERY_ITEMS})`);
  }

  const addressSnap = await db.doc(`profiles/${wallet}/addresses/${addressId}`).get();
  if (!addressSnap.exists) {
    throw new HttpsError('not-found', 'Address not found');
  }
  const addressData = addressSnap.data();
  const normalizedAddressCountry = normalizeCountryCode(addressData?.countryCode || addressData?.country);
  const addressCountry = normalizedAddressCountry || addressData?.countryCode || addressData?.country || '';

  // Validate assets are deliverable Mons items owned by the wallet.
  const assetPks: PublicKey[] = [];
  const orderItems: Array<{ assetId: string; kind: 'box' | 'dude'; refId: number }> = [];
  for (const assetId of uniqueItemIds) {
    let pk: PublicKey;
    try {
      pk = new PublicKey(assetId);
    } catch {
      throw new HttpsError('invalid-argument', 'Invalid asset id');
    }
    assetPks.push(pk);

    const asset = await fetchAssetRetry(assetId, dropRuntime);
    const kind = getAssetKind(asset);
    if (!kind) throw new HttpsError('failed-precondition', 'Unsupported asset type');
    if (kind === 'certificate') {
      throw new HttpsError('failed-precondition', 'Certificates cannot be delivered');
    }
    if (!assetMatchesRequestedDrop(asset, dropRuntime)) {
      throw new HttpsError('failed-precondition', 'Item does not belong to the requested drop');
    }
    const assetOwner = asset?.ownership?.owner;
    if (assetOwner !== ownerWallet) {
      throw new HttpsError('failed-precondition', 'Item not owned by wallet');
    }

    if (kind === 'box') {
      const boxIdStr = getBoxIdFromAsset(asset);
      const refId = Number(boxIdStr);
      if (!Number.isFinite(refId) || refId <= 0 || refId > 0xffff_ffff) {
        throw new HttpsError('failed-precondition', 'Box id missing from metadata');
      }
      orderItems.push({
        assetId,
        kind: 'box',
        refId,
      });
    } else {
      const dudeId = getDudeIdFromAsset(asset);
      const refId = Number(dudeId);
      if (!Number.isFinite(refId) || refId <= 0 || refId > dropRuntime.maxDudeId) {
        throw new HttpsError('failed-precondition', 'Dude id missing from metadata');
      }
      orderItems.push({
        assetId,
        kind: 'dude',
        refId,
      });
    }
  }

  const deliveryLamports = calculateDeliveryLamports(
    orderItems,
    addressCountry,
    dropRuntime.itemsPerBox,
    dropRuntime.config.dropFamily,
    SERVER_INVALID_DELIVERY_UNITS_POLICY,
  );
  const conn = connection(dropRuntime);

  // Ensure COSIGNER_SECRET matches on-chain admin, and COLLECTION_MINT matches configured core collection.
  const cfg = await fetchDecodedBoxMinterConfigAccount({
    dropRuntime,
    conn,
    context: 'getAccountInfo:boxMinterConfig',
  });
  const cfgAdmin = cfg.admin;
  const cfgTreasury = cfg.treasury;
  const cfgCoreCollection = cfg.coreCollection;
  const signer = cosigner();
  if (!signer.publicKey.equals(cfgAdmin)) {
    throw new HttpsError(
      'failed-precondition',
      `COSIGNER_SECRET pubkey ${signer.publicKey.toBase58()} does not match box minter admin ${cfgAdmin.toBase58()}`,
      { expectedAdmin: cfgAdmin.toBase58(), cosigner: signer.publicKey.toBase58() },
    );
  }
  assertConfiguredPublicKey(dropRuntime.collectionMint, 'COLLECTION_MINT');
  if (!dropRuntime.collectionMint.equals(cfgCoreCollection)) {
    throw new HttpsError('failed-precondition', 'COLLECTION_MINT does not match on-chain config (functions/src/config/deployment.ts)', {
      configured: dropRuntime.collectionMint.toBase58(),
      onchain: cfgCoreCollection.toBase58(),
      dropId,
    });
  }

  const programId = dropRuntime.boxMinterProgramId;
  const ownerPk = new PublicKey(ownerWallet);
  const addressLookupTables = await getDeliveryLookupTable(conn, dropRuntime);

  // Allocate a unique, compact delivery id and its on-chain PDA.
  // IMPORTANT: we atomically reserve the Firestore doc via `create()` to avoid TOCTOU collisions under concurrency.
  const MAX_DELIVERY_ID_ATTEMPTS = 16;

  for (let attempt = 0; attempt < MAX_DELIVERY_ID_ATTEMPTS; attempt += 1) {
    const candidate = randomInt(1, 2 ** 31);
    const [deliveryPda, deliveryBump] = deriveDeliveryPdaForDrop(dropRuntime, candidate);

    const chainInfo = await withTimeout(
      conn.getAccountInfo(deliveryPda, { commitment: 'confirmed', dataSlice: { offset: 0, length: 0 } }),
      RPC_TIMEOUT_MS,
      'getAccountInfo:deliveryPda',
    );
    if (chainInfo) continue;

    const deliverIx = new TransactionInstruction({
      programId,
      keys: [
        { pubkey: dropRuntime.boxMinterConfigPda, isSigner: false, isWritable: false },
        { pubkey: signer.publicKey, isSigner: true, isWritable: false },
        { pubkey: ownerPk, isSigner: true, isWritable: true },
        { pubkey: cfgTreasury, isSigner: false, isWritable: true },
        { pubkey: cfgCoreCollection, isSigner: false, isWritable: false },
        { pubkey: MPL_CORE_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: SPL_NOOP_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: deliveryPda, isSigner: false, isWritable: true },
        ...assetPks.map((pubkey) => ({ pubkey, isSigner: false, isWritable: true })),
      ],
      data: encodeDeliverArgs({ deliveryId: candidate, feeLamports: deliveryLamports, deliveryBump }),
    });

    const instructions: TransactionInstruction[] = [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
      deliverIx,
    ];

    // NOTE: use a dummy blockhash for the size check; it keeps the prepared transaction's real blockhash as fresh as possible.
    const sizeTx = buildTx(instructions, ownerPk, DUMMY_BLOCKHASH, [signer], addressLookupTables);
    const raw = sizeTx.serialize();

    if (raw.length > SOLANA_MAX_RAW_TX_BYTES) {
      let maxFit = 0;
      for (let n = assetPks.length - 1; n >= 1; n -= 1) {
        const candidateIx = new TransactionInstruction({
          programId,
          keys: [
            { pubkey: dropRuntime.boxMinterConfigPda, isSigner: false, isWritable: false },
            { pubkey: signer.publicKey, isSigner: true, isWritable: false },
            { pubkey: ownerPk, isSigner: true, isWritable: true },
            { pubkey: cfgTreasury, isSigner: false, isWritable: true },
            { pubkey: cfgCoreCollection, isSigner: false, isWritable: false },
            { pubkey: MPL_CORE_PROGRAM_ID, isSigner: false, isWritable: false },
            { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
            { pubkey: SPL_NOOP_PROGRAM_ID, isSigner: false, isWritable: false },
            { pubkey: deliveryPda, isSigner: false, isWritable: true },
            ...assetPks.slice(0, n).map((pubkey) => ({ pubkey, isSigner: false, isWritable: true })),
          ],
          data: encodeDeliverArgs({ deliveryId: candidate, feeLamports: deliveryLamports, deliveryBump }),
        });
        const candidateTx = buildTx(
          [ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }), candidateIx],
          ownerPk,
          DUMMY_BLOCKHASH,
          [signer],
          addressLookupTables,
        );
        if (candidateTx.serialize().length <= SOLANA_MAX_RAW_TX_BYTES) {
          maxFit = n;
          break;
        }
      }
      throw new HttpsError(
        'failed-precondition',
        `Delivery transaction too large (${raw.length} bytes > ${SOLANA_MAX_RAW_TX_BYTES}). Try fewer items.` +
          (maxFit ? ` Estimated max that fits: ${maxFit}.` : ' Try 1 item.'),
        { rawBytes: raw.length, maxRawBytes: SOLANA_MAX_RAW_TX_BYTES, items: assetPks.length, maxFit },
      );
    }

    const orderRef = db.doc(dropDeliveryOrderPath(dropId, candidate));
    const nowMs = Date.now();
    try {
      await db.runTransaction(async (t) => {
        t.create(orderRef, {
          dropId,
          status: 'prepared',
          owner: ownerWallet,
          addressId,
          addressSnapshot: {
            ...addressData,
            id: addressId,
            countryCode: addressCountry || addressData?.countryCode,
          },
          itemIds: uniqueItemIds,
          items: orderItems,
          deliveryId: candidate,
          deliveryPda: deliveryPda.toBase58(),
          ...(dropRuntime.deliveryLookupTableStr ? { lookupTable: dropRuntime.deliveryLookupTableStr } : {}),
          deliveryLamports,
          createdAt: FieldValue.serverTimestamp(),
          receiptRecovery: {
            preparedProbeCount: 0,
            nextPreparedProbeAt: Timestamp.fromMillis(nowMs + DELIVERY_RECOVERY_PREPARED_CHECK_DELAYS_MS[0]),
          },
        });
      });
    } catch (err) {
      if (isGrpcAlreadyExists(err)) continue;
      throw err;
    }

    try {
      const { blockhash } = await withTimeout(
        conn.getLatestBlockhash('confirmed'),
        RPC_TIMEOUT_MS,
        'getLatestBlockhash:prepareDeliveryTx',
      );
      const solanaTx = buildTx(instructions, ownerPk, blockhash, [signer], addressLookupTables);
      const rawTx = solanaTx.serialize();
      return { encodedTx: Buffer.from(rawTx).toString('base64'), deliveryLamports, deliveryId: candidate };
    } catch (err) {
      // If we fail after reserving the order doc (e.g. RPC timeout fetching blockhash),
      // clean up to avoid leaving orphan "prepared" orders around.
      try {
        await orderRef.delete();
      } catch (cleanupErr) {
        console.error('[mons/functions] prepareDeliveryTx cleanup failed', summarizeError(cleanupErr), { deliveryId: candidate });
      }
      throw err;
    }
  }

  throw new HttpsError('unavailable', 'Failed to allocate delivery id (try again)');
  },
  { secrets: [COSIGNER_SECRET] },
);

export type RetryIssueReceiptsArgs = {
  ownerWallet: string;
  deliveryId: number;
  dropId: string;
} & ({ verification: 'signature'; signature: string } | { verification: 'delivery_pda' });

export type RetryIssueReceiptsResult = {
  processed: true;
  deliveryId: number;
  receiptsMinted: number;
  receiptTxs: string[];
  closeDeliveryTx: string | null;
};

type VerifiedReceiptIssuanceTarget = {
  verification: 'signature' | 'delivery_pda';
  signature: string | null;
  expectedDeliveryPda: PublicKey;
  expectedDeliveryBump: number;
  targetAssetIds: string[];
};

export type FindConfirmedDeliverySignatureArgs = {
  ownerWallet: string;
  deliveryId: number;
  dropId: string;
  deliveryPda?: string | null;
  itemIds?: string[] | null;
  limit?: number;
};

export type HasConfirmedDeliveryRecordForDeliveryOrderArgs = {
  deliveryId: number;
  dropId: string;
  deliveryPda?: string | null;
};

type DeliverySignatureProbeFailureReason =
  | 'transaction_not_found_or_failed'
  | 'missing_target_deliver_instruction'
  | 'payer_mismatch'
  | 'delivery_id_mismatch'
  | 'delivery_pda_mismatch'
  | 'item_count_mismatch'
  | 'asset_list_mismatch'
  | 'missing_delivered_item_ids';

const IGNORABLE_DELIVERY_SIGNATURE_PROBE_FAILURES = new Set<DeliverySignatureProbeFailureReason>([
  'transaction_not_found_or_failed',
  'missing_target_deliver_instruction',
]);

function storedDeliverySignature(order: any): string | null {
  const signature = typeof order?.deliverySignature === 'string' ? order.deliverySignature.trim() : '';
  return signature || null;
}

function requirePositiveDeliveryId(rawDeliveryId: unknown): number {
  const deliveryId = Math.floor(Number(rawDeliveryId));
  if (!Number.isFinite(deliveryId) || deliveryId <= 0) {
    throw new HttpsError('invalid-argument', 'deliveryId must be a positive integer');
  }
  return deliveryId;
}

function assertStoredDeliveryPdaMatchesExpected(storedDeliveryPda: unknown, expectedDeliveryPda: PublicKey) {
  const storedPda = typeof storedDeliveryPda === 'string' ? storedDeliveryPda.trim() : '';
  if (!storedPda) return;

  const expectedPda = expectedDeliveryPda.toBase58();
  if (storedPda !== expectedPda) {
    throw new HttpsError('failed-precondition', 'Stored delivery PDA does not match the expected delivery PDA', {
      expected: expectedPda,
      got: storedPda,
    });
  }
}

function deliverySignatureProbeFailedPrecondition(
  reason: DeliverySignatureProbeFailureReason,
  message: string,
  details?: Record<string, unknown>,
): HttpsError {
  return new HttpsError('failed-precondition', message, { ...(details || {}), reason });
}

function isIgnorableDeliverySignatureProbeError(err: unknown): boolean {
  const anyErr = err as any;
  if (anyErr?.code !== 'failed-precondition') return false;
  const reason = typeof anyErr?.details?.reason === 'string' ? anyErr.details.reason : '';
  return IGNORABLE_DELIVERY_SIGNATURE_PROBE_FAILURES.has(reason as DeliverySignatureProbeFailureReason);
}

export async function findConfirmedDeliverySignatureForDeliveryOrder(
  args: FindConfirmedDeliverySignatureArgs,
): Promise<string | null> {
  const ownerWallet = normalizeWallet(args.ownerWallet);
  const deliveryId = requirePositiveDeliveryId(args.deliveryId);
  const dropId = requireDropId(args.dropId);
  const dropRuntime = getDropRuntime(dropId);
  const conn = connection(dropRuntime);
  const [expectedDeliveryPda] = deriveDeliveryPdaForDrop(dropRuntime, deliveryId);
  assertStoredDeliveryPdaMatchesExpected(args.deliveryPda, expectedDeliveryPda);

  const itemIds = Array.isArray(args.itemIds) ? args.itemIds.filter((id): id is string => typeof id === 'string' && !!id) : [];
  const rawLimit = Math.floor(Number(args.limit ?? 100));
  const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(rawLimit, 500)) : 100;
  let remaining = limit;
  let before: string | undefined;

  while (remaining > 0) {
    const pageLimit = Math.min(remaining, 100);
    const sigInfos = await withTimeout(
      conn.getSignaturesForAddress(expectedDeliveryPda, before ? { before, limit: pageLimit } : { limit: pageLimit }),
      RPC_TIMEOUT_MS,
      'getSignaturesForAddress:deliveryPda',
    );
    if (!sigInfos.length) break;

    for (const sigInfo of sigInfos) {
      if (sigInfo?.err) continue;
      const signature = typeof sigInfo?.signature === 'string' ? sigInfo.signature.trim() : '';
      if (!signature) continue;

      try {
        await verifyReceiptIssuanceBySignature({
          order: itemIds.length ? { itemIds } : {},
          ownerWallet,
          deliveryId,
          signature,
          dropRuntime,
          conn,
        });
        return signature;
      } catch (err) {
        if (isIgnorableDeliverySignatureProbeError(err)) continue;
        throw err;
      }
    }

    remaining -= sigInfos.length;
    if (sigInfos.length < pageLimit) break;
    const lastSignature = typeof sigInfos[sigInfos.length - 1]?.signature === 'string' ? sigInfos[sigInfos.length - 1]?.signature.trim() : '';
    if (!lastSignature) break;
    before = lastSignature;
  }

  return null;
}

export async function hasConfirmedDeliveryRecordForDeliveryOrder(
  args: HasConfirmedDeliveryRecordForDeliveryOrderArgs,
): Promise<boolean> {
  const deliveryId = requirePositiveDeliveryId(args.deliveryId);
  const dropId = requireDropId(args.dropId);
  const dropRuntime = getDropRuntime(dropId);
  const conn = connection(dropRuntime);
  const [expectedDeliveryPda] = deriveDeliveryPdaForDrop(dropRuntime, deliveryId);
  assertStoredDeliveryPdaMatchesExpected(args.deliveryPda, expectedDeliveryPda);
  const deliveryRecord = await fetchConfirmedDeliveryRecordAccount({
    dropRuntime,
    conn,
    deliveryId,
    context: 'getAccountInfo:deliveryPda:scriptProbe',
    includeData: false,
  });
  return Boolean(deliveryRecord);
}

async function verifyReceiptIssuanceBySignature(params: {
  order: any;
  ownerWallet: string;
  deliveryId: number;
  signature: string;
  dropRuntime: DropRuntime;
  conn: Connection;
}): Promise<VerifiedReceiptIssuanceTarget> {
  const { order, ownerWallet, deliveryId, signature, dropRuntime, conn } = params;
  const tx = await withTimeout(
    conn.getTransaction(signature, { maxSupportedTransactionVersion: 0 }),
    RPC_TIMEOUT_MS,
    'getTransaction:delivery',
  );
  if (!tx || tx.meta?.err) {
    throw deliverySignatureProbeFailedPrecondition('transaction_not_found_or_failed', 'Delivery transaction not found or failed');
  }

  const [expectedDeliveryPda, expectedDeliveryBump] = deriveDeliveryPdaForDrop(dropRuntime, deliveryId);
  const keys = resolveInstructionAccounts(tx);
  const FIXED_DELIVER_ACCOUNTS = 9;
  const deliverIxs = (tx?.transaction?.message?.compiledInstructions || []).filter((ix: any) => {
    const program = keys[ix.programIdIndex];
    if (!program || !program.equals(dropRuntime.boxMinterProgramId)) return false;
    const dataField = (ix as any).data;
    const dataBuffer = typeof dataField === 'string' ? Buffer.from(bs58.decode(dataField)) : Buffer.from(dataField || []);
    return dataBuffer.subarray(0, 8).equals(IX_DELIVER);
  });
  let deliverIx: any = null;
  let deliverIxAccounts: PublicKey[] = [];
  for (const candidateIx of deliverIxs) {
    const accountKeyIndexesRaw: any = (candidateIx as any).accountKeyIndexes;
    const accountKeyIndexes: number[] = Array.isArray(accountKeyIndexesRaw)
      ? (accountKeyIndexesRaw as number[])
      : Array.from(accountKeyIndexesRaw || []);
    const ixAccounts = accountKeyIndexes.map((idx: number) => keys[idx]);
    if (ixAccounts.length < FIXED_DELIVER_ACCOUNTS) continue;
    if (ixAccounts[8]?.equals(expectedDeliveryPda)) {
      deliverIx = candidateIx;
      deliverIxAccounts = ixAccounts;
      break;
    }
  }
  if (!deliverIx) {
    throw deliverySignatureProbeFailedPrecondition(
      'missing_target_deliver_instruction',
      'Delivery transaction is missing a deliver instruction for the expected delivery PDA',
    );
  }

  const payer = getPayerFromTx(tx);
  if (!payer || payer.toBase58() !== ownerWallet) {
    throw deliverySignatureProbeFailedPrecondition('payer_mismatch', 'Signature payer does not match owner');
  }

  const deliverDataField = (deliverIx as any).data;
  const deliverData =
    typeof deliverDataField === 'string' ? Buffer.from(bs58.decode(deliverDataField)) : Buffer.from(deliverDataField || []);
  const decoded = decodeDeliverArgs(deliverData);
  if (decoded.deliveryId !== deliveryId) {
    throw deliverySignatureProbeFailedPrecondition('delivery_id_mismatch', 'Delivery id mismatch', {
      expectedId: deliveryId,
      got: decoded.deliveryId,
    });
  }

  const deliveryPdaFromIx = deliverIxAccounts[8];
  if (!deliveryPdaFromIx?.equals(expectedDeliveryPda)) {
    throw deliverySignatureProbeFailedPrecondition('delivery_pda_mismatch', 'Delivery PDA mismatch', {
      expected: expectedDeliveryPda.toBase58(),
      got: deliveryPdaFromIx?.toBase58(),
    });
  }

  const itemIds: string[] = Array.isArray(order?.itemIds) ? order.itemIds : [];
  const deliveredAssetsFromIx = deliverIxAccounts.slice(FIXED_DELIVER_ACCOUNTS).map((k: PublicKey) => k.toBase58());
  if (itemIds.length && deliveredAssetsFromIx.length && itemIds.length !== deliveredAssetsFromIx.length) {
    throw deliverySignatureProbeFailedPrecondition('item_count_mismatch', 'Delivery item count mismatch', {
      expected: itemIds.length,
      got: deliveredAssetsFromIx.length,
    });
  }
  if (itemIds.length) {
    for (let i = 0; i < itemIds.length; i += 1) {
      if (deliveredAssetsFromIx[i] && deliveredAssetsFromIx[i] !== itemIds[i]) {
        throw deliverySignatureProbeFailedPrecondition('asset_list_mismatch', 'Delivered asset list mismatch', {
          index: i,
          expected: itemIds[i],
          got: deliveredAssetsFromIx[i],
        });
      }
    }
  }

  const targetAssetIds = itemIds.length ? itemIds : deliveredAssetsFromIx;
  if (!targetAssetIds.length) {
    throw deliverySignatureProbeFailedPrecondition(
      'missing_delivered_item_ids',
      'Delivery order is missing delivered item ids',
    );
  }

  return {
    verification: 'signature',
    signature,
    expectedDeliveryPda,
    expectedDeliveryBump,
    targetAssetIds,
  };
}

async function verifyReceiptIssuanceByDeliveryRecord(params: {
  order: any;
  ownerWallet: string;
  deliveryId: number;
  dropRuntime: DropRuntime;
  conn: Connection;
}): Promise<VerifiedReceiptIssuanceTarget> {
  const { order, ownerWallet, deliveryId, dropRuntime, conn } = params;
  const itemIds: string[] = Array.isArray(order?.itemIds) ? order.itemIds.filter((id: any) => typeof id === 'string' && id) : [];
  if (!itemIds.length) {
    throw new HttpsError('failed-precondition', 'Delivery order is missing itemIds for recovery');
  }

  const deliveryRecordAccount = await fetchConfirmedDeliveryRecordAccount({
    dropRuntime,
    conn,
    deliveryId,
    context: 'getAccountInfo:deliveryPda:recovery',
  });
  if (!deliveryRecordAccount) {
    throw new HttpsError('failed-precondition', 'Delivery record PDA not found');
  }
  const { expectedDeliveryPda, expectedDeliveryBump, deliveryInfo } = deliveryRecordAccount;
  assertStoredDeliveryPdaMatchesExpected(order?.deliveryPda, expectedDeliveryPda);

  const deliveryRecord = decodeDeliveryRecord(Buffer.from(deliveryInfo.data));
  if (deliveryRecord.payer.toBase58() !== ownerWallet) {
    throw new HttpsError('failed-precondition', 'Delivery record payer does not match owner');
  }
  if (deliveryRecord.itemCount !== itemIds.length) {
    throw new HttpsError('failed-precondition', 'Delivery record item count mismatch', {
      expected: itemIds.length,
      got: deliveryRecord.itemCount,
    });
  }

  const expectedLamports = Number(order?.deliveryLamports);
  if (Number.isFinite(expectedLamports) && expectedLamports >= 0 && deliveryRecord.deliveryFeeLamports !== expectedLamports) {
    throw new HttpsError('failed-precondition', 'Delivery record fee mismatch', {
      expected: expectedLamports,
      got: deliveryRecord.deliveryFeeLamports,
    });
  }

  return {
    verification: 'delivery_pda',
    signature: storedDeliverySignature(order),
    expectedDeliveryPda,
    expectedDeliveryBump,
    targetAssetIds: itemIds,
  };
}

async function verifyReceiptIssuanceTarget(params: {
  args: RetryIssueReceiptsArgs;
  order: any;
  ownerWallet: string;
  deliveryId: number;
  dropRuntime: DropRuntime;
  conn: Connection;
}): Promise<VerifiedReceiptIssuanceTarget> {
  const { args, order, ownerWallet, deliveryId, dropRuntime, conn } = params;
  if (args.verification === 'signature') {
    const signature = String(args.signature || '').trim();
    if (!signature) {
      throw new HttpsError('invalid-argument', 'signature is required');
    }
    return verifyReceiptIssuanceBySignature({
      order,
      ownerWallet,
      deliveryId,
      signature,
      dropRuntime,
      conn,
    });
  }
  return verifyReceiptIssuanceByDeliveryRecord({
    order,
    ownerWallet,
    deliveryId,
    dropRuntime,
    conn,
  });
}

export async function retryIssueReceiptsForDeliveryOrder(
  args: RetryIssueReceiptsArgs,
): Promise<RetryIssueReceiptsResult> {
  const ownerWallet = normalizeWallet(args.ownerWallet);
  const deliveryId = requirePositiveDeliveryId(args.deliveryId);
  const dropId = requireDropId(args.dropId);
  const dropRuntime = getDropRuntime(dropId);

  await ensureOnchainCoreConfig(dropRuntime);
  if (!dropRuntime.receiptsMerkleTreeStr) {
    throw new HttpsError(
      'failed-precondition',
      'Receipt cNFT tree is not configured (set `receiptsMerkleTree` in functions/src/config/deployment.ts)',
      { dropId },
    );
  }

  const orderRef = db.doc(dropDeliveryOrderPath(dropId, deliveryId));
  const orderSnap = await orderRef.get();
  if (!orderSnap.exists) {
    throw new HttpsError('not-found', 'Delivery order not found');
  }
  const order = orderSnap.data() as any;
  if (order.owner && order.owner !== ownerWallet) {
    throw new HttpsError('permission-denied', 'Order belongs to a different wallet');
  }

  const conn = connection(dropRuntime);

  // Fast-path idempotency (already finalized).
  if (order.status === 'ready_to_ship') {
    const cfg = await fetchDecodedBoxMinterConfigAccount({
      dropRuntime,
      conn,
      context: 'getAccountInfo:boxMinterConfig:lateClose',
    });
    const [expectedDeliveryPda, expectedDeliveryBump] = deriveDeliveryPdaForDrop(dropRuntime, deliveryId);
    let closeDeliveryTx: string | null = order.closeDeliveryTx || null;
    if (!closeDeliveryTx) {
      // Best-effort late cleanup: if the delivery PDA still exists, close it now.
      const deliveryInfo = await withTimeout(
        conn.getAccountInfo(expectedDeliveryPda, { commitment: 'confirmed', dataSlice: { offset: 0, length: 0 } }),
        RPC_TIMEOUT_MS,
        'getAccountInfo:deliveryPda:lateClose',
      );
      if (deliveryInfo) {
        try {
          const cfgAdmin = cfg.admin;
          const signer = cosigner();
          if (!signer.publicKey.equals(cfgAdmin)) {
            throw new HttpsError('failed-precondition', 'Server key does not match on-chain admin (late close)');
          }

          const closeIx = new TransactionInstruction({
            programId: dropRuntime.boxMinterProgramId,
            keys: [
              { pubkey: dropRuntime.boxMinterConfigPda, isSigner: false, isWritable: false },
              { pubkey: signer.publicKey, isSigner: true, isWritable: true },
              { pubkey: expectedDeliveryPda, isSigner: false, isWritable: true },
              { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
            ],
            data: encodeCloseDeliveryArgs({ deliveryId, deliveryBump: expectedDeliveryBump }),
          });
          const { blockhash } = await withTimeout(
            conn.getLatestBlockhash('confirmed'),
            RPC_TIMEOUT_MS,
            'getLatestBlockhash:lateClose',
          );
          const closeTx = buildTx(
            [ComputeBudgetProgram.setComputeUnitLimit({ units: 250_000 }), closeIx],
            signer.publicKey,
            blockhash,
            [signer],
          );
          const closeSig = await sendAndConfirmSignedTx(conn, closeTx, 'lateCloseDelivery', {
            sendTimeoutMs: TX_SEND_TIMEOUT_MS,
            confirmTimeoutMs: TX_CONFIRM_TIMEOUT_MS,
          });
          closeDeliveryTx = closeSig;
          await orderRef.set({ dropId, closeDeliveryTx, deliveryClosedAt: FieldValue.serverTimestamp() }, { merge: true });
        } catch (err) {
          console.error('[mons/functions] late closeDelivery failed (non-fatal)', summarizeError(err), { deliveryId });
        }
      }
    }

    return {
      processed: true,
      deliveryId,
      receiptsMinted: Number(order.receiptsMinted || 0),
      receiptTxs: Array.isArray(order.receiptTxs) ? order.receiptTxs : [],
      closeDeliveryTx,
    };
  }

  const verified = await verifyReceiptIssuanceTarget({
    args,
    order,
    ownerWallet,
    deliveryId,
    dropRuntime,
    conn,
  });
  const signature = verified.signature;
  const expectedDeliveryPda = verified.expectedDeliveryPda;
  const expectedDeliveryBump = verified.expectedDeliveryBump;
  const targetAssetIds = verified.targetAssetIds;

  // Ensure the cosigner key matches the on-chain admin (custody vault).
  const cfg = await fetchDecodedBoxMinterConfigAccount({
    dropRuntime,
    conn,
    context: 'getAccountInfo:boxMinterConfig',
  });
  const cfgAdmin = cfg.admin;
  const cfgCoreCollection = cfg.coreCollection;
  const signer = cosigner();
  if (!signer.publicKey.equals(cfgAdmin)) {
    throw new HttpsError('failed-precondition', 'COSIGNER_SECRET does not match on-chain admin', {
      expectedAdmin: cfgAdmin.toBase58(),
      cosigner: signer.publicKey.toBase58(),
    });
  }

  // Best-effort processing lock (avoid concurrent minting).
  await orderRef.set(
    {
      dropId,
      status: 'processing',
      ...(signature ? { deliverySignature: signature } : {}),
      ...(order?.processingAt ? {} : { processingAt: FieldValue.serverTimestamp() }),
    },
    { merge: true },
  );
  await orderRef
    .update({
      'receiptRecovery.lastPreparedProbeAt': FieldValue.delete(),
      'receiptRecovery.preparedProbeCount': FieldValue.delete(),
      'receiptRecovery.nextPreparedProbeAt': FieldValue.delete(),
      'receiptRecovery.status': FieldValue.delete(),
    })
    .catch(() => {
      // Ignore cleanup races; prepared-order probing is operational only.
    });

  const expectedOrderItems: any[] = Array.isArray(order.items) ? order.items : [];
  const byAssetId = new Map<string, any>();
  expectedOrderItems.forEach((it) => {
    if (it && typeof it.assetId === 'string') byAssetId.set(it.assetId, it);
  });

  const targetAssetPks = targetAssetIds.map((id) => new PublicKey(id));
  const infos = await withTimeout(
    conn.getMultipleAccountsInfo(targetAssetPks, { commitment: 'confirmed', dataSlice: { offset: 0, length: 0 } }),
    RPC_TIMEOUT_MS,
    'getMultipleAccountsInfo:deliveryAssets',
  );

  const ownerPk = new PublicKey(ownerWallet);
  const pending: Array<{ assetId: string; assetPk: PublicKey; kind: 'box' | 'dude'; refId: number }> = [];
  for (let i = 0; i < targetAssetIds.length; i += 1) {
    const info = infos[i];
    if (!info) continue; // already burned / reclaimed
    const assetId = targetAssetIds[i];
    const pk = targetAssetPks[i];
    const stored = byAssetId.get(assetId);
    const kind = stored?.kind;
    const refId = Number(stored?.refId);
    if (kind !== 'box' && kind !== 'dude') {
      throw new HttpsError('failed-precondition', 'Delivery order is missing item kind for receipt minting', {
        assetId,
        kind,
      });
    }
    if (!Number.isFinite(refId) || refId <= 0 || refId > 0xffff_ffff) {
      throw new HttpsError('failed-precondition', 'Delivery order is missing item refId for receipt minting', {
        assetId,
        kind,
        refId,
      });
    }
    if (kind === 'dude' && refId > dropRuntime.maxDudeId) {
      throw new HttpsError('failed-precondition', 'Invalid dude id for receipt minting', { assetId, refId });
    }
    pending.push({ assetId, assetPk: pk, kind, refId });
  }

  const alreadyProcessed = targetAssetIds.length - pending.length;
  const receiptTxs: string[] = [];
  let totalProcessed = 0;

  // Process in as-large-as-possible batches, bounded by tx size + compute + transient RPC failures.
  // Strategy:
  // - start with a large batch size (<= 24)
  // - if tx is too large OR hits compute/simulation limits, shrink `n`
  // - if send/confirm has transient failures, retry the SAME batch (same `n`) with backoff
  // - if we can't confirm but the burned assets are gone, treat it as success (idempotent)
  while (pending.length) {
    // Start small (more reliable under congestion / compute variability).
    let n = Math.min(pending.length, 3);
    let lastErr: unknown = null;

    while (n >= 1) {
      const batch = pending.slice(0, n);
      const burnIxs = batch.map((it) =>
        mplCoreBurnV1Ix({
          asset: it.assetPk,
          coreCollection: cfgCoreCollection,
          authority: signer.publicKey,
          payer: signer.publicKey,
        }),
      );
      const boxIds = batch.filter((it) => it.kind === 'box').map((it) => Math.floor(it.refId));
      const dudeIds = batch.filter((it) => it.kind === 'dude').map((it) => Math.floor(it.refId));
      const mintReceiptsIx = buildMintReceiptsIx({
        dropRuntime,
        cosignerPk: signer.publicKey,
        recipientPk: ownerPk,
        coreCollection: cfgCoreCollection,
        boxIds,
        dudeIds,
      });
      const instructions: TransactionInstruction[] = [
        ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
        ...burnIxs,
        mintReceiptsIx,
      ];

      let succeeded = false;

      for (let attempt = 0; attempt < Math.max(1, TX_MAX_SEND_ATTEMPTS); attempt += 1) {
        // Fresh blockhash each send attempt.
        const { blockhash } = await withTimeout(
          conn.getLatestBlockhash('confirmed'),
          RPC_TIMEOUT_MS,
          'getLatestBlockhash:issueReceipts',
        );

        let txCandidate: VersionedTransaction;
        let rawLen = 0;
        try {
          txCandidate = buildTx(instructions, signer.publicKey, blockhash, [signer]);
          rawLen = txCandidate.serialize().length;
          if (rawLen > SOLANA_MAX_RAW_TX_BYTES) {
            lastErr = new RangeError(`Receipt issuance transaction too large (${rawLen} bytes)`);
            break; // shrink `n`
          }
        } catch (err) {
          if (!transactionEncodingTooLarge(err)) throw err;
          lastErr = err;
          break; // shrink `n`
        }

        const sig = bs58.encode(txCandidate.signatures[0]);

        let sendErr: unknown = null;
        try {
          await withTimeout(
            conn.sendTransaction(txCandidate, { maxRetries: 2 }),
            TX_SEND_TIMEOUT_MS,
            'sendTransaction:issueReceipts',
          );
        } catch (err) {
          sendErr = err;
        }

        if (sendErr) {
          const msg = txErrMessage(sendErr);
          const logs = txErrLogs(sendErr);
          lastErr = sendErr;

          // If preflight simulation failed (logs present), retrying with the same batch size often won't help.
          if (logs.length) {
            if (looksLikeAccountInUseError(msg, logs) || looksLikeRateLimitOrRpcError(msg) || looksLikeBlockhashError(msg)) {
              // transient: backoff + retry same `n`
              await sleep(Math.min(600 * 2 ** Math.min(attempt, 4), 4_000));
              continue;
            }
            // likely compute or deterministic failure: shrink
            break;
          }

          // Unclear if it was submitted; wait briefly for it to land anyway.
          const maybe = await waitForSignature(conn, sig, { timeoutMs: 12_000, pollMs: TX_CONFIRM_POLL_MS });
          if (maybe.ok) {
            receiptTxs.push(sig);
            totalProcessed += n;
            pending.splice(0, n);
            succeeded = true;
            break;
          }
          // If we can't confirm, but the burned assets are gone, treat as success.
          const postInfos = await withTimeout(
            conn.getMultipleAccountsInfo(batch.map((b) => b.assetPk), {
              commitment: 'confirmed',
              dataSlice: { offset: 0, length: 0 },
            }),
            RPC_TIMEOUT_MS,
            'getMultipleAccountsInfo:postSend',
          );
          if (postInfos.every((ai) => !ai)) {
            receiptTxs.push(sig);
            totalProcessed += n;
            pending.splice(0, n);
            succeeded = true;
            break;
          }

          // retry same batch (transient)
          await sleep(Math.min(600 * 2 ** Math.min(attempt, 4), 4_000));
          continue;
        }

        // Sent: confirm (polling is more reliable than a single confirmTransaction call).
        const confirmed = await waitForSignature(conn, sig, { timeoutMs: TX_CONFIRM_TIMEOUT_MS, pollMs: TX_CONFIRM_POLL_MS });
        if (confirmed.ok) {
          receiptTxs.push(sig);
          totalProcessed += n;
          pending.splice(0, n);
          succeeded = true;
          break;
        }

        // If we can't confirm, but the burned assets are gone, treat as success.
        const postInfos = await withTimeout(
          conn.getMultipleAccountsInfo(batch.map((b) => b.assetPk), {
            commitment: 'confirmed',
            dataSlice: { offset: 0, length: 0 },
          }),
          RPC_TIMEOUT_MS,
          'getMultipleAccountsInfo:postConfirm',
        );
        if (postInfos.every((ai) => !ai)) {
          receiptTxs.push(sig);
          totalProcessed += n;
          pending.splice(0, n);
          succeeded = true;
          break;
        }

        // Failed or still unknown.
        if (confirmed.ok === false) {
          lastErr = confirmed.err;
          const msg = txErrMessage(confirmed.err);
          const logs = Array.isArray(confirmed.logs) ? confirmed.logs : [];
          if (looksLikeComputeLimitError(msg, logs)) {
            // shrink batch size
            break;
          }
        }

        // retry same `n` (congestion / rpc flakiness)
        await sleep(Math.min(600 * 2 ** Math.min(attempt, 4), 4_000));
      }

      if (succeeded) {
        break; // go to next `pending` chunk
      }

      // Shrink batch size and try again.
      n -= 1;
    }

    if (n < 1) {
      const msg = txErrMessage(lastErr);
      const logs = txErrLogs(lastErr);
      throw new HttpsError('failed-precondition', 'Unable to issue receipts (try fewer items or retry later)', {
        lastError: msg,
        lastLogs: logs.slice(0, 80),
      });
    }
  }

  const receiptsMinted = alreadyProcessed + totalProcessed;

  // Create IRL claim codes for each delivered box (so the admin can ship the secret code inside the physical box).
  const irlClaims: Array<{ code: string; boxId: number; boxAssetId: string; dudeIds: number[] }> = [];
  if (isOpenableDrop(dropRuntime)) {
    const deliveredItems: any[] = Array.isArray(order.items) ? order.items : [];
    const deliveredBoxes = deliveredItems.filter((it) => it && it.kind === 'box' && typeof it.assetId === 'string');
    for (const box of deliveredBoxes) {
      const boxAssetId = String(box.assetId);
      const boxId = Number(box.refId);
      if (!Number.isFinite(boxId) || boxId <= 0 || boxId > 0xffff_ffff) continue;
      const dudeIds = await assignDudes(dropId, boxAssetId);
      const code = await ensureIrlClaimCodeForBox({ dropId, ownerWallet, deliveryId, boxAssetId, boxId, dudeIds });
      irlClaims.push({ code, boxId, boxAssetId, dudeIds });
    }
  }

  // Mark Firestore ready-to-ship BEFORE closing on-chain delivery record.
  await orderRef.set(
    {
      dropId,
      status: 'ready_to_ship',
      ...(signature ? { deliverySignature: signature } : {}),
      receiptsMinted,
      receiptTxs,
      ...(irlClaims.length ? { irlClaims, irlClaimsUpdatedAt: FieldValue.serverTimestamp() } : {}),
      processedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );
  void countNormalIrlPackStatus({
    db,
    dropRuntime,
    deliveryId,
    packQuantity: countDeliveryOrderBoxItems(order.items),
    unsealedCardQuantity: countDeliveryOrderDudeItems(order.items),
  }).catch((err) => {
    logger.warn('retryIssueReceiptsForDeliveryOrder:packStatusCountFailed', {
      dropId,
      deliveryId,
      error: summarizeError(err),
    });
  });
  await orderRef.update({
    'receiptRecovery.leaseExpiresAt': FieldValue.delete(),
    'receiptRecovery.lastErrorCode': FieldValue.delete(),
    'receiptRecovery.lastErrorMessage': FieldValue.delete(),
    'receiptRecovery.lastPreparedProbeAt': FieldValue.delete(),
    'receiptRecovery.preparedProbeCount': FieldValue.delete(),
    'receiptRecovery.nextPreparedProbeAt': FieldValue.delete(),
    'receiptRecovery.status': FieldValue.delete(),
  }).catch(() => {
    // Ignore cleanup races; recovery metadata is operational only.
  });

  // Close delivery PDA (reclaim rent) after burning + minting + Firestore marking.
  let closeDeliveryTx: string | null = null;
  const deliveryInfo = await withTimeout(
    conn.getAccountInfo(expectedDeliveryPda, { commitment: 'confirmed', dataSlice: { offset: 0, length: 0 } }),
    RPC_TIMEOUT_MS,
    'getAccountInfo:deliveryPda',
  );
  if (deliveryInfo) {
    const closeIx = new TransactionInstruction({
      programId: dropRuntime.boxMinterProgramId,
      keys: [
        { pubkey: dropRuntime.boxMinterConfigPda, isSigner: false, isWritable: false },
        { pubkey: signer.publicKey, isSigner: true, isWritable: true },
        { pubkey: expectedDeliveryPda, isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: encodeCloseDeliveryArgs({ deliveryId, deliveryBump: expectedDeliveryBump }),
    });
    const { blockhash } = await withTimeout(
      conn.getLatestBlockhash('confirmed'),
      RPC_TIMEOUT_MS,
      'getLatestBlockhash:closeDelivery',
    );
    const closeTx = buildTx(
      [ComputeBudgetProgram.setComputeUnitLimit({ units: 250_000 }), closeIx],
      signer.publicKey,
      blockhash,
      [signer],
    );
    try {
      closeDeliveryTx = await sendAndConfirmSignedTx(conn, closeTx, 'closeDelivery', {
        sendTimeoutMs: TX_SEND_TIMEOUT_MS,
        confirmTimeoutMs: TX_CONFIRM_TIMEOUT_MS,
      });
    } catch (err) {
      console.error('[mons/functions] closeDelivery failed (non-fatal)', summarizeError(err), { deliveryId });
    }
  }

  if (closeDeliveryTx) {
    await orderRef.set({ dropId, closeDeliveryTx, deliveryClosedAt: FieldValue.serverTimestamp() }, { merge: true });
  }

  return { processed: true, deliveryId, receiptsMinted, receiptTxs, closeDeliveryTx };
}

export const issueReceipts = onCallLogged(
  'issueReceipts',
  async (request) => {
    const { wallet } = await requireWalletSession(request);
    const schema = z.object({
      owner: z.string(),
      deliveryId: z.number().int().positive(),
      signature: z.string(),
      dropId: z.string().min(1).max(64),
    });
    const { owner, deliveryId, signature, dropId: requestDropId } = parseRequest(schema, request.data);
    const ownerWallet = normalizeWallet(owner);
    if (wallet !== ownerWallet) throw new HttpsError('permission-denied', 'Owners only');
    const dropId = requireDropId(requestDropId);
    const orderRef = db.doc(dropDeliveryOrderPath(dropId, deliveryId));
    const orderSnap = await orderRef.get();
    const order = orderSnap.exists ? orderSnap.data() as any : null;
    let leaseAcquired = false;

    if (order?.status !== 'ready_to_ship') {
      const lease = await acquireDeliveryRecoveryLease(orderRef, ownerWallet, Date.now(), true);
      if ('result' in lease) {
        if (lease.result.outcome === 'lease_active') {
          throw new HttpsError('aborted', lease.result.message || 'another client is already retrying this order');
        }
        if (lease.result.outcome === 'not_found') {
          throw new HttpsError('not-found', lease.result.message || 'Delivery order not found');
        }
        if (lease.result.errorCode === 'permission-denied') {
          throw new HttpsError('permission-denied', lease.result.message || 'Order belongs to a different wallet');
        }
        if (lease.result.outcome !== 'skipped_status') {
          throw new HttpsError('failed-precondition', lease.result.message || 'Unable to start receipt issuance');
        }
      } else {
        leaseAcquired = true;
      }
    }

    try {
      const result = await retryIssueReceiptsForDeliveryOrder({
        ownerWallet,
        deliveryId,
        dropId,
        verification: 'signature',
        signature,
      });
      if (leaseAcquired) {
        await finalizeDeliveryRecoveryAttempt(orderRef, {}).catch(() => {
          // Ignore cleanup races; recovery metadata is operational only.
        });
      }
      return result;
    } catch (err) {
      if (leaseAcquired) {
        await finalizeDeliveryRecoveryAttempt(orderRef, {
          errorCode: normalizeRecoveryErrorCode(err),
          message: normalizeRecoveryMessage(err instanceof Error ? err.message : String(err)),
        }).catch(() => {
          // Ignore cleanup races; recovery metadata is operational only.
        });
      }
      throw err;
    }
  },
  { secrets: [COSIGNER_SECRET] },
);

export const recoverMyDeliveryOrders = onCallLogged('recoverMyDeliveryOrders', async (request) => {
  const { wallet } = await requireWalletSession(request);
  const schema = z.object({
    dropId: z.string().min(1).max(64).optional(),
    deliveryId: z.number().int().positive().optional(),
    force: z.boolean().optional(),
  });
  const { dropId: rawDropId, deliveryId, force = false } = parseRequest(schema, request.data || {});
  if (deliveryId != null && !rawDropId) {
    throw new HttpsError('invalid-argument', 'deliveryId requires dropId');
  }
  const filterDropId = rawDropId ? requireDropId(rawDropId) : undefined;
  const nowMs = Date.now();
  const results: RecoverMyDeliveryOrdersItemResult[] = [];
  let attempted = 0;
  let recovered = 0;

  let candidateDocs: DeliveryOrderDoc[] = [];
  if (filterDropId && deliveryId != null) {
    const doc = await db.doc(dropDeliveryOrderPath(filterDropId, deliveryId)).get();
    if (!doc.exists) {
      const recoveryState = await fetchDeliveryRecoveryState(wallet, filterDropId);
      return {
        attempted,
        recovered,
        remainingProcessing: recoveryState.remainingProcessing,
        ...(recoveryState.nextCheckAt != null ? { nextCheckAt: recoveryState.nextCheckAt } : {}),
        results: [
          {
            dropId: filterDropId,
            deliveryId,
            statusBefore: 'missing',
            outcome: 'not_found',
            verification: 'delivery_pda',
            message: 'delivery order not found',
          },
        ],
      } satisfies RecoverMyDeliveryOrdersResult;
    }
    candidateDocs = [doc];
  } else {
    const [processingDocs, preparedDocs] = await Promise.all([
      listOwnedDeliveryOrdersByStatus(wallet, 'processing', filterDropId),
      listOwnedDeliveryOrdersByStatus(wallet, 'prepared', filterDropId),
    ]);
    candidateDocs = [...processingDocs, ...preparedDocs];
  }

  candidateDocs.sort(compareDeliveryRecoveryCandidates);

  for (const doc of candidateDocs) {
    const order = doc.data() || {};
    const base = orderResultBase(doc);
    if (!base) continue;

    if (order?.owner && order.owner !== wallet) {
      results.push({
        ...base,
        outcome: 'failed',
        verification: 'delivery_pda',
        errorCode: 'permission-denied',
        message: 'order belongs to a different wallet',
      });
      continue;
    }

    if (base.statusBefore === 'ready_to_ship') {
      results.push({
        ...base,
        outcome: 'recovered',
        verification: 'delivery_pda',
        message: 'order is already ready to ship',
      });
      recovered += 1;
      continue;
    }

    if (base.statusBefore === 'prepared' && !force) {
      let hasDeliveryRecord: boolean | null = null;
      try {
        hasDeliveryRecord = await hasConfirmedDeliveryRecord(base.dropId, base.deliveryId);
      } catch (err) {
        logger.warn('recoverMyDeliveryOrders:eligibilityCheckFailed', {
          wallet,
          dropId: base.dropId,
          deliveryId: base.deliveryId,
          verification: 'delivery_pda',
          error: summarizeError(err),
        });
      }
      if (hasDeliveryRecord === false) {
        const nextPreparedCheckAt = await recordPreparedDeliveryRecoveryMiss(doc.ref, order, nowMs).catch((err) => {
          logger.warn('recoverMyDeliveryOrders:preparedProbeUpdateFailed', {
            wallet,
            dropId: base.dropId,
            deliveryId: base.deliveryId,
            verification: 'delivery_pda',
            error: summarizeError(err),
          });
          return null;
        });
        results.push({
          ...base,
          outcome: 'not_eligible',
          verification: 'delivery_pda',
          message:
            nextPreparedCheckAt != null
              ? 'prepared order has no confirmed on-chain delivery record yet'
              : 'prepared order never produced a confirmed on-chain delivery record',
        });
        continue;
      }
    }

    if (attempted >= MAX_DELIVERY_RECOVERY_ORDERS_PER_CALL) {
      results.push({
        ...base,
        outcome: 'attempt_capped',
        verification: 'delivery_pda',
        message: 'recovery attempt cap reached for this pass',
      });
      continue;
    }

    const lease = await acquireDeliveryRecoveryLease(doc.ref, wallet, nowMs, force);
    if ('result' in lease) {
      results.push(lease.result);
      continue;
    }

    attempted += 1;
    try {
      const retryResult = await retryIssueReceiptsForDeliveryOrder({
        ownerWallet: wallet,
        deliveryId: base.deliveryId,
        dropId: base.dropId,
        verification: 'delivery_pda',
      });
      recovered += 1;
      results.push({
        ...base,
        outcome: 'recovered',
        verification: 'delivery_pda',
        message: retryResult.processed ? 'receipts issued' : 'order already processed',
      });
      await finalizeDeliveryRecoveryAttempt(doc.ref, {});
      logger.info('recoverMyDeliveryOrders:recovered', {
        wallet,
        dropId: base.dropId,
        deliveryId: base.deliveryId,
        verification: 'delivery_pda',
      });
    } catch (err) {
      const errorCode = normalizeRecoveryErrorCode(err);
      const message = normalizeRecoveryMessage(err instanceof Error ? err.message : String(err));
      const outcome =
        errorCode === 'failed-precondition' && /delivery record pda not found/i.test(String(err instanceof Error ? err.message : err))
          ? 'missing_delivery'
          : 'failed';
      if (base.statusBefore === 'prepared') {
        if (outcome === 'missing_delivery') {
          await recordPreparedDeliveryRecoveryMiss(doc.ref, order, nowMs).catch((probeErr) => {
            logger.warn('recoverMyDeliveryOrders:preparedProbeUpdateFailed', {
              wallet,
              dropId: base.dropId,
              deliveryId: base.deliveryId,
              verification: 'delivery_pda',
              error: summarizeError(probeErr),
            });
          });
        } else {
          await stopPreparedDeliveryRecoveryChecks(doc.ref, order, nowMs).catch((probeErr) => {
            logger.warn('recoverMyDeliveryOrders:preparedProbeStopFailed', {
              wallet,
              dropId: base.dropId,
              deliveryId: base.deliveryId,
              verification: 'delivery_pda',
              error: summarizeError(probeErr),
            });
          });
        }
      }
      results.push({
        ...base,
        outcome,
        verification: 'delivery_pda',
        ...(errorCode ? { errorCode } : {}),
        ...(message ? { message } : {}),
      });
      await finalizeDeliveryRecoveryAttempt(doc.ref, { errorCode, message });
      logger.warn('recoverMyDeliveryOrders:failed', {
        wallet,
        dropId: base.dropId,
        deliveryId: base.deliveryId,
        verification: 'delivery_pda',
        error: summarizeError(err),
      });
    }
  }

  const recoveryState = await fetchDeliveryRecoveryState(wallet, filterDropId);
  return {
    attempted,
    recovered,
    remainingProcessing: recoveryState.remainingProcessing,
    ...(recoveryState.nextCheckAt != null ? { nextCheckAt: recoveryState.nextCheckAt } : {}),
    results,
  } satisfies RecoverMyDeliveryOrdersResult;
});

type StripeReceiptClaimStart =
  | {
      status: 'already_claimed';
      dropId: string;
      deliveryId: number;
      boxId: number;
      receiptTxs: string[];
      receiptKind?: StripeReceiptClaimReceiptKind;
      receiptsTransferred?: number;
      figureIds?: number[];
      receiptAssetIds?: string[];
    }
  | {
      status: 'started';
      dropId: string;
      deliveryId: number;
      boxId: number;
      attemptId: string;
      orderRef: DocumentReference;
      orderIrlClaims: any[];
      resumingPreviousProcessingClaim: boolean;
      hasPreviousClaimFailure: boolean;
      updatePluralOrderClaim: boolean;
      updateSingularOrderClaim: boolean;
      directFigureReceipt?: { receiptAssetId: string; figureId: number };
      receiptTxs: string[];
      receiptTxSubmissions: DirectCardReceiptClaimSubmission[];
    };

function normalizeReceiptTxs(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((tx): tx is string => typeof tx === 'string' && !!tx.trim()) : [];
}

function directCardReceiptClaimAssetId(raw: any): string {
  return raw?.receiptKind === 'figure' && typeof raw?.receiptAssetId === 'string'
    ? raw.receiptAssetId.trim()
    : '';
}

function normalizeDirectCardReceiptClaimSubmissions(raw: unknown): DirectCardReceiptClaimSubmission[] {
  if (!Array.isArray(raw)) return [];
  const bySignature = new Map<string, DirectCardReceiptClaimSubmission>();
  raw.forEach((entry) => {
    const signature = typeof entry?.signature === 'string' ? entry.signature.trim() : '';
    const lastValidBlockHeight = Math.floor(Number(entry?.lastValidBlockHeight));
    const submittedAtMs = Number(entry?.submittedAtMs);
    const status = entry?.status === 'not_landed' ? 'not_landed' : 'submitted';
    if (
      !signature ||
      !Number.isFinite(lastValidBlockHeight) ||
      lastValidBlockHeight <= 0 ||
      !Number.isFinite(submittedAtMs) ||
      submittedAtMs <= 0
    ) {
      return;
    }
    bySignature.set(signature, { signature, lastValidBlockHeight, submittedAtMs, status });
  });
  return Array.from(bySignature.values());
}

async function inspectDirectCardReceiptClaimSubmission(params: {
  conn: Connection;
  signature: string;
  submission: DirectCardReceiptClaimSubmission;
}): Promise<Extract<DirectCardReceiptClaimTransferEvidence, 'rejected' | 'expired_unverified' | 'unresolved'>> {
  const statuses = await withTimeout(
    params.conn.getSignatureStatuses([params.signature], { searchTransactionHistory: true }),
    RPC_TIMEOUT_MS,
    'getSignatureStatuses:claimStripeReceiptDirectCardTransfer',
  );
  const status = statuses?.value?.[0] || null;
  const signatureStatus = status?.err ? 'failed' : status ? 'succeeded' : 'missing';
  const currentBlockHeight =
    signatureStatus === 'missing'
      ? await withTimeout(
          params.conn.getBlockHeight('confirmed'),
          RPC_TIMEOUT_MS,
          'getBlockHeight:claimStripeReceiptDirectCardTransfer',
        )
      : 0;
  const evidence = classifyDirectCardReceiptClaimSubmission({
    signatureStatus,
    currentBlockHeight,
    lastValidBlockHeight: params.submission.lastValidBlockHeight,
    submittedAtMs: params.submission.submittedAtMs,
    nowMs: Date.now(),
  });
  return evidence === 'not_landed' ? 'rejected' : evidence;
}

async function resolveAmbiguousDirectCardReceiptSubmission(params: {
  conn: Connection;
  signature: string;
  lastValidBlockHeight: number;
  submittedAtMs: number;
}): Promise<'landed' | 'not_landed' | 'unresolved'> {
  const deadline = Date.now() + DIRECT_CARD_RECEIPT_SUBMISSION_RESOLUTION_MAX_WAIT_MS;
  while (Date.now() < deadline) {
    try {
      const statuses = await withTimeout(
        params.conn.getSignatureStatuses([params.signature], { searchTransactionHistory: true }),
        RPC_TIMEOUT_MS,
        'getSignatureStatuses:claimStripeReceiptDirectCardSubmission',
      );
      const status = statuses?.value?.[0] || null;
      if (status?.err) return 'not_landed';
      if (
        status?.confirmationStatus === 'confirmed' ||
        status?.confirmationStatus === 'finalized' ||
        status?.confirmations === null
      ) {
        return 'landed';
      }
      if (status) {
        await sleep(DIRECT_CARD_RECEIPT_SUBMISSION_RESOLUTION_POLL_MS);
        continue;
      }

      const currentBlockHeight = await withTimeout(
        params.conn.getBlockHeight('confirmed'),
        RPC_TIMEOUT_MS,
        'getBlockHeight:claimStripeReceiptDirectCardSubmission',
      );
      if (
        directCardReceiptClaimSubmissionProvesNoDelivery({
          signatureStatus: 'missing',
          currentBlockHeight,
          lastValidBlockHeight: params.lastValidBlockHeight,
          submittedAtMs: params.submittedAtMs,
          nowMs: Date.now(),
        })
      ) {
        return 'not_landed';
      }
    } catch {
      // Keep polling while this invocation is still inside the fresh history window.
    }
    await sleep(DIRECT_CARD_RECEIPT_SUBMISSION_RESOLUTION_POLL_MS);
  }
  return 'unresolved';
}

async function inspectPersistedDirectCardReceiptClaimTransfers(params: {
  conn: Connection;
  dropRuntime: DropRuntime;
  signatures: string[];
  adminWallet: string;
  recipientWallet: string;
  coreCollection: PublicKey;
  receiptAssetId: string;
  submissions: DirectCardReceiptClaimSubmission[];
}): Promise<{
  evidence: DirectCardReceiptClaimTransferEvidence;
  signature: string | null;
  terminalSubmissions: DirectCardReceiptClaimSubmission[];
}> {
  const signatures = Array.from(
    new Set(normalizeReceiptTxs(params.signatures).map((signature) => signature.trim())),
  ).reverse();
  if (!signatures.length) return { evidence: 'none', signature: null, terminalSubmissions: [] };
  const submissionsBySignature = new Map(params.submissions.map((submission) => [submission.signature, submission]));

  let sawUnresolved = false;
  let sawExpiredUnverified = false;
  const terminalSubmissions: DirectCardReceiptClaimSubmission[] = [];
  for (const signature of signatures) {
    const submission = submissionsBySignature.get(signature);
    if (submission?.status === 'not_landed') continue;
    try {
      await verifyDirectCardReceiptTransferSignature({
        conn: params.conn,
        dropRuntime: params.dropRuntime,
        signature,
        fromWallet: params.adminWallet,
        toWallet: params.recipientWallet,
        coreCollection: params.coreCollection,
        receiptAssetId: params.receiptAssetId,
        rpcLabel: 'getTransaction:claimStripeReceiptDirectCardTransfer',
      });
      return { evidence: 'verified', signature, terminalSubmissions };
    } catch (err) {
      let evidence: Extract<
        DirectCardReceiptClaimTransferEvidence,
        'rejected' | 'expired_unverified' | 'unresolved'
      > = classifyDirectCardReceiptClaimTransferVerificationError(err);
      if (evidence === 'unresolved' && submission) {
        try {
          evidence = await inspectDirectCardReceiptClaimSubmission({ conn: params.conn, signature, submission });
        } catch (absenceProofErr) {
          logger.info('claimStripeReceipt:persisted_direct_transfer_absence_unresolved', {
            dropId: params.dropRuntime.dropId,
            receiptAssetId: params.receiptAssetId,
            receiptTx: signature,
            error: summarizeError(absenceProofErr),
          });
        }
      }
      if (evidence === 'rejected' && submission) {
        terminalSubmissions.push({ ...submission, status: 'not_landed' });
      }
      if (evidence === 'unresolved') sawUnresolved = true;
      if (evidence === 'expired_unverified') sawExpiredUnverified = true;
      logger.info('claimStripeReceipt:persisted_direct_transfer_not_verified', {
        dropId: params.dropRuntime.dropId,
        receiptAssetId: params.receiptAssetId,
        receiptTx: signature,
        evidence,
        error: summarizeError(err),
      });
    }
  }
  return {
    evidence: sawUnresolved ? 'unresolved' : sawExpiredUnverified ? 'expired_unverified' : 'rejected',
    signature: null,
    terminalSubmissions,
  };
}

type StripeReceiptClaimReceiptKind = 'box' | 'figure';

type StripeReceiptClaimStoredResult = {
  receiptKind?: StripeReceiptClaimReceiptKind;
  receiptsTransferred?: number;
  figureIds?: number[];
  receiptAssetIds?: string[];
};

function stripeReceiptClaimMaybeSubmittedTx(err: unknown): string | null {
  const anyErr = err as any;
  const details = anyErr?.details || {};
  const signature = typeof details.signature === 'string' ? details.signature.trim() : '';
  if (!signature) return null;

  const message = txErrMessage(err);
  const maybeSubmitted = details.maybeSubmitted === true;
  const confirmationTimedOut = anyErr?.code === 'deadline-exceeded' && /transaction not confirmed/i.test(message);
  if (!/claimStripeReceipt/.test(message) || (!maybeSubmitted && !confirmationTimedOut)) return null;
  return signature;
}

function stripeReceiptClaimErrorKeepsProcessing(err: unknown): boolean {
  return (err as any)?.details?.keepReceiptClaimProcessing === true;
}

function normalizePositiveIntegerArray(raw: unknown): number[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((value) => Number(value))
    .filter((value) => Number.isInteger(value) && value > 0 && value <= 0xffff_ffff);
}

function normalizeStripeReceiptClaimStoredResult(raw: any): StripeReceiptClaimStoredResult {
  const receiptKind = raw?.receiptKind === 'box' || raw?.receiptKind === 'figure' ? raw.receiptKind : undefined;
  const receiptsTransferredRaw = Math.floor(Number(raw?.receiptsTransferred));
  const receiptsTransferred =
    Number.isFinite(receiptsTransferredRaw) && receiptsTransferredRaw > 0 ? receiptsTransferredRaw : undefined;
  const figureIds = normalizePositiveIntegerArray(raw?.figureIds);
  const receiptAssetId =
    receiptKind === 'figure' && typeof raw?.receiptAssetId === 'string' ? raw.receiptAssetId.trim() : '';
  return {
    ...(receiptKind ? { receiptKind } : {}),
    ...(receiptsTransferred ? { receiptsTransferred } : {}),
    ...(figureIds.length ? { figureIds } : {}),
    ...(receiptAssetId ? { receiptAssetIds: [receiptAssetId] } : {}),
  };
}

function stripeReceiptClaimResponse(params: {
  dropId: string;
  deliveryId: number;
  receiptTxs: string[];
  receiptKind?: StripeReceiptClaimReceiptKind;
  receiptsTransferred?: number;
  figureIds?: number[];
  receiptAssetIds?: string[];
}) {
  const figureIds = params.figureIds?.length ? params.figureIds : undefined;
  const receiptAssetIds = Array.from(
    new Set((params.receiptAssetIds || []).map((assetId) => String(assetId || '').trim()).filter(Boolean)),
  );
  const receiptsTransferred =
    params.receiptsTransferred && params.receiptsTransferred > 0
      ? params.receiptsTransferred
      : params.receiptKind === 'figure' && figureIds
        ? figureIds.length
        : 1;
  return {
    processed: true,
    dropId: params.dropId,
    deliveryId: params.deliveryId,
    receiptsTransferred,
    receiptTxs: params.receiptTxs,
    ...(params.receiptKind ? { receiptKind: params.receiptKind } : {}),
    ...(figureIds ? { figureIds } : {}),
    ...(receiptAssetIds.length ? { receiptAssetIds } : {}),
  };
}

function requireStripeReceiptClaimCodeForRequest(rawCode: unknown): string {
  try {
    return requireStripeReceiptClaimCode(rawCode);
  } catch {
    throw new HttpsError('invalid-argument', 'Invalid receipt claim code');
  }
}

function requirePositiveBoxId(rawBoxId: unknown): number {
  const boxId = Math.floor(Number(rawBoxId));
  if (!Number.isFinite(boxId) || boxId <= 0 || boxId > 0xffff_ffff) {
    throw new HttpsError('failed-precondition', 'Claim code is missing a valid box id');
  }
  return boxId;
}

function stripeReceiptClaimAttemptId(nowMs: number): string {
  return `${nowMs.toString(36)}:${randomInt(0, 2 ** 32).toString(36)}`;
}

function resolveStripeReceiptClaimOrderTarget(params: {
  order: any;
  code: string;
  boxId: number;
}): { updatePluralOrderClaim: boolean; updateSingularOrderClaim: boolean } {
  const pluralClaim = orderStripeReceiptClaimByBoxId(params.order, params.boxId);
  if (pluralClaim) {
    const pluralCode = stripeReceiptClaimCodeMaybe(pluralClaim);
    if (pluralCode && pluralCode !== params.code) {
      throw new HttpsError('failed-precondition', 'Receipt order claim code mismatch');
    }
    const singularClaim = params.order?.stripeReceiptClaim || {};
    const singularCode = stripeReceiptClaimCodeMaybe(singularClaim);
    const singularBoxId = Math.floor(Number(singularClaim?.boxId));
    return {
      updatePluralOrderClaim: true,
      updateSingularOrderClaim:
        singularCode === params.code || (!singularCode && Number.isFinite(singularBoxId) && singularBoxId === params.boxId),
    };
  }

  if (hasPluralStripeReceiptClaims(params.order)) {
    throw new HttpsError('failed-precondition', 'Receipt order claim code mismatch');
  }

  const singularClaim = params.order?.stripeReceiptClaim || {};
  const singularCode = stripeReceiptClaimCodeMaybe(singularClaim);
  if (singularCode && singularCode !== params.code) {
    throw new HttpsError('failed-precondition', 'Receipt order claim code mismatch');
  }
  const orderBoxId = Math.floor(Number(singularClaim?.boxId ?? params.order?.items?.[0]?.refId));
  if (Number.isFinite(orderBoxId) && orderBoxId > 0 && orderBoxId !== params.boxId) {
    throw new HttpsError('failed-precondition', 'Receipt order box id mismatch');
  }
  return { updatePluralOrderClaim: false, updateSingularOrderClaim: true };
}

function stripeReceiptClaimOrderFieldUpdate(params: {
  code: string;
  boxId: number;
  status: 'processing' | 'unclaimed' | 'claimed';
  fields: Record<string, unknown>;
  updatePluralOrderClaim: boolean;
  updateSingularOrderClaim: boolean;
}): Record<string, unknown> {
  const update: Record<string, unknown> = {};
  const claim = {
    namespace: STRIPE_RECEIPT_CLAIM_CODE_NAMESPACE,
    code: params.code,
    boxId: params.boxId,
    status: params.status,
    ...params.fields,
  };
  const assignClaimFields = (prefix: string) => {
    Object.entries(claim).forEach(([field, value]) => {
      update[`${prefix}.${field}`] = value;
    });
  };

  if (params.updatePluralOrderClaim) {
    assignClaimFields(`stripeReceiptClaimsByBoxId.${stripeReceiptClaimBoxMapKey(params.boxId)}`);
  }
  if (params.updateSingularOrderClaim) {
    assignClaimFields('stripeReceiptClaim');
  }
  return update;
}

function stripeReceiptClaimProcessingOrderUpdate(params: {
  dropId: string;
  code: string;
  boxId: number;
  recipientWallet: string;
  leaseExpiresAt: Timestamp;
  updatePluralOrderClaim: boolean;
  updateSingularOrderClaim: boolean;
}): Record<string, unknown> {
  return {
    dropId: params.dropId,
    ...stripeReceiptClaimOrderFieldUpdate({
      code: params.code,
      boxId: params.boxId,
      status: 'processing',
      fields: {
        recipient: params.recipientWallet,
        processingStartedAt: FieldValue.serverTimestamp(),
        processingLeaseExpiresAt: params.leaseExpiresAt,
      },
      updatePluralOrderClaim: params.updatePluralOrderClaim,
      updateSingularOrderClaim: params.updateSingularOrderClaim,
    }),
  };
}

function stripeReceiptClaimClearOrderUpdate(params: {
  dropId?: string;
  code: string;
  boxId: number;
  lastError: unknown;
  updatePluralOrderClaim: boolean;
  updateSingularOrderClaim: boolean;
}): Record<string, unknown> {
  return {
    ...(params.dropId ? { dropId: params.dropId } : {}),
    ...stripeReceiptClaimOrderFieldUpdate({
      code: params.code,
      boxId: params.boxId,
      status: 'unclaimed',
      fields: {
        recipient: FieldValue.delete(),
        processingStartedAt: FieldValue.delete(),
        processingLeaseExpiresAt: FieldValue.delete(),
        lastClaimError: params.lastError,
      },
      updatePluralOrderClaim: params.updatePluralOrderClaim,
      updateSingularOrderClaim: params.updateSingularOrderClaim,
    }),
  };
}

function stripeReceiptClaimFinalOrderUpdate(params: {
  dropId: string;
  code: string;
  boxId: number;
  recipientWallet: string;
  receiptTxs: string[];
  claimedAt: FieldValue;
  receiptKind: StripeReceiptClaimReceiptKind;
  receiptsTransferred: number;
  figureIds?: number[];
  updatePluralOrderClaim: boolean;
  updateSingularOrderClaim: boolean;
}): Record<string, unknown> {
  return {
    dropId: params.dropId,
    ...stripeReceiptClaimOrderFieldUpdate({
      code: params.code,
      boxId: params.boxId,
      status: 'claimed',
      fields: {
        recipient: params.recipientWallet,
        receiptTxs: params.receiptTxs,
        receiptKind: params.receiptKind,
        receiptsTransferred: params.receiptsTransferred,
        figureIds: params.figureIds?.length ? params.figureIds : FieldValue.delete(),
        claimedAt: params.claimedAt,
        processingStartedAt: FieldValue.delete(),
        processingLeaseExpiresAt: FieldValue.delete(),
      },
      updatePluralOrderClaim: params.updatePluralOrderClaim,
      updateSingularOrderClaim: params.updateSingularOrderClaim,
    }),
  };
}

async function startStripeReceiptClaim(params: {
  claimRef: DocumentReference;
  code: string;
  recipientWallet: string;
  attemptId: string;
  nowMs: number;
}): Promise<StripeReceiptClaimStart> {
  const leaseExpiresAt = Timestamp.fromMillis(params.nowMs + STRIPE_RECEIPT_CLAIM_PROCESSING_LEASE_MS);

  return db.runTransaction(async (tx) => {
    const claimSnap = await tx.get(params.claimRef);
    if (!claimSnap.exists) {
      throw new HttpsError('not-found', 'Invalid receipt claim code');
    }

    const claim = claimSnap.data() as any;
    if (claim?.namespace !== STRIPE_RECEIPT_CLAIM_CODE_NAMESPACE) {
      throw new HttpsError('not-found', 'Invalid receipt claim code');
    }
    if (typeof claim?.code === 'string' && normalizeStripeReceiptClaimCode(claim.code) !== params.code) {
      throw new HttpsError('failed-precondition', 'Claim code record is inconsistent');
    }

    const dropId = requireDropId(claim?.dropId);
    const deliveryId = requirePositiveDeliveryId(claim?.deliveryId);
    const boxId = requirePositiveBoxId(claim?.boxId);
    const directReceiptAssetId = directCardReceiptClaimAssetId(claim);
    const directFigureId = Math.floor(Number(claim?.figureId));
    const directFigureReceipt = directReceiptAssetId
      ? { receiptAssetId: directReceiptAssetId, figureId: directFigureId }
      : undefined;
    if (
      directFigureReceipt &&
      (!Number.isFinite(directFigureReceipt.figureId) ||
        directFigureReceipt.figureId <= 0 ||
        directFigureReceipt.figureId !== boxId)
    ) {
      throw new HttpsError('failed-precondition', 'Direct card receipt claim target is invalid');
    }
    const status = typeof claim?.status === 'string' ? claim.status : 'unclaimed';
    const claimedRecipient = typeof claim?.recipient === 'string' ? claim.recipient : '';
    const receiptTxSubmissions = normalizeDirectCardReceiptClaimSubmissions(claim?.receiptTxSubmissions);
    const storedReceiptTxs = normalizeReceiptTxs(claim?.receiptTxs);
    const receiptTxs = directFigureReceipt
      ? activeDirectCardReceiptClaimSignatures({
          receiptTxs: storedReceiptTxs,
          submissions: receiptTxSubmissions,
        })
      : storedReceiptTxs;
    const storedResult = normalizeStripeReceiptClaimStoredResult(claim);
    const hasPersistedDirectRecipientLock = Boolean(
      directFigureReceipt &&
        directCardReceiptClaimHasRecipientLock({
          hasRecipient: Boolean(claimedRecipient),
          receiptTxCount: receiptTxs.length,
        }),
    );
    // Direct sends persist their signed candidate before touching the network.
    // After the lease expires, no active candidate means a corrected recipient is safe.
    const hasClaimRecipientLock = directFigureReceipt
      ? hasPersistedDirectRecipientLock
      : status === 'processing';

    if (status === 'claimed') {
      if (claimedRecipient === params.recipientWallet) {
        return { status: 'already_claimed' as const, dropId, deliveryId, boxId, receiptTxs, ...storedResult };
      }
      throw new HttpsError('failed-precondition', 'This receipt claim code has already been used');
    }

    const processingLeaseExpiresAt = toMillisMaybe(claim?.processingLeaseExpiresAt) ?? 0;
    if (status === 'processing' && processingLeaseExpiresAt > params.nowMs) {
      throw new HttpsError('aborted', 'This receipt claim code is already being processed');
    }
    // Keep retries bound to the first receiver so maybe-submitted admin transactions can be finalized safely.
    // The persisted-transfer check also repairs claims that older recovery code may have reset to `unclaimed`.
    if (
      hasClaimRecipientLock &&
      claimedRecipient &&
      claimedRecipient !== params.recipientWallet
    ) {
      throw new HttpsError(
        'failed-precondition',
        'This receipt claim code is locked to the receiver address from the previous attempt. Retry with that same address.',
      );
    }

    const orderRef = db.doc(dropDeliveryOrderPath(dropId, deliveryId));
    const orderSnap = await tx.get(orderRef);
    if (!orderSnap.exists) {
      throw new HttpsError('not-found', 'Receipt claim order not found');
    }
    const order = orderSnap.data() as any;
    if (!isReceiptClaimDeliveryOrderSource(order?.source)) {
      throw new HttpsError('failed-precondition', 'Claim code is not for a receipt claim order');
    }
    if (directFigureReceipt) {
      const orderClaim = order?.stripeReceiptClaim;
      if (
        orderClaim?.receiptKind !== 'figure' ||
        orderClaim?.receiptAssetId !== directFigureReceipt.receiptAssetId ||
        Math.floor(Number(orderClaim?.figureId)) !== directFigureReceipt.figureId
      ) {
        throw new HttpsError('failed-precondition', 'Direct card receipt order target mismatch');
      }
    }
    const orderClaimTarget = resolveStripeReceiptClaimOrderTarget({ order, code: params.code, boxId });

    tx.set(
      params.claimRef,
      {
        status: 'processing',
        recipient: params.recipientWallet,
        processingAttemptId: params.attemptId,
        processingStartedAt: FieldValue.serverTimestamp(),
        processingLeaseExpiresAt: leaseExpiresAt,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
    tx.update(
      orderRef,
      stripeReceiptClaimProcessingOrderUpdate({
        dropId,
        code: params.code,
        boxId,
        recipientWallet: params.recipientWallet,
        leaseExpiresAt,
        ...orderClaimTarget,
      }),
    );

    return {
      status: 'started' as const,
      dropId,
      deliveryId,
      boxId,
      attemptId: params.attemptId,
      orderRef,
      orderIrlClaims: Array.isArray(order?.irlClaims) ? order.irlClaims : [],
      receiptTxs,
      receiptTxSubmissions,
      resumingPreviousProcessingClaim:
        hasClaimRecipientLock && claimedRecipient === params.recipientWallet,
      hasPreviousClaimFailure: Boolean(claim?.lastClaimError || claim?.lastClaimErrorAt),
      ...(directFigureReceipt ? { directFigureReceipt } : {}),
      ...orderClaimTarget,
    };
  });
}

async function clearStripeReceiptClaimProcessing(params: {
  claimRef: DocumentReference;
  orderRef: DocumentReference;
  code: string;
  boxId: number;
  recipientWallet: string;
  attemptId: string;
  err: unknown;
  updatePluralOrderClaim: boolean;
  updateSingularOrderClaim: boolean;
}): Promise<void> {
  await db
    .runTransaction(async (tx) => {
      const claimSnap = await tx.get(params.claimRef);
      const claim = claimSnap.exists ? (claimSnap.data() as any) : null;
      if (claim?.processingAttemptId !== params.attemptId || claim?.status !== 'processing') return;
      const lastError = summarizeError(params.err);
      tx.set(
        params.claimRef,
        {
          status: 'unclaimed',
          lastClaimError: lastError,
          lastClaimErrorAt: FieldValue.serverTimestamp(),
          processingAttemptId: FieldValue.delete(),
          processingStartedAt: FieldValue.delete(),
          processingLeaseExpiresAt: FieldValue.delete(),
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
      tx.update(
        params.orderRef,
        stripeReceiptClaimClearOrderUpdate({
          code: params.code,
          boxId: params.boxId,
          lastError,
          updatePluralOrderClaim: params.updatePluralOrderClaim,
          updateSingularOrderClaim: params.updateSingularOrderClaim,
        }),
      );
    })
    .catch((cleanupErr) => {
      logger.warn('claimStripeReceipt:cleanup_failed', {
        codeHash: hashForLog(params.code),
        recipient: params.recipientWallet,
        error: summarizeError(cleanupErr),
      });
    });
}

async function rememberStripeReceiptClaimSubmittedTx(params: {
  claimRef: DocumentReference;
  attemptId: string;
  receiptTx: string;
  submission?: Omit<DirectCardReceiptClaimSubmission, 'signature'> | null;
}): Promise<void> {
  await db.runTransaction(async (tx) => {
    const claimSnap = await tx.get(params.claimRef);
    if (!claimSnap.exists) throw new HttpsError('not-found', 'Receipt claim code not found');
    const claim = claimSnap.data() as any;
    if (claim?.status !== 'processing' || claim?.processingAttemptId !== params.attemptId) {
      throw new HttpsError('aborted', 'Receipt claim processing lease changed');
    }
    const isDirectCardReceiptClaim = Boolean(directCardReceiptClaimAssetId(claim));
    const submission = isDirectCardReceiptClaim && params.submission
      ? normalizeDirectCardReceiptClaimSubmissions([{ signature: params.receiptTx, ...params.submission }])[0]
      : undefined;
    const receiptTxSubmissions = isDirectCardReceiptClaim
      ? normalizeDirectCardReceiptClaimSubmissions(claim?.receiptTxSubmissions)
      : [];
    if (submission) {
      const existingIndex = receiptTxSubmissions.findIndex((entry) => entry.signature === submission.signature);
      if (existingIndex >= 0) receiptTxSubmissions[existingIndex] = submission;
      else receiptTxSubmissions.push(submission);
    }
    const mergedReceiptTxs = Array.from(new Set([...normalizeReceiptTxs(claim?.receiptTxs), params.receiptTx]));
    const receiptTxs = isDirectCardReceiptClaim && receiptTxSubmissions.length
      ? activeDirectCardReceiptClaimSignatures({
          receiptTxs: mergedReceiptTxs,
          submissions: receiptTxSubmissions,
        })
      : mergedReceiptTxs;
    tx.set(
      params.claimRef,
      {
        receiptTxs,
        ...(submission ? { receiptTxSubmissions } : {}),
        ...(submission
          ? {
              processingLeaseExpiresAt: Timestamp.fromMillis(
                Date.now() + DIRECT_CARD_RECEIPT_SUBMISSION_PROCESSING_LEASE_MS,
              ),
            }
          : {}),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
  });
}

async function finalizeStripeReceiptClaim(params: {
  claimRef: DocumentReference;
  orderRef: DocumentReference;
  code: string;
  dropId: string;
  deliveryId: number;
  boxId: number;
  recipientWallet: string;
  attemptId: string;
  receiptTx: string | null;
  receiptKind: StripeReceiptClaimReceiptKind;
  receiptsTransferred: number;
  figureIds?: number[];
  updatePluralOrderClaim: boolean;
  updateSingularOrderClaim: boolean;
}): Promise<string[]> {
  return db.runTransaction(async (tx) => {
    const claimSnap = await tx.get(params.claimRef);
    const claim = claimSnap.exists ? (claimSnap.data() as any) : null;
    if (!claim) throw new HttpsError('not-found', 'Receipt claim code not found');

    const storedReceiptTxs = normalizeReceiptTxs(claim?.receiptTxs);
    const isDirectCardReceiptClaim = Boolean(directCardReceiptClaimAssetId(claim));
    const receiptTxSubmissions = isDirectCardReceiptClaim
      ? normalizeDirectCardReceiptClaimSubmissions(claim?.receiptTxSubmissions)
      : [];
    const existingTxs = isDirectCardReceiptClaim && receiptTxSubmissions.length
      ? activeDirectCardReceiptClaimSignatures({
          receiptTxs: storedReceiptTxs,
          submissions: receiptTxSubmissions,
        })
      : storedReceiptTxs;
    if (claim?.status === 'claimed') {
      if (claim?.recipient !== params.recipientWallet) {
        throw new HttpsError('failed-precondition', 'This receipt claim code has already been used');
      }
      return existingTxs;
    }
    if (claim?.processingAttemptId !== params.attemptId) {
      throw new HttpsError('aborted', 'Receipt claim processing lease changed');
    }

    const receiptTxs = params.receiptTx ? [...new Set([...existingTxs, params.receiptTx])] : existingTxs;
    const claimedAt = FieldValue.serverTimestamp();
    tx.set(
      params.claimRef,
      {
        status: 'claimed',
        recipient: params.recipientWallet,
        receiptTxs,
        receiptKind: params.receiptKind,
        receiptsTransferred: params.receiptsTransferred,
        figureIds: params.figureIds?.length ? params.figureIds : FieldValue.delete(),
        claimedAt,
        processingAttemptId: FieldValue.delete(),
        processingStartedAt: FieldValue.delete(),
        processingLeaseExpiresAt: FieldValue.delete(),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
    tx.update(
      params.orderRef,
      stripeReceiptClaimFinalOrderUpdate({
        dropId: params.dropId,
        code: params.code,
        boxId: params.boxId,
        recipientWallet: params.recipientWallet,
        receiptTxs,
        claimedAt,
        receiptKind: params.receiptKind,
        receiptsTransferred: params.receiptsTransferred,
        figureIds: params.figureIds,
        updatePluralOrderClaim: params.updatePluralOrderClaim,
        updateSingularOrderClaim: params.updateSingularOrderClaim,
      }),
    );
    return receiptTxs;
  });
}

function stripeReceiptAssetMatches(asset: any, dropRuntime: DropRuntime, boxId: number, ownerWallet: string): boolean {
  if (looksBurntOrClosedInHelius(asset)) return false;
  if (asset?.ownership?.owner !== ownerWallet) return false;
  if (getAssetKind(asset) !== 'certificate') return false;
  if (!assetMatchesRequestedDrop(asset, dropRuntime)) return false;
  return String(getBoxIdFromAsset(asset) || '') === String(boxId);
}

async function findStripeReceiptAssetOwnedBy(ownerWallet: string, dropRuntime: DropRuntime, boxId: number): Promise<any | null> {
  if (clusterSharesCollectionMint(dropRuntime)) return null;

  const matches = (asset: any) => stripeReceiptAssetMatches(asset, dropRuntime, boxId, ownerWallet);
  if (dropRuntime.collectionMintStr) {
    const grouping = ['collection', dropRuntime.collectionMintStr] as const;
    const grouped = await findOwnedAssetByPredicate({
      owner: ownerWallet,
      dropRuntime,
      matches,
      grouping,
      label: 'Helius receipt assets error',
    });
    if (grouped.asset) return grouped.asset;
    if (grouped.sawItems) return null;

    logger.warn('Helius searchAssets returned 0 items for receipt collection grouping; falling back to ungrouped search', {
      owner: ownerWallet,
      collection: dropRuntime.collectionMintStr,
      dropId: dropRuntime.dropId,
    });
  }

  const ungrouped = await findOwnedAssetByPredicate({
    owner: ownerWallet,
    dropRuntime,
    matches,
    label: 'Helius receipt assets error',
  });
  return ungrouped.asset;
}

async function findStripeReceiptAssetByIdOwnedBy(
  ownerWallet: string,
  dropRuntime: DropRuntime,
  boxId: number,
  assetId: string,
): Promise<any | null> {
  let asset: any;
  try {
    asset = await fetchAsset(assetId, dropRuntime);
  } catch (err) {
    if ((err as any)?.code === 'not-found') return null;
    throw err;
  }
  if (!asset || looksBurntOrClosedInHelius(asset)) return null;
  if (asset?.ownership?.owner !== ownerWallet) return null;
  if (getAssetKind(asset) !== 'certificate') {
    throw new HttpsError('failed-precondition', 'Receipt claim is not ready yet; assigned pack receipt is not a receipt');
  }
  if (clusterSharesCollectionMint(dropRuntime)) {
    if (!assetGroupingAllowsTreeVerifiedDropMatch(asset, dropRuntime)) {
      throw new HttpsError('failed-precondition', 'Receipt claim is not ready yet; assigned pack receipt belongs to a different drop');
    }
  } else if (!assetMatchesDropCollection(asset, dropRuntime, ['certificate'])) {
    throw new HttpsError('failed-precondition', 'Receipt claim is not ready yet; assigned pack receipt belongs to a different drop');
  }
  if (String(getBoxIdFromAsset(asset) || '') !== String(boxId)) {
    throw new HttpsError('failed-precondition', 'Receipt claim is not ready yet; assigned pack receipt does not match claim box', {
      dropId: dropRuntime.dropId,
      boxId,
      assignedBoxAssetId: assetId,
    });
  }
  return asset;
}

async function findDirectFigureReceiptAssetByIdOwnedBy(
  ownerWallet: string,
  dropRuntime: DropRuntime,
  figureId: number,
  assetId: string,
): Promise<any | null> {
  let asset: any;
  try {
    asset = await fetchAsset(assetId, dropRuntime);
  } catch (err) {
    if ((err as any)?.code === 'not-found') return null;
    throw err;
  }
  if (!asset || looksBurntOrClosedInHelius(asset)) return null;
  if (asset?.ownership?.owner !== ownerWallet) return null;
  if (getAssetKind(asset) !== 'certificate') {
    throw new HttpsError('failed-precondition', 'Direct card receipt claim target is not a receipt');
  }
  if (!assetMatchesRequestedDrop(asset, dropRuntime)) {
    throw new HttpsError('failed-precondition', 'Direct card receipt claim target belongs to a different drop');
  }
  if (Number(getDudeIdFromAsset(asset)) !== figureId) {
    throw new HttpsError('failed-precondition', 'Direct card receipt claim figure id mismatch');
  }
  const proof = await fetchAssetProof(assetId, dropRuntime);
  parseCompressedReceiptProof({ asset, proof, dropRuntime, expectedOwner: ownerWallet });
  return asset;
}

async function sendDirectFigureReceiptClaimTx(params: {
  conn: Connection;
  dropRuntime: DropRuntime;
  signer: Keypair;
  recipientPk: PublicKey;
  coreCollection: PublicKey;
  adminReceipt: any;
  persistSubmission: (submission: DirectCardReceiptClaimSubmission) => Promise<void>;
}): Promise<DirectCardReceiptClaimSubmission> {
  const receiptId = String(params.adminReceipt?.id || '');
  if (!receiptId) throw new HttpsError('failed-precondition', 'Direct card receipt is missing an asset id');
  const proof = await fetchAssetProof(receiptId, params.dropRuntime);
  const proofContext = parseCompressedReceiptProof({
    asset: params.adminReceipt,
    proof,
    dropRuntime: params.dropRuntime,
    expectedOwner: params.signer.publicKey.toBase58(),
  });
  const transferIx = buildCompressedReceiptTransferIx({
    proofContext,
    owner: params.signer.publicKey,
    newOwner: params.recipientPk,
    coreCollection: params.coreCollection,
  });
  const { blockhash, lastValidBlockHeight } = await withTimeout(
    params.conn.getLatestBlockhash('confirmed'),
    RPC_TIMEOUT_MS,
    'getLatestBlockhash:claimStripeReceipt:directFigure',
  );
  const { tx } = await buildTxWithOptionalDeliveryLookupTable({
    conn: params.conn,
    dropRuntime: params.dropRuntime,
    build: (luts) =>
      buildTx(
        [ComputeBudgetProgram.setComputeUnitLimit({ units: 700_000 }), transferIx],
        params.signer.publicKey,
        blockhash,
        [params.signer],
        luts,
      ),
    encodeTooLargeMessage: 'Direct card receipt claim transaction is too large to encode.',
    encodeTooLargeDetails: { dropId: params.dropRuntime.dropId, receiptAssetId: receiptId },
    packetTooLargeMessage: (rawBytes, maxRawBytes) =>
      `Direct card receipt claim transaction too large (${rawBytes} bytes > ${maxRawBytes}).`,
    packetTooLargeDetails: { dropId: params.dropRuntime.dropId, receiptAssetId: receiptId },
  });
  const submittedAtMs = Date.now();
  const submission: DirectCardReceiptClaimSubmission = {
    signature: bs58.encode(tx.signatures[0]),
    lastValidBlockHeight,
    submittedAtMs,
    status: 'submitted',
  };
  // Persist the exact signed candidate and extend the lease before any network
  // submission so a timeout or concurrent recovery can never lose the evidence.
  await params.persistSubmission(submission);
  try {
    const signature = await sendAndConfirmSignedTx(params.conn, tx, 'claimStripeReceipt:directFigure', {
      sendTimeoutMs: TX_SEND_TIMEOUT_MS,
      confirmTimeoutMs: TX_CONFIRM_TIMEOUT_MS,
    });
    return { ...submission, signature };
  } catch (err) {
    const ambiguousSignature = stripeReceiptClaimMaybeSubmittedTx(err);
    if (!ambiguousSignature) {
      try {
        await params.persistSubmission({ ...submission, status: 'not_landed' });
      } catch (persistErr) {
        logger.warn('claimStripeReceipt:direct_submission_failure_persist_failed', {
          dropId: params.dropRuntime.dropId,
          receiptTx: submission.signature,
          error: summarizeError(persistErr),
        });
        const details = (err as any)?.details || {};
        (err as any).details = { ...details, lastValidBlockHeight, submittedAtMs };
        throw err;
      }
      const details = (err as any)?.details || {};
      (err as any).details = { ...details, directCardReceiptSubmissionStatus: 'not_landed' };
      throw err;
    }
    const resolution = await resolveAmbiguousDirectCardReceiptSubmission({
      conn: params.conn,
      signature: ambiguousSignature,
      lastValidBlockHeight,
      submittedAtMs,
    });
    if (resolution === 'landed') {
      return { ...submission, signature: ambiguousSignature };
    }
    if (resolution === 'not_landed') {
      const notLandedSubmission = { ...submission, signature: ambiguousSignature, status: 'not_landed' as const };
      try {
        await params.persistSubmission(notLandedSubmission);
      } catch (persistErr) {
        logger.warn('claimStripeReceipt:direct_submission_verdict_persist_failed', {
          dropId: params.dropRuntime.dropId,
          receiptTx: ambiguousSignature,
          error: summarizeError(persistErr),
        });
        const details = (err as any)?.details || {};
        (err as any).details = { ...details, lastValidBlockHeight, submittedAtMs };
        throw err;
      }
      throw new HttpsError('failed-precondition', 'Direct card receipt claim transaction expired before landing; retry', {
        signature: ambiguousSignature,
        directCardReceiptSubmissionStatus: 'not_landed',
      });
    }
    const details = (err as any)?.details;
    if (details && typeof details.signature === 'string') {
      (err as any).details = { ...details, lastValidBlockHeight, submittedAtMs };
    }
    throw err;
  }
}

function requireStripeOpenableClaimAssignment(order: any, dropRuntime: DropRuntime, boxId: number): StripeAssignedIrlClaim {
  let assignment: StripeAssignedIrlClaim | null = null;
  try {
    assignment = stripeAssignedIrlClaimForBox(order, boxId, {
      itemsPerBox: dropRuntime.itemsPerBox,
      maxDudeId: dropRuntime.maxDudeId,
    });
  } catch (err) {
    throw new HttpsError(
      'failed-precondition',
      err instanceof Error
        ? err.message.replace(/^Stripe (?:receipt|IRL) claim/, 'Receipt claim')
        : 'Receipt claim is not ready yet; assigned receipts are invalid',
      { dropId: dropRuntime.dropId, boxId },
    );
  }
  if (!assignment) {
    throw new HttpsError(
      'failed-precondition',
      'Receipt claim is not ready yet; assigned card receipts are missing',
      { dropId: dropRuntime.dropId, boxId },
    );
  }
  return assignment;
}

function stripeFigureReceiptDudeIdCandidateOwnedBy(asset: any, ownerWallet: string): number | null {
  if (looksBurntOrClosedInHelius(asset)) return null;
  if (asset?.ownership?.owner !== ownerWallet) return null;
  if (getAssetKind(asset) !== 'certificate') return null;
  const dudeId = Number(getDudeIdFromAsset(asset));
  return Number.isFinite(dudeId) ? dudeId : null;
}

function stripeFigureReceiptDudeIdOwnedBy(asset: any, dropRuntime: DropRuntime, ownerWallet: string): number | null {
  const dudeId = stripeFigureReceiptDudeIdCandidateOwnedBy(asset, ownerWallet);
  if (dudeId == null) return null;
  if (!assetMatchesRequestedDrop(asset, dropRuntime)) return null;
  return dudeId;
}

function assetGroupingAllowsTreeVerifiedDropMatch(asset: any, dropRuntime: DropRuntime): boolean {
  // In shared-collection recovery, the receipt tree is the drop discriminator.
  // Treat missing or multi-valued grouping as inconclusive, but skip assets that
  // explicitly group only to another collection.
  return assetGroupingAllowsTreeVerifiedCollectionMatch(asset, dropRuntime.collectionMintStr);
}

const STRIPE_FIGURE_RECEIPT_TREE_PROOF_CONCURRENCY = 4;

type StripeFigureReceiptTreeCandidate = {
  asset: any;
  dudeId: number;
};

async function receiptAssetProofMatchesDropTree(asset: any, dropRuntime: DropRuntime): Promise<boolean> {
  const assetId = String(asset?.id || '');
  if (!assetId || !dropRuntime.receiptsMerkleTreeStr) return false;

  let proof: any;
  try {
    proof = await fetchAssetProof(assetId, dropRuntime);
  } catch (err) {
    if ((err as any)?.code !== 'not-found') throw err;
    return false;
  }

  return assetProofMatchesTree(proof, dropRuntime.receiptsMerkleTree);
}

async function findOwnedStripeFigureReceiptDudeIdsByTree(
  ownerWallet: string,
  dropRuntime: DropRuntime,
  dudeIds: number[],
): Promise<Set<number>> {
  const expected = new Set(dudeIds.map((dudeId) => Number(dudeId)));
  const found = new Set<number>();
  const checkedAssetIds = new Set<string>();

  const collectCandidates = (items: any[]): StripeFigureReceiptTreeCandidate[] => {
    const candidates: StripeFigureReceiptTreeCandidate[] = [];
    for (const asset of items) {
      const dudeId = stripeFigureReceiptDudeIdCandidateOwnedBy(asset, ownerWallet);
      if (dudeId == null || !expected.has(dudeId) || found.has(dudeId)) continue;
      if (!assetGroupingAllowsTreeVerifiedDropMatch(asset, dropRuntime)) continue;

      const assetId = String(asset?.id || '');
      if (!assetId || checkedAssetIds.has(assetId)) continue;
      checkedAssetIds.add(assetId);
      candidates.push({ asset, dudeId });
    }
    return candidates;
  };

  const visitPage = async (items: any[]) => {
    const candidates = collectCandidates(items);
    for (
      let index = 0;
      index < candidates.length && found.size < expected.size;
      index += STRIPE_FIGURE_RECEIPT_TREE_PROOF_CONCURRENCY
    ) {
      const batch = candidates.slice(index, index + STRIPE_FIGURE_RECEIPT_TREE_PROOF_CONCURRENCY);
      const proofResults = await Promise.all(
        batch.map(async (candidate) => {
          try {
            return {
              candidate,
              matchesDropTree: await receiptAssetProofMatchesDropTree(candidate.asset, dropRuntime),
            };
          } catch (err) {
            return { candidate, err };
          }
        }),
      );
      for (const result of proofResults) {
        if (found.size >= expected.size) break;
        if (found.has(result.candidate.dudeId)) continue;
        if ('err' in result) throw result.err;
        if (result.matchesDropTree && expected.has(result.candidate.dudeId)) found.add(result.candidate.dudeId);
      }
    }
    return found.size === expected.size;
  };

  if (dropRuntime.collectionMintStr) {
    const grouping = ['collection', dropRuntime.collectionMintStr] as const;
    const grouped = await scanOwnedAssetPages({
      owner: ownerWallet,
      dropRuntime,
      visitPage,
      grouping,
      label: 'Helius figure receipt assets error',
    });
    if (grouped.stopped) return found;
    logger.warn(
      grouped.sawItems
        ? 'Helius collection-grouped search did not find every expected Stripe figure receipt; falling back to ungrouped tree-verified search'
        : 'Helius searchAssets returned 0 items for figure receipt collection grouping; falling back to ungrouped tree-verified search',
      {
        owner: ownerWallet,
        dropId: dropRuntime.dropId,
        collection: dropRuntime.collectionMintStr,
        expectedDudeIds: Array.from(expected),
        foundDudeIds: Array.from(found),
      },
    );
  }

  await scanOwnedAssetPages({
    owner: ownerWallet,
    dropRuntime,
    visitPage,
    label: 'Helius figure receipt assets error',
  });
  return found;
}

async function findOwnedStripeFigureReceiptDudeIds(
  ownerWallet: string,
  dropRuntime: DropRuntime,
  dudeIds: number[],
): Promise<Set<number>> {
  if (clusterSharesCollectionMint(dropRuntime)) {
    return findOwnedStripeFigureReceiptDudeIdsByTree(ownerWallet, dropRuntime, dudeIds);
  }

  const expected = new Set(dudeIds.map((dudeId) => Number(dudeId)));
  const found = new Set<number>();

  const visit = (asset: any) => {
    const dudeId = stripeFigureReceiptDudeIdOwnedBy(asset, dropRuntime, ownerWallet);
    if (dudeId != null && expected.has(dudeId)) found.add(dudeId);
    return found.size === expected.size;
  };

  if (dropRuntime.collectionMintStr) {
    const grouping = ['collection', dropRuntime.collectionMintStr] as const;
    const grouped = await scanOwnedAssets({
      owner: ownerWallet,
      dropRuntime,
      visit,
      grouping,
      label: 'Helius figure receipt assets error',
    });
    if (grouped.stopped) return found;
    if (grouped.sawItems) {
      if (found.size >= expected.size) return found;
      logger.warn('Helius collection-grouped search did not find every expected Stripe figure receipt; falling back to ungrouped search', {
        owner: ownerWallet,
        dropId: dropRuntime.dropId,
        collection: dropRuntime.collectionMintStr,
        expectedDudeIds: Array.from(expected),
        foundDudeIds: Array.from(found),
      });
    } else {
      logger.warn('Helius searchAssets returned 0 items for figure receipt collection grouping; falling back to ungrouped search', {
        owner: ownerWallet,
        dropId: dropRuntime.dropId,
        collection: dropRuntime.collectionMintStr,
      });
    }
  }

  await scanOwnedAssets({
    owner: ownerWallet,
    dropRuntime,
    visit,
    label: 'Helius figure receipt assets error',
  });
  return found;
}

async function ownsAllStripeFigureReceipts(ownerWallet: string, dropRuntime: DropRuntime, dudeIds: number[]): Promise<boolean> {
  const ownedDudeIds = await findOwnedStripeFigureReceiptDudeIds(ownerWallet, dropRuntime, dudeIds);
  return dudeIds.every((dudeId) => ownedDudeIds.has(Number(dudeId)));
}

function buildMintReceiptsIx(args: {
  dropRuntime: DropRuntime;
  cosignerPk: PublicKey;
  recipientPk: PublicKey;
  coreCollection: PublicKey;
  boxIds: number[];
  dudeIds: number[];
}): TransactionInstruction {
  const treeConfig = deriveTreeConfigPda(args.dropRuntime.receiptsMerkleTree);
  return new TransactionInstruction({
    programId: args.dropRuntime.boxMinterProgramId,
    keys: [
      { pubkey: args.dropRuntime.boxMinterConfigPda, isSigner: false, isWritable: false }, // config
      { pubkey: args.cosignerPk, isSigner: true, isWritable: true }, // cosigner
      { pubkey: args.recipientPk, isSigner: false, isWritable: false }, // user
      { pubkey: args.dropRuntime.receiptsMerkleTree, isSigner: false, isWritable: true }, // merkle_tree
      { pubkey: treeConfig, isSigner: false, isWritable: true }, // tree_config
      { pubkey: args.coreCollection, isSigner: false, isWritable: true }, // core_collection
      { pubkey: BUBBLEGUM_PROGRAM_ID, isSigner: false, isWritable: false }, // bubblegum_program
      { pubkey: MPL_NOOP_PROGRAM_ID, isSigner: false, isWritable: false }, // log_wrapper
      { pubkey: MPL_ACCOUNT_COMPRESSION_PROGRAM_ID, isSigner: false, isWritable: false }, // compression_program
      { pubkey: MPL_CORE_PROGRAM_ID, isSigner: false, isWritable: false }, // mpl_core_program
      { pubkey: MPL_CORE_CPI_SIGNER, isSigner: false, isWritable: false }, // mpl_core_cpi_signer
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, // system_program
    ],
    data: encodeMintReceiptsArgs({ boxIds: args.boxIds, dudeIds: args.dudeIds }, args.dropRuntime),
  });
}

function parseCompressedReceiptProof(params: {
  asset: any;
  proof: any;
  dropRuntime: DropRuntime;
  expectedOwner: string;
  proofMissingMessage?: string;
  treeMismatchMessage?: string;
  treeMismatchActualKey?: string;
  treeMismatchExpectedKey?: string;
  leafIdMessage?: string;
  leafIndexMessage?: string;
}) {
  const compression = params.asset?.compression || {};
  const proofPath: string[] = Array.isArray(params.proof?.proof) ? params.proof.proof : [];
  const merkleTree = assetProofTreePublicKey(params.proof);
  const rootStr = String(params.proof?.root || '');
  if (!merkleTree || !rootStr) {
    throw new HttpsError('failed-precondition', params.proofMissingMessage || 'Unable to fetch receipt proof for transfer');
  }
  if (!merkleTree.equals(params.dropRuntime.receiptsMerkleTree)) {
    throw new HttpsError('failed-precondition', params.treeMismatchMessage || 'Receipt does not belong to the configured receipts tree', {
      [params.treeMismatchActualKey || 'receiptTree']: merkleTree.toBase58(),
      [params.treeMismatchExpectedKey || 'receiptsTree']: params.dropRuntime.receiptsMerkleTree.toBase58(),
      dropId: params.dropRuntime.dropId,
    });
  }

  const nonce = Number(compression?.leaf_id ?? compression?.leafId);
  if (!Number.isFinite(nonce) || nonce < 0) {
    throw new HttpsError('failed-precondition', params.leafIdMessage || 'Unable to parse receipt leaf id');
  }
  const index = Math.floor(nonce);
  if (!Number.isFinite(index) || index < 0 || index > 0xffff_ffff) {
    throw new HttpsError('failed-precondition', params.leafIndexMessage || 'Receipt leaf index out of range');
  }

  return {
    merkleTree,
    root: bs58Bytes32(rootStr, 'assetProof.root'),
    dataHash: bs58Bytes32(String(compression?.data_hash || compression?.dataHash || ''), 'asset.compression.data_hash'),
    creatorHash: bs58Bytes32(String(compression?.creator_hash || compression?.creatorHash || ''), 'asset.compression.creator_hash'),
    assetDataHash:
      compression?.asset_data_hash || compression?.assetDataHash
        ? bs58Bytes32(String(compression?.asset_data_hash || compression?.assetDataHash), 'asset.compression.asset_data_hash')
        : null,
    flags: compression?.flags == null ? null : Number(compression.flags),
    nonce,
    index,
    proofAccounts: proofPath.map((p) => new PublicKey(p)),
    leafOwner: new PublicKey(String(params.asset?.ownership?.owner || params.expectedOwner)),
    leafDelegate: new PublicKey(String(params.asset?.ownership?.delegate || params.asset?.ownership?.owner || params.expectedOwner)),
  };
}

function buildCompressedReceiptTransferIx(args: {
  proofContext: ReturnType<typeof parseCompressedReceiptProof>;
  owner: PublicKey;
  newOwner: PublicKey;
  coreCollection: PublicKey;
}): TransactionInstruction {
  const { proofContext } = args;
  return bubblegumTransferV2Ix({
    bubblegumProgramId: BUBBLEGUM_PROGRAM_ID,
    mplNoopProgramId: MPL_NOOP_PROGRAM_ID,
    mplAccountCompressionProgramId: MPL_ACCOUNT_COMPRESSION_PROGRAM_ID,
    treeConfig: deriveTreeConfigPda(proofContext.merkleTree),
    payer: args.owner,
    authority: args.owner,
    leafOwner: proofContext.leafOwner,
    leafDelegate: proofContext.leafDelegate,
    newLeafOwner: args.newOwner,
    merkleTree: proofContext.merkleTree,
    coreCollection: args.coreCollection,
    root: proofContext.root,
    dataHash: proofContext.dataHash,
    creatorHash: proofContext.creatorHash,
    assetDataHash: proofContext.assetDataHash,
    flags: proofContext.flags,
    nonce: proofContext.nonce,
    index: proofContext.index,
    proof: proofContext.proofAccounts,
  });
}

async function sendOpenableStripeReceiptClaimTx(params: {
  conn: Connection;
  dropRuntime: DropRuntime;
  signer: Keypair;
  recipientPk: PublicKey;
  coreCollection: PublicKey;
  adminReceipt: any;
  dudeIds: number[];
}): Promise<string> {
  const receiptId = String(params.adminReceipt?.id || '');
  if (!receiptId) throw new HttpsError('failed-precondition', 'Matching pack receipt is missing an asset id');
  const proof = await fetchAssetProof(receiptId, params.dropRuntime);
  const proofContext = parseCompressedReceiptProof({
    asset: params.adminReceipt,
    proof,
    dropRuntime: params.dropRuntime,
    expectedOwner: params.signer.publicKey.toBase58(),
  });
  const burnIx = bubblegumBurnV2Ix({
    payer: params.signer.publicKey,
    authority: params.signer.publicKey,
    leafOwner: proofContext.leafOwner,
    leafDelegate: proofContext.leafDelegate,
    merkleTree: proofContext.merkleTree,
    coreCollection: params.coreCollection,
    root: proofContext.root,
    dataHash: proofContext.dataHash,
    creatorHash: proofContext.creatorHash,
    assetDataHash: proofContext.assetDataHash,
    flags: proofContext.flags,
    nonce: proofContext.nonce,
    index: proofContext.index,
    proof: proofContext.proofAccounts,
  });
  const mintIx = buildMintReceiptsIx({
    dropRuntime: params.dropRuntime,
    cosignerPk: params.signer.publicKey,
    recipientPk: params.recipientPk,
    coreCollection: params.coreCollection,
    boxIds: [],
    dudeIds: params.dudeIds,
  });
  const instructions = [ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }), burnIx, mintIx];

  const { blockhash } = await withTimeout(
    params.conn.getLatestBlockhash('confirmed'),
    RPC_TIMEOUT_MS,
    'getLatestBlockhash:claimStripeReceipt:openable',
  );
  const buildClaimTx = (luts: AddressLookupTableAccount[]) => buildTx(instructions, params.signer.publicKey, blockhash, [params.signer], luts);
  const { tx } = await buildTxWithOptionalDeliveryLookupTable({
    conn: params.conn,
    dropRuntime: params.dropRuntime,
    build: buildClaimTx,
    encodeTooLargeMessage:
      'Receipt claim transaction is too large to encode. Re-run deploy-all to update functions/src/config/deployment.ts (deliveryLookupTable), then retry.',
    encodeTooLargeDetails: {
      receiptsMerkleTree: params.dropRuntime.receiptsMerkleTreeStr,
      dropId: params.dropRuntime.dropId,
    },
    packetTooLargeMessage: (rawBytes, maxRawBytes) =>
      `Receipt claim transaction too large (${rawBytes} bytes > ${maxRawBytes}).`,
    packetTooLargeDetails: {
      deliveryLookupTable: params.dropRuntime.deliveryLookupTableStr,
      receiptsMerkleTree: params.dropRuntime.receiptsMerkleTreeStr,
      dropId: params.dropRuntime.dropId,
    },
  });

  return sendAndConfirmSignedTx(params.conn, tx, 'claimStripeReceipt:openable', {
    sendTimeoutMs: TX_SEND_TIMEOUT_MS,
    confirmTimeoutMs: TX_CONFIRM_TIMEOUT_MS,
  });
}

export const claimStripeReceipt = onCallLogged(
  'claimStripeReceipt',
  async (request) => {
    const schema = z.object({
      recipient: z.string(),
      code: z.string(),
    });
    const { recipient, code: rawCode } = parseRequest(schema, request.data);
    const recipientWallet = normalizeWallet(recipient);
    const recipientPk = new PublicKey(recipientWallet);
    const code = requireStripeReceiptClaimCodeForRequest(rawCode);
    const claimRef = db.doc(`claimCodes/${code}`);
    const nowMs = Date.now();
    const attemptId = stripeReceiptClaimAttemptId(nowMs);

    let startedClaim: Extract<StripeReceiptClaimStart, { status: 'started' }> | null = null;
    let sentReceiptTx: string | null = null;
    let sentReceiptTxSubmission: Omit<DirectCardReceiptClaimSubmission, 'signature'> | null = null;
    let keepDirectRecipientLockOnError = false;
    try {
      const started = await startStripeReceiptClaim({
        claimRef,
        code,
        recipientWallet,
        attemptId,
        nowMs,
      });
      if (started.status === 'already_claimed') {
        if (started.receiptKind) {
          return stripeReceiptClaimResponse({
            dropId: started.dropId,
            deliveryId: started.deliveryId,
            receiptTxs: started.receiptTxs,
            receiptKind: started.receiptKind,
            receiptsTransferred: started.receiptsTransferred,
            figureIds: started.figureIds,
            receiptAssetIds: started.receiptAssetIds,
          });
        }
        let dropRuntime: DropRuntime | null = null;
        try {
          dropRuntime = getDropRuntime(started.dropId);
        } catch (err) {
          logger.warn('claimStripeReceipt:already_claimed_drop_runtime_lookup_failed', {
            dropId: started.dropId,
            deliveryId: started.deliveryId,
            boxId: started.boxId,
            error: summarizeError(err),
          });
        }
        if (dropRuntime && isOpenableDrop(dropRuntime)) {
          try {
            const orderSnap = await db.doc(dropDeliveryOrderPath(started.dropId, started.deliveryId)).get();
            const assignment = orderSnap.exists
              ? stripeAssignedIrlClaimForBox(orderSnap.data(), started.boxId, {
                  itemsPerBox: dropRuntime.itemsPerBox,
                  maxDudeId: dropRuntime.maxDudeId,
                })
              : null;
            if (assignment && (await ownsAllStripeFigureReceipts(recipientWallet, dropRuntime, assignment.dudeIds))) {
              return stripeReceiptClaimResponse({
                dropId: started.dropId,
                deliveryId: started.deliveryId,
                receiptTxs: started.receiptTxs,
                receiptKind: 'figure',
                receiptsTransferred: assignment.dudeIds.length,
                figureIds: assignment.dudeIds,
              });
            }
          } catch (err) {
            logger.warn('claimStripeReceipt:already_claimed_assignment_lookup_failed', {
              dropId: started.dropId,
              deliveryId: started.deliveryId,
              boxId: started.boxId,
              error: summarizeError(err),
            });
          }
        }
        return stripeReceiptClaimResponse({
          dropId: started.dropId,
          deliveryId: started.deliveryId,
          receiptTxs: started.receiptTxs,
          ...(dropRuntime ? { receiptKind: 'box' as const } : {}),
        });
      }
      startedClaim = started;
      keepDirectRecipientLockOnError = Boolean(
        started.directFigureReceipt &&
          shouldKeepDirectCardReceiptClaimProcessing({
            resumingPreviousProcessingClaim: started.resumingPreviousProcessingClaim,
            recipientOwnershipConfirmed: false,
          }),
      );

      const dropRuntime = getDropRuntime(started.dropId);
      const openableAssignment = !started.directFigureReceipt && isOpenableDrop(dropRuntime)
        ? requireStripeOpenableClaimAssignment({ irlClaims: started.orderIrlClaims }, dropRuntime, started.boxId)
        : null;
      const cfg = await ensureOnchainCoreConfig(dropRuntime, true);
      if (!dropRuntime.receiptsMerkleTreeStr) {
        throw new HttpsError(
          'failed-precondition',
          'Receipt cNFT tree is not configured (set `receiptsMerkleTree` in functions/src/config/deployment.ts)',
          { dropId: started.dropId },
        );
      }

      const conn = connection(dropRuntime);
      const signer = cosigner();
      if (!signer.publicKey.equals(cfg.admin)) {
        throw new HttpsError('failed-precondition', 'COSIGNER_SECRET does not match on-chain admin', {
          expectedAdmin: cfg.admin.toBase58(),
          cosigner: signer.publicKey.toBase58(),
        });
      }
      assertConfiguredPublicKey(dropRuntime.collectionMint, 'COLLECTION_MINT');
      if (!dropRuntime.collectionMint.equals(cfg.coreCollection)) {
        throw new HttpsError('failed-precondition', 'COLLECTION_MINT does not match on-chain config (functions/src/config/deployment.ts)', {
          configured: dropRuntime.collectionMint.toBase58(),
          onchain: cfg.coreCollection.toBase58(),
          dropId: started.dropId,
        });
      }

      const adminWallet = signer.publicKey.toBase58();
      if (started.directFigureReceipt) {
        const target = started.directFigureReceipt;
        const finalizeDirectFigureClaim = async (receiptTx: string | null) => {
          const receiptTxs = await finalizeStripeReceiptClaim({
            claimRef,
            orderRef: started.orderRef,
            code,
            dropId: started.dropId,
            deliveryId: started.deliveryId,
            boxId: started.boxId,
            recipientWallet,
            attemptId,
            receiptTx,
            receiptKind: 'figure',
            receiptsTransferred: 1,
            figureIds: [target.figureId],
            updatePluralOrderClaim: started.updatePluralOrderClaim,
            updateSingularOrderClaim: started.updateSingularOrderClaim,
          });
          return stripeReceiptClaimResponse({
            dropId: started.dropId,
            deliveryId: started.deliveryId,
            receiptTxs,
            receiptKind: 'figure',
            receiptsTransferred: 1,
            figureIds: [target.figureId],
            receiptAssetIds: [target.receiptAssetId],
          });
        };
        const persistedTransfer = await inspectPersistedDirectCardReceiptClaimTransfers({
          conn,
          dropRuntime,
          signatures: started.receiptTxs,
          submissions: started.receiptTxSubmissions,
          adminWallet,
          recipientWallet,
          coreCollection: cfg.coreCollection,
          receiptAssetId: target.receiptAssetId,
        });
        for (const terminalSubmission of persistedTransfer.terminalSubmissions) {
          const { signature, ...submission } = terminalSubmission;
          await rememberStripeReceiptClaimSubmittedTx({
            claimRef,
            attemptId,
            receiptTx: signature,
            submission,
          });
        }
        const recipientReceipt = persistedTransfer.evidence === 'verified'
          ? null
          : await findDirectFigureReceiptAssetByIdOwnedBy(
              recipientWallet,
              dropRuntime,
              target.figureId,
              target.receiptAssetId,
            );
        const adminReceipt =
          persistedTransfer.evidence === 'verified' || persistedTransfer.evidence === 'unresolved' || recipientReceipt
          ? null
          : await findDirectFigureReceiptAssetByIdOwnedBy(
              adminWallet,
              dropRuntime,
              target.figureId,
              target.receiptAssetId,
            );
        const recoveryAction = resolveDirectCardReceiptClaimRecoveryAction({
          transferEvidence: persistedTransfer.evidence,
          recipientOwnsReceipt: Boolean(recipientReceipt),
          adminOwnsReceipt: Boolean(adminReceipt),
        });
        if (recoveryAction === 'finalize') {
          keepDirectRecipientLockOnError = shouldKeepDirectCardReceiptClaimProcessing({
            resumingPreviousProcessingClaim: started.resumingPreviousProcessingClaim,
            recipientOwnershipConfirmed: true,
          });
          return finalizeDirectFigureClaim(persistedTransfer.signature);
        }
        if (recoveryAction === 'wait' || !adminReceipt) {
          if (keepDirectRecipientLockOnError) {
            throw new HttpsError(
              'unavailable',
              'Card receipt ownership is still resolving for the original receiver; retry shortly',
              { keepReceiptClaimProcessing: true },
            );
          }
          throw new HttpsError('failed-precondition', 'Matching admin-owned card receipt not found');
        }
        const receiptSubmission = await sendDirectFigureReceiptClaimTx({
          conn,
          dropRuntime,
          signer,
          recipientPk,
          coreCollection: cfg.coreCollection,
          adminReceipt,
          persistSubmission: async (candidate) => {
            const { signature, ...submission } = candidate;
            await rememberStripeReceiptClaimSubmittedTx({
              claimRef,
              attemptId,
              receiptTx: signature,
              submission,
            });
            sentReceiptTx = signature;
            sentReceiptTxSubmission = submission;
          },
        });
        const receiptTx = receiptSubmission.signature;
        return finalizeDirectFigureClaim(receiptTx);
      }

      const adminReceipt = openableAssignment
        ? await findStripeReceiptAssetByIdOwnedBy(adminWallet, dropRuntime, started.boxId, openableAssignment.boxAssetId)
        : await findStripeReceiptAssetOwnedBy(adminWallet, dropRuntime, started.boxId);
      if (openableAssignment) {
        const assignment = openableAssignment;
        const finalizeOpenableFigureClaim = async (receiptTx: string | null) => {
          const receiptTxs = await finalizeStripeReceiptClaim({
            claimRef,
            orderRef: started.orderRef,
            code,
            dropId: started.dropId,
            deliveryId: started.deliveryId,
            boxId: started.boxId,
            recipientWallet,
            attemptId,
            receiptTx,
            receiptKind: 'figure',
            receiptsTransferred: assignment.dudeIds.length,
            figureIds: assignment.dudeIds,
            updatePluralOrderClaim: started.updatePluralOrderClaim,
            updateSingularOrderClaim: started.updateSingularOrderClaim,
          });
          return stripeReceiptClaimResponse({
            dropId: started.dropId,
            deliveryId: started.deliveryId,
            receiptTxs,
            receiptKind: 'figure',
            receiptsTransferred: assignment.dudeIds.length,
            figureIds: assignment.dudeIds,
          });
        };
        let ownsAssignedFigures: boolean | null = null;
        const receiverOwnsAssignedFigures = async () => {
          if (ownsAssignedFigures == null) {
            ownsAssignedFigures = await ownsAllStripeFigureReceipts(recipientWallet, dropRuntime, assignment.dudeIds);
          }
          return ownsAssignedFigures;
        };

        if (
          (started.resumingPreviousProcessingClaim || started.hasPreviousClaimFailure) &&
          (await receiverOwnsAssignedFigures())
        ) {
          return finalizeOpenableFigureClaim(null);
        }

        if (!adminReceipt) {
          if (await receiverOwnsAssignedFigures()) {
            return finalizeOpenableFigureClaim(null);
          }
          throw new HttpsError('failed-precondition', 'Matching admin-owned pack receipt not found');
        }

        const adminReceiptId = String(adminReceipt.id || '');
        if (!adminReceiptId) throw new HttpsError('failed-precondition', 'Matching pack receipt is missing an asset id');
        if (assignment.boxAssetId !== adminReceiptId) {
          throw new HttpsError(
            'failed-precondition',
            'Receipt claim is not ready yet; assigned pack receipt does not match admin receipt',
            {
              dropId: started.dropId,
              deliveryId: started.deliveryId,
              boxId: started.boxId,
              assignedBoxAssetId: assignment.boxAssetId,
              adminReceiptId,
            },
          );
        }

        const receiptTx = await sendOpenableStripeReceiptClaimTx({
          conn,
          dropRuntime,
          signer,
          recipientPk,
          coreCollection: cfg.coreCollection,
          adminReceipt,
          dudeIds: assignment.dudeIds,
        });
        sentReceiptTx = receiptTx;
        return finalizeOpenableFigureClaim(receiptTx);
      }

      let recipientReceipt: any | null | undefined;
      const findRecipientReceipt = async () => {
        if (recipientReceipt === undefined) {
          recipientReceipt = await findStripeReceiptAssetOwnedBy(recipientWallet, dropRuntime, started.boxId);
        }
        return recipientReceipt;
      };
      const finalizeBoxClaim = async (receiptTx: string | null) => {
        const receiptTxs = await finalizeStripeReceiptClaim({
          claimRef,
          orderRef: started.orderRef,
          code,
          dropId: started.dropId,
          deliveryId: started.deliveryId,
          boxId: started.boxId,
          recipientWallet,
          attemptId,
          receiptTx,
          receiptKind: 'box',
          receiptsTransferred: 1,
          updatePluralOrderClaim: started.updatePluralOrderClaim,
          updateSingularOrderClaim: started.updateSingularOrderClaim,
        });
        return stripeReceiptClaimResponse({
          dropId: started.dropId,
          deliveryId: started.deliveryId,
          receiptTxs,
          receiptKind: 'box',
          receiptsTransferred: 1,
        });
      };
      if ((started.resumingPreviousProcessingClaim || started.hasPreviousClaimFailure) && (await findRecipientReceipt())) {
        return finalizeBoxClaim(null);
      }

      if (!adminReceipt) {
        if (await findRecipientReceipt()) {
          return finalizeBoxClaim(null);
        }
        throw new HttpsError('failed-precondition', 'Matching admin-owned pack receipt not found');
      }

      const receiptId = String(adminReceipt.id || '');
      if (!receiptId) throw new HttpsError('failed-precondition', 'Matching pack receipt is missing an asset id');
      const proof = await fetchAssetProof(receiptId, dropRuntime);
      const proofContext = parseCompressedReceiptProof({
        asset: adminReceipt,
        proof,
        dropRuntime,
        expectedOwner: adminWallet,
      });

      const transferIx = buildCompressedReceiptTransferIx({
        proofContext,
        owner: signer.publicKey,
        newOwner: recipientPk,
        coreCollection: cfg.coreCollection,
      });
      const { blockhash } = await withTimeout(
        conn.getLatestBlockhash('confirmed'),
        RPC_TIMEOUT_MS,
        'getLatestBlockhash:claimStripeReceipt',
      );
      const tx = buildTx([ComputeBudgetProgram.setComputeUnitLimit({ units: 700_000 }), transferIx], signer.publicKey, blockhash, [signer]);
      const receiptTx = await sendAndConfirmSignedTx(conn, tx, 'claimStripeReceipt', {
        sendTimeoutMs: TX_SEND_TIMEOUT_MS,
        confirmTimeoutMs: TX_CONFIRM_TIMEOUT_MS,
      });
      sentReceiptTx = receiptTx;
      return finalizeBoxClaim(receiptTx);
    } catch (err) {
      const directSubmissionDefinitelyNotLanded =
        (err as any)?.details?.directCardReceiptSubmissionStatus === 'not_landed';
      const maybeSentReceiptTx = directSubmissionDefinitelyNotLanded
        ? null
        : sentReceiptTx || stripeReceiptClaimMaybeSubmittedTx(err);
      if (startedClaim && maybeSentReceiptTx) {
        const errorSubmission = normalizeDirectCardReceiptClaimSubmissions([
          {
            signature: maybeSentReceiptTx,
            lastValidBlockHeight: (err as any)?.details?.lastValidBlockHeight,
            submittedAtMs: (err as any)?.details?.submittedAtMs,
          },
        ])[0];
        await rememberStripeReceiptClaimSubmittedTx({
          claimRef,
          attemptId,
          receiptTx: maybeSentReceiptTx,
          submission: sentReceiptTxSubmission || errorSubmission || null,
        }).catch((persistErr) => {
          logger.warn('claimStripeReceipt:submitted_tx_persist_failed', {
            dropId: startedClaim?.dropId,
            deliveryId: startedClaim?.deliveryId,
            receiptTx: maybeSentReceiptTx,
            error: summarizeError(persistErr),
          });
        });
        logger.warn('claimStripeReceipt:post_send_error_left_processing_for_retry', {
          dropId: startedClaim.dropId,
          deliveryId: startedClaim.deliveryId,
          boxId: startedClaim.boxId,
          receiptTx: maybeSentReceiptTx,
          error: summarizeError(err),
        });
      } else if (
        startedClaim &&
        !directSubmissionDefinitelyNotLanded &&
        (stripeReceiptClaimErrorKeepsProcessing(err) || keepDirectRecipientLockOnError)
      ) {
        logger.warn('claimStripeReceipt:processing_left_locked_for_indexing', {
          dropId: startedClaim.dropId,
          deliveryId: startedClaim.deliveryId,
          boxId: startedClaim.boxId,
          error: summarizeError(err),
        });
      } else if (startedClaim) {
        await clearStripeReceiptClaimProcessing({
          claimRef,
          orderRef: startedClaim.orderRef,
          code,
          boxId: startedClaim.boxId,
          recipientWallet,
          attemptId,
          err,
          updatePluralOrderClaim: startedClaim.updatePluralOrderClaim,
          updateSingularOrderClaim: startedClaim.updateSingularOrderClaim,
        });
      }
      throw err;
    }
  },
  { secrets: [COSIGNER_SECRET], timeoutSeconds: 180 },
);

export const prepareIrlClaimTx = onCallLogged(
  'prepareIrlClaimTx',
  async (request) => {
  const { wallet } = await requireWalletSession(request);
  const schema = z.object({ owner: z.string(), code: z.string() });
  const { owner, code } = parseRequest(schema, request.data);
  const ownerWallet = normalizeWallet(owner);
  if (wallet !== ownerWallet) throw new HttpsError('permission-denied', 'Owners only');
  const ownerPk = new PublicKey(ownerWallet);

  const normalizedCode = normalizeIrlClaimCode(code);
  if (!normalizedCode || normalizedCode.length !== IRL_CLAIM_CODE_DIGITS) {
    throw new HttpsError('invalid-argument', `Invalid claim code (must be ${IRL_CLAIM_CODE_DIGITS} digits)`);
  }

  const claimRef = db.doc(`claimCodes/${normalizedCode}`);
  const claimDoc = await claimRef.get();
  if (!claimDoc.exists) {
    throw new HttpsError('not-found', 'Invalid claim code');
  }

  const claim = claimDoc.data() as any;
  const claimDropId = await resolveClaimDropIdForCode(normalizedCode, claim);
  const claimDropRuntime = getDropRuntime(claimDropId);
  assertOpenableDrop(claimDropRuntime, 'This drop does not use secret claim codes.');
  await ensureOnchainCoreConfig(claimDropRuntime);
  const boxIdNum = Number(claim?.boxId);
  const boxIdStr = claim?.boxId != null ? String(claim.boxId) : '';
  if (!Number.isFinite(boxIdNum) || boxIdNum <= 0 || boxIdNum > 0xffff_ffff || !boxIdStr) {
    throw new HttpsError('failed-precondition', 'Claim code is missing a valid box id');
  }

  const dudeIdsRaw = claim?.dudeIds ?? claim?.dude_ids ?? claim?.dudes ?? [];
  const dudeIds: number[] = Array.isArray(dudeIdsRaw) ? dudeIdsRaw.map((n: any) => Number(n)) : [];
  if (dudeIds.length !== claimDropRuntime.itemsPerBox) {
    throw new HttpsError('failed-precondition', `Claim has invalid dudeIds (expected ${claimDropRuntime.itemsPerBox})`);
  }
  dudeIds.forEach((id) => {
    if (!Number.isFinite(id) || id < 1 || id > claimDropRuntime.maxDudeId) {
      throw new HttpsError('failed-precondition', `Invalid dude id: ${id}`);
    }
  });
  if (new Set(dudeIds).size !== dudeIds.length) {
    throw new HttpsError('failed-precondition', 'Duplicate dude ids in claim');
  }

  if (clusterSharesCollectionMint(claimDropRuntime)) {
    throw new HttpsError('failed-precondition', 'IRL claim code cannot be disambiguated for a shared collection mint', {
      dropId: claimDropRuntime.dropId,
      expectedCollectionMint: claimDropRuntime.collectionMintStr || null,
    });
  }

  // Load wallet assets once and use it for both:
  // - detecting an already-claimed code (dude receipts already present)
  // - finding the matching box certificate in the wallet
  const ownedAssets = await fetchAssetsOwned(ownerWallet, claimDropRuntime);
  // Filter to certificates that belong to the requested drop before matching ids.
  // Shared collections can legitimately reuse box/dude number ranges across drops.
  const ownedRequestedDropCertificates = ownedAssets.filter(
    (asset: any) => getAssetKind(asset) === 'certificate' && assetMatchesRequestedDrop(asset, claimDropRuntime),
  );

  // If any of the expected dude receipts are already in the wallet, the claim is already done.
  // (The claim tx is atomic; once any of these exist, the box certificate must already be burned.)
  const dudeSet = new Set(dudeIds.map((n) => Number(n)));
  const mintedDudeReceipts = new Set<number>();
  for (const a of ownedRequestedDropCertificates) {
    const id = getDudeIdFromAsset(a);
    if (id != null && dudeSet.has(Number(id))) mintedDudeReceipts.add(Number(id));
  }
  if (mintedDudeReceipts.size > 0) {
    throw new HttpsError('failed-precondition', 'This IRL claim code has already been used');
  }

  // Locate the matching box certificate (receipt) in the requesting wallet.
  const certificate = ownedRequestedDropCertificates.find((asset: any) => getBoxIdFromAsset(asset) === boxIdStr) || null;
  if (!certificate) {
    throw new HttpsError('failed-precondition', 'Matching box certificate not found in wallet');
  }
  if (looksBurntOrClosedInHelius(certificate)) {
    throw new HttpsError('failed-precondition', 'This IRL claim code has already been used');
  }
  if (certificate?.ownership?.owner !== ownerWallet) {
    throw new HttpsError('failed-precondition', 'Matching box certificate not found in wallet');
  }
  const kind = getAssetKind(certificate);
  if (kind !== 'certificate') {
    throw new HttpsError('failed-precondition', 'Provided asset is not a certificate');
  }
  const certificateBoxId = getBoxIdFromAsset(certificate);
  if (!certificateBoxId) {
    throw new HttpsError('failed-precondition', 'Certificate missing box reference');
  }
  if (String(certificateBoxId) !== boxIdStr) {
    throw new HttpsError('failed-precondition', 'Certificate does not match claim box');
  }
  if (!assetMatchesRequestedDrop(certificate, claimDropRuntime)) {
    throw new HttpsError('failed-precondition', 'Certificate does not belong to the requested drop');
  }
  const certificateId = String(certificate.id || '');

  const conn = connection(claimDropRuntime);

  // Load on-chain config so we can build correct burn + mint instructions.
  const cfg = await fetchDecodedBoxMinterConfigAccount({
    dropRuntime: claimDropRuntime,
    conn,
    context: 'getAccountInfo:boxMinterConfig:claimIrl',
  });
  const cfgAdmin = cfg.admin;
  const cfgCoreCollection = cfg.coreCollection;
  const signer = cosigner();
  if (!signer.publicKey.equals(cfgAdmin)) {
    throw new HttpsError('failed-precondition', 'COSIGNER_SECRET does not match on-chain admin', {
      expectedAdmin: cfgAdmin.toBase58(),
      cosigner: signer.publicKey.toBase58(),
    });
  }
  assertConfiguredPublicKey(claimDropRuntime.collectionMint, 'COLLECTION_MINT');
  if (!claimDropRuntime.collectionMint.equals(cfgCoreCollection)) {
    throw new HttpsError('failed-precondition', 'COLLECTION_MINT does not match on-chain config (functions/src/config/deployment.ts)', {
      configured: claimDropRuntime.collectionMint.toBase58(),
      onchain: cfgCoreCollection.toBase58(),
      dropId: claimDropId,
    });
  }

  if (!claimDropRuntime.receiptsMerkleTreeStr) {
    throw new HttpsError(
      'failed-precondition',
      'Receipt cNFT tree is not configured (set `receiptsMerkleTree` in functions/src/config/deployment.ts)',
      { dropId: claimDropId },
    );
  }

  const instructions: TransactionInstruction[] = [ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 })];

  // All receipts/certificates in this repo are Bubblegum v2 compressed cNFTs.
  // (We intentionally do NOT support uncompressed receipt assets anymore.)
  const proof = await fetchAssetProof(certificateId, claimDropRuntime);
  const proofContext = parseCompressedReceiptProof({
    asset: certificate,
    proof,
    dropRuntime: claimDropRuntime,
    expectedOwner: ownerWallet,
    proofMissingMessage: 'Unable to fetch certificate proof for burn',
    treeMismatchMessage: 'Certificate does not belong to the configured receipts tree',
    treeMismatchActualKey: 'certificateTree',
    treeMismatchExpectedKey: 'receiptsTree',
    leafIdMessage: 'Unable to parse certificate leaf id',
    leafIndexMessage: 'Certificate leaf index out of range',
  });

  // 1) Burn the box certificate cNFT (user-signed).
  instructions.push(
    bubblegumBurnV2Ix({
      payer: ownerPk,
      authority: ownerPk,
      leafOwner: proofContext.leafOwner,
      leafDelegate: proofContext.leafDelegate,
      merkleTree: proofContext.merkleTree,
      coreCollection: cfgCoreCollection,
      root: proofContext.root,
      dataHash: proofContext.dataHash,
      creatorHash: proofContext.creatorHash,
      assetDataHash: proofContext.assetDataHash,
      flags: proofContext.flags,
      nonce: proofContext.nonce,
      index: proofContext.index,
      proof: proofContext.proofAccounts,
    }),
  );

  // 2) Mint the configured figure receipt cNFTs (server-cosigned via box_minter CPI to Bubblegum mintV2).
  instructions.push(
    buildMintReceiptsIx({
      dropRuntime: claimDropRuntime,
      cosignerPk: signer.publicKey,
      recipientPk: ownerPk,
      coreCollection: cfgCoreCollection,
      boxIds: [],
      dudeIds,
    }),
  );

  // Prefer building without LUT first (wallet UX / preview tends to behave better),
  // but fall back to the delivery ALT if needed to fit under Solana's packet limit.
  const { blockhash } = await withTimeout(conn.getLatestBlockhash('confirmed'), RPC_TIMEOUT_MS, 'getLatestBlockhash:claimIrl');
  const buildClaimTx = (luts: AddressLookupTableAccount[]) => buildTx(instructions, ownerPk, blockhash, [signer], luts);
  const { raw } = await buildTxWithOptionalDeliveryLookupTable({
    conn,
    dropRuntime: claimDropRuntime,
    build: buildClaimTx,
    encodeTooLargeMessage:
      'Claim transaction is too large to encode. Re-run deploy-all to update functions/src/config/deployment.ts (deliveryLookupTable), then retry.',
    encodeTooLargeDetails: { receiptsMerkleTree: claimDropRuntime.receiptsMerkleTreeStr, dropId: claimDropId },
    packetTooLargeMessage: (rawBytes, maxRawBytes) => `Claim transaction too large (${rawBytes} bytes > ${maxRawBytes}).`,
    packetTooLargeDetails: {
      deliveryLookupTable: claimDropRuntime.deliveryLookupTableStr,
      receiptsMerkleTree: claimDropRuntime.receiptsMerkleTreeStr,
      dropId: claimDropId,
    },
  });

  return {
    encodedTx: Buffer.from(raw).toString('base64'),
    dropId: claimDropId,
    certificates: dudeIds,
    certificateId,
    message: 'Sign and send to burn your box receipt and mint your dude receipts.',
  };
  },
  { secrets: [COSIGNER_SECRET] },
);
