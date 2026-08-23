export type SharedMediaMapConfig = {
  strategy?: 'direct' | 'cyclic';
  count?: number;
  overrides?: Record<number, number>;
};

export function normalizePositiveInteger(value: unknown): number | null {
  const normalized = Math.floor(Number(value));
  if (!Number.isFinite(normalized) || normalized <= 0) return null;
  return normalized;
}

export function normalizeMediaMapConfig(
  raw: unknown,
): SharedMediaMapConfig | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const config = raw as Record<string, unknown>;
  const strategy =
    config.strategy === 'cyclic'
      ? 'cyclic'
      : config.strategy === 'direct'
        ? 'direct'
        : undefined;
  const count = normalizePositiveInteger(config.count) ?? undefined;
  const overridesRaw =
    config.overrides &&
    typeof config.overrides === 'object' &&
    !Array.isArray(config.overrides)
      ? (config.overrides as Record<string, unknown>)
      : {};
  const overrideEntries = Object.entries(overridesRaw).flatMap(
    ([tokenIdRaw, mediaIdRaw]) => {
      const tokenId = normalizePositiveInteger(tokenIdRaw);
      const mediaId = normalizePositiveInteger(mediaIdRaw);
      return tokenId && mediaId ? ([[tokenId, mediaId]] as const) : [];
    },
  );
  const overrides = overrideEntries.length
    ? Object.fromEntries(overrideEntries)
    : undefined;
  if (!strategy && !count && !overrides) return undefined;
  return {
    ...(strategy ? { strategy } : {}),
    ...(count ? { count } : {}),
    ...(overrides ? { overrides } : {}),
  };
}

export function getMediaIdForTokenId(
  tokenId: string | number | undefined,
  mediaMap?: SharedMediaMapConfig,
): number | null {
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
