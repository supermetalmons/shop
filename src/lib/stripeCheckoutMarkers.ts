import type { MintStats } from '../types';

type StripeCheckoutMarkerStatus = 'started' | 'completed';

export type StripeCheckoutMintProgress = {
  dropId: string;
  quantity: number;
  remainingBeforeCheckout?: number;
  variantKey?: string;
  variantRemainingBeforeCheckout?: number;
};

export type StripeCheckoutMarker = {
  sessionId: string;
  dropId: string;
  firebaseUid: string;
  status: StripeCheckoutMarkerStatus;
  createdAt: number;
  completedAt?: number;
  quantity?: number;
  remainingBeforeCheckout?: number;
  variantKey?: string;
  variantRemainingBeforeCheckout?: number;
};

export type StripeCheckoutMarkerStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

const STRIPE_CHECKOUT_MARKERS_STORAGE_KEY = 'monsStripeCheckoutMarkers:v1';

const MAX_STRIPE_CHECKOUT_MARKERS = 50;

function defaultStorage(): StripeCheckoutMarkerStorage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage || null;
  } catch {
    return null;
  }
}

function normalizedString(value: unknown): string {
  return String(value || '').trim();
}

function normalizeTimestamp(value: unknown, fallback: number): number {
  const parsed = Math.floor(Number(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizePositiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    ? value
    : undefined;
}

function normalizeNonnegativeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

function normalizeMarker(value: unknown): StripeCheckoutMarker | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const sessionId = normalizedString(raw.sessionId);
  const dropId = normalizedString(raw.dropId).toLowerCase();
  const firebaseUid = normalizedString(raw.firebaseUid);
  const status = raw.status === 'completed' ? 'completed' : raw.status === 'started' ? 'started' : null;
  if (!sessionId || !dropId || !firebaseUid || !status) return null;
  const createdAt = normalizeTimestamp(raw.createdAt, Date.now());
  const completedAt = status === 'completed' ? normalizeTimestamp(raw.completedAt, createdAt) : undefined;
  const quantity = normalizePositiveInteger(raw.quantity);
  const remainingBeforeCheckout = normalizeNonnegativeInteger(raw.remainingBeforeCheckout);
  const variantKey = normalizedString(raw.variantKey) || undefined;
  const variantRemainingBeforeCheckout = normalizeNonnegativeInteger(raw.variantRemainingBeforeCheckout);
  return {
    sessionId,
    dropId,
    firebaseUid,
    status,
    createdAt,
    ...(completedAt ? { completedAt } : {}),
    ...(quantity ? { quantity } : {}),
    ...(remainingBeforeCheckout != null ? { remainingBeforeCheckout } : {}),
    ...(variantKey ? { variantKey } : {}),
    ...(variantRemainingBeforeCheckout != null
      ? { variantRemainingBeforeCheckout }
      : {}),
  };
}

function markerActivityAt(marker: StripeCheckoutMarker): number {
  return marker.completedAt ?? marker.createdAt;
}

function markerIdentity(marker: Pick<StripeCheckoutMarker, 'firebaseUid' | 'sessionId'>): string {
  return `${marker.firebaseUid}:${marker.sessionId}`;
}

function isMarkerForSession(marker: StripeCheckoutMarker, sessionId: string, firebaseUid: string): boolean {
  return marker.sessionId === sessionId && marker.firebaseUid === firebaseUid;
}

function serializeStripeCheckoutMarkers(markers: readonly StripeCheckoutMarker[]): string {
  return JSON.stringify(markers);
}

function compactStripeCheckoutMarkers(markers: readonly StripeCheckoutMarker[]): StripeCheckoutMarker[] {
  const byKey = new Map<string, StripeCheckoutMarker>();
  markers.forEach((marker) => {
    const key = markerIdentity(marker);
    const existing = byKey.get(key);
    if (!existing || markerActivityAt(marker) >= markerActivityAt(existing)) {
      byKey.set(key, marker);
    }
  });
  return Array.from(byKey.values())
    .sort((a, b) => markerActivityAt(b) - markerActivityAt(a))
    .slice(0, MAX_STRIPE_CHECKOUT_MARKERS);
}

export function parseStripeCheckoutMarkers(raw: string | null | undefined): {
  markers: StripeCheckoutMarker[];
  needsCleanup: boolean;
} {
  if (!raw) return { markers: [], needsCleanup: false };
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return { markers: [], needsCleanup: true };
    const markers = compactStripeCheckoutMarkers(
      parsed.map(normalizeMarker).filter((entry): entry is StripeCheckoutMarker => Boolean(entry)),
    );
    return { markers, needsCleanup: serializeStripeCheckoutMarkers(markers) !== raw };
  } catch {
    return { markers: [], needsCleanup: true };
  }
}

