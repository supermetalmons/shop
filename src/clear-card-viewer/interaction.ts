import * as THREE from 'three';
import {
  createSnapBackState,
  releaseSnapBack,
  resetSnapBackTracking,
  settleSnapBackInstantly,
  stepSnapBackSpring,
  trackSnapBackVelocity,
} from '../lib/clearCardSnapBack';
import {
  canStartClearCardPointerInteraction,
  isClearCardInteractionPoint,
  isClearCardImpactKey,
  isClearCardImpactPointer,
} from '../lib/clearCardReveal';
import { VIEWER_TAP_MAX_MOVEMENT_PX } from '../lib/miNoteCardInput';
import { SPRING_EPSILON, stepSpringAxis } from './motion';
import type { ClearCardDisplayStage, ClearCardThreeViewerProps, ClearCardViewMode } from './types';

const MAX_TILT_X = THREE.MathUtils.degToRad(25);
const MAX_TILT_Y = THREE.MathUtils.degToRad(14);
const SPRING_STIFFNESS = 60;
const SPRING_DAMPING = 11;
const UNRESTRICTED_ROTATION_SPEED = Math.PI / 300;
const KEYBOARD_ROTATION_STEP = THREE.MathUtils.degToRad(12);
const UNRESTRICTED_DRAG_THRESHOLD_SQ = VIEWER_TAP_MAX_MOVEMENT_PX ** 2;
const MAX_VERTICAL_ORBIT = THREE.MathUtils.degToRad(45);
const WORLD_UP = new THREE.Vector3(0, 1, 0);

type TiltState = {
  currentX: number;
  currentY: number;
  targetX: number;
  targetY: number;
  velocityX: number;
  velocityY: number;
};

type UnrestrictedRotationState = {
  quaternion: THREE.Quaternion;
  deltaQuaternion: THREE.Quaternion;
  deltaEuler: THREE.Euler;
  pointerId: number | null;
  startX: number;
  startY: number;
  lastX: number;
  lastY: number;
  dragged: boolean;
  lockedAxis: 'horizontal' | 'vertical' | null;
};

type ClearCardPointerInput = Pick<
  PointerEvent,
  'clientX' | 'clientY' | 'pointerId' | 'pointerType' | 'isPrimary' | 'button' | 'timeStamp' | 'preventDefault'
> & { currentTarget: HTMLCanvasElement };
type ClearCardKeyboardInput = Pick<
  KeyboardEvent,
  'defaultPrevented' | 'key' | 'repeat' | 'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey' |
  'timeStamp' | 'preventDefault' | 'stopPropagation'
>;
type ClearCardClickInput = Pick<
  MouseEvent,
  'defaultPrevented' | 'detail' | 'preventDefault' | 'stopPropagation'
>;
function resolveViewMode(
  unrestrictedMovement: boolean,
  axisLockedOrbit: boolean,
): ClearCardViewMode {
  if (axisLockedOrbit) return 'orbit';
  return unrestrictedMovement ? 'free' : 'tilt';
}

type InputOptions = Pick<ClearCardThreeViewerProps, 'snapBackOnRelease' | 'interactionEnabled'>;

type InteractionHost = {
  presentation: () => { ready: boolean; reducedMotion: boolean; stage: ClearCardDisplayStage };
  requestRender: () => void;
  beginInteraction: () => void;
  releaseInteraction: () => void;
  updateCameraView: () => void;
  applyAxisLockedOrbit: () => void;
  objectHitTest: (clientX: number, clientY: number) => boolean | undefined;
  triggerHit: (clientX?: number, clientY?: number) => void;
};

