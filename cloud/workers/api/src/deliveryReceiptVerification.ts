import { decodeDeliverInstruction, hasDeliverDiscriminator } from './deliveryProtocol.js';
import { parseDeliveryOrderReceiptView, type DeliveryOrderReceiptView } from './deliveryOrderReceiptView.js';
import { Connection, PublicKey, type AccountInfo } from '@solana/web3.js';
import {
  createConnection,
  deriveDeliveryPda,
  type DeliveryRuntime,
  type ProviderContext,
} from './deliveryReceiptOnchain.js';
import { DeliveryReceiptError } from './deliveryReceiptErrors.js';
import { transactionAccountKeys } from './receiptTransferVerification.js';
import { CommerceDudeAssignmentError, normalizeCommerceDudeIds } from './commerceDudeAssignments.js';

const ACCOUNT_DELIVERY_RECORD = Buffer.from('2b0f869afad50393', 'hex');

type VerifiedReceiptIssuanceTarget = {
  verification: 'signature' | 'delivery_pda';
  signature: string | null;
  expectedDeliveryPda: PublicKey;
  expectedDeliveryBump: number;
  targetAssetIds: string[];
};

export function canonicalPublicKey(value: string, label: string): PublicKey {
  try {
    const key = new PublicKey(value);
    if (key.toBase58() !== value) throw new Error('non-canonical');
    return key;
  } catch {
    throw new DeliveryReceiptError('invalid-argument', `Invalid ${label}.`);
  }
}

export function normalizeAssignedDudeIds(
  value: unknown,
  runtime: DeliveryRuntime,
  boxAssetId: string,
): number[] {
  try {
    return normalizeCommerceDudeIds(value, runtime.itemsPerBox, runtime.maxDudeId, boxAssetId);
  } catch (error) {
    if (!(error instanceof CommerceDudeAssignmentError)) throw error;
    throw new DeliveryReceiptError('failed-precondition', 'Stored figure assignment is invalid.', { boxAssetId });
  }
}

function decodeDeliverArgs(data: Buffer): { deliveryId: number; feeLamports: number; deliveryBump: number } {
  const decoded = decodeDeliverInstruction(data);
  if (!decoded) {
    throw new DeliveryReceiptError('failed-precondition', 'Transaction has an invalid deliver instruction.');
  }
  const fee = decoded.feeLamports;
  if (fee > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new DeliveryReceiptError('failed-precondition', 'Delivery fee is too large.');
  }
  return {
    ...decoded,
    feeLamports: Number(fee),
  };
}

export function assertDeliverArgsMatchOrder(args: {
  decoded: ReturnType<typeof decodeDeliverArgs>;
  deliveryId: number;
  expectedDeliveryBump: number;
  order: DeliveryOrderReceiptView;
}): void {
  if (args.decoded.deliveryId !== args.deliveryId) {
    throw new DeliveryReceiptError('failed-precondition', 'Delivery id mismatch.', {
      reason: 'delivery_id_mismatch',
    });
  }
  if (args.decoded.deliveryBump !== args.expectedDeliveryBump) {
    throw new DeliveryReceiptError('failed-precondition', 'Delivery PDA bump mismatch.', {
      reason: 'delivery_bump_mismatch',
    });
  }
  if (args.decoded.feeLamports !== args.order.deliveryLamports) {
    throw new DeliveryReceiptError('failed-precondition', 'Delivery fee mismatch.', {
      reason: 'delivery_fee_mismatch',
    });
  }
}

export function decodeDeliveryRecord(data: Buffer): {
  payer: PublicKey;
  deliveryFeeLamports: number;
  itemCount: number;
} {
  if (data.length < 50 || !data.subarray(0, 8).equals(ACCOUNT_DELIVERY_RECORD)) {
    throw new DeliveryReceiptError('failed-precondition', 'Delivery record account data is invalid.');
  }
  const fee = data.readBigUInt64LE(40);
  if (fee > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new DeliveryReceiptError('failed-precondition', 'Delivery record fee is too large.');
  }
  return {
    payer: new PublicKey(data.subarray(8, 40)),
    deliveryFeeLamports: Number(fee),
    itemCount: data.readUInt16LE(48),
  };
}

