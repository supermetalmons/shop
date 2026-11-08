import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { ETHEREUM_CONTAINER_MEDIA } from '../containerMedia';

export const CRATE_IMAGE_ASPECT = ETHEREUM_CONTAINER_MEDIA.crate.aspectRatio;
export const CRATE_BOUNDS = Object.freeze({ width: 3.2, height: 1.87149, depth: 2.20102 });
export const CRATE_CAMERA = Object.freeze({
  position: [-6.66606, 4.64376, 14.87276] as const,
  target: [0.061155, -0.104464, 0] as const,
  fov: 10.77718,
});

export type CrateModel = {
  root: THREE.Group;
  lid: THREE.Group;
  hitMeshes: THREE.Mesh[];
  setDamage: (count: number, point?: THREE.Vector3) => void;
  setOpening: (progress: number) => void;
  setRecoil: (x: number, y: number, amount: number) => void;
  setOpacity: (opacity: number) => void;
  dispose: () => void;
};

type Surface = 'timber' | 'front' | 'left' | 'lid' | 'rear-corner' | 'inside' | 'plain';
type GeometryBuckets = { photo: THREE.BufferGeometry[]; wood: THREE.BufferGeometry[] };
const { width: WIDTH, height: HEIGHT, depth: DEPTH } = CRATE_BOUNDS;
const LID_PIVOT = new THREE.Vector3(0, HEIGHT / 2, -DEPTH / 2);
const WOOD_PATCH = { left: 0.54, right: 0.62, bottom: 0.43, top: 0.65 };
const MAX_DAMAGE = 4;

function createReferenceCamera() {
  const camera = new THREE.PerspectiveCamera(CRATE_CAMERA.fov, CRATE_IMAGE_ASPECT, 0.1, 60);
  camera.position.set(...CRATE_CAMERA.position);
  camera.lookAt(...CRATE_CAMERA.target);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld(true);
  return camera;
}

function isPhotographed(normal: THREE.Vector3, surface: Surface) {
  if (surface === 'front') return normal.z > 0.5;
  if (surface === 'left') return normal.x < -0.5;
  if (surface === 'lid') return normal.y > 0.2 || normal.z > 0.5 || normal.x < -0.5;
  if (surface === 'rear-corner') return normal.y > 0.4;
  return surface === 'timber' && (normal.x < -0.3 || normal.y > 0.4 || normal.z > 0.3);
}

function partitionGeometry(geometry: THREE.BufferGeometry, camera: THREE.Camera, surface: Surface, pivot?: THREE.Vector3): GeometryBuckets {
  const source = geometry.index ? geometry.toNonIndexed() : geometry;
  const position = source.getAttribute('position');
  const normal = source.getAttribute('normal');
  const photo = { position: [] as number[], normal: [] as number[], uv: [] as number[], photoUv: [] as number[] };
  const wood = { position: [] as number[], normal: [] as number[], uv: [] as number[], photoUv: [] as number[] };
  const vertex = new THREE.Vector3();
  const direction = new THREE.Vector3();
  const projected = new THREE.Vector3();
  const viewPosition = new THREE.Vector3();
  for (let i = 0; i < position.count; i += 3) {
    direction.set(0, 0, 0);
    for (let j = 0; j < 3; j += 1) direction.add(projected.fromBufferAttribute(normal, i + j));
    const photographed = isPhotographed(direction.normalize(), surface);
    const target = photographed ? photo : wood;
    for (let j = 0; j < 3; j += 1) {
      const index = i + j;
      vertex.fromBufferAttribute(position, index);
      projected.copy(vertex).project(camera);
      const depth = -viewPosition.copy(vertex).applyMatrix4(camera.matrixWorldInverse).z;
      const u = Math.abs(direction.x) > 0.5 ? (vertex.z + DEPTH / 2) / DEPTH : (vertex.x + WIDTH / 2) / WIDTH;
      const v = Math.abs(direction.y) > 0.5 ? (vertex.z + DEPTH / 2) / DEPTH : (vertex.y + HEIGHT / 2) / HEIGHT;
      if (pivot) vertex.sub(pivot);
      target.position.push(vertex.x, vertex.y, vertex.z);
      target.normal.push(normal.getX(index), normal.getY(index), normal.getZ(index));
      target.photoUv.push((projected.x + 1) / 2 * depth, (projected.y + 1) / 2 * depth, depth);
      if (photographed) target.uv.push((projected.x + 1) / 2, (projected.y + 1) / 2);
      else {
        target.uv.push(THREE.MathUtils.lerp(WOOD_PATCH.left, WOOD_PATCH.right, u), THREE.MathUtils.lerp(WOOD_PATCH.bottom, WOOD_PATCH.top, v));
      }
    }
  }
  const build = (data: typeof photo) => {
    if (!data.position.length) return [];
    const result = new THREE.BufferGeometry();
    result.setAttribute('position', new THREE.Float32BufferAttribute(data.position, 3));
    result.setAttribute('normal', new THREE.Float32BufferAttribute(data.normal, 3));
    result.setAttribute('uv', new THREE.Float32BufferAttribute(data.uv, 2));
    result.setAttribute('photoUv', new THREE.Float32BufferAttribute(data.photoUv, 3));
    return [result];
  };
  if (source !== geometry) source.dispose();
  geometry.dispose();
  return { photo: build(photo), wood: build(wood) };
}

