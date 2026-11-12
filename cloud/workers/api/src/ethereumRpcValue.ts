import { EthereumApiError } from './ethereumError.js';

export type EthereumRpcEnvelope = { jsonrpc: '2.0'; id: number; result?: unknown; error?: unknown };

export function validEthereumRpcResponse(payload: { id: number } | { id: number }[], value: unknown): value is EthereumRpcEnvelope | EthereumRpcEnvelope[] {
  if (Array.isArray(value) !== Array.isArray(payload)) return false;
  const calls = Array.isArray(payload) ? payload : [payload];
  const answers: unknown[] = Array.isArray(value) ? value : [value];
  if (!calls.length || answers.length !== calls.length) return false;
  const ids = new Set(calls.map(call => call.id));
  return answers.every(answer => answer !== null && typeof answer === 'object' && !Array.isArray(answer) &&
    'jsonrpc' in answer && answer.jsonrpc === '2.0' && 'id' in answer && typeof answer.id === 'number' && ids.delete(answer.id) &&
    ('result' in answer) !== ('error' in answer) &&
    (!('error' in answer) || answer.error !== null && typeof answer.error === 'object' && !Array.isArray(answer.error) &&
      'code' in answer.error && Number.isInteger(answer.error.code) &&
      'message' in answer.error && typeof answer.error.message === 'string'));
}

export function rpcInteger(value: unknown): number {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]+$/.test(value)) {
    throw new EthereumApiError('unavailable', 'Invalid Ethereum block number.');
  }
  const number = Number(BigInt(value));
  if (!Number.isSafeInteger(number) || number < 0) throw new EthereumApiError('unavailable', 'Invalid Ethereum number.');
  return number;
}
