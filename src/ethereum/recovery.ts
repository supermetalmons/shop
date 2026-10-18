import type { Ethereum111kConfig, EthereumPreparedTransaction } from '../../shared/ethereum/api';
import type { EIP1193Provider } from '../wallet/injectedEthereumProviders';
import { ethereumAddress, ethereumChainId } from './wallet';
import type { EthereumPendingTransaction } from './state';

type WalletTransaction = { hash: string; from: string; to: string; data: string; value: string; nonce: string };

export async function readEthereumWalletTransaction(provider: EIP1193Provider, hash: string, chainId: number, owner: string): Promise<WalletTransaction | null> {
  const value = await provider.request({ method: 'eth_getTransactionByHash', params: [hash] });
  if (value === null) return null;
  if (!value || typeof value !== 'object') throw new Error('Your wallet returned an invalid transaction.');
  const row = value as Record<string, unknown>;
  const input = row.input ?? row.data;
  if (typeof row.hash !== 'string' || row.hash.toLowerCase() !== hash.toLowerCase() || ethereumAddress(row.from) !== owner ||
    !ethereumAddress(row.to) || typeof input !== 'string' || !/^0x(?:[0-9a-fA-F]{2})*$/.test(input) ||
    typeof row.value !== 'string' || !/^0x[0-9a-fA-F]+$/.test(row.value) ||
    typeof row.nonce !== 'string' || !/^0x[0-9a-fA-F]+$/.test(row.nonce) ||
    row.chainId !== undefined && ethereumChainId(row.chainId) !== chainId) {
    throw new Error('This transaction does not match your Ethereum wallet or network.');
  }
  return { hash: row.hash.toLowerCase(), from: owner, to: ethereumAddress(row.to)!, data: input.toLowerCase(),
    value: `0x${BigInt(row.value).toString(16)}`, nonce: `0x${BigInt(row.nonce).toString(16)}` };
}

export function ethereumTransactionMatchesIntent(actual: Pick<WalletTransaction, 'to' | 'data' | 'value'>, intended: Pick<EthereumPreparedTransaction, 'to' | 'data' | 'value'>): boolean {
  return ethereumAddress(actual.to) === ethereumAddress(intended.to) && actual.data.toLowerCase() === intended.data.toLowerCase() &&
    BigInt(actual.value) === BigInt(intended.value);
}

export async function ethereumReplacement(args: {
  provider: EIP1193Provider; config: Ethereum111kConfig; owner: string; pending: EthereumPendingTransaction;
  replacementHash: string; assertCurrent: () => void;
}): Promise<EthereumPendingTransaction> {
  const { provider, config, owner, pending, assertCurrent } = args;
  const hash = args.replacementHash.trim().toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(hash) || hash === pending.hash) throw new Error('Paste the replacement transaction hash from your wallet.');
  let nonce = pending.nonce;
  let intent = pending.intent;
  if (!nonce || !intent) {
    const original = await readEthereumWalletTransaction(provider, pending.hash, config.chainId, owner);
    assertCurrent();
    if (!original || original.to !== config.contractAddress || intent && !ethereumTransactionMatchesIntent(original, intent)) {
      throw new Error('The original transaction is no longer available, so its replacement cannot be verified. Check your wallet before stopping tracking.');
    }
    nonce = original.nonce;
    intent = { to: original.to, data: original.data, value: original.value };
  }
  const replacement = await readEthereumWalletTransaction(provider, hash, config.chainId, owner);
  assertCurrent();
  if (!replacement) throw new Error('That transaction is not visible yet. Check the hash and try again shortly.');
  if (BigInt(replacement.nonce) !== BigInt(nonce)) throw new Error('That transaction does not replace the pending transaction.');
  const cancellation = replacement.to === owner && replacement.data === '0x' && BigInt(replacement.value) === 0n;
  if (!cancellation && !ethereumTransactionMatchesIntent(replacement, intent)) {
    throw new Error('The replacement changes the original transaction. Check your wallet before stopping tracking.');
  }
  const originalAction = pending.action === 'cancel' ? pending.actionBeforeCancellation : pending.action;
  if (!originalAction) throw new Error('The original action could not be identified. Check your wallet before stopping tracking.');
  return { ...pending, hash, nonce, intent, action: cancellation ? 'cancel' : originalAction,
    ...(cancellation ? { actionBeforeCancellation: originalAction } : {}),
  };
}
