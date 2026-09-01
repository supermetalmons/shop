import type { ApiErrorCode } from './dataAccess.js';

export type JsonResponseOptions = Readonly<{
  contentType?: 'application/json' | 'application/json; charset=utf-8';
  headers?: HeadersInit;
}>;

export type ApiErrorLike = Readonly<{
  code: ApiErrorCode;
  message: string;
  details?: unknown;
}>;

export function jsonResponse(
  body: unknown,
  status: number,
  options: JsonResponseOptions = {},
): Response {
  const headers = new Headers({
    'Cache-Control': 'no-store',
    'Content-Type': options.contentType || 'application/json; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
  });
  if (options.headers) {
    const suppliedHeaders = new Headers(options.headers);
    suppliedHeaders.forEach((value, key) => {
      if (key !== 'set-cookie') headers.set(key, value);
    });
    for (const cookie of suppliedHeaders.getSetCookie()) {
      headers.append('Set-Cookie', cookie);
    }
  }
  return new Response(JSON.stringify(body), { status, headers });
}

export function httpStatusForApiErrorCode(
  code: ApiErrorCode,
  unavailableStatus: 502 | 503,
): number {
  if (code === 'invalid-argument') return 400;
  if (code === 'unauthenticated') return 401;
  if (code === 'permission-denied') return 403;
  if (code === 'not-found') return 404;
  if (code === 'aborted' || code === 'failed-precondition') return 409;
  if (code === 'resource-exhausted') return 429;
  if (code === 'deadline-exceeded') return 504;
  if (code === 'unavailable') return unavailableStatus;
  return 500;
}

export function apiErrorBody(error: ApiErrorLike): Readonly<{
  ok: false;
  error: Readonly<{
    code: ApiErrorCode;
    message: string;
    details?: unknown;
  }>;
}> {
  return {
    ok: false,
    error: {
      code: error.code,
      message: error.message,
      ...(error.details === undefined ? {} : { details: error.details }),
    },
  };
}
