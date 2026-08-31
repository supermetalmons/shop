import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import {
  clearStaffWalletSession,
  createStaffWalletChallenge,
  ensureStaffWalletSession,
  exchangeStaffWalletChallenge,
  installStaffWalletSessionIfUnchanged,
  logoutStaffWalletSession,
  readStaffWalletSession,
  saveStaffWalletSession,
  staffWalletSessionTestHooks,
  subscribeStaffWalletSession,
} from '../src/lib/staffWalletSession.ts';

const dom = new JSDOM('', { url: 'https://mons.shop' });
Object.defineProperty(globalThis, 'window', { configurable: true, value: dom.window });
Object.defineProperty(globalThis, 'StorageEvent', { configurable: true, value: dom.window.StorageEvent });

const WALLET = 'A87Upx1f1whNV5P8xQCK2YUTwE3uMYigjoKJAF3jiNpz';
const OTHER_WALLET = 'kPG2L5zuxqNkvWvJNptbkqnPhk4nGjnGp7jwDFZPQgx';
const SESSION_ID = '123e4567-e89b-42d3-a456-426614174000';
const TOKEN = `mons_staff_v1.${SESSION_ID}.${'A'.repeat(43)}`;
const OTHER_TOKEN = `mons_staff_v1.223e4567-e89b-42d3-a456-426614174000.${'B'.repeat(43)}`;
const NOW_MS = Date.parse('2026-08-25T12:00:00.000Z');

test.beforeEach(() => {
  dom.window.localStorage.clear();
  globalThis.fetch = async () => { throw new Error('Unexpected fetch'); };
});

test('staff wallet session persists, restores, synchronizes, and clears invalid state', async () => {
  const seen: Array<string | null> = [];
  const unsubscribe = subscribeStaffWalletSession((wallet) => seen.push(wallet));
  const session = await saveStaffWalletSession({
    wallet: WALLET,
    token: TOKEN,
    refreshedAt: NOW_MS,
    expiresAt: NOW_MS + 100_000,
  });
  assert.deepEqual(readStaffWalletSession(NOW_MS + 1), session);
  assert.deepEqual(seen, [WALLET]);

  dom.window.localStorage.setItem(staffWalletSessionTestHooks.storageKey, '{');
  assert.equal(readStaffWalletSession(NOW_MS + 1), null);
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  assert.equal(dom.window.localStorage.getItem(staffWalletSessionTestHooks.storageKey), null);

  dom.window.localStorage.setItem(staffWalletSessionTestHooks.storageKey, JSON.stringify({
    wallet: WALLET,
    token: TOKEN,
    refreshedAt: NOW_MS,
    expiresAt: NOW_MS,
  }));
  assert.equal(readStaffWalletSession(NOW_MS), null);
  unsubscribe();
});

test('concurrent staff session installs serialize without overwriting each other', async () => {
  const originalNow = Date.now;
  Date.now = () => NOW_MS;
  const first = {
    wallet: WALLET,
    token: TOKEN,
    refreshedAt: NOW_MS,
    expiresAt: NOW_MS + 100_000,
  };
  const second = {
    wallet: OTHER_WALLET,
    token: OTHER_TOKEN,
    refreshedAt: NOW_MS,
    expiresAt: NOW_MS + 200_000,
  };
  try {
    const [firstResult, secondResult] = await Promise.all([
      installStaffWalletSessionIfUnchanged(first, null),
      installStaffWalletSessionIfUnchanged(second, null),
    ]);
    assert.deepEqual(firstResult, secondResult);
    assert.deepEqual(readStaffWalletSession(NOW_MS), firstResult);
  } finally {
    Date.now = originalNow;
  }
});

