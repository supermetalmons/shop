import bs58 from 'bs58';
import { ComputeBudgetProgram, PublicKey, VersionedTransaction } from '@solana/web3.js';
import type { StripeReceiptClaimResult } from '../../../../shared/contracts.js';
import type { DasAsset } from '../../../../shared/dasAsset.js';
import type { ProfileProviderFetch } from './boundedResponse.js';
import { D1CommerceRepository, loadCommerceAuthorityControl } from './commerceRepository.js';
import type { CommerceRepositoryContext } from './commerceTransactions.js';
import { decodeCosigner, fetchOnchainConfig, hasConfirmedSignatureCommitment, mintReceiptsInstruction } from './deliveryReceiptOnchain.js';
import { StripeReceiptClaimError } from './stripeReceiptClaimErrors.js';
import {
  buildTransaction, buildWithOptionalLookupTable, burnInstruction, claimFlowFor,
  createConnection, fetchAsset, fetchAssetProof, findFigureReceiptById, findPackReceipt,
  findPackReceiptById, inspectPersistedTransfers, ownsAllFigureReceipts,
  proofForAsset, proofMatches, requireOpenableAssignment, responseForClaim, runtimeForDrop,
  signedTransactionSignature, transferInstruction,
} from './stripeReceiptClaim.js';
import { bubblegumReceiptAssetIds, matchingReceiptTransferCount, transactionAccountKeys } from './receiptTransferVerification.js';
import type { ReceiptClaimWorkflowSnapshot, ReceiptClaimWorkflowSubmission } from './stripeReceiptClaimWorkflowState.js';
import {
  loadReceiptClaimWorkflow,
  settleReceiptClaimWorkflowLegacySubmissions,
  settleReceiptClaimWorkflowSubmission,
} from './stripeReceiptClaimWorkflowStore.js';

export type ReceiptClaimWorkflowOnchainArgs = {
  env: Pick<Env, 'COMMERCE_DB' | 'COSIGNER_SECRET' | 'HELIUS_API_KEY'>;
  snapshot: ReceiptClaimWorkflowSnapshot;
  signal: AbortSignal;
  providerFetch?: ProfileProviderFetch;
};

export type ReceiptClaimWorkflowReconciliation =
  | { status: 'complete'; result: StripeReceiptClaimResult }
  | { status: 'prepare' | 'pending' | 'broadcast' };

function context(args: ReceiptClaimWorkflowOnchainArgs): CommerceRepositoryContext {
  return { repository: new D1CommerceRepository(args.env.COMMERCE_DB), nowMs: Date.now(), signal: args.signal };
}

async function freshSnapshot(args: ReceiptClaimWorkflowOnchainArgs): Promise<ReceiptClaimWorkflowSnapshot> {
  args.signal.throwIfAborted();
  const snapshot = await loadReceiptClaimWorkflow(context(args), args.snapshot.operation.operationId);
  if (!snapshot || snapshot.operation.generation !== args.snapshot.operation.generation ||
    snapshot.operation.recipient !== args.snapshot.operation.recipient) {
    throw new StripeReceiptClaimError('aborted', 'Receipt claim execution changed.');
  }
  if (snapshot.operation.phase !== 'pending' && snapshot.operation.phase !== 'complete') {
    throw new StripeReceiptClaimError('aborted', 'Receipt claim execution is no longer active.');
  }
  if (snapshot.operation.phase === 'pending' && (await loadCommerceAuthorityControl(args.env.COMMERCE_DB)).state === 'paused') {
    throw new StripeReceiptClaimError('unavailable', 'Receipt claiming is paused for maintenance.');
  }
  if (snapshot.operation.phase === 'pending' && snapshot.operation.deadlineAtMs <= Date.now()) {
    throw new StripeReceiptClaimError('deadline-exceeded', 'Receipt claim confirmation needs another retry.');
  }
  return snapshot;
}

