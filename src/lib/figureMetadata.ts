import { getFrontendDrop, normalizeDropId, resolveDropAssetUrl } from '../config/deployment';
import { normalizeFigureDisplayImage } from './dropContent';

type FigureMetadataAttributes = { trait_type: string; value: string };

export type FigureMetadataRecord = {
  id: number;
  dropId: string;
  name?: string;
  image?: string;
  attributes?: FigureMetadataAttributes[];
};

export type FigureMetadataTarget = {
  dropId: string;
  figureId: number;
};

type FigureMetadataResponse = {
  name?: string;
  image?: string;
  attributes?: FigureMetadataAttributes[];
  properties?: {
    files?: Array<{ uri?: string; cdn_uri?: string }>;
  };
};

const FIGURE_METADATA_RETRY_MS = 3000;
let metadataByKey: Record<string, FigureMetadataRecord> = {};
let pendingMetadataUpdates: Record<string, FigureMetadataRecord> | null = null;
const pendingMetadataByKey = new Map<string, Promise<FigureMetadataRecord | null>>();
const metadataListeners = new Set<() => void>();
const retainedMetadataTargets = new Map<string, { target: FigureMetadataTarget; count: number; retryAt: number | null }>();
let metadataRetryTimer: ReturnType<typeof setTimeout> | undefined;
let metadataRetryScheduled = false;

function normalizePositiveInteger(value: unknown): number | null {
  const normalized = Math.floor(Number(value));
  if (!Number.isFinite(normalized) || normalized <= 0) return null;
  return normalized;
}

export function figureMetadataCacheKey(dropId: string, figureId: number): string {
  const normalizedDropId = normalizeDropId(dropId);
  const normalizedFigureId = normalizePositiveInteger(figureId);
  return normalizedFigureId ? `${normalizedDropId}:${normalizedFigureId}` : normalizedDropId;
}

export function parseFigureMetadataCacheKey(key: string): FigureMetadataTarget | null {
  const raw = String(key || '');
  const sepIdx = raw.lastIndexOf(':');
  if (sepIdx <= 0 || sepIdx >= raw.length - 1) return null;
  const dropId = normalizeDropId(raw.slice(0, sepIdx));
  const figureId = normalizePositiveInteger(raw.slice(sepIdx + 1));
  if (!dropId || !figureId) return null;
  return { dropId, figureId };
}

export function getCachedFigureMetadata(dropId: string, figureId: number): FigureMetadataRecord | undefined {
  const key = figureMetadataCacheKey(dropId, figureId);
  return pendingMetadataUpdates?.[key] ?? metadataByKey[key];
}

export function getFigureMetadataSnapshot(): Record<string, FigureMetadataRecord> {
  return metadataByKey;
}

export function subscribeFigureMetadata(listener: () => void): () => void {
  metadataListeners.add(listener);
  return () => { metadataListeners.delete(listener); };
}

function publishFigureMetadata(cacheKey: string, record: FigureMetadataRecord) {
  const existing = pendingMetadataUpdates?.[cacheKey] ?? metadataByKey[cacheKey];
  if (existing?.image === record.image && existing?.name === record.name && existing?.attributes === record.attributes) return;
  if (!pendingMetadataUpdates) {
    pendingMetadataUpdates = {};
    queueMicrotask(() => {
      metadataByKey = { ...metadataByKey, ...pendingMetadataUpdates };
      pendingMetadataUpdates = null;
      metadataListeners.forEach((listener) => listener());
    });
  }
  pendingMetadataUpdates[cacheKey] = record;
  const retained = retainedMetadataTargets.get(cacheKey);
  if (retained) retained.retryAt = null;
}

function loadRetainedFigureMetadata(cacheKey: string, target: FigureMetadataTarget) {
  if (figureMetadataHasImage(getCachedFigureMetadata(target.dropId, target.figureId)) || pendingMetadataByKey.has(cacheKey)) return;
  void loadFigureMetadata(target.dropId, target.figureId).catch((error) => {
    console.warn('[mons] failed to load figure metadata', { ...target, error });
  });
}

