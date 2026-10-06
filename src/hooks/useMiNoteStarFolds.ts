import { useCallback, useRef, useState } from 'react';
import {
  MI_NOTE_STAR_FOLDS_STORAGE_KEY,
  MI_NOTE_STAR_VERTICAL_DEFAULT,
  isMiNoteStarTunable,
  normalizeMiNoteStarFoldPosition,
  normalizeMiNoteStarRotationOffset,
  normalizeMiNoteStarSizeScale,
  parseMiNoteStarFolds,
  parseMiNoteStarRotationOffsets,
  parseMiNoteStarSizeScales,
  serializeMiNoteStarFolds,
  type MiNoteStarFoldPositions,
  type MiNoteStarRotationOffsets,
  type MiNoteStarSizeScales,
} from '../lib/miNoteStarFolds';

type StarTuning = {
  foldPositions: MiNoteStarFoldPositions;
  rotationOffsetsDegrees: MiNoteStarRotationOffsets;
  sizeScales: MiNoteStarSizeScales;
};

function readStarFolds(): StarTuning & { storageError: boolean } {
  try {
    const serialized = window.localStorage.getItem(MI_NOTE_STAR_FOLDS_STORAGE_KEY);
    return {
      foldPositions: parseMiNoteStarFolds(serialized),
      rotationOffsetsDegrees: parseMiNoteStarRotationOffsets(serialized),
      sizeScales: parseMiNoteStarSizeScales(serialized),
      storageError: false,
    };
  } catch {
    return {
      foldPositions: parseMiNoteStarFolds(null),
      rotationOffsetsDegrees: parseMiNoteStarRotationOffsets(null),
      sizeScales: parseMiNoteStarSizeScales(null),
      storageError: true,
    };
  }
}

export function useMiNoteStarFolds() {
  const [state, setState] = useState(readStarFolds);
  const tuningRef = useRef<StarTuning>(state);

  const saveTuning = useCallback((tuning: StarTuning) => {
    tuningRef.current = tuning;
    let storageError = false;
    try {
      window.localStorage.setItem(
        MI_NOTE_STAR_FOLDS_STORAGE_KEY,
        serializeMiNoteStarFolds(tuning.foldPositions, tuning.rotationOffsetsDegrees, tuning.sizeScales),
      );
    } catch {
      storageError = true;
    }
    setState({ ...tuning, storageError });
  }, []);

  const setFoldPosition = useCallback((starId: string, value: number) => {
    const current = tuningRef.current;
    if (!isMiNoteStarTunable(starId) || !Object.hasOwn(current.foldPositions, starId)) return;
    const position = normalizeMiNoteStarFoldPosition(value);
    if (current.foldPositions[starId] === position) return;
    saveTuning({ ...current, foldPositions: { ...current.foldPositions, [starId]: position } });
  }, [saveTuning]);

  const setRotationOffset = useCallback((starId: string, value: number) => {
    const current = tuningRef.current;
    if (!isMiNoteStarTunable(starId) || !Object.hasOwn(current.rotationOffsetsDegrees, starId)) return;
    const rotation = normalizeMiNoteStarRotationOffset(value);
    if (current.rotationOffsetsDegrees[starId] === rotation) return;
    saveTuning({ ...current, rotationOffsetsDegrees: { ...current.rotationOffsetsDegrees, [starId]: rotation } });
  }, [saveTuning]);

  const setSizeScale = useCallback((starId: string, value: number) => {
    const current = tuningRef.current;
    if (!isMiNoteStarTunable(starId) || !Object.hasOwn(current.sizeScales, starId)) return;
    const sizeScale = normalizeMiNoteStarSizeScale(value);
    if (current.sizeScales[starId] === sizeScale) return;
    saveTuning({ ...current, sizeScales: { ...current.sizeScales, [starId]: sizeScale } });
  }, [saveTuning]);

  return { ...state, verticalPosition: MI_NOTE_STAR_VERTICAL_DEFAULT, setFoldPosition, setRotationOffset, setSizeScale };
}
