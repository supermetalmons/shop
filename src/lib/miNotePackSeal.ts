import * as THREE from 'three';
import type { MiNotePackStar } from './miNotePackStars';
import { normalizeMiNoteStarFoldPosition, normalizeMiNoteStarRotationOffset } from './miNoteStarFolds';

const STICKER_SIZE = 512;
const STICKER_WIDTH = 0.56;
const SURFACE_CLEARANCE = 0.0015;
const PROFILE_SEGMENTS = [56, 64, 40];
const WIDTH_SEGMENTS = PROFILE_SEGMENTS.reduce((total, count) => total + count, 0);
const HEIGHT_SEGMENTS = 48;
const PEEL_DURATION = 1.2;
const ARTWORK_TIMEOUT_MS = 30_000;

function sealPoint(distance: number, angle: number, radius: number, curvature: number) {
  if (distance <= 0) return { x: distance, z: 0 };
  const theta = Math.min(distance / radius, angle);
  const tail = Math.max(0, distance - radius * angle);
  const tipLength = Math.max(0, tail - 0.012);
  const straight = Math.min(tail, 0.012);
  let tipX = tipLength * Math.cos(angle);
  let tipZ = tipLength * Math.sin(angle);
  if (Math.abs(curvature) > 0.00001) {
    tipX = (Math.sin(angle + curvature * tipLength) - Math.sin(angle)) / curvature;
    tipZ = (Math.cos(angle) - Math.cos(angle + curvature * tipLength)) / curvature;
  }
  return {
    x: radius * Math.sin(theta) + straight * Math.cos(angle) + tipX,
    z: radius * (1 - Math.cos(theta)) + straight * Math.sin(angle) + tipZ,
  };
}