function scheduleMetadataRetry() {
  if (retainedMetadataTargets.size === 0) {
    if (metadataRetryTimer !== undefined) clearTimeout(metadataRetryTimer);
    metadataRetryTimer = undefined;
    return;
  }
  if (metadataRetryScheduled) return;
  metadataRetryScheduled = true;
  queueMicrotask(() => {
    metadataRetryScheduled = false;
    updateMetadataRetryTimer();
  });
}

function updateMetadataRetryTimer() {
  if (metadataRetryTimer !== undefined) clearTimeout(metadataRetryTimer);
  metadataRetryTimer = undefined;
  let nextRetryAt: number | undefined;
  for (const [key, entry] of retainedMetadataTargets) {
    if (entry.retryAt === null || pendingMetadataByKey.has(key) || figureMetadataHasImage(metadataByKey[key])) continue;
    nextRetryAt = Math.min(nextRetryAt ?? entry.retryAt, entry.retryAt);
  }
  if (nextRetryAt === undefined) return;
  metadataRetryTimer = setTimeout(() => {
    metadataRetryTimer = undefined;
    const now = Date.now();
    for (const [key, entry] of retainedMetadataTargets) {
      if (entry.retryAt !== null && entry.retryAt <= now) loadRetainedFigureMetadata(key, entry.target);
    }
    scheduleMetadataRetry();
  }, Math.max(0, nextRetryAt - Date.now()));
}

export function retainFigureMetadataTargets(targets: readonly FigureMetadataTarget[]): () => void {
  const keys = new Set<string>();
  for (const target of targets) {
    const dropId = normalizeDropId(target.dropId);
    const figureId = normalizePositiveInteger(target.figureId);
    if (!dropId || !figureId || !getFrontendDrop(dropId)) continue;
    const key = figureMetadataCacheKey(dropId, figureId);
    if (keys.has(key)) continue;
    keys.add(key);
    const existing = retainedMetadataTargets.get(key);
    if (existing) existing.count += 1;
    else retainedMetadataTargets.set(key, { target: { dropId, figureId }, count: 1, retryAt: null });
  }
  for (const key of keys) {
    const entry = retainedMetadataTargets.get(key)!;
    if (entry.retryAt === null || entry.retryAt <= Date.now()) loadRetainedFigureMetadata(key, entry.target);
  }
  scheduleMetadataRetry();
  return () => {
    for (const key of keys) {
      const entry = retainedMetadataTargets.get(key);
      if (entry && --entry.count === 0) retainedMetadataTargets.delete(key);
    }
    keys.clear();
    scheduleMetadataRetry();
  };
}

export function figureMetadataHasImage(
  record: FigureMetadataRecord | null | undefined,
): record is FigureMetadataRecord & { image: string } {
  return Boolean(record?.image && String(record.image).trim());
}

function canResolveFigureMetadataImageDirectly(
  drop: NonNullable<ReturnType<typeof getFrontendDrop>>,
  figureId: number,
): boolean {
  if (drop.dropFamily === 'card_nft_2') return true;
  if (drop.dropFamily !== 'little_swag_boxes' && drop.dropFamily !== 'clear_cards') return false;

  const maxFigureId = Math.floor(Number(drop.maxSupply)) * Math.floor(Number(drop.itemsPerBox));
  return Number.isFinite(maxFigureId) && maxFigureId > 0 && figureId <= maxFigureId;
}

