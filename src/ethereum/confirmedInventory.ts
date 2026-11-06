import { normalizeEthereumTokenId } from '../../shared/ethereum/protocol';

type ConfirmedInventory = {
  submittedAt: number;
  tokenIds: string[];
  burnedTokenIds: string[];
};

const lifetime = 30 * 60_000;
const prefix = 'ethereum111k:confirmed-inventory:v1:';
const fallback = new WeakMap<Window, Map<string, { value: ConfirmedInventory | null; baseline: string | null }>>();
const scopePrefix = (scope: string) => `${prefix}${scope}:`;
const storageKey = (scope: string, operationId: string) => `${scopePrefix(scope)}${encodeURIComponent(operationId)}`;

function tokenIds(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(id => typeof id === 'string' && normalizeEthereumTokenId(id) === id);
}

function parse(value: unknown): ConfirmedInventory | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as ConfirmedInventory;
  return Number.isSafeInteger(record.submittedAt) && record.submittedAt >= 0 &&
    tokenIds(record.tokenIds) && tokenIds(record.burnedTokenIds) ? record : null;
}

function read(key: string): ConfirmedInventory | null {
  const memory = fallback.get(window)?.get(key);
  try {
    const raw = window.localStorage.getItem(key);
    if (memory && memory.baseline === raw) return memory.value;
    fallback.get(window)?.delete(key);
    return parse(JSON.parse(raw ?? 'null'));
  } catch { return memory?.value ?? null; }
}

function write(key: string, value: ConfirmedInventory | null): void {
  let baseline: string | null = null;
  try { baseline = window.localStorage.getItem(key); } catch {}
  try {
    const serialized = value ? JSON.stringify(value) : null;
    if (serialized === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, serialized);
    if (window.localStorage.getItem(key) !== serialized) throw new Error('Storage unavailable');
    fallback.get(window)?.delete(key);
  } catch {
    let memory = fallback.get(window);
    if (!memory) fallback.set(window, memory = new Map());
    memory.set(key, { value, baseline });
  }
}

export function readEthereumConfirmedInventory(scope: string, now = Date.now()): { tokenIds: string[]; burnedTokenIds: string[] } {
  if (typeof window === 'undefined') return { tokenIds: [], burnedTokenIds: [] };
  const scopedPrefix = scopePrefix(scope);
  const keys = new Set([...fallback.get(window)?.keys() ?? []].filter(key => key.startsWith(scopedPrefix)));
  try {
    for (let index = 0; index < window.localStorage.length; index++) {
      const key = window.localStorage.key(index);
      if (key?.startsWith(scopedPrefix)) keys.add(key);
    }
  } catch {}
  const records: ConfirmedInventory[] = [];
  for (const key of keys) {
    const record = read(key);
    if (!record) continue;
    if (record.submittedAt + lifetime <= now) write(key, null);
    else if (record.submittedAt <= now) records.push(record);
  }
  const burnedTokenIds = new Set(records.flatMap(record => record.burnedTokenIds));
  return {
    tokenIds: [...new Set(records.flatMap(record => record.tokenIds))].filter(id => !burnedTokenIds.has(id)),
    burnedTokenIds: [...burnedTokenIds],
  };
}

export function hasEthereumConfirmedInventory(scope: string, operationId: string, now = Date.now()): boolean {
  if (typeof window === 'undefined') return false;
  const record = read(storageKey(scope, operationId));
  return Boolean(record && record.submittedAt <= now && record.submittedAt + lifetime > now);
}

export function rememberEthereumConfirmedInventory(
  scope: string,
  operationId: string,
  confirmedTokenIds: readonly string[],
  burnedTokenIds: readonly string[],
  submittedAt: number,
): void {
  if (typeof window === 'undefined' || !operationId || !Number.isSafeInteger(submittedAt) || submittedAt < 0) return;
  const key = storageKey(scope, operationId);
  const previous = read(key);
  const originalSubmission = Math.min(submittedAt, previous?.submittedAt ?? submittedAt);
  const now = Date.now();
  if (originalSubmission > now || originalSubmission + lifetime <= now) { write(key, null); return; }
  const normalized = (ids: readonly string[]) => [...new Set(ids.filter(id => normalizeEthereumTokenId(id) === id))];
  write(key, {
    submittedAt: originalSubmission,
    tokenIds: normalized([...previous?.tokenIds ?? [], ...confirmedTokenIds]),
    burnedTokenIds: normalized([...previous?.burnedTokenIds ?? [], ...burnedTokenIds]),
  });
}
