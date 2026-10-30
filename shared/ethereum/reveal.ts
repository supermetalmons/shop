export const ETHEREUM_REVEAL_PATHS = {
  transaction: '/ethereum/111k/reveal/transaction',
  tokens: '/ethereum/111k/reveal/tokens',
} as const;

export const ETHEREUM_REVEAL_MAX_TOKEN_IDS = 500;
export const ETHEREUM_REVEAL_RETRY_MS = 2_000;

export type EthereumArtworkCategory = 'egg' | 'painting' | 'video';
export type EthereumArtworkAspectRatio = { width: number; height: number };
export type EthereumRevealObservation = { transactionHash: string; blockNumber: number; blockHash: string };
export type EthereumRevealScope = {
  deploymentId: string;
  dropId: string;
  chainId: number;
  contractAddress: string;
};
export type EthereumRevealedArtwork = {
  tokenId: string;
  crateTokenId: string;
  category: EthereumArtworkCategory;
  name: string;
  description?: string;
  image: string;
  animation_url?: string;
  aspectRatio: EthereumArtworkAspectRatio;
  attributes?: Array<{ trait_type: string; value: string | number }>;
  observation: EthereumRevealObservation;
};
export type EthereumRevealTransactionRequest = {
  chainId: number;
  contractAddress: string;
  transactionHash: string;
};
export type EthereumRevealTokensRequest = {
  chainId: number;
  contractAddress: string;
  tokenIds: string[];
};
export type EthereumRevealTransactionResponse = EthereumRevealScope & {
  status: 'pending' | 'revealed' | 'reverted' | 'not_unpack';
  artworks: EthereumRevealedArtwork[];
  retryAfterMs: number;
  observedBlock?: { number: number; hash: string };
};
export type EthereumRevealTokensResponse = EthereumRevealScope & {
  artworks: EthereumRevealedArtwork[];
  unresolved: Array<{ tokenId: string; status: 'recovering' | 'unminted' }>;
  retryAfterMs: number;
};
export type EthereumRevealResult<T> =
  | { kind: 'ready'; value: T }
  | { kind: 'admission' }
  | { kind: 'capacity' };
