import type { FigureMediaConfig } from '../config/deployment';
import { getMediaIdForTokenId } from './mediaMap';

export function getMediaIdForFigureId(figureId: number, figureMedia?: FigureMediaConfig): number | null {
  return getMediaIdForTokenId(figureId, figureMedia);
}
