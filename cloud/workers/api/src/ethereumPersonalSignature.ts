import { encodeCall } from '../../../../shared/ethereum/abi.js';
import { personalMessageHash, recoverEthereumAddress } from '../../../../shared/ethereum/crypto.js';
import { ethereumRpc, type EthereumBlockReference, type EthereumReadContext } from './ethereumRuntime.js';
import { RpcProviderError } from './ethereumProvider.js';
import { ProviderBudgetUnavailable } from './ethereumProviderBudget.js';

export async function verifyEthereumPersonalSignature(context: EthereumReadContext, wallet: string,
  message: string, signature: string, blockReference: EthereumBlockReference = 'latest'): Promise<boolean> {
  const digest = personalMessageHash(message);
  if (recoverEthereumAddress(digest, signature)?.toLowerCase() === wallet.toLowerCase()) return true;
  const code = await ethereumRpc(context, 'eth_getCode', [wallet, blockReference]);
  if (typeof code !== 'string' || code === '0x' || code === '0x0') return false;
  try {
    const result = await ethereumRpc(context, 'eth_call', [{ to: wallet,
      data: encodeCall('isValidSignature(bytes32,bytes)', ['bytes32', 'bytes'], [digest, signature]) }, blockReference]);
    return typeof result === 'string' && result.slice(0, 10).toLowerCase() === '0x1626ba7e';
  } catch (error) {
    context.signal.throwIfAborted();
    if (error instanceof RpcProviderError || error instanceof ProviderBudgetUnavailable) throw error;
    return false;
  }
}
