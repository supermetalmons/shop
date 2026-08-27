import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite';
import test from 'node:test';
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import {
  STAFF_AUTH_CHALLENGE_PATH,
  STAFF_AUTH_LOGOUT_PATH,
  STAFF_AUTH_REFRESH_PATH,
  STAFF_AUTH_SESSION_PATH,
  StaffAuthError,
  cleanupExpiredStaffAuthState,
  handleStaffAuthRequest,
  verifyStaffSession,
} from '../src/staffWalletAuth.ts';

const NOW_MS = Date.parse('2026-08-25T12:00:00.000Z');
const keypair = nacl.sign.keyPair();
const WALLET = bs58.encode(keypair.publicKey);
const OTHER_WALLET = bs58.encode(nacl.sign.keyPair().publicKey);

function result(changes: number, rows: Record<string, unknown>[] = []): D1Result<Record<string, unknown>> {
  return {
    success: true,
    results: rows,
    meta: { changes },
  } as D1Result<Record<string, unknown>>;
}

function sqliteValue(value: unknown): SQLInputValue {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'bigint' ||
    value instanceof Uint8Array
  ) return value;
  throw new Error('Unsupported test D1 binding');
}

class TestD1Statement implements D1PreparedStatement {
  private bindings: SQLInputValue[] = [];

  constructor(private readonly statement: StatementSync) {}

  execute(): D1Result<Record<string, unknown>> {
    if (this.statement.columns().length > 0) {
      const rows = this.statement.all(...this.bindings).map((row) => ({ ...row }));
      return result(0, rows);
    }
    return result(Number(this.statement.run(...this.bindings).changes));
  }

  bind(...values: unknown[]): D1PreparedStatement {
    this.bindings = values.map(sqliteValue);
    return this;
  }

  first<T = unknown>(colName: string): Promise<T | null>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  async first<T = Record<string, unknown>>(colName?: string): Promise<T | null> {
    const row = this.statement.get(...this.bindings);
    if (!row) return null;
    return (colName === undefined ? { ...row } : row[colName]) as T;
  }

  async run<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    return this.execute() as D1Result<T>;
  }

  async all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    return this.execute() as D1Result<T>;
  }

  raw<T = unknown[]>(options: { columnNames: true }): Promise<[string[], ...T[]]>;
  raw<T = unknown[]>(options?: { columnNames?: false }): Promise<T[]>;
  async raw<T = unknown[]>(options?: { columnNames?: boolean }): Promise<T[] | [string[], ...T[]]> {
    const rows = this.execute().results;
    const columnNames = Object.keys(rows[0] || {});
    const values = rows.map((row) => columnNames.map((columnName) => row[columnName]) as T);
    return options?.columnNames ? [columnNames, ...values] : values;
  }
}

class TestD1Database implements D1Database {
  constructor(private readonly sqlite: DatabaseSync) {}

  prepare(query: string): D1PreparedStatement {
    return new TestD1Statement(this.sqlite.prepare(query));
  }

  async batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
    this.sqlite.exec('BEGIN IMMEDIATE');
    try {
      const results = statements.map((statement) => {
        if (!(statement instanceof TestD1Statement)) throw new Error('Unexpected test D1 statement');
        return statement.execute() as D1Result<T>;
      });
      this.sqlite.exec('COMMIT');
      return results;
    } catch (error) {
      this.sqlite.exec('ROLLBACK');
      throw error;
    }
  }

  exec(): Promise<D1ExecResult> {
    throw new Error('Unexpected D1 exec');
  }

  withSession(): D1DatabaseSession {
    throw new Error('Unexpected D1 session');
  }

  dump(): Promise<ArrayBuffer> {
    throw new Error('Unexpected D1 dump');
  }
}

class TestRateLimit implements RateLimit {
  readonly calls: string[] = [];
  readonly counts = new Map<string, number>();
  fail = false;

  constructor(private readonly maximum: number) {}

