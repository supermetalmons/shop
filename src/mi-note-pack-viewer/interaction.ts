import * as THREE from 'three';
import { MI_NOTE_CARD_HEIGHT, MI_NOTE_CARD_WIDTH, type createMiNotePackModel } from '../lib/miNotePackModel';
import { createMiNoteCardInput, type PackPointerEvent } from '../lib/miNoteCardInput';
import { isMiNoteFolderInteractive, type MiNoteFolderPose, type MiNoteRevealEvent } from '../lib/miNoteCardReveal';
import { unlockMiNotePackSounds, type MiNotePackSound } from '../lib/miNotePackSounds';
import type { createMiNoteTapSparkles } from '../lib/miNoteTapSparkles';
import type { MiNoteCardAssets } from './cardAssets';
import type { MiNoteMotionGesture, MiNotePackMotion } from './motion';
import type { MiNotePackControls, MiNotePackViewerProps } from './types';

type CardDrag = {
  index: 0 | 1;
  active: boolean;
  targetProgress: number;
  distance: number;
  flickStartY: number;
  flickEndY: number;
  flickTime: number;
  lastY: number;
  velocity: number;
};
type CardDismissSwipe = {
  index: 0 | 1;
  startX: number;
  startY: number;
  startTime: number;
  lastY: number;
  maxHorizontal: number;
  verticalTravel: number;
  top: number;
  bottom: number;
  minimumDistance: number;
};


const PACK_HOVER_PITCH = THREE.MathUtils.degToRad(12);
const PACK_HOVER_YAW = THREE.MathUtils.degToRad(8);

