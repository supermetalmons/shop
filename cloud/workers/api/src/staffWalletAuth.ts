import bs58 from 'bs58';
import nacl from 'tweetnacl';
import { z } from 'zod';
import { isStaffWalletAddress } from '../../../../shared/fulfillmentAccess.js';
import { OPS_EXPIRY_CLEANUP_STATEMENTS } from '../../../../shared/opsExpiryCleanupSql.js';
import {
  WalletLifecycleValidationError,
  canonicalWalletAddress,
  parseSolanaSignInMessage,
  validateSolanaSignInMessage,
} from '../../../../shared/walletLifecycle.js';
import { isRequestCancellationError, readBoundedRequestJson } from './boundedRequest.js';
import { matchesSha256Hex, randomSessionSecret, sha256Hex } from './sessionSecrets.js';

export const STAFF_AUTH_CHALLENGE_PATH = '/staff/auth/challenge';
export const STAFF_AUTH_SESSION_PATH = '/staff/auth/session';
export const STAFF_AUTH_REFRESH_PATH = '/staff/auth/refresh';
export const STAFF_AUTH_LOGOUT_PATH = '/staff/auth/logout';
export const STAFF_AUTH_PATHS = new Set([
  STAFF_AUTH_CHALLENGE_PATH,
  STAFF_AUTH_SESSION_PATH,
  STAFF_AUTH_REFRESH_PATH,
  STAFF_AUTH_LOGOUT_PATH,
]);

