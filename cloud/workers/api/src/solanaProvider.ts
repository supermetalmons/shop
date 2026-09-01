import { PublicKey } from '@solana/web3.js';
import type { DasAsset } from '../../../../shared/dasAsset.js';
import { HELIUS_COLLECTION_GROUPING_OPTIONS } from '../../../../shared/dasAssetCollections.js';
import type { SolanaCluster } from '../../../../shared/deploymentCore.js';
import {
  isExactShopRpcResponse,
  type ShopRpcId,
} from '../../../../shared/solanaRpcProxy.js';
import {
  cancelResponseBody,
  readBoundedResponseJson,
  readBoundedResponseText,
  type ProfileProviderFetch,
  type ResponseBodyFailure,
} from './boundedResponse.js';
import {
  createTimedAbortScope,
  isSignalCancellationError,
  raceWithSignal,
  sleepWithSignal,
} from './boundedRequest.js';
import { isRecord } from './dataAccess.js';

export type SolanaProviderFailureKind =
  | 'network'
  | 'timeout'
  | 'http'
  | 'rpc'
  | 'body'
  | 'invalid-response'
  | 'not-found';

export type SolanaProviderErrorReason =
  | 'account-shape'
  | 'account-data'
  | 'asset-shape'
  | 'proof-shape';

export class SolanaProviderError extends Error {
  readonly kind: SolanaProviderFailureKind;
  readonly method?: string;
  readonly status?: number;
  readonly rpcCode?: number;
  readonly rpcData?: unknown;
  readonly resource?: 'asset' | 'asset-proof';
  readonly reason?: SolanaProviderErrorReason;
  readonly bodyFailure?: ResponseBodyFailure;

  constructor(
    kind: SolanaProviderFailureKind,
    message: string,
    options: Readonly<{
      cause?: unknown;
      method?: string;
      status?: number;
      rpcCode?: number;
      rpcData?: unknown;
      resource?: 'asset' | 'asset-proof';
      reason?: SolanaProviderErrorReason;
      bodyFailure?: ResponseBodyFailure;
    }> = {},
  ) {
    super(message);
    this.name = 'SolanaProviderError';
    this.kind = kind;
    this.method = options.method;
    this.status = options.status;
    this.rpcCode = options.rpcCode;
    this.rpcData = options.rpcData;
    this.resource = options.resource;
    this.reason = options.reason;
    this.bodyFailure = options.bodyFailure;
    if (options.cause !== undefined) Object.defineProperty(this, 'cause', { value: options.cause });
  }
}

export type SolanaRetryPolicy = Readonly<{
  attempts: number;
  delayMs: (failure: SolanaProviderError, attemptNumber: number) => number;
  shouldRetry: (failure: SolanaProviderError, attemptNumber: number) => boolean;
}>;

export type SolanaRpcEnvelope = 'basic' | 'strict';
export type SolanaRpcErrorMode = 'record' | 'truthy';
export type SolanaRpcRedirect = 'follow' | 'manual';

export type SolanaProviderAttemptEvent = Readonly<{
  attemptNumber: number;
  failure?: SolanaProviderError;
  method: string;
  phase: 'start' | 'success' | 'failure';
}>;

export type SolanaProviderOptions = Readonly<{
  apiKey: string;
  attemptTimeoutMs: number | null;
  cluster: SolanaCluster;
  envelope?: SolanaRpcEnvelope;
  fetch: ProfileProviderFetch;
  maxResponseBytes: number;
  onAttempt?: (event: SolanaProviderAttemptEvent) => void;
  requestId: (method: string, attemptNumber: number) => ShopRpcId;
  retry: SolanaRetryPolicy;
  signal: AbortSignal;
}>;

export type SolanaRpcCallOptions = Readonly<{
  accept?: 'application/json';
  attemptTimeoutMs?: number | null;
  envelope?: SolanaRpcEnvelope;
  errorMode?: SolanaRpcErrorMode;
  onAttempt?: (event: SolanaProviderAttemptEvent) => void;
  redirect?: SolanaRpcRedirect;
  requestId?: (method: string, attemptNumber: number) => ShopRpcId;
  retry?: SolanaRetryPolicy;
}>;

export type SolanaAssetIndexingRetry = Readonly<{
  attempts: number;
  baseDelayMs: number;
  capDelayToRemaining: boolean;
  maxElapsedMs: number;
}>;