function resources(args: ReceiptClaimWorkflowOnchainArgs, snapshot: ReceiptClaimWorkflowSnapshot) {
  const runtime = runtimeForDrop(snapshot.started.dropId);
  const network = runtime.cluster;
  if (network !== 'mainnet-beta' && network !== 'devnet') throw new StripeReceiptClaimError('failed-precondition', 'Receipt claim network is unsupported.');
  const apiKey = String(args.env.HELIUS_API_KEY || '').trim();
  if (!apiKey) throw new StripeReceiptClaimError('unavailable', 'Receipt claiming is temporarily unavailable.');
  const signal = AbortSignal.any([args.signal, AbortSignal.timeout(Math.max(1, snapshot.operation.deadlineAtMs - Date.now()))]);
  const provider = { apiKey, providerFetch: args.providerFetch ?? fetch, signal };
  const connection = createConnection(provider, runtime);
  const flow = claimFlowFor(snapshot.started.directFigureReceipt, runtime.itemsPerBox);
  const assignment = flow === 'openable_pack'
    ? requireOpenableAssignment(snapshot.started.orderIrlClaims, runtime, snapshot.started.boxId)
    : null;
  const target = snapshot.operation.submission?.target;
  if (target && (target.flow !== flow || target.dropId !== runtime.dropId || target.network !== runtime.cluster ||
    target.programId !== runtime.boxMinterProgramId.toBase58() ||
    target.collectionMint !== runtime.collectionMint.toBase58() ||
    target.receiptsMerkleTree !== runtime.receiptsMerkleTree.toBase58() ||
    (assignment && (target.receiptAssetId !== assignment.boxAssetId || JSON.stringify(target.figureIds) !== JSON.stringify(assignment.dudeIds))) ||
    (snapshot.started.directFigureReceipt && (target.receiptAssetId !== snapshot.started.directFigureReceipt.receiptAssetId ||
      target.figureIds.length !== 1 || target.figureIds[0] !== snapshot.started.directFigureReceipt.figureId)))) {
    throw new StripeReceiptClaimError('failed-precondition', 'Receipt claim configuration changed.');
  }
  return { runtime, network, provider, connection, flow, assignment };
}

function completion(snapshot: ReceiptClaimWorkflowSnapshot, target?: ReceiptClaimWorkflowSubmission['target'], signature?: string): StripeReceiptClaimResult {
  const { started, operation } = snapshot;
  const runtime = runtimeForDrop(started.dropId);
  const flow = target?.flow ?? claimFlowFor(started.directFigureReceipt, runtime.itemsPerBox);
  const figureIds = target?.figureIds ?? (started.directFigureReceipt ? [started.directFigureReceipt.figureId]
    : flow === 'openable_pack' ? requireOpenableAssignment(started.orderIrlClaims, runtime, started.boxId).dudeIds : []);
  const rejected = new Set([
    ...operation.submissionHistory.filter((entry) => entry.status === 'not_landed').map((entry) => entry.signature),
    ...started.receiptTxSubmissions.filter((entry) => entry.status === 'not_landed').map((entry) => entry.signature),
  ]);
  return responseForClaim({
    dropId: started.dropId,
    deliveryId: started.deliveryId,
    receiptKind: flow === 'legacy_pack' ? 'box' : 'figure',
    receiptsTransferred: figureIds.length || 1,
    receiptTxs: Array.from(new Set([...started.receiptTxs, ...(signature ? [signature] : [])])).filter((entry) => !rejected.has(entry)),
    ...(figureIds.length ? { figureIds } : {}),
    ...(flow === 'direct_figure' ? { receiptAssetIds: [target?.receiptAssetId ?? started.directFigureReceipt!.receiptAssetId] } : {}),
  });
}

async function ownedReceipt(
  data: ReturnType<typeof resources>,
  snapshot: ReceiptClaimWorkflowSnapshot,
  owner: string,
): Promise<DasAsset | null> {
  const { started, operation } = snapshot;
  if (started.directFigureReceipt) {
    return findFigureReceiptById(data.provider, owner, data.runtime,
      started.directFigureReceipt.figureId, started.directFigureReceipt.receiptAssetId);
  }
  const assetId = operation.submission?.target.receiptAssetId ?? data.assignment?.boxAssetId;
  return assetId
    ? findPackReceiptById(data.provider, owner, data.runtime, started.boxId, assetId)
    : findPackReceipt(data.provider, owner, data.runtime, started.boxId);
}

async function recipientHasReceipts(data: ReturnType<typeof resources>, snapshot: ReceiptClaimWorkflowSnapshot): Promise<boolean> {
  return data.assignment
    ? ownsAllFigureReceipts(data.provider, snapshot.operation.recipient, data.runtime, data.assignment.dudeIds)
    : Boolean(await ownedReceipt(data, snapshot, snapshot.operation.recipient));
}

