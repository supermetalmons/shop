import { ETHEREUM_111K_DROP_ID, ETHEREUM_MAX_DELIVERY_ITEMS, ETHEREUM_MAX_MINT_QUANTITY, ETHEREUM_MAX_UNBOX_QUANTITY, normalizeEthereumAddress } from './protocol.ts';

export type Ethereum111kConfig = {
  dropId: typeof ETHEREUM_111K_DROP_ID;
  chainId: number;
  chainName: string;
  contractAddress: string | null;
  rendererAddress: string | null;
  metadataBaseUri: string;
  deploymentBlock: number;
  explorerUrl: string;
  walletRpcUrl: string;
  enabled: boolean;
  testnet: true;
  cratePriceWei: string;
  warehousePriceWei: string;
  deliveryFeeWei: string;
  confirmationBlocks: number;
  maxMintQuantity: number;
  maxUnboxQuantity: number;
  maxDeliveryItems: number;
};

export function resolveEthereum111kConfig(input: {
  chainId?: number | string;
  contractAddress?: string | null;
  rendererAddress?: string | null;
  metadataBaseUri?: string;
  deploymentBlock?: number | string;
  walletRpcUrl?: string;
} = {}): Ethereum111kConfig {
  const chainId = Number(input.chainId || 11155111);
  if (chainId !== 11155111 && chainId !== 31337) throw new Error('111K development supports Sepolia or a local chain only');
  const deploymentBlock = Number(input.deploymentBlock || 0);
  if (!Number.isSafeInteger(deploymentBlock) || deploymentBlock < 0) throw new Error('Invalid Ethereum deployment block');
  const contractAddress = normalizeEthereumAddress(input.contractAddress);
  const rendererAddress = normalizeEthereumAddress(input.rendererAddress);
  const metadataBaseUri = ethereumMetadataBaseUri(input.metadataBaseUri || 'https://cdn.mons.shop/111k-sepolia/', chainId);
  return {
    dropId: ETHEREUM_111K_DROP_ID, chainId,
    chainName: chainId === 31337 ? 'Local Ethereum' : 'Sepolia',
    contractAddress, rendererAddress, metadataBaseUri, deploymentBlock,
    explorerUrl: chainId === 31337 ? '' : 'https://sepolia.etherscan.io',
    walletRpcUrl: input.walletRpcUrl || (chainId === 31337 ? 'http://127.0.0.1:8545' : 'https://ethereum-sepolia-rpc.publicnode.com'),
    enabled: contractAddress !== null, testnet: true,
    cratePriceWei: '100000000000000', warehousePriceWei: '1100000000000000',
    deliveryFeeWei: '100000000000000', confirmationBlocks: 3,
    maxMintQuantity: ETHEREUM_MAX_MINT_QUANTITY, maxUnboxQuantity: ETHEREUM_MAX_UNBOX_QUANTITY,
    maxDeliveryItems: ETHEREUM_MAX_DELIVERY_ITEMS,
  };
}

export function ethereumMetadataBaseUri(value: string, chainId: number): string {
  const url = new URL(value);
  const local = chainId === 31337 && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) &&
    url.protocol === 'http:' && ['/111k-sepolia/', '/111k/'].includes(url.pathname);
  const hostedPaths = chainId === 31337 ? ['/111k-sepolia/', '/111k/'] :
    chainId === 11155111 ? ['/111k-sepolia/'] : chainId === 1 ? ['/111k/'] : [];
  const hosted = url.origin === 'https://cdn.mons.shop' && hostedPaths.includes(url.pathname);
  if ((!local && !hosted) || url.username || url.password || url.search || url.hash ||
    !url.pathname.endsWith('/') || url.href !== value) throw new Error('Invalid Ethereum metadata base URI');
  return url.href;
}

export const DEFAULT_ETHEREUM_111K_CONFIG = Object.freeze(resolveEthereum111kConfig());

export function ethereumExplorerTransaction(config: Pick<Ethereum111kConfig, 'explorerUrl'>, hash: string): string | null {
  return config.explorerUrl && /^0x[0-9a-fA-F]{64}$/.test(hash) ? `${config.explorerUrl}/tx/${hash}` : null;
}
