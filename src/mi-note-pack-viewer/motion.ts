import * as THREE from 'three';
import { MI_NOTE_STAR_VERTICAL_DEFAULT } from '../lib/miNoteStarFolds';
import { MI_NOTE_CARD_HEIGHT, MI_NOTE_CARD_WIDTH, MI_NOTE_LEAF_WIDTH, MI_NOTE_POCKET_TOP, type createMiNotePackModel } from '../lib/miNotePackModel';
import { createMiNoteCardPath, poseMiNoteCardPath, updateMiNoteCardPath } from '../lib/miNotePackMotion';
import { INTERACTIVE_CARD_CLOSEUP_MAX_HEIGHT_RATIO, INTERACTIVE_CARD_CLOSEUP_MAX_WIDTH_RATIO } from '../lib/revealOverlayLayout';
import { setMiNoteCardTiltTarget, stepMiNoteMotion as spring } from '../lib/miNoteCardTilt';
import { MI_NOTE_OPEN_TAPS, type MiNoteFolderPose, type MiNoteRevealEvent } from '../lib/miNoteCardReveal';
import type { createMiNoteTapSparkles } from '../lib/miNoteTapSparkles';
import type { MiNotePackSound } from '../lib/miNotePackSounds';
import type { MiNoteCardAssets } from './cardAssets';
import type { MiNotePackViewerProps } from './types';

type Motion = { value: number; velocity: number };
type OuterFlip = Motion & { from: 0 | 2; to: 0 | 2; direction: number; target: number; dragging: boolean };
export type MiNoteMotionGesture = {
  folderDragging: boolean;
  cardDragging: boolean;
  cardTargetProgress: number;
  hoverEnabled: boolean;
};
const CARD_FRONT_CLEARANCE = 0.05;
const UNSEAL_TAP_DELAY_MS = 500;