async function fetchDeliveryRecord(
  connection: Connection,
  runtime: DeliveryRuntime,
  deliveryId: number,
  includeData = true,
): Promise<{
  expectedDeliveryPda: PublicKey;
  expectedDeliveryBump: number;
  deliveryInfo: AccountInfo<Buffer>;
} | null> {
  const [expectedDeliveryPda, expectedDeliveryBump] = deriveDeliveryPda(runtime, deliveryId);
  const deliveryInfo = (await connection.getAccountInfoAndContext(
    expectedDeliveryPda,
    includeData
      ? { commitment: 'confirmed' }
      : { commitment: 'confirmed', dataSlice: { offset: 0, length: 0 } },
  )).value;
  if (!deliveryInfo) return null;
  if (!deliveryInfo.owner.equals(runtime.boxMinterProgramId)) {
    throw new DeliveryReceiptError('failed-precondition', 'Delivery record PDA is owned by the wrong program.');
  }
  return { expectedDeliveryPda, expectedDeliveryBump, deliveryInfo };
}

function assertStoredDeliveryPda(order: DeliveryOrderReceiptView, expectedDeliveryPda: PublicKey): void {
  const stored = order.deliveryPda;
  if (stored && stored !== expectedDeliveryPda.toBase58()) {
    throw new DeliveryReceiptError('failed-precondition', 'Stored delivery PDA does not match the expected delivery PDA.');
  }
}

export function assertDeliveryPayers(
  ownerWallet: string,
  feePayer: PublicKey | undefined,
  deliveryPayer: PublicKey | undefined,
): void {
  if (!feePayer || feePayer.toBase58() !== ownerWallet) {
    throw new DeliveryReceiptError('failed-precondition', 'Transaction fee payer does not match owner.', {
      reason: 'payer_mismatch',
    });
  }
  if (!deliveryPayer || deliveryPayer.toBase58() !== ownerWallet) {
    throw new DeliveryReceiptError('failed-precondition', 'Delivery payer does not match owner.', {
      reason: 'payer_mismatch',
    });
  }
}

export async function verifyReceiptIssuanceBySignature(args: {
  connection: Connection;
  deliveryId: number;
  order: DeliveryOrderReceiptView;
  ownerWallet: string;
  runtime: DeliveryRuntime;
  signature: string;
}): Promise<VerifiedReceiptIssuanceTarget> {
  const transaction = await args.connection.getTransaction(args.signature, { maxSupportedTransactionVersion: 0 });
  if (!transaction || transaction.meta?.err) {
    throw new DeliveryReceiptError('failed-precondition', 'Delivery transaction not found or failed.', {
      reason: 'transaction_not_found_or_failed',
    });
  }
  const [expectedDeliveryPda, expectedDeliveryBump] = deriveDeliveryPda(args.runtime, args.deliveryId);
  const keys = transactionAccountKeys(transaction);
  const fixedAccountCount = 9;
  let deliverAccounts: PublicKey[] | undefined;
  let deliverData: Buffer | undefined;
  for (const instruction of transaction.transaction.message.compiledInstructions) {
    const program = keys[instruction.programIdIndex];
    if (!program?.equals(args.runtime.boxMinterProgramId)) continue;
    const data = Buffer.from(instruction.data);
    if (!hasDeliverDiscriminator(data)) continue;
    const accounts = Array.from(instruction.accountKeyIndexes).map((index) => keys[index]);
    if (accounts.length >= fixedAccountCount && accounts[8]?.equals(expectedDeliveryPda)) {
      deliverAccounts = accounts;
      deliverData = data;
      break;
    }
  }
  if (!deliverAccounts || !deliverData) {
    throw new DeliveryReceiptError(
      'failed-precondition',
      'Delivery transaction is missing a deliver instruction for the expected delivery PDA.',
      { reason: 'missing_target_deliver_instruction' },
    );
  }
  assertDeliveryPayers(
    args.ownerWallet,
    transaction.transaction.message.staticAccountKeys[0],
    deliverAccounts[2],
  );
  const decoded = decodeDeliverArgs(deliverData);
  assertDeliverArgsMatchOrder({
    decoded,
    deliveryId: args.deliveryId,
    expectedDeliveryBump,
    order: args.order,
  });
  const itemIds = args.order.itemIds;
  const deliveredAssets = deliverAccounts.slice(fixedAccountCount).map((key) => key.toBase58());
  if (itemIds.length && deliveredAssets.length && itemIds.length !== deliveredAssets.length) {
    throw new DeliveryReceiptError('failed-precondition', 'Delivery item count mismatch.', {
      reason: 'item_count_mismatch',
    });
  }
  if (itemIds.some((itemId, index) => deliveredAssets[index] && deliveredAssets[index] !== itemId)) {
    throw new DeliveryReceiptError('failed-precondition', 'Delivered asset list mismatch.', {
      reason: 'asset_list_mismatch',
    });
  }
  const targetAssetIds = itemIds.length ? itemIds : deliveredAssets;
  if (!targetAssetIds.length) {
    throw new DeliveryReceiptError('failed-precondition', 'Delivery order is missing delivered item ids.', {
      reason: 'missing_delivered_item_ids',
    });
  }
  return {
    verification: 'signature',
    signature: args.signature,
    expectedDeliveryPda,
    expectedDeliveryBump,
    targetAssetIds,
  };
}

