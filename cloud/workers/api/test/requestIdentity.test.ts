import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  RequestIdentityError,
  verifyRequestIdentity,
} from '../src/requestIdentity.ts';
import { anonymousAuthTestHooks, handleAnonymousAuthRequest } from '../src/anonymousAuth.ts';

const NOW_MS = Date.parse('2026-08-25T12:00:00.000Z');
const SESSION_ID = '123e4567-e89b-42d3-a456-426614174000';
const SUBJECT = 'anon:223e4567-e89b-42d3-a456-426614174000';
const SECRET = 'A'.repeat(43);

test('anonymous production cookies are host-only, secure, and strict', () => {
  const cookie = anonymousAuthTestHooks.sessionCookie(new URL('https://mons.shop'), 'token', 60);
  assert.equal(cookie, '__Host-mons_anon_v1=token; Path=/; HttpOnly; SameSite=Strict; Secure; Max-Age=60');
  assert.equal(anonymousAuthTestHooks.tokenPattern.test(`mons_anon_v1.${SESSION_ID}.${SECRET}`), true);
});

function db(first: (query: string) => Record<string, unknown> | null): D1Database {
  return {
    prepare(query: string) {
      return {
        bind() { return this; },
        first: async () => first(query),
      };
    },
  } as D1Database;
}

test('request identity verifies a same-origin cookie without exposing its secret', async () => {
  const database = db((query) => query.includes('anonymous_auth_sessions') ? {
    session_id: SESSION_ID,
    secret_hash: createHash('sha256').update(SECRET).digest('hex'),
    auth_subject: SUBJECT,
    origin_hostname: 'mons.shop',
    created_at_ms: NOW_MS,
    refreshed_at_ms: NOW_MS,
    expires_at_ms: NOW_MS + 30 * 24 * 60 * 60 * 1000,
  } : null);
  const request = new Request('https://mons.shop/profile/state', {
    headers: {
      Cookie: `__Host-mons_anon_v1=mons_anon_v1.${SESSION_ID}.${SECRET}`,
      Origin: 'https://mons.shop',
      'X-Mons-CSRF': '1',
    },
  });
  assert.deepEqual(await verifyRequestIdentity(
    null,
    async () => { throw new Error('unexpected fetch'); },
    request.signal,
    NOW_MS,
    request,
    database,
  ), { kind: 'anonymous', authSubject: SUBJECT, source: 'mons' });
});

test('request identity rejects cookie CSRF failures and disabled legacy bearer tokens', async () => {
  const database = db((query) => query.includes('anonymous_auth_control')
    ? { firebase_fallback_enabled: 0 }
    : null);
  const missingCsrf = new Request('https://mons.shop/profile/state', {
    headers: { Origin: 'https://mons.shop' },
  });
  await assert.rejects(
    verifyRequestIdentity(null, fetch, missingCsrf.signal, NOW_MS, missingCsrf, database),
    (error) => error instanceof RequestIdentityError && error.kind === 'invalid-token',
  );
  let fetched = false;
  await assert.rejects(
    verifyRequestIdentity(
      'Bearer legacy-token',
      async () => {
        fetched = true;
        throw new Error('unexpected fetch');
      },
      new AbortController().signal,
      NOW_MS,
      missingCsrf,
      database,
    ),
    (error) => error instanceof RequestIdentityError && error.kind === 'invalid-token',
  );
  assert.equal(fetched, false);
});

test('anonymous logout expires its cookie when D1 revocation fails', async () => {
  const database = db(() => {
    throw new Error('D1 unavailable');
  });
  const request = new Request('https://mons.shop/auth/anonymous/logout', {
    method: 'POST',
    headers: {
      Cookie: `__Host-mons_anon_v1=mons_anon_v1.${SESSION_ID}.${SECRET}`,
      Origin: 'https://mons.shop',
      'Content-Type': 'application/json',
      'X-Mons-CSRF': '1',
    },
    body: '{}',
  });
  const response = await handleAnonymousAuthRequest(request, {
    OPS_DB: database,
    ANONYMOUS_AUTH_SESSION_RATE_LIMITER: { limit: async () => ({ success: true }) } as RateLimit,
  }, '/auth/anonymous/logout', NOW_MS);
  assert.equal(response.status, 503);
  assert.match(response.headers.get('set-cookie') || '', /Max-Age=0/);
});

test('anonymous refresh reloads the winner of a concurrent compare-and-set', async () => {
  const refreshAt = NOW_MS + 24 * 60 * 60 * 1000;
  const winnerRefreshAt = refreshAt + 1000;
  const ttlMs = 30 * 24 * 60 * 60 * 1000;
  const oldRow = {
    session_id: SESSION_ID,
    secret_hash: createHash('sha256').update(SECRET).digest('hex'),
    auth_subject: SUBJECT,
    origin_hostname: 'mons.shop',
    created_at_ms: NOW_MS,
    refreshed_at_ms: NOW_MS,
    expires_at_ms: NOW_MS + ttlMs,
  };
  const winnerRow = {
    ...oldRow,
    refreshed_at_ms: winnerRefreshAt,
    expires_at_ms: winnerRefreshAt + ttlMs,
  };
  let selectCalls = 0;
  let updateQuery = '';
  let updateBindings: unknown[] = [];
  const database = {
    prepare(query: string) {
      let bindings: unknown[] = [];
      return {
        bind(...values: unknown[]) {
          bindings = values;
          return this;
        },
        async first() {
          selectCalls += 1;
          return selectCalls === 1 ? oldRow : winnerRow;
        },
        async run() {
          updateQuery = query;
          updateBindings = bindings;
          return { meta: { changes: 0 } };
        },
      };
    },
  } as unknown as D1Database;
  const request = new Request('https://mons.shop/auth/anonymous/session', {
    method: 'POST',
    headers: {
      Cookie: `__Host-mons_anon_v1=mons_anon_v1.${SESSION_ID}.${SECRET}`,
      Origin: 'https://mons.shop',
      'Content-Type': 'application/json',
      'X-Mons-CSRF': '1',
    },
    body: '{}',
  });
  const response = await handleAnonymousAuthRequest(request, {
    OPS_DB: database,
    ANONYMOUS_AUTH_SESSION_RATE_LIMITER: {
      limit: async () => assert.fail('valid sessions must not consume the creation limit'),
    } as unknown as RateLimit,
  }, '/auth/anonymous/session', refreshAt);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    subject: SUBJECT,
    refreshedAt: winnerRefreshAt,
    expiresAt: winnerRefreshAt + ttlMs,
  });
  assert.match(updateQuery, /refreshed_at_ms = \? AND\s+expires_at_ms = \?/);
  assert.deepEqual(updateBindings.slice(4, 6), [oldRow.refreshed_at_ms, oldRow.expires_at_ms]);
  assert.equal(selectCalls, 2);
});
