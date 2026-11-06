import * as THREE from 'three';

export const WAREHOUSE_IMAGE_ASPECT = 1254 / 1104;
export const WAREHOUSE_BOUNDS = Object.freeze({ width: 8, height: 8, depth: 8 });
export const WAREHOUSE_CAMERA = Object.freeze({
  position: [11.29012, -0.59413, 31.2461] as const,
  target: [-0.47988, -0.35887, 0] as const,
  fov: 15.37848,
});

export type WarehouseModel = {
  root: THREE.Group;
  hitMeshes: THREE.Mesh[];
  setDamage: (count: number, point?: THREE.Vector3) => void;
  setFracture: (progress: number) => void;
  setRecoil: (x: number, y: number, amount: number) => void;
  setOpacity: (value: number) => void;
  dispose: () => void;
};

const bounded = (value: number, min = 0, max = 1) => THREE.MathUtils.clamp(Number.isFinite(value) ? value : min, min, max);

function loadReference(signal?: AbortSignal): Promise<THREE.Texture> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.decoding = 'async';
    let settled = false;
    const clean = () => {
      clearTimeout(timer);
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
    const abort = () => fail(new DOMException('Warehouse loading was cancelled.', 'AbortError'));
    const timer = setTimeout(() => fail(new Error('The warehouse image took too long to load.')), 30_000);
    signal?.addEventListener('abort', abort, { once: true });
    image.onerror = () => fail(new Error('Unable to load the warehouse image.'));
    image.onload = () => {
      void image.decode().then(() => {
        if (settled) return;
        if (signal?.aborted) { abort(); return; }
        if (!image.naturalWidth || !image.naturalHeight) { fail(new Error('The warehouse image is empty.')); return; }
        settled = true;
        clean();
        const texture = new THREE.Texture(image);
        texture.colorSpace = THREE.SRGBColorSpace;
        texture.needsUpdate = true;
        resolve(texture);
      }).catch(() => fail(new Error('Unable to prepare the warehouse image.')));
    };
    if (signal?.aborted) abort();
    else image.src = '/111k/warehouse-reference.webp';
  });
}