export function createClearCardInteraction(initialOptions: Pick<ClearCardThreeViewerProps,
  'unrestrictedMovement' | 'axisLockedOrbit' | 'snapBackOnRelease' | 'interactionEnabled'>, host: InteractionHost) {
  const { unrestrictedMovement, axisLockedOrbit, snapBackOnRelease = false, interactionEnabled = true } = initialOptions;
  let currentCanvas: HTMLCanvasElement | null = null;
  let currentAxisLockedOrbit = axisLockedOrbit;
  let currentSnapBackOnRelease = snapBackOnRelease;
  let currentInteractionEnabled = interactionEnabled;
  let currentViewMode = resolveViewMode(unrestrictedMovement, axisLockedOrbit);
  const currentTilt: TiltState = {
    currentX: 0,
    currentY: 0,
    targetX: 0,
    targetY: 0,
    velocityX: 0,
    velocityY: 0,
  };
  const currentUnrestrictedRotation: UnrestrictedRotationState = {
    quaternion: new THREE.Quaternion(),
    deltaQuaternion: new THREE.Quaternion(),
    deltaEuler: new THREE.Euler(),
    pointerId: null,
    startX: 0,
    startY: 0,
    lastX: 0,
    lastY: 0,
    dragged: false,
    lockedAxis: null,
  };
  const currentSnapBack = createSnapBackState();
  let currentSuppressNextCanvasClick = false;
  let currentOrbitYaw = 0;
  let currentOrbitElevation = 0;

  const clearTilt = () => {
    currentTilt.currentX = 0;
    currentTilt.currentY = 0;
    currentTilt.targetX = 0;
    currentTilt.targetY = 0;
    currentTilt.velocityX = 0;
    currentTilt.velocityY = 0;
  };

  const resetTilt = () => {
    currentTilt.targetX = 0;
    currentTilt.targetY = 0;
    host.requestRender();
  };

  const cancelUnrestrictedDrag = () => {
    const rotation = currentUnrestrictedRotation;
    const pointerId = rotation.pointerId;
    rotation.pointerId = null;
    rotation.dragged = false;
    rotation.lockedAxis = null;
    const canvas = currentCanvas;
    if (pointerId !== null && canvas?.hasPointerCapture(pointerId)) {
      canvas.releasePointerCapture(pointerId);
    }
  };

  const startSnapBack = (timeStampMs: number) => {
    if (!currentSnapBackOnRelease || currentViewMode !== 'free') return;
    releaseSnapBack(currentSnapBack, timeStampMs);
    host.requestRender();
  };

  const resetViewOrientation = () => {
    cancelUnrestrictedDrag();
    resetSnapBackTracking(currentSnapBack, 0);
    host.releaseInteraction();
    currentUnrestrictedRotation.quaternion.identity();
    currentOrbitYaw = 0;
    currentOrbitElevation = 0;
    clearTilt();
    host.updateCameraView();
    host.requestRender();
  };

  const getInteractionBounds = (canvas: HTMLCanvasElement, interactionBounds: ClearCardThreeViewerProps['interactionBounds']) =>
    interactionBounds === 'parent'
      ? canvas.parentElement?.getBoundingClientRect() ?? canvas.getBoundingClientRect()
      : canvas.getBoundingClientRect();

  const pointerIsWithinInteractionBounds = (event: ClearCardPointerInput, interactionBounds: ClearCardThreeViewerProps['interactionBounds']) =>
    isClearCardInteractionPoint(event, getInteractionBounds(event.currentTarget, interactionBounds));

  const updateTilt = (event: ClearCardPointerInput, interactionBounds: ClearCardThreeViewerProps['interactionBounds']) => {
    if (currentViewMode !== 'tilt') return;
    if (!host.presentation().ready || host.presentation().reducedMotion) return;
    if (!event.isPrimary) return;
    if (host.presentation().stage === 'breaking') return;
    const bounds = getInteractionBounds(event.currentTarget, interactionBounds);
    if (!bounds.width || !bounds.height) return;
    if (!isClearCardInteractionPoint(event, bounds)) {
      host.releaseInteraction();
      resetTilt();
      return;
    }
    host.beginInteraction();
    const pointerX = THREE.MathUtils.clamp((event.clientX - bounds.left) / bounds.width, 0, 1);
    const pointerY = THREE.MathUtils.clamp((event.clientY - bounds.top) / bounds.height, 0, 1);
    currentTilt.targetX = -(pointerY * 2 - 1) * MAX_TILT_X;
    currentTilt.targetY = -(pointerX * 2 - 1) * MAX_TILT_Y;
    host.requestRender();
  };

  const handlePointerMove = (event: ClearCardPointerInput, interactionBounds: ClearCardThreeViewerProps['interactionBounds']) => {
    if (currentViewMode === 'tilt') {
      updateTilt(event, interactionBounds);
      return;
    }
    const rotation = currentUnrestrictedRotation;
    if (rotation.pointerId !== event.pointerId) return;
    const deltaX = event.clientX - rotation.lastX;
    const deltaY = event.clientY - rotation.lastY;
    rotation.lastX = event.clientX;
    rotation.lastY = event.clientY;
    const totalX = event.clientX - rotation.startX;
    const totalY = event.clientY - rotation.startY;
    if (!rotation.dragged) {
      if (totalX * totalX + totalY * totalY <= UNRESTRICTED_DRAG_THRESHOLD_SQ) return;
      rotation.dragged = true;
      host.beginInteraction();
      if (currentViewMode === 'orbit') {
        rotation.lockedAxis =
          Math.abs(totalX) >= Math.abs(totalY) ? 'horizontal' : 'vertical';
      }
    }
    if (!deltaX && !deltaY) return;
    if (currentViewMode === 'orbit') {
      if (rotation.lockedAxis === 'horizontal') {
        currentOrbitYaw += deltaX * UNRESTRICTED_ROTATION_SPEED;
        rotation.quaternion.setFromAxisAngle(WORLD_UP, currentOrbitYaw);
      } else if (rotation.lockedAxis === 'vertical') {
        currentOrbitElevation = THREE.MathUtils.clamp(
          currentOrbitElevation + deltaY * UNRESTRICTED_ROTATION_SPEED,
          -MAX_VERTICAL_ORBIT,
          MAX_VERTICAL_ORBIT,
        );
      }
      host.updateCameraView();
    } else {
      rotation.deltaEuler.set(
        deltaY * UNRESTRICTED_ROTATION_SPEED,
        deltaX * UNRESTRICTED_ROTATION_SPEED,
        0,
      );
      rotation.deltaQuaternion.setFromEuler(rotation.deltaEuler);
      rotation.quaternion.premultiply(rotation.deltaQuaternion).normalize();
      if (currentSnapBackOnRelease) {
        trackSnapBackVelocity(
          currentSnapBack,
          deltaX,
          deltaY,
          UNRESTRICTED_ROTATION_SPEED,
          event.timeStamp,
        );
      }
    }
    host.requestRender();
  };

  const handleKeyDown = (event: ClearCardKeyboardInput, keyboardActivationEnabled: boolean, keyboardRotationEnabled: boolean) => {
    if (event.defaultPrevented) return;

    if (keyboardRotationEnabled) {
      const pitch =
        event.key === 'ArrowUp'
          ? -KEYBOARD_ROTATION_STEP
          : event.key === 'ArrowDown'
            ? KEYBOARD_ROTATION_STEP
            : 0;
      const yaw =
        event.key === 'ArrowLeft'
          ? -KEYBOARD_ROTATION_STEP
          : event.key === 'ArrowRight'
            ? KEYBOARD_ROTATION_STEP
            : 0;
      if (
        (pitch || yaw) &&
        host.presentation().ready &&
        currentInteractionEnabled &&
        host.presentation().stage !== 'breaking'
      ) {
        event.preventDefault();
        event.stopPropagation();
        const rotation = currentUnrestrictedRotation;
        resetSnapBackTracking(currentSnapBack, event.timeStamp);
        rotation.deltaEuler.set(pitch, yaw, 0);
        rotation.deltaQuaternion.setFromEuler(rotation.deltaEuler);
        rotation.quaternion.premultiply(rotation.deltaQuaternion).normalize();
        host.requestRender();
        return;
      }
    }

    if (!keyboardActivationEnabled || !isClearCardImpactKey(event)) return;
    event.preventDefault();
    event.stopPropagation();
    host.triggerHit();
  };

  const handleSyntheticClick = (event: ClearCardClickInput, keyboardActivationEnabled: boolean) => {
    if (currentSuppressNextCanvasClick) {
      currentSuppressNextCanvasClick = false;
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (event.defaultPrevented || !keyboardActivationEnabled || event.detail !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    host.triggerHit();
  };

  const handlePointerDown = (
    event: ClearCardPointerInput,
    pointerActivationEnabled: boolean,
    interactionBounds: ClearCardThreeViewerProps['interactionBounds'],
  ) => {
    currentSuppressNextCanvasClick = false;
    const withinBounds = pointerIsWithinInteractionBounds(event, interactionBounds);
    if (
      !canStartClearCardPointerInteraction({
        withinBounds,
        objectHit: withinBounds
          ? undefined
          : host.objectHitTest(event.clientX, event.clientY),
      })
    ) {
      return;
    }
    if (currentViewMode !== 'tilt') {
      if (!host.presentation().ready || host.presentation().stage === 'breaking') return;
      if (!isClearCardImpactPointer(event)) return;
      const rotation = currentUnrestrictedRotation;
      if (rotation.pointerId !== null) return;
      rotation.pointerId = event.pointerId;
      rotation.startX = event.clientX;
      rotation.startY = event.clientY;
      rotation.lastX = event.clientX;
      rotation.lastY = event.clientY;
      rotation.dragged = false;
      rotation.lockedAxis = null;
      resetSnapBackTracking(currentSnapBack, event.timeStamp);
      event.currentTarget.setPointerCapture(event.pointerId);
      event.preventDefault();
      return;
    }
    if (
      pointerActivationEnabled &&
      host.presentation().stage === 'pack' &&
      isClearCardImpactPointer(event)
    ) {
      host.triggerHit(event.clientX, event.clientY);
    }
    updateTilt(event, interactionBounds);
  };

  const handlePointerUp = (event: ClearCardPointerInput, pointerActivationEnabled: boolean) => {
    if (currentViewMode !== 'tilt') {
      const rotation = currentUnrestrictedRotation;
      if (rotation.pointerId !== event.pointerId) return;
      const totalX = event.clientX - rotation.startX;
      const totalY = event.clientY - rotation.startY;
      const dragged =
        rotation.dragged ||
        totalX * totalX + totalY * totalY > UNRESTRICTED_DRAG_THRESHOLD_SQ;
      currentSuppressNextCanvasClick = dragged;
      rotation.pointerId = null;
      rotation.dragged = false;
      rotation.lockedAxis = null;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      startSnapBack(event.timeStamp);
      host.releaseInteraction();
      if (pointerActivationEnabled && !dragged && host.presentation().stage === 'pack') {
        host.triggerHit(event.clientX, event.clientY);
      }
      return;
    }
    if (event.pointerType === 'mouse') return;
    host.releaseInteraction();
    resetTilt();
  };

  const handlePointerLeave = () => {
    if (currentViewMode === 'tilt') {
      host.releaseInteraction();
      resetTilt();
    }
  };

  const handlePointerCancel = (event: ClearCardPointerInput) => {
    if (currentViewMode !== 'tilt') {
      const hadActiveDrag = currentUnrestrictedRotation.pointerId !== null;
      cancelUnrestrictedDrag();
      if (hadActiveDrag) startSnapBack(event.timeStamp);
      host.releaseInteraction();
    } else {
      host.releaseInteraction();
      resetTilt();
    }
  };

  const handleLostPointerCapture = (event: ClearCardPointerInput) => {
    if (currentUnrestrictedRotation.pointerId === event.pointerId) {
      currentUnrestrictedRotation.pointerId = null;
      currentUnrestrictedRotation.dragged = false;
      currentUnrestrictedRotation.lockedAxis = null;
      startSnapBack(event.timeStamp);
      host.releaseInteraction();
    }
  };

  const updateViewMode = (unrestrictedMovement: boolean, axisLockedOrbit: boolean) => {
    const previousMode = currentViewMode;
    currentAxisLockedOrbit = axisLockedOrbit;
    const nextMode = resolveViewMode(unrestrictedMovement, axisLockedOrbit);
    host.applyAxisLockedOrbit();
    if (previousMode === nextMode) return;

    cancelUnrestrictedDrag();
    resetSnapBackTracking(currentSnapBack, 0);
    host.releaseInteraction();
    const rotation = currentUnrestrictedRotation;
    const tilt = currentTilt;
    if (nextMode === 'orbit') {
      if (previousMode === 'free') {
        const forward = new THREE.Vector3(0, 0, 1).applyQuaternion(rotation.quaternion);
        currentOrbitYaw = Math.atan2(forward.x, forward.z);
      } else if (previousMode === 'tilt') {
        currentOrbitYaw = tilt.currentY;
      }
      rotation.quaternion.setFromAxisAngle(WORLD_UP, currentOrbitYaw);
    } else if (nextMode === 'free' && previousMode === 'tilt') {
      rotation.deltaEuler.set(tilt.currentX, tilt.currentY, 0);
      rotation.quaternion.setFromEuler(rotation.deltaEuler);
    } else if (nextMode === 'tilt') {
      rotation.quaternion.identity();
      currentOrbitYaw = 0;
    }
    if (nextMode !== 'orbit') {
      currentOrbitElevation = 0;
    }

    clearTilt();
    currentViewMode = nextMode;
    host.updateCameraView();
    host.requestRender();
  };

  const handleWindowBlur = () => {
    const hadActiveDrag = currentUnrestrictedRotation.pointerId !== null;
    cancelUnrestrictedDrag();
    if (hadActiveDrag) startSnapBack(performance.now());
    host.releaseInteraction();
    if (currentViewMode === 'tilt') {
      resetTilt();
    }
  };

  return {
    get viewMode() { return currentViewMode; },
    get axisLockedOrbit() { return currentAxisLockedOrbit; },
    get orbitYaw() { return currentOrbitYaw; },
    get orbitElevation() { return currentOrbitElevation; },
    get snapBackActive() { return currentSnapBack.active; },
    setCanvas(canvas: HTMLCanvasElement | null) { currentCanvas = canvas; },
    setInputOptions({ snapBackOnRelease = false, interactionEnabled = true }: InputOptions) {
      currentSnapBackOnRelease = snapBackOnRelease;
      currentInteractionEnabled = interactionEnabled;
    },
    updateViewMode,
    cancelDrag: cancelUnrestrictedDrag,
    resetViewOrientation,
    resetTilt,
    clearTilt,
    addTiltImpulse(x: number, y: number) {
      currentTilt.velocityX += x;
      currentTilt.velocityY += y;
    },
    stepTilt(deltaSeconds: number) {
      const tilt = currentTilt;
      const rotationInteractionActive = currentViewMode !== 'tilt';
      if (host.presentation().reducedMotion) {
        clearTilt();
      } else if (!rotationInteractionActive) {
        const nextX = stepSpringAxis(
          tilt.currentX,
          tilt.targetX,
          tilt.velocityX,
          deltaSeconds,
          SPRING_STIFFNESS,
          SPRING_DAMPING,
        );
        const nextY = stepSpringAxis(
          tilt.currentY,
          tilt.targetY,
          tilt.velocityY,
          deltaSeconds,
          SPRING_STIFFNESS,
          SPRING_DAMPING,
        );
        tilt.currentX = nextX.current;
        tilt.currentY = nextY.current;
        tilt.velocityX = nextX.velocity;
        tilt.velocityY = nextY.velocity;
      } else {
        clearTilt();
      }
      return rotationInteractionActive;
    },
    stepSnapBack(deltaSeconds: number) {
      const snapBack = currentSnapBack;
      if (snapBack.active) {
        const rotationState = currentUnrestrictedRotation;
        if (rotationState.pointerId !== null) {
          snapBack.active = false;
        } else if (host.presentation().reducedMotion) {
          settleSnapBackInstantly(rotationState.quaternion, snapBack);
        } else {
          stepSnapBackSpring(rotationState.quaternion, snapBack, deltaSeconds);
        }
      }
    },
    applyOrientation(pivot: THREE.Object3D, rotationInteractionActive: boolean) {
      if (rotationInteractionActive) pivot.quaternion.copy(currentUnrestrictedRotation.quaternion);
      else pivot.rotation.set(currentTilt.currentX, currentTilt.currentY, 0);
    },
    isUnsettled(rotationInteractionActive: boolean) {
      const tilt = currentTilt;
      const tiltUnsettled =
        !rotationInteractionActive &&
        (Math.abs(tilt.targetX - tilt.currentX) > SPRING_EPSILON ||
          Math.abs(tilt.targetY - tilt.currentY) > SPRING_EPSILON ||
          Math.abs(tilt.velocityX) > SPRING_EPSILON ||
          Math.abs(tilt.velocityY) > SPRING_EPSILON);
      return tiltUnsettled || currentSnapBack.active;
    },
    settleTilt() {
      currentTilt.currentX = currentTilt.targetX;
      currentTilt.currentY = currentTilt.targetY;
      currentTilt.velocityX = 0;
      currentTilt.velocityY = 0;
    },
    handleKeyDown,
    handleSyntheticClick,
    handlePointerMove,
    handlePointerDown,
    handlePointerUp,
    handlePointerLeave,
    handlePointerCancel,
    handleLostPointerCapture,
    handleWindowBlur,
  };
}
