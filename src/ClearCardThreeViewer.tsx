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

const DRACO_DECODER_PATH = '/draco/0.185.1/';
const MAX_PIXEL_RATIO = 2;
const CANVAS_OVERSCAN = 1.5;
const CAMERA_FIT_MARGIN = 1.06;
const MAX_TILT_X = THREE.MathUtils.degToRad(25);
const MAX_TILT_Y = THREE.MathUtils.degToRad(14);
const SPRING_STIFFNESS = 60;
const SPRING_DAMPING = 11;
const SPRING_EPSILON = 0.0001;

const HITS_TO_BREAK = 3;
const HIT_INTENSITIES = [1, 1.3, 1.7] as const;
const PUNCH_SPRING_STIFFNESS = 190;
const PUNCH_SPRING_DAMPING = 14;
const PUNCH_SCALE_IMPULSE = 0.9;
const HIT_TILT_JOLT = 0.9;

const CARD_EMBED_FACTOR = 0.9;

const BREAK_SHARD_FADE_START_S = 0.4;
const BREAK_SHARD_FADE_END_S = 0.9;
const BREAK_SHARDS_HIDE_S = 0.95;
const BREAK_REVEAL_INTERACTIVE_S = 1;
const SHARD_GRAVITY_FACTOR = 9;

const MAX_SPARKLES = 64;
const HIT_SPARKLE_COUNT = 12;
const BREAK_SPARKLE_COUNT = 28;
const CARD_TRANSMISSION_BACKDROP_COLOR = 0x191919;
const CARD_TRANSMISSION_BACKDROP_ALPHA = 0.72;
const PACK_TRANSMISSION_BACKDROP_COLOR = 0x777777;
const PACK_TRANSMISSION_BACKDROP_ALPHA = 0.62;
const TRANSMISSIVE_PACK_ROTATION_X = THREE.MathUtils.degToRad(7);
const TRANSMISSIVE_PACK_ROTATION_Y = THREE.MathUtils.degToRad(-4);

type ViewerStatus = 'loading' | 'ready' | 'error';

type UnboxStage = 'pack' | 'breaking' | 'revealed';

export type ClearCardThreeViewerHandle = {
  reset: () => void;
  hit: () => void;
};