export function createMiNotePackMotion({ host, model, assets, scene, camera, sparkles: tapSparkles,
  props, reducedMotion, playSound, invalidate }: {
  host: HTMLElement;
  model: ReturnType<typeof createMiNotePackModel>;
  assets: MiNoteCardAssets;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  sparkles: ReturnType<typeof createMiNoteTapSparkles>;
  props: () => MiNotePackViewerProps;
  reducedMotion: () => boolean;
  playSound: (sound: MiNotePackSound) => void;
  invalidate: () => void;
}) {
  let taps = props().state.taps;
  let sealTime = 0;
  let sealStarted = false;
  let sealStartedAt: number | null = null;
  let sealFinished = false;
  const idlePitch = { value: 0.055, phase: Math.PI / 2, amplitude: 0.055, openAmplitude: 0.004, openOffset: -0.012, frequency: 0.45 };
  const idleYaw = { value: -0.12, phase: -Math.PI / 2, amplitude: 0.12, openAmplitude: 0, openOffset: 0, frequency: 0.32 };
  const idleRoll = { value: -0.016, phase: -Math.PI / 2, amplitude: 0.016, openAmplitude: 0, openOffset: 0, frequency: 0.55 };
  const idleHeight = { value: 0, phase: 0, amplitude: 0.037, openAmplitude: 0.0185, openOffset: 0, frequency: 0.75 };
  const idleMotions = [idlePitch, idleYaw, idleRoll, idleHeight];
  const idleSpeed: Motion = { value: props().state.folderPose === 1 ? 0.65 : 1, velocity: 0 };
  const idleStrength: Motion = { value: 1, velocity: 0 };
  const fold: Motion = { value: props().state.folderPose, velocity: 0 };
  const recoil: Motion = { value: 0, velocity: 0 };
  const cameraMotion: Motion = { value: 0, velocity: 0 };
  const cameraFocusX: Motion = { value: 0, velocity: 0 };
  const cameraFocusY: Motion = { value: 0, velocity: 0 };
  const stickerFocus = new THREE.Vector3();
  const cardDestination = new THREE.Vector3();
  const cardHomePosition = new THREE.Vector3();
  const cardHomeQuaternion = new THREE.Quaternion();
  const cardPocketTop = new THREE.Vector3();
  let outerFlip: OuterFlip | null = null;
  let selected: 0 | 1 | null = null;
  let cardPath: ReturnType<typeof createMiNoteCardPath> | null = null;
  let cardProgress = 0;
  let cardMotionSoundStage: 'lifting' | 'returning' | null = null;
  let lastSealAngle = model.right.rotation.y + model.flipRoot.rotation.y;
  const tiltX: Motion = { value: 0, velocity: 0 };
  const tiltY: Motion = { value: 0, velocity: 0 };
  const tiltTarget = new THREE.Vector2();
  const packTiltX: Motion = { value: 0, velocity: 0 };
  const packTiltY: Motion = { value: 0, velocity: 0 };
  const packTiltTarget = new THREE.Vector2();
  let packHoverSettling = false;
  const dispatch = (event: MiNoteRevealEvent) => props().onEvent(event);

  const hitPack = (count: number) => {
    recoil.velocity += 1.6 + Math.min(count, MI_NOTE_OPEN_TAPS) * 0.65;
    playSound('folderTap');
  };
  const applyPackPose = () => {
    const closed = THREE.MathUtils.smoothstep(Math.abs(fold.value - 1), 0, 1);
    model.group.rotation.set(
      idlePitch.value + packTiltX.value,
      idleYaw.value + packTiltY.value,
      idleRoll.value + recoil.value * 0.08 * closed,
    );
    model.group.position.y = idleHeight.value;
    model.group.scale.setScalar(1 - recoil.value * 0.08 * closed);
  };

  return {
    get selectedCard() { return selected; },
    get cardProgress() { return cardProgress; },
    get folderPosition() { return fold.value; },
    get flipPosition() { return outerFlip?.value ?? null; },
    hitPack,
    isUnsealTapWindow: () => sealStartedAt === null
      ? props().state.stage === 'seal-peeling'
      : performance.now() - sealStartedAt < UNSEAL_TAP_DELAY_MS,
    clearSelection() {
      selected = null;
      cardPath = null;
      cardMotionSoundStage = null;
    },
    aimCard(x: number, y: number, dragging: boolean) { setMiNoteCardTiltTarget(tiltTarget, x, y, dragging); },
    clearCardTilt() { tiltTarget.set(0, 0); },
    setPackHover(pitch: number, yaw: number, settling: boolean) {
      packHoverSettling = settling;
      if (packTiltTarget.x === pitch && packTiltTarget.y === yaw) return false;
      packTiltTarget.set(pitch, yaw);
      return true;
    },
    resetTilt(settlePack: boolean) {
      packHoverSettling = settlePack;
      if (tiltTarget.lengthSq() === 0 && packTiltTarget.lengthSq() === 0) return false;
      tiltTarget.set(0, 0);
      packTiltTarget.set(0, 0);
      return true;
    },
    stopFolderMotion() { fold.velocity = 0; },
    setFolderPosition(position: number) { fold.value = position; },
    beginFlip(direction: number, dragging = false) {
      const from = Math.round(fold.value);
      if ((from !== 0 && from !== 2) || Math.abs(fold.value - from) > 0.015 || outerFlip) return;
      fold.value = from;
      fold.velocity = 0;
      outerFlip = { from, to: from === 0 ? 2 : 0, direction, value: 0, velocity: 0, target: 1, dragging };
      if (!dragging) {
        dispatch({ type: 'folder-pose', pose: outerFlip.to });
        invalidate();
      }
      invalidate();
    },
    resumeFlipDrag() {
      if (!outerFlip) return null;
      outerFlip.dragging = true;
      outerFlip.velocity = 0;
      return outerFlip.value;
    },
    moveFlip(start: number, deltaX: number, distance: number) {
      if (outerFlip) outerFlip.value = THREE.MathUtils.clamp(start + outerFlip.direction * deltaX / distance, 0, 1);
    },
    finishFlip(): MiNoteFolderPose | null {
      if (!outerFlip) return null;
      outerFlip.dragging = false;
      outerFlip.target = Math.round(outerFlip.value);
      outerFlip.velocity = 0;
      return outerFlip.target === 1 ? outerFlip.to : outerFlip.from;
    },
    step(now: number, dt: number, { width, height, pixelRatio }: { width: number; height: number; pixelRatio: number }, gesture: MiNoteMotionGesture) {
      let moving = false;
      const state = props().state;
      const cards = assets.cards;
      model.setSealFoldPosition(props().foldPosition);
      model.setSealRotationOffsetDegrees(props().rotationOffsetDegrees);
      model.setSealVerticalPosition(props().verticalPosition ?? MI_NOTE_STAR_VERTICAL_DEFAULT);
      model.setSealSizeScale(props().sizeScale ?? props().star.sizeScale);
      if (state.taps !== taps) {
        for (let count = taps + 1; count <= state.taps; count += 1) {
          hitPack(count);
        }
        taps = state.taps;
      }
      if (state.stage === 'seal-peeling' && !sealStarted) {
        sealStarted = true;
        sealStartedAt = now;
        model.startSealPeel();
        playSound('stickerUnseal');
      }
      if (outerFlip) {
        const flip = outerFlip;
        if (!flip.dragging) moving = spring(flip, flip.target, 13, dt, reducedMotion()) || moving;
        const swapped = flip.value >= 0.5;
        fold.value = swapped ? flip.to : flip.from;
        model.flipRoot.rotation.y = flip.direction * Math.PI * (flip.value - (swapped ? 1 : 0));
        if (!flip.dragging && flip.value === flip.target) {
          model.flipRoot.rotation.y = 0;
          outerFlip = null;
          moving = fold.value !== state.folderPose || moving;
        }
      } else if (!gesture.folderDragging) {
        moving = spring(fold, state.folderPose, 16, dt, reducedMotion()) || moving;
      }
      fold.value = THREE.MathUtils.clamp(fold.value, 0, 2);
      const canLiftCard = state.cardStage === 'lifting' && state.selectedCard !== null && selected === null
        && Boolean(cards[state.selectedCard]) && !outerFlip && !gesture.folderDragging && Math.abs(fold.value - 1) < 0.015;
      if (canLiftCard) {
        fold.value = 1;
        fold.velocity = 0;
      }
      model.setFolderPhase(fold.value);
      if (reducedMotion() || state.selectedCard !== null) {
        recoil.value = recoil.velocity = 0;
      } else {
        for (let remaining = dt; remaining > 0; remaining -= 1 / 120) {
          const step = Math.min(remaining, 1 / 120);
          recoil.velocity += (-190 * recoil.value - 14 * recoil.velocity) * step;
          recoil.value += recoil.velocity * step;
        }
        if (Math.abs(recoil.value) < 0.0001 && Math.abs(recoil.velocity) < 0.0008) recoil.value = recoil.velocity = 0;
        else moving = true;
      }
      const closed = THREE.MathUtils.smoothstep(Math.abs(fold.value - 1), 0, 1);
      const idleAdvancing = !reducedMotion() && !gesture.folderDragging && !gesture.cardDragging && !props().previewVisible;
      if (!gesture.folderDragging || reducedMotion()) {
        moving = spring(idleStrength, reducedMotion() ? 0 : 1, 16, dt, reducedMotion()) || moving;
      }
      if (idleAdvancing) spring(idleSpeed, THREE.MathUtils.lerp(0.65, 1, closed), 3, dt, false);
      for (const motion of idleMotions) {
        if (idleAdvancing) motion.phase += motion.frequency * idleSpeed.value * dt;
        const amplitude = THREE.MathUtils.lerp(motion.openAmplitude, motion.amplitude, closed);
        motion.value = idleStrength.value === 0 ? 0
          : (Math.sin(motion.phase) * amplitude + motion.openOffset * (1 - closed)) * idleStrength.value;
      }
      moving = idleAdvancing || moving;
      const hoverEnabled = gesture.hoverEnabled;
      if (!hoverEnabled) {
        packHoverSettling = state.selectedCard !== null || selected !== null;
        packTiltTarget.set(0, 0);
      }
      if (!gesture.folderDragging || !hoverEnabled) {
        const frequency = packHoverSettling ? 3 : 10;
        moving = spring(packTiltX, packTiltTarget.x, frequency, dt, reducedMotion()) || moving;
        moving = spring(packTiltY, packTiltTarget.y, frequency, dt, reducedMotion()) || moving;
      }
      applyPackPose();
      const sealAngle = model.right.rotation.y + model.flipRoot.rotation.y;
      const angleDelta = Math.atan2(Math.sin(sealAngle - lastSealAngle), Math.cos(sealAngle - lastSealAngle));
      lastSealAngle = sealAngle;
      if (sealStarted) {
        sealTime += dt;
        const angularVelocity = dt > 0 ? angleDelta / dt : 0;
        const motion = THREE.MathUtils.clamp(angularVelocity * 0.08 + recoil.velocity * 0.04, -1, 1);
        const finished = model.updateSeal(sealTime, reducedMotion(), motion);
        if (finished && !sealFinished) {
          sealFinished = true;
          dispatch({ type: 'seal-finished' });
        }
        moving = !reducedMotion() || !finished || moving;
      }
      if (reducedMotion() || state.folderPose === 1 || state.selectedCard !== null) tapSparkles.clear();
      else moving = tapSparkles.update(dt, pixelRatio) || moving;

      const aspect = width / height;
      const closedHeight = Math.max(1.82 / 0.52, MI_NOTE_LEAF_WIDTH / (aspect * 0.68));
      const openHeight = Math.max(1.82 / 0.52, (MI_NOTE_LEAF_WIDTH * 2 + 0.32) / (aspect * 0.86));
      const selectedHeight = Math.max(
        MI_NOTE_CARD_HEIGHT * 1.28 / INTERACTIVE_CARD_CLOSEUP_MAX_HEIGHT_RATIO,
        MI_NOTE_CARD_WIDTH * 1.28 / (aspect * INTERACTIVE_CARD_CLOSEUP_MAX_WIDTH_RATIO),
      );
      const inspectSticker = props().inspectSticker && state.selectedCard === null;
      stickerFocus.set(0, 0, 0);
      if (inspectSticker) model.getSealFocus(stickerFocus);
      const viewHeight = inspectSticker ? Math.max(.9, .72 / aspect)
        : THREE.MathUtils.lerp(closedHeight, openHeight, 1 - Math.abs(fold.value - 1));
      const frustumHeight = 2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
      const cameraTarget = viewHeight / frustumHeight + stickerFocus.z;
      if (cameraMotion.value === 0) {
        cameraMotion.value = cameraTarget;
        cameraFocusX.value = stickerFocus.x;
        cameraFocusY.value = stickerFocus.y;
      }
      moving = spring(cameraMotion, cameraTarget, 12, dt, reducedMotion()) || moving;
      moving = spring(cameraFocusX, stickerFocus.x, 12, dt, reducedMotion()) || moving;
      moving = spring(cameraFocusY, stickerFocus.y, 12, dt, reducedMotion()) || moving;
      camera.position.set(cameraFocusX.value, cameraFocusY.value, cameraMotion.value);
      cardDestination.set(cameraFocusX.value, cameraFocusY.value, Math.max(CARD_FRONT_CLEARANCE, cameraMotion.value - selectedHeight / frustumHeight));

      if (canLiftCard && state.selectedCard !== null) {
        selected = state.selectedCard;
        const card = cards[selected];
        scene.attach(card.anchor);
        cardProgress = 0;
      }
      if (selected === null && state.selectedCard !== null && state.cardStage === 'returning') {
        dispatch({ type: 'card-returned' });
      }
      if (selected !== null) {
        const card = cards[selected];
        card.parent.localToWorld(cardHomePosition.copy(card.home));
        card.parent.getWorldQuaternion(cardHomeQuaternion);
        card.parent.localToWorld(cardPocketTop.set(card.home.x, MI_NOTE_POCKET_TOP, card.home.z));
        if (cardPath) updateMiNoteCardPath(cardPath, cardHomePosition, cardHomeQuaternion, cardPocketTop, cardDestination);
        else cardPath = createMiNoteCardPath(cardHomePosition, cardHomeQuaternion, cardPocketTop, cardDestination);
        if (state.cardStage === 'inspecting' && !gesture.cardDragging) poseMiNoteCardPath(card.anchor, cardPath, 1);
      }
      if ((state.cardStage === 'lifting' || state.cardStage === 'returning') && selected !== null && cardPath) {
        const lifting = state.cardStage === 'lifting';
        if (cardMotionSoundStage !== state.cardStage) {
          cardMotionSoundStage = state.cardStage;
          playSound(lifting ? 'cardPullout' : 'cardPutback');
        }
        const target = gesture.cardDragging ? gesture.cardTargetProgress : lifting ? 1 : 0;
        const duration = reducedMotion() ? 0.16 : target >= cardProgress ? 0.44 : 0.4;
        const step = dt / duration;
        cardProgress = THREE.MathUtils.clamp(target, cardProgress - step, cardProgress + step);
        const card = cards[selected];
        poseMiNoteCardPath(card.anchor, cardPath, cardProgress);
        if (!gesture.cardDragging && cardProgress === (lifting ? 1 : 0)) {
          if (!lifting) {
            card.parent.add(card.anchor);
            card.anchor.position.copy(card.home);
            card.anchor.quaternion.identity();
            card.anchor.scale.setScalar(1);
            selected = null;
            cardPath = null;
            cardMotionSoundStage = null;
            if (!document.activeElement?.matches('input, textarea, select')) host?.focus({ preventScroll: true });
            dispatch({ type: 'card-returned' });
          } else {
            dispatch({ type: 'card-lifted' });
          }
        } else moving = cardProgress !== target || moving;
      }
      if (state.cardStage !== 'inspecting' || reducedMotion()) tiltTarget.set(0, 0);
      moving = spring(tiltX, tiltTarget.x, state.cardStage === 'returning' ? 40 : 16, dt, reducedMotion()) || moving;
      moving = spring(tiltY, tiltTarget.y, state.cardStage === 'returning' ? 40 : 16, dt, reducedMotion()) || moving;
      cards.forEach(({ mesh }, index) => mesh.rotation.set(index === selected ? tiltX.value : 0, index === selected ? tiltY.value : 0, 0));
      return moving;
    },
  };
}

export type MiNotePackMotion = ReturnType<typeof createMiNotePackMotion>;
