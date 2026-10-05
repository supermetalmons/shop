import * as THREE from 'three';
import type { MiNotePackStar } from './miNotePackStars';
import { normalizeMiNoteStarFoldPosition, normalizeMiNoteStarRotationOffset } from './miNoteStarFolds';

const STICKER_SIZE = 512;
const STICKER_WIDTH = 0.56;
const FALL_DURATION = 1.15;
const ARTWORK_TIMEOUT_MS = 30_000;

function sealPoint(u: number, progress: number, width: number, spine: number, foldPosition: number) {
  const back = -0.0035;
  const radius = (spine + 0.007) / 2;
  const backTangent = foldPosition + Math.PI * radius / (2 * STICKER_WIDTH);
  const distance = (backTangent - u) * STICKER_WIDTH;
  if (distance <= 0) return { x: width + distance, z: back };
  const angle = Math.PI * (1 - progress) + 0.85 * progress;
  const length = Math.PI * radius * (1 - progress) + 0.25 * progress;
  const bendRadius = length / angle;
  const theta = Math.min(distance / bendRadius, angle);
  const tail = Math.max(0, distance - length);
  const tipLength = Math.max(0, tail - 0.012);
  const straight = Math.min(tail, 0.012);
  const curl = THREE.MathUtils.clamp((progress - 0.65) / 0.35, 0, 1);
  const curvature = -24 * curl * curl * (3 - 2 * curl);
  let tipX = tipLength * Math.cos(angle);
  let tipZ = tipLength * Math.sin(angle);
  if (Math.abs(curvature) > 0.00001) {
    tipX = (Math.sin(angle + curvature * tipLength) - Math.sin(angle)) / curvature;
    tipZ = (Math.cos(angle) - Math.cos(angle + curvature * tipLength)) / curvature;
  }
  return {
    x: width + bendRadius * Math.sin(theta) + straight * Math.cos(angle) + tipX,
    z: back + bendRadius * (1 - Math.cos(theta)) + straight * Math.sin(angle) + tipZ,
  };
}

