import { isStaffWalletAddress } from '../../shared/fulfillmentAccess';
import { canonicalWalletAddress } from '../../shared/walletLifecycle';
import { monsApiOrigin } from './monsApiOrigin';

const STAFF_SESSION_STORAGE_KEY = 'monsStaffWalletSession:v1';
const STAFF_SESSION_LOCK_NAME = 'monsStaffWalletSession:lock';
const STAFF_SESSION_REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;
const STAFF_SESSION_TOKEN_PATTERN = /^mons_staff_v1\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.[A-Za-z0-9_-]{43}$/;
const STAFF_AUTH_MAX_RESPONSE_BYTES = 8192;
const STAFF_AUTH_TIMEOUT_MS = 20_000;

export type StaffWalletSession = {
  wallet: string;
  token: string;
  expiresAt: number;
  refreshedAt: number;
};

export type StaffWalletChallenge = {
  challengeId: string;
  message: string;
  expiresAt: number;
};

type StaffAuthErrorPayload = {
  error?: {
    code?: unknown;
    message?: unknown;
  };
};

const listeners = new Set<(wallet: string | null) => void>();
const refreshPromises = new Map<string, Promise<StaffWalletSession | null>>();
let fallbackMutationTail: Promise<unknown> = Promise.resolve();

function staffAuthError(value: unknown, status: number): Error {
  const payload = value && typeof value === 'object' ? value as StaffAuthErrorPayload : null;
  const code = typeof payload?.error?.code === 'string' ? payload.error.code : `http-${status}`;
  const message = typeof payload?.error?.message === 'string'
    ? payload.error.message
    : 'Staff authentication failed.';
  const error = new Error(message) as Error & { code?: string };
  error.code = code;
  return error;
}

function errorCode(error: unknown): string {
  return typeof error === 'object' && error && typeof (error as { code?: unknown }).code === 'string'
    ? String((error as { code: string }).code)
    : '';
}

function isDefinitiveStaffAuthError(error: unknown): boolean {
  return ['unauthenticated', 'permission-denied', 'http-401', 'http-403'].includes(errorCode(error));
}

function parseSession(value: unknown, nowMs = Date.now()): StaffWalletSession | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Partial<StaffWalletSession>;
  const wallet = canonicalWalletAddress(raw.wallet);
  const token = typeof raw.token === 'string' ? raw.token : '';
  const expiresAt = Number(raw.expiresAt);
  const refreshedAt = Number(raw.refreshedAt);
  if (
    !wallet ||
    !isStaffWalletAddress(wallet) ||
    !STAFF_SESSION_TOKEN_PATTERN.test(token) ||
    !Number.isSafeInteger(expiresAt) ||
    !Number.isSafeInteger(refreshedAt) ||
    expiresAt <= nowMs ||
    refreshedAt < 0 ||
    refreshedAt > expiresAt
  ) return null;
  return { wallet, token, expiresAt, refreshedAt };
}

function notify(session: StaffWalletSession | null): void {
  for (const listener of listeners) listener(session?.wallet || null);
}

function storedValue(): string | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage?.getItem(STAFF_SESSION_STORAGE_KEY) || null;
  } catch {
    return null;
  }
}

async function withStaffSessionLock<T>(operation: () => T | Promise<T>): Promise<T> {
  if (typeof navigator !== 'undefined' && navigator.locks) {
    return navigator.locks.request(STAFF_SESSION_LOCK_NAME, operation);
  }
  const result = fallbackMutationTail.then(operation, operation);
  fallbackMutationTail = result.then(() => undefined, () => undefined);
  return result;
}

function writeStaffWalletSession(session: StaffWalletSession): StaffWalletSession {
  try {
    window.localStorage?.setItem(STAFF_SESSION_STORAGE_KEY, JSON.stringify(session));
  } catch {
    throw new Error('Unable to persist staff wallet session');
  }
  notify(session);
  return session;
}

function removeStaffWalletSession(): void {
  try {
    if (typeof window !== 'undefined') window.localStorage?.removeItem(STAFF_SESSION_STORAGE_KEY);
  } catch {}
  notify(null);
}

async function clearMalformedStaffWalletSession(raw: string): Promise<void> {
  await withStaffSessionLock(() => {
    if (storedValue() === raw) removeStaffWalletSession();
  });
}

export function readStaffWalletSession(nowMs = Date.now()): StaffWalletSession | null {
  const raw = storedValue();
  if (!raw) return null;
  try {
    const session = parseSession(JSON.parse(raw), nowMs);
    if (session) return session;
  } catch {}
  void clearMalformedStaffWalletSession(raw).catch(() => undefined);
  return null;
}

export async function saveStaffWalletSession(session: StaffWalletSession): Promise<StaffWalletSession> {
  const normalized = parseSession(session, Math.min(Date.now(), session.refreshedAt));
  if (!normalized) throw new Error('Invalid staff wallet session');
  return withStaffSessionLock(() => writeStaffWalletSession(normalized));
}

export async function installStaffWalletSessionIfUnchanged(
  session: StaffWalletSession,
  expectedToken: string | null,
): Promise<StaffWalletSession | null> {
  const normalized = parseSession(session, Math.min(Date.now(), session.refreshedAt));
  if (!normalized) throw new Error('Invalid staff wallet session');
  return withStaffSessionLock(() => {
    const current = readStaffWalletSession();
    if ((current?.token || null) !== expectedToken) return current;
    return writeStaffWalletSession(normalized);
  });
}

export async function clearStaffWalletSession(): Promise<void> {
  await withStaffSessionLock(removeStaffWalletSession);
}

