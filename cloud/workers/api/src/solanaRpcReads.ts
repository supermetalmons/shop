import {
  AddressLookupTableAccount,
  AddressLookupTableProgram,
  PublicKey,
} from '@solana/web3.js';
import { isNonZeroBase58Bytes } from '../../../../shared/solanaRpcProxy.js';
import { isRecord } from './dataAccess.js';

type RpcRead = (method: string, params: unknown) => Promise<unknown>;

type BlockhashReadOptions = Readonly<{
  rpc: RpcRead;
  invalidResponse: () => Error;
}>;

export async function readLatestBlockhash(options: BlockhashReadOptions): Promise<string> {
  const result = await options.rpc('getLatestBlockhash', [{ commitment: 'confirmed' }]);
  const value = isRecord(result) ? result.value : undefined;
  const blockhash = isRecord(value) && typeof value.blockhash === 'string' ? value.blockhash : '';
  try {
    if (!blockhash || new PublicKey(blockhash).toBytes().length !== 32) throw new Error('invalid');
  } catch {
    throw options.invalidResponse();
  }
  return blockhash;
}

export async function readLatestBlockhashWithContext(
  options: BlockhashReadOptions,
): Promise<{ blockhash: string; blockhashContextSlot: number }> {
  const result = await options.rpc('getLatestBlockhash', [{ commitment: 'confirmed' }]);
  const context = isRecord(result) ? result.context : undefined;
  const value = isRecord(result) ? result.value : undefined;
  const blockhash = isRecord(value) && typeof value.blockhash === 'string' ? value.blockhash : '';
  const lastValidBlockHeight = isRecord(value) ? value.lastValidBlockHeight : undefined;
  if (
    !isRecord(context) ||
    !Number.isSafeInteger(context.slot) ||
    Number(context.slot) < 0 ||
    !Number.isSafeInteger(lastValidBlockHeight) ||
    Number(lastValidBlockHeight) < 0 ||
    !isNonZeroBase58Bytes(blockhash, 32)
  ) {
    throw options.invalidResponse();
  }
  return { blockhash, blockhashContextSlot: Number(context.slot) };
}

export async function readSolanaLookupTable(options: Readonly<{
  rpc: RpcRead;
  address: PublicKey | undefined;
  parseAccount: (value: unknown) => { owner: PublicKey; data: Uint8Array };
  label: string;
  missing: 'error' | 'empty';
  inactive: 'error' | 'empty' | 'allow';
  configurationError: (message: string) => Error;
}>): Promise<AddressLookupTableAccount[]> {
  if (!options.address) return [];
  const result = await options.rpc('getAccountInfo', [
    options.address.toBase58(),
    { commitment: 'confirmed', encoding: 'base64' },
  ]);
  const value = isRecord(result) ? result.value : undefined;
  if (!value) {
    if (options.missing === 'empty') return [];
    throw options.configurationError(`${options.label} not found on-chain.`);
  }
  const account = options.parseAccount(value);
  if (!account.owner.equals(AddressLookupTableProgram.programId)) {
    throw options.configurationError(`${options.label} has an unexpected owner.`);
  }
  let lookup: AddressLookupTableAccount;
  let active = true;
  try {
    lookup = new AddressLookupTableAccount({
      key: options.address,
      state: AddressLookupTableAccount.deserialize(account.data),
    });
    if (options.inactive !== 'allow') active = lookup.isActive();
  } catch {
    throw options.configurationError(`${options.label} is invalid.`);
  }
  if (!active) {
    if (options.inactive === 'empty') return [];
    throw options.configurationError(`${options.label} is inactive.`);
  }
  return [lookup];
}
