import test from 'node:test';
import assert from 'node:assert/strict';
import {
  apiErrorBody,
  httpStatusForApiErrorCode,
  jsonResponse,
} from '../src/httpResponse.ts';
import type { ApiErrorCode } from '../src/dataAccess.ts';

test('shared JSON responses preserve defaults and caller-owned headers', async () => {
  const standard = jsonResponse({ ok: true }, 201);
  assert.equal(standard.status, 201);
  assert.equal(standard.headers.get('cache-control'), 'no-store');
  assert.equal(standard.headers.get('content-type'), 'application/json; charset=utf-8');
  assert.equal(standard.headers.get('x-content-type-options'), 'nosniff');
  assert.deepEqual(await standard.json(), { ok: true });

  const customized = jsonResponse({ ok: true }, 202, {
    contentType: 'application/json',
    headers: {
      'Retry-After': '2',
      'Timing-Allow-Origin': '*',
      'X-Content-Type-Options': 'custom',
    },
  });
  assert.equal(customized.headers.get('content-type'), 'application/json');
  assert.equal(customized.headers.get('retry-after'), '2');
  assert.equal(customized.headers.get('timing-allow-origin'), '*');
  assert.equal(customized.headers.get('x-content-type-options'), 'custom');
});

test('shared JSON responses preserve repeated Set-Cookie headers', () => {
  const cookieHeaders: Array<HeadersInit> = [
    [
      ['Set-Cookie', 'session=one; Path=/; HttpOnly'],
      ['Set-Cookie', 'csrf=two; Path=/; SameSite=Lax'],
    ],
    new Headers([
      ['Set-Cookie', 'session=one; Path=/; HttpOnly'],
      ['Set-Cookie', 'csrf=two; Path=/; SameSite=Lax'],
    ]),
  ];

  for (const headers of cookieHeaders) {
    const response = jsonResponse({ ok: true }, 200, { headers });
    assert.deepEqual(response.headers.getSetCookie(), [
      'session=one; Path=/; HttpOnly',
      'csrf=two; Path=/; SameSite=Lax',
    ]);
  }
});

test('shared API error mapping preserves both unavailable policies', () => {
  const expected: Record<ApiErrorCode, number> = {
    'invalid-argument': 400,
    unauthenticated: 401,
    'permission-denied': 403,
    'not-found': 404,
    aborted: 409,
    'failed-precondition': 409,
    'resource-exhausted': 429,
    'deadline-exceeded': 504,
    unavailable: 502,
    internal: 500,
  };
  for (const [code, status] of Object.entries(expected) as Array<[ApiErrorCode, number]>) {
    assert.equal(httpStatusForApiErrorCode(code, 502), status);
  }
  assert.equal(httpStatusForApiErrorCode('unavailable', 503), 503);
});

test('shared API error bodies omit undefined details', () => {
  assert.deepEqual(apiErrorBody({ code: 'not-found', message: 'Missing' }), {
    ok: false,
    error: { code: 'not-found', message: 'Missing' },
  });
  assert.deepEqual(apiErrorBody({ code: 'aborted', message: 'Retry', details: { retry: true } }), {
    ok: false,
    error: { code: 'aborted', message: 'Retry', details: { retry: true } },
  });
});