export type SolanaAssetOptions = Readonly<{
  indexingRetry?: SolanaAssetIndexingRetry;
  restRetry?: SolanaRetryPolicy;
}>;

export type SolanaAssetProofOptions = Readonly<{
  restRetry?: SolanaRetryPolicy;
}>;

export type SolanaRpcTransportResult =
  | { kind: 'result'; value: unknown }
  | { kind: 'rpc-error'; error: Record<string, unknown> }
  | { kind: 'http-error'; status: number }
  | { kind: 'invalid-response' };

export type SolanaRpcRawResult = Readonly<{
  payload: Record<string, unknown>;
  response: Response;
  text: string;
}>;

export type SolanaProvider = Readonly<{
  getAsset: (id: string, options?: SolanaAssetOptions) => Promise<DasAsset>;
  getAssetProof: (id: string, options?: SolanaAssetProofOptions) => Promise<Record<string, unknown>>;
  rpc: (method: string, params: unknown, options?: SolanaRpcCallOptions) => Promise<unknown>;
}>;

function validAttempts(attempts: number): number {
  if (!Number.isSafeInteger(attempts) || attempts < 1) {
    throw new RangeError('attempts must be a positive safe integer');
  }
  return attempts;
}

function rpcErrorDetails(value: Record<string, unknown>): Readonly<{
  code?: number;
  data?: unknown;
  message: string;
}> {
  const code = Number(value.code);
  return {
    ...(Number.isInteger(code) ? { code } : {}),
    ...(Object.hasOwn(value, 'data') ? { data: value.data } : {}),
    message: typeof value.message === 'string' ? value.message : 'Solana RPC request failed',
  };
}

function basicRpcEnvelope(value: unknown, id: ShopRpcId): value is Record<string, unknown> {
  return isRecord(value) && value.jsonrpc === '2.0' && value.id === id;
}

function providerResponseError(cause?: unknown): SolanaProviderError {
  return new SolanaProviderError('invalid-response', 'Solana provider returned an invalid response', { cause });
}

function providerBodyError(
  failure: ResponseBodyFailure,
  cause?: unknown,
  method?: string,
): SolanaProviderError {
  return new SolanaProviderError(
    failure === 'stream-failed' ? 'network' : 'body',
    'Solana provider returned an invalid response',
    { bodyFailure: failure, cause, method },
  );
}

function emitAttempt(
  handler: ((event: SolanaProviderAttemptEvent) => void) | undefined,
  event: SolanaProviderAttemptEvent,
): void {
  try {
    handler?.(event);
  } catch {}
}

export function heliusRpcUrl(cluster: SolanaCluster, apiKey: string): string {
  const subdomain = cluster === 'mainnet-beta' ? 'mainnet' : cluster;
  return `https://${subdomain}.helius-rpc.com/?api-key=${encodeURIComponent(apiKey)}`;
}

async function readSolanaRpcRawResponse(args: Readonly<{
  body: Readonly<{ jsonrpc: '2.0'; id: ShopRpcId; method: string; params: unknown }>;
  contentType: 'require-json' | 'ignore';
  envelope: SolanaRpcEnvelope;
  maxResponseBytes: number;
  response: Response;
  signal: AbortSignal;
}>): Promise<SolanaRpcRawResult> {
  if (
    args.contentType === 'require-json' &&
    args.response.headers.get('Content-Type')?.split(';', 1)[0].trim().toLowerCase() !== 'application/json'
  ) {
    await cancelResponseBody(args.response);
    throw providerBodyError('unexpected-content-type', undefined, args.body.method);
  }
  const text = await readBoundedResponseText(args.response, {
    maxBytes: args.maxResponseBytes,
    signal: args.signal,
    createError: (failure, cause) => providerBodyError(failure, cause, args.body.method),
  });
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch (error) {
    throw providerBodyError('invalid-json', error, args.body.method);
  }
  const valid = args.envelope === 'strict'
    ? isExactShopRpcResponse(payload, args.body.id)
    : basicRpcEnvelope(payload, args.body.id);
  if (!valid || !isRecord(payload)) throw providerResponseError();
  return { payload, response: args.response, text };
}

