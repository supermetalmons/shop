import * as THREE from 'three';
import { createMiNotePackModel } from '../lib/miNotePackModel';
import { createMiNoteTapSparkles } from '../lib/miNoteTapSparkles';
import { playMiNotePackSound, preloadMiNotePackSounds, type MiNotePackSound } from '../lib/miNotePackSounds';
import { createMiNoteCardAssets } from './cardAssets';
import { createMiNoteFrameLoop } from './frameLoop';
import { createMiNotePackInteraction } from './interaction';
import { createMiNotePackMotion } from './motion';
import type { MiNotePackViewerProps } from './types';

export function createMiNotePackViewerRuntime(host: HTMLElement, initial: MiNotePackViewerProps, props: () => MiNotePackViewerProps) {
  let disposed = false;
  let failed = false;
  let width = 1;
  let height = 1;
  let pixelRatio = 0;
  let packReadyPending = false;
  let loop: ReturnType<typeof createMiNoteFrameLoop> | undefined;
  const active = () => !disposed && !failed;
  const soundEnabled = () => active() && props().activationEnabled !== false;
  const playSound = (sound: MiNotePackSound, isCurrent = () => true) => {
    void playMiNotePackSound(sound, () => soundEnabled() && props().interactionEnabled && isCurrent());
  };
  if (soundEnabled()) void preloadMiNotePackSounds();

  let renderer: THREE.WebGLRenderer;
  try {
    renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
  } catch (error) {
    props().onError(error instanceof Error ? error : new Error('Unable to display the pack.'));
    return null;
  }
  const fail = (error: Error) => {
    if (!active()) return;
    failed = true;
    loop?.stop();
    props().onReadyChange(false);
    props().onCardsReadyChange(false);
    props().onError(error);
  };
  renderer.debug.onShaderError = () => fail(new Error('Unable to render this pack. Please retry.'));
  renderer.setClearColor(0x000000, 0);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.domElement.className = 'mi-note-pack__canvas';
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
      color: initial.color,
      star: initial.star,
      foldPosition: props().foldPosition,
      rotationOffsetDegrees: props().rotationOffsetDegrees,
      verticalPosition: props().verticalPosition,
      sizeScale: props().sizeScale,
      effectSettings: props().effectSettings,
    });
  } catch (error) {
    renderer.dispose();
    renderer.forceContextLoss();
    renderer.domElement.remove();
    props().onError(error instanceof Error ? error : new Error('Unable to create the pack.'));
    return null;
  }
  scene.add(model.group);
  const sparkles = createMiNoteTapSparkles();
  scene.add(sparkles.points);
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const viewport = () => ({ width, height, pixelRatio });
  const invalidate = () => loop?.invalidate();
  const assets = createMiNoteCardAssets({ model, scene, camera, renderer, props, active, invalidate,
    beforeClear: () => interaction.cancel(), afterClear: () => motion.clearSelection() });
  const motion = createMiNotePackMotion({ host, model, assets, scene, camera, sparkles, props,
    reducedMotion: () => reducedMotion.matches, playSound, invalidate });
  const interaction = createMiNotePackInteraction({ host, model, assets, scene, camera, motion, sparkles, props, viewport,
    reducedMotion: () => reducedMotion.matches, disposed: () => disposed, failed: () => failed, soundEnabled, playSound, invalidate });
  props().controlsRef.current = interaction.controls;

  function updateDrawingBuffer(nextWidth = width, nextHeight = height) {
    const densityLimit = props().state.selectedCard === null ? 2 : 3;
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

  loop = createMiNoteFrameLoop(active, (now, deltaSeconds) => {
    if (interaction.cancelDisabledInteraction()) return;
    updateDrawingBuffer();
    const moving = motion.step(now, deltaSeconds, viewport(), interaction.motionGesture());
    scene.updateMatrixWorld(true);
    camera.updateMatrixWorld(true);
    assets.updateMaterials();
    try {
      renderer.render(scene, camera);
    } catch (error) {
      fail(error instanceof Error ? error : new Error('Unable to render this pack.'));
    }
    if (failed) return;
    if (packReadyPending) {
      packReadyPending = false;
      props().onReadyChange(true);
    }
    assets.commitReady();
    props().onFrameRendered?.();
    return moving;
  });

  const resize = () => {
    if (updateDrawingBuffer(Math.max(1, host.clientWidth), Math.max(1, host.clientHeight))) invalidate();
  };
  const handleContextLost = (event: Event) => {
    event.preventDefault();
    interaction.cancel();
    fail(new Error('The pack display was interrupted. Please retry.'));
  };
  const handleVisibility = () => {
    interaction.blur();
    if (document.hidden) {
      sparkles.clear();
      loop!.stop();
    } else if (soundEnabled()) {
      void preloadMiNotePackSounds();
    }
    loop!.resetClock();
    invalidate();
  };
  const observer = new ResizeObserver(resize);
  observer.observe(host);
  document.addEventListener('visibilitychange', handleVisibility);
  reducedMotion.addEventListener('change', invalidate);
  renderer.domElement.addEventListener('webglcontextlost', handleContextLost);
  props().onReadyChange(false);
  resize();
  assets.update(props().cards, props().cardEffect);
  void model.ready.then(() => {
    if (!active()) return;
    renderer.compile(scene, camera);
    if (failed) return;
    packReadyPending = true;
    invalidate();
  }).catch((error: unknown) => {
    fail(error instanceof Error ? error : new Error('Unable to load the pack.'));
  });

  return {
    invalidate,
    updateCards: assets.update,
    updateEffectSettings: model.setSealEffectSettings,
    dispose() {
      disposed = true;
      interaction.cancel();
      loop!.dispose();
      if (props().controlsRef.current === interaction.controls) props().controlsRef.current = null;
      observer.disconnect();
      document.removeEventListener('visibilitychange', handleVisibility);
      reducedMotion.removeEventListener('change', invalidate);
      renderer.domElement.removeEventListener('webglcontextlost', handleContextLost);
      interaction.dispose();
      assets.dispose();
      sparkles.dispose();
      model.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      renderer.domElement.remove();
    },
  };
}

export type MiNotePackViewerRuntime = NonNullable<ReturnType<typeof createMiNotePackViewerRuntime>>;
