import { parseDeliveryOrderReceiptView } from './deliveryOrderReceiptView.js';
import { parseDeliveryOrderStatus } from './deliveryOrderReadModel.js';
import {
  createConnection,
  decodeCosigner,
  deriveDeliveryPda,
  fetchOnchainConfig,
  runtimeForDrop,
  transactionErrorMessage,
  type ProviderContext,
} from './deliveryReceiptOnchain.js';
import { DeliveryReceiptError, summarizeDeliveryReceiptError as summarizeError } from './deliveryReceiptErrors.js';
import { dropDeliveryOrderPath } from './dropPaths.js';
import { isNonZeroBase58Bytes } from '../../../../shared/solanaRpcProxy.js';
import { resolveRequestWallet, type RequestIdentity } from './requestIdentity.js';
import { assignDudesForBox } from './deliveryDudeAssignments.js';
import { secureRandomInt } from './deliveryRandom.js';
import { publishReadyToShipNotifications } from './readyToShipNotificationOutbox.js';
import { scheduleDeliveryPackStatusProjection } from './deliveryPackStatusOutbox.js';
import type { DeferredWork } from './deferredWork.js';
import { deliveryOrderKey, readDeliveryRecovery } from './deliveryOrderStore.js';
import {
  confirmedReceiptTransactions,
  ensureIrlClaimCodeForBox,
  markDeliveryProcessing,
  markDeliveryReady,
  pendingReceiptSubmission,
  persistPendingReceiptSubmission,
  recordDeliveryClose,
  settlePendingReceiptSubmission,
  type DeliveryIrlClaim,
} from './deliveryReceiptStore.js';
import {
  acquireDeliveryRecoveryLease,
  acquireVerifiedReceiptIssuanceLease,
  requireDeliveryRecoveryLease,
  type DeliveryRecoveryLease,
} from './deliveryRecoveryStore.js';
import {
  deliveryRecoveryCleanupContext as cleanupContext,
  runLeasedReceiptRecoveryAttempt,
} from './deliveryRecoveryAttempt.js';
import {
  type DeliveryReceiptsEnv,
  type CommerceContext,
  type IssueRequest,
  loadBoundWallet,
} from './deliveryReceiptRequest.js';
import {
  canonicalPublicKey,
  verifyReceiptIssuanceBySignature,
  verifyReceiptIssuanceByDeliveryRecord,
} from './deliveryReceiptVerification.js';
import {
  closeDeliveryPda,
  reconcilePendingReceiptSubmission,
  type ReceiptSubmissionLifecycle,
  fetchReceiptAssetAccounts,
  pendingReceiptItems,
  sendReceiptBatch,
  shouldShrinkReceiptBatch,
} from './deliveryReceiptSubmission.js';

type RetryIssueReceiptsArgs = {
  ownerWallet: string;
  deliveryId: number;
  dropId: string;
} & ({ verification: 'signature'; signature: string } | { verification: 'delivery_pda' });

export type ReceiptIssueResult = {
  processed: true;
  deliveryId: number;
  receiptsMinted: number;
  receiptTxs: string[];
  closeDeliveryTx: string | null;
};

type ReceiptIssuanceAccess =
  | { kind: 'leased'; lease: DeliveryRecoveryLease }
  | { kind: 'verify-and-lease' }
  | { kind: 'ready' };

type ReceiptIssuanceArguments = {
  request: RetryIssueReceiptsArgs;
  env: DeliveryReceiptsEnv;
  commerce: CommerceContext;
  provider: ProviderContext;
  waitUntil: DeferredWork;
  randomInt: (maxExclusive: number) => number;
  access: ReceiptIssuanceAccess;
};