export async function loadFigureMetadata(dropId: string, figureId: number): Promise<FigureMetadataRecord | null> {
  const normalizedDropId = normalizeDropId(dropId);
  const normalizedFigureId = normalizePositiveInteger(figureId);
  if (!normalizedDropId || !normalizedFigureId) return null;

  const cacheKey = figureMetadataCacheKey(normalizedDropId, normalizedFigureId);
  const cached = getCachedFigureMetadata(normalizedDropId, normalizedFigureId);
  if (figureMetadataHasImage(cached)) return cached;

  const pending = pendingMetadataByKey.get(cacheKey);
  if (pending) return pending;

  const drop = getFrontendDrop(normalizedDropId);
  if (!drop) return null;

  if (canResolveFigureMetadataImageDirectly(drop, normalizedFigureId)) {
    const image = normalizeFigureDisplayImage(normalizedDropId, undefined, normalizedFigureId);
    if (image) {
      const record: FigureMetadataRecord = {
        id: normalizedFigureId,
        dropId: normalizedDropId,
        image,
      };
      publishFigureMetadata(cacheKey, record);
      return record;
    }
  }

  const metadataPromise = (async () => {
    const metadataUrl = resolveDropAssetUrl(`${drop.paths.figuresJsonBase}${normalizedFigureId}.json`);
    if (!metadataUrl) {
      throw new Error(`metadata url missing for ${normalizedDropId}:${normalizedFigureId}`);
    }

    let data: FigureMetadataResponse | null = null;
    try {
      const resp = await fetch(metadataUrl);
      if (resp.ok) {
        data = (await resp.json()) as FigureMetadataResponse;
      }
    } catch {
      // fall through to the common error path below
    }
    if (!data) {
      throw new Error(`metadata fetch failed for ${normalizedDropId}:${normalizedFigureId}`);
    }
    const rawImage =
      (typeof data.image === 'string' ? data.image : undefined) ||
      (typeof data.properties?.files?.[0]?.uri === 'string' ? data.properties?.files?.[0]?.uri : undefined) ||
      (typeof data.properties?.files?.[0]?.cdn_uri === 'string' ? data.properties?.files?.[0]?.cdn_uri : undefined);
    const image = normalizeFigureDisplayImage(normalizedDropId, rawImage, normalizedFigureId);
    if (!image) {
      throw new Error(`metadata missing image for ${normalizedDropId}:${normalizedFigureId}`);
    }
    const record: FigureMetadataRecord = {
      id: normalizedFigureId,
      dropId: normalizedDropId,
      image,
      ...(typeof data.name === 'string' ? { name: data.name } : {}),
      ...(Array.isArray(data.attributes) ? { attributes: data.attributes } : {}),
    };
    publishFigureMetadata(cacheKey, record);
    return record;
  })()
    .catch((error) => {
      const retained = retainedMetadataTargets.get(cacheKey);
      if (retained) retained.retryAt = Date.now() + FIGURE_METADATA_RETRY_MS;
      throw error;
    })
    .finally(() => {
      pendingMetadataByKey.delete(cacheKey);
      scheduleMetadataRetry();
    });

  pendingMetadataByKey.set(cacheKey, metadataPromise);
  return metadataPromise;
}

export async function loadFigureMetadataBatch(targets: readonly FigureMetadataTarget[]): Promise<FigureMetadataRecord[]> {
  const uniqueTargets = Array.from(
    new Map(
      targets
        .map((target) => {
          const normalizedDropId = normalizeDropId(target.dropId);
          const normalizedFigureId = normalizePositiveInteger(target.figureId);
          if (!normalizedDropId || !normalizedFigureId) return null;
          return [figureMetadataCacheKey(normalizedDropId, normalizedFigureId), { dropId: normalizedDropId, figureId: normalizedFigureId }] as const;
        })
        .filter((entry): entry is readonly [string, FigureMetadataTarget] => Boolean(entry)),
    ).values(),
  );

  const settled = await Promise.allSettled(uniqueTargets.map((target) => loadFigureMetadata(target.dropId, target.figureId)));
  const records: FigureMetadataRecord[] = [];
  const failedKeys: string[] = [];
  settled.forEach((result, index) => {
    if (result.status === 'fulfilled') {
      if (result.value) records.push(result.value);
      return;
    }
    failedKeys.push(figureMetadataCacheKey(uniqueTargets[index].dropId, uniqueTargets[index].figureId));
  });
  if (failedKeys.length) {
    console.warn('[mons] failed to load some figure metadata records', { failedKeys });
  }
  return records;
}
