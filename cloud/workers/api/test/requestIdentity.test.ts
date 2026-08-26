import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  RequestIdentityError,
  internalStaffAuthorization,
  verifyRequestIdentity,
} from '../src/requestIdentity.ts';
import { anonymousAuthTestHooks, handleAnonymousAuthRequest } from '../src/anonymousAuth.ts';

const NOW_MS = Date.parse('2026-08-25T12:00:00.000Z');
const SESSION_ID = '123e4567-e89b-42d3-a456-426614174000';
const SUBJECT = 'anon:223e4567-e89b-42d3-a456-426614174000';
const SECRET = 'A'.repeat(43);
const STAFF_WALLET = 'A87Upx1f1whNV5P8xQCK2YUTwE3uMYigjoKJAF3jiNpz';

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
    request,
    database,
    request.signal,
    NOW_MS,
  ), { kind: 'anonymous', authSubject: SUBJECT });
});

test('request identity rejects cookie CSRF failures and arbitrary bearer tokens without a database lookup', async () => {
  let queries = 0;
  const database = db(() => {
    queries += 1;
    return null;
  });
  const missingCsrf = new Request('https://mons.shop/profile/state', {
    headers: { Origin: 'https://mons.shop' },
  });
  await assert.rejects(
    verifyRequestIdentity(missingCsrf, database, missingCsrf.signal, NOW_MS),
    (error) => error instanceof RequestIdentityError && error.kind === 'invalid-token',
  );
  assert.equal(queries, 0);
  const bearer = new Request(missingCsrf, { headers: { Authorization: 'Bearer legacy-token' } });
  await assert.rejects(
    verifyRequestIdentity(bearer, database, bearer.signal, NOW_MS),
    (error) => error instanceof RequestIdentityError && error.kind === 'invalid-token',
  );
  assert.equal(queries, 0);
});

test('request identity accepts only allowlisted internal staff identities', async () => {
  const valid = new Request('https://api.mons.shop/admin/profile', {
    headers: { Authorization: internalStaffAuthorization(STAFF_WALLET) },
  });
  assert.deepEqual(
    await verifyRequestIdentity(valid, undefined, valid.signal, NOW_MS),
    { kind: 'staff-wallet', wallet: STAFF_WALLET },
  );
  const invalid = new Request(valid, {
    headers: { Authorization: internalStaffAuthorization('11111111111111111111111111111111') },
  });
  await assert.rejects(verifyRequestIdentity(invalid, undefined, invalid.signal, NOW_MS), /Invalid internal staff identity/);
});

test('request identity maps unavailable and timed-out anonymous session storage', async () => {
  const request = new Request('https://mons.shop/profile/state', {
    headers: {
      Cookie: `__Host-mons_anon_v1=mons_anon_v1.${SESSION_ID}.${SECRET}`,
      Origin: 'https://mons.shop',
      'X-Mons-CSRF': '1',
    },
  });
  await assert.rejects(
    verifyRequestIdentity(request, db(() => { throw new Error('D1 unavailable'); }), request.signal, NOW_MS),
    (error) => error instanceof RequestIdentityError && error.kind === 'provider-unavailable',
  );
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    verifyRequestIdentity(request, db(() => null), controller.signal, NOW_MS),
    (error) => error instanceof RequestIdentityError && error.kind === 'provider-timeout',
  );
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
