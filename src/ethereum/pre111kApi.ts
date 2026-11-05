import { encodePre111kReservation, isPre111kPriceWei, PRE111K_API_PATHS, PRE111K_MAX_RELICS, PRE111K_TREASURY, type Pre111kAccessResponse, type Pre111kConfig, type Pre111kConfirmResponse, type Pre111kNetwork, type Pre111kPrepareResponse, type Pre111kStatus } from '../../shared/ethereum/pre111k';
import { EthereumApiError } from './api';
import { ethereumAddress } from './wallet';
import { requestEthereumJson } from './request';

const CHAINS = { mainnet: 1, devnet: 11155111 };

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function invalid(): never { throw new Error('The relic service returned an invalid response. Please try again.'); }
function count(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= PRE111K_MAX_RELICS; }

async function request(path: string, body?: unknown, signal?: AbortSignal): Promise<unknown> {
  const { response, value } = await requestEthereumJson(path, { body, signal });
  if (!response.ok) {
    const detail = record(value) && record(value.error) ? value.error : value;
    throw new EthereumApiError(response.status,
      record(detail) && typeof detail.message === 'string' ? detail.message : 'Couldn’t reach the relic service. Please try again.',
      record(detail) && typeof detail.code === 'string' ? detail.code : null);
  }
  return value;
}

function config(value: unknown, network: Pre111kNetwork): Pre111kConfig {
  if (!record(value) || value.network !== network || value.chainId !== CHAINS[network] || typeof value.chainName !== 'string' ||
    typeof value.enabled !== 'boolean' || !isPre111kPriceWei(value.priceWei) || value.maxRelics !== PRE111K_MAX_RELICS || value.confirmationBlocks !== 3 ||
    !Number.isSafeInteger(value.deploymentBlock) || Number(value.deploymentBlock) < 0 ||
    ethereumAddress(value.treasury) !== PRE111K_TREASURY ||
    typeof value.walletRpcUrl !== 'string' || typeof value.explorerUrl !== 'string' ||
    value.explorerUrl !== (network === 'mainnet' ? 'https://etherscan.io' : 'https://sepolia.etherscan.io') ||
    value.contractAddress !== null && (!ethereumAddress(value.contractAddress) || /^0x0{40}$/i.test(String(value.contractAddress))) ||
    value.enabled && value.contractAddress === null) return invalid();
  const rpc = new URL(value.walletRpcUrl);
  if (rpc.protocol !== 'https:') return invalid();
  return { ...value, contractAddress: ethereumAddress(value.contractAddress) } as Pre111kConfig;
}

export class Pre111kPriceChanged extends Error {
  constructor() { super('The reservation price changed. Review the new price and try again.'); }
}

export function checkedPre111kReservation(value: Pre111kPrepareResponse, expected: Pre111kConfig, wallet: string, nonce: number) {
  if (!record(value) || value.network !== expected.network || ethereumAddress(value.wallet) !== wallet || value.nonce !== nonce ||
    !count(value.nonce) || value.nonce >= PRE111K_MAX_RELICS || !Number.isSafeInteger(value.deadline) || value.deadline * 1000 <= Date.now() ||
    !Number.isSafeInteger(value.expiresAtMs) || value.expiresAtMs <= Date.now() || value.expiresAtMs > value.deadline * 1000 ||
    typeof value.signature !== 'string' || !/^0x[0-9a-fA-F]{130}$/.test(value.signature) || !record(value.transaction)) return invalid();
  const transaction = value.transaction;
  if (transaction.chainId !== expected.chainId || ethereumAddress(transaction.to) !== expected.contractAddress ||
    typeof transaction.value !== 'string' || !/^0x[0-9a-fA-F]+$/.test(transaction.value) ||
    typeof transaction.data !== 'string' || transaction.data.toLowerCase() !== encodePre111kReservation(value.nonce, value.deadline, value.signature).toLowerCase()) {
    throw new Error('The reservation does not match your wallet or payment. Please try again.');
  }
  if (BigInt(transaction.value) !== BigInt(expected.priceWei)) throw new Pre111kPriceChanged();
  return value.transaction;
}

export const pre111kApi = {
  async verifyAccess(code: string, signal?: AbortSignal): Promise<Pre111kAccessResponse> {
    const value = await request(PRE111K_API_PATHS.access, { code }, signal);
    if (!record(value) || value.ok !== true) return invalid();
    return { ok: true };
  },
  async status(network: Pre111kNetwork, wallet: string | null, signal?: AbortSignal): Promise<Pre111kStatus> {
    const params = new URLSearchParams({ network });
    if (wallet) params.set('wallet', wallet);
    const value = await request(`${PRE111K_API_PATHS.status}?${params}`, undefined, signal);
    if (!record(value) || (wallet === null ? value.wallet !== null : ethereumAddress(value.wallet) !== wallet)) return invalid();
    const parsed = config(value.config, network);
    if (parsed.contractAddress === null) {
      if (['totalReserved', 'reservedRelics', 'remainingRelics', 'observedBlock', 'blockHash'].some(key => value[key] !== null)) return invalid();
    } else if (!count(value.totalReserved) || !count(value.remainingRelics) || value.remainingRelics !== parsed.maxRelics - value.totalReserved ||
      (wallet === null ? value.reservedRelics !== null : !count(value.reservedRelics) || value.reservedRelics > value.totalReserved) ||
      !Number.isSafeInteger(value.observedBlock) || Number(value.observedBlock) < 0 ||
      typeof value.blockHash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(value.blockHash)) return invalid();
    return { ...value, wallet, config: parsed } as Pre111kStatus;
  },
  async prepare(network: Pre111kNetwork, wallet: string, code: string, signal?: AbortSignal): Promise<Pre111kPrepareResponse> {
    return await request(PRE111K_API_PATHS.prepare, { network, wallet, code }, signal) as Pre111kPrepareResponse;
  },
  async confirm(network: Pre111kNetwork, wallet: string, transactionHash: string, signal?: AbortSignal): Promise<Pre111kConfirmResponse> {
    const value = await request(PRE111K_API_PATHS.confirm, { network, wallet, transactionHash }, signal);
    if (!record(value) || typeof value.status !== 'string' || !['pending', 'confirmed', 'failed'].includes(value.status) ||
      typeof value.transactionHash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(value.transactionHash) ||
      value.transactionHash.toLowerCase() !== transactionHash.toLowerCase() ||
      !Number.isSafeInteger(value.confirmations) || Number(value.confirmations) < 0 ||
      value.reservationNonce !== null && (!count(value.reservationNonce) || value.reservationNonce >= PRE111K_MAX_RELICS)) return invalid();
    return { ...value, transactionHash: value.transactionHash.toLowerCase() } as Pre111kConfirmResponse;
  },
};
