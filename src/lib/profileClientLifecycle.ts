export type WalletScopedSerialRun<Request> = {
  wallet: string;
  queue: Request[];
  cancelled: boolean;
  promise: Promise<void> | null;
};

export type WalletScopedSerialRunRef<Request> = {
  current: WalletScopedSerialRun<Request> | null;
};

export function invalidateWalletScopedSerialRun<Request>(runRef: WalletScopedSerialRunRef<Request>): void {
  if (runRef.current) {
    runRef.current.cancelled = true;
    runRef.current.queue.length = 0;
  }
  runRef.current = null;
}

export function runWalletScopedSerial<Request>(args: {
  runRef: WalletScopedSerialRunRef<Request>;
  wallet: string;
  request: Request;
  execute: (request: Request, isCurrent: () => boolean) => Promise<void>;
  isContextCurrent?: () => boolean;
}): Promise<void> {
  const currentRun = args.runRef.current;
  if (
    currentRun &&
    !currentRun.cancelled &&
    currentRun.wallet === args.wallet &&
    currentRun.promise
  ) {
    currentRun.queue.push(args.request);
    return currentRun.promise;
  }
  if (currentRun) currentRun.cancelled = true;

  const run: WalletScopedSerialRun<Request> = {
    wallet: args.wallet,
    queue: [args.request],
    cancelled: false,
    promise: null,
  };
  const isCurrent = () =>
    !run.cancelled &&
    args.runRef.current === run &&
    (args.isContextCurrent?.() ?? true);
  let resolveRun!: () => void;
  let rejectRun!: (reason: unknown) => void;
  const promise = new Promise<void>((resolve, reject) => {
    resolveRun = resolve;
    rejectRun = reject;
  });
  run.promise = promise;
  args.runRef.current = run;
  void (async () => {
    try {
      while (run.queue.length > 0 && isCurrent()) {
        const activeRequest = run.queue.shift() as Request;
        await args.execute(activeRequest, isCurrent);
        if (!isCurrent()) {
          run.queue.length = 0;
          break;
        }
      }
    } finally {
      if (args.runRef.current === run) args.runRef.current = null;
    }
  })().then(
    () => {
      resolveRun();
    },
    (error) => {
      rejectRun(error);
    },
  );
  return promise;
}

export function walletDeliveryRecoveryNextCheckAt(
  result: unknown,
): number | null | undefined {
  if (!result || typeof result !== 'object') return undefined;
  const walletRecovery = (result as { walletRecovery?: unknown }).walletRecovery;
  if (!walletRecovery || typeof walletRecovery !== 'object') return undefined;
  const nextCheckAt = (walletRecovery as { nextCheckAt?: unknown }).nextCheckAt;
  if (nextCheckAt === null) return null;
  return typeof nextCheckAt === 'number' && Number.isFinite(nextCheckAt)
    ? nextCheckAt
    : undefined;
}

export type OwnerRecoveryKey = {
  owner: string;
  key: string;
};

export function stripeRecoveryKeyForResolvedSessions(
  firebaseUid: string | null | undefined,
  sessionIds: readonly string[],
): string {
  const uid = String(firebaseUid || '').trim();
  const normalizedSessionIds = Array.from(
    new Set(sessionIds.map((sessionId) => String(sessionId || '').trim()).filter(Boolean)),
  ).sort();
  return uid && normalizedSessionIds.length
    ? `${uid}:${normalizedSessionIds.join('|')}`
    : '';
}

export function stripeInventoryRecoveryTargetForResolvedSessions(args: {
  owner: string | null | undefined;
  firebaseUid: string | null | undefined;
  sessionIds: readonly string[];
}): OwnerRecoveryKey | null {
  const owner = String(args.owner || '').trim();
  const key = stripeRecoveryKeyForResolvedSessions(args.firebaseUid, args.sessionIds);
  return owner && key ? { owner, key } : null;
}

export type KeyedInventoryRecovery = OwnerRecoveryKey & {
  phase: 'pending' | 'complete';
  baselineUpdatedAt: number;
};

function ownerRecoveryKeyMatches(
  value: OwnerRecoveryKey | null | undefined,
  target: OwnerRecoveryKey,
): boolean {
  return value?.owner === target.owner && value.key === target.key;
}

export function retainMatchingOwnerRecoveryKey(
  current: OwnerRecoveryKey | null,
  target: OwnerRecoveryKey,
): OwnerRecoveryKey {
  return current && ownerRecoveryKeyMatches(current, target) ? current : target;
}

export type CappedDeadlineStep =
  | { kind: 'due' }
  | { kind: 'wait'; delayMs: number };