  async limit(options: RateLimitOptions): Promise<RateLimitOutcome> {
    if (this.fail) throw new Error('Rate limiter unavailable');
    this.calls.push(options.key);
    const count = (this.counts.get(options.key) || 0) + 1;
    this.counts.set(options.key, count);
    return { success: count <= this.maximum };
  }
}

function database(): {
  db: D1Database;
  sqlite: DatabaseSync;
  env: Pick<Env, 'OPS_DB' | 'STAFF_AUTH_CHALLENGE_RATE_LIMITER' | 'STAFF_AUTH_SESSION_RATE_LIMITER'>;
  challengeLimiter: TestRateLimit;
  sessionLimiter: TestRateLimit;
} {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON');
  sqlite.exec(readFileSync('cloud/workers/api/ops-migrations/0001_current_schema.sql', 'utf8'));
  const db = new TestD1Database(sqlite);
  const challengeLimiter = new TestRateLimit(10);
  const sessionLimiter = new TestRateLimit(30);
  return {
    db,
    sqlite,
    challengeLimiter,
    sessionLimiter,
    env: {
      OPS_DB: db,
      STAFF_AUTH_CHALLENGE_RATE_LIMITER: challengeLimiter,
      STAFF_AUTH_SESSION_RATE_LIMITER: sessionLimiter,
    },
  };
}

function request(
  path: string,
  body: unknown,
  authorization?: string,
  origin = 'https://mons.shop',
  caller = '198.51.100.10',
): Request {
  return new Request(`https://api.mons.shop${path}`, {
    method: 'POST',
    headers: {
      ...(authorization ? { Authorization: `Bearer ${authorization}` } : {}),
      'Content-Type': 'application/json',
      'CF-Connecting-IP': caller,
      Origin: origin,
    },
    body: JSON.stringify(body),
  });
}

const staffDependencies = { isStaffWallet: (wallet: string | null | undefined) => wallet === WALLET };

