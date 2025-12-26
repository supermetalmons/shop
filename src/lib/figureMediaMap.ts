const FIGURE_MEDIA_COUNT = 333;
const FIGURE_ID_MAX = 999;

// Overrides go here when specific figure ids need custom media ids.
export const FIGURE_MEDIA_OVERRIDES: Record<number, number> = {};

export function getMediaIdForFigureId(figureId: number): number | null {
  if (!Number.isFinite(figureId) || figureId <= 0) return null;
  if (figureId > FIGURE_ID_MAX) return null;
  const override = FIGURE_MEDIA_OVERRIDES[figureId];
  if (Number.isFinite(override) && override > 0) return override;
  return ((figureId - 1) % FIGURE_MEDIA_COUNT) + 1;
}
