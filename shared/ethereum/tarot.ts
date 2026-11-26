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
  claim: '/ethereum/tarot/claim',
} as const;
export const TAROT_RECEIPT_OFFSET = DMX_RECEIPT_OFFSET;
export const TAROT_AUTHORIZATION_TTL_SECONDS = 600;
export const TAROT_CHAIN_ID = 11155111;
const TAROT_CLAIM_FUNCTION = 'claim(uint256,uint256,bytes)';

export type TarotConfig = {
  testnet: boolean; chainId: number; chainName: string; contractAddress: string | null;
  deploymentBlock: number; enabled: boolean; explorerUrl: string; walletRpcUrl: string;
  confirmationBlocks: number; maxCards: number;
};
export type TarotRequest = { tokenId: number; testnet: boolean; code: string };
export type TarotStatusRequest = TarotRequest & { requestId?: string };
export type TarotPrepareRequest = TarotRequest & { wallet: string };
export type TarotConfirmRequest = TarotPrepareRequest & { transactionHash: string };
export type TarotClaimRequest = TarotRequest & { recipient: string; requestId: string };
export type TarotBackendClaim = {
  requestId: string;
  state: 'submitting' | 'pending' | 'confirmed' | 'failed' | 'recovery-required';
  recipient: string;
  transactionHash: string | null;
  error?: string;
};
export type TarotClaimResponse = {
  tokenId: number; receiptTokenId: number; backendClaim: TarotBackendClaim;
};
export type TarotStatus = {
  config: TarotConfig; tokenId: number; receiptTokenId: number; claimed: boolean;
  observedBlock: number; observedTimestamp: number; blockHash: string;
  backendClaim?: TarotBackendClaim | null;
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

export function tarotChainId(testnet: boolean): 1 | 11155111 {
  return testnet ? TAROT_CHAIN_ID : 1;
}

export function tarotCodeHashInput(args: { chainId: number; contractAddress: string; tokenId: number; code: string }): string {
  const contractAddress = normalizeEthereumAddress(args.contractAddress);
  if ((args.chainId !== 1 && args.chainId !== TAROT_CHAIN_ID) || !contractAddress || /^0x0{40}$/.test(contractAddress) ||
    !isTarotTokenId(args.tokenId) || !isTarotClaimCode(args.code)) {
    throw new Error('Invalid Tarot claim code scope');
  }
  return `mons:tarot:claim:v1:${args.chainId}:${contractAddress}:${args.tokenId}:${args.code.toLowerCase()}`;
}

export function resolveTarotConfig(input: {
  testnet?: boolean; contractAddress?: string | null; deploymentBlock?: number | string; enabled?: boolean;
}): TarotConfig {
  const testnet = input.testnet ?? false;
  if (typeof testnet !== 'boolean') throw new Error('Invalid Tarot network');
  const contractAddress = normalizeEthereumAddress(input.contractAddress);
  if (input.contractAddress && (!contractAddress || /^0x0{40}$/.test(contractAddress))) {
    throw new Error('Invalid Tarot contract');
  }
  const deploymentBlock = Number(input.deploymentBlock || 0);
  if (!Number.isSafeInteger(deploymentBlock) || deploymentBlock < 0) throw new Error('Invalid Tarot deployment block');
  return {
    testnet, chainId: tarotChainId(testnet), chainName: testnet ? 'Sepolia' : 'Ethereum', contractAddress, deploymentBlock,
    enabled: !!contractAddress && input.enabled === true,
    explorerUrl: testnet ? 'https://sepolia.etherscan.io' : 'https://etherscan.io',
    walletRpcUrl: testnet ? 'https://ethereum-sepolia-rpc.publicnode.com' : 'https://ethereum-rpc.publicnode.com',
    confirmationBlocks: 3, maxCards: TAROT_MAX_CARDS,
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
