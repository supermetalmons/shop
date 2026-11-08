import * as THREE from 'three';
import { ETHEREUM_CONTAINER_MEDIA } from '../containerMedia';

export const WAREHOUSE_IMAGE_ASPECT = ETHEREUM_CONTAINER_MEDIA.warehouse.aspectRatio;
export const WAREHOUSE_BOUNDS = Object.freeze({ width: 8, height: 4.48332, depth: 7.19808 });
export const WAREHOUSE_CAMERA = Object.freeze({
  position: [-11.38806, 8.12919, 28.60020] as const,
  target: [0.235222, -0.292677, 0] as const,
  fov: 12.90936,
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
    else image.src = '/111k/warehouse-reference-v16.webp';
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
      .replace('#include <common>', '#include <common>\nattribute vec3 photoUv;\nattribute vec3 shellPosition;\nattribute float photoFace;\nattribute float roofVent;\nvarying vec3 vWarehouseUv;\nvarying vec3 vWarehousePosition;\nvarying float vWarehouseFace;\nvarying float vWarehouseVent;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvWarehouseUv = photoUv;\nvWarehousePosition = shellPosition;\nvWarehouseFace = photoFace;\nvWarehouseVent = roofVent;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWarehouseUv;\nvarying vec3 vWarehousePosition;\nvarying float vWarehouseFace;\nvarying float vWarehouseVent;\nuniform float warehouseOpening;\nuniform float warehouseDamage;\nuniform vec3 warehouseHits[3];')
      .replace('#include <map_fragment>', '')
      .replace('#include <opaque_fragment>', `
        vec2 referenceUv = vWarehouseUv.xy / vWarehouseUv.z;
        vec4 referenceColor = texture2D(map, clamp(referenceUv, 0.0, 1.0));
        if (referenceUv.x < 0.0 || referenceUv.y < 0.0 || referenceUv.x > 1.0 || referenceUv.y > 1.0) referenceColor.a = 0.0;
        if (referenceColor.a < 0.6) discard;
        bool underVent = referenceUv.x > 0.396 && referenceUv.x < 0.460 && referenceUv.y > 0.913
          || referenceUv.x > 0.477 && referenceUv.x < 0.544 && referenceUv.y > 0.849 && referenceUv.y < 0.934
          || referenceUv.x > 0.578 && referenceUv.x < 0.650 && referenceUv.y > 0.764 && referenceUv.y < 0.865;
        if (vWarehouseVent < 0.5 && underVent) {
          vec3 roofColor = texture2D(map, vec2(0.18, 0.62) + fract(referenceUv * 8.0) * vec2(0.05, 0.04)).rgb;
          referenceColor.rgb = mix(referenceColor.rgb, roofColor, warehouseOpening);
        }
        outgoingLight = mix(outgoingLight, referenceColor.rgb, vWarehouseFace > 0.5 ? 1.0 : 1.0 - warehouseOpening);
        diffuseColor.a *= referenceColor.a;
        for (int hit = 0; hit < 3; hit++) {
          if (float(hit) >= warehouseDamage) break;
          vec3 delta = vWarehousePosition - warehouseHits[hit];
          float radius = length(delta);
          float angle = atan(delta.y, warehouseHits[hit].x < -3.6 ? delta.z : delta.x);
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
  const thickness = 0.10;
  function piece(geometry: THREE.BufferGeometry, name: string, parent?: THREE.Mesh) {
    geometry.computeBoundingBox();
    const center = geometry.boundingBox!.getCenter(new THREE.Vector3());
    const positions = geometry.getAttribute('position');
    const normals = geometry.getAttribute('normal');
    const photoUv: number[] = [];
    const shellPosition: number[] = [];
    const photoFace: number[] = [];
    for (let index = 0; index < positions.count; index++) {
      vertex.fromBufferAttribute(positions, index);
      projected.copy(vertex).project(camera);
      const depth = -view.copy(vertex).applyMatrix4(camera.matrixWorldInverse).z;
      photoUv.push((projected.x + 1) / 2 * depth, (projected.y + 1) / 2 * depth, depth);
      shellPosition.push(vertex.x, vertex.y, vertex.z);
      photoFace.push(view.copy(camera.position).sub(vertex).dot(projected.fromBufferAttribute(normals, index)) > 0 ? 1 : 0);
    }
    geometry.setAttribute('photoUv', new THREE.Float32BufferAttribute(photoUv, 3));
    geometry.setAttribute('shellPosition', new THREE.Float32BufferAttribute(shellPosition, 3));
    geometry.setAttribute('photoFace', new THREE.Float32BufferAttribute(photoFace, 1));
    geometry.setAttribute('roofVent', new THREE.Float32BufferAttribute(new Float32Array(positions.count).fill(name.startsWith('warehouse-roof-vent-') ? 1 : 0), 1));
    geometry.translate(-center.x, -center.y, -center.z);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = name;
    mesh.position.copy(center);
    if (parent) {
      mesh.position.sub(parent.position);
      parent.add(mesh);
    } else {
      const index = pieces.length;
      const outward = center.clone().setY(0).normalize();
      pieces.push({ mesh, origin: mesh.position.clone(),
        velocity: outward.multiplyScalar(2.1 + index % 3 * 0.42).setY(1.3 + index % 4 * 0.22),
        spin: new THREE.Vector3(Math.sin(index * 2.7) * 0.8, Math.cos(index * 1.7) * 0.7, Math.sin(index * 3.1) * 0.6),
      });
      motion.add(mesh);
    }
    hitMeshes.push(mesh);
    return mesh;
  }

  const ray = new THREE.Raycaster();
  const imagePoint = (x: number, y: number, z: number) => {
    ray.setFromCamera(new THREE.Vector2(x / ETHEREUM_CONTAINER_MEDIA.warehouse.width * 2 - 1,
      1 - y / ETHEREUM_CONTAINER_MEDIA.warehouse.height * 2), camera);
    return ray.ray.at((z - ray.ray.origin.z) / ray.ray.direction.z, new THREE.Vector3());
  };
  function panel(vertices: readonly THREE.Vector3[], name: string, parent?: THREE.Mesh) {
    const normal = new THREE.Vector3().crossVectors(vertices[1].clone().sub(vertices[0]), vertices[2].clone().sub(vertices[0])).normalize();
    const back = vertices.map(point => point.clone().addScaledVector(normal, -thickness));
    const positions: number[] = [];
    const triangle = (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3) => positions.push(...a.toArray(), ...b.toArray(), ...c.toArray());
    for (let index = 1; index < vertices.length - 1; index++) {
      triangle(vertices[0], vertices[index], vertices[index + 1]);
      triangle(back[0], back[index + 1], back[index]);
    }
    for (let index = 0; index < vertices.length; index++) {
      const next = (index + 1) % vertices.length;
      triangle(vertices[index], back[index], back[next]);
      triangle(vertices[index], back[next], vertices[next]);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setIndex(Array.from({ length: positions.length / 3 }, (_, index) => index));
    geometry.computeVertexNormals();
    return piece(geometry, name, parent);
  }
  function grid(bottomLeft: THREE.Vector3, bottomRight: THREE.Vector3, topRight: THREE.Vector3, topLeft: THREE.Vector3,
    columns: number, rows: number, name: string) {
    const point = (u: number, v: number) => bottomLeft.clone().lerp(bottomRight, u).lerp(topLeft.clone().lerp(topRight, u), v);
    for (let row = 0; row < rows; row++) for (let column = 0; column < columns; column++) {
      panel([point(column / columns, row / rows), point((column + 1) / columns, row / rows),
        point((column + 1) / columns, (row + 1) / rows), point(column / columns, (row + 1) / rows)], `${name}-${row}-${column}`);
    }
  }
  const frontZ = WAREHOUSE_BOUNDS.depth / 2;
  const rearZ = -frontZ;
  const floorY = -WAREHOUSE_BOUNDS.height / 2;
  const frontLeft = imagePoint(342, 1020, frontZ);
  const frontRight = imagePoint(1496, 885, frontZ);
  const frontEaveLeft = imagePoint(314, 510, frontZ);
  const frontEaveRight = imagePoint(1507, 377, frontZ);
  const frontRidge = imagePoint(1051, 264, frontZ);
  const rearLeft = imagePoint(56, 753, rearZ);
  const rearEaveLeft = imagePoint(43, 212, rearZ);
  const rearRidge = imagePoint(596, 43, rearZ);
  const rearRight = new THREE.Vector3(frontRight.x, floorY, rearZ);
  const rearEaveRight = new THREE.Vector3(frontEaveRight.x, rearEaveLeft.y, rearZ);
  grid(frontLeft, frontRight, frontEaveRight, frontEaveLeft, 3, 3, 'warehouse-front');
  const frontCenter = frontEaveLeft.clone().lerp(frontEaveRight, (frontRidge.x - frontEaveLeft.x) / (frontEaveRight.x - frontEaveLeft.x));
  panel([frontEaveLeft, frontCenter, frontRidge], 'warehouse-gable-left');
  panel([frontCenter, frontEaveRight, frontRidge], 'warehouse-gable-right');
  grid(rearLeft, frontLeft, frontEaveLeft, rearEaveLeft, 2, 3, 'warehouse-left');
  grid(frontRight, rearRight, rearEaveRight, frontEaveRight, 2, 1, 'warehouse-right');
  panel([rearRight, rearLeft, rearEaveLeft, rearRidge, rearEaveRight], 'warehouse-rear');
  const roof: THREE.Mesh[] = [];
  for (let index = 0; index < 3; index++) {
    const start = index / 3;
    const end = (index + 1) / 3;
    const left = panel([frontEaveLeft.clone().lerp(rearEaveLeft, start), frontRidge.clone().lerp(rearRidge, start),
      frontRidge.clone().lerp(rearRidge, end), frontEaveLeft.clone().lerp(rearEaveLeft, end)], `warehouse-roof-left-${index}`);
    panel([frontRidge.clone().lerp(rearRidge, start), frontEaveRight.clone().lerp(rearEaveRight, start),
      frontEaveRight.clone().lerp(rearEaveRight, end), frontRidge.clone().lerp(rearRidge, end)], `warehouse-roof-right-${index}`, left);
    roof.push(left);
  }
  panel([new THREE.Vector3(rearLeft.x, floorY, rearZ), new THREE.Vector3(rearRight.x, floorY, rearZ),
    new THREE.Vector3(frontRight.x, floorY, frontZ), new THREE.Vector3(frontLeft.x, floorY, frontZ)], 'warehouse-floor');
  for (const [index, [left, top, right, bottom, z]] of [
    [611, 4, 703, 88, -2.9], [735, 69, 833, 153, -0.55], [890, 140, 995, 240, 1.8],
  ].entries()) {
    const center = imagePoint((left + right) / 2, (top + bottom) / 2, z);
    const radius = imagePoint(left, (top + bottom) / 2, z).distanceTo(imagePoint(right, (top + bottom) / 2, z)) * 0.57;
    const height = imagePoint((left + right) / 2, top, z).distanceTo(imagePoint((left + right) / 2, bottom, z));
    const geometry = new THREE.SphereGeometry(1, 8, 6);
    geometry.scale(radius, height * 0.6, radius);
    geometry.translate(center.x, center.y, center.z);
    piece(geometry, `warehouse-roof-vent-${index}`, roof[2 - index]);
  }
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
        hitPoints.value[index].copy(point ?? new THREE.Vector3(-1 + index, 0.4 - index * 0.3, frontZ));
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
      for (const mesh of hitMeshes) mesh.geometry.dispose();
      pieces.length = 0;
      hitMeshes.length = 0;
      material.dispose();
      texture.dispose();
      root.clear();
    },
  };
}
