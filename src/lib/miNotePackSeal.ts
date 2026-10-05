import * as THREE from 'three';

const STICKER_SIZE = 512;
const FALL_DURATION = 1.15;
const ARTWORK_TIMEOUT_MS = 30_000;

function sealPoint(u: number, progress: number, width: number, spine: number) {
  const back = -0.0035;
  const radius = (spine + 0.007) / 2;
  const distance = (0.605 - u) * 0.56;
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

function removeStickerBackground(context: CanvasRenderingContext2D) {
  const image = context.getImageData(0, 0, STICKER_SIZE, STICKER_SIZE);
  const pixels = image.data;
  const visited = new Uint8Array(STICKER_SIZE * STICKER_SIZE);
  const queue = new Uint32Array(STICKER_SIZE * STICKER_SIZE);
  let head = 0;
  let tail = 0;
  const enqueue = (index: number) => {
    if (visited[index]) return;
    visited[index] = 1;
    const pixel = index * 4;
    const min = Math.min(pixels[pixel], pixels[pixel + 1], pixels[pixel + 2]);
    const max = Math.max(pixels[pixel], pixels[pixel + 1], pixels[pixel + 2]);
    if (min > 210 && max - min < 38) {
      queue[tail++] = index;
      pixels[pixel + 3] = 0;
    }
  };
  for (let i = 0; i < STICKER_SIZE; i += 1) {
    enqueue(i);
    enqueue((STICKER_SIZE - 1) * STICKER_SIZE + i);
    enqueue(i * STICKER_SIZE);
    enqueue(i * STICKER_SIZE + STICKER_SIZE - 1);
  }
  while (head < tail) {
    const index = queue[head++];
    const x = index % STICKER_SIZE;
    const y = Math.floor(index / STICKER_SIZE);
    if (x) enqueue(index - 1);
    if (x < STICKER_SIZE - 1) enqueue(index + 1);
    if (y) enqueue(index - STICKER_SIZE);
    if (y < STICKER_SIZE - 1) enqueue(index + STICKER_SIZE);
  }
  context.putImageData(image, 0, 0);
}

export function createMiNotePackSeal({
  parent,
  fallRoot,
  width,
  spine,
  onInvalidate,
}: {
  parent: THREE.Group;
  fallRoot: THREE.Group;
  width: number;
  spine: number;
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
    roughness: 0.22,
    metalness: 0.28,
    side: THREE.DoubleSide,
    alphaTest: 0.4,
  });
  material.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace('#include <opaque_fragment>', `
      float foil = smoothstep(0.12, 0.42, diffuseColor.b);
      float angle = dot(normalize(vViewPosition), normal);
      vec3 rainbow = 0.5 + 0.5 * cos(6.28318 * (vec3(0., .33, .67) + vMapUv.x * .8 + vMapUv.y * .65 + angle * 2.4));
      if (gl_FrontFacing) outgoingLight = mix(outgoingLight, outgoingLight * .3 + rainbow * .95 + vec3(.04), .60 * foil + .07);
      else outgoingLight = vec3(.78, .76, .68);
      #include <opaque_fragment>
    `);
  };
  material.customProgramCacheKey = () => 'mi-note-holographic-seal-v1';
  const geometry = new THREE.PlaneGeometry(0.56, 0.544, 160, 48);
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
    const angle = 5 * Math.PI / 180;
    for (let i = 0; i < position.count; i += 1) {
      const x = (uv.getX(i) - 0.5) * 0.56;
      const y = (uv.getY(i) - 0.5) * 0.544;
      const rotatedX = x * Math.cos(angle) - y * Math.sin(angle);
      const rotatedY = x * Math.sin(angle) + y * Math.cos(angle);
      const point = sealPoint(rotatedX / 0.56 + 0.5, eased, width, spine);
      position.setXYZ(i, point.x - width, rotatedY, point.z - spine / 2);
    }
    position.needsUpdate = true;
    geometry.computeVertexNormals();
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
        context.drawImage(artwork, 40, 150, 700, 680, 0, 0, STICKER_SIZE, STICKER_SIZE);
        removeStickerBackground(context);
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
    artwork.src = '/mi-note-cards/star-sticker.png';
  });

  return {
    ready,
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
