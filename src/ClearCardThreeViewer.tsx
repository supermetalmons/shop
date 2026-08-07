import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import type {
  ClearCardLightingConfig,
  LightStage,
  SkyEnvironmentConfig,
  ToneMappingMode,
} from './clearCardLighting';
import {
  findOpaquePixelBounds,
  padPixelBounds,
  resolveSnapshotOutputSize,
} from './lib/clearCardSnapshot';
import {
  createSnapBackState,
  releaseSnapBack,
  resetSnapBackTracking,
  settleSnapBackInstantly,
  stepSnapBackSpring,
  trackSnapBackVelocity,
} from './lib/clearCardSnapBack';
import {
  createAdaptiveFrameRateMonitor,
  resolveMedianFrameInterval,
  resolveAdaptiveSlowFrameThreshold,
} from './lib/adaptiveFrameRate';
import {
  advanceClearCardGatedHit,
  createClearCardGatedHitState,
  isClearCardImpactPointer,
  type ClearCardGatedHitState,
} from './lib/clearCardReveal';
import { clearCardModelLoadDecision } from './lib/clearCardModels';

const DRACO_DECODER_PATH = '/draco/0.185.1/';
const MAX_PIXEL_RATIO = 2;
const CANVAS_OVERSCAN = 1.5;
const INTERACTION_FRAME_INTERVAL_MS = 1_000 / 30;
const ADAPTIVE_INTERACTION_THROTTLE_SESSION_KEY =
  'mons.clear-card.interaction-throttle-required.v1';
const ADAPTIVE_THROTTLE_REPROBE_MS = 60_000;
const DISPLAY_CADENCE_SAMPLE_SIZE = 8;
const DISPLAY_CADENCE_MAX_ATTEMPTS = 24;
const DISPLAY_CADENCE_MAX_INTERVAL_MS = 100;
const CAMERA_FIT_MARGIN = 1.06;
const MAX_TILT_X = THREE.MathUtils.degToRad(25);
const MAX_TILT_Y = THREE.MathUtils.degToRad(14);
const SPRING_STIFFNESS = 60;
const SPRING_DAMPING = 11;
const SPRING_EPSILON = 0.0001;
const UNRESTRICTED_ROTATION_SPEED = Math.PI / 300;
const UNRESTRICTED_DRAG_THRESHOLD_SQ = 16;
const MAX_VERTICAL_ORBIT = THREE.MathUtils.degToRad(45);
const WORLD_UP = new THREE.Vector3(0, 1, 0);

const HITS_TO_BREAK = 9;
const HEALABLE_HITS = 5;
const HIT_INTENSITIES = [1, 1.3, 1.7] as const;

const CRACK_APPEAR_S = 0.1;
const CRACK_HOLD_S = 0.45;
const CRACK_HEAL_S = 0.6;
const CRACK_MAX_OPACITY = 1;
const CRACK_PERMANENT_OPACITY = 0.92;
const CRACK_HEALABLE_RADIUS_FACTOR = 0.12;
const CRACK_PERMANENT_RADIUS_FACTOR = 0.15;
const CRACK_SURFACE_OFFSET_FACTOR = 0.004;
const SHARD_CRACK_IMPULSE = 0.22;
const SHARD_IMPACT_IMPULSE = 0.3;
const SHARD_IMPULSE_FALLOFF_RADIUS = 0.45;
const PUNCH_SPRING_STIFFNESS = 190;
const PUNCH_SPRING_DAMPING = 14;
const PUNCH_SCALE_IMPULSE = 0.9;
const HIT_TILT_JOLT = 0.9;

const CARD_EMBED_FACTOR = 0.9;

const BREAK_SHARDS_HIDE_S = 0.95;
const BREAK_REVEAL_INTERACTIVE_S = 1;
const SHARD_GRAVITY_FACTOR = 9;
const SHARD_SIDE_DRIFT_DAMPING = 6;
const SHARD_SIDE_CENTERING = 3;
const SHARD_SIDE_CENTERING_RAMP_S = 0.4;

const MAX_SPARKLES = 64;
const HIT_SPARKLE_COUNT = 12;
const BREAK_SPARKLE_COUNT = 28;
const TRANSMISSIVE_PACK_ROTATION_X = THREE.MathUtils.degToRad(7);
const TRANSMISSIVE_PACK_ROTATION_Y = THREE.MathUtils.degToRad(-4);
const TRANSMISSION_RESOLUTION_SCALE_DEFAULT = 1;
const TRANSMISSION_RESOLUTION_SCALE_SHARDS = 0.5;
const SNAPSHOT_ANALYSIS_LONGEST_EDGE = 1024;
const SNAPSHOT_OUTPUT_LONGEST_EDGE = 1400;
const SNAPSHOT_PADDING_RATIO = 0.02;

const SHARD_LAYER = 1;

let rectAreaLightSupportPromise: Promise<void> | null = null;

function loadRectAreaLightSupport() {
  if (!rectAreaLightSupportPromise) {
    rectAreaLightSupportPromise = import(
      'three/addons/lights/RectAreaLightUniformsLib.js'
    )
      .then(({ RectAreaLightUniformsLib }) => {
        RectAreaLightUniformsLib.init();
      })
      .catch((error) => {
        rectAreaLightSupportPromise = null;
        throw error;
      });
  }
  return rectAreaLightSupportPromise;
}

function createSkyEnvironmentTexture(config: SkyEnvironmentConfig): THREE.DataTexture {
  const width = config.resolution;
  const height = width / 2;
  const data = new Float32Array(width * height * 4);
  const ground = new THREE.Color(config.groundColor).multiplyScalar(config.groundIntensity);
  const horizon = new THREE.Color(config.horizonColor).multiplyScalar(config.horizonIntensity);
  const zenith = new THREE.Color(config.zenithColor).multiplyScalar(config.zenithIntensity);
  const keyColor = new THREE.Color(config.keyColor);
  const keyLatitude = THREE.MathUtils.degToRad(config.keyLatitude);
  const keyLongitude = THREE.MathUtils.degToRad(config.keyLongitude);
  const keyRadius = THREE.MathUtils.degToRad(config.keyRadius);
  const keyX = Math.cos(keyLatitude) * Math.sin(keyLongitude);
  const keyY = Math.sin(keyLatitude);
  const keyZ = Math.cos(keyLatitude) * Math.cos(keyLongitude);
  const cosRadius = Math.cos(keyRadius);

  for (let y = 0; y < height; y += 1) {
    const latitude = (0.5 - (y + 0.5) / height) * Math.PI;
    const sinLat = Math.sin(latitude);
    const cosLat = Math.cos(latitude);
    const blend = Math.abs(sinLat);
    const target = sinLat >= 0 ? zenith : ground;
    const baseR = horizon.r + (target.r - horizon.r) * blend;
    const baseG = horizon.g + (target.g - horizon.g) * blend;
    const baseB = horizon.b + (target.b - horizon.b) * blend;

    for (let x = 0; x < width; x += 1) {
      const longitude = ((x + 0.5) / width) * Math.PI * 2 - Math.PI;
      const dot =
        cosLat * Math.sin(longitude) * keyX + sinLat * keyY + cosLat * Math.cos(longitude) * keyZ;
      let key = 0;
      if (dot > cosRadius) {
        key =
          config.keyIntensity *
          Math.pow((dot - cosRadius) / (1 - cosRadius), config.keyFalloff);
      }
      const offset = (y * width + x) * 4;
      data[offset] = baseR + keyColor.r * key;
      data[offset + 1] = baseG + keyColor.g * key;
      data[offset + 2] = baseB + keyColor.b * key;
      data[offset + 3] = 1;
    }
  }

  const texture = new THREE.DataTexture(
    data,
    width,
    height,
    THREE.RGBAFormat,
    THREE.FloatType,
  );
  texture.mapping = THREE.EquirectangularReflectionMapping;
  texture.colorSpace = THREE.LinearSRGBColorSpace;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return texture;
}

function resolveToneMapping(mode: ToneMappingMode): THREE.ToneMapping {
  switch (mode) {
    case 'none':
      return THREE.NoToneMapping;
    case 'reinhard':
      return THREE.ReinhardToneMapping;
    case 'cineon':
      return THREE.CineonToneMapping;
    case 'aces':
      return THREE.ACESFilmicToneMapping;
    case 'agx':
      return THREE.AgXToneMapping;
    case 'neutral':
      return THREE.NeutralToneMapping;
    case 'linear':
    default:
      return THREE.LinearToneMapping;
  }
}

function lightMatchesStage(scope: LightStage, stage: ClearCardDisplayStage) {
  if (scope === 'all') return true;
  return scope === 'pack' ? stage === 'pack' : stage !== 'pack';
}

export type ViewerStatus = 'loading' | 'ready' | 'error';
export type ClearCardModelLoadStatus = 'idle' | 'loading' | 'ready' | 'error';
type ClearCardViewMode = 'tilt' | 'free' | 'orbit';
type InteractionFrameRateMode = 'unrestricted' | 'throttled' | 'adaptive';
type ClearCardHitProgressionMode = 'fixed' | 'reveal-gated';

export type ClearCardDisplayStage = 'pack' | 'breaking' | 'revealed';

type ClearCardSnapshot = {
  blob: Blob;
  objectKind: 'pack' | 'card';
};

export type ClearCardThreeViewerHandle = {
  reset: () => void;
  hit: () => void;
  retryCardModel: () => void;
  captureSnapshot: () => Promise<ClearCardSnapshot>;
};

type ClearCardThreeViewerProps = {
  ready: boolean;
  cardModelUrl?: string;
  packModelUrl?: string;
  lightingConfig: ClearCardLightingConfig;
  unrestrictedMovement: boolean;
  axisLockedOrbit: boolean;
  snapBackOnRelease?: boolean;
  interactionFrameRateMode?: InteractionFrameRateMode;
  interactionEnabled?: boolean;
  hitProgressionMode?: ClearCardHitProgressionMode;
  revealReady?: boolean;
  initiallyRevealed: boolean;
  cameraZoom?: number;
  ariaLabel?: string;
  onStatusChange: (status: ViewerStatus) => void;
  onCardModelLoadStatusChange?: (status: ClearCardModelLoadStatus) => void;
  onStageChange?: (stage: ClearCardDisplayStage) => void;
  onPackHit?: (hitIndex: number) => void;
  onPackBreak?: () => void;
};

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

type SpringValue = {
  current: number;
  target: number;
  velocity: number;
};

type PackShard = {
  holder: THREE.Group;
  home: THREE.Vector3;
  velocity: THREE.Vector3;
  angularVelocity: THREE.Vector3;
};

type PackCrack = {
  mesh: THREE.Mesh;
  material: THREE.MeshBasicMaterial;
  center: THREE.Vector3;
  healable: boolean;
  age: number;
  settled: boolean;
};

type HitSample = {
  point: THREE.Vector3;
  normal: THREE.Vector3;
};

type Sparkle = {
  position: THREE.Vector3;
  velocity: THREE.Vector3;
  life: number;
  ttl: number;
  red: number;
  green: number;
  blue: number;
};

function resolveViewMode(
  unrestrictedMovement: boolean,
  axisLockedOrbit: boolean,
): ClearCardViewMode {
  if (axisLockedOrbit) return 'orbit';
  return unrestrictedMovement ? 'free' : 'tilt';
}

function disposeObject3D(root: THREE.Object3D) {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  const textures = new Set<THREE.Texture>();

  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh) && !(object instanceof THREE.Points)) return;
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

function stepSpringAxis(
  current: number,
  target: number,
  velocity: number,
  deltaSeconds: number,
  stiffness: number,
  damping: number,
): { current: number; velocity: number } {
  const acceleration = (target - current) * stiffness - velocity * damping;
  const nextVelocity = velocity + acceleration * deltaSeconds;
  return {
    current: current + nextVelocity * deltaSeconds,
    velocity: nextVelocity,
  };
}

function stepSpringValue(spring: SpringValue, deltaSeconds: number, stiffness: number, damping: number) {
  const stepped = stepSpringAxis(spring.current, spring.target, spring.velocity, deltaSeconds, stiffness, damping);
  spring.current = stepped.current;
  spring.velocity = stepped.velocity;
}

function isSpringValueSettled(spring: SpringValue) {
  return (
    Math.abs(spring.target - spring.current) <= SPRING_EPSILON &&
    Math.abs(spring.velocity) <= SPRING_EPSILON
  );
}

function snapSpringValue(spring: SpringValue) {
  spring.current = spring.target;
  spring.velocity = 0;
}

