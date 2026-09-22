import type { AddressLookupTableAccount, VersionedTransaction } from '@solana/web3.js';
import { isSignalCancellationError } from './boundedRequest.js';

export const SOLANA_MAX_RAW_TX_BYTES = 1232;

export function isTransactionEncodingTooLarge(error: unknown): boolean {
  if (!(error instanceof RangeError)) return false;
  return /encoding overruns Uint8Array/i.test(error.message) ||
    /offset.*out of range/i.test(error.message) ||
    ('code' in error && error.code === 'ERR_OUT_OF_RANGE');
}

export async function buildSizedTransaction(args: {
  build: (lookupTables: AddressLookupTableAccount[]) => VersionedTransaction;
  loadLookupTables: () => Promise<AddressLookupTableAccount[]>;
  signal: AbortSignal;
  encodingError: () => Error;
  packetSizeError: (rawBytes: number) => Error;
}): Promise<{ transaction: VersionedTransaction; raw: Uint8Array }> {
  const serialize = (lookupTables: AddressLookupTableAccount[]) => {
    const transaction = args.build(lookupTables);
    return { transaction, raw: transaction.serialize() };
  };
  let built: { transaction: VersionedTransaction; raw: Uint8Array } | undefined;
  try {
    built = serialize([]);
  } catch (error) {
    if (!isTransactionEncodingTooLarge(error)) throw error;
  }
  if (built && built.raw.length <= SOLANA_MAX_RAW_TX_BYTES) return built;

  let lookupTables: AddressLookupTableAccount[];
  try {
    lookupTables = await args.loadLookupTables();
  } catch (error) {
    if (isSignalCancellationError(args.signal, error)) throw args.signal.reason;
    lookupTables = [];
  }
  if (lookupTables.length) {
    try {
      built = serialize(lookupTables);
    } catch (error) {
      if (!isTransactionEncodingTooLarge(error)) throw error;
      throw args.encodingError();
    }
  }
  if (!built) throw args.encodingError();
  if (built.raw.length > SOLANA_MAX_RAW_TX_BYTES) throw args.packetSizeError(built.raw.length);
  return built;
}