export async function requestSolanaRpcRaw(args: Readonly<{
  body: Readonly<{ jsonrpc: '2.0'; id: ShopRpcId; method: string; params: unknown }>;
  contentType: 'require-json' | 'ignore';
  envelope: SolanaRpcEnvelope;
  fetch: ProfileProviderFetch;
  maxResponseBytes: number;
  redirect?: SolanaRpcRedirect;
  signal: AbortSignal;
  url: string;
}>): Promise<SolanaRpcRawResult> {
  if (args.signal.aborted) throw args.signal.reason;
  const response = await raceWithSignal(args.fetch(args.url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(args.body),
    ...(args.redirect === 'follow' ? {} : { redirect: 'manual' as const }),
    signal: args.signal,
  }), args.signal);
  return readSolanaRpcRawResponse({ ...args, response });
}

async function requestSolanaRpc(args: Readonly<{
  accept?: 'application/json';
  contentType?: 'require-json' | 'ignore';
  envelope?: SolanaRpcEnvelope;
  errorMode?: SolanaRpcErrorMode;
  fetch: ProfileProviderFetch;
  id: ShopRpcId;
  maxResponseBytes: number;
  method: string;
  params: unknown;
  redirect?: SolanaRpcRedirect;
  signal: AbortSignal;
  url: string;
}>): Promise<SolanaRpcTransportResult> {
  if (args.signal.aborted) throw args.signal.reason;
  const body = { jsonrpc: '2.0' as const, id: args.id, method: args.method, params: args.params };
  const response = await raceWithSignal(args.fetch(args.url, {
    method: 'POST',
    headers: {
      ...(args.accept ? { Accept: args.accept } : {}),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    ...(args.redirect === 'follow' ? {} : { redirect: 'manual' as const }),
    signal: args.signal,
  }), args.signal);
  if (!response.ok) {
    await cancelResponseBody(response);
    return { kind: 'http-error', status: response.status };
  }
  let payload: Record<string, unknown>;
  try {
    const raw = await readSolanaRpcRawResponse({
      body,
      contentType: args.contentType || 'require-json',
      envelope: args.envelope || 'basic',
      maxResponseBytes: args.maxResponseBytes,
      response,
      signal: args.signal,
    });
    payload = raw.payload;
  } catch (error) {
    if (args.signal.aborted && error === args.signal.reason) throw error;
    if (error instanceof SolanaProviderError && error.kind === 'invalid-response') {
      return { kind: 'invalid-response' };
    }
    throw error;
  }
  if (isRecord(payload.error)) return { kind: 'rpc-error', error: payload.error };
  if (args.errorMode === 'truthy' && payload.error) return { kind: 'rpc-error', error: {} };
  return Object.hasOwn(payload, 'result')
    ? { kind: 'result', value: payload.result }
    : { kind: 'invalid-response' };
}

function transportFailure(
  result: Exclude<SolanaRpcTransportResult, { kind: 'result' }>,
  method: string,
): SolanaProviderError {
  if (result.kind === 'http-error') {
    return new SolanaProviderError('http', 'Solana provider request failed', {
      method,
      status: result.status,
    });
  }
  if (result.kind === 'rpc-error') {
    const details = rpcErrorDetails(result.error);
    return new SolanaProviderError('rpc', details.message, {
      method,
      rpcCode: details.code,
      rpcData: details.data,
    });
  }
  return new SolanaProviderError('invalid-response', 'Solana provider returned an invalid response', { method });
}

function networkFailure(error: unknown, method: string): SolanaProviderError {
  return error instanceof SolanaProviderError
    ? error
    : new SolanaProviderError('network', 'Solana provider request failed', { cause: error, method });
}

async function runRpc(
  provider: SolanaProviderOptions,
  method: string,
  params: unknown,
  overrides: SolanaRpcCallOptions = {},
): Promise<unknown> {
  const retry = overrides.retry || provider.retry;
  const onAttempt = overrides.onAttempt || provider.onAttempt;
  const attempts = validAttempts(retry.attempts);
  for (let index = 0; index < attempts; index += 1) {
    if (provider.signal.aborted) throw provider.signal.reason;
    const attemptNumber = index + 1;
    const timeoutMs = overrides.attemptTimeoutMs === undefined
      ? provider.attemptTimeoutMs
      : overrides.attemptTimeoutMs;
    const scope = timeoutMs === null
      ? null
      : createTimedAbortScope(provider.signal, {
          timeoutMs,
          timeoutMessage: 'Solana provider request timed out',
        });
    const signal = scope?.signal || provider.signal;
    if (signal.aborted) {
      scope?.dispose();
      throw signal.reason;
    }
    emitAttempt(onAttempt, { attemptNumber, method, phase: 'start' });
    let failure: SolanaProviderError | undefined;
    try {
      const result = await requestSolanaRpc({
        accept: overrides.accept,
        envelope: overrides.envelope || provider.envelope || 'basic',
        errorMode: overrides.errorMode || 'record',
        fetch: provider.fetch,
        id: (overrides.requestId || provider.requestId)(method, attemptNumber),
        maxResponseBytes: provider.maxResponseBytes,
        method,
        params,
        redirect: overrides.redirect || 'manual',
        signal,
        url: heliusRpcUrl(provider.cluster, provider.apiKey),
      });
      if (result.kind !== 'result') throw transportFailure(result, method);
      emitAttempt(onAttempt, { attemptNumber, method, phase: 'success' });
      return result.value;
    } catch (error) {
      if (isSignalCancellationError(provider.signal, error)) throw provider.signal.reason;
      failure = scope?.timedOut()
        ? new SolanaProviderError('timeout', 'Solana provider request timed out', { cause: error, method })
        : networkFailure(error, method);
      emitAttempt(onAttempt, { attemptNumber, failure, method, phase: 'failure' });
    } finally {
      scope?.dispose();
    }
    if (provider.signal.aborted) throw failure;
    if (attemptNumber >= attempts || !retry.shouldRetry(failure, attemptNumber)) throw failure;
    await sleepWithSignal(retry.delayMs(failure, attemptNumber), provider.signal);
  }
  throw new SolanaProviderError('network', 'Solana provider request failed', { method });
}

async function requestRestJson(
  provider: SolanaProviderOptions,
  url: string,
  method: string,
  retry: SolanaRetryPolicy,
): Promise<unknown> {
  const attempts = validAttempts(retry.attempts);
  for (let index = 0; index < attempts; index += 1) {
    if (provider.signal.aborted) throw provider.signal.reason;
    const attemptNumber = index + 1;
    const scope = provider.attemptTimeoutMs === null
      ? null
      : createTimedAbortScope(provider.signal, {
          timeoutMs: provider.attemptTimeoutMs,
          timeoutMessage: 'Solana provider request timed out',
        });
    const signal = scope?.signal || provider.signal;
    if (signal.aborted) {
      scope?.dispose();
      throw signal.reason;
    }
    emitAttempt(provider.onAttempt, { attemptNumber, method, phase: 'start' });
    let failure: SolanaProviderError | undefined;
    try {
      const response = await raceWithSignal(provider.fetch(url, {
        headers: { Accept: 'application/json' },
        redirect: 'manual',
        signal,
      }), signal);
      if (!response.ok) {
        await cancelResponseBody(response);
        throw new SolanaProviderError(
          response.status === 404 ? 'not-found' : 'http',
          'Solana provider request failed',
          { method, status: response.status },
        );
      }
      const value = await readBoundedResponseJson(response, {
        maxBytes: provider.maxResponseBytes,
        signal,
        contentType: 'require-json',
        createError: (failure, cause) => providerBodyError(failure, cause, method),
      });
      emitAttempt(provider.onAttempt, { attemptNumber, method, phase: 'success' });
      return value;
    } catch (error) {
      if (isSignalCancellationError(provider.signal, error)) throw provider.signal.reason;
      failure = scope?.timedOut()
        ? new SolanaProviderError('timeout', 'Solana provider request timed out', { cause: error, method })
        : networkFailure(error, method);
      emitAttempt(provider.onAttempt, { attemptNumber, failure, method, phase: 'failure' });
    } finally {
      scope?.dispose();
    }
    if (provider.signal.aborted) throw failure;
    if (attemptNumber >= attempts || !retry.shouldRetry(failure, attemptNumber)) throw failure;
    await sleepWithSignal(retry.delayMs(failure, attemptNumber), provider.signal);
  }
  throw new SolanaProviderError('network', 'Solana provider request failed', { method });
}

function restClusterQuery(cluster: SolanaCluster): string {
  return cluster === 'mainnet-beta' ? '' : `&cluster=${encodeURIComponent(cluster)}`;
}

function retryableIndexingFailure(error: unknown): boolean {
  return error instanceof SolanaProviderError && [
    'network',
    'timeout',
    'http',
    'rpc',
    'body',
    'invalid-response',
    'not-found',
  ].includes(error.kind);
}

export function createSolanaProvider(options: SolanaProviderOptions): SolanaProvider {
  validAttempts(options.retry.attempts);
  const rpc = (method: string, params: unknown, overrides?: SolanaRpcCallOptions) =>
    runRpc(options, method, params, overrides);

  const getAssetOnce = async (id: string, assetOptions: SolanaAssetOptions): Promise<DasAsset> => {
    let value: unknown;
    try {
      value = await rpc('getAsset', { id, options: HELIUS_COLLECTION_GROUPING_OPTIONS });
    } catch (error) {
      if (!(error instanceof SolanaProviderError) || error.kind !== 'rpc' || ![-32601, -32602].includes(error.rpcCode || 0)) {
        throw error;
      }
      const payload = await requestRestJson(
        options,
        `https://api.helius.xyz/v0/assets?ids[]=${encodeURIComponent(id)}&api-key=${encodeURIComponent(options.apiKey)}${restClusterQuery(options.cluster)}`,
        'getAssetRest',
        assetOptions.restRetry || options.retry,
      );
      value = Array.isArray(payload) ? payload[0] : undefined;
    }
    if (!isRecord(value)) {
      throw new SolanaProviderError('not-found', 'Solana asset was not found', {
        resource: 'asset',
        reason: 'asset-shape',
      });
    }
    return value as DasAsset;
  };

  const getAsset = async (id: string, assetOptions: SolanaAssetOptions = {}): Promise<DasAsset> => {
    const indexing = assetOptions.indexingRetry;
    if (!indexing) return getAssetOnce(id, assetOptions);
    const attempts = validAttempts(indexing.attempts);
    const startedAt = Date.now();
    let lastError: unknown;
    for (let index = 0; index < attempts && Date.now() - startedAt < indexing.maxElapsedMs; index += 1) {
      try {
        return await getAssetOnce(id, assetOptions);
      } catch (error) {
        lastError = error;
        if (!retryableIndexingFailure(error)) throw error;
      }
      if (index + 1 < attempts) {
        const delay = indexing.baseDelayMs * 2 ** index;
        const remaining = indexing.maxElapsedMs - (Date.now() - startedAt);
        if (remaining > 0) {
          await sleepWithSignal(indexing.capDelayToRemaining ? Math.min(delay, remaining) : delay, options.signal);
        }
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new SolanaProviderError('not-found', 'Solana asset was not found', { resource: 'asset' });
  };

  const getAssetProof = async (
    id: string,
    proofOptions: SolanaAssetProofOptions = {},
  ): Promise<Record<string, unknown>> => {
    let value: unknown;
    try {
      value = await rpc('getAssetProof', { id });
    } catch (error) {
      if (!(error instanceof SolanaProviderError) || error.kind !== 'rpc' || ![-32601, -32602].includes(error.rpcCode || 0)) {
        throw error;
      }
      value = await requestRestJson(
        options,
        `https://api.helius.xyz/v0/assets/${encodeURIComponent(id)}/proof?api-key=${encodeURIComponent(options.apiKey)}${restClusterQuery(options.cluster)}`,
        'getAssetProofRest',
        proofOptions.restRetry || options.retry,
      );
    }
    if (!isRecord(value)) {
      throw new SolanaProviderError('not-found', 'Solana asset proof was not found', {
        resource: 'asset-proof',
        reason: 'proof-shape',
      });
    }
    return value;
  };

  return { getAsset, getAssetProof, rpc };
}

export function parseSolanaRpcAccount(
  value: unknown,
  options: Readonly<{ maxEncodedBytes: number }>,
): { owner: PublicKey; data: Uint8Array } {
  if (!isRecord(value) || typeof value.owner !== 'string' || !Array.isArray(value.data)) {
    throw new SolanaProviderError('invalid-response', 'Solana account response is invalid', {
      reason: 'account-shape',
    });
  }
  const encoded = value.data[0];
  if (
    typeof encoded !== 'string' ||
    value.data[1] !== 'base64' ||
    encoded.length > options.maxEncodedBytes
  ) {
    throw new SolanaProviderError('invalid-response', 'Solana account data is invalid', {
      reason: 'account-data',
    });
  }
  try {
    return { owner: new PublicKey(value.owner), data: Buffer.from(encoded, 'base64') };
  } catch (error) {
    throw new SolanaProviderError('invalid-response', 'Solana account data is invalid', {
      cause: error,
      reason: 'account-data',
    });
  }
}
