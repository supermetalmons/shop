import { Connection, type FetchFn } from '@solana/web3.js';
import type { SolanaCluster } from '../../../../shared/deploymentCore.js';
import {
  createTimedAbortScope,
  isSignalCancellationError,
  raceWithSignal,
} from './boundedRequest.js';
import {
  cancelResponseBody,
  readBoundedResponseBytes,
  type ProfileProviderFetch,
} from './boundedResponse.js';
import { heliusRpcUrl, SolanaProviderError } from './solanaProvider.js';

function cancellationError(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error('Solana request cancelled', { cause: reason });
}

export function createSolanaConnection(options: Readonly<{
  apiKey: string;
  cluster: SolanaCluster;
  fetch: ProfileProviderFetch;
  signal: AbortSignal;
  attemptTimeoutMs?: number;
  maxResponseBytes?: number;
  mapError: (failure: SolanaProviderError) => Error;
}>): Connection {
  const attemptTimeoutMs = options.attemptTimeoutMs ?? 8_000;
  const maxResponseBytes = options.maxResponseBytes ?? 2 * 1024 * 1024;
  if (!Number.isFinite(attemptTimeoutMs) || attemptTimeoutMs < 0) {
    throw new RangeError('attemptTimeoutMs must be a non-negative finite number');
  }
  if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 0) {
    throw new RangeError('maxResponseBytes must be a non-negative safe integer');
  }
  const boundedFetch: FetchFn = async (input, init) => {
    const parentSignal = init?.signal
      ? AbortSignal.any([options.signal, init.signal])
      : options.signal;
    if (parentSignal.aborted) throw cancellationError(parentSignal.reason);
    const scope = createTimedAbortScope(parentSignal, {
      timeoutMs: attemptTimeoutMs,
      timeoutMessage: 'Solana provider request timed out',
    });
    let response: Response | undefined;
    try {
      scope.signal.throwIfAborted();
      const pendingResponse = options.fetch(input, {
        ...init,
        redirect: 'manual',
        signal: scope.signal,
      }).then(async (fetchedResponse) => {
        response = fetchedResponse;
        if (scope.signal.aborted) {
          await cancelResponseBody(response, scope.signal.reason);
          throw scope.signal.reason;
        }
        return response;
      });
      const fetchedResponse = await raceWithSignal(pendingResponse, scope.signal);
      if (!fetchedResponse.ok) {
        throw new SolanaProviderError('http', 'Solana provider request failed', { status: fetchedResponse.status });
      }
      const body = await readBoundedResponseBytes(fetchedResponse, {
        maxBytes: maxResponseBytes,
        signal: scope.signal,
        createError: (failure, cause) => new SolanaProviderError(
          failure === 'stream-failed' ? 'network' : 'body',
          'Solana provider returned an invalid response',
          { bodyFailure: failure, cause },
        ),
      });
      return new Response(Uint8Array.from(body).buffer, {
        status: fetchedResponse.status,
        statusText: fetchedResponse.statusText,
        headers: fetchedResponse.headers,
      });
    } catch (error) {
      if (response) await cancelResponseBody(response);
      if (isSignalCancellationError(parentSignal, error)) throw cancellationError(parentSignal.reason);
      const failure = scope.timedOut() && isSignalCancellationError(scope.signal, error)
        ? new SolanaProviderError('timeout', 'Solana provider request timed out', { cause: error })
        : error instanceof SolanaProviderError
          ? error
          : new SolanaProviderError('network', 'Solana provider request failed', { cause: error });
      throw options.mapError(failure);
    } finally {
      scope.dispose();
    }
  };
  return new Connection(heliusRpcUrl(options.cluster, options.apiKey), {
    commitment: 'confirmed',
    disableRetryOnRateLimit: true,
    fetch: boundedFetch,
  });
}
