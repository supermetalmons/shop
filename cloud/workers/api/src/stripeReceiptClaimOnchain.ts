import bs58 from 'bs58';
import {
  AddressLookupTableAccount,
  Connection,
  Keypair,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import { bubblegumBurnV2Ix, bubblegumTransferV2Ix } from './bubblegum.js';
import {
  adminIrlCardReceiptProofHasIdentity,
  classifyDirectCardReceiptClaimSubmission,
  classifyDirectCardReceiptClaimTransferVerificationError,
  type DirectCardReceiptClaimSubmission,
  type DirectCardReceiptClaimTransferEvidence,
} from './adminIrlCardReceipt.js';
import { getApiDrop } from './dropConfig.js';
import {
  assetMatchesReceiptDropIdentity,
  assetMatchesReceiptMetadataIdentity,
  receiptMetadataReference,
} from './receiptProof.js';
import {
  bubblegumReceiptAssetIds,
  matchingReceiptTransferCount,
  transactionAccountKeys,
} from './receiptTransferVerification.js';
import { dasAssetLooksBurntOrClosed, type DasAsset } from '../../../../shared/dasAsset.js';
import { HELIUS_COLLECTION_GROUPING_OPTIONS } from '../../../../shared/dasAssetCollections.js';
import { heliusSearchAssetsHasNextPage, heliusSearchAssetsItems } from '../../../../shared/heliusDas.js';
import { BOX_MINTER_MIN_OPENABLE_ITEMS_PER_BOX } from '../../../../shared/boxMinterProtocol.js';
import {
  BUBBLEGUM_PROGRAM_ADDRESS,
  MPL_ACCOUNT_COMPRESSION_PROGRAM_ADDRESS,
  MPL_CORE_CPI_SIGNER_ADDRESS,
  MPL_CORE_PROGRAM_ADDRESS,
  MPL_NOOP_PROGRAM_ADDRESS,
} from '../../../../shared/solanaProgramAddresses.js';
import { stripeAssignedIrlClaimForBox, type StripeAssignedIrlClaim } from '../../../../shared/stripeReceiptClaims.js';
import { isRecord } from './dataAccess.js';
import { normalizeReceiptTxs, type StartedClaim } from './stripeReceiptClaimStore.js';
import { StripeReceiptClaimError, normalizeStripeReceiptClaimError as normalizedError } from './stripeReceiptClaimErrors.js';
import {
  buildRuntime as buildAdminIrlRedeemRuntime,
  fetchAsset as fetchAdminIrlRedeemAsset,
  fetchAssetProof as fetchAdminIrlRedeemAssetProof,
  loadLookupTable as loadAdminIrlRedeemLookupTable,
  parseProof as parseAdminIrlRedeemProof,
  receiptDropIdentity as adminIrlRedeemReceiptDropIdentity,
  rpcCall as adminIrlRedeemRpcCall,
  type ProviderContext,
} from './adminIrlRedeemOnchain.js';
import { createConnection as createDeliveryConnection } from './deliveryReceiptOnchain.js';
import { buildSizedTransaction, SOLANA_MAX_RAW_TX_BYTES } from './solanaTransaction.js';

const HELIUS_ASSETS_PAGE_LIMIT = 1000;

const HELIUS_ASSETS_MAX_SEARCH_PAGES = 64;

const BURN_POLICY = { missingAssetResult: true, nonBooleanFlagIsBurnt: false } as const;

const BUBBLEGUM_PROGRAM_ID = new PublicKey(BUBBLEGUM_PROGRAM_ADDRESS);

const MPL_NOOP_PROGRAM_ID = new PublicKey(MPL_NOOP_PROGRAM_ADDRESS);

const MPL_ACCOUNT_COMPRESSION_PROGRAM_ID = new PublicKey(MPL_ACCOUNT_COMPRESSION_PROGRAM_ADDRESS);

const MPL_CORE_PROGRAM_ID = new PublicKey(MPL_CORE_PROGRAM_ADDRESS);

const MPL_CORE_CPI_SIGNER = new PublicKey(MPL_CORE_CPI_SIGNER_ADDRESS);

type Runtime = ReturnType<typeof buildAdminIrlRedeemRuntime>;

type ClaimFlow = 'direct_figure' | 'openable_pack' | 'legacy_pack';

export function runtimeForDrop(dropId: string): Runtime {
  const config = getApiDrop(dropId);
  if (!config) throw new StripeReceiptClaimError('failed-precondition', 'Claim code has an unsupported drop id.');
  try {
    return buildAdminIrlRedeemRuntime(config);
  } catch (error) {
    throw normalizedError(error, 'Receipt claim drop configuration is invalid.');
  }
}

export function createConnection(provider: ProviderContext, runtime: Runtime): Connection {
  return createDeliveryConnection({
    apiKey: provider.apiKey,
    fetch: provider.providerFetch,
    signal: provider.signal,
  }, runtime);
}

export async function fetchAsset(provider: ProviderContext, runtime: Runtime, assetId: string): Promise<DasAsset> {
  try {
    return await fetchAdminIrlRedeemAsset(provider, runtime, assetId);
  } catch (error) {
    throw normalizedError(error, 'Receipt claim provider is temporarily unavailable.');
  }
}

export async function fetchAssetProof(
  provider: ProviderContext,
  runtime: Runtime,
  assetId: string,
): Promise<Record<string, unknown>> {
  try {
    const proof = await fetchAdminIrlRedeemAssetProof(provider, runtime, assetId);
    if (!adminIrlCardReceiptProofHasIdentity(proof) || !Array.isArray(proof.proof)) {
      throw new StripeReceiptClaimError('unavailable', 'Receipt proof is temporarily unavailable.');
    }
    return proof;
  } catch (error) {
    const failure = normalizedError(error, 'Receipt claim provider is temporarily unavailable.');
    if (failure.code === 'not-found') {
      throw new StripeReceiptClaimError('unavailable', 'Receipt proof is temporarily unavailable.', undefined, failure);
    }
    throw failure;
  }
}

async function scanOwnedAssetPages(args: {
  provider: ProviderContext;
  runtime: Runtime;
  owner: string;
  grouping?: readonly [string, string];
  visitPage: (items: DasAsset[]) => boolean | Promise<boolean>;
}): Promise<{ sawItems: boolean; stopped: boolean }> {
  let sawItems = false;
  for (let page = 1; page <= HELIUS_ASSETS_MAX_SEARCH_PAGES; page += 1) {
    let result: unknown;
    try {
      result = await adminIrlRedeemRpcCall(args.provider, args.runtime, 'searchAssets', {
        ownerAddress: args.owner,
        page,
        limit: HELIUS_ASSETS_PAGE_LIMIT,
        options: HELIUS_COLLECTION_GROUPING_OPTIONS,
        ...(args.grouping ? { grouping: args.grouping } : {}),
      });
    } catch (error) {
      throw normalizedError(error, 'Receipt claim provider is temporarily unavailable.');
    }
    const items = heliusSearchAssetsItems(result).filter(isRecord) as DasAsset[];
    sawItems ||= items.length > 0;
    if (await args.visitPage(items)) return { sawItems, stopped: true };
    if (!heliusSearchAssetsHasNextPage(result, page, items, HELIUS_ASSETS_PAGE_LIMIT)) {
      return { sawItems, stopped: false };
    }
  }
  throw new StripeReceiptClaimError('unavailable', 'Too many assets to search for receipt; try again or contact support.', {
    dropId: args.runtime.dropId,
    maxPages: HELIUS_ASSETS_MAX_SEARCH_PAGES,
  });
}

async function findOwnedAsset(args: {
  provider: ProviderContext;
  runtime: Runtime;
  owner: string;
  grouping?: readonly [string, string];
  matches: (asset: DasAsset) => boolean | Promise<boolean>;
}): Promise<{ asset: DasAsset | null; sawItems: boolean }> {
  let asset: DasAsset | null = null;
  const scan = await scanOwnedAssetPages({
    provider: args.provider,
    runtime: args.runtime,
    owner: args.owner,
    grouping: args.grouping,
    visitPage: async (items) => {
      for (const candidate of items) {
        if (!(await args.matches(candidate))) continue;
        asset = candidate;
        return true;
      }
      return false;
    },
  });
  return { asset, sawItems: scan.sawItems };
}

function looksBurntOrClosed(asset: DasAsset): boolean {
  return dasAssetLooksBurntOrClosed(asset, BURN_POLICY);
}

function assetOwner(asset: DasAsset): string {
  return isRecord(asset.ownership) && typeof asset.ownership.owner === 'string'
    ? asset.ownership.owner
    : '';
}

function receiptIdentity(runtime: Runtime) {
  return adminIrlRedeemReceiptDropIdentity(runtime);
}

export async function proofMatches(
  provider: ProviderContext,
  runtime: Runtime,
  asset: DasAsset,
  expected: { kind: 'box' | 'figure'; id: number },
): Promise<boolean> {
  const assetId = typeof asset.id === 'string' ? asset.id.trim() : '';
  if (!assetId) return false;
  const proof = await fetchAssetProof(provider, runtime, assetId);
  return assetMatchesReceiptDropIdentity(asset, proof, receiptIdentity(runtime), expected);
}

export async function findPackReceipt(
  provider: ProviderContext,
  owner: string,
  runtime: Runtime,
  boxId: number,
): Promise<DasAsset | null> {
  const matches = async (asset: DasAsset) =>
    !looksBurntOrClosed(asset) &&
    assetOwner(asset) === owner &&
    assetMatchesReceiptMetadataIdentity(asset, receiptIdentity(runtime), { kind: 'box', id: boxId }) &&
    await proofMatches(provider, runtime, asset, { kind: 'box', id: boxId });
  const grouping = ['collection', runtime.collectionMint.toBase58()] as const;
  const grouped = await findOwnedAsset({ provider, runtime, owner, grouping, matches });
  if (grouped.asset) return grouped.asset;
  return (await findOwnedAsset({ provider, runtime, owner, matches })).asset;
}

export async function findPackReceiptById(
  provider: ProviderContext,
  owner: string,
  runtime: Runtime,
  boxId: number,
  assetId: string,
): Promise<DasAsset | null> {
  let asset: DasAsset;
  try {
    asset = await fetchAsset(provider, runtime, assetId);
  } catch (error) {
    if (normalizedError(error, '').code === 'not-found') return null;
    throw error;
  }
  if (looksBurntOrClosed(asset) || assetOwner(asset) !== owner) return null;
  if (!assetMatchesReceiptMetadataIdentity(asset, receiptIdentity(runtime), { kind: 'box', id: boxId })) {
    throw new StripeReceiptClaimError('failed-precondition', 'Receipt claim is not ready yet; assigned pack receipt belongs to a different drop.');
  }
  if (!(await proofMatches(provider, runtime, asset, { kind: 'box', id: boxId }))) {
    throw new StripeReceiptClaimError('failed-precondition', 'Receipt claim is not ready yet; assigned pack receipt proof belongs to a different drop.');
  }
  return asset;
}

export async function findFigureReceiptById(
  provider: ProviderContext,
  owner: string,
  runtime: Runtime,
  figureId: number,
  assetId: string,
): Promise<DasAsset | null> {
  let asset: DasAsset;
  try {
    asset = await fetchAsset(provider, runtime, assetId);
  } catch (error) {
    if (normalizedError(error, '').code === 'not-found') return null;
    throw error;
  }
  if (looksBurntOrClosed(asset) || assetOwner(asset) !== owner) return null;
  if (!assetMatchesReceiptMetadataIdentity(asset, receiptIdentity(runtime), { kind: 'figure', id: figureId })) {
    throw new StripeReceiptClaimError('failed-precondition', 'Direct card receipt claim target belongs to a different drop.');
  }
  const proof = await fetchAssetProof(provider, runtime, assetId);
  if (!assetMatchesReceiptDropIdentity(asset, proof, receiptIdentity(runtime), { kind: 'figure', id: figureId })) {
    throw new StripeReceiptClaimError('failed-precondition', 'Direct card receipt claim proof belongs to a different drop.');
  }
  try {
    parseAdminIrlRedeemProof(asset, proof, runtime, owner);
  } catch (error) {
    throw normalizedError(error, 'Direct card receipt claim proof is invalid.');
  }
  return asset;
}

async function findOwnedFigureIds(
  provider: ProviderContext,
  owner: string,
  runtime: Runtime,
  figureIds: number[],
): Promise<Set<number>> {
  const expected = new Set(figureIds);
  const found = new Set<number>();
  const checked = new Set<string>();
  const visitPage = async (items: DasAsset[]) => {
    const candidates: Array<{ asset: DasAsset; figureId: number }> = [];
    for (const asset of items) {
      if (looksBurntOrClosed(asset) || assetOwner(asset) !== owner) continue;
      const reference = receiptMetadataReference(asset);
      if (!reference || reference.kind !== 'figure' || !expected.has(reference.id) || found.has(reference.id)) continue;
      if (!assetMatchesReceiptMetadataIdentity(asset, receiptIdentity(runtime), reference)) continue;
      const assetId = typeof asset.id === 'string' ? asset.id.trim() : '';
      if (!assetId || checked.has(assetId)) continue;
      checked.add(assetId);
      candidates.push({ asset, figureId: reference.id });
    }
    for (let index = 0; index < candidates.length; index += 4) {
      const results = await Promise.all(candidates.slice(index, index + 4).map(async (candidate) => ({
        ...candidate,
        matches: await proofMatches(provider, runtime, candidate.asset, { kind: 'figure', id: candidate.figureId }),
      })));
      for (const result of results) if (result.matches) found.add(result.figureId);
      if (found.size === expected.size) return true;
    }
    return found.size === expected.size;
  };
  const grouping = ['collection', runtime.collectionMint.toBase58()] as const;
  const grouped = await scanOwnedAssetPages({ provider, runtime, owner, grouping, visitPage });
  if (!grouped.stopped) await scanOwnedAssetPages({ provider, runtime, owner, visitPage });
  return found;
}

export async function ownsAllFigureReceipts(
  provider: ProviderContext,
  owner: string,
  runtime: Runtime,
  figureIds: number[],
): Promise<boolean> {
  const owned = await findOwnedFigureIds(provider, owner, runtime, figureIds);
  return figureIds.every((figureId) => owned.has(figureId));
}

async function verifyDirectTransfer(args: {
  connection: Connection;
  runtime: Runtime;
  signature: string;
  fromWallet: string;
  toWallet: string;
  coreCollection: PublicKey;
  receiptAssetId: string;
}): Promise<void> {
  const transaction = await args.connection.getTransaction(args.signature, { maxSupportedTransactionVersion: 0 });
  if (!transaction) throw new StripeReceiptClaimError('unavailable', 'Card receipt transfer transaction not found yet; retry shortly.');
  if (transaction.meta?.err) {
    throw new StripeReceiptClaimError('failed-precondition', 'Card receipt transfer transaction failed.', { err: transaction.meta.err });
  }
  const keys = transactionAccountKeys(transaction);
  if (keys[0]?.toBase58() !== args.fromWallet) {
    throw new StripeReceiptClaimError('failed-precondition', 'Card receipt transfer payer does not match sender.');
  }
  const matches = matchingReceiptTransferCount(transaction, {
    sender: args.fromWallet,
    recipient: args.toWallet,
    collection: args.coreCollection,
    merkleTree: args.runtime.receiptsMerkleTree,
  });
  if (matches !== 1) {
    throw new StripeReceiptClaimError('failed-precondition', 'Card receipt transfer instruction mismatch.', { expected: 1, got: matches });
  }
  const assetIds = bubblegumReceiptAssetIds(transaction);
  if (assetIds.length !== 1 || assetIds[0] !== args.receiptAssetId) {
    throw new StripeReceiptClaimError('failed-precondition', 'Card receipt transfer asset mismatch.', {
      expected: args.receiptAssetId,
      got: assetIds,
    });
  }
}

async function inspectSubmission(
  connection: Connection,
  signature: string,
  submission: DirectCardReceiptClaimSubmission,
): Promise<Extract<DirectCardReceiptClaimTransferEvidence, 'rejected' | 'expired_unverified' | 'unresolved'>> {
  const statuses = await connection.getSignatureStatuses([signature], { searchTransactionHistory: true });
  const status = statuses.value[0];
  const signatureStatus = status?.err ? 'failed' : status ? 'succeeded' : 'missing';
  const currentBlockHeight = signatureStatus === 'missing' ? await connection.getBlockHeight('confirmed') : 0;
  const evidence = classifyDirectCardReceiptClaimSubmission({
    signatureStatus,
    currentBlockHeight,
    lastValidBlockHeight: submission.lastValidBlockHeight,
    submittedAtMs: submission.submittedAtMs,
    nowMs: Date.now(),
  });
  return evidence === 'not_landed' ? 'rejected' : evidence;
}

export async function inspectPersistedTransfers(args: {
  connection: Connection;
  runtime: Runtime;
  signatures: string[];
  submissions: DirectCardReceiptClaimSubmission[];
  adminWallet: string;
  recipientWallet: string;
  coreCollection: PublicKey;
  receiptAssetId: string;
}): Promise<{
  evidence: DirectCardReceiptClaimTransferEvidence;
  signature: string | null;
  terminalSubmissions: DirectCardReceiptClaimSubmission[];
}> {
  const signatures = Array.from(new Set(normalizeReceiptTxs(args.signatures))).reverse();
  if (!signatures.length) return { evidence: 'none', signature: null, terminalSubmissions: [] };
  const submissions = new Map(args.submissions.map((submission) => [submission.signature, submission]));
  let sawUnresolved = false;
  let sawExpired = false;
  const terminalSubmissions: DirectCardReceiptClaimSubmission[] = [];
  for (const signature of signatures) {
    const submission = submissions.get(signature);
    if (submission?.status === 'not_landed') continue;
    try {
      await verifyDirectTransfer({
        connection: args.connection,
        runtime: args.runtime,
        signature,
        fromWallet: args.adminWallet,
        toWallet: args.recipientWallet,
        coreCollection: args.coreCollection,
        receiptAssetId: args.receiptAssetId,
      });
      return { evidence: 'verified', signature, terminalSubmissions };
    } catch (error) {
      let evidence: Extract<DirectCardReceiptClaimTransferEvidence, 'rejected' | 'expired_unverified' | 'unresolved'> =
        classifyDirectCardReceiptClaimTransferVerificationError(error);
      if (evidence === 'unresolved' && submission) {
        try { evidence = await inspectSubmission(args.connection, signature, submission); }
        catch { evidence = 'unresolved'; }
      }
      if (evidence === 'rejected' && submission) terminalSubmissions.push({ ...submission, status: 'not_landed' });
      sawUnresolved ||= evidence === 'unresolved';
      sawExpired ||= evidence === 'expired_unverified';
    }
  }
  return {
    evidence: sawUnresolved ? 'unresolved' : sawExpired ? 'expired_unverified' : 'rejected',
    signature: null,
    terminalSubmissions,
  };
}

function deriveTreeConfig(merkleTree: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([merkleTree.toBuffer()], BUBBLEGUM_PROGRAM_ID)[0];
}

export function buildTransaction(
  instructions: TransactionInstruction[],
  signer: Keypair,
  blockhash: string,
  lookupTables: AddressLookupTableAccount[] = [],
): VersionedTransaction {
  const transaction = new VersionedTransaction(new TransactionMessage({
    payerKey: signer.publicKey,
    recentBlockhash: blockhash,
    instructions,
  }).compileToV0Message(lookupTables));
  transaction.sign([signer]);
  return transaction;
}

export async function buildWithOptionalLookupTable(args: {
  provider: ProviderContext;
  runtime: Runtime;
  build: (lookupTables: AddressLookupTableAccount[]) => VersionedTransaction;
  encodeTooLargeMessage: string;
  packetTooLargeMessage: (rawBytes: number) => string;
}): Promise<VersionedTransaction> {
  const { transaction } = await buildSizedTransaction({
    build: args.build,
    loadLookupTables: () => loadAdminIrlRedeemLookupTable(args.provider, args.runtime),
    signal: args.provider.signal,
    encodingError: () => new StripeReceiptClaimError('failed-precondition', args.encodeTooLargeMessage),
    packetSizeError: (rawBytes) => new StripeReceiptClaimError(
      'failed-precondition',
      args.packetTooLargeMessage(rawBytes),
      { rawBytes, maxRawBytes: SOLANA_MAX_RAW_TX_BYTES },
    ),
  });
  return transaction;
}

export function signedTransactionSignature(transaction: VersionedTransaction): string {
  return bs58.encode(transaction.signatures[0]);
}

export function transferInstruction(args: {
  proof: ReturnType<typeof parseAdminIrlRedeemProof>;
  owner: PublicKey;
  recipient: PublicKey;
  coreCollection: PublicKey;
}): TransactionInstruction {
  return bubblegumTransferV2Ix({
    bubblegumProgramId: BUBBLEGUM_PROGRAM_ID,
    mplNoopProgramId: MPL_NOOP_PROGRAM_ID,
    mplAccountCompressionProgramId: MPL_ACCOUNT_COMPRESSION_PROGRAM_ID,
    treeConfig: deriveTreeConfig(args.proof.merkleTree),
    payer: args.owner,
    authority: args.owner,
    leafOwner: args.proof.leafOwner,
    leafDelegate: args.proof.leafDelegate,
    newLeafOwner: args.recipient,
    merkleTree: args.proof.merkleTree,
    coreCollection: args.coreCollection,
    root: args.proof.root,
    dataHash: args.proof.dataHash,
    creatorHash: args.proof.creatorHash,
    assetDataHash: args.proof.assetDataHash,
    flags: args.proof.flags,
    nonce: args.proof.nonce,
    index: args.proof.index,
    proof: args.proof.proofAccounts,
  });
}

export function burnInstruction(args: {
  proof: ReturnType<typeof parseAdminIrlRedeemProof>;
  owner: PublicKey;
  coreCollection: PublicKey;
}): TransactionInstruction {
  return bubblegumBurnV2Ix({
    bubblegumProgramId: BUBBLEGUM_PROGRAM_ID,
    mplNoopProgramId: MPL_NOOP_PROGRAM_ID,
    mplAccountCompressionProgramId: MPL_ACCOUNT_COMPRESSION_PROGRAM_ID,
    mplCoreProgramId: MPL_CORE_PROGRAM_ID,
    mplCoreCpiSigner: MPL_CORE_CPI_SIGNER,
    treeConfig: deriveTreeConfig(args.proof.merkleTree),
    payer: args.owner,
    authority: args.owner,
    leafOwner: args.proof.leafOwner,
    leafDelegate: args.proof.leafDelegate,
    merkleTree: args.proof.merkleTree,
    coreCollection: args.coreCollection,
    root: args.proof.root,
    dataHash: args.proof.dataHash,
    creatorHash: args.proof.creatorHash,
    assetDataHash: args.proof.assetDataHash,
    flags: args.proof.flags,
    nonce: args.proof.nonce,
    index: args.proof.index,
    proof: args.proof.proofAccounts,
  });
}

export function proofForAsset(
  asset: DasAsset,
  proof: Record<string, unknown>,
  runtime: Runtime,
  owner: string,
): ReturnType<typeof parseAdminIrlRedeemProof> {
  try { return parseAdminIrlRedeemProof(asset, proof, runtime, owner); }
  catch (error) { throw normalizedError(error, 'Receipt proof is invalid.'); }
}

export function requireOpenableAssignment(claims: unknown[], runtime: Runtime, boxId: number): StripeAssignedIrlClaim {
  try {
    const assignment = stripeAssignedIrlClaimForBox({ irlClaims: claims }, boxId, {
      itemsPerBox: runtime.itemsPerBox,
      maxDudeId: runtime.maxDudeId,
    });
    if (assignment) return assignment;
  } catch (error) {
    throw new StripeReceiptClaimError(
      'failed-precondition',
      error instanceof Error
        ? error.message.replace(/^Stripe (?:receipt|IRL) claim/, 'Receipt claim')
        : 'Receipt claim is not ready yet; assigned receipts are invalid.',
      { dropId: runtime.dropId, boxId },
    );
  }
  throw new StripeReceiptClaimError('failed-precondition', 'Receipt claim is not ready yet; assigned card receipts are missing.', {
    dropId: runtime.dropId,
    boxId,
  });
}

export function claimFlowFor(directFigureReceipt: StartedClaim['directFigureReceipt'], itemsPerBox: number): ClaimFlow {
  if (directFigureReceipt) return 'direct_figure';
  return itemsPerBox >= BOX_MINTER_MIN_OPENABLE_ITEMS_PER_BOX ? 'openable_pack' : 'legacy_pack';
}
