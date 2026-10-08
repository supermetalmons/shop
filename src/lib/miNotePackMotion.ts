import * as THREE from 'three';
import { MI_NOTE_CARD_HEIGHT } from './miNotePackModel';

const MI_NOTE_CARD_LIFT_FRACTION = 0.4;
const LIP_CLEARANCE = 0.085;
const identity = new THREE.Quaternion();
const up = new THREE.Vector3();

export function createMiNoteCardPath(
  homePosition: THREE.Vector3,
  homeQuaternion: THREE.Quaternion,
  pocketTop: THREE.Vector3,
  destination: THREE.Vector3,
) {
  const path = {
    home: new THREE.Vector3(),
    homeRotation: new THREE.Quaternion(),
    lift: new THREE.Vector3(),
    curve: new THREE.CubicBezierCurve3(),
  };
  updateMiNoteCardPath(path, homePosition, homeQuaternion, pocketTop, destination);
  return path;
}

export type MiNoteCardPath = ReturnType<typeof createMiNoteCardPath>;

export function updateMiNoteCardPath(
  path: MiNoteCardPath,
  homePosition: THREE.Vector3,
  homeQuaternion: THREE.Quaternion,
  pocketTop: THREE.Vector3,
  destination: THREE.Vector3,
) {
  path.home.copy(homePosition);
  path.homeRotation.copy(homeQuaternion).normalize();
  up.set(0, 1, 0).applyQuaternion(path.homeRotation);
  const liftDistance = Math.max(0, path.curve.v1.copy(pocketTop).sub(path.home).dot(up) + MI_NOTE_CARD_HEIGHT / 2 + LIP_CLEARANCE);
  path.lift.copy(path.home).addScaledVector(up, liftDistance);
  path.curve.v0.copy(path.lift);
  path.curve.v1.copy(path.lift).addScaledVector(up, liftDistance * (1 - MI_NOTE_CARD_LIFT_FRACTION) / (MI_NOTE_CARD_LIFT_FRACTION * 3));
  path.curve.v2.copy(destination);
  path.curve.v3.copy(destination);
}

export function poseMiNoteCardPath(anchor: THREE.Object3D, path: MiNoteCardPath, progress: number) {
  const value = THREE.MathUtils.clamp(progress, 0, 1);
  if (value < MI_NOTE_CARD_LIFT_FRACTION) {
    const u = value / MI_NOTE_CARD_LIFT_FRACTION;
    anchor.position.lerpVectors(path.home, path.lift, u);
    anchor.quaternion.copy(path.homeRotation);
    anchor.scale.setScalar(1);
    return;
  }
  const u = (value - MI_NOTE_CARD_LIFT_FRACTION) / (1 - MI_NOTE_CARD_LIFT_FRACTION);
  path.curve.getPoint(u, anchor.position);
  const turnProgress = THREE.MathUtils.clamp((u - 0.32) / 0.68, 0, 1);
  const turn = turnProgress * turnProgress * (3 - 2 * turnProgress);
  anchor.quaternion.slerpQuaternions(path.homeRotation, identity, turn);
  anchor.scale.setScalar(1 + 0.28 * turn);
}