function partitionGeometryIntoQuadrants(geometry: THREE.BufferGeometry): THREE.BufferGeometry[] {
  geometry.computeBoundingBox();
  const bounds = geometry.boundingBox;
  const position = geometry.getAttribute('position');
  if (!bounds || !position) return [];
  const center = bounds.getCenter(new THREE.Vector3());
  const size = bounds.getSize(new THREE.Vector3());
  const extents = [size.x, size.y, size.z];
  const axisOrder = [0, 1, 2].sort((a, b) => extents[b] - extents[a]);
  const axisA = axisOrder[0];
  const axisB = axisOrder[1];
  const centerA = center.getComponent(axisA);
  const centerB = center.getComponent(axisB);

  const index = geometry.index;
  const triangleCount = Math.floor((index ? index.count : position.count) / 3);
  const buckets: number[][] = [[], [], [], []];
  const vertex = new THREE.Vector3();

  for (let triangle = 0; triangle < triangleCount; triangle += 1) {
    const i0 = index ? index.getX(triangle * 3) : triangle * 3;
    const i1 = index ? index.getX(triangle * 3 + 1) : triangle * 3 + 1;
    const i2 = index ? index.getX(triangle * 3 + 2) : triangle * 3 + 2;
    let centroidA = 0;
    let centroidB = 0;
    for (const vertexIndex of [i0, i1, i2]) {
      vertex.fromBufferAttribute(position, vertexIndex);
      centroidA += vertex.getComponent(axisA);
      centroidB += vertex.getComponent(axisB);
    }
    const bucket = (centroidA / 3 >= centerA ? 1 : 0) + (centroidB / 3 >= centerB ? 2 : 0);
    buckets[bucket].push(i0, i1, i2);
  }

  return buckets
    .filter((bucket) => bucket.length > 0)
    .map((bucket) => {
      const fragment = new THREE.BufferGeometry();
      Object.entries(geometry.attributes).forEach(([name, attribute]) => {
        fragment.setAttribute(name, attribute);
      });
      fragment.setIndex(bucket);
      const fragmentBounds = new THREE.Box3();
      bucket.forEach((vertexIndex) => {
        vertex.fromBufferAttribute(position, vertexIndex);
        fragmentBounds.expandByPoint(vertex);
      });
      fragment.boundingBox = fragmentBounds;
      return fragment;
    });
}

function createCrackGeometry(radius: number): THREE.BufferGeometry {
  const positions: number[] = [];
  const colors: number[] = [];

  const addRibbon = (
    points: Array<{ x: number; y: number; z: number }>,
    widths: number[],
    widthScale: number,
    alpha: number,
  ) => {
    for (let i = 0; i < points.length - 1; i += 1) {
      const a = points[i];
      const b = points[i + 1];
      const deltaX = b.x - a.x;
      const deltaY = b.y - a.y;
      const length = Math.hypot(deltaX, deltaY);
      if (length < 1e-6) continue;
      const normalX = -deltaY / length;
      const normalY = deltaX / length;
      const widthA = widths[i] * widthScale;
      const widthB = widths[i + 1] * widthScale;
      positions.push(
        a.x + normalX * widthA, a.y + normalY * widthA, a.z,
        a.x - normalX * widthA, a.y - normalY * widthA, a.z,
        b.x + normalX * widthB, b.y + normalY * widthB, b.z,
        a.x - normalX * widthA, a.y - normalY * widthA, a.z,
        b.x - normalX * widthB, b.y - normalY * widthB, b.z,
        b.x + normalX * widthB, b.y + normalY * widthB, b.z,
      );
      for (let vertex = 0; vertex < 6; vertex += 1) colors.push(1, 1, 1, alpha);
    }
  };

  const buildSpoke = (
    originX: number,
    originY: number,
    angle: number,
    length: number,
    width: number,
    depth: number,
  ) => {
    const segments = depth === 0 ? 4 : 2;
    const points = [{ x: originX, y: originY, z: radius * 0.02 }];
    const widths = [width];
    let x = originX;
    let y = originY;
    let heading = angle;
    for (let segment = 1; segment <= segments; segment += 1) {
      heading += (Math.random() - 0.5) * 0.7;
      const segmentLength = (length / segments) * (0.7 + Math.random() * 0.6);
      x += Math.cos(heading) * segmentLength;
      y += Math.sin(heading) * segmentLength;
      points.push({ x, y, z: radius * (0.01 + Math.random() * 0.03) });
      widths.push(Math.max(width * (1 - segment / segments), width * 0.15));
      if (depth === 0 && segment === 2 && Math.random() < 0.75) {
        buildSpoke(
          x,
          y,
          heading + (Math.random() < 0.5 ? 1 : -1) * (0.45 + Math.random() * 0.55),
          length * 0.45,
          width * 0.6,
          1,
        );
      }
    }
    addRibbon(points, widths, 2.6, 0.22);
    addRibbon(points, widths, 1, 0.9);
  };

  const spokeCount = 5 + Math.floor(Math.random() * 3);
  const baseAngle = Math.random() * Math.PI * 2;
  for (let spoke = 0; spoke < spokeCount; spoke += 1) {
    buildSpoke(
      0,
      0,
      baseAngle + (spoke / spokeCount) * Math.PI * 2 + (Math.random() - 0.5) * 0.6,
      radius * (0.55 + Math.random() * 0.45),
      radius * (0.028 + Math.random() * 0.018),
      0,
    );
  }

  const chipRadius = radius * 0.055;
  const chipZ = radius * 0.025;
  const chipSides = 6;
  let previousX = chipRadius;
  let previousY = 0;
  for (let side = 1; side <= chipSides; side += 1) {
    const chipAngle = (side / chipSides) * Math.PI * 2;
    const cornerRadius = chipRadius * (0.7 + Math.random() * 0.6);
    const cornerX = Math.cos(chipAngle) * cornerRadius;
    const cornerY = Math.sin(chipAngle) * cornerRadius;
    positions.push(0, 0, chipZ, previousX, previousY, chipZ, cornerX, cornerY, chipZ);
    for (let vertex = 0; vertex < 3; vertex += 1) colors.push(1, 1, 1, 0.85);
    previousX = cornerX;
    previousY = cornerY;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 4));
  return geometry;
}

function createSparkleTexture(): THREE.CanvasTexture | null {
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext('2d');
  if (!context) return null;
  const gradient = context.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  gradient.addColorStop(0, 'rgba(255, 255, 255, 1)');
  gradient.addColorStop(0.35, 'rgba(255, 255, 255, 0.85)');
  gradient.addColorStop(1, 'rgba(255, 255, 255, 0)');
  context.fillStyle = gradient;
  context.fillRect(0, 0, size, size);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function canvasToPngBlob(canvas: HTMLCanvasElement) {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) {
        resolve(blob);
      } else {
        reject(new Error('The browser could not create the PNG snapshot.'));
      }
    }, 'image/png');
  });
}

function copyCanvasToPngBlob(source: HTMLCanvasElement) {
  const canvas = document.createElement('canvas');
  canvas.width = source.width;
  canvas.height = source.height;
  const context = canvas.getContext('2d');
  if (!context) {
    return Promise.reject(new Error('The browser could not prepare the PNG snapshot.'));
  }
  context.drawImage(source, 0, 0);
  return canvasToPngBlob(canvas);
}