test('staff wallet challenge creates, verifies, refreshes, and revokes one opaque session', async () => {
  const { db, sqlite, env, challengeLimiter, sessionLimiter } = database();
  try {
    const challengeResponse = await handleStaffAuthRequest(
      request(STAFF_AUTH_CHALLENGE_PATH, { wallet: WALLET }),
      env,
      STAFF_AUTH_CHALLENGE_PATH,
      staffDependencies,
      NOW_MS,
    );
    assert.equal(challengeResponse.status, 200);
    const challenge = await challengeResponse.json() as {
      challengeId: string;
      message: string;
      expiresAt: number;
    };
    assert.match(challenge.message, new RegExp(`Session: staff:${challenge.challengeId}$`));
    assert.equal(challenge.expiresAt, NOW_MS + 5 * 60 * 1000);
    const reusedResponse = await handleStaffAuthRequest(
      request(STAFF_AUTH_CHALLENGE_PATH, { wallet: WALLET }),
      env,
      STAFF_AUTH_CHALLENGE_PATH,
      staffDependencies,
      NOW_MS + 1,
    );
    assert.equal(reusedResponse.status, 200);
    assert.equal((await reusedResponse.json() as { challengeId: string }).challengeId, challenge.challengeId);
    const challengeCount = sqlite.prepare('SELECT COUNT(*) AS count FROM staff_auth_challenges').get() as { count: number };
    assert.equal(challengeCount.count, 1);
    assert.equal(challengeLimiter.calls.length, 2);
    assert.equal(new Set(challengeLimiter.calls).size, 1);
    const signature = nacl.sign.detached(new TextEncoder().encode(challenge.message), keypair.secretKey);
    const sessionResponse = await handleStaffAuthRequest(
      request(STAFF_AUTH_SESSION_PATH, {
        challengeId: challenge.challengeId,
        signature: Array.from(signature),
      }),
      env,
      STAFF_AUTH_SESSION_PATH,
      staffDependencies,
      NOW_MS + 2,
    );
    assert.equal(sessionResponse.status, 200);
    const session = await sessionResponse.json() as { wallet: string; token: string; expiresAt: number };
    assert.equal(session.wallet, WALLET);
    assert.match(session.token, /^mons_staff_v1\.[^.]+\.[A-Za-z0-9_-]{43}$/);
    const stored = sqlite.prepare('SELECT secret_hash FROM staff_auth_sessions').get() as { secret_hash: string };
    assert.match(stored.secret_hash, /^[0-9a-f]{64}$/);
    assert.doesNotMatch(stored.secret_hash, new RegExp(session.token.slice(-16)));
    const verified = await verifyStaffSession(
      `Bearer ${session.token}`,
      db,
      NOW_MS + 2,
      staffDependencies.isStaffWallet,
    );
    assert.equal(verified.wallet, WALLET);

    const replay = await handleStaffAuthRequest(
      request(STAFF_AUTH_SESSION_PATH, {
        challengeId: challenge.challengeId,
        signature: Array.from(signature),
      }),
      env,
      STAFF_AUTH_SESSION_PATH,
      staffDependencies,
      NOW_MS + 3,
    );
    assert.equal(replay.status, 409);
    assert.equal(sessionLimiter.calls.length, 2);

    const refreshAt = NOW_MS + 24 * 60 * 60 * 1000;
    const refresh = await handleStaffAuthRequest(
      request(STAFF_AUTH_REFRESH_PATH, {}, session.token),
      env,
      STAFF_AUTH_REFRESH_PATH,
      staffDependencies,
      refreshAt,
    );
    assert.equal(refresh.status, 200);
    const refreshed = await refresh.json() as { expiresAt: number };
    assert.equal(refreshed.expiresAt, refreshAt + 30 * 24 * 60 * 60 * 1000);

    const logout = await handleStaffAuthRequest(
      request(STAFF_AUTH_LOGOUT_PATH, {}, session.token),
      env,
      STAFF_AUTH_LOGOUT_PATH,
      staffDependencies,
      refreshAt + 1,
    );
    assert.equal(logout.status, 200);
    await assert.rejects(
      verifyStaffSession(
        `Bearer ${session.token}`,
        db,
        refreshAt + 2,
        staffDependencies.isStaffWallet,
      ),
      (error: unknown) => error instanceof StaffAuthError && error.code === 'unauthenticated',
    );
  } finally {
    sqlite.close();
  }
});