async function clearStaffWalletSessionIfCurrent(token: string): Promise<boolean> {
  return withStaffSessionLock(() => {
    const current = readStaffWalletSession();
    if (!current || current.token !== token) return false;
    removeStaffWalletSession();
    return true;
  });
}

export function subscribeStaffWalletSession(listener: (wallet: string | null) => void): () => void {
  listeners.add(listener);
  if (typeof window === 'undefined') return () => listeners.delete(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key !== STAFF_SESSION_STORAGE_KEY) return;
    listener(readStaffWalletSession()?.wallet || null);
  };
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('storage', onStorage);
  };
}

async function boundedJson(response: Response): Promise<unknown> {
  const contentLength = Number(response.headers.get('Content-Length'));
  if (Number.isFinite(contentLength) && contentLength > STAFF_AUTH_MAX_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error('Staff authentication returned an invalid response');
  }
  if (!response.body) throw new Error('Staff authentication returned an invalid response');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > STAFF_AUTH_MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new Error('Staff authentication returned an invalid response');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error('Staff authentication returned an invalid response');
  }
}

async function callStaffAuth(path: string, body: unknown, token?: string): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new DOMException('Timed out', 'TimeoutError')),
    STAFF_AUTH_TIMEOUT_MS,
  );
  try {
    const response = await fetch(`${monsApiOrigin()}${path}`, {
      method: 'POST',
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      cache: 'no-store',
      signal: controller.signal,
    });
    const payload = await boundedJson(response);
    if (!response.ok) throw staffAuthError(payload, response.status);
    return payload;
  } finally {
    clearTimeout(timeout);
  }
}

export async function createStaffWalletChallenge(walletValue: string): Promise<StaffWalletChallenge> {
  const wallet = canonicalWalletAddress(walletValue);
  if (!wallet || !isStaffWalletAddress(wallet)) throw new Error('This wallet is not authorized for staff access.');
  const payload = await callStaffAuth('/staff/auth/challenge', { wallet });
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Invalid staff authentication response');
  }
  const raw = payload as Partial<StaffWalletChallenge>;
  const challengeId = typeof raw.challengeId === 'string' ? raw.challengeId : '';
  const message = typeof raw.message === 'string' ? raw.message : '';
  const expiresAt = Number(raw.expiresAt);
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(challengeId) ||
    !message ||
    !Number.isSafeInteger(expiresAt) ||
    expiresAt <= Date.now()
  ) {
    throw new Error('Invalid staff authentication response');
  }
  return { challengeId, message, expiresAt };
}

export async function exchangeStaffWalletChallenge(
  challengeId: string,
  signature: Uint8Array,
): Promise<StaffWalletSession> {
  const payload = await callStaffAuth('/staff/auth/session', {
    challengeId,
    signature: Array.from(signature),
  });
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Invalid staff authentication response');
  }
  const raw = payload as { wallet?: unknown; token?: unknown; expiresAt?: unknown };
  const wallet = canonicalWalletAddress(raw.wallet);
  const token = typeof raw.token === 'string' ? raw.token : '';
  const expiresAt = Number(raw.expiresAt);
  const refreshedAt = Date.now();
  if (
    !wallet ||
    !isStaffWalletAddress(wallet) ||
    !STAFF_SESSION_TOKEN_PATTERN.test(token) ||
    !Number.isSafeInteger(expiresAt) ||
    expiresAt <= refreshedAt
  ) throw new Error('Invalid staff authentication response');
  return { wallet, token, expiresAt, refreshedAt };
}

async function refreshStaffWalletSession(session: StaffWalletSession): Promise<StaffWalletSession | null> {
  const payload = await callStaffAuth('/staff/auth/refresh', {}, session.token);
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Invalid staff authentication response');
  }
  const raw = payload as { wallet?: unknown; expiresAt?: unknown };
  const wallet = canonicalWalletAddress(raw.wallet);
  const expiresAt = Number(raw.expiresAt);
  const refreshedAt = Date.now();
  if (wallet !== session.wallet || !Number.isSafeInteger(expiresAt) || expiresAt <= refreshedAt) {
    throw new Error('Invalid staff authentication response');
  }
  return withStaffSessionLock(() => {
    const current = readStaffWalletSession();
    if (!current || current.token !== session.token) return current;
    return writeStaffWalletSession({ ...session, expiresAt, refreshedAt });
  });
}

export async function ensureStaffWalletSession(forceRefresh = false): Promise<StaffWalletSession | null> {
  const session = readStaffWalletSession();
  if (!session) return null;
  if (!forceRefresh && Date.now() - session.refreshedAt < STAFF_SESSION_REFRESH_INTERVAL_MS) return session;
  let refreshPromise = refreshPromises.get(session.token);
  if (!refreshPromise) {
    refreshPromise = refreshStaffWalletSession(session)
      .catch(async (error) => {
        if (isDefinitiveStaffAuthError(error)) await clearStaffWalletSessionIfCurrent(session.token);
        throw error;
      })
      .finally(() => {
        refreshPromises.delete(session.token);
      });
    refreshPromises.set(session.token, refreshPromise);
  }
  return refreshPromise;
}

export async function logoutStaffWalletSession(
  session = readStaffWalletSession(),
): Promise<void> {
  if (!session) return;
  try {
    await callStaffAuth('/staff/auth/logout', {}, session.token);
  } catch (error) {
    if (!isDefinitiveStaffAuthError(error)) throw error;
  }
  await clearStaffWalletSessionIfCurrent(session.token);
}

export const staffWalletSessionTestHooks = {
  parseSession,
  storageKey: STAFF_SESSION_STORAGE_KEY,
  tokenPattern: STAFF_SESSION_TOKEN_PATTERN,
};
