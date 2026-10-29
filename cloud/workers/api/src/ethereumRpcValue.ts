import { EthereumApiError } from './ethereumError.js';

export function rpcInteger(value: unknown): number {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]+$/.test(value)) {
    throw new EthereumApiError('unavailable', 'Invalid Ethereum block number.');
  }
  const number = Number(BigInt(value));
  if (!Number.isSafeInteger(number) || number < 0) throw new EthereumApiError('unavailable', 'Invalid Ethereum number.');
  return number;
}
