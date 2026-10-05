const MI_NOTE_STAR_FOLD_DEFAULT = 0.573;
const MI_NOTE_STAR_FOLD_MIN = 0.1;
const MI_NOTE_STAR_FOLD_MAX = 0.9;
const MI_NOTE_STAR_ROTATION_DEFAULT = 0;
const MI_NOTE_STAR_ROTATION_MIN = -15;
const MI_NOTE_STAR_ROTATION_MAX = 15;

export function normalizeMiNoteStarFoldPosition(value: number): number {
  if (!Number.isFinite(value)) return MI_NOTE_STAR_FOLD_DEFAULT;
  return Math.round(Math.min(MI_NOTE_STAR_FOLD_MAX, Math.max(MI_NOTE_STAR_FOLD_MIN, value)) * 1000) / 1000;
}

export function normalizeMiNoteStarRotationOffset(value: number): number {
  if (!Number.isFinite(value)) return MI_NOTE_STAR_ROTATION_DEFAULT;
  return Math.round(Math.min(MI_NOTE_STAR_ROTATION_MAX, Math.max(MI_NOTE_STAR_ROTATION_MIN, value)) * 10) / 10 || 0;
}
