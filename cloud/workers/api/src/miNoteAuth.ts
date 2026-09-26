import { secp256k1 } from '@noble/curves/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3';
import { bytesToHex, concatBytes, hexToBytes, utf8ToBytes } from '@noble/hashes/utils';
import { z } from 'zod';
import {
  MI_NOTE_AUTH_CHALLENGE_PATH, MI_NOTE_AUTH_LOGOUT_PATH, MI_NOTE_AUTH_VERIFY_PATH,
  MI_NOTE_SESSION_HEADER, type MiNoteEthereumChallenge, type MiNoteEthereumSession,
} from '../../../../shared/miNoteAuth.js';
import { normalizeMiNoteAddress } from '../../../../shared/miNoteCards.js';
import { OPS_EXPIRY_CLEANUP_STATEMENTS } from '../../../../shared/opsExpiryCleanupSql.js';
import { getPreorderConfig } from '../../../../shared/preorders.js';
import { isRequestCancellationError, readBoundedRequestJson } from './boundedRequest.js';
import { apiErrorBody, jsonResponse } from './httpResponse.js';
import { isAllowedProfileOrigin } from './profileReadSupport.js';
import { matchesSha256Hex, randomSessionSecret, sha256Hex } from './sessionSecrets.js';

export const MI_NOTE_AUTH_PATHS = [MI_NOTE_AUTH_CHALLENGE_PATH, MI_NOTE_AUTH_VERIFY_PATH, MI_NOTE_AUTH_LOGOUT_PATH] as const;
const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const SESSION_TTL_MS = 60 * 60 * 1000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TOKEN_PATTERN = /^mons_mi_note_v1\.([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.([A-Za-z0-9_-]{43})$/;
const challengeSchema = z.object({
  preorderId: z.string().max(64),
  address: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  chainId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
}).strict();
const verifySchema = z.object({ challengeId: z.string().regex(UUID_PATTERN), signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/) }).strict();

type MiNoteAuthEnv = Pick<Env, 'OPS_DB' | 'STAFF_AUTH_CHALLENGE_RATE_LIMITER' | 'STAFF_AUTH_SESSION_RATE_LIMITER'>;
type ChallengeRow = {
  challenge_id: string;
  address: string;
  preorder_id: string;
  origin: string;
  chain_id: number;
  issued_at_ms: number;
  expires_at_ms: number;
  consumed_at_ms: number | null;
};
type SessionRow = {
  session_id: string;
  secret_hash: string;
  address: string;
  preorder_id: string;
  origin: string;
  created_at_ms: number;
  expires_at_ms: number;
};

type VerifiedMiNoteSession = {
  sessionId: string;
  address: string;
  preorderId: string;
  origin: string;
  createdAtMs: number;
  expiresAtMs: number;
};

export class MiNoteAuthError extends Error {
  constructor(
    readonly code: 'invalid-argument' | 'unauthenticated' | 'permission-denied' | 'failed-precondition' | 'resource-exhausted' | 'unavailable',
    readonly status: 400 | 401 | 403 | 405 | 409 | 429 | 503,
    message: string,
  ) { super(message); this.name = 'MiNoteAuthError'; }
}

function unavailable(): MiNoteAuthError {
  return new MiNoteAuthError('unavailable', 503, 'Ethereum verification is temporarily unavailable.');
}

function invalidSession(): MiNoteAuthError {
  return new MiNoteAuthError('unauthenticated', 401, 'Verify your Ethereum wallet to continue.');
}

function requestOrigin(request: Request): string {
  let origin = request.headers.get('Origin');
  if (!origin && request.method === 'GET') {
    try { origin = new URL(request.headers.get('Referer') || request.url).origin; } catch {}
  }
  if (!origin || !isAllowedProfileOrigin(origin)) {
    throw new MiNoteAuthError('permission-denied', 403, 'Origin is not allowed.');
  }
  return origin;
}

function canonicalMessage(challenge: ChallengeRow): string {
  const plainAddress = challenge.address.slice(2);
  const checksum = bytesToHex(keccak_256(utf8ToBytes(plainAddress)));
  const address = `0x${Array.from(plainAddress, (char, index) => Number.parseInt(checksum[index], 16) >= 8 ? char.toUpperCase() : char).join('')}`;
  return [
    `${new URL(challenge.origin).host} wants you to sign in with your Ethereum account:`,
    address, '',
    'Verify ownership to view and preorder your Mi Note Cards.', '',
    `URI: ${challenge.origin}`,
    'Version: 1',
    `Chain ID: ${challenge.chain_id}`,
    `Nonce: ${challenge.challenge_id.replaceAll('-', '')}`,
    `Issued At: ${new Date(challenge.issued_at_ms).toISOString()}`,
    `Expiration Time: ${new Date(challenge.expires_at_ms).toISOString()}`,
    'Resources:',
    `- urn:mons:preorder:${challenge.preorder_id}`,
  ].join('\n');
}

function signedAddress(message: string, signature: string): string | null {
  try {
    const bytes = hexToBytes(signature.slice(2));
    if (bytes.length !== 65) return null;
    const recovery = bytes[64] >= 27 ? bytes[64] - 27 : bytes[64];
    if (recovery !== 0 && recovery !== 1) return null;
    const body = utf8ToBytes(message);
    const hash = keccak_256(concatBytes(utf8ToBytes(`\x19Ethereum Signed Message:\n${body.length}`), body));
    const recovered = secp256k1.Signature.fromCompact(bytes.subarray(0, 64)).addRecoveryBit(recovery);
    if (recovered.hasHighS()) return null;
    const publicKey = recovered.recoverPublicKey(hash).toRawBytes(false);
    return `0x${bytesToHex(keccak_256(publicKey.subarray(1)).subarray(12))}`;
  } catch { return null; }
}

async function parseBody<T>(request: Request, schema: z.ZodType<T>): Promise<T> {
  const value = await readBoundedRequestJson(request, {
    maxBytes: 2048,
    signal: request.signal,
    createError: () => new MiNoteAuthError('invalid-argument', 400, 'Invalid verification request.'),
  });
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new MiNoteAuthError('invalid-argument', 400, 'Invalid verification request.');
  return parsed.data;
}

async function rateLimit(request: Request, origin: string, limiter: RateLimit, operation: string): Promise<void> {
  const ip = request.headers.get('CF-Connecting-IP')?.trim();
  const local = ['localhost', '127.0.0.1'].includes(new URL(origin).hostname);
  if ((!ip || ip.length > 64) && !local) throw unavailable();
  const key = await sha256Hex(`mi-note-auth:v1:${operation}:${origin}:${ip || 'local-development'}`);
  let success: boolean;
  try { ({ success } = await limiter.limit({ key })); } catch { throw unavailable(); }
  if (!success) throw new MiNoteAuthError('resource-exhausted', 429, 'Too many verification attempts. Try again later.');
}

async function createChallenge(request: Request, env: MiNoteAuthEnv, origin: string, nowMs: number): Promise<MiNoteEthereumChallenge> {
  const body = await parseBody(request, challengeSchema);
  if (!getPreorderConfig(body.preorderId)) throw new MiNoteAuthError('invalid-argument', 400, 'Invalid preorder.');
  await rateLimit(request, origin, env.STAFF_AUTH_CHALLENGE_RATE_LIMITER, 'challenge');
  const challenge: ChallengeRow = {
    challenge_id: crypto.randomUUID(), address: body.address.toLowerCase(), preorder_id: body.preorderId,
    origin, chain_id: body.chainId, issued_at_ms: nowMs, expires_at_ms: nowMs + CHALLENGE_TTL_MS, consumed_at_ms: null,
  };
  await env.OPS_DB.prepare(`INSERT INTO mi_note_auth_challenges (
    challenge_id, address, preorder_id, origin, chain_id, issued_at_ms, expires_at_ms, consumed_at_ms
  ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`)
    .bind(challenge.challenge_id, challenge.address, challenge.preorder_id, origin, challenge.chain_id, nowMs, challenge.expires_at_ms)
    .run();
  return { challengeId: challenge.challenge_id, message: canonicalMessage(challenge), expiresAtMs: challenge.expires_at_ms };
}

async function createSession(request: Request, env: MiNoteAuthEnv, origin: string, nowMs: number): Promise<MiNoteEthereumSession> {
  const body = await parseBody(request, verifySchema);
  await rateLimit(request, origin, env.STAFF_AUTH_SESSION_RATE_LIMITER, 'verify');
  const challenge = await env.OPS_DB.prepare('SELECT * FROM mi_note_auth_challenges WHERE challenge_id = ?')
    .bind(body.challengeId).first<ChallengeRow>();
  if (!challenge || challenge.consumed_at_ms !== null || challenge.expires_at_ms <= nowMs ||
    challenge.origin !== origin || !getPreorderConfig(challenge.preorder_id)) {
    throw new MiNoteAuthError('failed-precondition', 409, 'The verification request expired or was already used. Please sign again.');
  }
  if (signedAddress(canonicalMessage(challenge), body.signature) !== challenge.address) {
    throw new MiNoteAuthError('unauthenticated', 401, 'The Ethereum signature does not match this wallet.');
  }
  const sessionId = crypto.randomUUID();
  const secret = randomSessionSecret();
  const secretHash = await sha256Hex(secret);
  const expiresAtMs = nowMs + SESSION_TTL_MS;
  const results = await env.OPS_DB.batch([
    env.OPS_DB.prepare(`INSERT OR IGNORE INTO mi_note_auth_sessions (
      session_id, challenge_id, secret_hash, address, preorder_id, origin, created_at_ms, expires_at_ms
    ) SELECT ?, challenge_id, ?, address, preorder_id, origin, ?, ? FROM mi_note_auth_challenges
      WHERE challenge_id = ? AND consumed_at_ms IS NULL AND expires_at_ms > ?`)
      .bind(sessionId, secretHash, nowMs, expiresAtMs, challenge.challenge_id, nowMs),
    env.OPS_DB.prepare(`UPDATE mi_note_auth_challenges SET consumed_at_ms = ?
      WHERE challenge_id = ? AND consumed_at_ms IS NULL AND expires_at_ms > ?`)
      .bind(nowMs, challenge.challenge_id, nowMs),
  ]);
  if (Number(results[0]?.meta.changes) !== 1 || Number(results[1]?.meta.changes) !== 1) {
    throw new MiNoteAuthError('failed-precondition', 409, 'The verification request was already used. Please sign again.');
  }
  return { token: `mons_mi_note_v1.${sessionId}.${secret}`, address: challenge.address, preorderId: challenge.preorder_id, expiresAtMs };
}

async function readSession(request: Request, db: D1Database | undefined, nowMs: number): Promise<VerifiedMiNoteSession> {
  const origin = requestOrigin(request);
  const match = TOKEN_PATTERN.exec(request.headers.get(MI_NOTE_SESSION_HEADER) || '');
  if (!match) throw invalidSession();
  if (!db) throw unavailable();
  let row: SessionRow | null;
  try {
    row = await db.prepare('SELECT * FROM mi_note_auth_sessions WHERE session_id = ?').bind(match[1]).first<SessionRow>();
  } catch { throw unavailable(); }
  if (!row || row.origin !== origin || !Number.isSafeInteger(row.expires_at_ms) || row.expires_at_ms <= nowMs ||
    row.expires_at_ms !== row.created_at_ms + SESSION_TTL_MS || !normalizeMiNoteAddress(row.address) ||
    !getPreorderConfig(row.preorder_id) || !await matchesSha256Hex(match[2], row.secret_hash)) throw invalidSession();
  return {
    sessionId: row.session_id, address: row.address, preorderId: row.preorder_id, origin: row.origin,
    createdAtMs: row.created_at_ms, expiresAtMs: row.expires_at_ms,
  };
}

export async function verifyMiNoteSession(
  request: Request, db: D1Database | undefined, preorderId: string, nowMs = Date.now(),
): Promise<VerifiedMiNoteSession> {
  const session = await readSession(request, db, nowMs);
  if (session.preorderId !== preorderId) throw invalidSession();
  return session;
}

export async function handleMiNoteAuthRequest(request: Request, env: MiNoteAuthEnv, path: string, nowMs = Date.now()): Promise<Response> {
  try {
    if (request.method !== 'POST') {
      await request.body?.cancel().catch(() => undefined);
      return jsonResponse(apiErrorBody(new MiNoteAuthError('invalid-argument', 405, 'Method not allowed.')), 405, { headers: { Allow: 'POST, OPTIONS' } });
    }
    const origin = requestOrigin(request);
    if (request.headers.get('X-Mons-CSRF') !== '1') throw new MiNoteAuthError('permission-denied', 403, 'Invalid verification request.');
    if (!env.OPS_DB) throw unavailable();
    if (path === MI_NOTE_AUTH_CHALLENGE_PATH) return jsonResponse(await createChallenge(request, env, origin, nowMs), 200);
    if (path === MI_NOTE_AUTH_VERIFY_PATH) return jsonResponse(await createSession(request, env, origin, nowMs), 200);
    if (path !== MI_NOTE_AUTH_LOGOUT_PATH) throw new MiNoteAuthError('invalid-argument', 400, 'Invalid verification request.');
    await parseBody(request, z.object({}).strict());
    const session = await readSession(request, env.OPS_DB, nowMs);
    await env.OPS_DB.prepare('DELETE FROM mi_note_auth_sessions WHERE session_id = ?').bind(session.sessionId).run();
    return jsonResponse({ ok: true }, 200);
  } catch (error) {
    if (isRequestCancellationError(request, error)) throw error;
    const failure = error instanceof MiNoteAuthError ? error : unavailable();
    return jsonResponse(apiErrorBody(failure), failure.status, {
      ...(failure.status === 429 ? { headers: { 'Retry-After': '60' } } : {}),
    });
  }
}

export async function cleanupExpiredMiNoteAuthState(db: D1Database, nowMs: number): Promise<{
  sessionsDeleted: number; challengesDeleted: number; limitReached: boolean; hasMore: boolean;
}> {
  const sessions = OPS_EXPIRY_CLEANUP_STATEMENTS.miNoteAuthSessions;
  const challenges = OPS_EXPIRY_CLEANUP_STATEMENTS.miNoteAuthChallenges;
  const results = await db.batch([
    db.prepare(sessions.sql).bind(nowMs, sessions.limit),
    db.prepare(challenges.sql).bind(nowMs, challenges.limit),
    db.prepare(`SELECT (EXISTS(SELECT 1 FROM mi_note_auth_sessions WHERE expires_at_ms <= ?) OR
      EXISTS(SELECT 1 FROM mi_note_auth_challenges WHERE expires_at_ms <= ?)) AS has_more`).bind(nowMs, nowMs),
  ]);
  const sessionsDeleted = Number(results[0]?.meta.changes || 0);
  const challengesDeleted = Number(results[1]?.meta.changes || 0);
  const hasMore = (results[2]?.results[0] as { has_more?: number } | undefined)?.has_more === 1;
  return { sessionsDeleted, challengesDeleted, limitReached: sessionsDeleted === sessions.limit || challengesDeleted === challenges.limit, hasMore };
}