async function verifiesLegacyDelivery(data: ReturnType<typeof resources>, snapshot: ReceiptClaimWorkflowSnapshot, signature: string): Promise<boolean> {
  const transaction = await data.connection.getTransaction(signature, { maxSupportedTransactionVersion: 0 });
  if (!transaction?.meta || transaction.meta.err) return false;
  const onchain = await fetchOnchainConfig(data.connection, data.runtime);
  const keys = transactionAccountKeys(transaction);
  if (!keys[0]?.equals(onchain.admin)) return false;
  if (data.assignment) {
    const expected = mintReceiptsInstruction({
      runtime: data.runtime, signer: onchain.admin, recipient: new PublicKey(snapshot.operation.recipient),
      coreCollection: onchain.coreCollection, boxIds: [], dudeIds: data.assignment.dudeIds,
    });
    return transaction.transaction.message.compiledInstructions.some((instruction) =>
      keys[instruction.programIdIndex]?.equals(expected.programId) &&
      Buffer.from(instruction.data).equals(expected.data) &&
      instruction.accountKeyIndexes.length === expected.keys.length &&
      Array.from(instruction.accountKeyIndexes).every((index, position) => keys[index]?.equals(expected.keys[position].pubkey)));
  }
  if (matchingReceiptTransferCount(transaction, {
    sender: onchain.admin.toBase58(), recipient: snapshot.operation.recipient,
    collection: onchain.coreCollection, merkleTree: data.runtime.receiptsMerkleTree,
  }) !== 1) return false;
  const assetIds = bubblegumReceiptAssetIds(transaction);
  if (assetIds.length !== 1) return false;
  const asset = await fetchAsset(data.provider, data.runtime, assetIds[0]);
  return proofMatches(data.provider, data.runtime, asset, { kind: 'box', id: snapshot.started.boxId });
}

async function inspectLegacyDelivery(data: ReturnType<typeof resources>, snapshot: ReceiptClaimWorkflowSnapshot, signatures: string[]) {
  const { value: statuses } = await data.connection.getSignatureStatuses(signatures, { searchTransactionHistory: true });
  for (let index = 0; index < signatures.length; index += 1) {
    const status = statuses[index];
    if (status && !status.err && hasConfirmedSignatureCommitment(status) &&
      await verifiesLegacyDelivery(data, snapshot, signatures[index])) {
      return { statuses, signature: signatures[index] };
    }
  }
  return { statuses, signature: null };
}