type ClearCardThreeViewerProps = {
  ready: boolean;
  cardModelUrl: string;
  packModelUrl: string;
  initiallyRevealed: boolean;
  onStatusChange: (status: ViewerStatus) => void;
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

type SpringValue = {
  current: number;
  target: number;
  velocity: number;
};

type PackShard = {
  holder: THREE.Group;
  material: THREE.Material;
  baseOpacity: number;
  home: THREE.Vector3;
  velocity: THREE.Vector3;
  angularVelocity: THREE.Vector3;
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

const ClearCardThreeViewer = forwardRef<ClearCardThreeViewerHandle, ClearCardThreeViewerProps>(
  function ClearCardThreeViewer(
    {
      ready,
      cardModelUrl,
      packModelUrl,
      initiallyRevealed,
      onStatusChange,
      onPackHit,
      onPackBreak,
    },
    ref,
  ) {
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const requestRenderRef = useRef<(() => void) | null>(null);
    const reducedMotionRef = useRef(false);
    const viewerReadyRef = useRef(false);
    const stageRef = useRef<UnboxStage>('pack');
    const initiallyRevealedRef = useRef(initiallyRevealed);
    const triggerHitRef = useRef<((clientX?: number, clientY?: number) => void) | null>(null);
    const performResetRef = useRef<(() => void) | null>(null);
    const onPackHitRef = useRef(onPackHit);
    const onPackBreakRef = useRef(onPackBreak);
    const tiltRef = useRef<TiltState>({
      currentX: 0,
      currentY: 0,
      targetX: 0,
      targetY: 0,
      velocityX: 0,
      velocityY: 0,
    });

    useEffect(() => {
      onPackHitRef.current = onPackHit;
      onPackBreakRef.current = onPackBreak;
    });

    useImperativeHandle(
      ref,
      () => ({
        reset: () => performResetRef.current?.(),
        hit: () => triggerHitRef.current?.(),
      }),
      [],
    );

    const resetTilt = useCallback(() => {
      tiltRef.current.targetX = 0;
      tiltRef.current.targetY = 0;
      requestRenderRef.current?.();
    }, []);

    const updateTilt = useCallback((event: ReactPointerEvent<HTMLCanvasElement>) => {
      if (!viewerReadyRef.current || reducedMotionRef.current) return;
      if (stageRef.current === 'breaking') return;
      const bounds = event.currentTarget.getBoundingClientRect();
      if (!bounds.width || !bounds.height) return;
      const pointerX = THREE.MathUtils.clamp((event.clientX - bounds.left) / bounds.width, 0, 1);
      const pointerY = THREE.MathUtils.clamp((event.clientY - bounds.top) / bounds.height, 0, 1);
      tiltRef.current.targetX = -(pointerY * 2 - 1) * MAX_TILT_X;
      tiltRef.current.targetY = -(pointerX * 2 - 1) * MAX_TILT_Y;
      requestRenderRef.current?.();
    }, []);

    const handlePointerEnter = updateTilt;
    const handlePointerMove = updateTilt;

    const handlePointerDown = useCallback(
      (event: ReactPointerEvent<HTMLCanvasElement>) => {
        if (stageRef.current === 'pack') {
          triggerHitRef.current?.(event.clientX, event.clientY);
        }
        updateTilt(event);
      },
      [updateTilt],
    );

    const handlePointerUp = useCallback(
      (event: ReactPointerEvent<HTMLCanvasElement>) => {
        if (event.pointerType === 'mouse') return;
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
      let modelsReady = false;
      let initializationFrameId: number | null = null;
      let frameId: number | null = null;
      let lastFrameTime = 0;
      let renderer: THREE.WebGLRenderer | null = null;
      let dracoLoader: DRACOLoader | null = null;
      let environmentRenderTarget: THREE.WebGLRenderTarget | null = null;
      let loadingManager: THREE.LoadingManager | null = null;
      let resizeObserver: ResizeObserver | null = null;
      let motionQuery: MediaQueryList | null = null;
      let handleMotionPreference: (() => void) | null = null;
      let handleVisibilityChange: (() => void) | null = null;
      let handleContextLost: ((event: Event) => void) | null = null;
      let handleContextRestored: (() => void) | null = null;
      let resize: (() => void) | null = null;

      const packMeshes: THREE.Mesh[] = [];
      let packUsesTransmission = false;
      let cardUsesTransmission = false;
      let fragmentsGroup: THREE.Group | null = null;
      let hitCount = 0;
      let breakElapsed = 0;
      let shardLocalScale = 1;
      const shards: PackShard[] = [];
      const packLocalCenter = new THREE.Vector3();
      const packSize = new THREE.Vector3();
      const cardSize = new THREE.Vector3();
      const fitSize = new THREE.Vector3();
      const punchSpring: SpringValue = { current: 1, target: 1, velocity: 0 };
      let sparkleWorldScale = 1;
      const sparkles: Sparkle[] = [];
      const tmpVector = new THREE.Vector3();
      const tmpMatrix = new THREE.Matrix4();
      const localDown = new THREE.Vector3();
      const raycaster = new THREE.Raycaster();
      const pointerNdc = new THREE.Vector2();

      const scene = new THREE.Scene();
      const pivot = new THREE.Group();
      const packGroup = new THREE.Group();
      const cardGroup = new THREE.Group();
      cardGroup.visible = false;
      const camera = new THREE.PerspectiveCamera(28, 1, 0.01, 100);
      const ambientLight = new THREE.AmbientLight(0xffffff, 0.3);
      const directionalLight = new THREE.DirectionalLight(0xffffff, 0.45 * Math.PI);
      directionalLight.position.set(0.5, 0, 0.866);
      camera.add(ambientLight, directionalLight);
      const transmissionBackdropMaterial = new THREE.ShaderMaterial({
        uniforms: {
          backdropColor: { value: new THREE.Color(CARD_TRANSMISSION_BACKDROP_COLOR) },
          backdropAlpha: { value: CARD_TRANSMISSION_BACKDROP_ALPHA },
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
        transmissionBackdropMaterial.colorWrite = activeRenderer.getRenderTarget() !== null;
      };
      pivot.add(packGroup);
      pivot.add(cardGroup);
      scene.add(transmissionBackdrop);
      scene.add(pivot);
      scene.add(camera);

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
      scene.add(sparklePoints);

      const setStage = (nextStage: UnboxStage) => {
        stageRef.current = nextStage;
        directionalLight.visible = nextStage === 'pack' || !cardUsesTransmission;
        const usePackBackdrop = nextStage === 'pack' && packUsesTransmission;
        transmissionBackdropMaterial.uniforms.backdropColor.value.setHex(
          usePackBackdrop
            ? PACK_TRANSMISSION_BACKDROP_COLOR
            : CARD_TRANSMISSION_BACKDROP_COLOR,
        );
        transmissionBackdropMaterial.uniforms.backdropAlpha.value = usePackBackdrop
          ? PACK_TRANSMISSION_BACKDROP_ALPHA
          : CARD_TRANSMISSION_BACKDROP_ALPHA;
      };
      setStage('pack');

      const fitCamera = () => {
        if (!modelsReady) return;
        const verticalFov = THREE.MathUtils.degToRad(camera.fov);
        const fitHeightDistance = fitSize.y / (2 * Math.tan(verticalFov / 2));
        const fitWidthDistance =
          fitSize.x / (2 * Math.tan(verticalFov / 2) * Math.max(camera.aspect, 0.01));
        const distance =
          Math.max(fitHeightDistance, fitWidthDistance) * CAMERA_FIT_MARGIN * CANVAS_OVERSCAN +
          fitSize.z / 2;
        camera.position.set(0, 0, Math.max(distance, 0.1));
        camera.lookAt(0, 0, 0);
        camera.updateProjectionMatrix();
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
        fragments.forEach((fragment) => {
          const fragmentCenter = fragment.boundingBox
            ? fragment.boundingBox.getCenter(new THREE.Vector3())
            : new THREE.Vector3();
          const material = sourceMaterial.clone();
          material.transparent = true;
          const shardMesh = new THREE.Mesh(fragment, material);
          shardMesh.position.copy(fragmentCenter).negate();
          const holder = new THREE.Group();
          holder.position.copy(fragmentCenter);
          holder.add(shardMesh);
          group.add(holder);
          shards.push({
            holder,
            material,
            baseOpacity: material.opacity,
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
          const material = pieceSourceMaterial.clone();
          material.transparent = true;
          const pieceMesh = new THREE.Mesh(mesh.geometry, material);
          relativeMatrix.decompose(pieceMesh.position, pieceMesh.quaternion, pieceMesh.scale);
          pieceMesh.position.sub(pieceCenter);
          const holder = new THREE.Group();
          holder.position.copy(pieceCenter);
          holder.add(pieceMesh);
          group.add(holder);
          shards.push({
            holder,
            material,
            baseOpacity: material.opacity,
            home: pieceCenter.clone(),
            velocity: new THREE.Vector3(),
            angularVelocity: new THREE.Vector3(),
          });
        });
      };

      const computeLocalDown = () => {
        if (!fragmentsGroup) return localDown.set(0, -1, 0);
        fragmentsGroup.updateWorldMatrix(true, false);
        return localDown
          .set(0, -1, 0)
          .transformDirection(tmpMatrix.copy(fragmentsGroup.matrixWorld).invert());
      };

      const armShards = () => {
        const down = computeLocalDown();
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

      const computeHitPoint = (clientX: number, clientY: number) => {
        const targetPoint = new THREE.Vector3(0, 0, packSize.z / 2);
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
          if (intersections.length > 0) {
            return targetPoint.copy(intersections[0].point);
          }
        }
        const frontPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), -(packSize.z / 2));
        if (raycaster.ray.intersectPlane(frontPlane, targetPoint)) {
          targetPoint.x = THREE.MathUtils.clamp(targetPoint.x, -packSize.x * 0.45, packSize.x * 0.45);
          targetPoint.y = THREE.MathUtils.clamp(targetPoint.y, -packSize.y * 0.45, packSize.y * 0.45);
          return targetPoint;
        }
        return targetPoint.set(0, 0, packSize.z / 2);
      };

      const finishBreakInstant = () => {
        packGroup.visible = false;
        packMeshes.forEach((mesh) => {
          mesh.visible = false;
        });
        if (fragmentsGroup) fragmentsGroup.visible = false;
        cardGroup.visible = true;
        cardGroup.scale.setScalar(1);
        fitSize.copy(packSize);
        fitCamera();
        setStage('revealed');
      };

      const startBreak = (point: THREE.Vector3) => {
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
        armShards();
        packMeshes.forEach((mesh) => {
          mesh.visible = false;
        });
        fragmentsGroup.visible = true;
        cardGroup.visible = true;
        cardGroup.scale.setScalar(1);
        spawnSparkles(point, BREAK_SPARKLE_COUNT);
        requestRender();
      };

      const registerHit = (clientX: number, clientY: number) => {
        if (disposed || !viewerReadyRef.current || contextLost) return;
        if (stageRef.current !== 'pack' || !modelsReady) return;
        hitCount += 1;
        const hitIndex = hitCount;
        const point = computeHitPoint(clientX, clientY);
        if (hitIndex >= HITS_TO_BREAK) {
          startBreak(point);
          return;
        }
        onPackHitRef.current?.(hitIndex);
        if (!reducedMotionRef.current) {
          const intensity = HIT_INTENSITIES[Math.min(hitIndex - 1, HIT_INTENSITIES.length - 1)];
          punchSpring.velocity -= PUNCH_SCALE_IMPULSE * intensity;
          const tilt = tiltRef.current;
          tilt.velocityX += (Math.random() - 0.35) * HIT_TILT_JOLT * intensity;
          tilt.velocityY += (Math.random() - 0.5) * HIT_TILT_JOLT * 1.2 * intensity;
          spawnSparkles(point, HIT_SPARKLE_COUNT);
        }
        requestRender();
      };

      const performReset = () => {
        if (disposed || !modelsReady) return;
        setStage('pack');
        hitCount = 0;
        breakElapsed = 0;
        packGroup.visible = true;
        packGroup.scale.setScalar(1);
        packMeshes.forEach((mesh) => {
          mesh.visible = true;
        });
        if (fragmentsGroup) fragmentsGroup.visible = false;
        shards.forEach((shard) => {
          shard.holder.position.copy(shard.home);
          shard.holder.rotation.set(0, 0, 0);
          shard.material.opacity = shard.baseOpacity;
          shard.velocity.set(0, 0, 0);
          shard.angularVelocity.set(0, 0, 0);
        });
        cardGroup.visible = false;
        cardGroup.scale.setScalar(1);
        punchSpring.current = 1;
        punchSpring.target = 1;
        punchSpring.velocity = 0;
        clearSparkles();
        resetTilt();
        fitSize.copy(packSize);
        fitCamera();
        requestRender();
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
          snapSpringValue(punchSpring);
          clearSparkles();
          if (stageRef.current === 'breaking') finishBreakInstant();
        } else {
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
        }

        if (!isSpringValueSettled(punchSpring)) {
          stepSpringValue(punchSpring, deltaSeconds, PUNCH_SPRING_STIFFNESS, PUNCH_SPRING_DAMPING);
        }
        packGroup.scale.setScalar(punchSpring.current);

        if (stageRef.current === 'breaking') {
          breakElapsed += deltaSeconds;
          const down = computeLocalDown();
          const gravity = shardLocalScale * SHARD_GRAVITY_FACTOR;
          const fadeRange = BREAK_SHARD_FADE_END_S - BREAK_SHARD_FADE_START_S;
          const fadeProgress = THREE.MathUtils.clamp(
            (breakElapsed - BREAK_SHARD_FADE_START_S) / fadeRange,
            0,
            1,
          );
          shards.forEach((shard) => {
            shard.velocity.addScaledVector(down, gravity * deltaSeconds);
            shard.holder.position.addScaledVector(shard.velocity, deltaSeconds);
            shard.holder.rotation.x += shard.angularVelocity.x * deltaSeconds;
            shard.holder.rotation.y += shard.angularVelocity.y * deltaSeconds;
            shard.holder.rotation.z += shard.angularVelocity.z * deltaSeconds;
            shard.material.opacity = shard.baseOpacity * (1 - fadeProgress);
          });
          if (breakElapsed >= BREAK_SHARDS_HIDE_S && fragmentsGroup) {
            fragmentsGroup.visible = false;
          }
          if (breakElapsed >= BREAK_REVEAL_INTERACTIVE_S) {
            setStage('revealed');
          }
        }

        updateSparkles(deltaSeconds);

        pivot.rotation.x = tilt.currentX;
        pivot.rotation.y = tilt.currentY;
        renderer.render(scene, camera);

        const tiltUnsettled =
          Math.abs(tilt.targetX - tilt.currentX) > SPRING_EPSILON ||
          Math.abs(tilt.targetY - tilt.currentY) > SPRING_EPSILON ||
          Math.abs(tilt.velocityX) > SPRING_EPSILON ||
          Math.abs(tilt.velocityY) > SPRING_EPSILON;
        const effectsActive =
          sparkles.length > 0 ||
          stageRef.current === 'breaking' ||
          !isSpringValueSettled(punchSpring);
        if (tiltUnsettled || effectsActive) {
          frameId = window.requestAnimationFrame(renderFrame);
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

      const rebuildEnvironment = () => {
        if (!renderer) throw new Error('Clear-card renderer is unavailable');
        const environment = new RoomEnvironment();
        const pmremGenerator = new THREE.PMREMGenerator(renderer);
        try {
          const nextEnvironmentRenderTarget = pmremGenerator.fromScene(environment);
          environmentRenderTarget?.dispose();
          environmentRenderTarget = nextEnvironmentRenderTarget;
          scene.environment = nextEnvironmentRenderTarget.texture;
        } finally {
          disposeObject3D(environment);
          pmremGenerator.dispose();
        }
      };

      const initializeViewer = () => {
        initializationFrameId = null;
        if (disposed) return;
        requestRenderRef.current = requestRender;
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

        resize = () => {
          if (disposed || !renderer) return;
          const width = Math.max(1, canvas.clientWidth);
          const height = Math.max(1, canvas.clientHeight);
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
          renderer.toneMapping = THREE.LinearToneMapping;
          renderer.toneMappingExposure = 1;
          rebuildEnvironment();
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
          try {
            rebuildEnvironment();
          } catch (error) {
            console.error('[mons] failed to restore the clear-card environment', error);
            viewerReadyRef.current = false;
            onStatusChange('error');
            return;
          }
          const restoredReady = modelsReady && !modelLoadFailed;
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

        void Promise.all([
          modelLoader.loadAsync(packModelUrl),
          modelLoader.loadAsync(cardModelUrl),
        ])
          .then(([packGltf, cardGltf]) => {
            if (disposed) {
              disposeObject3D(packGltf.scene);
              disposeObject3D(cardGltf.scene);
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
            if (packUsesTransmission) {
              packGroup.rotation.set(
                TRANSMISSIVE_PACK_ROTATION_X,
                TRANSMISSIVE_PACK_ROTATION_Y,
                0,
              );
            }
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

            const cardRoot = cardGltf.scene;
            const rawCardSize = new THREE.Box3().setFromObject(cardRoot).getSize(new THREE.Vector3());
            const embedScale =
              rawCardSize.x > 0 && rawCardSize.y > 0
                ? Math.min(packSize.x / rawCardSize.x, packSize.y / rawCardSize.y) *
                  CARD_EMBED_FACTOR
                : 1;
            cardRoot.scale.setScalar(embedScale);
            centerObject(cardRoot, cardSize);
            cardGroup.add(cardRoot);
            cardRoot.traverse((object) => {
              if (!(object instanceof THREE.Mesh)) return;
              const materials = Array.isArray(object.material) ? object.material : [object.material];
              if (
                materials.some(
                  (material) =>
                    material instanceof THREE.MeshPhysicalMaterial && material.transmission > 0,
                )
              ) {
                cardUsesTransmission = true;
              }
            });

            sparkleWorldScale = Math.max(packSize.x, packSize.y, packSize.z) || 1;
            sparkleMaterial.size = sparkleWorldScale * 0.05;

            modelsReady = true;
            if (initiallyRevealedRef.current) {
              finishBreakInstant();
            } else {
              fitSize.copy(packSize);
              fitCamera();
            }
            viewerReadyRef.current = !contextLost;
            onStatusChange(contextLost ? 'error' : 'ready');
            if (!contextLost) requestRender();
          })
          .catch((error: unknown) => {
            if (disposed) return;
            modelLoadFailed = true;
            console.error('[mons] failed to load the clear-card models', error);
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
        triggerHitRef.current = null;
        performResetRef.current = null;
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
        environmentRenderTarget?.dispose();
        environmentRenderTarget = null;
        disposeObject3D(scene);
        renderer?.renderLists.dispose();
        renderer?.dispose();
        renderer?.forceContextLoss();
      };
    }, [cardModelUrl, onStatusChange, packModelUrl]);

    return (
      <canvas
        ref={canvasRef}
        className="clear-card-wip__canvas"
        role="img"
        aria-label="Interactive 3D clear card unboxing"
        aria-hidden={!ready}
        onPointerEnter={handlePointerEnter}
        onPointerMove={handlePointerMove}
        onPointerDown={handlePointerDown}
        onPointerUp={handlePointerUp}
        onPointerLeave={resetTilt}
        onPointerCancel={resetTilt}
      />
    );
  },
);

export default ClearCardThreeViewer;