export async function createWarehouseModel({ signal }: { signal?: AbortSignal } = {}): Promise<WarehouseModel> {
  const texture = await loadReference(signal);
  if (signal?.aborted) {
    texture.dispose();
    throw new DOMException('Warehouse loading was cancelled.', 'AbortError');
  }
  texture.anisotropy = 4;
  const camera = new THREE.PerspectiveCamera(WAREHOUSE_CAMERA.fov, WAREHOUSE_IMAGE_ASPECT, 0.1, 100);
  camera.position.fromArray(WAREHOUSE_CAMERA.position);
  camera.lookAt(...WAREHOUSE_CAMERA.target);
  camera.updateMatrixWorld(true);
  const opening = { value: 0 };
  const damage = { value: 0 };
  const hitPoints = { value: Array.from({ length: 3 }, () => new THREE.Vector3()) };
  const material = new THREE.MeshLambertMaterial({ map: texture, color: 0x85888b, transparent: true, toneMapped: false });
  material.onBeforeCompile = shader => {
    shader.uniforms.warehouseOpening = opening;
    shader.uniforms.warehouseDamage = damage;
    shader.uniforms.warehouseHits = hitPoints;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec3 photoUv;\nattribute vec3 shellPosition;\nattribute float photoFace;\nvarying vec3 vWarehouseUv;\nvarying vec3 vWarehousePosition;\nvarying float vWarehouseFace;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvWarehouseUv = photoUv;\nvWarehousePosition = shellPosition;\nvWarehouseFace = photoFace;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWarehouseUv;\nvarying vec3 vWarehousePosition;\nvarying float vWarehouseFace;\nuniform float warehouseOpening;\nuniform float warehouseDamage;\nuniform vec3 warehouseHits[3];')
      .replace('#include <map_fragment>', '')
      .replace('#include <opaque_fragment>', `
        vec2 referenceUv = vWarehouseUv.xy / vWarehouseUv.z;
        vec4 referenceColor = texture2D(map, clamp(referenceUv, 0.0, 1.0));
        if (referenceUv.x < 0.0 || referenceUv.y < 0.0 || referenceUv.x > 1.0 || referenceUv.y > 1.0) referenceColor.a = 0.0;
        if (referenceColor.a < 0.6) discard;
        outgoingLight = mix(outgoingLight, referenceColor.rgb, vWarehouseFace > 0.5 ? 1.0 : 1.0 - warehouseOpening);
        for (int hit = 0; hit < 3; hit++) {
          if (float(hit) >= warehouseDamage) break;
          vec3 delta = vWarehousePosition - warehouseHits[hit];
          float radius = length(delta);
          float angle = atan(delta.y, abs(warehouseHits[hit].x) > 3.85 ? delta.z : delta.x);
          float seam = abs(sin(angle * 4.0 + sin(radius * 13.0) * 0.22));
          float frost = (1.0 - smoothstep(0.02, 0.09, seam)) * (1.0 - smoothstep(0.12, 1.9, radius));
          outgoingLight = mix(outgoingLight, vec3(0.37, 0.76, 0.9), frost * 0.72);
        }
        #include <opaque_fragment>
      `);
  };
  material.customProgramCacheKey = () => '111k-warehouse-projected-shell';
  const root = new THREE.Group();
  root.name = '111k-warehouse';
  const motion = new THREE.Group();
  root.add(motion);
  const hitMeshes: THREE.Mesh[] = [];
  const pieces: { mesh: THREE.Mesh; origin: THREE.Vector3; velocity: THREE.Vector3; spin: THREE.Vector3 }[] = [];
  const vertex = new THREE.Vector3();
  const projected = new THREE.Vector3();
  const view = new THREE.Vector3();
  const thickness = 0.12;
  function panel(size: [number, number, number], position: [number, number, number], name: string) {
    const geometry = new THREE.BoxGeometry(...size);
    const positions = geometry.getAttribute('position');
    const normals = geometry.getAttribute('normal');
    const photoUv: number[] = [];
    const shellPosition: number[] = [];
    const photoFace: number[] = [];
    for (let index = 0; index < positions.count; index++) {
      vertex.fromBufferAttribute(positions, index).add(new THREE.Vector3(...position));
      projected.copy(vertex).project(camera);
      const depth = -view.copy(vertex).applyMatrix4(camera.matrixWorldInverse).z;
      photoUv.push((projected.x + 1) / 2 * depth, (projected.y + 1) / 2 * depth, depth);
      shellPosition.push(vertex.x, vertex.y, vertex.z);
      photoFace.push(normals.getZ(index) > 0.5 && vertex.z > 3.85 || normals.getX(index) > 0.5 && vertex.x > 3.85 ? 1 : 0);
    }
    geometry.setAttribute('photoUv', new THREE.Float32BufferAttribute(photoUv, 3));
    geometry.setAttribute('shellPosition', new THREE.Float32BufferAttribute(shellPosition, 3));
    geometry.setAttribute('photoFace', new THREE.Float32BufferAttribute(photoFace, 1));
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = name;
    mesh.position.fromArray(position);
    const index = pieces.length;
    const outward = new THREE.Vector3(position[0], 0, position[2]).normalize();
    pieces.push({ mesh, origin: mesh.position.clone(),
      velocity: outward.multiplyScalar(2.1 + index % 3 * 0.42).setY(1.3 + index % 4 * 0.22),
      spin: new THREE.Vector3(Math.sin(index * 2.7) * 0.8, Math.cos(index * 1.7) * 0.7, Math.sin(index * 3.1) * 0.6),
    });
    hitMeshes.push(mesh);
    motion.add(mesh);
  }
  for (let row = 0; row < 3; row++) {
    for (let column = 0; column < 3; column++) {
      panel([8 / 3, 8 / 3, thickness], [-4 + (column + 0.5) * 8 / 3, -4 + (row + 0.5) * 8 / 3, 4 - thickness / 2], `warehouse-front-${row}-${column}`);
    }
    for (let column = 0; column < 2; column++) {
      panel([thickness, 8 / 3, 4], [4 - thickness / 2, -4 + (row + 0.5) * 8 / 3, -2 + column * 4], `warehouse-right-${row}-${column}`);
    }
  }
  for (let index = 0; index < 2; index++) {
    panel([4, 8, thickness], [-2 + index * 4, 0, -4 + thickness / 2], `warehouse-rear-${index}`);
    panel([thickness, 4, 8], [-4 + thickness / 2, -2 + index * 4, 0], `warehouse-left-${index}`);
    panel([4, thickness, 8], [-2 + index * 4, 4 - thickness / 2, 0], `warehouse-roof-${index}`);
  }
  panel([8, thickness, 8], [0, -4 + thickness / 2, 0], 'warehouse-floor');
  let disposed = false;
  let opacity = 1;
  let fracture = 0;
  const applyOpacity = () => {
    material.opacity = opacity * (1 - THREE.MathUtils.smoothstep(fracture, 0.48, 1));
    material.depthWrite = material.opacity >= 0.999;
    root.visible = material.opacity > 0.001;
  };
  return {
    root, hitMeshes,
    setDamage(count, point) {
      if (disposed) return;
      const next = Math.floor(bounded(count, 0, 3));
      if (next > damage.value) for (let index = damage.value; index < next; index++) {
        hitPoints.value[index].copy(point ?? new THREE.Vector3(-1 + index, 0.4 - index * 0.3, 4));
      }
      damage.value = next;
    },
    setFracture(progress) {
      if (disposed) return;
      fracture = bounded(progress);
      opening.value = THREE.MathUtils.smoothstep(fracture, 0, 0.06);
      const travel = THREE.MathUtils.smoothstep(fracture, 0, 1);
      for (const piece of pieces) {
        piece.mesh.position.copy(piece.origin).addScaledVector(piece.velocity, travel);
        piece.mesh.position.y -= travel * travel * 2.4;
        piece.mesh.rotation.set(piece.spin.x * travel, piece.spin.y * travel, piece.spin.z * travel);
      }
      applyOpacity();
    },
    setRecoil(x, y, amount) {
      if (disposed) return;
      const strength = bounded(amount, -1.5, 1.5);
      const horizontal = bounded(x, -1, 1);
      const vertical = bounded(y, -1, 1);
      motion.rotation.set(vertical * strength * 0.012, horizontal * strength * 0.016, -horizontal * strength * 0.009);
      motion.position.set(-horizontal * strength * 0.028, -Math.abs(strength) * 0.02, -strength * 0.045);
    },
    setOpacity(value) { if (!disposed) { opacity = bounded(value); applyOpacity(); } },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const piece of pieces) piece.mesh.geometry.dispose();
      pieces.length = 0;
      hitMeshes.length = 0;
      material.dispose();
      texture.dispose();
      root.clear();
    },
  };
}