function persistStripeCheckoutMarkers(
  markers: readonly StripeCheckoutMarker[],
  storage: StripeCheckoutMarkerStorage | null = defaultStorage(),
): StripeCheckoutMarker[] {
  const compacted = compactStripeCheckoutMarkers(markers);
  if (!storage) return compacted;
  try {
    if (compacted.length) {
      storage.setItem(STRIPE_CHECKOUT_MARKERS_STORAGE_KEY, serializeStripeCheckoutMarkers(compacted));
    } else {
      storage.removeItem(STRIPE_CHECKOUT_MARKERS_STORAGE_KEY);
    }
  } catch {}
  return compacted;
}

export function loadStripeCheckoutMarkers(
  storage: StripeCheckoutMarkerStorage | null = defaultStorage(),
): StripeCheckoutMarker[] {
  if (!storage) return [];
  try {
    const parsed = parseStripeCheckoutMarkers(storage.getItem(STRIPE_CHECKOUT_MARKERS_STORAGE_KEY));
    if (parsed.needsCleanup) persistStripeCheckoutMarkers(parsed.markers, storage);
    return parsed.markers;
  } catch {
    return [];
  }
}

export function rememberStripeCheckoutStarted(
  marker: Pick<StripeCheckoutMarker, 'sessionId' | 'dropId' | 'firebaseUid'> & {
    createdAt?: number;
    quantity?: number;
    remainingBeforeCheckout?: number;
    variantKey?: string;
    variantRemainingBeforeCheckout?: number;
  },
  storage: StripeCheckoutMarkerStorage | null = defaultStorage(),
): StripeCheckoutMarker[] {
  const sessionId = normalizedString(marker.sessionId);
  const dropId = normalizedString(marker.dropId).toLowerCase();
  const firebaseUid = normalizedString(marker.firebaseUid);
  if (!sessionId || !dropId || !firebaseUid) {
    return loadStripeCheckoutMarkers(storage);
  }
  const markers = loadStripeCheckoutMarkers(storage);
  const existing = markers.find((entry) => isMarkerForSession(entry, sessionId, firebaseUid));
  const quantity = normalizePositiveInteger(marker.quantity) || existing?.quantity;
  const remainingBeforeCheckout =
    normalizeNonnegativeInteger(marker.remainingBeforeCheckout) ?? existing?.remainingBeforeCheckout;
  const variantKey = normalizedString(marker.variantKey) || existing?.variantKey;
  const variantRemainingBeforeCheckout =
    normalizeNonnegativeInteger(marker.variantRemainingBeforeCheckout) ??
    existing?.variantRemainingBeforeCheckout;
  const nextMarker: StripeCheckoutMarker = {
    sessionId,
    dropId,
    firebaseUid,
    status: existing?.status === 'completed' ? 'completed' : 'started',
    createdAt: normalizeTimestamp(marker.createdAt, Date.now()),
    ...(existing?.completedAt ? { completedAt: existing.completedAt } : {}),
    ...(quantity ? { quantity } : {}),
    ...(remainingBeforeCheckout != null ? { remainingBeforeCheckout } : {}),
    ...(variantKey ? { variantKey } : {}),
    ...(variantRemainingBeforeCheckout != null
      ? { variantRemainingBeforeCheckout }
      : {}),
  };
  return persistStripeCheckoutMarkers(
    [nextMarker, ...markers.filter((entry) => !isMarkerForSession(entry, sessionId, firebaseUid))],
    storage,
  );
}

