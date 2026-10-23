import { MathUtils } from 'three';

export function stepMiNoteMotion(motion: { value: number; velocity: number }, target: number, frequency: number, dt: number, reduced: boolean) {
  if (motion.value === target && motion.velocity === 0) return false;
  const offset = motion.value - target;
  const impulse = motion.velocity + frequency * offset;
  const decay = Math.exp(-frequency * dt);
  motion.value = reduced ? target : target + (offset + impulse * dt) * decay;
  motion.velocity = reduced ? 0 : (motion.velocity - frequency * impulse * dt) * decay;
  if (Math.abs(motion.value - target) < 0.0001 && Math.abs(motion.velocity) < 0.0008) {
    motion.value = target;
    motion.velocity = 0;
  }
  return motion.value !== target || motion.velocity !== 0;
}

export function setMiNoteCardTiltTarget(target: { set(x: number, y: number): unknown }, x: number, y: number, dragging: boolean) {
  if (!dragging && (Math.abs(x) > 1 || Math.abs(y) > 1)) target.set(0, 0);
  else target.set(-MathUtils.clamp(y, -1, 1) * 0.24, -MathUtils.clamp(x, -1, 1) * 0.3);
}