export async function reconcileReceiptClaimWorkflowOnchain(args: ReceiptClaimWorkflowOnchainArgs): Promise<ReceiptClaimWorkflowReconciliation> {
  let snapshot = await freshSnapshot(args);
  if (snapshot.operation.phase === 'complete' && snapshot.operation.result) return { status: 'complete', result: snapshot.operation.result };
  const data = resources(args, snapshot);
  const submission = snapshot.operation.submission;
  const historical = new Set(snapshot.operation.submissionHistory.map((entry) => entry.signature));
  const legacySignatures = snapshot.started.receiptTxs.filter((signature) => !historical.has(signature));
  if (submission?.status === 'confirmed') return { status: 'complete', result: completion(snapshot, submission.target, submission.signature) };
  if (submission?.status === 'prepared') {
    const statuses = await data.connection.getSignatureStatuses([submission.signature], { searchTransactionHistory: true });
    const status = statuses.value[0];
    if (status && !status.err && hasConfirmedSignatureCommitment(status)) {
      await settleReceiptClaimWorkflowSubmission(context(args), snapshot, 'confirmed');
      return { status: 'complete', result: completion(snapshot, submission.target, submission.signature) };
    }
    if (status?.err && hasConfirmedSignatureCommitment(status)) {
      await settleReceiptClaimWorkflowSubmission(context(args), snapshot, 'not_landed');
      return { status: 'prepare' };
    }
    if (status) return { status: 'pending' };
    const height = await data.connection.getBlockHeight('finalized');
    if (height <= submission.lastValidBlockHeight) return { status: 'broadcast' };
    if (data.assignment && legacySignatures.length) {
      const { signature } = await inspectLegacyDelivery(data, snapshot, legacySignatures);
      if (signature) return { status: 'complete', result: completion(snapshot, undefined, signature) };
    }
    if (await recipientHasReceipts(data, snapshot)) return { status: 'complete', result: completion(snapshot, submission.target, submission.signature) };
    if (!await ownedReceipt(data, snapshot, submission.target.adminWallet)) return { status: 'pending' };
    await settleReceiptClaimWorkflowSubmission(context(args), snapshot, 'not_landed');
    return { status: 'prepare' };
  }
  if (!snapshot.started.directFigureReceipt && !submission && !snapshot.started.receiptTxs.length &&
    !snapshot.started.resumingPreviousProcessingClaim && !snapshot.started.hasPreviousClaimFailure) {
    const onchain = await fetchOnchainConfig(data.connection, data.runtime);
    const adminWallet = onchain.admin.toBase58();
    if (adminWallet !== snapshot.operation.recipient && await ownedReceipt(data, snapshot, adminWallet)) {
      return { status: 'prepare' };
    }
  }
  if (!(snapshot.started.directFigureReceipt && legacySignatures.length) && await recipientHasReceipts(data, snapshot)) {
    return { status: 'complete', result: completion(snapshot) };
  }
  if (snapshot.started.directFigureReceipt && legacySignatures.length) {
    const onchain = await fetchOnchainConfig(data.connection, data.runtime);
    const inspected = await inspectPersistedTransfers({
      connection: data.connection, runtime: data.runtime, signatures: legacySignatures,
      submissions: snapshot.started.receiptTxSubmissions, adminWallet: onchain.admin.toBase58(),
      recipientWallet: snapshot.operation.recipient, coreCollection: onchain.coreCollection,
      receiptAssetId: snapshot.started.directFigureReceipt.receiptAssetId,
    });
    if (inspected.terminalSubmissions.length) {
      snapshot = await settleReceiptClaimWorkflowLegacySubmissions(context(args), snapshot, inspected.terminalSubmissions);
      if (snapshot.operation.phase === 'complete' && snapshot.operation.result) return { status: 'complete', result: snapshot.operation.result };
    }
    if (inspected.evidence === 'verified' || await recipientHasReceipts(data, snapshot)) {
      return { status: 'complete', result: completion(snapshot, undefined, inspected.signature ?? undefined) };
    }
    if (inspected.evidence === 'unresolved') return { status: 'pending' };
  } else if (legacySignatures.length) {
    const { statuses, signature } = await inspectLegacyDelivery(data, snapshot, legacySignatures);
    if (signature) return { status: 'complete', result: completion(snapshot, undefined, signature) };
    if (statuses.some((status) => status && (!status.err || !hasConfirmedSignatureCommitment(status)))) return { status: 'pending' };
    if (statuses.some((status) => !status)) {
      if (!data.assignment) return { status: 'pending' };
      const onchain = await fetchOnchainConfig(data.connection, data.runtime);
      const receipt = await ownedReceipt(data, snapshot, onchain.admin.toBase58());
      if (receipt?.id !== data.assignment.boxAssetId) return { status: 'pending' };
    }
  } else if (snapshot.started.resumingPreviousProcessingClaim && !submission && snapshot.operation.submissionHistory.length === 0) {
    if ((!snapshot.started.directFigureReceipt && !data.assignment) ||
      snapshot.started.receiptTxSubmissions.some((entry) => entry.status !== 'not_landed')) {
      return { status: 'pending' };
    }
    const onchain = await fetchOnchainConfig(data.connection, data.runtime);
    if (!await ownedReceipt(data, snapshot, onchain.admin.toBase58())) return { status: 'pending' };
  }
  return { status: 'prepare' };
}

