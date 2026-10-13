import { useEffect, useRef, type RefObject } from 'react';
import * as THREE from 'three';
import type { MiNotePackStar } from '../lib/miNotePackStars';
import { MI_NOTE_STAR_VERTICAL_DEFAULT } from '../lib/miNoteStarFolds';
import { DEFAULT_MI_NOTE_STICKER_EFFECT_SETTINGS, type MiNoteStickerEffectSettings } from '../lib/miNoteStickerEffects';
import type { DrifCardConfig } from '../drifCards';
import { createMiNoteCardGeometry } from '../lib/miNoteCardGeometry';
import { createMiNoteCardMaterial } from '../lib/miNoteCardMaterial';
import {
  createMiNotePackModel,
  MI_NOTE_CARD_HEIGHT,
  MI_NOTE_CARD_WIDTH,
  MI_NOTE_LEAF_WIDTH,
  MI_NOTE_POCKET_TOP,
} from '../lib/miNotePackModel';
import { createMiNoteCardPath, poseMiNoteCardPath, updateMiNoteCardPath } from '../lib/miNotePackMotion';
import { INTERACTIVE_CARD_CLOSEUP_MAX_HEIGHT_RATIO, INTERACTIVE_CARD_CLOSEUP_MAX_WIDTH_RATIO } from '../lib/revealOverlayLayout';
import { createMiNoteCardInput, type PackPointerEvent } from '../lib/miNoteCardInput';
import { isMiNoteFolderInteractive, MI_NOTE_OPEN_TAPS, type MiNoteFolderPose, type MiNoteRevealEvent, type MiNoteRevealState } from '../lib/miNoteCardReveal';
import { createMiNoteTapSparkles } from '../lib/miNoteTapSparkles';
import { playMiNotePackSound, preloadMiNotePackSounds, unlockMiNotePackSounds, type MiNotePackSound } from '../lib/miNotePackSounds';

export type MiNotePackControls = {
  activate: () => void;
  navigate: (direction: -1 | 1) => void;
  escape: () => boolean;
  selectCard: (index: 0 | 1) => void;
  returnCard: () => void;
};

type MiNotePackViewerProps = {
  color: string;
  star: MiNotePackStar;
  foldPosition: number;
  rotationOffsetDegrees: number;
  verticalPosition?: number;
  sizeScale?: number;
  effectSettings?: MiNoteStickerEffectSettings;
  inspectSticker?: boolean;
  cards?: readonly [DrifCardConfig, DrifCardConfig];
  cardEffect: DrifCardConfig['effect'];
  onCardsReadyChange: (ready: boolean) => void;
  onCardsError: (error: Error | null) => void;
  state: MiNoteRevealState;
  interactionEnabled: boolean;
  previewVisible?: boolean;
  activationEnabled?: boolean;
  onReadyChange: (ready: boolean) => void;
  onFrameRendered?: () => void;
  onError: (error: Error) => void;
  onEvent: (event: MiNoteRevealEvent) => void;
  onBackgroundTap?: () => void;
  controlsRef: RefObject<MiNotePackControls | null>;
};

type Motion = { value: number; velocity: number };
type OuterFlip = Motion & { from: 0 | 2; to: 0 | 2; direction: number; target: number; dragging: boolean };
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

const CARD_FRONT_CLEARANCE = 0.05;
const UNSEAL_TAP_DELAY_MS = 500;
const PACK_HOVER_PITCH = THREE.MathUtils.degToRad(12);
const PACK_HOVER_YAW = THREE.MathUtils.degToRad(8);

function cardAssetKey(card: DrifCardConfig) {
  return JSON.stringify([card.imageSrc, card.foilSrc, card.textureSrc]);
}

