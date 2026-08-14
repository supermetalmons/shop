import * as THREE from 'three';

type GpuBuffer = THREE.BufferAttribute | THREE.InterleavedBuffer;

type GeometryObject = THREE.Mesh | THREE.Points;

function gpuBufferForAttribute(
  attribute: THREE.BufferAttribute | THREE.InterleavedBufferAttribute,
): GpuBuffer {
  return attribute instanceof THREE.InterleavedBufferAttribute
    ? attribute.data
    : attribute;
}

function isGeometryObject(object: THREE.Object3D): object is GeometryObject {
  return object instanceof THREE.Mesh || object instanceof THREE.Points;
}

function geometryHasMorphAttributes(geometry: THREE.BufferGeometry): boolean {
  return Object.values(geometry.morphAttributes).some((attributes) => attributes.length > 0);
}

function objectUsesWireframeMaterial(object: GeometryObject): boolean {
  if (!(object instanceof THREE.Mesh)) return false;
  const materials = Array.isArray(object.material) ? object.material : [object.material];
  return materials.some(
    (material) => (material as THREE.Material & { wireframe?: boolean }).wireframe === true,
  );
}

function isInstancedAttribute(
  attribute: THREE.BufferAttribute | THREE.InterleavedBufferAttribute,
): boolean {
  return (
    attribute instanceof THREE.InstancedBufferAttribute ||
    (attribute instanceof THREE.InterleavedBufferAttribute &&
      attribute.data instanceof THREE.InstancedInterleavedBuffer)
  );
}

export function releaseObjectGeometryCpuBuffersAfterUpload(
  root: THREE.Object3D,
  options?: { immutable: true },
): boolean {
  if (!options?.immutable) return false;

  const buffers = new Set<GpuBuffer>();
  const geometries = new Set<THREE.BufferGeometry>();
  let safeToRelease = true;

  root.traverse((object) => {
    if (!isGeometryObject(object)) {
      if ((object as { geometry?: unknown }).geometry instanceof THREE.BufferGeometry) {
        safeToRelease = false;
      }
      return;
    }
    const geometry = object.geometry;
    geometries.add(geometry);

    if (
      object instanceof THREE.SkinnedMesh ||
      object instanceof THREE.InstancedMesh ||
      object instanceof THREE.BatchedMesh ||
      geometry instanceof THREE.InstancedBufferGeometry ||
      geometryHasMorphAttributes(geometry) ||
      objectUsesWireframeMaterial(object)
    ) {
      safeToRelease = false;
    }

    const attributes = geometry.attributes as Record<
      string,
      THREE.BufferAttribute | THREE.InterleavedBufferAttribute
    >;
    Object.values(attributes).forEach((attribute) => {
      const buffer = gpuBufferForAttribute(attribute);
      buffers.add(buffer);
      if (isInstancedAttribute(attribute) || buffer.usage !== THREE.StaticDrawUsage) {
        safeToRelease = false;
      }
    });
    if (geometry.index) {
      buffers.add(geometry.index);
      if (geometry.index.usage !== THREE.StaticDrawUsage) safeToRelease = false;
    }
  });

  if (!safeToRelease || buffers.size === 0) return false;

  geometries.forEach((geometry) => {
    if (!geometry.boundingBox) geometry.computeBoundingBox();
    if (!geometry.boundingSphere) geometry.computeBoundingSphere();
  });

  buffers.forEach((buffer) => {
    const previousUploadCallback = buffer.onUploadCallback;
    buffer.onUpload(() => {
      previousUploadCallback.call(buffer);
      (buffer as unknown as { array: ArrayBufferView | null }).array = null;
    });
  });

  return true;
}