export function createMiNotePackSeal({
  parent,
  width,
  spine,
  thickness,
  star,
  foldPosition,
  rotationOffsetDegrees,
  onInvalidate,
}: {
  parent: THREE.Group;
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
  const material = new THREE.MeshPhysicalMaterial({
    map,
    roughness: 0.36,
    metalness: 0.06,
    clearcoat: 0.65,
    clearcoatRoughness: 0.24,
    side: THREE.DoubleSide,
    alphaTest: 0.4,
    alphaToCoverage: true,
  });
  material.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <color_fragment>', `
        #include <color_fragment>
        if (!gl_FrontFacing) diffuseColor.rgb = vec3(.57, .53, .43);
      `)
      .replace('#include <metalnessmap_fragment>', `
        #include <metalnessmap_fragment>
        if (!gl_FrontFacing) {
          metalnessFactor = 0.0;
          roughnessFactor = .94;
        }
      `)
      .replace('#include <lights_physical_fragment>', `
        #include <lights_physical_fragment>
        if (!gl_FrontFacing) material.clearcoat = 0.0;
      `);
  };
  material.customProgramCacheKey = () => 'mi-note-printed-star-seal-v2';
  const geometry = new THREE.PlaneGeometry(STICKER_WIDTH, STICKER_WIDTH, WIDTH_SEGMENTS, HEIGHT_SEGMENTS);
  (geometry.attributes.position as THREE.BufferAttribute).setUsage(THREE.DynamicDrawUsage);
  (geometry.attributes.normal as THREE.BufferAttribute).setUsage(THREE.DynamicDrawUsage);
  (geometry.attributes.uv as THREE.BufferAttribute).setUsage(THREE.DynamicDrawUsage);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  let pixels: Uint8ClampedArray | undefined;
  mesh.raycast = (raycaster, intersections) => {
    if (!pixels) return;
    const hits: THREE.Intersection[] = [];
    THREE.Mesh.prototype.raycast.call(mesh, raycaster, hits);
    for (const hit of hits) {
      if (!hit.uv) continue;
      const x = THREE.MathUtils.clamp(Math.floor(hit.uv.x * STICKER_SIZE), 0, STICKER_SIZE - 1);
      const y = THREE.MathUtils.clamp(Math.floor((1 - hit.uv.y) * STICKER_SIZE), 0, STICKER_SIZE - 1);
      if (pixels[(y * STICKER_SIZE + x) * 4 + 3] / 255 >= material.alphaTest) intersections.push(hit);
    }
  };
  const pivot = new THREE.Group();
  pivot.position.set(width, 0, spine / 2);
  pivot.add(mesh);
  parent.add(pivot);
  const shadowMaterial = new THREE.MeshBasicMaterial({
    map,
    color: 0x000000,
    vertexColors: true,
    transparent: true,
    opacity: 0.22,
    depthWrite: false,
    side: THREE.DoubleSide,
    toneMapped: false,
  });
  const shadows = [-1, 1].map((side) => {
    const shadowGeometry = new THREE.PlaneGeometry(STICKER_WIDTH, STICKER_WIDTH, WIDTH_SEGMENTS, HEIGHT_SEGMENTS);
    shadowGeometry.setAttribute('uv', geometry.attributes.uv);
    shadowGeometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(geometry.attributes.position.count * 4), 4).setUsage(THREE.DynamicDrawUsage));
    (shadowGeometry.attributes.position as THREE.BufferAttribute).setUsage(THREE.DynamicDrawUsage);
    const shadow = new THREE.Mesh(shadowGeometry, shadowMaterial);
    shadow.frustumCulled = false;
    shadow.raycast = () => undefined;
    pivot.add(shadow);
    return { geometry: shadowGeometry, side };
  });

  let disposed = false;
  let started = false;
  let finished = false;
  let lastProgress = -1;
  let lastFlutter = 0;
  let lastTwist = 0;
  let currentFoldPosition = normalizeMiNoteStarFoldPosition(foldPosition);
  let currentRotationOffsetDegrees = normalizeMiNoteStarRotationOffset(rotationOffsetDegrees);
  const pose = (progress: number, flutter = 0, twist = 0) => {
    if (progress === lastProgress && flutter === lastFlutter && twist === lastTwist) return;
    lastProgress = progress;
    lastFlutter = flutter;
    lastTwist = twist;
    const position = geometry.attributes.position;
    const uv = geometry.attributes.uv;
    const eased = progress ** 3 * (10 - 15 * progress + 6 * progress * progress);
    const angle = THREE.MathUtils.degToRad(5 - currentRotationOffsetDegrees);
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const back = -thickness / 2 - SURFACE_CLEARANCE;
    const closedRadius = (spine + thickness + 2 * SURFACE_CLEARANCE) / 2;
    const wrapLength = Math.PI * closedRadius;
    const backTangent = currentFoldPosition + wrapLength / (2 * STICKER_WIDTH);
    const bendAngle = THREE.MathUtils.lerp(Math.PI, 0.85, eased) + flutter;
    const peeledArcLength = Math.max(wrapLength, Math.min(0.25, backTangent * STICKER_WIDTH * 0.66));
    const arcLength = THREE.MathUtils.lerp(wrapLength, peeledArcLength, eased);
    const curl = THREE.MathUtils.clamp((eased - 0.65) / 0.35, 0, 1);
    const curvature = -24 * curl * curl * (3 - 2 * curl);
    const distances = [arcLength, 0];
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
      const rowAngle = bendAngle + twist * y / STICKER_WIDTH;
      const radius = arcLength / rowAngle;
      let column = 0;
      for (let section = 0; section < PROFILE_SEGMENTS.length; section += 1) {
        const segments = PROFILE_SEGMENTS[section];
        for (let step = section === 0 ? 0 : 1; step <= segments; step += 1) {
          const u = THREE.MathUtils.lerp(boundaries[section], boundaries[section + 1], step / segments);
          const x = (u - 0.5) * STICKER_WIDTH;
          const rotatedX = x * cos - y * sin;
          const rotatedY = x * sin + y * cos;
          const distance = (backTangent - 0.5) * STICKER_WIDTH - rotatedX;
          const point = sealPoint(distance, rowAngle, radius, curvature + flutter * 8);
          const index = row * (WIDTH_SEGMENTS + 1) + column;
          position.setXYZ(index, point.x, rotatedY, back + point.z - spine / 2);
          uv.setXY(index, u, v);
          for (const shadow of shadows) {
            const surface = shadow.side < 0 ? -thickness / 2 : spine + thickness / 2;
            const lift = shadow.side * (back + point.z - surface);
            const opacity = lift > 0 ? Math.exp(-lift * 65) : 0;
            shadow.geometry.attributes.position.setXYZ(index,
              Math.min(0, point.x + Math.max(0, lift) * 0.4),
              rotatedY - Math.max(0, lift) * 0.6,
              surface + shadow.side * 0.0001 - spine / 2,
            );
            shadow.geometry.attributes.color.setXYZW(index, 1, 1, 1, opacity);
          }
          column += 1;
        }
      }
    }
    position.needsUpdate = true;
    uv.needsUpdate = true;
    geometry.computeVertexNormals();
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    for (const shadow of shadows) {
      shadow.geometry.attributes.position.needsUpdate = true;
      shadow.geometry.attributes.color.needsUpdate = true;
    }
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
        pixels = context.getImageData(0, 0, STICKER_SIZE, STICKER_SIZE).data;
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
      pose(progress, lastFlutter, lastTwist);
      onInvalidate?.();
    },
    setRotationOffsetDegrees(value: number) {
      const next = normalizeMiNoteStarRotationOffset(value);
      if (disposed || next === currentRotationOffsetDegrees) return;
      currentRotationOffsetDegrees = next;
      const progress = lastProgress;
      lastProgress = -1;
      pose(progress, lastFlutter, lastTwist);
      onInvalidate?.();
    },
    start() {
      if (started || disposed) return;
      started = true;
      onInvalidate?.();
    },
    update(elapsedSeconds: number, reducedMotion: boolean, motion = 0) {
      if (disposed) return true;
      if (!started) return false;
      const elapsed = Math.max(0, elapsedSeconds);
      finished ||= reducedMotion || elapsed >= PEEL_DURATION;
      const progress = finished ? 1 : Math.min(1, elapsed / PEEL_DURATION);
      const release = THREE.MathUtils.smoothstep(progress, 0.65, 1);
      const flutter = reducedMotion ? 0 : release * (
        Math.sin(elapsed * 4.2) * 0.11 + Math.sin(elapsed * 7.1 + 0.8) * 0.035
        + THREE.MathUtils.clamp(motion, -1, 1) * 0.24
      );
      const twist = reducedMotion ? 0 : release * Math.sin(elapsed * 5.3 + 1.2) * 0.12;
      pose(progress, flutter, twist);
      return finished;
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
      pixels = undefined;
      pivot.removeFromParent();
      geometry.dispose();
      shadows.forEach((shadow) => shadow.geometry.dispose());
      shadowMaterial.dispose();
      material.dispose();
      map.dispose();
    },
  };
}