async function prepareReceiptIssuance(args: ReceiptIssuanceArguments) {
  const owner = canonicalPublicKey(args.request.ownerWallet, 'wallet address');
  const deliveryId = Math.floor(args.request.deliveryId);
  const runtime = runtimeForDrop(args.request.dropId);
  const path = dropDeliveryOrderPath(runtime.dropId, deliveryId);
  const snapshot = await readDeliveryRecovery(args.commerce, deliveryOrderKey(path));
  if (!snapshot) throw new DeliveryReceiptError('not-found', 'Delivery order not found.');
  if (args.access.kind === 'leased') requireDeliveryRecoveryLease(snapshot, args.access.lease);
  const document = snapshot.order;
  const receipt = parseDeliveryOrderReceiptView(document.data);
  if (receipt.ownership.hasOwner && receipt.ownership.owner !== owner.toBase58()) {
    throw new DeliveryReceiptError('permission-denied', 'Order belongs to a different wallet.');
  }
  const connection = createConnection(args.provider, runtime);
  const onchain = await fetchOnchainConfig(connection, runtime);
  const signer = decodeCosigner(args.env.COSIGNER_SECRET);
  if (!signer.publicKey.equals(onchain.admin)) {
    throw new DeliveryReceiptError('failed-precondition', 'COSIGNER_SECRET does not match on-chain admin.');
  }
  const prepared = { owner, deliveryId, runtime, snapshot, document, receipt, connection, onchain, signer };
  if (receipt.status === 'ready_to_ship') return { ...prepared, kind: 'ready' as const };
  if (args.access.kind === 'ready') {
    throw new DeliveryReceiptError('aborted', 'Delivery order changed. Retry later.');
  }
  const verified = args.request.verification === 'signature'
    ? await verifyReceiptIssuanceBySignature({
        connection,
        deliveryId,
        order: receipt,
        ownerWallet: owner.toBase58(),
        runtime,
        signature: args.request.signature,
      })
    : await verifyReceiptIssuanceByDeliveryRecord({
        connection,
        deliveryId,
        order: receipt,
        ownerWallet: owner.toBase58(),
        runtime,
      });
  return { ...prepared, kind: 'verified' as const, verified };
}

type PreparedReceiptIssuance = Awaited<ReturnType<typeof prepareReceiptIssuance>>;

type VerifiedReceiptIssuance = Extract<PreparedReceiptIssuance, { kind: 'verified' }>;

async function resumeReadyOrder(
  args: ReceiptIssuanceArguments,
  prepared: PreparedReceiptIssuance,
): Promise<ReceiptIssueResult> {
  const { runtime, deliveryId, document, receipt, connection, signer } = prepared;
  scheduleDeliveryPackStatusProjection({
    context: args.commerce,
    deliveryId,
    dropId: runtime.dropId,
    waitUntil: args.waitUntil,
  });
  let closeDeliveryTx = receipt.closeDeliveryTx;
  if (!closeDeliveryTx) {
    const [deliveryPda, deliveryBump] = deriveDeliveryPda(runtime, deliveryId);
    try {
      closeDeliveryTx = await closeDeliveryPda({
        connection,
        runtime,
        signer,
        deliveryPda,
        deliveryId,
        deliveryBump,
        signal: args.provider.signal,
      });
      if (closeDeliveryTx) {
        await recordDeliveryClose(args.commerce, document.key, runtime.dropId, closeDeliveryTx);
      }
    } catch (error) {
      console.warn({
        event: 'delivery_receipt_late_close_failed',
        dropId: runtime.dropId,
        deliveryId,
        error: summarizeError(error),
      });
    }
  }
  await publishReadyToShipNotifications({
    context: args.commerce,
    deliveryId,
    key: document.key,
    dropId: runtime.dropId,
    queue: args.env.NOTIFICATION_EMAIL_QUEUE,
  });
  return {
    processed: true,
    deliveryId,
    receiptsMinted: receipt.receiptsMinted,
    receiptTxs: receipt.receiptTxs,
    closeDeliveryTx,
  };
}