const STAFF_AUTH_CHALLENGE_TTL_MS = 5 * 60 * 1000;
const STAFF_AUTH_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const STAFF_AUTH_MAX_REQUEST_BYTES = 2048;
const STAFF_AUTH_CLEANUP_LIMIT = OPS_EXPIRY_CLEANUP_STATEMENTS.staffAuthSessions.limit;
const STAFF_AUTH_RATE_LIMIT_RETRY_MS = 60_000;
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const STAFF_SESSION_TOKEN_PATTERN = /^mons_staff_v1\.([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.([A-Za-z0-9_-]{43})$/;

const challengeSchema = z.object({
  wallet: z.string().min(32).max(64),
}).strict();

const sessionSchema = z.object({
  challengeId: z.string().uuid(),
  signature: z.array(z.number().int().min(0).max(255)).length(64),
}).strict();

const emptySchema = z.object({}).strict();

export type StaffAuthPath =
  | typeof STAFF_AUTH_CHALLENGE_PATH
  | typeof STAFF_AUTH_SESSION_PATH
  | typeof STAFF_AUTH_REFRESH_PATH
  | typeof STAFF_AUTH_LOGOUT_PATH;

type StaffAuthEnv = Pick<
  Env,
  'OPS_DB' | 'STAFF_AUTH_CHALLENGE_RATE_LIMITER' | 'STAFF_AUTH_SESSION_RATE_LIMITER'
>;

type StaffAuthDependencies = {
  isStaffWallet: typeof isStaffWalletAddress;
};

const defaultDependencies: StaffAuthDependencies = {
  isStaffWallet: isStaffWalletAddress,
};

type StaffAuthChallengeRow = {
  challenge_id: string;
  wallet: string;
  origin_hostname: string;
  issued_at_ms: number;
  expires_at_ms: number;
  consumed_at_ms: number | null;
};

type StaffAuthSessionRow = {
  session_id: string;
  secret_hash: string;
  wallet: string;
  created_at_ms: number;
  refreshed_at_ms: number;
  expires_at_ms: number;
};

export type VerifiedStaffSession = {
  sessionId: string;
  wallet: string;
  createdAtMs: number;
  refreshedAtMs: number;
  expiresAtMs: number;
};

export class StaffAuthError extends Error {
  constructor(
    readonly code: 'invalid-argument' | 'unauthenticated' | 'permission-denied' | 'failed-precondition' | 'resource-exhausted' | 'unavailable',
    readonly status: 400 | 401 | 403 | 405 | 409 | 429 | 503,
    message: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'StaffAuthError';
  }
}

function jsonResponse(body: unknown, status: number): Response {
  return Response.json(body, {
    status,
    headers: {
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

function errorResponse(error: StaffAuthError): Response {
  const response = jsonResponse({
    ok: false,
    error: {
      code: error.code,
      message: error.message,
      ...(error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs }),
    },
  }, error.status);
  if (error.retryAfterMs !== undefined) {
    response.headers.set('Retry-After', String(Math.max(1, Math.ceil(error.retryAfterMs / 1000))));
  }
  return response;
}

function canonicalMessage(wallet: string, originHostname: string, issuedAtMs: number, challengeId: string): string {
  return `Sign in to mons.shop as ${wallet}\nDomain: ${originHostname}\nTimestamp: ${new Date(issuedAtMs).toISOString()}\nSession: staff:${challengeId}`;
}

export function isAllowedStaffAuthOrigin(origin: string): boolean {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.origin !== origin || url.username || url.password || url.pathname !== '/' || url.search || url.hash) return false;
  if (url.protocol === 'https:' && (
    url.hostname === 'mons.shop' ||
    url.hostname === 'www.mons.shop' ||
    url.hostname === 'candidate-mons-shop.lil-org.workers.dev'
  )) return true;
  return (url.protocol === 'http:' || url.protocol === 'https:') &&
    (url.hostname === 'localhost' || url.hostname === '127.0.0.1');
}

function requestOriginHostname(request: Request): string {
  const origin = request.headers.get('Origin') || '';
  if (!origin || !isAllowedStaffAuthOrigin(origin)) {
    throw new StaffAuthError('permission-denied', 403, 'Origin is not allowed.');
  }
  return new URL(origin).hostname.toLowerCase();
}

async function parseBody(request: Request, schema: z.ZodType): Promise<unknown> {
  let value: unknown;
  try {
    value = await readBoundedRequestJson(request, {
      maxBytes: STAFF_AUTH_MAX_REQUEST_BYTES,
      signal: request.signal,
      createError: () => new StaffAuthError('invalid-argument', 400, 'Invalid request.'),
    });
  } catch (error) {
    if (isRequestCancellationError(request, error)) throw error;
    if (error instanceof StaffAuthError) throw error;
    throw new StaffAuthError('invalid-argument', 400, 'Invalid request.');
  }
  const result = schema.safeParse(value);
  if (!result.success) throw new StaffAuthError('invalid-argument', 400, 'Invalid request.');
  return result.data;
}

function safeTimestamp(value: unknown): number | null {
  const normalized = Number(value);
  return Number.isSafeInteger(normalized) && normalized >= 0 && normalized <= 253_402_300_799_999
    ? normalized
    : null;
}

function challengeFromRow(row: Record<string, unknown> | null): StaffAuthChallengeRow | null {
  if (!row) return null;
  const challengeId = typeof row.challenge_id === 'string' ? row.challenge_id : '';
  const wallet = canonicalWalletAddress(row.wallet);
  const originHostname = typeof row.origin_hostname === 'string' ? row.origin_hostname : '';
  const issuedAtMs = safeTimestamp(row.issued_at_ms);
  const expiresAtMs = safeTimestamp(row.expires_at_ms);
  const consumedAtMs = row.consumed_at_ms === null ? null : safeTimestamp(row.consumed_at_ms);
  if (
    !UUID_V4_PATTERN.test(challengeId) ||
    !wallet ||
    !/^[a-z0-9.-]+$/.test(originHostname) ||
    issuedAtMs === null ||
    expiresAtMs === null ||
    expiresAtMs !== issuedAtMs + STAFF_AUTH_CHALLENGE_TTL_MS ||
    (row.consumed_at_ms !== null && consumedAtMs === null)
  ) return null;
  return {
    challenge_id: challengeId,
    wallet,
    origin_hostname: originHostname,
    issued_at_ms: issuedAtMs,
    expires_at_ms: expiresAtMs,
    consumed_at_ms: consumedAtMs,
  };
}

function activeChallenge(
  challenge: StaffAuthChallengeRow | null,
  nowMs: number,
): challenge is StaffAuthChallengeRow {
  return Boolean(challenge && challenge.consumed_at_ms === null && challenge.expires_at_ms > nowMs);
}

async function loadChallenge(
  db: D1Database,
  wallet: string,
  originHostname: string,
): Promise<StaffAuthChallengeRow | null> {
  return challengeFromRow(await db.prepare(`SELECT
      challenge_id,
      wallet,
      origin_hostname,
      issued_at_ms,
      expires_at_ms,
      consumed_at_ms
    FROM staff_auth_challenges
    WHERE wallet = ? AND origin_hostname = ?`)
    .bind(wallet, originHostname)
    .first<Record<string, unknown>>());
}

function callerIdentifier(request: Request, originHostname: string): string {
  const value = String(request.headers.get('CF-Connecting-IP') || '').trim().toLowerCase();
  if (value && value.length <= 64) return value;
  if (originHostname === 'localhost' || originHostname === '127.0.0.1') return 'local-development';
  throw new StaffAuthError('unavailable', 503, 'Staff authentication is temporarily unavailable.');
}

async function consumeStaffAuthRateLimit(
  limiter: RateLimit,
  key: string,
): Promise<void> {
  let success: boolean;
  try {
    ({ success } = await limiter.limit({ key }));
  } catch {
    throw new StaffAuthError('unavailable', 503, 'Staff authentication is temporarily unavailable.');
  }
  if (success) return;
  throw new StaffAuthError(
    'resource-exhausted',
    429,
    'Too many staff authentication attempts. Try again later.',
    STAFF_AUTH_RATE_LIMIT_RETRY_MS,
  );
}

function sessionFromRow(row: Record<string, unknown> | null): StaffAuthSessionRow | null {
  if (!row) return null;
  const sessionId = typeof row.session_id === 'string' ? row.session_id : '';
  const secretHash = typeof row.secret_hash === 'string' ? row.secret_hash : '';
  const wallet = canonicalWalletAddress(row.wallet);
  const createdAtMs = safeTimestamp(row.created_at_ms);
  const refreshedAtMs = safeTimestamp(row.refreshed_at_ms);
  const expiresAtMs = safeTimestamp(row.expires_at_ms);
  if (
    !UUID_V4_PATTERN.test(sessionId) ||
    !/^[0-9a-f]{64}$/.test(secretHash) ||
    !wallet ||
    createdAtMs === null ||
    refreshedAtMs === null ||
    expiresAtMs === null ||
    refreshedAtMs < createdAtMs ||
    expiresAtMs !== refreshedAtMs + STAFF_AUTH_SESSION_TTL_MS
  ) return null;
  return {
    session_id: sessionId,
    secret_hash: secretHash,
    wallet,
    created_at_ms: createdAtMs,
    refreshed_at_ms: refreshedAtMs,
    expires_at_ms: expiresAtMs,
  };
}

function authorizationToken(authorization: string | null): { sessionId: string; secret: string } {
  const match = /^Bearer\s+(.+)$/i.exec(String(authorization || '').trim());
  const tokenMatch = match ? STAFF_SESSION_TOKEN_PATTERN.exec(match[1]) : null;
  if (!tokenMatch) throw new StaffAuthError('unauthenticated', 401, 'Authentication is required.');
  return { sessionId: tokenMatch[1], secret: tokenMatch[2] };
}

export function isStaffSessionAuthorization(authorization: string | null): boolean {
  const match = /^Bearer\s+(.+)$/i.exec(String(authorization || '').trim());
  return Boolean(match && STAFF_SESSION_TOKEN_PATTERN.test(match[1]));
}

export async function verifyStaffSession(
  authorization: string | null,
  db: D1Database | undefined,
  nowMs = Date.now(),
  isStaffWallet: typeof isStaffWalletAddress = isStaffWalletAddress,
): Promise<VerifiedStaffSession> {
  if (!db) throw new StaffAuthError('unavailable', 503, 'Staff authentication is temporarily unavailable.');
  const { sessionId, secret } = authorizationToken(authorization);
  const row = sessionFromRow(await db.prepare(`SELECT
      session_id,
      secret_hash,
      wallet,
      created_at_ms,
      refreshed_at_ms,
      expires_at_ms
    FROM staff_auth_sessions
    WHERE session_id = ?`)
    .bind(sessionId)
    .first<Record<string, unknown>>());
  if (!row || row.expires_at_ms <= nowMs || !isStaffWallet(row.wallet)) {
    throw new StaffAuthError('unauthenticated', 401, 'Authentication is required.');
  }
  if (!await matchesSha256Hex(secret, row.secret_hash)) {
    throw new StaffAuthError('unauthenticated', 401, 'Authentication is required.');
  }
  return {
    sessionId: row.session_id,
    wallet: row.wallet,
    createdAtMs: row.created_at_ms,
    refreshedAtMs: row.refreshed_at_ms,
    expiresAtMs: row.expires_at_ms,
  };
}

async function createChallenge(
  request: Request,
  db: D1Database,
  limiter: RateLimit,
  nowMs: number,
  isStaffWallet: typeof isStaffWalletAddress,
): Promise<Response> {
  const originHostname = requestOriginHostname(request);
  const body = await parseBody(request, challengeSchema) as z.infer<typeof challengeSchema>;
  const wallet = canonicalWalletAddress(body.wallet);
  if (!wallet || !isStaffWallet(wallet)) {
    throw new StaffAuthError('permission-denied', 403, 'This wallet is not authorized for staff access.');
  }
  const caller = callerIdentifier(request, originHostname);
  const rateKey = await sha256Hex(`staff-auth:v1:challenge:${caller}:${wallet}`);
  await consumeStaffAuthRateLimit(limiter, rateKey);
  const existing = await loadChallenge(db, wallet, originHostname);
  if (activeChallenge(existing, nowMs)) {
    return jsonResponse({
      challengeId: existing.challenge_id,
      message: canonicalMessage(wallet, originHostname, existing.issued_at_ms, existing.challenge_id),
      expiresAt: existing.expires_at_ms,
    }, 200);
  }
  const challengeId = crypto.randomUUID();
  const expiresAt = nowMs + STAFF_AUTH_CHALLENGE_TTL_MS;
  const inserted = challengeFromRow(await db.prepare(`INSERT INTO staff_auth_challenges (
      challenge_id,
      wallet,
      origin_hostname,
      issued_at_ms,
      expires_at_ms,
      consumed_at_ms
    ) VALUES (?, ?, ?, ?, ?, NULL)
    ON CONFLICT(wallet, origin_hostname) DO UPDATE SET
      challenge_id = excluded.challenge_id,
      issued_at_ms = excluded.issued_at_ms,
      expires_at_ms = excluded.expires_at_ms,
      consumed_at_ms = NULL
    WHERE
      staff_auth_challenges.consumed_at_ms IS NOT NULL OR
      staff_auth_challenges.expires_at_ms <= excluded.issued_at_ms
    RETURNING
      challenge_id,
      wallet,
      origin_hostname,
      issued_at_ms,
      expires_at_ms,
      consumed_at_ms`)
    .bind(challengeId, wallet, originHostname, nowMs, expiresAt)
    .first<Record<string, unknown>>());
  const challenge = inserted || await loadChallenge(db, wallet, originHostname);
  if (!activeChallenge(challenge, nowMs)) {
    throw new StaffAuthError('unavailable', 503, 'Staff authentication is temporarily unavailable.');
  }
  return jsonResponse({
    challengeId: challenge.challenge_id,
    message: canonicalMessage(wallet, originHostname, challenge.issued_at_ms, challenge.challenge_id),
    expiresAt: challenge.expires_at_ms,
  }, 200);
}

async function createSession(
  request: Request,
  db: D1Database,
  limiter: RateLimit,
  nowMs: number,
  isStaffWallet: typeof isStaffWalletAddress,
): Promise<Response> {
  const originHostname = requestOriginHostname(request);
  const body = await parseBody(request, sessionSchema) as z.infer<typeof sessionSchema>;
  const caller = callerIdentifier(request, originHostname);
  const rateKey = await sha256Hex(`staff-auth:v1:session:${caller}`);
  await consumeStaffAuthRateLimit(limiter, rateKey);
  const challenge = challengeFromRow(await db.prepare(`SELECT
      challenge_id,
      wallet,
      origin_hostname,
      issued_at_ms,
      expires_at_ms,
      consumed_at_ms
    FROM staff_auth_challenges
    WHERE challenge_id = ?`)
    .bind(body.challengeId)
    .first<Record<string, unknown>>());
  if (
    !challenge ||
    challenge.consumed_at_ms !== null ||
    challenge.expires_at_ms <= nowMs ||
    challenge.origin_hostname !== originHostname ||
    !isStaffWallet(challenge.wallet)
  ) {
    throw new StaffAuthError('failed-precondition', 409, 'The staff sign-in challenge is invalid or expired.');
  }
  const message = canonicalMessage(
    challenge.wallet,
    challenge.origin_hostname,
    challenge.issued_at_ms,
    challenge.challenge_id,
  );
  try {
    validateSolanaSignInMessage({
      message: parseSolanaSignInMessage(message),
      nowMs,
      originHostname,
      uid: `staff:${challenge.challenge_id}`,
      wallet: challenge.wallet,
    });
  } catch (error) {
    if (error instanceof WalletLifecycleValidationError) {
      throw new StaffAuthError('failed-precondition', 409, 'The staff sign-in challenge is invalid or expired.');
    }
    throw error;
  }
  const signatureValid = nacl.sign.detached.verify(
    new TextEncoder().encode(message),
    Uint8Array.from(body.signature),
    bs58.decode(challenge.wallet),
  );
  if (!signatureValid) throw new StaffAuthError('unauthenticated', 401, 'Invalid signature.');
  const sessionId = crypto.randomUUID();
  const secret = randomSessionSecret();
  const secretHash = await sha256Hex(secret);
  const expiresAt = nowMs + STAFF_AUTH_SESSION_TTL_MS;
  const results = await db.batch([
    db.prepare(`INSERT OR IGNORE INTO staff_auth_sessions (
        session_id,
        challenge_id,
        secret_hash,
        wallet,
        created_at_ms,
        refreshed_at_ms,
        expires_at_ms
      )
      SELECT ?, challenge_id, ?, wallet, ?, ?, ?
      FROM staff_auth_challenges
      WHERE
        challenge_id = ? AND
        consumed_at_ms IS NULL AND
        expires_at_ms > ?`)
      .bind(sessionId, secretHash, nowMs, nowMs, expiresAt, challenge.challenge_id, nowMs),
    db.prepare(`UPDATE staff_auth_challenges
      SET consumed_at_ms = ?
      WHERE challenge_id = ? AND consumed_at_ms IS NULL AND expires_at_ms > ?`)
      .bind(nowMs, challenge.challenge_id, nowMs),
  ]);
  if (Number(results[0]?.meta.changes || 0) !== 1 || Number(results[1]?.meta.changes || 0) !== 1) {
    throw new StaffAuthError('failed-precondition', 409, 'The staff sign-in challenge is invalid or expired.');
  }
  return jsonResponse({
    wallet: challenge.wallet,
    token: `mons_staff_v1.${sessionId}.${secret}`,
    expiresAt,
  }, 200);
}

async function refreshSession(
  request: Request,
  db: D1Database,
  nowMs: number,
  isStaffWallet: typeof isStaffWalletAddress,
): Promise<Response> {
  requestOriginHostname(request);
  await parseBody(request, emptySchema);
  const session = await verifyStaffSession(request.headers.get('Authorization'), db, nowMs, isStaffWallet);
  const expiresAt = nowMs + STAFF_AUTH_SESSION_TTL_MS;
  const result = await db.prepare(`UPDATE staff_auth_sessions
    SET refreshed_at_ms = ?, expires_at_ms = ?
    WHERE session_id = ? AND expires_at_ms > ?`)
    .bind(nowMs, expiresAt, session.sessionId, nowMs)
    .run();
  if (Number(result.meta.changes || 0) !== 1) {
    throw new StaffAuthError('unauthenticated', 401, 'Authentication is required.');
  }
  return jsonResponse({ wallet: session.wallet, expiresAt }, 200);
}

async function logoutSession(
  request: Request,
  db: D1Database,
  nowMs: number,
  isStaffWallet: typeof isStaffWalletAddress,
): Promise<Response> {
  requestOriginHostname(request);
  await parseBody(request, emptySchema);
  const session = await verifyStaffSession(request.headers.get('Authorization'), db, nowMs, isStaffWallet);
  await db.prepare('DELETE FROM staff_auth_sessions WHERE session_id = ?')
    .bind(session.sessionId)
    .run();
  return jsonResponse({ ok: true }, 200);
}

export async function handleStaffAuthRequest(
  request: Request,
  env: StaffAuthEnv,
  path: StaffAuthPath,
  overrides: Partial<StaffAuthDependencies> = {},
  nowMs = Date.now(),
): Promise<Response> {
  const dependencies = { ...defaultDependencies, ...overrides };
  if (request.method !== 'POST') {
    await request.body?.cancel().catch(() => undefined);
    const response = errorResponse(new StaffAuthError('invalid-argument', 405, 'Method not allowed.'));
    response.headers.set('Allow', 'POST, OPTIONS');
    return response;
  }
  try {
    if (!env.OPS_DB) throw new StaffAuthError('unavailable', 503, 'Staff authentication is temporarily unavailable.');
    if (path === STAFF_AUTH_CHALLENGE_PATH) {
      return await createChallenge(
        request,
        env.OPS_DB,
        env.STAFF_AUTH_CHALLENGE_RATE_LIMITER,
        nowMs,
        dependencies.isStaffWallet,
      );
    }
    if (path === STAFF_AUTH_SESSION_PATH) {
      return await createSession(
        request,
        env.OPS_DB,
        env.STAFF_AUTH_SESSION_RATE_LIMITER,
        nowMs,
        dependencies.isStaffWallet,
      );
    }
    if (path === STAFF_AUTH_REFRESH_PATH) {
      return await refreshSession(request, env.OPS_DB, nowMs, dependencies.isStaffWallet);
    }
    return await logoutSession(request, env.OPS_DB, nowMs, dependencies.isStaffWallet);
  } catch (error) {
    if (isRequestCancellationError(request, error)) throw error;
    if (error instanceof StaffAuthError) return errorResponse(error);
    console.error({
      event: 'staff_auth_unhandled_error',
      path,
      error: error instanceof Error ? { name: error.name, message: error.message } : { name: 'UnknownError' },
    });
    return errorResponse(new StaffAuthError('unavailable', 503, 'Staff authentication is temporarily unavailable.'));
  }
}

export async function cleanupExpiredStaffAuthState(
  db: D1Database,
  nowMs: number,
): Promise<{
  challengesDeleted: number;
  sessionsDeleted: number;
  limitReached: boolean;
  hasMore: boolean;
}> {
  const results = await db.batch([
    db.prepare(OPS_EXPIRY_CLEANUP_STATEMENTS.staffAuthSessions.sql)
      .bind(nowMs, STAFF_AUTH_CLEANUP_LIMIT),
    db.prepare(OPS_EXPIRY_CLEANUP_STATEMENTS.staffAuthChallenges.sql)
      .bind(nowMs, OPS_EXPIRY_CLEANUP_STATEMENTS.staffAuthChallenges.limit),
    db.prepare(`SELECT (
      EXISTS(SELECT 1 FROM staff_auth_sessions WHERE expires_at_ms <= ?) OR
      EXISTS(SELECT 1 FROM staff_auth_challenges WHERE expires_at_ms <= ?)
    ) AS has_more`).bind(nowMs, nowMs),
  ]);
  const sessionsDeleted = Number(results[0]?.meta.changes || 0);
  const challengesDeleted = Number(results[1]?.meta.changes || 0);
  const hasMoreValue = (results[2]?.results[0] as { has_more?: unknown } | undefined)?.has_more;
  const hasMore = hasMoreValue === 1 || hasMoreValue === true;
  return {
    sessionsDeleted,
    challengesDeleted,
    limitReached: [sessionsDeleted, challengesDeleted].some(
      (count) => count === STAFF_AUTH_CLEANUP_LIMIT,
    ),
    hasMore,
  };
}
