const FIGURE_MEDIA_COUNT = 333;
const FIGURE_ID_MAX = 999;

export const FIGURE_MEDIA_OVERRIDES: Record<number, number> = {
  344: 1,
  353: 90,
  360: 3,
  505: 163,
  650: 285,
  660: 13,
  661: 206,
  662: 82,
  663: 175,
  664: 19,
  665: 92,
  666: 86,
  677: 1,
  686: 90,
  693: 3,
  838: 163,
  983: 285,
  993: 49,
  994: 206,
  995: 21,
  996: 175,
  997: 19,
  998: 92,
  999: 86,
};

export function getMediaIdForFigureId(figureId: number): number | null {
  if (!Number.isFinite(figureId) || figureId <= 0) return null;
  if (figureId > FIGURE_ID_MAX) return null;
  const override = FIGURE_MEDIA_OVERRIDES[figureId];
  if (Number.isFinite(override) && override > 0) return override;
  return ((figureId - 1) % FIGURE_MEDIA_COUNT) + 1;
}
