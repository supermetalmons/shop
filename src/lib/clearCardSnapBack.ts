import { Quaternion, Vector3 } from 'three';

// Pure math only — imported by the lazy viewer chunk and node tests, so keep this
// file free of renderer/DOM dependencies.

const SNAP_BACK_STIFFNESS = 170;
const SNAP_BACK_DAMPING = 14;
export const SNAP_BACK_MAX_ANGULAR_SPEED = 15;
export const SNAP_BACK_FLING_STALE_MS = 90;
const SNAP_BACK_VELOCITY_SMOOTHING_MS = 50;
const SNAP_BACK_ANGLE_EPSILON = 0.0005;
const SNAP_BACK_SPEED_EPSILON = 0.01;

export type SnapBackState = {
  active: boolean;
  velocity: Vector3;
  lastSampleTimeMs: number;
  sampleVelocity: Vector3;
  axis: Vector3;
  stepQuaternion: Quaternion;
};

export function createSnapBackState(): SnapBackState {
  return {
    active: false,
    velocity: new Vector3(),
    lastSampleTimeMs: 0,
    sampleVelocity: new Vector3(),
    axis: new Vector3(),
    stepQuaternion: new Quaternion(),
  };
}

export function resetSnapBackTracking(state: SnapBackState, timeStampMs: number) {
  state.active = false;
  state.velocity.set(0, 0, 0);
  state.lastSampleTimeMs = timeStampMs;
}

export function trackSnapBackVelocity(
  state: SnapBackState,
  deltaX: number,
  deltaY: number,
  radiansPerPixel: number,
  timeStampMs: number,
) {
  const deltaMs = timeStampMs - state.lastSampleTimeMs;
  if (!(deltaMs > 0)) return;
  const invDeltaSeconds = 1_000 / deltaMs;
  state.sampleVelocity.set(
    deltaY * radiansPerPixel * invDeltaSeconds,
    deltaX * radiansPerPixel * invDeltaSeconds,
    0,
  );
  const alpha = 1 - Math.exp(-deltaMs / SNAP_BACK_VELOCITY_SMOOTHING_MS);
  state.velocity.lerp(state.sampleVelocity, alpha);
  state.lastSampleTimeMs = timeStampMs;
}

export function releaseSnapBack(state: SnapBackState, timeStampMs: number) {
  if (timeStampMs - state.lastSampleTimeMs > SNAP_BACK_FLING_STALE_MS) {
    state.velocity.set(0, 0, 0);
  } else {
    const speed = state.velocity.length();
    if (speed > SNAP_BACK_MAX_ANGULAR_SPEED) {
      state.velocity.multiplyScalar(SNAP_BACK_MAX_ANGULAR_SPEED / speed);
    }
  }
  state.active = true;
}

export function settleSnapBackInstantly(quaternion: Quaternion, state: SnapBackState) {
  quaternion.identity();
  state.active = false;
  state.velocity.set(0, 0, 0);
}

export function stepSnapBackSpring(
  quaternion: Quaternion,
  state: SnapBackState,
  deltaSeconds: number,
) {
  // q and -q encode the same rotation; keep w >= 0 so the log map below always
  // measures the short way home.
  if (quaternion.w < 0) {
    quaternion.set(-quaternion.x, -quaternion.y, -quaternion.z, -quaternion.w);
  }
  const sinHalfAngle = Math.sqrt(
    quaternion.x * quaternion.x + quaternion.y * quaternion.y + quaternion.z * quaternion.z,
  );
  const angle = 2 * Math.atan2(sinHalfAngle, quaternion.w);
  // angle/sinHalfAngle → 2 as angle → 0; avoids dividing by a vanishing sine.
  const scale = sinHalfAngle > 1e-8 ? angle / sinHalfAngle : 2;
  state.axis.set(quaternion.x * scale, quaternion.y * scale, quaternion.z * scale);

  const velocity = state.velocity;
  if (angle <= SNAP_BACK_ANGLE_EPSILON && velocity.length() <= SNAP_BACK_SPEED_EPSILON) {
    quaternion.identity();
    velocity.set(0, 0, 0);
    state.active = false;
    return;
  }

  velocity.x += (-SNAP_BACK_STIFFNESS * state.axis.x - SNAP_BACK_DAMPING * velocity.x) * deltaSeconds;
  velocity.y += (-SNAP_BACK_STIFFNESS * state.axis.y - SNAP_BACK_DAMPING * velocity.y) * deltaSeconds;
  velocity.z += (-SNAP_BACK_STIFFNESS * state.axis.z - SNAP_BACK_DAMPING * velocity.z) * deltaSeconds;

  const speed = velocity.length();
  if (speed > 1e-9) {
    state.axis.copy(velocity).divideScalar(speed);
    state.stepQuaternion.setFromAxisAngle(state.axis, speed * deltaSeconds);
    quaternion.premultiply(state.stepQuaternion).normalize();
  }
}