export function completeStripeCheckoutMarker(
  args: { sessionId: string; firebaseUid: string; completedAt?: number },
  storage: StripeCheckoutMarkerStorage | null = defaultStorage(),
): { markers: StripeCheckoutMarker[]; completed: boolean } {
  const sessionId = normalizedString(args.sessionId);
  const firebaseUid = normalizedString(args.firebaseUid);
  const markers = loadStripeCheckoutMarkers(storage);
  if (!sessionId || !firebaseUid) return { markers, completed: false };

  let completed = false;
  const completedAt = normalizeTimestamp(args.completedAt, Date.now());
  const nextMarkers = markers.map((marker) => {
    if (!isMarkerForSession(marker, sessionId, firebaseUid)) return marker;
    completed = true;
    return {
      ...marker,
      status: 'completed' as const,
      completedAt,
    };
  });
  return { markers: completed ? persistStripeCheckoutMarkers(nextMarkers, storage) : markers, completed };
}

export function forgetCompletedStripeCheckoutMarkersForFirebaseUid(
  args: { firebaseUid: string | null | undefined; sessionIds: readonly string[] },
  storage: StripeCheckoutMarkerStorage | null = defaultStorage(),
): { markers: StripeCheckoutMarker[]; removed: boolean; removedSessionIds: string[] } {
  const firebaseUid = normalizedString(args.firebaseUid);
  const sessionIds = new Set(args.sessionIds.map(normalizedString).filter(Boolean));
  const markers = loadStripeCheckoutMarkers(storage);
  if (!firebaseUid || !sessionIds.size) {
    return { markers, removed: false, removedSessionIds: [] };
  }

  const removedSessionIds: string[] = [];
  const nextMarkers = markers.filter((marker) => {
    if (marker.firebaseUid !== firebaseUid || marker.status !== 'completed' || !sessionIds.has(marker.sessionId)) {
      return true;
    }
    removedSessionIds.push(marker.sessionId);
    return false;
  });

  if (!removedSessionIds.length) {
    return { markers, removed: false, removedSessionIds: [] };
  }

  return {
    markers: persistStripeCheckoutMarkers(nextMarkers, storage),
    removed: true,
    removedSessionIds,
  };
}

export function stripeCheckoutMintProgressForSession(
  firebaseUid: string | null | undefined,
  sessionId: string | null | undefined,
  markers: readonly StripeCheckoutMarker[],
): StripeCheckoutMintProgress | null {
  const normalizedFirebaseUid = normalizedString(firebaseUid);
  const normalizedSessionId = normalizedString(sessionId);
  if (!normalizedFirebaseUid || !normalizedSessionId) return null;
  const marker = markers.find(
    (entry) =>
      entry.firebaseUid === normalizedFirebaseUid &&
      entry.sessionId === normalizedSessionId,
  );
  if (!marker) return null;
  return {
    dropId: marker.dropId,
    quantity: marker.quantity || 1,
    ...(marker.remainingBeforeCheckout != null
      ? { remainingBeforeCheckout: marker.remainingBeforeCheckout }
      : {}),
    ...(marker.variantKey ? { variantKey: marker.variantKey } : {}),
    ...(marker.variantRemainingBeforeCheckout != null
      ? { variantRemainingBeforeCheckout: marker.variantRemainingBeforeCheckout }
      : {}),
  };
}

function optimisticRemaining(baseline: number, quantity: number): number {
  return Math.max(0, baseline - quantity);
}

