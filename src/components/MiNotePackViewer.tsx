import { useEffect, useRef, type RefObject } from 'react';
import * as THREE from 'three';
import type { MiNotePackStar } from '../lib/miNotePackStars';
import { CSS3DObject, CSS3DRenderer } from 'three/addons/renderers/CSS3DRenderer.js';
import {
  createMiNotePackModel,
  MI_NOTE_CARD_HEIGHT,
  MI_NOTE_CARD_WIDTH,
  MI_NOTE_LEAF_WIDTH,
  MI_NOTE_POCKET_TOP,
} from '../lib/miNotePackModel';
import { createMiNoteCardPath, poseMiNoteCardPath } from '../lib/miNotePackMotion';
import { createMiNoteCardInput, type PackPointerEvent } from '../lib/miNoteCardInput';
import type { MiNoteFolderPose, MiNoteRevealEvent, MiNoteRevealState } from '../lib/miNoteCardReveal';

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
  cardElements: readonly [HTMLDivElement, HTMLDivElement];
  state: MiNoteRevealState;
  interactionEnabled: boolean;
  onReadyChange: (ready: boolean) => void;
  onError: (error: Error) => void;
  onEvent: (event: MiNoteRevealEvent) => void;
  onBackgroundTap: () => void;
  controlsRef: RefObject<MiNotePackControls | null>;
};

type Motion = { value: number; velocity: number };
type OuterFlip = Motion & { from: 0 | 2; to: 0 | 2; direction: number; target: number; dragging: boolean };

