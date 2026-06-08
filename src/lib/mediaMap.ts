import type { MediaMapConfig } from '../config/deployment';

function normalizePositiveInteger(value: unknown): number | null {
  const normalized = Math.floor(Number(value));
  if (!Number.isFinite(normalized) || normalized <= 0) return null;
  return normalized;
}

export function getMediaIdForTokenId(tokenId: string | number | undefined, mediaMap?: MediaMapConfig): number | null {
  const normalizedTokenId = normalizePositiveInteger(tokenId);
  if (!normalizedTokenId) return null;

  const override = normalizePositiveInteger(mediaMap?.overrides?.[normalizedTokenId]);
  if (override) return override;

  if (mediaMap?.strategy === 'cyclic') {
    const count = normalizePositiveInteger(mediaMap.count);
    if (count) return ((normalizedTokenId - 1) % count) + 1;
  }

  return normalizedTokenId;
}
