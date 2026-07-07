import { getFrontendDrop, normalizeDropId, resolveDropAssetUrl } from '../config/deployment';
import { normalizeFigureDisplayImage } from './dropContent';

export type FigureMetadataAttributes = { trait_type: string; value: string };

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

const metadataByKey = new Map<string, FigureMetadataRecord>();
const pendingMetadataByKey = new Map<string, Promise<FigureMetadataRecord | null>>();

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
  return metadataByKey.get(figureMetadataCacheKey(dropId, figureId));
}

export function figureMetadataHasImage(
  record: FigureMetadataRecord | null | undefined,
): record is FigureMetadataRecord & { image: string } {
  return Boolean(record?.image && String(record.image).trim());
}

export async function loadFigureMetadata(dropId: string, figureId: number): Promise<FigureMetadataRecord | null> {
  const normalizedDropId = normalizeDropId(dropId);
  const normalizedFigureId = normalizePositiveInteger(figureId);
  if (!normalizedDropId || !normalizedFigureId) return null;

  const cacheKey = figureMetadataCacheKey(normalizedDropId, normalizedFigureId);
  const cached = metadataByKey.get(cacheKey);
  if (figureMetadataHasImage(cached)) return cached;
  if (cached) metadataByKey.delete(cacheKey);

  const pending = pendingMetadataByKey.get(cacheKey);
  if (pending) return pending;

  const drop = getFrontendDrop(normalizedDropId);
  if (!drop) return null;

  if (drop.dropFamily === 'card_nft_2') {
    const image = normalizeFigureDisplayImage(normalizedDropId, undefined, normalizedFigureId);
    if (image) {
      const record: FigureMetadataRecord = {
        id: normalizedFigureId,
        dropId: normalizedDropId,
        image,
      };
      metadataByKey.set(cacheKey, record);
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
    metadataByKey.set(cacheKey, record);
    return record;
  })()
    .finally(() => {
      pendingMetadataByKey.delete(cacheKey);
    });

  pendingMetadataByKey.set(cacheKey, metadataPromise);
  return metadataPromise;
}

export async function loadFigureMetadataBatch(targets: FigureMetadataTarget[]): Promise<FigureMetadataRecord[]> {
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