test('staff wallet authentication rejects wrong origins, signatures, expiry, and removed allowlists', async () => {
  const { db, sqlite, env } = database();
  try {
    const deniedOrigin = await handleStaffAuthRequest(
      request(STAFF_AUTH_CHALLENGE_PATH, { wallet: WALLET }, undefined, 'https://evil.example'),
      env,
      STAFF_AUTH_CHALLENGE_PATH,
      staffDependencies,
      NOW_MS,
    );
    assert.equal(deniedOrigin.status, 403);

    const deniedVersionPreview = await handleStaffAuthRequest(
      request(
        STAFF_AUTH_CHALLENGE_PATH,
        { wallet: WALLET },
        undefined,
        'https://deadbeef-mons-shop.lil-org.workers.dev',
      ),
      env,
      STAFF_AUTH_CHALLENGE_PATH,
      staffDependencies,
      NOW_MS,
    );
    assert.equal(deniedVersionPreview.status, 403);

    const candidateOrigin = await handleStaffAuthRequest(
      request(
        STAFF_AUTH_CHALLENGE_PATH,
        { wallet: WALLET },
        undefined,
        'https://candidate-mons-shop.lil-org.workers.dev',
      ),
      env,
      STAFF_AUTH_CHALLENGE_PATH,
      staffDependencies,
      NOW_MS,
    );
    assert.equal(candidateOrigin.status, 200);

    const challengeResponse = await handleStaffAuthRequest(
      request(STAFF_AUTH_CHALLENGE_PATH, { wallet: WALLET }),
      env,
      STAFF_AUTH_CHALLENGE_PATH,
      staffDependencies,
      NOW_MS,
    );
    const challenge = await challengeResponse.json() as { challengeId: string; message: string };
    const wrongSignature = nacl.sign.detached(
      new TextEncoder().encode(challenge.message),
      nacl.sign.keyPair().secretKey,
    );
    const invalidSignature = await handleStaffAuthRequest(
      request(STAFF_AUTH_SESSION_PATH, {
        challengeId: challenge.challengeId,
        signature: Array.from(wrongSignature),
      }),
      env,
      STAFF_AUTH_SESSION_PATH,
      staffDependencies,
      NOW_MS + 1,
    );
    assert.equal(invalidSignature.status, 401);

    const expiredSignature = nacl.sign.detached(new TextEncoder().encode(challenge.message), keypair.secretKey);
    const expired = await handleStaffAuthRequest(
      request(STAFF_AUTH_SESSION_PATH, {
        challengeId: challenge.challengeId,
        signature: Array.from(expiredSignature),
      }),
      env,
      STAFF_AUTH_SESSION_PATH,
      staffDependencies,
      NOW_MS + 5 * 60 * 1000,
    );
    assert.equal(expired.status, 409);

    await assert.rejects(
      verifyStaffSession('Bearer invalid', db, NOW_MS, staffDependencies.isStaffWallet),
      (error: unknown) => error instanceof StaffAuthError && error.code === 'unauthenticated',
    );
  } finally {
    sqlite.close();
  }
});

test('staff session exchange bounds signature verification per caller without consuming the challenge', async () => {
  const { sqlite, env } = database();
  try {
    const challengeResponse = await handleStaffAuthRequest(
      request(STAFF_AUTH_CHALLENGE_PATH, { wallet: WALLET }),
      env,
      STAFF_AUTH_CHALLENGE_PATH,
      staffDependencies,
      NOW_MS,
    );
    const challenge = await challengeResponse.json() as { challengeId: string; message: string };
    const wrongSignature = Array.from(nacl.sign.detached(
      new TextEncoder().encode(challenge.message),
      nacl.sign.keyPair().secretKey,
    ));
    for (let index = 0; index < 30; index += 1) {
      const response = await handleStaffAuthRequest(
        request(STAFF_AUTH_SESSION_PATH, { challengeId: challenge.challengeId, signature: wrongSignature }),
        env,
        STAFF_AUTH_SESSION_PATH,
        staffDependencies,
        NOW_MS + index + 1,
      );
      assert.equal(response.status, 401);
    }
    const denied = await handleStaffAuthRequest(
      request(STAFF_AUTH_SESSION_PATH, { challengeId: challenge.challengeId, signature: wrongSignature }),
      env,
      STAFF_AUTH_SESSION_PATH,
      staffDependencies,
      NOW_MS + 31,
    );
    assert.equal(denied.status, 429);

    const signature = Array.from(nacl.sign.detached(
      new TextEncoder().encode(challenge.message),
      keypair.secretKey,
    ));
    const otherCaller = await handleStaffAuthRequest(
      request(
        STAFF_AUTH_SESSION_PATH,
        { challengeId: challenge.challengeId, signature },
        undefined,
        'https://mons.shop',
        '198.51.100.11',
      ),
      env,
      STAFF_AUTH_SESSION_PATH,
      staffDependencies,
      NOW_MS + 32,
    );
    assert.equal(otherCaller.status, 200);
  } finally {
    sqlite.close();
  }
});

