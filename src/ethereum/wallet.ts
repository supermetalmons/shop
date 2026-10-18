import { normalizeEthereumAddress as ethereumAddress } from '../../shared/ethereum/protocol';
import type { EIP1193Provider, EthereumProviderListener } from '../wallet/injectedEthereumProviders';

export { ethereumAddress };

export type EthereumWalletSnapshot = { address: string | null; provider: EIP1193Provider | null };
export type EthereumNetwork = { chainId: number; chainName: string; walletRpcUrl: string; explorerUrl: string };
export type EthereumTransaction = { to: string; data: string; value: string; chainId: number };

export function ethereumChainId(value: unknown): number | null {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]+$/.test(value)) return null;
  const chainId = Number(BigInt(value));
  return Number.isSafeInteger(chainId) && chainId > 0 ? chainId : null;
}

export function ethereumWalletError(error: unknown): string {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : null;
  if (code === 4001) return 'Request cancelled in your wallet.';
  if (code === -32002) return 'A request is already open. Check your Ethereum wallet.';
  return error instanceof Error ? error.message : 'The Ethereum request failed. Please try again.';
}

export function ethereumOperation(getWallet: () => EthereumWalletSnapshot, network: EthereumNetwork) {
  const initial = getWallet();
  const provider = initial.provider;
  const address = ethereumAddress(initial.address);
  if (!provider || !address) throw new Error('Connect your Ethereum wallet first.');
  const abortController = new AbortController();
  const cancel = () => abortController.abort(new Error('Your Ethereum wallet changed. Please try again.'));
  const accountsChanged: EthereumProviderListener = accounts => {
    if (!Array.isArray(accounts) || ethereumAddress(accounts[0]) !== address) cancel();
  };
  const chainChanged: EthereumProviderListener = chain => {
    if (ethereumChainId(chain) !== network.chainId) cancel();
  };
  provider.on?.('accountsChanged', accountsChanged);
  provider.on?.('chainChanged', chainChanged);
  provider.on?.('disconnect', cancel);
  const assertCurrent = () => {
    abortController.signal.throwIfAborted();
    const current = getWallet();
    if (current.provider !== provider || ethereumAddress(current.address) !== address) {
      cancel();
      abortController.signal.throwIfAborted();
    }
  };
  const verifyAccount = async () => {
    assertCurrent();
    const accounts = await provider.request({ method: 'eth_accounts' });
    assertCurrent();
    if (!Array.isArray(accounts) || ethereumAddress(accounts[0]) !== address) throw new Error('Your Ethereum account changed. Connect it again.');
  };
  const ensureNetwork = async () => {
    await verifyAccount();
    const chain = await provider.request({ method: 'eth_chainId' });
    assertCurrent();
    if (ethereumChainId(chain) !== network.chainId) {
      try {
        await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: `0x${network.chainId.toString(16)}` }] });
      } catch (error) {
        const code = error && typeof error === 'object' && 'code' in error ? error.code : null;
        if (code !== 4902) throw error;
        assertCurrent();
        await provider.request({ method: 'wallet_addEthereumChain', params: [{
          chainId: `0x${network.chainId.toString(16)}`,
          chainName: network.chainName,
          nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
          rpcUrls: [network.walletRpcUrl],
          ...(network.explorerUrl ? { blockExplorerUrls: [network.explorerUrl] } : {}),
        }] });
        assertCurrent();
        await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: `0x${network.chainId.toString(16)}` }] });
      }
    }
    await verifyAccount();
    if (ethereumChainId(await provider.request({ method: 'eth_chainId' })) !== network.chainId) {
      throw new Error(`Switch your wallet to ${network.chainName}.`);
    }
    assertCurrent();
  };
  return {
    address, provider, signal: abortController.signal, assertCurrent, ensureNetwork,
    async send(transaction: EthereumTransaction, beforeSend?: () => void) {
      if (transaction.chainId !== network.chainId || !ethereumAddress(transaction.to) ||
        !/^0x(?:[0-9a-fA-F]{2})*$/.test(transaction.data) || !/^0x[0-9a-fA-F]+$/.test(transaction.value)) {
        throw new Error('The transaction does not match this Ethereum network.');
      }
      await ensureNetwork();
      beforeSend?.();
      const result = await provider.request({ method: 'eth_sendTransaction', params: [{
        from: address, to: transaction.to, data: transaction.data, value: transaction.value,
        chainId: `0x${network.chainId.toString(16)}`,
      }] });
      if (typeof result !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(result)) throw new Error('Your wallet did not return a transaction hash.');
      return result.toLowerCase();
    },
    dispose() {
      provider.removeListener?.('accountsChanged', accountsChanged);
      provider.removeListener?.('chainChanged', chainChanged);
      provider.removeListener?.('disconnect', cancel);
    },
  };
}