function spring(motion: Motion, target: number, frequency: number, dt: number, reduced: boolean) {
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

export default function MiNotePackViewer(props: MiNotePackViewerProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const currentProps = useRef(props);
  currentProps.current = props;
  const invalidateRef = useRef<() => void>(() => undefined);
  const cardAppearanceRef = useRef<(cards: MiNotePackViewerProps['cards'], effect: DrifCardConfig['effect']) => void>(() => undefined);
  const effectSettingsRef = useRef<(value: MiNoteStickerEffectSettings) => void>(() => undefined);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let disposed = false;
    let frameId = 0;
    let failed = false;
    let width = 1;
    let height = 1;
    let pixelRatio = 0;
    let lastTime = 0;
    let lastRenderTime = 0;
    let taps = props.state.taps;
    let sealTime = 0;
    let sealStarted = false;
    let sealStartedAt: number | null = null;
    let sealFinished = false;
    let packReadyPending = false;
    let cardsReadyPending: (() => void) | null = null;
    const idlePitch = { value: 0.055, phase: Math.PI / 2, amplitude: 0.055, openAmplitude: 0.004, openOffset: -0.012, frequency: 0.45 };
    const idleYaw = { value: -0.12, phase: -Math.PI / 2, amplitude: 0.12, openAmplitude: 0, openOffset: 0, frequency: 0.32 };
    const idleRoll = { value: -0.016, phase: -Math.PI / 2, amplitude: 0.016, openAmplitude: 0, openOffset: 0, frequency: 0.55 };
    const idleHeight = { value: 0, phase: 0, amplitude: 0.037, openAmplitude: 0.0185, openOffset: 0, frequency: 0.75 };
    const idleMotions = [idlePitch, idleYaw, idleRoll, idleHeight];
    const idleSpeed: Motion = { value: props.state.folderPose === 1 ? 0.65 : 1, velocity: 0 };
    const idleStrength: Motion = { value: 1, velocity: 0 };
    const fold: Motion = { value: props.state.folderPose, velocity: 0 };
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
    let drag: { hit: THREE.Intersection | null; phase: number; outerStart: number; mode: 'pending' | 'fold' | 'flip'; soundStarted: boolean } | null = null;
    let tapHit: THREE.Intersection | null = null;
    let tapCard: 0 | 1 | null = null;
    let selected: 0 | 1 | null = null;
    let cardPath: ReturnType<typeof createMiNoteCardPath> | null = null;
    let cardProgress = 0;
    let cardDrag: CardDrag | null = null;
    let cardDismissSwipe: CardDismissSwipe | null = null;
    let cardMotionSoundStage: 'lifting' | 'returning' | null = null;
    let dragSoundVersion = 0;
    const soundEnabled = () => !disposed && !failed && currentProps.current.activationEnabled !== false;
    const playSound = (sound: MiNotePackSound, isCurrent = () => true) => {
      void playMiNotePackSound(sound, () => soundEnabled() && currentProps.current.interactionEnabled && isCurrent());
    };
    if (soundEnabled()) void preloadMiNotePackSounds();
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
    } catch (error) {
      currentProps.current.onError(error instanceof Error ? error : new Error('Unable to display the pack.'));
      return;
    }
    const fail = (error: Error) => {
      if (disposed || failed) return;
      failed = true;
      cancelAnimationFrame(frameId);
      frameId = 0;
      currentProps.current.onReadyChange(false);
      currentProps.current.onCardsReadyChange(false);
      currentProps.current.onError(error);
    };
    renderer.debug.onShaderError = () => fail(new Error('Unable to render this pack. Please retry.'));
    renderer.setClearColor(0x000000, 0);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    renderer.domElement.className = 'mi-note-wip__canvas';
    renderer.domElement.setAttribute('aria-hidden', 'true');
    host.append(renderer.domElement);
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(34, 1, 0.1, 40);
    scene.add(new THREE.HemisphereLight(0xffffff, 0xb1b9ac, 2.2));
    const keyLight = new THREE.DirectionalLight(0xffffff, 2.6);
    keyLight.position.set(-3, 5, 7);
    const fillLight = new THREE.DirectionalLight(0xe7f0ff, 0.8);
    fillLight.position.set(4, 0, 4);
    scene.add(keyLight, fillLight);
    let model: ReturnType<typeof createMiNotePackModel>;
    try {
      model = createMiNotePackModel({
        color: props.color,
        star: props.star,
        foldPosition: currentProps.current.foldPosition,
        rotationOffsetDegrees: currentProps.current.rotationOffsetDegrees,
        verticalPosition: currentProps.current.verticalPosition,
        sizeScale: currentProps.current.sizeScale,
        effectSettings: currentProps.current.effectSettings,
      });
    } catch (error) {
      renderer.dispose();
      renderer.forceContextLoss();
      renderer.domElement.remove();
      currentProps.current.onError(error instanceof Error ? error : new Error('Unable to create the pack.'));
      return;
    }
    scene.add(model.group);
    const tapSparkles = createMiNoteTapSparkles();
    scene.add(tapSparkles.points);
    effectSettingsRef.current = model.setSealEffectSettings;
    let lastSealAngle = model.right.rotation.y + model.flipRoot.rotation.y;
    const cardGeometry = createMiNoteCardGeometry();
    const createCard = (config: DrifCardConfig, index: number) => {
      const anchor = new THREE.Group();
      const home = new THREE.Vector3((index === 0 ? -1 : 1) * (MI_NOTE_LEAF_WIDTH / 2 - 0.015), -0.005, 0.0057);
      anchor.position.copy(home);
      const surface = createMiNoteCardMaterial(config);
      const mesh = new THREE.Mesh(cardGeometry, surface.material);
      mesh.name = `mi-note-card-${index}`;
      mesh.userData.card = index;
      mesh.visible = false;
      anchor.add(mesh);
      const parent = index === 0 ? model.left : model.right;
      parent.add(anchor);
      return { anchor, mesh, surface, parent, home, assetKey: cardAssetKey(config) };
    };
    const cards: ReturnType<typeof createCard>[] = [];
    let cardEffectRequest = 0;
    let activeCardEffect: DrifCardConfig['effect'] | undefined;
    cardAppearanceRef.current = (configs, effect) => {
      if (disposed || failed) return;
      if (!configs) {
        input.cancel();
        cardEffectRequest += 1;
        cards.splice(0).forEach(({ anchor, surface }) => {
          surface.dispose();
          anchor.removeFromParent();
        });
        selected = null;
        cardPath = null;
        cardMotionSoundStage = null;
        activeCardEffect = undefined;
        currentProps.current.onCardsReadyChange(false);
        return;
      }
      let assetsChanged = false;
      configs.forEach((config, index) => {
        const card = cards[index];
        if (!card) {
          cards.push(createCard(config, index));
          assetsChanged = true;
          return;
        }
        const assetKey = cardAssetKey(config);
        if (card.assetKey === assetKey) return;
        const previous = card.surface;
        card.surface = createMiNoteCardMaterial(config);
        card.mesh.material = card.surface.material;
        card.mesh.visible = false;
        card.assetKey = assetKey;
        previous.dispose();
        assetsChanged = true;
      });
      if (!assetsChanged && effect === activeCardEffect) return;
      activeCardEffect = effect;
      const request = ++cardEffectRequest;
      currentProps.current.onCardsError(null);
      currentProps.current.onCardsReadyChange(false);
      const isCurrent = () => !disposed && !failed && request === cardEffectRequest
        && currentProps.current.cardEffect === effect
        && currentProps.current.cards?.every((card, index) => cardAssetKey(card) === cards[index]?.assetKey);
      void Promise.all(cards.map(({ surface }) => surface.setEffect(effect))).then(() => {
        if (!isCurrent()) return;
        const textures = new Set<THREE.Texture>();
        cards.forEach(({ surface }) => Object.values(surface.material.uniforms).forEach(({ value }) => {
          if (value instanceof THREE.Texture) textures.add(value);
        }));
        textures.forEach(texture => renderer.initTexture(texture));
        cards.forEach(({ mesh }) => { mesh.visible = true; });
        renderer.compile(scene, camera);
        if (!isCurrent()) return;
        cardsReadyPending = () => {
          if (isCurrent()) currentProps.current.onCardsReadyChange(true);
        };
        invalidate();
      }).catch((error: unknown) => {
        if (!isCurrent()) return;
        currentProps.current.onCardsError(error instanceof Error ? error : new Error('Unable to load the cards.'));
      });
    };
    const tiltX: Motion = { value: 0, velocity: 0 };
    const tiltY: Motion = { value: 0, velocity: 0 };
    const tiltTarget = new THREE.Vector2();
    const packTiltX: Motion = { value: 0, velocity: 0 };
    const packTiltY: Motion = { value: 0, velocity: 0 };
    const packTiltTarget = new THREE.Vector2();
    let packHoverSettling = false;
    const projectedCenter = new THREE.Vector3();
    const projectedCorner = new THREE.Vector3();
    let inspectingPointer: number | null = null;
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    const dispatch = (event: MiNoteRevealEvent) => currentProps.current.onEvent(event);
    const invalidate = () => {
      if (!disposed && !failed && !frameId && !document.hidden) frameId = requestAnimationFrame(render);
    };
    invalidateRef.current = invalidate;

    const setPose = (pose: MiNoteFolderPose) => {
      dispatch({ type: 'folder-pose', pose });
      invalidate();
    };
    const beginFlip = (direction: number, dragging = false) => {
      const from = Math.round(fold.value);
      if ((from !== 0 && from !== 2) || Math.abs(fold.value - from) > 0.015 || outerFlip) return;
      fold.value = from;
      fold.velocity = 0;
      outerFlip = { from, to: from === 0 ? 2 : 0, direction, value: 0, velocity: 0, target: 1, dragging };
      if (!dragging) setPose(outerFlip.to);
      invalidate();
    };
    const canNavigate = () => currentProps.current.interactionEnabled
      && (currentProps.current.state.stage === 'sealed' || isMiNoteFolderInteractive(currentProps.current.state))
      && currentProps.current.state.selectedCard === null && !cardDrag?.active;
    const isUnsealTapWindow = () => sealStartedAt === null
      ? currentProps.current.state.stage === 'seal-peeling'
      : performance.now() - sealStartedAt < UNSEAL_TAP_DELAY_MS;
    const hitPack = (count: number) => {
      recoil.velocity += 1.6 + Math.min(count, MI_NOTE_OPEN_TAPS) * 0.65;
      playSound('folderTap');
    };
    const selectCard = (index: 0 | 1) => {
      if (!cards[index]) return;
      const state = currentProps.current.state;
      if (currentProps.current.interactionEnabled && state.selectedCard === index && state.cardStage === 'returning') {
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
      if (soundEnabled() && currentProps.current.interactionEnabled) void unlockMiNotePackSounds();
      input.cancel();
      tiltTarget.set(0, 0);
      dispatch({ type: 'return-card' });
      invalidate();
    };
    const activate = (leaf?: 0 | 2, point?: THREE.Vector3) => {
      const state = currentProps.current.state;
      if (currentProps.current.activationEnabled === false || !currentProps.current.interactionEnabled
        || state.selectedCard !== null || cardDrag?.active || drag) return;
      const feedbackOnly = state.folderPose !== 1 && isUnsealTapWindow();
      if (!feedbackOnly && !canNavigate()) return;
      void unlockMiNotePackSounds();
      input.cancel();
      if (point && (state.stage === 'sealed' || feedbackOnly) && !reducedMotion.matches) {
        const worldPerPixel = 2 * Math.abs(camera.position.z - point.z) * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) / height;
        tapSparkles.burst(point, worldPerPixel);
      }
      if (feedbackOnly) {
        hitPack(state.taps + 1);
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
        if (!canNavigate() || drag || outerFlip) return;
        input.cancel();
        if (currentProps.current.state.stage === 'sealed') {
          beginFlip(-direction);
          return;
        }
        const pose = currentProps.current.state.folderPose + direction;
        if (pose < 0 || pose > 2) beginFlip(-direction);
        else setPose(pose as MiNoteFolderPose);
      },
      escape() {
        if (failed || !currentProps.current.interactionEnabled) return false;
        const state = currentProps.current.state;
        if (state.selectedCard !== null || cardDrag?.active) {
          returnCard();
          return true;
        }
        if (drag || outerFlip) return true;
        if (isMiNoteFolderInteractive(state) && (state.folderPose === 1 || Math.abs(fold.value - state.folderPose) > 0.015)) {
          input.cancel();
          setPose(0);
          return true;
        }
        return state.stage === 'seal-peeling' || state.stage === 'unsealed';
      },
    };
    currentProps.current.controlsRef.current = controls;

    const hit = (event: PackPointerEvent) => {
      const rect = host.getBoundingClientRect();
      pointer.set((event.clientX - rect.left) / width * 2 - 1, 1 - (event.clientY - rect.top) / height * 2);
      scene.updateMatrixWorld(true);
      camera.updateMatrixWorld(true);
      raycaster.setFromCamera(pointer, camera);
      const objects = selected === null ? [model.group] : [cards[selected].anchor];
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
      const state = currentProps.current.state;
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
        currentProps.current.onBackgroundTap?.();
        return;
      }
      const index = tapHit.object.userData.card;
      if (index === 0 || index === 1) selectCard(index);
      else activate(tapHit.object.userData.leaf, tapHit.point);
    }, {
      onStart(event) {
        if (!currentProps.current.interactionEnabled) return false;
        if (event.pointerType !== 'mouse') {
          packHoverSettling = false;
          packTiltTarget.set(0, 0);
        }
        const state = currentProps.current.state;
        tapHit = hit(event);
        tapCard = state.selectedCard;
        if (state.selectedCard === null && state.stage !== 'sealed' && !isMiNoteFolderInteractive(state) && !isUnsealTapWindow()) return false;
        host.focus({ preventScroll: true });
        host.setPointerCapture(event.pointerId);
        const cardIndex = tapHit?.object.userData.card;
        if ((cardIndex === 0 || cardIndex === 1) && isMiNoteFolderInteractive(state) && state.ready
          && currentProps.current.activationEnabled !== false && state.folderPose === 1 && !outerFlip
          && Math.abs(fold.value - 1) < 0.015 && state.selectedCard === null) {
          cardDrag = {
            index: cardIndex, active: false, targetProgress: 0,
            distance: THREE.MathUtils.clamp(height * 0.3, 140, 260),
            flickStartY: event.clientY, flickEndY: event.clientY, flickTime: event.timeStamp,
            lastY: event.clientY, velocity: 0,
          };
        }
        if (state.selectedCard !== null) {
          inspectingPointer = event.pointerId;
          if (state.cardStage === 'inspecting' && selected === state.selectedCard && cardIndex === selected
            && state.ready && currentProps.current.activationEnabled !== false) {
            const rect = host.getBoundingClientRect();
            let top = Infinity;
            let bottom = -Infinity;
            for (const x of [-MI_NOTE_CARD_WIDTH / 2, MI_NOTE_CARD_WIDTH / 2]) {
              for (const y of [-MI_NOTE_CARD_HEIGHT / 2, MI_NOTE_CARD_HEIGHT / 2]) {
                projectedCorner.set(x, y, 0).applyMatrix4(cards[selected].mesh.matrixWorld).project(camera);
                const screenY = rect.top + (1 - projectedCorner.y) * height / 2;
                top = Math.min(top, screenY);
                bottom = Math.max(bottom, screenY);
              }
            }
            cardDismissSwipe = {
              index: selected, startX: event.clientX, startY: event.clientY, startTime: event.timeStamp,
              lastY: event.clientY, maxHorizontal: 0, verticalTravel: 0, top, bottom,
              minimumDistance: THREE.MathUtils.clamp((bottom - top) * 0.45, 140, 200),
            };
          }
          aimCard(event);
          return true;
        }
        drag = { hit: tapHit, phase: fold.value, outerStart: 0, mode: 'pending', soundStarted: false };
        fold.velocity = 0;
        return true;
      },
      onMove(event, movement) {
        const state = currentProps.current.state;
        if (!currentProps.current.interactionEnabled || failed
          || (state.selectedCard === null && state.stage !== 'sealed' && !isMiNoteFolderInteractive(state)
            && (movement.moved || !isUnsealTapWindow()))
          || ((cardDrag?.active || inspectingPointer !== null) && currentProps.current.activationEnabled === false)) {
          input.cancel();
          return;
        }
        if (cardDrag && !cardDrag.active && movement.moved && Math.hypot(movement.deltaX, movement.deltaY) > 8) {
          const vertical = Math.abs(movement.deltaY) > Math.abs(movement.deltaX) * 1.2;
          if (vertical && movement.deltaY < 0 && state.selectedCard === null && state.ready && currentProps.current.activationEnabled !== false) {
            cardDrag.active = true;
            drag = null;
            inspectingPointer = null;
            tiltTarget.set(0, 0);
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
              progress = delta < 0 ? Math.min(progress, cardProgress) : Math.max(progress, cardProgress);
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
        if (!drag?.hit || currentProps.current.state.selectedCard !== null) return;
        const { deltaX, deltaY, moved } = movement;
        const previousPosition = outerFlip?.value ?? fold.value;
        if (drag.mode === 'pending' && moved && Math.abs(deltaX) > Math.abs(deltaY)) {
          drag.phase = fold.value;
          const phase = Math.round(drag.phase);
          const closed = Math.abs(drag.phase - phase) < 0.015 && (phase === 0 || phase === 2);
          if (outerFlip) {
            outerFlip.dragging = true;
            outerFlip.velocity = 0;
            drag.outerStart = outerFlip.value;
            drag.mode = 'flip';
          } else if (closed && (currentProps.current.state.stage === 'sealed' || (phase === 0 ? deltaX > 0 : deltaX < 0))) {
            beginFlip(Math.sign(deltaX), true);
            if (outerFlip) drag.mode = 'flip';
          } else if (isMiNoteFolderInteractive(currentProps.current.state)) {
            drag.mode = 'fold';
          }
          if (drag.mode !== 'pending') {
            cardDrag = null;
            host.style.cursor = 'grabbing';
          }
        }
        const distance = Math.max(145, Math.min(280, width * 0.4));
        if (drag.mode === 'flip' && outerFlip) {
          outerFlip.value = THREE.MathUtils.clamp(drag.outerStart + outerFlip.direction * deltaX / distance, 0, 1);
        } else if (drag.mode === 'fold') {
          fold.value = THREE.MathUtils.clamp(drag.phase - deltaX / distance, 0, 2);
        }
        if (moved && !drag.soundStarted && (outerFlip?.value ?? fold.value) !== previousPosition) {
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
          if (!finish && !disposed && !failed) dispatch({ type: 'return-card' });
          tapHit = null;
          tapCard = null;
          tiltTarget.set(0, 0);
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
          if (movement.cancelled || event.pointerType !== 'mouse') tiltTarget.set(0, 0);
          else aimCard(event);
        }
        if (drag?.mode === 'flip' && outerFlip) {
          outerFlip.dragging = false;
          outerFlip.target = Math.round(outerFlip.value);
          outerFlip.velocity = 0;
          setPose(outerFlip.target === 1 ? outerFlip.to : outerFlip.from);
        } else if (drag?.mode === 'fold') {
          setPose(Math.round(fold.value) as MiNoteFolderPose);
          fold.velocity = 0;
        }
        if (movement.cancelled) {
          tapHit = null;
          tapCard = null;
          packHoverSettling = false;
          packTiltTarget.set(0, 0);
        }
        if (drag && drag.mode !== 'pending') host.style.cursor = 'pointer';
        drag = null;
        if (host.hasPointerCapture(event.pointerId)) host.releasePointerCapture(event.pointerId);
        if (swipe && !movement.cancelled && !disposed && !failed) {
          const state = currentProps.current.state;
          const elapsed = event.timeStamp - swipe.startTime;
          const deltaY = event.clientY - swipe.startY;
          const distance = Math.abs(deltaY);
          const beyondEdge = deltaY < 0 ? event.clientY <= swipe.top - 24 : event.clientY >= swipe.bottom + 24;
          if (state.selectedCard === swipe.index && state.cardStage === 'inspecting' && state.ready
            && currentProps.current.interactionEnabled && currentProps.current.activationEnabled !== false
            && elapsed > 0 && elapsed <= 300 && distance >= swipe.minimumDistance && distance / elapsed >= 0.75
            && distance >= swipe.maxHorizontal * 3 && swipe.verticalTravel <= distance + 12 && beyondEdge && !hit(event)) {
            returnCard();
          }
        }
        invalidate();
      },
    });
    function aimCard(event: PackPointerEvent) {
      if (cardDrag?.active || selected === null || currentProps.current.state.cardStage !== 'inspecting' || reducedMotion.matches) return;
      const anchor = cards[selected].anchor;
      const rect = host?.getBoundingClientRect();
      if (!rect) return;
      projectedCenter.set(0, 0, 0).applyMatrix4(anchor.matrixWorld).project(camera);
      projectedCorner.set(MI_NOTE_CARD_WIDTH / 2, MI_NOTE_CARD_HEIGHT / 2, 0).applyMatrix4(anchor.matrixWorld).project(camera);
      const halfWidth = Math.max(1, Math.abs(projectedCorner.x - projectedCenter.x) * width / 2);
      const halfHeight = Math.max(1, Math.abs(projectedCorner.y - projectedCenter.y) * height / 2);
      const x = (event.clientX - rect.left - (projectedCenter.x + 1) * width / 2) / halfWidth;
      const y = (event.clientY - rect.top - (1 - projectedCenter.y) * height / 2) / halfHeight;
      if (inspectingPointer === null && (Math.abs(x) > 1 || Math.abs(y) > 1)) tiltTarget.set(0, 0);
      else tiltTarget.set(-THREE.MathUtils.clamp(y, -1, 1) * 0.24, -THREE.MathUtils.clamp(x, -1, 1) * 0.3);
      invalidate();
    }
    const canHoverPack = () => currentProps.current.interactionEnabled
      && !currentProps.current.previewVisible && !currentProps.current.inspectSticker && !reducedMotion.matches
      && currentProps.current.state.selectedCard === null && selected === null
      && (currentProps.current.state.stage === 'sealed' || isMiNoteFolderInteractive(currentProps.current.state));
    const updatePackHover = (event: PointerEvent) => {
      if (!event.isPrimary || event.pointerType === 'touch' || drag || cardDrag?.active) return;
      const cardSelected = currentProps.current.state.selectedCard !== null;
      const packHit = cardSelected ? null : hit(event);
      if (host.style.cursor !== 'pointer') host.style.cursor = 'pointer';
      if (event.pointerType !== 'mouse') return;
      const hoverEnabled = canHoverPack();
      const hovering = packHit !== null && hoverEnabled;
      packHoverSettling = hoverEnabled && !hovering;
      const pitch = hovering ? pointer.y * PACK_HOVER_PITCH : 0;
      const yaw = hovering ? -pointer.x * PACK_HOVER_YAW : 0;
      if (packTiltTarget.x === pitch && packTiltTarget.y === yaw) return;
      packTiltTarget.set(pitch, yaw);
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
      packHoverSettling = settlePack && canHoverPack();
      if (tiltTarget.lengthSq() === 0 && packTiltTarget.lengthSq() === 0) return;
      tiltTarget.set(0, 0);
      packTiltTarget.set(0, 0);
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

    function render(now: number) {
      frameId = 0;
      if (disposed || failed || document.hidden) return;
      const elapsed = lastTime ? now - lastTime : Math.min(now - lastRenderTime, 16.67);
      const dt = Math.min(elapsed / 1000, 0.05);
      lastTime = lastRenderTime = now;
      let moving = false;
      const state = currentProps.current.state;
      if ((cardDrag?.active || inspectingPointer !== null)
        && (!currentProps.current.interactionEnabled || currentProps.current.activationEnabled === false)) {
        input.cancel();
        return;
      }
      updateDrawingBuffer();
      model.setSealFoldPosition(currentProps.current.foldPosition);
      model.setSealRotationOffsetDegrees(currentProps.current.rotationOffsetDegrees);
      model.setSealVerticalPosition(currentProps.current.verticalPosition ?? MI_NOTE_STAR_VERTICAL_DEFAULT);
      model.setSealSizeScale(currentProps.current.sizeScale ?? currentProps.current.star.sizeScale);
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
        if (!flip.dragging) moving = spring(flip, flip.target, 13, dt, reducedMotion.matches) || moving;
        const swapped = flip.value >= 0.5;
        fold.value = swapped ? flip.to : flip.from;
        model.flipRoot.rotation.y = flip.direction * Math.PI * (flip.value - (swapped ? 1 : 0));
        if (!flip.dragging && flip.value === flip.target) {
          model.flipRoot.rotation.y = 0;
          outerFlip = null;
          moving = fold.value !== state.folderPose || moving;
        }
      } else if (!drag) {
        moving = spring(fold, state.folderPose, 16, dt, reducedMotion.matches) || moving;
      }
      fold.value = THREE.MathUtils.clamp(fold.value, 0, 2);
      const canLiftCard = state.cardStage === 'lifting' && state.selectedCard !== null && selected === null
        && Boolean(cards[state.selectedCard]) && !outerFlip && !drag && Math.abs(fold.value - 1) < 0.015;
      if (canLiftCard) {
        fold.value = 1;
        fold.velocity = 0;
      }
      model.setFolderPhase(fold.value);
      if (reducedMotion.matches || state.selectedCard !== null) {
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
      const idleAdvancing = !reducedMotion.matches && !drag && !cardDrag?.active && !currentProps.current.previewVisible;
      if (!drag || reducedMotion.matches) {
        moving = spring(idleStrength, reducedMotion.matches ? 0 : 1, 16, dt, reducedMotion.matches) || moving;
      }
      if (idleAdvancing) spring(idleSpeed, THREE.MathUtils.lerp(0.65, 1, closed), 3, dt, false);
      for (const motion of idleMotions) {
        if (idleAdvancing) motion.phase += motion.frequency * idleSpeed.value * dt;
        const amplitude = THREE.MathUtils.lerp(motion.openAmplitude, motion.amplitude, closed);
        motion.value = idleStrength.value === 0 ? 0
          : (Math.sin(motion.phase) * amplitude + motion.openOffset * (1 - closed)) * idleStrength.value;
      }
      moving = idleAdvancing || moving;
      const hoverEnabled = canHoverPack();
      if (!hoverEnabled) {
        packHoverSettling = state.selectedCard !== null || selected !== null;
        packTiltTarget.set(0, 0);
      }
      if (!drag || !hoverEnabled) {
        const frequency = packHoverSettling ? 3 : 10;
        moving = spring(packTiltX, packTiltTarget.x, frequency, dt, reducedMotion.matches) || moving;
        moving = spring(packTiltY, packTiltTarget.y, frequency, dt, reducedMotion.matches) || moving;
      }
      applyPackPose();
      const sealAngle = model.right.rotation.y + model.flipRoot.rotation.y;
      const angleDelta = Math.atan2(Math.sin(sealAngle - lastSealAngle), Math.cos(sealAngle - lastSealAngle));
      lastSealAngle = sealAngle;
      if (sealStarted) {
        sealTime += dt;
        const angularVelocity = dt > 0 ? angleDelta / dt : 0;
        const motion = THREE.MathUtils.clamp(angularVelocity * 0.08 + recoil.velocity * 0.04, -1, 1);
        const finished = model.updateSeal(sealTime, reducedMotion.matches, motion);
        if (finished && !sealFinished) {
          sealFinished = true;
          dispatch({ type: 'seal-finished' });
        }
        moving = !reducedMotion.matches || !finished || moving;
      }
      if (reducedMotion.matches || state.folderPose === 1 || state.selectedCard !== null) tapSparkles.clear();
      else moving = tapSparkles.update(dt, pixelRatio) || moving;

      const aspect = width / height;
      const closedHeight = Math.max(1.82 / 0.52, MI_NOTE_LEAF_WIDTH / (aspect * 0.68));
      const openHeight = Math.max(1.82 / 0.52, (MI_NOTE_LEAF_WIDTH * 2 + 0.32) / (aspect * 0.86));
      const selectedHeight = Math.max(
        MI_NOTE_CARD_HEIGHT * 1.28 / INTERACTIVE_CARD_CLOSEUP_MAX_HEIGHT_RATIO,
        MI_NOTE_CARD_WIDTH * 1.28 / (aspect * INTERACTIVE_CARD_CLOSEUP_MAX_WIDTH_RATIO),
      );
      const inspectSticker = currentProps.current.inspectSticker && state.selectedCard === null;
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
      moving = spring(cameraMotion, cameraTarget, 12, dt, reducedMotion.matches) || moving;
      moving = spring(cameraFocusX, stickerFocus.x, 12, dt, reducedMotion.matches) || moving;
      moving = spring(cameraFocusY, stickerFocus.y, 12, dt, reducedMotion.matches) || moving;
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
        if (state.cardStage === 'inspecting' && !cardDrag?.active) poseMiNoteCardPath(card.anchor, cardPath, 1);
      }
      if ((state.cardStage === 'lifting' || state.cardStage === 'returning') && selected !== null && cardPath) {
        const lifting = state.cardStage === 'lifting';
        if (cardMotionSoundStage !== state.cardStage) {
          cardMotionSoundStage = state.cardStage;
          playSound(lifting ? 'cardPullout' : 'cardPutback');
        }
        const target = cardDrag?.active ? cardDrag.targetProgress : lifting ? 1 : 0;
        const duration = reducedMotion.matches ? 0.16 : target >= cardProgress ? 0.44 : 0.4;
        const step = dt / duration;
        cardProgress = THREE.MathUtils.clamp(target, cardProgress - step, cardProgress + step);
        const card = cards[selected];
        poseMiNoteCardPath(card.anchor, cardPath, cardProgress);
        if (!cardDrag?.active && cardProgress === (lifting ? 1 : 0)) {
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
      if (state.cardStage !== 'inspecting' || reducedMotion.matches) tiltTarget.set(0, 0);
      moving = spring(tiltX, tiltTarget.x, state.cardStage === 'returning' ? 40 : 16, dt, reducedMotion.matches) || moving;
      moving = spring(tiltY, tiltTarget.y, state.cardStage === 'returning' ? 40 : 16, dt, reducedMotion.matches) || moving;
      cards.forEach(({ mesh }, index) => mesh.rotation.set(index === selected ? tiltX.value : 0, index === selected ? tiltY.value : 0, 0));
      scene.updateMatrixWorld(true);
      camera.updateMatrixWorld(true);
      cards.forEach(({ mesh, surface }) => { if (mesh.visible) surface.update(mesh, camera); });
      try {
        renderer.render(scene, camera);
      } catch (error) {
        fail(error instanceof Error ? error : new Error('Unable to render this pack.'));
      }
      if (failed) return;
      if (packReadyPending) {
        packReadyPending = false;
        currentProps.current.onReadyChange(true);
      }
      const reportCardsReady = cardsReadyPending;
      cardsReadyPending = null;
      reportCardsReady?.();
      currentProps.current.onFrameRendered?.();
      if (moving) invalidate();
      else lastTime = 0;
    }

    function updateDrawingBuffer(nextWidth = width, nextHeight = height) {
      const densityLimit = currentProps.current.state.selectedCard === null ? 2 : 3;
      const nextPixelRatio = Math.min(window.devicePixelRatio || 1, densityLimit);
      const sizeChanged = width !== nextWidth || height !== nextHeight;
      if (!sizeChanged && pixelRatio === nextPixelRatio) return false;
      width = nextWidth;
      height = nextHeight;
      pixelRatio = nextPixelRatio;
      renderer.setDrawingBufferSize(width, height, pixelRatio);
      if (sizeChanged) {
        camera.aspect = width / height;
        camera.updateProjectionMatrix();
      }
      return true;
    }
    const resize = () => {
      if (updateDrawingBuffer(Math.max(1, host.clientWidth), Math.max(1, host.clientHeight))) invalidate();
    };
    const handleContextLost = (event: Event) => {
      event.preventDefault();
      input.cancel();
      fail(new Error('The pack display was interrupted. Please retry.'));
    };
    const handleVisibility = () => {
      handleBlur();
      if (document.hidden) {
        tapSparkles.clear();
        cancelAnimationFrame(frameId);
        frameId = 0;
      } else if (soundEnabled()) {
        void preloadMiNotePackSounds();
      }
      lastTime = 0;
      invalidate();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(host);
    document.addEventListener('visibilitychange', handleVisibility);
    reducedMotion.addEventListener('change', invalidate);
    renderer.domElement.addEventListener('webglcontextlost', handleContextLost);
    currentProps.current.onReadyChange(false);
    resize();
    cardAppearanceRef.current(currentProps.current.cards, currentProps.current.cardEffect);
    void model.ready.then(() => {
      if (disposed || failed) return;
      renderer.compile(scene, camera);
      if (failed) return;
      packReadyPending = true;
      invalidate();
    }).catch((error: unknown) => {
      fail(error instanceof Error ? error : new Error('Unable to load the pack.'));
    });

    return () => {
      disposed = true;
      input.cancel();
      cancelAnimationFrame(frameId);
      invalidateRef.current = () => undefined;
      effectSettingsRef.current = () => undefined;
      cardAppearanceRef.current = () => undefined;
      if (currentProps.current.controlsRef.current === controls) currentProps.current.controlsRef.current = null;
      observer.disconnect();
      document.removeEventListener('visibilitychange', handleVisibility);
      reducedMotion.removeEventListener('change', invalidate);
      renderer.domElement.removeEventListener('webglcontextlost', handleContextLost);
      host.removeEventListener('pointerdown', handlePointerDown);
      host.removeEventListener('pointerenter', updatePackHover);
      host.removeEventListener('pointermove', handlePointerMove);
      host.removeEventListener('pointerleave', handlePointerLeave);
      host.removeEventListener('pointerup', handlePointerUp);
      host.removeEventListener('pointercancel', input.onPointerCancel);
      host.removeEventListener('lostpointercapture', input.onLostPointerCapture);
      window.removeEventListener('blur', handleBlur);
      cards.forEach(({ anchor, surface }) => {
        surface.dispose();
        anchor.removeFromParent();
      });
      cardGeometry.dispose();
      tapSparkles.dispose();
      model.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      renderer.domElement.remove();
    };
  }, [props.color, props.star, props.controlsRef]);

  useEffect(() => {
    cardAppearanceRef.current(props.cards, props.cardEffect);
    invalidateRef.current();
  }, [props.cards, props.cardEffect]);
  useEffect(() => invalidateRef.current(), [props.state, props.foldPosition, props.rotationOffsetDegrees, props.verticalPosition, props.sizeScale, props.inspectSticker, props.previewVisible, props.interactionEnabled, props.activationEnabled, props.onFrameRendered]);
  useEffect(() => {
    effectSettingsRef.current(props.effectSettings ?? DEFAULT_MI_NOTE_STICKER_EFFECT_SETTINGS);
    invalidateRef.current();
  }, [props.effectSettings]);

  return <div ref={hostRef} className="mi-note-wip__renderer" tabIndex={0} role="group" aria-label="Interactive Mi Note Cards folder" />;
}
