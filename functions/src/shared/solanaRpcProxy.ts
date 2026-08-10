import bs58 from 'bs58';

export const SHOP_RPC_METHODS = [
  'getAccountInfo',
  'getMultipleAccounts',
  'getLatestBlockhash',
  'getSignatureStatuses',
  'isBlockhashValid',
  'simulateTransaction',
  'sendTransaction',
] as const;

export type ShopRpcMethod = typeof SHOP_RPC_METHODS[number];
export type ShopRpcId = string | number;

export type ShopRpcRequest = {
  jsonrpc: '2.0';
  id: ShopRpcId;
  method: ShopRpcMethod;
  params: unknown[];
};

type ShopRpcError = {
  code: number;
  message: string;
  data?: unknown;
};

export type ShopRpcResponse = {
  jsonrpc: '2.0';
  id: ShopRpcId;
  result?: unknown;
  error?: ShopRpcError;
};

const SHOP_RPC_METHOD_SET = new Set<string>(SHOP_RPC_METHODS);
const MAX_TRANSACTION_BYTES = 1232;
const MAX_MULTIPLE_ACCOUNTS = 32;
const MAX_DATA_SLICE_BYTES = 2 * 1024 * 1024;
const MAX_AGGREGATE_DATA_SLICE_BYTES = 2_900_000;
const BASE58_ALPHABET_PATTERN = /^[1-9A-HJ-NP-Za-km-z]+$/;
const BASE58_BYTE_LENGTH_RANGES = new Map<number, readonly [number, number]>([
  [32, [32, 44]],
  [64, [64, 88]],
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(value);
  return required.every((key) => Object.prototype.hasOwnProperty.call(value, key)) && keys.every((key) => allowed.has(key));
}

function isSafeNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

export function isBase58Bytes(value: unknown, length: number): boolean {
  if (typeof value !== 'string') return false;
  const encodedLengthRange = BASE58_BYTE_LENGTH_RANGES.get(length);
  if (
    !encodedLengthRange ||
    value.length < encodedLengthRange[0] ||
    value.length > encodedLengthRange[1] ||
    !BASE58_ALPHABET_PATTERN.test(value)
  ) return false;
  try {
    return bs58.decode(value).byteLength === length;
  } catch {
    return false;
  }
}

function isCommitmentConfig(
  value: unknown,
  optionalKeys: readonly string[] = [],
): value is Record<string, unknown> {
  if (!isRecord(value) || !hasExactKeys(value, ['commitment'], optionalKeys)) return false;
  return value.commitment === 'confirmed';
}

type DataSlice = {
  offset: number;
  length: number;
};

function isDataSlice(value: unknown): value is DataSlice {
  return isRecord(value) &&
    hasExactKeys(value, ['offset', 'length']) &&
    isSafeNonNegativeInteger(value.offset) &&
    isSafeNonNegativeInteger(value.length) &&
    Number(value.length) <= MAX_DATA_SLICE_BYTES;
}

function isAccountConfig(value: unknown): boolean {
  if (!isCommitmentConfig(value, ['encoding', 'dataSlice', 'minContextSlot'])) return false;
  if (value.encoding !== 'base64') return false;
  if (value.dataSlice !== undefined && !isDataSlice(value.dataSlice)) return false;
  return value.minContextSlot === undefined || isSafeNonNegativeInteger(value.minContextSlot);
}

function isMultipleAccountsConfig(value: unknown, accountCount: number): boolean {
  if (!isAccountConfig(value) || !isRecord(value)) return false;
  if (value.dataSlice === undefined) return true;
  const dataSlice = value.dataSlice;
  return isDataSlice(dataSlice) &&
    dataSlice.length * accountCount <= MAX_AGGREGATE_DATA_SLICE_BYTES;
}

function isBase64Transaction(value: unknown): value is string {
  if (typeof value !== 'string' || !value || value.length > 2048 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return false;
  try {
    const decoded = atob(value);
    return decoded.length > 0 && decoded.length <= MAX_TRANSACTION_BYTES;
  } catch {
    return false;
  }
}

function isSimulationConfig(value: unknown): boolean {
  return isRecord(value) &&
    hasExactKeys(value, ['commitment', 'encoding', 'sigVerify']) &&
    value.commitment === 'confirmed' &&
    value.encoding === 'base64' &&
    value.sigVerify === false;
}

function isSendConfig(value: unknown): boolean {
  if (!isRecord(value) || !hasExactKeys(
    value,
    ['encoding', 'preflightCommitment'],
    ['maxRetries', 'minContextSlot', 'skipPreflight'],
  )) return false;
  if (value.encoding !== 'base64' || value.preflightCommitment !== 'confirmed') return false;
  if (value.skipPreflight !== undefined && value.skipPreflight !== false) return false;
  if (value.maxRetries !== undefined && (!isSafeNonNegativeInteger(value.maxRetries) || Number(value.maxRetries) > 3)) return false;
  return value.minContextSlot === undefined || isSafeNonNegativeInteger(value.minContextSlot);
}

function isValidParams(method: ShopRpcMethod, params: unknown[]): boolean {
  if (method === 'getAccountInfo') {
    return params.length === 2 && isBase58Bytes(params[0], 32) && isAccountConfig(params[1]);
  }
  if (method === 'getMultipleAccounts') {
    return params.length === 2 &&
      Array.isArray(params[0]) &&
      params[0].length > 0 &&
      params[0].length <= MAX_MULTIPLE_ACCOUNTS &&
      params[0].every((address) => isBase58Bytes(address, 32)) &&
      isMultipleAccountsConfig(params[1], params[0].length);
  }
  if (method === 'getLatestBlockhash') {
    return params.length === 1 && isCommitmentConfig(params[0], ['minContextSlot']) &&
      (params[0].minContextSlot === undefined || isSafeNonNegativeInteger(params[0].minContextSlot));
  }
  if (method === 'getSignatureStatuses') {
    return (params.length === 1 || params.length === 2) &&
      Array.isArray(params[0]) &&
      params[0].length === 1 &&
      isBase58Bytes(params[0][0], 64) &&
      (params.length === 1 || (
        isRecord(params[1]) &&
        hasExactKeys(params[1], [], ['searchTransactionHistory']) &&
        (params[1].searchTransactionHistory === undefined || typeof params[1].searchTransactionHistory === 'boolean')
      ));
  }
  if (method === 'isBlockhashValid') {
    return params.length === 2 && isBase58Bytes(params[0], 32) && isCommitmentConfig(params[1], ['minContextSlot']) &&
      (params[1].minContextSlot === undefined || isSafeNonNegativeInteger(params[1].minContextSlot));
  }
  if (method === 'simulateTransaction') {
    return params.length === 2 && isBase64Transaction(params[0]) && isSimulationConfig(params[1]);
  }
  return params.length === 2 && isBase64Transaction(params[0]) && isSendConfig(params[1]);
}

function isShopRpcMethod(value: unknown): value is ShopRpcMethod {
  return typeof value === 'string' && SHOP_RPC_METHOD_SET.has(value);
}

export function isExactShopRpcRequest(value: unknown): value is ShopRpcRequest {
  if (!isRecord(value) || !hasExactKeys(value, ['jsonrpc', 'id', 'method', 'params'])) return false;
  if (value.jsonrpc !== '2.0' || !isShopRpcMethod(value.method) || !Array.isArray(value.params)) return false;
  const idValid = (typeof value.id === 'string' && value.id.length > 0 && value.id.length <= 64) ||
    (typeof value.id === 'number' && Number.isSafeInteger(value.id));
  return idValid && isValidParams(value.method, value.params);
}

export function isExactShopRpcResponse(value: unknown, expectedId: ShopRpcId): value is ShopRpcResponse {
  if (!isRecord(value) || value.jsonrpc !== '2.0' || value.id !== expectedId) return false;
  const hasResult = Object.prototype.hasOwnProperty.call(value, 'result');
  const hasError = Object.prototype.hasOwnProperty.call(value, 'error');
  if (hasResult === hasError) return false;
  if (hasResult) return hasExactKeys(value, ['jsonrpc', 'id', 'result']);
  if (!hasExactKeys(value, ['jsonrpc', 'id', 'error']) || !isRecord(value.error)) return false;
  return hasExactKeys(value.error, ['code', 'message'], ['data']) &&
    Number.isInteger(value.error.code) &&
    typeof value.error.message === 'string';
}

export function isTransientShopRpcError(value: unknown): boolean {
  if (!isRecord(value) || !Number.isInteger(value.code)) return false;
  if (value.code === 408 || value.code === 429 || value.code === -32005 || value.code === -32603) return true;
  const message = typeof value.message === 'string' ? value.message.toLowerCase() : '';
  return /timeout|timed out|rate limit|temporar|overload|internal/.test(message);
}