export async function prepareReceiptClaimWorkflowTransaction(args: ReceiptClaimWorkflowOnchainArgs): Promise<ReceiptClaimWorkflowSubmission> {
  const snapshot = await freshSnapshot(args);
  if (snapshot.operation.phase !== 'pending') throw new StripeReceiptClaimError('aborted', 'Receipt claim is already complete.');
  const previous = snapshot.operation.submission;
  if (previous && previous.status !== 'not_landed') return previous;
  const data = resources(args, snapshot);
  const onchain = await fetchOnchainConfig(data.connection, data.runtime);
  const signer = decodeCosigner(args.env.COSIGNER_SECRET);
  if (!signer.publicKey.equals(onchain.admin) || !data.runtime.collectionMint.equals(onchain.coreCollection)) {
    throw new StripeReceiptClaimError('unavailable', 'Receipt claim signer or collection configuration changed.');
  }
  const adminWallet = signer.publicKey.toBase58();
  if (previous && previous.target.adminWallet !== adminWallet) throw new StripeReceiptClaimError('failed-precondition', 'Receipt claim admin changed.');
  const receipt = await ownedReceipt(data, snapshot, adminWallet);
  if (!receipt || typeof receipt.id !== 'string') throw new StripeReceiptClaimError('unavailable', 'Receipt ownership is still resolving.');
  const proof = proofForAsset(receipt, await fetchAssetProof(data.provider, data.runtime, receipt.id), data.runtime, adminWallet);
  const recipient = new PublicKey(snapshot.operation.recipient);
  const figureIds = snapshot.started.directFigureReceipt ? [snapshot.started.directFigureReceipt.figureId] : data.assignment?.dudeIds ?? [];
  const instructions = data.flow === 'openable_pack'
    ? [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
      burnInstruction({ proof, owner: signer.publicKey, coreCollection: onchain.coreCollection }),
      mintReceiptsInstruction({ runtime: data.runtime, signer: signer.publicKey, recipient, coreCollection: onchain.coreCollection, boxIds: [], dudeIds: figureIds }),
    ]
    : [ComputeBudgetProgram.setComputeUnitLimit({ units: 700_000 }), transferInstruction({ proof, owner: signer.publicKey, recipient, coreCollection: onchain.coreCollection })];
  const { blockhash, lastValidBlockHeight } = await data.connection.getLatestBlockhash('confirmed');
  const transaction = await buildWithOptionalLookupTable({
    provider: data.provider, runtime: data.runtime,
    build: (tables) => buildTransaction(instructions, signer, blockhash, tables),
    encodeTooLargeMessage: 'Receipt claim transaction is too large to encode.',
    packetTooLargeMessage: () => 'Receipt claim transaction is too large.',
  });
  const signature = signedTransactionSignature(transaction);
  if (previous?.signature === signature) throw new StripeReceiptClaimError('unavailable', 'Waiting for a fresh receipt claim transaction.');
  return {
    signature, signedTransactionBase64: Buffer.from(transaction.serialize()).toString('base64'),
    blockhash, lastValidBlockHeight, preparedAtMs: Date.now(), status: 'prepared',
    target: {
      flow: data.flow, receiptAssetId: receipt.id, figureIds, dropId: data.runtime.dropId, network: data.network,
      programId: data.runtime.boxMinterProgramId.toBase58(), collectionMint: data.runtime.collectionMint.toBase58(),
      receiptsMerkleTree: data.runtime.receiptsMerkleTree.toBase58(), adminWallet,
    },
  };
}

export async function broadcastReceiptClaimWorkflowTransaction(args: ReceiptClaimWorkflowOnchainArgs): Promise<void> {
  const snapshot = await freshSnapshot(args);
  if (snapshot.operation.phase === 'complete') return;
  const submission = snapshot.operation.submission;
  if (!submission) throw new StripeReceiptClaimError('failed-precondition', 'Receipt claim submission is not persisted.');
  if (submission.status !== 'prepared') return;
  const data = resources(args, snapshot);
  const raw = Buffer.from(submission.signedTransactionBase64, 'base64');
  const transaction = VersionedTransaction.deserialize(raw);
  if (bs58.encode(transaction.signatures[0]) !== submission.signature || transaction.message.recentBlockhash !== submission.blockhash ||
    transaction.message.staticAccountKeys[0]?.toBase58() !== submission.target.adminWallet) {
    throw new StripeReceiptClaimError('failed-precondition', 'Stored receipt claim transaction is invalid.');
  }
  const height = await data.connection.getBlockHeight('confirmed');
  if (height > submission.lastValidBlockHeight) return;
  const fenced = await freshSnapshot(args);
  if (fenced.operation.phase !== 'pending' || fenced.operation.submission?.signature !== submission.signature || fenced.operation.submission.status !== 'prepared') return;
  try {
    const signature = await data.connection.sendRawTransaction(raw, { maxRetries: 0 });
    if (signature !== submission.signature) throw new Error('Unexpected transaction signature');
  } catch {
    args.signal.throwIfAborted();
  }
}