async function issueVerifiedReceipts(
  args: ReceiptIssuanceArguments,
  prepared: VerifiedReceiptIssuance,
  lease: DeliveryRecoveryLease,
): Promise<ReceiptIssueResult> {
  const { owner, deliveryId, runtime, snapshot, connection, onchain, signer, verified } = prepared;
  let document = snapshot.order;
  const path = document.key.path;
  await markDeliveryProcessing(args.commerce, snapshot, runtime, verified.signature, lease);
  const storedPendingSubmission = pendingReceiptSubmission(document.data);
  if (storedPendingSubmission) {
    const outcome = await reconcilePendingReceiptSubmission({
      commerce: args.commerce,
      provider: args.provider,
      runtime,
      path: document.key.path,
      pending: storedPendingSubmission,
      lease,
    });
    if (outcome === 'unresolved') {
      throw new DeliveryReceiptError('aborted', 'A receipt transaction is still being reconciled.');
    }
    const reconciled = await readDeliveryRecovery(args.commerce, deliveryOrderKey(path));
    if (!reconciled) throw new DeliveryReceiptError('not-found', 'Delivery order not found.');
    document = reconciled.order;
  }
  const lifecycle: ReceiptSubmissionLifecycle = {
    prepare: (pendingSubmission) => persistPendingReceiptSubmission(
      args.commerce,
      document.key,
      pendingSubmission,
      lease,
      () => cleanupContext(args.commerce),
    ),
    reconcile: (pendingSubmission) => reconcilePendingReceiptSubmission({
      commerce: args.commerce,
      provider: args.provider,
      runtime,
      path: document.key.path,
      pending: pendingSubmission,
      lease,
    }),
    settle: (pendingSubmission, outcome) => settlePendingReceiptSubmission(
      cleanupContext(args.commerce),
      document.key,
      pendingSubmission,
      outcome,
      lease,
      () => cleanupContext(args.commerce),
    ),
  };
  const assetKeys = verified.targetAssetIds.map((assetId) => canonicalPublicKey(assetId, 'delivery asset id'));
  const infos = await fetchReceiptAssetAccounts(connection, assetKeys);
  const pending = pendingReceiptItems(parseDeliveryOrderReceiptView(document.data), verified.targetAssetIds, infos, runtime);
  const alreadyProcessed = verified.targetAssetIds.length - pending.length;
  const receiptTxs = confirmedReceiptTransactions(document.data);
  let totalProcessed = 0;
  while (pending.length) {
    if (args.provider.signal.aborted) throw args.provider.signal.reason;
    let batchSize = Math.min(pending.length, 3);
    let lastError: unknown;
    while (batchSize >= 1) {
      try {
        const signature = await sendReceiptBatch({
          connection,
          runtime,
          signer,
          owner,
          coreCollection: onchain.coreCollection,
          batch: pending.slice(0, batchSize),
          signal: args.provider.signal,
          lifecycle,
        });
        if (!receiptTxs.includes(signature)) receiptTxs.push(signature);
        totalProcessed += batchSize;
        pending.splice(0, batchSize);
        break;
      } catch (error) {
        lastError = error;
        if (shouldShrinkReceiptBatch(error)) {
          batchSize -= 1;
          continue;
        }
        throw error;
      }
    }
    if (batchSize < 1) {
      throw new DeliveryReceiptError(
        'failed-precondition',
        'Unable to issue receipts. Try fewer items or retry later.',
        { lastError: transactionErrorMessage(lastError) },
      );
    }
  }
  const receiptsMinted = alreadyProcessed + totalProcessed;
  const irlClaims: DeliveryIrlClaim[] = [];
  if (runtime.itemsPerBox > 0) {
    const items = parseDeliveryOrderReceiptView(document.data).items;
    for (const item of items) {
      if (item.kind !== 'box' || typeof item.assetId !== 'string') continue;
      const boxId = item.refId;
      if (!Number.isSafeInteger(boxId) || boxId < 1 || boxId > 0xffff_ffff) continue;
      const dudeIds = await assignDudesForBox(
        args.commerce,
        runtime,
        item.assetId,
        args.randomInt,
      );
      const code = await ensureIrlClaimCodeForBox(args.commerce, runtime, {
        ownerWallet: owner.toBase58(),
        deliveryId,
        boxAssetId: item.assetId,
        boxId,
        dudeIds,
      }, args.randomInt);
      irlClaims.push({ code, boxId, boxAssetId: item.assetId, dudeIds });
    }
  }
  const readyDocument = await markDeliveryReady(args.commerce, document, runtime, {
    signature: verified.signature,
    receiptsMinted,
    receiptTxs,
    irlClaims,
  }, lease);
  scheduleDeliveryPackStatusProjection({
    context: args.commerce,
    deliveryId,
    dropId: runtime.dropId,
    waitUntil: args.waitUntil,
  });
  let closeDeliveryTx: string | null = null;
  try {
    closeDeliveryTx = await closeDeliveryPda({
      connection,
      runtime,
      signer,
      deliveryPda: verified.expectedDeliveryPda,
      deliveryId,
      deliveryBump: verified.expectedDeliveryBump,
      signal: args.provider.signal,
    });
  } catch (error) {
    console.warn({
      event: 'delivery_receipt_close_failed',
      dropId: runtime.dropId,
      deliveryId,
      error: summarizeError(error),
    });
  }
  if (closeDeliveryTx) {
    await recordDeliveryClose(args.commerce, document.key, runtime.dropId, closeDeliveryTx);
  }
  await publishReadyToShipNotifications({
    context: args.commerce,
    deliveryId,
    key: readyDocument.key,
    dropId: runtime.dropId,
    queue: args.env.NOTIFICATION_EMAIL_QUEUE,
  });
  return { processed: true, deliveryId, receiptsMinted, receiptTxs, closeDeliveryTx };
}