function spring(motion: Motion, target: number, frequency: number, dt: number, reduced: boolean) {
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

function cardApertureGeometry() {
  const width = MI_NOTE_CARD_WIDTH;
  const height = MI_NOTE_CARD_HEIGHT;
  const radius = width * 0.0455;
  const shape = new THREE.Shape();
  const x = -width / 2;
  const y = -height / 2;
  shape.moveTo(x + radius, y);
  shape.lineTo(x + width - radius, y);
  shape.quadraticCurveTo(x + width, y, x + width, y + radius);
  shape.lineTo(x + width, y + height - radius);
  shape.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
  shape.lineTo(x + radius, y + height);
  shape.quadraticCurveTo(x, y + height, x, y + height - radius);
  shape.lineTo(x, y + radius);
  shape.quadraticCurveTo(x, y, x + radius, y);
  return new THREE.ShapeGeometry(shape, 12);
}

export default function MiNotePackViewer(props: MiNotePackViewerProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const currentProps = useRef(props);
  currentProps.current = props;
  const invalidateRef = useRef<() => void>(() => undefined);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let disposed = false;
    let frameId = 0;
    let failed = false;
    let width = 1;
    let height = 1;
    let lastTime = 0;
    let taps = 0;
    let sealTime = 0;
    let sealStarted = false;
    let sealFinished = false;
    const fold: Motion = { value: props.state.folderPose, velocity: 0 };
    const recoil: Motion = { value: 0, velocity: 0 };
    const cameraMotion: Motion = { value: 0, velocity: 0 };
    let outerFlip: OuterFlip | null = null;
    let drag: { hit: THREE.Intersection | null; phase: number; outerStart: number; mode: 'pending' | 'fold' | 'flip' } | null = null;
    let tapHit: THREE.Intersection | null = null;
    let selected: 0 | 1 | null = null;
    let foregroundCard: 0 | 1 | null = null;
    let cardPath: ReturnType<typeof createMiNoteCardPath> | null = null;
    let transition: 'lifting' | 'returning' | null = null;
    let cardTime = 0;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
    } catch (error) {
      currentProps.current.onError(error instanceof Error ? error : new Error('Unable to display the pack.'));
      return;
    }
    renderer.setClearColor(0x000000, 0);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    renderer.domElement.className = 'mi-note-wip__canvas';
    renderer.domElement.setAttribute('aria-hidden', 'true');
    const cssRenderer = new CSS3DRenderer();
    cssRenderer.domElement.className = 'mi-note-wip__css-scene';
    const foregroundRenderer = new CSS3DRenderer();
    foregroundRenderer.domElement.className = 'mi-note-wip__css-scene mi-note-wip__css-scene--foreground';
    host.append(cssRenderer.domElement, renderer.domElement, foregroundRenderer.domElement);
    const scene = new THREE.Scene();
    const foregroundScene = new THREE.Scene();
    const foregroundAnchor = new THREE.Group();
    foregroundScene.add(foregroundAnchor);
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
      });
    } catch (error) {
      renderer.dispose();
      renderer.forceContextLoss();
      renderer.domElement.remove();
      cssRenderer.domElement.remove();
      foregroundRenderer.domElement.remove();
      currentProps.current.onError(error instanceof Error ? error : new Error('Unable to create the pack.'));
      return;
    }
    scene.add(model.group);
    let lastSealAngle = model.right.rotation.y + model.flipRoot.rotation.y;
    const apertureGeometry = cardApertureGeometry();
    const apertureMaterial = new THREE.MeshBasicMaterial({
      color: 0x000000,
      opacity: 0,
      transparent: true,
      blending: THREE.NoBlending,
      depthWrite: true,
      depthTest: true,
      side: THREE.FrontSide,
      toneMapped: false,
    });
    const cards = props.cardElements.map((element, index) => {
      const anchor = new THREE.Group();
      const home = new THREE.Vector3((index === 0 ? -1 : 1) * MI_NOTE_LEAF_WIDTH / 2, -0.005, 0.0057);
      anchor.position.copy(home);
      const cssObject = new CSS3DObject(element);
      const aperture = new THREE.Mesh(apertureGeometry, apertureMaterial);
      aperture.userData.card = index;
      anchor.add(cssObject, aperture);
      const parent = index === 0 ? model.left : model.right;
      parent.add(anchor);
      return { anchor, cssObject, aperture, parent, home };
    });
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
      invalidate();
    };
    const canNavigate = () => currentProps.current.interactionEnabled
      && ['sealed', 'interactive'].includes(currentProps.current.state.stage)
      && currentProps.current.state.selectedCard === null;
    const selectCard = (index: 0 | 1) => {
      const state = currentProps.current.state;
      if (!canNavigate() || state.stage !== 'interactive' || !state.ready || drag || outerFlip) return;
      setPose(1);
      dispatch({ type: 'select-card', index });
    };
    const returnCard = () => {
      dispatch({ type: 'return-card' });
      invalidate();
    };
    const activate = (leaf?: 0 | 2) => {
      if (!canNavigate() || drag || outerFlip) return;
      dispatch({ type: 'activate', leaf });
      invalidate();
    };
    const controls: MiNotePackControls = {
      activate,
      selectCard,
      returnCard,
      navigate(direction) {
        if (!canNavigate() || drag || outerFlip) return;
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
        if (state.selectedCard !== null) {
          returnCard();
          return true;
        }
        if (drag || outerFlip || state.stage === 'seal-peeling' || state.stage === 'unsealed') return true;
        if (state.stage === 'interactive' && (state.folderPose === 1 || Math.abs(fold.value - state.folderPose) > 0.015)) {
          setPose(0);
          return true;
        }
        return false;
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
      if (currentProps.current.state.selectedCard !== null) {
        if (!tapHit) returnCard();
        return;
      }
      if (!tapHit) {
        currentProps.current.onBackgroundTap();
        return;
      }
      const index = tapHit.object.userData.card;
      if (index === 0 || index === 1) selectCard(index);
      else activate(tapHit.object.userData.leaf);
    }, {
      onStart(event) {
        if (!currentProps.current.interactionEnabled) return false;
        const state = currentProps.current.state;
        if (state.cardStage === 'lifting' || state.cardStage === 'returning') return false;
        tapHit = hit(event);
        if (state.selectedCard !== null && tapHit) return false;
        if (state.stage === 'seal-peeling' || state.stage === 'unsealed') return false;
        host.focus({ preventScroll: true });
        host.setPointerCapture(event.pointerId);
        if (outerFlip) {
          outerFlip.dragging = true;
          outerFlip.velocity = 0;
        }
        drag = { hit: tapHit, phase: fold.value, outerStart: outerFlip?.value ?? 0, mode: outerFlip ? 'flip' : 'pending' };
        fold.velocity = 0;
        return true;
      },
      onMove(_event, movement) {
        if (!drag?.hit || currentProps.current.state.selectedCard !== null) return;
        const { deltaX, deltaY, moved } = movement;
        if (drag.mode === 'pending' && moved && Math.abs(deltaX) > Math.abs(deltaY)) {
          const phase = Math.round(drag.phase);
          const closed = Math.abs(drag.phase - phase) < 0.015 && (phase === 0 || phase === 2);
          if (closed && (currentProps.current.state.stage === 'sealed' || (phase === 0 ? deltaX > 0 : deltaX < 0))) {
            beginFlip(Math.sign(deltaX), true);
            if (outerFlip) drag.mode = 'flip';
          } else if (currentProps.current.state.stage === 'interactive') {
            drag.mode = 'fold';
          }
        }
        const distance = Math.max(145, Math.min(280, width * 0.4));
        if (drag.mode === 'flip' && outerFlip) {
          outerFlip.value = THREE.MathUtils.clamp(drag.outerStart + outerFlip.direction * deltaX / distance, 0, 1);
        } else if (drag.mode === 'fold') {
          fold.value = THREE.MathUtils.clamp(drag.phase - deltaX / distance, 0, 2);
        }
        invalidate();
      },
      onEnd(event, movement) {
        if (outerFlip) {
          outerFlip.dragging = false;
          outerFlip.target = Math.round(outerFlip.value);
          outerFlip.velocity = 0;
        } else if (drag?.mode === 'fold') {
          setPose(Math.round(fold.value) as MiNoteFolderPose);
          fold.velocity = 0;
        }
        if (movement.cancelled) tapHit = null;
        drag = null;
        if (host.hasPointerCapture(event.pointerId)) host.releasePointerCapture(event.pointerId);
        invalidate();
      },
    });
    const handlePointerDown = (event: PointerEvent) => {
      if (event.target instanceof Element && event.target.closest('.mi-note-wip__card[data-active="true"]')) return;
      input.onPointerDown(event);
    };
    const handlePointerMove = (event: PointerEvent) => {
      input.onPointerMove(event);
      if (!drag && currentProps.current.state.selectedCard === null) host.style.cursor = hit(event) ? 'grab' : '';
    };
    const handleBlur = () => input.cancel();
    host.addEventListener('pointerdown', handlePointerDown);
    host.addEventListener('pointermove', handlePointerMove);
    host.addEventListener('pointerup', input.onPointerUp);
    host.addEventListener('pointercancel', input.onPointerCancel);
    host.addEventListener('lostpointercapture', input.onLostPointerCapture);
    window.addEventListener('blur', handleBlur);

    function render(now: number) {
      frameId = 0;
      if (disposed || failed || document.hidden) return;
      const dt = Math.min((now - (lastTime || now - 16.67)) / 1000, 0.05);
      lastTime = now;
      let moving = false;
      const state = currentProps.current.state;
      model.setSealFoldPosition(currentProps.current.foldPosition);
      model.setSealRotationOffsetDegrees(currentProps.current.rotationOffsetDegrees);
      if (state.taps !== taps) {
        for (let count = taps + 1; count <= state.taps; count += 1) recoil.velocity += 1.6 + count * 0.65;
        taps = state.taps;
      }
      if (state.stage === 'seal-peeling' && !sealStarted) {
        sealStarted = true;
        model.startSealPeel();
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
          setPose(fold.value as MiNoteFolderPose);
        }
      } else if (!drag) {
        moving = spring(fold, state.folderPose, 16, dt, reducedMotion.matches) || moving;
      }
      fold.value = THREE.MathUtils.clamp(fold.value, 0, 2);
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
      model.group.scale.setScalar(1 - recoil.value * 0.08);
      model.group.rotation.z = -0.016 + recoil.value * 0.08;
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

      if (state.cardStage === 'lifting' && state.selectedCard !== null && selected === null && !outerFlip && !drag && Math.abs(fold.value - 1) < 0.015) {
        fold.value = 1;
        fold.velocity = 0;
        model.setFolderPhase(1);
        scene.updateMatrixWorld(true);
        selected = state.selectedCard;
        const card = cards[selected];
        const homePosition = card.anchor.getWorldPosition(new THREE.Vector3());
        const homeQuaternion = card.anchor.getWorldQuaternion(new THREE.Quaternion());
        const pocketTop = card.parent.localToWorld(new THREE.Vector3(card.home.x, MI_NOTE_POCKET_TOP, card.home.z));
        cardPath = createMiNoteCardPath(homePosition, homeQuaternion, pocketTop, new THREE.Vector3(0, 0, 1.4));
        scene.attach(card.anchor);
        transition = 'lifting';
        cardTime = 0;
      }
      if (selected !== null && state.cardStage === 'returning' && transition === null) {
        transition = 'returning';
        cardTime = 0;
      }
      if (transition && selected !== null && cardPath) {
        cardTime += dt;
        const duration = reducedMotion.matches ? 0.16 : transition === 'lifting' ? 0.6 : 0.56;
        const progress = Math.min(1, cardTime / duration);
        const card = cards[selected];
        if (transition === 'returning' && progress >= 0.18 && foregroundCard !== null) {
          card.anchor.add(card.cssObject);
          card.aperture.visible = true;
          foregroundCard = null;
        }
        poseMiNoteCardPath(card.anchor, cardPath, transition === 'lifting' ? progress : 1 - Math.max(0, (progress - 0.18) / 0.82));
        if (progress === 1) {
          if (transition === 'returning') {
            card.parent.add(card.anchor);
            card.anchor.position.copy(card.home);
            card.anchor.quaternion.identity();
            card.anchor.scale.setScalar(1);
            selected = null;
            cardPath = null;
            host?.focus({ preventScroll: true });
            dispatch({ type: 'card-returned' });
          } else {
            foregroundAnchor.add(card.cssObject);
            card.aperture.visible = false;
            foregroundCard = selected;
            dispatch({ type: 'card-lifted' });
          }
          transition = null;
        } else moving = true;
      }
      const aspect = width / height;
      const closedHeight = Math.max(1.82 / 0.52, MI_NOTE_LEAF_WIDTH / (aspect * 0.68));
      const openHeight = Math.max(1.82 / 0.52, (MI_NOTE_LEAF_WIDTH * 2 + 0.32) / (aspect * 0.86));
      const selectedHeight = Math.max(MI_NOTE_CARD_HEIGHT * 1.28 / 0.66, MI_NOTE_CARD_WIDTH * 1.28 / (aspect * 0.72));
      const viewHeight = state.selectedCard !== null ? selectedHeight : THREE.MathUtils.lerp(closedHeight, openHeight, 1 - Math.abs(fold.value - 1));
      const cameraTarget = viewHeight / (2 * Math.tan(THREE.MathUtils.degToRad(17))) + (state.selectedCard !== null ? 1.4 : 0);
      if (cameraMotion.value === 0) cameraMotion.value = cameraTarget;
      moving = spring(cameraMotion, cameraTarget, 12, dt, reducedMotion.matches) || moving;
      camera.position.z = cameraMotion.value;
      camera.aspect = aspect;
      camera.updateProjectionMatrix();
      scene.updateMatrixWorld(true);
      camera.updateMatrixWorld(true);
      if (foregroundCard !== null) {
        const anchor = cards[foregroundCard].anchor;
        anchor.getWorldPosition(foregroundAnchor.position);
        anchor.getWorldQuaternion(foregroundAnchor.quaternion);
        anchor.getWorldScale(foregroundAnchor.scale);
      }
      renderer.render(scene, camera);
      cssRenderer.render(scene, camera);
      foregroundRenderer.render(foregroundScene, camera);
      if (moving) invalidate();
      else lastTime = 0;
    }

    const resize = () => {
      width = Math.max(1, host.clientWidth);
      height = Math.max(1, host.clientHeight);
      const cardWidth = Math.min(width * 0.72, height * 0.7 / 1.4, 480);
      cards.forEach(({ cssObject }) => {
        cssObject.element.style.width = `${cardWidth}px`;
        cssObject.element.style.height = `${cardWidth * 1.4}px`;
        cssObject.scale.setScalar(MI_NOTE_CARD_WIDTH / cardWidth);
      });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      renderer.setSize(width, height);
      cssRenderer.setSize(width, height);
      foregroundRenderer.setSize(width, height);
      invalidate();
    };
    const handleContextLost = (event: Event) => {
      event.preventDefault();
      failed = true;
      currentProps.current.onReadyChange(false);
      currentProps.current.onError(new Error('The pack display was interrupted. Please retry.'));
    };
    const handleVisibility = () => {
      input.cancel();
      if (document.hidden) {
        cancelAnimationFrame(frameId);
        frameId = 0;
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
    void model.ready.then(() => {
      if (disposed || failed) return;
      renderer.compile(scene, camera);
      currentProps.current.onReadyChange(true);
      invalidate();
    }).catch((error: unknown) => {
      if (disposed) return;
      failed = true;
      currentProps.current.onError(error instanceof Error ? error : new Error('Unable to load the pack.'));
    });

    return () => {
      disposed = true;
      input.cancel();
      cancelAnimationFrame(frameId);
      invalidateRef.current = () => undefined;
      if (currentProps.current.controlsRef.current === controls) currentProps.current.controlsRef.current = null;
      observer.disconnect();
      document.removeEventListener('visibilitychange', handleVisibility);
      reducedMotion.removeEventListener('change', invalidate);
      renderer.domElement.removeEventListener('webglcontextlost', handleContextLost);
      host.removeEventListener('pointerdown', handlePointerDown);
      host.removeEventListener('pointermove', handlePointerMove);
      host.removeEventListener('pointerup', input.onPointerUp);
      host.removeEventListener('pointercancel', input.onPointerCancel);
      host.removeEventListener('lostpointercapture', input.onLostPointerCapture);
      window.removeEventListener('blur', handleBlur);
      cards.forEach(({ anchor, cssObject }) => {
        cssObject.removeFromParent();
        anchor.removeFromParent();
      });
      apertureGeometry.dispose();
      apertureMaterial.dispose();
      model.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      renderer.domElement.remove();
      cssRenderer.domElement.remove();
      foregroundRenderer.domElement.remove();
    };
  }, [props.color, props.star, props.cardElements, props.controlsRef]);

  useEffect(() => invalidateRef.current(), [props.state, props.foldPosition, props.rotationOffsetDegrees]);

  return <div ref={hostRef} className="mi-note-wip__renderer" tabIndex={0} role="group" aria-label="Interactive Mi Note Cards folder" />;
}