export function cappedDeadlineStep(
  deadlineAt: number,
  now: number,
  maximumDelay = 0x7fffffff,
): CappedDeadlineStep {
  if (!Number.isFinite(deadlineAt) || !Number.isFinite(now) || deadlineAt <= now) {
    return { kind: 'due' };
  }
  const delayCap = Number.isFinite(maximumDelay) && maximumDelay > 0
    ? maximumDelay
    : 0x7fffffff;
  return { kind: 'wait', delayMs: Math.min(deadlineAt - now, delayCap) };
}

export function beginKeyedInventoryRecovery(
  current: KeyedInventoryRecovery | null,
  target: OwnerRecoveryKey,
  baselineUpdatedAt: number,
): KeyedInventoryRecovery {
  if (ownerRecoveryKeyMatches(current, target) && current?.phase === 'complete') return current;
  return { ...target, phase: 'pending', baselineUpdatedAt };
}

export function settleKeyedInventoryRecovery(
  current: KeyedInventoryRecovery | null,
  target: OwnerRecoveryKey,
): KeyedInventoryRecovery | null {
  if (!current || !ownerRecoveryKeyMatches(current, target) || current.phase === 'complete') return current;
  return { ...current, phase: 'complete' };
}

export type KeyedInventoryRefreshRun = OwnerRecoveryKey & {
  inventoryPromise: Promise<void>;
  completionPromise: Promise<unknown>;
};

export type KeyedInventoryRefreshRunRef = {
  current: KeyedInventoryRefreshRun | null;
};

export function getOrStartKeyedInventoryRefresh(args: {
  runRef: KeyedInventoryRefreshRunRef;
  target: OwnerRecoveryKey;
  start: () => Pick<KeyedInventoryRefreshRun, 'inventoryPromise' | 'completionPromise'>;
}): { run: KeyedInventoryRefreshRun; started: boolean } {
  const current = args.runRef.current;
  if (current && ownerRecoveryKeyMatches(current, args.target)) {
    return { run: current, started: false };
  }
  const started = args.start();
  const run = { ...args.target, ...started };
  args.runRef.current = run;
  const clear = () => {
    if (args.runRef.current === run) args.runRef.current = null;
  };
  void run.completionPromise.then(clear, clear);
  return { run, started: true };
}

export async function observeKeyedInventoryRefresh(args: {
  run: KeyedInventoryRefreshRun;
  isCancelled: () => boolean;
  settle: (target: OwnerRecoveryKey) => void;
  reportError: (error: unknown) => void;
}): Promise<boolean> {
  try {
    await args.run.inventoryPromise;
  } catch (error) {
    if (!args.isCancelled()) args.reportError(error);
    await args.run.completionPromise.catch(() => undefined);
    return false;
  }
  if (args.isCancelled()) return false;
  args.settle(args.run);
  return true;
}

export function keyedInventoryRecoveryPendingForOwner(args: {
  owner: string | null | undefined;
  recovered: OwnerRecoveryKey | null;
  inventoryRecovery: KeyedInventoryRecovery | null;
}): boolean {
  if (!args.owner || args.recovered?.owner !== args.owner) return false;
  return (
    !ownerRecoveryKeyMatches(args.inventoryRecovery, args.recovered) ||
    args.inventoryRecovery?.phase === 'pending'
  );
}

export function profileSectionReadiness(args: {
  shipmentCount: number;
  shipmentsEmptyStateReady: boolean;
  receiptItemCount: number;
  inventoryEmptyStateVisible: boolean;
}): { shipments: boolean; receipts: boolean } {
  return {
    shipments: args.shipmentCount > 0 || args.shipmentsEmptyStateReady,
    receipts: args.receiptItemCount > 0 || args.inventoryEmptyStateVisible,
  };
}

type StripeShipment = {
  stripeCheckoutSessionId?: string;
};

export function authoritativeProfileShipmentsContainStripeSessions(args: {
  shipments: readonly StripeShipment[];
  ready: boolean;
  expectedSessionIds: readonly string[];
}): boolean {
  if (!args.ready || !args.expectedSessionIds.length) return false;
  const present = new Set(
    args.shipments
      .map((shipment) => shipment.stripeCheckoutSessionId?.trim() || '')
      .filter(Boolean),
  );
  return args.expectedSessionIds.every((sessionId) => present.has(sessionId.trim()));
}

const RETAINED_PROFILE_SHIPMENTS_ERROR =
  'Unable to refresh shipments. Showing previously loaded data.';

export function retainedProfileShipmentsError(args: {
  isOwnProfileView: boolean;
  shipmentCount: number;
  error: string | null;
}): string | null {
  return args.isOwnProfileView && args.shipmentCount > 0 && args.error
    ? RETAINED_PROFILE_SHIPMENTS_ERROR
    : null;
}