export async function retryIssueReceipts(args: ReceiptIssuanceArguments): Promise<ReceiptIssueResult> {
  const prepared = await prepareReceiptIssuance(args);
  if (prepared.kind === 'ready') return resumeReadyOrder(args, prepared);
  if (args.access.kind === 'leased') return issueVerifiedReceipts(args, prepared, args.access.lease);
  if (args.access.kind !== 'verify-and-lease' || args.request.verification !== 'signature') {
    throw new DeliveryReceiptError('aborted', 'Receipt issuance requires an owned recovery attempt.');
  }
  const claimed = await acquireVerifiedReceiptIssuanceLease(
    args.commerce, prepared.snapshot, prepared.owner.toBase58(), Date.now(),
  );
  return runLeasedReceiptRecoveryAttempt({
    context: args.commerce, key: prepared.document.key, lease: claimed.lease, origin: { kind: 'issue' },
    operation: () => issueVerifiedReceipts(args, { ...prepared, snapshot: claimed.snapshot }, claimed.lease),
  });
}

export async function issueReceiptsRequest(
  body: IssueRequest,
  identity: RequestIdentity,
  env: DeliveryReceiptsEnv,
  commerce: CommerceContext,
  provider: ProviderContext,
  waitUntil: DeferredWork,
  overrides: Partial<{ retryIssueReceipts: typeof retryIssueReceipts }> = {},
): Promise<ReceiptIssueResult> {
  const wallet = await resolveRequestWallet(identity, (uid) => loadBoundWallet(commerce, env.OPS_DB, uid));
  const ownerWallet = canonicalPublicKey(body.owner, 'wallet address').toBase58();
  if (wallet !== ownerWallet) throw new DeliveryReceiptError('permission-denied', 'Owners only.');
  if (!isNonZeroBase58Bytes(body.signature, 64)) {
    throw new DeliveryReceiptError('invalid-argument', 'Invalid delivery signature.');
  }
  const runtime = runtimeForDrop(body.dropId);
  const path = dropDeliveryOrderPath(runtime.dropId, body.deliveryId);
  const snapshot = await readDeliveryRecovery(commerce, deliveryOrderKey(path));
  if (!snapshot) throw new DeliveryReceiptError('not-found', 'Delivery order not found.');
  const order = snapshot.order;
  let access: ReceiptIssuanceAccess = { kind: 'ready' };
  if (parseDeliveryOrderStatus(order.data).status !== 'ready_to_ship') {
    const lease = await acquireDeliveryRecoveryLease(commerce, order.key, ownerWallet, Date.now(), true);
    if (!lease.acquired) {
      if (lease.result.outcome === 'lease_active') {
        throw new DeliveryReceiptError('aborted', lease.result.message || 'Another client is already retrying this order.');
      }
      if (lease.result.outcome === 'not_found') {
        throw new DeliveryReceiptError('not-found', lease.result.message || 'Delivery order not found.');
      }
      if (lease.result.errorCode === 'permission-denied') {
        throw new DeliveryReceiptError('permission-denied', lease.result.message || 'Order belongs to a different wallet.');
      }
      if (lease.result.outcome !== 'skipped_status') {
        throw new DeliveryReceiptError('failed-precondition', lease.result.message || 'Unable to start receipt issuance.');
      }
      access = { kind: 'verify-and-lease' };
    } else {
      access = { kind: 'leased', lease: lease.lease };
    }
  }
  const operation = () => (overrides.retryIssueReceipts || retryIssueReceipts)({
    request: {
      ownerWallet, deliveryId: body.deliveryId, dropId: runtime.dropId,
      verification: 'signature', signature: body.signature,
    },
    env, commerce, provider, waitUntil, randomInt: secureRandomInt, access,
  });
  if (access.kind !== 'leased') return operation();
  return runLeasedReceiptRecoveryAttempt({
    context: commerce, key: order.key, lease: access.lease, origin: { kind: 'issue' }, operation,
  });
}
