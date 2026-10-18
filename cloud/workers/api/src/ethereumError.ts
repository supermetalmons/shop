import { z } from 'zod';
import type { ApiErrorCode } from './dataAccess.js';
import { readBoundedRequestJson } from './boundedRequest.js';
import { apiErrorBody, httpStatusForApiErrorCode, jsonResponse } from './httpResponse.js';

export class EthereumApiError extends Error {
  constructor(readonly code: ApiErrorCode, message: string, readonly details?: unknown) {
    super(message);
    this.name = 'EthereumApiError';
  }
}

export async function readEthereumBody<T>(request: Request, signal: AbortSignal, schema: z.ZodType<T>): Promise<T> {
  const body = await readBoundedRequestJson(request, {
    maxBytes: 16 * 1024,
    signal,
    createError: () => new EthereumApiError('invalid-argument', 'Invalid Ethereum request.'),
  });
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new EthereumApiError('invalid-argument', 'Invalid Ethereum request.');
  return parsed.data;
}

export function ethereumErrorResponse(error: unknown): Response {
  const failure = error instanceof EthereumApiError
    ? error
    : new EthereumApiError('unavailable', 'Ethereum service is temporarily unavailable.');
  return jsonResponse(apiErrorBody(failure), httpStatusForApiErrorCode(failure.code, 503), {
    ...(failure.code === 'resource-exhausted' ? { headers: { 'Retry-After': '60' } } : {}),
  });
}