export async function verifyReceiptIssuanceByDeliveryRecord(args: {
  connection: Connection;
  deliveryId: number;
  order: DeliveryOrderReceiptView;
  ownerWallet: string;
  runtime: DeliveryRuntime;
}): Promise<VerifiedReceiptIssuanceTarget> {
  const itemIds = args.order.itemIds;
  if (!itemIds.length) {
    throw new DeliveryReceiptError('failed-precondition', 'Delivery order is missing itemIds for recovery.');
  }
  const account = await fetchDeliveryRecord(args.connection, args.runtime, args.deliveryId);
  if (!account) throw new DeliveryReceiptError('failed-precondition', 'Delivery record PDA not found.');
  assertStoredDeliveryPda(args.order, account.expectedDeliveryPda);
  const record = decodeDeliveryRecord(Buffer.from(account.deliveryInfo.data));
  if (record.payer.toBase58() !== args.ownerWallet) {
    throw new DeliveryReceiptError('failed-precondition', 'Delivery record payer does not match owner.');
  }
  if (record.itemCount !== itemIds.length) {
    throw new DeliveryReceiptError('failed-precondition', 'Delivery record item count mismatch.', {
      expected: itemIds.length,
      got: record.itemCount,
    });
  }
  const expectedLamports = args.order.deliveryLamports;
  if (record.deliveryFeeLamports !== expectedLamports) {
    throw new DeliveryReceiptError('failed-precondition', 'Delivery record fee mismatch.', {
      expected: expectedLamports,
      got: record.deliveryFeeLamports,
    });
  }
  return {
    verification: 'delivery_pda',
    signature: args.order.deliverySignature,
    expectedDeliveryPda: account.expectedDeliveryPda,
    expectedDeliveryBump: account.expectedDeliveryBump,
    targetAssetIds: itemIds,
  };
}

export async function hasConfirmedDeliveryRecord(
  provider: ProviderContext,
  runtime: DeliveryRuntime,
  deliveryId: number,
  order: Record<string, unknown>,
): Promise<boolean> {
  const connection = createConnection(provider, runtime);
  const [expectedDeliveryPda] = deriveDeliveryPda(runtime, deliveryId);
  assertStoredDeliveryPda(parseDeliveryOrderReceiptView(order), expectedDeliveryPda);
  return Boolean(await fetchDeliveryRecord(connection, runtime, deliveryId, false));
}
