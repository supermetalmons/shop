import { useEffect, useRef, useSyncExternalStore } from 'react';
import {
  figureMetadataCacheKey,
  getFigureMetadataSnapshot,
  parseFigureMetadataCacheKey,
  retainFigureMetadataTargets,
  subscribeFigureMetadata,
  type FigureMetadataTarget,
} from '../lib/figureMetadata';

export function useFigureMetadataSnapshot() {
  return useSyncExternalStore(subscribeFigureMetadata, getFigureMetadataSnapshot, getFigureMetadataSnapshot);
}

export function useFigureMetadataTargets(targets: readonly FigureMetadataTarget[]) {
  const retained = useRef(new Map<string, () => void>());
  const targetKeys = JSON.stringify([...new Set(targets.map(({ dropId, figureId }) => figureMetadataCacheKey(dropId, figureId)))].sort());
  useEffect(() => {
    const keys = new Set<string>(JSON.parse(targetKeys));
    for (const [key, release] of retained.current) {
      if (keys.has(key)) continue;
      release();
      retained.current.delete(key);
    }
    for (const key of keys) {
      if (retained.current.has(key)) continue;
      const target = parseFigureMetadataCacheKey(key);
      if (target) retained.current.set(key, retainFigureMetadataTargets([target]));
    }
  }, [targetKeys]);
  useEffect(() => () => {
    retained.current.forEach((release) => release());
    retained.current.clear();
  }, []);
}