test('staff challenge exchange stays pure until the session is installed and refreshed', async () => {
  const originalNow = Date.now;
  Date.now = () => NOW_MS;
  const calls: Array<{ path: string; authorization: string; body: unknown }> = [];
  globalThis.fetch = async (input, init) => {
    const path = new URL(String(input), 'https://mons.shop').pathname;
    calls.push({
      path,
      authorization: new Headers(init?.headers).get('Authorization') || '',
      body: JSON.parse(String(init?.body || '{}')),
    });
    if (path === '/api/staff/auth/challenge') {
      return Response.json({
        challengeId: SESSION_ID,
        message: `Sign in to mons.shop as ${WALLET}\nDomain: mons.shop\nTimestamp: 2026-08-25T12:00:00.000Z\nSession: staff:${SESSION_ID}`,
        expiresAt: NOW_MS + 300_000,
      });
    }
    if (path === '/api/staff/auth/session') {
      return Response.json({ wallet: WALLET, token: TOKEN, expiresAt: NOW_MS + 30 * 24 * 60 * 60 * 1000 });
    }
    if (path === '/api/staff/auth/refresh') {
      return Response.json({ wallet: WALLET, expiresAt: NOW_MS + 31 * 24 * 60 * 60 * 1000 });
    }
    throw new Error(`Unexpected path: ${path}`);
  };
  try {
    const challenge = await createStaffWalletChallenge(WALLET);
    assert.equal(challenge.challengeId, SESSION_ID);
    const exchanged = await exchangeStaffWalletChallenge(challenge.challengeId, new Uint8Array(64).fill(7));
    assert.deepEqual(exchanged, {
      wallet: WALLET,
      token: TOKEN,
      expiresAt: NOW_MS + 30 * 24 * 60 * 60 * 1000,
      refreshedAt: NOW_MS,
    });
    assert.equal(readStaffWalletSession(NOW_MS), null);
    assert.deepEqual(await installStaffWalletSessionIfUnchanged(exchanged, null), exchanged);
    const restored = readStaffWalletSession(NOW_MS);
    assert.equal(restored?.wallet, WALLET);

    const refreshed = await ensureStaffWalletSession(true);
    assert.equal(refreshed?.expiresAt, NOW_MS + 31 * 24 * 60 * 60 * 1000);
    assert.deepEqual(calls.map(({ path }) => path), [
      '/api/staff/auth/challenge',
      '/api/staff/auth/session',
      '/api/staff/auth/refresh',
    ]);
    assert.equal(calls[2].authorization, `Bearer ${TOKEN}`);
  } finally {
    Date.now = originalNow;
  }
});

test('staff session installation never overwrites a replacement token', async () => {
  const originalNow = Date.now;
  Date.now = () => NOW_MS;
  try {
    const replacement = await saveStaffWalletSession({
      wallet: OTHER_WALLET,
      token: OTHER_TOKEN,
      refreshedAt: NOW_MS,
      expiresAt: NOW_MS + 200_000,
    });
    const stale = {
      wallet: WALLET,
      token: TOKEN,
      refreshedAt: NOW_MS,
      expiresAt: NOW_MS + 100_000,
    };
    assert.deepEqual(await installStaffWalletSessionIfUnchanged(stale, null), replacement);
    assert.deepEqual(readStaffWalletSession(NOW_MS), replacement);
  } finally {
    Date.now = originalNow;
  }
});

test('staff logout clears only after remote revocation succeeds', async () => {
  const originalNow = Date.now;
  Date.now = () => NOW_MS;
  await saveStaffWalletSession({
    wallet: WALLET,
    token: TOKEN,
    refreshedAt: NOW_MS,
    expiresAt: NOW_MS + 100_000,
  });
  let presentDuringFetch = false;
  globalThis.fetch = async () => {
    presentDuringFetch = readStaffWalletSession(NOW_MS)?.token === TOKEN;
    return Response.json({ ok: true });
  };
  try {
    await logoutStaffWalletSession();
    assert.equal(presentDuringFetch, true);
    assert.equal(readStaffWalletSession(NOW_MS), null);
    await clearStaffWalletSession();
  } finally {
    Date.now = originalNow;
  }
});

test('staff logout retains transient failures and never clears a replacement session', async () => {
  const originalNow = Date.now;
  Date.now = () => NOW_MS;
  try {
    await saveStaffWalletSession({ wallet: WALLET, token: TOKEN, refreshedAt: NOW_MS, expiresAt: NOW_MS + 100_000 });
    globalThis.fetch = async () => { throw new TypeError('offline'); };
    await assert.rejects(logoutStaffWalletSession(), /offline/);
    assert.equal(readStaffWalletSession(NOW_MS)?.token, TOKEN);

    let release!: (response: Response) => void;
    globalThis.fetch = () => new Promise<Response>((resolve) => { release = resolve; });
    const logout = logoutStaffWalletSession();
    await saveStaffWalletSession({
      wallet: OTHER_WALLET,
      token: OTHER_TOKEN,
      refreshedAt: NOW_MS,
      expiresAt: NOW_MS + 200_000,
    });
    release(Response.json({ ok: true }));
    await logout;
    assert.equal(readStaffWalletSession(NOW_MS)?.token, OTHER_TOKEN);
  } finally {
    Date.now = originalNow;
  }
});