function append(target: GeometryBuckets, source: GeometryBuckets) {
  target.photo.push(...source.photo);
  target.wood.push(...source.wood);
}

function handleWall() {
  const shape = new THREE.Shape();
  shape.moveTo(-DEPTH / 2, -HEIGHT / 2 + 0.045);
  shape.lineTo(DEPTH / 2, -HEIGHT / 2 + 0.045);
  shape.lineTo(DEPTH / 2, HEIGHT / 2 - 0.03);
  shape.lineTo(-DEPTH / 2, HEIGHT / 2 - 0.03);
  shape.closePath();
  const hole = new THREE.Path();
  const x = 0.08;
  const y = 0.51;
  const w = 0.57;
  const h = 0.155;
  const r = 0.026;
  hole.moveTo(x - w / 2 + r, y - h / 2);
  hole.lineTo(x + w / 2 - r, y - h / 2);
  hole.quadraticCurveTo(x + w / 2, y - h / 2, x + w / 2, y - h / 2 + r);
  hole.lineTo(x + w / 2, y + h / 2 - r);
  hole.quadraticCurveTo(x + w / 2, y + h / 2, x + w / 2 - r, y + h / 2);
  hole.lineTo(x - w / 2 + r, y + h / 2);
  hole.quadraticCurveTo(x - w / 2, y + h / 2, x - w / 2, y + h / 2 - r);
  hole.lineTo(x - w / 2, y - h / 2 + r);
  hole.quadraticCurveTo(x - w / 2, y - h / 2, x - w / 2 + r, y - h / 2);
  shape.holes.push(hole);
  const geometry = new THREE.ExtrudeGeometry(shape, { depth: 0.065, bevelEnabled: true, bevelSegments: 1, bevelSize: 0.005, bevelThickness: 0.004, steps: 1, curveSegments: 3 });
  geometry.rotateY(Math.PI / 2);
  geometry.translate(-WIDTH / 2, 0, 0);
  return geometry;
}

