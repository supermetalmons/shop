import * as THREE from 'three';
import type { MiNotePackStar } from './miNotePackStars';
import { normalizeMiNoteStarFoldPosition, normalizeMiNoteStarRotationOffset } from './miNoteStarFolds';

const STICKER_SIZE = 512;
const STICKER_WIDTH = 0.56;
const SURFACE_CLEARANCE = 0.0003;
const PROFILE_SEGMENTS = [48, 16, 32, 16, 48];
const WIDTH_SEGMENTS = PROFILE_SEGMENTS.reduce((total, count) => total + count, 0);
const HEIGHT_SEGMENTS = 48;
const FALL_DURATION = 1.15;
const ARTWORK_TIMEOUT_MS = 30_000;

function sealPoint(distance: number, bendAngle: number, radius: number, edgeLength: number, curvature: number) {
  if (distance <= 0) return { x: distance, z: 0 };
  const arcLength = radius * bendAngle;
  const firstAngle = Math.min(distance / radius, bendAngle);
  const edge = THREE.MathUtils.clamp(distance - arcLength, 0, edgeLength);
  const secondAngle = THREE.MathUtils.clamp((distance - arcLength - edgeLength) / radius, 0, bendAngle);
  const angle = 2 * bendAngle;
  const tail = Math.max(0, distance - 2 * arcLength - edgeLength);
  const tipLength = Math.max(0, tail - 0.012);
  const straight = Math.min(tail, 0.012);
  let tipX = tipLength * Math.cos(angle);
  let tipZ = tipLength * Math.sin(angle);
  if (Math.abs(curvature) > 0.00001) {
    tipX = (Math.sin(angle + curvature * tipLength) - Math.sin(angle)) / curvature;
    tipZ = (Math.cos(angle) - Math.cos(angle + curvature * tipLength)) / curvature;
  }
  return {
    x: radius * (Math.sin(firstAngle) + Math.sin(bendAngle + secondAngle) - Math.sin(bendAngle))
      + edge * Math.cos(bendAngle) + straight * Math.cos(angle) + tipX,
    z: radius * (1 - Math.cos(firstAngle) + Math.cos(bendAngle) - Math.cos(bendAngle + secondAngle))
      + edge * Math.sin(bendAngle) + straight * Math.sin(angle) + tipZ,
  };
}

export function createMiNotePackSeal({
  parent,
  fallRoot,
  width,
  spine,
  thickness,
  star,
  foldPosition,
  rotationOffsetDegrees,
  onInvalidate,
}: {
  parent: THREE.Group;
  fallRoot: THREE.Group;
  width: number;
  spine: number;
  thickness: number;
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
  const geometry = new THREE.PlaneGeometry(STICKER_WIDTH, STICKER_WIDTH, WIDTH_SEGMENTS, HEIGHT_SEGMENTS);
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
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const back = -thickness / 2 - SURFACE_CLEARANCE;
    const wrapLength = Math.PI * SURFACE_CLEARANCE + spine + thickness;
    const backTangent = currentFoldPosition + wrapLength / (2 * STICKER_WIDTH);
    const bendAngle = THREE.MathUtils.lerp(Math.PI / 2, 0.425, eased);
    const arcLength = THREE.MathUtils.lerp(Math.PI * SURFACE_CLEARANCE / 2, 0.125, eased);
    const edgeLength = (spine + thickness) * (1 - eased);
    const radius = arcLength / bendAngle;
    const curl = THREE.MathUtils.clamp((eased - 0.65) / 0.35, 0, 1);
    const curvature = -24 * curl * curl * (3 - 2 * curl);
    const distances = [2 * arcLength + edgeLength, arcLength + edgeLength, arcLength, 0];
    const uniformRows = HEIGHT_SEGMENTS - 2 * distances.length;
    const rows = Array.from({ length: uniformRows + 1 }, (_, row) => 1 - row / uniformRows);
    for (const distance of distances) {
      for (const u of [0, 1]) {
        rows.push(Math.abs(sin) < 1e-8 ? 0 : THREE.MathUtils.clamp(
          0.5 + (distance - (backTangent - 0.5) * STICKER_WIDTH + (u - 0.5) * STICKER_WIDTH * cos) / (STICKER_WIDTH * sin),
          0,
          1,
        ));
      }
    }
    rows.sort((a, b) => b - a);
    for (let row = 0; row <= HEIGHT_SEGMENTS; row += 1) {
      const v = rows[row];
      const y = (v - 0.5) * STICKER_WIDTH;
      const boundaries = [0, ...distances.map((distance) => THREE.MathUtils.clamp(
        0.5 + ((backTangent - 0.5) * STICKER_WIDTH - distance + y * sin) / (STICKER_WIDTH * cos),
        0,
        1,
      )), 1];
      let column = 0;
      for (let section = 0; section < PROFILE_SEGMENTS.length; section += 1) {
        const segments = PROFILE_SEGMENTS[section];
        for (let step = section === 0 ? 0 : 1; step <= segments; step += 1) {
          const u = THREE.MathUtils.lerp(boundaries[section], boundaries[section + 1], step / segments);
          const x = (u - 0.5) * STICKER_WIDTH;
          const rotatedX = x * cos - y * sin;
          const rotatedY = x * sin + y * cos;
          const distance = (backTangent - 0.5) * STICKER_WIDTH - rotatedX;
          const point = sealPoint(distance, bendAngle, radius, edgeLength, curvature);
          const index = row * (WIDTH_SEGMENTS + 1) + column;
          position.setXYZ(index, point.x, rotatedY, back + point.z - spine / 2);
          uv.setXY(index, u, v);
          column += 1;
        }
      }
    }
    position.needsUpdate = true;
    uv.needsUpdate = true;
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
