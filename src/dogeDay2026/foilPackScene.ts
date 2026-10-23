import * as THREE from 'three';
import type { DrifCardConfig } from '../drifCards';
import { createMiNoteCardGeometry } from '../lib/miNoteCardGeometry';
import { createMiNoteCardMaterial } from '../lib/miNoteCardMaterial';
import { createMiNoteCardInput, type PackPointerEvent } from '../lib/miNoteCardInput';
import { setMiNoteCardTiltTarget, stepMiNoteMotion } from '../lib/miNoteCardTilt';
import { createDogeFoilPackModel } from './foilPackModel';
import {
  activateDogeCardStackFlow, advanceDogeCardStackFlow, createDogeCardStackFlow,
  sampleDogeCardStackFlow,
} from './cardStackFlow';
import {
  advanceDogeFoilFlow, createDogeFoilFlow, hitDogeFoilFlow,
  readyDogeFoilFlow, sampleDogeFoilFlow,
} from './foilPackFlow';

export type DogeCardSceneState = {
  mode: 'stack' | 'cycling' | 'spreading' | 'row';
  activeCardIndex: number;
  transitioning: boolean;
};

type SceneOptions = {
  cards: readonly DrifCardConfig[];
  cardReady: boolean;
  onStageChange: (stage: 'sealed' | 'hit' | 'waiting' | 'opening' | 'revealed', hits: number) => void;
  onReady: () => void;
  onError: (error: Error) => void;
  onHit: () => void;
  onReveal: () => void;
  onBackgroundTap: () => void;
  onCardStateChange?: (state: DogeCardSceneState) => void;
  onCardSwipe?: () => void;
  onCardSpread?: () => void;
};

function loadCardTexture(source: string, signal: AbortSignal, maxSize: number) {
  return new Promise<THREE.Texture>((resolve, reject) => {
    const image = new Image();
    image.crossOrigin = 'anonymous';
    image.decoding = 'async';
    image.fetchPriority = 'high';
    let settled = false;
    const clean = () => {
      image.onload = image.onerror = null;
      signal.removeEventListener('abort', abort);
    };
    const fail = () => {
      if (settled) return;
      settled = true;
      clean();
      image.src = '';
      reject(new Error('Unable to load the card artwork. Please retry.'));
    };
    const abort = () => fail();
    signal.addEventListener('abort', abort, { once: true });
    image.onerror = fail;
    image.onload = () => {
      void image.decode().then(() => {
        if (settled) return;
        if (signal.aborted || !image.naturalWidth || !image.naturalHeight) { fail(); return; }
        const scale = Math.min(1, maxSize / Math.max(image.naturalWidth, image.naturalHeight));
        let texture: THREE.Texture;
        if (scale < 1) {
          const canvas = document.createElement('canvas');
          canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
          canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
          const context = canvas.getContext('2d');
          if (!context) { fail(); return; }
          context.imageSmoothingQuality = 'high';
          context.drawImage(image, 0, 0, canvas.width, canvas.height);
          texture = new THREE.CanvasTexture(canvas);
        } else texture = new THREE.Texture(image);
        settled = true;
        clean();
        resolve(texture);
      }).catch(fail);
    };
    if (signal.aborted) fail();
    else image.src = source;
  });
}