test('concurrent staff challenge exchanges create exactly one session', async () => {
  const { sqlite, env } = database();
  try {
    const challengeResponse = await handleStaffAuthRequest(
      request(STAFF_AUTH_CHALLENGE_PATH, { wallet: WALLET }),
      env,
      STAFF_AUTH_CHALLENGE_PATH,
      staffDependencies,
      NOW_MS,
    );
    const challenge = await challengeResponse.json() as { challengeId: string; message: string };
    const signature = Array.from(nacl.sign.detached(
      new TextEncoder().encode(challenge.message),
      keypair.secretKey,
    ));
    const responses = await Promise.all([
      handleStaffAuthRequest(
        request(STAFF_AUTH_SESSION_PATH, { challengeId: challenge.challengeId, signature }),
        env,
        STAFF_AUTH_SESSION_PATH,
        staffDependencies,
        NOW_MS + 1,
      ),
      handleStaffAuthRequest(
        request(STAFF_AUTH_SESSION_PATH, { challengeId: challenge.challengeId, signature }),
        env,
        STAFF_AUTH_SESSION_PATH,
        staffDependencies,
        NOW_MS + 1,
      ),
    ]);
    assert.deepEqual(responses.map(({ status }) => status).sort(), [200, 409]);
    const count = sqlite.prepare('SELECT COUNT(*) AS count FROM staff_auth_sessions').get() as { count: number };
    assert.equal(count.count, 1);
  } finally {
    sqlite.close();
  }
});

test('staff challenge creation enforces the Worker caller-wallet limit', async () => {
  const { sqlite, env, challengeLimiter } = database();
  try {
    for (let index = 0; index < 10; index += 1) {
      const response = await handleStaffAuthRequest(
        request(STAFF_AUTH_CHALLENGE_PATH, { wallet: WALLET }),
        env,
        STAFF_AUTH_CHALLENGE_PATH,
        staffDependencies,
        NOW_MS + index,
      );
      assert.equal(response.status, 200);
      sqlite.prepare('UPDATE staff_auth_challenges SET consumed_at_ms = ?').run(NOW_MS + index);
    }
    const denied = await handleStaffAuthRequest(
      request(STAFF_AUTH_CHALLENGE_PATH, { wallet: WALLET }),
      env,
      STAFF_AUTH_CHALLENGE_PATH,
      staffDependencies,
      NOW_MS + 10,
    );
    assert.equal(denied.status, 429);
    assert.equal(denied.headers.get('retry-after'), '60');
    assert.deepEqual(await denied.json(), {
      ok: false,
      error: {
        code: 'resource-exhausted',
        message: 'Too many staff authentication attempts. Try again later.',
        retryAfterMs: 60_000,
      },
    });
    const challengeCount = sqlite.prepare('SELECT COUNT(*) AS count FROM staff_auth_challenges').get() as { count: number };
    assert.equal(challengeCount.count, 1);
    assert.equal(challengeLimiter.calls.length, 11);
    const otherCaller = await handleStaffAuthRequest(
      request(STAFF_AUTH_CHALLENGE_PATH, { wallet: WALLET }, undefined, 'https://mons.shop', '198.51.100.11'),
      env,
      STAFF_AUTH_CHALLENGE_PATH,
      staffDependencies,
      NOW_MS + 11,
    );
    assert.equal(otherCaller.status, 200);
    const otherWallet = await handleStaffAuthRequest(
      request(STAFF_AUTH_CHALLENGE_PATH, { wallet: OTHER_WALLET }),
      env,
      STAFF_AUTH_CHALLENGE_PATH,
      { isStaffWallet: (wallet) => wallet === WALLET || wallet === OTHER_WALLET },
      NOW_MS + 12,
    );
    assert.equal(otherWallet.status, 200);
  } finally {
    sqlite.close();
  }
});

