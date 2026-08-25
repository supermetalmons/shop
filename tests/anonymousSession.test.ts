import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import {
  anonymousSessionTestHooks,
  currentAnonymousSession,
  ensureAnonymousSession,
  logoutAnonymousSession,
  subscribeAnonymousSession,
} from '../src/lib/anonymousSession.ts';

const dom = new JSDOM('', { url: 'https://mons.shop' });
Object.defineProperty(globalThis, 'window', { configurable: true, value: dom.window });
Object.defineProperty(globalThis, 'StorageEvent', { configurable: true, value: dom.window.StorageEvent });

const NOW_MS = Date.parse('2026-08-25T12:00:00.000Z');
const SUBJECT = 'anon:123e4567-e89b-42d3-a456-426614174000';

test.beforeEach(() => {
  dom.window.localStorage.clear();
  anonymousSessionTestHooks.resetValidation();
  globalThis.fetch = async () => { throw new Error('Unexpected fetch'); };
});

test('anonymous session creates, persists non-secret metadata, and reuses the cached identity', async () => {
  const originalNow = Date.now;
  Date.now = () => NOW_MS;
  const calls: Array<{ input: string; headers: Headers; credentials: RequestCredentials | undefined }> = [];
  globalThis.fetch = async (input, init) => {
    calls.push({ input: String(input), headers: new Headers(init?.headers), credentials: init?.credentials });
    return Response.json({
      subject: SUBJECT,
      refreshedAt: NOW_MS,
      expiresAt: NOW_MS + 30 * 24 * 60 * 60 * 1000,
    });
  };
  try {
    const [session, concurrent] = await Promise.all([
      ensureAnonymousSession(),
      ensureAnonymousSession(),
    ]);
    assert.equal(session.subject, SUBJECT);
    assert.deepEqual(concurrent, session);
    assert.deepEqual(currentAnonymousSession(NOW_MS), session);
    assert.equal((await ensureAnonymousSession()).subject, SUBJECT);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].input, '/api/auth/anonymous/session');
    assert.equal(calls[0].headers.get('x-mons-csrf'), '1');
    assert.equal(calls[0].headers.get('authorization'), null);
    assert.equal(calls[0].credentials, 'same-origin');
    const stored = dom.window.localStorage.getItem(anonymousSessionTestHooks.storageKey) || '';
    assert.equal(stored.includes('mons_anon_v1'), false);
  } finally {
    Date.now = originalNow;
  }
});

test('anonymous session refreshes on demand and publishes subject changes', async () => {
  const originalNow = Date.now;
  Date.now = () => NOW_MS;
  const seen: Array<string | null> = [];
  const unsubscribe = subscribeAnonymousSession((subject) => seen.push(subject));
  let subject = SUBJECT;
  globalThis.fetch = async () => Response.json({
    subject,
    refreshedAt: NOW_MS,
    expiresAt: NOW_MS + 30 * 24 * 60 * 60 * 1000,
  });
  try {
    await ensureAnonymousSession(true);
    subject = 'anon:223e4567-e89b-42d3-a456-426614174000';
    await ensureAnonymousSession(true);
    assert.deepEqual(seen, [SUBJECT, subject]);
  } finally {
    unsubscribe();
    Date.now = originalNow;
  }
});

test('anonymous session validates cached metadata against the HttpOnly cookie', async () => {
  const originalNow = Date.now;
  Date.now = () => NOW_MS;
  const replacement = 'anon:223e4567-e89b-42d3-a456-426614174000';
  dom.window.localStorage.setItem(anonymousSessionTestHooks.storageKey, JSON.stringify({
    subject: SUBJECT,
    refreshedAt: NOW_MS,
    expiresAt: NOW_MS + 30 * 24 * 60 * 60 * 1000,
  }));
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return Response.json({
      subject: replacement,
      refreshedAt: NOW_MS,
      expiresAt: NOW_MS + 30 * 24 * 60 * 60 * 1000,
    });
  };
  try {
    assert.equal((await ensureAnonymousSession()).subject, replacement);
    assert.equal(calls, 1);
    assert.equal(currentAnonymousSession(NOW_MS)?.subject, replacement);
  } finally {
    Date.now = originalNow;
  }
});

test('anonymous session remains usable when metadata storage is unavailable', async () => {
  const originalStorage = Object.getOwnPropertyDescriptor(dom.window, 'localStorage');
  Object.defineProperty(dom.window, 'localStorage', {
    configurable: true,
    value: {
      getItem: () => null,
      removeItem: () => undefined,
      setItem: () => { throw new DOMException('blocked', 'SecurityError'); },
    },
  });
  const nowMs = Date.now();
  globalThis.fetch = async () => Response.json({
    subject: SUBJECT,
    refreshedAt: nowMs,
    expiresAt: nowMs + 30 * 24 * 60 * 60 * 1000,
  });
  try {
    assert.equal((await ensureAnonymousSession(true)).subject, SUBJECT);
    assert.equal(currentAnonymousSession(nowMs)?.subject, SUBJECT);
  } finally {
    if (originalStorage) Object.defineProperty(dom.window, 'localStorage', originalStorage);
  }
});

test('anonymous logout retains local state when remote revocation fails', async () => {
  const originalNow = Date.now;
  Date.now = () => NOW_MS;
  globalThis.fetch = async () => Response.json({
    subject: SUBJECT,
    refreshedAt: NOW_MS,
    expiresAt: NOW_MS + 30 * 24 * 60 * 60 * 1000,
  });
  try {
    await ensureAnonymousSession(true);
    globalThis.fetch = async () => { throw new TypeError('offline'); };
    await assert.rejects(logoutAnonymousSession(), /offline/);
    assert.equal(currentAnonymousSession(NOW_MS)?.subject, SUBJECT);
  } finally {
    Date.now = originalNow;
  }
});

test('anonymous logout clears local state when the server responds with an error', async () => {
  const originalNow = Date.now;
  Date.now = () => NOW_MS;
  globalThis.fetch = async () => Response.json({
    subject: SUBJECT,
    refreshedAt: NOW_MS,
    expiresAt: NOW_MS + 30 * 24 * 60 * 60 * 1000,
  });
  try {
    await ensureAnonymousSession(true);
    globalThis.fetch = async () => Response.json({
      ok: false,
      error: { code: 'unavailable', message: 'Authentication is temporarily unavailable.' },
    }, { status: 503 });
    await assert.rejects(logoutAnonymousSession(), /temporarily unavailable/);
    assert.equal(currentAnonymousSession(NOW_MS), null);
  } finally {
    Date.now = originalNow;
  }
});
