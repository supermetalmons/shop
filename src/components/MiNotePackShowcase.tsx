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
import { sampleMiNotePackShowcase } from '../lib/miNotePackShowcaseMotion';
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
    let lastTime: number | null = null;
    let elapsed = 0;
    let fadeElapsed = 0;
    let rendered = false;
    let handoffComplete = false;
    let currentPackId = 0;
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
      const currentSetup = getMiNotePackRenderSetupByPackId(motion.packId)!;
      const model = models.get(currentSetup.sticker.id)!;
      try {
        if (motion.packId !== currentPackId) {
          for (const candidate of models.values()) candidate.group.visible = candidate === model;
          model.setColor(currentSetup.color);
          applyMiNotePackRenderPose(model, currentSetup);
          currentPackId = motion.packId;
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
        renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
        renderer.setSize(width, height);
        restoreMiNotePackRenderCamera(camera, setup);
        camera.aspect = width / height;
        camera.zoom = setup.camera.zoom * Math.min(width / shared.output.width, height / shared.output.height) * shared.output.height / height;
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
      pause();
      schedule();
    }
    function handleContextLost(event: Event) {
      event.preventDefault();
      fail();
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
      const loaded = MI_NOTE_PACK_STARS.map((star) => {
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
        const ready = model.ready.catch(fail);
        models.set(star.id, model);
        applyMiNotePackRenderPose(model, starSetup);
        applyMiNotePackTextureQuality(model.group, renderer!, shared);
        scene.add(model.group);
        return ready;
      });
      void Promise.all(loaded).then(() => {
        if (disposed || !renderer) return;
        try {
          renderer.compile(scene, camera);
          if (shaderFailed) {
            fail();
            return;
          }
          assetsReady = true;
          schedule();
        } catch {
          fail();
        }
      });
    } catch {
      fail();
    }
    return dispose;
  }, []);

  return <div ref={hostRef} className="mint-panel__box mint-panel__box--showcase" data-visible={visible} aria-hidden="true" />;
}