test('staff authentication fails closed for missing caller metadata and limiter failures', async () => {
  const { sqlite, env, challengeLimiter, sessionLimiter } = database();
  try {
    const missingCaller = request(STAFF_AUTH_CHALLENGE_PATH, { wallet: WALLET });
    missingCaller.headers.delete('CF-Connecting-IP');
    const missingCallerResponse = await handleStaffAuthRequest(
      missingCaller,
      env,
      STAFF_AUTH_CHALLENGE_PATH,
      staffDependencies,
      NOW_MS,
    );
    assert.equal(missingCallerResponse.status, 503);

    const localCaller = request(
      STAFF_AUTH_CHALLENGE_PATH,
      { wallet: WALLET },
      undefined,
      'http://localhost:5173',
    );
    localCaller.headers.delete('CF-Connecting-IP');
    const localResponse = await handleStaffAuthRequest(
      localCaller,
      env,
      STAFF_AUTH_CHALLENGE_PATH,
      staffDependencies,
      NOW_MS,
    );
    assert.equal(localResponse.status, 200);

    challengeLimiter.fail = true;
    sqlite.prepare('UPDATE staff_auth_challenges SET consumed_at_ms = ?').run(NOW_MS + 1);
    const challengeFailure = await handleStaffAuthRequest(
      request(STAFF_AUTH_CHALLENGE_PATH, { wallet: WALLET }),
      env,
      STAFF_AUTH_CHALLENGE_PATH,
      staffDependencies,
      NOW_MS + 1,
    );
    assert.equal(challengeFailure.status, 503);

    sessionLimiter.fail = true;
    const sessionFailure = await handleStaffAuthRequest(
      request(STAFF_AUTH_SESSION_PATH, {
        challengeId: crypto.randomUUID(),
        signature: Array.from(new Uint8Array(64)),
      }),
      env,
      STAFF_AUTH_SESSION_PATH,
      staffDependencies,
      NOW_MS + 2,
    );
    assert.equal(sessionFailure.status, 503);
  } finally {
    sqlite.close();
  }
});

test('staff auth cleanup removes expired state without touching active sessions', async () => {
  const { db, sqlite } = database();
  try {
    sqlite.prepare(`INSERT INTO staff_auth_challenges VALUES (?, ?, ?, ?, ?, NULL)`).run(
      '11111111-1111-4111-8111-111111111111',
      WALLET,
      'mons.shop',
      NOW_MS - 600_000,
      NOW_MS - 300_000,
    );
    sqlite.prepare(`INSERT INTO staff_auth_challenges VALUES (?, ?, ?, ?, ?, ?)`).run(
      '22222222-2222-4222-8222-222222222222',
      WALLET,
      'www.mons.shop',
      NOW_MS - 10,
      NOW_MS + 299_990,
      NOW_MS - 5,
    );
    sqlite.prepare(`INSERT INTO staff_auth_sessions VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
      '33333333-3333-4333-8333-333333333333',
      '22222222-2222-4222-8222-222222222222',
      'a'.repeat(64),
      WALLET,
      NOW_MS - 5,
      NOW_MS - 5,
      NOW_MS + 30 * 24 * 60 * 60 * 1000 - 5,
    );
    const cleaned = await cleanupExpiredStaffAuthState(db, NOW_MS);
    assert.deepEqual(cleaned, {
      challengesDeleted: 1,
      sessionsDeleted: 0,
      limitReached: false,
      hasMore: false,
    });
    const count = sqlite.prepare('SELECT COUNT(*) AS count FROM staff_auth_sessions').get() as { count: number };
    assert.equal(count.count, 1);
  } finally {
    sqlite.close();
  }
});

test('staff auth cleanup reports a bounded backlog', async () => {
  const { db, sqlite } = database();
  try {
    const insert = sqlite.prepare('INSERT INTO staff_auth_challenges VALUES (?, ?, ?, ?, ?, NULL)');
    for (let index = 0; index < 501; index += 1) {
      insert.run(
        crypto.randomUUID(),
        WALLET,
        `preview-${index}.example`,
        NOW_MS - 600_000,
        NOW_MS - 300_000,
      );
    }
    const cleaned = await cleanupExpiredStaffAuthState(db, NOW_MS);
    assert.deepEqual(cleaned, {
      challengesDeleted: 500,
      sessionsDeleted: 0,
      limitReached: true,
      hasMore: true,
    });
  } finally {
    sqlite.close();
  }
});
