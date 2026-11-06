import * as THREE from 'three';
import { WAREHOUSE_BOUNDS, WAREHOUSE_CAMERA } from './warehouseModel';

export const WAREHOUSE_OPEN_DURATION_MS = 2800;
export const WAREHOUSE_REDUCED_DURATION_MS = 300;
export const WAREHOUSE_HIT_DURATION_MS = 540;
export const WAREHOUSE_HIT_CONTACT_MS = 220;
export const WAREHOUSE_CRITICAL_CONTACT_MS = 360;
export const WAREHOUSE_CRATE_RELEASE_MS = 1050;
export const WAREHOUSE_CRATE_TRAVEL_MS = 1500;
export const WAREHOUSE_CRATE_COUNT = 11;

export const clamp = (value: number) => Math.max(0, Math.min(1, value));
export const smooth = (value: number) => { const t = clamp(value); return t * t * (3 - 2 * t); };

export type WarehouseCratePose = {
  start: THREE.Vector3;
  target: THREE.Vector3;
  localTarget: THREE.Vector3;
  yaw: number;
  scale: number;
  startScale: number;
  baseYaw: number;
  support: number | null;
  releaseAtMs: number;
};

export function createWarehouseCrateLayout(bounds: THREE.Box3, count = WAREHOUSE_CRATE_COUNT): WarehouseCratePose[] {
  if (!Number.isInteger(count) || count < 1 || count > WAREHOUSE_CRATE_COUNT || bounds.isEmpty()) {
    throw new Error('Unable to arrange the warehouse crates.');
  }
  const size = bounds.getSize(new THREE.Vector3());
  const { width, height, depth } = WAREHOUSE_BOUNDS;
  const scale = Math.min((width - 0.6) / (size.x * 3.5), (depth - 0.6) / (size.z * 2.6), (height - 0.6) / (size.y * 3));
  const startScale = Math.min(scale, (width - 0.6) / (size.x * 4.2));
  const floor = -height / 2;
  const baseYaw = Math.atan2(WAREHOUSE_CAMERA.position[0] - WAREHOUSE_CAMERA.target[0], WAREHOUSE_CAMERA.position[2] - WAREHOUSE_CAMERA.target[2]) + Math.PI / 7;
  const positions = [
    [-1.9, -0.9, -0.12], [-0.62, -1.08, 0.08], [0.7, -0.94, -0.06], [2.02, -0.82, 0.13],
    [-1.98, 0.82, 0.1], [-0.65, 0.95, -0.09], [0.7, 0.9, 0.12], [2.03, 1.04, -0.1],
  ];
  const supports = [0, 2, 7];
  const axis = new THREE.Vector3(0, 1, 0);
  const poses: WarehouseCratePose[] = [];
  for (let index = 0; index < count; index++) {
    const support = index < 8 ? null : supports[index - 8];
    let start: THREE.Vector3;
    let localTarget: THREE.Vector3;
    let yaw: number;
    if (support === null) {
      const [x, z, rotation] = positions[index];
      start = new THREE.Vector3((index % 4 - 1.5) * size.x * startScale * 1.055,
        floor - bounds.min.y * startScale + 0.15, (index < 4 ? -0.75 : 0.75) * size.z * startScale);
      localTarget = new THREE.Vector3(x * size.x * scale, floor - bounds.min.y * scale, z * size.z * scale);
      yaw = baseYaw + rotation;
    } else {
      start = poses[support].start.clone();
      start.y += size.y * startScale;
      localTarget = poses[support].localTarget.clone();
      localTarget.y += size.y * scale;
      yaw = poses[support].yaw;
    }
    const target = localTarget.clone().applyAxisAngle(axis, baseYaw);
    poses.push({ start, target, localTarget, yaw, scale, startScale, baseYaw, support, releaseAtMs: WAREHOUSE_CRATE_RELEASE_MS });
  }
  return poses;
}

export function sampleWarehouseCrate(pose: WarehouseCratePose, index: number, elapsedMs: number,
  reducedMotion: boolean, target: THREE.Object3D) {
  const p = reducedMotion ? 1 : clamp((elapsedMs - pose.releaseAtMs) / WAREHOUSE_CRATE_TRAVEL_MS);
  if (p === 1) {
    target.position.copy(pose.target);
    target.rotation.set(0, pose.yaw, 0);
    target.scale.setScalar(pose.scale);
    target.updateMatrix();
    return;
  }
  const travel = smooth(Math.min(1, p / 0.8));
  target.position.lerpVectors(pose.start, pose.localTarget, travel);
  const cosine = Math.cos(pose.baseYaw * travel);
  const sine = Math.sin(pose.baseYaw * travel);
  const x = target.position.x;
  const z = target.position.z;
  target.position.x = x * cosine + z * sine;
  target.position.z = z * cosine - x * sine;
  const stack = pose.support ?? index;
  const lift = p < 0.8 ? Math.sin(p / 0.8 * Math.PI) * (1.8 + stack % 3 * 0.18)
    : p < 0.9 ? Math.sin((p - 0.8) / 0.1 * Math.PI) * 0.08 : 0;
  const upperLift = pose.support === null ? 0 : smooth(p / 0.15) * (1 - smooth((p - 0.9) / 0.1)) * 0.45;
  target.position.y += lift + upperLift;
  target.rotation.set(0, pose.yaw * travel, 0);
  target.scale.setScalar(THREE.MathUtils.lerp(pose.startScale, pose.scale, travel));
  target.updateMatrix();
}

export function warehouseFracture(elapsedMs: number) {
  return smooth((elapsedMs - WAREHOUSE_CRITICAL_CONTACT_MS) / 900);
}

export function warehouseRenderDensity(width: number, height: number, ratio: number) {
  return Math.min(Math.max(1, ratio || 1), 2, Math.sqrt(3_000_000 / Math.max(1, width * height)));
}
