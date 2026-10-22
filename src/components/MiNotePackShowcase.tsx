import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { createMiNotePackModel } from '../lib/miNotePackModel';
import { MI_NOTE_PACK_STARS } from '../lib/miNotePackStars';
import {
  MI_NOTE_PACK_RENDER_REGISTRY,
  addMiNotePackRenderLights,
  applyMiNotePackRenderPose,
  applyMiNotePackTextureQuality,
  configureMiNotePackRenderer,
  getMiNotePackRenderSetup,
  getMiNotePackRenderSetupByPackId,
  restoreMiNotePackRenderCamera,
} from '../lib/miNotePackRenderSetup';
import { MI_NOTE_PACK_SHOWCASE_VERTICAL_OVERSCAN, sampleMiNotePackShowcase } from '../lib/miNotePackShowcaseMotion';
import type { PrimaryMediaControls } from './MediaWithFallback';

type PackModel = ReturnType<typeof createMiNotePackModel>;

export default function MiNotePackShowcase({ media }: { media: PrimaryMediaControls }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const mediaRef = useRef(media);
  mediaRef.current = media;
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const setup = getMiNotePackRenderSetupByPackId(1)!;
    const { shared } = MI_NOTE_PACK_RENDER_REGISTRY;
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const models = new Map<string, PackModel>();
    const readyStars = new Set<string>();
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera();
    let renderer: THREE.WebGLRenderer | undefined;
    let resizeObserver: ResizeObserver | undefined;
    let intersectionObserver: IntersectionObserver | undefined;
    let disposed = false;
    let shaderFailed = false;
    let assetsReady = false;
    let intersecting = true;
    let pageActive = true;
    let frameId = 0;
    let modelTask: ReturnType<typeof setTimeout> | undefined;
    let pendingStars = MI_NOTE_PACK_STARS.length;
    let lastTime: number | null = null;
    let elapsed = 0;
    let fadeElapsed = 0;
    let rendered = false;
    let handoffComplete = false;
    let currentPackId = 0;
    let currentSetup = setup;
    let width = 0;
    let height = 0;
    const baseRotation = setup.model.rotationDegrees.map(THREE.MathUtils.degToRad);

    const pause = () => {
      cancelAnimationFrame(frameId);
      frameId = 0;
      lastTime = null;
    };
    const canRender = () => !disposed && assetsReady && intersecting && pageActive && !document.hidden && width > 0 && height > 0;
    const schedule = () => {
      if (canRender() && !frameId) frameId = requestAnimationFrame(render);
    };
    const dispose = () => {
      if (disposed) return;
      disposed = true;
      pause();
      clearTimeout(modelTask);
      resizeObserver?.disconnect();
      intersectionObserver?.disconnect();
      document.removeEventListener('visibilitychange', handleVisibility);
      window.removeEventListener('pagehide', handlePageHide);
      window.removeEventListener('pageshow', handlePageShow);
      reducedMotion.removeEventListener('change', handleMotionPreference);
      renderer?.domElement.removeEventListener('webglcontextlost', handleContextLost);
      for (const model of models.values()) model.dispose();
      models.clear();
      renderer?.dispose();
      renderer?.forceContextLoss();
      renderer?.domElement.remove();
    };
    const fail = () => {
      if (disposed) return;
      setVisible(false);
      mediaRef.current.onError();
      dispose();
    };

    function render(now: number) {
      frameId = 0;
      if (!canRender() || !renderer) return;
      const dt = lastTime === null ? 0 : Math.min(Math.max(0, (now - lastTime) / 1000), 0.05);
      lastTime = now;
      if (handoffComplete && !reducedMotion.matches) elapsed += dt;
      else if (rendered) fadeElapsed += dt;
      const motion = sampleMiNotePackShowcase(reducedMotion.matches ? 0 : elapsed, baseRotation[1]);
      if (motion.variantId !== currentSetup.variantId) {
        const candidates = MI_NOTE_PACK_STARS.filter(star => readyStars.has(star.id) && star.id !== currentSetup.sticker.id);
        const star = candidates[Math.floor(Math.random() * candidates.length)];
        currentSetup = getMiNotePackRenderSetup(motion.variantId, star?.id ?? currentSetup.sticker.id)!;
      }
      const model = models.get(currentSetup.sticker.id)!;
      try {
        if (currentSetup.packId !== currentPackId) {
          for (const candidate of models.values()) candidate.group.visible = candidate === model;
          model.setColor(currentSetup.color);
          applyMiNotePackRenderPose(model, currentSetup);
          currentPackId = currentSetup.packId;
          host!.dataset.packId = String(currentPackId);
        }
        model.group.rotation.set(
          baseRotation[0] + motion.rotationX,
          baseRotation[1] + motion.rotationY,
          baseRotation[2] + motion.rotationZ,
          setup.model.rotationOrder,
        );
        model.group.position.fromArray(setup.model.position);
        model.group.position.y += motion.offsetY;
        model.group.scale.fromArray(setup.model.scale).multiplyScalar(motion.scale);
        renderer.render(scene, camera);
      } catch {
        fail();
        return;
      }
      if (shaderFailed) {
        fail();
        return;
      }
      if (!rendered) {
        rendered = true;
        setVisible(true);
      }
      if (!handoffComplete && (reducedMotion.matches || fadeElapsed >= 0.65)) {
        handoffComplete = true;
        mediaRef.current.onReady();
      }
      if (!reducedMotion.matches) schedule();
    }

    function resize() {
      if (disposed || !renderer) return;
      width = host!.clientWidth;
      height = host!.clientHeight;
      if (!width || !height) {
        pause();
        return;
      }
      try {
        const canvasHeight = height * MI_NOTE_PACK_SHOWCASE_VERTICAL_OVERSCAN;
        renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2) / Math.sqrt(MI_NOTE_PACK_SHOWCASE_VERTICAL_OVERSCAN));
        renderer.setSize(width, canvasHeight);
        restoreMiNotePackRenderCamera(camera, setup);
        camera.aspect = width / canvasHeight;
        camera.zoom = setup.camera.zoom * Math.min(width / shared.output.width, height / shared.output.height) * shared.output.height / canvasHeight;
        camera.updateProjectionMatrix();
        schedule();
      } catch {
        fail();
      }
    }

    function handleVisibility() {
      pause();
      schedule();
    }
    function handlePageHide() {
      pageActive = false;
      pause();
    }
    function handlePageShow() {
      pageActive = true;
      pause();
      resize();
    }
    function handleMotionPreference() {
      elapsed = 0;
      currentSetup = readyStars.has(setup.sticker.id)
        ? setup
        : getMiNotePackRenderSetup('cobalt-blue', currentSetup.sticker.id)!;
      pause();
      schedule();
    }
    function handleContextLost(event: Event) {
      event.preventDefault();
      fail();
    }

    function loadModel(index: number) {
      if (disposed || !renderer) return;
      const star = MI_NOTE_PACK_STARS[index];
      try {
        const starSetup = getMiNotePackRenderSetup('cobalt-blue', star.id)!;
        const model = createMiNotePackModel({
          color: starSetup.color,
          star,
          foldPosition: starSetup.sticker.foldPosition,
          rotationOffsetDegrees: starSetup.sticker.rotationOffsetDegrees,
          verticalPosition: starSetup.sticker.verticalPosition,
          sizeScale: starSetup.sticker.sizeScale,
          effectSettings: starSetup.sticker.effectSettings,
        });
        models.set(star.id, model);
        void model.ready.then(() => {
          if (disposed || !renderer) return;
          pendingStars -= 1;
          try {
            renderer.compile(model.group, camera, scene);
            if (shaderFailed) {
              fail();
              return;
            }
            readyStars.add(star.id);
            if (!assetsReady) currentSetup = starSetup;
            assetsReady = true;
            schedule();
          } catch {
            fail();
          }
        }, () => {
          if (disposed) return;
          pendingStars -= 1;
          models.delete(star.id);
          model.dispose();
          if (!pendingStars && !readyStars.size) fail();
        });
        applyMiNotePackRenderPose(model, starSetup);
        applyMiNotePackTextureQuality(model.group, renderer, shared);
        model.group.visible = false;
        scene.add(model.group);
        if (index + 1 < MI_NOTE_PACK_STARS.length) {
          modelTask = setTimeout(() => loadModel(index + 1), 0);
        }
      } catch {
        fail();
      }
    }

    setVisible(false);
    mediaRef.current.onLoading();
    try {
      renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
      renderer.debug.checkShaderErrors = true;
      renderer.debug.onShaderError = () => { shaderFailed = true; };
      renderer.domElement.setAttribute('aria-hidden', 'true');
      configureMiNotePackRenderer(renderer, shared);
      addMiNotePackRenderLights(scene, shared);
      host.append(renderer.domElement);
      renderer.domElement.addEventListener('webglcontextlost', handleContextLost);
      resizeObserver = new ResizeObserver(resize);
      resizeObserver.observe(host);
      if (typeof IntersectionObserver !== 'undefined') {
        intersectionObserver = new IntersectionObserver(([entry]) => {
          intersecting = entry.isIntersecting;
          pause();
          schedule();
        });
        intersectionObserver.observe(host);
      }
      document.addEventListener('visibilitychange', handleVisibility);
      window.addEventListener('pagehide', handlePageHide);
      window.addEventListener('pageshow', handlePageShow);
      reducedMotion.addEventListener('change', handleMotionPreference);
      resize();
      if (disposed) return dispose;
      loadModel(0);
    } catch {
      fail();
    }
    return dispose;
  }, []);

  return <div ref={hostRef} className="mint-panel__box mint-panel__box--showcase" data-visible={visible} aria-hidden="true" />;
}