test('staff logout can revoke a captured session without touching a later replacement', async () => {
  const originalNow = Date.now;
  Date.now = () => NOW_MS;
  try {
    await saveStaffWalletSession({ wallet: WALLET, token: TOKEN, refreshedAt: NOW_MS, expiresAt: NOW_MS + 100_000 });
    const captured = readStaffWalletSession(NOW_MS);
    assert.ok(captured);
    await saveStaffWalletSession({
      wallet: OTHER_WALLET,
      token: OTHER_TOKEN,
      refreshedAt: NOW_MS,
      expiresAt: NOW_MS + 200_000,
    });
    let authorization = '';
    globalThis.fetch = async (_input, init) => {
      authorization = new Headers(init?.headers).get('Authorization') || '';
      return Response.json({ ok: true });
    };
    await logoutStaffWalletSession(captured);
    assert.equal(authorization, `Bearer ${TOKEN}`);
    assert.equal(readStaffWalletSession(NOW_MS)?.token, OTHER_TOKEN);
  } finally {
    Date.now = originalNow;
  }
});

test('staff logout treats an already-invalid remote session as revoked', async () => {
  const originalNow = Date.now;
  Date.now = () => NOW_MS;
  await saveStaffWalletSession({ wallet: WALLET, token: TOKEN, refreshedAt: NOW_MS, expiresAt: NOW_MS + 100_000 });
  globalThis.fetch = async () => Response.json({
    ok: false,
    error: { code: 'unauthenticated', message: 'Authentication is required.' },
  }, { status: 401 });
  try {
    await logoutStaffWalletSession();
    assert.equal(readStaffWalletSession(NOW_MS), null);
  } finally {
    Date.now = originalNow;
  }
});

test('staff refresh cannot overwrite or clear a replacement session', async () => {
  const originalNow = Date.now;
  Date.now = () => NOW_MS;
  try {
    await saveStaffWalletSession({ wallet: WALLET, token: TOKEN, refreshedAt: NOW_MS - 86_400_001, expiresAt: NOW_MS + 100_000 });
    let release!: (response: Response) => void;
    globalThis.fetch = () => new Promise<Response>((resolve) => { release = resolve; });
    const refresh = ensureStaffWalletSession(true);
    await saveStaffWalletSession({
      wallet: OTHER_WALLET,
      token: OTHER_TOKEN,
      refreshedAt: NOW_MS,
      expiresAt: NOW_MS + 200_000,
    });
    release(Response.json({ wallet: WALLET, expiresAt: NOW_MS + 300_000 }));
    assert.equal((await refresh)?.token, OTHER_TOKEN);
    assert.equal(readStaffWalletSession(NOW_MS)?.token, OTHER_TOKEN);

    await saveStaffWalletSession({ wallet: WALLET, token: TOKEN, refreshedAt: NOW_MS - 86_400_001, expiresAt: NOW_MS + 100_000 });
    let releaseFailure!: (response: Response) => void;
    globalThis.fetch = () => new Promise<Response>((resolve) => { releaseFailure = resolve; });
    const failedRefresh = ensureStaffWalletSession(true);
    await saveStaffWalletSession({
      wallet: OTHER_WALLET,
      token: OTHER_TOKEN,
      refreshedAt: NOW_MS,
      expiresAt: NOW_MS + 200_000,
    });
    releaseFailure(new Response('<html>expired</html>', { status: 401 }));
    await assert.rejects(
      failedRefresh,
      (error) => error instanceof Error &&
        (error as Error & { code?: unknown }).code === 'unauthenticated',
    );
    assert.equal(readStaffWalletSession(NOW_MS)?.token, OTHER_TOKEN);
  } finally {
    Date.now = originalNow;
  }
});