const ClearCardThreeViewer = forwardRef<ClearCardThreeViewerHandle, ClearCardThreeViewerProps>(
  function ClearCardThreeViewer(
    {
      ready,
      cardModelUrl,
      packModelUrl,
      lightingConfig,
      unrestrictedMovement,
      axisLockedOrbit,
      snapBackOnRelease = false,
      interactionFrameRateMode = 'unrestricted',
      interactionEnabled = true,
      hitProgressionMode = 'fixed',
      revealReady = true,
      initiallyRevealed,
      cameraZoom = 1,
      ariaLabel,
      onStatusChange,
      onCardModelLoadStatusChange,
      onStageChange,
      onPackHit,
      onPackBreak,
    },
    ref,
  ) {
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const cardOnly = !packModelUrl;
    const requestRenderRef = useRef<(() => void) | null>(null);
    const applyLightingRef = useRef<((config: ClearCardLightingConfig) => void) | null>(null);
    const lightingConfigRef = useRef(lightingConfig);
    const reducedMotionRef = useRef(false);
    const axisLockedOrbitRef = useRef(axisLockedOrbit);
    const snapBackOnReleaseRef = useRef(snapBackOnRelease);
    const viewModeRef = useRef<ClearCardViewMode>(
      resolveViewMode(unrestrictedMovement, axisLockedOrbit),
    );
    const viewerReadyRef = useRef(false);
    const stageRef = useRef<ClearCardDisplayStage>('pack');
    const initiallyRevealedRef = useRef(initiallyRevealed);
    const cardModelUrlRef = useRef(cardModelUrl);
    const interactionEnabledRef = useRef(interactionEnabled);
    const hitProgressionModeRef = useRef(hitProgressionMode);
    const revealReadyRef = useRef(revealReady);
    const triggerHitRef = useRef<((clientX?: number, clientY?: number) => void) | null>(null);
    const performResetRef = useRef<(() => void) | null>(null);
    const loadCardModelRef = useRef<((modelUrl: string | undefined, force?: boolean) => void) | null>(null);
    const retryCardModelRef = useRef<(() => void) | null>(null);
    const captureSnapshotRef = useRef<(() => Promise<ClearCardSnapshot>) | null>(null);
    const applyAxisLockedOrbitRef = useRef<(() => void) | null>(null);
    const updateCameraViewRef = useRef<(() => void) | null>(null);
    const beginInteractionThrottleRef = useRef<(() => void) | null>(null);
    const releaseInteractionThrottleRef = useRef<(() => void) | null>(null);
    const onStageChangeRef = useRef(onStageChange);
    const onPackHitRef = useRef(onPackHit);
    const onPackBreakRef = useRef(onPackBreak);
    const onCardModelLoadStatusChangeRef = useRef(onCardModelLoadStatusChange);
    const tiltRef = useRef<TiltState>({
      currentX: 0,
      currentY: 0,
      targetX: 0,
      targetY: 0,
      velocityX: 0,
      velocityY: 0,
    });
    const unrestrictedRotationRef = useRef<UnrestrictedRotationState>({
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
    });
    const snapBackRef = useRef(createSnapBackState());
    const orbitYawRef = useRef(0);
    const orbitElevationRef = useRef(0);

    useEffect(() => {
      onPackHitRef.current = onPackHit;
      onPackBreakRef.current = onPackBreak;
      onStageChangeRef.current = onStageChange;
      onCardModelLoadStatusChangeRef.current = onCardModelLoadStatusChange;
      snapBackOnReleaseRef.current = snapBackOnRelease;
      cardModelUrlRef.current = cardModelUrl;
      interactionEnabledRef.current = interactionEnabled;
      hitProgressionModeRef.current = hitProgressionMode;
      revealReadyRef.current = revealReady;
    });

    useEffect(() => {
      lightingConfigRef.current = lightingConfig;
      applyLightingRef.current?.(lightingConfig);
    }, [lightingConfig]);

    useImperativeHandle(
      ref,
      () => ({
        reset: () => performResetRef.current?.(),
        hit: () => triggerHitRef.current?.(),
        retryCardModel: () => retryCardModelRef.current?.(),
        captureSnapshot: () => {
          const captureSnapshot = captureSnapshotRef.current;
          if (!captureSnapshot) {
            return Promise.reject(new Error('Snapshot rendering is unavailable.'));
          }
          return captureSnapshot();
        },
      }),
      [],
    );

    useEffect(() => {
      cardModelUrlRef.current = cardModelUrl;
      loadCardModelRef.current?.(cardModelUrl);
    }, [cardModelUrl]);

    const resetTilt = useCallback(() => {
      tiltRef.current.targetX = 0;
      tiltRef.current.targetY = 0;
      requestRenderRef.current?.();
    }, []);

    const cancelUnrestrictedDrag = useCallback(() => {
      const rotation = unrestrictedRotationRef.current;
      const pointerId = rotation.pointerId;
      rotation.pointerId = null;
      rotation.dragged = false;
      rotation.lockedAxis = null;
      const canvas = canvasRef.current;
      if (pointerId !== null && canvas?.hasPointerCapture(pointerId)) {
        canvas.releasePointerCapture(pointerId);
      }
    }, []);

    const startSnapBack = useCallback((timeStampMs: number) => {
      if (!snapBackOnReleaseRef.current || viewModeRef.current !== 'free') return;
      releaseSnapBack(snapBackRef.current, timeStampMs);
      requestRenderRef.current?.();
    }, []);

    const resetViewOrientation = useCallback(() => {
      cancelUnrestrictedDrag();
      resetSnapBackTracking(snapBackRef.current, 0);
      releaseInteractionThrottleRef.current?.();
      unrestrictedRotationRef.current.quaternion.identity();
      orbitYawRef.current = 0;
      orbitElevationRef.current = 0;
      const tilt = tiltRef.current;
      tilt.currentX = 0;
      tilt.currentY = 0;
      tilt.targetX = 0;
      tilt.targetY = 0;
      tilt.velocityX = 0;
      tilt.velocityY = 0;
      updateCameraViewRef.current?.();
      requestRenderRef.current?.();
    }, [cancelUnrestrictedDrag]);

    useEffect(() => {
      const previousMode = viewModeRef.current;
      axisLockedOrbitRef.current = axisLockedOrbit;
      const nextMode = resolveViewMode(unrestrictedMovement, axisLockedOrbit);
      applyAxisLockedOrbitRef.current?.();
      if (previousMode === nextMode) return;

      cancelUnrestrictedDrag();
      resetSnapBackTracking(snapBackRef.current, 0);
      releaseInteractionThrottleRef.current?.();
      const rotation = unrestrictedRotationRef.current;
      const tilt = tiltRef.current;
      if (nextMode === 'orbit') {
        if (previousMode === 'free') {
          const forward = new THREE.Vector3(0, 0, 1).applyQuaternion(rotation.quaternion);
          orbitYawRef.current = Math.atan2(forward.x, forward.z);
        } else if (previousMode === 'tilt') {
          orbitYawRef.current = tilt.currentY;
        }
        rotation.quaternion.setFromAxisAngle(WORLD_UP, orbitYawRef.current);
      } else if (nextMode === 'free' && previousMode === 'tilt') {
        rotation.deltaEuler.set(tilt.currentX, tilt.currentY, 0);
        rotation.quaternion.setFromEuler(rotation.deltaEuler);
      } else if (nextMode === 'tilt') {
        rotation.quaternion.identity();
        orbitYawRef.current = 0;
      }
      if (nextMode !== 'orbit') {
        orbitElevationRef.current = 0;
      }

      tilt.currentX = 0;
      tilt.currentY = 0;
      tilt.targetX = 0;
      tilt.targetY = 0;
      tilt.velocityX = 0;
      tilt.velocityY = 0;
      viewModeRef.current = nextMode;
      updateCameraViewRef.current?.();
      requestRenderRef.current?.();
    }, [axisLockedOrbit, cancelUnrestrictedDrag, unrestrictedMovement]);

    const updateTilt = useCallback((event: ReactPointerEvent<HTMLCanvasElement>) => {
      if (viewModeRef.current !== 'tilt') return;
      if (!viewerReadyRef.current || reducedMotionRef.current) return;
      if (!event.isPrimary) return;
      if (stageRef.current === 'breaking') return;
      const bounds = event.currentTarget.getBoundingClientRect();
      if (!bounds.width || !bounds.height) return;
      beginInteractionThrottleRef.current?.();
      const pointerX = THREE.MathUtils.clamp((event.clientX - bounds.left) / bounds.width, 0, 1);
      const pointerY = THREE.MathUtils.clamp((event.clientY - bounds.top) / bounds.height, 0, 1);
      tiltRef.current.targetX = -(pointerY * 2 - 1) * MAX_TILT_X;
      tiltRef.current.targetY = -(pointerX * 2 - 1) * MAX_TILT_Y;
      requestRenderRef.current?.();
    }, []);

    const handlePointerMove = useCallback(
      (event: ReactPointerEvent<HTMLCanvasElement>) => {
        if (viewModeRef.current === 'tilt') {
          updateTilt(event);
          return;
        }
        const rotation = unrestrictedRotationRef.current;
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
          beginInteractionThrottleRef.current?.();
          if (viewModeRef.current === 'orbit') {
            rotation.lockedAxis =
              Math.abs(totalX) >= Math.abs(totalY) ? 'horizontal' : 'vertical';
          }
        }
        if (!deltaX && !deltaY) return;
        if (viewModeRef.current === 'orbit') {
          if (rotation.lockedAxis === 'horizontal') {
            orbitYawRef.current += deltaX * UNRESTRICTED_ROTATION_SPEED;
            rotation.quaternion.setFromAxisAngle(WORLD_UP, orbitYawRef.current);
          } else if (rotation.lockedAxis === 'vertical') {
            orbitElevationRef.current = THREE.MathUtils.clamp(
              orbitElevationRef.current + deltaY * UNRESTRICTED_ROTATION_SPEED,
              -MAX_VERTICAL_ORBIT,
              MAX_VERTICAL_ORBIT,
            );
          }
          updateCameraViewRef.current?.();
        } else {
          rotation.deltaEuler.set(
            deltaY * UNRESTRICTED_ROTATION_SPEED,
            deltaX * UNRESTRICTED_ROTATION_SPEED,
            0,
          );
          rotation.deltaQuaternion.setFromEuler(rotation.deltaEuler);
          rotation.quaternion.premultiply(rotation.deltaQuaternion).normalize();
          if (snapBackOnReleaseRef.current) {
            trackSnapBackVelocity(
              snapBackRef.current,
              deltaX,
              deltaY,
              UNRESTRICTED_ROTATION_SPEED,
              event.timeStamp,
            );
          }
        }
        requestRenderRef.current?.();
      },
      [updateTilt],
    );

    const handlePointerEnter = handlePointerMove;

    const handlePointerDown = useCallback(
      (event: ReactPointerEvent<HTMLCanvasElement>) => {
        if (viewModeRef.current !== 'tilt') {
          if (!viewerReadyRef.current || stageRef.current === 'breaking') return;
          if (!isClearCardImpactPointer(event)) return;
          const rotation = unrestrictedRotationRef.current;
          if (rotation.pointerId !== null) return;
          rotation.pointerId = event.pointerId;
          rotation.startX = event.clientX;
          rotation.startY = event.clientY;
          rotation.lastX = event.clientX;
          rotation.lastY = event.clientY;
          rotation.dragged = false;
          rotation.lockedAxis = null;
          resetSnapBackTracking(snapBackRef.current, event.timeStamp);
          event.currentTarget.setPointerCapture(event.pointerId);
          event.preventDefault();
          return;
        }
        if (stageRef.current === 'pack' && isClearCardImpactPointer(event)) {
          triggerHitRef.current?.(event.clientX, event.clientY);
        }
        updateTilt(event);
      },
      [updateTilt],
    );

    const handlePointerUp = useCallback(
      (event: ReactPointerEvent<HTMLCanvasElement>) => {
        if (viewModeRef.current !== 'tilt') {
          const rotation = unrestrictedRotationRef.current;
          if (rotation.pointerId !== event.pointerId) return;
          const totalX = event.clientX - rotation.startX;
          const totalY = event.clientY - rotation.startY;
          const dragged =
            rotation.dragged ||
            totalX * totalX + totalY * totalY > UNRESTRICTED_DRAG_THRESHOLD_SQ;
          rotation.pointerId = null;
          rotation.dragged = false;
          rotation.lockedAxis = null;
          if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
          }
          startSnapBack(event.timeStamp);
          releaseInteractionThrottleRef.current?.();
          if (!dragged && stageRef.current === 'pack') {
            triggerHitRef.current?.(event.clientX, event.clientY);
          }
          return;
        }
        if (event.pointerType === 'mouse') return;
        releaseInteractionThrottleRef.current?.();
        resetTilt();
      },
      [resetTilt, startSnapBack],
    );

    const handlePointerLeave = useCallback(() => {
      if (viewModeRef.current === 'tilt') {
        releaseInteractionThrottleRef.current?.();
        resetTilt();
      }
    }, [resetTilt]);

    const handlePointerCancel = useCallback(
      (event: ReactPointerEvent<HTMLCanvasElement>) => {
        if (viewModeRef.current !== 'tilt') {
          const hadActiveDrag = unrestrictedRotationRef.current.pointerId !== null;
          cancelUnrestrictedDrag();
          if (hadActiveDrag) startSnapBack(event.timeStamp);
          releaseInteractionThrottleRef.current?.();
        } else {
          releaseInteractionThrottleRef.current?.();
          resetTilt();
        }
      },
      [cancelUnrestrictedDrag, resetTilt, startSnapBack],
    );

    const handleLostPointerCapture = useCallback(
      (event: ReactPointerEvent<HTMLCanvasElement>) => {
        if (unrestrictedRotationRef.current.pointerId === event.pointerId) {
          unrestrictedRotationRef.current.pointerId = null;
          unrestrictedRotationRef.current.dragged = false;
          unrestrictedRotationRef.current.lockedAxis = null;
          startSnapBack(event.timeStamp);
          releaseInteractionThrottleRef.current?.();
        }
      },
      [startSnapBack],
    );

    useEffect(() => {
      const handleWindowBlur = () => {
        const hadActiveDrag = unrestrictedRotationRef.current.pointerId !== null;
        cancelUnrestrictedDrag();
        if (hadActiveDrag) startSnapBack(performance.now());
        releaseInteractionThrottleRef.current?.();
        if (viewModeRef.current === 'tilt') {
          resetTilt();
        }
      };
      window.addEventListener('blur', handleWindowBlur);
      return () => window.removeEventListener('blur', handleWindowBlur);
    }, [cancelUnrestrictedDrag, resetTilt, startSnapBack]);

    useEffect(() => {
      const canvas = canvasRef.current;
      if (!canvas) return undefined;
      const viewport = canvas.parentElement;
      if (!viewport) return undefined;

      let disposed = false;
      let contextLost = false;
      let packLoadFailed = false;
      let packReady = false;
      let cardLoadFailed = false;
      let cardReady = false;
      let cardLoadGeneration = 0;
      let loadedCardModelUrl: string | undefined;
      let activeCardModelUrl: string | undefined;
      let initializationFrameId: number | null = null;
      let frameId: number | null = null;
      let displayCadenceFrameId: number | null = null;
      let lastFrameTime = 0;
      let lastInteractionFrameTime = 0;
      let interactionActive = false;
      let interactionProbeActive = false;
      let interactionThrottleActive = false;
      let interactionThrottleReleasePending = false;
      let adaptiveInteractionThrottleRequired = false;
      let adaptiveThrottleActivatedAt = 0;
      let displayFrameIntervalMs = 1_000 / 60;
      let adaptiveFrameRateMonitor = createAdaptiveFrameRateMonitor();
      let renderer: THREE.WebGLRenderer | null = null;
      let snapshotOutputTarget: THREE.WebGLRenderTarget | null = null;
      let snapshotInFlight = false;
      let packDracoLoader: DRACOLoader | null = null;
      let cardDracoLoader: DRACOLoader | null = null;
      let environmentRenderTarget: THREE.WebGLRenderTarget | null = null;
      let environmentUpdateTimer: number | null = null;
      let environmentSignature = '';
      let pendingEnvironmentConfig: ClearCardLightingConfig | null = null;
      let lastToneMapping: THREE.ToneMapping | null = null;
      let rectAreaLightReady = false;
      let rectAreaLightLoadPending = false;
      let packLoadingManager: THREE.LoadingManager | null = null;
      let cardLoadingManager: THREE.LoadingManager | null = null;
      let resizeObserver: ResizeObserver | null = null;
      let motionQuery: MediaQueryList | null = null;
      let handleMotionPreference: (() => void) | null = null;
      let handleVisibilityChange: (() => void) | null = null;
      let handleContextLost: ((event: Event) => void) | null = null;
      let handleContextRestored: (() => void) | null = null;
      let syncRendererSize: (() => void) | null = null;
      let resize: (() => void) | null = null;

      const packMeshes: THREE.Mesh[] = [];
      let packUsesTransmission = false;
      let fragmentsGroup: THREE.Group | null = null;
      let crackGroup: THREE.Group | null = null;
      let shardTransmissionWarmed = false;
      let hitCount = 0;
      let gatedHitState: ClearCardGatedHitState = createClearCardGatedHitState();
      let breakElapsed = 0;
      let shardLocalScale = 1;
      const shards: PackShard[] = [];
      const cracks: PackCrack[] = [];
      const packLocalCenter = new THREE.Vector3();
      const packSize = new THREE.Vector3();
      const cardSize = new THREE.Vector3();
      const fitSize = new THREE.Vector3();
      const punchSpring: SpringValue = { current: 1, target: 1, velocity: 0 };
      let sparkleWorldScale = 1;
      const sparkles: Sparkle[] = [];
      const tmpVector = new THREE.Vector3();
      const tmpVector2 = new THREE.Vector3();
      const tmpMatrix = new THREE.Matrix4();
      const localDown = new THREE.Vector3();
      const raycaster = new THREE.Raycaster();
      const pointerNdc = new THREE.Vector2();

      const scene = new THREE.Scene();
      const pivot = new THREE.Group();
      const packGroup = new THREE.Group();
      const cardGroup = new THREE.Group();
      cardGroup.visible = false;
      let cardRoot: THREE.Object3D | null = null;
      const camera = new THREE.PerspectiveCamera(28, 1, 0.01, 100);
      let cameraAspect = 1;
      const shardCamera = new THREE.PerspectiveCamera();
      shardCamera.layers.set(SHARD_LAYER);
      shardCamera.matrixAutoUpdate = false;
      shardCamera.matrixWorldAutoUpdate = false;
      const syncShardCamera = () => {
        shardCamera.matrixWorld.copy(camera.matrixWorld);
        shardCamera.matrixWorldInverse.copy(camera.matrixWorldInverse);
        shardCamera.projectionMatrix.copy(camera.projectionMatrix);
        shardCamera.projectionMatrixInverse.copy(camera.projectionMatrixInverse);
      };
      const ambientLight = new THREE.AmbientLight();
      const hemisphereLight = new THREE.HemisphereLight();
      const directionalLight = new THREE.DirectionalLight();
      const directionalTarget = new THREE.Object3D();
      const rimLight = new THREE.DirectionalLight();
      const rimTarget = new THREE.Object3D();
      const areaLight = new THREE.RectAreaLight();
      const pointLight = new THREE.PointLight();
      const spotLight = new THREE.SpotLight();
      const spotTarget = new THREE.Object3D();
      directionalLight.target = directionalTarget;
      rimLight.target = rimTarget;
      spotLight.target = spotTarget;
      const transmissionBackdropMaterial = new THREE.ShaderMaterial({
        uniforms: {
          backdropColor: {
            value: new THREE.Color(lightingConfigRef.current.transmission.cardColor),
          },
          backdropAlpha: { value: lightingConfigRef.current.transmission.cardAlpha },
        },
        vertexShader: `
          void main() {
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }
        `,
        fragmentShader: `
          uniform vec3 backdropColor;
          uniform float backdropAlpha;

          void main() {
            gl_FragColor = vec4(backdropColor, backdropAlpha);
          }
        `,
        depthTest: false,
        depthWrite: false,
      });
      const transmissionBackdrop = new THREE.Mesh(
        new THREE.PlaneGeometry(100, 100),
        transmissionBackdropMaterial,
      );
      transmissionBackdrop.position.z = -10;
      transmissionBackdrop.renderOrder = -1_000;
      transmissionBackdrop.onBeforeRender = (activeRenderer) => {
        const activeTarget = activeRenderer.getRenderTarget();
        transmissionBackdropMaterial.colorWrite =
          activeTarget !== null && activeTarget !== snapshotOutputTarget;
      };
      pivot.add(packGroup);
      pivot.add(cardGroup);
      scene.add(transmissionBackdrop);
      scene.add(pivot);
      scene.add(camera);
      scene.add(
        ambientLight,
        hemisphereLight,
        directionalLight,
        directionalTarget,
        rimLight,
        rimTarget,
        areaLight,
        pointLight,
        spotLight,
        spotTarget,
      );
      camera.layers.enable(SHARD_LAYER);
      transmissionBackdrop.layers.enable(SHARD_LAYER);
      [
        ambientLight,
        hemisphereLight,
        directionalLight,
        rimLight,
        areaLight,
        pointLight,
        spotLight,
      ].forEach((light) => light.layers.enable(SHARD_LAYER));

      const sparklePositions = new Float32Array(MAX_SPARKLES * 3);
      const sparkleColors = new Float32Array(MAX_SPARKLES * 4);
      const sparkleGeometry = new THREE.BufferGeometry();
      sparkleGeometry.setAttribute('position', new THREE.BufferAttribute(sparklePositions, 3));
      sparkleGeometry.setAttribute('color', new THREE.BufferAttribute(sparkleColors, 4));
      sparkleGeometry.setDrawRange(0, 0);
      const sparkleMaterial = new THREE.PointsMaterial({
        map: createSparkleTexture(),
        vertexColors: true,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        sizeAttenuation: true,
        size: 1,
      });
      const sparklePoints = new THREE.Points(sparkleGeometry, sparkleMaterial);
      sparklePoints.frustumCulled = false;
      sparklePoints.renderOrder = 10;
      sparklePoints.visible = false;
      sparklePoints.layers.set(SHARD_LAYER);
      scene.add(sparklePoints);

      const markSceneMaterialsForUpdate = () => {
        scene.traverse((object) => {
          if (!(object instanceof THREE.Mesh) && !(object instanceof THREE.Points)) return;
          const materials = Array.isArray(object.material) ? object.material : [object.material];
          materials.forEach((material) => {
            material.needsUpdate = true;
          });
        });
      };

      const syncLightVisibility = (
        stage: ClearCardDisplayStage,
        config: ClearCardLightingConfig,
      ) => {
        ambientLight.visible =
          config.ambient.enabled && lightMatchesStage(config.ambient.stage, stage);
        hemisphereLight.visible =
          config.hemisphere.enabled && lightMatchesStage(config.hemisphere.stage, stage);
        directionalLight.visible =
          config.directional.enabled && lightMatchesStage(config.directional.stage, stage);
        rimLight.visible = config.rim.enabled && lightMatchesStage(config.rim.stage, stage);
        const areaLightShouldBeVisible =
          config.area.enabled && lightMatchesStage(config.area.stage, stage);
        areaLight.visible = areaLightShouldBeVisible && rectAreaLightReady;
        if (
          areaLightShouldBeVisible &&
          !rectAreaLightReady &&
          !rectAreaLightLoadPending
        ) {
          rectAreaLightLoadPending = true;
          void loadRectAreaLightSupport()
            .then(() => {
              rectAreaLightLoadPending = false;
              if (disposed) return;
              rectAreaLightReady = true;
              markSceneMaterialsForUpdate();
              syncLightVisibility(stageRef.current, lightingConfigRef.current);
              requestRender();
            })
            .catch((error) => {
              rectAreaLightLoadPending = false;
              if (!disposed) {
                console.error(
                  '[mons] failed to initialize rectangular area lighting',
                  error,
                );
              }
            });
        }
        pointLight.visible = config.point.enabled && lightMatchesStage(config.point.stage, stage);
        spotLight.visible = config.spot.enabled && lightMatchesStage(config.spot.stage, stage);
      };

      const applyTransmissionBackdrop = (
        config: ClearCardLightingConfig,
        usePackBackdrop: boolean,
      ) => {
        transmissionBackdropMaterial.uniforms.backdropColor.value.set(
          usePackBackdrop
            ? config.transmission.packColor
            : config.transmission.cardColor,
        );
        transmissionBackdropMaterial.uniforms.backdropAlpha.value = usePackBackdrop
          ? config.transmission.packAlpha
          : config.transmission.cardAlpha;
      };

      const syncTransmissionBackdrop = (
        stage: ClearCardDisplayStage,
        config: ClearCardLightingConfig,
      ) => {
        applyTransmissionBackdrop(config, stage === 'pack' && packUsesTransmission);
      };

      const setStage = (nextStage: ClearCardDisplayStage) => {
        stageRef.current = nextStage;
        syncLightVisibility(nextStage, lightingConfigRef.current);
        syncTransmissionBackdrop(nextStage, lightingConfigRef.current);
        onStageChangeRef.current?.(nextStage);
      };
      setStage('pack');

      const displayModelReady = () => (cardOnly ? cardReady : packReady);

      const cardRequiredForViewerStatus = () =>
        cardOnly || hitProgressionModeRef.current === 'fixed';

      const updateViewerStatus = () => {
        if (disposed) return;
        const failed = packLoadFailed || (cardRequiredForViewerStatus() && cardLoadFailed);
        const statusReady = displayModelReady() && (!cardRequiredForViewerStatus() || cardReady);
        viewerReadyRef.current = !contextLost && statusReady;
        onStatusChange(contextLost || failed ? 'error' : statusReady ? 'ready' : 'loading');
      };

      const reportCardModelLoadStatus = (status: ClearCardModelLoadStatus) => {
        onCardModelLoadStatusChangeRef.current?.(status);
      };

      const fitCamera = () => {
        if (!displayModelReady()) return;
        let projectedWidth = fitSize.x;
        let projectedDepth = fitSize.z;
        let projectedHeight = fitSize.y;
        let viewDepth = fitSize.z;
        const elevation = axisLockedOrbitRef.current ? orbitElevationRef.current : 0;
        if (axisLockedOrbitRef.current) {
          const baseYaw =
            stageRef.current === 'pack' && packUsesTransmission
              ? TRANSMISSIVE_PACK_ROTATION_Y
              : 0;
          const yaw = orbitYawRef.current + baseYaw;
          const absCosYaw = Math.abs(Math.cos(yaw));
          const absSinYaw = Math.abs(Math.sin(yaw));
          projectedWidth = fitSize.x * absCosYaw + fitSize.z * absSinYaw;
          projectedDepth = fitSize.x * absSinYaw + fitSize.z * absCosYaw;
          const absCosElevation = Math.abs(Math.cos(elevation));
          const absSinElevation = Math.abs(Math.sin(elevation));
          projectedHeight =
            fitSize.y * absCosElevation + projectedDepth * absSinElevation;
          viewDepth = fitSize.y * absSinElevation + projectedDepth * absCosElevation;
        }

        camera.aspect = cameraAspect;
        camera.zoom = Math.max(0.1, cameraZoom);
        const verticalFov = THREE.MathUtils.degToRad(camera.fov);
        const fitHeightDistance = projectedHeight / (2 * Math.tan(verticalFov / 2));
        const fitWidthDistance =
          projectedWidth / (2 * Math.tan(verticalFov / 2) * Math.max(cameraAspect, 0.01));
        const distance =
          Math.max(fitHeightDistance, fitWidthDistance) * CAMERA_FIT_MARGIN * CANVAS_OVERSCAN +
          viewDepth / 2;
        camera.near = 0.01;
        camera.far = Math.max(100, distance + viewDepth * 2 + 1);
        camera.position.set(
          0,
          Math.sin(elevation) * distance,
          Math.max(Math.cos(elevation) * distance, 0.1),
        );
        camera.up.copy(WORLD_UP);
        camera.lookAt(0, 0, 0);
        camera.updateProjectionMatrix();
      };

      updateCameraViewRef.current = fitCamera;

      const syncPackDisplayRotation = () => {
        if (!packUsesTransmission) {
          packGroup.rotation.set(0, 0, 0);
          return;
        }
        packGroup.rotation.set(
          axisLockedOrbitRef.current ? 0 : TRANSMISSIVE_PACK_ROTATION_X,
          TRANSMISSIVE_PACK_ROTATION_Y,
          0,
        );
      };

      applyAxisLockedOrbitRef.current = () => {
        syncPackDisplayRotation();
        fitCamera();
        requestRender();
      };

      const centerObject = (root: THREE.Object3D, sizeTarget: THREE.Vector3) => {
        const bounds = new THREE.Box3().setFromObject(root);
        const center = bounds.getCenter(new THREE.Vector3());
        root.position.sub(center);
        new THREE.Box3().setFromObject(root).getSize(sizeTarget);
      };

      const buildPackShards = (meshes: THREE.Mesh[], largestMesh: THREE.Mesh) => {
        const parent = largestMesh.parent;
        if (!parent) return;
        const sourceMaterial = Array.isArray(largestMesh.material)
          ? largestMesh.material[0]
          : largestMesh.material;
        if (!sourceMaterial) return;
        const fragments = partitionGeometryIntoQuadrants(largestMesh.geometry);
        if (fragments.length < 2) {
          fragments.forEach((fragment) => fragment.dispose());
          return;
        }
        const geometryBounds = largestMesh.geometry.boundingBox;
        if (geometryBounds) {
          geometryBounds.getCenter(packLocalCenter);
          const localSize = geometryBounds.getSize(new THREE.Vector3());
          shardLocalScale = Math.max(localSize.x, localSize.y, localSize.z);
        }
        const group = new THREE.Group();
        group.position.copy(largestMesh.position);
        group.quaternion.copy(largestMesh.quaternion);
        group.scale.copy(largestMesh.scale);
        group.visible = false;
        parent.add(group);
        fragmentsGroup = group;
        const crackHost = new THREE.Group();
        crackHost.position.copy(largestMesh.position);
        crackHost.quaternion.copy(largestMesh.quaternion);
        crackHost.scale.copy(largestMesh.scale);
        parent.add(crackHost);
        crackGroup = crackHost;
        fragments.forEach((fragment) => {
          const fragmentCenter = fragment.boundingBox
            ? fragment.boundingBox.getCenter(new THREE.Vector3())
            : new THREE.Vector3();
          const shardMesh = new THREE.Mesh(fragment, sourceMaterial);
          shardMesh.position.copy(fragmentCenter).negate();
          const holder = new THREE.Group();
          holder.position.copy(fragmentCenter);
          holder.add(shardMesh);
          group.add(holder);
          shards.push({
            holder,
            home: fragmentCenter.clone(),
            velocity: new THREE.Vector3(),
            angularVelocity: new THREE.Vector3(),
          });
        });
        group.updateWorldMatrix(true, false);
        const groupWorldInverse = new THREE.Matrix4().copy(group.matrixWorld).invert();
        meshes.forEach((mesh) => {
          if (mesh === largestMesh) return;
          const pieceSourceMaterial = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
          if (!pieceSourceMaterial) return;
          mesh.updateWorldMatrix(true, false);
          const relativeMatrix = new THREE.Matrix4().multiplyMatrices(
            groupWorldInverse,
            mesh.matrixWorld,
          );
          mesh.geometry.computeBoundingBox();
          const pieceCenter = (mesh.geometry.boundingBox
            ? mesh.geometry.boundingBox.getCenter(new THREE.Vector3())
            : new THREE.Vector3()
          ).applyMatrix4(relativeMatrix);
          const pieceMesh = new THREE.Mesh(mesh.geometry, pieceSourceMaterial);
          relativeMatrix.decompose(pieceMesh.position, pieceMesh.quaternion, pieceMesh.scale);
          pieceMesh.position.sub(pieceCenter);
          const holder = new THREE.Group();
          holder.position.copy(pieceCenter);
          holder.add(pieceMesh);
          group.add(holder);
          shards.push({
            holder,
            home: pieceCenter.clone(),
            velocity: new THREE.Vector3(),
            angularVelocity: new THREE.Vector3(),
          });
        });
        group.traverse((object) => {
          object.layers.set(SHARD_LAYER);
        });
      };

      const computeLocalDown = () => {
        if (!fragmentsGroup) return localDown.set(0, -1, 0);
        fragmentsGroup.updateWorldMatrix(true, false);
        return localDown
          .set(0, -1, 0)
          .transformDirection(tmpMatrix.copy(fragmentsGroup.matrixWorld).invert());
      };

      const removeCrack = (crack: PackCrack) => {
        crack.mesh.parent?.remove(crack.mesh);
        crack.mesh.geometry.dispose();
        crack.material.dispose();
      };

      const clearCracks = () => {
        cracks.forEach(removeCrack);
        cracks.length = 0;
      };

      const settleCrack = (crack: PackCrack) => {
        crack.mesh.scale.setScalar(1);
        crack.material.opacity = crack.healable
          ? CRACK_MAX_OPACITY
          : CRACK_PERMANENT_OPACITY;
        crack.settled = true;
      };

      const settleCracksInstantly = () => {
        let write = 0;
        for (const crack of cracks) {
          if (crack.healable) {
            removeCrack(crack);
            continue;
          }
          if (!crack.settled) settleCrack(crack);
          cracks[write] = crack;
          write += 1;
        }
        cracks.length = write;
      };

      const updateCracks = (deltaSeconds: number) => {
        if (cracks.length === 0) return;
        let write = 0;
        for (const crack of cracks) {
          if (crack.settled) {
            cracks[write] = crack;
            write += 1;
            continue;
          }
          crack.age += deltaSeconds;
          const age = crack.age;
          if (age <= CRACK_APPEAR_S) {
            const t = age / CRACK_APPEAR_S;
            const eased = 1 - (1 - t) * (1 - t);
            crack.mesh.scale.setScalar(0.35 + 0.65 * eased);
            crack.material.opacity = CRACK_MAX_OPACITY * eased;
          } else if (!crack.healable) {
            settleCrack(crack);
          } else if (age <= CRACK_APPEAR_S + CRACK_HOLD_S) {
            crack.mesh.scale.setScalar(1);
            crack.material.opacity = CRACK_MAX_OPACITY;
          } else {
            const t = (age - CRACK_APPEAR_S - CRACK_HOLD_S) / CRACK_HEAL_S;
            if (t >= 1) {
              removeCrack(crack);
              continue;
            }
            const eased = t * t * (3 - 2 * t);
            crack.mesh.scale.setScalar(1 - 0.85 * eased);
            crack.material.opacity = CRACK_MAX_OPACITY * (1 - eased);
          }
          cracks[write] = crack;
          write += 1;
        }
        cracks.length = write;
      };

      const spawnCrack = (hit: HitSample, healable: boolean, instant = false) => {
        if (!crackGroup) return;
        crackGroup.updateWorldMatrix(true, false);
        tmpMatrix.copy(crackGroup.matrixWorld).invert();
        const center = hit.point.clone().applyMatrix4(tmpMatrix);
        const normal = hit.normal.clone().transformDirection(tmpMatrix);
        if (normal.lengthSq() < 1e-8) normal.set(0, 0, 1);
        normal.normalize();
        const radiusFactor = healable
          ? CRACK_HEALABLE_RADIUS_FACTOR
          : CRACK_PERMANENT_RADIUS_FACTOR;
        const radius = shardLocalScale * radiusFactor * (0.85 + Math.random() * 0.35);
        const material = new THREE.MeshBasicMaterial({
          color: 0xffffff,
          transparent: true,
          opacity: 0,
          vertexColors: true,
          side: THREE.DoubleSide,
          depthWrite: false,
        });
        material.toneMapped = false;
        const mesh = new THREE.Mesh(createCrackGeometry(radius), material);
        mesh.position
          .copy(center)
          .addScaledVector(normal, shardLocalScale * CRACK_SURFACE_OFFSET_FACTOR);
        mesh.quaternion.setFromUnitVectors(tmpVector.set(0, 0, 1), normal);
        mesh.scale.setScalar(0.35);
        mesh.renderOrder = 5;
        crackGroup.add(mesh);
        const crack: PackCrack = { mesh, material, center, healable, age: 0, settled: false };
        if (instant || reducedMotionRef.current) settleCrack(crack);
        cracks.push(crack);
      };

      const attachCracksToShards = () => {
        let write = 0;
        for (const crack of cracks) {
          if (crack.healable) {
            removeCrack(crack);
            continue;
          }
          if (shards.length > 0) {
            let nearest = shards[0];
            let nearestDistanceSq = Infinity;
            shards.forEach((shard) => {
              const distanceSq = crack.center.distanceToSquared(shard.home);
              if (distanceSq >= nearestDistanceSq) return;
              nearestDistanceSq = distanceSq;
              nearest = shard;
            });
            crack.mesh.position.sub(nearest.home);
            nearest.holder.add(crack.mesh);
            crack.mesh.layers.set(SHARD_LAYER);
          }
          cracks[write] = crack;
          write += 1;
        }
        cracks.length = write;
      };

      const armShards = (worldImpactPoint: THREE.Vector3 | null) => {
        const down = computeLocalDown();
        const impactLocal =
          worldImpactPoint && fragmentsGroup
            ? worldImpactPoint
                .clone()
                .applyMatrix4(tmpMatrix.copy(fragmentsGroup.matrixWorld).invert())
            : null;
        const falloffRadius = shardLocalScale * SHARD_IMPULSE_FALLOFF_RADIUS;
        const applyImpulse = (shard: PackShard, source: THREE.Vector3, strength: number) => {
          tmpVector2.copy(shard.home).sub(source);
          const distance = tmpVector2.length();
          if (distance < 1e-6) {
            tmpVector2
              .set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5)
              .normalize();
          } else {
            tmpVector2.divideScalar(distance);
          }
          const falloff = 1 / (1 + (distance / falloffRadius) * (distance / falloffRadius));
          shard.velocity.addScaledVector(tmpVector2, shardLocalScale * strength * falloff);
        };
        shards.forEach((shard) => {
          tmpVector.copy(shard.home).sub(packLocalCenter);
          if (tmpVector.lengthSq() < 1e-8) {
            tmpVector.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5);
          }
          tmpVector.normalize();
          shard.velocity
            .copy(tmpVector)
            .multiplyScalar(shardLocalScale * (0.25 + Math.random() * 0.2));
          shard.velocity.addScaledVector(down, -shardLocalScale * 0.15);
          cracks.forEach((crack) => {
            if (!crack.healable) applyImpulse(shard, crack.center, SHARD_CRACK_IMPULSE);
          });
          if (impactLocal) applyImpulse(shard, impactLocal, SHARD_IMPACT_IMPULSE);
          shard.angularVelocity.set(
            (Math.random() - 0.5) * 3.5,
            (Math.random() - 0.5) * 3.5,
            (Math.random() - 0.5) * 3.5,
          );
        });
      };

      const spawnSparkles = (origin: THREE.Vector3, count: number) => {
        if (reducedMotionRef.current) return;
        const available = MAX_SPARKLES - sparkles.length;
        const spawnCount = Math.min(count, available);
        for (let i = 0; i < spawnCount; i += 1) {
          const direction = new THREE.Vector3(
            Math.random() * 2 - 1,
            Math.random() * 2 - 1,
            Math.random() * 2 - 1,
          );
          if (direction.lengthSq() < 1e-6) direction.set(0, 1, 0);
          direction.normalize();
          direction.z = Math.abs(direction.z) * 0.9 + 0.3;
          direction.normalize();
          const speed = sparkleWorldScale * (0.35 + Math.random() * 0.65);
          const velocity = direction.multiplyScalar(speed);
          velocity.y += sparkleWorldScale * 0.2;
          sparkles.push({
            position: origin
              .clone()
              .add(
                new THREE.Vector3(
                  (Math.random() - 0.5) * sparkleWorldScale * 0.08,
                  (Math.random() - 0.5) * sparkleWorldScale * 0.08,
                  (Math.random() - 0.5) * sparkleWorldScale * 0.04,
                ),
              ),
            velocity,
            life: 0,
            ttl: 0.45 + Math.random() * 0.35,
            red: 1,
            green: 0.92 + Math.random() * 0.08,
            blue: 0.72 + Math.random() * 0.22,
          });
        }
      };

      const updateSparkles = (deltaSeconds: number) => {
        if (sparkles.length === 0) {
          if (sparklePoints.visible) {
            sparklePoints.visible = false;
            sparkleGeometry.setDrawRange(0, 0);
          }
          return;
        }
        const gravity = sparkleWorldScale * 2.5;
        let write = 0;
        for (let i = 0; i < sparkles.length; i += 1) {
          const sparkle = sparkles[i];
          sparkle.life += deltaSeconds;
          if (sparkle.life >= sparkle.ttl) continue;
          sparkle.velocity.y -= gravity * deltaSeconds;
          sparkle.position.addScaledVector(sparkle.velocity, deltaSeconds);
          sparklePositions[write * 3] = sparkle.position.x;
          sparklePositions[write * 3 + 1] = sparkle.position.y;
          sparklePositions[write * 3 + 2] = sparkle.position.z;
          const fade = 1 - sparkle.life / sparkle.ttl;
          sparkleColors[write * 4] = sparkle.red;
          sparkleColors[write * 4 + 1] = sparkle.green;
          sparkleColors[write * 4 + 2] = sparkle.blue;
          sparkleColors[write * 4 + 3] = fade * fade;
          sparkles[write] = sparkle;
          write += 1;
        }
        sparkles.length = write;
        sparkleGeometry.getAttribute('position').needsUpdate = true;
        sparkleGeometry.getAttribute('color').needsUpdate = true;
        sparkleGeometry.setDrawRange(0, write);
        sparklePoints.visible = write > 0;
      };

      const clearSparkles = () => {
        sparkles.length = 0;
        sparkleGeometry.setDrawRange(0, 0);
        sparklePoints.visible = false;
      };

      const computeHitPoint = (clientX: number, clientY: number): HitSample => {
        const point = new THREE.Vector3(0, 0, packSize.z / 2);
        const normal = new THREE.Vector3(0, 0, 1);
        const rect = canvas.getBoundingClientRect();
        if (rect.width && rect.height) {
          pointerNdc.set(
            ((clientX - rect.left) / rect.width) * 2 - 1,
            -(((clientY - rect.top) / rect.height) * 2 - 1),
          );
        } else {
          pointerNdc.set(0, 0);
        }
        raycaster.setFromCamera(pointerNdc, camera);
        if (packMeshes.length > 0) {
          const intersections = raycaster.intersectObjects(packMeshes, false);
          const nearest = intersections[0];
          if (nearest) {
            point.copy(nearest.point);
            if (nearest.face) {
              normal.copy(nearest.face.normal).transformDirection(nearest.object.matrixWorld);
            }
            return { point, normal };
          }
        }
        const frontPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), -(packSize.z / 2));
        if (raycaster.ray.intersectPlane(frontPlane, point)) {
          point.x = THREE.MathUtils.clamp(point.x, -packSize.x * 0.45, packSize.x * 0.45);
          point.y = THREE.MathUtils.clamp(point.y, -packSize.y * 0.45, packSize.y * 0.45);
          return { point, normal };
        }
        point.set(0, 0, packSize.z / 2);
        return { point, normal };
      };

      const finishBreakInstant = () => {
        clearCracks();
        packGroup.visible = false;
        packMeshes.forEach((mesh) => {
          mesh.visible = false;
        });
        if (fragmentsGroup) fragmentsGroup.visible = false;
        cardGroup.visible = true;
        cardGroup.scale.setScalar(1);
        fitSize.copy(cardOnly ? cardSize : packSize);
        fitCamera();
        setStage('revealed');
      };

      const startBreak = (hit: HitSample) => {
        if (!cardReady) return;
        cancelUnrestrictedDrag();
        onPackBreakRef.current?.();
        if (reducedMotionRef.current || shards.length === 0 || !fragmentsGroup) {
          finishBreakInstant();
          requestRender();
          return;
        }
        setStage('breaking');
        breakElapsed = 0;
        resetTilt();
        punchSpring.target = 1;
        spawnCrack(hit, false, true);
        attachCracksToShards();
        armShards(hit.point);
        packMeshes.forEach((mesh) => {
          mesh.visible = false;
        });
        fragmentsGroup.visible = true;
        cardGroup.visible = true;
        cardGroup.scale.setScalar(1);
        spawnSparkles(hit.point, BREAK_SPARKLE_COUNT);
        requestRender();
      };

      const applyHitEffect = (hit: HitSample, hitIndex: number, healable: boolean) => {
        if (!reducedMotionRef.current) {
          const rampIndex = Math.min(
            Math.floor(((hitIndex - 1) * HIT_INTENSITIES.length) / (HITS_TO_BREAK - 1)),
            HIT_INTENSITIES.length - 1,
          );
          const intensity = HIT_INTENSITIES[rampIndex] ?? HIT_INTENSITIES[0];
          punchSpring.velocity -= PUNCH_SCALE_IMPULSE * intensity;
          const tilt = tiltRef.current;
          tilt.velocityX += (Math.random() - 0.35) * HIT_TILT_JOLT * intensity;
          tilt.velocityY += (Math.random() - 0.5) * HIT_TILT_JOLT * 1.2 * intensity;
          spawnSparkles(hit.point, healable ? HIT_SPARKLE_COUNT : HIT_SPARKLE_COUNT + 6);
          spawnCrack(hit, healable);
        } else if (!healable) {
          spawnCrack(hit, false, true);
        }
      };

      const registerHit = (clientX: number, clientY: number) => {
        if (disposed || !viewerReadyRef.current || contextLost || !interactionEnabledRef.current) return;
        if (stageRef.current !== 'pack' || !packReady) return;
        const hit = computeHitPoint(clientX, clientY);
        if (hitProgressionModeRef.current === 'reveal-gated') {
          const result = advanceClearCardGatedHit(
            gatedHitState,
            cardReady && revealReadyRef.current,
          );
          gatedHitState = result.state;
          onPackHitRef.current?.(result.hitIndex);
          if (result.effect === 'break') {
            startBreak(hit);
            return;
          }
          applyHitEffect(hit, result.hitIndex, result.effect === 'recoverable');
          requestRender();
          return;
        }

        if (!cardReady) return;
        hitCount += 1;
        const hitIndex = hitCount;
        if (hitIndex >= HITS_TO_BREAK) {
          startBreak(hit);
          return;
        }
        onPackHitRef.current?.(hitIndex);
        const healable = hitIndex <= HEALABLE_HITS;
        applyHitEffect(hit, hitIndex, healable);
        requestRender();
      };

      const performReset = () => {
        if (disposed || !displayModelReady()) return;
        if (cardOnly) {
          finishBreakInstant();
          requestRender();
          return;
        }
        setStage('pack');
        hitCount = 0;
        gatedHitState = createClearCardGatedHitState();
        breakElapsed = 0;
        clearCracks();
        packGroup.visible = true;
        packGroup.scale.setScalar(1);
        packMeshes.forEach((mesh) => {
          mesh.visible = true;
        });
        if (fragmentsGroup) fragmentsGroup.visible = false;
        shards.forEach((shard) => {
          shard.holder.position.copy(shard.home);
          shard.holder.rotation.set(0, 0, 0);
          shard.velocity.set(0, 0, 0);
          shard.angularVelocity.set(0, 0, 0);
        });
        cardGroup.visible = false;
        cardGroup.scale.setScalar(1);
        punchSpring.current = 1;
        punchSpring.target = 1;
        punchSpring.velocity = 0;
        clearSparkles();
        if (viewModeRef.current !== 'tilt') {
          resetViewOrientation();
        } else {
          resetTilt();
        }
        fitSize.copy(packSize);
        fitCamera();
        requestRender();
      };

      const captureSnapshot = async (): Promise<ClearCardSnapshot> => {
        if (snapshotInFlight) {
          throw new Error('A snapshot is already rendering.');
        }
        const snapshotModelReady =
          displayModelReady() && (stageRef.current === 'pack' || cardReady);
        if (disposed || contextLost || !snapshotModelReady || !renderer || !viewerReadyRef.current) {
          throw new Error('Snapshot rendering is unavailable while the model is loading.');
        }
        const snapshotStage = stageRef.current;
        if (snapshotStage === 'breaking') {
          throw new Error('Snapshots are unavailable while the pack is breaking.');
        }

        snapshotInFlight = true;
        const activeRenderer = renderer;
        const previousRenderTarget = activeRenderer.getRenderTarget();
        const previousPixelRatio = activeRenderer.getPixelRatio();
        const previousRendererSize = activeRenderer.getSize(new THREE.Vector2());
        const previousCameraView = camera.view ? { ...camera.view } : null;
        const previousSparkleVisibility = sparklePoints.visible;
        const activeCrackGroup = crackGroup;
        const previousCrackVisibility = activeCrackGroup?.visible ?? false;
        const activeFragmentsGroup = fragmentsGroup;
        const previousFragmentsVisibility = activeFragmentsGroup?.visible ?? false;
        const previousPackScale = packGroup.scale.clone();
        let analysisTarget: THREE.WebGLRenderTarget | null = null;
        let blobPromise: Promise<Blob> | null = null;

        try {
          sparklePoints.visible = false;
          if (activeCrackGroup) activeCrackGroup.visible = false;
          if (activeFragmentsGroup) activeFragmentsGroup.visible = false;
          packGroup.scale.setScalar(1);

          const analysisWidth =
            cameraAspect >= 1
              ? SNAPSHOT_ANALYSIS_LONGEST_EDGE
              : Math.max(1, Math.round(SNAPSHOT_ANALYSIS_LONGEST_EDGE * cameraAspect));
          const analysisHeight =
            cameraAspect >= 1
              ? Math.max(1, Math.round(SNAPSHOT_ANALYSIS_LONGEST_EDGE / cameraAspect))
              : SNAPSHOT_ANALYSIS_LONGEST_EDGE;
          analysisTarget = new THREE.WebGLRenderTarget(analysisWidth, analysisHeight, {
            depthBuffer: true,
            stencilBuffer: false,
          });
          snapshotOutputTarget = analysisTarget;
          activeRenderer.setRenderTarget(analysisTarget);
          activeRenderer.clear();
          activeRenderer.render(scene, camera);

          const pixels = new Uint8Array(analysisWidth * analysisHeight * 4);
          activeRenderer.readRenderTargetPixels(
            analysisTarget,
            0,
            0,
            analysisWidth,
            analysisHeight,
            pixels,
          );
          const objectBounds = findOpaquePixelBounds(pixels, analysisWidth, analysisHeight);
          if (!objectBounds) {
            throw new Error('The displayed object did not produce any visible pixels.');
          }
          const cropBounds = padPixelBounds(
            objectBounds,
            analysisWidth,
            analysisHeight,
            SNAPSHOT_PADDING_RATIO,
          );
          const outputSize = resolveSnapshotOutputSize(
            cropBounds,
            SNAPSHOT_OUTPUT_LONGEST_EDGE,
          );

          snapshotOutputTarget = null;
          activeRenderer.setRenderTarget(null);
          camera.setViewOffset(
            analysisWidth,
            analysisHeight,
            cropBounds.x,
            cropBounds.y,
            cropBounds.width,
            cropBounds.height,
          );
          activeRenderer.setPixelRatio(1);
          activeRenderer.setSize(outputSize.width, outputSize.height, false);
          activeRenderer.render(scene, camera);
          blobPromise = copyCanvasToPngBlob(canvas);
        } finally {
          snapshotInFlight = false;
          snapshotOutputTarget = null;
          sparklePoints.visible = previousSparkleVisibility;
          if (activeCrackGroup) activeCrackGroup.visible = previousCrackVisibility;
          if (activeFragmentsGroup) {
            activeFragmentsGroup.visible = previousFragmentsVisibility;
          }
          packGroup.scale.copy(previousPackScale);
          if (previousCameraView?.enabled) {
            camera.setViewOffset(
              previousCameraView.fullWidth,
              previousCameraView.fullHeight,
              previousCameraView.offsetX,
              previousCameraView.offsetY,
              previousCameraView.width,
              previousCameraView.height,
            );
          } else {
            camera.clearViewOffset();
          }
          activeRenderer.setRenderTarget(null);
          activeRenderer.setPixelRatio(previousPixelRatio);
          activeRenderer.setSize(previousRendererSize.x, previousRendererSize.y, false);
          syncTransmissionBackdrop(stageRef.current, lightingConfigRef.current);
          activeRenderer.render(scene, camera);
          activeRenderer.setRenderTarget(previousRenderTarget);
          analysisTarget?.dispose();
          requestRender();
        }

        if (!blobPromise) throw new Error('The PNG snapshot could not be rendered.');
        return {
          blob: await blobPromise,
          objectKind: snapshotStage === 'pack' ? 'pack' : 'card',
        };
      };

      const renderFrame = (now: number) => {
        frameId = null;
        if (disposed || !renderer || document.visibilityState !== 'visible') return;
        if (interactionThrottleReleasePending && !snapBackRef.current.active) {
          interactionThrottleReleasePending = false;
          interactionActive = false;
          interactionProbeActive = false;
          setInteractionThrottle(false);
          startDisplayCadenceCalibration();
        }
        if (
          interactionThrottleActive &&
          lastInteractionFrameTime > 0 &&
          now - lastInteractionFrameTime < INTERACTION_FRAME_INTERVAL_MS
        ) {
          frameId = window.requestAnimationFrame(renderFrame);
          return;
        }
        if (interactionThrottleActive) lastInteractionFrameTime = now;
        if (interactionProbeActive) {
          const decision = adaptiveFrameRateMonitor.addFrame(now);
          if (decision !== 'sampling') interactionProbeActive = false;
          if (decision === 'throttle') {
            adaptiveInteractionThrottleRequired = true;
            adaptiveThrottleActivatedAt = Date.now();
            try {
              window.sessionStorage.setItem(
                ADAPTIVE_INTERACTION_THROTTLE_SESSION_KEY,
                String(adaptiveThrottleActivatedAt),
              );
            } catch {}
            setInteractionThrottle(true);
          }
        }

        const deltaSeconds = lastFrameTime
          ? Math.min((now - lastFrameTime) / 1_000, 1 / 30)
          : 1 / 60;
        lastFrameTime = now;
        const tilt = tiltRef.current;

        const rotationInteractionActive = viewModeRef.current !== 'tilt';
        if (reducedMotionRef.current) {
          tilt.currentX = 0;
          tilt.currentY = 0;
          tilt.targetX = 0;
          tilt.targetY = 0;
          tilt.velocityX = 0;
          tilt.velocityY = 0;
          snapSpringValue(punchSpring);
          clearSparkles();
          settleCracksInstantly();
          if (stageRef.current === 'breaking') finishBreakInstant();
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
          tilt.currentX = 0;
          tilt.currentY = 0;
          tilt.targetX = 0;
          tilt.targetY = 0;
          tilt.velocityX = 0;
          tilt.velocityY = 0;
        }

        const snapBack = snapBackRef.current;
        if (snapBack.active) {
          const rotationState = unrestrictedRotationRef.current;
          if (rotationState.pointerId !== null) {
            snapBack.active = false;
          } else if (reducedMotionRef.current) {
            settleSnapBackInstantly(rotationState.quaternion, snapBack);
          } else {
            stepSnapBackSpring(rotationState.quaternion, snapBack, deltaSeconds);
          }
        }

        if (!isSpringValueSettled(punchSpring)) {
          stepSpringValue(punchSpring, deltaSeconds, PUNCH_SPRING_STIFFNESS, PUNCH_SPRING_DAMPING);
        }
        packGroup.scale.setScalar(punchSpring.current);

        if (stageRef.current === 'breaking') {
          breakElapsed += deltaSeconds;
          const down = computeLocalDown();
          const gravity = shardLocalScale * SHARD_GRAVITY_FACTOR;
          const sideDrag = Math.exp(-SHARD_SIDE_DRIFT_DAMPING * deltaSeconds);
          const centering =
            SHARD_SIDE_CENTERING *
            Math.min(breakElapsed / SHARD_SIDE_CENTERING_RAMP_S, 1) *
            deltaSeconds;
          shards.forEach((shard) => {
            shard.velocity.addScaledVector(down, gravity * deltaSeconds);
            tmpVector2.copy(shard.holder.position).sub(packLocalCenter);
            tmpVector2.addScaledVector(down, -tmpVector2.dot(down));
            shard.velocity.addScaledVector(tmpVector2, -centering);
            const fallSpeed = shard.velocity.dot(down);
            tmpVector.copy(down).multiplyScalar(fallSpeed);
            shard.velocity.sub(tmpVector).multiplyScalar(sideDrag).add(tmpVector);
            shard.holder.position.addScaledVector(shard.velocity, deltaSeconds);
            shard.holder.rotation.x += shard.angularVelocity.x * deltaSeconds;
            shard.holder.rotation.y += shard.angularVelocity.y * deltaSeconds;
            shard.holder.rotation.z += shard.angularVelocity.z * deltaSeconds;
          });
          if (breakElapsed >= BREAK_SHARDS_HIDE_S && fragmentsGroup) {
            fragmentsGroup.visible = false;
          }
          if (breakElapsed >= BREAK_REVEAL_INTERACTIVE_S) {
            setStage('revealed');
          }
        }

        if (!reducedMotionRef.current) updateCracks(deltaSeconds);
        updateSparkles(deltaSeconds);

        if (rotationInteractionActive) {
          pivot.quaternion.copy(unrestrictedRotationRef.current.quaternion);
        } else {
          pivot.rotation.set(tilt.currentX, tilt.currentY, 0);
        }
        if (
          !shardTransmissionWarmed &&
          packUsesTransmission &&
          fragmentsGroup !== null &&
          !fragmentsGroup.visible &&
          packGroup.visible &&
          stageRef.current !== 'breaking'
        ) {
          // Allocate the shard pass's transmission target here rather than on the
          // frame the break starts; the cleared render below overwrites this pass.
          shardTransmissionWarmed = true;
          fragmentsGroup.visible = true;
          applyTransmissionBackdrop(lightingConfigRef.current, true);
          camera.updateMatrixWorld();
          syncShardCamera();
          renderer.transmissionResolutionScale = TRANSMISSION_RESOLUTION_SCALE_SHARDS;
          try {
            renderer.render(scene, shardCamera);
          } finally {
            renderer.transmissionResolutionScale = TRANSMISSION_RESOLUTION_SCALE_DEFAULT;
            fragmentsGroup.visible = false;
          }
        }
        const splitBackdropPasses =
          stageRef.current === 'breaking' &&
          packUsesTransmission &&
          fragmentsGroup !== null &&
          fragmentsGroup.visible;
        if (splitBackdropPasses) {
          const config = lightingConfigRef.current;
          applyTransmissionBackdrop(config, false);
          camera.layers.set(0);
          renderer.render(scene, camera);
          applyTransmissionBackdrop(config, true);
          syncShardCamera();
          renderer.transmissionResolutionScale = TRANSMISSION_RESOLUTION_SCALE_SHARDS;
          renderer.autoClear = false;
          try {
            renderer.render(scene, shardCamera);
          } finally {
            renderer.autoClear = true;
            renderer.transmissionResolutionScale = TRANSMISSION_RESOLUTION_SCALE_DEFAULT;
          }
          camera.layers.set(0);
          camera.layers.enable(SHARD_LAYER);
        } else {
          syncTransmissionBackdrop(stageRef.current, lightingConfigRef.current);
          renderer.render(scene, camera);
        }

        const tiltUnsettled =
          !rotationInteractionActive &&
          (Math.abs(tilt.targetX - tilt.currentX) > SPRING_EPSILON ||
            Math.abs(tilt.targetY - tilt.currentY) > SPRING_EPSILON ||
            Math.abs(tilt.velocityX) > SPRING_EPSILON ||
            Math.abs(tilt.velocityY) > SPRING_EPSILON);
        const effectsActive =
          sparkles.length > 0 ||
          cracks.some((crack) => !crack.settled) ||
          stageRef.current === 'breaking' ||
          !isSpringValueSettled(punchSpring);
        if (
          tiltUnsettled ||
          effectsActive ||
          snapBackRef.current.active ||
          interactionThrottleReleasePending ||
          interactionProbeActive
        ) {
          if (frameId === null) frameId = window.requestAnimationFrame(renderFrame);
        } else {
          tilt.currentX = tilt.targetX;
          tilt.currentY = tilt.targetY;
          tilt.velocityX = 0;
          tilt.velocityY = 0;
          snapSpringValue(punchSpring);
          lastFrameTime = 0;
        }
      };

      const requestRender = () => {
        if (disposed || frameId !== null) return;
        lastFrameTime = 0;
        frameId = window.requestAnimationFrame(renderFrame);
      };

      const setInteractionThrottle = (active: boolean) => {
        if (interactionFrameRateMode === 'unrestricted' || interactionThrottleActive === active) {
          return;
        }
        interactionThrottleActive = active;
        lastInteractionFrameTime = 0;
      };

      const stopDisplayCadenceCalibration = () => {
        if (displayCadenceFrameId === null) return;
        window.cancelAnimationFrame(displayCadenceFrameId);
        displayCadenceFrameId = null;
      };

      const startDisplayCadenceCalibration = () => {
        if (interactionFrameRateMode !== 'adaptive' || disposed || interactionActive) return;
        stopDisplayCadenceCalibration();
        let previousFrameTime: number | null = null;
        const frameIntervals: number[] = [];
        let attemptCount = 0;

        const sampleDisplayCadence = (now: number) => {
          displayCadenceFrameId = null;
          if (disposed || interactionActive) return;
          attemptCount += 1;
          if (previousFrameTime !== null) {
            const intervalMs = now - previousFrameTime;
            if (intervalMs > 0 && intervalMs <= DISPLAY_CADENCE_MAX_INTERVAL_MS) {
              frameIntervals.push(intervalMs);
            }
          }
          previousFrameTime = now;
          if (frameIntervals.length >= DISPLAY_CADENCE_SAMPLE_SIZE) {
            displayFrameIntervalMs = resolveMedianFrameInterval(frameIntervals);
            return;
          }
          if (attemptCount >= DISPLAY_CADENCE_MAX_ATTEMPTS) return;
          displayCadenceFrameId = window.requestAnimationFrame(sampleDisplayCadence);
        };

        displayCadenceFrameId = window.requestAnimationFrame(sampleDisplayCadence);
      };

      const startAdaptiveInteractionProbe = () => {
        interactionProbeActive =
          interactionFrameRateMode === 'adaptive' && !adaptiveInteractionThrottleRequired;
        if (!interactionProbeActive) return;
        adaptiveFrameRateMonitor = createAdaptiveFrameRateMonitor({
          slowFrameThresholdMs: resolveAdaptiveSlowFrameThreshold(displayFrameIntervalMs),
        });
      };

      const beginInteractionThrottle = () => {
        if (interactionFrameRateMode === 'unrestricted') return;
        if (interactionActive) {
          interactionThrottleReleasePending = false;
          return;
        }
        stopDisplayCadenceCalibration();
        interactionActive = true;
        interactionThrottleReleasePending = false;
        if (interactionFrameRateMode === 'adaptive' && adaptiveInteractionThrottleRequired) {
          const throttleAge = Date.now() - adaptiveThrottleActivatedAt;
          if (throttleAge < 0 || throttleAge >= ADAPTIVE_THROTTLE_REPROBE_MS) {
            adaptiveInteractionThrottleRequired = false;
            adaptiveThrottleActivatedAt = 0;
            try {
              window.sessionStorage.removeItem(ADAPTIVE_INTERACTION_THROTTLE_SESSION_KEY);
            } catch {}
          }
        }
        startAdaptiveInteractionProbe();
        setInteractionThrottle(
          interactionFrameRateMode === 'throttled' || adaptiveInteractionThrottleRequired,
        );
        requestRender();
      };

      const releaseInteractionThrottle = () => {
        if (!interactionActive) return;
        if (!interactionProbeActive) startAdaptiveInteractionProbe();
        interactionThrottleReleasePending = true;
        requestRender();
      };

      const getEnvironmentSignature = (config: ClearCardLightingConfig) => {
        return config.environment.mode === 'sky'
          ? JSON.stringify([config.environment.mode, config.environment.sky])
          : config.environment.mode;
      };

      const rebuildEnvironment = (config: ClearCardLightingConfig) => {
        if (!renderer) throw new Error('Clear-card renderer is unavailable');
        const signature = getEnvironmentSignature(config);
        if (config.environment.mode === 'none') {
          environmentRenderTarget?.dispose();
          environmentRenderTarget = null;
          scene.environment = null;
          environmentSignature = signature;
          return;
        }

        const pmremGenerator = new THREE.PMREMGenerator(renderer);
        let skyTexture: THREE.DataTexture | null = null;
        let roomEnvironment: RoomEnvironment | null = null;
        try {
          let nextEnvironmentRenderTarget: THREE.WebGLRenderTarget;
          if (config.environment.mode === 'room') {
            roomEnvironment = new RoomEnvironment();
            nextEnvironmentRenderTarget = pmremGenerator.fromScene(roomEnvironment);
          } else {
            skyTexture = createSkyEnvironmentTexture(config.environment.sky);
            nextEnvironmentRenderTarget = pmremGenerator.fromEquirectangular(skyTexture);
          }
          environmentRenderTarget?.dispose();
          environmentRenderTarget = nextEnvironmentRenderTarget;
          scene.environment = nextEnvironmentRenderTarget.texture;
          environmentSignature = signature;
        } finally {
          skyTexture?.dispose();
          if (roomEnvironment) disposeObject3D(roomEnvironment);
          pmremGenerator.dispose();
        }
      };

      const scheduleEnvironmentRebuild = (config: ClearCardLightingConfig) => {
        pendingEnvironmentConfig = config;
        if (environmentUpdateTimer !== null) {
          window.clearTimeout(environmentUpdateTimer);
        }
        environmentUpdateTimer = window.setTimeout(() => {
          environmentUpdateTimer = null;
          const nextConfig = pendingEnvironmentConfig;
          pendingEnvironmentConfig = null;
          if (!nextConfig || disposed || contextLost) return;
          try {
            rebuildEnvironment(nextConfig);
            requestRender();
          } catch (error) {
            console.error('[mons] failed to update the clear-card environment', error);
          }
        }, 90);
      };

      const applyLightingConfiguration = (
        config: ClearCardLightingConfig,
        rebuildImmediately = false,
      ) => {
        if (!renderer) return;

        const toneMapping = resolveToneMapping(config.renderer.toneMapping);
        if (lastToneMapping !== toneMapping) {
          renderer.toneMapping = toneMapping;
          lastToneMapping = toneMapping;
          markSceneMaterialsForUpdate();
        }
        renderer.toneMappingExposure = config.renderer.exposure;
        scene.environmentIntensity = config.environment.intensity;
        scene.environmentRotation.set(
          0,
          THREE.MathUtils.degToRad(config.environment.rotation),
          0,
        );

        ambientLight.color.set(config.ambient.color);
        ambientLight.intensity = config.ambient.intensity;
        hemisphereLight.color.set(config.hemisphere.skyColor);
        hemisphereLight.groundColor.set(config.hemisphere.groundColor);
        hemisphereLight.intensity = config.hemisphere.intensity;

        directionalLight.color.set(config.directional.color);
        directionalLight.intensity = config.directional.intensity;
        directionalLight.position.set(
          config.directional.position.x,
          config.directional.position.y,
          config.directional.position.z,
        );
        directionalTarget.position.set(
          config.directional.target.x,
          config.directional.target.y,
          config.directional.target.z,
        );

        rimLight.color.set(config.rim.color);
        rimLight.intensity = config.rim.intensity;
        rimLight.position.set(
          config.rim.position.x,
          config.rim.position.y,
          config.rim.position.z,
        );
        rimTarget.position.set(config.rim.target.x, config.rim.target.y, config.rim.target.z);

        areaLight.color.set(config.area.color);
        areaLight.intensity = config.area.intensity;
        areaLight.width = config.area.width;
        areaLight.height = config.area.height;
        areaLight.position.set(
          config.area.position.x,
          config.area.position.y,
          config.area.position.z,
        );
        areaLight.lookAt(config.area.target.x, config.area.target.y, config.area.target.z);

        pointLight.color.set(config.point.color);
        pointLight.intensity = config.point.intensity;
        pointLight.distance = config.point.distance;
        pointLight.decay = config.point.decay;
        pointLight.position.set(
          config.point.position.x,
          config.point.position.y,
          config.point.position.z,
        );

        spotLight.color.set(config.spot.color);
        spotLight.intensity = config.spot.intensity;
        spotLight.distance = config.spot.distance;
        spotLight.decay = config.spot.decay;
        spotLight.angle = THREE.MathUtils.degToRad(config.spot.angle);
        spotLight.penumbra = config.spot.penumbra;
        spotLight.position.set(
          config.spot.position.x,
          config.spot.position.y,
          config.spot.position.z,
        );
        spotTarget.position.set(config.spot.target.x, config.spot.target.y, config.spot.target.z);

        syncLightVisibility(stageRef.current, config);
        syncTransmissionBackdrop(stageRef.current, config);

        const nextEnvironmentSignature = getEnvironmentSignature(config);
        if (rebuildImmediately || nextEnvironmentSignature !== environmentSignature) {
          if (rebuildImmediately) {
            if (environmentUpdateTimer !== null) {
              window.clearTimeout(environmentUpdateTimer);
              environmentUpdateTimer = null;
            }
            pendingEnvironmentConfig = null;
            rebuildEnvironment(config);
          } else {
            scheduleEnvironmentRebuild(config);
          }
        } else if (environmentUpdateTimer !== null) {
          window.clearTimeout(environmentUpdateTimer);
          environmentUpdateTimer = null;
          pendingEnvironmentConfig = null;
        }
        requestRender();
      };

      const prewarmCardModel = () => {
        if (!renderer || !cardRoot || contextLost) return false;
        const target = new THREE.WebGLRenderTarget(64, 64, {
          depthBuffer: true,
          stencilBuffer: false,
        });
        const previousTarget = renderer.getRenderTarget();
        const previousPackVisibility = packGroup.visible;
        const previousCardVisibility = cardGroup.visible;
        const previousFragmentsVisibility = fragmentsGroup?.visible ?? false;
        try {
          packGroup.visible = false;
          if (fragmentsGroup) fragmentsGroup.visible = false;
          cardGroup.visible = true;
          renderer.setRenderTarget(target);
          renderer.clear();
          renderer.render(scene, camera);
          return true;
        } finally {
          packGroup.visible = previousPackVisibility;
          if (fragmentsGroup) fragmentsGroup.visible = previousFragmentsVisibility;
          cardGroup.visible = previousCardVisibility;
          renderer.setRenderTarget(previousTarget);
          target.dispose();
        }
      };

      const clearLoadedCard = () => {
        if (!cardRoot) return;
        cardGroup.remove(cardRoot);
        disposeObject3D(cardRoot);
        cardRoot = null;
      };

      const loadCardModel = (modelUrl: string | undefined, force = false) => {
        if (disposed || !renderer) return;
        if (!force && modelUrl && loadedCardModelUrl === modelUrl && cardReady) return;
        const loadDecision = clearCardModelLoadDecision({
          modelUrl,
          hasPackModel: !cardOnly,
          packReady,
        });

        cardLoadGeneration += 1;
        const generation = cardLoadGeneration;
        activeCardModelUrl = modelUrl;
        cardLoadingManager?.abort();
        cardDracoLoader?.dispose();
        cardLoadingManager = null;
        cardDracoLoader = null;
        clearLoadedCard();
        loadedCardModelUrl = undefined;
        cardReady = false;
        cardLoadFailed = false;

        if (loadDecision === 'idle' || !modelUrl) {
          reportCardModelLoadStatus('idle');
          updateViewerStatus();
          requestRender();
          return;
        }

        reportCardModelLoadStatus('loading');
        updateViewerStatus();
        if (loadDecision === 'defer') {
          requestRender();
          return;
        }
        cardLoadingManager = new THREE.LoadingManager();
        cardDracoLoader = new DRACOLoader(cardLoadingManager);
        cardDracoLoader.setDecoderPath(DRACO_DECODER_PATH);
        cardDracoLoader.setWorkerLimit(1);
        const loader = new GLTFLoader(cardLoadingManager);
        loader.setDRACOLoader(cardDracoLoader);

        void loader.loadAsync(modelUrl)
          .then((cardGltf) => {
            if (disposed || generation !== cardLoadGeneration) {
              disposeObject3D(cardGltf.scene);
              return;
            }
            cardRoot = cardGltf.scene;
            const rawCardSize = new THREE.Box3().setFromObject(cardRoot).getSize(new THREE.Vector3());
            const embedScale =
              packReady && rawCardSize.x > 0 && rawCardSize.y > 0
                ? Math.min(packSize.x / rawCardSize.x, packSize.y / rawCardSize.y) *
                  CARD_EMBED_FACTOR
                : 1;
            cardRoot.scale.setScalar(embedScale);
            centerObject(cardRoot, cardSize);
            cardGroup.add(cardRoot);
            const effectSize = packReady ? packSize : cardSize;
            sparkleWorldScale = Math.max(effectSize.x, effectSize.y, effectSize.z) || 1;
            sparkleMaterial.size = sparkleWorldScale * 0.05;
            if (cardOnly) {
              cardReady = true;
              fitSize.copy(cardSize);
              fitCamera();
              cardReady = false;
            }
            if (!prewarmCardModel()) {
              throw new Error('The clear-card model could not be prewarmed.');
            }
            loadedCardModelUrl = modelUrl;
            cardReady = true;
            cardLoadFailed = false;
            reportCardModelLoadStatus('ready');
            if (cardOnly || initiallyRevealedRef.current) {
              finishBreakInstant();
            }
            updateViewerStatus();
            requestRender();
          })
          .catch((error: unknown) => {
            if (disposed || generation !== cardLoadGeneration) return;
            clearLoadedCard();
            cardReady = false;
            cardLoadFailed = true;
            console.error('[mons] failed to load the clear-card model', error);
            reportCardModelLoadStatus('error');
            updateViewerStatus();
          })
          .finally(() => {
            if (generation !== cardLoadGeneration) return;
            cardDracoLoader?.dispose();
            cardDracoLoader = null;
            cardLoadingManager = null;
          });
      };

      const initializeViewer = () => {
        initializationFrameId = null;
        if (disposed) return;
        if (interactionFrameRateMode === 'adaptive') {
          try {
            const storedActivationTime = Number(
              window.sessionStorage.getItem(ADAPTIVE_INTERACTION_THROTTLE_SESSION_KEY),
            );
            const throttleAge = Date.now() - storedActivationTime;
            if (
              Number.isFinite(storedActivationTime) &&
              storedActivationTime > 0 &&
              throttleAge >= 0 &&
              throttleAge < ADAPTIVE_THROTTLE_REPROBE_MS
            ) {
              adaptiveInteractionThrottleRequired = true;
              adaptiveThrottleActivatedAt = storedActivationTime;
            } else {
              window.sessionStorage.removeItem(ADAPTIVE_INTERACTION_THROTTLE_SESSION_KEY);
            }
          } catch {
            adaptiveInteractionThrottleRequired = false;
            adaptiveThrottleActivatedAt = 0;
          }
        }
        requestRenderRef.current = requestRender;
        beginInteractionThrottleRef.current = beginInteractionThrottle;
        releaseInteractionThrottleRef.current = releaseInteractionThrottle;
        triggerHitRef.current = (clientX, clientY) => {
          let x = clientX;
          let y = clientY;
          if (x === undefined || y === undefined) {
            const rect = canvas.getBoundingClientRect();
            x = rect.left + rect.width / 2;
            y = rect.top + rect.height / 2;
          }
          registerHit(x, y);
        };
        performResetRef.current = performReset;
        loadCardModelRef.current = loadCardModel;
        retryCardModelRef.current = () => {
          if (activeCardModelUrl) loadCardModel(activeCardModelUrl, true);
        };

        syncRendererSize = () => {
          if (disposed || !renderer) return;
          const width = Math.max(1, canvas.clientWidth);
          const height = Math.max(1, canvas.clientHeight);
          renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO));
          renderer.setSize(width, height, false);
          cameraAspect = width / height;
          fitCamera();
        };
        resize = () => {
          syncRendererSize?.();
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
          renderer.transmissionResolutionScale = TRANSMISSION_RESOLUTION_SCALE_DEFAULT;
          applyLightingRef.current = (config) => applyLightingConfiguration(config);
          applyLightingConfiguration(lightingConfigRef.current, true);
          captureSnapshotRef.current = captureSnapshot;
        } catch (error) {
          console.error('[mons] failed to initialize the clear-card viewer', error);
          requestRenderRef.current = null;
          onStatusChange('error');
          return;
        }

        handleContextLost = (event) => {
          event.preventDefault();
          if (disposed) return;
          cancelUnrestrictedDrag();
          contextLost = true;
          viewerReadyRef.current = false;
          onStatusChange('error');
        };
        handleContextRestored = () => {
          if (disposed) return;
          contextLost = false;
          shardTransmissionWarmed = false;
          try {
            applyLightingConfiguration(lightingConfigRef.current, true);
          } catch (error) {
            console.error('[mons] failed to restore the clear-card environment', error);
            viewerReadyRef.current = false;
            onStatusChange('error');
            return;
          }
          if (cardRoot && cardReady) {
            reportCardModelLoadStatus('loading');
            try {
              if (prewarmCardModel()) {
                reportCardModelLoadStatus('ready');
              } else {
                cardReady = false;
                cardLoadFailed = true;
                reportCardModelLoadStatus('error');
              }
            } catch (error) {
              console.error('[mons] failed to prewarm the restored clear-card model', error);
              cardReady = false;
              cardLoadFailed = true;
              reportCardModelLoadStatus('error');
            }
          }
          updateViewerStatus();
          requestRender();
        };
        canvas.addEventListener('webglcontextlost', handleContextLost);
        canvas.addEventListener('webglcontextrestored', handleContextRestored);

        motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
        handleMotionPreference = () => {
          if (!motionQuery) return;
          reducedMotionRef.current = motionQuery.matches;
          if (motionQuery.matches) {
            cancelUnrestrictedDrag();
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
        startDisplayCadenceCalibration();

        if (!packModelUrl) {
          loadCardModel(cardModelUrlRef.current);
          return;
        }

        packLoadingManager = new THREE.LoadingManager();
        packDracoLoader = new DRACOLoader(packLoadingManager);
        packDracoLoader.setDecoderPath(DRACO_DECODER_PATH);
        packDracoLoader.setWorkerLimit(1);
        const packLoader = new GLTFLoader(packLoadingManager);
        packLoader.setDRACOLoader(packDracoLoader);

        void packLoader.loadAsync(packModelUrl)
          .then((packGltf) => {
            if (disposed) {
              disposeObject3D(packGltf.scene);
              return;
            }
            const packRoot = packGltf.scene;
            centerObject(packRoot, packSize);
            packGroup.add(packRoot);
            packRoot.traverse((object) => {
              if (!(object instanceof THREE.Mesh)) return;
              packMeshes.push(object);
              const materials = Array.isArray(object.material) ? object.material : [object.material];
              if (
                materials.some(
                  (material) =>
                    material instanceof THREE.MeshPhysicalMaterial && material.transmission > 0,
                )
              ) {
                packUsesTransmission = true;
              }
            });
            setStage(stageRef.current);
            syncPackDisplayRotation();
            let largestMeshSizeSq = -1;
            let largestPackMesh: THREE.Mesh | null = null;
            packMeshes.forEach((mesh) => {
              const meshSize = new THREE.Box3().setFromObject(mesh).getSize(new THREE.Vector3());
              const meshSizeSq = meshSize.lengthSq();
              if (meshSizeSq <= largestMeshSizeSq) return;
              largestMeshSizeSq = meshSizeSq;
              largestPackMesh = mesh;
            });
            if (largestPackMesh) buildPackShards(packMeshes, largestPackMesh);
            packReady = true;
            packLoadFailed = false;
            fitSize.copy(packSize);
            fitCamera();
            updateViewerStatus();
            requestRender();
            loadCardModel(cardModelUrlRef.current);
          })
          .catch((error: unknown) => {
            if (disposed) return;
            packReady = false;
            packLoadFailed = true;
            console.error('[mons] failed to load the clear-card pack model', error);
            updateViewerStatus();
          })
          .finally(() => {
            packDracoLoader?.dispose();
            packDracoLoader = null;
            packLoadingManager = null;
          });
      };

      initializationFrameId = window.requestAnimationFrame(initializeViewer);

      return () => {
        cancelUnrestrictedDrag();
        disposed = true;
        viewerReadyRef.current = false;
        requestRenderRef.current = null;
        applyLightingRef.current = null;
        applyAxisLockedOrbitRef.current = null;
        updateCameraViewRef.current = null;
        beginInteractionThrottleRef.current = null;
        releaseInteractionThrottleRef.current = null;
        triggerHitRef.current = null;
        performResetRef.current = null;
        loadCardModelRef.current = null;
        retryCardModelRef.current = null;
        captureSnapshotRef.current = null;
        cardLoadGeneration += 1;
        packLoadingManager?.abort();
        cardLoadingManager?.abort();
        if (initializationFrameId !== null) {
          window.cancelAnimationFrame(initializationFrameId);
        }
        stopDisplayCadenceCalibration();
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
        syncRendererSize = null;
        if (frameId !== null) window.cancelAnimationFrame(frameId);
        if (environmentUpdateTimer !== null) {
          window.clearTimeout(environmentUpdateTimer);
          environmentUpdateTimer = null;
        }
        pendingEnvironmentConfig = null;
        packDracoLoader?.dispose();
        packDracoLoader = null;
        cardDracoLoader?.dispose();
        cardDracoLoader = null;
        environmentRenderTarget?.dispose();
        environmentRenderTarget = null;
        disposeObject3D(scene);
        renderer?.renderLists.dispose();
        renderer?.dispose();
        renderer?.forceContextLoss();
      };
    }, [
      interactionFrameRateMode,
      cancelUnrestrictedDrag,
      cameraZoom,
      onStatusChange,
      packModelUrl,
      resetTilt,
      resetViewOrientation,
    ]);

    return (
      <canvas
        ref={canvasRef}
        className={`clear-card-wip__canvas${
          unrestrictedMovement || axisLockedOrbit
            ? ' clear-card-wip__canvas--unrestricted'
            : ''
        }`}
        role="img"
        aria-label={
          ariaLabel || (axisLockedOrbit
            ? 'Interactive 3D clear card; drag sideways or vertically with one-axis perspective orbit'
            : unrestrictedMovement
              ? 'Interactive 3D clear card; drag to rotate'
              : 'Interactive 3D clear card unboxing')
        }
        aria-hidden={!ready}
        onPointerEnter={handlePointerEnter}
        onPointerMove={handlePointerMove}
        onPointerDown={handlePointerDown}
        onPointerUp={handlePointerUp}
        onPointerLeave={handlePointerLeave}
        onPointerCancel={handlePointerCancel}
        onLostPointerCapture={handleLostPointerCapture}
      />
    );
  },
);

export default ClearCardThreeViewer;
