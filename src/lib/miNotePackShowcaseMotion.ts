export const MI_NOTE_PACK_SHOWCASE_ORDER = [1, 5, 9, 4, 8, 3, 7, 2, 6] as const;
export const MI_NOTE_PACK_SHOWCASE_CYCLE_SECONDS = 2.65;

const HOLD_SECONDS = 0.45;
const TURN_SECONDS = MI_NOTE_PACK_SHOWCASE_CYCLE_SECONDS - HOLD_SECONDS;
const TAU = Math.PI * 2;
const DEFAULT_ROTATION_Y = -0.12;

function turnProgress(value: number): number {
  const progress = Math.min(1, Math.max(0, value));
  return Math.min(1, Math.max(0, progress ** 3 * (20 + progress * (-45 + progress * (36 - 10 * progress)))));
}

function motionEnvelope(value: number): number {
  const wave = value * (1 - value);
  return 64 * wave * wave * wave;
}

export function sampleMiNotePackShowcase(elapsedSeconds: number, baseRotationY = DEFAULT_ROTATION_Y) {
  const time = Number.isFinite(elapsedSeconds) ? Math.max(0, elapsedSeconds) : 0;
  const cycles = time / MI_NOTE_PACK_SHOWCASE_CYCLE_SECONDS;
  const cycleIndex = Math.floor(cycles);
  const elapsed = (cycles - cycleIndex) * MI_NOTE_PACK_SHOWCASE_CYCLE_SECONDS;
  const index = cycleIndex % MI_NOTE_PACK_SHOWCASE_ORDER.length;
  const outgoingPackId = MI_NOTE_PACK_SHOWCASE_ORDER[index];
  const nextPackId = MI_NOTE_PACK_SHOWCASE_ORDER[(index + 1) % MI_NOTE_PACK_SHOWCASE_ORDER.length];

  if (elapsed < HOLD_SECONDS) {
    const progress = elapsed / HOLD_SECONDS;
    const envelope = motionEnvelope(progress);
    const sway = Math.sin(TAU * progress);
    return {
      packId: outgoingPackId,
      nextPackId,
      rotationX: 0.022 * envelope,
      rotationY: 0,
      rotationZ: 0.012 * envelope * sway,
      offsetY: 0.012 * envelope,
      scale: 1,
    };
  }

  const progress = (elapsed - HOLD_SECONDS) / TURN_SECONDS;
  const turn = turnProgress(progress);
  const envelope = motionEnvelope(turn);
  const baseYaw = Number.isFinite(baseRotationY) ? baseRotationY % TAU : DEFAULT_ROTATION_Y;
  const returnEdge = ((Math.PI * 1.5 + baseYaw) % TAU + TAU) % TAU / TAU;

  return {
    packId: turn < returnEdge ? outgoingPackId : nextPackId,
    nextPackId,
    rotationX: 0.065 * envelope * Math.sin(TAU * turn + Math.PI / 5),
    rotationY: -TAU * turn,
    rotationZ: 0.033 * envelope * Math.sin(Math.PI * turn),
    offsetY: 0.028 * envelope,
    scale: (1 - 0.18 * Math.sin(TAU * turn) ** 2) * (1 - 0.025 * envelope),
  };
}
