import {
  AddressLookupTableAccount,
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import bs58 from 'bs58';
import { MPL_CORE_PROGRAM_ADDRESS, SPL_NOOP_PROGRAM_ADDRESS } from '../../../../shared/solanaProgramAddresses.js';
import {
  PendingFinalizeSubmissionError,
  rethrowAdminIrlRedeemFinalizeCancellation as rethrowFinalizeCancellation,
  summarizeAdminIrlRedeemFinalizeError as summarizeError,
} from './adminIrlRedeemErrors.js';
import { requestKey } from './adminIrlRedeemFinalizeRequest.js';
import { executePendingFinalizeSubmission, isTombstone, receiptBatchConfirmedByPostState } from './adminIrlRedeemFinalizeSubmission.js';
import type { CommerceContext, OnchainConfig, Runtime } from './adminIrlRedeemFinalizeTypes.js';
import { AdminIrlRedeemFinalizeError } from './adminIrlRedeemFinalizeWorkflowState.js';
import type { ProviderContext } from './adminIrlRedeemOnchain.js';
import {
  MAX_DELIVERY_ALLOCATION_ATTEMPTS,
  normalizeReceiptTxs,
  type InternalDelivery,
  type PendingFinalizeSubmission,
  type RequestItem,
  type StartedRequest,
} from './adminIrlRedeemRequestState.js';
import { recordCloseDelivery, recordInternalDelivery } from './adminIrlRedeemRequestStore.js';
import { sleepWithSignal } from './boundedRequest.js';
import { encodeDeliverInstruction } from './deliveryProtocol.js';
import { secureRandomInt } from './deliveryRandom.js';
import {
  buildTransaction as buildDeliveryTransaction,
  closeDeliveryInstruction,
  deriveDeliveryPda,
  mintReceiptsInstruction,
  sendAndConfirmSignedTransaction,
} from './deliveryReceiptOnchain.js';

const SOLANA_MAX_RAW_TX_BYTES = 1232;

const DUMMY_BLOCKHASH = '11111111111111111111111111111111';

const MPL_CORE_PROGRAM_ID = new PublicKey(MPL_CORE_PROGRAM_ADDRESS);

const SPL_NOOP_PROGRAM_ID = new PublicKey(SPL_NOOP_PROGRAM_ADDRESS);

function mplCoreBurn(asset: PublicKey, collection: PublicKey, signer: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    programId: MPL_CORE_PROGRAM_ID,
    keys: [
      { pubkey: asset, isSigner: false, isWritable: true },
      { pubkey: collection, isSigner: false, isWritable: true },
      { pubkey: signer, isSigner: true, isWritable: true },
      { pubkey: signer, isSigner: true, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: SPL_NOOP_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([12, 0]),
  });
}

export async function mintPackReceipts(
  connection: Connection,
  provider: ProviderContext,
  runtime: Runtime,
  signer: Keypair,
  collection: PublicKey,
  items: RequestItem[],
  commerce: CommerceContext,
  path: string,
  attemptId: string,
  existing: string[],
): Promise<string[]> {
  const keys = items.map((item) => new PublicKey(item.assetId));
  const infos = await connection.getMultipleAccountsInfo(keys, { commitment: 'confirmed', dataSlice: { offset: 0, length: 2 } });
  const pending = items.map((item, index) => ({ ...item, asset: keys[index], account: infos[index] }))
    .filter((item) => !isTombstone(item.account));
  const receiptTxs = normalizeReceiptTxs(existing);
  while (pending.length) {
    let batchSize = Math.min(3, pending.length);
    let lastError: unknown;
    while (batchSize >= 1) {
      const batch = pending.slice(0, batchSize);
      const instructions = [
        ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
        ...batch.map((item) => mplCoreBurn(item.asset, collection, signer.publicKey)),
        mintReceiptsInstruction({
          runtime,
          signer: signer.publicKey,
          recipient: signer.publicKey,
          coreCollection: collection,
          boxIds: batch.map((item) => item.refId),
          dudeIds: [],
        }),
      ];
      let completed = false;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        if (commerce.signal.aborted) throw commerce.signal.reason;
        try {
          const { blockhash } = (await connection.getLatestBlockhashAndContext('confirmed')).value;
          const transaction = buildDeliveryTransaction(instructions, signer.publicKey, blockhash, signer);
          if (transaction.serialize().length > SOLANA_MAX_RAW_TX_BYTES) throw new RangeError('transaction too large');
          const signature = bs58.encode(transaction.signatures[0]);
          const pendingSubmission: PendingFinalizeSubmission = {
            kind: 'receipt_mint',
            signature,
            blockhash,
            assetIds: batch.map((item) => item.asset.toBase58()),
          };
          await executePendingFinalizeSubmission({
            commerce,
            provider,
            runtime,
            path,
            attemptId,
            pending: pendingSubmission,
            connection,
            transaction,
            label: 'Admin IRL receipt mint',
          });
          if (!receiptTxs.includes(signature)) receiptTxs.push(signature);
          pending.splice(0, batchSize);
          completed = true;
          break;
        } catch (error) {
          if (error instanceof PendingFinalizeSubmissionError) throw error;
          rethrowFinalizeCancellation(commerce.signal, error);
          lastError = error;
          if (await receiptBatchConfirmedByPostState(
            error,
            connection,
            batch.map((item) => item.asset),
          )) {
            pending.splice(0, batchSize);
            completed = true;
            break;
          }
          if (attempt < 2) await sleepWithSignal(Math.min(4_000, 600 * 2 ** attempt), commerce.signal);
        }
      }
      if (completed) break;
      batchSize -= 1;
    }
    if (batchSize < 1) {
      throw new AdminIrlRedeemFinalizeError('failed-precondition', 'Unable to mint Admin IRL redeem pack receipts.', {
        lastError: lastError instanceof Error ? lastError.message : String(lastError),
      });
    }
  }
  return receiptTxs;
}