export function applyOptimisticStripeCheckoutMintProgress(
  stats: MintStats | undefined,
  progress: StripeCheckoutMintProgress | null | undefined,
): MintStats | undefined {
  if (!stats || !progress) return stats;
  const totalRemaining =
    progress.remainingBeforeCheckout == null
      ? stats.remaining
      : Math.min(
          stats.remaining,
          optimisticRemaining(
            progress.remainingBeforeCheckout,
            progress.quantity,
          ),
        );
  const variantRemaining =
    progress.variantKey && progress.variantRemainingBeforeCheckout != null
      ? stats.mintSelectionAvailability?.[progress.variantKey]
      : undefined;
  const optimisticVariantTarget =
    progress.variantRemainingBeforeCheckout == null
      ? undefined
      : optimisticRemaining(
          progress.variantRemainingBeforeCheckout,
          progress.quantity,
        );
  const optimisticVariantRemaining =
    variantRemaining == null || optimisticVariantTarget == null
      ? undefined
      : Math.min(variantRemaining, optimisticVariantTarget);
  const totalChanged = totalRemaining !== stats.remaining;
  const variantChanged =
    optimisticVariantRemaining != null &&
    optimisticVariantRemaining !== variantRemaining;
  if (!totalChanged && !variantChanged) return stats;
  return {
    ...stats,
    ...(totalChanged
      ? {
          minted: Math.max(stats.minted, stats.total - totalRemaining),
          remaining: totalRemaining,
        }
      : {}),
    ...(variantChanged && progress.variantKey
      ? {
          mintSelectionAvailability: {
            ...stats.mintSelectionAvailability,
            [progress.variantKey]: optimisticVariantRemaining,
          },
        }
      : {}),
  };
}

export function isStripeCheckoutMintProgressSettled(
  stats: MintStats | undefined,
  progress: StripeCheckoutMintProgress | null | undefined,
): boolean {
  if (!stats || !progress) return false;
  let tracksProgress = false;
  if (progress.remainingBeforeCheckout != null) {
    tracksProgress = true;
    if (
      stats.remaining >
      optimisticRemaining(progress.remainingBeforeCheckout, progress.quantity)
    ) {
      return false;
    }
  }
  if (progress.variantKey && progress.variantRemainingBeforeCheckout != null) {
    tracksProgress = true;
    const variantRemaining =
      stats.mintSelectionAvailability?.[progress.variantKey];
    if (
      variantRemaining == null ||
      variantRemaining >
        optimisticRemaining(
          progress.variantRemainingBeforeCheckout,
          progress.quantity,
        )
    ) {
      return false;
    }
  }
  return tracksProgress;
}

export function completedStripeCheckoutMarkerKeyForFirebaseUid(
  firebaseUid: string | null | undefined,
  markers: readonly StripeCheckoutMarker[],
): string {
  return completedStripeCheckoutMarkerSummaryForFirebaseUid(firebaseUid, markers).markerKey;
}

export function completedStripeCheckoutMarkerSummaryForFirebaseUid(
  firebaseUid: string | null | undefined,
  markers: readonly StripeCheckoutMarker[],
): { markerKey: string; sessionIds: string[]; latestCompletedAt: number } {
  const uid = normalizedString(firebaseUid);
  if (!uid) return { markerKey: '', sessionIds: [], latestCompletedAt: 0 };

  const sessionIds: string[] = [];
  let latestCompletedAt = 0;
  markers.forEach((marker) => {
    if (marker.firebaseUid !== uid || marker.status !== 'completed') return;
    sessionIds.push(marker.sessionId);
    latestCompletedAt = Math.max(latestCompletedAt, marker.completedAt || marker.createdAt || 0);
  });

  sessionIds.sort();
  return {
    markerKey: sessionIds.join('|'),
    sessionIds,
    latestCompletedAt,
  };
}
