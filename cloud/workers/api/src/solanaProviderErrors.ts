import { isSignalCancellationError } from './boundedRequest.js';
import { SolanaProviderError } from './solanaProvider.js';

export function translateSolanaProviderError<Failure extends Error>(error: unknown, options: {
  signal: AbortSignal;
  providerName: string;
  createError: (code: 'unavailable' | 'deadline-exceeded', message: string, details?: unknown) => Failure;
  notFound: (failure: SolanaProviderError) => Failure | undefined;
}): Failure {
  if (isSignalCancellationError(options.signal, error)) throw options.signal.reason;
  const unavailable = `${options.providerName} is temporarily unavailable.`;
  if (error instanceof SolanaProviderError) {
    if (error.kind === 'timeout') {
      return options.createError('deadline-exceeded', `${options.providerName} request timed out.`);
    }
    if (error.kind === 'invalid-response' ||
      ((error.kind === 'network' || error.kind === 'body') && error.method?.endsWith('Rest'))) {
      return options.createError('unavailable', `${options.providerName} returned an invalid response.`);
    }
    if (error.kind === 'rpc') {
      return options.createError('unavailable', unavailable, {
        method: error.method,
        ...(Number.isFinite(error.rpcCode) ? { upstreamCode: error.rpcCode } : {}),
      });
    }
    if (error.kind === 'not-found') {
      const failure = options.notFound(error);
      if (failure) return failure;
    }
  }
  return options.createError('unavailable', unavailable);
}
