import { MI_NOTE_PACK_STARS } from './miNotePackStars';

export const MI_NOTE_STAR_FOLD_DEFAULT = 0.573;
export const MI_NOTE_STAR_FOLD_MIN = 0.1;
export const MI_NOTE_STAR_FOLD_MAX = 0.9;
export const MI_NOTE_STAR_FOLD_STEP = 0.001;
export const MI_NOTE_STAR_ROTATION_DEFAULT = 0;
export const MI_NOTE_STAR_ROTATION_MIN = -15;
export const MI_NOTE_STAR_ROTATION_MAX = 15;
export const MI_NOTE_STAR_ROTATION_STEP = 0.1;
export const MI_NOTE_STAR_FOLDS_STORAGE_KEY = 'mi-note-star-folds:v1';

export type MiNoteStarFoldPositions = Readonly<Record<string, number>>;
export type MiNoteStarRotationOffsets = Readonly<Record<string, number>>;

export function isMiNoteStarTunable(id: string): boolean {
  return id === 'twinkle' || id === 'zombie';
}

export function normalizeMiNoteStarFoldPosition(value: number): number {
  if (!Number.isFinite(value)) return MI_NOTE_STAR_FOLD_DEFAULT;
  return Math.round(Math.min(MI_NOTE_STAR_FOLD_MAX, Math.max(MI_NOTE_STAR_FOLD_MIN, value)) * 1000) / 1000;
}

export function normalizeMiNoteStarRotationOffset(value: number): number {
  if (!Number.isFinite(value)) return MI_NOTE_STAR_ROTATION_DEFAULT;
  return Math.round(Math.min(MI_NOTE_STAR_ROTATION_MAX, Math.max(MI_NOTE_STAR_ROTATION_MIN, value)) * 10) / 10 || 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseSavedValues(serialized: string | null, key: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(serialized ?? 'null');
    if (isRecord(parsed) && parsed.version === 1 && isRecord(parsed[key])) return parsed[key];
  } catch {}
  return {};
}

export function parseMiNoteStarFolds(serialized: string | null): MiNoteStarFoldPositions {
  const values = parseSavedValues(serialized, 'foldPositions');
  return Object.fromEntries(MI_NOTE_PACK_STARS.map(({ id, foldPosition }) => {
    const value = values[id];
    return [id, isMiNoteStarTunable(id) && typeof value === 'number' && Number.isFinite(value)
      && value >= MI_NOTE_STAR_FOLD_MIN && value <= MI_NOTE_STAR_FOLD_MAX
      ? normalizeMiNoteStarFoldPosition(value)
      : foldPosition];
  }));
}

export function parseMiNoteStarRotationOffsets(serialized: string | null): MiNoteStarRotationOffsets {
  const values = parseSavedValues(serialized, 'rotationOffsetsDegrees');
  return Object.fromEntries(MI_NOTE_PACK_STARS.map(({ id, rotationOffsetDegrees }) => {
    const value = values[id];
    return [id, isMiNoteStarTunable(id) && typeof value === 'number' && Number.isFinite(value)
      && value >= MI_NOTE_STAR_ROTATION_MIN && value <= MI_NOTE_STAR_ROTATION_MAX
      ? normalizeMiNoteStarRotationOffset(value)
      : rotationOffsetDegrees];
  }));
}

export function serializeMiNoteStarFolds(
  positions: MiNoteStarFoldPositions,
  rotations: MiNoteStarRotationOffsets = {},
): string {
  const foldPositions = Object.fromEntries(MI_NOTE_PACK_STARS.map(({ id, foldPosition }) => [
    id,
    isMiNoteStarTunable(id) && Number.isFinite(positions[id])
      ? normalizeMiNoteStarFoldPosition(positions[id])
      : foldPosition,
  ]));
  const rotationOffsetsDegrees = Object.fromEntries(MI_NOTE_PACK_STARS.map(({ id, rotationOffsetDegrees }) => [
    id,
    isMiNoteStarTunable(id) && Number.isFinite(rotations[id])
      ? normalizeMiNoteStarRotationOffset(rotations[id])
      : rotationOffsetDegrees,
  ]));
  return JSON.stringify({ version: 1, foldPositions, rotationOffsetsDegrees }, null, 2);
}
