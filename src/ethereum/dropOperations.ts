import { decodeReturn, encodeCall } from '../../shared/ethereum/abi';
import { ETHEREUM_FUNCTIONS, type EthereumContainerKind } from '../../shared/ethereum/protocol';
import { readEthereumPending, readEthereumRevealJobs, readEthereumSubmission, rememberEthereumRevealJob, writeEthereumStorage, type EthereumSubmission } from './state';

export const ETHEREUM_DROP_OPERATION_TTL = 30 * 60_000;
export type EthereumDropOperation = Omit<EthereumSubmission, 'action'> & {
  id: string;
  action: 'mint' | 'relic-claim' | 'unbox';
  kind: EthereumContainerKind;
  quantity: number;
  sourceTokenIds: string[];
  discountedQuantity: number;
  relicId?: number;
  hash?: string;
};

export function definiteEthereumSubmissionRejection(error: unknown): boolean {
  if (!error || typeof error !== 'object' || !('code' in error)) return false;
  if ([4001, 4100, 4200, -32600, -32601, -32602].includes(Number(error.code))) return true;
  return [-32000, -32003].includes(Number(error.code)) && 'message' in error && typeof error.message === 'string' &&
    /insufficient funds|intrinsic gas too low|exceeds block gas limit|invalid sender|invalid transaction/i.test(error.message);
}

const prefix = 'ethereum111k:drop-operation:v1:';
const eventName = 'ethereum111k-drop-operations';
const memory = new WeakMap<Window, Map<string, { value: EthereumDropOperation | null; baseline: string | null }>>();
const requests = new WeakMap<Window, Map<string, string>>();
const storageKey = (scope: string, id: string) => `${prefix}${scope}:${id}`;

function valid(value: unknown, scope: string): value is EthereumDropOperation {
  if (!value || typeof value !== 'object') return false;
  const row = value as EthereumDropOperation;
  return row.scope === scope && typeof row.id === 'string' && /^[a-zA-Z0-9-]+$/.test(row.id) &&
    ['mint', 'relic-claim', 'unbox'].includes(row.action) && ['crate', 'warehouse', 'relic'].includes(row.kind) &&
    Number.isSafeInteger(row.submittedAt) && row.submittedAt >= 0 && Number.isInteger(row.quantity) && row.quantity > 0 && row.quantity <= 15 &&
    Number.isInteger(row.discountedQuantity) && row.discountedQuantity >= 0 && row.discountedQuantity <= row.quantity &&
    Array.isArray(row.sourceTokenIds) && row.sourceTokenIds.every(id => typeof id === 'string' && /^\d+$/.test(id)) &&
    (row.hash === undefined || /^0x[0-9a-f]{64}$/.test(row.hash)) &&
    (row.nonce === undefined || /^0x[0-9a-f]+$/.test(row.nonce)) &&
    (row.transactionSender === undefined || /^0x[0-9a-f]{40}$/.test(row.transactionSender)) &&
    (row.relicId === undefined || Number.isInteger(row.relicId) && row.relicId >= 1 && row.relicId <= 18) &&
    Boolean(row.intent && /^0x[0-9a-f]{40}$/i.test(row.intent.to) && /^0x(?:[0-9a-f]{2})*$/i.test(row.intent.data) && /^0x[0-9a-f]+$/i.test(row.intent.value));
}

export function readEthereumDropOperations(scope: string, now = Date.now(), includeExpired = false): EthereumDropOperation[] {
  if (typeof window === 'undefined') return [];
  const scopedPrefix = `${prefix}${scope}:`;
  const keys = new Set([...memory.get(window)?.keys() ?? []].filter(key => key.startsWith(scopedPrefix)));
  try {
    for (let index = 0; index < window.localStorage.length; index++) {
      const key = window.localStorage.key(index);
      if (key?.startsWith(scopedPrefix)) keys.add(key);
    }
  } catch {}
  const result: EthereumDropOperation[] = [];
  for (const key of keys) {
    const fallback = memory.get(window)?.get(key);
    let value: unknown = fallback?.value;
    try {
      const raw = window.localStorage.getItem(key);
      if (!fallback || raw !== fallback.baseline) {
        memory.get(window)?.delete(key);
        value = JSON.parse(raw ?? 'null');
      }
    } catch {}
    if (valid(value, scope) && storageKey(scope, value.id) === key &&
      (includeExpired || value.submittedAt + ETHEREUM_DROP_OPERATION_TTL > now)) result.push(value);
  }
  return result.sort((a, b) => a.submittedAt - b.submittedAt || a.id.localeCompare(b.id));
}