export function createDogeFoilScene(host: HTMLDivElement, options: SceneOptions) {
  if (options.cards.length !== 1 && options.cards.length !== 2 && options.cards.length !== 3) {
    throw new Error('A pack must contain 1, 2 or 3 cards.');
  }
  const cardCount = options.cards.length;
  let disposed = false;
  let failed = false;
  let frame = 0;
  let lastFrameTime = 0;
  let time = 0;
  let cardTime = 0;
  let width = 1;
  let height = 1;
  let cardWidthPx = 1;
  let cardCenterY = 0;
  let density = 1;
  let ready = options.cardReady;
  let gpuReady = false;
  let firstFrame = true;
  let revealPlayed = false;
  let inspectingPointer: number | null = null;
  let inspectingCardIndex: number | null = null;
  let pointerCardIndex: number | null = null;
  let pointerTarget: 'pack' | 'card' | 'background' = 'background';
  let hitX = 0;
  let hitY = 0;
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  let flow = createDogeFoilFlow({ reducedMotion: reducedMotion.matches });
  let cardFlow = createDogeCardStackFlow({ count: cardCount, reducedMotion: reducedMotion.matches });
  const abort = new AbortController();
  const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, powerPreference: 'low-power' });
  renderer.setClearColor(0x000000, 0);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.domElement.className = 'doge-day-2026-foil-canvas';
  renderer.domElement.setAttribute('aria-hidden', 'true');
  renderer.domElement.style.position = 'absolute';
  renderer.domElement.style.top = '0';
  host.append(renderer.domElement);
  const scene = new THREE.Scene();
  const stage = new THREE.Group();
  scene.add(stage);
  const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 60);
  camera.position.z = 10;
  const packRoot = new THREE.Group();
  packRoot.scale.set(2.35 / 2.45, 4.08 / 3.75, 1);
  let pack: ReturnType<typeof createDogeFoilPackModel>;
  try {
    pack = createDogeFoilPackModel(cardCount);
  } catch (error) {
    renderer.dispose();
    renderer.forceContextLoss();
    renderer.domElement.remove();
    throw error;
  }
  packRoot.add(pack.group);
  stage.add(packRoot);

  const cardGeometry = createMiNoteCardGeometry();
  cardGeometry.computeBoundingBox();
  const bounds = cardGeometry.boundingBox!;
  const cardWidth = bounds.max.x - bounds.min.x;
  cardGeometry.scale(2 / cardWidth, 2 / cardWidth, 1);
  const cardBackMaterial = new THREE.MeshBasicMaterial({ color: 0x28272c, side: THREE.BackSide });
  const textureLoader = (source: string) => loadCardTexture(source, abort.signal, renderer.capabilities.maxTextureSize);
  const cards = options.cards.map((config, index) => {
    const surface = createMiNoteCardMaterial(config, { loadTexture: textureLoader });
    const group = new THREE.Group();
    const tilt = new THREE.Group();
    const front = new THREE.Mesh(cardGeometry, surface.material);
    const back = new THREE.Mesh(cardGeometry, cardBackMaterial);
    front.userData.cardIndex = back.userData.cardIndex = index;
    back.position.z = -0.018;
    tilt.add(front, back);
    group.add(tilt);
    group.visible = false;
    stage.add(group);
    return {
      group, tilt, front, back, surface,
      tiltX: { value: 0, velocity: 0 },
      tiltY: { value: 0, velocity: 0 },
      tiltTarget: new THREE.Vector2(),
    };
  });
  const localPoint = new THREE.Vector3();
  const projectedCenter = new THREE.Vector3();
  const projectedCorner = new THREE.Vector3();
  const pointer = new THREE.Vector2();
  const raycaster = new THREE.Raycaster();
  const hits: THREE.Intersection[] = [];

  const fail = (error: unknown) => {
    if (disposed || failed) return;
    failed = true;
    abort.abort();
    cancelAnimationFrame(frame);
    frame = 0;
    options.onError(error instanceof Error ? error : new Error('Unable to render this pack. Please retry.'));
  };
  renderer.debug.onShaderError = () => fail(new Error('Unable to render this pack on this device.'));
  const invalidate = () => {
    if (!disposed && !failed && !frame && !document.hidden) frame = requestAnimationFrame(render);
  };
  function commit(next: typeof flow) {
    const changed = next.stage !== flow.stage || next.hitCount !== flow.hitCount;
    flow = next;
    if (flow.stage === 'opening' && !revealPlayed) {
      revealPlayed = true;
      resetTilt();
      options.onReveal();
    }
    if (changed && flow.stage === 'revealed') host.style.cursor = 'default';
    if (changed) options.onStageChange(flow.stage, flow.hitCount);
  }
  function cardTransitioning() {
    return cardFlow.stage === 'cycling' || cardFlow.stage === 'spreading';
  }
  function reportCardState() {
    options.onCardStateChange?.({
      mode: cardFlow.stage,
      activeCardIndex: cardFlow.activeIndex,
      transitioning: cardTransitioning(),
    });
  }
  function commitCardFlow(next: typeof cardFlow) {
    const changed = next.stage !== cardFlow.stage || next.activeIndex !== cardFlow.activeIndex;
    cardFlow = next;
    if (changed) reportCardState();
  }
  function resetTilt(immediate = false) {
    cards.forEach(({ tiltTarget, tiltX, tiltY, tilt }) => {
      tiltTarget.set(0, 0);
      if (immediate) {
        tiltX.value = tiltX.velocity = tiltY.value = tiltY.velocity = 0;
        tilt.rotation.set(0, 0, 0);
      }
    });
  }
  function canInspect(index: number) {
    return flow.stage === 'revealed' && flow.ready && !cardTransitioning()
      && (cardFlow.stage === 'row' || index === cardFlow.activeIndex);
  }
  function advanceCards() {
    if (!canInspect(cardFlow.activeIndex) || cardCount === 1 || cardFlow.stage === 'row') return;
    const next = activateDogeCardStackFlow(cardFlow, cardTime);
    if (next === cardFlow) return;
    const spreading = cardFlow.activeIndex === cardCount - 1;
    resetTilt(true);
    commitCardFlow(next);
    if (spreading) options.onCardSpread?.();
    else options.onCardSwipe?.();
    invalidate();
  }
  function activate() {
    if (disposed || failed || firstFrame) return;
    if (flow.stage === 'revealed') {
      if (cardTransitioning() || !flow.ready) return;
      if (cardCount > 1 && cardFlow.stage !== 'row') {
        advanceCards();
        return;
      }
      resetTilt();
      invalidate();
      return;
    }
    const next = hitDogeFoilFlow(flow, time, hitX, hitY);
    if (next.hitCount === flow.hitCount) return;
    commit(next);
    options.onHit();
    invalidate();
  }
  function intersect(event: PackPointerEvent) {
    const rect = host.getBoundingClientRect();
    pointer.set((event.clientX - rect.left) / width * 2 - 1, 1 - (event.clientY - rect.top) / height * 2);
    raycaster.setFromCamera(pointer, camera);
    hits.length = 0;
    if (flow.stage === 'revealed') {
      cards.forEach(({ group }) => {
        if (group.visible) raycaster.intersectObject(group, true, hits);
      });
      hits.sort((a, b) => b.object.renderOrder - a.object.renderOrder || a.distance - b.distance);
    }
    else if (packRoot.visible) raycaster.intersectObject(pack.group, true, hits);
    return hits[0];
  }
  const input = createMiNoteCardInput(() => {
    if (disposed || failed) return;
    if (pointerTarget === 'background') options.onBackgroundTap();
    else if (flow.stage !== 'revealed') activate();
    else if (pointerCardIndex === cardFlow.activeIndex) advanceCards();
  }, {
    maxTapDurationMs: 600,
    maxTapMovementPx: 8,
    onStart(event) {
      if (disposed || failed) return false;
      const hit = intersect(event);
      pointerTarget = hit ? (flow.stage === 'revealed' ? 'card' : 'pack') : 'background';
      pointerCardIndex = pointerTarget === 'card' ? hit.object.userData.cardIndex as number : null;
      if (pointerCardIndex !== null && !canInspect(pointerCardIndex)) return false;
      if (hit && pointerTarget === 'pack') {
        localPoint.copy(hit.point);
        packRoot.worldToLocal(localPoint);
        hitX = THREE.MathUtils.clamp(localPoint.x / 1.225, -1, 1);
        hitY = THREE.MathUtils.clamp(localPoint.y / 1.875, -1, 1);
      }
      if (pointerTarget === 'card') {
        inspectingPointer = event.pointerId;
        inspectingCardIndex = pointerCardIndex;
      }
      host.setPointerCapture(event.pointerId);
    },
    onMove(event) {
      if (inspectingPointer === null) return;
      event.preventDefault();
      if (inspectingCardIndex !== null) aimCard(event, inspectingCardIndex);
    },
    onEnd(event, movement) {
      if (inspectingPointer !== null) {
        const index = inspectingCardIndex;
        inspectingPointer = null;
        inspectingCardIndex = null;
        if (index !== null) {
          if (movement.cancelled || event.pointerType !== 'mouse') cards[index].tiltTarget.set(0, 0);
          else aimCard(event, index);
        }
      }
      if (host.hasPointerCapture(event.pointerId)) host.releasePointerCapture(event.pointerId);
      invalidate();
    },
  });
  function aimCard(event: PackPointerEvent, index: number) {
    if (disposed || failed || !canInspect(index) || reducedMotion.matches) return;
    const card = cards[index];
    const rect = host.getBoundingClientRect();
    card.group.updateWorldMatrix(true, false);
    projectedCenter.set(0, 0, 0).applyMatrix4(card.group.matrixWorld).project(camera);
    projectedCorner.set(1, 1.4, 0).applyMatrix4(card.group.matrixWorld).project(camera);
    const halfWidth = Math.max(1, Math.abs(projectedCorner.x - projectedCenter.x) * width / 2);
    const halfHeight = Math.max(1, Math.abs(projectedCorner.y - projectedCenter.y) * height / 2);
    const x = (event.clientX - rect.left - (projectedCenter.x + 1) * width / 2) / halfWidth;
    const y = (event.clientY - rect.top - (1 - projectedCenter.y) * height / 2) / halfHeight;
    setMiNoteCardTiltTarget(card.tiltTarget, x, y, inspectingPointer !== null);
    invalidate();
  }
  function pointerMove(event: PointerEvent) {
    input.onPointerMove(event);
    if (!event.isPrimary || event.pointerType !== 'mouse' || inspectingPointer !== null
      || reducedMotion.matches || flow.stage === 'opening') return;
    const hit = intersect(event);
    const index = flow.stage === 'revealed' ? hit?.object.userData.cardIndex as number | undefined : undefined;
    host.style.cursor = hit ? (flow.stage === 'revealed'
      ? index !== undefined && canInspect(index) && cardCount > 1 && cardFlow.stage !== 'row' ? 'pointer' : 'default'
      : 'pointer') : '';
    if (cardFlow.stage === 'row') {
      cards.forEach((_card, cardIndex) => aimCard(event, cardIndex));
    } else aimCard(event, cardFlow.activeIndex);
  }
  function pointerLeave() {
    if (inspectingPointer !== null) return;
    resetTilt();
    invalidate();
  }
  function resetPointer() {
    input.cancel();
    resetTilt();
    invalidate();
  }
  function render(stamp: number) {
    frame = 0;
    if (disposed || failed || document.hidden) return;
    updateDrawingBuffer();
    const elapsed = lastFrameTime ? stamp - lastFrameTime : 16.67;
    const dt = Math.min(elapsed, 50) / 1000;
    lastFrameTime = stamp;
    time += dt * 1000;
    commit(advanceDogeFoilFlow(flow, time));
    if (flow.stage === 'revealed' && flow.ready) cardTime += dt * 1000;
    commitCardFlow(advanceDogeCardStackFlow(cardFlow, cardTime));
    if (disposed || failed) return;
    const pose = sampleDogeFoilFlow(flow, time);
    packRoot.visible = flow.stage !== 'revealed';
    cardBackMaterial.depthWrite = packRoot.visible;
    pack.update(pose);
    packRoot.position.y = -pose.discard * (1440 / 520 * 2 * 1.42);
    const cardPoses = sampleDogeCardStackFlow(cardFlow, cardTime, { viewportWidth: width, viewportHeight: height, cardWidthPx, cardCenterY });
    let tiltMoving = false;
    cards.forEach((card, index) => {
      const placement = cardPoses[index];
      const movingX = stepMiNoteMotion(card.tiltX, card.tiltTarget.x, 16, dt, reducedMotion.matches);
      const movingY = stepMiNoteMotion(card.tiltY, card.tiltTarget.y, 16, dt, reducedMotion.matches);
      tiltMoving ||= movingX || movingY;
      card.group.visible = gpuReady && pose.tear > 0;
      card.surface.material.depthWrite = packRoot.visible;
      card.group.position.set(placement.x, placement.y, placement.z);
      card.group.scale.setScalar(placement.scale);
      card.group.rotation.z = placement.rotationZ;
      card.front.renderOrder = card.back.renderOrder = 1000 + Math.round(placement.z * 10_000);
      const interactive = pose.cardInteractive && placement.interactive;
      card.tilt.rotation.set(interactive ? card.tiltX.value : 0, interactive ? card.tiltY.value : 0, 0);
      if (card.group.visible) card.surface.update(card.front, camera);
    });
    try {
      renderer.render(scene, camera);
    } catch (error) { fail(error); return; }
    if (failed) return;
    if (firstFrame) {
      firstFrame = false;
      options.onReady();
    }
    const moving = flow.stage === 'hit' || (flow.stage === 'opening' && flow.ready)
      || (cardTransitioning() && flow.ready) || tiltMoving;
    if (moving) invalidate();
    else lastFrameTime = 0;
  }
  function updateDrawingBuffer() {
    const nextDensity = Math.min(window.devicePixelRatio || 1, 3);
    if (density === nextDensity && renderer.domElement.width === Math.floor(width * density)
      && renderer.domElement.height === Math.floor(height * density)) return;
    density = nextDensity;
    renderer.setDrawingBufferSize(width, height, density);
  }
  function resize() {
    width = Math.max(1, host.clientWidth);
    height = Math.max(1, host.clientHeight);
    const portrait = height >= width;
    const gutter = portrait ? 8 : 16;
    const frameSize = Math.max(1, Math.floor(portrait ? Math.min(width * 1.4, height - gutter * 2) : height * 0.82));
    renderer.domElement.style.left = '0px';
    renderer.domElement.style.width = `${width}px`;
    updateDrawingBuffer();
    camera.aspect = width / height;
    const lift = portrait ? Math.min(44, Math.round(frameSize * 0.08)) : Math.min(32, Math.round(frameSize * 0.06));
    const frameTop = Math.min(Math.max(gutter, height - frameSize - gutter), Math.max(gutter, Math.round((height - frameSize) / 2) - lift));
    cardWidthPx = Math.max(1, Math.round(frameSize * 520 / 1440));
    cardCenterY = frameTop + Math.round(frameSize * 372 / 1440) + Math.round(frameSize * 728 / 1440) / 2;
    const worldPerPixel = 2 / cardWidthPx;
    stage.position.y = (height / 2 - cardCenterY) * worldPerPixel;
    const verticalSpan = height * worldPerPixel;
    camera.position.z = verticalSpan / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)));
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld();
    invalidate();
  }
  function visibilityChange() {
    resetPointer();
    lastFrameTime = 0;
    if (document.hidden) {
      cancelAnimationFrame(frame);
      frame = 0;
    } else invalidate();
  }
  function contextLost(event: Event) {
    event.preventDefault();
    fail(new Error('The 3D display was interrupted. Please retry.'));
  }
  function motionChange() {
    resetTilt();
    flow = { ...flow, reducedMotion: reducedMotion.matches };
    commitCardFlow(advanceDogeCardStackFlow({ ...cardFlow, reducedMotion: reducedMotion.matches }, cardTime));
    invalidate();
  }
  host.addEventListener('pointerdown', input.onPointerDown);
  host.addEventListener('pointermove', pointerMove);
  host.addEventListener('pointerup', input.onPointerUp);
  host.addEventListener('pointercancel', input.onPointerCancel);
  host.addEventListener('lostpointercapture', input.onLostPointerCapture);
  host.addEventListener('pointerleave', pointerLeave);
  window.addEventListener('blur', resetPointer);
  window.addEventListener('resize', resize);
  document.addEventListener('visibilitychange', visibilityChange);
  reducedMotion.addEventListener('change', motionChange);
  renderer.domElement.addEventListener('webglcontextlost', contextLost);
  const observer = new ResizeObserver(resize);
  observer.observe(host);
  resize();
  options.onStageChange(flow.stage, flow.hitCount);
  reportCardState();

  void Promise.all(cards.map((card, index) => card.surface.setEffect(options.cards[index].effect))).then(() => {
    if (disposed || failed) return;
    const textures = new Set<THREE.Texture>();
    cards.forEach(({ surface, group }) => {
      Object.values(surface.material.uniforms).forEach(({ value }) => {
        if (value instanceof THREE.Texture) textures.add(value);
      });
      group.visible = true;
    });
    textures.forEach(texture => renderer.initTexture(texture));
    renderer.compile(scene, camera);
    if (disposed || failed) return;
    if (renderer.getContext().isContextLost()) {
      fail(new Error('The 3D display was interrupted. Please retry.'));
      return;
    }
    const warmTarget = new THREE.WebGLRenderTarget(4, 4);
    try {
      packRoot.visible = false;
      renderer.setRenderTarget(warmTarget);
      cards.forEach(card => { card.group.visible = false; });
      for (const card of cards) {
        if (disposed || failed) return;
        card.group.visible = true;
        card.surface.update(card.front, camera);
        renderer.render(scene, camera);
        card.group.visible = false;
        if (renderer.getContext().isContextLost()) {
          fail(new Error('The 3D display was interrupted. Please retry.'));
          return;
        }
      }
    } finally {
      renderer.setRenderTarget(null);
      warmTarget.dispose();
      packRoot.visible = true;
      cards.forEach(card => { card.group.visible = false; });
    }
    if (disposed || failed) return;
    if (renderer.getContext().isContextLost()) {
      fail(new Error('The 3D display was interrupted. Please retry.'));
      return;
    }
    gpuReady = true;
    commit(readyDogeFoilFlow(flow, ready, time));
    invalidate();
  }).catch(fail);

  return {
    activate,
    setCardReady(value: boolean) {
      if (disposed || failed) return;
      ready = value;
      commit(readyDogeFoilFlow(flow, ready && gpuReady, time));
      invalidate();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      input.cancel();
      abort.abort();
      cancelAnimationFrame(frame);
      observer.disconnect();
      host.removeEventListener('pointerdown', input.onPointerDown);
      host.removeEventListener('pointermove', pointerMove);
      host.removeEventListener('pointerup', input.onPointerUp);
      host.removeEventListener('pointercancel', input.onPointerCancel);
      host.removeEventListener('lostpointercapture', input.onLostPointerCapture);
      host.removeEventListener('pointerleave', pointerLeave);
      window.removeEventListener('blur', resetPointer);
      window.removeEventListener('resize', resize);
      document.removeEventListener('visibilitychange', visibilityChange);
      reducedMotion.removeEventListener('change', motionChange);
      renderer.domElement.removeEventListener('webglcontextlost', contextLost);
      renderer.domElement.remove();
      host.style.cursor = '';
      cards.forEach(card => card.surface.dispose());
      cardGeometry.dispose();
      cardBackMaterial.dispose();
      pack.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
    },
  };
}