function createDamageGeometry(center: THREE.Vector3, u: THREE.Vector3, v: THREE.Vector3, index: number) {
  const positions: number[] = [];
  const length = 0.21 + index * 0.037;
  const width = 0.0028 + index * 0.0005;
  const point = (x: number, y: number) => center.clone().addScaledVector(u, x).addScaledVector(v, y);
  const segment = (ax: number, ay: number, bx: number, by: number, thickness: number) => {
    const dx = bx - ax;
    const dy = by - ay;
    const scale = thickness / Math.max(0.001, Math.hypot(dx, dy));
    const a = point(ax - dy * scale, ay + dx * scale);
    const b = point(ax + dy * scale, ay - dx * scale);
    const c = point(bx + dy * scale, by - dx * scale);
    const d = point(bx - dy * scale, by + dx * scale);
    for (const vertex of [a, b, c, a, c, d]) positions.push(vertex.x, vertex.y, vertex.z);
  };
  let x = -length / 2;
  let y = 0;
  for (let i = 1; i <= 7; i += 1) {
    const nextX = -length / 2 + length * i / 7;
    const nextY = Math.sin(i * 2.47 + index) * 0.013 + Math.sin(i * 0.87) * 0.008;
    segment(x, y, nextX, nextY, width * Math.sin(i / 8 * Math.PI));
    if (i === 3 || i === 5) segment(nextX, nextY, nextX + length * 0.2, nextY + (i === 3 ? 0.026 : -0.02), width * 0.48);
    x = nextX;
    y = nextY;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  return geometry;
}

function loadCrateTexture(signal?: AbortSignal): Promise<THREE.Texture> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.decoding = 'async';
    let settled = false;
    const clean = () => {
      clearTimeout(timeout);
      image.onload = image.onerror = null;
      signal?.removeEventListener('abort', abort);
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      clean();
      image.src = '';
      reject(error);
    };
    const abort = () => fail(new DOMException('Crate loading was cancelled.', 'AbortError'));
    const timeout = setTimeout(() => fail(new Error('The crate image took too long to load. Please retry.')), 30_000);
    signal?.addEventListener('abort', abort, { once: true });
    image.onerror = () => fail(new Error('Unable to load the crate image. Please retry.'));
    image.onload = () => {
      void image.decode().then(() => {
        if (settled) return;
        if (signal?.aborted) { abort(); return; }
        if (!image.naturalWidth || !image.naturalHeight) { fail(new Error('The crate image is empty. Please retry.')); return; }
        settled = true;
        clean();
        const texture = new THREE.Texture(image);
        texture.needsUpdate = true;
        resolve(texture);
      }).catch(() => fail(new Error('Unable to prepare the crate image. Please retry.')));
    };
    if (signal?.aborted) abort();
    else image.src = '/111k/crate-reference-v16.webp';
  });
}

function projectedVertexShader(source: string) {
  return source.replace('#include <common>', '#include <common>\nattribute vec3 photoUv;\nvarying vec3 vCratePhotoUv;')
    .replace('#include <begin_vertex>', '#include <begin_vertex>\nvCratePhotoUv = photoUv;');
}

