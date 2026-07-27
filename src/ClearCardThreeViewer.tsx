import {
  useCallback,
  useEffect,
  useRef,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import * as THREE from 'three';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const CLEAR_CARD_MODEL_URL = '/clear_card_sample.glb';
const DRACO_DECODER_PATH = '/draco/0.185.1/';
const MAX_PIXEL_RATIO = 2;
const MAX_TILT_X = THREE.MathUtils.degToRad(8);
const MAX_TILT_Y = THREE.MathUtils.degToRad(11);
const SPRING_STIFFNESS = 72;
const SPRING_DAMPING = 15;
const SPRING_EPSILON = 0.0001;

type ViewerStatus = 'loading' | 'ready' | 'error';

type ClearCardThreeViewerProps = {
  ready: boolean;
  onStatusChange: (status: ViewerStatus) => void;
};

type TiltState = {
  currentX: number;
  currentY: number;
  targetX: number;
  targetY: number;
  velocityX: number;
  velocityY: number;
};

type InteractionState = {
  pointerId: number | null;
};

function disposeObject3D(root: THREE.Object3D) {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  const textures = new Set<THREE.Texture>();

  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    geometries.add(object.geometry);
    const objectMaterials = Array.isArray(object.material) ? object.material : [object.material];
    objectMaterials.forEach((material) => {
      materials.add(material);
      Object.values(material as unknown as Record<string, unknown>).forEach((value) => {
        if (value instanceof THREE.Texture) textures.add(value);
      });
    });
  });

  textures.forEach((texture) => {
    const image = texture.source.data as { close?: () => void } | null;
    image?.close?.();
    texture.dispose();
  });
  materials.forEach((material) => material.dispose());
  geometries.forEach((geometry) => geometry.dispose());
}

function stepTiltAxis(
  current: number,
  target: number,
  velocity: number,
  deltaSeconds: number,
): { current: number; velocity: number } {
  const acceleration = (target - current) * SPRING_STIFFNESS - velocity * SPRING_DAMPING;
  const nextVelocity = velocity + acceleration * deltaSeconds;
  return {
    current: current + nextVelocity * deltaSeconds,
    velocity: nextVelocity,
  };
}

