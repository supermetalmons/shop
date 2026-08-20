import bs58 from 'bs58';
import { isBase58Bytes } from './solanaRpcProxy.js';

export const WALLET_SESSION_COLLECTION = 'authSessions';
export const WALLET_SESSION_COMPATIBILITY_EXPIRES_AT_MS = 253_402_300_799_999;
const WALLET_SIGN_IN_MAX_SKEW_MS = 2 * 24 * 60 * 60 * 1000;

export type WalletSessionResolution =
  | { wallet: string; source: 'session' | 'legacy_uid' }
  | { wallet: null; reason: 'legacy_uid_invalid' | 'missing_wallet' | 'invalid_wallet' };

export type ParsedSolanaSignInMessage = {
  wallet: string;
  domain: string;
  timestamp: string;
  session: string;
};

export class WalletLifecycleValidationError extends Error {
  constructor(
    readonly code: 'invalid-argument' | 'permission-denied' | 'failed-precondition',
    message: string,
  ) {
    super(message);
    this.name = 'WalletLifecycleValidationError';
  }
}

export function canonicalWalletAddress(value: unknown): string | null {
  if (!isBase58Bytes(value, 32)) return null;
  try {
    const wallet = String(value);
    const encoded = bs58.encode(bs58.decode(wallet));
    return encoded === wallet ? encoded : null;
  } catch {
    return null;
  }
}

export function resolveWalletSessionBinding(params: {
  uid: string;
  sessionExists: boolean;
  sessionData: unknown;
}): WalletSessionResolution {
  if (!params.sessionExists) {
    const wallet = canonicalWalletAddress(params.uid);
    return wallet
      ? { wallet, source: 'legacy_uid' }
      : { wallet: null, reason: 'legacy_uid_invalid' };
  }
  const data = params.sessionData as { wallet?: unknown } | null;
  if (typeof data?.wallet !== 'string' || !data.wallet) {
    return { wallet: null, reason: 'missing_wallet' };
  }
  const wallet = canonicalWalletAddress(data.wallet);
  return wallet
    ? { wallet, source: 'session' }
    : { wallet: null, reason: 'invalid_wallet' };
}

export function parseSolanaSignInMessage(message: unknown): ParsedSolanaSignInMessage {
  const raw = typeof message === 'string' ? message.trim() : '';
  if (!raw) throw new WalletLifecycleValidationError('invalid-argument', 'Missing sign-in message');
  if (raw.length > 1024) throw new WalletLifecycleValidationError('invalid-argument', 'Sign-in message too long');
  const lines = raw
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .filter(Boolean);
  const prefix = 'Sign in to mons.shop as ';
  const header = lines[0] || '';
  if (!header.startsWith(prefix)) {
    throw new WalletLifecycleValidationError('invalid-argument', 'Invalid sign-in message (bad header)');
  }
  const wallet = header.slice(prefix.length).trim();
  if (!wallet) {
    throw new WalletLifecycleValidationError('invalid-argument', 'Invalid sign-in message (missing wallet)');
  }
  const fields = new Map<string, string>();
  for (const line of lines.slice(1)) {
    const separator = line.indexOf(':');
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (key && value && !fields.has(key)) fields.set(key, value);
  }
  const domain = fields.get('Domain') || '';
  const timestamp = fields.get('Timestamp') || '';
  const session = fields.get('Session') || '';
  if (!domain) throw new WalletLifecycleValidationError('invalid-argument', 'Invalid sign-in message (missing Domain)');
  if (!timestamp) throw new WalletLifecycleValidationError('invalid-argument', 'Invalid sign-in message (missing Timestamp)');
  if (!session) throw new WalletLifecycleValidationError('invalid-argument', 'Invalid sign-in message (missing Session)');
  return { wallet, domain, timestamp, session };
}

export function validateSolanaSignInMessage(params: {
  message: ParsedSolanaSignInMessage;
  nowMs: number;
  originHostname: string;
  uid: string;
  wallet: string;
}): void {
  const statementWallet = canonicalWalletAddress(params.message.wallet);
  if (statementWallet !== params.wallet) {
    throw new WalletLifecycleValidationError('invalid-argument', 'Wallet mismatch in signed message');
  }
  if (params.message.session !== params.uid) {
    throw new WalletLifecycleValidationError('permission-denied', 'Signed message does not match caller');
  }
  if (params.message.domain !== params.originHostname) {
    throw new WalletLifecycleValidationError('permission-denied', 'Signed message domain does not match request origin');
  }
  const timestampMs = Date.parse(params.message.timestamp);
  if (!Number.isFinite(timestampMs)) {
    throw new WalletLifecycleValidationError('invalid-argument', 'Invalid Timestamp in signed message');
  }
  if (Math.abs(params.nowMs - timestampMs) > WALLET_SIGN_IN_MAX_SKEW_MS) {
    throw new WalletLifecycleValidationError('failed-precondition', 'Signed message timestamp is too far from current time');
  }
}