async function buildTransactionWithLookupTables(
  instructions: TransactionInstruction[],
  signer: Keypair,
  blockhash: string,
  lookupTables: AddressLookupTableAccount[],
): Promise<VersionedTransaction> {
  const transaction = new VersionedTransaction(new TransactionMessage({
    payerKey: signer.publicKey,
    recentBlockhash: blockhash,
    instructions,
  }).compileToV0Message(lookupTables));
  transaction.sign([signer]);
  return transaction;
}

export async function ensureInternalDelivery(
  connection: Connection,
  provider: ProviderContext,
  runtime: Runtime,
  signer: Keypair,
  onchain: OnchainConfig,
  commerce: CommerceContext,
  path: string,
  attemptId: string,
  request: StartedRequest,
): Promise<InternalDelivery> {
  let lookupTables: AddressLookupTableAccount[] = [];
  if (runtime.deliveryLookupTable) {
    const lookup = await connection.getAddressLookupTable(runtime.deliveryLookupTable).catch(() => null);
    if (lookup?.value?.isActive()) lookupTables = [lookup.value];
  }
  const assets = request.items.map((item) => new PublicKey(item.assetId));
  const send = async (deliveryId: number, deliveryPda: PublicKey, bump: number): Promise<InternalDelivery> => {
    if (request.internalDeliveryTx) return { deliveryId, deliveryPda: deliveryPda.toBase58(), deliveryTx: request.internalDeliveryTx };
    const existing = (await connection.getAccountInfoAndContext(deliveryPda, { commitment: 'confirmed', dataSlice: { offset: 0, length: 0 } })).value;
    if (existing) return { deliveryId, deliveryPda: deliveryPda.toBase58(), deliveryTx: null };
    const instruction = new TransactionInstruction({
      programId: runtime.boxMinterProgramId,
      keys: [
        { pubkey: runtime.boxMinterConfigPda, isSigner: false, isWritable: false },
        { pubkey: signer.publicKey, isSigner: true, isWritable: false },
        { pubkey: signer.publicKey, isSigner: true, isWritable: true },
        { pubkey: new PublicKey(onchain.decoded.treasury), isSigner: false, isWritable: true },
        { pubkey: onchain.coreCollection, isSigner: false, isWritable: false },
        { pubkey: MPL_CORE_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: SPL_NOOP_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: deliveryPda, isSigner: false, isWritable: true },
        ...assets.map((asset) => ({ pubkey: asset, isSigner: false, isWritable: true })),
      ],
      data: encodeDeliverInstruction(deliveryId, 0n, bump),
    });
    const instructions = [ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }), instruction];
    const sized = await buildTransactionWithLookupTables(instructions, signer, DUMMY_BLOCKHASH, lookupTables);
    if (sized.serialize().length > SOLANA_MAX_RAW_TX_BYTES) {
      throw new AdminIrlRedeemFinalizeError('failed-precondition', 'Admin IRL internal delivery transaction is too large. Try fewer packs.');
    }
    const { blockhash } = (await connection.getLatestBlockhashAndContext('confirmed')).value;
    const transaction = await buildTransactionWithLookupTables(instructions, signer, blockhash, lookupTables);
    const signature = bs58.encode(transaction.signatures[0]);
    const pendingSubmission: PendingFinalizeSubmission = {
      kind: 'internal_delivery',
      signature,
      blockhash,
      deliveryId,
      deliveryPda: deliveryPda.toBase58(),
    };
    await executePendingFinalizeSubmission({
      commerce,
      provider,
      runtime,
      path,
      attemptId,
      pending: pendingSubmission,
      connection,
      transaction,
      label: 'Admin IRL internal delivery',
    });
    const result = { deliveryId, deliveryPda: deliveryPda.toBase58(), deliveryTx: signature };
    return result;
  };
  if (request.internalDeliveryId && request.internalDeliveryPda) {
    const [pda, bump] = deriveDeliveryPda(runtime, request.internalDeliveryId);
    if (pda.toBase58() !== request.internalDeliveryPda) {
      throw new AdminIrlRedeemFinalizeError('failed-precondition', 'Stored Admin IRL internal delivery PDA does not match delivery id.');
    }
    return send(request.internalDeliveryId, pda, bump);
  }
  for (let attempt = 0; attempt < MAX_DELIVERY_ALLOCATION_ATTEMPTS; attempt += 1) {
    const deliveryId = secureRandomInt(2 ** 31 - 1) + 1;
    const [pda, bump] = deriveDeliveryPda(runtime, deliveryId);
    if ((await connection.getAccountInfoAndContext(pda, { commitment: 'confirmed', dataSlice: { offset: 0, length: 0 } })).value) continue;
    await recordInternalDelivery(commerce, requestKey(path), attemptId, { deliveryId, deliveryPda: pda.toBase58() });
    return send(deliveryId, pda, bump);
  }
  throw new AdminIrlRedeemFinalizeError('unavailable', 'Failed to allocate hidden Admin IRL delivery id.');
}