export default function ClearCardThreeViewer({
  ready,
  onStatusChange,
}: ClearCardThreeViewerProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const requestRenderRef = useRef<(() => void) | null>(null);
  const reducedMotionRef = useRef(false);
  const viewerReadyRef = useRef(false);
  const interactionRef = useRef<InteractionState>({ pointerId: null });
  const tiltRef = useRef<TiltState>({
    currentX: 0,
    currentY: 0,
    targetX: 0,
    targetY: 0,
    velocityX: 0,
    velocityY: 0,
  });
  const resetTilt = useCallback(() => {
    interactionRef.current.pointerId = null;
    tiltRef.current.targetX = 0;
    tiltRef.current.targetY = 0;
    requestRenderRef.current?.();
  }, []);

  const updateTilt = useCallback((event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!viewerReadyRef.current || reducedMotionRef.current) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return;
    const pointerX = THREE.MathUtils.clamp((event.clientX - bounds.left) / bounds.width, 0, 1);
    const pointerY = THREE.MathUtils.clamp((event.clientY - bounds.top) / bounds.height, 0, 1);
    tiltRef.current.targetX = -(pointerY * 2 - 1) * MAX_TILT_X;
    tiltRef.current.targetY = (pointerX * 2 - 1) * MAX_TILT_Y;
    requestRenderRef.current?.();
  }, []);

  const handlePointerEnter = useCallback(
    (event: ReactPointerEvent<HTMLCanvasElement>) => {
      if (event.pointerType === 'mouse') updateTilt(event);
    },
    [updateTilt],
  );

  const handlePointerMove = useCallback(
    (event: ReactPointerEvent<HTMLCanvasElement>) => {
      if (
        event.pointerType === 'mouse' ||
        interactionRef.current.pointerId === event.pointerId
      ) {
        updateTilt(event);
      }
    },
    [updateTilt],
  );

  const handlePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLCanvasElement>) => {
      if (event.pointerType !== 'mouse') {
        interactionRef.current.pointerId = event.pointerId;
        event.currentTarget.setPointerCapture(event.pointerId);
      }
      updateTilt(event);
    },
    [updateTilt],
  );

  const handlePointerUp = useCallback(
    (event: ReactPointerEvent<HTMLCanvasElement>) => {
      if (event.pointerType === 'mouse') return;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      resetTilt();
    },
    [resetTilt],
  );

  const handlePointerLeave = useCallback(
    (event: ReactPointerEvent<HTMLCanvasElement>) => {
      if (event.pointerType === 'mouse') resetTilt();
    },
    [resetTilt],
  );

  const handlePointerCancel = useCallback(
    (event: ReactPointerEvent<HTMLCanvasElement>) => {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      resetTilt();
    },
    [resetTilt],
  );

  useEffect(() => {
    window.addEventListener('blur', resetTilt);
    return () => window.removeEventListener('blur', resetTilt);
  }, [resetTilt]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const viewport = canvas.parentElement;
    if (!viewport) return undefined;

    let disposed = false;
    let contextLost = false;
    let modelLoadFailed = false;
    let initializationFrameId: number | null = null;
    let frameId: number | null = null;
    let lastFrameTime = 0;
    let renderer: THREE.WebGLRenderer | null = null;
    let dracoLoader: DRACOLoader | null = null;
    let loadingManager: THREE.LoadingManager | null = null;
    let resizeObserver: ResizeObserver | null = null;
    let modelRoot: THREE.Object3D | null = null;
    let motionQuery: MediaQueryList | null = null;
    let handleMotionPreference: (() => void) | null = null;
    let handleVisibilityChange: (() => void) | null = null;
    let handleContextLost: ((event: Event) => void) | null = null;
    let handleContextRestored: (() => void) | null = null;
    let resize: (() => void) | null = null;
    const modelSize = new THREE.Vector3();
    const scene = new THREE.Scene();
    const pivot = new THREE.Group();
    const camera = new THREE.PerspectiveCamera(28, 1, 0.01, 100);
    scene.add(pivot);

    const fitCamera = () => {
      if (!modelRoot) return;
      const verticalFov = THREE.MathUtils.degToRad(camera.fov);
      const fitHeightDistance = modelSize.y / (2 * Math.tan(verticalFov / 2));
      const fitWidthDistance =
        modelSize.x / (2 * Math.tan(verticalFov / 2) * Math.max(camera.aspect, 0.01));
      const distance = Math.max(fitHeightDistance, fitWidthDistance) * 1.14 + modelSize.z / 2;
      camera.position.set(0, 0, Math.max(distance, 0.1));
      camera.lookAt(0, 0, 0);
      camera.updateProjectionMatrix();
    };

    const renderFrame = (now: number) => {
      frameId = null;
      if (disposed || !renderer || document.visibilityState !== 'visible') return;

      const deltaSeconds = lastFrameTime
        ? Math.min((now - lastFrameTime) / 1_000, 1 / 30)
        : 1 / 60;
      lastFrameTime = now;
      const tilt = tiltRef.current;

      if (reducedMotionRef.current) {
        tilt.currentX = 0;
        tilt.currentY = 0;
        tilt.targetX = 0;
        tilt.targetY = 0;
        tilt.velocityX = 0;
        tilt.velocityY = 0;
      } else {
        const nextX = stepTiltAxis(
          tilt.currentX,
          tilt.targetX,
          tilt.velocityX,
          deltaSeconds,
        );
        const nextY = stepTiltAxis(
          tilt.currentY,
          tilt.targetY,
          tilt.velocityY,
          deltaSeconds,
        );
        tilt.currentX = nextX.current;
        tilt.currentY = nextY.current;
        tilt.velocityX = nextX.velocity;
        tilt.velocityY = nextY.velocity;
      }

      pivot.rotation.x = tilt.currentX;
      pivot.rotation.y = tilt.currentY;
      renderer.render(scene, camera);

      const unsettled =
        Math.abs(tilt.targetX - tilt.currentX) > SPRING_EPSILON ||
        Math.abs(tilt.targetY - tilt.currentY) > SPRING_EPSILON ||
        Math.abs(tilt.velocityX) > SPRING_EPSILON ||
        Math.abs(tilt.velocityY) > SPRING_EPSILON;
      if (unsettled) {
        frameId = window.requestAnimationFrame(renderFrame);
      } else {
        tilt.currentX = tilt.targetX;
        tilt.currentY = tilt.targetY;
        tilt.velocityX = 0;
        tilt.velocityY = 0;
        lastFrameTime = 0;
      }
    };

    const requestRender = () => {
      if (disposed || frameId !== null) return;
      lastFrameTime = 0;
      frameId = window.requestAnimationFrame(renderFrame);
    };

    const initializeViewer = () => {
      initializationFrameId = null;
      if (disposed) return;
      requestRenderRef.current = requestRender;

      resize = () => {
        if (disposed || !renderer) return;
        const width = Math.max(1, viewport.clientWidth);
        const height = Math.max(1, viewport.clientHeight);
        renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO));
        renderer.setSize(width, height, false);
        camera.aspect = width / height;
        fitCamera();
        requestRender();
      };

      try {
        renderer = new THREE.WebGLRenderer({
          canvas,
          alpha: true,
          antialias: true,
          powerPreference: 'high-performance',
        });
        renderer.setClearColor(0x000000, 0);
        renderer.outputColorSpace = THREE.SRGBColorSpace;
      } catch (error) {
        console.error('[mons] failed to initialize the clear-card viewer', error);
        requestRenderRef.current = null;
        onStatusChange('error');
        return;
      }

      handleContextLost = (event) => {
        event.preventDefault();
        if (disposed) return;
        contextLost = true;
        viewerReadyRef.current = false;
        onStatusChange('error');
      };
      handleContextRestored = () => {
        if (disposed) return;
        contextLost = false;
        const restoredReady = Boolean(modelRoot) && !modelLoadFailed;
        viewerReadyRef.current = restoredReady;
        onStatusChange(modelLoadFailed ? 'error' : restoredReady ? 'ready' : 'loading');
        requestRender();
      };
      canvas.addEventListener('webglcontextlost', handleContextLost);
      canvas.addEventListener('webglcontextrestored', handleContextRestored);

      motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
      handleMotionPreference = () => {
        if (!motionQuery) return;
        reducedMotionRef.current = motionQuery.matches;
        if (motionQuery.matches) {
          const tilt = tiltRef.current;
          tilt.currentX = 0;
          tilt.currentY = 0;
          tilt.targetX = 0;
          tilt.targetY = 0;
          tilt.velocityX = 0;
          tilt.velocityY = 0;
        }
        requestRender();
      };
      handleMotionPreference();
      motionQuery.addEventListener('change', handleMotionPreference);

      handleVisibilityChange = () => {
        if (document.visibilityState === 'visible') requestRender();
      };
      document.addEventListener('visibilitychange', handleVisibilityChange);
      window.addEventListener('resize', resize);
      if (typeof ResizeObserver !== 'undefined') {
        resizeObserver = new ResizeObserver(resize);
        resizeObserver.observe(viewport);
      }
      resize();

      loadingManager = new THREE.LoadingManager();
      dracoLoader = new DRACOLoader(loadingManager);
      dracoLoader.setDecoderPath(DRACO_DECODER_PATH);
      dracoLoader.setWorkerLimit(1);
      const modelLoader = new GLTFLoader(loadingManager);
      modelLoader.setDRACOLoader(dracoLoader);

      void modelLoader
        .loadAsync(CLEAR_CARD_MODEL_URL)
        .then((gltf) => {
          if (disposed) {
            disposeObject3D(gltf.scene);
            return;
          }

          modelRoot = gltf.scene;
          const bounds = new THREE.Box3().setFromObject(modelRoot);
          const center = bounds.getCenter(new THREE.Vector3());
          modelRoot.position.sub(center);
          new THREE.Box3().setFromObject(modelRoot).getSize(modelSize);
          pivot.add(modelRoot);
          fitCamera();
          viewerReadyRef.current = !contextLost;
          onStatusChange(contextLost ? 'error' : 'ready');
          if (!contextLost) requestRender();
        })
        .catch((error: unknown) => {
          if (disposed) return;
          modelLoadFailed = true;
          console.error('[mons] failed to load the clear-card model', error);
          onStatusChange('error');
        })
        .finally(() => {
          dracoLoader?.dispose();
          dracoLoader = null;
        });
    };

    initializationFrameId = window.requestAnimationFrame(initializeViewer);

    return () => {
      disposed = true;
      viewerReadyRef.current = false;
      requestRenderRef.current = null;
      loadingManager?.abort();
      if (initializationFrameId !== null) {
        window.cancelAnimationFrame(initializationFrameId);
      }
      if (motionQuery && handleMotionPreference) {
        motionQuery.removeEventListener('change', handleMotionPreference);
      }
      if (handleVisibilityChange) {
        document.removeEventListener('visibilitychange', handleVisibilityChange);
      }
      if (handleContextLost) {
        canvas.removeEventListener('webglcontextlost', handleContextLost);
      }
      if (handleContextRestored) {
        canvas.removeEventListener('webglcontextrestored', handleContextRestored);
      }
      if (resize) window.removeEventListener('resize', resize);
      resizeObserver?.disconnect();
      if (frameId !== null) window.cancelAnimationFrame(frameId);
      dracoLoader?.dispose();
      dracoLoader = null;
      if (modelRoot) disposeObject3D(modelRoot);
      renderer?.renderLists.dispose();
      renderer?.dispose();
      renderer?.forceContextLoss();
    };
  }, [onStatusChange]);

  return (
    <canvas
      ref={canvasRef}
      className="clear-card-wip__canvas"
      role="img"
      aria-label="Interactive 3D clear card sample"
      aria-hidden={!ready}
      onPointerEnter={handlePointerEnter}
      onPointerMove={handlePointerMove}
      onPointerDown={handlePointerDown}
      onPointerUp={handlePointerUp}
      onPointerLeave={handlePointerLeave}
      onPointerCancel={handlePointerCancel}
      onLostPointerCapture={resetTilt}
    />
  );
}
