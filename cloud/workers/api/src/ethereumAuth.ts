import { z } from 'zod';
import { encodeCall } from '../../../../shared/ethereum/abi.js';
import { checksumEthereumAddress, personalMessageHash, recoverEthereumAddress } from '../../../../shared/ethereum/crypto.js';
import { EthereumApiError, readEthereumBody } from './ethereumError.js';
import { ethereumAddress, ethereumCall, ethereumRpc, type EthereumContext } from './ethereumRuntime.js';
import { isAllowedProfileOrigin } from './profileReadSupport.js';
import { matchesSha256Hex, randomSessionSecret, sha256Hex } from './sessionSecrets.js';

const ETHEREUM_SESSION_HEADER = 'X-Mons-Ethereum-Session';
const CHALLENGE_TTL_MS = 300_000;
const SESSION_TTL_MS = 3_600_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TOKEN = /^mons_eth_v1\.([0-9a-f-]{36})\.([A-Za-z0-9_-]{43})$/;

type Challenge = {
  challenge_id: string;
  wallet: string;
  chain_id: number;
  drop_id: string;
  origin: string;
  message: string;
  expires_at_ms: number;
  consumed_at_ms: number | null;
};

export type EthereumSession = {
  session_id: string;
  wallet: string;
  chain_id: number;
  drop_id: string;
  origin: string;
  secret_hash: string;
  expires_at_ms: number;
};

export function ethereumRequestOrigin(request: Request, isAllowedOrigin = isAllowedProfileOrigin): string {
  const origin = request.headers.get('Origin') || (request.method === 'GET'
    ? new URL(request.headers.get('Referer') || request.url).origin
    : '');
  if (!origin || !isAllowedOrigin(origin)) throw new EthereumApiError('permission-denied', 'Origin is not allowed.');
  return origin;
}

export async function limitEthereumRequest(request: Request, context: EthereumContext, operation: string, limiter: RateLimit,
  isAllowedOrigin = isAllowedProfileOrigin): Promise<void> {
  const origin = ethereumRequestOrigin(request, isAllowedOrigin);
  const ip = request.headers.get('CF-Connecting-IP') || (['localhost', '127.0.0.1'].includes(new URL(origin).hostname) ? 'local' : '');
  if (!ip) throw new EthereumApiError('unavailable', 'Ethereum verification is temporarily unavailable.');
  const key = await sha256Hex(`ethereum:${operation}:${origin}:${ip}`);
  if (!(await limiter.limit({ key })).success) throw new EthereumApiError('resource-exhausted', 'Too many requests. Try again later.');
  context.signal.throwIfAborted();
}

export async function verifyEthereumSession(request: Request, context: EthereumContext): Promise<EthereumSession> {
  const token = TOKEN.exec(request.headers.get(ETHEREUM_SESSION_HEADER) || '');
  if (!token) throw new EthereumApiError('unauthenticated', 'Verify your Ethereum wallet to continue.');
  const row = await context.env.OPS_DB.prepare('SELECT * FROM ethereum_auth_sessions WHERE session_id = ?')
    .bind(token[1]).first<EthereumSession>();
  if (!row || row.origin !== ethereumRequestOrigin(request) || row.chain_id !== context.config.chainId ||
    row.drop_id !== context.config.dropId || row.expires_at_ms <= context.nowMs || !await matchesSha256Hex(token[2], row.secret_hash)) {
    throw new EthereumApiError('unauthenticated', 'Verify your Ethereum wallet to continue.');
  }
  return row;
}

function signInMessage(args: { wallet: string; chainId: number; origin: string; challengeId: string; nowMs: number }): string {
  return [
    `${new URL(args.origin).host} wants you to sign in with your Ethereum account:`,
    checksumEthereumAddress(args.wallet), '', 'Sign in to the 111K test collection for delivery and receipt claims.', '',
    `URI: ${args.origin}`, 'Version: 1', `Chain ID: ${args.chainId}`,
    `Nonce: ${args.challengeId.replaceAll('-', '')}`,
    `Issued At: ${new Date(args.nowMs).toISOString()}`,
    `Expiration Time: ${new Date(args.nowMs + CHALLENGE_TTL_MS).toISOString()}`,
    'Resources:', '- urn:mons:drop:111k_devnet',
  ].join('\n');
}

async function verifySignature(context: EthereumContext, wallet: string, message: string, signature: string): Promise<boolean> {
  const digest = personalMessageHash(message);
  try {
    if (recoverEthereumAddress(digest, signature)?.toLowerCase() === wallet) return true;
  } catch {}
  const code = await ethereumRpc(context, 'eth_getCode', [wallet, 'latest']);
  if (typeof code !== 'string' || code === '0x' || code === '0x0') return false;
  try {
    const result = await ethereumCall(context, encodeCall('isValidSignature(bytes32,bytes)', ['bytes32', 'bytes'], [digest, signature]), wallet);
    return result.slice(0, 10).toLowerCase() === '0x1626ba7e';
  } catch { return false; }
}

