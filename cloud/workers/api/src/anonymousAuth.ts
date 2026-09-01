import { z } from 'zod';
import { OPS_EXPIRY_CLEANUP_STATEMENTS } from '../../../../shared/opsExpiryCleanupSql.js';
import { isRequestCancellationError, readBoundedRequestJson } from './boundedRequest.js';
import { jsonResponse as sharedJsonResponse } from './httpResponse.js';
import { matchesSha256Hex, randomSessionSecret, sha256Hex } from './sessionSecrets.js';

const ANONYMOUS_AUTH_SESSION_PATH = '/auth/anonymous/session';
const ANONYMOUS_AUTH_LOGOUT_PATH = '/auth/anonymous/logout';
export const ANONYMOUS_AUTH_PATHS = new Set([
  ANONYMOUS_AUTH_SESSION_PATH,
  ANONYMOUS_AUTH_LOGOUT_PATH,
]);

const ANONYMOUS_AUTH_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const ANONYMOUS_AUTH_REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;
const ANONYMOUS_AUTH_MAX_REQUEST_BYTES = 256;
const ANONYMOUS_AUTH_CLEANUP_LIMIT = OPS_EXPIRY_CLEANUP_STATEMENTS.anonymousAuthSessions.limit;
const ANONYMOUS_AUTH_RATE_LIMIT_RETRY_MS = 60_000;
const PRODUCTION_COOKIE_NAME = '__Host-mons_anon_v1';
const DEVELOPMENT_COOKIE_NAME = 'mons_anon_dev_v1';
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SESSION_TOKEN_PATTERN = /^mons_anon_v1\.([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.([A-Za-z0-9_-]{43})$/;
const emptySchema = z.object({}).strict();

type AnonymousAuthEnv = Pick<Env, 'ANONYMOUS_AUTH_SESSION_RATE_LIMITER' | 'OPS_DB'>;

type AnonymousAuthRow = {
  sessionId: string;
  secretHash: string;
  authSubject: string;
  originHostname: string;
  createdAtMs: number;
  refreshedAtMs: number;
  expiresAtMs: number;
};

export type VerifiedAnonymousSession = Omit<AnonymousAuthRow, 'secretHash'>;

export class AnonymousAuthError extends Error {
  constructor(
    readonly kind: 'invalid-token' | 'provider-unavailable',
    message: string = kind,
  ) {
    super(message);
    this.name = 'AnonymousAuthError';
  }
}

function safeTimestamp(value: unknown): number | null {
  const normalized = Number(value);
  return Number.isSafeInteger(normalized) && normalized >= 0 && normalized <= 253_402_300_799_999
    ? normalized
    : null;
}

function isAllowedOrigin(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.origin !== value || url.username || url.password || url.pathname !== '/' || url.search || url.hash) return false;
  if (url.protocol === 'https:' && (url.hostname === 'mons.shop' || url.hostname === 'www.mons.shop')) return true;
  if (
    (url.protocol === 'http:' || url.protocol === 'https:') &&
    (url.hostname === 'localhost' || url.hostname === '127.0.0.1')
  ) return true;
  if (url.protocol !== 'https:') return false;
  const match = url.hostname.match(/^([^.]+)-mons-shop\.lil-org\.workers\.dev$/);
  return match?.[1] === 'candidate' || /^[0-9a-f]{8}$/i.test(match?.[1] || '');
}

function rowFromValue(value: Record<string, unknown> | null): AnonymousAuthRow | null {
  if (!value) return null;
  const sessionId = typeof value.session_id === 'string' ? value.session_id : '';
  const secretHash = typeof value.secret_hash === 'string' ? value.secret_hash : '';
  const authSubject = typeof value.auth_subject === 'string' ? value.auth_subject : '';
  const originHostname = typeof value.origin_hostname === 'string' ? value.origin_hostname : '';
  const createdAtMs = safeTimestamp(value.created_at_ms);
  const refreshedAtMs = safeTimestamp(value.refreshed_at_ms);
  const expiresAtMs = safeTimestamp(value.expires_at_ms);
  if (
    !UUID_V4_PATTERN.test(sessionId) ||
    !/^[0-9a-f]{64}$/.test(secretHash) ||
    !/^anon:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(authSubject) ||
    !/^[a-z0-9.-]+$/.test(originHostname) ||
    createdAtMs === null ||
    refreshedAtMs === null ||
    expiresAtMs === null ||
    refreshedAtMs < createdAtMs ||
    expiresAtMs !== refreshedAtMs + ANONYMOUS_AUTH_SESSION_TTL_MS
  ) return null;
  return { sessionId, secretHash, authSubject, originHostname, createdAtMs, refreshedAtMs, expiresAtMs };
}

function origin(request: Request): URL {
  const raw = request.headers.get('Origin') || '';
  if (!isAllowedOrigin(raw)) throw new AnonymousAuthError('invalid-token', 'Origin is not allowed.');
  return new URL(raw);
}

function requireCsrf(request: Request): void {
  if (request.headers.get('X-Mons-CSRF') !== '1') {
    throw new AnonymousAuthError('invalid-token', 'Authentication request is invalid.');
  }
}

function cookieName(originUrl: URL): string {
  return originUrl.protocol === 'https:' ? PRODUCTION_COOKIE_NAME : DEVELOPMENT_COOKIE_NAME;
}

function cookieValue(request: Request, name: string): string | null {
  const cookie = request.headers.get('Cookie') || '';
  for (const part of cookie.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
    return part.slice(separator + 1).trim() || null;
  }
  return null;
}

function sessionCookie(originUrl: URL, token: string, maxAgeSeconds: number): string {
  return [
    `${cookieName(originUrl)}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    ...(originUrl.protocol === 'https:' ? ['Secure'] : []),
    `Max-Age=${maxAgeSeconds}`,
  ].join('; ');
}

function jsonResponse(body: unknown, status: number, cookie?: string): Response {
  return sharedJsonResponse(body, status, {
    contentType: 'application/json',
    ...(cookie ? { headers: { 'Set-Cookie': cookie } } : {}),
  });
}

async function parseEmptyBody(request: Request): Promise<void> {
  try {
    const value = await readBoundedRequestJson(request, {
      maxBytes: ANONYMOUS_AUTH_MAX_REQUEST_BYTES,
      signal: request.signal,
      createError: () => new AnonymousAuthError('invalid-token', 'Invalid request.'),
    });
    if (!emptySchema.safeParse(value).success) {
      throw new AnonymousAuthError('invalid-token', 'Invalid request.');
    }
  } catch (error) {
    if (isRequestCancellationError(request, error)) throw error;
    if (error instanceof AnonymousAuthError) throw error;
    throw new AnonymousAuthError('invalid-token', 'Invalid request.');
  }
}

function callerIdentifier(request: Request): string {
  const value = String(request.headers.get('CF-Connecting-IP') || '').trim().toLowerCase();
  if (value && value.length <= 64) return value;
  const requestOrigin = origin(request);
  if (requestOrigin.hostname === 'localhost' || requestOrigin.hostname === '127.0.0.1') return 'local-development';
  throw new AnonymousAuthError('provider-unavailable');
}

async function loadSession(db: D1Database, sessionId: string): Promise<AnonymousAuthRow | null> {
  return rowFromValue(await db.prepare(`SELECT
      session_id,
      secret_hash,
      auth_subject,
      origin_hostname,
      created_at_ms,
      refreshed_at_ms,
      expires_at_ms
    FROM anonymous_auth_sessions
    WHERE session_id = ?`)
    .bind(sessionId)
    .first<Record<string, unknown>>());
}

async function verifyToken(
  token: string,
  originHostname: string,
  db: D1Database,
  nowMs: number,
): Promise<AnonymousAuthRow | null> {
  const match = SESSION_TOKEN_PATTERN.exec(token);
  if (!match) return null;
  const row = await loadSession(db, match[1]);
  if (!row || row.originHostname !== originHostname || row.expiresAtMs <= nowMs) return null;
  return await matchesSha256Hex(match[2], row.secretHash) ? row : null;
}

export async function verifyAnonymousSession(
  request: Request,
  db: D1Database | undefined,
  nowMs = Date.now(),
): Promise<VerifiedAnonymousSession> {
  if (!db) throw new AnonymousAuthError('provider-unavailable');
  requireCsrf(request);
  const requestOrigin = origin(request);
  const token = cookieValue(request, cookieName(requestOrigin));
  if (!token) throw new AnonymousAuthError('invalid-token');
  let row: AnonymousAuthRow | null;
  try {
    row = await verifyToken(token, requestOrigin.hostname.toLowerCase(), db, nowMs);
  } catch {
    throw new AnonymousAuthError('provider-unavailable');
  }
  if (!row) throw new AnonymousAuthError('invalid-token');
  const { secretHash: _secretHash, ...verified } = row;
  return verified;
}

async function createOrRefreshSession(
  request: Request,
  env: AnonymousAuthEnv,
  requestOrigin: URL,
  nowMs: number,
): Promise<Response> {
  const name = cookieName(requestOrigin);
  const existingToken = cookieValue(request, name);
  if (existingToken) {
    let existing: AnonymousAuthRow | null;
    try {
      existing = await verifyToken(existingToken, requestOrigin.hostname.toLowerCase(), env.OPS_DB, nowMs);
    } catch {
      throw new AnonymousAuthError('provider-unavailable');
    }
    if (existing) {
      let refreshed = existing;
      if (nowMs - existing.refreshedAtMs >= ANONYMOUS_AUTH_REFRESH_INTERVAL_MS) {
        const expiresAtMs = nowMs + ANONYMOUS_AUTH_SESSION_TTL_MS;
        const result = await env.OPS_DB.prepare(`UPDATE anonymous_auth_sessions
          SET refreshed_at_ms = ?, expires_at_ms = ?
          WHERE
            session_id = ? AND
            secret_hash = ? AND
            refreshed_at_ms = ? AND
            expires_at_ms = ? AND
            expires_at_ms > ?`)
          .bind(
            nowMs,
            expiresAtMs,
            existing.sessionId,
            existing.secretHash,
            existing.refreshedAtMs,
            existing.expiresAtMs,
            nowMs,
          )
          .run();
        if (Number(result.meta.changes || 0) === 1) {
          refreshed = { ...existing, refreshedAtMs: nowMs, expiresAtMs };
        } else {
          const winner = await verifyToken(
            existingToken,
            requestOrigin.hostname.toLowerCase(),
            env.OPS_DB,
            nowMs,
          );
          if (!winner) throw new AnonymousAuthError('provider-unavailable');
          refreshed = winner;
        }
      }
      return jsonResponse({
        subject: refreshed.authSubject,
        refreshedAt: refreshed.refreshedAtMs,
        expiresAt: refreshed.expiresAtMs,
      }, 200, sessionCookie(requestOrigin, existingToken, Math.floor(ANONYMOUS_AUTH_SESSION_TTL_MS / 1000)));
    }
  }

  const rateKey = await sha256Hex(`anonymous-auth:v1:${callerIdentifier(request)}:${requestOrigin.hostname.toLowerCase()}`);
  let allowed: boolean;
  try {
    ({ success: allowed } = await env.ANONYMOUS_AUTH_SESSION_RATE_LIMITER.limit({ key: rateKey }));
  } catch {
    throw new AnonymousAuthError('provider-unavailable');
  }
  if (!allowed) {
    const response = jsonResponse({
      ok: false,
      error: {
        code: 'resource-exhausted',
        message: 'Too many authentication attempts. Try again later.',
        retryAfterMs: ANONYMOUS_AUTH_RATE_LIMIT_RETRY_MS,
      },
    }, 429);
    response.headers.set('Retry-After', '60');
    return response;
  }

  const sessionId = crypto.randomUUID();
  const authSubject = `anon:${crypto.randomUUID()}`;
  const secret = randomSessionSecret();
  const secretHash = await sha256Hex(secret);
  const expiresAtMs = nowMs + ANONYMOUS_AUTH_SESSION_TTL_MS;
  const result = await env.OPS_DB.prepare(`INSERT INTO anonymous_auth_sessions (
      session_id,
      secret_hash,
      auth_subject,
      origin_hostname,
      created_at_ms,
      refreshed_at_ms,
      expires_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .bind(
      sessionId,
      secretHash,
      authSubject,
      requestOrigin.hostname.toLowerCase(),
      nowMs,
      nowMs,
      expiresAtMs,
    )
    .run();
  if (Number(result.meta.changes || 0) !== 1) throw new AnonymousAuthError('provider-unavailable');
  console.log({ event: 'anonymous_auth_session_created', originHostname: requestOrigin.hostname.toLowerCase() });
  return jsonResponse({ subject: authSubject, refreshedAt: nowMs, expiresAt: expiresAtMs }, 201, sessionCookie(
    requestOrigin,
    `mons_anon_v1.${sessionId}.${secret}`,
    Math.floor(ANONYMOUS_AUTH_SESSION_TTL_MS / 1000),
  ));
}

async function logoutSession(
  request: Request,
  env: AnonymousAuthEnv,
  requestOrigin: URL,
  nowMs: number,
): Promise<Response> {
  const name = cookieName(requestOrigin);
  const token = cookieValue(request, name);
  const match = token ? SESSION_TOKEN_PATTERN.exec(token) : null;
  try {
    if (match && await verifyToken(token!, requestOrigin.hostname.toLowerCase(), env.OPS_DB, nowMs)) {
      await env.OPS_DB.prepare('DELETE FROM anonymous_auth_sessions WHERE session_id = ? AND secret_hash = ?')
        .bind(match[1], await sha256Hex(match[2]))
        .run();
    }
  } catch {
    throw new AnonymousAuthError('provider-unavailable');
  }
  return jsonResponse({ ok: true }, 200, sessionCookie(requestOrigin, '', 0));
}

export async function handleAnonymousAuthRequest(
  request: Request,
  env: AnonymousAuthEnv,
  path: string,
  nowMs = Date.now(),
): Promise<Response> {
  if (request.method !== 'POST') {
    await request.body?.cancel().catch(() => undefined);
    const response = jsonResponse({ ok: false, error: { code: 'invalid-argument', message: 'Method not allowed.' } }, 405);
    response.headers.set('Allow', 'POST, OPTIONS');
    return response;
  }
  let failureCookie: string | undefined;
  try {
    requireCsrf(request);
    const requestOrigin = origin(request);
    await parseEmptyBody(request);
    if (path === ANONYMOUS_AUTH_SESSION_PATH) {
      return await createOrRefreshSession(request, env, requestOrigin, nowMs);
    }
    failureCookie = sessionCookie(requestOrigin, '', 0);
    return await logoutSession(request, env, requestOrigin, nowMs);
  } catch (error) {
    if (isRequestCancellationError(request, error)) throw error;
    if (error instanceof AnonymousAuthError) {
      const status = error.kind === 'invalid-token' ? 400 : 503;
      return jsonResponse({
        ok: false,
        error: {
          code: error.kind === 'invalid-token' ? 'invalid-argument' : 'unavailable',
          message: error.kind === 'invalid-token' ? error.message : 'Authentication is temporarily unavailable.',
        },
      }, status, failureCookie);
    }
    console.error({
      event: 'anonymous_auth_unhandled_error',
      path,
      error: error instanceof Error ? { name: error.name, message: error.message } : { name: 'UnknownError' },
    });
    return jsonResponse(
      { ok: false, error: { code: 'unavailable', message: 'Authentication is temporarily unavailable.' } },
      503,
      failureCookie,
    );
  }
}

export async function cleanupExpiredAnonymousAuthSessions(
  db: D1Database,
  nowMs: number,
): Promise<{ deletedCount: number; limitReached: boolean; hasMore: boolean }> {
  const results = await db.batch([
    db.prepare(OPS_EXPIRY_CLEANUP_STATEMENTS.anonymousAuthSessions.sql)
      .bind(nowMs, ANONYMOUS_AUTH_CLEANUP_LIMIT),
    db.prepare(`SELECT EXISTS(
      SELECT 1 FROM anonymous_auth_sessions WHERE expires_at_ms <= ?
    ) AS has_more`).bind(nowMs),
  ]);
  const deletedCount = Number(results[0]?.meta.changes || 0);
  const hasMoreValue = (results[1]?.results[0] as { has_more?: unknown } | undefined)?.has_more;
  return {
    deletedCount,
    limitReached: deletedCount === ANONYMOUS_AUTH_CLEANUP_LIMIT,
    hasMore: hasMoreValue === 1 || hasMoreValue === true,
  };
}

export const anonymousAuthTestHooks = {
  cookieName,
  sessionCookie,
  tokenPattern: SESSION_TOKEN_PATTERN,
};
