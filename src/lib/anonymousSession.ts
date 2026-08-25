import { AUTHENTICATED_API_ORIGIN } from './authenticatedApiOrigin';

const STORAGE_KEY = 'monsAnonymousSession:v1';
const LOCK_NAME = 'monsAnonymousSession:lock';
const REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;
const MAX_RESPONSE_BYTES = 8192;
const REQUEST_TIMEOUT_MS = 20_000;

export type AnonymousSession = {
  subject: string;
  refreshedAt: number;
  expiresAt: number;
};

const listeners = new Set<(subject: string | null) => void>();
let ensurePromise: Promise<AnonymousSession> | null = null;
let fallbackMutationTail: Promise<unknown> = Promise.resolve();
let validatedSubject: string | null = null;
let memorySession: AnonymousSession | null = null;

function parseSession(value: unknown, nowMs = Date.now()): AnonymousSession | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Partial<AnonymousSession>;
  const subject = typeof raw.subject === 'string' ? raw.subject : '';
  const refreshedAt = Number(raw.refreshedAt);
  const expiresAt = Number(raw.expiresAt);
  if (
    !/^anon:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(subject) ||
    !Number.isSafeInteger(refreshedAt) ||
    !Number.isSafeInteger(expiresAt) ||
    refreshedAt < 0 ||
    expiresAt <= nowMs ||
    refreshedAt > expiresAt
  ) return null;
  return { subject, refreshedAt, expiresAt };
}

function storedValue(): string | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage?.getItem(STORAGE_KEY) || null;
  } catch {
    return null;
  }
}

function sessionFromStoredValue(raw: string | null, nowMs = Date.now()): AnonymousSession | null {
  if (!raw) return null;
  try {
    return parseSession(JSON.parse(raw), nowMs);
  } catch {
    return null;
  }
}

function readSession(nowMs = Date.now()): AnonymousSession | null {
  const inMemory = parseSession(memorySession, nowMs);
  if (inMemory) return inMemory;
  memorySession = sessionFromStoredValue(storedValue(), nowMs);
  return memorySession;
}

function notify(session: AnonymousSession | null): void {
  for (const listener of listeners) listener(session?.subject || null);
}

function writeSession(session: AnonymousSession): AnonymousSession {
  memorySession = session;
  try {
    window.localStorage?.setItem(STORAGE_KEY, JSON.stringify(session));
  } catch {}
  validatedSubject = session.subject;
  notify(session);
  return session;
}

function removeSession(): void {
  validatedSubject = null;
  memorySession = null;
  try {
    if (typeof window !== 'undefined') window.localStorage?.removeItem(STORAGE_KEY);
  } catch {}
  notify(null);
}

async function withSessionLock<T>(operation: () => T | Promise<T>): Promise<T> {
  if (typeof navigator !== 'undefined' && navigator.locks) {
    return navigator.locks.request(LOCK_NAME, operation);
  }
  const result = fallbackMutationTail.then(operation, operation);
  fallbackMutationTail = result.then(() => undefined, () => undefined);
  return result;
}

async function boundedJson(response: Response): Promise<unknown> {
  const contentLength = Number(response.headers.get('Content-Length'));
  if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error('Authentication returned an invalid response');
  }
  if (!response.body) throw new Error('Authentication returned an invalid response');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new Error('Authentication returned an invalid response');
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
    throw new Error('Authentication returned an invalid response');
  }
}

function responseError(payload: unknown, status: number): Error {
  const raw = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? payload as { error?: { code?: unknown; message?: unknown } }
    : null;
  const error = new Error(
    typeof raw?.error?.message === 'string' ? raw.error.message : 'Authentication failed.',
  ) as Error & { code?: string; responseReceived?: boolean };
  error.code = typeof raw?.error?.code === 'string' ? raw.error.code : `http-${status}`;
  error.responseReceived = true;
  return error;
}

async function call(path: string): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new DOMException('Timed out', 'TimeoutError')),
    REQUEST_TIMEOUT_MS,
  );
  let responseReceived = false;
  try {
    const response = await fetch(`${AUTHENTICATED_API_ORIGIN}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Mons-CSRF': '1',
      },
      body: '{}',
      cache: 'no-store',
      credentials: 'same-origin',
      signal: controller.signal,
    });
    responseReceived = true;
    const payload = await boundedJson(response);
    if (!response.ok) throw responseError(payload, response.status);
    return payload;
  } catch (error) {
    if (error instanceof Error) {
      (error as Error & { responseReceived?: boolean }).responseReceived ||= responseReceived;
      throw error;
    }
    const normalized = new Error(String(error)) as Error & { responseReceived?: boolean };
    normalized.responseReceived = responseReceived;
    throw normalized;
  } finally {
    clearTimeout(timeout);
  }
}

function responseSession(payload: unknown): AnonymousSession {
  const session = parseSession(payload, Date.now());
  if (!session) throw new Error('Authentication returned an invalid response');
  return session;
}

export function currentAnonymousSession(nowMs = Date.now()): AnonymousSession | null {
  return readSession(nowMs);
}

export function currentAnonymousSubject(nowMs = Date.now()): string | null {
  return readSession(nowMs)?.subject || null;
}

export function subscribeAnonymousSession(listener: (subject: string | null) => void): () => void {
  listeners.add(listener);
  if (typeof window === 'undefined') return () => listeners.delete(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key !== STORAGE_KEY) return;
    memorySession = sessionFromStoredValue(event.newValue);
    validatedSubject = null;
    listener(memorySession?.subject || null);
  };
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('storage', onStorage);
  };
}

export async function ensureAnonymousSession(forceRefresh = false): Promise<AnonymousSession> {
  const existing = readSession();
  if (
    !forceRefresh &&
    existing &&
    validatedSubject === existing.subject &&
    Date.now() - existing.refreshedAt < REFRESH_INTERVAL_MS
  ) return existing;
  if (!ensurePromise) {
    ensurePromise = withSessionLock(async () => {
      const lockedExisting = readSession();
      if (
        !forceRefresh &&
        lockedExisting &&
        validatedSubject === lockedExisting.subject &&
        Date.now() - lockedExisting.refreshedAt < REFRESH_INTERVAL_MS
      ) {
        return lockedExisting;
      }
      const session = responseSession(await call('/auth/anonymous/session'));
      return writeSession(session);
    }).finally(() => {
      ensurePromise = null;
    });
  }
  return ensurePromise;
}

export async function logoutAnonymousSession(): Promise<void> {
  await withSessionLock(async () => {
    try {
      await call('/auth/anonymous/logout');
      removeSession();
    } catch (error) {
      if ((error as { responseReceived?: unknown } | null)?.responseReceived === true) removeSession();
      throw error;
    }
  });
}

export const anonymousSessionTestHooks = {
  parseSession,
  resetValidation: () => {
    validatedSubject = null;
    memorySession = null;
  },
  storageKey: STORAGE_KEY,
};