export async function ethereumAuth(request: Request, context: EthereumContext, path: string): Promise<unknown> {
  const origin = ethereumRequestOrigin(request);
  if (path.endsWith('/challenge')) {
    const body = await readEthereumBody(request, context.signal, z.object({
      dropId: z.literal('111k_devnet'), address: z.string(), chainId: z.number().int(),
    }).strict());
    if (body.chainId !== context.config.chainId) throw new EthereumApiError('invalid-argument', 'Connect to the collection test network.');
    const wallet = ethereumAddress(body.address);
    await limitEthereumRequest(request, context, 'challenge', context.env.STAFF_AUTH_CHALLENGE_RATE_LIMITER);
    const challengeId = crypto.randomUUID();
    const message = signInMessage({ wallet, chainId: body.chainId, origin, challengeId, nowMs: context.nowMs });
    await context.env.OPS_DB.prepare(`INSERT INTO ethereum_auth_challenges
      (challenge_id, wallet, chain_id, drop_id, origin, message, issued_at_ms, expires_at_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).bind(challengeId, wallet, body.chainId, body.dropId, origin,
      message, context.nowMs, context.nowMs + CHALLENGE_TTL_MS).run();
    return { challengeId, message, expiresAtMs: context.nowMs + CHALLENGE_TTL_MS };
  }
  if (path.endsWith('/verify')) {
    const body = await readEthereumBody(request, context.signal, z.object({
      challengeId: z.string().regex(UUID), signature: z.string().regex(/^0x(?:[0-9a-fA-F]{2})*$/).max(8194),
    }).strict());
    await limitEthereumRequest(request, context, 'verify', context.env.STAFF_AUTH_SESSION_RATE_LIMITER);
    const challenge = await context.env.OPS_DB.prepare('SELECT * FROM ethereum_auth_challenges WHERE challenge_id = ?')
      .bind(body.challengeId).first<Challenge>();
    if (!challenge || challenge.origin !== origin || challenge.drop_id !== context.config.dropId ||
      challenge.chain_id !== context.config.chainId || challenge.consumed_at_ms !== null || challenge.expires_at_ms <= context.nowMs) {
      throw new EthereumApiError('failed-precondition', 'This sign-in request expired or was already used.');
    }
    if (!await verifySignature(context, challenge.wallet, challenge.message, body.signature)) {
      throw new EthereumApiError('unauthenticated', 'The signature does not match this wallet.');
    }
    const sessionId = crypto.randomUUID();
    const secret = randomSessionSecret();
    const secretHash = await sha256Hex(secret);
    const expiresAtMs = context.nowMs + SESSION_TTL_MS;
    const results = await context.env.OPS_DB.batch([
      context.env.OPS_DB.prepare(`INSERT INTO ethereum_auth_sessions
        (session_id, challenge_id, secret_hash, wallet, chain_id, drop_id, origin, created_at_ms, expires_at_ms)
        SELECT ?, challenge_id, ?, wallet, chain_id, drop_id, origin, ?, ? FROM ethereum_auth_challenges
        WHERE challenge_id = ? AND consumed_at_ms IS NULL AND expires_at_ms > ?`)
        .bind(sessionId, secretHash, context.nowMs, expiresAtMs, body.challengeId, context.nowMs),
      context.env.OPS_DB.prepare(`UPDATE ethereum_auth_challenges SET consumed_at_ms = ?
        WHERE challenge_id = ? AND consumed_at_ms IS NULL AND expires_at_ms > ?`)
        .bind(context.nowMs, body.challengeId, context.nowMs),
    ]);
    if (results.some((result) => result.meta.changes !== 1)) throw new EthereumApiError('failed-precondition', 'This sign-in request was already used.');
    return { token: `mons_eth_v1.${sessionId}.${secret}`, address: challenge.wallet,
      chainId: challenge.chain_id, dropId: challenge.drop_id, expiresAtMs };
  }
  await readEthereumBody(request, context.signal, z.object({}).strict());
  const session = await verifyEthereumSession(request, context);
  await context.env.OPS_DB.prepare('DELETE FROM ethereum_auth_sessions WHERE session_id = ?').bind(session.session_id).run();
  return { ok: true };
}

export async function cleanupEthereumAuth(db: D1Database, nowMs: number): Promise<void> {
  await db.batch(['ethereum_auth_sessions', 'ethereum_auth_challenges'].map((table) => db.prepare(
    `DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE expires_at_ms <= ? LIMIT 500)`,
  ).bind(nowMs)));
}
