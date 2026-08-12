export type ClearCardRenderSize = {
  width: number;
  height: number;
};

export type ClearCardRenderQuality = {
  maxPixelRatio?: number;
  transmissionResolutionScale?: number;
};

export type ClearCardRenderQualityByStage = Record<
  'pack' | 'breaking' | 'revealed',
  ClearCardRenderQuality
>;

export function resolveClearCardRevealRenderQuality(
  viewerOnly: boolean,
): ClearCardRenderQualityByStage | undefined {
  if (viewerOnly) return undefined;
  return {
    pack: {
      maxPixelRatio: 3,
      transmissionResolutionScale: 1,
    },
    breaking: {
      maxPixelRatio: 1.5,
      transmissionResolutionScale: 0.65,
    },
    revealed: {
      maxPixelRatio: 1.5,
      transmissionResolutionScale: 0.65,
    },
  };
}

export function resolveClearCardRenderSize(
  canvasWidth: number,
  canvasHeight: number,
  viewportWidth: number,
  viewportHeight: number,
): ClearCardRenderSize {
  const width = Math.max(1, canvasWidth);
  const height = Math.max(1, canvasHeight);
  const maxWidth = Math.max(1, viewportWidth);
  const maxHeight = Math.max(1, viewportHeight);
  const scale = Math.min(1, maxWidth / width, maxHeight / height);

  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}
