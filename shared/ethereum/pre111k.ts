import { encodeCall } from './abi.ts';
import type { EthereumPreparedTransaction } from './api.ts';
import { normalizeEthereumAddress } from './protocol.ts';

export const PRE111K_API_PATHS = {
  access: '/ethereum/pre111k/access',
  status: '/ethereum/pre111k/status',
  prepare: '/ethereum/pre111k/prepare',
  confirm: '/ethereum/pre111k/confirm',
} as const;

const PRE111K_FUNCTIONS = { reserveRelic: 'reserveRelic(uint256,uint256,bytes)' } as const;
export const PRE111K_TREASURY = '0x72d0c5623a05033f9ee4495d408bc6c05df8367d';
export const PRE111K_MAX_RELICS = 18;
export const PRE111K_AUTHORIZATION_TTL_SECONDS = 600;

export type Pre111kNetwork = 'mainnet' | 'devnet';
export type Pre111kAccessResponse = { ok: true };
export type Pre111kConfig = {
  network: Pre111kNetwork; chainId: number; chainName: string; contractAddress: string | null;
  deploymentBlock: number; enabled: boolean; priceWei: string; treasury: string;
  explorerUrl: string; walletRpcUrl: string; confirmationBlocks: number; maxRelics: number;
};
export type Pre111kStatus = {
  config: Pre111kConfig; wallet: string | null; totalReserved: number | null;
  reservedRelics: number | null; remainingRelics: number | null; observedBlock: number | null; blockHash: string | null;
};
export type Pre111kPrepareResponse = {
  network: Pre111kNetwork; wallet: string; nonce: number; deadline: number; expiresAtMs: number;
  signature: string; transaction: EthereumPreparedTransaction;
};
export type Pre111kConfirmResponse = {
  status: 'pending' | 'confirmed' | 'failed'; confirmations: number; transactionHash: string; reservationNonce: number | null;
};

export function resolvePre111kConfig(network: Pre111kNetwork, input: {
  contractAddress?: string | null; deploymentBlock?: number | string; enabled?: boolean;
} = {}): Pre111kConfig {
  if (network !== 'mainnet' && network !== 'devnet') throw new Error('Invalid relic preorder network');
  const contractAddress = normalizeEthereumAddress(input.contractAddress);
  if (input.contractAddress && (!contractAddress || /^0x0{40}$/.test(contractAddress))) {
    throw new Error('Invalid relic preorder contract');
  }
  const deploymentBlock = Number(input.deploymentBlock || 0);
  if (!Number.isSafeInteger(deploymentBlock) || deploymentBlock < 0) throw new Error('Invalid relic preorder deployment block');
  const mainnet = network === 'mainnet';
  return {
    network, chainId: mainnet ? 1 : 11155111, chainName: mainnet ? 'Ethereum' : 'Sepolia',
    contractAddress, deploymentBlock, enabled: !!contractAddress && input.enabled === true,
    priceWei: mainnet ? '2300000000000000000' : '2300000000000000', treasury: PRE111K_TREASURY,
    explorerUrl: mainnet ? 'https://etherscan.io' : 'https://sepolia.etherscan.io',
    walletRpcUrl: mainnet ? 'https://ethereum-rpc.publicnode.com' : 'https://ethereum-sepolia-rpc.publicnode.com',
    confirmationBlocks: 3, maxRelics: PRE111K_MAX_RELICS,
  };
}

export function encodePre111kReservation(nonce: number, deadline: number, signature: string): string {
  return encodeCall(PRE111K_FUNCTIONS.reserveRelic, ['uint256', 'uint256', 'bytes'], [nonce, deadline, signature]);
}
