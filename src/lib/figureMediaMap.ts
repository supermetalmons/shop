import type { FigureMediaConfig } from '../config/deployment.ts';
import { getMediaIdForTokenId } from './mediaMap.ts';

export function getMediaIdForFigureId(figureId: number, figureMedia?: FigureMediaConfig): number | null {
  return getMediaIdForTokenId(figureId, figureMedia);
}