export function createMiNotePackInteraction({ host, model, assets, scene, camera, motion, sparkles: tapSparkles,
  props, viewport, reducedMotion, disposed, failed, soundEnabled, playSound, invalidate }: {
  host: HTMLElement;
  model: ReturnType<typeof createMiNotePackModel>;
  assets: MiNoteCardAssets;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  motion: MiNotePackMotion;
  sparkles: ReturnType<typeof createMiNoteTapSparkles>;
  props: () => MiNotePackViewerProps;
  viewport: () => { width: number; height: number };
  reducedMotion: () => boolean;
  disposed: () => boolean;
  failed: () => boolean;
  soundEnabled: () => boolean;
  playSound: (sound: MiNotePackSound, isCurrent?: () => boolean) => void;
  invalidate: () => void;
}) {
  let drag: { hit: THREE.Intersection | null; phase: number; outerStart: number; mode: 'pending' | 'fold' | 'flip'; soundStarted: boolean } | null = null;
  let tapHit: THREE.Intersection | null = null;
  let tapCard: 0 | 1 | null = null;
  let cardDrag: CardDrag | null = null;
  let cardDismissSwipe: CardDismissSwipe | null = null;
  let dragSoundVersion = 0;
  const projectedCenter = new THREE.Vector3();
  const projectedCorner = new THREE.Vector3();
  let inspectingPointer: number | null = null;
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  const dispatch = (event: MiNoteRevealEvent) => props().onEvent(event);
  const setPose = (pose: MiNoteFolderPose) => {
    dispatch({ type: 'folder-pose', pose });
    invalidate();
  };
  const canNavigate = () => props().interactionEnabled
    && (props().state.stage === 'sealed' || isMiNoteFolderInteractive(props().state))
    && props().state.selectedCard === null && !cardDrag?.active;
  const selectCard = (index: 0 | 1) => {
    if (!assets.cards[index]) return;
    const state = props().state;
    if (props().interactionEnabled && state.selectedCard === index && state.cardStage === 'returning') {
      if (soundEnabled()) void unlockMiNotePackSounds();
      input.cancel();
      dispatch({ type: 'select-card', index });
      invalidate();
      return;
    }
    if (!canNavigate() || !isMiNoteFolderInteractive(state) || !state.ready || drag) return;
    if (soundEnabled()) void unlockMiNotePackSounds();
    input.cancel();
    setPose(1);
    dispatch({ type: 'select-card', index });
  };
  const returnCard = () => {
    if (soundEnabled() && props().interactionEnabled) void unlockMiNotePackSounds();
    input.cancel();
    motion.clearCardTilt();
    dispatch({ type: 'return-card' });
    invalidate();
  };
  const activate = (leaf?: 0 | 2, point?: THREE.Vector3) => {
    const state = props().state;
    if (props().activationEnabled === false || !props().interactionEnabled
      || state.selectedCard !== null || cardDrag?.active || drag) return;
    const feedbackOnly = state.folderPose !== 1 && motion.isUnsealTapWindow();
    if (!feedbackOnly && !canNavigate()) return;
    void unlockMiNotePackSounds();
    input.cancel();
    if (point && (state.stage === 'sealed' || feedbackOnly) && !reducedMotion()) {
      const worldPerPixel = 2 * Math.abs(camera.position.z - point.z) * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) / viewport().height;
      tapSparkles.burst(point, worldPerPixel);
    }
    if (feedbackOnly) {
      motion.hitPack(state.taps + 1);
      invalidate();
      return;
    }
    if (isMiNoteFolderInteractive(state)) {
      playSound(state.folderPose === 1 ? 'folderClose' : 'folderOpen');
    }
    dispatch({ type: 'activate', leaf });
    invalidate();
  };
  const controls: MiNotePackControls = {
    activate,
    selectCard,
    returnCard,
    navigate(direction) {
      if (!canNavigate() || drag || motion.flipPosition !== null) return;
      input.cancel();
      if (props().state.stage === 'sealed') {
        motion.beginFlip(-direction);
        return;
      }
      const pose = props().state.folderPose + direction;
      if (pose < 0 || pose > 2) motion.beginFlip(-direction);
      else setPose(pose as MiNoteFolderPose);
    },
    escape() {
      if (failed() || !props().interactionEnabled) return false;
      const state = props().state;
      if (state.selectedCard !== null || cardDrag?.active) {
        returnCard();
        return true;
      }
      if (drag || motion.flipPosition !== null) return true;
      if (isMiNoteFolderInteractive(state) && (state.folderPose === 1 || Math.abs(motion.folderPosition - state.folderPose) > 0.015)) {
        input.cancel();
        setPose(0);
        return true;
      }
      return state.stage === 'seal-peeling' || state.stage === 'unsealed';
    },
  };

  const hit = (event: PackPointerEvent) => {
    const rect = host.getBoundingClientRect();
    pointer.set((event.clientX - rect.left) / viewport().width * 2 - 1, 1 - (event.clientY - rect.top) / viewport().height * 2);
    scene.updateMatrixWorld(true);
    camera.updateMatrixWorld(true);
    raycaster.setFromCamera(pointer, camera);
    const objects = motion.selectedCard === null ? [model.group] : [assets.cards[motion.selectedCard].anchor];
    return raycaster.intersectObjects(objects, true).find((entry) => {
      let object: THREE.Object3D | null = entry.object;
      while (object) {
        if (!object.visible) return false;
        object = object.parent;
      }
      return true;
    }) ?? null;
  };
  const input = createMiNoteCardInput((event) => {
    if (!event) return;
    const state = props().state;
    const tappedCard = tapCard;
    tapCard = null;
    if (state.selectedCard !== null) {
      if (state.cardStage === 'returning') selectCard(state.selectedCard);
      else returnCard();
      return;
    }
    if (tappedCard !== null) {
      selectCard(tappedCard);
      return;
    }
    if (!tapHit) {
      props().onBackgroundTap?.();
      return;
    }
    const index = tapHit.object.userData.card;
    if (index === 0 || index === 1) selectCard(index);
    else activate(tapHit.object.userData.leaf, tapHit.point);
  }, {
    onStart(event) {
      if (!props().interactionEnabled) return false;
      if (event.pointerType !== 'mouse') {
        motion.setPackHover(0, 0, false);
      }
      const state = props().state;
      tapHit = hit(event);
      tapCard = state.selectedCard;
      if (state.selectedCard === null && state.stage !== 'sealed' && !isMiNoteFolderInteractive(state) && !motion.isUnsealTapWindow()) return false;
      host.focus({ preventScroll: true });
      host.setPointerCapture(event.pointerId);
      const cardIndex = tapHit?.object.userData.card;
      if ((cardIndex === 0 || cardIndex === 1) && isMiNoteFolderInteractive(state) && state.ready
        && props().activationEnabled !== false && state.folderPose === 1 && motion.flipPosition === null
        && Math.abs(motion.folderPosition - 1) < 0.015 && state.selectedCard === null) {
        cardDrag = {
          index: cardIndex, active: false, targetProgress: 0,
          distance: THREE.MathUtils.clamp(viewport().height * 0.3, 140, 260),
          flickStartY: event.clientY, flickEndY: event.clientY, flickTime: event.timeStamp,
          lastY: event.clientY, velocity: 0,
        };
      }
      if (state.selectedCard !== null) {
        inspectingPointer = event.pointerId;
        if (state.cardStage === 'inspecting' && motion.selectedCard === state.selectedCard && cardIndex === motion.selectedCard
          && state.ready && props().activationEnabled !== false) {
          const rect = host.getBoundingClientRect();
          let top = Infinity;
          let bottom = -Infinity;
          for (const x of [-MI_NOTE_CARD_WIDTH / 2, MI_NOTE_CARD_WIDTH / 2]) {
            for (const y of [-MI_NOTE_CARD_HEIGHT / 2, MI_NOTE_CARD_HEIGHT / 2]) {
              projectedCorner.set(x, y, 0).applyMatrix4(assets.cards[motion.selectedCard].mesh.matrixWorld).project(camera);
              const screenY = rect.top + (1 - projectedCorner.y) * viewport().height / 2;
              top = Math.min(top, screenY);
              bottom = Math.max(bottom, screenY);
            }
          }
          cardDismissSwipe = {
            index: motion.selectedCard, startX: event.clientX, startY: event.clientY, startTime: event.timeStamp,
            lastY: event.clientY, maxHorizontal: 0, verticalTravel: 0, top, bottom,
            minimumDistance: THREE.MathUtils.clamp((bottom - top) * 0.45, 140, 200),
          };
        }
        aimCard(event);
        return true;
      }
      drag = { hit: tapHit, phase: motion.folderPosition, outerStart: 0, mode: 'pending', soundStarted: false };
      motion.stopFolderMotion();
      return true;
    },
    onMove(event, movement) {
      const state = props().state;
      if (!props().interactionEnabled || failed()
        || (state.selectedCard === null && state.stage !== 'sealed' && !isMiNoteFolderInteractive(state)
          && (movement.moved || !motion.isUnsealTapWindow()))
        || ((cardDrag?.active || inspectingPointer !== null) && props().activationEnabled === false)) {
        input.cancel();
        return;
      }
      if (cardDrag && !cardDrag.active && movement.moved && Math.hypot(movement.deltaX, movement.deltaY) > 8) {
        const vertical = Math.abs(movement.deltaY) > Math.abs(movement.deltaX) * 1.2;
        if (vertical && movement.deltaY < 0 && state.selectedCard === null && state.ready && props().activationEnabled !== false) {
          cardDrag.active = true;
          drag = null;
          inspectingPointer = null;
          motion.clearCardTilt();
          host.style.cursor = 'grabbing';
          if (soundEnabled()) void unlockMiNotePackSounds();
          dispatch({ type: 'select-card', index: cardDrag.index });
        } else cardDrag = null;
      }
      if (cardDrag?.active) {
        const elapsed = event.timeStamp - cardDrag.flickTime;
        if (elapsed > 80) {
          cardDrag.velocity = 0;
          cardDrag.flickEndY = cardDrag.lastY;
        }
        const delta = (cardDrag.lastY - event.clientY) / cardDrag.distance;
        if (delta !== 0) {
          const flickDelta = cardDrag.flickEndY - event.clientY;
          const sameDirection = Math.sign(flickDelta) === Math.sign(cardDrag.velocity);
          const meaningful = cardDrag.velocity === 0 || sameDirection || Math.abs(flickDelta) > 8;
          if (meaningful) {
            const velocity = THREE.MathUtils.clamp(flickDelta * 1000 / (cardDrag.distance * Math.max(1, elapsed)), -6, 6);
            if (!sameDirection) cardDrag.flickStartY = cardDrag.flickEndY;
            cardDrag.velocity = sameDirection ? cardDrag.velocity * 0.35 + velocity * 0.65 : velocity;
            cardDrag.flickEndY = event.clientY;
            cardDrag.flickTime = event.timeStamp;
          }
          let progress = cardDrag.targetProgress;
          if (meaningful && Math.abs(event.clientY - cardDrag.flickStartY) > 8) {
            progress = delta < 0 ? Math.min(progress, motion.cardProgress) : Math.max(progress, motion.cardProgress);
          }
          cardDrag.targetProgress = THREE.MathUtils.clamp(progress + delta, 0, 1);
          cardDrag.lastY = event.clientY;
        }
        invalidate();
        return;
      }
      if (inspectingPointer !== null) {
        if (cardDismissSwipe) {
          if (event.timeStamp - cardDismissSwipe.startTime > 300) cardDismissSwipe = null;
          else {
            cardDismissSwipe.maxHorizontal = Math.max(cardDismissSwipe.maxHorizontal, Math.abs(event.clientX - cardDismissSwipe.startX));
            cardDismissSwipe.verticalTravel += Math.abs(event.clientY - cardDismissSwipe.lastY);
            cardDismissSwipe.lastY = event.clientY;
          }
        }
        aimCard(event);
        return;
      }
      if (!drag?.hit || props().state.selectedCard !== null) return;
      const { deltaX, deltaY, moved } = movement;
      const previousPosition = motion.flipPosition ?? motion.folderPosition;
      if (drag.mode === 'pending' && moved && Math.abs(deltaX) > Math.abs(deltaY)) {
        drag.phase = motion.folderPosition;
        const phase = Math.round(drag.phase);
        const closed = Math.abs(drag.phase - phase) < 0.015 && (phase === 0 || phase === 2);
        if (motion.flipPosition !== null) {
          drag.outerStart = motion.resumeFlipDrag()!;
          drag.mode = 'flip';
        } else if (closed && (props().state.stage === 'sealed' || (phase === 0 ? deltaX > 0 : deltaX < 0))) {
          motion.beginFlip(Math.sign(deltaX), true);
          if (motion.flipPosition !== null) drag.mode = 'flip';
        } else if (isMiNoteFolderInteractive(props().state)) {
          drag.mode = 'fold';
        }
        if (drag.mode !== 'pending') {
          cardDrag = null;
          host.style.cursor = 'grabbing';
        }
      }
      const distance = Math.max(145, Math.min(280, viewport().width * 0.4));
      if (drag.mode === 'flip' && motion.flipPosition !== null) {
        motion.moveFlip(drag.outerStart, deltaX, distance);
      } else if (drag.mode === 'fold') {
        motion.setFolderPosition(THREE.MathUtils.clamp(drag.phase - deltaX / distance, 0, 2));
      }
      if (moved && !drag.soundStarted && (motion.flipPosition ?? motion.folderPosition) !== previousPosition) {
        drag.soundStarted = true;
        dragSoundVersion += 1;
        const startedDrag = drag;
        if (soundEnabled()) void unlockMiNotePackSounds();
        playSound('folderDragStart', () => drag === startedDrag);
      }
      invalidate();
    },
    onEnd(event, movement) {
      const gesture = cardDrag;
      cardDrag = null;
      const swipe = cardDismissSwipe;
      cardDismissSwipe = null;
      if (gesture?.active) {
        const flick = Math.abs(gesture.flickEndY - gesture.flickStartY) >= 40 && Math.abs(gesture.velocity) > 2;
        const finish = !movement.cancelled && (flick ? gesture.velocity > 0 : gesture.targetProgress >= 0.35);
        if (!finish && !disposed() && !failed()) dispatch({ type: 'return-card' });
        tapHit = null;
        tapCard = null;
        motion.clearCardTilt();
        host.style.cursor = 'pointer';
        if (host.hasPointerCapture(event.pointerId)) host.releasePointerCapture(event.pointerId);
        invalidate();
        return;
      }
      if (drag?.soundStarted) {
        const version = dragSoundVersion;
        playSound('folderDragEnd', () => version === dragSoundVersion);
      }
      if (inspectingPointer !== null) {
        inspectingPointer = null;
        if (movement.cancelled || event.pointerType !== 'mouse') motion.clearCardTilt();
        else aimCard(event);
      }
      if (drag?.mode === 'flip' && motion.flipPosition !== null) {
        setPose(motion.finishFlip()!);
      } else if (drag?.mode === 'fold') {
        setPose(Math.round(motion.folderPosition) as MiNoteFolderPose);
        motion.stopFolderMotion();
      }
      if (movement.cancelled) {
        tapHit = null;
        tapCard = null;
        motion.setPackHover(0, 0, false);
      }
      if (drag && drag.mode !== 'pending') host.style.cursor = 'pointer';
      drag = null;
      if (host.hasPointerCapture(event.pointerId)) host.releasePointerCapture(event.pointerId);
      if (swipe && !movement.cancelled && !disposed() && !failed()) {
        const state = props().state;
        const elapsed = event.timeStamp - swipe.startTime;
        const deltaY = event.clientY - swipe.startY;
        const distance = Math.abs(deltaY);
        const beyondEdge = deltaY < 0 ? event.clientY <= swipe.top - 24 : event.clientY >= swipe.bottom + 24;
        if (state.selectedCard === swipe.index && state.cardStage === 'inspecting' && state.ready
          && props().interactionEnabled && props().activationEnabled !== false
          && elapsed > 0 && elapsed <= 300 && distance >= swipe.minimumDistance && distance / elapsed >= 0.75
          && distance >= swipe.maxHorizontal * 3 && swipe.verticalTravel <= distance + 12 && beyondEdge && !hit(event)) {
          returnCard();
        }
      }
      invalidate();
    },
  });
  function aimCard(event: PackPointerEvent) {
    if (cardDrag?.active || motion.selectedCard === null || props().state.cardStage !== 'inspecting' || reducedMotion()) return;
    const anchor = assets.cards[motion.selectedCard].anchor;
    const rect = host?.getBoundingClientRect();
    if (!rect) return;
    projectedCenter.set(0, 0, 0).applyMatrix4(anchor.matrixWorld).project(camera);
    projectedCorner.set(MI_NOTE_CARD_WIDTH / 2, MI_NOTE_CARD_HEIGHT / 2, 0).applyMatrix4(anchor.matrixWorld).project(camera);
    const halfWidth = Math.max(1, Math.abs(projectedCorner.x - projectedCenter.x) * viewport().width / 2);
    const halfHeight = Math.max(1, Math.abs(projectedCorner.y - projectedCenter.y) * viewport().height / 2);
    const x = (event.clientX - rect.left - (projectedCenter.x + 1) * viewport().width / 2) / halfWidth;
    const y = (event.clientY - rect.top - (1 - projectedCenter.y) * viewport().height / 2) / halfHeight;
    motion.aimCard(x, y, inspectingPointer !== null);
    invalidate();
  }
  const canHoverPack = () => props().interactionEnabled
    && !props().previewVisible && !props().inspectSticker && !reducedMotion()
    && props().state.selectedCard === null && motion.selectedCard === null
    && (props().state.stage === 'sealed' || isMiNoteFolderInteractive(props().state));
  const updatePackHover = (event: PointerEvent) => {
    if (!event.isPrimary || event.pointerType === 'touch' || drag || cardDrag?.active) return;
    const cardSelected = props().state.selectedCard !== null;
    const packHit = cardSelected ? null : hit(event);
    if (host.style.cursor !== 'pointer') host.style.cursor = 'pointer';
    if (event.pointerType !== 'mouse') return;
    const hoverEnabled = canHoverPack();
    const hovering = packHit !== null && hoverEnabled;
    const pitch = hovering ? pointer.y * PACK_HOVER_PITCH : 0;
    const yaw = hovering ? -pointer.x * PACK_HOVER_YAW : 0;
    if (!motion.setPackHover(pitch, yaw, hoverEnabled && !hovering)) return;
    invalidate();
  };
  const handlePointerDown = (event: PointerEvent) => input.onPointerDown(event);
  const handlePointerUp = (event: PointerEvent) => {
    input.onPointerUp(event);
    updatePackHover(event);
  };
  const handlePointerMove = (event: PointerEvent) => {
    input.onPointerMove(event);
    updatePackHover(event);
    if (event.isPrimary && event.pointerType === 'mouse') aimCard(event);
  };
  const resetTilt = (settlePack = false) => {
    if (!motion.resetTilt(settlePack && canHoverPack())) return;
    invalidate();
  };
  const handlePointerLeave = () => { if (inspectingPointer === null) resetTilt(true); };
  const handleBlur = () => { input.cancel(); resetTilt(); };
  host.addEventListener('pointerdown', handlePointerDown);
  host.addEventListener('pointerenter', updatePackHover);
  host.addEventListener('pointermove', handlePointerMove);
  host.addEventListener('pointerleave', handlePointerLeave);
  host.addEventListener('pointerup', handlePointerUp);
  host.addEventListener('pointercancel', input.onPointerCancel);
  host.addEventListener('lostpointercapture', input.onLostPointerCapture);
  window.addEventListener('blur', handleBlur);

  return {
    controls,
    cancel: input.cancel,
    blur: handleBlur,
    cancelDisabledInteraction() {
      if ((cardDrag?.active || inspectingPointer !== null)
        && (!props().interactionEnabled || props().activationEnabled === false)) {
        input.cancel();
        return true;
      }
      return false;
    },
    motionGesture(): MiNoteMotionGesture {
      return { folderDragging: drag !== null, cardDragging: Boolean(cardDrag?.active),
        cardTargetProgress: cardDrag?.targetProgress ?? 0, hoverEnabled: canHoverPack() };
    },
    dispose() {
      input.cancel();
      host.removeEventListener('pointerdown', handlePointerDown);
      host.removeEventListener('pointerenter', updatePackHover);
      host.removeEventListener('pointermove', handlePointerMove);
      host.removeEventListener('pointerleave', handlePointerLeave);
      host.removeEventListener('pointerup', handlePointerUp);
      host.removeEventListener('pointercancel', input.onPointerCancel);
      host.removeEventListener('lostpointercapture', input.onLostPointerCapture);
      window.removeEventListener('blur', handleBlur);
    },
  };
}
