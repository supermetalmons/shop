import { encodeCall } from './abi.ts';
import type { EthereumPreparedTransaction } from './api.ts';
import { normalizeEthereumAddress } from './protocol.ts';
import { DMX_RECEIPT_OFFSET } from './dmx.ts';
import { isTarotClaimCode, isTarotTokenId, TAROT_MAX_CARDS } from './tarotCard.ts';

export { TAROT_MAX_CARDS } from './tarotCard.ts';

export const TAROT_API_PATHS = {
  status: '/ethereum/tarot/status',
  prepare: '/ethereum/tarot/prepare',
  confirm: '/ethereum/tarot/confirm',
} as const;
export const TAROT_RECEIPT_OFFSET = DMX_RECEIPT_OFFSET;
export const TAROT_AUTHORIZATION_TTL_SECONDS = 600;
export const TAROT_CHAIN_ID = 11155111;
export const TAROT_METADATA_BASE_URI = 'https://cdn.mons.shop/tarot-sepolia/v1/';
const TAROT_CLAIM_FUNCTION = 'claim(uint256,uint256,bytes)';

export type TarotConfig = {
  testnet: true; chainId: number; chainName: string; contractAddress: string | null;
  deploymentBlock: number; enabled: boolean; explorerUrl: string; walletRpcUrl: string;
  confirmationBlocks: number; maxCards: number;
};
export type TarotRequest = { tokenId: number; testnet: true; code: string };
export type TarotPrepareRequest = TarotRequest & { wallet: string };
export type TarotConfirmRequest = TarotPrepareRequest & { transactionHash: string };
export type TarotStatus = {
  config: TarotConfig; tokenId: number; receiptTokenId: number; claimed: boolean;
  observedBlock: number; observedTimestamp: number; blockHash: string;
};
export type TarotPrepareResponse = {
  tokenId: number; receiptTokenId: number; wallet: string; deadline: number; expiresAtMs: number;
  signature: string; transaction: EthereumPreparedTransaction;
};
export type TarotConfirmResponse = {
  status: 'pending' | 'confirmed' | 'failed'; transactionHash: string; confirmations: number;
  tokenId: number; receiptTokenId: number; blockNumber: number | null; blockHash: string | null;
};

export function tarotReceiptTokenId(tokenId: number): number {
  if (!isTarotTokenId(tokenId)) throw new Error('Invalid Tarot card ID');
  return tokenId + TAROT_RECEIPT_OFFSET;
}

export function tarotCodeHashInput(args: { chainId: number; contractAddress: string; tokenId: number; code: string }): string {
  const contractAddress = normalizeEthereumAddress(args.contractAddress);
  if (args.chainId !== TAROT_CHAIN_ID || !contractAddress || /^0x0{40}$/.test(contractAddress) ||
    !isTarotTokenId(args.tokenId) || !isTarotClaimCode(args.code)) {
    throw new Error('Invalid Tarot claim code scope');
  }
  return `mons:tarot:claim:v1:${args.chainId}:${contractAddress}:${args.tokenId}:${args.code.toLowerCase()}`;
}

export function resolveTarotConfig(input: {
  contractAddress?: string | null; deploymentBlock?: number | string; enabled?: boolean;
}): TarotConfig {
  const contractAddress = normalizeEthereumAddress(input.contractAddress);
  if (input.contractAddress && (!contractAddress || /^0x0{40}$/.test(contractAddress))) {
    throw new Error('Invalid Tarot contract');
  }
  const deploymentBlock = Number(input.deploymentBlock || 0);
  if (!Number.isSafeInteger(deploymentBlock) || deploymentBlock < 0) throw new Error('Invalid Tarot deployment block');
  return {
    testnet: true, chainId: TAROT_CHAIN_ID, chainName: 'Sepolia', contractAddress, deploymentBlock,
    enabled: !!contractAddress && input.enabled === true, explorerUrl: 'https://sepolia.etherscan.io',
    walletRpcUrl: 'https://ethereum-sepolia-rpc.publicnode.com', confirmationBlocks: 3, maxCards: TAROT_MAX_CARDS,
  };
}

export function encodeTarotClaim(tokenId: number, deadline: number, signature: string): string {
  if (!isTarotTokenId(tokenId)) throw new Error('Invalid Tarot card ID');
  return encodeCall(TAROT_CLAIM_FUNCTION, ['uint256', 'uint256', 'bytes'], [tokenId, deadline, signature]);
}

export function encodeTarotClaimTo(recipient: string, tokenId: number, deadline: number, signature: string): string {
  if (!isTarotTokenId(tokenId)) throw new Error('Invalid Tarot card ID');
  return encodeCall('claimTo(address,uint256,uint256,bytes)', ['address', 'uint256', 'uint256', 'bytes'],
    [recipient, tokenId, deadline, signature]);
}