export async function createCrateModel(options: { signal?: AbortSignal } = {}): Promise<CrateModel> {
  const texture = await loadCrateTexture(options.signal);
  if (options.signal?.aborted) {
    texture.dispose();
    throw new DOMException('Crate loading was cancelled.', 'AbortError');
  }
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  const photograph = new THREE.MeshBasicMaterial({ map: texture, alphaTest: 0.001, transparent: true, toneMapped: false });
  photograph.onBeforeCompile = shader => {
    shader.vertexShader = projectedVertexShader(shader.vertexShader);
    shader.fragmentShader = shader.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec3 vCratePhotoUv;')
      .replace('#include <map_fragment>', 'vec2 crateUv = vCratePhotoUv.xy / vCratePhotoUv.z;\nif (crateUv.x < 0.0 || crateUv.y < 0.0 || crateUv.x > 1.0 || crateUv.y > 1.0) discard;\n' + THREE.ShaderChunk.map_fragment.replaceAll('vMapUv', 'crateUv') + '\n#ifdef USE_MAP\nif (sampledDiffuseColor.a < 0.6) discard;\n#endif');
  };
  photograph.customProgramCacheKey = () => '111k-crate-reference-projection';
  const closedWoodColor = new THREE.Color(0x30271a);
  const openWoodColor = new THREE.Color(0x9d8d76);
  const wood = new THREE.MeshStandardMaterial({ map: texture, roughness: 0.96, metalness: 0, color: openWoodColor, transparent: true, toneMapped: false });
  const interior = wood.clone();
  interior.color.copy(closedWoodColor);
  const woodVisibility = { value: 0 };
  for (const material of [wood, interior]) {
    material.onBeforeCompile = shader => {
      shader.uniforms.crateWoodReveal = woodVisibility;
      shader.vertexShader = projectedVertexShader(shader.vertexShader);
      shader.fragmentShader = shader.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec3 vCratePhotoUv;\nuniform float crateWoodReveal;')
        .replace('#include <opaque_fragment>', `
          vec2 referenceUv = vCratePhotoUv.xy / vCratePhotoUv.z;
          vec4 referenceColor = texture2D(map, clamp(referenceUv, 0.0, 1.0));
          if (referenceUv.x < 0.0 || referenceUv.y < 0.0 || referenceUv.x > 1.0 || referenceUv.y > 1.0) referenceColor.a = 0.0;
          if (referenceColor.a < 0.6) discard;
          outgoingLight = mix(referenceColor.rgb, outgoingLight, crateWoodReveal);
          diffuseColor.a *= referenceColor.a;
          #include <opaque_fragment>
        `);
    };
    material.customProgramCacheKey = () => '111k-crate-inner-wood';
  }
  const crackMaterial = new THREE.MeshBasicMaterial({ color: 0x392817, transparent: true, opacity: 0.82, depthWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2 });
  const root = new THREE.Group();
  root.name = '111k-wooden-crate';
  const motion = new THREE.Group();
  root.add(motion);
  const lid = new THREE.Group();
  lid.name = '111k-pry-lid';
  lid.position.copy(LID_PIVOT);
  motion.add(lid);
  const front = new THREE.Group();
  front.name = '111k-front-panel';
  front.position.z = DEPTH / 2;
  const left = new THREE.Group();
  left.name = '111k-left-panel';
  left.position.x = -WIDTH / 2;
  motion.add(front, left);
  const camera = createReferenceCamera();
  const bodyGeometry: GeometryBuckets = { photo: [], wood: [] };
  const lidGeometry: GeometryBuckets = { photo: [], wood: [] };
  const frontGeometry: GeometryBuckets = { photo: [], wood: [] };
  const leftGeometry: GeometryBuckets = { photo: [], wood: [] };
  const interiorGeometry: GeometryBuckets = { photo: [], wood: [] };
  const geometries = new Set<THREE.BufferGeometry>();
  const hitMeshes: THREE.Mesh[] = [];
  const box = (size: [number, number, number], position: [number, number, number], surface: Surface = 'timber', onLid = false, bevel = 0.008) => {
    const geometry = new RoundedBoxGeometry(...size, 1, bevel);
    geometry.translate(...position);
    append(onLid ? lidGeometry : surface === 'inside' ? interiorGeometry : bodyGeometry, partitionGeometry(geometry, camera, surface, onLid ? LID_PIVOT : undefined));
  };

  const frontPanel = new RoundedBoxGeometry(WIDTH, HEIGHT - 0.11, 0.065, 1, 0.008);
  frontPanel.translate(0, -0.012, DEPTH / 2 - 0.0325);
  append(frontGeometry, partitionGeometry(frontPanel, camera, 'front', front.position));
  append(leftGeometry, partitionGeometry(handleWall(), camera, 'left', left.position));
  box([0.065, HEIGHT - 0.035, DEPTH], [WIDTH / 2 - 0.0325, -0.012, 0], 'inside');
  box([WIDTH, HEIGHT - 0.035, 0.065], [0, -0.012, -DEPTH / 2 + 0.0325], 'inside');
  box([WIDTH, 0.065, DEPTH], [0, -HEIGHT / 2 + 0.0325, 0], 'inside');

  for (const x of [-WIDTH / 2 + 0.035, WIDTH / 2 - 0.035]) {
    for (const z of [-DEPTH / 2 + 0.005, DEPTH / 2 + 0.005]) {
      const surface = x > 0 && z < 0 ? 'rear-corner' : 'timber';
      box([0.225, HEIGHT + (surface === 'rear-corner' ? 0.07 : 0.105), 0.19], [x, surface === 'rear-corner' ? -0.02 : -0.01, z], surface, false, 0.009);
      box([0.285, surface === 'rear-corner' ? 0.37 : 0.45, 0.245], [x, HEIGHT / 2 - 0.15, z], surface);
      box([0.285, 0.46, 0.245], [x, -HEIGHT / 2 + 0.12, z], surface);
    }
  }
  box([WIDTH - 0.19, 0.24, 0.09], [0, -HEIGHT / 2 + 0.095, DEPTH / 2 + 0.037], 'timber');
  box([WIDTH - 0.19, 0.19, 0.09], [0, -HEIGHT / 2 + 0.13, -DEPTH / 2 - 0.037], 'plain');
  for (const x of [-WIDTH / 2 - 0.027, WIDTH / 2 + 0.027]) {
    box([0.09, 0.24, DEPTH - 0.16], [x, -HEIGHT / 2 + 0.095, 0], x < 0 ? 'timber' : 'plain');
  }
  for (const x of [-WIDTH / 2 + 0.04, 0.08, WIDTH / 2 - 0.04]) {
    box([0.3, 0.22, DEPTH + 0.06], [x, -HEIGHT / 2 - 0.09, 0.005], 'timber');
  }

  const plankCount = 6;
  const plankDepth = (DEPTH - 0.06) / plankCount;
  for (let i = 0; i < plankCount; i += 1) {
    box([WIDTH - 0.075, 0.072, plankDepth - 0.003], [0, HEIGHT / 2 + 0.004, -DEPTH / 2 + 0.03 + plankDepth * (i + 0.5)], 'lid', true, 0.004);
  }
  box([WIDTH - 0.12, 0.153, 0.115], [0, HEIGHT / 2 - 0.043, DEPTH / 2 + 0.018], 'lid', true);
  box([WIDTH - 0.12, 0.125, 0.1], [0, HEIGHT / 2 - 0.033, -DEPTH / 2 + 0.015], 'lid', true);
  for (const x of [-WIDTH / 2 + 0.095, WIDTH / 2 - 0.095]) {
    box([0.175, 0.068, DEPTH - 0.025], [x, HEIGHT / 2 + 0.062, 0], 'lid', true, 0.006);
  }

  const addMeshes = (buckets: GeometryBuckets, parent: THREE.Group, woodMaterial: THREE.Material = wood) => {
    for (const key of ['photo', 'wood'] as const) {
      if (!buckets[key].length) continue;
      const geometry = mergeGeometries(buckets[key], false)!;
      buckets[key].forEach(part => part.dispose());
      geometries.add(geometry);
      geometry.computeBoundingBox();
      geometry.computeBoundingSphere();
      const mesh = new THREE.Mesh(geometry, key === 'photo' ? photograph : woodMaterial);
      mesh.name = `${parent.name || 'body'}-${key}`;
      parent.add(mesh);
      hitMeshes.push(mesh);
    }
  };
  addMeshes(bodyGeometry, motion);
  addMeshes(lidGeometry, lid);
  addMeshes(frontGeometry, front, interior);
  addMeshes(leftGeometry, left, interior);
  addMeshes(interiorGeometry, motion, interior);
  const damageMeshes: THREE.Mesh[] = [];
  let damage = 0;
  let disposed = false;
  let hitSurface: 'front' | 'left' | 'lid' = 'front';
  const setDamage = (count: number, point?: THREE.Vector3) => {
    if (disposed) return;
    const next = Math.max(0, Math.min(MAX_DAMAGE, Math.floor(Number.isFinite(count) ? count : 0)));
    root.updateMatrixWorld(true);
    const hit = point ? motion.worldToLocal(point.clone()) : new THREE.Vector3(-0.46 + damage * 0.31, 0.1 - damage * 0.09, DEPTH / 2);
    const frontDistance = Math.abs(hit.z - DEPTH / 2);
    const sideDistance = Math.abs(hit.x + WIDTH / 2);
    const topDistance = Math.abs(hit.y - HEIGHT / 2);
    hitSurface = topDistance < frontDistance && topDistance < sideDistance ? 'lid' : sideDistance < frontDistance ? 'left' : 'front';
    if (next < damage) {
      damageMeshes.splice(next).forEach(mesh => {
        mesh.removeFromParent();
        mesh.geometry.dispose();
        geometries.delete(mesh.geometry);
      });
      damage = next;
    }
    while (damage < next) {
      const center = hit.clone();
      const u = new THREE.Vector3(1, 0, 0);
      const v = new THREE.Vector3(0, 1, 0);
      let parent = front;
      if (hitSurface === 'lid') {
        center.y = HEIGHT / 2 + 0.042;
        center.x = THREE.MathUtils.clamp(center.x, -WIDTH / 2 + 0.3, WIDTH / 2 - 0.3);
        center.z = THREE.MathUtils.clamp(center.z, -DEPTH / 2 + 0.18, DEPTH / 2 - 0.15);
        v.set(0, 0, -1);
        center.sub(LID_PIVOT);
        parent = lid;
      } else if (hitSurface === 'left') {
        center.x = -WIDTH / 2 - 0.006;
        center.z = THREE.MathUtils.clamp(center.z, -DEPTH / 2 + 0.28, DEPTH / 2 - 0.28);
        center.y = THREE.MathUtils.clamp(center.y, -HEIGHT / 2 + 0.29, HEIGHT / 2 - 0.24);
        u.set(0, 0, -1);
        center.x += WIDTH / 2;
        parent = left;
      } else {
        center.z = 0.004;
        center.x = THREE.MathUtils.clamp(center.x, -WIDTH / 2 + 0.29, WIDTH / 2 - 0.29);
        center.y = THREE.MathUtils.clamp(center.y, -HEIGHT / 2 + 0.29, HEIGHT / 2 - 0.24);
      }
      const geometry = createDamageGeometry(center, u, v, damage);
      geometries.add(geometry);
      const mesh = new THREE.Mesh(geometry, crackMaterial);
      mesh.name = `wood-split-${damage}`;
      parent.add(mesh);
      damageMeshes.push(mesh);
      damage += 1;
    }
  };
  const setOpening = (progress: number) => {
    const p = THREE.MathUtils.clamp(Number.isFinite(progress) ? progress : 0, 0, 1);
    const pry = THREE.MathUtils.smoothstep(p, 0, 0.18);
    const lift = THREE.MathUtils.smoothstep(p, 0.12, 0.8);
    const settle = THREE.MathUtils.smoothstep(p, 0.55, 1);
    woodVisibility.value = THREE.MathUtils.smoothstep(p, 0, 0.08);
    interior.color.copy(closedWoodColor).lerp(openWoodColor, THREE.MathUtils.smoothstep(p, 0, 0.5));
    lid.position.copy(LID_PIVOT);
    lid.position.y += pry * 0.075 + lift * 0.08 - settle * 0.13;
    lid.position.z -= lift * 0.18;
    lid.rotation.x = -2.2 * THREE.MathUtils.smoothstep(p, 0.08, 1);
    lid.rotation.z = Math.sin(p * Math.PI) * 0.018;
  };
  const setRecoil = (x: number, y: number, amount: number) => {
    const strength = THREE.MathUtils.clamp(Number.isFinite(amount) ? amount : 0, -1.5, 1.5);
    const hx = THREE.MathUtils.clamp(Number.isFinite(x) ? x : 0, -1, 1);
    const hy = THREE.MathUtils.clamp(Number.isFinite(y) ? y : 0, -1, 1);
    motion.rotation.set(strength * (0.014 + hy * 0.018), strength * hx * 0.028, -strength * hx * 0.014);
    motion.position.set(-hx * strength * 0.012, -Math.abs(strength) * 0.009, -strength * 0.022);
    const frontFlex = hitSurface === 'front' ? strength : 0;
    const sideFlex = hitSurface === 'left' ? strength : 0;
    front.position.z = DEPTH / 2 - frontFlex * 0.024;
    front.rotation.set(hy * frontFlex * 0.006, -hx * frontFlex * 0.008, 0);
    left.position.x = -WIDTH / 2 + sideFlex * 0.022;
    left.rotation.set(0, hx * sideFlex * 0.008, -hy * sideFlex * 0.006);
  };
  const setOpacity = (opacity: number) => {
    const value = THREE.MathUtils.clamp(Number.isFinite(opacity) ? opacity : 1, 0, 1);
    root.visible = value > 0.001;
    for (const material of [photograph, wood, interior]) {
      material.opacity = value;
      material.depthWrite = value === 1;
    }
    crackMaterial.opacity = value * 0.82;
  };
  return {
    root, lid, hitMeshes, setDamage, setOpening, setRecoil, setOpacity,
    dispose() {
      if (disposed) return;
      disposed = true;
      geometries.forEach(geometry => geometry.dispose());
      photograph.dispose();
      wood.dispose();
      interior.dispose();
      crackMaterial.dispose();
      texture.dispose();
      root.clear();
      hitMeshes.length = 0;
    },
  };
}
