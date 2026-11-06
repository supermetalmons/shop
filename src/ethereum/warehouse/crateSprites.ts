import * as THREE from 'three';

export const CRATE_SPRITE_BOUNDS = Object.freeze({ width: 3.42, height: 2.11836, depth: 2.36555 });

export type CrateSprites = {
  root: THREE.Group;
  bounds: THREE.Box3;
  setMatrixAt: (index: number, matrix: THREE.Matrix4) => void;
  commit: () => void;
  setOpacity: (value: number) => void;
  dispose: () => void;
};

export function createCrateSprites(count: number, preview: { image: HTMLCanvasElement; width: number; height: number }): CrateSprites {
  if (!Number.isInteger(count) || count < 1 || count > 11) throw new RangeError('A warehouse contains between one and eleven crates.');
  if (![preview.width, preview.height, preview.image.width, preview.image.height].every(value => Number.isFinite(value) && value > 0)) {
    throw new Error('The crate preview must be decoded before preparing its sprites.');
  }
  const texture = new THREE.CanvasTexture(preview.image);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  const geometry = new THREE.PlaneGeometry(1, 1);
  const material = new THREE.MeshBasicMaterial({ map: texture, transparent: true, alphaTest: 0.025, toneMapped: false });
  const mesh = new THREE.InstancedMesh(geometry, material, count);
  mesh.name = 'warehouse-crate-sprites';
  mesh.frustumCulled = false;
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  const root = new THREE.Group();
  root.name = '111k-warehouse-crates';
  root.add(mesh);
  const { width, height, depth } = CRATE_SPRITE_BOUNDS;
  const bounds = new THREE.Box3(new THREE.Vector3(-width / 2, -height / 2, -depth / 2), new THREE.Vector3(width / 2, height / 2, depth / 2));
  let disposed = false;
  return {
    root, bounds,
    setMatrixAt(index, matrix) {
      if (disposed) return;
      if (!Number.isInteger(index) || index < 0 || index >= count || !matrix.elements.every(Number.isFinite)) {
        throw new RangeError('The crate transform must be finite and refer to an existing crate.');
      }
      mesh.setMatrixAt(index, matrix);
    },
    commit() { if (!disposed) mesh.instanceMatrix.needsUpdate = true; },
    setOpacity(value) {
      if (disposed) return;
      const opacity = THREE.MathUtils.clamp(Number.isFinite(value) ? value : 1, 0, 1);
      material.opacity = opacity;
      material.depthWrite = opacity === 1;
      root.visible = opacity > 0.001;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      mesh.dispose();
      geometry.dispose();
      material.dispose();
      texture.dispose();
      root.clear();
    },
  };
}