test('staff refresh classifies failures by HTTP status before payload', async (t) => {
  const originalNow = Date.now;
  Date.now = () => NOW_MS;
  const cases: Array<{
    name: string;
    request: () => Promise<Response>;
    code?: string;
    retained: boolean;
  }> = [
    {
      name: 'network failure is transient',
      request: async () => { throw new TypeError('offline'); },
      code: 'unavailable',
      retained: true,
    },
    {
      name: 'timeout is transient',
      request: async () => { throw new DOMException('Timed out', 'TimeoutError'); },
      code: 'unavailable',
      retained: true,
    },
    {
      name: 'malformed success is transient',
      request: async () => new Response('{"wallet":', { status: 200 }),
      code: 'unavailable',
      retained: true,
    },
    {
      name: 'null success is transient',
      request: async () => Response.json(null),
      code: 'unavailable',
      retained: true,
    },
    {
      name: 'array success is transient',
      request: async () => Response.json([]),
      code: 'unavailable',
      retained: true,
    },
    {
      name: 'non-object success is transient',
      request: async () => Response.json('invalid'),
      code: 'unavailable',
      retained: true,
    },
    {
      name: 'empty success is transient',
      request: async () => Response.json({}),
      code: 'unavailable',
      retained: true,
    },
    {
      name: 'invalid-wallet success is transient',
      request: async () => Response.json({ wallet: 'invalid', expiresAt: NOW_MS + 300_000 }),
      code: 'unavailable',
      retained: true,
    },
    {
      name: 'missing-expiry success is transient',
      request: async () => Response.json({ wallet: WALLET }),
      code: 'unavailable',
      retained: true,
    },
    {
      name: 'string-expiry success is transient',
      request: async () => Response.json({ wallet: WALLET, expiresAt: String(NOW_MS + 300_000) }),
      code: 'unavailable',
      retained: true,
    },
    {
      name: 'unsafe-expiry success is transient',
      request: async () => Response.json({ wallet: WALLET, expiresAt: Number.MAX_SAFE_INTEGER + 1 }),
      code: 'unavailable',
      retained: true,
    },
    {
      name: 'invalid wallet takes precedence over an expired value',
      request: async () => Response.json({ wallet: 'invalid', expiresAt: NOW_MS }),
      code: 'unavailable',
      retained: true,
    },
    {
      name: 'malformed expiry takes precedence over a wrong wallet',
      request: async () => Response.json({ wallet: OTHER_WALLET, expiresAt: String(NOW_MS + 300_000) }),
      code: 'unavailable',
      retained: true,
    },
    {
      name: 'malformed 401 invalidates the credential',
      request: async () => new Response('<html>unauthorized</html>', { status: 401 }),
      code: 'unauthenticated',
      retained: false,
    },
    {
      name: 'malformed 403 invalidates the credential',
      request: async () => new Response('<html>forbidden</html>', { status: 403 }),
      code: 'permission-denied',
      retained: false,
    },
    {
      name: 'malformed 400 is a protocol failure',
      request: async () => new Response('<html>bad request</html>', { status: 400 }),
      code: 'http-400',
      retained: true,
    },
    {
      name: '400 payload cannot invalidate the credential',
      request: async () => Response.json({
        error: { code: 'unauthenticated', message: 'Misclassified response.' },
      }, { status: 400 }),
      code: 'http-400',
      retained: true,
    },
    {
      name: '500 payload cannot invalidate the credential',
      request: async () => Response.json({
        error: { code: 'unauthenticated', message: 'Upstream failed.' },
      }, { status: 500 }),
      code: 'unavailable',
      retained: true,
    },
    {
      name: 'malformed gateway response is transient',
      request: async () => new Response('<html>bad gateway</html>', { status: 502 }),
      code: 'unavailable',
      retained: true,
    },
    {
      name: 'structured timeout response is transient',
      request: async () => Response.json({
        error: { code: 'deadline-exceeded', message: 'Staff authentication timed out.' },
      }, { status: 504 }),
      code: 'unavailable',
      retained: true,
    },
    {
      name: 'wrong-wallet success is a protocol failure',
      request: async () => Response.json({ wallet: OTHER_WALLET, expiresAt: NOW_MS + 300_000 }),
      retained: true,
    },
    {
      name: 'expired success is a protocol failure',
      request: async () => Response.json({ wallet: WALLET, expiresAt: NOW_MS }),
      retained: true,
    },
    {
      name: 'valid wrong-wallet expired success is a protocol failure',
      request: async () => Response.json({ wallet: OTHER_WALLET, expiresAt: NOW_MS }),
      retained: true,
    },
  ];
  try {
    for (const entry of cases) {
      await t.test(entry.name, async () => {
        await saveStaffWalletSession({
          wallet: WALLET,
          token: TOKEN,
          refreshedAt: NOW_MS - 86_400_001,
          expiresAt: NOW_MS + 100_000,
        });
        globalThis.fetch = entry.request;
        await assert.rejects(
          ensureStaffWalletSession(true),
          (error) => error instanceof Error &&
            (error as Error & { code?: unknown }).code === entry.code,
        );
        assert.equal(readStaffWalletSession(NOW_MS)?.token, entry.retained ? TOKEN : undefined);
      });
    }
  } finally {
    Date.now = originalNow;
  }
});