export async function closeInternalDelivery(
  connection: Connection,
  runtime: Runtime,
  signer: Keypair,
  commerce: CommerceContext,
  path: string,
  attemptId: string,
  request: StartedRequest,
  internal: InternalDelivery,
): Promise<string | null> {
  try {
    if (request.closeDeliveryTx) return request.closeDeliveryTx;
    const [pda, bump] = deriveDeliveryPda(runtime, internal.deliveryId);
    if (!(await connection.getAccountInfoAndContext(pda, { commitment: 'confirmed', dataSlice: { offset: 0, length: 0 } })).value) return null;
    const { blockhash } = (await connection.getLatestBlockhashAndContext('confirmed')).value;
    const transaction = buildDeliveryTransaction([
      ComputeBudgetProgram.setComputeUnitLimit({ units: 250_000 }),
      closeDeliveryInstruction({
        runtime,
        signer: signer.publicKey,
        deliveryPda: pda,
        deliveryId: internal.deliveryId,
        deliveryBump: bump,
      }),
    ], signer.publicKey, blockhash, signer);
    const signature = await sendAndConfirmSignedTransaction(
      connection,
      transaction,
      commerce.signal,
      'Admin IRL internal delivery close',
    );
    await recordCloseDelivery(commerce, requestKey(path), attemptId, signature);
    return signature;
  } catch (error) {
    console.warn({
      event: 'admin_irl_redeem_internal_delivery_close_failed',
      dropId: runtime.dropId,
      requestId: request.requestId,
      deliveryId: internal.deliveryId,
      error: summarizeError(error),
    });
    return null;
  }
}