export function createMiNotePackSeal({
  parent,
  fallRoot,
  width,
  spine,
  star,
  foldPosition,
  rotationOffsetDegrees,
  onInvalidate,
}: {
  parent: THREE.Group;
  fallRoot: THREE.Group;
  width: number;
  spine: number;
  star: MiNotePackStar;
  foldPosition: number;
  rotationOffsetDegrees: number;
  onInvalidate?: () => void;
}) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = STICKER_SIZE;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('The star sticker canvas could not be created.');
  const map = new THREE.CanvasTexture(canvas);
  map.colorSpace = THREE.SRGBColorSpace;
  map.anisotropy = 4;
  const material = new THREE.MeshStandardMaterial({
    map,
    roughness: 0.4,
    metalness: 0.06,
    side: THREE.DoubleSide,
    alphaTest: 0.4,
    alphaToCoverage: true,
  });
  material.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace('#include <opaque_fragment>', `
      if (!gl_FrontFacing) outgoingLight = vec3(.78, .76, .68);
      #include <opaque_fragment>
    `);
  };
  material.customProgramCacheKey = () => 'mi-note-printed-star-seal-v1';
  const geometry = new THREE.PlaneGeometry(STICKER_WIDTH, STICKER_WIDTH, 160, 48);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  const pivot = new THREE.Group();
  pivot.position.set(width, 0, spine / 2);
  pivot.add(mesh);
  parent.add(pivot);

  let disposed = false;
  let started = false;
  let finished = false;
  let lastProgress = -1;
  let currentFoldPosition = normalizeMiNoteStarFoldPosition(foldPosition);
  let currentRotationOffsetDegrees = normalizeMiNoteStarRotationOffset(rotationOffsetDegrees);
  const startPosition = new THREE.Vector3();
  const startQuaternion = new THREE.Quaternion();
  const tumble = new THREE.Quaternion();
  const tumbleEuler = new THREE.Euler();
  const fallOffset = new THREE.Vector3();
  const pose = (progress: number) => {
    if (progress === lastProgress) return;
    lastProgress = progress;
    const position = geometry.attributes.position;
    const uv = geometry.attributes.uv;
    const eased = progress ** 3 * (10 - 15 * progress + 6 * progress * progress);
    const angle = THREE.MathUtils.degToRad(5 - currentRotationOffsetDegrees);
    for (let i = 0; i < position.count; i += 1) {
      const x = (uv.getX(i) - 0.5) * STICKER_WIDTH;
      const y = (uv.getY(i) - 0.5) * STICKER_WIDTH;
      const rotatedX = x * Math.cos(angle) - y * Math.sin(angle);
      const rotatedY = x * Math.sin(angle) + y * Math.cos(angle);
      const point = sealPoint(rotatedX / STICKER_WIDTH + 0.5, eased, width, spine, currentFoldPosition);
      position.setXYZ(i, point.x - width, rotatedY, point.z - spine / 2);
    }
    position.needsUpdate = true;
    geometry.computeVertexNormals();
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
  };
  pose(0);

  const artwork = new Image();
  let cancelReady: (() => void) | undefined;
  let loadTimeout: ReturnType<typeof setTimeout> | undefined;
  const clearLoadTimeout = () => {
    if (loadTimeout === undefined) return;
    clearTimeout(loadTimeout);
    loadTimeout = undefined;
  };
  const ready = new Promise<void>((resolve, reject) => {
    cancelReady = () => reject(new DOMException('Star sticker loading was cancelled.', 'AbortError'));
    artwork.onload = () => {
      clearLoadTimeout();
      if (disposed) return;
      try {
        const scale = STICKER_SIZE / Math.max(artwork.naturalWidth, artwork.naturalHeight);
        const artworkWidth = artwork.naturalWidth * scale;
        const artworkHeight = artwork.naturalHeight * scale;
        context.imageSmoothingQuality = 'high';
        context.drawImage(artwork, (STICKER_SIZE - artworkWidth) / 2, (STICKER_SIZE - artworkHeight) / 2, artworkWidth, artworkHeight);
        map.needsUpdate = true;
        cancelReady = undefined;
        resolve();
        onInvalidate?.();
      } catch (error) {
        cancelReady = undefined;
        reject(error);
      }
    };
    artwork.onerror = () => {
      clearLoadTimeout();
      cancelReady = undefined;
      reject(new Error('The star sticker could not be loaded.'));
    };
    loadTimeout = setTimeout(() => {
      loadTimeout = undefined;
      artwork.onload = null;
      artwork.onerror = null;
      artwork.removeAttribute('src');
      cancelReady = undefined;
      reject(new Error('The star sticker took too long to load.'));
    }, ARTWORK_TIMEOUT_MS);
    artwork.src = star.src;
  });

  return {
    ready,
    setFoldPosition(value: number) {
      const next = normalizeMiNoteStarFoldPosition(value);
      if (disposed || next === currentFoldPosition) return;
      currentFoldPosition = next;
      const progress = lastProgress;
      lastProgress = -1;
      pose(progress);
      onInvalidate?.();
    },
    setRotationOffsetDegrees(value: number) {
      const next = normalizeMiNoteStarRotationOffset(value);
      if (disposed || next === currentRotationOffsetDegrees) return;
      currentRotationOffsetDegrees = next;
      const progress = lastProgress;
      lastProgress = -1;
      pose(progress);
      onInvalidate?.();
    },
    start() {
      if (started || disposed) return;
      started = true;
      fallRoot.updateWorldMatrix(true, true);
      fallRoot.attach(pivot);
      startPosition.copy(pivot.position);
      startQuaternion.copy(pivot.quaternion);
      onInvalidate?.();
    },
    update(elapsedSeconds: number, reducedMotion: boolean) {
      if (finished || disposed) return true;
      if (!started) return false;
      const elapsed = Math.max(0, elapsedSeconds);
      if (reducedMotion || elapsed >= FALL_DURATION) {
        finished = true;
        pivot.visible = false;
        return true;
      }
      pose(THREE.MathUtils.clamp(elapsed / 0.62, 0, 1));
      const fallTime = Math.max(0, elapsed - 0.12);
      pivot.position.copy(startPosition).add(fallOffset.set(
        0.42 * fallTime,
        0.16 * fallTime - 4.6 * fallTime * fallTime,
        Math.min(0.42, fallTime * 0.6),
      ));
      tumble.setFromEuler(tumbleEuler.set(fallTime * 4.2, fallTime * -2.3, fallTime * -2.7));
      pivot.quaternion.copy(startQuaternion).multiply(tumble);
      return false;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      artwork.onload = null;
      artwork.onerror = null;
      artwork.removeAttribute('src');
      clearLoadTimeout();
      cancelReady?.();
      cancelReady = undefined;
      pivot.removeFromParent();
      geometry.dispose();
      material.dispose();
      map.dispose();
    },
  };
}
