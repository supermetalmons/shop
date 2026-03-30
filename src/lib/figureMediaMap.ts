import type { FigureMediaConfig } from '../config/deployment';

function normalizePositiveInteger(value: unknown): number | null {
  const normalized = Math.floor(Number(value));
  if (!Number.isFinite(normalized) || normalized <= 0) return null;
  return normalized;
}

export function getMediaIdForFigureId(figureId: number, figureMedia?: FigureMediaConfig): number | null {
  const normalizedFigureId = normalizePositiveInteger(figureId);
  if (!normalizedFigureId) return null;

  const override = normalizePositiveInteger(figureMedia?.overrides?.[normalizedFigureId]);
  if (override) return override;

  if (figureMedia?.strategy === 'cyclic') {
    const count = normalizePositiveInteger(figureMedia.count);
    if (count) return ((normalizedFigureId - 1) % count) + 1;
  }

  return normalizedFigureId;
}