export function writeEthereumDropOperation(scope: string, id: string, value: EthereumDropOperation | null): void {
  const key = storageKey(scope, id);
  let baseline: string | null = null;
  try { baseline = window.localStorage.getItem(key); } catch {}
  try {
    if (value) window.localStorage.setItem(key, JSON.stringify(value));
    else window.localStorage.removeItem(key);
    if (window.localStorage.getItem(key) !== (value ? JSON.stringify(value) : null)) throw new Error('Storage unavailable');
    memory.get(window)?.delete(key);
  } catch {
    let values = memory.get(window);
    if (!values) memory.set(window, values = new Map());
    values.set(key, { value, baseline });
  }
  window.dispatchEvent(new window.CustomEvent(eventName, { detail: scope }));
}

export function subscribeEthereumDropOperations(scope: string, listener: () => void): () => void {
  const changed = (event: Event) => { if ((event as CustomEvent<string>).detail === scope) listener(); };
  const storage = (event: StorageEvent) => { if (event.key === null || event.key.startsWith(`${prefix}${scope}:`)) listener(); };
  window.addEventListener(eventName, changed);
  window.addEventListener('storage', storage);
  return () => { window.removeEventListener(eventName, changed); window.removeEventListener('storage', storage); };
}

export function readEthereumDropBusy(scope: string): string | null {
  return requests.get(window)?.get(scope) ?? null;
}

export async function runEthereumDropRequest<T>(scope: string, label: string, action: () => Promise<T>): Promise<T> {
  if (readEthereumDropBusy(scope)) throw new Error('A request is already open. Check your wallet.');
  const browserWindow = window;
  let active = requests.get(browserWindow);
  if (!active) requests.set(browserWindow, active = new Map());
  active.set(scope, label);
  const notify = () => browserWindow.dispatchEvent(new browserWindow.CustomEvent(eventName, { detail: scope }));
  notify();
  try {
    if (typeof navigator.locks?.request === 'function') {
      return await navigator.locks.request(`ethereum111k-drop-submission:${scope}`, { ifAvailable: true }, async lock => {
        if (!lock) throw new Error('A request is already open. Check your wallet.');
        return action();
      });
    }
    return await action();
  } finally {
    active.delete(scope);
    notify();
  }
}

export function migrateEthereumDropOperation(scope: string): void {
  const legacy = readEthereumPending(scope) ?? readEthereumSubmission(scope);
  if (!legacy || !['mint', 'relic-claim', 'unbox'].includes(legacy.action) || !legacy.intent) return;
  const methods = [
    [ETHEREUM_FUNCTIONS.mintCrates, 'mint', 'crate', ['uint256']],
    [ETHEREUM_FUNCTIONS.mintCratesDiscounted, 'mint', 'crate', ['uint256', 'bytes32[]']],
    [ETHEREUM_FUNCTIONS.mintWarehouses, 'mint', 'warehouse', ['uint256']],
    [ETHEREUM_FUNCTIONS.claimRelic, 'relic-claim', 'relic', ['uint256']],
    [ETHEREUM_FUNCTIONS.unboxCrate, 'unbox', 'crate', ['uint256']],
    [ETHEREUM_FUNCTIONS.unboxCrates, 'unbox', 'crate', ['uint256[]']],
    [ETHEREUM_FUNCTIONS.unboxWarehouse, 'unbox', 'warehouse', ['uint256']],
    [ETHEREUM_FUNCTIONS.unboxRelic, 'unbox', 'relic', ['uint256']],
  ] as const;
  const method = methods.find(([signature, action]) => action === legacy.action && legacy.intent!.data.slice(0, 10) === encodeCall(signature, [], []));
  if (!method) return;
  try {
    const [argument] = decodeReturn([...method[3]], `0x${legacy.intent.data.slice(10)}`);
    const sourceTokenIds = method[1] === 'unbox' ? (Array.isArray(argument) ? argument : [argument]).map(String) : [];
    const hash = 'hash' in legacy && typeof legacy.hash === 'string' ? legacy.hash : undefined;
    const id = `legacy-${hash?.slice(2) ?? legacy.submittedAt}`;
    const operation: EthereumDropOperation = { ...legacy, id, action: method[1], kind: method[2], hash,
      quantity: method[1] === 'mint' ? Number(argument) : sourceTokenIds.length || 1, sourceTokenIds,
      discountedQuantity: method[0] === ETHEREUM_FUNCTIONS.mintCratesDiscounted ? Number(argument) : 0,
      ...(method[1] === 'relic-claim' ? { relicId: Number(argument) } : {}),
      ...(!hash || !legacy.transactionSender ? { nonce: undefined } : {}),
    };
    if (valid(operation, scope) && operation.submittedAt + ETHEREUM_DROP_OPERATION_TTL > Date.now()) {
      if (hash && operation.action === 'unbox' && operation.kind === 'crate' &&
        readEthereumRevealJobs(scope).some(job => job.transactionHash === hash)) {
        rememberEthereumRevealJob(scope, hash, operation.submittedAt, operation);
      }
      if (!readEthereumDropOperations(scope).some(item => item.id === id)) writeEthereumDropOperation(scope, id, operation);
    }
    writeEthereumStorage(`${scope}:pending`, null);
  } catch {}
}
