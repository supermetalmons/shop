import type { EthereumRevealScope } from './reveal.js';

export const ETHEREUM_OWNER_HATCHING_PATHS = {
  ready: '/ethereum/111k/hatching/ready',
  hatch: '/ethereum/111k/hatching/hatch',
} as const;

export const ETHEREUM_OWNER_HATCHING_MESSAGE = 'I authorize 111k egg hatching.';

export type EthereumOwnerHatchingReadyResponse = EthereumRevealScope & { tokenIds: string[] };

export type EthereumOwnerHatchRequest = {
  chainId: number;
  contractAddress: string;
  tokenId: string;
  signature: string;
};
